import { useEffect, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'

/**
 * What the coach is doing while it answers, in the order the server does it: it reads the
 * person's data, picks catalog exercises (and dishes), then waits on the model. The first two
 * take well under a second; nearly all the wait is the model writing, so that step stays longest.
 * The reply is never shown as it is written: the safety check needs the whole reply first.
 */
const STEPS: { key: MessageKey; at: number }[] = [
  { key: 'coach.stepReading', at: 0 },
  { key: 'coach.stepPicking', at: 600 },
  { key: 'coach.stepWriting', at: 1300 },
  // Only an honest "still going" for slow answers; it does not claim a new step.
  { key: 'coach.stepLong', at: 9000 },
]

export default function CoachProgress() {
  const t = useT()
  const [step, setStep] = useState(0)

  useEffect(() => {
    const timers = STEPS.slice(1).map((item, index) => window.setTimeout(() => setStep(index + 1), item.at))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [])

  return (
    <div className="coach-message is-assistant coach-progress" role="status">
      <span className="coach-dots" aria-hidden="true"><i /><i /><i /></span>
      <span key={step} className="coach-progress-step">{t(STEPS[step].key)}</span>
    </div>
  )
}
