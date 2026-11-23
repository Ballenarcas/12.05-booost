"""Stateless bearer sessions with password-change revocation.

Tokens are ``<user_id>.<issued_at_ms>.<expires_at>.<hmac>`` (legacy 3-part
``<user_id>.<expires_at>.<hmac>`` tokens remain accepted with ``issued_at_ms=0``)
signed with HMAC-SHA256. The signing key never leaves the backend, so a client
cannot mint or extend a session by editing local storage. Sessions issued at or
before ``users.password_changed_at`` (or an in-process revocation mark) are
rejected; rotating ``AUTH_SECRET_KEY`` still revokes every session globally.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import hmac
import logging
import threading
import time
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import get_settings
from app.db.supabase_client import get_supabase

logger = logging.getLogger(__name__)
_bearer = HTTPBearer(auto_error=False)
_lock = threading.Lock()
_MAX_REVOCATION_CACHE_ENTRIES = 10_000
_DB_CACHE_TTL_SECONDS = 30.0
_revoked_before: dict[str, int] = {}
_db_revocation_cache: dict[str, tuple[float, int | None]] = {}
_password_changed_column_available = True


def _normalize_user_key(user_id: str) -> str:
    try:
        return str(UUID(str(user_id)))
    except ValueError:
        return str(user_id)


def _bounded_set(mapping: dict, key: str, value) -> None:
    if key not in mapping and len(mapping) >= _MAX_REVOCATION_CACHE_ENTRIES:
        mapping.pop(next(iter(mapping)))
    mapping[key] = value


def _parse_timestamp_ms(value: object) -> int | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _is_missing_password_changed_column(err: Exception) -> bool:
    text = str(err)
    return "password_changed_at" in text or "PGRST204" in text or "42703" in text


def revoke_user_sessions(user_id: str, at: datetime | None = None) -> None:
    """Invalidate all tokens issued at or before ``at`` for ``user_id``."""
    ts_ms = int((at or datetime.now(timezone.utc)).timestamp() * 1000)
    key = _normalize_user_key(user_id)
    with _lock:
        latest = max(_revoked_before.get(key, 0), ts_ms)
        _bounded_set(_revoked_before, key, latest)
        _bounded_set(_db_revocation_cache, key, (time.monotonic() + _DB_CACHE_TTL_SECONDS, latest))


def _revoked_at_ms(user_id: str) -> int | None:
    global _password_changed_column_available
    now_mono = time.monotonic()
    with _lock:
        mem_ms = _revoked_before.get(user_id)
        cached = _db_revocation_cache.get(user_id)
        if cached is not None and cached[0] > now_mono:
            db_ms = cached[1]
            if mem_ms is not None and db_ms is not None:
                return max(mem_ms, db_ms)
            return mem_ms if mem_ms is not None else db_ms
        column_available = _password_changed_column_available

    if not column_available:
        return mem_ms

    supabase = get_supabase(admin=True)
    if supabase is None:
        return mem_ms

    db_ms: int | None = None
    try:
        rows = (
            supabase.table("users")
            .select("password_changed_at")
            .eq("id", user_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if rows:
            db_ms = _parse_timestamp_ms(rows[0].get("password_changed_at"))
    except Exception as err:
        if _is_missing_password_changed_column(err):
            with _lock:
                if _password_changed_column_available:
                    logger.warning("users.password_changed_at column is missing; using in-process session revocation only.")
                    _password_changed_column_available = False
        else:
            logger.warning("Could not check session revocation timestamp", exc_info=True)
        return mem_ms

    with _lock:
        latest_mem = _revoked_before.get(user_id)
        effective_db = max(latest_mem, db_ms) if (latest_mem is not None and db_ms is not None) else (db_ms if db_ms is not None else latest_mem)
        _bounded_set(_db_revocation_cache, user_id, (time.monotonic() + _DB_CACHE_TTL_SECONDS, effective_db))
        return effective_db


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired session.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _secret() -> bytes:
    settings = get_settings()
    secret = settings.auth_secret_key or settings.supabase_service_role_key
    if not secret:
        raise HTTPException(status_code=500, detail="Authentication is not configured.")
    return secret.encode("utf-8")


def _sign(payload: str) -> str:
    digest = hmac.new(_secret(), payload.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def issue_access_token(user_id: str) -> tuple[str, int]:
    """Return ``(token, expires_at_unix)`` for an authenticated user."""
    ttl_hours = max(1, min(get_settings().auth_token_ttl_hours, 24 * 30))
    now_ms = int(time.time() * 1000)
    key = _normalize_user_key(user_id)
    with _lock:
        revoked_ms = _revoked_before.get(key)
        cached = _db_revocation_cache.get(key)
        if cached is not None and cached[0] > time.monotonic() and cached[1] is not None:
            revoked_ms = max(revoked_ms or 0, cached[1])
    issued_at_ms = max(now_ms, revoked_ms + 1) if revoked_ms is not None else now_ms
    expires_at = issued_at_ms // 1000 + ttl_hours * 3600
    payload = f"{user_id}.{issued_at_ms}.{expires_at}"
    return f"{payload}.{_sign(payload)}", expires_at


def _verify_token(token: str) -> str:
    if not isinstance(token, str):
        raise _unauthorized()
    parts = token.split(".")
    if len(parts) == 4:
        user_id, issued_raw, expires_raw, signature = parts
        if not (issued_raw.isascii() and issued_raw.isdigit() and expires_raw.isascii() and expires_raw.isdigit()):
            raise _unauthorized()
        signed_payload = f"{user_id}.{issued_raw}.{expires_raw}"
        if not hmac.compare_digest(_sign(signed_payload).encode(), signature.encode()):
            raise _unauthorized()
        issued_at_ms = int(issued_raw)
        expires_at = int(expires_raw)
    elif len(parts) == 3:
        user_id, expires_raw, signature = parts
        if not (expires_raw.isascii() and expires_raw.isdigit()):
            raise _unauthorized()
        signed_payload = f"{user_id}.{expires_raw}"
        if not hmac.compare_digest(_sign(signed_payload).encode(), signature.encode()):
            raise _unauthorized()
        issued_at_ms = 0
        expires_at = int(expires_raw)
    else:
        raise _unauthorized()

    if expires_at <= int(time.time()):
        raise _unauthorized()
    try:
        normalized_uid = str(UUID(user_id))
    except ValueError as err:
        raise _unauthorized() from err

    revoked_ms = _revoked_at_ms(normalized_uid)
    if revoked_ms is not None and issued_at_ms <= revoked_ms:
        raise _unauthorized()
    return normalized_uid


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UUID:
    if credentials is None:
        raise _unauthorized()
    return UUID(_verify_token(credentials.credentials))


def optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UUID | None:
    """The signed-in user, or None without a token. A bad token is still rejected."""
    if credentials is None:
        return None
    return UUID(_verify_token(credentials.credentials))

