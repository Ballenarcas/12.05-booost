import { useState } from 'react'

/**
 * A count whose number rolls to the new value, upwards when it grows and downwards when it shrinks,
 * like the counters under a post on X. Screen readers get the value from the button's label.
 */
export default function RollingCount({ value }: { value: number }) {
  const [shown, setShown] = useState({ value, from: value })
  // Remember the old number during render (React's pattern for state derived from a prop change).
  if (shown.value !== value) setShown({ value, from: shown.value })
  const changed = shown.from !== value
  const way = value > shown.from ? 'up' : 'down'
  return (
    <span className="cm-roll" aria-hidden="true">
      {changed && <span key={`out-${shown.from}-${value}`} className={`cm-roll-out is-${way}`}>{shown.from}</span>}
      <span key={`in-${value}`} className={changed ? `cm-roll-in is-${way}` : undefined}>{value}</span>
    </span>
  )
}
