import { ChevronDown, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { usePageNavigate } from '../utils/usePageNavigate'
import PremiumUpsellButton from '../components/premium/PremiumUpsellButton'
import { activeWorkoutStorageKey, deleteRoutine, deleteWorkoutHistoryEntry, fetchDashboardSummary, fetchRoutines, fetchWorkoutHistory, getCachedDashboardSummary, getCurrentUser, overtrainingModPctStorageKey, readSavedCopy, type DashboardSummary } from '../services/api'
import { describeError } from '../utils/errors.js'
import { lastLifts, type LastLift } from '../utils/lastLifts'
import { OvertrainingBanner } from '../components/workout/OvertrainingBanner'
import WorkoutPhoto from '../components/workout/WorkoutPhoto'
import { planWorkoutState } from '../utils/workoutPlan'
import '../styles/workouts.css'
import type { ActiveExercise, Routine, WorkoutHistoryEntry } from '../types/workout'

function formatWorkoutDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unavailable'
  return formatMinutes(Math.round(seconds / 60))
}

function formatWorkoutDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${minutes} min`
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/** "Today", "Yesterday" or a short date such as "Nov 16", as in the mockup's recent workouts. */
function formatRelativeDay(value: string): string {
  const day = new Date(value)
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const daysAgo = Math.round((startOf(new Date()) - startOf(day)) / 86_400_000)
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(day)
}

function isCardioExercise(exercise: WorkoutHistoryEntry['exercises'][number]): boolean {
  return Boolean(
    exercise.is_cardio ||
    exercise.sets.some((set) => (set.duration_seconds ?? 0) > 0 || (set.distance_km ?? 0) > 0),
  )
}

function formatCardioDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const rem = Math.round(seconds % 60)
  return rem > 0 ? `${mins}m ${rem}s` : `${mins} min`
}

function formatCardioSummary(sets: WorkoutHistoryEntry['exercises'][number]['sets']): string {
  const set = sets.find((item) => item.is_completed) ?? sets[0]
  if (!set) return 'Cardio'
  const parts: string[] = []
  const duration = formatCardioDuration(set.duration_seconds)
  if (duration) parts.push(duration)
  if (set.distance_km != null && set.distance_km > 0) {
    const km = Number.isInteger(set.distance_km) ? String(set.distance_km) : String(Number(set.distance_km.toFixed(2)))
    parts.push(`${km} km`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'Cardio'
}

function getOvertrainingModPct(userId?: string): number {
  const key = overtrainingModPctStorageKey(userId)
  if (!key) return 0
  const modPct = Number(localStorage.getItem(key) || '0')
  return Number.isFinite(modPct) && modPct > 0 ? modPct : 0
}

function applyOvertrainingVolumeReduction(targetSets: number, userId?: string): number {
  const modPct = getOvertrainingModPct(userId)
  if (modPct > 0 && targetSets >= 2) {
    // At least one set fewer (or -15%) once there are 2 sets or more.
    return Math.max(1, Math.min(targetSets - 1, Math.round(targetSets * (1 - modPct / 100))))
  }
  return targetSets
}

function applyOvertrainingWeightReduction(weightKg: number, userId?: string): number {
  const modPct = getOvertrainingModPct(userId)
  if (modPct > 0 && weightKg > 0) {
    // Lower the load by the deload percentage, rounded to 0.5 kg.
    const reduced = weightKg * (1 - modPct / 100)
    return Math.max(0, Math.round(reduced * 2) / 2)
  }
  return weightKg
}

// Routines store no weight, so each exercise starts from the last weight the user lifted for it,
// lowered while an overtraining deload is active.
function createActiveExercises(routine: Routine, lifts: Map<string, LastLift>, userId?: string): ActiveExercise[] {
  const modActive = getOvertrainingModPct(userId) > 0
  return routine.exercises.map((exercise) => {
    const adjustedSets = applyOvertrainingVolumeReduction(exercise.target_sets ?? 1, userId)
    const lastWeight = lifts.get(exercise.exercise_id)?.weight_kg ?? null
    return {
      exercise_id: exercise.exercise_id,
      name: exercise.name,
      previous_weight_kg: lastWeight,
      previous_reps: lifts.get(exercise.exercise_id)?.reps ?? null,
      target_sets: adjustedSets,
      target_reps: exercise.target_reps,
      sets: Array.from({ length: adjustedSets }, (_, index) => ({
        set_number: index + 1,
        weight_kg: applyOvertrainingWeightReduction(lastWeight ?? 0, userId),
        reps: exercise.reps_by_set?.[index] ?? exercise.target_reps ?? 0,
        rpe: modActive ? 6 : undefined,
        is_completed: false,
      })),
    }
  })
}

type SetSummary = { text: string; label: string }

/** "3S 8–10R 40kg": S for sets, R for reps; the label spells it out for screen readers. */
function describeSets(sets: number, reps: number[], weightKg: number | null): SetSummary {
  const counted = reps.filter((rep) => rep > 0)
  const low = Math.min(...counted)
  const high = Math.max(...counted)
  const repText = counted.length === 0 ? null : low === high ? `${low}` : `${low}–${high}`
  const weight = weightKg && weightKg > 0 ? weightKg : null
  return {
    text: [`${sets}S`, repText && `${repText}R`, weight && `${weight}kg`].filter(Boolean).join(' '),
    label: [`${sets} ${sets === 1 ? 'set' : 'sets'}`, repText && `${repText} reps`, weight && `${weight} kg`].filter(Boolean).join(', '),
  }
}

function summarizeSets(sets: WorkoutHistoryEntry['exercises'][number]['sets']): SetSummary {
  return describeSets(sets.length, sets.map((set) => set.reps), Math.max(0, ...sets.map((set) => set.weight_kg)))
}

const LIST_PREVIEW_SIZE = 3

function Workouts() {
  const navigate = usePageNavigate()
  const currentUserId = getCurrentUser()?.id
  // Last copies saved on this device show at once; the requests below refresh them.
  const [savedRoutines] = useState(() => (currentUserId ? readSavedCopy<Routine[]>(`routines:${currentUserId}`) : null))
  const [savedHistory] = useState(() => (currentUserId ? readSavedCopy<WorkoutHistoryEntry[]>(`history:${currentUserId}`) : null))
  const [routines, setRoutines] = useState<Routine[]>(savedRoutines ?? [])
  const [workoutHistory, setWorkoutHistory] = useState<WorkoutHistoryEntry[]>(savedHistory ?? [])
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [showAllRoutines, setShowAllRoutines] = useState(false)
  const lifts = useMemo(() => lastLifts(workoutHistory), [workoutHistory])
  const [isLoading, setIsLoading] = useState(!savedRoutines)
  const [error, setError] = useState<string | null>(null)
  const [isHistoryLoading, setIsHistoryLoading] = useState(() => Boolean(currentUserId) && !savedHistory)
  const [historyError, setHistoryError] = useState<string | null>(() => (
    getCurrentUser()?.id ? null : 'Sign in to view your workout history.'
  ))
  const [showDiscardActiveWorkout, setShowDiscardActiveWorkout] = useState(false)
  const [ongoingWorkoutName, setOngoingWorkoutName] = useState('your workout')
  const [routineToDelete, setRoutineToDelete] = useState<Routine | null>(null)
  const [isDeletingRoutine, setIsDeletingRoutine] = useState(false)
  const [routineDeleteError, setRoutineDeleteError] = useState<string | null>(null)
  const [workoutToDelete, setWorkoutToDelete] = useState<WorkoutHistoryEntry | null>(null)
  const [isDeletingWorkout, setIsDeletingWorkout] = useState(false)
  const [workoutDeleteError, setWorkoutDeleteError] = useState<string | null>(null)
  const [openRoutineId, setOpenRoutineId] = useState<string | null>(null)
  const [openWorkoutId, setOpenWorkoutId] = useState<string | null>(null)
  const [summary, setSummary] = useState<DashboardSummary | null>(() => getCachedDashboardSummary())
  const [activeDeloadPct, setActiveDeloadPct] = useState<number>(() => getOvertrainingModPct(currentUserId))

  useEffect(() => {
    setActiveDeloadPct(getOvertrainingModPct(currentUserId))
  }, [currentUserId])

  useEffect(() => {
    let isMounted = true
    fetchDashboardSummary()
      .then((data) => { if (isMounted) setSummary(data) })
      .catch(() => undefined) // The AI card keeps its loading text; routines and history still work.
    return () => {
      isMounted = false
    }
  }, [currentUserId])

  useEffect(() => {
    fetchRoutines()
      .then(setRoutines)
      .catch((requestError: Error) => setError(describeError(requestError, "We couldn't load your routines. Please try again.")))
      .finally(() => setIsLoading(false))
  }, [currentUserId])

  useEffect(() => {
    if (!currentUserId) {
      setIsHistoryLoading(false)
      setHistoryError('Sign in to view your workout history.')
      return
    }

    let isMounted = true
    setHistoryError(null)
    fetchWorkoutHistory(currentUserId)
      .then((items) => { if (isMounted) setWorkoutHistory(items) })
      .catch((requestError: Error) => {
        if (isMounted) setHistoryError(describeError(requestError, "We couldn't load your workout history. Please try again."))
      })
      .finally(() => {
        if (isMounted) setIsHistoryLoading(false)
      })

    return () => {
      isMounted = false
    }
  }, [currentUserId])

  function startWorkout(routine?: Routine) {
    const modActive = getOvertrainingModPct(currentUserId) > 0
    const baseName = routine?.name ?? 'Empty workout'
    navigate('/workouts/active', {
      state: {
        routineId: routine?.id,
        name: modActive && routine ? `${baseName} (AI Deload -15%)` : baseName,
        startedAt: new Date().toISOString(),
        exercises: routine ? createActiveExercises(routine, lifts, currentUserId) : [],
      },
    })
  }

  function repeatWorkout(workout: WorkoutHistoryEntry) {
    const modActive = getOvertrainingModPct(currentUserId) > 0
    const exercises: ActiveExercise[] = workout.exercises.map((exercise) => {
      const isCardio = isCardioExercise(exercise)
      const previousSets = [...exercise.sets].sort((first, second) => first.set_number - second.set_number)
      const lastSet = previousSets[previousSets.length - 1]
      if (isCardio) {
        return {
          exercise_id: exercise.exercise_id,
          name: exercise.name,
          is_cardio: true,
          previous_weight_kg: null,
          previous_reps: null,
          target_sets: 1,
          target_reps: null,
          sets: [{
            set_number: 1,
            weight_kg: 0,
            reps: 0,
            // Start empty: a copied time would be saved as if this block was done again.
            duration_seconds: null,
            distance_km: null,
            cardio_status: 'idle',
            cardio_accumulated: 0,
            is_completed: false,
          }],
        }
      }
      const targetCount = applyOvertrainingVolumeReduction(previousSets.length || 1, currentUserId)
      const slicedSets = previousSets.slice(0, targetCount)

      return {
        exercise_id: exercise.exercise_id,
        name: exercise.name,
        is_cardio: false,
        previous_weight_kg: lastSet?.weight_kg ?? null,
        previous_reps: lastSet?.reps ?? null,
        target_sets: targetCount,
        target_reps: lastSet?.reps ?? null,
        sets: slicedSets.length > 0
          ? slicedSets.map((set, index) => ({
            set_number: index + 1,
            weight_kg: applyOvertrainingWeightReduction(set.weight_kg, currentUserId),
            reps: set.reps,
            rpe: modActive ? 6 : undefined,
            is_completed: false,
          }))
          : [{ set_number: 1, weight_kg: 0, reps: 0, is_completed: false }],
      }
    })

    navigate('/workouts/active', {
      state: {
        name: modActive ? `${workout.name} (AI Deload -15%)` : workout.name,
        startedAt: new Date().toISOString(),
        exercises,
      },
    })
  }

  function editWorkout(workout: WorkoutHistoryEntry) {
    const exercises: ActiveExercise[] = workout.exercises.map((exercise) => {
      const isCardio = isCardioExercise(exercise)
      const sets = [...exercise.sets]
        .sort((first, second) => first.set_number - second.set_number)
        .map((set, index) => ({
          set_number: index + 1,
          weight_kg: set.weight_kg,
          reps: set.reps,
          rpe: set.rpe,
          duration_seconds: set.duration_seconds ?? null,
          distance_km: set.distance_km ?? null,
          cardio_status: isCardio ? ((set.duration_seconds ?? 0) > 0 || set.is_completed ? 'finished' as const : 'manual' as const) : undefined,
          cardio_accumulated: isCardio ? (set.duration_seconds ?? 0) : undefined,
          is_completed: set.is_completed,
        }))

      return {
        exercise_id: exercise.exercise_id,
        name: exercise.name,
        is_cardio: isCardio,
        previous_weight_kg: isCardio ? null : (sets[sets.length - 1]?.weight_kg ?? null),
        previous_reps: isCardio ? null : (sets[sets.length - 1]?.reps ?? null),
        target_sets: sets.length || 1,
        target_reps: isCardio ? null : (sets[sets.length - 1]?.reps ?? null),
        sets: sets.length > 0
          ? sets
          : [{ set_number: 1, weight_kg: 0, reps: 0, ...(isCardio ? { cardio_status: 'manual' as const } : {}), is_completed: false }],
      }
    })

    navigate('/workouts/active', {
      state: {
        editWorkoutId: workout.id,
        name: workout.name,
        startedAt: new Date().toISOString(),
        fatigueLevel: workout.fatigue_level,
        exercises,
      },
    })
  }

  function requestEmptyWorkout() {
    const workoutKey = activeWorkoutStorageKey(currentUserId)
    const saved = workoutKey ? localStorage.getItem(workoutKey) : null
    if (saved) {
      try {
        const activeWorkout = JSON.parse(saved) as { name?: string; exercises?: unknown[]; startedAt?: string }
        if (activeWorkout.startedAt && Array.isArray(activeWorkout.exercises)) {
          setOngoingWorkoutName(activeWorkout.name || 'your workout')
          setShowDiscardActiveWorkout(true)
          return
        }
      } catch {
        if (workoutKey) localStorage.removeItem(workoutKey)
      }
    }
    startWorkout()
  }

  function discardAndStartEmptyWorkout() {
    const workoutKey = activeWorkoutStorageKey(currentUserId)
    if (workoutKey) localStorage.removeItem(workoutKey)
    sessionStorage.removeItem('set_plate_pending_exercise')
    setShowDiscardActiveWorkout(false)
    startWorkout()
  }

  function clearDeloadModification() {
    const modKey = overtrainingModPctStorageKey(currentUserId)
    if (modKey) localStorage.removeItem(modKey)
    if (currentUserId) {
      localStorage.setItem(
        `set_plate_overtraining_state_${currentUserId}`,
        JSON.stringify({ modsApplied: false, dismissed: false, dismissedAt: null }),
      )
    }
    setActiveDeloadPct(0)
  }

  async function confirmDeleteRoutine() {
    if (!routineToDelete) return
    setIsDeletingRoutine(true)
    setRoutineDeleteError(null)
    try {
      await deleteRoutine(routineToDelete.id)
      setRoutines((current) => current.filter((routine) => routine.id !== routineToDelete.id))
      setRoutineToDelete(null)
    } catch (requestError) {
      setRoutineDeleteError(requestError instanceof Error ? requestError.message : 'Unable to delete routine')
    } finally {
      setIsDeletingRoutine(false)
    }
  }

  async function confirmDeleteWorkout() {
    if (!workoutToDelete || !currentUserId) return
    setIsDeletingWorkout(true)
    setWorkoutDeleteError(null)
    try {
      await deleteWorkoutHistoryEntry(currentUserId, workoutToDelete.id)
      setWorkoutHistory((current) => current.filter((workout) => workout.id !== workoutToDelete.id))
      setWorkoutToDelete(null)
    } catch (requestError) {
      setWorkoutDeleteError(requestError instanceof Error ? requestError.message : "We couldn't remove this workout.")
    } finally {
      setIsDeletingWorkout(false)
    }
  }

  const visibleRoutines = showAllRoutines ? routines : routines.slice(0, LIST_PREVIEW_SIZE)
  const visibleHistory = showAllHistory ? workoutHistory : workoutHistory.slice(0, LIST_PREVIEW_SIZE)
  const plan = summary?.plan
  const completedToday = summary?.completed_workout_today
  const planDuration = summary?.workout && summary.workout.title === plan?.title ? summary.workout.estimated_duration_minutes : null

  return (
    <div className="screen hifi-screen workouts-screen">
      <header className="hifi-page-header">
        <h1 className="hifi-page-title">Workouts</h1>
        <span className="hifi-card-actions">
          <PremiumUpsellButton compact />
          <button className="hifi-pill" type="button" onClick={requestEmptyWorkout}>Create workout</button>
        </span>
      </header>

      <OvertrainingBanner workouts={workoutHistory} />

      {activeDeloadPct > 0 && (
        <div className="hifi-card workouts-deload" role="status">
          <Sparkles size={18} aria-hidden="true" />
          <div>
            <p className="workouts-deload-title">AI deload active (-{activeDeloadPct}% volume &amp; load, RPE 6 cap)</p>
            <p className="hifi-muted">Starting or repeating any workout below will reduce sets and weights by {activeDeloadPct}%.</p>
          </div>
          <button className="hifi-pill" type="button" onClick={clearDeloadModification}>Disable</button>
        </div>
      )}

      <section className="hifi-section" aria-labelledby="ai-workout-title">
        <div className="hifi-section-heading">
          <h2 className="hifi-section-title" id="ai-workout-title">AI Workout</h2>
        </div>
        <div className="hifi-card workouts-ai-card">
          {!summary ? (
            <p className="hifi-muted" role="status">Loading today&apos;s workout…</p>
          ) : completedToday ? (
            <p className="workouts-plan-intro">Workout completed today<span>{completedToday.name}</span></p>
          ) : plan?.is_rest_day ? (
            <>
              <p className="workouts-plan-intro">Rest day<span>Recovery recommended by your AI trainer</span></p>
              {plan.ai_reasoning && <p className="hifi-muted">{plan.ai_reasoning}</p>}
            </>
          ) : plan ? (
            <>
              <p className="workouts-plan-intro">Your next session<span>based on your goals and progress</span></p>
              <div className="workouts-plan">
                <WorkoutPhoto name={plan.title} exercises={plan.exercises} size={88} />
                <div className="workouts-plan-body">
                  <h3>{plan.title}</h3>
                  <div className="hifi-card-footer">
                    <p className="hifi-caption">
                      {planDuration ? <span>{planDuration} min</span> : null}
                      <span>{plan.exercises.length} exercises</span>
                    </p>
                    <button className="hifi-pill" type="button" onClick={() => navigate('/workouts/active', { state: planWorkoutState(plan) })}>Start</button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <p className="hifi-muted">Today&apos;s AI workout shows here once your trainer has planned it on Home.</p>
          )}
        </div>
      </section>

      {isLoading && <p className="visually-hidden" role="status">Loading routines...</p>}
      {error && <div className="card state-card" role="alert">{error}</div>}
      {routineDeleteError && <div className="card routine-delete-error" role="alert">{routineDeleteError}</div>}

      <section className="hifi-section" aria-labelledby="saved-routines-title">
        <div className="hifi-section-heading">
          <h2 className="hifi-section-title" id="saved-routines-title">My routines</h2>
          {routines.length > LIST_PREVIEW_SIZE && (
            <button className="hifi-link-button" type="button" aria-expanded={showAllRoutines} onClick={() => setShowAllRoutines((current) => !current)}>
              {showAllRoutines ? 'Show less' : 'See all'}
            </button>
          )}
        </div>
        {!isLoading && !error && routines.length === 0 && <p className="hifi-card hifi-muted">No saved routines yet.</p>}
        <div className="workouts-list">
          {visibleRoutines.map((routine) => {
            const isOpen = openRoutineId === routine.id
            return (
              <article className="hifi-card workouts-item" key={routine.id}>
                <button className="workouts-item-toggle" type="button" aria-expanded={isOpen} onClick={() => setOpenRoutineId(isOpen ? null : routine.id)}>
                  <WorkoutPhoto name={routine.name} exercises={routine.exercises} size={64} />
                  <span className="workouts-item-text">
                    <span className="workouts-item-name">{routine.name}</span>
                    <span className="workouts-item-meta">
                      {routine.estimated_duration_minutes !== null && <span>{formatMinutes(routine.estimated_duration_minutes)}</span>}
                      <span>{routine.exercises.length} exercises</span>
                    </span>
                  </span>
                  <ChevronDown className="workouts-item-chevron" size={20} aria-hidden="true" />
                </button>
                {isOpen && (
                  <div className="workouts-item-details">
                    <ul className="workouts-history-rows">
                      {routine.exercises.map((exercise) => {
                        const summary = describeSets(
                          exercise.target_sets ?? 0,
                          exercise.reps_by_set?.length ? exercise.reps_by_set : [exercise.target_reps ?? 0],
                          lifts.get(exercise.exercise_id)?.weight_kg ?? null,
                        )
                        return (
                          <li key={exercise.exercise_id}>
                            <span>{exercise.name}</span>
                            {exercise.target_sets ? <span aria-label={summary.label}>{summary.text}</span> : null}
                          </li>
                        )
                      })}
                    </ul>
                    <div className="hifi-card-footer">
                      <span className="hifi-card-actions">
                        <button className="hifi-link-button" type="button" onClick={() => navigate('/workouts/create', { state: { routine } })}>Edit</button>
                        <button className="hifi-link-button" type="button" onClick={() => { setRoutineDeleteError(null); setRoutineToDelete(routine) }}>Delete</button>
                      </span>
                      <button className="hifi-pill" type="button" onClick={() => startWorkout(routine)}>Start workout</button>
                    </div>
                  </div>
                )}
              </article>
            )
          })}
        </div>
        <button className="hifi-link-button workouts-create-routine" type="button" onClick={() => navigate('/workouts/create')}>+ Create routine</button>
      </section>

      <section className="hifi-section" aria-labelledby="workout-history-title">
        <div className="hifi-section-heading">
          <h2 className="hifi-section-title" id="workout-history-title">Recent workouts</h2>
          {!historyError && workoutHistory.length > LIST_PREVIEW_SIZE && (
            <button className="hifi-link-button" type="button" aria-expanded={showAllHistory} onClick={() => setShowAllHistory((current) => !current)}>
              {showAllHistory ? 'Show less' : 'See all'}
            </button>
          )}
        </div>
        {isHistoryLoading && <p className="visually-hidden" role="status">Loading your workouts...</p>}
        {historyError && <div className="card state-card" role="alert">{historyError}</div>}
        {!isHistoryLoading && !historyError && workoutHistory.length === 0 && (
          <p className="hifi-card hifi-muted">No completed workouts yet. Finish a workout to start building your history.</p>
        )}
        {!historyError && workoutHistory.length > 0 && (
          <div className="workouts-list">
            {visibleHistory.map((workout) => {
              const isOpen = openWorkoutId === workout.id
              return (
                <article className="hifi-card workouts-item is-history" key={workout.id}>
                  <button className="workouts-item-toggle" type="button" aria-expanded={isOpen} onClick={() => setOpenWorkoutId(isOpen ? null : workout.id)}>
                    <span className="workouts-item-text">
                      <span className="workouts-item-name">{workout.name}</span>
                      <span className="workouts-item-meta is-muted">
                        <span>{formatWorkoutDuration(workout.duration_seconds)}</span>
                        <span>{workout.exercises.length} exercises</span>
                      </span>
                    </span>
                    <span className="workouts-item-date">{formatRelativeDay(workout.started_at)}</span>
                  </button>
                  {isOpen && (
                    <div className="workouts-item-details">
                      {workout.exercises.length > 0 && (
                        <ul className="workouts-history-rows">
                          {workout.exercises.map((exercise) => (
                            <li key={exercise.exercise_id}>
                              <span>{exercise.name}</span>
                              {isCardioExercise(exercise)
                                ? <span>{formatCardioSummary(exercise.sets)}</span>
                                : <span aria-label={summarizeSets(exercise.sets).label}>{summarizeSets(exercise.sets).text}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="hifi-caption">
                        {formatWorkoutDate(workout.started_at)}{workout.fatigue_level != null && ` · Fatigue ${workout.fatigue_level}/10`}
                      </p>
                      <div className="hifi-card-footer">
                        <span className="hifi-card-actions">
                          <button className="hifi-link-button" type="button" onClick={() => editWorkout(workout)}>Edit</button>
                          <button className="hifi-link-button" type="button" onClick={() => { setWorkoutDeleteError(null); setWorkoutToDelete(workout) }}>Delete</button>
                        </span>
                        <button className="hifi-pill" type="button" onClick={() => repeatWorkout(workout)}>Repeat</button>
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>

      {workoutToDelete && <div className="modal-backdrop">
        <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="delete-workout-title">
          <p className="eyebrow">Remove workout history</p>
          <h2 id="delete-workout-title">Delete {workoutToDelete.name}?</h2>
          <p>This completed workout and its recorded sets will be permanently deleted. Saved routines will not be affected.</p>
          {workoutDeleteError && <p className="form-error" role="alert">{workoutDeleteError}</p>}
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={() => setWorkoutToDelete(null)} disabled={isDeletingWorkout}>Cancel</button>
            <button className="danger-action" type="button" onClick={confirmDeleteWorkout} disabled={isDeletingWorkout}>
              {isDeletingWorkout ? 'Deleting...' : 'Delete workout'}
            </button>
          </div>
        </div>
      </div>}

      {routineToDelete && <div className="modal-backdrop">
        <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="delete-routine-title">
          <p className="eyebrow">Remove saved routine</p>
          <h2 id="delete-routine-title">Delete {routineToDelete.name}?</h2>
          <p>The routine and its exercise plan will be deleted. Saved workout history will be kept.</p>
          {routineDeleteError && <p className="form-error" role="alert">{routineDeleteError}</p>}
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={() => setRoutineToDelete(null)} disabled={isDeletingRoutine}>Cancel</button>
            <button className="danger-action" type="button" onClick={confirmDeleteRoutine} disabled={isDeletingRoutine}>
              {isDeletingRoutine ? 'Deleting...' : 'Delete routine'}
            </button>
          </div>
        </div>
      </div>}

      {showDiscardActiveWorkout && <div className="modal-backdrop">
        <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="discard-active-workout-title">
          <p className="eyebrow">Workout in progress</p>
          <h2 id="discard-active-workout-title">Discard ongoing workout?</h2>
          <p>{ongoingWorkoutName} hasn’t been saved. Discard it and start an empty workout?</p>
          <div className="modal-actions">
            <button className="secondary-action" type="button" onClick={() => setShowDiscardActiveWorkout(false)}>Keep workout</button>
            <button className="danger-action" type="button" onClick={discardAndStartEmptyWorkout}>Discard &amp; start empty</button>
          </div>
        </div>
      </div>}
    </div>
  )
}

export default Workouts