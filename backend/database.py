from sqlalchemy import create_engine, Column, String, Integer, JSON, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker


engine = create_engine("sqlite:///workout.db")
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
