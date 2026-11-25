# Hydration tracking and history

## Sub-features

- **Daily hydration card (`HydrationCard`)**: Embedded on both Home (`/` under `section[aria-labelledby="hydration-summary"]`) and Nutrition (`/nutrition` under `section[aria-labelledby="nutrition-hydration"]`). Displays `total_ml / goal_ml`, a daily progress bar, quick logging in `Milliliters` or `Glasses (250 ml)`, today's drink log (`ul.hydration-entries`) with per-entry delete, inline goal editing (`Edit goal` with `Use recommended` reset), and a `History` link.
- **Weekly hydration history (`/hydration/history`)**: Displays a Mon–Sun SVG bar chart (`.hydration-chart-wrap`) comparing each day's total against the goal active on that date (`hydration_goal_history`), summary metric cards, and previous/next week navigation (capped at the current week).
- **Backend & auth**: Backed by `/api/v1/hydration/today`, `POST /api/v1/hydration/entries`, `DELETE /api/v1/hydration/entries/{entry_id}`, `PUT /api/v1/hydration/goal`, and `GET /api/v1/hydration/history`. All routes require `Authorization: Bearer <token>` (`Depends(current_user)`) and local-day query params (`today`, `today_start`, `today_end`). No LLM calls.

## How to get to it (user POV)

- **Daily card**: Sign in -> open Home (`/`) and scroll to `Daily hydration`, or open Nutrition (`/nutrition`) and scroll to `Hydration today`.
- **History page**: Click `History` on `HydrationCard`, or navigate directly to `/hydration/history` (behind `ProtectedLayout`).

## Driving it with Chrome DevTools

This journey writes a row to `hydration_logs`. Delete the created entry before cleanup.

1. Reach `HydrationCard` via `/nutrition` (safe even when `home_safe: false`) or via `/` (when `home_safe: true`).
2. Record the initial total text in `.hydration-card .progress-copy strong`.
3. Fill `input[aria-label="Amount in milliliters"]` with `250` (using the native input setter + `input` event) and click `button.hydration-add` (`Add`).
4. Capture the `200` `POST /api/v1/hydration/entries` response and assert `.hydration-card .progress-copy strong` increased by 250 ml and a `250 ml` row appeared in `ul.hydration-entries`.
5. Click `History` (`a` or `button` inside the hydration section) to open `/hydration/history`, wait for `GET /api/v1/hydration/history` (`200`) and `.hydration-chart-wrap`.
6. Return to the hydration card and click `button[aria-label="Remove 250 ml"]` (`.hydration-entry-remove`), asserting `DELETE /api/v1/hydration/entries/{id}` returns `200` and `.hydration-card .progress-copy strong` returns to its original value.

## Gotchas

- Navigating directly to `/nutrition` or `/hydration/history` avoids Home auto-planning when `home_safe: false`.
- Amounts are formatted with `de-DE` thousands separators (for example, `250 / 4.000 ml`). Compare before/after strings or strip `.` when parsing integers.
- Editing the hydration goal writes to both `users.hydration_goal_ml` and `hydration_goal_history`; if you test goal editing, restore the original goal afterward.
- Direct API cleanup requires `Authorization: Bearer <localStorage['booost_session']>` on `DELETE /api/v1/hydration/entries/{entry_id}`.
