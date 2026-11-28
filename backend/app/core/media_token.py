"""Short-lived signed links to private Storage objects.

A token is ``<payload>.<signature>``: two parts, so it can never pass as a session
token (three or four), and the ``media:`` prefix keeps the signatures apart.
"""

import base64
import hashlib
import hmac
import re
import time

from app.core.config import get_settings

BUCKETS = {"avatars", "post-images"}
_PATH = re.compile(r"[0-9a-f-]{36}/(?:[0-9a-f-]{36}/)?[0-9a-z-]+\.webp")


def _key() -> bytes:
    settings = get_settings()
    secret = settings.auth_secret_key or settings.supabase_service_role_key
    if not secret:  # an empty key would let anyone forge a link
        raise RuntimeError("Authentication is not configured.")
    return secret.encode("utf-8")


def _encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _signature(payload: str) -> str:
    return _encode(hmac.new(_key(), b"media:" + payload.encode("utf-8"), hashlib.sha256).digest())


def sign(bucket: str, path: str, now: float | None = None) -> str:
    if bucket not in BUCKETS or not _PATH.fullmatch(path):
        raise ValueError("Not a media object")
    # Rounded to the hour so the URL stays the same, and cacheable, for that hour.
    expires = int(time.time() if now is None else now) // 3600 * 3600 + 7200
    payload = _encode(f"{bucket}\n{path}\n{expires}".encode("utf-8"))
    return f"{payload}.{_signature(payload)}"


def verify(token: str, now: float | None = None) -> tuple[str, str] | None:
    payload, _, signature = token.partition(".")
    if not hmac.compare_digest(_signature(payload).encode(), signature.encode("utf-8")):
        return None
    # Only reached with a payload this server signed.
    bucket, path, expires = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8").split("\n")
    if int(expires) <= (time.time() if now is None else now) or bucket not in BUCKETS or not _PATH.fullmatch(path):
        return None
    return bucket, path
