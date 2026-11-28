"""Backend i18n tests: Accept-Language parsing, errors, AI tips safety gate, overtraining, workout plans, and reset email."""

from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.api import users as users_api
from app.core import reset_quota
from app.core.i18n import parse_accept_language, translate_error_detail, use_language
from app.core.local_day import utc_day
from app.core.security import hash_password
from app.services import (
    ai_tips_service,
    calorie_adjustment_service,
    email_service,
    overtraining_service,
    workout_adjustment_service,
)
from main import app
from tests.auth_helpers import auth_headers

client = TestClient(app)
USER = "11111111-1111-1111-1111-111111111111"


class _Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters = []
        self.change = None
        self.new_row = None

    def select(self, *_):
        return self

    def limit(self, _):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def range(self, *_):
        return self

    def eq(self, field, value):
        self.filters.append(lambda row: str(row.get(field)) == str(value))
        return self

    def in_(self, field, values):
        allowed = {str(v) for v in values}
        self.filters.append(lambda row: str(row.get(field)) in allowed)
        return self

    def is_(self, field, value):
        if value == "null":
            self.filters.append(lambda row: row.get(field) is None)
        return self

    @property
    def not_(self):
        query = self

        class _Negated:
            def is_(self, field, value):
                if value == "null":
                    query.filters.append(lambda row: row.get(field) is not None)
                return query

        return _Negated()

    def gte(self, field, value):
        self.filters.append(lambda row: _dt(row[field]) >= _dt(value))
        return self

    def lt(self, field, value):
        self.filters.append(lambda row: _dt(row[field]) < _dt(value))
        return self

    def insert(self, row):
        self.new_row = row
        return self

    def upsert(self, row, **_kwargs):
        self.new_row = row
        return self

    def update(self, change):
        self.change = change
        return self

    def delete(self):
        self.change = "__delete__"
        return self

    def execute(self):
        rows = self.db.rows.setdefault(self.table, [])
        if self.new_row is not None:
            row = {"id": str(uuid4()), "status": "pending", "created_at": _now().isoformat(), **self.new_row}
            rows.append(row)
            return SimpleNamespace(data=[deepcopy(row)])
        matched = [row for row in rows if all(check(row) for check in self.filters)]
        if self.change == "__delete__":
            self.db.rows[self.table] = [row for row in rows if row not in matched]
        elif self.change is not None:
            for row in matched:
                row.update(self.change)
        return SimpleNamespace(data=deepcopy(matched))


class _Database:
    def __init__(self, **rows):
        self.rows = rows

    def table(self, name):
        return _Query(self, name)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _dt(value) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def test_parse_accept_language_handles_weights_regions_and_fallbacks():
    assert parse_accept_language(None) == "en"
    assert parse_accept_language("") == "en"
    assert parse_accept_language("es") == "es"
    assert parse_accept_language("es-ES") == "es"
    assert parse_accept_language("es-MX,es;q=0.9,en;q=0.8") == "es"
    assert parse_accept_language("en-US,en;q=0.9,es;q=0.8") == "en"
    assert parse_accept_language("fr-FR,es;q=0.7") == "es"
    assert parse_accept_language("fr-FR,de;q=0.9") == "en"
    assert parse_accept_language("es;q=0,en;q=0.5") == "en"


def test_http_errors_follow_accept_language():
    en_res = client.get("/api/v1/ai/tips/current", headers={"Accept-Language": "en"})
    es_res = client.get("/api/v1/ai/tips/current", headers={"Accept-Language": "es-ES,es;q=0.9"})
    assert en_res.status_code == es_res.status_code == 401
    assert en_res.json()["detail"] == "Invalid or expired session."
    assert es_res.json()["detail"] == "Sesión no válida o caducada."

    # Signed out on purpose: a signed-in miss also looks up custom exercises in Supabase, which CI does not have.
    not_found = client.get(
        "/api/v1/workouts/exercises/nonexistent-exercise-id",
        headers={"Accept-Language": "es"},
    )
    assert not_found.status_code == 404
    assert "No se encontró el ejercicio" in not_found.json()["detail"]
    assert "nonexistent-exercise-id" in not_found.json()["detail"]

    assert translate_error_detail('The name is already in use by "Bench Press".', "es") == (
        'Ese nombre ya está en uso por "Bench Press".'
    )


def test_ai_tips_spanish_uses_rule_written_tips_only_and_never_calls_model(monkeypatch):
    started = _now()
    db = _Database(
        users=[{"id": USER, "calorie_goal": 2000, "weight": 75}],
        meals=[],
        workouts=[{
            "user_id": USER,
            "start_time": started.isoformat(),
            "end_time": started.isoformat(),
            "workout_sets": [{"is_done": True}] * 5,
        }],
        workout_plans=[],
        subscriptions=[{
            "user_id": USER,
            "status": "active",
            "current_period_end": (_now() + timedelta(days=30)).isoformat(),
        }],
    )
    monkeypatch.setattr(ai_tips_service, "get_supabase", lambda admin=False: db)
    monkeypatch.setattr(
        ai_tips_service,
        "get_settings",
        lambda: SimpleNamespace(ai_tips_model_enabled=True, ai_api_key="test-key"),
    )

    model_calls = []

    def fail_if_called(*args, **kwargs):
        model_calls.append((args, kwargs))
        return {"message": "Model text?", "reasoning": "Model reason."}

    monkeypatch.setattr(ai_tips_service, "phrase_tip", fail_if_called)

    # Spanish request: must return Spanish rule-written tip and never invoke the model.
    es_resp = client.get(
        "/api/v1/ai/tips/current",
        headers={**auth_headers(USER), "Accept-Language": "es"},
    )
    assert es_resp.status_code == 200
    tip = es_resp.json()["tip"]
    assert tip["kind"] == "workout_done_kcal"
    assert "¡Buen entrenamiento hoy!" in tip["message"]
    assert "kcal" in tip["message"]
    assert "Terminaste un entrenamiento hoy" in tip["reasoning"]
    assert model_calls == []

    # Accepting in Spanish returns a Spanish confirmation.
    decided = client.post(
        f"/api/v1/ai/tips/{tip['id']}/decision",
        json={"status": "accepted"},
        headers={**auth_headers(USER), "Accept-Language": "es"},
    )
    assert decided.status_code == 200
    assert decided.json()["confirmation"] == "Se añadieron 100 kcal al objetivo de hoy."

    # Undoing in Spanish returns a Spanish notice.
    undone = client.post(
        f"/api/v1/ai/tips/{tip['id']}/undo",
        headers={**auth_headers(USER), "Accept-Language": "es"},
    )
    assert undone.status_code == 200
    assert undone.json()["notice"] == "Cambio deshecho."


def test_ai_tips_switching_from_english_to_spanish_rerenders_pending_tip(monkeypatch):
    db = _Database(
        users=[{"id": USER, "calorie_goal": 2000, "weight": 75}],
        meals=[],
        workouts=[],
        workout_plans=[],
    )
    monkeypatch.setattr(ai_tips_service, "get_supabase", lambda admin=False: db)

    en_tip = client.get(
        "/api/v1/ai/tips/current",
        headers={**auth_headers(USER), "Accept-Language": "en"},
    ).json()["tip"]
    es_tip = client.get(
        "/api/v1/ai/tips/current",
        headers={**auth_headers(USER), "Accept-Language": "es"},
    ).json()["tip"]

    assert en_tip["id"] == es_tip["id"]
    assert "haven't logged any meals" in en_tip["message"]
    assert "Todavía no has registrado ninguna comida" in es_tip["message"]


def test_overtraining_status_localizes_headlines_signals_and_recommendations(monkeypatch):
    monkeypatch.setattr(overtraining_service, "get_supabase", lambda admin=False: None)
    monkeypatch.setattr(overtraining_service, "_FALLBACK_STATES", {})
    monkeypatch.setattr(overtraining_service, "_fetch_todays_plan", lambda *_: None)
    monkeypatch.setattr(overtraining_service, "_fetch_nutrition_3d", lambda *_: (0, {}))
    monkeypatch.setattr(overtraining_service, "get_cached_exercise", lambda _id: None)
    monkeypatch.setattr(
        overtraining_service.health_service,
        "get_activity_summary",
        lambda *_: SimpleNamespace(connected=False, steps_avg_7d=0, active_calories_avg_7d=0),
    )

    now = _now()
    workouts = [
        {
            "id": f"w-{idx}",
            "name": "Chest Day",
            "fatigue_level": 9,
            "joint_pain": ["knee"],
            "start_time": (now - timedelta(days=idx)).isoformat(),
            "end_time": (now - timedelta(days=idx)).isoformat(),
            "workout_sets": [
                {
                    "exercise_id": "ex-chest",
                    "set_number": s,
                    "reps": 8,
                    "weight": 100,
                    "rpe": 9.5,
                    "is_done": True,
                    "exercises": {"name": "Bench Press", "muscle_group": "Chest"},
                }
                for s in range(1, 5)
            ],
        }
        for idx in range(6)
    ]
    monkeypatch.setattr(overtraining_service, "_fetch_workouts_35d", lambda *_: workouts)

    es_resp = client.get(
        "/api/v1/workouts/overtraining-alerts",
        headers={**auth_headers(USER), "Accept-Language": "es"},
    )
    assert es_resp.status_code == 200
    body = es_resp.json()
    assert body["risk_level"] == "high"
    assert "sobreentrenamiento" in body["headline"].lower()
    assert "Disponibilidad en" in body["summary"]
    assert body["deload_week_recommended"] is True
    assert "rodilla" in (body["deload_week_reason"] or "").lower()
    assert any("descarga" in rec.lower() for rec in body["recommendations"])
    assert any("pecho" in rec.lower() for rec in body["recommendations"])
    # Canonical English muscle names stay intact for the frontend body map SVG.
    assert "Chest" in body["strained_muscles"]
    assert any(sig["label"] == "Molestia articular repetida" for sig in body["signals"])


def test_workout_plan_reasoning_localizes_in_spanish(monkeypatch):
    # Whole-body trained yesterday (within 48h, not today) -> deterministic rest day reasoning in Spanish.
    started = (_now() - timedelta(hours=30)).isoformat()
    db = _Database(
        workout_plans=[],
        workouts=[{"id": "w1", "user_id": USER, "start_time": started, "end_time": started}],
        users=[{"id": USER, "objective": "Build muscle", "calorie_goal": 2200}],
        meals=[],
        routines=[],
        workout_sets=[
            {"workout_id": "w1", "exercise_id": "ex-chest"},
            {"workout_id": "w1", "exercise_id": "ex-legs"},
        ],
        exercises=[
            {"id": "ex-chest", "name": "Bench Press", "muscle_group": "Chest", "owner_id": None},
            {"id": "ex-legs", "name": "Squat", "muscle_group": "Legs", "owner_id": None},
        ],
    )
    monkeypatch.setattr(workout_adjustment_service, "_load_exercise_catalog", lambda _s: [
        {"id": "ex-chest", "exercise_id": "ex-chest", "name": "Bench Press", "muscle_group": "Chest"},
        {"id": "ex-legs", "exercise_id": "ex-legs", "name": "Squat", "muscle_group": "Legs"},
    ])
    monkeypatch.setattr(workout_adjustment_service, "build_session", lambda *_a, **_kw: None)

    with use_language("es"):
        result = asyncio.run(workout_adjustment_service.plan_daily_workout(UUID(USER), db, utc_day()))

    assert result["rest_day"] is True
    assert "últimas 48 horas" in result["reasoning"]
    assert db.rows["workout_plans"][0]["title"] == "Día de descanso"


def test_workout_plan_llm_prompt_requests_spanish_reasoning_when_es(monkeypatch):
    db = _Database(
        workout_plans=[],
        workouts=[],
        users=[{"id": USER, "objective": "Build muscle", "calorie_goal": 2200}],
        meals=[],
        routines=[{"id": "r1", "user_id": USER, "name": "Push"}],
        routine_exercises=[
            {"routine_id": "r1", "exercise_id": f"e{i}", "target_sets": 3, "target_reps": 10, "set_order": i,
             "exercises": {"name": f"Ex {i}", "muscle_group": "Chest"}}
            for i in range(5)
        ],
    )
    captured_prompts = []

    async def fake_request_json(prompt, _schema):
        captured_prompts.append(json.loads(prompt))
        return {
            "routine_id": "r1",
            "workout_name": "Push",
            "rest_day": False,
            "adjusted": True,
            "reasoning": "Volumen adaptado a tu ingesta reciente.",
            "exercises": [{"exercise_id": f"e{i}", "sets": 3, "reps": 10} for i in range(5)],
        }

    monkeypatch.setattr(workout_adjustment_service, "_request_json", fake_request_json)

    with use_language("es"):
        plan = asyncio.run(workout_adjustment_service.plan_daily_workout(UUID(USER), db, utc_day()))

    assert captured_prompts
    assert "natural Spanish" in captured_prompts[0]["instruction"]
    assert plan["reasoning"] == "Volumen adaptado a tu ingesta reciente."


def test_password_reset_email_and_response_follow_accept_language(monkeypatch):
    db = _Database(
        users=[{"id": USER, "email": "user@example.com", "password": hash_password("OldPassword123!")}],
        password_resets=[],
    )
    monkeypatch.setattr(users_api.onboarding_facade, "supabase_provider", lambda admin: db)
    monkeypatch.setattr(reset_quota, "_sent", {})
    monkeypatch.setattr(
        email_service,
        "get_settings",
        lambda: SimpleNamespace(resend_api_key="re_test", email_from="noreply@booost.app", is_production=False),
    )

    sent_payloads = []

    def fake_post(_url, headers, json, timeout):
        sent_payloads.append(json)
        return SimpleNamespace(is_error=False, status_code=200, text="ok")

    monkeypatch.setattr(email_service.httpx, "post", fake_post)

    res = client.post(
        "/api/v1/users/password-reset/request",
        json={"email": "user@example.com"},
        headers={"Accept-Language": "es-ES"},
    )
    assert res.status_code == 200
    assert "enlace para restablecer" in res.json()["message"]
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["subject"] == "Restablece tu contraseña de BOOOST"
    assert "Crear una contraseña nueva" in sent_payloads[0]["html"]
    assert "Alguien ha solicitado restablecer" in sent_payloads[0]["text"]


def test_calorie_adjustment_rules_localize_in_spanish():
    result = calorie_adjustment_service.propose_adjustment(
        {"goal": 2000, "compliance": 0.2, "days_within": 1},
        lang="es",
    )
    assert "Primero constancia" in result["reason"]


@pytest.mark.parametrize("language, message", [
    ("en", "A workout cannot end before it starts"),
    ("es", "Un entrenamiento no puede terminar antes de empezar."),
])
def test_validator_errors_stay_422_in_both_languages(language, message):
    # A custom validator puts the exception object in the error's ctx; the handler must still return JSON.
    now = datetime.now(timezone.utc)
    body = {
        "name": "Push", "duration_seconds": 60,
        "started_at": now.isoformat(), "completed_at": (now - timedelta(minutes=1)).isoformat(),
        "exercises": [{"exercise_id": "0025", "sets": [{"set_number": 1, "weight_kg": 50, "reps": 8, "is_completed": True}]}],
    }
    response = client.post("/api/v1/workouts/logs", json=body, headers={**auth_headers(uuid4()), "Accept-Language": language})
    assert response.status_code == 422
    assert message in response.json()["detail"][0]["msg"]
