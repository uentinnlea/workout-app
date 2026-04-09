from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from jose import JWTError, jwt
from passlib.context import CryptContext
from datetime import datetime, timedelta
from database import SessionLocal, User, Workout
from typing import Any
import uuid

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
