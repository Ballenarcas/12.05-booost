# Meal logging and nutrition

## Sub-features

- **Manual meal logging (`/log-meals`)**: Standalone route (outside `ProtectedLayout`, redirects to `/login` when `getCurrentUser()?.id` is empty). Displays `Daily Calorie Summary`, an `AI Tip` calorie-adjustment proposal button/modal (`GET /api/v1/ai/calorie-adjustment`), a search box for today's logged meals, the `Add Register` modal (`#foodInput` food search over the 30-item local catalog + Open Food Facts fallback, `#quantityGrams` + presets, meal type chips, `Add food to meal` to build a plate, then `Save Meal`), `Today Consumption` with immediate delete per meal, and a `See all` button navigating to `/nutrition`.
- **Nutrition hub (`/nutrition`)**: Full feature screen (not a placeholder) inside `ProtectedLayout` and the bottom dock `Nutrition` tab, titled `SAVED MEAL HISTORY`. Includes 7-day date navigation, quick actions (`Manual Register` -> `/log-meals`, `Scan plate PRO` -> `/scan-meal` or `/premium`, `Favorites` modal, `Suggestions PRO` modal), an embedded `HydrationCard` (`Hydration today`), and the selected day's meals with Favorite toggle (up to 50 saved favorites), ingredient-level Edit modal (with a `>1,000 g` `alertdialog` confirmation), and confirmation-gated Delete dialog.
- **AI Meal Recommendations (`Suggestions` modal on `/nutrition`)**: Premium-gated on client and server (`403` for non-Premium). Picks 3 meal suggestions per day; first load of the day and refreshes (up to 5/day) call the configured LLM (`meal_recommendation_service.py`) when `AI_API_KEY` is set. **Skip during routine checks.**
- **Photo Meal Scan (`/scan-meal`)**: Client-side Premium-gated via `Scan plate PRO` buttons on Home and Nutrition. Resizes an uploaded image and sends it to `POST /api/v1/nutrition/scan`, which calls the Vision LLM (`AI_VISION_MODEL`) and returns editable items before saving to `POST /api/v1/nutrition/meals`. **Skip photo uploads during routine checks.**

## How to get to it (user POV)

1. Sign in.
2. From Home (`/`), press `Manual Register` to open `/log-meals`, or tap `Nutrition` in the bottom dock (`nav[aria-label="Primary navigation"] button[aria-label="Nutrition"]`) to open `/nutrition` (`SAVED MEAL HISTORY`).
3. On `/log-meals`, press `Add Register`, search a food, pick a suggestion, set the weight in grams, press `Add food to meal`, choose a meal type, and press `Save Meal`.

## Driving it with Chrome DevTools

This journey writes a row to `meals` (and `meal_ingredients`). Delete it before cleanup.

1. Open `/log-meals` (directly or via `Manual Register` from Home or Nutrition) and wait for `section[aria-label="Daily Calorie Summary"]`.
2. If the Calorie Adjustment dialog (`div[role="dialog"][aria-labelledby="calorie-adjustment-title"]`) auto-opens, dismiss it with `button[aria-label="Close tip"]` (do not apply a goal change).
3. Click `button.btn-add-register` (`Add Register`). Inside `div[role="dialog"][aria-labelledby="modal-meal-title"]`:
   - Type a local staple such as `Chicken Breast` into `#foodInput` and click the matching `.suggestions-list .suggestion-item` row.
   - Set `#quantityGrams` to a small value (for example `10`).
   - Verify `button.btn-modal-submit` (`Save Meal`) is disabled until at least one food is added to the plate, then click `button.btn-add-food` (`Add food to meal`).
   - Click `button.btn-modal-submit` (`Save Meal`) and capture the created `id` from the `200` `POST /api/v1/nutrition/meals` response.
4. Assert the meal appears under `section[aria-label="Today Consumption"]` (`button[aria-label="Delete Chicken Breast"]`).
5. Click `button.see-all-link` (`See all`) to navigate to `/nutrition`. Assert `<h1>SAVED MEAL HISTORY</h1>`, `section[aria-labelledby="nutrition-hydration"]`, `Favorites` and `Suggestions` buttons, and `button[aria-label="Edit Chicken Breast"]`. (Do not open `Suggestions` or upload a photo on `/scan-meal`.)
6. Cleanup: navigate back to `/log-meals`, dismiss `Close tip` if open, and click `button[aria-label="Delete Chicken Breast"]` (asserting `DELETE /api/v1/nutrition/meals/<id>` returns `200`). Fallback API cleanup requires `Authorization: Bearer <localStorage['set_plate_session']>` on `DELETE /api/v1/nutrition/meals/<id>`.

## Gotchas

- Selecting a food suggestion only populates `#foodInput` and macro density; you **must** click `button.btn-add-food` (`Add food to meal`) before `Save Meal` (`button.btn-modal-submit`) becomes enabled.
- `/log-meals` fetches `GET /api/v1/ai/calorie-adjustment` on mount and auto-opens the Calorie Adjustment dialog whenever `status === 'pending' && has_change`. Dismiss it with `button[aria-label="Close tip"]` before interacting with the page.
- On `/log-meals`, `button[aria-label="Delete <meal name>"]` deletes immediately; on `/nutrition`, the trash button has no `aria-label` and opens a `Delete Meal?` confirmation dialog.
- Every `/api/v1/nutrition/*` endpoint requires `Authorization: Bearer <token>` from `localStorage['set_plate_session']`.
- `fetchTodayNutrition` caches per day in `sessionStorage` (`set_plate_nutrition:<userId>:<today_start>`, 60s TTL) and clears on create/update/delete.
- Searching fewer than 4 local matches falls back to `world.openfoodfacts.org`; use a local staple like `Chicken Breast` to avoid external network flakiness.
- Opening `Suggestions` on a Premium account (when no batch exists today) or uploading a photo on `/scan-meal` triggers paid LLM calls — skip both during routine verification.
