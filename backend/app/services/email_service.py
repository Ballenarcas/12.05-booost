"""Outgoing email through Resend's HTTP API."""

import logging
from html import escape

import httpx

from app.core.config import get_settings
from app.core.i18n import get_language, normalize_language

logger = logging.getLogger(__name__)

RESEND_URL = "https://api.resend.com/emails"


def send_password_reset_email(to: str, link: str, lang: str | None = None) -> None:
    """Send the reset link. Never raises: the caller already answered the user."""
    settings = get_settings()
    if not settings.resend_api_key or not settings.email_from:
        # Never log the link: it works as a password for 30 minutes.
        log = logger.error if settings.is_production else logger.warning
        log("Password reset email not sent: RESEND_API_KEY or EMAIL_FROM is not configured.")
        return

    active_lang = normalize_language(lang) if lang is not None else get_language()
    if active_lang == "es":
        subject = "Restablece tu contraseña de BOOOST"
        text = (
            "Alguien ha solicitado restablecer la contraseña de tu cuenta de BOOOST.\n\n"
            f"Crea una contraseña nueva aquí (el enlace funciona una sola vez, durante 30 minutos):\n{link}\n\n"
            "Si no has sido tú, ignora este correo. Tu contraseña seguirá siendo la misma."
        )
        html = (
            "<p>Alguien ha solicitado restablecer la contraseña de tu cuenta de BOOOST.</p>"
            f'<p><a href="{escape(link)}">Crear una contraseña nueva</a></p>'
            "<p>El enlace funciona una sola vez, durante 30 minutos. Si no has sido tú, ignora este correo. "
            "Tu contraseña seguirá siendo la misma.</p>"
        )
    else:
        subject = "Reset your BOOOST password"
        text = (
            "Someone asked to reset the password of your BOOOST account.\n\n"
            f"Set a new password here (the link works once, for 30 minutes):\n{link}\n\n"
            "If it wasn't you, ignore this email. Your password stays the same."
        )
        html = (
            "<p>Someone asked to reset the password of your BOOOST account.</p>"
            f'<p><a href="{escape(link)}">Set a new password</a></p>'
            "<p>The link works once, for 30 minutes. If it wasn't you, ignore this email. "
            "Your password stays the same.</p>"
        )
    try:
        response = httpx.post(
            RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.email_from,
                "to": [to],
                "subject": subject,
                "text": text,
                "html": html,
            },
            timeout=10,
        )
    except httpx.HTTPError as err:
        logger.error("Password reset email failed: %s", err)
        return
    if response.is_error:
        # Resend explains the refusal in the body (e.g. an unverified domain); it never contains the key.
        logger.error("Password reset email refused by Resend (%s): %s", response.status_code, response.text[:300])
