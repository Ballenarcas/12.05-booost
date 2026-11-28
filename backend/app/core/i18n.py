"""Request-scoped backend language resolution (English / Spanish) and error translations."""

from __future__ import annotations

import re
from contextlib import contextmanager
from contextvars import ContextVar, Token
from datetime import date
from typing import Any, Iterator

SUPPORTED_LANGUAGES = ("en", "es")
DEFAULT_LANGUAGE = "en"

_language: ContextVar[str] = ContextVar("booost_language", default=DEFAULT_LANGUAGE)

_ES_WEEKDAYS = ("Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom")
_ES_MONTHS = (
    "",
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
)

_MUSCLES_ES: dict[str, str] = {
    "chest": "pecho",
    "shoulders": "hombros",
    "back": "espalda",
    "quads": "cuádriceps",
    "hamstrings": "isquiotibiales",
    "glutes": "glúteos",
    "legs": "piernas",
    "arms": "brazos",
    "core": "core",
    "abs": "abdomen",
    "calves": "gemelos",
    "biceps": "bíceps",
    "triceps": "tríceps",
    "forearms": "antebrazos",
    "cardio": "cardio",
}

_OBJECTIVES_ES: dict[str, str] = {
    "lose weight": "perder peso",
    "weight loss": "perder peso",
    "fat loss": "perder grasa",
    "build muscle": "ganar músculo",
    "muscle gain": "ganar músculo",
    "hypertrophy": "hipertrofia",
    "gain strength": "ganar fuerza",
    "strength": "fuerza",
    "maintain": "mantener",
    "maintenance": "mantenimiento",
    "maintain weight": "mantener peso",
    "endurance": "resistencia",
    "general fitness": "forma física general",
    "general health": "salud general",
}

_FIELD_NAMES_ES: dict[str, str] = {
    "weight": "peso",
    "height": "altura",
    "age": "edad",
}

_TEMPLATE_LABELS_ES: dict[str, str] = {
    "full_body": "Cuerpo completo",
    "upper": "Tren superior",
    "lower": "Tren inferior",
    "push": "Día de empuje",
    "pull": "Día de tirón",
    "legs": "Día de pierna",
}

_ERROR_EXACT_ES: dict[str, str] = {
    # Database / infrastructure
    "Could not reach the database. Check your network and try again.": "No se pudo conectar con la base de datos. Comprueba tu conexión e inténtalo de nuevo.",
    "The database took too long to answer. Try again.": "La base de datos tardó demasiado en responder. Inténtalo de nuevo.",
    "Database connection unavailable": "Conexión con la base de datos no disponible.",
    "Supabase is not configured": "El servicio de base de datos no está configurado.",
    "Service unavailable. Please try again.": "Servicio no disponible. Inténtalo de nuevo.",
    # Auth / users / password reset
    "Invalid or expired session.": "Sesión no válida o caducada.",
    "Authentication is not configured.": "La autenticación no está configurada.",
    "Invalid email or password": "Correo o contraseña incorrectos.",
    "Could not sign in": "No se pudo iniciar sesión.",
    "This email is already registered. Sign in instead.": "Este correo ya está registrado. Inicia sesión en su lugar.",
    "Could not confirm the saved user profile.": "No se pudo confirmar el perfil de usuario guardado.",
    "Could not create the account.": "No se pudo crear la cuenta.",
    "This link is invalid or has expired. Ask for a new one.": "Este enlace no es válido o ha caducado. Solicita uno nuevo.",
    "Could not update the password. Please try again.": "No se pudo actualizar la contraseña. Inténtalo de nuevo.",
    "User not found": "Usuario no encontrado.",
    "User profile was not found": "No se encontró el perfil de usuario.",
    "Profile not found.": "Perfil no encontrado.",
    "Could not save your settings.": "No se pudieron guardar tus ajustes.",
    # AI & quotas
    "You've reached today's AI limit. Please try again tomorrow.": "Has alcanzado el límite diario de IA. Inténtalo de nuevo mañana.",
    "AI is not configured": "La IA no está configurada.",
    "AI is not configured. Set AI_API_KEY in your .env file.": "La IA no está configurada.",
    "The AI trainer is not available right now.": "El entrenador con IA no está disponible en este momento.",
    "The AI trainer could not answer. Please try again.": "El entrenador con IA no pudo responder. Inténtalo de nuevo.",
    "You've used today's coach messages.": "Has usado los mensajes del entrenador de hoy.",
    "Conversation not found": "Conversación no encontrada.",
    "Could not load your conversations.": "No se pudieron cargar tus conversaciones.",
    "Could not build the calorie adjustment.": "No se pudo calcular el ajuste de calorías.",
    "Could not apply the calorie adjustment.": "No se pudo aplicar el ajuste de calorías.",
    "Adjustment not found": "Ajuste no encontrado.",
    "Invalid decision status": "Estado de decisión no válido.",
    "Could not build the tip.": "No se pudo generar el consejo.",
    "Could not update the tip.": "No se pudo actualizar el consejo.",
    "Could not undo the tip.": "No se pudo deshacer el consejo.",
    "Tip not found": "Consejo no encontrado.",
    # Health Connect
    "Health Connect is not set up on the server yet.": "Health Connect todavía no está configurado en el servidor.",
    "Could not read the Health Connect status.": "No se pudo leer el estado de Health Connect.",
    "Could not connect Health Connect.": "No se pudo conectar Health Connect.",
    "Could not sync Health Connect activity.": "No se pudo sincronizar la actividad de Health Connect.",
    "Could not disconnect Health Connect.": "No se pudo desconectar Health Connect.",
    "Connect Health Connect before syncing activity.": "Conecta Health Connect antes de sincronizar la actividad.",
    "No recent activity days to sync.": "No hay días de actividad reciente para sincronizar.",
    # Hydration
    "Hydration can't be loaded right now.": "No se puede cargar la hidratación en este momento.",
    "Could not load today's hydration.": "No se pudo cargar la hidratación de hoy.",
    "Hydration history can't be loaded right now.": "No se puede cargar el historial de hidratación ahora mismo.",
    "Could not load your hydration history.": "No se pudo cargar tu historial de hidratación.",
    "Hydration can't be saved right now.": "No se puede guardar la hidratación en este momento.",
    "Could not save this drink.": "No se pudo guardar esta bebida.",
    "Could not update your hydration goal.": "No se pudo actualizar tu objetivo de hidratación.",
    "Hydration can't be updated right now.": "No se puede actualizar la hidratación en este momento.",
    "This drink entry no longer exists.": "Este registro de bebida ya no existe.",
    "Could not remove this drink.": "No se pudo eliminar esta bebida.",
    "Hydration entry not found": "Registro de hidratación no encontrado.",
    # Nutrition & Meal scan & Recommendations
    "Could not search foods right now.": "No se pueden buscar alimentos en este momento.",
    "Could not load today's nutrition.": "No se pudo cargar la nutrición de hoy.",
    "Use a JPEG, PNG, or WebP photo.": "Usa una foto en formato JPEG, PNG o WebP.",
    "That photo is too large. Use one under 8 MB.": "Esa foto es demasiado grande. Usa una menor de 8 MB.",
    "That file is not a supported photo.": "Ese archivo no es una foto compatible.",
    "Could not analyze that photo. Try again.": "No se pudo analizar esa foto. Inténtalo de nuevo.",
    "The AI did not return a meal estimate.": "La IA no devolvió una estimación de la comida.",
    "No food was detected in that photo. Try a clearer photo.": "No se detectó comida en esa foto. Prueba con una foto más clara.",
    "Photo meal scanning is not configured. Set AI_VISION_MODEL to a vision-capable model.": "El escaneo de comidas por foto no está configurado.",
    "Photo meal scanning is not configured. Set AI_VISION_API_KEY.": "El escaneo de comidas por foto no está configurado.",
    "Could not reach the AI provider. Check your network and AI_VISION_BASE_URL.": "No se pudo contactar con el proveedor de IA. Comprueba tu conexión.",
    "Meals can't be saved right now.": "No se pueden guardar comidas en este momento.",
    "Could not save this meal.": "No se pudo guardar esta comida.",
    "Could not update this meal.": "No se pudo actualizar esta comida.",
    "Could not remove this meal.": "No se pudo eliminar esta comida.",
    "Meal not found.": "Comida no encontrada.",
    "Meal not found": "Comida no encontrada.",
    "A meal can't be logged in the future.": "No se puede registrar una comida en el futuro.",
    "A meal can only be logged up to a year back.": "Solo se puede registrar una comida de hasta un año atrás.",
    "Could not load your favorite meals.": "No se pudieron cargar tus comidas favoritas.",
    "Could not save this favorite.": "No se pudo guardar este favorito.",
    "Could not update this favorite.": "No se pudo actualizar este favorito.",
    "Could not remove this favorite.": "No se pudo eliminar este favorito.",
    "Favorite not found.": "Favorito no encontrado.",
    "Favorite not found": "Favorito no encontrado.",
    "You already have a favorite with this name and meal type.": "Ya tienes un favorito con este nombre y tipo de comida.",
    "Meal recommendations are a Premium feature.": "Las recomendaciones de comidas son una función Premium.",
    "You've used today's refreshes. New suggestions come tomorrow.": "Has usado todas las actualizaciones de hoy. Mañana tendrás nuevas sugerencias.",
    "This suggestion was already added or dismissed.": "Esta sugerencia ya se añadió o se descartó.",
    "Recommendation not found": "Sugerencia no encontrada.",
    "Suggestion not found.": "Sugerencia no encontrada.",
    "Meal suggestions are not available right now.": "Las sugerencias de comidas no están disponibles ahora mismo.",
    # Premium
    "Could not read your profile. Please try again.": "No se pudo leer tu perfil. Inténtalo de nuevo.",
    "Could not read your subscription. Please try again.": "No se pudo leer tu suscripción. Inténtalo de nuevo.",
    "Could not activate premium. Please try again.": "No se pudo activar Premium. Inténtalo de nuevo.",
    "There is no active subscription to cancel": "No hay ninguna suscripción activa para cancelar.",
    "Could not check your Premium status. Please try again.": "No se pudo comprobar tu estado Premium. Inténtalo de nuevo.",
    "Warm-up recommendations are a Premium feature. Upgrade to Premium to unlock them.": "Las recomendaciones de calentamiento son una función Premium. Pásate a Premium para desbloquearlas.",
    "Custom exercises are a Premium feature.": "Los ejercicios personalizados son una función Premium.",
    # Workouts, routines, overtraining
    "Wait a moment before asking for another adjustment": "Espera un momento antes de pedir otro ajuste.",
    "Could not generate workout adjustment": "No se pudo generar el ajuste de entrenamiento.",
    "Could not load workout context": "No se pudo cargar el contexto del entrenamiento.",
    "Could not save daily workout plan": "No se pudo guardar el plan de entrenamiento de hoy.",
    "The AI returned an invalid workout plan": "La IA devolvió un plan de entrenamiento no válido.",
    "The AI selected an unavailable routine": "La IA seleccionó una rutina no disponible.",
    "The AI returned an invalid generated workout": "La IA devolvió un entrenamiento generado no válido.",
    "The AI returned exercises outside the available catalog": "La IA devolvió ejercicios fuera del catálogo disponible.",
    "The AI returned invalid generated set targets": "La IA devolvió objetivos de series no válidos.",
    "The AI returned a workout without a name": "La IA devolvió un entrenamiento sin nombre.",
    "The AI returned an invalid exercise plan": "La IA devolvió un plan de ejercicios no válido.",
    "Workout has no exercises to evaluate": "El entrenamiento no tiene ejercicios para evaluar.",
    "Workout exercises are missing IDs": "A los ejercicios del entrenamiento les faltan los identificadores.",
    "The AI returned invalid workout adjustments": "La IA devolvió ajustes de entrenamiento no válidos.",
    "The AI suggested a load that is not a reduction": "La IA sugirió una carga que no supone una reducción.",
    "The AI suggested reps that are not a reduction": "La IA sugirió repeticiones que no suponen una reducción.",
    "Custom exercise not found": "Ejercicio personalizado no encontrado.",
    "A routine cannot contain the same exercise more than once": "Una rutina no puede contener el mismo ejercicio más de una vez.",
    "One or more selected exercises are unavailable": "Uno o más ejercicios seleccionados no están disponibles.",
    "Could not save this routine.": "No se pudo guardar esta rutina.",
    "Routine not found": "Rutina no encontrada.",
    "Could not update this routine.": "No se pudo actualizar esta rutina.",
    "Workout plan not found": "Plan de entrenamiento no encontrado.",
    "Could not save workout history": "No se pudo guardar el historial de entrenamiento.",
    "Workout history entry not found": "Registro de entrenamiento no encontrado.",
    "Could not update workout history": "No se pudo actualizar el historial de entrenamiento.",
    "Could not delete workout history entry": "No se pudo eliminar el registro de entrenamiento.",
    "Could not save recovery check-in": "No se pudo guardar el registro de recuperación.",
    "Recovery check-in not found": "Registro de recuperación no encontrado.",
    "Could not delete recovery check-in": "No se pudo eliminar el registro de recuperación.",
    "Could not update today's workout plan": "No se pudo actualizar el plan de entrenamiento de hoy.",
    # Schema validation errors
    "Each set must have between 1 and 30 reps": "Cada serie debe tener entre 1 y 30 repeticiones.",
    "Reps count must match target_sets": "El número de repeticiones debe coincidir con el número de series.",
    "A workout cannot end before it starts": "Un entrenamiento no puede terminar antes de empezar.",
    "Workout dates are out of range": "Las fechas del entrenamiento están fuera de rango.",
    "Join the Community first.": "Únete antes a la Comunidad.",
    "That username is taken.": "Ese nombre de usuario ya está en uso.",
    "You can change your username once every 30 days.": "Puedes cambiar tu nombre de usuario una vez cada 30 días.",
    "Daily limit reached. Try again tomorrow.": "Has alcanzado el límite diario. Inténtalo mañana.",
    "That card is not valid.": "Esa tarjeta no es válida.",
    "That is not a personal record.": "Eso no es un récord personal.",
    "Log meals 7 days in a row to share a streak.": "Registra comidas 7 días seguidos para compartir una racha.",
    "The Community is not available right now.": "La Comunidad no está disponible ahora mismo.",
    "Something went wrong. Try again.": "Algo ha fallado. Inténtalo de nuevo.",
    "Not found.": "No encontrado.",
    "You already joined the Community.": "Ya te has unido a la Comunidad.",
    "That text contains characters that are not allowed.": "Ese texto contiene caracteres no permitidos.",
    "Keep it to 280 characters.": "No pases de 280 caracteres.",
    "Usernames use 3 to 20 letters, numbers or underscores.": "Los nombres de usuario usan de 3 a 20 letras, números o guiones bajos.",
    "That username is reserved.": "Ese nombre de usuario está reservado.",
    "Search with 2 to 40 letters or numbers.": "Busca con 2 a 40 letras o números.",
    "A post can have up to 4 photos.": "Una publicación admite hasta 4 fotos.",
    "Write something, add a photo or attach a card.": "Escribe algo, añade una foto o adjunta una tarjeta.",
    "Write a comment first.": "Escribe antes un comentario.",
    "You cannot follow yourself.": "No puedes seguirte a ti mismo.",
    "You cannot block yourself.": "No puedes bloquearte a ti mismo.",
    "You follow too many people. Unfollow someone first.": "Sigues a demasiadas personas. Deja de seguir a alguien.",
    "You have blocked too many people.": "Has bloqueado a demasiadas personas.",
}

_ERROR_PATTERNS_ES: tuple[tuple[re.Pattern[str], Any], ...] = (
    (
        re.compile(r"^Exercise '(.+)' not found$"),
        lambda m: f"No se encontró el ejercicio «{m.group(1)}».",
    ),
    (
        re.compile(r"^Unknown exercise '(.+)'$"),
        lambda m: f"Ejercicio desconocido: «{m.group(1)}».",
    ),
    (
        re.compile(r'^The name is already in use by "(.+)"\.$'),
        lambda m: f'Ese nombre ya está en uso por "{m.group(1)}".',
    ),
    (
        re.compile(r"^You can have up to (\d+) custom exercises\.$"),
        lambda m: f"Puedes tener hasta {m.group(1)} ejercicios personalizados.",
    ),
    (
        re.compile(r"^You can save up to (\d+) favorite meals\.$"),
        lambda m: f"Puedes guardar hasta {m.group(1)} comidas favoritas.",
    ),
    (
        re.compile(r"^User profile is missing: (.+)$"),
        lambda m: "Faltan datos en tu perfil: "
        + ", ".join(_FIELD_NAMES_ES.get(part.strip(), part.strip()) for part in m.group(1).split(","))
        + ".",
    ),
    (
        re.compile(r"^Could not delete routine: .+$"),
        lambda _m: "No se pudo eliminar la rutina.",
    ),
    (
        re.compile(r"^A single entry can't exceed (\d+(?:\.\d+)?) (\w+)\.$"),
        lambda m: f"Un solo registro no puede superar {m.group(1)} {m.group(2)}.",
    ),
)

_STORED_PLAN_EXACT_ES: dict[str, str] = {
    "Rest day": "Día de descanso",
    "Active Recovery & Rest": "Recuperación activa y descanso",
    "Today's workout": "Entrenamiento de hoy",
    "Swapped to a recovery rest day based on your readiness check.": "Cambiado a un día de descanso y recuperación según tu evaluación de disponibilidad.",
    "Every major muscle group was trained in the last 48 hours. Today is a rest day.": "Todos los grupos musculares principales se entrenaron en las últimas 48 horas. Hoy es día de descanso.",
    "Every muscle group was trained in the last 48 hours. Today is a rest day.": "Todos los grupos musculares se entrenaron en las últimas 48 horas. Hoy es día de descanso.",
}

_DELOAD_NOTE_RE = re.compile(
    r"Deload(?: week)? active: volume and load reduced by (\d+)%, target RPE capped at 6\."
)


def parse_accept_language(header: str | None) -> str:
    """Resolve an HTTP Accept-Language header to 'en' or 'es', defaulting to 'en'."""
    if not header:
        return DEFAULT_LANGUAGE
    candidates: list[tuple[float, int, str]] = []
    for index, raw_part in enumerate(header.split(",")):
        part = raw_part.strip()
        if not part:
            continue
        pieces = [piece.strip() for piece in part.split(";")]
        tag = pieces[0].lower()
        primary = tag.split("-", 1)[0]
        if primary not in SUPPORTED_LANGUAGES:
            continue
        quality = 1.0
        for param in pieces[1:]:
            if param.lower().startswith("q="):
                try:
                    quality = float(param[2:].strip())
                except ValueError:
                    quality = 0.0
                break
        if quality > 0:
            candidates.append((quality, -index, primary))
    if not candidates:
        return DEFAULT_LANGUAGE
    candidates.sort(reverse=True)
    return candidates[0][2]


def normalize_language(lang: str | None) -> str:
    if not lang:
        return DEFAULT_LANGUAGE
    primary = lang.strip().lower().split("-", 1)[0]
    return primary if primary in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


def get_language() -> str:
    return _language.get()


def set_language(lang: str | None) -> Token[str]:
    return _language.set(normalize_language(lang))


def reset_language(token: Token[str]) -> None:
    _language.reset(token)


@contextmanager
def use_language(lang: str | None) -> Iterator[str]:
    resolved = normalize_language(lang)
    token = _language.set(resolved)
    try:
        yield resolved
    finally:
        _language.reset(token)


def pick(en: str, es: str, lang: str | None = None) -> str:
    active = normalize_language(lang) if lang is not None else get_language()
    return es if active == "es" else en


def translate_muscle(muscle: str, lang: str | None = None) -> str:
    active = normalize_language(lang) if lang is not None else get_language()
    if active != "es":
        return muscle
    return _MUSCLES_ES.get(muscle.strip().lower(), muscle)


def translate_objective(objective: str, lang: str | None = None) -> str:
    active = normalize_language(lang) if lang is not None else get_language()
    if active != "es":
        return objective
    return _OBJECTIVES_ES.get(objective.strip().lower(), objective)


def template_label(template: str, fallback: str, lang: str | None = None) -> str:
    active = normalize_language(lang) if lang is not None else get_language()
    if active == "es":
        return _TEMPLATE_LABELS_ES.get(template, fallback)
    return fallback


def format_short_date(value: date, lang: str | None = None, *, with_weekday: bool = False) -> str:
    active = normalize_language(lang) if lang is not None else get_language()
    if active != "es":
        return value.strftime("%a, %b %d") if with_weekday else value.strftime("%b %d")
    month = _ES_MONTHS[value.month]
    if with_weekday:
        weekday = _ES_WEEKDAYS[value.weekday()]
        return f"{weekday}, {value.day} {month}"
    return f"{value.day} {month}"


def translate_error_detail(detail: Any, lang: str | None = None) -> Any:
    """Translate known English HTTPException/validation strings into Spanish when active."""
    active = normalize_language(lang) if lang is not None else get_language()
    if active != "es" or not isinstance(detail, str):
        return detail
    if detail in _ERROR_EXACT_ES:
        return _ERROR_EXACT_ES[detail]
    stripped = detail.removeprefix("Value error, ")
    if stripped in _ERROR_EXACT_ES:
        return _ERROR_EXACT_ES[stripped]
    for pattern, formatter in _ERROR_PATTERNS_ES:
        match = pattern.match(stripped)
        if match:
            return formatter(match)
    return detail


def translate_stored_plan_text(text: str | None, lang: str | None = None) -> str | None:
    """Translate known rule-written stored workout plan titles/notes when reading in Spanish."""
    if not text:
        return text
    active = normalize_language(lang) if lang is not None else get_language()
    if active != "es":
        return text
    if text in _STORED_PLAN_EXACT_ES:
        return _STORED_PLAN_EXACT_ES[text]
    return _DELOAD_NOTE_RE.sub(
        lambda m: f"Semana de descarga activa: volumen y carga reducidos un {m.group(1)} %, RPE objetivo limitado a 6.",
        text,
    )
