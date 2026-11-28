from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.core import media_token
from app.core.auth import _verify_token, issue_access_token

USER, POST = str(uuid4()), str(uuid4())
PATH = f"{USER}/{POST}/0.webp"
AVATAR = f"{USER}/{POST}.webp"
NOW = 1_800_000_100


def test_round_trip():
    assert media_token.verify(media_token.sign("post-images", PATH, now=NOW), now=NOW) == ("post-images", PATH)


def test_same_url_for_the_whole_hour():
    assert media_token.sign("avatars", AVATAR, now=NOW) == media_token.sign("avatars", AVATAR, now=NOW + 60)


def test_expired_token_is_rejected():
    token = media_token.sign("post-images", PATH, now=NOW)
    assert media_token.verify(token, now=NOW + 2 * 3600) is None


def test_tampering_is_rejected():
    token = media_token.sign("post-images", PATH, now=NOW)
    payload, signature = token.split(".")
    other = media_token.sign("avatars", AVATAR, now=NOW).split(".")[0]
    for bad in (f"{other}.{signature}", f"{payload}.{signature[:-2]}xx", payload, f"{token}.x", "", "é.é"):
        assert media_token.verify(bad, now=NOW) is None


@pytest.mark.parametrize("bucket,path", [
    ("secrets", PATH),
    ("post-images", "../../etc/passwd"),
    ("post-images", f"{USER}/../{POST}/0.webp"),
    ("post-images", f"{PATH}\n"),
    ("post-images", f"{USER}/0.png"),
])
def test_only_known_buckets_and_server_built_paths(bucket, path):
    with pytest.raises(ValueError):
        media_token.sign(bucket, path)


def test_media_and_session_tokens_are_not_interchangeable(monkeypatch):
    monkeypatch.setattr("app.core.auth.get_supabase", lambda admin=False: None)
    session, _ = issue_access_token(USER)
    assert media_token.verify(session) is None
    with pytest.raises(Exception) as error:
        _verify_token(media_token.sign("post-images", PATH))
    assert getattr(error.value, "status_code", None) == 401


def test_without_a_secret_it_fails_closed(monkeypatch):
    token = media_token.sign("post-images", PATH)
    empty = SimpleNamespace(auth_secret_key="", supabase_service_role_key="")
    monkeypatch.setattr(media_token, "get_settings", lambda: empty)
    with pytest.raises(RuntimeError):
        media_token.sign("post-images", PATH)
    with pytest.raises(RuntimeError):
        media_token.verify(token)
