import type { WorkoutPlanSummary } from '../services/api'

/** Navigation state that opens today's plan in the active workout screen. */
export function planWorkoutState(plan: WorkoutPlanSummary) {
  return {
    planId: plan.id,
    routineId: plan.routine_id,
    name: plan.title,
    startedAt: new Date().toISOString(),
    exercises: plan.exercises.map((exercise) => ({
      exercise_id: exercise.exercise_id,
      name: exercise.name,
      previous_weight_kg: exercise.previous_weight_kg ?? null,
      previous_reps: exercise.reps,
      target_sets: exercise.sets,
      target_reps: exercise.reps,
      sets: Array.from({ length: Math.max(1, exercise.sets) }, (_, index) => ({
        set_number: index + 1,
        weight_kg: exercise.previous_weight_kg ?? 0,
        reps: exercise.reps,
        is_completed: false,
      })),
    })),
  }
}
