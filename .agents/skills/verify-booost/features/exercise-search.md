# Exercise search

## Sub-features

- **In-page Exercise Modal (`SelectExerciseModal`)**: Primary user-facing picker opened by `Add Exercise` / `Replace exercise` in `/workouts/active` and `/workouts/create`. Provides free-text search (un-debounced, `limit=30`, `compact=true`, no pagination), a muscle-group dropdown (`GET /api/v1/workouts/exercises/muscle-groups`), exclusion of already-selected exercises, `CUSTOM` badges + edit links for owned custom exercises, and a link to `/exercises/custom` (Premium-gated).
- **Full-page Exercise Picker (`/workouts/active/exercises`)**: Direct-URL route behind `ProtectedLayout`. Searches the 1,324-exercise catalog (plus the signed-in user's custom exercises) with a 250 ms debounce, pagination at 30 results per page (`Page 1 of 45` for the shared catalog), up to two muscles (falling back to `category`), and an info button linking to `/exercises/:id/guide`. Selecting a row stores the exercise in `sessionStorage` under `booost_pending_exercise` and navigates to `/workouts/active`.
- **Exercise Guide (`/exercises/:id/guide`)**: Loads `GET /api/v1/workouts/exercises/{id}` with rule-based coaching cues (`exercise_guides.json` / `exercise_staples.json` for catalog exercises, `null` for custom), still-image/GIF playback toggle, Gym visual media credit, and an `Add to workout` button.
- **Custom Exercises (`/exercises/custom` and `/exercises/custom/:id`)**: Premium-only CRUD (`POST`/`PUT`/`DELETE /api/v1/workouts/exercises/custom`, up to 100 private exercises per user stored in Supabase `public.exercises` with `owner_id`).
- **Auth behavior**: Search and detail endpoints use `optional_user` (`Authorization: Bearer <token>` from `localStorage['booost_session']`). Anonymous requests return shared catalog items only; valid tokens prepend the user's custom exercises and return `Cache-Control: private, no-store`; invalid/expired tokens return `401` and force a redirect to `/login`. No `user_id` query param, no LLM calls.

## How to get to it (user POV)

- **Modal picker**: Sign in -> open Workouts -> start a routine or empty workout -> press `Add Exercise` (or open a routine in `/workouts/create` and press `Add Exercise`).
- **Full-page picker**: Direct navigation to `/workouts/active/exercises` (behind `ProtectedLayout`, requires `booost_user` in `localStorage`; `ActiveWorkout` no longer routes here automatically, though it still consumes `booost_pending_exercise`).
- **Exercise Guide**: Click the info button `button[aria-label="How to do <name>"]` on `/workouts/active/exercises`, or open an exercise card menu (`...`) in `/workouts/active` and click `How to do it`.

## Driving it with Chrome DevTools

The shipped proof drives the full-page picker at `/workouts/active/exercises`:

```powershell
node .agents/skills/verify-booost/scripts/drive.mjs --scenario proof
```

It logs in through `/login`, waits for `booost_user` and `booost_session`, full-navigates to `/workouts/active/exercises` to cancel the login redirect before Home mounts, waits for `.exercise-picker-item`, types `bench` into `input[aria-label="Search exercises"]`, and compares the DOM with the real `/api/v1/workouts/exercises?q=bench...` response.

Manual handles if you extend the driver:

- **Full-page picker (`/workouts/active/exercises`)**:
  - Search box: `input[aria-label="Search exercises"]`.
  - Rows: `.exercise-picker-item`, names in `.exercise-picker-item strong`.
  - Guide button per row: `button[aria-label^="How to do "]`.
  - Page indicator: `.pagination-count` (`Page 1 of 45`+).
  - Loading / error / empty states: `.state-card` (`role="status"` when loading, `role="alert"` on error, no `role` attribute on `No exercises found.`).
- **Modal picker (`SelectExerciseModal`)**:
  - Search box: `input[placeholder="Search exercises..."]` (no `aria-label`).
  - Muscle-group filter: `select[aria-label="Filter exercises by muscle group"]`.
  - Add row button: `button[aria-label^="Add "]`; edit custom button: `button[aria-label^="Edit "]`.
- **Exercise Guide (`/exercises/:id/guide`)**:
  - Heading `h1` (`Exercise guide`), exercise name heading, detail chips, and coaching sections.

Assertions that prove it:

1. Initial catalog row count is greater than zero (`total >= 1324`, `items.length === 30`).
2. The `q=bench` request returns HTTP 200 with at least one item.
3. The rendered row count equals the response `items.length`.
4. The first rendered names equal the first response names.
5. At least one rendered name contains `bench`.
6. Clicking `button[aria-label^="How to do "]` opens `/exercises/:id/guide` with HTTP 200 from `GET /api/v1/workouts/exercises/{id}`.
7. No failed `/api/` requests and no console errors.

## Gotchas

- `fetchExercises` caches results in memory for 30 seconds keyed by `${user_id}|${queryString}` and sends the Bearer token automatically when `booost_session` exists.
- The 250 ms debounce applies to `/workouts/active/exercises`, not to `SelectExerciseModal`. Wait for the `q=bench` response, not a fixed sleep.
- Selecting a row on `/workouts/active/exercises` without an active session writes `booost_pending_exercise` and lands on `/workouts/active` with `No active workout selected.`. That is not a search failure.
- Exercise media URLs come from GitHub (`hasaneyldrm/exercises-dataset`, credited to Gym visual) and can fail offline. `drive.mjs` ignores non-`/api/` resource failures and fails only on `/api/` or console errors.
- `compact=true` omits `description`, `aliases`, and extra images (`images[:1]`), while retaining `id`, `name`, `category`, `muscle_group`, `muscles`, `muscles_secondary`, `equipment`, and `is_custom`.
- Creating a custom exercise (`/exercises/custom`) writes a row to Supabase `public.exercises` and requires an active Premium subscription. Delete any verification custom exercise via `DELETE /api/v1/workouts/exercises/custom/{id}` with Bearer auth.
