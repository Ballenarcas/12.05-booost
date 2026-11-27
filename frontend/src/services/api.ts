// In development, send API requests through Vite so LAN devices use the
// computer hosting the frontend instead of their own localhost.
const API_URL = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL ?? '')
const REQUEST_TIMEOUT_MS = 5000
const PURCHASE_TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 15000
const SCAN_TIMEOUT_MS = 70000
const LOGIN_TIMEOUT_MS = 15000
const DASHBOARD_TIMEOUT_MS = 15000
const LLM_TIMEOUT_MS = 20000
const CHAT_TIMEOUT_MS = 30000 // the server reads the user's data before it asks the model
const dashboardRequests = new Map<string, Promise<DashboardSummary>>()
const DASHBOARD_CACHE_PREFIX = 'booost_dashboard:'
const DASHBOARD_CACHE_TTL_MS = 30_000
const insightRequests = new Map<string, Promise<TrainerInsightResponse>>()
const nutritionRequests = new Map<string, Promise<TodayNutritionData>>()
const adjustmentRequests = new Map<string, Promise<CalorieAdjustmentData>>()
const workoutStatisticsCache = new Map<string, { data: WorkoutStatistics; expiresAt: number }>()
const nutritionStatisticsCache = new Map<string, { data: NutritionStatistics; expiresAt: number }>()
const WORKOUT_STATISTICS_CACHE_TTL_MS = 30_000
const NUTRITION_CACHE_PREFIX = 'booost_nutrition:'
const NUTRITION_CACHE_TTL_MS = 60_000
import type { NutritionStatistics, NutritionStatisticsRange } from '../types/nutrition'
import type {
  Attachables,
  CardRef,
  Comment,
  FeedMode,
  FeedPage,
  Member,
  MemberProfile,
  Post,
  SocialMe,
} from '../types/social'
import type {
  LiveWorkoutAdjustmentRequest,
  LiveWorkoutAdjustmentResponse,
  Routine,
  RoutineCreatePayload,
  WarmupRecommendation,
  WarmupRecommendationRequest,
  WorkoutHistoryEntry,
  WorkoutStatistics,
  WorkoutStatisticsRange,
} from '../types/workout'
import type { WorkoutLogCreate } from '../types/workout'
import { DEFAULT_STATISTICS_RANGE } from '../utils/workoutStatistics'
import { getLanguage, onLanguageChange, t } from '../i18n'
import type {
  ChatQuota,
  ChatReply,
  ConversationDetail,
  ConversationSummary,
  PremiumPlan,
  UserProfile,
} from '../types'
import type {
  HealthActivityDay,
  HealthActivitySummary,
  HealthConnectSource,
  HealthConnectStatus,
} from '../types/health'

export interface PlanExercise {
  exercise_id: string
  name: string
  sets: number
  reps: number
  previous_weight_kg?: number | null
}

export interface WorkoutPlanSummary {
  id: string
  routine_id: string | null
  title: string
  plan_date: string
  is_rest_day: boolean
  ai_adjusted: boolean
  ai_reasoning: string | null
  exercises: PlanExercise[]
}

export interface CompletedWorkoutToday {
  id: string
  name: string
}

export interface DashboardSummary {
  user_name: string
  current_date_formatted: string
  ai_notification: string
  nutrition: {
    remaining_kcals: number
    target_kcals: number
    current_protein: number
    target_protein: number
    current_carbs: number
    target_carbs: number
    current_fat: number
    target_fat: number
  }
  workout: {
    title: string
    exercise_count: number
    estimated_duration_minutes: number
  } | null
  plan: WorkoutPlanSummary | null
  completed_workout_today: CompletedWorkoutToday | null
  activity: HealthActivitySummary
}

const SESSION_KEY = 'booost_session'
const STORAGE_PREFIX = 'booost_'

export function activeWorkoutStorageKey(userId: string | undefined = getCurrentUser()?.id): string | null {
  return userId ? `${STORAGE_PREFIX}active_workout:${userId}` : null
}

export function overtrainingModPctStorageKey(userId: string | undefined = getCurrentUser()?.id): string | null {
  return userId ? `${STORAGE_PREFIX}overtraining_mod_pct:${userId}` : null
}

export function getActiveDeloadPct(userId: string | undefined = getCurrentUser()?.id): number {
  try {
    const key = overtrainingModPctStorageKey(userId)
    if (!key) return 0
    const modPct = Number(localStorage.getItem(key) || '0')
    return Number.isFinite(modPct) && modPct > 0 ? modPct : 0
  } catch {
    return 0
  }
}

function clearStorageByPrefix(storage: Storage, prefix: string, kept: string[] = []): void {
  try {
    Object.keys(storage)
      .filter((key) => key.startsWith(prefix) && !kept.some((start) => key.startsWith(start)))
      .forEach((key) => storage.removeItem(key))
  } catch {
    // Storage can be unavailable in restricted browsing contexts.
  }
}

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

/**
 * keepWorkouts leaves workouts in progress on the device: an expired session or a new sign-in must
 * not lose them. Their keys carry the user id, so another account never sees them.
 */
export function clearSession({ keepWorkouts = false } = {}): void {
  shortCache.clear()
  feedEpoch += 1
  feedRequests.clear()
  lastFeeds.clear()
  lastSocialMeValue = null
  preloadedMedia.clear()
  lastHydration = null
  dashboardRequests.clear()
  insightRequests.clear()
  nutritionRequests.clear()
  adjustmentRequests.clear()
  workoutStatisticsCache.clear()
  nutritionStatisticsCache.clear()
  routinesRequests.clear()
  exerciseListCache.clear()
  exerciseListInflight.clear()
  const kept = keepWorkouts
    ? [`${STORAGE_PREFIX}active_workout:`, `${STORAGE_PREFIX}overtraining_mod_pct:`]
    : []
  clearStorageByPrefix(localStorage, STORAGE_PREFIX, kept)
  clearStorageByPrefix(sessionStorage, STORAGE_PREFIX)
}

/**
 * Single entry point for every authenticated request. Adds the bearer token
 * and drops the local session as soon as the server rejects it.
 */
async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  // The server answers messages, tips and plans in the app language.
  headers.set('Accept-Language', getLanguage())
  const response = await fetch(input, { ...init, headers })
  // The server renews a session in use. Ignored if the user signed out or switched meanwhile.
  const renewed = response.headers.get('X-Session-Token')
  if (renewed && token && getAccessToken() === token) {
    try {
      localStorage.setItem(SESSION_KEY, renewed)
    } catch {
      // The current token keeps working until it expires.
    }
  }
  if (response.status === 401) {
    clearSession({ keepWorkouts: true })
    if (window.location.pathname !== '/login') window.location.assign('/login')
    throw new Error(t('api.sessionExpired'))
  }
  return response
}

function todayKey(): string {
  return new Date().toDateString()
}

// Kept on the device, not just the tab, so reopening the app shows the last dashboard at once while a
// fresh one loads. Only today's copy is used, and signing out removes it.
function readDashboardCache(userId: string): { data: DashboardSummary; at: number } | null {
  try {
    const saved = localStorage.getItem(`${DASHBOARD_CACHE_PREFIX}${userId}`)
    if (!saved) return null
    const cached = JSON.parse(saved) as { data: DashboardSummary; at: number; day?: string }
    return cached?.data && typeof cached.at === 'number' && cached.day === todayKey() ? cached : null
  } catch {
    return null
  }
}

// Last answers kept on the device, so pages show them at once on the next visit (even after the
// app is reopened) while a fresh copy loads. Cleared when the data changes and on sign-out.
const SAVED_COPY_PREFIX = 'booost_copy:'

export function readSavedCopy<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(SAVED_COPY_PREFIX + key) ?? 'null') as T | null
  } catch {
    return null
  }
}

function saveCopy(key: string, value: unknown): void {
  try {
    localStorage.setItem(SAVED_COPY_PREFIX + key, JSON.stringify(value))
  } catch {
    // The fresh answer is still shown when storage is unavailable or full.
  }
}

function forgetSavedCopies(prefix = ''): void {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(SAVED_COPY_PREFIX + prefix))
      .forEach((key) => localStorage.removeItem(key))
  } catch {
    // Nothing saved to forget when storage is unavailable.
  }
}

// Short in-memory cache for what Home shows next to the dashboard. Same request in flight is shared,
// so Home and Workouts never fetch it twice at once. Cleared with the dashboard after any change.
const SHORT_CACHE_TTL_MS = 30_000
const shortCache = new Map<string, { at: number; value: Promise<unknown> }>()

function cachedRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = shortCache.get(key)
  if (hit && Date.now() - hit.at < SHORT_CACHE_TTL_MS) return hit.value as Promise<T>
  const value = load()
  shortCache.set(key, { at: Date.now(), value })
  value.catch(() => { if (shortCache.get(key)?.value === value) shortCache.delete(key) })
  return value
}

/** A decided tip is replaced by the next one, so the cached tip must not come back. */
function forgetCachedTip(): void {
  for (const key of [...shortCache.keys()]) if (key.startsWith('tip:')) shortCache.delete(key)
}

export function clearDashboardCache(): void {
  dashboardRequests.clear()
  shortCache.clear()
  invalidateNutritionStatisticsCache()
  forgetSavedCopies('history:')
  forgetSavedCopies('nutrition:')
  forgetSavedCopies('overtraining:')
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(DASHBOARD_CACHE_PREFIX))
      .forEach((key) => localStorage.removeItem(key))
  } catch {
    // The next dashboard request remains authoritative if browser storage is unavailable.
  }
}

export function getCachedDashboardSummary(): DashboardSummary | null {
  const user = getCurrentUser()
  return user?.id ? readDashboardCache(user.id)?.data ?? null : null
}

export async function fetchDashboardSummary(options: { forceRefresh?: boolean } = {}): Promise<DashboardSummary> {
  const user = getCurrentUser()
  if (!user?.id) throw new Error(t('api.profileDashboard'))
  const userId = user.id
  const cached = readDashboardCache(userId)
  if (!options.forceRefresh && cached && Date.now() - cached.at < DASHBOARD_CACHE_TTL_MS) return cached.data
  const inflight = dashboardRequests.get(userId)
  if (inflight) return inflight

  const request = apiFetch(`${API_URL}/api/v1/dashboard/summary?user_id=${encodeURIComponent(userId)}&${localDayQuery()}`, {
    signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(t('home.errorLoad'))
      const data = await response.json() as DashboardSummary
      try {
        localStorage.setItem(`${DASHBOARD_CACHE_PREFIX}${userId}`, JSON.stringify({ data, at: Date.now(), day: todayKey() }))
      } catch {
        // The fresh response remains usable when browser storage is unavailable.
      }
      return data
    })
    .finally(() => {
      dashboardRequests.delete(userId)
    })

  dashboardRequests.set(userId, request)
  return request
}

export async function planTodaysWorkout(userId: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/api/v1/workouts/plan-today?user_id=${encodeURIComponent(userId)}&${localDayQuery()}`, {
    method: 'POST',
    signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(t('api.buildWorkout'))
  }
  clearDashboardCache()
}

const routinesRequests = new Map<string, Promise<Routine[]>>()

export function clearRoutinesCache(): void {
  routinesRequests.clear()
  forgetSavedCopies('routines:')
}

export async function fetchRoutines(): Promise<Routine[]> {
  const user = getCurrentUser()
  const userId = user?.id
  if (!userId) throw new Error(t('api.profileRoutines'))
  const existing = routinesRequests.get(userId)
  if (existing) return existing
  const request = apiFetch(`${API_URL}/api/v1/routines?user_id=${encodeURIComponent(userId)}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(t('workouts.errorRoutines'))
      const routines = await response.json() as Routine[]
      saveCopy(`routines:${userId}`, routines)
      return routines
    })
    .catch((error: unknown) => {
      if (routinesRequests.get(userId) === request) routinesRequests.delete(userId)
      throw error
    })
  routinesRequests.set(userId, request)
  return request
}

export async function createRoutine(payload: RoutineCreatePayload): Promise<Routine> {
  const user = getCurrentUser()
  if (!user?.id) throw new Error(t('api.onboardingCreateRoutine'))

  let response: Response
  try {
    response = await apiFetch(`${API_URL}/api/v1/routines?user_id=${encodeURIComponent(user.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(t('api.routineTimeout'), { cause: error })
    }
    if (error instanceof TypeError) {
      throw new Error(t('api.routineUnreachable', { message: error.message }), { cause: error })
    }
    throw error
  }

  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null)
    let detail: string | undefined
    if (error && typeof error === 'object' && 'detail' in error) {
      const responseDetail = error.detail
      if (typeof responseDetail === 'string') {
        detail = responseDetail
      } else if (Array.isArray(responseDetail)) {
        detail = responseDetail
          .map((item: unknown) => {
            if (!item || typeof item !== 'object' || !('msg' in item)) return null
            const message = typeof item.msg === 'string' ? item.msg : null
            const location = 'loc' in item && Array.isArray(item.loc)
              ? item.loc.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number').join(' > ')
              : ''
            return message ? `${location ? `${location}: ` : ''}${message}` : null
          })
          .filter((message): message is string => message !== null)
          .join('; ')
      }
    }
    throw new Error(detail || t('api.serverCreate', { status: response.status }))
  }
  const routine = await response.json() as Routine
  clearRoutinesCache()
  return routine
}

export async function updateRoutine(routineId: string, payload: RoutineCreatePayload): Promise<Routine> {
  const user = getCurrentUser()
  if (!user?.id) throw new Error(t('api.onboardingUpdateRoutine'))

  const response = await apiFetch(
    `${API_URL}/api/v1/routines/${encodeURIComponent(routineId)}?user_id=${encodeURIComponent(user.id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  )
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null)
    const detail = error && typeof error === 'object' && 'detail' in error && typeof error.detail === 'string'
      ? error.detail
      : t('api.serverUpdate', { status: response.status })
    throw new Error(detail)
  }
  const routine = await response.json() as Routine
  clearRoutinesCache()
  return routine
}

export async function deleteRoutine(routineId: string): Promise<void> {
  const user = getCurrentUser()
  if (!user?.id) throw new Error(t('api.onboardingDeleteRoutine'))

  const response = await apiFetch(
    `${API_URL}/api/v1/routines/${encodeURIComponent(routineId)}?user_id=${encodeURIComponent(user.id)}`,
    { method: 'DELETE', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  )
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null)
    const detail = error && typeof error === 'object' && 'detail' in error && typeof error.detail === 'string'
      ? error.detail
      : t('api.serverDelete', { status: response.status })
    throw new Error(detail)
  }
  clearRoutinesCache()
}

export async function saveWorkoutLog(userId: string, payload: WorkoutLogCreate): Promise<{ id: string; status: string }> {
  const response = await apiFetch(`${API_URL}/api/v1/workouts/logs?user_id=${encodeURIComponent(userId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(t('aw.errorSave'))
  }
  invalidateWorkoutStatisticsCache(userId)
  clearDashboardCache()
  return response.json() as Promise<{ id: string; status: string }>
}

function workoutAdjustmentError(response: Response, payload: unknown): string {
  if (response.status === 422) {
    return t('api.aiCantRead')
  }
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail?: unknown }).detail
    if (typeof detail === 'string' && detail.trim()) return detail
  }
  return t('aw.errorAdjust')
}

export async function requestWorkoutAdjustment(
  userId: string,
  payload: LiveWorkoutAdjustmentRequest,
): Promise<LiveWorkoutAdjustmentResponse> {
  const query = new URLSearchParams({ user_id: userId })
  let response: Response
  try {
    response = await apiFetch(`${API_URL}/api/v1/workouts/adjust?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(t('api.trainerSlow'), { cause: error })
    }
    throw error
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    if (response.status === 422) console.error('Workout adjustment request rejected', JSON.stringify(body))
    throw new Error(workoutAdjustmentError(response, body))
  }
  return response.json() as Promise<LiveWorkoutAdjustmentResponse>
}

export class PremiumRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PremiumRequiredError'
  }
}

export async function requestWarmupRecommendation(
  userId: string,
  payload: WarmupRecommendationRequest,
): Promise<WarmupRecommendation> {
  const query = new URLSearchParams({ user_id: userId })
  const response = await apiFetch(`${API_URL}/api/v1/workouts/warmup?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string'
      ? body.detail
      : null
    if (response.status === 403) {
      throw new PremiumRequiredError(detail ?? 'Warm-up recommendations are a Premium feature.')
    }
    throw new Error(detail ?? t('aw.errorWarmup'))
  }
  return response.json() as Promise<WarmupRecommendation>
}


export function fetchWorkoutHistory(userId: string): Promise<WorkoutHistoryEntry[]> {
  return cachedRequest(`history:${userId}`, () => loadWorkoutHistory(userId).then((items) => {
    saveCopy(`history:${userId}`, items)
    return items
  }))
}

async function loadWorkoutHistory(userId: string): Promise<WorkoutHistoryEntry[]> {
  const query = new URLSearchParams({ user_id: userId, limit: '30' })
  const response = await apiFetch(`${API_URL}/api/v1/workouts/history?${query}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(t('workouts.errorHistory'))
  }
  const result = await response.json() as { items: WorkoutHistoryEntry[] }
  return result.items
}

export async function updateWorkoutHistoryEntry(
  userId: string,
  workoutId: string,
  payload: Pick<WorkoutLogCreate, 'name' | 'exercises' | 'fatigue_level'>,
): Promise<{ id: string; status: string }> {
  const query = new URLSearchParams({ user_id: userId })
  const response = await apiFetch(`${API_URL}/api/v1/workouts/history/${encodeURIComponent(workoutId)}?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.updateWorkout'))
  }
  clearDashboardCache()
  return response.json()
}

export async function deleteWorkoutHistoryEntry(userId: string, workoutId: string): Promise<void> {
  const query = new URLSearchParams({ user_id: userId })
  const response = await apiFetch(`${API_URL}/api/v1/workouts/history/${encodeURIComponent(workoutId)}?${query}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(t('api.removeWorkout'))
  }
  invalidateWorkoutStatisticsCache(userId)
  clearDashboardCache()
}

// The last statistics for each range are also kept on the device, so the page can show them at
// once while fresh ones load. Only today's copy is used; saving or deleting a workout, or signing
// out, removes them.
const SAVED_STATISTICS_PREFIX = 'booost_stats:'
const SAVED_NUTRITION_STATISTICS_PREFIX = 'booost_nutrition_stats:'

export function getSavedWorkoutStatistics(userId: string, range: WorkoutStatisticsRange): WorkoutStatistics | null {
  try {
    const saved = JSON.parse(localStorage.getItem(`${SAVED_STATISTICS_PREFIX}${userId}:${range}`) ?? 'null') as { data: WorkoutStatistics; day: string } | null
    return saved?.day === new Date().toDateString() ? saved.data : null
  } catch {
    return null
  }
}

export function getSavedNutritionStatistics(userId: string, range: NutritionStatisticsRange): NutritionStatistics | null {
  try {
    const saved = JSON.parse(localStorage.getItem(`${SAVED_NUTRITION_STATISTICS_PREFIX}${userId}:${range}`) ?? 'null') as { data: NutritionStatistics; day: string } | null
    return saved?.day === new Date().toDateString() ? saved.data : null
  } catch {
    return null
  }
}

function forgetSavedStatistics(userId?: string): void {
  try {
    const prefix = `${SAVED_STATISTICS_PREFIX}${userId ?? ''}`
    Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key))
  } catch {
    // Nothing saved to forget when storage is unavailable.
  }
}

function forgetSavedNutritionStatistics(userId?: string): void {
  try {
    const prefix = `${SAVED_NUTRITION_STATISTICS_PREFIX}${userId ?? ''}`
    Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key))
  } catch {
    // Nothing saved to forget when storage is unavailable.
  }
}

function invalidateWorkoutStatisticsCache(userId: string): void {
  const prefix = `${userId}:`
  for (const key of workoutStatisticsCache.keys()) {
    if (key.startsWith(prefix)) workoutStatisticsCache.delete(key)
  }
  forgetSavedStatistics(userId)
}

function invalidateNutritionStatisticsCache(userId?: string): void {
  if (userId) {
    const prefix = `${userId}:`
    for (const key of nutritionStatisticsCache.keys()) {
      if (key.startsWith(prefix)) nutritionStatisticsCache.delete(key)
    }
  } else {
    nutritionStatisticsCache.clear()
  }
  forgetSavedNutritionStatistics(userId)
}

/** Loads what the main pages show in the background, so their first visit is instant too. */
export function prefetchMainPages(): void {
  const userId = getCurrentUser()?.id
  if (!userId) return
  const quietly = (request: Promise<unknown>) => { void request.catch(() => undefined) }
  quietly(fetchWorkoutStatistics(userId, DEFAULT_STATISTICS_RANGE))
  quietly(fetchNutritionStatistics(userId, DEFAULT_STATISTICS_RANGE))
  quietly(fetchRoutines())
  quietly(fetchWorkoutHistory(userId))
  quietly(fetchTodayNutrition(userId))
  quietly(fetchSocialMe())
  quietly(fetchFeed('following'))
}

export async function fetchWorkoutStatistics(
  userId: string,
  range: WorkoutStatisticsRange,
  signal?: AbortSignal,
): Promise<WorkoutStatistics> {
  const timezoneOffsetMinutes = new Date().getTimezoneOffset()
  const cacheKey = `${userId}:${range}:${timezoneOffsetMinutes}`
  const cached = workoutStatisticsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.data
  if (cached) workoutStatisticsCache.delete(cacheKey)

  const query = new URLSearchParams({
    user_id: userId,
    range,
    timezone_offset_minutes: String(timezoneOffsetMinutes),
  })
  const timeout = AbortSignal.timeout(DASHBOARD_TIMEOUT_MS)
  const response = await apiFetch(`${API_URL}/api/v1/workouts/statistics?${query}`, {
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    throw new Error(t('stats.errorWorkouts'))
  }
  const data = await response.json() as WorkoutStatistics
  workoutStatisticsCache.set(cacheKey, { data, expiresAt: Date.now() + WORKOUT_STATISTICS_CACHE_TTL_MS })
  try {
    localStorage.setItem(`${SAVED_STATISTICS_PREFIX}${userId}:${range}`, JSON.stringify({ data, day: new Date().toDateString() }))
  } catch {
    // The fresh response is still shown when storage is unavailable or full.
  }
  return data
}

export async function fetchNutritionStatistics(
  userId: string,
  range: NutritionStatisticsRange,
  signal?: AbortSignal,
): Promise<NutritionStatistics> {
  const timezoneOffsetMinutes = new Date().getTimezoneOffset()
  const cacheKey = `${userId}:${range}:${timezoneOffsetMinutes}`
  const cached = nutritionStatisticsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.data
  if (cached) nutritionStatisticsCache.delete(cacheKey)

  const query = new URLSearchParams({
    range,
    timezone_offset_minutes: String(timezoneOffsetMinutes),
  })
  const timeout = AbortSignal.timeout(DASHBOARD_TIMEOUT_MS)
  const response = await apiFetch(`${API_URL}/api/v1/nutrition/statistics?${query}`, {
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    throw new Error(t('stats.errorMeals'))
  }
  const data = await response.json() as NutritionStatistics
  nutritionStatisticsCache.set(cacheKey, { data, expiresAt: Date.now() + WORKOUT_STATISTICS_CACHE_TTL_MS })
  try {
    localStorage.setItem(`${SAVED_NUTRITION_STATISTICS_PREFIX}${userId}:${range}`, JSON.stringify({ data, day: new Date().toDateString() }))
  } catch {
    // The fresh response is still shown when storage is unavailable or full.
  }
  return data
}

async function postPasswordReset(path: string, body: object, fallback: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${API_URL}/api/v1/users/password-reset/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLanguage() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(t('api.slow'), { cause: error })
  }
  if (response.status === 429) throw new Error(t('api.tooMany'))
  const data = await response.json().catch(() => ({})) as { message?: string; detail?: unknown }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : fallback)
  return data.message ?? ''
}

/** Always resolves with the same message, whether or not the email has an account. */
export function requestPasswordReset(email: string): Promise<string> {
  return postPasswordReset('request', { email: email.trim() }, t('reset.errorSend'))
}

export function confirmPasswordReset(token: string, newPassword: string): Promise<string> {
  return postPasswordReset('confirm', { token, new_password: newPassword }, t('reset.errorUpdate'))
}

export async function loginUser(email: string, password: string): Promise<import('../types').UserProfile> {
  let response: Response
  try {
    response = await fetch(`${API_URL}/api/v1/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLanguage() },
      body: JSON.stringify({ email: email.trim(), password }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(t('api.signInSlow'), { cause: error })
    }
    throw error
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 404) {
      throw new Error(t('api.wrongPassword'))
    }
    if (response.status === 429) {
      throw new Error(t('api.tooMany'))
    }
    throw new Error(t('api.signInNow'))
  }

  const profile = await response.json() as import('../types').UserProfile & { access_token: string }
  clearSession({ keepWorkouts: true })
  try {
    localStorage.setItem(SESSION_KEY, profile.access_token)
    localStorage.setItem('booost_user', JSON.stringify(profile))
  } catch {
    throw new Error(t('api.keepSignedIn'))
  }
  return profile
}

export interface TrainerInsightRequest {
  nutrition_summary: string
  training_summary: string
  user_goal: string
}

export interface TrainerInsightResponse {
  insight: string
  model: string
}

export async function getHealth(): Promise<{ status: string }> {
  const response = await apiFetch(`${API_URL}/api/v1/health`)
  if (!response.ok) throw new Error(t('api.unreachable'))
  return response.json() as Promise<{ status: string }>
}

export async function fetchHealthConnectStatus(): Promise<HealthConnectStatus> {
  const response = await apiFetch(`${API_URL}/api/v1/health-connect/status`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(
      typeof body?.detail === 'string'
        ? body.detail
        : t('health.errorLoad'),
    )
  }
  return response.json() as Promise<HealthConnectStatus>
}

export async function connectHealthConnect(
  source: HealthConnectSource,
  days: HealthActivityDay[],
): Promise<HealthConnectStatus> {
  const response = await apiFetch(`${API_URL}/api/v1/health-connect/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, days }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(
      typeof body?.detail === 'string'
        ? body.detail
        : t('health.errorConnect'),
    )
  }
  return response.json() as Promise<HealthConnectStatus>
}

export async function syncHealthConnectActivity(
  source: HealthConnectSource,
  days: HealthActivityDay[],
): Promise<HealthConnectStatus> {
  const response = await apiFetch(`${API_URL}/api/v1/health-connect/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, days }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(
      typeof body?.detail === 'string'
        ? body.detail
        : t('health.errorSync'),
    )
  }
  return response.json() as Promise<HealthConnectStatus>
}

export async function disconnectHealthConnect(): Promise<HealthConnectStatus> {
  const response = await apiFetch(`${API_URL}/api/v1/health-connect/disconnect`, {
    method: 'POST',
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(
      typeof body?.detail === 'string'
        ? body.detail
        : t('health.errorDisconnect'),
    )
  }
  return response.json() as Promise<HealthConnectStatus>
}

export async function generateTrainerInsight(
  request: TrainerInsightRequest,
): Promise<TrainerInsightResponse> {
  const requestKey = JSON.stringify(request)
  const existingRequest = insightRequests.get(requestKey)
  if (existingRequest) return existingRequest

  const insightRequest = apiFetch(`${API_URL}/api/v1/ai/trainer-insight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestKey,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(t('api.trainerTip'))
      return response.json() as Promise<TrainerInsightResponse>
    })
    .finally(() => insightRequests.delete(requestKey))

  insightRequests.set(requestKey, insightRequest)
  return insightRequest
}

export type EntityType = 'food' | 'exercise' | 'routine' | 'meal'

export interface MatchedEntity {
  id: string
  name: string
  category: EntityType
  score: number
  matched_term: string
  metadata: Record<string, unknown>
}

export interface ParseNaturalLanguageResponse {
  original_text: string
  detected_intent: string
  foods: MatchedEntity[]
  exercises: MatchedEntity[]
  routines: MatchedEntity[]
  meals: MatchedEntity[]
}

export interface ConversationalSetupRequest {
  message: string
  conversation_history?: Array<{ role: string; content: string }>
}

export interface ConversationalSetupResponse {
  reply: string
  detected_intent: string
  matched_entities: ParseNaturalLanguageResponse
}

export async function parseNaturalLanguage(
  text: string,
  threshold = 0.65,
): Promise<ParseNaturalLanguageResponse> {
  const response = await apiFetch(`${API_URL}/api/v1/ai/parse-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, threshold }),
  })
  if (!response.ok) throw new Error(t('api.understand'))
  return response.json() as Promise<ParseNaturalLanguageResponse>
}

export async function conversationalSetup(
  request: ConversationalSetupRequest,
): Promise<ConversationalSetupResponse> {
  const response = await apiFetch(`${API_URL}/api/v1/ai/conversational-setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(t('api.continueSetup'))
  return response.json() as Promise<ConversationalSetupResponse>
}

export interface FetchExercisesParams {
  q?: string
  category?: string
  muscle_group?: string
  muscle?: string
  equipment?: string
  page?: number
  limit?: number
  compact?: boolean
}

const exerciseListCache = new Map<string, { at: number; data: import('../types').ExerciseListResponse }>()
const exerciseListInflight = new Map<string, Promise<import('../types').ExerciseListResponse>>()
const EXERCISE_LIST_TTL_MS = 30_000

export async function fetchExercises(params: FetchExercisesParams = {}) {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.category) query.set('category', params.category)
  if (params.muscle_group) query.set('muscle_group', params.muscle_group)
  if (params.muscle) query.set('muscle', params.muscle)
  if (params.equipment) query.set('equipment', params.equipment)
  if (params.page) query.set('page', String(params.page))
  if (params.limit) query.set('limit', String(params.limit))
  if (params.compact) query.set('compact', 'true')

  const queryString = query.toString()
  // The list includes the signed-in user's custom exercises, so cache it per user.
  const cacheKey = `${getCurrentUser()?.id ?? ''}|${queryString}`
  const cached = exerciseListCache.get(cacheKey)
  if (cached && Date.now() - cached.at < EXERCISE_LIST_TTL_MS) return cached.data
  const inflight = exerciseListInflight.get(cacheKey)
  if (inflight) return inflight

  const request = apiFetch(`${API_URL}/api/v1/workouts/exercises${queryString ? `?${queryString}` : ''}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(t('picker.errorLoad'))
      const data = (await response.json()) as import('../types').ExerciseListResponse
      exerciseListCache.set(cacheKey, { at: Date.now(), data })
      return data
    })
    .finally(() => {
      exerciseListInflight.delete(cacheKey)
    })

  exerciseListInflight.set(cacheKey, request)
  return request
}

export async function fetchExerciseCategories(): Promise<string[]> {
  const response = await apiFetch(`${API_URL}/api/v1/workouts/exercises/categories`)
  if (!response.ok) throw new Error(t('api.exerciseCategories'))
  const data = await response.json()
  return data.categories ?? []
}

export async function fetchExerciseMuscleGroups(): Promise<string[]> {
  const response = await apiFetch(`${API_URL}/api/v1/workouts/exercises/muscle-groups`)
  if (!response.ok) throw new Error(t('api.muscleGroups'))
  const data = await response.json() as { muscle_groups?: string[] }
  return data.muscle_groups ?? []
}

export async function fetchExerciseById(exerciseId: string) {
  const response = await apiFetch(`${API_URL}/api/v1/workouts/exercises/${encodeURIComponent(exerciseId)}`, {
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(t('api.loadExercise'))
  return response.json()
}

export function calculateAgeFromBirthDate(birthDate: string): number | undefined {
  if (!birthDate) return undefined
  const birth = new Date(birthDate)
  if (isNaN(birth.getTime())) return undefined
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const m = today.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
    age--
  }
  return age >= 0 ? age : undefined
}

export async function submitUserOnboarding(formData: import('../types').UserOnboardingFormData): Promise<import('../types').UserProfile> {
  const calculatedAge = calculateAgeFromBirthDate(formData.birthDate)
  const ageInt = calculatedAge !== undefined ? Math.floor(calculatedAge) : undefined

  const payload = {
    name: formData.firstName.trim(),
    surname: formData.lastName.trim(),
    email: formData.email.trim(),
    password: formData.password,
    age: ageInt,
    gender: formData.gender,
    weight: formData.weight ? parseFloat(formData.weight) : undefined,
    height: formData.height ? parseInt(formData.height, 10) : undefined,
    objective: formData.mainGoal,
  }

  const localProfile: import('../types').UserProfile = {
    name: payload.name,
    surname: payload.surname,
    email: payload.email,
    birthDate: formData.birthDate,
    age: calculatedAge,
    gender: payload.gender,
    weight: payload.weight,
    height: payload.height,
    objective: payload.objective,
  }

  const response = await apiFetch(`${API_URL}/api/v1/users/onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    if (response.status === 409) {
      throw new Error(t('api.emailTaken'))
    }
    throw new Error(t('signup.errorSave'))
  }

  const data = await response.json()
  if (!data.saved_to_supabase) {
    throw new Error(t('api.saveAccount'))
  }

  localProfile.id = data.user_id
  if (data.calorie_goal) {
    localProfile.calorie_goal = data.calorie_goal
  }
  clearSession()
  try {
    if (data.access_token) localStorage.setItem(SESSION_KEY, data.access_token)
    localStorage.setItem('booost_user', JSON.stringify(localProfile))
  } catch {
    // Ignore
  }

  return localProfile
}

export function getCurrentUser(): import('../types').UserProfile | null {
  try {
    const saved = localStorage.getItem('booost_user')
    return saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
}

export interface PremiumStatus {
  status: string
  is_premium: boolean
  plan: PremiumPlan
  started_at: string
  expires_at: string
}

export const PREMIUM_UPDATED_EVENT = 'booost:premium-updated'

export function isPremiumActive(profile: UserProfile | null = getCurrentUser()): boolean {
  if (!profile?.is_premium) return false
  if (!profile.premium_expires_at) return true
  const expiresAt = Date.parse(profile.premium_expires_at)
  return Number.isFinite(expiresAt) ? expiresAt > Date.now() : false
}

export async function purchasePremium(plan: PremiumPlan): Promise<PremiumStatus> {
  const user = getCurrentUser()
  if (!user?.id) throw new Error(t('api.signInPremium'))

  const response = await apiFetch(
    `${API_URL}/api/v1/premium/subscribe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
      signal: AbortSignal.timeout(PURCHASE_TIMEOUT_MS),
    },
  )

  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null)
    const detail = error && typeof error === 'object' && 'detail' in error && typeof error.detail === 'string'
      ? error.detail
      : t('api.serverActivate', { status: response.status })
    throw new Error(detail)
  }

  const status = await response.json() as PremiumStatus
  const updatedProfile: UserProfile = {
    ...user,
    is_premium: true,
    premium_plan: status.plan,
    premium_started_at: status.started_at,
    premium_expires_at: status.expires_at,
    premium_cancel_at_period_end: false,
  }

  try {
    localStorage.setItem('booost_user', JSON.stringify(updatedProfile))
  } catch {
    // The server response is still authoritative when browser storage is unavailable.
  }
  clearDashboardCache()
  window.dispatchEvent(new Event(PREMIUM_UPDATED_EVENT))
  return status
}

export async function cancelPremium(): Promise<void> {
  const response = await apiFetch(`${API_URL}/api/v1/premium/cancel`, {
    method: 'POST',
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('profile.errorCancel'))
  }

  const status = await response.json() as { expires_at: string }
  const user = getCurrentUser()
  if (user) {
    try {
      localStorage.setItem('booost_user', JSON.stringify({
        ...user,
        premium_expires_at: status.expires_at,
        premium_cancel_at_period_end: true,
      }))
    } catch {
      // The server response is still authoritative when browser storage is unavailable.
    }
  }
  window.dispatchEvent(new Event(PREMIUM_UPDATED_EVENT))
}

async function muscleFocusRequest(init: RequestInit): Promise<string | null> {
  const response = await apiFetch(`${API_URL}/api/v1/settings/muscle-focus`, { ...init, signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) })
  if (!response.ok) throw new Error(t('api.saveSettings'))
  return ((await response.json()) as { muscle: string | null }).muscle
}

export function fetchMuscleFocus(): Promise<string | null> {
  return muscleFocusRequest({})
}

export function saveMuscleFocus(muscle: string | null): Promise<string | null> {
  return muscleFocusRequest({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muscle }) })
}

export async function updateUserSettings(
  userId: string,
  settings: { age: number; weight: number; height: number; gender: string; objective: string },
): Promise<void> {
  const query = new URLSearchParams({ user_id: userId })
  const response = await apiFetch(`${API_URL}/api/v1/settings/update?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(t('api.saveSettings'))
  }

  try {
    const user = getCurrentUser()
    if (user?.id === userId) {
      localStorage.setItem('booost_user', JSON.stringify({ ...user, ...settings }))
    }
    localStorage.removeItem(`${DASHBOARD_CACHE_PREFIX}${userId}`)
  } catch {
    // The saved server response remains authoritative if browser storage is unavailable.
  }
  clearDashboardCache()
}

export interface MealIngredient {
  name: string
  quantity_g: number
  calories_per_100g: number
  proteins_per_100g: number
  carbs_per_100g: number
  fats_per_100g: number
}

export interface MealLogItem {
  id: string
  user_id: string
  meal_name: string
  meal_type: string
  portion_amount: string
  weight_g: string
  item_calories: number
  consumed_at?: string
  proteins_g?: number
  carbs_g?: number
  fats_g?: number
  ingredients?: MealIngredient[]
  ingredient_details_saved?: boolean
}

export interface TodayNutritionData {
  consumed_calories: number
  daily_goal: number
  calories_progress_percentage: number
  remaining_calories: number
  target_proteins_g: number
  target_carbs_g: number
  target_fats_g: number
  remaining_proteins_g: number
  remaining_carbs_g: number
  remaining_fats_g: number
  carbs_g: number
  proteins_g: number
  fats_g: number
  meals: MealLogItem[]
}

export function localDayWindow(dateString?: string): { today_start: string; today_end: string } {
  const start = new Date()
  if (dateString) {
    const parts = dateString.split('-')
    if (parts.length === 3) {
      start.setFullYear(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10))
    }
  }
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { today_start: start.toISOString(), today_end: end.toISOString() }
}

function localDayQuery(): string {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return new URLSearchParams({ today, ...localDayWindow() }).toString()
}

function nutritionCacheKey(userId: string, windowStart: string): string {
  return `${NUTRITION_CACHE_PREFIX}${userId}:${windowStart}`
}

/** The last copy of a day's meals saved on this device, however old; the page refreshes it. */
export function getSavedDayNutrition(userId: string, dateString?: string): TodayNutritionData | null {
  return userId ? readSavedCopy<TodayNutritionData>(`nutrition:${userId}:${localDayWindow(dateString).today_start}`) : null
}

export function getCachedTodayNutrition(userId: string, dateString?: string): TodayNutritionData | null {
  if (!userId) return null
  try {
    const window = localDayWindow(dateString)
    const saved = sessionStorage.getItem(nutritionCacheKey(userId, window.today_start))
    if (!saved) return null
    const cached = JSON.parse(saved) as { data: TodayNutritionData; at: number }
    if (!cached?.data || typeof cached.at !== 'number') return null
    if (Date.now() - cached.at > NUTRITION_CACHE_TTL_MS) return null
    return cached.data
  } catch {
    return null
  }
}

export async function fetchTodayNutrition(userId: string, dateString?: string): Promise<TodayNutritionData> {
  const window = localDayWindow(dateString)
  const requestKey = `${userId}:${window.today_start}`
  const existing = nutritionRequests.get(requestKey)
  if (existing) return existing

  const request = apiFetch(
    `${API_URL}/api/v1/nutrition/today?user_id=${encodeURIComponent(userId)}&today_start=${encodeURIComponent(window.today_start)}&today_end=${encodeURIComponent(window.today_end)}`,
    { signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS) },
  )
    .then((response) => {
      if (!response.ok) throw new Error(t('api.loadNutrition'))
      return response.json() as Promise<TodayNutritionData>
    })
    .then((data) => {
      try {
        sessionStorage.setItem(
          nutritionCacheKey(userId, window.today_start),
          JSON.stringify({ data, at: Date.now() }),
        )
        saveCopy(`nutrition:${userId}:${window.today_start}`, data)
      } catch {
        // The fresh response remains usable when browser storage is unavailable.
      }
      return data
    })
    .finally(() => nutritionRequests.delete(requestKey))

  nutritionRequests.set(requestKey, request)
  return request
}

export interface CalorieAdjustmentData {
  adjustment_id: string | null
  previous_goal: number
  proposed_goal: number
  has_change: boolean
  reason: string
  status: 'pending' | 'accepted' | 'rejected' | 'advice'
  objective: string
  avg_daily_intake: number
  compliance_rate: number
  weekly_volume: number
  fatigue_avg: number
  fatigue_latest: number
  fatigue_workouts: number
  activity: HealthActivitySummary
}

export async function fetchCalorieAdjustment(userId: string): Promise<CalorieAdjustmentData> {
  const existing = adjustmentRequests.get(userId)
  if (existing) return existing

  const request = apiFetch(
    `${API_URL}/api/v1/ai/calorie-adjustment?user_id=${encodeURIComponent(userId)}`,
    { signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS) },
  )
    .then((response) => {
      if (!response.ok) throw new Error(t('api.checkProgress'))
      return response.json() as Promise<CalorieAdjustmentData>
    })
    .finally(() => adjustmentRequests.delete(userId))

  adjustmentRequests.set(userId, request)
  return request
}

export async function decideCalorieAdjustment(
  userId: string,
  adjustmentId: string,
  status: 'accepted' | 'rejected',
): Promise<{ calorie_goal: number }> {
  const response = await apiFetch(`${API_URL}/api/v1/ai/calorie-adjustment/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, adjustment_id: adjustmentId, status }),
  })
  if (!response.ok) {
    throw new Error(t('add.errorGoal'))
  }
  return response.json()
}

export interface AiTip {
  id: string
  kind: string
  message: string
  reasoning: string
}

export interface AiTipDecision {
  tip: AiTip | null
  applied: boolean
  notice: string | null
  confirmation: string | null
}

function clearGoalCaches(): void {
  clearDashboardCache()
  nutritionRequests.clear()
  try {
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(NUTRITION_CACHE_PREFIX))
      .forEach((key) => sessionStorage.removeItem(key))
  } catch {
    // The next nutrition request remains authoritative if browser storage is unavailable.
  }
}

export function fetchCurrentTip(): Promise<AiTip | null> {
  return cachedRequest(`tip:${getCurrentUser()?.id ?? ''}:${localDayQuery()}`, loadCurrentTip)
}

async function loadCurrentTip(): Promise<AiTip | null> {
  const response = await apiFetch(`${API_URL}/api/v1/ai/tips/current?${localDayQuery()}`, { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) })
  if (!response.ok) throw new Error(t('api.loadTip'))
  return ((await response.json()) as { tip: AiTip | null }).tip
}

export async function decideTip(tipId: string, status: 'accepted' | 'dismissed'): Promise<AiTipDecision> {
  const response = await apiFetch(`${API_URL}/api/v1/ai/tips/${encodeURIComponent(tipId)}/decision?${localDayQuery()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(t('api.updateTip'))
  forgetCachedTip()
  if (status === 'accepted') clearGoalCaches()
  return response.json() as Promise<AiTipDecision>
}

export async function undoTip(tipId: string): Promise<AiTipDecision> {
  const response = await apiFetch(`${API_URL}/api/v1/ai/tips/${encodeURIComponent(tipId)}/undo?${localDayQuery()}`, {
    method: 'POST',
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(t('api.undo'))
  forgetCachedTip()
  clearGoalCaches()
  return response.json() as Promise<AiTipDecision>
}

export class ChatLimitError extends Error {}

async function chatRequest<T>(path: string, fallback: string, init: RequestInit = {}, timeout = WRITE_TIMEOUT_MS): Promise<T> {
  let response: Response
  try {
    response = await apiFetch(`${API_URL}/api/v1/ai/chat/${path}`, { ...init, signal: AbortSignal.timeout(timeout) })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error(t('api.trainerSlow'), { cause: error })
    throw error
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: unknown }
    const detail = typeof body.detail === 'string' ? body.detail : fallback
    throw response.status === 429 ? new ChatLimitError(detail) : new Error(detail)
  }
  return response.json() as Promise<T>
}

export function sendChatMessage(content: string, conversationId?: string): Promise<ChatReply> {
  return chatRequest<ChatReply>(`messages?${localDayQuery()}`, t('coach.errorSend'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, conversation_id: conversationId ?? null }),
  }, CHAT_TIMEOUT_MS)
}

export function listChatConversations(): Promise<ConversationSummary[]> {
  return chatRequest<ConversationSummary[]>('conversations', t('coach.errorLoad'))
}

export function getChatConversation(conversationId: string): Promise<ConversationDetail> {
  return chatRequest<ConversationDetail>(`conversations/${encodeURIComponent(conversationId)}`, t('coach.errorLoad'))
}

export function getChatQuota(): Promise<ChatQuota> {
  return chatRequest<ChatQuota>('quota', t('coach.errorLoad'))
}

export interface FoodSearchItem {
  id: string
  name: string
  calories_per_100g: number
  proteins_per_100g: number
  carbs_per_100g: number
  fats_per_100g: number
  category?: string
}

export async function searchFoodItems(query = ''): Promise<FoodSearchItem[]> {
  const response = await apiFetch(`${API_URL}/api/v1/nutrition/search-foods?q=${encodeURIComponent(query)}`)
  if (!response.ok) {
    throw new Error(t('add.errorSearch'))
  }
  return response.json()
}

export interface MealCreateRequest {
  user_id: string
  name: string
  calories?: number
  quantity_g?: number
  meal_type?: string
  proteins?: number
  carbs?: number
  fats?: number
  ingredients?: MealIngredient[]
  /** ISO instant the meal was eaten; omitted means now. */
  consumed_at?: string
}

function clearNutritionCache(): void {
  invalidateNutritionStatisticsCache()
  try {
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(NUTRITION_CACHE_PREFIX))
      .forEach((key) => sessionStorage.removeItem(key))
  } catch {
    // The server stays authoritative when browser storage is unavailable.
  }
}

export interface FavoriteMeal {
  id: string
  name: string
  meal_type: string
  calories: number
  proteins_g: number
  carbs_g: number
  fats_g: number
  quantity_g: number
  ingredients: MealIngredient[]
  created_at?: string
}

async function favoriteRequest<T>(path: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await apiFetch(`${API_URL}/api/v1/nutrition/favorites${path}`, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : fallback)
  }
  return response.json() as Promise<T>
}

export function fetchFavoriteMeals(): Promise<FavoriteMeal[]> {
  return favoriteRequest('', {}, t('api.loadFavorites'))
}

export function addFavoriteMeal(mealId: string): Promise<FavoriteMeal> {
  return favoriteRequest('', { method: 'POST', body: JSON.stringify({ meal_id: mealId }) }, t('api.saveFavorite'))
}

export function updateFavoriteMeal(
  favoriteId: string,
  payload: { name: string; meal_type: string; ingredients: MealIngredient[] },
): Promise<FavoriteMeal> {
  return favoriteRequest(`/${encodeURIComponent(favoriteId)}`, { method: 'PUT', body: JSON.stringify(payload) }, t('api.updateFavorite'))
}

export async function deleteFavoriteMeal(favoriteId: string): Promise<void> {
  await favoriteRequest(`/${encodeURIComponent(favoriteId)}`, { method: 'DELETE' }, t('api.removeFavorite'))
}

export interface MealScanItem {
  name: string
  grams: number
  calories: number
  protein_g: number
  carbs_g: number
  fat_g: number
}

export interface MealScanResult {
  items: MealScanItem[]
  total_calories: number
  notes: string | null
}

export async function scanMealPhoto(image: Blob): Promise<MealScanResult> {
  const file = image instanceof File
    ? image
    : new File([image], 'meal.jpg', { type: 'image/jpeg' })
  const form = new FormData()
  form.append('file', file)
  const response = await apiFetch(`${API_URL}/api/v1/nutrition/scan`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(
      typeof body?.detail === 'string'
        ? body.detail
        : t('scan.errorAnalyze'),
    )
  }
  return response.json() as Promise<MealScanResult>
}

export async function addMealLog(payload: MealCreateRequest): Promise<MealLogItem> {
  const response = await apiFetch(`${API_URL}/api/v1/nutrition/meals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('add.errorSave'))
  }
  clearDashboardCache()
  clearNutritionCache()
  return response.json()
}

export async function updateMealLog(
  userId: string,
  mealId: string,
  payload: { name: string; meal_type: string; ingredients: MealIngredient[] },
): Promise<MealLogItem> {
  const query = new URLSearchParams({ user_id: userId })
  const response = await apiFetch(`${API_URL}/api/v1/nutrition/meals/${encodeURIComponent(mealId)}?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.updateMeal'))
  }
  clearDashboardCache()
  try {
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(NUTRITION_CACHE_PREFIX))
      .forEach((key) => sessionStorage.removeItem(key))
  } catch {
    // The updated server response remains authoritative when browser storage is unavailable.
  }
  return response.json() as Promise<MealLogItem>
}

export async function deleteMealLog(userId: string, mealId: string): Promise<void> {
  const query = new URLSearchParams({ user_id: userId })
  const response = await apiFetch(`${API_URL}/api/v1/nutrition/meals/${encodeURIComponent(mealId)}?${query}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.removeMeal'))
  }
  clearDashboardCache()
  try {
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(NUTRITION_CACHE_PREFIX))
      .forEach((key) => sessionStorage.removeItem(key))
  } catch {
    // The server-side deletion remains authoritative when browser storage is unavailable.
  }
}

export interface HydrationEntry {
  id: string
  amount_ml: number
  unit: 'ml' | 'glass'
  created_at: string | null
}

export interface HydrationToday {
  total_ml: number
  goal_ml: number
  default_goal_ml: number
  progress_percentage: number
  remaining_ml: number
  entries: HydrationEntry[]
}

// Today's water, kept in memory for the local day, so Home and Nutrition show it at once on the
// next visit while a fresh copy loads. clearSession drops it.
let lastHydration: { day: string; value: HydrationToday } | null = null

/** The last known water for today, or null when there is none for this local day. */
export function cachedHydrationToday(): HydrationToday | null {
  return lastHydration?.day === localDayQuery() ? lastHydration.value : null
}

/** Records the latest water for today, including the answer to an add or a goal change. */
export function rememberHydration(value: HydrationToday): HydrationToday {
  lastHydration = { day: localDayQuery(), value }
  return value
}

export async function fetchHydrationToday(): Promise<HydrationToday> {
  const response = await apiFetch(`${API_URL}/api/v1/hydration/today?${localDayQuery()}`, {
    signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(t('api.loadHydration'))
  }
  return rememberHydration(await response.json())
}

export interface HydrationHistoryDay {
  date: string
  total_ml: number
  goal_ml: number
  progress_percentage: number
  met_goal: boolean
}

export interface HydrationHistoryWeek {
  week_start: string
  week_end: string
  goal_ml: number
  default_goal_ml: number
  total_ml: number
  daily_average_ml: number
  days_met_goal: number
  entries_count: number
  days: HydrationHistoryDay[]
}

export async function fetchHydrationHistory(weekStart?: string): Promise<HydrationHistoryWeek> {
  const params = new URLSearchParams(localDayQuery())
  if (weekStart) params.set('week_start', weekStart)
  const response = await apiFetch(`${API_URL}/api/v1/hydration/history?${params.toString()}`, {
    signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(t('api.loadHydrationHistory'))
  }
  return response.json()
}

export async function addHydrationEntry(payload: { amount: number; unit: 'ml' | 'glass' }): Promise<HydrationToday> {
  const response = await apiFetch(`${API_URL}/api/v1/hydration/entries?${localDayQuery()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.saveDrink'))
  }
  invalidateNutritionStatisticsCache()
  return response.json()
}

export async function removeHydrationEntry(entryId: string): Promise<HydrationToday> {
  const response = await apiFetch(`${API_URL}/api/v1/hydration/entries/${encodeURIComponent(entryId)}?${localDayQuery()}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.removeDrink'))
  }
  invalidateNutritionStatisticsCache()
  return response.json()
}

export async function updateHydrationGoal(goalMl: number | null): Promise<HydrationToday> {
  const response = await apiFetch(`${API_URL}/api/v1/hydration/goal?${localDayQuery()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal_ml: goalMl }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.updateHydrationGoal'))
  }
  return response.json()
}

export async function createCustomExercise(userId: string, payload: import('../types').CustomExercisePayload): Promise<import('../types').Exercise> {
  const response = await apiFetch(`${API_URL}/api/v1/workouts/exercises/custom?user_id=${encodeURIComponent(userId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.createExercise'))
  }
  exerciseListCache.clear()
  return response.json()
}

export async function updateCustomExercise(userId: string, exerciseId: string, payload: import('../types').CustomExercisePayload): Promise<import('../types').Exercise> {
  const response = await apiFetch(`${API_URL}/api/v1/workouts/exercises/custom/${encodeURIComponent(exerciseId)}?user_id=${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.updateExercise'))
  }
  exerciseListCache.clear()
  return response.json()
}

export async function deleteCustomExercise(userId: string, exerciseId: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/api/v1/workouts/exercises/custom/${encodeURIComponent(exerciseId)}?user_id=${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('api.deleteExercise'))
  }
  exerciseListCache.clear()
}
export interface MealRecommendation {
  id: string
  name: string
  meal_type: string
  calories: number
  proteins_g: number
  carbs_g: number
  fats_g: number
  quantity_g: number
  ingredients: MealIngredient[]
  reason: string | null
  source: 'ai' | 'rules'
  status: 'pending' | 'added' | 'dismissed'
}

export interface MealRecommendations {
  remaining_calories: number
  remaining_proteins_g: number
  remaining_carbs_g: number
  remaining_fats_g: number
  goal_reached: boolean
  refreshes_left: number
  items: MealRecommendation[]
}

async function recommendationRequest<T>(path: string, method: 'GET' | 'POST', fallback: string): Promise<T> {
  // The local day lets the server keep suggestions to today only.
  const response = await apiFetch(`${API_URL}/api/v1/nutrition/recommendations${path}?${localDayQuery()}`, {
    method,
    // Picking with the model can take a few seconds on the first open of the day.
    signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS * 2),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    const message = typeof body?.detail === 'string' ? body.detail : fallback
    throw response.status === 403 ? new PremiumRequiredError(message) : new Error(message)
  }
  return response.json() as Promise<T>
}

export function fetchMealRecommendations(): Promise<MealRecommendations> {
  return recommendationRequest('', 'GET', t('api.loadSuggestions'))
}

export function refreshMealRecommendations(): Promise<MealRecommendations> {
  return recommendationRequest('/refresh', 'POST', t('api.newSuggestions'))
}

export async function addMealRecommendation(id: string): Promise<MealLogItem> {
  const meal = await recommendationRequest<MealLogItem>(`/${encodeURIComponent(id)}/add`, 'POST', t('api.addMeal'))
  clearDashboardCache()
  clearNutritionCache()
  return meal
}

export async function dismissMealRecommendation(id: string): Promise<void> {
  await recommendationRequest(`/${encodeURIComponent(id)}/dismiss`, 'POST', t('api.hideSuggestion'))
}

export interface FatigueFeedbackPayload {
  fatigue_level: number
  soreness_level: number
  sleep_quality: 'restorative' | 'average' | 'poor'
  joint_strain: 'none' | 'mild' | 'sharp'
  sore_muscles: string[]
  notes?: string
}

export interface FatigueFeedbackEntry {
  id: string
  fatigue_level: number
  soreness_level: number
  sleep_quality: 'restorative' | 'average' | 'poor'
  joint_strain: 'none' | 'mild' | 'sharp'
  sore_muscles: string[]
  notes?: string | null
  created_at: string
}

export type OvertrainingSeverity = 'ok' | 'watch' | 'high'

export interface OvertrainingSignal {
  id: string
  label: string
  value: string
  detail: string
  severity: OvertrainingSeverity
}

export interface MuscleStrainSummary {
  muscle_group: string
  sets_7d: number
  hours_since_trained: number | null
  reported_sore: boolean
  status: OvertrainingSeverity
}

export interface OvertrainingAlertStatus {
  has_alert: boolean
  risk_level: 'none' | 'moderate' | 'high'
  readiness_score: number
  acwr: number | null
  load_increase_pct: number
  sessions_last_7_days: number
  total_sets_last_7_days: number
  high_rpe_sets_count: number
  consecutive_training_days: number
  avg_workout_fatigue_7d: number | null
  latest_workout_fatigue: number | null
  repeated_fatigue_reports: number
  strained_muscles: string[]
  muscle_strain: MuscleStrainSummary[]
  signals: OvertrainingSignal[]
  recent_checkins: FatigueFeedbackEntry[]
  headline: string
  summary: string
  recommendations: string[]
  volume_reduction_pct: number
  deload_active: boolean
  deload_expires_at: string | null
  rest_day_scheduled: boolean
  dismissed: boolean
}

export function clearOvertrainingCache(): void {
  for (const key of [...shortCache.keys()]) {
    if (key.startsWith('overtraining:')) shortCache.delete(key)
  }
  forgetSavedCopies('overtraining:')
}

export function getSavedOvertrainingAlerts(userId: string | undefined = getCurrentUser()?.id): OvertrainingAlertStatus | null {
  return userId ? readSavedCopy<OvertrainingAlertStatus>(`overtraining:${userId}`) : null
}

function syncDeloadMirror(userId: string, status: OvertrainingAlertStatus): void {
  const key = overtrainingModPctStorageKey(userId)
  if (!key) return
  try {
    if (status.deload_active && status.volume_reduction_pct > 0) {
      localStorage.setItem(key, String(status.volume_reduction_pct))
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // Ignore storage quota or restriction errors.
  }
}

export async function fetchOvertrainingAlerts(
  options: { forceRefresh?: boolean } = {},
): Promise<OvertrainingAlertStatus> {
  const userId = getCurrentUser()?.id
  if (!userId) throw new Error(t('api.signInRecovery'))
  const cacheKey = `overtraining:${userId}:${localDayQuery()}`
  if (options.forceRefresh) shortCache.delete(cacheKey)

  return cachedRequest(cacheKey, async () => {
    const response = await apiFetch(
      `${API_URL}/api/v1/workouts/overtraining-alerts?${localDayQuery()}`,
      { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    )
    if (!response.ok) {
      throw new Error(t('api.checkRecovery'))
    }
    const status = (await response.json()) as OvertrainingAlertStatus
    saveCopy(`overtraining:${userId}`, status)
    syncDeloadMirror(userId, status)
    return status
  })
}

async function postOvertrainingMutation(
  path: string,
  method: 'POST' | 'DELETE',
  fallbackError: string,
  body?: unknown,
  invalidateDashboard = false,
): Promise<OvertrainingAlertStatus> {
  const userId = getCurrentUser()?.id
  if (!userId) throw new Error(t('api.signInRecoveryUpdate'))
  const response = await apiFetch(`${API_URL}/api/v1/workouts${path}?${localDayQuery()}`, {
    method,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const errBody = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof errBody?.detail === 'string' ? errBody.detail : fallbackError)
  }
  const status = (await response.json()) as OvertrainingAlertStatus
  clearOvertrainingCache()
  if (invalidateDashboard) clearDashboardCache()
  saveCopy(`overtraining:${userId}`, status)
  syncDeloadMirror(userId, status)
  return status
}

export function submitFatigueFeedback(payload: FatigueFeedbackPayload): Promise<OvertrainingAlertStatus> {
  return postOvertrainingMutation(
    '/fatigue-feedback',
    'POST',
    t('api.saveCheckIn'),
    payload,
  )
}

export function deleteFatigueFeedback(entryId: string): Promise<OvertrainingAlertStatus> {
  return postOvertrainingMutation(
    `/fatigue-feedback/${encodeURIComponent(entryId)}`,
    'DELETE',
    t('ot.errorDeleteCheckIn'),
  )
}

export function applyOvertrainingMods(): Promise<OvertrainingAlertStatus> {
  return postOvertrainingMutation(
    '/overtraining-alerts/apply',
    'POST',
    t('ot.errorDeloadApply'),
    undefined,
    true,
  )
}

export function clearOvertrainingMods(): Promise<OvertrainingAlertStatus> {
  return postOvertrainingMutation(
    '/overtraining-alerts/apply',
    'DELETE',
    t('ot.errorDeloadOff'),
    undefined,
    true,
  )
}

export function scheduleRecoveryRestDay(): Promise<OvertrainingAlertStatus> {
  return postOvertrainingMutation(
    '/overtraining-alerts/rest-day',
    'POST',
    t('ot.errorRestSwap'),
    undefined,
    true,
  )
}

export function dismissOvertrainingAlert(): Promise<OvertrainingAlertStatus> {
  return postOvertrainingMutation(
    '/overtraining-alerts/dismiss',
    'POST',
    t('ot.errorDismiss'),
  )
}

// Saved copies hold server text in the old language; drop them so the next load is in the new one.
onLanguageChange(() => {
  clearDashboardCache()
  forgetSavedCopies()
})

// --- Community ---

/** Photo links are either direct CDN signed URLs or relative API proxy paths. */
export function mediaUrl(path: string): string {
  return /^https?:\/\//i.test(path) ? path : `${API_URL}${path}`
}

const SOCIAL_ME_KEY = 'social:me'
// Signed CDN URLs live 2 h; keeping local snapshots for 25 min makes reloads & tab switches instant
// while ensuring photo URLs are always well within their valid window.
const SOCIAL_SNAPSHOT_TTL_MS = 25 * 60 * 1000
const FEED_INITIAL_LIMIT = 8
const FEED_MORE_LIMIT = 16
let lastSocialMeValue: SocialMe | null = null
const preloadedMedia = new Set<string>()
const MAX_PRELOADED_MEDIA = 200

function socialSnapshotKey(name: string): string | null {
  const userId = getCurrentUser()?.id
  return userId ? `social:${userId}:${name}` : null
}

function readSocialSnapshot<T>(name: string): T | null {
  const key = socialSnapshotKey(name)
  if (!key) return null
  const saved = readSavedCopy<{ data: T; at: number }>(key)
  if (!saved || typeof saved.at !== 'number' || Date.now() - saved.at > SOCIAL_SNAPSHOT_TTL_MS) return null
  return saved.data
}

function writeSocialSnapshot<T>(name: string, data: T): void {
  const key = socialSnapshotKey(name)
  if (!key) return
  saveCopy(key, { data, at: Date.now() })
}

function dropSocialSnapshot(name: string): void {
  const key = socialSnapshotKey(name)
  if (!key) return
  forgetSavedCopies(key)
}

/** Warms the browser image cache for the top 2 visible posts' lead photo and avatars without choking bandwidth. */
function preloadFeedMedia(posts: Post[], count = 2) {
  if (typeof Image === 'undefined') return
  const urls: string[] = []
  for (const post of posts.slice(0, count)) {
    if (post.author.avatar_url) urls.push(mediaUrl(post.author.avatar_url))
    if (post.image_urls[0]) urls.push(mediaUrl(post.image_urls[0]))
  }
  for (const url of urls) {
    if (preloadedMedia.has(url)) continue
    if (preloadedMedia.size >= MAX_PRELOADED_MEDIA) preloadedMedia.clear()
    preloadedMedia.add(url)
    const img = new Image()
    img.decoding = 'async'
    img.src = url
  }
}

/** Remembered signed-in social profile (RAM or fresh localStorage snapshot) so Community renders at once. */
export function lastSocialMe(): SocialMe | null {
  if (lastSocialMeValue) return lastSocialMeValue
  const saved = readSocialSnapshot<SocialMe>('me')
  if (saved) lastSocialMeValue = saved
  return lastSocialMeValue
}

function rememberSocialMe(value: SocialMe): SocialMe {
  lastSocialMeValue = value
  writeSocialSnapshot('me', value)
  return value
}
// The first page of each feed: the request in flight is shared, and the last answer is shown at once
// next time while a fresh one loads. Memory only, because photo links expire.
const feedRequests = new Map<FeedMode, Promise<FeedPage>>()
const lastFeeds = new Map<FeedMode, FeedPage>()

/** A post already shown in a feed, so its page can draw it at once while the fresh copy loads. */
export function cachedPost(id: string): Post | null {
  for (const page of lastFeeds.values()) {
    const found = page.items.find((item) => item.id === id)
    if (found) return found
  }
  return null
}
let feedEpoch = 0

/** Drops in-flight feed reads started before a mutation so stale data cannot overwrite newer state. */
function invalidateInFlightFeeds() {
  feedEpoch += 1
  feedRequests.clear()
}

function updateCachedFeeds(transform: (items: Post[]) => Post[]) {
  for (const [mode, page] of lastFeeds) {
    const next = { ...page, items: transform(page.items) }
    lastFeeds.set(mode, next)
    writeSocialSnapshot(`feed:${mode}`, next)
  }
}

async function social<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Any change (follow, block, photo, settings…) can change the counts and photo on /me.
  if (init.method && init.method !== 'GET') shortCache.delete(SOCIAL_ME_KEY)
  const response = await apiFetch(`${API_URL}/api/v1/social${path}`, {
    ...init,
    signal: AbortSignal.timeout(init.body instanceof FormData ? SCAN_TIMEOUT_MS : WRITE_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    throw new Error(typeof body?.detail === 'string' ? body.detail : t('community.error'))
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

// URLSearchParams matters: a cursor holds a "+", which would otherwise arrive as a space.
function beforeQuery(before?: string): string {
  return before ? new URLSearchParams({ before }).toString() : ''
}

// Community, Profile and Friends all need it; shared for 30 seconds instead of asked three times.
export const fetchSocialMe = () => cachedRequest(SOCIAL_ME_KEY, () => social<SocialMe>('/me').then(rememberSocialMe))
export const joinCommunity = (username: string, isPrivate: boolean) =>
  social<SocialMe>('/me/join', jsonBody('POST', { username, is_private: isPrivate })).then(rememberSocialMe)
export const updateSocialMe = (changes: { username?: string; is_private?: boolean }) =>
  social<SocialMe>('/me', jsonBody('PATCH', changes)).then(rememberSocialMe)
export const removeAvatar = () => social<SocialMe>('/me/avatar', { method: 'DELETE' }).then(rememberSocialMe)

export function uploadAvatar(photo: Blob): Promise<SocialMe> {
  const form = new FormData()
  form.append('file', photo, 'avatar.jpg')
  return social<SocialMe>('/me/avatar', { method: 'PUT', body: form }).then(rememberSocialMe)
}

export function fetchFeed(mode: FeedMode, before?: string): Promise<FeedPage> {
  if (before) {
    return social<FeedPage>(`/feed?mode=${mode}&limit=${FEED_MORE_LIMIT}&${beforeQuery(before)}`).then((page) => {
      preloadFeedMedia(page.items, 1)
      return page
    })
  }
  const running = feedRequests.get(mode)
  if (running) return running
  const startedAt = feedEpoch
  const request = social<FeedPage>(`/feed?mode=${mode}&limit=${FEED_INITIAL_LIMIT}`)
    .then((page) => {
      if (feedEpoch === startedAt) {
        lastFeeds.set(mode, page)
        writeSocialSnapshot(`feed:${mode}`, page)
        preloadFeedMedia(page.items, 2)
      }
      return page
    })
    .finally(() => {
      if (feedRequests.get(mode) === request) feedRequests.delete(mode)
    })
  feedRequests.set(mode, request)
  return request
}

/** The feed page shown last time (RAM or fresh localStorage snapshot), to display at once while fresh loads. */
export function lastFeedPage(mode: FeedMode): FeedPage | null {
  const mem = lastFeeds.get(mode)
  if (mem) return mem
  const saved = readSocialSnapshot<FeedPage>(`feed:${mode}`)
  if (saved) {
    lastFeeds.set(mode, saved)
    return saved
  }
  return null
}

/** Keeps the remembered feeds in step with a post that just changed, so going back shows it. */
function rememberPost(post: Post) {
  updateCachedFeeds((items) => items.map((item) => (
    item.id === post.id ? { ...item, liked_by_me: post.liked_by_me, like_count: post.like_count } : item
  )))
}

/** Keeps cached feed comment counters aligned when comments are added or removed. */
export function rememberCommentCount(postId: string, delta: number) {
  invalidateInFlightFeeds()
  updateCachedFeeds((items) => items.map((item) => (
    item.id === postId ? { ...item, comment_count: Math.max(0, item.comment_count + delta) } : item
  )))
}

/** Your new post goes to the top of the remembered feeds; the next fetch confirms it. */
export function rememberNewPost(post: Post) {
  invalidateInFlightFeeds()
  const targets: FeedMode[] = post.author.is_private ? ['following'] : ['following', 'discover']
  for (const mode of targets) {
    const page = lastFeeds.get(mode)
    if (page) {
      const next = { ...page, items: [post, ...page.items.filter((item) => item.id !== post.id)] }
      lastFeeds.set(mode, next)
      writeSocialSnapshot(`feed:${mode}`, next)
    }
  }
}
export const fetchPost = (id: string) => social<Post>(`/posts/${encodeURIComponent(id)}`)
export const deletePost = (id: string) =>
  social<void>(`/posts/${id}`, { method: 'DELETE' }).then(() => {
    invalidateInFlightFeeds()
    updateCachedFeeds((items) => items.filter((item) => item.id !== id))
  })
export const setPostLike = (id: string, liked: boolean) => {
  invalidateInFlightFeeds()
  return social<Post>(`/posts/${id}/like`, { method: liked ? 'PUT' : 'DELETE' }).then((post) => {
    rememberPost(post)
    return post
  })
}

export function createPost(body: string, card: CardRef | null, photos: Blob[]): Promise<Post> {
  const form = new FormData()
  form.append('body', body)
  if (card) form.append('card', JSON.stringify(card))
  photos.forEach((photo, index) => form.append('images', photo, `photo-${index}.jpg`))
  return social<Post>(`/posts?${localDayQuery()}`, { method: 'POST', body: form })
}

export const fetchAttachables = () => social<Attachables>(`/attachables?${localDayQuery()}`)
export const fetchComments = (postId: string) => social<Comment[]>(`/posts/${encodeURIComponent(postId)}/comments`)
export const addComment = (postId: string, body: string) =>
  social<Comment>(`/posts/${encodeURIComponent(postId)}/comments`, jsonBody('POST', { body }))
export const deleteComment = (id: string) => social<void>(`/comments/${id}`, { method: 'DELETE' })

export const searchMembers = (q: string) => social<Member[]>(`/users?${new URLSearchParams({ q })}`)
export const fetchMember = (username: string) => social<MemberProfile>(`/users/${encodeURIComponent(username)}`)
export const fetchMemberPosts = (username: string, before?: string) =>
  social<FeedPage>(`/users/${encodeURIComponent(username)}/posts?${beforeQuery(before)}`)
export const fetchMemberList = (username: string, kind: 'followers' | 'following') =>
  social<Member[]>(`/users/${encodeURIComponent(username)}/${kind}`)

export const followMember = (id: string) =>
  social<MemberProfile>(`/users/${id}/follow`, { method: 'PUT' }).then((profile) => {
    invalidateInFlightFeeds()
    lastFeeds.delete('following')
    dropSocialSnapshot('feed:following')
    return profile
  })
export const unfollowMember = (id: string) =>
  social<void>(`/users/${id}/follow`, { method: 'DELETE' }).then(() => {
    invalidateInFlightFeeds()
    lastFeeds.delete('following')
    dropSocialSnapshot('feed:following')
  })
export const removeFollower = (id: string) => social<void>(`/followers/${id}`, { method: 'DELETE' })
export const fetchFollowRequests = () => social<Member[]>('/follow-requests')
export const acceptFollowRequest = (id: string) => social<void>(`/follow-requests/${id}/accept`, { method: 'POST' })
export const declineFollowRequest = (id: string) => social<void>(`/follow-requests/${id}`, { method: 'DELETE' })
export const blockMember = (id: string) =>
  social<void>(`/users/${id}/block`, { method: 'PUT' }).then(() => {
    invalidateInFlightFeeds()
    updateCachedFeeds((items) => items.filter((item) => item.author.id !== id))
  })
export const unblockMember = (id: string) =>
  social<void>(`/users/${id}/block`, { method: 'DELETE' }).then(() => {
    invalidateInFlightFeeds()
    lastFeeds.clear()
    dropSocialSnapshot('feed:following')
    dropSocialSnapshot('feed:discover')
  })
export const fetchBlocked = () => social<Member[]>('/blocks')
