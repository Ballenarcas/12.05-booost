import { AlertCircle, CheckCircle2, ChevronLeft, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import {
  applyOvertrainingMods,
  clearOvertrainingMods,
  deleteFatigueFeedback,
  dismissOvertrainingAlert,
  fetchOvertrainingAlerts,
  getCurrentUser,
  getSavedOvertrainingAlerts,
  scheduleRecoveryRestDay,
  submitFatigueFeedback,
  type OvertrainingAlertStatus,
} from '../services/api'
import { describeError } from '../utils/errors.js'
import { usePageNavigate } from '../utils/usePageNavigate'
import '../styles/overtraining.css'

type SleepQuality = 'restorative' | 'average' | 'poor'
type JointStrain = 'none' | 'mild' | 'sharp'

const MUSCLE_OPTIONS = ['Chest', 'Shoulders', 'Back', 'Quads', 'Hamstrings', 'Glutes', 'Arms', 'Core']

const SLEEP_OPTIONS: Array<{ id: SleepQuality; label: string }> = [
  { id: 'restorative', label: 'Restorative (7.5h+)' },
  { id: 'average', label: 'Moderate (6–7h)' },
  { id: 'poor', label: 'Fragmented (<6h)' },
]

const JOINT_OPTIONS: Array<{ id: JointStrain; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'mild', label: 'Mild stiffness' },
  { id: 'sharp', label: 'Noticeable strain' },
]

function describeScale(value: number, kind: 'cns' | 'doms'): string {
  if (kind === 'cns') {
    if (value <= 3) return 'Fresh — normal energy & bar speed'
    if (value <= 6) return 'Moderate — typical post-training tiredness'
    if (value <= 8) return 'High — sluggish warm-ups or higher effort at usual loads'
    return 'Severe — wiped out, unusually heavy fatigue'
  }
  if (value <= 3) return 'Minimal — muscles feel ready'
  if (value <= 6) return 'Moderate DOMS — stiff early in warm-up'
  if (value <= 8) return 'High DOMS — tender with reduced output'
  return 'Severe DOMS — soreness limiting normal range of motion'
}

function formatShortDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Recently'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function MuscleBodyMap({ muscles }: { muscles: Array<{ muscle_group: string; status: 'ok' | 'watch' | 'high' }> }) {
  const toneFor = (targets: string[]): string => {
    const matches = muscles.filter((item) => targets.some((t) => item.muscle_group.toLowerCase().includes(t)))
    if (matches.some((item) => item.status === 'high')) return '#c62f45'
    if (matches.some((item) => item.status === 'watch')) return '#e0a83a'
    if (matches.length > 0) return '#6fb2ec'
    return 'var(--hifi-track)'
  }

  return (
    <svg width="72" height="132" viewBox="0 0 72 132" fill="none" aria-hidden="true">
      <circle cx="36" cy="14" r="9" fill="var(--hifi-track)" stroke="var(--line)" />
      <rect x="31" y="24" width="10" height="6" rx="3" fill="var(--hifi-track)" />
      {/* Shoulders / Arms */}
      <rect x="13" y="30" width="9" height="32" rx="4.5" fill={toneFor(['shoulder', 'arm'])} />
      <rect x="50" y="30" width="9" height="32" rx="4.5" fill={toneFor(['shoulder', 'arm'])} />
      {/* Chest & Back */}
      <rect x="24" y="30" width="24" height="20" rx="5" fill={toneFor(['chest', 'back'])} />
      {/* Core */}
      <rect x="25" y="52" width="22" height="18" rx="4" fill={toneFor(['core'])} />
      {/* Quads / Hamstrings / Glutes / Legs */}
      <rect x="24" y="73" width="10" height="46" rx="5" fill={toneFor(['quad', 'hamstring', 'glute', 'leg'])} />
      <rect x="38" y="73" width="10" height="46" rx="5" fill={toneFor(['quad', 'hamstring', 'glute', 'leg'])} />
    </svg>
  )
}

function ReadinessGauge({ score, risk }: { score: number; risk: 'none' | 'moderate' | 'high' }) {
  const radius = 37
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100)
  const modifier = risk === 'high' ? 'is-high' : risk === 'moderate' ? 'is-moderate' : 'is-ready'

  return (
    <div className="ot-gauge" role="img" aria-label={`Readiness score ${score} out of 100`}>
      <svg viewBox="0 0 88 88" aria-hidden="true">
        <circle className="ot-gauge-track" cx="44" cy="44" r={radius} />
        <circle
          className={`ot-gauge-value ${modifier}`}
          cx="44"
          cy="44"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <div className="ot-gauge-center" aria-hidden="true">
        <strong>{score}</strong>
        <span>/100</span>
      </div>
    </div>
  )
}

export default function OvertrainingAlerts() {
  const navigate = usePageNavigate()
  const userId = getCurrentUser()?.id

  const [status, setStatus] = useState<OvertrainingAlertStatus | null>(() => getSavedOvertrainingAlerts(userId))
  const [loading, setLoading] = useState(() => Boolean(userId) && !getSavedOvertrainingAlerts(userId))
  const [error, setError] = useState<string | null>(() => (
    userId ? null : 'Sign in to review your recovery and readiness status.'
  ))
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<'apply' | 'clear' | 'rest' | 'dismiss' | 'checkin' | string | null>(null)
  const [showForm, setShowForm] = useState(false)

  // Neutral defaults so check-ins reflect actual feeling rather than biasing toward severe fatigue.
  const [fatigueLevel, setFatigueLevel] = useState(5)
  const [sorenessLevel, setSorenessLevel] = useState(4)
  const [sleepQuality, setSleepQuality] = useState<SleepQuality>('average')
  const [jointStrain, setJointStrain] = useState<JointStrain>('none')
  const [selectedMuscles, setSelectedMuscles] = useState<string[]>([])
  const [notes, setNotes] = useState('')

  useEffect(() => {
    // Signed out: the initial state already shows the sign-in message.
    if (!userId) return
    let active = true
    fetchOvertrainingAlerts({ forceRefresh: true })
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch((err: unknown) => {
        if (active && !getSavedOvertrainingAlerts(userId)) {
          setError(describeError(err, "We couldn't load your recovery status right now."))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [userId])

  const resetCheckInForm = () => {
    setFatigueLevel(5)
    setSorenessLevel(4)
    setSleepQuality('average')
    setJointStrain('none')
    setSelectedMuscles([])
    setNotes('')
  }

  const toggleMuscle = (muscle: string) => {
    setSelectedMuscles((current) =>
      current.includes(muscle) ? current.filter((item) => item !== muscle) : [...current, muscle],
    )
  }

  const handleSubmitCheckIn = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('checkin')
    setNotice(null)
    try {
      const next = await submitFatigueFeedback({
        fatigue_level: fatigueLevel,
        soreness_level: sorenessLevel,
        sleep_quality: sleepQuality,
        joint_strain: jointStrain,
        sore_muscles: selectedMuscles,
        notes: notes.trim() || undefined,
      })
      setStatus(next)
      setShowForm(false)
      resetCheckInForm()
      setNotice({
        kind: 'success',
        text: next.has_alert
          ? 'Check-in logged and combined with your 7-day workload.'
          : 'Check-in logged. Readiness stays in a healthy range.',
      })
    } catch (err) {
      setNotice({ kind: 'error', text: describeError(err, "We couldn't save your check-in.") })
    } finally {
      setBusy(null)
    }
  }

  const runAction = async (
    key: 'apply' | 'clear' | 'rest' | 'dismiss',
    action: () => Promise<OvertrainingAlertStatus>,
    successText: string,
    failureText: string,
  ) => {
    setBusy(key)
    setNotice(null)
    try {
      const next = await action()
      setStatus(next)
      setNotice({ kind: 'success', text: successText })
      if (key === 'dismiss') navigate('/workouts')
    } catch (err) {
      setNotice({ kind: 'error', text: describeError(err, failureText) })
    } finally {
      setBusy(null)
    }
  }

  const handleDeleteCheckIn = async (entryId: string) => {
    setBusy(entryId)
    setNotice(null)
    try {
      const next = await deleteFatigueFeedback(entryId)
      setStatus(next)
      setNotice({ kind: 'success', text: 'Check-in removed and readiness updated.' })
    } catch (err) {
      setNotice({ kind: 'error', text: describeError(err, "We couldn't delete that check-in.") })
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="screen hifi-screen ot-screen">
        <header className="ot-header">
          <button type="button" className="ot-back" onClick={() => navigate('/workouts')}>
            <ChevronLeft size={18} aria-hidden="true" /> Workouts
          </button>
        </header>
        <p className="hifi-card hifi-muted" role="status">Analyzing your training load and recovery…</p>
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className="screen hifi-screen ot-screen">
        <header className="ot-header">
          <button type="button" className="ot-back" onClick={() => navigate('/workouts')}>
            <ChevronLeft size={18} aria-hidden="true" /> Workouts
          </button>
        </header>
        <div className="hifi-card" role="alert">
          <p className="hifi-muted">{error}</p>
        </div>
      </div>
    )
  }

  const risk = status?.risk_level ?? 'none'
  const modifier = risk === 'high' ? 'is-high' : risk === 'moderate' ? 'is-moderate' : 'is-ready'
  const tierLabel = risk === 'high' ? 'Deload recommended' : risk === 'moderate' ? 'Watch fatigue' : 'Ready'

  return (
    <div className="screen hifi-screen ot-screen">
      <header className="ot-header">
        <button type="button" className="ot-back" onClick={() => navigate('/workouts')}>
          <ChevronLeft size={18} aria-hidden="true" /> Workouts
        </button>
        <button
          type="button"
          className="hifi-pill"
          aria-expanded={showForm}
          onClick={() => setShowForm((open) => !open)}
        >
          {showForm ? 'Close check-in' : 'Log check-in'}
        </button>
      </header>

      <div className="ot-page-title-row">
        <h1 className="hifi-page-title">Recovery &amp; readiness</h1>
        <p>Evaluated from your completed workouts, fatigue ratings, RPE, and check-ins.</p>
      </div>

      {notice && (
        <div className={`ot-notice${notice.kind === 'error' ? ' is-error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'error' ? <AlertCircle size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
          <span>{notice.text}</span>
        </div>
      )}

      {showForm && (
        <form className="hifi-card ot-form" onSubmit={handleSubmitCheckIn}>
          <h2 className="hifi-card-label">Recovery check-in</h2>

          <label className="ot-slider-field">
            <span className="ot-slider-head">
              <span>Systemic fatigue</span>
              <strong>{fatigueLevel}/10</strong>
            </span>
            <input type="range" min={1} max={10} value={fatigueLevel} onChange={(e) => setFatigueLevel(Number(e.target.value))} />
            <span className="hifi-muted">{describeScale(fatigueLevel, 'cns')}</span>
          </label>

          <label className="ot-slider-field">
            <span className="ot-slider-head">
              <span>Muscle soreness (DOMS)</span>
              <strong>{sorenessLevel}/10</strong>
            </span>
            <input type="range" min={1} max={10} value={sorenessLevel} onChange={(e) => setSorenessLevel(Number(e.target.value))} />
            <span className="hifi-muted">{describeScale(sorenessLevel, 'doms')}</span>
          </label>

          <div>
            <p className="hifi-muted" style={{ marginBottom: 6 }}>Last night&apos;s sleep</p>
            <div className="ot-choice-grid">
              {SLEEP_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ot-choice${sleepQuality === opt.id ? ' is-selected' : ''}`}
                  aria-pressed={sleepQuality === opt.id}
                  onClick={() => setSleepQuality(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="hifi-muted" style={{ marginBottom: 6 }}>Joint / tendon strain</p>
            <div className="ot-choice-grid">
              {JOINT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ot-choice${jointStrain === opt.id ? ' is-selected' : ''}`}
                  aria-pressed={jointStrain === opt.id}
                  onClick={() => setJointStrain(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="hifi-muted" style={{ marginBottom: 6 }}>Sore muscles (optional)</p>
            <div className="ot-chips">
              {MUSCLE_OPTIONS.map((muscle) => {
                const selected = selectedMuscles.includes(muscle)
                return (
                  <button
                    key={muscle}
                    type="button"
                    className={`ot-chip${selected ? ' is-selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() => toggleMuscle(muscle)}
                  >
                    {muscle}
                  </button>
                )
              })}
            </div>
          </div>

          <input
            type="text"
            className="ot-notes-input"
            maxLength={300}
            placeholder="Optional notes (e.g. heavy squats, travel, short sleep)"
            aria-label="Recovery check-in notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          <button type="submit" className="ot-action-btn is-primary" disabled={busy !== null}>
            {busy === 'checkin' ? 'Saving check-in…' : 'Save recovery check-in'}
          </button>
        </form>
      )}

      {status && (
        <>
          <section className="hifi-card" aria-labelledby="ot-overview-heading">
            <h2 className="hifi-card-label" id="ot-overview-heading">Readiness summary</h2>
            <div className="ot-overview">
              <ReadinessGauge score={status.readiness_score} risk={risk} />
              <div className="ot-overview-copy">
                <div className="ot-overview-badges">
                  <span className={`ot-tier-badge ${modifier}`}>{tierLabel}</span>
                  {status.acwr !== null && (
                    <span className="ot-tier-badge">ACWR {status.acwr.toFixed(2)}x</span>
                  )}
                  {status.deload_active && (
                    <span className="ot-tier-badge">-{status.volume_reduction_pct}% deload active</span>
                  )}
                  {status.rest_day_scheduled && (
                    <span className="ot-tier-badge is-ready">Rest day set</span>
                  )}
                </div>
                <p className="ot-overview-headline">{status.headline}</p>
                <p className="ot-overview-summary">{status.summary}</p>
              </div>
            </div>

            <div className="ot-metrics">
              <div className="ot-metric">
                <span>7d Sessions</span>
                <strong>{status.sessions_last_7_days}</strong>
              </div>
              <div className="ot-metric">
                <span>7d Sets</span>
                <strong>{status.total_sets_last_7_days}</strong>
              </div>
              <div className="ot-metric">
                <span>RPE ≥ 8.5</span>
                <strong>{status.high_rpe_sets_count}</strong>
              </div>
              <div className="ot-metric">
                <span>Avg Fatigue</span>
                <strong>{status.avg_workout_fatigue_7d !== null ? `${status.avg_workout_fatigue_7d}/10` : '–'}</strong>
              </div>
            </div>
          </section>

          <section className="hifi-card" aria-labelledby="ot-signals-heading">
            <h2 className="hifi-card-label" id="ot-signals-heading">Signals measured</h2>
            <ul className="ot-signals">
              {status.signals.map((signal) => (
                <li className="ot-signal" key={signal.id}>
                  <div className="ot-signal-top">
                    <span className="ot-signal-name">
                      <span className={`ot-dot is-${signal.severity}`} aria-hidden="true" />
                      {signal.label}
                    </span>
                    <span className="ot-signal-value">{signal.value}</span>
                  </div>
                  <p className="ot-signal-detail">{signal.detail}</p>
                </li>
              ))}
            </ul>
          </section>

          {status.muscle_strain.length > 0 && (
            <section className="hifi-card" aria-labelledby="ot-muscles-heading">
              <h2 className="hifi-card-label" id="ot-muscles-heading">Muscle recovery (7 days)</h2>
              <div className="ot-muscles-wrap">
                <MuscleBodyMap muscles={status.muscle_strain} />
                <ul className="ot-muscle-list">
                  {status.muscle_strain.map((item) => (
                    <li className="ot-muscle-row" key={item.muscle_group}>
                      <span>{item.muscle_group}</span>
                      <span className="ot-muscle-meta">
                        {item.sets_7d} sets
                        {item.hours_since_trained !== null ? ` · ${item.hours_since_trained}h ago` : ''}
                        {item.reported_sore ? ' · Sore' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="hifi-card" aria-labelledby="ot-actions-heading">
            <h2 className="hifi-card-label" id="ot-actions-heading">Recommendations &amp; actions</h2>
            <ul className="ot-recommendations">
              {status.recommendations.map((rec) => (
                <li key={rec}>{rec}</li>
              ))}
            </ul>
            <div className="ot-actions">
              {status.deload_active ? (
                <button
                  type="button"
                  className="ot-action-btn"
                  disabled={busy !== null}
                  onClick={() => runAction(
                    'clear',
                    clearOvertrainingMods,
                    'Deload turned off. Next workout returns to normal targets.',
                    "We couldn't turn off the deload.",
                  )}
                >
                  {busy === 'clear' ? 'Updating…' : `Disable -${status.volume_reduction_pct}% deload`}
                </button>
              ) : (
                <button
                  type="button"
                  className="ot-action-btn is-primary"
                  disabled={busy !== null}
                  onClick={() => runAction(
                    'apply',
                    applyOvertrainingMods,
                    `-${status.volume_reduction_pct}% deload applied to your next workout and today's AI plan.`,
                    "We couldn't apply the deload.",
                  )}
                >
                  {busy === 'apply' ? 'Applying…' : `Apply -${status.volume_reduction_pct}% deload`}
                </button>
              )}

              <button
                type="button"
                className="ot-action-btn"
                disabled={busy !== null || status.rest_day_scheduled}
                onClick={() => runAction(
                  'rest',
                  scheduleRecoveryRestDay,
                  "Today's AI workout was swapped to an active recovery rest day.",
                  "We couldn't swap today to a rest day.",
                )}
              >
                {busy === 'rest'
                  ? 'Updating plan…'
                  : status.rest_day_scheduled
                    ? 'Rest day scheduled for today'
                    : 'Swap today to rest day'}
              </button>

              {status.has_alert && (
                <button
                  type="button"
                  className="ot-action-btn is-ghost"
                  disabled={busy !== null}
                  onClick={() => runAction(
                    'dismiss',
                    dismissOvertrainingAlert,
                    'Alert dismissed until your next workout or check-in.',
                    "We couldn't dismiss the alert.",
                  )}
                >
                  {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss and train anyway'}
                </button>
              )}
            </div>
          </section>

          <section className="hifi-card" aria-labelledby="ot-checkins-heading">
            <div className="hifi-card-footer">
              <h2 className="hifi-card-label" id="ot-checkins-heading">Recent check-ins (7 days)</h2>
              {!showForm && (
                <button type="button" className="hifi-pill" onClick={() => setShowForm(true)}>
                  <Plus size={14} aria-hidden="true" /> Add
                </button>
              )}
            </div>
            {status.recent_checkins.length === 0 ? (
              <p className="hifi-muted">
                No check-ins logged in the last 7 days. Fatigue ratings from finished workouts are still tracked automatically.
              </p>
            ) : (
              <ul className="ot-checkins">
                {status.recent_checkins.map((entry) => (
                  <li className="ot-checkin-item" key={entry.id}>
                    <div className="ot-checkin-body">
                      <span className="ot-checkin-scores">
                        Fatigue {entry.fatigue_level}/10 · Soreness {entry.soreness_level}/10
                      </span>
                      <span className="ot-checkin-meta">
                        {formatShortDate(entry.created_at)} · Sleep: {entry.sleep_quality} · Joints: {entry.joint_strain}
                        {entry.sore_muscles.length > 0 ? ` · ${entry.sore_muscles.join(', ')}` : ''}
                      </span>
                      {entry.notes && <span className="ot-checkin-meta">“{entry.notes}”</span>}
                    </div>
                    <button
                      type="button"
                      className="ot-checkin-delete"
                      disabled={busy !== null}
                      aria-label={`Delete check-in from ${formatShortDate(entry.created_at)}`}
                      onClick={() => handleDeleteCheckIn(entry.id)}
                    >
                      {busy === entry.id ? <Sparkles size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
