export interface RoutineExercise {
  exercise_id: string
  name: string
  target_sets: number | null
  target_reps: number | null
  reps_by_set?: number[] | null
}

export interface Routine {
  id: string
  name: string
  exercises: RoutineExercise[]
  estimated_duration_minutes: number | null
}

export interface RoutineCreatePayload {
  name: string
  exercises: Array<{
    exercise_id: string
    target_sets: number
    target_reps: number
    reps_by_set: number[]
  }>
}

export type SetKind = 'normal' | 'warmup' | 'drop' | 'failure'

export interface WorkoutSet {
  set_number: number
  weight_kg: number
  reps: number
  rpe?: number | null
  is_completed: boolean

  // Cardio fields
  duration_seconds?: number | null
  distance_km?: number | null
  cardio_status?: 'idle' | 'running' | 'paused' | 'finished' | 'manual'
  cardio_started_at?: string | null
  cardio_accumulated?: number
}

export interface ActiveExercise {
  exercise_id: string
  name: string
  images?: string[]
  previous_weight_kg: number | null
  previous_reps: number | null
  notes?: string
  rest_enabled?: boolean
  rest_seconds?: number
  target_sets?: number | null
  target_reps?: number | null
  is_cardio?: boolean
  /** No weight to enter: the catalog lists body weight as its only equipment. */
  is_bodyweight?: boolean
  sets: WorkoutSet[]
}

export interface ActiveSession {
  planId?: string
  routineId?: string
  editWorkoutId?: string
  fatigueLevel?: number | null
  name: string
  startedAt: string
  exercises: ActiveExercise[]
  setKinds: Record<string, SetKind>
  rpeValues?: Record<string, number>
  warmupSteps?: WarmupStep[]
  /** Set once a warm-up was added, so the same workout can't get a second one. */
  warmupAdded?: boolean
}

export interface WorkoutLogCreate {
  plan_id?: string
  routine_id?: string
  name: string
  duration_seconds: number
  started_at: string
  completed_at: string
  fatigue_level?: number | null
  exercises: Array<{
    exercise_id: string
    is_cardio?: boolean
    sets: WorkoutSet[]
  }>
}

export interface WorkoutHistoryEntry {
  id: string
  routine_id: string | null
  name: string
  started_at: string
  completed_at: string | null
  duration_seconds: number
  fatigue_level: number | null
  exercises: Array<{
    exercise_id: string
    name: string
    is_cardio?: boolean
    sets: Array<{
      set_number: number
      reps: number
      weight_kg: number
      rpe: number | null
      duration_seconds?: number | null
      distance_km?: number | null
      is_completed: boolean
    }>
  }>
}

export type WorkoutStatisticsRange = '1W' | '1M' | '3M'

export interface WorkoutStatisticsVolumePoint {
  date: string
  volume_kg: number
}

export interface WorkoutStatisticsMuscleGroup {
  muscle_group: string
  volume_kg: number
}

export interface WorkoutStatisticsFatiguePoint {
  date: string
  fatigue_level: number
  workout_id: string
  name: string
  workout_count: number
}

export interface WorkoutStatistics {
  range: WorkoutStatisticsRange
  start_date: string
  end_date: string
  total_workouts: number
  total_volume_kg: number
  total_duration_seconds: number
  workouts_with_duration: number
  eligible_set_count: number
  progression_granularity: 'day' | 'week'
  volume_progression: WorkoutStatisticsVolumePoint[]
  muscle_group_distribution: WorkoutStatisticsMuscleGroup[]
  classified_volume_kg: number
  unclassified_volume_kg: number
  fatigue_history: WorkoutStatisticsFatiguePoint[]
  fatigue_workouts: number
  fatigue_days: number
  fatigue_average: number | null
  fatigue_latest: number | null
}

export type LiveWorkoutAdjustmentAction = 'reduce_load' | 'reduce_reps' | 'drop_set' | 'stop_exercise'

export interface LiveWorkoutAdjustmentSuggestion {
  exercise_id: string
  action: LiveWorkoutAdjustmentAction
  reason: string
  new_weight_kg?: number | null
  new_reps?: number | null
}

export interface LiveWorkoutAdjustmentRequest {
  name: string
  duration_seconds: number
  user_goal?: string | null
  exercises: Array<{
    exercise_id: string
    name: string
    is_cardio?: boolean
    previous_weight_kg: number | null
    previous_reps: number | null
    rest_seconds: number | null
    target_sets?: number | null
    target_reps?: number | null
    sets: Array<WorkoutSet & { kind: SetKind }>
  }>
}

export interface LiveWorkoutAdjustmentResponse {
  suggestions: LiveWorkoutAdjustmentSuggestion[]
};

export interface WarmupSet {
  weight_kg: number | null
  reps: number
}

export interface WarmupStep {
  title: string
  detail: string
  duration_seconds?: number | null
  exercise_id?: string | null
  sets: WarmupSet[]
}

export interface WarmupRecommendation {
  summary: string
  total_duration_seconds: number
  steps: WarmupStep[]
}

export interface WarmupRecommendationRequest {
  name: string
  user_goal?: string | null
  exercises: Array<{
    exercise_id: string
    name: string
    is_cardio?: boolean
    working_weight_kg?: number | null
    target_reps?: number | null
  }>
}