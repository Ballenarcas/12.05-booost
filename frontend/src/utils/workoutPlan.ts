import type { WorkoutPlanSummary } from '../services/api'

/** Navigation state that opens today's plan in the active workout screen. */
export function planWorkoutState(plan: WorkoutPlanSummary, deloadPct = 0) {
  const alreadyDeloaded = Boolean(
    plan.ai_reasoning && /(?:deload(?: week)? active|descarga(?:.*)?activa)/i.test(plan.ai_reasoning),
  )
  const factor = deloadPct > 0 && !alreadyDeloaded ? 1 - deloadPct / 100 : 1
  const applyDeload = factor < 1

  return {
    planId: plan.id,
    routineId: plan.routine_id,
    name: applyDeload ? `${plan.title} (Deload -${deloadPct}%)` : plan.title,
    startedAt: new Date().toISOString(),
    exercises: plan.exercises.map((exercise) => {
      const sets = applyDeload && exercise.sets >= 2
        ? Math.max(1, Math.min(exercise.sets - 1, Math.round(exercise.sets * factor)))
        : Math.max(1, exercise.sets)
      const weight =
        exercise.previous_weight_kg && exercise.previous_weight_kg > 0 && applyDeload
          ? Math.max(0, Math.round(exercise.previous_weight_kg * factor * 2) / 2)
          : (exercise.previous_weight_kg ?? null)

      return {
        exercise_id: exercise.exercise_id,
        name: exercise.name,
        previous_weight_kg: exercise.previous_weight_kg ?? null,
        previous_reps: exercise.reps,
        target_sets: sets,
        target_reps: exercise.reps,
        sets: Array.from({ length: sets }, (_, index) => ({
          set_number: index + 1,
          weight_kg: weight ?? 0,
          reps: exercise.reps,
          rpe: deloadPct > 0 ? 6 : undefined,
          is_completed: false,
        })),
      }
    }),
  }
}
