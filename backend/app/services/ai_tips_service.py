"""Short Home tips chosen by rules from today's meals and training.

The rules pick the tip, its numbers and its action, which keeps every tip inside
the safety limits. Tips only ever add calories (never a deeper deficit) and add
at most one set, and only while the weekly set count stays within 10% of the
previous week.

Every tip tells the user what to do: either Accept, or a "next_step" written by
the rule and added to the message word for word.

A model may rewrite a tip for Premium users when AI_TIPS_MODEL_ENABLED is on,
using facts about the user to make it personal. It is called at most once per
change in their data, never touches the next step or what Accept does, and
anything it writes that fails is_safe_wording is thrown away in favour of the
rule's text.
"""

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from app.core.config import get_settings
from app.core.i18n import get_language, normalize_language, pick, translate_muscle, translate_objective
from app.core.local_day import LocalDay, utc_day
from app.db.supabase_client import get_supabase
from app.services.ai_service import phrase_tip
from app.services.ai_tip_history import (
    ACCEPTED_LOOKBACK_DAYS,
    HISTORY_DAYS,
    instant,
    personal_facts,
    summarize_accepted,
    summarize_meals,
    summarize_workouts,
)
from app.services.exercise_catalog import exercise_label
from app.services.muscle_focus import get_muscle_focus
from app.services.nutrition_math import estimate_burned_kcal
from app.services.premium_service import has_active_premium
from app.services.user_profile_service import calculate_calorie_goal

logger = logging.getLogger(__name__)

TIPS_TABLE = "ai_tips"
WORKOUT_KCAL_BONUS = 100  # used when the session length or body weight is unknown
MIN_WORKOUT_KCAL_BONUS = 50
MAX_WORKOUT_KCAL_BONUS = 200
BURNED_KCAL_SHARE = 1 / 3  # eat back part of the session, so a deficit is reduced but not erased
MIN_STREAK_DAYS = 3
MAX_MODEL_TIPS_PER_DAY = 8
MAX_MESSAGE_LENGTH = 120  # before the next step is added
MAX_REASONING_LENGTH = 240
PROTEIN_REMINDER_HOUR = 14  # earlier than this, a low protein total only means the day is young
HARD_SESSION_RPE = 8.5
LOW_WEEK_PROTEIN_RATIO = 0.8
MIN_DAYS_FOR_WEEK_TIPS = 3
GOOD_WEEK_DAYS_ON_GOAL = 5
TRAINING_GAP_DAYS = 4
FOLLOW_UP_DAYS = 3  # how long an accepted tip is followed up, and not offered again
PLAN_NOTE_DAYS = 3  # how long an accepted training tip still shapes the workout plan
PROTEIN_KINDS = ("protein_week", "protein_behind", "yesterday_recap")
# What the workout planner should do about a tip the user accepted.
PLAN_NOTES = {
    "hard_session": "Agreed to recover after a very hard session: keep this workout moderate.",
    "lift_progress": "Agreed to stay at their new best weight: do not raise the load.",
    "training_gap": "Agreed to return with a short session: keep this workout short.",
}
# These answer today's numbers, so new data may bring them back after a dismiss.
REACTIVE_KINDS = {"protein_behind", "over_target", "on_track", "goal_reached", "nothing_logged"}
MAX_WEEKLY_SET_GROWTH = 1.10
PROTEIN_PER_KG = 1.6  # same factor as the dashboard's protein target
OVER_TARGET_RATIO = 1.10
LOW_PROTEIN_RATIO = 0.5
NOT_AVAILABLE = "That change is no longer available, so nothing was changed."
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
AMOUNT = re.compile(r"(\d+(?:[.,]\d+)*)[\s\-‐‑]*(kcal|kg|g)\b", re.IGNORECASE)
PAIRED_AMOUNT = re.compile(r"(\d+(?:[.,]\d+)*) of (\d+(?:[.,]\d+)*)\s*(kcal|kg|g)\b", re.IGNORECASE)
# Medical advice, eating less, spelled-out amounts the number check cannot see, claiming
# a change was already made, and the model talking about its own rewriting.
MEDICAL_TERMS = (  # shared with the AI Coach chat
    r"diagnos\w*|treat\w*|cure\w*|disease\w*|disorder\w*|illness\w*|medic\w*|deficien\w*|diabet\w*"
    r"|symptom\w*|therap\w*|injur\w*|supplement\w*|doctor\w*"
)
BLOCKED_WORDING = re.compile(
    rf"\b({MEDICAL_TERMS}"
    r"|eat less|skip\w*|fast|fasting|starv\w*|detox\w*"
    r"|restrict\w*|cut back|cut down|cut calories|burn it off|burn off"
    r"|percent|hundred|thousand|double|twice|triple|i added|i['’]ve added|we added|been added|was added|already added"
    r"|rephras\w*|rewr[io]\w*|reword\w*|the tip|this tip|meaning|tone|instructions?)\b",
    re.IGNORECASE,
)


def can_add_set(sets_last_7d: int, planned_today: int, sets_prev_7d: int) -> bool:
    """One more set is allowed only if the 7-day total stays within +10% of the week before."""
    if sets_prev_7d <= 0:
        return False
    return sets_last_7d + planned_today + 1 <= sets_prev_7d * MAX_WEEKLY_SET_GROWTH


def bump_exercise_sets(
    exercises: list[dict[str, Any]], exercise_id: str, change: int = 1,
) -> list[dict[str, Any]] | None:
    """Return a copy with the exercise's sets changed, or None when it is not in the plan."""
    if not any(str(item.get("exercise_id")) == exercise_id for item in exercises):
        return None
    return [
        {**item, "sets": int(item.get("sets") or 0) + change} if str(item.get("exercise_id")) == exercise_id else item
        for item in exercises
    ]


def workout_kcal_bonus(weight_kg: float | None, workout_seconds: int) -> int:
    """Calories to offer after training. A timer left running is limited by the maximum."""
    burned = estimate_burned_kcal(weight_kg, workout_seconds)
    if burned <= 0:
        return WORKOUT_KCAL_BONUS
    rounded = round(burned * BURNED_KCAL_SHARE / 10) * 10
    return max(MIN_WORKOUT_KCAL_BONUS, min(MAX_WORKOUT_KCAL_BONUS, rounded))


def logging_streak(days_ago: set[int]) -> int:
    """Consecutive days with a meal, up to today, or up to yesterday if today has none yet."""
    first = 0 if 0 in days_ago else 1
    streak = 0
    while first + streak in days_ago:
        streak += 1
    return streak


def _amounts(text: str) -> set[tuple[str, str]]:
    """Numbers with their unit, reading "20 of 120 g" as 20 g and 120 g."""
    return {(number, unit.lower()) for number, unit in AMOUNT.findall(PAIRED_AMOUNT.sub(r"\1 \3 of \2 \3", text))}


def is_safe_wording(tip: dict[str, Any], wording: Any, facts: tuple[str, ...] | list[str] = ()) -> bool:
    """Accept a model's text only if every number is real and it stays within the rule's advice."""
    if not isinstance(wording, dict):
        return False
    message, reasoning = wording.get("message"), wording.get("reasoning")
    if not isinstance(message, str) or not isinstance(reasoning, str):
        return False
    message, reasoning = message.strip(), reasoning.strip()
    if not message or not reasoning or len(message) > MAX_MESSAGE_LENGTH or len(reasoning) > MAX_REASONING_LENGTH:
        return False
    text = f"{message} {reasoning}"
    if BLOCKED_WORDING.search(text):
        return False
    known = " ".join((tip["message"], tip["reasoning"], tip.get("next_step") or "", *facts))
    if not set(NUMBER.findall(text)) <= set(NUMBER.findall(known)) or not _amounts(text) <= _amounts(known):
        return False

    action = tip.get("action")
    if not action or action["type"] not in ("add_kcal", "add_set"):
        return True
    lowered = message.lower()
    if "?" not in message:  # nothing has happened until the user taps Accept
        return False
    if action["type"] == "add_kcal":
        return str(action["kcal"]) in NUMBER.findall(message) and "kcal" in lowered
    return "one set" in lowered and str(action["name"]).lower() in lowered


def _follow_ups(
    state: dict[str, Any],
    agreed: dict[str, dict[str, Any]],
    reading: str,
    lang: str = "en",
) -> list[dict[str, Any]]:
    """Check how a tip the user accepted on an earlier day turned out."""
    is_es = lang == "es"
    tips: list[dict[str, Any]] = []
    yesterday = state.get("yesterday")
    protein_goal = round(float(state["protein_goal"]))
    if yesterday and protein_goal > 0 and any(kind in agreed for kind in PROTEIN_KINDS):
        reached = yesterday["protein"] >= protein_goal
        if is_es:
            message = (
                f"Aceptaste subir la proteína y ayer llegaste a tu objetivo de {protein_goal} g con {yesterday['protein']} g."
                if reached
                else f"Aceptaste subir la proteína y ayer llegaste a {yesterday['protein']} de {protein_goal} g."
            )
            next_step = (
                "Mantén esas comidas en tu rutina."
                if reached
                else "Incluye una fuente de proteína en tu primera comida de hoy."
            )
            reasoning = "Aceptaste un consejo de proteína hace poco, así que revisé cómo fue ayer."
        else:
            message = (
                f"You said yes to more protein, and you reached your {protein_goal} g target yesterday with {yesterday['protein']} g."
                if reached
                else f"You said yes to more protein, and yesterday you reached {yesterday['protein']} of {protein_goal} g."
            )
            next_step = (
                "Keep those meals in your routine."
                if reached
                else "Put a protein source in your first meal today."
            )
            reasoning = "You accepted a protein tip recently, so I checked how yesterday went."
        tips.append({
            "kind": "follow_up_protein",
            "state_key": reading,
            "message": message,
            "next_step": next_step,
            "reasoning": reasoning,
            "action": None,
        })
    muscle_tip = agreed.get("muscle_gap")
    if muscle_tip and muscle_tip.get("muscle"):
        muscle = muscle_tip["muscle"]
        if state.get("muscle_ages", {}).get(muscle, 99) < muscle_tip["days_ago"]:
            muscle_label = translate_muscle(muscle, lang)
            tips.append({
                "kind": "follow_up_muscle",
                "state_key": reading,
                "message": (
                    f"Aceptaste entrenar {muscle_label}, y lo cumpliste."
                    if is_es
                    else f"You said yes to training {muscle}, and you did it."
                ),
                "next_step": (
                    f"Mantén {muscle_label} en tu rotación semanal."
                    if is_es
                    else f"Keep {muscle} in your weekly rotation."
                ),
                "reasoning": (
                    f"Aceptaste un consejo de {muscle_label} hace poco y tu registro muestra que ya lo entrenaste."
                    if is_es
                    else f"You accepted a {muscle} tip recently, and your log shows you trained it since then."
                ),
                "action": None,
            })
    training_tip = agreed.get("training_gap")
    since = state.get("days_since_workout")
    if training_tip and since is not None and since < training_tip["days_ago"]:
        tips.append({
            "kind": "follow_up_training",
            "state_key": reading,
            "message": (
                "Dijiste que volverías a entrenar, y lo hiciste."
                if is_es
                else "You said you'd get back to training, and you did."
            ),
            "next_step": (
                "Planifica tu próxima sesión para esta semana."
                if is_es
                else "Plan your next session for this week."
            ),
            "reasoning": (
                "Aceptaste un consejo de entrenamiento hace poco y tu registro muestra una sesión desde entonces."
                if is_es
                else "You accepted a training tip recently, and your log shows a workout since then."
            ),
            "action": None,
        })
    return tips


def build_candidates(state: dict[str, Any], lang: str | None = None) -> list[dict[str, Any]]:
    """Return possible tips, best first. Pure: no database access."""
    active_lang = normalize_language(lang) if lang is not None else get_language()
    is_es = active_lang == "es"
    if is_es:  # exercise names are stored in English
        lift, plan = state.get("lift_progress"), state.get("plan")
        state = {
            **state,
            "lift_progress": lift and {**lift, "exercise": exercise_label(lift["exercise"], "es")},
            "plan": plan and {**plan, "exercises": [
                {**item, "name": exercise_label(item.get("name"), "es")} for item in plan.get("exercises") or []
            ]},
        }
    goal = int(state["goal"])
    eaten = round(state["eaten_kcal"])
    meals = int(state["meals_count"])
    protein = float(state["protein_eaten"])
    protein_goal = float(state["protein_goal"])
    plan = state.get("plan")
    workouts_today = state["workouts_done_today"]
    is_rest_day = bool(plan and plan.get("is_rest_day"))
    reading = f"{meals}:{eaten}:{workouts_today}"
    tips: list[dict[str, Any]] = []

    if state["workouts_done_today"] > 0:
        bonus = workout_kcal_bonus(state.get("weight_kg"), state.get("workout_seconds", 0))
        tips.append({
            "kind": "workout_done_kcal",
            "state_key": "day",
            "message": (
                f"¡Buen entrenamiento hoy! ¿Añadimos {bonus} kcal al plan de hoy?"
                if is_es
                else f"Good job in your training! Add {bonus} kcal to today's plan?"
            ),
            "reasoning": (
                f"Terminaste un entrenamiento hoy y quemaste energía extra. Añadir {bonus} kcal, "
                "según el tiempo que entrenaste, ayuda a recuperarte sin aumentar tu déficit. "
                "Solo cambia el objetivo de hoy."
                if is_es
                else f"You finished a workout today, so you burned extra energy. Adding {bonus} kcal, "
                "based on how long you trained, helps you recover and never makes your deficit "
                "bigger. It only changes today's goal."
            ),
            "next_step": None,
            "action": {"type": "add_kcal", "kcal": bonus},
        })
    elif plan and not plan.get("is_rest_day") and plan.get("exercises") and can_add_set(
        state["sets_last_7d"], state["planned_sets_today"], state["sets_prev_7d"],
    ):
        first = plan["exercises"][0]
        total = state["sets_last_7d"] + state["planned_sets_today"] + 1
        tips.append({
            "kind": "add_set",
            "state_key": "day",
            "message": (
                f"Has sido muy constante últimamente. ¿Añadimos una serie de {first['name']} al entreno de hoy?"
                if is_es
                else f"You've been consistent lately. Add one set of {first['name']} to today's workout?"
            ),
            "reasoning": (
                f"En los últimos 7 días hiciste {state['sets_last_7d']} series y hoy tienes "
                f"{state['planned_sets_today']}. Una serie más suma {total}, dentro del 10 % respecto a las "
                f"{state['sets_prev_7d']} series de la semana anterior, para progresar de forma gradual."
                if is_es
                else f"Over the last 7 days you did {state['sets_last_7d']} sets and today's plan has "
                f"{state['planned_sets_today']}. One more set makes {total}, still within 10% of the "
                f"{state['sets_prev_7d']} sets you did the week before, so the increase stays gradual."
            ),
            "next_step": None,
            "action": {"type": "add_set", "exercise_id": str(first["exercise_id"]), "name": first["name"]},
        })

    lift = state.get("lift_progress")
    if lift:
        tips.append({
            "kind": "lift_progress",
            "state_key": reading,
            "message": (
                f"Nueva marca en {lift['exercise']}: {lift['after']} kg, subiendo desde {lift['before']} kg."
                if is_es
                else f"New best on {lift['exercise']}: {lift['after']} kg, up from {lift['before']} kg."
            ),
            "next_step": (
                "Mantén este peso en la próxima sesión hasta que se sienta sólido."
                if is_es
                else "Stay at this weight next session until it feels solid."
            ),
            "reasoning": (
                f"Tu serie más pesada de {lift['exercise']} hoy fue de {lift['after']} kg. Tu mejor marca en los "
                f"30 días anteriores era {lift['before']} kg."
                if is_es
                else f"Your heaviest {lift['exercise']} set today was {lift['after']} kg. Your best in the "
                f"previous 30 days was {lift['before']} kg."
            ),
            "action": None,
        })
    effort = state.get("today_rpe")
    if effort and effort >= HARD_SESSION_RPE:
        tips.append({
            "kind": "hard_session",
            "state_key": reading,
            "message": (
                f"Fue una sesión exigente, con un esfuerzo medio de {effort} sobre 10."
                if is_es
                else f"That was a tough one, with an average effort of {effort} out of 10."
            ),
            "next_step": (
                "Haz una comida rica en proteína y descansa bien esta noche."
                if is_es
                else "Have a protein-rich meal and get a good night's sleep."
            ),
            "reasoning": (
                "Valoraste las series de hoy como muy duras. Tu cuerpo se recupera tras la sesión, así que descansar forma parte del trabajo."
                if is_es
                else "You rated today's sets as very hard. Your body rebuilds after the session, so recovery is part of the work."
            ),
            "action": None,
        })

    protein_time = state.get("local_hour", 18) >= PROTEIN_REMINDER_HOUR
    if meals and protein_time and protein_goal > 0 and eaten >= goal * 0.5 and protein < protein_goal * LOW_PROTEIN_RATIO:
        tips.append({
            "kind": "protein_behind",
            "state_key": reading,
            "message": (
                f"La proteína va un poco baja hoy: {round(protein)} de {round(protein_goal)} g."
                if is_es
                else f"Protein is a bit low today: {round(protein)} of {round(protein_goal)} g."
            ),
            "next_step": (
                "Haz que la proteína sea la protagonista de tu próxima comida."
                if is_es
                else "Make protein the focus of your next meal."
            ),
            "reasoning": (
                f"Llevas {eaten} de {goal} kcal, pero solo {round(protein)} g de tu objetivo de "
                f"{round(protein_goal)} g de proteína. La proteína ayuda a recuperar el músculo."
                if is_es
                else f"You have eaten {eaten} of {goal} kcal but only {round(protein)} g of your "
                f"{round(protein_goal)} g protein target. Protein supports muscle recovery."
            ),
            "action": None,
        })
    if eaten > goal * OVER_TARGET_RATIO:
        tips.append({
            "kind": "over_target",
            "state_key": reading,
            "message": (
                f"Estás {eaten - goal} kcal por encima del objetivo de hoy, y no pasa nada."
                if is_es
                else f"You're {eaten - goal} kcal over today's goal, and that's fine."
            ),
            "next_step": (
                "Vuelve a tu plan habitual mañana, sin necesidad de compensarlo."
                if is_es
                else "Go back to your normal plan tomorrow, with no need to make up for it."
            ),
            "reasoning": (
                "Un día por encima del objetivo rara vez cambia tu progreso. Tu media semanal importa más que un solo día."
                if is_es
                else "One day above target rarely changes your progress. Your weekly average matters more than a single day."
            ),
            "action": None,
        })
    if meals and eaten < goal:
        last_meal = state.get("last_meal")
        if is_es:
            meal_word = "comida registrada" if meals == 1 else "comidas registradas"
            message = f"Bien, {meals} {meal_word} y te quedan {goal - eaten} kcal hoy."
            if last_meal:
                message = f"{last_meal['name']} te aportó {last_meal['protein']} g de proteína y te quedan {goal - eaten} kcal."
        else:
            message = f"Nice, {meals} meal{'s' if meals != 1 else ''} logged and {goal - eaten} kcal left today."
            if last_meal:
                message = f"{last_meal['name']} gave you {last_meal['protein']} g of protein, and you have {goal - eaten} kcal left."
        protein_left = round(protein_goal - protein)
        tips.append({
            "kind": "on_track",
            "state_key": reading,
            "message": message,
            "next_step": (
                (
                    f"Apunta a {protein_left} g más de proteína en tus comidas restantes."
                    if is_es
                    else f"Aim for {protein_left} g more protein in your remaining meals."
                )
                if protein_left > 0
                else (
                    "Objetivo de proteína cubierto hoy; sigue registrando tus comidas."
                    if is_es
                    else "Protein is done for today, so just keep logging your meals."
                )
            ),
            "reasoning": (
                f"Calculado con las {eaten} kcal registradas hasta ahora frente a tu objetivo de {goal} kcal."
                if is_es
                else f"Based on {eaten} kcal eaten so far against your {goal} kcal goal."
            ),
            "action": None,
        })
    elif meals and eaten <= goal * OVER_TARGET_RATIO:
        tips.append({
            "kind": "goal_reached",
            "state_key": reading,
            "message": (
                "Has alcanzado tu objetivo de calorías de hoy."
                if is_es
                else "You've reached today's calorie goal."
            ),
            "next_step": (
                "Con esto cierras el día; solo registra cualquier otra comida que hagas."
                if is_es
                else "That's today done, so just log anything else you eat."
            ),
            "reasoning": (
                f"Llevas {eaten} kcal frente a tu objetivo de {goal} kcal."
                if is_es
                else f"You have eaten {eaten} kcal against your {goal} kcal goal."
            ),
            "action": None,
        })
    # Below the meal tips on purpose: logging food must always change what is shown.
    agreed: dict[str, dict[str, Any]] = {}
    for item in state.get("accepted_recent", []):
        if item["days_ago"] <= FOLLOW_UP_DAYS:
            agreed.setdefault(item["kind"], item)
    tips.extend(_follow_ups(state, agreed, reading, active_lang))

    week_days = state.get("week_days_logged", 0)
    week_protein = state.get("week_protein_avg")
    protein_agreed = any(kind in agreed for kind in PROTEIN_KINDS)
    if (week_days >= MIN_DAYS_FOR_WEEK_TIPS and protein_goal > 0 and not protein_agreed
            and week_protein < protein_goal * LOW_WEEK_PROTEIN_RATIO):
        objective = state.get("objective")
        objective_es = translate_objective(objective, "es") if objective else None
        tips.append({
            "kind": "protein_week",
            "state_key": reading,
            "message": (
                f"Tu media de proteína fue de {week_protein} g esta semana, por debajo de tu objetivo de {round(protein_goal)} g."
                if is_es
                else f"Your protein averaged {week_protein} g this week, under your {round(protein_goal)} g target."
            ),
            "next_step": (
                "Añade una fuente de proteína a una comida cada día."
                if is_es
                else "Add one protein source to a meal each day."
            ),
            "reasoning": (
                f"Calculado con los {week_days} días que registraste la última semana."
                + (f" Llegar a la proteína es clave para tu objetivo de {objective_es}." if objective_es else "")
                if is_es
                else f"This comes from the {week_days} days you logged in the past week."
                + (f" Enough protein matters for your {objective} goal." if objective else "")
            ),
            "action": None,
        })
    if state.get("week_days_on_goal", 0) >= GOOD_WEEK_DAYS_ON_GOAL:
        tips.append({
            "kind": "calorie_week",
            "state_key": reading,
            "message": (
                f"Cumpliste tu objetivo de calorías {state['week_days_on_goal']} de los últimos 7 días."
                if is_es
                else f"You hit your calorie goal on {state['week_days_on_goal']} of the last 7 days."
            ),
            "next_step": (
                "Planifica las comidas de hoy igual para mantener la racha."
                if is_es
                else "Plan today's meals the same way to keep that going."
            ),
            "reasoning": (
                "Esos días quedaron dentro del 10 % de tu objetivo calórico. Las semanas constantes importan más que un día suelto."
                if is_es
                else "Those days landed within 10% of your calorie goal. Steady weeks matter more than any single day."
            ),
            "action": None,
        })
    gap = state.get("muscle_gap")
    if gap and "muscle_gap" not in agreed:
        muscle_label = translate_muscle(gap["muscle"], active_lang)
        tips.append({
            "kind": "muscle_gap",
            "state_key": reading,
            "message": (
                f"Llevas {gap['days']} días sin entrenar {muscle_label}."
                if is_es
                else f"You haven't trained {gap['muscle']} in {gap['days']} days."
            ),
            "next_step": (
                f"Incluye un ejercicio de {muscle_label} en tu próximo entrenamiento."
                if is_es
                else f"Put a {gap['muscle']} exercise in your next workout."
            ),
            "reasoning": (
                "Es el grupo muscular que más tiempo llevas sin entrenar en los últimos 30 días."
                if is_es
                else "It's the muscle group you've gone longest without training in the past 30 days."
            ),
            "action": {"type": "focus_muscle", "muscle": gap["muscle"]},
        })
    since = state.get("days_since_workout")
    if since is not None and since >= TRAINING_GAP_DAYS and not is_rest_day and "training_gap" not in agreed:
        tips.append({
            "kind": "training_gap",
            "state_key": reading,
            "message": (
                f"Han pasado {since} días desde tu último entrenamiento."
                if is_es
                else f"It's been {since} days since your last workout."
            ),
            "next_step": (
                "Planifica una sesión corta en los próximos uno o dos días."
                if is_es
                else "Plan a short session in the next day or two."
            ),
            "reasoning": (
                "La regularidad importa más que una gran sesión aislada, así que un entrenamiento corto también cuenta."
                if is_es
                else "Regular training matters more than any single big session, so a short workout still counts."
            ),
            "action": None,
        })
    if is_rest_day and not workouts_today:
        tips.append({
            "kind": "rest_day",
            "state_key": reading,
            "message": (
                "Hoy toca descanso, y recuperarte también forma parte del entrenamiento."
                if is_es
                else "It's a rest day, and recovery is part of your training."
            ),
            "next_step": (
                "Sal a caminar o estira un poco si te apetece moverte."
                if is_es
                else "Go for a walk or stretch a little if you feel like moving."
            ),
            "reasoning": (
                "Tu plan no tiene entrenamiento hoy. Los músculos se fortalecen cuando descansas, no solo cuando entrenas."
                if is_es
                else "Your plan has no workout today. Muscles get stronger while you rest, not only while you train."
            ),
            "action": None,
        })
    streak = state.get("streak_days", 0)
    if streak >= MIN_STREAK_DAYS:
        tips.append({
            "kind": "logging_streak",
            "state_key": reading,
            "message": (
                f"Llevas {streak} días seguidos registrando tus comidas."
                if is_es
                else f"{streak} days of logging in a row."
            ),
            "next_step": (
                "Registra tu próxima comida para mantener la racha."
                if is_es
                else "Log your next meal to keep it going."
            ),
            "reasoning": (
                f"Has registrado comidas cada uno de los últimos {streak} días. Ser constante hace mis consejos más útiles."
                if is_es
                else f"You logged meals on each of the last {streak} days. Staying consistent makes my tips more useful."
            ),
            "action": None,
        })
    yesterday = state.get("yesterday")
    if not meals and yesterday:
        protein_short = round(protein_goal - yesterday["protein"])
        tips.append({
            "kind": "yesterday_recap",
            "state_key": reading,
            "message": (
                (
                    f"Ayer te faltaron {protein_short} g de proteína."
                    if is_es
                    else f"You were {protein_short} g short on protein yesterday."
                )
                if protein_short > 0
                else (
                    f"Ayer alcanzaste {yesterday['protein']} g de proteína."
                    if is_es
                    else f"You reached {yesterday['protein']} g of protein yesterday."
                )
            ),
            "next_step": (
                (
                    "Haz que tu primera comida de hoy sea rica en proteína."
                    if is_es
                    else "Make your first meal today rich in protein."
                )
                if protein_short > 0
                else (
                    "Registra tu primera comida para empezar hoy igual de bien."
                    if is_es
                    else "Log your first meal to start today the same way."
                )
            ),
            "reasoning": (
                f"Ayer registraste {yesterday['kcal']} kcal y {yesterday['protein']} g de proteína."
                if is_es
                else f"Yesterday you logged {yesterday['kcal']} kcal and {yesterday['protein']} g of protein."
            ),
            "action": None,
        })
    if not meals:
        tips.append({
            "kind": "nothing_logged",
            "state_key": reading,
            "message": (
                "Todavía no has registrado ninguna comida hoy."
                if is_es
                else "You haven't logged any meals yet today."
            ),
            "next_step": (
                "Registra tu primera comida para poder adaptar los consejos de hoy."
                if is_es
                else "Log your first meal so I can tailor today's tips."
            ),
            "reasoning": (
                "Aún no hay comidas registradas hoy, así que todavía no tengo datos para personalizar un consejo."
                if is_es
                else "There are no meals logged for today yet, so there is nothing to base a tip on."
            ),
            "action": None,
        })
    return tips


def _rows(response: Any) -> list[dict[str, Any]]:
    rows = response.data or []
    return rows if isinstance(rows, list) else [rows]


def collect_state(session: Any, user_id: UUID, day: LocalDay) -> dict[str, Any]:
    uid = str(user_id)
    history_start = day.start - timedelta(days=HISTORY_DAYS)
    prev_start = day.start - timedelta(days=13)

    def users():
        return _rows(session.table("users").select("calorie_goal,weight,height,age,gender,objective")
                     .eq("id", uid).limit(1).execute())

    def meals():
        return _rows(session.table("meals").select("calories,proteins").eq("user_id", uid)
                     .gte("consumed_at", day.start.isoformat()).lt("consumed_at", day.end.isoformat()).execute())

    def meal_history():
        return _rows(session.table("meals").select("name,calories,proteins,consumed_at").eq("user_id", uid)
                     .gte("consumed_at", history_start.isoformat()).lt("consumed_at", day.end.isoformat()).execute())

    def workouts():
        return _rows(session.table("workouts")
                     .select("name,start_time,end_time,workout_sets(is_done,weight,rpe,exercises(name,muscle_group))")
                     .eq("user_id", uid).gte("start_time", history_start.isoformat()).execute())

    def accepted():
        since = day.start - timedelta(days=ACCEPTED_LOOKBACK_DAYS)
        return _rows(session.table(TIPS_TABLE).select("kind,action,created_at").eq("user_id", uid)
                     .eq("status", "accepted").gte("created_at", since.isoformat()).execute())

    def plan():
        return _rows(session.table("workout_plans").select("is_rest_day,exercises")
                     .eq("user_id", uid).eq("plan_date", day.local_date.isoformat()).limit(1).execute())

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(fn) for fn in (users, meals, meal_history, workouts, plan, accepted)]
        user_rows, meal_rows, meal_history_rows, workout_rows, plan_rows, accepted_rows = (
            future.result() for future in futures
        )

    user = user_rows[0] if user_rows else {}
    goal = int(user["calorie_goal"]) if user.get("calorie_goal") else calculate_calorie_goal(
        user.get("weight"), user.get("height"), user.get("age"), user.get("gender"), user.get("objective"),
    )
    goal += kcal_bonus(user_id, day, session)
    weight = float(user.get("weight") or 0)

    week_start = day.start - timedelta(days=6)
    sets_last_7d = sets_prev_7d = workouts_done_today = workout_seconds = 0
    for workout in workout_rows:
        started = instant(workout.get("start_time"))
        if started is None or started < prev_start:
            continue
        sets = sum(1 for row in workout.get("workout_sets") or [] if row.get("is_done") is not False)
        if started >= week_start:
            sets_last_7d += sets
        else:
            sets_prev_7d += sets
        finished = instant(workout.get("end_time"))
        if day.start <= started < day.end and finished is not None:
            workouts_done_today += 1
            workout_seconds += max(0, int((finished - started).total_seconds()))

    meal_summary = summarize_meals(meal_history_rows, day, goal)
    hours_into_day = (datetime.now(timezone.utc) - day.start).total_seconds() // 3600

    today_plan = plan_rows[0] if plan_rows else None
    exercises = (today_plan or {}).get("exercises") or []
    return {
        "goal": goal,
        "eaten_kcal": sum(float(row.get("calories") or 0) for row in meal_rows),
        "protein_eaten": sum(float(row.get("proteins") or 0) for row in meal_rows),
        "protein_goal": round(weight * PROTEIN_PER_KG, 1),
        "meals_count": len(meal_rows),
        "workouts_done_today": workouts_done_today,
        "workout_seconds": workout_seconds,
        "weight_kg": weight,
        "streak_days": logging_streak(meal_summary.pop("logged_days")),
        "objective": user.get("objective"),
        "accepted_recent": summarize_accepted(accepted_rows, day),
        "local_hour": int(min(23, max(0, hours_into_day))),
        **meal_summary,
        **summarize_workouts(workout_rows, day),
        "sets_last_7d": sets_last_7d,
        "sets_prev_7d": sets_prev_7d,
        "planned_sets_today": sum(int(item.get("sets") or 0) for item in exercises),
        "plan": {"is_rest_day": bool(today_plan.get("is_rest_day")), "exercises": exercises} if today_plan else None,
    }


def kcal_bonus(user_id: UUID | str, day: LocalDay, session: Any = None) -> int:
    """Calories the user accepted for this day. A missing table must not break the dashboard."""
    try:
        session = session or get_supabase(admin=True)
        rows = _rows(session.table(TIPS_TABLE).select("action").eq("user_id", str(user_id))
                     .eq("status", "accepted").gte("created_at", day.start.isoformat())
                     .lt("created_at", day.end.isoformat()).execute())
    except Exception:
        logger.warning("Could not read accepted calorie tips", exc_info=True)
        return 0
    return sum(int(row["action"].get("kcal") or 0) for row in rows
               if row.get("action") and row["action"].get("type") == "add_kcal")


def _public(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": str(row["id"]), "kind": row["kind"], "message": row["message"],
            "reasoning": row["reasoning"]}


def _with_model_wording(
    tip: dict[str, Any],
    user_id: UUID,
    seen_keys: set[str],
    state: dict[str, Any],
    session: Any,
    lang: str = "en",
) -> dict[str, Any]:
    """Make a new tip personal if allowed. Any failure keeps the rule's text, so Home never depends on the model."""
    # Safety gate: is_safe_wording only understands English wording, so non-English users always get rule-written tips.
    if lang != "en":
        return tip
    settings = get_settings()
    if not settings.ai_tips_model_enabled or not settings.ai_api_key:
        return tip
    # A key seen before means the data has not changed: dismissing tips or reloading spends nothing.
    if tip["state_key"] in seen_keys or len(seen_keys) >= MAX_MODEL_TIPS_PER_DAY:
        return tip
    facts = personal_facts(state)
    try:
        if not has_active_premium(str(user_id), session):
            return tip
        wording = phrase_tip(tip["message"], tip["reasoning"], facts, tip["next_step"])
    except Exception:
        logger.warning("Could not reword the tip; using the template", exc_info=True)
        return tip
    if not is_safe_wording(tip, wording, facts):
        logger.warning("Rejected the model's wording for a %s tip", tip["kind"])
        return tip
    return {**tip, "message": wording["message"].strip(), "reasoning": wording["reasoning"].strip(), "source": "model"}


def get_current_tip(
    user_id: UUID,
    day: LocalDay | None = None,
    session: Any = None,
    lang: str | None = None,
) -> dict[str, Any] | None:
    """First candidate the user has not answered. Stored on first display so it can be decided later."""
    active_lang = normalize_language(lang) if lang is not None else get_language()
    session = session or get_supabase(admin=True)
    day = day or utc_day()
    tip_date = day.local_date.isoformat()
    rows = _rows(session.table(TIPS_TABLE).select("*").eq("user_id", str(user_id)).eq("tip_date", tip_date).execute())
    stored = {(row["kind"], row["state_key"]): row for row in rows}
    seen_keys = {row["state_key"] for row in rows}
    answered_kinds = {row["kind"] for row in rows if row["status"] != "pending"}
    state = collect_state(session, user_id, day)
    for tip in build_candidates(state, lang=active_lang):
        if tip["kind"] in answered_kinds and tip["kind"] not in REACTIVE_KINDS and tip["state_key"] != "day":
            continue  # an insight the user already answered stays gone for the day
        rule_message = f"{tip['message']} {tip['next_step']}" if tip["next_step"] else tip["message"]
        row = stored.get((tip["kind"], tip["state_key"]))
        if row:
            if row["status"] == "pending":
                # Keep model-written English tips untouched, but always render rule-written text
                # in the active language (and always rule-written for Spanish).
                if active_lang != "en" or row.get("source") != "model":
                    return {**_public(row), "message": rule_message, "reasoning": tip["reasoning"]}
                return _public(row)
            continue
        tip = _with_model_wording(tip, user_id, seen_keys, state, session, lang=active_lang)
        next_step = tip.pop("next_step")
        message = f"{tip['message']} {next_step}" if next_step else tip["message"]
        try:
            inserted = _rows(session.table(TIPS_TABLE).insert(
                {**tip, "message": message, "user_id": str(user_id), "tip_date": tip_date}).execute())
        except Exception as err:
            if "23505" not in str(err):  # another request stored it first; show the stored one
                raise
            inserted = _rows(session.table(TIPS_TABLE).select("*").eq("user_id", str(user_id))
                             .eq("tip_date", tip_date).eq("kind", tip["kind"])
                             .eq("state_key", tip["state_key"]).execute())
            if inserted and inserted[0]["status"] != "pending":
                continue
        if inserted:
            if active_lang != "en":
                return {**_public(inserted[0]), "message": rule_message, "reasoning": tip["reasoning"]}
            return _public(inserted[0])
    return None


def _set_status(session: Any, tip_id: str, new: str, old: str) -> list[dict[str, Any]]:
    return _rows(session.table(TIPS_TABLE).update({"status": new}).eq("id", tip_id).eq("status", old).execute())


def _change_planned_sets(
    session: Any, user_id: UUID, exercise_id: str, day: LocalDay, change: int,
) -> bool:
    """Add or remove a set in today's plan. False means the plan can no longer change."""
    state = collect_state(session, user_id, day)
    plan = state["plan"]
    if state["workouts_done_today"] or not plan or plan["is_rest_day"]:
        return False
    if change > 0 and not can_add_set(state["sets_last_7d"], state["planned_sets_today"], state["sets_prev_7d"]):
        return False
    updated = bump_exercise_sets(plan["exercises"], exercise_id, change)
    if updated is None:
        return False
    session.table("workout_plans").update({"exercises": updated, "updated_at": datetime.now(timezone.utc).isoformat()}) \
        .eq("user_id", str(user_id)).eq("plan_date", day.local_date.isoformat()).execute()
    return True


def _not_available(lang: str) -> str:
    return pick(NOT_AVAILABLE, "Ese cambio ya no está disponible, así que no se modificó nada.", lang)


def _confirmation(tip: dict[str, Any], lang: str | None = None) -> str:
    action = tip.get("action") or {}
    if action.get("type") == "add_set":
        return pick("Added one set to today's workout.", "Se añadió una serie al entrenamiento de hoy.", lang)
    if action.get("type") == "add_kcal":
        kcal = action.get("kcal")
        return pick(f"Added {kcal} kcal to today's goal.", f"Se añadieron {kcal} kcal al objetivo de hoy.", lang)
    if action.get("type") == "focus_muscle" or tip["kind"] in PLAN_NOTES:
        return pick(
            "Got it, I'll use this in your next workout plan.",
            "Entendido, lo tendré en cuenta en tu próximo plan de entrenamiento.",
            lang,
        )
    return pick("Got it, I'll follow up on this.", "Entendido, haré seguimiento de esto.", lang)


def accepted_training_notes(user_id: UUID, day_start: datetime, session: Any) -> list[str]:
    """What the user recently agreed to about training, for the workout planner.

    Written here rather than taken from the tip text, so the planner only ever reads
    rule-made instructions. A failure must not stop the plan from being built.
    """
    try:
        rows = _rows(session.table(TIPS_TABLE).select("kind,action").eq("user_id", str(user_id))
                     .eq("status", "accepted").gte("created_at", (day_start - timedelta(days=PLAN_NOTE_DAYS)).isoformat())
                     .execute())
    except Exception:
        logger.warning("Could not read accepted tips for the workout plan", exc_info=True)
        return []
    focus = get_muscle_focus(session, user_id)
    notes: list[str] = []
    for row in rows:
        muscle = (row.get("action") or {}).get("muscle")
        if muscle and focus:  # the setting outranks an accepted tip
            continue
        note = f"Agreed to train {muscle} next: prefer it if it is available." if muscle else PLAN_NOTES.get(row.get("kind"))
        if note and note not in notes:
            notes.append(note)
    if focus:
        notes.append(f"Chose {focus} as their muscle focus: prefer it if it is available.")
    return notes


def _find_tip(session: Any, user_id: UUID, tip_id: UUID) -> dict[str, Any]:
    found = _rows(session.table(TIPS_TABLE).select("*").eq("id", str(tip_id)).eq("user_id", str(user_id))
                  .limit(1).execute())
    if not found:
        raise ValueError("Tip not found")
    return found[0]


def _is_today(tip: dict[str, Any], day: LocalDay) -> bool:
    return str(tip["tip_date"]) == day.local_date.isoformat()


def decide_tip(
    user_id: UUID,
    tip_id: UUID,
    status: str,
    day: LocalDay | None = None,
    session: Any = None,
    lang: str | None = None,
) -> dict[str, Any]:
    """Dismiss or accept a tip, then return the next one. Repeating a decision changes nothing."""
    if status not in ("accepted", "dismissed"):
        raise ValueError("Invalid decision status")
    active_lang = normalize_language(lang) if lang is not None else get_language()
    session = session or get_supabase(admin=True)
    day = day or utc_day()
    tip = _find_tip(session, user_id, tip_id)
    action = tip.get("action") or {}
    applied, notice = False, None
    is_stale = not _is_today(tip, day)  # a tab left open overnight must not change the new day

    # Claim the tip before applying it, so a double tap cannot apply it twice.
    if tip["status"] == "pending" and _set_status(session, str(tip_id), "dismissed" if is_stale else status, "pending"):
        if status == "accepted" and is_stale:
            notice = _not_available(active_lang)
        elif status == "accepted" and action.get("type") == "add_set":
            try:
                applied = _change_planned_sets(session, user_id, str(action.get("exercise_id")), day, 1)
            except Exception:
                _set_status(session, str(tip_id), "pending", status)
                raise
            if not applied:
                _set_status(session, str(tip_id), "dismissed", status)
                notice = _not_available(active_lang)
        elif status == "accepted":
            applied = True
    return {
        "applied": applied,
        "notice": notice,
        "confirmation": _confirmation(tip, active_lang) if applied else None,
        "tip": get_current_tip(user_id, day, session, lang=active_lang),
    }


def undo_tip(
    user_id: UUID,
    tip_id: UUID,
    day: LocalDay | None = None,
    session: Any = None,
    lang: str | None = None,
) -> dict[str, Any]:
    """Reverse an accepted tip from today and offer it again. Repeating an undo changes nothing."""
    active_lang = normalize_language(lang) if lang is not None else get_language()
    session = session or get_supabase(admin=True)
    day = day or utc_day()
    tip = _find_tip(session, user_id, tip_id)
    action = tip.get("action") or {}
    undone = False

    if tip["status"] == "accepted" and _is_today(tip, day) and _set_status(session, str(tip_id), "pending", "accepted"):
        undone = True
        if action.get("type") == "add_set":
            try:
                undone = _change_planned_sets(session, user_id, str(action.get("exercise_id")), day, -1)
            except Exception:
                _set_status(session, str(tip_id), "accepted", "pending")
                raise
            if not undone:
                _set_status(session, str(tip_id), "accepted", "pending")
    return {
        "applied": undone,
        "notice": (
            pick("Change undone.", "Cambio deshecho.", active_lang)
            if undone
            else pick("That change can no longer be undone.", "Ese cambio ya no se puede deshacer.", active_lang)
        ),
        "confirmation": None,
        "tip": get_current_tip(user_id, day, session, lang=active_lang),
    }
