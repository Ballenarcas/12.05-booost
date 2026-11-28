import { useState } from 'react'

/**
 * A count whose number rolls to the new value, upwards when it grows and downwards when it shrinks,
 * like the counters under a post on X. Hides zero when idle like Twitter, while screen readers get
 * the exact count from the button's aria-label.
 */
export default function RollingCount({ value }: { value: number }) {
  const [shown, setShown] = useState({ value, from: value })
  if (shown.value !== value) setShown({ value, from: shown.value })
  const changed = shown.from !== value
  if (value === 0 && !changed) return null
  const way = value > shown.from ? 'up' : 'down'
  return (
    <span className="cm-roll" aria-hidden="true">
      {changed && shown.from > 0 && (
        <span key={`out-${shown.from}-${value}`} className={`cm-roll-out is-${way}`}>
          {shown.from}
        </span>
      )}
      <span key={`in-${value}`} className={changed ? `cm-roll-in is-${way}` : undefined}>
        {value > 0 ? value : '\u00A0'}
      </span>
    </span>
  )
}
