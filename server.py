#!/usr/bin/env python3
"""
Волна — локальный аудио-хостинг.

Один файл, только стандартная библиотека Python:
  * HTTP-сервер (http.server) и JSON-база (data/db.json);
  * аккаунты с настройками профиля и пароля;
  * загрузка аудио, публичное прослушивание и бесплатное скачивание.

Запуск:  python3 server.py [--port 8000] [--host 127.0.0.1]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import threading
import time
import traceback
import unicodedata
import uuid
import webbrowser
from collections import Counter
from datetime import datetime, timezone
from email.utils import formatdate
from html import escape as html_escape
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

# --------------------------------------------------------------------------
# Конфигурация
# --------------------------------------------------------------------------

VERSION = "2.2.0"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(DATA_DIR, "db.json")
SECRET_PATH = os.path.join(DATA_DIR, "secret.key")

MAX_UPLOAD_BYTES = 80 * 1024 * 1024          # 80 МБ на файл
MAX_JSON_BYTES = 256 * 1024                  # тела JSON-запросов
MAX_COMMENT_LEN = 1000
SESSION_TTL = 30 * 24 * 60 * 60              # 30 дней
SESSION_COOKIE = "session"
PBKDF2_ITERATIONS = 240_000

AUDIO_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
    ".weba": "audio/webm",
}

USERNAME_RE = re.compile(r"^[\w.-]{3,24}$", re.UNICODE)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

USERNAME_TAKEN = "Это имя пользователя уже занято"
BAD_CREDENTIALS = "Неверное имя пользователя или пароль"
LOGIN_REQUIRED = "Для этого действия нужно войти в аккаунт"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def iso_from_ts(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(timespec="seconds")


def load_or_create_secret(path: str) -> bytes:
    """Ключ подписи cookie-сессий. Создаётся один раз и не попадает в Git."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, "rb") as fh:
            secret = fh.read()
        if len(secret) >= 32:
            return secret
    except FileNotFoundError:
        pass
    secret = secrets.token_bytes(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(secret)
    return secret


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# --------------------------------------------------------------------------
# JSON-база
# --------------------------------------------------------------------------

class Database:
    """Небольшая потокобезопасная JSON-база с атомарной записью."""

    def __init__(self, path: str):
        self.path = path
        self.lock = threading.RLock()
        self.data = self._load()

    def _empty(self) -> dict[str, Any]:
        return {
            "meta": {"version": 2, "created_at": now_iso()},
            "users": {},
            "tracks": {},
            "comments": {},
        }

    def _load(self) -> dict[str, Any]:
        if not os.path.exists(self.path):
            data = self._empty()
            self._write(data)
            return data
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            backup = f"{self.path}.broken-{int(time.time())}"
            try:
                shutil.copy2(self.path, backup)
            except OSError:
                pass
            print(f"[db] Не удалось прочитать {self.path}: {exc}")
            print(f"[db] Повреждённый файл сохранён как {backup}, создаю новую базу.")
            data = self._empty()
            self._write(data)
            return data
        changed = False
        if "sessions" in data:
            data.pop("sessions")
            changed = True
        for key, default in (("users", {}), ("tracks", {}), ("comments", {}), ("meta", {})):
            if key not in data:
                data[key] = default
                changed = True
        if data["meta"].get("version") != 2:
            data["meta"]["version"] = 2
            changed = True
        data["meta"].setdefault("created_at", now_iso())
        for user in data["users"].values():
            if "session_version" not in user:
                user["session_version"] = 0
                changed = True
        for track in data["tracks"].values():
            if "likes" not in track:
                track["likes"] = []
                changed = True
        if changed:
            self._write(data)
        return data

    def _write(self, data: dict[str, Any]) -> None:
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)

    def save(self) -> None:
        with self.lock:
            self._write(self.data)


# --------------------------------------------------------------------------
# Пароли и пользователи
# --------------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt_hex, digest_hex = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def find_user_by_username(db: Database, username: str) -> dict[str, Any] | None:
    target = username.casefold()
    for user in db.data["users"].values():
        if user["username"].casefold() == target:
            return user
    return None


def user_tracks(db: Database, user_id: str) -> list[dict[str, Any]]:
    return [t for t in db.data["tracks"].values() if t["user_id"] == user_id]


def user_public(db: Database, user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user.get("display_name") or user["username"],
        "avatar": user.get("avatar") or "🎵",
        "accent": user.get("accent") or "#8b5cf6",
        "bio": user.get("bio") or "",
        "created_at": user.get("created_at"),
    }


def comment_counts(db: Database) -> Counter:
    counts: Counter = Counter()
    for comment in db.data["comments"].values():
        counts[comment.get("track_id")] += 1
    return counts


def comment_count_for_track(db: Database, track_id: str) -> int:
    return sum(1 for c in db.data["comments"].values() if c.get("track_id") == track_id)


def profile_stats(db: Database, user: dict[str, Any]) -> dict[str, int]:
    tracks = user_tracks(db, user["id"])
    track_ids = {track["id"] for track in tracks}
    return {
        "tracks": len(tracks),
        "plays": sum(int(t.get("plays", 0)) for t in tracks),
        "downloads": sum(int(t.get("downloads", 0)) for t in tracks),
        "likes": sum(len(t.get("likes", [])) for t in tracks),
        "comments": sum(
            1 for comment in db.data["comments"].values()
            if comment.get("track_id") in track_ids
        ),
    }


def user_private(db: Database, user: dict[str, Any]) -> dict[str, Any]:
    payload = user_public(db, user)
    tracks = user_tracks(db, user["id"])
    track_ids = {track["id"] for track in tracks}
    payload.update({
        "email": user.get("email") or "",
        "tracks_count": len(tracks),
        "plays_total": sum(int(t.get("plays", 0)) for t in tracks),
        "downloads_total": sum(int(t.get("downloads", 0)) for t in tracks),
        "likes_received": sum(len(t.get("likes", [])) for t in tracks),
        "comments_received": sum(
            1 for comment in db.data["comments"].values()
            if comment.get("track_id") in track_ids
        ),
        "last_login_at": user.get("last_login_at"),
        "likes_given": sum(
            1 for track in db.data["tracks"].values()
            if user["id"] in track.get("likes", [])
        ),
        "comments_written": sum(
            1 for comment in db.data["comments"].values()
            if comment.get("user_id") == user["id"]
        ),
    })
    return payload


def public_track(
    db: Database,
    track: dict[str, Any],
    viewer_id: str | None,
    comment_count: int | None = None,
) -> dict[str, Any]:
    author = db.data["users"].get(track["user_id"])
    author_payload = user_public(db, author) if author else {
        "id": None,
        "username": "deleted",
        "display_name": "Удалённый пользователь",
        "avatar": "👻",
        "accent": "#6b7280",
        "bio": "",
        "created_at": None,
    }
    likes = track.get("likes", [])
    return {
        "id": track["id"],
        "title": track["title"],
        "description": track.get("description") or "",
        "created_at": track.get("created_at"),
        "size": int(track.get("size", 0)),
        "mime": track.get("mime") or "audio/mpeg",
        "ext": track.get("ext") or ".mp3",
        "plays": int(track.get("plays", 0)),
        "downloads": int(track.get("downloads", 0)),
        "likes": len(likes),
        "liked": bool(viewer_id and viewer_id in likes),
        "comment_count": (
            int(comment_count) if comment_count is not None
            else comment_count_for_track(db, track["id"])
        ),
        "author": author_payload,
        "mine": bool(viewer_id and track["user_id"] == viewer_id),
    }


def public_comment(
    db: Database,
    comment: dict[str, Any],
    viewer_id: str | None,
    track_owner_id: str | None,
) -> dict[str, Any]:
    author = db.data["users"].get(comment.get("user_id"))
    author_payload = user_public(db, author) if author else {
        "id": None,
        "username": "deleted",
        "display_name": "Удалённый пользователь",
        "avatar": "👻",
        "accent": "#6b7280",
        "bio": "",
        "created_at": None,
    }
    return {
        "id": comment["id"],
        "text": comment.get("text", ""),
        "created_at": comment.get("created_at"),
        "author": author_payload,
        "mine": bool(viewer_id and viewer_id == comment.get("user_id")),
        "can_delete": bool(
            viewer_id and (
                viewer_id == comment.get("user_id")
                or viewer_id == track_owner_id
            )
        ),
    }


# --------------------------------------------------------------------------
# Валидация
# --------------------------------------------------------------------------

def clean_text(value: Any, *, field: str, max_len: int, min_len: int = 0) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(400, f"Поле «{field}» должно быть строкой")
    value = value.strip()
    if len(value) < min_len:
        raise ApiError(400, f"Поле «{field}» слишком короткое")
    if len(value) > max_len:
        raise ApiError(400, f"Поле «{field}» не должно быть длиннее {max_len} символов")
    return value


def validate_username(raw: Any) -> str:
    username = clean_text(raw, field="Имя пользователя", max_len=24, min_len=3)
    if not USERNAME_RE.match(username):
        raise ApiError(400, "Имя пользователя: 3–24 символа, только буквы, цифры, «_», «-», «.»")
    return username


def validate_password(raw: Any, *, field: str = "Пароль") -> str:
    if not isinstance(raw, str):
        raise ApiError(400, f"Поле «{field}» обязательно")
    if len(raw) < 6:
        raise ApiError(400, "Пароль должен содержать минимум 6 символов")
    if len(raw) > 200:
        raise ApiError(400, "Пароль слишком длинный")
    return raw


def validate_email(raw: Any) -> str:
    email = clean_text(raw, field="Email", max_len=254)
    if email and not EMAIL_RE.match(email):
        raise ApiError(400, "Некорректный email")
    return email


def validate_accent(raw: Any) -> str:
    accent = clean_text(raw, field="Цвет", max_len=7)
    if not accent:
        return "#8b5cf6"
    if not ACCENT_RE.match(accent):
        raise ApiError(400, "Цвет должен быть в формате #RRGGBB")
    return accent.lower()


# --------------------------------------------------------------------------
# Multipart/form-data
# --------------------------------------------------------------------------

def parse_multipart(body: bytes, boundary: bytes) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    fields: dict[str, str] = {}
    files: dict[str, dict[str, Any]] = {}
    delimiter = b"--" + boundary

    for segment in body.split(delimiter):
        if not segment or segment in (b"--\r\n", b"--"):
            continue
        if segment.startswith(b"\r\n"):
            segment = segment[2:]
        if segment.startswith(b"--"):
            continue
        if segment.endswith(b"\r\n"):
            segment = segment[:-2]

        head_end = segment.find(b"\r\n\r\n")
        if head_end < 0:
            continue
        raw_headers = segment[:head_end].decode("utf-8", "replace")
        content = segment[head_end + 4:]

        disposition = ""
        for line in raw_headers.split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                disposition = line
                break
        if not disposition:
            continue

        name_match = re.search(r'(?:^|;)\s*name="([^"]*)"', disposition)
        if not name_match:
            continue
        name = name_match.group(1)
        filename_match = re.search(r'(?:^|;)\s*filename="([^"]*)"', disposition)
        if filename_match is not None:
            files[name] = {
                "filename": filename_match.group(1),
                "content": content,
            }
        else:
            fields[name] = content.decode("utf-8", "replace")

    return fields, files


# --------------------------------------------------------------------------
# Cookie-сессии
# --------------------------------------------------------------------------

def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def build_session(secret: bytes, user: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    now = int(time.time())
    payload = {
        "u": user["id"],
        "v": int(user.get("session_version", 0)),
        "i": now,
        "e": now + SESSION_TTL,
    }
    body = b64url_encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    signature = b64url_encode(
        hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest()
    )
    return f"v1.{body}.{signature}", payload


def verify_session(secret: bytes, value: str) -> dict[str, Any] | None:
    try:
        version, body, signature = value.split(".")
        if version != "v1":
            return None
        expected = b64url_encode(
            hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(b64url_decode(body).decode("utf-8"))
        if not isinstance(payload, dict):
            return None
        if int(payload.get("e", 0)) <= int(time.time()):
            return None
        if not isinstance(payload.get("u"), str):
            return None
        return payload
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def session_info(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "cookie",
        "issued_at": iso_from_ts(int(payload.get("i", 0))),
        "expires_at": iso_from_ts(int(payload.get("e", 0))),
    }


def session_cookie_header(token: str, expires_at: float | None = None) -> str:
    expires = formatdate(
        expires_at if expires_at is not None else time.time() + SESSION_TTL,
        usegmt=True,
    )
    return (
        f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; "
        f"Max-Age={SESSION_TTL}; Expires={expires}"
    )


def clear_session_cookie_header() -> str:
    return (
        f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; "
        "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    )


# --------------------------------------------------------------------------
# HTTP-сервер
# --------------------------------------------------------------------------

class VolnaHandler(BaseHTTPRequestHandler):
    server_version = f"Volna/{VERSION}"
    protocol_version = "HTTP/1.1"

    db: Database = None  # type: ignore[assignment]
    secret: bytes = b""

    # -- служебное ---------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:
        stamp = time.strftime("%H:%M:%S")
        print(f"[{stamp}] {self.address_string()} {fmt % args}")

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._head_only = True
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        try:
            parsed = urlparse(self.path)
            self.path_only = unquote(parsed.path)
            self.query = parse_qs(parsed.query)
            self._route(method)
        except ApiError as exc:
            self._safe_json(exc.status, {"error": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self._safe_json(500, {"error": "Внутренняя ошибка сервера"})

    # -- ответы ------------------------------------------------------------

    def _common_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")

    def _safe_json(self, status: int, payload: dict[str, Any]) -> None:
        try:
            self.send_json(status, payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(
        self,
        status: int,
        payload: dict[str, Any],
        *,
        cookie: str | None = None,
    ) -> None:
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self._common_headers()
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json(status, {"error": message})

    def redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self, limit: int) -> bytes:
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            raise ApiError(411, "Требуется заголовок Content-Length")
        try:
            length = int(raw_len)
        except ValueError:
            raise ApiError(400, "Некорректный Content-Length")
        if length < 0:
            raise ApiError(400, "Некорректный Content-Length")
        if length > limit:
            raise ApiError(413, "Слишком большой запрос")
        data = b""
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1024 * 1024))
            if not chunk:
                break
            data += chunk
            remaining -= len(chunk)
        return data

    def read_json(self) -> dict[str, Any]:
        body = self.read_body(MAX_JSON_BYTES)
        if not body:
            return {}
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "Ожидался корректный JSON")
        if not isinstance(payload, dict):
            raise ApiError(400, "JSON должен быть объектом")
        return payload

    # -- сессии ------------------------------------------------------------

    def _cookie_value(self, name: str) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            cookie = SimpleCookie(raw)
        except Exception:
            return None
        morsel = cookie.get(name)
        return morsel.value if morsel else None

    def current_session(self) -> tuple[dict[str, Any], dict[str, Any]] | None:
        if getattr(self, "_session_checked", False):
            return self._session_result
        self._session_checked = True
        self._session_result = None
        token = self._cookie_value(SESSION_COOKIE)
        if not token:
            return None
        payload = verify_session(self.secret, token)
        if not payload:
            return None
        user = self.db.data["users"].get(payload.get("u"))
        if not user:
            return None
        if int(user.get("session_version", 0)) != int(payload.get("v", -1)):
            return None
        self._session_result = (user, payload)
        return self._session_result

    def current_user(self) -> dict[str, Any] | None:
        session = self.current_session()
        return session[0] if session else None

    def require_user(self) -> dict[str, Any]:
        user = self.current_user()
        if not user:
            raise ApiError(401, LOGIN_REQUIRED)
        return user

    def issue_session(self, user: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        token, payload = build_session(self.secret, user)
        self._session_checked = True
        self._session_result = (user, payload)
        return session_cookie_header(token, payload["e"]), payload

    def clear_session(self) -> None:
        self._session_checked = True
        self._session_result = None

    # -- маршрутизация -----------------------------------------------------

    def _route(self, method: str) -> None:
        path = self.path_only
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")

        if method == "GET":
            if path in ("/", "/upload", "/account"):
                return self.serve_spa(path)
            if path == "/index.html":
                return self.serve_static("index.html")
            if re.match(r"^/track/[a-f0-9]+$", path):
                return self.serve_spa(path)
            if re.match(r"^/u/[^/]+$", path):
                return self.serve_spa(path)
            if path == "/health":
                return self.send_json(200, {"ok": True, "version": VERSION, "time": now_iso()})
            if path.startswith("/static/"):
                return self.serve_static(path[len("/static/"):])
            if path == "/favicon.ico":
                return self.serve_static("favicon.svg")
            if path == "/api/me":
                return self.api_me()
            if path == "/api/me/likes":
                return self.api_my_likes()
            if path == "/api/me/comments":
                return self.api_my_comments()
            if path == "/api/tracks":
                return self.api_list_tracks()
            m = re.match(r"^/api/users/([^/]+)$", path)
            if m:
                return self.api_user_profile(m.group(1))
            m = re.match(r"^/api/tracks/([a-f0-9]+)$", path)
            if m:
                return self.api_track_detail(m.group(1))
            if path.startswith("/audio/"):
                return self.api_stream_audio(path[len("/audio/"):])
            m = re.match(r"^/api/tracks/([a-f0-9]+)/download$", path)
            if m:
                return self.api_download(m.group(1))
            raise ApiError(404, "Не найдено")

        if method == "POST":
            if path == "/api/register":
                return self.api_register()
            if path == "/api/login":
                return self.api_login()
            if path == "/api/logout":
                return self.api_logout()
            if path == "/api/account/logout-all":
                return self.api_logout_all()
            if path == "/api/account/delete":
                return self.api_delete_account()
            if path == "/api/tracks":
                return self.api_upload_track()
            m = re.match(r"^/api/tracks/([a-f0-9]+)/play$", path)
            if m:
                return self.api_play(m.group(1))
            m = re.match(r"^/api/tracks/([a-f0-9]+)/like$", path)
            if m:
                return self.api_toggle_like(m.group(1))
            m = re.match(r"^/api/tracks/([a-f0-9]+)/comments$", path)
            if m:
                return self.api_add_comment(m.group(1))
            raise ApiError(404, "Не найдено")

        if method == "PATCH":
            if path == "/api/account":
                return self.api_update_account()
            m = re.match(r"^/api/tracks/([a-f0-9]+)$", path)
            if m:
                return self.api_update_track(m.group(1))
            raise ApiError(404, "Не найдено")

        if method == "DELETE":
            if path == "/api/account":
                return self.api_delete_account()
            m = re.match(r"^/api/tracks/([a-f0-9]+)$", path)
            if m:
                return self.api_delete_track(m.group(1))
            m = re.match(r"^/api/comments/([a-f0-9]+)$", path)
            if m:
                return self.api_delete_comment(m.group(1))
            raise ApiError(404, "Не найдено")

        raise ApiError(405, "Метод не поддерживается")

    # -- статика -----------------------------------------------------------

    def serve_static(self, relative: str) -> None:
        relative = relative.lstrip("/") or "index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, relative))
        root = os.path.realpath(STATIC_DIR)
        if not (full == root or full.startswith(root + os.sep)) or not os.path.isfile(full):
            raise ApiError(404, "Файл не найден")

        stat = os.stat(full)
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self._common_headers()
            self.end_headers()
            return

        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as fh:
            body = fh.read()

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self._common_headers()
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)

    @staticmethod
    def _inject_meta(html: str, title: str, description: str, og_type: str) -> str:
        safe_title = html_escape(title, quote=True)
        safe_desc = html_escape(description, quote=True)
        html = re.sub(r"<title>.*?</title>", f"<title>{safe_title}</title>",
                      html, count=1, flags=re.S)
        html = re.sub(r'<meta name="description" content="[^"]*">',
                      f'<meta name="description" content="{safe_desc}">', html, count=1)
        html = re.sub(r'<meta property="og:title" content="[^"]*">',
                      f'<meta property="og:title" content="{safe_title}">', html, count=1)
        html = re.sub(r'<meta property="og:description" content="[^"]*">',
                      f'<meta property="og:description" content="{safe_desc}">', html, count=1)
        html = re.sub(r'<meta property="og:type" content="[^"]*">',
                      f'<meta property="og:type" content="{html_escape(og_type, quote=True)}">',
                      html, count=1)
        return html

    def serve_spa(self, path: str) -> None:
        index_path = os.path.join(STATIC_DIR, "index.html")
        with open(index_path, "r", encoding="utf-8") as fh:
            html = fh.read()

        title = "Волна — аудио без границ"
        description = (
            "Локальный аудио-хостинг: слушайте и скачивайте треки без регистрации, "
            "загружайте свои и общайтесь с авторами."
        )
        og_type = "website"

        with self.db.lock:
            track_match = re.match(r"^/track/([a-f0-9]+)$", path)
            user_match = re.match(r"^/u/([^/]+)$", path)
            if track_match:
                track = self.db.data["tracks"].get(track_match.group(1))
                if track:
                    author = self.db.data["users"].get(track["user_id"])
                    author_name = (author.get("display_name") if author else None) or "Волна"
                    title = f"{track['title']} — {author_name} — Волна"
                    description = (
                        track.get("description")
                        or f"Слушайте «{track['title']}» на Волне и скачивайте бесплатно."
                    )[:180]
                    og_type = "music.song"
            elif user_match:
                user = find_user_by_username(self.db, user_match.group(1))
                if user:
                    title = f"{user.get('display_name') or user['username']} (@{user['username']}) — Волна"
                    description = (
                        user.get("bio")
                        or f"Профиль @{user['username']} на Волне: треки, лайки и комментарии."
                    )[:180]
                    og_type = "profile"

        description = re.sub(r"\s+", " ", description).strip()
        html = self._inject_meta(html, title, description, og_type)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self._common_headers()
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)

    # -- API: аккаунты -----------------------------------------------------

    def api_me(self) -> None:
        session = self.current_session()
        if not session:
            return self.send_json(200, {"user": None, "session": None})
        user, payload = session
        self.send_json(200, {
            "user": user_private(self.db, user),
            "session": session_info(payload),
        })

    def api_register(self) -> None:
        payload = self.read_json()
        username = validate_username(payload.get("username"))
        password = validate_password(payload.get("password"))
        display_name = clean_text(
            payload.get("display_name") or username,
            field="Отображаемое имя", max_len=40, min_len=1,
        )
        email = validate_email(payload.get("email") or "")
        avatar = clean_text(payload.get("avatar") or "🎵", field="Аватар", max_len=8) or "🎵"

        with self.db.lock:
            if find_user_by_username(self.db, username):
                raise ApiError(409, USERNAME_TAKEN)
            user = {
                "id": uuid.uuid4().hex[:12],
                "username": username,
                "display_name": display_name,
                "email": email,
                "bio": "",
                "avatar": avatar,
                "accent": "#8b5cf6",
                "password_hash": hash_password(password),
                "session_version": 0,
                "created_at": now_iso(),
                "last_login_at": now_iso(),
            }
            self.db.data["users"][user["id"]] = user
            self.db.save()

        cookie, session_payload = self.issue_session(user)
        self.send_json(201, {
            "user": user_private(self.db, user),
            "session": session_info(session_payload),
        }, cookie=cookie)

    def api_login(self) -> None:
        payload = self.read_json()
        username = clean_text(payload.get("username"), field="Имя пользователя", max_len=64)
        password = payload.get("password")
        if not isinstance(password, str) or not password:
            raise ApiError(400, "Введите пароль")

        with self.db.lock:
            user = find_user_by_username(self.db, username)
            if not user or not verify_password(password, user["password_hash"]):
                raise ApiError(401, BAD_CREDENTIALS)
            user["last_login_at"] = now_iso()
            self.db.save()

        cookie, session_payload = self.issue_session(user)
        self.send_json(200, {
            "user": user_private(self.db, user),
            "session": session_info(session_payload),
        }, cookie=cookie)

    def api_logout(self) -> None:
        self.clear_session()
        self.send_json(200, {"ok": True}, cookie=clear_session_cookie_header())

    def api_logout_all(self) -> None:
        user = self.require_user()
        with self.db.lock:
            user["session_version"] = int(user.get("session_version", 0)) + 1
            self.db.save()
        cookie, payload = self.issue_session(user)
        self.send_json(200, {
            "ok": True,
            "session": session_info(payload),
        }, cookie=cookie)

    def api_update_account(self) -> None:
        user = self.require_user()
        payload = self.read_json()
        current_password = payload.get("current_password")
        new_username = validate_username(payload["username"]) if "username" in payload else None
        wants_username = new_username is not None and new_username != user["username"]
        wants_password = "new_password" in payload

        if (wants_username or wants_password) and not current_password:
            raise ApiError(400, "Для изменения имени или пароля введите текущий пароль")

        if wants_username or wants_password:
            if not isinstance(current_password, str) or not verify_password(
                current_password, user["password_hash"]
            ):
                raise ApiError(403, "Текущий пароль неверен")

        cookie = None
        session_payload = None
        with self.db.lock:
            if wants_username:
                existing = find_user_by_username(self.db, new_username)
                if existing and existing["id"] != user["id"]:
                    raise ApiError(409, USERNAME_TAKEN)
                user["username"] = new_username

            if "display_name" in payload:
                display_name = clean_text(
                    payload.get("display_name"), field="Отображаемое имя", max_len=40
                )
                user["display_name"] = display_name or user["username"]

            if "email" in payload:
                user["email"] = validate_email(payload.get("email"))

            if "bio" in payload:
                user["bio"] = clean_text(payload.get("bio"), field="О себе", max_len=300)

            if "avatar" in payload:
                avatar = clean_text(payload.get("avatar"), field="Аватар", max_len=8)
                user["avatar"] = avatar or "🎵"

            if "accent" in payload:
                user["accent"] = validate_accent(payload.get("accent"))

            if wants_password:
                new_password = validate_password(payload.get("new_password"), field="Новый пароль")
                user["password_hash"] = hash_password(new_password)
                user["session_version"] = int(user.get("session_version", 0)) + 1
                self.db.save()
                cookie, session_payload = self.issue_session(user)
            else:
                self.db.save()
                session = self.current_session()
                session_payload = session[1] if session else None

        result = {"user": user_private(self.db, user)}
        if session_payload:
            result["session"] = session_info(session_payload)
        self.send_json(200, result, cookie=cookie)

    def api_delete_account(self) -> None:
        user = self.require_user()
        payload = self.read_json()
        password = payload.get("password")
        if not isinstance(password, str) or not verify_password(password, user["password_hash"]):
            raise ApiError(403, "Пароль неверен")

        with self.db.lock:
            tracks = user_tracks(self.db, user["id"])
            track_ids = {track["id"] for track in tracks}
            for track in tracks:
                self._remove_track_file(track)
                self.db.data["tracks"].pop(track["id"], None)
            for comment_id, comment in list(self.db.data["comments"].items()):
                if comment.get("user_id") == user["id"] or comment.get("track_id") in track_ids:
                    del self.db.data["comments"][comment_id]
            for track in self.db.data["tracks"].values():
                likes = track.get("likes", [])
                if user["id"] in likes:
                    track["likes"] = [uid for uid in likes if uid != user["id"]]
            self.db.data["users"].pop(user["id"], None)
            self.db.save()

        self.clear_session()
        self.send_json(200, {"ok": True}, cookie=clear_session_cookie_header())

    # -- API: треки --------------------------------------------------------

    def api_list_tracks(self) -> None:
        viewer = self.current_user()
        viewer_id = viewer["id"] if viewer else None
        query = (self.query.get("q", [""])[0] or "").strip().casefold()
        author = (self.query.get("author", [""])[0] or "").strip().casefold()
        sort = (self.query.get("sort", ["new"])[0] or "new").lower()

        with self.db.lock:
            counts = comment_counts(self.db)
            tracks = [
                public_track(self.db, track, viewer_id, counts.get(track["id"], 0))
                for track in self.db.data["tracks"].values()
            ]

        if author:
            tracks = [t for t in tracks if t["author"]["username"].casefold() == author]
        if query:
            tracks = [
                t for t in tracks
                if query in t["title"].casefold()
                or query in t["description"].casefold()
                or query in t["author"]["display_name"].casefold()
                or query in t["author"]["username"].casefold()
            ]
        if sort == "popular":
            tracks.sort(key=lambda t: (t["plays"], t["likes"]), reverse=True)
        elif sort == "discussed":
            tracks.sort(key=lambda t: t["comment_count"], reverse=True)
        else:
            tracks.sort(key=lambda t: t.get("created_at") or "", reverse=True)
        self.send_json(200, {"tracks": tracks, "count": len(tracks)})

    def api_track_detail(self, track_id: str) -> None:
        session = self.current_session()
        viewer = session[0] if session else None
        viewer_id = viewer["id"] if viewer else None

        with self.db.lock:
            track = self.db.data["tracks"].get(track_id)
            if not track:
                raise ApiError(404, "Трек не найден")
            comments = [
                c for c in self.db.data["comments"].values()
                if c.get("track_id") == track_id
            ]
            comments.sort(key=lambda c: c.get("created_at") or "", reverse=True)
            counts = comment_counts(self.db)
            payload = public_track(
                self.db, track, viewer_id, counts.get(track_id, 0)
            )
            comment_payloads = [
                public_comment(self.db, c, viewer_id, track["user_id"])
                for c in comments
            ]
            related = [
                t for t in self.db.data["tracks"].values()
                if t["user_id"] == track["user_id"] and t["id"] != track_id
            ]
            related.sort(key=lambda t: t.get("created_at") or "", reverse=True)
            related_payloads = [
                public_track(self.db, t, viewer_id, counts.get(t["id"], 0))
                for t in related[:4]
            ]

        self.send_json(200, {
            "track": payload,
            "comments": comment_payloads,
            "related": related_payloads,
            "viewer": {"authenticated": bool(viewer)},
        })

    def api_user_profile(self, username: str) -> None:
        viewer = self.current_user()
        viewer_id = viewer["id"] if viewer else None
        with self.db.lock:
            user = find_user_by_username(self.db, username)
            if not user:
                raise ApiError(404, "Пользователь не найден")
            counts = comment_counts(self.db)
            tracks = sorted(
                user_tracks(self.db, user["id"]),
                key=lambda t: t.get("created_at") or "",
                reverse=True,
            )
            track_payloads = [
                public_track(self.db, t, viewer_id, counts.get(t["id"], 0))
                for t in tracks
            ]
            payload = user_public(self.db, user)
            payload["stats"] = profile_stats(self.db, user)

        payload["is_self"] = bool(viewer_id and viewer_id == user["id"])
        self.send_json(200, {"user": payload, "tracks": track_payloads})

    def api_my_likes(self) -> None:
        user = self.require_user()
        with self.db.lock:
            counts = comment_counts(self.db)
            tracks = [
                t for t in self.db.data["tracks"].values()
                if user["id"] in t.get("likes", [])
            ]
            tracks.sort(key=lambda t: t.get("created_at") or "", reverse=True)
            payloads = [
                public_track(self.db, t, user["id"], counts.get(t["id"], 0))
                for t in tracks
            ]
        self.send_json(200, {"tracks": payloads})

    def api_my_comments(self) -> None:
        user = self.require_user()
        with self.db.lock:
            comments = [
                c for c in self.db.data["comments"].values()
                if c.get("user_id") == user["id"]
            ]
            comments.sort(key=lambda c: c.get("created_at") or "", reverse=True)
            payloads = []
            for comment in comments:
                track = self.db.data["tracks"].get(comment.get("track_id"))
                if not track:
                    continue
                item = public_comment(self.db, comment, user["id"], track["user_id"])
                item["track"] = {
                    "id": track["id"],
                    "title": track["title"],
                    "author": user_public(self.db, self.db.data["users"].get(track["user_id"]))
                    if self.db.data["users"].get(track["user_id"]) else None,
                }
                payloads.append(item)
        self.send_json(200, {"comments": payloads})

    def api_upload_track(self) -> None:
        user = self.require_user()
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type.lower():
            raise ApiError(400, "Ожидалась форма с файлом (multipart/form-data)")
        boundary_match = re.search('boundary=(?:"([^"]+)"|([^;]+))', content_type)
        if not boundary_match:
            raise ApiError(400, "Не удалось определить boundary формы")
        boundary = (boundary_match.group(1) or boundary_match.group(2) or "").strip()
        if not boundary:
            raise ApiError(400, "Некорректный boundary формы")

        body = self.read_body(MAX_UPLOAD_BYTES + 1024 * 1024)
        fields, files = parse_multipart(body, boundary.encode("utf-8", "replace"))

        title = clean_text(fields.get("title"), field="Название", max_len=120, min_len=1)
        description = clean_text(fields.get("description"), field="Описание", max_len=1000)
        upload = files.get("file")
        if not upload or not upload.get("content"):
            raise ApiError(400, "Выберите аудиофайл")

        original_name = os.path.basename(upload["filename"].replace("\\", "/")).strip()
        ext = os.path.splitext(original_name)[1].lower()
        if ext not in AUDIO_TYPES:
            allowed = ", ".join(sorted(e.lstrip(".") for e in AUDIO_TYPES))
            raise ApiError(400, f"Неподдерживаемый формат. Можно загрузить: {allowed}")
        if len(upload["content"]) > MAX_UPLOAD_BYTES:
            raise ApiError(413, "Файл больше 80 МБ")

        track_id = uuid.uuid4().hex[:12]
        stored_name = f"{track_id}{ext}"
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        destination = os.path.join(UPLOAD_DIR, stored_name)
        with open(destination, "wb") as fh:
            fh.write(upload["content"])

        track = {
            "id": track_id,
            "title": title,
            "description": description,
            "user_id": user["id"],
            "filename": stored_name,
            "original_name": original_name[:200],
            "mime": AUDIO_TYPES[ext],
            "ext": ext,
            "size": len(upload["content"]),
            "plays": 0,
            "downloads": 0,
            "likes": [],
            "created_at": now_iso(),
        }
        with self.db.lock:
            self.db.data["tracks"][track_id] = track
            self.db.save()

        # Загрузка не должна ронять сессию: обновляем cookie в ответе.
        cookie, _ = self.issue_session(user)
        self.send_json(
            201,
            {"track": public_track(self.db, track, user["id"], 0)},
            cookie=cookie,
        )

    def api_update_track(self, track_id: str) -> None:
        user = self.require_user()
        payload = self.read_json()
        with self.db.lock:
            track = self.db.data["tracks"].get(track_id)
            if not track:
                raise ApiError(404, "Трек не найден")
            if track["user_id"] != user["id"]:
                raise ApiError(403, "Это не ваш трек")
            if "title" in payload:
                track["title"] = clean_text(
                    payload.get("title"), field="Название", max_len=120, min_len=1
                )
            if "description" in payload:
                track["description"] = clean_text(
                    payload.get("description"), field="Описание", max_len=1000
                )
            self.db.save()
            result = public_track(self.db, track, user["id"])
        self.send_json(200, {"track": result})

    def api_delete_track(self, track_id: str) -> None:
        user = self.require_user()
        with self.db.lock:
            track = self.db.data["tracks"].get(track_id)
            if not track:
                raise ApiError(404, "Трек не найден")
            if track["user_id"] != user["id"]:
                raise ApiError(403, "Это не ваш трек")
            self._remove_track_file(track)
            del self.db.data["tracks"][track_id]
            for comment_id, comment in list(self.db.data["comments"].items()):
                if comment.get("track_id") == track_id:
                    del self.db.data["comments"][comment_id]
            self.db.save()
        self.send_json(200, {"ok": True})

    def api_play(self, track_id: str) -> None:
        with self.db.lock:
            track = self.db.data["tracks"].get(track_id)
            if not track:
                raise ApiError(404, "Трек не найден")
            track["plays"] = int(track.get("plays", 0)) + 1
            self.db.save()
            plays = track["plays"]
        self.send_json(200, {"plays": plays})

    def api_toggle_like(self, track_id: str) -> None:
        user = self.require_user()
        with self.db.lock:
            track = self.db.data["tracks"].get(track_id)
            if not track:
                raise ApiError(404, "Трек не найден")
            likes = track.setdefault("likes", [])
            if user["id"] in likes:
                likes.remove(user["id"])
                liked = False
            else:
                likes.append(user["id"])
                liked = True
            self.db.save()
            like_count = len(likes)
        self.send_json(200, {"liked": liked, "likes": like_count})

    def api_add_comment(self, track_id: str) -> None:
        user = self.require_user()
        payload = self.read_json()
        text = clean_text(
            payload.get("text"), field="Комментарий",
            max_len=MAX_COMMENT_LEN, min_len=1,
        )
        with self.db.lock:
            track = self.db.data["tracks"].get(track_id)
            if not track:
                raise ApiError(404, "Трек не найден")
            comment = {
                "id": uuid.uuid4().hex[:10],
                "track_id": track_id,
                "user_id": user["id"],
                "text": text,
                "created_at": now_iso(),
            }
            self.db.data["comments"][comment["id"]] = comment
            self.db.save()
            count = comment_count_for_track(self.db, track_id)
            result = public_comment(self.db, comment, user["id"], track["user_id"])
        self.send_json(201, {"comment": result, "comment_count": count})

    def api_delete_comment(self, comment_id: str) -> None:
        user = self.require_user()
        with self.db.lock:
            comment = self.db.data["comments"].get(comment_id)
            if not comment:
                raise ApiError(404, "Комментарий не найден")
            track = self.db.data["tracks"].get(comment.get("track_id"))
            if not track:
                del self.db.data["comments"][comment_id]
                self.db.save()
                return self.send_json(200, {"ok": True, "comment_count": 0})
            if comment.get("user_id") != user["id"] and track["user_id"] != user["id"]:
                raise ApiError(403, "Нельзя удалить этот комментарий")
            del self.db.data["comments"][comment_id]
            self.db.save()
            count = comment_count_for_track(self.db, track["id"])
        self.send_json(200, {"ok": True, "comment_count": count})

    @staticmethod
    def _remove_track_file(track: dict[str, Any]) -> None:
        filename = track.get("filename")
        if not filename:
            return
        path = os.path.realpath(os.path.join(UPLOAD_DIR, filename))
        if not path.startswith(os.path.realpath(UPLOAD_DIR) + os.sep):
            return
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            print(f"[files] Не удалось удалить {path}: {exc}")

    # -- аудио и скачивание ------------------------------------------------

    def _find_track(self, track_id: str) -> dict[str, Any]:
        with self.db.lock:
            track = self.db.data["tracks"].get(track_id)
        if not track:
            raise ApiError(404, "Трек не найден")
        return track

    def api_stream_audio(self, track_id: str) -> None:
        track = self._find_track(track_id)
        path = os.path.realpath(os.path.join(UPLOAD_DIR, track["filename"]))
        if not path.startswith(os.path.realpath(UPLOAD_DIR) + os.sep) or not os.path.isfile(path):
            raise ApiError(404, "Аудиофайл не найден")
        self._send_file(path, track["mime"])

    def api_download(self, track_id: str) -> None:
        track = self._find_track(track_id)
        path = os.path.realpath(os.path.join(UPLOAD_DIR, track["filename"]))
        if not path.startswith(os.path.realpath(UPLOAD_DIR) + os.sep) or not os.path.isfile(path):
            raise ApiError(404, "Аудиофайл не найден")

        with self.db.lock:
            # HEAD не должен увеличивать счётчик: это лишь проверка заголовков.
            if not getattr(self, "_head_only", False):
                track["downloads"] = int(track.get("downloads", 0)) + 1
                self.db.save()
            title = track["title"]
            ext = track.get("ext") or os.path.splitext(track["filename"])[1]
            owner = self.db.data["users"].get(track["user_id"])

        author = owner["username"] if owner else "volna"
        download_name = f"{title} — @{author}{ext}"
        self._send_file(
            path, track["mime"], attachment_name=download_name,
        )

    def _send_file(
        self,
        path: str,
        content_type: str,
        *,
        attachment_name: str | None = None,
    ) -> None:
        file_size = os.path.getsize(path)
        start, end = 0, file_size - 1
        status = 200
        range_header = self.headers.get("Range")

        if range_header:
            match = re.match(r"^bytes=(\d*)-(\d*)$", range_header.strip())
            if match and (match.group(1) or match.group(2)):
                if match.group(1):
                    start = int(match.group(1))
                    end = int(match.group(2)) if match.group(2) else file_size - 1
                else:
                    suffix = int(match.group(2))
                    start = max(0, file_size - suffix)
                    end = file_size - 1
                if start >= file_size or start > end:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = min(end, file_size - 1)
                status = 206
            else:
                start, end = 0, file_size - 1

        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        if attachment_name:
            self.send_header("Content-Disposition", self._content_disposition(attachment_name))
        self._common_headers()
        self.end_headers()

        if getattr(self, "_head_only", False):
            return
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(remaining, 128 * 1024))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    @staticmethod
    def _content_disposition(filename: str) -> str:
        filename = re.sub(r"[\r\n\"\\/]", "_", filename).strip() or "audio"
        ascii_name = (
            unicodedata.normalize("NFKD", filename)
            .encode("ascii", "ignore")
            .decode("ascii")
        )
        ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", ascii_name).strip() or "audio"
        return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


# --------------------------------------------------------------------------
# Запуск
# --------------------------------------------------------------------------

def build_server(host: str, port: int) -> ThreadingHTTPServer:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    db = Database(DB_PATH)
    secret = load_or_create_secret(SECRET_PATH)

    handler = type("BoundVolnaHandler", (VolnaHandler,), {"db": db, "secret": secret})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Волна — локальный аудио-сайт")
    parser.add_argument("--host", default="127.0.0.1", help="Адрес (по умолчанию 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Порт (по умолчанию 8000)")
    parser.add_argument("--open", action="store_true", help="Открыть сайт в браузере")
    args = parser.parse_args()

    try:
        server = build_server(args.host, args.port)
    except OSError as exc:
        print(f"\n  Не удалось запустить сервер на {args.host}:{args.port}: {exc}")
        print("  Возможно, порт занят. Попробуйте: python3 server.py --port 8001\n")
        return
    url = f"http://{args.host}:{args.port}/"
    if args.host in ("0.0.0.0", "::"):
        url = f"http://127.0.0.1:{args.port}/"

    print(f"\n  Волна v{VERSION} — локальный аудио-хостинг")
    print(f"  Сайт:  {url}")
    print(f"  База:  {DB_PATH}")
    print(f"  Файлы: {UPLOAD_DIR}")
    print("  Остановка: Ctrl+C\n")

    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Останавливаю сервер…")
    finally:
        server.shutdown()
        server.server_close()
        print("  Готово. Пока!")


if __name__ == "__main__":
    main()
