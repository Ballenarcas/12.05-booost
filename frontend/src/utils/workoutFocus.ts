export type WorkoutFocus = 'legs' | 'pull' | 'upper'

// Word stems that point to a focus; matched against the workout name and its exercise names.
const KEYWORDS: Record<Exclude<WorkoutFocus, 'upper'>, string[]> = {
  legs: ['leg', 'lower', 'squat', 'lunge', 'deadlift', 'rdl', 'hip thrust', 'glute', 'calf', 'calves', 'hamstring', 'quad', 'step-up', 'step up', 'pierna', 'sentadilla', 'zancada', 'peso muerto', 'glúteo', 'gemelo', 'femoral', 'cuádriceps', 'isquio', 'subida al'],
  pull: ['pull', 'row', 'lat ', 'chin', 'curl', 'bicep', 'back', 'shrug', 'rear delt', 'tirón', 'remo', 'dominada', 'jalón', 'bíceps', 'espalda', 'encogimiento', 'pájaro'],
}

function hits(text: string, words: string[]): number {
  return words.filter((word) => text.includes(word)).length
}

/**
 * The main focus of a workout, used to pick its default photo. The name counts three times as much as
 * one exercise, so "Leg day" stays legs even with a curl in it. Anything else (push, full body, cardio)
 * falls back to the upper-body photo.
 */
export function workoutFocus(name: string, exerciseNames: string[] = []): WorkoutFocus {
  const title = ` ${name.toLowerCase()} `
  const exercises = exerciseNames.map((exercise) => ` ${exercise.toLowerCase()} `)
  const score = (focus: keyof typeof KEYWORDS) => (
    3 * hits(title, KEYWORDS[focus]) + exercises.reduce((sum, exercise) => sum + hits(exercise, KEYWORDS[focus]), 0)
  )
  const legs = score('legs')
  const pull = score('pull')
  if (legs === 0 && pull === 0) return 'upper'
  return legs >= pull ? 'legs' : 'pull'
}
