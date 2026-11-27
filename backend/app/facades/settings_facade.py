from app.db.supabase_client import get_supabase
from app.schemas.settings import UserSettingsUpdate
from app.services.muscle_focus import get_muscle_focus, set_muscle_focus
from app.services.settings_service import update_user_settings_db


def _session():
    client = get_supabase(admin=True)
    if client is None:
        raise RuntimeError("Database connection unavailable")
    return client


class SettingsFacade:
    def update(self, user_id: str, settings: UserSettingsUpdate):
        return update_user_settings_db(user_id, settings)

    def muscle_focus(self, user_id: str) -> str | None:
        return get_muscle_focus(_session(), user_id)

    def set_muscle_focus(self, user_id: str, muscle: str | None) -> None:
        set_muscle_focus(_session(), user_id, muscle)


settings_facade = SettingsFacade()
