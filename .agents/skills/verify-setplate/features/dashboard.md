# Dashboard and daily plan

## Sub-features

- **Header**: Greeting (`Hello, <name>`), formatted local date badge (`.date-badge`), and `Go Premium` upsell button (`button.premium-upsell-button`, hidden when `isPremiumActive()` is true).
- **AI Trainer (`AiTipCard`)**: Active rule-driven coaching card backed by `GET /api/v1/ai/tips/current` (not a static string from `/dashboard/summary`, where `ai_notification` is `null`). Persists shown tips in `ai_tips`, offers `Accept`, `Dismiss`, `Why this tip?` dialog (`#ai-tip-why-title`), and an 8-second `Undo` bar after accepting. For Premium users when `AI_TIPS_MODEL_ENABLED=true`, an LLM may reword a tip once per `state_key` change (max 8/day), gated by `is_safe_wording`.
- **Daily activity (Health Connect)**: `section[aria-labelledby="daily-activity"]` displays today's steps, active kcal, 7-day averages (plus browser preview note when applicable) when connected, or a `Connect in Settings` CTA (`/settings`) when disconnected.
- **Nutrition summary**: `section[aria-labelledby="nutrition-summary"]` shows remaining kcals (including accepted `add_kcal` tip bonuses), calorie progress bar, Protein/Carbs/Fat macro cards, and two action buttons: `Manual Register` (`/log-meals`) and `Scan plate PRO` (`/scan-meal` if Premium, else `/premium`).
- **Daily hydration (`HydrationCard`)**: `section[aria-labelledby="hydration-summary"]` tracks today's water intake, goal editing, and links to `/hydration/history` (see [Hydration tracking and history](hydration.md)).
- **Programmed training & auto-planning**: `section[aria-labelledby="programmed-training"]` shows `Workout completed today`, `Rest day`, a planned session (`AI generated` or `AI adjusted` badge, `ul.scheduled-exercises` with `N sets · M reps`, optional reasoning, and `START WORKOUT`), or `No workout scheduled for today.`. If both `plan` and `completed_workout_today` are null on mount, Home automatically calls `POST /api/v1/workouts/plan-today` (which calls the configured OpenAI-compatible LLM unless every major muscle group was trained in the last 48h).

## How to get to it (user POV)

Sign in and land on `/`. Home is the first item in the bottom dock (`nav[aria-label="Primary navigation"] button[aria-label="Home"]`).

## Driving it with Chrome DevTools

Read the doctor output first:

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/verify-setplate/scripts/doctor.ps1
```

- `doctor.ps1` logs in, sends `Authorization: Bearer <access_token>` plus local-day query params (`today`, `today_start`, `today_end`) to `GET /api/v1/dashboard/summary`, and reports `has_plan_today`, `completed_workout_today`, `home_safe`, and `is_premium`.
- `home_safe: true` means `has_plan_today` or `completed_workout_today` is set. Navigating `/` will not call `POST /api/v1/workouts/plan-today`.
- `home_safe: false` means Home will auto-plan via `POST /api/v1/workouts/plan-today` (calling the configured LLM). Do not open `/` until a plan or completed workout exists today (for example, while a temporary verification workout is saved before cleanup) or LLM spending is explicitly allowed.

When safe, log in, navigate `/`, and wait for `h1` containing `Hello,`, `.ai-tip[aria-busy="false"]`, and `.hydration-card`. Assert:

- `section[aria-labelledby="trainer-insight"]` renders `.ai-tip`; if `button[aria-label="Why this tip?"]` is present, click it, assert `#ai-tip-why-title` opens, and close via `Got it` (read-only; avoids mutating `ai_tips` decisions).
- `section[aria-labelledby="daily-activity"]` renders `.activity-card` (stats or `Connect in Settings`).
- `section[aria-labelledby="nutrition-summary"]` shows `[role="progressbar"][aria-label="Daily calorie progress"]`, 3 `.macro` entries, `Manual Register`, and `Scan plate`.
- `section[aria-labelledby="hydration-summary"]` renders `.hydration-card`.
- `section[aria-labelledby="programmed-training"]` shows `Workout completed today`, `Rest day`, a plan title (with `ul.scheduled-exercises` for non-rest plans), or `No workout scheduled for today.`.
- Network log confirms zero `POST /api/v1/workouts/plan-today` requests fired.

## Gotchas

- Home requires both `set_plate_user` (for `ProtectedLayout`) and `set_plate_session` (Bearer token for `/dashboard/summary`, `/ai/tips/current`, and `/hydration/today`) in `localStorage`.
- The dashboard summary is cached in `sessionStorage` for 30 seconds under `set_plate_dashboard:<user_id>`. Accepting/undoing an AI tip or calling `fetchDashboardSummary({ forceRefresh: true })` bypasses it.
- `GET /api/v1/ai/tips/current` writes a row to `ai_tips` when a new tip is first generated for the user's current `state_key`, and on Premium accounts may invoke the tip-wording model if `AI_TIPS_MODEL_ENABLED=true`.
- A rest day is a valid plan (`is_rest_day: true`) with no `ul.scheduled-exercises`.
- The plan title can be a routine name, an AI-generated title, `Rest day`, or `Workout completed today`. Match the section (`section[aria-labelledby="programmed-training"]`), not a hardcoded title.
