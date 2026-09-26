"""Optional local, password-backed JWT issuer for offline development.

This is intentionally not a production identity system. It exists so the Vite
app and FastAPI can exercise a real HS256 bearer-token flow without shipping a
secret or credentials in the browser. It is disabled by default and
configuration rejects it for Supabase/production deployments.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

from backend.config import Settings

_PBKDF2_ITERATIONS = 310_000
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 256


class LocalAuthError(RuntimeError):
    """A local account operation failed."""


class DuplicateEmailError(LocalAuthError):
    pass


class InvalidCredentialsError(LocalAuthError):
    pass


class LocalAuthStore:
    """Small tenant-independent account store using a local SQLite database."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._shared: Optional[sqlite3.Connection] = None
        if path == ":memory:":
            self._shared = sqlite3.connect(":memory:", check_same_thread=False)
        else:
            resolved = Path(path).expanduser().resolve()
            resolved.parent.mkdir(parents=True, exist_ok=True)
            self.path = str(resolved)
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                create table if not exists local_users (
                    user_id text primary key,
                    email text not null unique,
                    password_salt text not null,
                    password_hash text not null,
                    display_name text not null default '',
                    business_name text not null default '',
                    created_at text not null
                )
                """
            )

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        self._lock.acquire()
        own = self._shared is None
        connection = self._shared or sqlite3.connect(
            self.path, timeout=5.0, check_same_thread=False
        )
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("pragma busy_timeout = 5000")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            if own:
                connection.close()
            self._lock.release()

    def create_user(
        self,
        *,
        email: str,
        password: str,
        display_name: str = "",
        business_name: str = "",
    ) -> Dict[str, Any]:
        normalized_email = _normalize_email(email)
        _validate_password(password)
        display_name = str(display_name or "").strip()[:120]
        business_name = str(business_name or "").strip()[:160]
        salt_bytes, password_hash_bytes = _derive_password(password)
        salt = _encode_secret(salt_bytes)
        password_hash = _encode_secret(password_hash_bytes)
        user_id = str(uuid.uuid4())
        created_at = str(int(time.time()))
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    insert into local_users
                        (user_id, email, password_salt, password_hash,
                         display_name, business_name, created_at)
                    values (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        normalized_email,
                        salt,
                        password_hash,
                        display_name,
                        business_name,
                        created_at,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise DuplicateEmailError("An account with this email already exists.") from exc
        return {
            "id": user_id,
            "sub": user_id,
            "email": normalized_email,
            "name": display_name or normalized_email.split("@", 1)[0],
            "businessName": business_name,
        }

    def authenticate(self, *, email: str, password: str) -> Dict[str, Any]:
        normalized_email = _normalize_email(email)
        _validate_password(password)
        with self._connect() as connection:
            row = connection.execute(
                """
                select user_id, email, password_salt, password_hash,
                       display_name, business_name
                from local_users where email = ?
                """,
                (normalized_email,),
            ).fetchone()
        if row is None:
            # Do the same expensive work for an unknown account to reduce
            # account-enumeration timing differences.
            _derive_password(password)
            raise InvalidCredentialsError("Email or password is incorrect.")
        expected = _decode_secret(row["password_hash"])
        supplied = _derive_password(password, salt=_decode_secret(row["password_salt"]))[1]
        if not hmac.compare_digest(expected, supplied):
            raise InvalidCredentialsError("Email or password is incorrect.")
        return {
            "id": str(row["user_id"]),
            "sub": str(row["user_id"]),
            "email": str(row["email"]),
            "name": str(row["display_name"] or row["email"].split("@", 1)[0]),
            "businessName": str(row["business_name"] or ""),
        }

    def get_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as connection:
            row = connection.execute(
                """
                select user_id, email, display_name, business_name
                from local_users where user_id = ?
                """,
                (str(user_id),),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": str(row["user_id"]),
            "sub": str(row["user_id"]),
            "email": str(row["email"]),
            "name": str(row["display_name"] or row["email"].split("@", 1)[0]),
            "businessName": str(row["business_name"] or ""),
        }

    def close(self) -> None:
        with self._lock:
            if self._shared is not None:
                self._shared.close()
                self._shared = None


def _normalize_email(email: str) -> str:
    value = str(email or "").strip().casefold()
    if not value or len(value) > 320 or not _EMAIL_RE.fullmatch(value):
        raise LocalAuthError("Enter a valid email address.")
    return value


def _validate_password(password: str) -> None:
    if not isinstance(password, str) or not (
        MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH
    ):
        raise LocalAuthError(
            f"Password must be between {MIN_PASSWORD_LENGTH} and "
            f"{MAX_PASSWORD_LENGTH} characters."
        )


def _derive_password(password: str, salt: Optional[bytes] = None) -> tuple[bytes, bytes]:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS
    )
    return salt, digest


def _encode_secret(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_secret(value: str) -> bytes:
    padded = str(value) + "=" * (-len(str(value)) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, UnicodeError, binascii.Error) as exc:
        raise LocalAuthError("Stored local credentials are invalid.") from exc


def issue_access_token(user: Dict[str, Any], settings: Settings) -> str:
    """Issue a short-lived HS256 token from the server-owned signing secret."""

    if settings.auth_mode != "jwt" or settings.jwt_algorithm != "HS256":
        raise LocalAuthError("Local auth requires a configured HS256 verifier.")
    secret = settings.jwt_secret
    if not secret or len(secret.encode("utf-8")) < 32:
        raise LocalAuthError("Local auth is not configured with a real JWT secret.")
    now = int(time.time())
    ttl = int(settings.access_token_ttl_seconds)
    header = {"alg": "HS256", "typ": "JWT"}
    payload: Dict[str, Any] = {
        "sub": user["id"],
        "iat": now,
        "exp": now + ttl,
        "jti": secrets.token_urlsafe(16),
        "email": user.get("email", ""),
    }
    if settings.jwt_issuer:
        payload["iss"] = settings.jwt_issuer
    if settings.jwt_audience:
        payload["aud"] = settings.jwt_audience
    encoded_header = _b64_json(header)
    encoded_payload = _b64_json(payload)
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{encoded_header}.{encoded_payload}.{_b64_bytes(signature)}"


def _b64_json(value: Dict[str, Any]) -> str:
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return _b64_bytes(raw)


def _b64_bytes(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


_STORE: Optional[LocalAuthStore] = None
_STORE_LOCK = threading.Lock()


def _store_path_key(path: str) -> str:
    if str(path) == ":memory:":
        return ":memory:"
    return str(Path(path).expanduser().resolve())


def get_store(settings: Settings) -> LocalAuthStore:
    global _STORE
    if not settings.local_auth_enabled:
        raise LocalAuthError("Local authentication is disabled.")
    configured_path = settings.local_auth_database_path
    with _STORE_LOCK:
        if _STORE is None or _store_path_key(_STORE.path) != _store_path_key(configured_path):
            if _STORE is not None:
                _STORE.close()
            _STORE = LocalAuthStore(configured_path)
        return _STORE


def reset_store() -> None:
    """Close the process store; useful for isolated test processes."""

    global _STORE
    with _STORE_LOCK:
        if _STORE is not None:
            _STORE.close()
        _STORE = None
