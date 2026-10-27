"""XIAO ESP32-S3 IoT API (FastAPI + Supabase Postgres).

Users sign up / log in here (bcrypt + JWT), then read sensor values and control the LED.
The board talks to the same API over HTTPS: POST /api/device/report every second with its
sensor values, and the response carries the LED state it should apply. Because the board
only makes outgoing requests, it can be controlled from any network.

Data lives in the shared Supabase project (kepco-vibe-exhibition). The backend connects as
the least-privilege role `xiao_api`, which can only touch xiao_users, xiao_sensor_logs and
some columns of xiao_devices.
"""

import hmac
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Literal

import bcrypt
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, EmailStr, Field

try:  # local development reads backend/.env; on Render the env vars are set on the service
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

DB_HOST = os.getenv("DB_HOST", "aws-0-ap-northeast-2.pooler.supabase.com")
DB_PORT = int(os.getenv("DB_PORT", "6543"))  # transaction pooler
DB_USER = os.getenv("DB_USER", "xiao_api.butmwwmzrrpfwutezuns")
DB_PASSWORD = os.environ["DB_PASSWORD"]
JWT_SECRET = os.environ["JWT_SECRET"]
DEVICE_KEY = os.environ["DEVICE_KEY"]
DEVICE_ID = os.getenv("DEVICE_ID", "xiao-01")
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",")]

TOKEN_HOURS = 24
ONLINE_SECONDS = 10       # board reports every second
LOG_EVERY_SECONDS = 5     # history row at most every 5 s (and on every touch change)
LOG_KEEP_HOURS = 24
PRUNE_EVERY_SECONDS = 600

pool = ConnectionPool(
    kwargs=dict(
        host=DB_HOST, port=DB_PORT, dbname="postgres", user=DB_USER, password=DB_PASSWORD,
        autocommit=True, row_factory=dict_row,
        prepare_threshold=None,  # the transaction pooler does not support prepared statements
    ),
    min_size=1, max_size=4, open=False,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.open()
    yield
    pool.close()


app = FastAPI(title="XIAO IoT API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Models ----------

class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)  # bcrypt uses at most 72 bytes


class User(BaseModel):
    id: str
    email: str
    created_at: datetime


class AuthResponse(BaseModel):
    token: str
    user: User


class DeviceState(BaseModel):
    id: str
    led: bool
    touched: bool
    touch_value: int
    threshold: int
    rssi: int
    updated_at: datetime
    online: bool


class LedCommand(BaseModel):
    state: Literal["on", "off", "toggle"]


class SensorLog(BaseModel):
    touched: bool
    touch_value: int
    threshold: int
    rssi: int
    led: bool
    created_at: datetime


class DeviceReport(BaseModel):
    touched: bool
    touch_value: int = Field(ge=0)
    threshold: int = Field(ge=0)
    rssi: int


class DeviceReply(BaseModel):
    led: bool


# ---------- Auth ----------

bearer = HTTPBearer(auto_error=False)


def make_token(user: dict) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user["id"]), "email": user["email"], "iat": now,
               "exp": now + timedelta(hours=TOKEN_HOURS)}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def to_user(row: dict) -> User:
    return User(id=str(row["id"]), email=row["email"], created_at=row["created_at"])


def current_user(cred: HTTPAuthorizationCredentials | None = Depends(bearer)) -> User:
    if cred is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "로그인이 필요합니다")
    try:
        payload = jwt.decode(cred.credentials, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "토큰이 만료되었습니다. 다시 로그인하세요")
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "유효하지 않은 토큰입니다")
    with pool.connection() as conn:
        row = conn.execute("select id, email, created_at from xiao_users where id = %s",
                           (payload["sub"],)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "사용자를 찾을 수 없습니다")
    return to_user(row)


@app.post("/api/auth/signup", response_model=AuthResponse, status_code=201, tags=["auth"])
def signup(body: Credentials):
    hashed = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
    try:
        with pool.connection() as conn:
            row = conn.execute(
                "insert into xiao_users (email, password_hash) values (%s, %s) "
                "returning id, email, created_at",
                (body.email.lower(), hashed)).fetchone()
    except UniqueViolation:
        raise HTTPException(status.HTTP_409_CONFLICT, "이미 가입된 이메일입니다")
    return AuthResponse(token=make_token(row), user=to_user(row))


@app.post("/api/auth/login", response_model=AuthResponse, tags=["auth"])
def login(body: Credentials):
    with pool.connection() as conn:
        row = conn.execute("select id, email, password_hash, created_at from xiao_users where email = %s",
                           (body.email.lower(),)).fetchone()
    if row is None or not bcrypt.checkpw(body.password.encode(), row["password_hash"].encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "이메일 또는 비밀번호가 올바르지 않습니다")
    return AuthResponse(token=make_token(row), user=to_user(row))


@app.get("/api/auth/me", response_model=User, tags=["auth"])
def me(user: User = Depends(current_user)):
    return user


# ---------- Dashboard (login required) ----------

DEVICE_SELECT = (
    "select id, led, touched, touch_value, threshold, rssi, updated_at, "
    f"now() - updated_at < interval '{ONLINE_SECONDS} seconds' as online "
    "from xiao_devices where id = %s"
)


@app.get("/api/device", response_model=DeviceState, tags=["device"])
def get_device(user: User = Depends(current_user)):
    with pool.connection() as conn:
        row = conn.execute(DEVICE_SELECT, (DEVICE_ID,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "장치가 없습니다")
    return row


@app.post("/api/device/led", response_model=DeviceState, tags=["device"])
def set_led(body: LedCommand, user: User = Depends(current_user)):
    # updated_at is written only on board reports - it is the board's heartbeat
    value = {"on": "true", "off": "false", "toggle": "not led"}[body.state]
    with pool.connection() as conn:
        conn.execute(f"update xiao_devices set led = {value} where id = %s", (DEVICE_ID,))
        return conn.execute(DEVICE_SELECT, (DEVICE_ID,)).fetchone()


@app.get("/api/device/history", response_model=list[SensorLog], tags=["device"])
def history(minutes: int = Query(10, ge=1, le=LOG_KEEP_HOURS * 60), user: User = Depends(current_user)):
    with pool.connection() as conn:
        return conn.execute(
            "select touched, touch_value, threshold, rssi, led, created_at from xiao_sensor_logs "
            "where device_id = %s and created_at > now() - make_interval(mins => %s) "
            "order by created_at limit 2000",
            (DEVICE_ID, minutes)).fetchall()


# ---------- Board ----------

_last_log = {"at": 0.0, "touched": None}
_last_prune = 0.0


@app.post("/api/device/report", response_model=DeviceReply, tags=["board"])
def device_report(body: DeviceReport, x_device_key: str = Header(default="")):
    global _last_prune
    if not hmac.compare_digest(x_device_key, DEVICE_KEY):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "장치 키가 올바르지 않습니다")

    with pool.connection() as conn:
        row = conn.execute(
            "update xiao_devices set touched = %s, touch_value = %s, threshold = %s, rssi = %s, "
            "updated_at = now() where id = %s returning led",
            (body.touched, body.touch_value, body.threshold, body.rssi, DEVICE_ID)).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "장치가 없습니다")

        now = time.monotonic()
        if now - _last_log["at"] >= LOG_EVERY_SECONDS or body.touched != _last_log["touched"]:
            conn.execute(
                "insert into xiao_sensor_logs (device_id, touched, touch_value, threshold, rssi, led) "
                "values (%s, %s, %s, %s, %s, %s)",
                (DEVICE_ID, body.touched, body.touch_value, body.threshold, body.rssi, row["led"]))
            _last_log.update(at=now, touched=body.touched)

        if now - _last_prune >= PRUNE_EVERY_SECONDS:
            conn.execute("delete from xiao_sensor_logs where created_at < now() - make_interval(hours => %s)",
                         (LOG_KEEP_HOURS,))
            _last_prune = now

    return DeviceReply(led=row["led"])


@app.get("/api/health", tags=["health"])
def health():
    with pool.connection() as conn:
        conn.execute("select 1")
    return {"ok": True}
