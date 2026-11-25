# BOOOST feature map

Primary surface: the React web UI at `http://localhost:5173`. Secondary surface: the FastAPI JSON API at `http://127.0.0.1:8000/api/v1`.

Read `../SKILL.md` first. Every journey uses the bundled Chrome DevTools harness and the account in `.env.verify`. Authenticated API calls require `Authorization: Bearer <token>` from `localStorage['booost_session']` alongside the profile in `localStorage['booost_user']`.

| Feature | Entry point | Writes | LLM / AI call | Automated today |
| --- | --- | --- | --- | --- |
| [Exercise search](exercise-search.md) | `SelectExerciseModal`, `/workouts/active/exercises`, `/exercises/:id/guide`, `/exercises/custom` | Custom exercises only | No | Catalog picker covered by `proof` |
| [Dashboard and daily plan](dashboard.md) | `/` | `workout_plans` (when auto-planning), `ai_tips` (on tip load/decision) | Auto-plan if `home_safe` is false; optional Premium tip wording when `AI_TIPS_MODEL_ENABLED=true` | No, guarded |
| [Hydration tracking and history](hydration.md) | Home / Nutrition hydration card, `/hydration/history` | `hydration_logs`, `users.hydration_goal_ml`, `hydration_goal_history` | No | No, cleanup required |
| [Workout session](workout-session.md) | `/workouts`, `/workouts/active`, `/workouts/create`, `/workouts/statistics`, `/overtraining-alerts` | `workouts`, `workout_sets`, `routines`, `routine_exercises` | Only if AI adjustment or Premium Warm-up is pressed | No, cleanup required |
| [Meal logging and nutrition](meal-logging.md) | `/log-meals`, `/nutrition`, `/scan-meal` | `meals`, `meal_ingredients`, `favorite_meals`, `meal_recommendations` | Only on Premium `Suggestions` or `/scan-meal` photo upload | No, cleanup required |
| [Settings and auth](settings-and-auth.md) | `/welcome`, `/login`, `/forgot-password`, `/reset-password`, `/onboarding`, `/settings`, `/premium`, `/faq` | `users`, `password_resets`, `health_connections`, `health_activity`, `subscriptions` | No | Login is covered by `proof` |

## Evidence standard

- Drive the real UI and the real backend. No route interception, test-only endpoints, or `localStorage` injection.
- Capture the action and the resulting state. Compare rendered data with the network payload when the feature is data-driven.
- For write journeys, capture the created id and delete the row through the app before cleanup.
- Never trigger paid LLM calls during routine verification (skip auto-plan when `home_safe: false`, Active Workout AI adjustment and Warm-up, Nutrition `Suggestions`, and `/scan-meal` uploads) and state what was skipped.
- Keep artifacts under `../evidence/<UTC timestamp>/`. They survive cleanup and are gitignored.

## Seed data

There is no local seed. The backend reads the 1,324-exercise catalog from `backend/app/data/exercises_catalog.json` (plus rule-based guides from `exercise_guides.json` / `exercise_staples.json`) and persists users, routines, meals, hydration logs, tips, and workouts in the shared Supabase project. The verification account supplies the user context. If a journey needs data the account does not have, report the precondition as a failure and add it to that feature's Gotchas instead of weakening the journey.
