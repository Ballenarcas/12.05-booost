import { useEffect, useRef, useState } from 'react'
import { prefersStillness } from './useSpring'

const DURATION_MS = 700

/** A number that counts from where it was (0 the first time) to ``target``, easing out like iOS. */
export function useCountUp(target: number): number {
  const still = prefersStillness()
  const [value, setValue] = useState(still ? target : 0)
  const shown = useRef(still ? target : 0)

  useEffect(() => {
    if (still || !Number.isFinite(target)) {
      shown.current = target
      return
    }
    const from = shown.current
    if (from === target) return
    let frame = 0
    let start = 0
    const tick = (time: number) => {
      start ||= time
      const progress = Math.min(1, (time - start) / DURATION_MS)
      const eased = 1 - Math.pow(1 - progress, 3)
      shown.current = from + (target - from) * eased
      setValue(shown.current)
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, still])

  // With reduced motion, or no number to count, the real value shows at once.
  return still || !Number.isFinite(target) ? target : value
}
