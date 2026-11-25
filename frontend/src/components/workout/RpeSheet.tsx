import { useState } from 'react'
import { useDialogBehavior } from '../../utils/useDialogBehavior'
import { useT, type MessageKey } from '../../i18n'

const RPE_SCALE: { rpe: number; effort: MessageKey; reps: MessageKey }[] = [
  { rpe: 6, effort: 'rpe.moderate', reps: 'rpe.reps6' },
  { rpe: 6.5, effort: 'rpe.moderate', reps: 'rpe.reps65' },
  { rpe: 7, effort: 'rpe.hard', reps: 'rpe.reps7' },
  { rpe: 7.5, effort: 'rpe.hard', reps: 'rpe.reps75' },
  { rpe: 8, effort: 'rpe.veryHard', reps: 'rpe.reps8' },
  { rpe: 8.5, effort: 'rpe.veryHard', reps: 'rpe.reps85' },
  { rpe: 9, effort: 'rpe.veryHard', reps: 'rpe.reps9' },
  { rpe: 9.5, effort: 'rpe.nearMax', reps: 'rpe.reps95' },
  { rpe: 10, effort: 'rpe.max', reps: 'rpe.reps10' },
]

type Props = { subtitle: string; rpe: number | null; onDone: (rpe: number | null) => void; onClose: () => void }

/** RPE sheet: a big number with what it means, picked from a 6–10 strip in half steps. */
export default function RpeSheet({ subtitle, rpe, onDone, onClose }: Props) {
  const t = useT()
  const dialogRef = useDialogBehavior(true, onClose)
  const [value, setValue] = useState(() => (rpe === null ? 8 : Math.min(10, Math.max(6, Math.round(rpe * 2) / 2))))
  const current = RPE_SCALE.find((step) => step.rpe === value) ?? RPE_SCALE[4]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="date-sheet rest-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rpe-sheet-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="rest-sheet-grabber" aria-hidden="true" />
        <h2 id="rpe-sheet-title">{t('rpe.title')}</h2>
        <p className="rest-sheet-subtitle rpe-sheet-subtitle">{subtitle}</p>
        <p className="rpe-sheet-value" aria-live="polite">
          <strong>{value}</strong>
          <span className="rpe-sheet-effort">{t(current.effort)}</span>
          <span className="rpe-sheet-reps">{t(current.reps)}</span>
        </p>
        <div className="rpe-strip" role="radiogroup" aria-label="RPE">
          {RPE_SCALE.map((step) => (
            <button
              key={step.rpe}
              type="button"
              role="radio"
              aria-checked={step.rpe === value}
              className={step.rpe === value ? 'is-selected' : undefined}
              onClick={() => setValue(step.rpe)}
            >
              {step.rpe}
            </button>
          ))}
        </div>
        <button className="primary-button rest-sheet-done" type="button" onClick={() => onDone(value)}>{t('rpe.done')}</button>
        {rpe !== null && <button className="text-action rpe-sheet-clear" type="button" onClick={() => onDone(null)}>{t('rpe.clear')}</button>}
      </div>
    </div>
  )
}
