import { Play, Plus } from 'lucide-react'
import { useState } from 'react'
import { activeWorkoutStorageKey, addMealLog, fetchRoutines, getCurrentUser } from '../../services/api'
import type { ChatExercise, ChatMeal, ChatMessage } from '../../types'
import type { ActiveExercise, Routine } from '../../types/workout'
import { useT } from '../../i18n'
import { describeError } from '../../utils/errors'
import { useDialogBehavior } from '../../utils/useDialogBehavior'
import { usePageNavigate } from '../../utils/usePageNavigate'

// The same starting targets the routine editor gives a newly added exercise.
const SETS = 3
const REPS = 10

function activeExercise({ id, name, is_cardio: isCardio }: ChatExercise): ActiveExercise {
  const base = { exercise_id: id, name, previous_weight_kg: null, previous_reps: null }
  if (isCardio) {
    return {
      ...base,
      is_cardio: true,
      target_sets: 1,
      target_reps: null,
      sets: [{ set_number: 1, weight_kg: 0, reps: 0, duration_seconds: null, distance_km: null, cardio_status: 'idle', cardio_accumulated: 0, is_completed: false }],
    }
  }
  return {
    ...base,
    target_sets: SETS,
    target_reps: REPS,
    sets: Array.from({ length: SETS }, (_, index) => ({ set_number: index + 1, weight_kg: 0, reps: REPS, is_completed: false })),
  }
}

function hasWorkoutInProgress(): boolean {
  const key = activeWorkoutStorageKey()
  return Boolean(key && localStorage.getItem(key))
}

/** The buttons under a coach answer. Nothing is saved until the user taps one. */
export default function CoachActions({ message }: { message: ChatMessage }) {
  const t = useT()
  const navigate = usePageNavigate()
  const [dialog, setDialog] = useState<'routine' | 'replace' | null>(null)
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [added, setAdded] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialogBehavior(dialog !== null, () => setDialog(null))
  const { exercises, meals = [] } = message

  function startWorkout() {
    navigate('/workouts/active', {
      state: { name: t('coach.workoutName'), startedAt: new Date().toISOString(), exercises: exercises.map(activeExercise) },
    })
  }

  function chooseRoutine() {
    setError(null)
    setRoutines(null)
    setDialog('routine')
    fetchRoutines()
      .then(setRoutines)
      .catch((failure) => {
        setDialog(null)
        setError(describeError(failure, t('workouts.errorRoutines')))
      })
  }

  // The routine editor opens with the exercises added, so the user reviews them before saving.
  function openEditor(routine?: Routine) {
    navigate('/workouts/create', { state: { routine, addExercises: exercises } })
  }

  async function addMeal(meal: ChatMeal) {
    const userId = getCurrentUser()?.id
    if (!userId || adding) return
    setAdding(meal.key)
    setError(null)
    try {
      await addMealLog({ user_id: userId, name: meal.name, meal_type: meal.meal_type, ingredients: meal.ingredients })
      setAdded((keys) => [...keys, meal.key])
    } catch (failure) {
      setError(describeError(failure, t('add.errorSave')))
    } finally {
      setAdding(null)
    }
  }

  if (!exercises.length && !meals.length) return null

  const canStartWorkout = exercises.length >= 2 || (exercises.length === 1 && exercises[0].is_cardio)

  return (
    <>
      {exercises.length > 0 && (
        <div className="coach-actions">
          {canStartWorkout && (
            <button type="button" className="hifi-pill" onClick={() => (hasWorkoutInProgress() ? setDialog('replace') : startWorkout())}>
              <Play size={14} aria-hidden="true" /> {t('coach.startWorkout')}
            </button>
          )}
          <button type="button" className="hifi-pill" onClick={chooseRoutine}>
            <Plus size={14} aria-hidden="true" /> {t('coach.addToRoutine')}
          </button>
        </div>
      )}

      {meals.map((meal) => (
        <div className="coach-meal" key={meal.key}>
          <div>
            <strong>{meal.name}</strong>
            <span>{t('coach.mealFigures', { kcal: meal.calories, protein: Math.round(meal.proteins_g) })}</span>
          </div>
          <button type="button" className="hifi-pill" disabled={adding !== null || added.includes(meal.key)} onClick={() => void addMeal(meal)}>
            {added.includes(meal.key) ? t('coach.mealAdded') : t('coach.addMeal')}
          </button>
        </div>
      ))}

      {error && <p className="coach-error" role="alert">{error}</p>}

      {dialog && (
        <div className="ai-tip-backdrop" onClick={() => setDialog(null)}>
          <div
            className="ai-tip-dialog coach-history"
            role="dialog"
            aria-modal="true"
            aria-label={t(dialog === 'routine' ? 'coach.addToRoutine' : 'coach.startWorkout')}
            tabIndex={-1}
            ref={dialogRef}
            onClick={(event) => event.stopPropagation()}
          >
            {dialog === 'replace' ? (
              <>
                <h3>{t('coach.replaceTitle')}</h3>
                <p>{t('coach.replaceText')}</p>
                <ul>
                  <li><button type="button" onClick={() => navigate('/workouts/active')}>{t('coach.resumeWorkout')}</button></li>
                  <li><button type="button" onClick={startWorkout}>{t('coach.replaceWorkout')}</button></li>
                </ul>
              </>
            ) : (
              <>
                <h3>{t('coach.addToRoutine')}</h3>
                {routines === null ? <p role="status">{t('common.loading')}</p> : (
                  <ul>
                    <li><button type="button" onClick={() => openEditor()}>{t('coach.newRoutine')}</button></li>
                    {routines.map((routine) => (
                      <li key={routine.id}><button type="button" onClick={() => openEditor(routine)}>{routine.name}</button></li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <button type="button" className="primary-button" onClick={() => setDialog(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </>
  )
}
