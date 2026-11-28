from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "BOOOST API"
    supabase_url: str = ""
    supabase_key: str = ""
    supabase_service_role_key: str = ""
    # Any OpenAI-compatible chat API (Groq, OpenAI, OpenRouter, Gemini, Ollama...): one key for every AI feature.
    ai_base_url: str = "https://api.groq.com/openai/v1"
    ai_api_key: str = ""
    ai_model: str = "openai/gpt-oss-20b"
    ai_tips_model: str = "openai/gpt-oss-120b"
    ai_tips_model_enabled: bool = False
    # Photo meal scanning needs an image-capable model. It may use a different
    # OpenAI-compatible provider from the text model, so the keys are separate.
    ai_vision_model: str = ""
    ai_vision_base_url: str = ""
    ai_vision_api_key: str = ""
    cors_origins: str = "http://localhost:5173"

    # Session signing. Falls back to the Supabase service-role key when no
    # dedicated secret is configured, so existing deployments keep working;
    # ``AUTH_SECRET_KEY`` is preferred and should be set in production.
    auth_secret_key: str = ""
    auth_token_ttl_hours: int = 24 * 30  # renewed while in use

    # Password reset emails go through Resend. Without a key, no email is sent.
    resend_api_key: str = ""
    # Sender on a domain verified in Resend, e.g. "BOOOST <no-reply@your-domain.com>".
    email_from: str = ""
    # Public address of the frontend, used to build the reset link.
    app_url: str = "http://localhost:5173"

    environment: str = "development"
    allowed_hosts: str = ""

    model_config = SettingsConfigDict(
        env_file=("../.env", ".env", "backend/.env"),
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def allowed_hosts_list(self) -> list[str]:
        hosts = [host.strip() for host in self.allowed_hosts.split(",") if host.strip()]
        if not hosts:
            return hosts
        # The container HEALTHCHECK calls /health on 127.0.0.1, and the Host
        # header it sends is validated by the same middleware. If loopback is
        # missing the check gets 400, the backend stays unhealthy and
        # ``depends_on: service_healthy`` keeps the frontend from starting,
        # which the tunnel surfaces as a bare 502.
        for loopback in ("127.0.0.1", "localhost"):
            if loopback not in hosts:
                hosts.append(loopback)
        return hosts

    @property
    def is_production(self) -> bool:
        return self.environment.strip().lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
