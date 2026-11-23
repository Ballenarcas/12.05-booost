import legsPhoto from '../../assets/workouts/legs.webp'
import pullPhoto from '../../assets/workouts/pull.webp'
import upperPhoto from '../../assets/workouts/upper.webp'
import { workoutFocus, type WorkoutFocus } from '../../utils/workoutFocus'

// Default photos from the Figma mockup, one per focus.
const PHOTOS: Record<WorkoutFocus, string> = { legs: legsPhoto, pull: pullPhoto, upper: upperPhoto }

/** Decorative photo for a workout or routine, chosen from what it trains. */
export default function WorkoutPhoto({ name, exercises, size }: { name: string; exercises: Array<{ name: string }>; size: number }) {
  return (
    <img
      className="hifi-photo"
      src={PHOTOS[workoutFocus(name, exercises.map((exercise) => exercise.name))]}
      alt=""
      width={size}
      height={size}
      loading="lazy"
    />
  )
}
