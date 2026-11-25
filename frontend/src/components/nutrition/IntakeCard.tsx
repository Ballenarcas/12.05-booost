import { useId, type ReactNode } from 'react'
import '../../styles/intake-card.css'
import { percent } from '../../utils/percent'
import { locale, useT } from '../../i18n'

type Macro = { label: string; current: number; target: number }

const ORB_WAVE_FRONT_PATH = 'M 0 0 C 21 -8, 42 -8, 63 0 C 84 8, 105 8, 126 0 C 147 -8, 168 -8, 189 0 C 210 8, 231 8, 252 0 L 252 160 L 0 160 Z'
const ORB_WAVE_BACK_PATH = 'M 0 0 C 21 6, 42 6, 63 0 C 84 -6, 105 -6, 126 0 C 147 6, 168 6, 189 0 C 210 -6, 231 -6, 252 0 L 252 160 L 0 160 Z'


/**
 * The Figma "Nutrition card": a ball whose water level is the share of the calorie goal eaten,
 * with the three macro bars beside it. Home and Meals pass their own label and footer.
 */
export default function IntakeCard({ label, consumed, goal, macros, pending, footer }: {
  label: string
  consumed: number
  goal: number
  macros: Macro[]
  /** Data still loading: the card keeps its shape with dashes. */
  pending: boolean
  footer: ReactNode
}) {
  const t = useT()
  const id = useId().replace(/:/g, '')
  const labelId = `intake-label-${id}`
  const clipId = `intake-orb-clip-${id}`
  const waveBackId = `intake-orb-wave-back-${id}`
  const waveFrontId = `intake-orb-wave-front-${id}`
  const fill = pending ? 0 : percent(consumed, goal)
  const waterY = fill <= 0 ? 136 : fill >= 1 ? -10 : 126 * (1 - fill)

  return (
    <section className="hifi-card" aria-labelledby={labelId} aria-busy={pending}>
      <h2 className="hifi-card-label" id={labelId}>{label}</h2>
      <div className="home-nutrition">
        <div className="home-orb" role="img" aria-label={pending ? t('intake.loading') : t('intake.eatenAria', { value: Math.round(consumed), goal })}>
          <svg className="home-orb-waves" viewBox="0 0 126 126" width={126} height={126} aria-hidden="true">
            <defs>
              <clipPath id={clipId}>
                <circle cx="63" cy="63" r="63" />
              </clipPath>
              <linearGradient id={waveBackId} x1="0" y1="0" x2="0" y2="126" gradientUnits="userSpaceOnUse">
                <stop className="home-orb-stop-back-top" offset="0%" />
                <stop className="home-orb-stop-back-bottom" offset="100%" />
              </linearGradient>
              <linearGradient id={waveFrontId} x1="0" y1="0" x2="0" y2="126" gradientUnits="userSpaceOnUse">
                <stop className="home-orb-stop-front-top" offset="0%" />
                <stop className="home-orb-stop-front-mid" offset="55%" />
                <stop className="home-orb-stop-front-bottom" offset="100%" />
              </linearGradient>
            </defs>
            <g clipPath={`url(#${clipId})`}>
              <g className="home-orb-level" style={{ transform: `translateY(${waterY}px)` }}>
                <path className="home-orb-wave home-orb-wave-back" d={ORB_WAVE_BACK_PATH} fill={`url(#${waveBackId})`} />
                <path className="home-orb-wave home-orb-wave-front" d={ORB_WAVE_FRONT_PATH} fill={`url(#${waveFrontId})`} />
              </g>
            </g>
          </svg>
          <p className="home-orb-value" aria-hidden="true">
            <strong>{pending ? '–' : Math.round(consumed).toLocaleString(locale())}</strong>
            <span>/{pending ? '–' : goal.toLocaleString(locale())} kcal</span>
          </p>
        </div>
        <ul className="home-macros">
          {macros.map((macro) => (
            <li key={macro.label}>
              <span className="home-macro-name">{macro.label}</span>
              <span className="home-macro-value">
                <strong>{pending ? '–' : Math.round(macro.current)}</strong>/{pending ? '–' : Math.round(macro.target)} g
              </span>
              <span className="hifi-bar" aria-hidden="true">
                <span style={{ width: `${percent(macro.current, macro.target) * 100}%` }} />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="hifi-card-footer">{footer}</div>
    </section>
  )
}
