from sqlalchemy import create_engine, Column, String, Integer, JSON, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker


import os

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///workout.db")
# Render gives postgres:// but SQLAlchemy needs postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id               = Column(String, primary_key=True)
    email            = Column(String, unique=True, nullable=False)
    hashed_password  = Column(String, nullable=False)


class Workout(Base):
    __tablename__ = "workouts"

    id         = Column(String, primary_key=True)
    user_id    = Column(String, ForeignKey("users.id"), nullable=False)
    start_time = Column(Integer)   # unix timestamp in ms
    end_time   = Column(Integer)
    duration   = Column(Integer)   # seconds
    exercises  = Column(JSON)


Base.metadata.create_all(engine)
