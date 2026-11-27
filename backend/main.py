import logging
import threading
from contextlib import asynccontextmanager

import httpx
from fastapi import APIRouter, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import ai, ai_chat, dashboard, health_connect, hydration, nutrition, premium, routines, users, workouts
from app.core.config import get_settings
from app.core.i18n import parse_accept_language, pick, reset_language, set_language, translate_error_detail
from app.api.settings import router as settings_router
from app.db.supabase_client import warm_supabase

settings = get_settings()
logger = logging.getLogger(__name__)

if "*" in settings.cors_origin_list:
    raise RuntimeError("CORS_ORIGINS must list explicit origins; '*' is not allowed.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=warm_supabase, daemon=True).start()
    yield


app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None,
    openapi_url=None if settings.is_production else "/openapi.json",
)

if settings.allowed_hosts_list:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts_list)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept-Language"],
    expose_headers=["WWW-Authenticate", "X-Session-Token"],
    max_age=600,
)


@app.middleware("http")
async def language_middleware(request: Request, call_next):
    token = set_language(parse_accept_language(request.headers.get("accept-language")))
    try:
        return await call_next(request)
    finally:
        reset_language(token)


@app.exception_handler(StarletteHTTPException)
async def localized_http_exception(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": translate_error_detail(exc.detail)},
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def localized_validation_exception(_request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = []
    for item in exc.errors():
        localized = dict(item)
        if isinstance(localized.get("msg"), str):
            localized["msg"] = translate_error_detail(localized["msg"])
        errors.append(localized)
    # jsonable_encoder like FastAPI's own handler: custom validators put exception objects in "ctx".
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


@app.exception_handler(httpx.ConnectError)
async def database_unreachable(_request, _exc) -> JSONResponse:
    logger.warning("Database connection failed")
    return JSONResponse(
        status_code=503,
        content={
            "detail": pick(
                "Could not reach the database. Check your network and try again.",
                "No se pudo conectar con la base de datos. Comprueba tu conexión e inténtalo de nuevo.",
            )
        },
    )


@app.exception_handler(httpx.TimeoutException)
async def database_timeout(_request, _exc) -> JSONResponse:
    logger.warning("Database request timed out")
    return JSONResponse(
        status_code=503,
        content={
            "detail": pick(
                "The database took too long to answer. Try again.",
                "La base de datos tardó demasiado en responder. Inténtalo de nuevo.",
            )
        },
    )


@app.get("/")
def root() -> dict[str, str]:
    return {"status": "ok", "message": f"{settings.app_name} is running"}


api_router = APIRouter(prefix="/api/v1")


@app.get("/health", include_in_schema=False)
@api_router.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


api_router.include_router(users.router)
api_router.include_router(workouts.router)
api_router.include_router(routines.router)
api_router.include_router(nutrition.router)
api_router.include_router(ai.router)
api_router.include_router(ai_chat.router)
api_router.include_router(dashboard.router)
api_router.include_router(hydration.router)
api_router.include_router(health_connect.router)
api_router.include_router(settings_router)
api_router.include_router(premium.router)
app.include_router(api_router)
