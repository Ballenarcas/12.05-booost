"""AI Coach chat: what the model is told, and what it is allowed to say back.

The model only sees facts about this user and a short list of catalog exercises.
Whatever it writes that fails is_safe_chat_reply is replaced by a fixed message.
"""

import logging
import re
from typing import Any
from uuid import UUID

from app.core.i18n import pick
from app.core.local_day import LocalDay
from app.schemas.exercise import Exercise
from app.services.ai_tip_history import days_ago, meal_label, personal_facts, weight_text
from app.services.ai_tips_service import MEDICAL_TERMS, NUMBER, _amounts, collect_state
from app.services.exercise_catalog import get_cached_exercise, load_cached_exercises
from app.services.fuzzy_matcher import get_fuzzy_matcher
from app.services.workout_program import load_staples
from app.services.workout_service import list_user_routines, list_workout_history

logger = logging.getLogger(__name__)

MAX_REPLY_LENGTH = 1200
MAX_CANDIDATE_EXERCISES = 40
MAX_ROUTINES = 6
RECENT_WORKOUTS = 5
MAX_DAILY_DEFICIT_KCAL = 500
MAX_WEEKLY_LOAD_PERCENT = 10

MEDICAL_TERMS_ES = (
    r"diagn[oó]stic\w*|tratamientos?|curar\w*|enfermedad\w*|trastornos?|m[eé]dic(?:o|a|os|as)|medicamentos?"
    r"|medicaci[oó]n|diab[eé]t\w*|s[ií]ntomas?|terapia\w*|lesi[oó]n\w*|lesionad\w*|suplement\w*|doctora?e?s?"
)
MEDICAL_WORDING = re.compile(rf"\b(?:{MEDICAL_TERMS}|{MEDICAL_TERMS_ES})\b", re.IGNORECASE)
# Only for the user's question: words a coach may use in an answer but that point to a health problem.
HEALTH_QUESTION = re.compile(
    r"\b(?:pain\w*|hurts?|pregnan\w*|dolor(?:es)?|duelen?|embaraz\w*)\b", re.IGNORECASE
)
# "medicine ball" is equipment, not medicine.
EQUIPMENT_PHRASES = re.compile(r"medicine[- ]ball|bal[oó]n(?:es)? medicinal(?:es)?", re.IGNORECASE)
# Eating less, amounts spelled out so the number check cannot see them, and claims of having changed something.
BLOCKED_ADVICE = re.compile(
    r"\b(?:eat less|skip(?:ping)? (?:a |your |the )?(?:meals?|breakfast|lunch|dinner)|fasting|starv\w*|detox\w*"
    r"|restrict\w*|cut calories|burn it off|percent|hundred|thousand|double|triple|twice as"
    r"|i added|i['’]ve added|i have added|i updated|i['’]ve updated"
    r"|come(?:r)? menos|s[aá]lta(?:r|te)? (?:comidas?|el desayuno|la comida|la cena)|ayun\w*|desintox\w*"
    r"|pasar hambre|restring\w*|restric\w*|por ciento|cien|cientos|mil|miles|doble|triple"
    r"|he añadido|he actualizado)\b",
    re.IGNORECASE,
)
PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*%")
DEFICIT_AMOUNT = re.compile(
    r"d[eé]ficit\s+(?:cal[oó]rico\s+)?(?:of|de)\s+(\d+(?:\.\d+)?)"
    r"|(\d+(?:\.\d+)?)[\s-]*(?:kcal|calor\w*)[\s-]+(?:de\s+)?(?:daily\s+|calorie\s+)?d[eé]ficit",
    re.IGNORECASE,
)
# Amounts written as words, which the digit check cannot see. "one" and the Spanish "once" are everyday words.
SPELLED_AMOUNT = re.compile(
    r"\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\w+teen|twenty|thirty|forty|fifty|sixty"
    r"|seventy|eighty|ninety|a dozen|half a|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|trece|catorce"
    r"|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta"
    r"|setenta|ochenta|noventa|una docena(?: de)?|medio|media)[\s-]+(?:\w+[\s-]+)?"
    r"(?:sets?|reps?|grams?|g|kg|kilos?|kcal|calories|minutes?|seconds?|hours?|days?|weeks?|meals?|servings?"
    r"|series?|repeticion(?:es)?|gramos?|calor[ií]as?|minutos?|segundos?|horas?|d[ií]as?|semanas?|comidas?"
    r"|raciones|doce|diez|ocho|quince)\b",
    re.IGNORECASE,
)
# "a treat" is food, not treatment.
FOOD_TREAT = re.compile(r"\b(?:a|an occasional|the occasional|cheat) treats?\b", re.IGNORECASE)
LIST_MARKER = re.compile(r"(?m)^\s*\d+[.)]\s+")

# exercise_staples.json only covers strength work: run, bike, elliptical, incline walk, jump rope.
CARDIO_STAPLES = ["0685", "0798", "2141", "3666", "2612"]

# Question words that point to a catalog category.
CATEGORY_WORDS = {
    "Chest": ("chest", "pecho", "bench", "banca"),
    "Back": ("back", "lats", "espalda", "dorsal"),
    "Legs": ("leg", "legs", "squat", "squats", "sentadillas", "glute", "glutes", "pierna", "piernas", "glúteo", "glúteos", "sentadilla"),
    "Arms": ("arm", "arms", "biceps", "triceps", "brazo", "brazos", "bíceps", "tríceps"),
    "Shoulders": ("shoulder", "shoulders", "hombro", "hombros"),
    "Abs": ("abs", "core", "abdomen", "abdominales"),
    "Calves": ("calf", "calves", "gemelo", "gemelos"),
    "Cardio": ("cardio", "running", "correr", "resistencia"),
}

# Models write look-alike hyphens and spaces, which would slip a name or amount past the checks.
PLAIN_CHARACTERS = str.maketrans({code: "-" for code in range(0x2010, 0x2016)} | {0x00A0: " ", 0x2009: " ", 0x202F: " "})

_name_index: tuple[int, re.Pattern[str] | None] | None = None


def medical_refusal() -> str:
    return pick(
        "I can't give medical advice. Please talk to a health professional about this. "
        "I can still help with your training and nutrition.",
        "No puedo dar consejos médicos. Consulta esto con un profesional de la salud. "
        "Sí puedo ayudarte con tu entrenamiento y tu nutrición.",
    )


def fallback_reply() -> str:
    return pick(
        "I couldn't give a reliable answer to that. I can help with training and nutrition based on your "
        "own data: try asking about your routines, your recent workouts or today's meals.",
        "No he podido darte una respuesta fiable. Puedo ayudarte con el entrenamiento y la nutrición a partir "
        "de tus datos: pregunta por tus rutinas, tus últimos entrenamientos o las comidas de hoy.",
    )


def is_medical_question(question: str) -> bool:
    text = FOOD_TREAT.sub(" ", EQUIPMENT_PHRASES.sub(" ", question))
    return bool(MEDICAL_WORDING.search(text) or HEALTH_QUESTION.search(text))


def _canonical_number(value: str) -> str:
    """2.100, 2,100 and 2100 are one number; so are 72,5 and 72.50."""
    if re.fullmatch(r"[1-9]\d{0,2}(?:[.,]\d{3})+", value):
        return re.sub(r"[.,]", "", value)
    value = value.replace(",", ".")
    return value.rstrip("0").rstrip(".") if value.count(".") == 1 else value


def _plain_numbers(text: str) -> str:
    return NUMBER.sub(lambda match: _canonical_number(match.group()), text)


def _catalog_names() -> re.Pattern[str] | None:
    """Every catalog name of two or more words. One-word names are also ordinary words, so they are not matched."""
    global _name_index
    catalog = load_cached_exercises()
    if _name_index is None or _name_index[0] != id(catalog):
        names = {
            name.lower()
            for exercise in catalog
            for name in (exercise.name, exercise.name_es, *exercise.aliases)
            if name and len(name.split()) > 1
        }
        # Longest first, so "Incline Bench Press" is not read as "Bench Press".
        joined = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True))
        _name_index = (id(catalog), re.compile(rf"(?<!\w)(?:{joined})(?!\w)", re.IGNORECASE) if joined else None)
    return _name_index[1]


def _names_of(exercise_id: str) -> set[str]:
    exercise = get_cached_exercise(exercise_id)
    if exercise is None:
        return set()
    return {name.lower() for name in (exercise.name, exercise.name_es, *exercise.aliases) if name}


def named_exercises(reply: str, candidates: list[dict[str, str]]) -> list[str]:
    """Ids of the candidates the reply names."""
    pattern = _catalog_names()
    named = {match.lower() for match in pattern.findall(reply.translate(PLAIN_CHARACTERS))} if pattern else set()
    return [item["id"] for item in candidates if named & _names_of(item["id"])]


def is_safe_chat_reply(
    reply: Any,
    exercise_ids: Any,
    facts: list[str],
    candidates: list[dict[str, str]],
) -> bool:
    """Accept a model's answer only with real numbers, catalog exercises and no medical or restrictive advice.

    The user's question is deliberately not a source of numbers: "is a 1500 kcal deficit fine?"
    must not let the answer repeat 1500.
    """
    def reject(reason: str) -> bool:
        logger.warning("Rejected the coach's reply: %s", reason)
        return False

    if not isinstance(reply, str) or not isinstance(exercise_ids, list):
        return reject("wrong shape")
    if not reply.strip() or len(reply) > MAX_REPLY_LENGTH:
        return reject("wrong length")
    allowed_ids = {item["id"] for item in candidates}
    if not all(isinstance(value, str) and value in allowed_ids for value in exercise_ids):
        return reject("exercise id outside the candidates")

    text = EQUIPMENT_PHRASES.sub(" ", reply.translate(PLAIN_CHARACTERS))
    if MEDICAL_WORDING.search(text) or BLOCKED_ADVICE.search(text):
        return reject("blocked wording")
    if SPELLED_AMOUNT.search(text):
        return reject("amount written in words")

    allowed_names = {name for item in candidates for name in _names_of(item["id"])}
    pattern = _catalog_names()
    if pattern:
        if any(match.lower() not in allowed_names for match in pattern.findall(text)):
            return reject("exercise name outside the candidates")
        text = pattern.sub(" ", text)  # a name such as "3/4 Sit-Up" carries no figure

    text = _plain_numbers(LIST_MARKER.sub("", text))
    known = _plain_numbers(" ".join(facts))
    if not set(NUMBER.findall(text)) <= set(NUMBER.findall(known)) or not _amounts(text) <= _amounts(known):
        return reject("number that is not in the user's data")
    if any(float(value) > MAX_WEEKLY_LOAD_PERCENT for value in PERCENT.findall(text)):
        return reject("percentage above the load limit")
    if any(float(first or second) > MAX_DAILY_DEFICIT_KCAL for first, second in DEFICIT_AMOUNT.findall(text)):
        return reject("deficit above the limit")
    return True


def _routine_facts(routines: list[Any]) -> list[str]:
    facts = []
    for routine in routines[:MAX_ROUTINES]:
        parts = []
        for item in routine.exercises:
            catalog = get_cached_exercise(item.exercise_id)
            # Catalog names are trusted; names the user typed must not become trusted figures.
            name = catalog.name if catalog else meal_label(item.name)
            reps = item.reps_by_set or []
            if reps and len(set(reps)) == 1:
                parts.append(f"{name} {len(reps)} sets of {reps[0]} reps")
            elif reps:
                parts.append(f"{name} {len(reps)} sets of {', '.join(map(str, reps))} reps")
            else:
                parts.append(name)
        facts.append(f"Routine \"{meal_label(routine.name)}\": {'; '.join(parts) or 'no exercises'}")
    return facts


def _history_facts(entries: list[Any], day: LocalDay) -> list[str]:
    facts = []
    for entry in entries:
        parts = []
        for item in entry.exercises:
            catalog = get_cached_exercise(str(item.exercise_id))
            name = catalog.name if catalog else meal_label(item.name)
            done = [row for row in item.sets if row.is_completed]
            if not done:
                continue
            best = max(done, key=lambda row: (row.weight_kg, row.reps))
            if item.is_cardio:
                parts.append(name)
            elif best.weight_kg > 0:
                parts.append(f"{name} {len(done)} sets, best {weight_text(best.weight_kg)} kg for {best.reps} reps")
            else:
                parts.append(f"{name} {len(done)} sets, best {best.reps} reps")
        if parts:
            age = max(0, days_ago(entry.started_at, day))
            facts.append(f"Workout {age} days ago ({meal_label(entry.name)}): {'; '.join(parts)}")
    return facts


def user_facts(session: Any, user_id: UUID, day: LocalDay, routines: list[Any]) -> list[str]:
    state = collect_state(session, user_id, day)
    lift = state.get("lift_progress")
    safe_state = {
        **state,
        "objective": meal_label(state.get("objective")),
        "last_workout_name": meal_label(state.get("last_workout_name")),
        "lift_progress": {**lift, "exercise": meal_label(lift["exercise"])} if lift else None,
    }
    facts = personal_facts(safe_state)
    facts.append(
        f"Left today: {max(0, state['goal'] - round(state['eaten_kcal']))} kcal, "
        f"{max(0, round(state['protein_goal']) - round(state['protein_eaten']))} g protein"
    )
    if state.get("weight_kg"):
        facts.append(f"Body weight: {weight_text(state['weight_kg'])} kg")
    history = list_workout_history(user_id, limit=RECENT_WORKOUTS).items
    return facts + _routine_facts(routines) + _history_facts(history, day)


def candidate_exercises(question: str, routines: list[Any]) -> list[dict[str, str]]:
    """The catalog exercises the model may recommend, most relevant first.

    The user's own and the ones they name come first. Everything else comes from the vetted
    staples, in priority order, so the coach suggests common exercises and not obscure variants.
    """
    found: dict[str, Exercise] = {}

    def add(exercise_id: str) -> None:
        exercise = get_cached_exercise(exercise_id)
        if exercise and len(found) < MAX_CANDIDATE_EXERCISES:
            found.setdefault(exercise.id, exercise)

    pattern = _catalog_names()
    named = {name.lower() for name in pattern.findall(question)} if pattern else set()
    if named:
        for exercise in load_cached_exercises():
            if exercise.name.lower() in named:
                add(exercise.id)
    for routine in routines[:MAX_ROUTINES]:
        for item in routine.exercises:
            add(item.exercise_id)

    staples = load_staples()
    # Loose name matches bring in junk ("la" matches "Flag"), so only staples count.
    for match in get_fuzzy_matcher().match(question, limit_per_category=20).exercises:
        if match.id in staples:
            add(match.id)

    # Priority is the pick order within a movement, so this sort takes the first choice of every movement first.
    ranked = sorted(staples, key=lambda key: (staples[key].get("priority", 50), staples[key].get("tier", "B")))
    popular = CARDIO_STAPLES + ranked
    words = set(re.findall(r"\w+", question.lower()))
    for category, keywords in CATEGORY_WORDS.items():
        if words & set(keywords):
            for exercise_id in popular:
                exercise = get_cached_exercise(exercise_id)
                if exercise and exercise.category == category:
                    add(exercise_id)
    # A general question can still be answered with real exercises.
    # Strength first picks lead; a little cardio follows, before the list is full.
    for exercise_id in ranked[:30] + CARDIO_STAPLES[:3] + ranked[30:]:
        add(exercise_id)

    return [{"id": exercise.id, "name": exercise.name} for exercise in found.values()]


def build_context(session: Any, user_id: UUID, day: LocalDay, question: str) -> tuple[list[str], list[dict[str, str]]]:
    routines = list_user_routines(user_id)
    return user_facts(session, user_id, day, routines), candidate_exercises(question, routines)
