# Workout session

## Sub-features

- **Workouts hub (`/workouts`)**: Displays the client-side `OvertrainingBanner` (and active AI Deload `-15%` banner if enabled), **Workout history** (`#workout-history-title`, latest 3 + `See N more`, with `Statistics`, Edit, Delete confirmation modal, and `REPEAT WORKOUT`), **Saved routines** (`#saved-routines-title`, latest 3 + `See N more`, with `Create Routine` -> `/workouts/create`, Edit, Delete, and `START WORKOUT`), and `Start empty workout` (which opens `Discard ongoing workout?` if an active session already exists in `localStorage`).
- **Active workout (`/workouts/active`)**: Starts from `/workouts` (routine, empty, repeat, or edit-history), from the Home dashboard plan card, or by resuming `localStorage['set_plate_active_workout']` (also surfaced by `WorkoutInProgressBar` across other protected screens).
  - Add or replace exercises via `SelectExerciseModal` (in-place modal with search, muscle-group filter, and custom exercises).
  - Exercise card menu (`...`): `How to do it` (`/exercises/:id/guide`), `Move up`, `Move down`, `Replace exercise`, and `Remove exercise`.
  - Strength sets: weight, reps (`type="text"` controlled numeric inputs), RPE, set kind (`normal|warmup|drop|failure`), completion toggle, swipe/keyboard set delete with a **2.8-second** undo banner (no confirmation dialog), and an opt-in per-exercise rest timer (`button.rest-toggle`, off by default).
  - Cardio blocks: stopwatch timer or manual duration/distance entry with pace display.
  - Header AI actions (**do not press during routine checks**): **Warm-up** (`button[aria-label="Recommend a warm-up"]`, Premium-gated LLM call to `POST /api/v1/workouts/warmup`) and **AI** live adjustment (`button[aria-label="Ask AI for adjustments"]`, LLM call to `POST /api/v1/workouts/adjust` with 60s per-user cooldown and 8s undo).
  - Finish dialog (`button.finish-button`): requires a workout name (`#completed-workout-name`), a mandatory 1–10 fatigue rating (`button.fatigue-scale-button`), and at least one completed strength set or cardio block (for new workouts) before `SAVE WORKOUT` enables; `Discard workout` requires a second confirmation tap (`Tap again to discard`).
- **Companion routes**:
  - Routine builder: `/workouts/create` (`CreateRoutine.tsx`, writes to `routines` + `routine_exercises`).
  - Workout statistics: `/workouts/statistics` (`WorkoutStatistics.tsx`, `1W`/`1M`/`3M` ranges, volume progression, muscle distribution, and all-time fatigue history via `GET /api/v1/workouts/statistics`).
  - Overtraining alerts: `/overtraining-alerts` (`OvertrainingAlerts.tsx`, client-side workload evaluation + `localStorage` recovery check-ins and `-15%` deload toggle; no backend overtraining routes are mounted).

## How to get to it (user POV)

1. Sign in and open Workouts in the bottom dock (`nav[aria-label="Primary navigation"] button[aria-label="Workouts"]`).
2. Press `START WORKOUT` on a routine or `Start empty workout`.
3. Add an exercise (if empty) via `Add Exercise` (`SelectExerciseModal`), log weight/reps, and mark sets complete.
4. Press `Finish`, enter a workout name, choose a 1–10 fatigue rating, and press `SAVE WORKOUT`.

The dashboard plan card also starts `/workouts/active`. Direct navigation to `/workouts/active` requires router state or `localStorage['set_plate_active_workout']`; otherwise it renders `<div className="screen state-card" role="alert">No active workout selected.</div>`.

## Driving it with Chrome DevTools

This journey writes rows to `workouts` and `workout_sets`. Plan the cleanup before starting.

1. Ensure clean active state (`localStorage.removeItem('set_plate_active_workout')`), open `/workouts`, and assert `#workout-history-title` and `#saved-routines-title` render.
2. Click `button.secondary-action` with text `Start empty workout` (or a routine's `START WORKOUT`).
3. On `/workouts/active`, if starting empty, click `button.add-exercise-button` (`Add Exercise`), wait for `SelectExerciseModal` (`input[placeholder="Search exercises..."]`), filter if desired, and click `button[aria-label^="Add "]` on a strength exercise. Wait for `.exercise-card`.
4. To verify the rest timer, click `button.rest-toggle` (`aria-pressed="true"`).
5. Fill `input[aria-label$="set 1 weight"]` (e.g. `40`) and `input[aria-label$="set 1 reps"]` (e.g. `8`, must be `> 0`) using the native value setter + `input` event.
6. Click `button[aria-label="Toggle set 1"]`. Assert `aria-pressed="true"` and `.rest-bar` appears.
7. Click `button.finish-button`. In `div[role="dialog"][aria-labelledby="finish-title"]`, verify `SAVE WORKOUT` is disabled before choosing fatigue, fill `#completed-workout-name` with `Verification Session`, click `button.fatigue-scale-button[aria-label="5 of 10, Solid"]`, then click `SAVE WORKOUT`.
8. Capture the `200` `POST /api/v1/workouts/logs` response `id`, assert redirect to `/workouts`, `localStorage.getItem('set_plate_active_workout') === null`, and `Verification Session` visible in Workout history.
9. Optional read-only checks: visit `/workouts/statistics` (assert `GET /api/v1/workouts/statistics` returns `200`) and `/overtraining-alerts` (assert `OVERTRAINING ALERTS` renders; do not submit check-ins or apply deload mods).
10. Cleanup: on `/workouts`, click `button[aria-label="Delete Verification Session workout"]`, confirm `Delete workout` inside `#delete-workout-title`, and assert `DELETE /api/v1/workouts/history/<id>` returns `200`. Fallback API cleanup requires `Authorization: Bearer <localStorage['set_plate_session']>` on `DELETE /api/v1/workouts/history/<id>`.

Never press `button[aria-label="Ask AI for adjustments"]` or `button[aria-label="Recommend a warm-up"]` during routine runs — both invoke the configured LLM.

## Gotchas

- The active session persists in **`localStorage`** under `set_plate_active_workout` (not `sessionStorage`). `Discard ongoing workout?` on `/workouts` fires for `Start empty workout` when a leftover session exists.
- An empty workout has zero exercises (`exercises: []`), so no `Add Set` button exists until you add an exercise via `SelectExerciseModal`.
- Completing a set requires `reps > 0`; otherwise the UI shows `Enter your reps to complete this set.`. The rest timer only starts if `button.rest-toggle` was enabled on that exercise.
- `SAVE WORKOUT` stays disabled until a 1–10 fatigue rating is selected AND (for new workouts) at least one set or cardio block is completed.
- All `/api/v1/workouts/*` and `/api/v1/routines/*` write/history endpoints authenticate via `Authorization: Bearer <token>` (`set_plate_session`); the `user_id` query parameter is ignored by the backend.
- Weight and reps inputs (`SetNumberInput`) are controlled `type="text"` inputs; set them with `HTMLInputElement.prototype.value` setter + `input` event.
- Overtraining state is stored client-side in `localStorage` (`set_plate_recovery_checkins_<userId>`, `set_plate_overtraining_state_<userId>`, `set_plate_overtraining_mod_pct`); do not toggle deload mods on the shared browser profile unless you clear them afterward.
