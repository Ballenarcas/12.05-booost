# Settings and auth

## Sub-features

- **Welcome & Login (`/welcome`, `/login`)**: `/welcome` links to `/onboarding` (`Create your profile`) and `/login` (`Existing profile`). Submitting `/login` posts to `POST /api/v1/users/login` (15s timeout), stores **both** the stateless HMAC-SHA256 Bearer token in `localStorage['set_plate_session']` and the profile JSON in `localStorage['set_plate_user']`, shows a welcome overlay, and routes to `/` after 1.6 seconds.
- **Onboarding (`/onboarding`)**: A 2-step form (`Step 1 of 2`: name, email, 12+ char password + confirmation, Terms checkbox; `Step 2 of 2`: birth date, gender, weight, height, main goal) followed by a Step 3 completion overlay (auto-redirect to `/` after 1.6s). `POST /api/v1/users/onboarding` inserts a new user row, computes `calorie_goal`, issues a Bearer token, and rejects duplicate emails with **HTTP 409** (`This email is already registered. Sign in instead.`).
- **Password Reset (`/forgot-password`, `/reset-password`)**: `/login` links to `/forgot-password` (`POST /api/v1/users/password-reset/request`, anti-enumeration response, sends email via Resend if configured). `/reset-password?token=...` strips the token from the URL and submits a 12+ char password to `POST /api/v1/users/password-reset/confirm`; without a token it renders a missing-link fallback.
- **Settings (`/settings`)**:
  - **Profile & Goal card**: Edits Age, Weight, Height, Gender, and Main Goal (`PUT /api/v1/settings/update`, recalculating `calorie_goal` when fields change), plus `FAQ & Support` (`button.faq-btn` -> `/faq`).
  - **Health Connect card**: Loads `GET /api/v1/health-connect/status` on mount, opens a consent modal to connect (`POST /api/v1/health-connect/connect`, deterministic 7-day `preview` data in desktop browsers without Android's `window.SETPLATEHealthConnect` bridge), and supports `Sync now` (`/sync`) and `Disconnect` (`/disconnect`).
  - **Premium card & `/premium`**: Non-Premium users see `Go Premium` in the header routing to `/premium` (`POST /api/v1/premium/subscribe`). Active Premium users see a `Subscription` card in `/settings` with `Cancel Premium` (`POST /api/v1/premium/cancel`, `cancel_at_period_end = true`).
  - **Two-step Log Out**: Clicking `Log Out` opens a confirmation modal (`#logout-title`); clicking `button.danger-action` (`Log out`) clears `set_plate_session`, `set_plate_user`, `set_plate_active_workout`, `set_plate_pending_exercise`, and the dashboard cache, then navigates to `/login`.
- **FAQ (`/faq`)**: Static 4-item accordion (`article.faq-card`) and `Contact support` button revealing `support@setandplate.com`. No API calls.

## How to get to it (user POV)

- Login: `/welcome` -> `Existing profile`, or `/login` directly.
- Onboarding: `/welcome` -> `Create your profile`, or `/onboarding` directly.
- Settings: bottom dock `nav[aria-label="Primary navigation"] button[aria-label="Settings"]` (icon-only button), or `/settings` directly.
- FAQ: `/settings` -> `FAQ & Support`, or `/faq` directly.

## Driving it with Chrome DevTools

Login is the authentication step of the shipped proof:

```powershell
node .agents/skills/verify-setplate/scripts/drive.mjs --scenario proof
```

Handles:

- **Login**: `#login-email` (controlled React input — use native value setter + `input` event), `#login-password`, submit `form.login-form` with `requestSubmit()`. Wait for **both** `localStorage.getItem('set_plate_user')` and `localStorage.getItem('set_plate_session')`, then full-navigate to a non-Home route (e.g. `/settings` or `/workouts/active/exercises`) to cancel the 1.6s redirect to `/`.
- **Settings profile**: 3 `input.settings-input` fields (Age, Weight, Height) and 2 `select.settings-input` fields (Gender, Main Goal); save with `form button.settings-btn` (`Save Changes`) and assert `.settings-notice.success` (`PUT /api/v1/settings/update` returns `200`). For a safe write check, bump Weight by `+0.1` and immediately restore the original value.
- **Health Connect**: Assert `GET /api/v1/health-connect/status` returns `200`. If testing connect/disconnect, always restore the account's original connection state before teardown.
- **FAQ**: Click `button.faq-btn` -> assert `/faq` renders `article.faq-card` items.
- **Logout**: Match the `button.logout-btn` whose text is **`Log Out`** (do not use bare `querySelector('button.logout-btn')`), wait for `#logout-title`, click `div[role="dialog"] button.danger-action`, and assert redirect to `/login` with both `set_plate_session` and `set_plate_user` removed.
- **Reset fallback (logged out)**: Navigate to `/reset-password` with no query param and assert the missing-link notice renders cleanly.

Do not submit `/onboarding` (creates a permanent user), `/forgot-password` (sends email for real accounts), or `/premium` subscribe/cancel (not cleanly reversible via UI) during routine verification.

## Gotchas

- **Selector collision on Premium accounts**: Active Premium users render `Cancel Premium` as the **first** `button.logout-btn` above `Log Out`. Always filter `button.logout-btn` by text `Log Out`, or you will trigger the Cancel Premium modal instead.
- **Second `button.settings-btn`**: When Health Connect is disconnected, `Connect Health Connect` also carries `.settings-btn`. Scope profile saves to `form button.settings-btn`.
- **Controlled `#login-email`**: `#login-email` is React-controlled (`value={email}`), while `#login-password` is uncontrolled. Always use the native `HTMLInputElement.prototype.value` setter + `input`/`change` events (as `drive.mjs` does).
- **Auth split**: `ProtectedLayout` checks `set_plate_user` (redirecting to `/welcome`), while `apiFetch()` sends `set_plate_session` as `Authorization: Bearer <token>` and on `401` clears both keys and redirects to `/login`.
- **Login timeout**: `LOGIN_TIMEOUT_MS` is 15 seconds (other requests default to 5s). Exercise slow login with `node .agents/skills/verify-setplate/scripts/drive.mjs --scenario proof --login-latency 6000`.
- **After login**: `/login` waits 1.6s then navigates to `/`. Only a full-page navigation (`Page.navigate`) cancels that timer cleanly when `home_safe: false`.
- **Settings input accessibility**: Profile inputs lack `aria-label` or `id`; locate them via `input.settings-input` / `select.settings-input` order or surrounding `<label>` text.
