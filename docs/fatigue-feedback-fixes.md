# Fatigue feedback: fixes for next sprint

Review date: 2026-11-19. Nothing below has been changed yet.

## How it works today

There are two separate fatigue systems.

| | Post-workout fatigue | Recovery check-in and overtraining alert |
|---|---|---|
| Where the user sees it | 1–10 scale when saving a workout (`frontend/src/pages/ActiveWorkout.tsx`) | `/overtraining-alerts` (`frontend/src/pages/OvertrainingAlerts.tsx`) and the banner in `frontend/src/components/workout/OvertrainingBanner.tsx` |
| Where it's stored | `public.workouts.fatigue_level` in Supabase | Browser `localStorage` only |
| What it changes | Tomorrow's calories (`calorie_adjustment_service.py`, up to +200 kcal above 5) and one set fewer in the AI plan (`workout_adjustment_service.py`, `FATIGUE_HIGH = 6`), using only workouts from the last 3 days | Shows an alert. "Apply deload" cuts sets and weight by 15% in `Workouts.tsx`, on that device only |
| Status | Works | Broken in the ways listed below |

The backend already has an overtraining service (`backend/app/services/overtraining_service.py`, with facade methods in `workout_facade.py` and schemas in `schemas/overtraining.py`), but **no API routes** expose it. The frontend calls in `services/api.ts` (`fetchOvertrainingAlerts`, `submitFatigueFeedback`, `applyOvertrainingMods`, `dismissOvertrainingAlert`) are never used and would return 404 if they were.

## Fixes

Ordered by priority. P1 items are quick and frontend-only.

### P1: Misleading wording (safety)

- **Problem:** the alert text says "heart rate variability", "HRV and CNS readiness are suppressed" and "CRITICAL ALERT: Overtraining Risk High". The app never measures HRV, and every alert is set to `risk_level: 'high'`. This reads like a diagnosis, which AGENTS.md forbids.
- **Where:** `OvertrainingAlerts.tsx` `computePhysiologicalStatus`, the `describeScale` text ("suppressed HRV"), and the same strings in `overtraining_service.py` `evaluate_overtraining`.
- **Fix:**
  - Remove every HRV and CNS claim.
  - Use "moderate" when only one condition is met and "high" only when training load and poor recovery happen together.
  - Change the tone from "CRITICAL ALERT" to plain advice, for example "Your recent training and check-ins suggest you need more recovery."
- **Done when:** nothing in the UI or the backend strings mentions HRV, CNS or "critical", and risk levels follow the rule above.

### P1: Made-up numbers

- **Problem:**
  - "X% above recommended recovery levels" is invented: it's set to 35% when there's no data, and to an estimate based on 60 sets otherwise.
  - "Chest/shoulders" is shown when nobody reported any sore muscles.
  - The backend falls back to `["Chest", "Shoulders"]` in the same way.
- **Where:** `displayLoadPct`, `musclesLabel` and `strained_muscles` in `OvertrainingAlerts.tsx`; `display_pct`, `muscles_label` and `strained_muscles or [...]` in `overtraining_service.py`.
- **Fix:**
  - Show the real counts: sessions, completed sets, and sets at RPE 8.5 or higher.
  - Show a percentage only when there's a previous week to compare with.
  - Leave out the muscles line when there are no sore muscles.
- **Done when:** every number on the page can be traced back to the user's own data.

### P1: Check-in form starts pre-filled

- **Problem:**
  - The form opens at fatigue 8, soreness 8, poor sleep, mild joint pain, and chest and shoulders selected, so submitting without touching anything logs a high-fatigue report.
  - If the user leaves the muscles empty, it saves Chest and Shoulders anyway.
- **Where:** the `useState` defaults in `OvertrainingAlerts.tsx` and `muscles: selectedMuscles.length > 0 ? ... : ['Chest', 'Shoulders']` in `handleSubmitCheckIn`.
- **Fix:**
  - Start with no choice selected, and disable Submit until fatigue and soreness are both chosen.
  - Save an empty list when no muscle is selected.
- **Done when:** an untouched form can't be submitted, and no muscle is saved that the user didn't pick.

### P1: Sharp joint pain is just a number

- **Problem:** "Noticeable joint strain" only adds 2 points to the soreness score.
- **Fix:** when it's picked, show a fixed message: stop loading that joint, and check with a professional if it doesn't go away. Never suggest training through it.
- **Done when:** choosing sharp joint pain always shows that message.

### P2: Sets counted as done when they weren't

- **Problem:** a set counts as done if it has any reps or weight, even when it was never ticked (`isDone` in `computePhysiologicalStatus`).
- **Fix:** count only `is_completed === true`, as the backend does.
- **Done when:** sets that weren't ticked don't count towards the totals.

### P2: Check-ins are stored only in the browser

- **Problem:**
  - Check-ins and the dismiss and deload state live in `localStorage`. They're lost when the user clears the browser or changes device.
  - The AI planner never sees them.
  - The backend's JSON-file store (`backend/app/data/overtraining_store.json`) is just as bad: one process, and it's lost on redeploy.
- **Fix:**
  1. Migration for a new `public.fatigue_checkins` table: `id`, `user_id` (references `users`, `ON DELETE CASCADE`), `fatigue_level` (1–10), `soreness_level` (1–10), `sleep_quality`, `joint_strain`, `sore_muscles text[]`, `notes` (up to 300 characters), `created_at`. Index on `(user_id, created_at desc)`. Turn RLS on with no policies, because only the service role reads it. **The user must approve the migration before it runs.**
  2. Store `dismissed_at` and `deload_applied_at` per user, either as columns on `users` or in a small `overtraining_state` table.
  3. Change `overtraining_service.py` to read and write Supabase instead of the JSON file, and delete `overtraining_store.json`.
  4. Add routes in `backend/app/api/workouts.py`, using the logged-in user (`current_user`), not a `user_id` query parameter:
     - `GET /workouts/overtraining-alerts`
     - `POST /workouts/fatigue-feedback`
     - `POST /workouts/overtraining-alerts/apply`
     - `POST /workouts/overtraining-alerts/dismiss`
  5. Change `OvertrainingAlerts.tsx` and `OvertrainingBanner.tsx` to use the existing `api.ts` functions and delete the copy of the rules in the browser. Keep the `api.ts` URLs in line with the new routes.
- **Done when:** a check-in made on one device shows on another, and the page makes no `localStorage` reads for this feature.

### P2: "Apply deload" only works on one device

- **Problem:**
  - "Apply deload" only sets `set_plate_overtraining_mod_pct` in `localStorage`, and that key is shared by every account on the device.
  - `apply_overtraining_mods` in the backend rewrites `ai_reasoning` on **all** of the user's plans without lowering any numbers.
- **Fix:**
  - Store `deload_applied_at` on the server.
  - Have `workout_adjustment_service.plan_daily_workout` treat an active deload, applied within the last 7 days, like high fatigue: one set fewer, and target RPE capped at 6.
  - Remove the 15% cut that `Workouts.tsx` makes in the browser.
  - Let the deload end after one planned session or 7 days.
- **Done when:** after applying a deload, the next AI plan really has fewer sets on any device, and another account on the same phone isn't affected.

### P3: The two fatigue systems don't share data

- **Problem:** the post-workout `workouts.fatigue_level`, the real one stored in the database, isn't counted by the overtraining alert.
- **Fix:** in `evaluate_overtraining`, treat a workout with `fatigue_level >= 7` in the last 7 days as a high-fatigue report, alongside the check-ins.
- **Done when:** two very tired workouts in a week can trigger the alert without any check-in.

### P3: Tests

The backend fixes need tests in `backend/tests/` that use the existing fake Supabase builders:

- **Risk level:** moderate versus high rules.
- **No made-up data:** no invented muscles or percentages.
- **Deload:** an active deload trims one set in the plan and expires after 7 days.
- **Ownership:** a user can't read or change another user's check-ins.
- **Validation:** fatigue or soreness outside 1–10, and notes over 300 characters, are rejected with 422.

## Notes

- Update the FAQ answer in `frontend/src/pages/Faq.tsx` once check-ins affect the plan.
- Workout history is read with `limit=50`, which is enough for 14 days. A filter on `start_time` would be cheaper.
