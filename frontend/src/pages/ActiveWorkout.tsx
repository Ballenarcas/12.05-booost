import { ArrowDown, ArrowUp, Check, ChevronUp, Clock3, Crown, Dumbbell, Flame, Info, Minus, MoreVertical, Plus, Repeat2, Sparkles, Trash2, X, Play, Pause } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { usePageNavigate } from '../utils/usePageNavigate'
import { fetchExerciseById, fetchExercises, getCurrentUser, isPremiumActive, PremiumRequiredError, requestWarmupRecommendation, requestWorkoutAdjustment, saveWorkoutLog, updateWorkoutHistoryEntry, activeWorkoutStorageKey } from '../services/api'
import { describeError } from '../utils/errors.js'
import type { Exercise } from '../types'
import type {
  ActiveExercise,
  ActiveSession,
  LiveWorkoutAdjustmentAction,
  LiveWorkoutAdjustmentRequest,
  LiveWorkoutAdjustmentSuggestion,
  SetKind,
  WarmupRecommendation,
  WarmupRecommendationRequest,
  WorkoutLogCreate,
  WorkoutSet,
} from '../types/workout'
import { useDialogBehavior } from '../utils/useDialogBehavior'
import { applyAdjustments, reindexKeyedMap } from '../utils/workoutAdjustments'

import { SelectExerciseModal } from '../components/layout/SelectExerciseModal'
import SwipeToDeleteRow from '../components/workout/SwipeToDeleteRow'
import MediaCredit from '../components/workout/MediaCredit'
import WheelPickerSheet, { type WheelOption } from '../components/workout/WheelPickerSheet'
import RpeSheet from '../components/workout/RpeSheet'
import backIcon from '../assets/scan/back.svg'
import '../styles/active-workout.css'

const EXTREME_WEIGHT_WARNING_KG = 600
const DEFAULT_REST_SECONDS = 90
const REST_STEP_SECONDS = 15
// "off", then every 5 seconds up to 10 minutes.
const REST_OPTIONS: WheelOption<number | null>[] = [
  { value: null, label: 'off' },
  ...Array.from({ length: 120 }, (_, index) => {
    const seconds = (index + 1) * 5
    const minutes = Math.floor(seconds / 60)
    return { value: seconds, label: minutes ? `${minutes}min ${seconds % 60}s` : `${seconds}s` }
  }),
]
const ADJUSTMENT_ACTION_LABELS: Record<LiveWorkoutAdjustmentAction, string> = {
  reduce_load: 'Reduce the load',
  reduce_reps: 'Reduce the reps',
  drop_set: 'Turn the next set into a drop set',
  stop_exercise: 'Skip the remaining sets',
}
const FATIGUE_LABELS = [
  'Fresh', 'Easy', 'Light', 'Moderate', 'Solid',
  'Tired', 'Very tired', 'Drained', 'Exhausted', 'Maxed out',
]

function describeAdjustment(suggestion: LiveWorkoutAdjustmentSuggestion): string {
  const base = ADJUSTMENT_ACTION_LABELS[suggestion.action]
  if (suggestion.action === 'reduce_load' && typeof suggestion.new_weight_kg === 'number') {
    return `${base} to ${suggestion.new_weight_kg} kg`
  }
  if (suggestion.action === 'reduce_reps' && typeof suggestion.new_reps === 'number') {
    return `${base} to ${suggestion.new_reps}`
  }
  return base
}

type AiAdjustmentState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; suggestions: LiveWorkoutAdjustmentSuggestion[]; applied: number[] }
  | { status: 'error'; message: string }
type WarmupState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; recommendation: WarmupRecommendation }
  | { status: 'premium' }
  | { status: 'error'; message: string }
type AdjustmentUndo = {
  session: ActiveSession
  rpeValues: Record<string, number>
  restRemaining: Record<number, number>
  applied: number[]
}
type PendingSetRemoval = {
  exerciseIndex: number
  setIndex: number
  setNumber: number
  key: string
  set: WorkoutSet
  kind?: SetKind
  rpe?: number
  removed: boolean
}

function ExerciseArtwork({ name, images }: { name: string; images?: string[] }) {
  const [imageFailed, setImageFailed] = useState(false)
  const image = images?.find(Boolean)

  if (!image || imageFailed) {
    return <div className="active-exercise-artwork active-exercise-artwork-fallback" role="img" aria-label={`${name} image unavailable`}>
      <Dumbbell size={25} aria-hidden="true" />
    </div>
  }

  return <img className="active-exercise-artwork" src={image} alt={`${name} demonstration`} onError={() => setImageFailed(true)} />
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes === 0) return `${remaining}s`
  return `${minutes}min ${remaining}s`
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const remaining = (seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remaining}`
}

function formatRestLong(seconds: number): string {
  if (seconds < 120) return `${seconds} sec`
  return `${formatRest(seconds)} min`
}

function formatRest(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`
}

function formatWarmupDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `${minutes} min`
}

function formatPace(seconds: number, km: number | null | undefined): string {
  if (!km || km <= 0) return '';
  const secondsPerKm = seconds / km;
  const mins = Math.floor(secondsPerKm / 60);
  const secs = Math.floor(secondsPerKm % 60).toString().padStart(2, '0');
  return `${mins}:${secs} /km`;
}

function elapsedSeconds(startedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
}

function ElapsedTime({ startedAt, format }: { startedAt: string; format: (seconds: number) => string }) {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(startedAt))
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(elapsedSeconds(startedAt)), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return <>{format(seconds)}</>
}

function CardioTimerDisplay({ startedAt, accumulated }: { startedAt: string | null, accumulated: number }) {
  const [runningSeconds, setSeconds] = useState(() => {
    if (!startedAt) return accumulated;
    return accumulated + Math.floor((Date.now() - Date.parse(startedAt)) / 1000);
  })
  // A paused timer shows the stored total; only a running one ticks.
  const seconds = startedAt ? runningSeconds : accumulated

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => {
      setSeconds(accumulated + Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
    }, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt, accumulated])

  return <span className="cardio-clock" role="timer">{formatClock(seconds)}</span>
}

function CardioManualForm({ 
  initialMins,
  initialDist,
  onSave, 
  onCancel 
}: { 
  initialMins?: number,
  initialDist?: number,
  onSave: (mins: number, dist: number | null) => void, 
  onCancel: () => void 
}) {
  const [mins, setMins] = useState<string>(initialMins ? String(initialMins) : '');
  const [dist, setDist] = useState<string>(initialDist ? String(initialDist) : '');
  const [error, setError] = useState<string | null>(null);

  const handleSave = () => {
    const m = Number(mins);
    const d = dist ? Number(dist) : null;
    
    if (!mins || isNaN(m) || m < 1 || m > 1440) {
      setError('Duration must be between 1 and 1440 minutes.');
      return;
    }
    if (d !== null && (isNaN(d) || d < 0)) {
      setError('Distance cannot be negative.');
      return;
    }
    
    setError(null);
    onSave(m, d);
  }

  return (
    <div className="cardio-panel">
      <div className="cardio-fields">
        <div>
          <label className="cardio-label" htmlFor="cardio-minutes">Duration (min)</label>
          <input 
            id="cardio-minutes"
            className="cardio-input"
            type="number"
            inputMode="numeric"
            value={mins} 
            onChange={(e) => setMins(e.target.value)} 
            placeholder="e.g. 30"
          />
        </div>
        <div>
          <label className="cardio-label" htmlFor="cardio-distance">Distance (km)</label>
          <input 
            id="cardio-distance"
            className="cardio-input"
            type="number"
            inputMode="decimal"
            value={dist} 
            onChange={(e) => setDist(e.target.value)} 
            placeholder="Optional"
          />
        </div>
      </div>
      
      {error && <p className="form-error" role="alert">{error}</p>}
      
      <div className="cardio-actions">
        <button className="secondary-action" type="button" onClick={onCancel}>Cancel</button>
        <button className="primary-button" type="button" onClick={handleSave}>Save cardio</button>
      </div>
    </div>
  )
}

function finalizeCardioSet(set: WorkoutSet): WorkoutSet {
  if (set.cardio_status === 'running' || set.cardio_status === 'paused') {
    let finalSeconds = set.cardio_accumulated || 0
    if (set.cardio_status === 'running' && set.cardio_started_at) {
      finalSeconds += Math.max(0, Math.floor((Date.now() - Date.parse(set.cardio_started_at)) / 1000))
    }
    finalSeconds = Math.max(1, finalSeconds)
    return {
      ...set,
      cardio_status: 'finished',
      cardio_started_at: null,
      cardio_accumulated: finalSeconds,
      duration_seconds: finalSeconds,
      is_completed: true,
    }
  }
  // Only a block the user finished or ticked counts. A time alone (e.g. a hint) does not.
  if (set.cardio_status === 'finished' || set.is_completed) {
    const finalSeconds = Math.max(0, set.duration_seconds ?? set.cardio_accumulated ?? 0)
    return {
      ...set,
      cardio_status: 'finished',
      cardio_started_at: null,
      cardio_accumulated: finalSeconds,
      duration_seconds: finalSeconds,
      is_completed: finalSeconds > 0 || Boolean(set.distance_km && set.distance_km > 0) || set.is_completed,
    }
  }
  return set
}

// "Weighted" and "Assisted" variants are listed as their own equipment, so they still take a weight.
function isBodyweightOnly(equipment?: string[] | null): boolean {
  return !!equipment?.length && equipment.every((item) => item.trim().toLowerCase() === 'body weight')
}

function formatPrevious({ previous_weight_kg: weight, previous_reps: reps, is_bodyweight }: ActiveExercise): string {
  if (is_bodyweight) return reps ? `${reps} reps` : '–'
  if (weight === null || weight === undefined) return '–'
  return reps ? `${weight}×${reps}` : `${weight}`
}

function repsInputId(exerciseIndex: number, setNumber: number): string {
  return `reps-${exerciseIndex}-${setNumber}`
}

type SetNumberInputProps = {
  id?: string
  label: string
  value: number
  decimal?: boolean
  invalid?: boolean
  onChange: (value: number) => void
}

function SetNumberInput({ id, label, value, decimal = false, invalid = false, onChange }: SetNumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  return <input
    id={id}
    className={invalid ? 'is-missing' : undefined}
    aria-label={label}
    aria-invalid={invalid || undefined}
    type="text"
    inputMode={decimal ? 'decimal' : 'numeric'}
    autoComplete="off"
    value={draft ?? (value ? String(value) : '')}
    onFocus={(event) => event.target.select()}
    onBlur={() => setDraft(null)}
    onChange={(event) => {
      const text = event.target.value.replace(',', '.')
      if (!(decimal ? /^\d*\.?\d*$/ : /^\d*$/).test(text)) return
      setDraft(text)
      onChange(Number(text) || 0)
    }}
  />
}

function swapKeyedMapIndexes<T>(map: Record<string, T>, firstIndex: number, secondIndex: number): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(map)) {
    const [indexPart, ...rest] = key.split(':')
    const index = Number(indexPart)
    const nextIndex = index === firstIndex ? secondIndex : index === secondIndex ? firstIndex : index
    next[[nextIndex, ...rest].join(':')] = value
  }
  return next
}

function removeSetFromKeyedMap<T>(map: Record<string, T>, exerciseIndex: number, removedSetNumber: number): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(map)) {
    const [exercisePart, setPart, ...rest] = key.split(':')
    const currentExerciseIndex = Number(exercisePart)
    const currentSetNumber = Number(setPart)
    if (currentExerciseIndex === exerciseIndex && currentSetNumber === removedSetNumber) continue
    const nextSetNumber = currentExerciseIndex === exerciseIndex && currentSetNumber > removedSetNumber
      ? currentSetNumber - 1
      : currentSetNumber
    next[[exercisePart, nextSetNumber, ...rest].join(':')] = value
  }
  return next
}

function insertSetIntoKeyedMap<T>(map: Record<string, T>, exerciseIndex: number, setNumber: number, value?: T): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [key, currentValue] of Object.entries(map)) {
    const [exercisePart, setPart, ...rest] = key.split(':')
    const currentExerciseIndex = Number(exercisePart)
    const currentSetNumber = Number(setPart)
    const nextSetNumber = currentExerciseIndex === exerciseIndex && currentSetNumber >= setNumber
      ? currentSetNumber + 1
      : currentSetNumber
    next[[exercisePart, nextSetNumber, ...rest].join(':')] = currentValue
  }
  if (value !== undefined) next[`${exerciseIndex}:${setNumber}`] = value
  return next
}

function createSet(setNumber: number, source?: WorkoutSet): WorkoutSet {
  return { set_number: setNumber, weight_kg: source?.weight_kg ?? 0, reps: source?.reps ?? 0, is_completed: false }
}

function nullableNumber(value: unknown, min = 0): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= min ? number : null
}

function safeNumber(value: unknown, min = 0): number {
  return nullableNumber(value, min) ?? 0
}

function safeCount(value: unknown, min = 0): number {
  return Math.trunc(safeNumber(value, min))
}

function safeSetKind(value: unknown): SetKind {
  return value === 'warmup' || value === 'drop' || value === 'failure' ? value : 'normal'
}

function getSession(state: unknown): ActiveSession | null {
  if (!state || typeof state !== 'object' || !('name' in state) || !('exercises' in state)) return null
  const parsed = state as Partial<ActiveSession>
  return { ...parsed, setKinds: parsed.setKinds ?? {} } as ActiveSession
}

function buildWarmupRequest(session: ActiveSession, userGoal?: string | null): WarmupRecommendationRequest {
  return {
    name: session.name.trim() || 'Workout',
    user_goal: userGoal ?? null,
    exercises: session.exercises.map((exercise) => {
      const positiveWeights = exercise.sets
        .map((set) => safeNumber(set.weight_kg))
        .filter((weight) => weight > 0)
      const nextSet = exercise.sets.find((set) => !set.is_completed && safeNumber(set.weight_kg) > 0)
      const workingWeight = nextSet
        ? safeNumber(nextSet.weight_kg)
        : positiveWeights.length
          ? Math.max(...positiveWeights)
          : nullableNumber(exercise.previous_weight_kg)
      return {
        exercise_id: exercise.exercise_id,
        name: exercise.name,
        is_cardio: Boolean(exercise.is_cardio),
        working_weight_kg: workingWeight,
        target_reps: nullableNumber(exercise.target_reps),
      }
    }),
  }
}

function useScreenAwake() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    let isActive = true
    const requestLock = () => {
      if (document.visibilityState !== 'visible') return
      navigator.wakeLock?.request('screen')
        .then((sentinel) => {
          if (isActive) lock = sentinel
          else sentinel.release()
        })
        .catch(() => undefined)
    }
    requestLock()
    document.addEventListener('visibilitychange', requestLock)
    return () => {
      isActive = false
      document.removeEventListener('visibilitychange', requestLock)
      lock?.release().catch(() => undefined)
    }
  }, [])
}

function readSavedSession(): ActiveSession | null {
  try {
    const key = activeWorkoutStorageKey()
    if (!key) return null
    return getSession(JSON.parse(localStorage.getItem(key) ?? 'null'))
  } catch {
    return null
  }
}

function ActiveWorkout() {
  const navigate = usePageNavigate()
  const location = useLocation()
  useScreenAwake()
  const routeSession = getSession(location.state)
  const [session, setSession] = useState<ActiveSession | null>(() => routeSession ?? readSavedSession())
  const [workoutName, setWorkoutName] = useState(() => session?.name ?? '')
  const [fatigueLevel, setFatigueLevel] = useState<number | null>(() => session?.fatigueLevel ?? null)
  const [showFinish, setShowFinish] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [showAiAdjustment, setShowAiAdjustment] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [rpeValues, setRpeValues] = useState<Record<string, number>>(() => session?.rpeValues ?? {})
  const [missingReps, setMissingReps] = useState<string | null>(null)
  // Which exercise and set are open. null follows the workout: the first unfinished exercise and
  // its first unfinished set. setIndex null keeps the exercise open with every set closed.
  const [focus, setFocus] = useState<{ exerciseIndex: number; setIndex?: number | null } | null>(null)
  // The reps input only exists once its set is open, so focus it after the render that opens it.
  useEffect(() => {
    if (!missingReps) return
    const [exerciseIndex, setNumber] = missingReps.split(':').map(Number)
    document.getElementById(repsInputId(exerciseIndex, setNumber))?.focus()
  }, [missingReps])
  const [restRemaining, setRestRemaining] = useState<Record<number, number>>({})
  const [restPickerIndex, setRestPickerIndex] = useState<number | null>(null)
  const [rpePicker, setRpePicker] = useState<{ exerciseIndex: number; setIndex: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState<number | null>(null)
  const [pendingSetRemoval, setPendingSetRemoval] = useState<PendingSetRemoval | null>(null)
  const [aiAdjustment, setAiAdjustment] = useState<AiAdjustmentState>({ status: 'idle' })
  const [adjustmentUndo, setAdjustmentUndo] = useState<AdjustmentUndo | null>(null)
  const [showWarmup, setShowWarmup] = useState(false)
  const [warmup, setWarmup] = useState<WarmupState>({ status: 'idle' })
  const [selectedWarmupSteps, setSelectedWarmupSteps] = useState<number[]>([])

  const [isSelectModalOpen, setIsSelectModalOpen] = useState(() => {
    if (sessionStorage.getItem('booost_reopen_exercise_modal') === 'true') {
      sessionStorage.removeItem('booost_reopen_exercise_modal')
      return true
    }
    return false
  })
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null)

  const removeSetTimer = useRef<number | null>(null)
  const undoAdjustmentTimer = useRef<number | null>(null)
  const lastAdjustmentSetCount = useRef<number | null>(null)
  const imageLookups = useRef(new Set<string>())
  const sessionRef = useRef(session)
  const restRef = useRef(restRemaining)

  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  useEffect(() => {
    sessionRef.current = session
    const key = activeWorkoutStorageKey()
    if (session && key) localStorage.setItem(key, JSON.stringify({ ...session, rpeValues }))
  }, [session, rpeValues])

  useEffect(() => {
    restRef.current = restRemaining
  }, [restRemaining])

  useEffect(() => {
    if (menuOpen === null) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.exercise-menu, .exercise-menu-trigger')) setMenuOpen(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(null)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  useEffect(() => () => {
    if (removeSetTimer.current !== null) window.clearTimeout(removeSetTimer.current)
    if (undoAdjustmentTimer.current !== null) window.clearTimeout(undoAdjustmentTimer.current)
  }, [])

  const aiAdjustmentDialogRef = useDialogBehavior(showAiAdjustment, () => setShowAiAdjustment(false))
  const warmupDialogRef = useDialogBehavior(showWarmup, () => setShowWarmup(false))
  const closeFinish = () => {
    setShowFinish(false)
    setConfirmDiscard(false)
  }
  const finishDialogRef = useDialogBehavior(showFinish, closeFinish)

  useEffect(() => {
    let lastTick = Date.now()
    const timer = window.setInterval(() => {
      const passed = Math.floor((Date.now() - lastTick) / 1000)
      if (passed < 1) return
      lastTick += passed * 1000
      if (Object.values(restRef.current).some((value) => value <= passed)) navigator.vibrate?.([200, 100, 200])
      setRestRemaining((current) => {
        const next: Record<number, number> = {}
        for (const [key, value] of Object.entries(current)) {
          if (value > passed) next[Number(key)] = value - passed
        }
        return Object.keys(current).length ? next : current
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    session?.exercises.forEach((exercise) => {
      if ((exercise.images?.length && exercise.is_cardio !== undefined && exercise.is_bodyweight !== undefined) || imageLookups.current.has(exercise.exercise_id)) return
      imageLookups.current.add(exercise.exercise_id)
      fetchExerciseById(exercise.exercise_id)
        .catch(() => fetchExercises({ q: exercise.name, limit: 100 }).then((result: { items: Exercise[] }) =>
          result.items.find((item) => item.name.trim().toLowerCase() === exercise.name.trim().toLowerCase()) ?? null))
        .then((catalogExercise: Exercise | null) => {
          if (!catalogExercise) return
          
          const isCardio = !!catalogExercise.category?.toLowerCase().includes('cardio');
          
          setSession((current) => current ? ({
            ...current,
            exercises: current.exercises.map((item) => item.exercise_id === exercise.exercise_id
              ? { 
                  ...item, 
                  images: catalogExercise.images?.length ? catalogExercise.images : item.images,
                  is_cardio: item.is_cardio !== undefined ? item.is_cardio : isCardio,
                  is_bodyweight: isBodyweightOnly(catalogExercise.equipment),
                  sets: (item.is_cardio !== undefined ? item.is_cardio : isCardio) 
                        ? item.sets.map(s => ({...s, cardio_status: s.cardio_status || (s.duration_seconds ? 'finished' : 'idle')}))
                        : item.sets
                }
              : item),
          }) : current)
        })
        .catch(() => undefined)
    })
  }, [session])

  useEffect(() => {
    const pending = sessionStorage.getItem('booost_pending_exercise')
    if (!pending) return
    try {
      const selection = JSON.parse(pending) as Exercise & { replaceExerciseIndex?: number }
      const isCardio = !!selection.category?.toLowerCase().includes('cardio')

      setSession((current) => {
        if (!current) return current
        const replacement = {
          exercise_id: selection.id,
          name: selection.name,
          images: selection.images,
          previous_weight_kg: null,
          previous_reps: null,
          is_cardio: isCardio,
          // Unknown until the catalog lookup runs when the selection carries no equipment.
          is_bodyweight: selection.equipment ? isBodyweightOnly(selection.equipment) : undefined,
        }
        const initialSets = isCardio
          ? [{ ...createSet(1), cardio_status: 'idle' as const }]
          : selection.is_custom
            ? [createSet(1), createSet(2), createSet(3)]
            : [createSet(1)]

        if (selection.replaceExerciseIndex !== undefined && current.exercises[selection.replaceExerciseIndex]) {
          return {
            ...current,
            exercises: current.exercises.map((exercise, index) => index === selection.replaceExerciseIndex
              ? { ...exercise, ...replacement, sets: isCardio ? [{ ...createSet(1), cardio_status: 'idle' }] : exercise.sets }
              : exercise),
          }
        }
        return { 
          ...current, 
          exercises: [...current.exercises, { 
            ...replacement, 
            sets: initialSets
          }] 
        }
      })
    } finally {
      sessionStorage.removeItem('booost_pending_exercise')
    }
  }, [])

  const totalSets = session?.exercises.reduce((total, exercise) => total + (exercise.is_cardio ? 0 : exercise.sets.length), 0) ?? 0
  const completedSets = session?.exercises.reduce((total, exercise) => total + (exercise.is_cardio ? 0 : exercise.sets.filter((set) => set.is_completed).length), 0) ?? 0
  const completedCardio = session?.exercises.reduce((total, exercise) => total + (exercise.is_cardio && exercise.sets[0]?.is_completed ? 1 : 0), 0) ?? 0
  const volumeKg = session?.exercises.reduce((total, exercise) => (
    total + (exercise.is_cardio ? 0 : exercise.sets.reduce((sum, set) => sum + (set.is_completed ? set.weight_kg * set.reps : 0), 0))
  ), 0) ?? 0
  const isEditingWorkout = Boolean(session?.editWorkoutId)

  if (!session) return <div className="screen hifi-theme state-card" role="alert">No active workout selected.</div>

  function handleSelectExercise(selected: Exercise) {
    setFocus(null)
    const isCardio = !!selected.category?.toLowerCase().includes('cardio');
    const replacement = {
      exercise_id: selected.id,
      name: selected.name,
      images: selected.images || [],
      previous_weight_kg: null,
      previous_reps: null,
      is_cardio: isCardio
    }
    const initialSets = isCardio
      ? [{ ...createSet(1), cardio_status: 'idle' as const }]
      : selected.is_custom
        ? [createSet(1), createSet(2), createSet(3)]
        : [createSet(1)]

    setSession((current) => {
      if (!current) return current
      if (replaceIndex !== null && current.exercises[replaceIndex]) {
        return {
          ...current,
          exercises: current.exercises.map((ex, idx) => idx === replaceIndex 
            ? { ...ex, ...replacement, sets: isCardio ? [{ ...createSet(1), cardio_status: 'idle' }] : ex.sets } 
            : ex),
        }
      }
      return {
        ...current,
        exercises: [...current.exercises, { 
          ...replacement, 
          sets: initialSets
        }],
      }
    })
    setIsSelectModalOpen(false)
    setReplaceIndex(null)
  }

  function updateExercise(exerciseIndex: number, update: Partial<ActiveExercise>) {
    setSession((current) => current ? ({
      ...current,
      exercises: current.exercises.map((exercise, index) => index !== exerciseIndex ? exercise : { ...exercise, ...update }),
    }) : current)
  }

  function updateSet(exerciseIndex: number, setIndex: number, update: Partial<WorkoutSet>) {
    setSession((current) => current ? ({
      ...current,
      exercises: current.exercises.map((exercise, index) => index !== exerciseIndex ? exercise : ({
        ...exercise,
        sets: exercise.sets.map((set, currentIndex) => currentIndex !== setIndex ? set : { ...set, ...update }),
      })),
    }) : current)
  }

  function startCardioTimer(exerciseIndex: number) {
    updateSet(exerciseIndex, 0, { cardio_status: 'running', cardio_started_at: new Date().toISOString(), cardio_accumulated: 0 })
  }

  function pauseCardioTimer(exerciseIndex: number) {
    const set = session?.exercises[exerciseIndex]?.sets[0];
    if (!set || set.cardio_status !== 'running') return;
    const passed = set.cardio_started_at ? Math.floor((Date.now() - Date.parse(set.cardio_started_at)) / 1000) : 0;
    updateSet(exerciseIndex, 0, { 
      cardio_status: 'paused', 
      cardio_started_at: null, 
      cardio_accumulated: (set.cardio_accumulated || 0) + passed 
    });
  }

  function resumeCardioTimer(exerciseIndex: number) {
    updateSet(exerciseIndex, 0, { cardio_status: 'running', cardio_started_at: new Date().toISOString() })
  }

  function finishCardioTimer(exerciseIndex: number) {
    const set = session?.exercises[exerciseIndex]?.sets[0];
    if (!set) return;
    const finalized = finalizeCardioSet(set.cardio_status === 'running' || set.cardio_status === 'paused' ? set : { ...set, cardio_status: 'running' });
    updateSet(exerciseIndex, 0, finalized);
  }

  function saveManualCardio(exerciseIndex: number, mins: number, dist: number | null) {
    const seconds = Math.max(1, Math.round(mins * 60));
    updateSet(exerciseIndex, 0, {
      cardio_status: 'finished',
      cardio_started_at: null,
      cardio_accumulated: seconds,
      duration_seconds: seconds,
      distance_km: dist,
      is_completed: true
    });
  }

  function addSet(exerciseIndex: number) {
    setSession((current) => current ? ({
      ...current,
      exercises: current.exercises.map((exercise, index) => {
        if (index !== exerciseIndex) return exercise
        const last = exercise.sets[exercise.sets.length - 1]
        return { ...exercise, sets: [...exercise.sets, createSet(exercise.sets.length + 1, last)] }
      }),
    }) : current)
  }

  function removeSet(exerciseIndex: number, setIndex: number) {
    const removedSetNumber = sessionRef.current?.exercises[exerciseIndex]?.sets[setIndex]?.set_number
    if (removedSetNumber === undefined) return
    setSession((current) => current ? ({
      ...current,
      exercises: current.exercises.map((exercise, index) => index !== exerciseIndex ? exercise : ({
        ...exercise,
        sets: exercise.sets
          .filter((_, currentIndex) => currentIndex !== setIndex)
          .map((set, currentIndex) => ({ ...set, set_number: currentIndex + 1 })),
      })),
      setKinds: removeSetFromKeyedMap(current.setKinds, exerciseIndex, removedSetNumber),
    }) : current)
    setRpeValues((current) => removeSetFromKeyedMap(current, exerciseIndex, removedSetNumber))
  }

  function scheduleSetRemoval(removal: PendingSetRemoval) {
    if (removeSetTimer.current !== null) return
    setFocus(null)
    setPendingSetRemoval({ ...removal, removed: true })
    removeSet(removal.exerciseIndex, removal.setIndex)
    removeSetTimer.current = window.setTimeout(() => {
      setPendingSetRemoval(null)
      removeSetTimer.current = null
    }, 2800)
  }

  function undoSetRemoval() {
    setFocus(null)
    if (removeSetTimer.current !== null) window.clearTimeout(removeSetTimer.current)
    removeSetTimer.current = null
    if (pendingSetRemoval?.removed) {
      const { exerciseIndex, setIndex, set, kind, rpe } = pendingSetRemoval
      setSession((current) => current ? ({
        ...current,
        exercises: current.exercises.map((exercise, index) => index !== exerciseIndex ? exercise : ({
          ...exercise,
          sets: [...exercise.sets.slice(0, setIndex), set, ...exercise.sets.slice(setIndex)]
            .map((currentSet, index) => ({ ...currentSet, set_number: index + 1 })),
        })),
        setKinds: insertSetIntoKeyedMap(current.setKinds, exerciseIndex, set.set_number, kind),
      }) : current)
      setRpeValues((current) => insertSetIntoKeyedMap(current, exerciseIndex, set.set_number, rpe))
    }
    setPendingSetRemoval(null)
  }

  function removeExercise(exerciseIndex: number) {
    setFocus(null)
    if (removeSetTimer.current !== null) undoSetRemoval()
    setMenuOpen(null)
    setSession((current) => current ? ({
      ...current,
      exercises: current.exercises.filter((_, index) => index !== exerciseIndex),
      setKinds: reindexKeyedMap(current.setKinds, exerciseIndex),
    }) : current)
    setRpeValues((current) => reindexKeyedMap(current, exerciseIndex))
    setRestRemaining((current) => reindexKeyedMap(current, exerciseIndex))
  }

  function replaceExercise(exerciseIndex: number) {
    setMenuOpen(null)
    setReplaceIndex(exerciseIndex)
    setIsSelectModalOpen(true)
  }

  function moveExercise(exerciseIndex: number, direction: -1 | 1) {
    const targetIndex = exerciseIndex + direction
    if (!session || targetIndex < 0 || targetIndex >= session.exercises.length) return
    setFocus(null)
    if (removeSetTimer.current !== null) undoSetRemoval()
    setMenuOpen(null)
    setSession((current) => {
      if (!current || targetIndex >= current.exercises.length) return current
      const exercises = [...current.exercises]
      ;[exercises[exerciseIndex], exercises[targetIndex]] = [exercises[targetIndex], exercises[exerciseIndex]]
      return { ...current, exercises, setKinds: swapKeyedMapIndexes(current.setKinds, exerciseIndex, targetIndex) }
    })
    setRpeValues((current) => swapKeyedMapIndexes(current, exerciseIndex, targetIndex))
    setRestRemaining((current) => {
      const next = { ...current }
      const firstValue = current[exerciseIndex]
      const secondValue = current[targetIndex]
      if (secondValue === undefined) delete next[exerciseIndex]
      else next[exerciseIndex] = secondValue
      if (firstValue === undefined) delete next[targetIndex]
      else next[targetIndex] = firstValue
      return next
    })
  }

  function updateSetKind(exerciseIndex: number, setNumber: number, kind: SetKind) {
    setSession((current) => current ? ({ ...current, setKinds: { ...current.setKinds, [`${exerciseIndex}:${setNumber}`]: kind } }) : current)
  }

  function updateRpe(exerciseIndex: number, setNumber: number, rpe: number) {
    const key = `${exerciseIndex}:${setNumber}`
    setRpeValues((current) => ({ ...current, [key]: rpe }))
  }

  function clearRpe(exerciseIndex: number, setIndex: number, setNumber: number) {
    updateSet(exerciseIndex, setIndex, { rpe: null })
    setRpeValues((current) => {
      const next = { ...current }
      delete next[`${exerciseIndex}:${setNumber}`]
      return next
    })
  }

  function stopRest(exerciseIndex: number) {
    setRestRemaining((current) => {
      if (!(exerciseIndex in current)) return current
      const next = { ...current }
      delete next[exerciseIndex]
      return next
    })
  }

  function changeRunningRest(exerciseIndex: number, seconds: number) {
    const remaining = (restRemaining[exerciseIndex] ?? 0) + seconds
    if (remaining <= 0) stopRest(exerciseIndex)
    else setRestRemaining((current) => ({ ...current, [exerciseIndex]: remaining }))
  }

  function chooseRest(exerciseIndex: number, seconds: number | null) {
    setRestPickerIndex(null)
    if (seconds === null) {
      updateExercise(exerciseIndex, { rest_enabled: false })
      stopRest(exerciseIndex)
      return
    }
    updateExercise(exerciseIndex, { rest_enabled: true })
    updateRestDuration(exerciseIndex, seconds)
  }

  function toggleSetComplete(exerciseIndex: number, setIndex: number, isCompleted: boolean) {
    const exercise = session?.exercises[exerciseIndex]
    const set = exercise?.sets[setIndex]
    if (!exercise || !set) return
    if (isCompleted && !set.reps) {
      setMissingReps(`${exerciseIndex}:${set.set_number}`)
      setFocus({ exerciseIndex, setIndex })
      return
    }
    setMissingReps(null)
    updateSet(exerciseIndex, setIndex, { is_completed: isCompleted })
    if (!isCompleted) {
      stopRest(exerciseIndex)
      return
    }
    navigator.vibrate?.(15)
    const setsLeft = exercise.sets.some((other, index) => index !== setIndex && !other.is_completed)
    setFocus(setsLeft ? { exerciseIndex } : null)
    if (exercise.rest_enabled) {
      setRestRemaining((current) => ({ ...current, [exerciseIndex]: exercise.rest_seconds ?? DEFAULT_REST_SECONDS }))
    }
  }

  function chooseRpe(exerciseIndex: number, setIndex: number, rpe: number | null) {
    setRpePicker(null)
    const set = session?.exercises[exerciseIndex]?.sets[setIndex]
    if (!set) return
    if (rpe === null) {
      clearRpe(exerciseIndex, setIndex, set.set_number)
      return
    }
    updateRpe(exerciseIndex, set.set_number, rpe)
    if (!set.is_completed) toggleSetComplete(exerciseIndex, setIndex, true)
  }

  function updateRestDuration(exerciseIndex: number, seconds: number) {
    updateExercise(exerciseIndex, { rest_seconds: seconds })
    setRestRemaining((current) => exerciseIndex in current ? { ...current, [exerciseIndex]: seconds } : current)
  }

  function selectFatigue(level: number) {
    setFatigueLevel(level)
    setSession((current) => current ? { ...current, fatigueLevel: level } : current)
  }

  async function finishWorkout() {
    const user = getCurrentUser()
    const currentSession = session
    if (!currentSession) return
    if (!user?.id) {
      setSaveError('Sign in again to save this workout.')
      return
    }
    if (fatigueLevel === null) {
      setSaveError('Choose how fatigued you feel to save this workout.')
      return
    }
    setIsSaving(true)
    setSaveError(null)
    const payload: WorkoutLogCreate = {
      plan_id: currentSession.planId,
      routine_id: currentSession.routineId,
      name: workoutName.trim() || currentSession.name,
      duration_seconds: elapsedSeconds(currentSession.startedAt),
      started_at: currentSession.startedAt,
      completed_at: new Date().toISOString(),
      fatigue_level: fatigueLevel,
      exercises: currentSession.exercises.map(({ exercise_id, sets, is_cardio, is_bodyweight }, exerciseIndex) => ({
        exercise_id,
        is_cardio: Boolean(is_cardio),
        sets: sets.map((rawSet) => {
          const set = is_cardio ? finalizeCardioSet(rawSet) : rawSet
          return {
            ...set,
            ...(is_cardio
              ? {
                  weight_kg: 0,
                  reps: 0,
                  duration_seconds: set.duration_seconds ?? null,
                  distance_km: set.distance_km ?? null,
                  rpe: null,
                }
              : {
                  // The weight field is hidden for bodyweight exercises, so never save a stale value.
                  ...(is_bodyweight ? { weight_kg: 0 } : {}),
                  rpe: rpeValues[`${exerciseIndex}:${set.set_number}`] ?? set.rpe ?? null,
                }),
          }
        }),
      })),
    }
    try {
      if (currentSession.editWorkoutId) {
        await updateWorkoutHistoryEntry(user.id, currentSession.editWorkoutId, {
          name: payload.name,
          exercises: payload.exercises,
          fatigue_level: payload.fatigue_level,
        })
      } else {
        await saveWorkoutLog(user.id, payload)
      }
      const key = activeWorkoutStorageKey()
      if (key) localStorage.removeItem(key)
      navigate('/workouts')
    } catch (error) {
      setSaveError(describeError(error, "We couldn't save your workout. Please try again."))
      setIsSaving(false)
    }
  }

  async function requestAiAdjustment() {
    const currentSession = session
    const user = getCurrentUser()
    if (!currentSession || aiAdjustment.status === 'loading') return
    if (!user?.id) {
      setAiAdjustment({ status: 'error', message: 'Sign in to ask the AI trainer for adjustments' })
      return
    }
    const completedAtRequest = completedSets
    const exercises = (Array.isArray(currentSession.exercises) ? currentSession.exercises : []).map((exercise, exerciseIndex) => {
      const { exercise_id, name, previous_weight_kg, previous_reps, rest_enabled, rest_seconds, target_sets, target_reps, sets, is_cardio } = exercise
      const previousWeight = nullableNumber(previous_weight_kg)
      const previousReps = nullableNumber(previous_reps)
      const rest = nullableNumber(rest_seconds, 1)
      const targetSets = nullableNumber(target_sets)
      const targetReps = nullableNumber(target_reps)
      return {
        exercise_id: exercise_id ? String(exercise_id) : '',
        name: typeof name === 'string' && name.trim() ? name : 'Exercise',
        is_cardio: !!is_cardio,
        previous_weight_kg: previousWeight,
        previous_reps: previousReps === null ? null : Math.trunc(previousReps),
        rest_seconds: rest_enabled ? (rest === null ? DEFAULT_REST_SECONDS : Math.trunc(rest)) : null,
        target_sets: targetSets === null ? null : Math.trunc(targetSets),
        target_reps: targetReps === null ? null : Math.trunc(targetReps),
        sets: (Array.isArray(sets) ? sets : []).map((set, setIndex) => {
          const key = `${exerciseIndex}:${set.set_number}`
          const rpe = nullableNumber(rpeValues[key], 1)
          return {
            set_number: setIndex + 1,
            weight_kg: safeNumber(set.weight_kg),
            reps: safeCount(set.reps),
            is_completed: Boolean(set.is_completed),
            rpe: rpe !== null && rpe <= 10 ? rpe : null,
            kind: safeSetKind(currentSession.setKinds[key]),
          }
        }),
      }
    }).filter((exercise) => exercise.exercise_id && !exercise.is_cardio)
    if (!exercises.length) {
      setAiAdjustment({ status: 'error', message: 'Add at least one exercise before asking the AI for adjustments.' })
      return
    }
    setAiAdjustment({ status: 'loading' })
    const durationSeconds = elapsedSeconds(currentSession.startedAt)
    const payload: LiveWorkoutAdjustmentRequest = {
      name: typeof currentSession.name === 'string' && currentSession.name.trim() ? currentSession.name : 'Workout',
      duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
      user_goal: typeof user.objective === 'string' ? user.objective : null,
      exercises,
    }
    try {
      const result = await requestWorkoutAdjustment(user.id, payload)
      lastAdjustmentSetCount.current = completedAtRequest
      setAdjustmentUndo(null)
      setAiAdjustment({ status: 'ready', suggestions: result.suggestions, applied: [] })
    } catch (error) {
      setAiAdjustment({ status: 'error', message: error instanceof Error ? error.message : 'Unable to get AI adjustments' })
    }
  }

  function openAiAdjustment() {
    if (!session || session.editWorkoutId) return
    setShowAiAdjustment(true)
    const isStale = lastAdjustmentSetCount.current !== completedSets
    if (aiAdjustment.status !== 'ready' || isStale) requestAiAdjustment()
  }

  async function requestWarmup() {
    const currentSession = session
    const user = getCurrentUser()
    if (!currentSession || warmup.status === 'loading') return
    if (!user?.id) {
      setWarmup({ status: 'error', message: 'Sign in to get a warm-up.' })
      return
    }
    setWarmup({ status: 'loading' })
    setSelectedWarmupSteps([])
    try {
      const recommendation = await requestWarmupRecommendation(
        user.id,
        buildWarmupRequest(currentSession, user.objective ?? null),
      )
      setWarmup({ status: 'ready', recommendation })
    } catch (error) {
      if (error instanceof PremiumRequiredError) {
        setWarmup({ status: 'premium' })
        return
      }
      setWarmup({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to build your warm-up. Please try again.',
      })
    }
  }

  function addSelectedWarmupSteps() {
    if (!session || session.warmupAdded || warmup.status !== 'ready') return

    const steps = warmup.recommendation.steps.filter((_, index) => selectedWarmupSteps.includes(index))
    if (!steps.length) return
    const exerciseSteps = steps.filter((step) => step.exercise_id && step.sets.length > 0)
    const activitySteps = steps.filter((step) => step.sets.length === 0)

    const exercises = [...session.exercises]
    let setKinds = { ...session.setKinds }
    let nextRpeValues = { ...rpeValues }
    for (const step of exerciseSteps) {
      const exerciseIndex = exercises.findIndex((exercise) => exercise.exercise_id === step.exercise_id)
      if (exerciseIndex === -1) continue

      const exercise = exercises[exerciseIndex]
      const nextIncompleteIndex = exercise.sets.findIndex((set) => !set.is_completed)
      const insertIndex = nextIncompleteIndex === -1 ? exercise.sets.length : nextIncompleteIndex
      const firstSetNumber = insertIndex + 1
      const warmupSets = step.sets.map((set) => ({
        weight_kg: set.weight_kg ?? 0,
        reps: set.reps,
        is_completed: false,
      }))

      for (let index = 0; index < warmupSets.length; index += 1) {
        setKinds = insertSetIntoKeyedMap(setKinds, exerciseIndex, firstSetNumber)
        nextRpeValues = insertSetIntoKeyedMap(nextRpeValues, exerciseIndex, firstSetNumber)
      }
      for (let index = 0; index < warmupSets.length; index += 1) {
        setKinds[`${exerciseIndex}:${firstSetNumber + index}`] = 'warmup'
      }

      exercises[exerciseIndex] = {
        ...exercise,
        sets: [...exercise.sets.slice(0, insertIndex), ...warmupSets, ...exercise.sets.slice(insertIndex)]
          .map((set, index) => ({ ...set, set_number: index + 1 })),
      }
    }

    setSession({
      ...session,
      exercises,
      setKinds,
      warmupSteps: [...(session.warmupSteps ?? []), ...activitySteps],
      warmupAdded: true,
    })
    setRpeValues(nextRpeValues)
    setSelectedWarmupSteps([])
    setShowWarmup(false)
  }

  function openWarmup() {
    if (!session || session.editWorkoutId || session.warmupAdded) return
    setShowWarmup(true)
    if (!isPremiumActive()) {
      setWarmup({ status: 'premium' })
      return
    }
    requestWarmup()
  }

  function rememberAdjustmentUndo(snapshot: AdjustmentUndo) {
    if (undoAdjustmentTimer.current !== null) window.clearTimeout(undoAdjustmentTimer.current)
    setAdjustmentUndo(snapshot)
    undoAdjustmentTimer.current = window.setTimeout(() => {
      setAdjustmentUndo(null)
      undoAdjustmentTimer.current = null
    }, 8000)
  }

  function applyOneAdjustment(index: number) {
    if (!session || aiAdjustment.status !== 'ready' || aiAdjustment.applied.includes(index)) return
    const update = aiAdjustment.suggestions[index]
    rememberAdjustmentUndo({ session, rpeValues, restRemaining, applied: aiAdjustment.applied })
    applySuggestions([update])
    setAiAdjustment({ ...aiAdjustment, applied: [...aiAdjustment.applied, index] })
  }

  function applyAllAdjustments() {
    if (!session || aiAdjustment.status !== 'ready') return
    const pending = aiAdjustment.suggestions.filter((_, index) => !aiAdjustment.applied.includes(index))
    rememberAdjustmentUndo({ session, rpeValues, restRemaining, applied: aiAdjustment.applied })
    applySuggestions(pending)
    setAiAdjustment({ ...aiAdjustment, applied: aiAdjustment.suggestions.map((_, index) => index) })
  }

  function undoAdjustment() {
    if (!adjustmentUndo || aiAdjustment.status !== 'ready') return
    if (undoAdjustmentTimer.current !== null) {
      window.clearTimeout(undoAdjustmentTimer.current)
      undoAdjustmentTimer.current = null
    }
    setSession(adjustmentUndo.session)
    setRpeValues(adjustmentUndo.rpeValues)
    setRestRemaining(adjustmentUndo.restRemaining)
    setAiAdjustment({ ...aiAdjustment, applied: adjustmentUndo.applied })
    setAdjustmentUndo(null)
  }

  function applySuggestions(updates: LiveWorkoutAdjustmentSuggestion[]) {
    const current = session
    if (!current || !updates.length) return
    const next = applyAdjustments(current, rpeValues, restRemaining, updates)
    setSession(next.session)
    setRpeValues(next.rpeValues)
    setRestRemaining(next.restRemaining)
  }

  function discardWorkout() {
    if (!confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    const key = activeWorkoutStorageKey()
    if (key) localStorage.removeItem(key)
    navigate('/workouts')
  }

  const nextExerciseIndex = session.exercises.findIndex((exercise) => !exercise.is_cardio && exercise.sets.some((set) => !set.is_completed))
  const nextSetIndex = session.exercises[nextExerciseIndex]?.sets.findIndex((set) => !set.is_completed) ?? -1
  const isExerciseFinished = (exercise: ActiveExercise) => (exercise.is_cardio
    ? Boolean(exercise.sets[0]?.is_completed)
    : exercise.sets.length > 0 && exercise.sets.every((set) => set.is_completed))
  const firstUnfinished = session.exercises.findIndex((exercise) => !isExerciseFinished(exercise))
  // Editing a past workout: everything is done, so open the first exercise instead of none.
  const openExerciseIndex = focus ? focus.exerciseIndex : (firstUnfinished === -1 && isEditingWorkout ? 0 : firstUnfinished)
  const openSetIndex = focus && focus.setIndex !== undefined
    ? focus.setIndex ?? -1
    : session.exercises[openExerciseIndex]?.sets.findIndex((set) => !set.is_completed) ?? -1
  const runningRests = Object.entries(restRemaining).sort(([, first], [, second]) => first - second)
  const runningRestIndex = runningRests.length ? Number(runningRests[0][0]) : null

  return (
    <div className={`screen active-workout-screen hifi-screen hifi-theme${runningRestIndex !== null ? ' is-resting' : ''}`}>
      <header className={`aw-header${isEditingWorkout ? ' is-editing' : ''}`}>
        <div className="aw-header-row">
          <button className="scan-back" type="button" onClick={() => navigate('/workouts')} aria-label="Back to workouts">
            <img src={backIcon} alt="" width={36} height={37} />
          </button>
          <div className="aw-title">
            <h1>
              {isEditingWorkout ? 'Edit Workout' : session.name}
              {!isEditingWorkout && <span className="aw-clock" aria-label="Elapsed time"><ElapsedTime startedAt={session.startedAt} format={formatClock} /></span>}
            </h1>
            <p className="hifi-caption aw-subtitle">
              <span>{completedSets}/{totalSets} sets</span>
              <span>{Math.round(volumeKg).toLocaleString('en-US')}kg lift</span>
            </p>
          </div>
          <button className="hifi-pill aw-finish" type="button" onClick={() => setShowFinish(true)}>{isEditingWorkout ? 'Save' : 'Finish'}</button>
        </div>
        <div className="hifi-bar aw-progress" role="progressbar" aria-label="Completed sets" aria-valuemin={0} aria-valuemax={totalSets} aria-valuenow={completedSets}>
          <span style={{ width: `${totalSets ? (completedSets / totalSets) * 100 : 0}%` }} />
        </div>
        {!isEditingWorkout && (
          <div className="aw-tools">
            <button
              className="hifi-link-button aw-tool"
              type="button"
              onClick={openWarmup}
              disabled={isSaving || session.warmupAdded}
              aria-label={session.warmupAdded ? 'Warm-up already added' : 'Recommend a warm-up'}
              title={session.warmupAdded ? 'Warm-up already added' : 'Recommend a warm-up'}
            >
              <Flame size={15} aria-hidden="true" />
              <span>Warm-up</span>
            </button>
            <button
              className="hifi-link-button aw-tool"
              type="button"
              onClick={openAiAdjustment}
              disabled={isSaving}
              aria-label="Ask AI for adjustments"
              title="Ask AI for adjustments"
            >
              <Sparkles size={15} aria-hidden="true" />
              <span>AI adjust</span>
            </button>
          </div>
        )}
      </header>

      {session.warmupSteps?.length ? (
        <section className="card active-warmup-card" aria-label="Added warm-up activities">
          <h2>Warm-up activities</h2>
          <ul>
            {session.warmupSteps.map((step, index) => <li className="warmup-step" key={`${step.title}-${index}`}>
              <div className="warmup-step-heading">
                <strong>{step.title}</strong>
                {step.duration_seconds ? <span>{formatWarmupDuration(step.duration_seconds)}</span> : null}
              </div>
              <p>{step.detail}</p>
            </li>)}
          </ul>
        </section>
      ) : null}

      <div className="aw-exercise-list">
        {session.exercises.map((exercise, exerciseIndex) => {
          const doneSets = exercise.sets.filter((set) => set.is_completed).length
          const isExerciseDone = isExerciseFinished(exercise)
          const restSeconds = exercise.rest_seconds ?? DEFAULT_REST_SECONDS
          const isOpen = exerciseIndex === openExerciseIndex
          const bodyId = `aw-exercise-${exerciseIndex}`
          const countLabel = exercise.is_cardio
            ? 'Cardio'
            : doneSets > 0 ? `${doneSets}/${exercise.sets.length} sets` : `${exercise.sets.length} ${exercise.sets.length === 1 ? 'set' : 'sets'}`

          return <article className={`hifi-card aw-exercise${isExerciseDone ? ' is-complete' : ''}`} data-open={isOpen} key={`${exercise.exercise_id}-${exerciseIndex}`}>
            <div className="aw-exercise-head">
              <button
                className="aw-exercise-toggle"
                type="button"
                aria-expanded={isOpen}
                aria-controls={bodyId}
                onClick={() => setFocus(isOpen ? { exerciseIndex: -1 } : { exerciseIndex })}
              >
                <span className="aw-exercise-name">{exercise.name}</span>
                <span className="aw-exercise-count">
                  {isExerciseDone && <Check size={14} aria-hidden="true" />}
                  {countLabel}
                </span>
              </button>
              <button className="icon-button ghost exercise-menu-trigger" type="button" aria-label={`Exercise options for ${exercise.name}`} aria-expanded={menuOpen === exerciseIndex} onClick={() => setMenuOpen(menuOpen === exerciseIndex ? null : exerciseIndex)}>
                <MoreVertical size={19} aria-hidden="true" />
              </button>
              {menuOpen === exerciseIndex && <div className="exercise-menu">
                <button type="button" onClick={() => navigate(`/exercises/${encodeURIComponent(exercise.exercise_id)}/guide`, { state: { fromWorkout: true } })}><Info size={15} aria-hidden="true" />How to do it</button>
                <button className="exercise-order-action" type="button" onClick={() => moveExercise(exerciseIndex, -1)} disabled={exerciseIndex === 0}><ArrowUp size={15} aria-hidden="true" />Move up</button>
                <button className="exercise-order-action" type="button" onClick={() => moveExercise(exerciseIndex, 1)} disabled={exerciseIndex === session.exercises.length - 1}><ArrowDown size={15} aria-hidden="true" />Move down</button>
                <button className="replace-exercise-action" type="button" onClick={() => replaceExercise(exerciseIndex)}><Repeat2 size={15} aria-hidden="true" />Replace exercise</button>
                <button type="button" onClick={() => removeExercise(exerciseIndex)}><Trash2 size={15} aria-hidden="true" />Remove exercise</button>
              </div>}
            </div>

            {isOpen && <div className="aw-exercise-body" id={bodyId}>
              <div className="aw-exercise-art">
                <ExerciseArtwork name={exercise.name} images={exercise.images} />
                {!exercise.is_cardio && (
                  <div className="aw-rest-row">
                    <span className="aw-rest-label">Rest time</span>
                    <button className="aw-step" type="button" aria-label={`Rest 15 seconds less for ${exercise.name}`} onClick={() => chooseRest(exerciseIndex, Math.max(15, (exercise.rest_enabled ? restSeconds : DEFAULT_REST_SECONDS) - REST_STEP_SECONDS))}>
                      <Minus size={18} aria-hidden="true" />
                    </button>
                    <button className={`aw-rest-value${exercise.rest_enabled ? '' : ' is-off'}`} type="button" aria-haspopup="dialog" aria-label={`Rest timer for ${exercise.name}: ${exercise.rest_enabled ? formatRestLong(restSeconds) : 'off'}`} onClick={() => setRestPickerIndex(exerciseIndex)}>
                      {exercise.rest_enabled ? formatRestLong(restSeconds) : 'Off'}
                    </button>
                    <button className="aw-step" type="button" aria-label={`Rest 15 seconds more for ${exercise.name}`} onClick={() => chooseRest(exerciseIndex, Math.min(600, (exercise.rest_enabled ? restSeconds : DEFAULT_REST_SECONDS - REST_STEP_SECONDS) + REST_STEP_SECONDS))}>
                      <Plus size={18} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>

              {exercise.is_cardio ? (
              <div className="cardio-container">
                {(() => {
                  const set = exercise.sets[0] || createSet(1);
                  let status = set.cardio_status || 'idle';

                  if (isEditingWorkout && status === 'idle') {
                     status = set.duration_seconds ? 'finished' : 'manual';
                  }

                  if (status === 'manual') {
                    const initialMins = set.duration_seconds ? Math.max(1, Math.round(set.duration_seconds / 60)) : undefined;
                    return <CardioManualForm
                      initialMins={initialMins}
                      initialDist={set.distance_km || undefined}
                      onSave={(m, d) => saveManualCardio(exerciseIndex, m, d)}
                      onCancel={() => {
                        updateSet(exerciseIndex, 0, { cardio_status: set.duration_seconds ? 'finished' : 'idle' })
                      }}
                    />
                  }

                  if (status === 'finished') {
                    return (
                      <div className="cardio-panel cardio-summary">
                        <div>
                          <span className="cardio-label">Time</span>
                          <strong className="cardio-stat">{formatDuration(set.duration_seconds || 0)}</strong>
                        </div>
                        {set.distance_km != null && set.distance_km > 0 && (
                          <div>
                            <span className="cardio-label">Distance</span>
                            <strong className="cardio-stat">{set.distance_km} km</strong>
                          </div>
                        )}
                        {set.distance_km != null && set.distance_km > 0 && (set.duration_seconds ?? 0) > 0 && (
                          <div>
                            <span className="cardio-label">Pace</span>
                            <strong className="cardio-stat">{formatPace(set.duration_seconds || 0, set.distance_km)}</strong>
                          </div>
                        )}
                        <button
                          className="secondary-action cardio-edit-button"
                          type="button"
                          aria-label={`Edit ${exercise.name} cardio`}
                          onClick={() => updateSet(exerciseIndex, 0, { cardio_status: 'manual' })}
                        >
                          Edit
                        </button>
                      </div>
                    )
                  }

                  return (
                    <div className="cardio-panel cardio-timer">
                      <div className="cardio-clock-row">
                        {status === 'idle' ? (
                          <span className="cardio-clock">00:00</span>
                        ) : (
                          <CardioTimerDisplay
                            startedAt={status === 'running' ? set.cardio_started_at! : null}
                            accumulated={set.cardio_accumulated || 0}
                          />
                        )}
                      </div>

                      {(status === 'running' || status === 'paused') && (
                        <div className="cardio-distance">
                          <input
                            className="cardio-input"
                            type="number"
                            inputMode="decimal"
                            aria-label="Distance in km, optional"
                            placeholder="Distance (km, optional)"
                            value={set.distance_km || ''}
                            onChange={e => updateSet(exerciseIndex, 0, { distance_km: e.target.value ? Number(e.target.value) : null })}
                          />
                        </div>
                      )}

                      <div className="cardio-actions">
                        {status === 'idle' && (
                          <>
                            <button className="primary-button" type="button" onClick={() => startCardioTimer(exerciseIndex)}>Start timer</button>
                            <button className="secondary-action" type="button" onClick={() => updateSet(exerciseIndex, 0, { cardio_status: 'manual' })}>Enter manually</button>
                          </>
                        )}
                        {status === 'running' && (
                          <>
                            <button className="secondary-action" type="button" onClick={() => pauseCardioTimer(exerciseIndex)}><Pause size={18} aria-hidden="true" /> Pause</button>
                            <button className="primary-button" type="button" onClick={() => finishCardioTimer(exerciseIndex)}>Finish block</button>
                          </>
                        )}
                        {status === 'paused' && (
                          <>
                            <button className="secondary-action" type="button" onClick={() => resumeCardioTimer(exerciseIndex)}><Play size={18} aria-hidden="true" /> Resume</button>
                            <button className="primary-button" type="button" onClick={() => finishCardioTimer(exerciseIndex)}>Finish block</button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })()}
              </div>
              ) : (
              <div className="aw-sets">
                {exercise.sets.map((set, setIndex) => {
                  const setKey = `${exerciseIndex}:${set.set_number}`
                  const kind = session.setKinds[setKey] ?? 'normal'
                  const rpe = rpeValues[setKey] ?? set.rpe ?? null
                  const hasHighWeightWarning = set.weight_kg > EXTREME_WEIGHT_WARNING_KG
                  const isNextSet = exerciseIndex === nextExerciseIndex && setIndex === nextSetIndex
                  const isSetOpen = setIndex === openSetIndex
                  const doneButton = (
                    <button className={`done-button aw-done${set.is_completed ? ' is-done' : ''}`} type="button" onClick={() => toggleSetComplete(exerciseIndex, setIndex, !set.is_completed)} aria-label={`Toggle set ${set.set_number}`} aria-pressed={set.is_completed}>
                      <Check size={isSetOpen ? 22 : 16} strokeWidth={3} aria-hidden="true" />
                    </button>
                  )
                  const kindBadge = kind !== 'normal' && <span className={`aw-kind set-kind-${kind}`} aria-hidden="true">{kind[0].toUpperCase()}</span>
                  return <div className="set-row-entry" key={set.set_number}>
                    <SwipeToDeleteRow
                      className="swipe-row--set"
                      actionWidth={64}
                      label={`set ${set.set_number} of ${exercise.name}`}
                      disabled={pendingSetRemoval !== null}
                      onDelete={() => scheduleSetRemoval({ exerciseIndex, setIndex, setNumber: set.set_number, key: setKey, set: { ...set }, kind: session.setKinds[setKey], rpe: rpeValues[setKey], removed: false })}
                    >
                      {isSetOpen ? (
                        <div className={`aw-set is-open${set.is_completed ? ' is-done' : ''}${isNextSet ? ' is-next' : ''}`}>
                          <div className="aw-set-top">
                            <span className={`aw-set-title set-kind-${kind}`}>
                              Set {set.set_number}
                              {kindBadge}
                              <select className="set-kind-select" value={kind} onChange={(event) => {
                                updateSetKind(exerciseIndex, set.set_number, event.target.value as SetKind)
                              }} aria-label={`Set ${set.set_number} type`} title="Set type">
                                <option value="normal">{set.set_number} — Normal set</option>
                                <option value="warmup">W — Warm-up: prepare for heavier sets</option>
                                <option value="drop">D — Drop set: lower weight, keep going</option>
                                <option value="failure">F — Failure: no more good-form reps</option>
                              </select>
                            </span>
                            <button className="aw-set-close" type="button" aria-expanded="true" aria-label={`Close set ${set.set_number}`} onClick={() => setFocus({ exerciseIndex, setIndex: null })}>
                              <ChevronUp size={18} aria-hidden="true" />
                            </button>
                            {doneButton}
                          </div>
                          <div className="aw-fields">
                            <span aria-hidden="true" />
                            <span className="aw-field-label" aria-hidden="true">Kg</span>
                            <span className="aw-field-label" aria-hidden="true">Reps</span>
                            <span className="aw-field-label" aria-hidden="true">RPE</span>

                            <span aria-hidden="true" />
                            {exercise.is_bodyweight
                              ? <span className="set-bodyweight aw-field-value" aria-label="Bodyweight, no weight to enter">BW</span>
                              : <SetNumberInput label={`${exercise.name} set ${set.set_number} weight`} decimal value={set.weight_kg} onChange={(weight_kg) => updateSet(exerciseIndex, setIndex, { weight_kg })} />}
                            <SetNumberInput id={repsInputId(exerciseIndex, set.set_number)} label={`${exercise.name} set ${set.set_number} reps`} value={set.reps} invalid={missingReps === setKey} onChange={(reps) => {
                              updateSet(exerciseIndex, setIndex, { reps })
                              setMissingReps(null)
                            }} />
                            <button className="rpe-select aw-field-value" type="button" aria-haspopup="dialog" aria-label={`Set ${set.set_number} RPE: ${rpe ?? 'none'}`} onClick={() => setRpePicker({ exerciseIndex, setIndex })}>
                              {rpe ?? '—'}
                            </button>

                            <span className="aw-last-label">Last</span>
                            <span className="aw-last" aria-hidden="true">{exercise.is_bodyweight ? 'BW' : exercise.previous_weight_kg ?? '—'}</span>
                            <span className="aw-last" aria-hidden="true">{exercise.previous_reps ?? '—'}</span>
                            <span className="aw-last" aria-hidden="true">—</span>
                            <span className="visually-hidden">Last time: {formatPrevious(exercise)}</span>
                          </div>
                        </div>
                      ) : (
                        <div className={`aw-set${set.is_completed ? ' is-done' : ''}${isNextSet ? ' is-next' : ''}`}>
                          <button className="aw-set-open" type="button" data-swipe-through aria-expanded="false" aria-label={`Edit set ${set.set_number}`} onClick={() => setFocus({ exerciseIndex, setIndex })}>
                            <span className="aw-set-name">Set {set.set_number}{kindBadge}</span>
                            <span className="aw-set-values">
                              <span>{exercise.is_bodyweight ? 'BW' : set.weight_kg ? `${set.weight_kg}kg` : '—kg'}</span>
                              <span>{set.reps ? `${set.reps}reps` : '—reps'}</span>
                              {rpe !== null && <span>{rpe}RPE</span>}
                            </span>
                          </button>
                          {doneButton}
                        </div>
                      )}
                    </SwipeToDeleteRow>
                    {missingReps === setKey && <p className="set-row-hint" role="status">Enter your reps to complete this set.</p>}
                    {hasHighWeightWarning && <p className="high-weight-warning" role="status">This weight is extremely high. Check that you entered it correctly.</p>}
                  </div>
                })}
              </div>
              )}

              {pendingSetRemoval?.exerciseIndex === exerciseIndex && <div className="set-removal-undo" role="status">
                <span>Set {pendingSetRemoval.setNumber} deleted</span>
                <button type="button" onClick={undoSetRemoval}>Undo</button>
              </div>}

              {!exercise.is_cardio && (
                <button className="hifi-link-button aw-add" type="button" onClick={() => addSet(exerciseIndex)}>Add set</button>
              )}
            </div>}

            {!isOpen && pendingSetRemoval?.exerciseIndex === exerciseIndex && <div className="set-removal-undo" role="status">
              <span>Set {pendingSetRemoval.setNumber} deleted</span>
              <button type="button" onClick={undoSetRemoval}>Undo</button>
            </div>}
          </article>
        })}
      </div>

      <button
        className="hifi-link-button aw-add aw-add-exercise"
        type="button"
        onClick={() => {
          setReplaceIndex(null)
          setIsSelectModalOpen(true)
        }}
      >
        Add exercise
      </button>
      <MediaCredit />

      {restPickerIndex !== null && session.exercises[restPickerIndex] && (() => {
        const exercise = session.exercises[restPickerIndex]
        const seconds = exercise.rest_enabled ? exercise.rest_seconds ?? DEFAULT_REST_SECONDS : null
        return (
          <WheelPickerSheet
            title="Rest Timer"
            subtitle={exercise.name}
            options={REST_OPTIONS}
            initialIndex={seconds === null ? 0 : Math.min(REST_OPTIONS.length - 1, Math.max(1, Math.round(seconds / 5)))}
            onDone={(value) => chooseRest(restPickerIndex, value)}
            onClose={() => setRestPickerIndex(null)}
          />
        )
      })()}
      {rpePicker && session.exercises[rpePicker.exerciseIndex]?.sets[rpePicker.setIndex] && (() => {
        const exercise = session.exercises[rpePicker.exerciseIndex]
        const set = exercise.sets[rpePicker.setIndex]
        const rpe = rpeValues[`${rpePicker.exerciseIndex}:${set.set_number}`] ?? set.rpe ?? null
        return (
          <RpeSheet
            subtitle={`${exercise.name} · Set ${set.set_number}${set.weight_kg ? `: ${set.weight_kg}kg` : ''}${set.reps ? ` × ${set.reps}` : ''}`}
            rpe={rpe}
            onDone={(value) => chooseRpe(rpePicker.exerciseIndex, rpePicker.setIndex, value)}
            onClose={() => setRpePicker(null)}
          />
        )
      })()}
      {runningRestIndex !== null && (() => {
        const nextExercise = session.exercises[nextExerciseIndex]
        const nextLabel = nextExercise && nextSetIndex >= 0
          ? `Next: ${nextExercise.name} Set ${nextExercise.sets[nextSetIndex].set_number}`
          : session.exercises[runningRestIndex]?.name
        return (
          <section className="aw-rest-sheet" aria-label="Rest timer">
            <div className="aw-rest-top">
              <span className="aw-rest-next">{nextLabel}</span>
              <button className="aw-rest-close" type="button" aria-label="Dismiss rest timer" onClick={() => stopRest(runningRestIndex)}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="aw-rest-controls">
              <button className="aw-step" type="button" aria-label="Rest 15 seconds less" onClick={() => changeRunningRest(runningRestIndex, -REST_STEP_SECONDS)}>
                <Minus size={20} aria-hidden="true" />
              </button>
              <strong className="aw-rest-time" role="timer">{formatRestLong(restRemaining[runningRestIndex])}</strong>
              <button className="aw-step" type="button" aria-label="Rest 15 seconds more" onClick={() => changeRunningRest(runningRestIndex, REST_STEP_SECONDS)}>
                <Plus size={20} aria-hidden="true" />
              </button>
              <button className="hifi-pill aw-rest-skip" type="button" onClick={() => stopRest(runningRestIndex)}>Skip</button>
            </div>
          </section>
        )
      })()}

      {showAiAdjustment && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowAiAdjustment(false) }}>
          <div className="confirmation-modal ai-adjust-modal" role="dialog" aria-modal="true" aria-labelledby="ai-adjust-title" tabIndex={-1} ref={aiAdjustmentDialogRef}>
            <button className="modal-close" type="button" onClick={() => setShowAiAdjustment(false)} aria-label="Close"><X size={20} /></button>
            <p className="eyebrow">AI trainer</p>
            <h2 id="ai-adjust-title">Workout adjustments</h2>
            {aiAdjustment.status === 'loading'
              && <p className="ai-adjust-loading" role="status">Reviewing your sets and effort ratings...</p>}
            {aiAdjustment.status === 'ready' && (aiAdjustment.suggestions.length === 0
              ? <div className="ai-adjust-feedback"><p className="ai-adjust-result-none" role="status">No modifications suggested. Your current plan looks on track for the rest of the session.</p></div>
              : <div className="ai-adjust-result">
                <ul>
                  {aiAdjustment.suggestions.map((suggestion, index) => {
                    const isApplied = aiAdjustment.applied.includes(index)
                    const exerciseName = session.exercises.find((exercise) => exercise.exercise_id === suggestion.exercise_id)?.name
                    return <li key={`${suggestion.exercise_id}:${suggestion.action}`} className={isApplied ? 'is-applied' : undefined}>
                      <span>{exerciseName ?? 'Exercise'}</span>
                      <p><strong>{describeAdjustment(suggestion)}.</strong> {suggestion.reason}</p>
                      {isApplied
                        ? <p className="ai-adjust-applied">Applied</p>
                        : <button className="ai-adjust-accept" type="button" onClick={() => applyOneAdjustment(index)}>Accept</button>}
                    </li>
                  })}
                </ul>
                {aiAdjustment.applied.length < aiAdjustment.suggestions.length
                  && <button className="ai-adjust-accept-all" type="button" onClick={applyAllAdjustments}>Accept all suggestions</button>}
              </div>)}
            {aiAdjustment.status === 'error' && <div className="ai-adjust-feedback">
              <p className="ai-adjust-error" role="alert">{aiAdjustment.message}</p>
              <button className="secondary-action" type="button" onClick={requestAiAdjustment}>Try again</button>
            </div>}
            {adjustmentUndo && <div className="set-removal-undo" role="status">
              <span>Adjustment applied</span>
              <button type="button" onClick={undoAdjustment}>Undo</button>
            </div>}
            <div className="modal-actions">
              <button className="secondary-action" type="button" onClick={() => setShowAiAdjustment(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showWarmup && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowWarmup(false) }}>
          <div className="confirmation-modal ai-adjust-modal warmup-modal" role="dialog" aria-modal="true" aria-labelledby="warmup-title" tabIndex={-1} ref={warmupDialogRef}>
            <button className="modal-close" type="button" onClick={() => setShowWarmup(false)} aria-label="Close"><X size={20} /></button>
            <p className="eyebrow">Warm-up</p>
            <h2 id="warmup-title">Warm-up plan</h2>
            {warmup.status === 'loading'
              && <p className="ai-adjust-loading" role="status">Building a warm-up from your working weights...</p>}
            {warmup.status === 'premium' && <div className="warmup-feedback">
              <p className="warmup-copy">
                <strong>Warm-up recommendations are a Premium feature.</strong> Upgrade to get a tailored
                warm-up with ramp-up sets built from the weights you are about to lift.
              </p>
              <button
                className="warmup-cta"
                type="button"
                onClick={() => navigate('/premium', { state: { from: location.pathname } })}
              >
                <Crown size={16} aria-hidden="true" />
                Upgrade to Premium
              </button>
            </div>}
            {warmup.status === 'ready' && <div className="warmup-plan">
              <p className="warmup-summary">{warmup.recommendation.summary}</p>
              <p className="warmup-total">
                <Clock3 size={14} aria-hidden="true" />
                About {formatWarmupDuration(warmup.recommendation.total_duration_seconds)}
              </p>
              <ul>
                {warmup.recommendation.steps.map((step, index) => <li className="warmup-step" key={`${step.title}-${index}`}>
                  <div className="warmup-step-heading">
                    <label className="warmup-step-select">
                      <input
                        type="checkbox"
                        checked={selectedWarmupSteps.includes(index)}
                        onChange={(event) => setSelectedWarmupSteps((current) => event.target.checked
                          ? [...current, index]
                          : current.filter((selectedIndex) => selectedIndex !== index))}
                      />
                      <strong>{step.title}</strong>
                    </label>
                    {step.duration_seconds ? <span>{formatWarmupDuration(step.duration_seconds)}</span> : null}
                  </div>
                  <p>{step.detail}</p>
                  {step.sets.length > 0 && <div className="warmup-sets">
                    {step.sets.map((set, setIndex) => <span key={setIndex}>
                      {set.weight_kg ? `${set.weight_kg} kg` : 'Bodyweight'} × {set.reps}
                    </span>)}
                  </div>}
                </li>)}
              </ul>
              <button
                className="warmup-cta"
                type="button"
                onClick={addSelectedWarmupSteps}
                disabled={!selectedWarmupSteps.length}
              >
                <Plus size={16} aria-hidden="true" />
                Add selected recommendations
              </button>
            </div>}
            {warmup.status === 'error' && <div className="warmup-feedback">
              <p className="ai-adjust-error" role="alert">{warmup.message}</p>
              <button className="secondary-action" type="button" onClick={requestWarmup}>Try again</button>
            </div>}
            <div className="modal-actions">
              <button className="secondary-action" type="button" onClick={() => setShowWarmup(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showFinish && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeFinish() }}>
          <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="finish-title" tabIndex={-1} ref={finishDialogRef}>
            <button className="modal-close" type="button" onClick={closeFinish} aria-label="Close"><X size={20} /></button>
            <p className="eyebrow">{session?.editWorkoutId ? 'Edit workout history' : 'Session complete'}</p>
            <h2 id="finish-title">{session?.editWorkoutId ? 'Save workout changes?' : 'Finish workout?'}</h2>
            {isEditingWorkout
              ? <p>Your original date and duration will be kept. Changes are saved to this workout only when confirmed.</p>
              : <p>
                  {(completedSets || completedCardio)
                    ? `${completedSets} of ${totalSets} sets done${session.exercises.some((exercise) => exercise.is_cardio) ? `, ${completedCardio} cardio` : ''} · `
                    : 'No sets completed yet. Complete at least one to save. · '}
                  <ElapsedTime startedAt={session.startedAt} format={(seconds) => `${Math.max(1, Math.round(seconds / 60))} min`} />
                </p>}
            <div className="workout-name-field">
              <label htmlFor="completed-workout-name">Workout name (e.g. Best chest day)</label>
              <input
                id="completed-workout-name"
                type="text"
                maxLength={120}
                placeholder="Best chest day"
                value={workoutName}
                onChange={(event) => setWorkoutName(event.target.value)}
                disabled={isSaving}
              />
            </div>
            <fieldset className="fatigue-field" aria-describedby="fatigue-hint">
              <legend>How fatigued do you feel after this workout?</legend>
              <div className="fatigue-scale">
                {FATIGUE_LABELS.map((label, index) => {
                  const level = index + 1
                  return (
                    <button
                      key={level}
                      type="button"
                      className="fatigue-scale-button"
                      aria-pressed={fatigueLevel === level}
                      aria-label={`${level} of 10, ${label}`}
                      onClick={() => selectFatigue(level)}
                      disabled={isSaving}
                    >
                      {level}
                    </button>
                  )
                })}
              </div>
              <p className="fatigue-hint" id="fatigue-hint">
                {fatigueLevel === null
                  ? 'Choose 1 (fresh) to 10 (exhausted). This tunes tomorrow’s calories and training.'
                  : `${fatigueLevel}/10 · ${FATIGUE_LABELS[fatigueLevel - 1]}. Used for tomorrow’s calories and training.`}
              </p>
              {fatigueLevel !== null && fatigueLevel > 5 && (
                <p className="fatigue-hint fatigue-hint-high">
                  High fatigue: tomorrow’s calorie target gets a recovery bump and training volume will be reduced.
                </p>
              )}
            </fieldset>
            {saveError && <p className="form-error">{saveError}</p>}
            <div className="modal-actions">
              <button className="secondary-action" type="button" onClick={closeFinish} disabled={isSaving}>Keep training</button>
              <button className="danger-action" type="button" onClick={discardWorkout} disabled={isSaving}>{confirmDiscard ? 'Tap again to discard' : session?.editWorkoutId ? 'Discard edits' : 'Discard workout'}</button>
              <button className="primary-button" type="button" onClick={finishWorkout} disabled={isSaving || fatigueLevel === null || (!isEditingWorkout && completedSets === 0 && completedCardio === 0)}>{isSaving ? 'Saving...' : session?.editWorkoutId ? 'Save changes' : 'Save workout'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Pop-up de sélection d'exercice */}
      <SelectExerciseModal
        isOpen={isSelectModalOpen}
        onClose={() => {
          setIsSelectModalOpen(false)
          setReplaceIndex(null)
        }}
        onSelectExercise={handleSelectExercise}
        onCreateCustom={() => {
          setIsSelectModalOpen(false)
          navigate('/exercises/custom')
        }}
      />
    </div>
  )
}

export default ActiveWorkout