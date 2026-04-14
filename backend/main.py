from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from jose import JWTError, jwt
from passlib.context import CryptContext
from datetime import datetime, timedelta, date
from database import SessionLocal, User, Workout
from typing import Any
import uuid
import math
import numpy as np

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SECRET_KEY  = "change-this-in-production"
ALGORITHM   = "HS256"
EXPIRE_DAYS = 30

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer      = HTTPBearer()


# ── Auth helpers ──────────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def create_token(user_id: str) -> str:
    expire = datetime.utcnow() + timedelta(days=EXPIRE_DAYS)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    try:
        payload  = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id  = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        return user_id
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")


# ── Auth endpoints ────────────────────────────────────────────────────────────

class AuthIn(BaseModel):
    email: str
    password: str

@app.post("/register")
def register(body: AuthIn):
    db = SessionLocal()
    if db.query(User).filter(User.email == body.email).first():
        db.close()
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(
        id=str(uuid.uuid4()),
        email=body.email,
        hashed_password=hash_password(body.password),
    )
    db.add(user)
    db.commit()
    user_id = user.id  # read before closing session
    db.close()
    return {"token": create_token(user_id)}

@app.post("/login")
def login(body: AuthIn):
    db = SessionLocal()
    user = db.query(User).filter(User.email == body.email).first()
    db.close()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {"token": create_token(user.id)}


# ── Workout endpoints ─────────────────────────────────────────────────────────

class WorkoutIn(BaseModel):
    id:         str
    start_time: int
    end_time:   int
    duration:   int
    exercises:  list[Any]

@app.get("/workouts")
def get_workouts(user_id: str = Depends(get_current_user)):
    db = SessionLocal()
    workouts = db.query(Workout).filter(Workout.user_id == user_id).order_by(Workout.start_time.desc()).all()
    db.close()
    return workouts

@app.post("/workouts")
def save_workout(w: WorkoutIn, user_id: str = Depends(get_current_user)):
    db = SessionLocal()
    existing = db.query(Workout).filter(Workout.id == w.id, Workout.user_id == user_id).first()
    if existing:
        db.close()
        raise HTTPException(status_code=409, detail="Already exists")
    workout = Workout(
        id=w.id, user_id=user_id,
        start_time=w.start_time, end_time=w.end_time,
        duration=w.duration, exercises=w.exercises,
    )
    db.add(workout)
    db.commit()
    db.close()
    return {"status": "saved"}

@app.delete("/workouts/{workout_id}")
def delete_workout(workout_id: str, user_id: str = Depends(get_current_user)):
    db = SessionLocal()
    workout = db.query(Workout).filter(Workout.id == workout_id, Workout.user_id == user_id).first()
    if not workout:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(workout)
    db.commit()
    db.close()
    return {"status": "deleted"}


# ── Readiness / ACWR model ────────────────────────────────────────────────────
#
# Acute:Chronic Workload Ratio (ACWR) — a sports-science model used by
# professional teams to quantify injury risk and training readiness.
#
# Method: exponential weighted moving average (EWMA) of daily volume load.
#   • Acute load  = EWMA over 7 days  (what you did recently)
#   • Chronic load = EWMA over 28 days (your baseline fitness)
#   • ACWR = acute / chronic
#
# Sweet spot: 0.8 – 1.3  →  trained but not overloaded
# > 1.5          →  injury / overreaching risk
# < 0.8          →  undertrained / deload territory
#
# Readiness score (0–100): Gaussian centred at ACWR = 1.0, σ = 0.3

def _ewma(data: np.ndarray, span: int) -> np.ndarray:
    """Exponential weighted moving average (same formula as pandas ewm(span=))."""
    alpha = 2.0 / (span + 1)
    out = np.empty(len(data))
    out[0] = data[0]
    for i in range(1, len(data)):
        out[i] = alpha * data[i] + (1 - alpha) * out[i - 1]
    return out


@app.get("/readiness")
def get_readiness(user_id: str = Depends(get_current_user)):
    db = SessionLocal()
    workouts = db.query(Workout).filter(Workout.user_id == user_id).all()
    db.close()

    if not workouts:
        return {
            "score": None, "acwr": None,
            "acute_load": 0, "chronic_load": 0,
            "zone": "no_data",
            "message": "Log some workouts to get a readiness score.",
        }

    # ── Build a daily volume-load map ─────────────────────────────────────────
    daily: dict[date, float] = {}
    for w in workouts:
        day = datetime.utcfromtimestamp(w.start_time / 1000).date()
        vol = sum(
            (float(s.get("weight") or 0)) * (int(s.get("reps") or 0))
            for ex in (w.exercises or [])
            for s in ex.get("sets", [])
        )
        daily[day] = daily.get(day, 0.0) + vol

    # 35-day window (28 chronic + 7 buffer for EWMA warm-up)
    today = datetime.utcnow().date()
    window = 35
    days   = [today - timedelta(days=i) for i in range(window - 1, -1, -1)]
    loads  = np.array([daily.get(d, 0.0) for d in days], dtype=float)

    acute_arr   = _ewma(loads, span=7)
    chronic_arr = _ewma(loads, span=28)

    acute   = float(acute_arr[-1])
    chronic = float(chronic_arr[-1])

    # ── ACWR & readiness score ────────────────────────────────────────────────
    if chronic < 1.0:
        # Not enough training history for a meaningful chronic baseline
        acwr = 1.0 if acute < 1.0 else min(acute / 100, 2.0)
    else:
        acwr = acute / chronic

    # Gaussian readiness: peak 100 at ACWR=1.0, sigma=0.3
    score = int(round(100 * math.exp(-((acwr - 1.0) ** 2) / (2 * 0.3 ** 2))))
    score = max(0, min(100, score))

    # ── Zone classification ───────────────────────────────────────────────────
    if acwr < 0.8:
        zone    = "undertrained"
        message = "Load is low — you're well recovered. Good day to train hard."
    elif acwr <= 1.3:
        zone    = "optimal"
        message = "You're in the sweet spot — train at full intensity today."
    elif acwr <= 1.5:
        zone    = "caution"
        message = "Training load is elevated — keep today moderate."
    else:
        zone    = "overreaching"
        message = "Very high load — consider rest or light active recovery."

    return {
        "score":        score,
        "acwr":         round(acwr, 2),
        "acute_load":   round(acute),
        "chronic_load": round(chronic),
        "zone":         zone,
        "message":      message,
    }
