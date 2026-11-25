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
import { locale, t as tr, useT, valueLabel, type MessageKey } from '../i18n'
import '../styles/overtraining.css'

type SleepQuality = 'restorative' | 'average' | 'poor'
type JointStrain = 'none' | 'mild' | 'sharp'

const MUSCLE_OPTIONS = ['Chest', 'Shoulders', 'Back', 'Quads', 'Hamstrings', 'Glutes', 'Arms', 'Core']

const SLEEP_OPTIONS: Array<{ id: SleepQuality; label: MessageKey }> = [
  { id: 'restorative', label: 'ot.sleep.restorative' },
  { id: 'average', label: 'ot.sleep.average' },
  { id: 'poor', label: 'ot.sleep.poor' },
]

const JOINT_OPTIONS: Array<{ id: JointStrain; label: MessageKey }> = [
  { id: 'none', label: 'ot.joint.none' },
  { id: 'mild', label: 'ot.joint.mild' },
  { id: 'sharp', label: 'ot.joint.sharp' },
]

function describeScale(value: number, kind: 'cns' | 'doms'): string {
  if (kind === 'cns') {
    if (value <= 3) return tr('ot.cns1')
    if (value <= 6) return tr('ot.cns2')
    if (value <= 8) return tr('ot.cns3')
    return tr('ot.cns4')
  }
  if (value <= 3) return tr('ot.doms1')
  if (value <= 6) return tr('ot.doms2')
  if (value <= 8) return tr('ot.doms3')
  return tr('ot.doms4')
}

function formatShortDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return tr('ot.recently')
  return date.toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
    <div className="ot-gauge" role="img" aria-label={tr('ot.gaugeAria', { score })}>
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
  const t = useT()
  const navigate = usePageNavigate()
  const userId = getCurrentUser()?.id

  const [status, setStatus] = useState<OvertrainingAlertStatus | null>(() => getSavedOvertrainingAlerts(userId))
  const [loading, setLoading] = useState(() => Boolean(userId) && !getSavedOvertrainingAlerts(userId))
  const [error, setError] = useState<string | null>(() => (
    userId ? null : tr('ot.signIn')
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
          setError(describeError(err, t('ot.errorLoad')))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [userId, t])

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
          ? t('ot.checkInLoggedAlert')
          : t('ot.checkInLogged'),
      })
    } catch (err) {
      setNotice({ kind: 'error', text: describeError(err, t('ot.errorCheckIn')) })
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
      setNotice({ kind: 'success', text: t('ot.checkInRemoved') })
    } catch (err) {
      setNotice({ kind: 'error', text: describeError(err, t('ot.errorDeleteCheckIn')) })
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="screen hifi-screen ot-screen">
        <header className="ot-header">
          <button type="button" className="ot-back" onClick={() => navigate('/workouts')}>
            <ChevronLeft size={18} aria-hidden="true" /> {t('nav.workouts')}
          </button>
        </header>
        <p className="hifi-card hifi-muted" role="status">{t('ot.analyzing')}</p>
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className="screen hifi-screen ot-screen">
        <header className="ot-header">
          <button type="button" className="ot-back" onClick={() => navigate('/workouts')}>
            <ChevronLeft size={18} aria-hidden="true" /> {t('nav.workouts')}
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
  const tierLabel = risk === 'high' ? t('otBanner.deloadRecommended') : risk === 'moderate' ? t('ot.watchFatigue') : t('ot.ready')

  return (
    <div className="screen hifi-screen ot-screen">
      <header className="ot-header">
        <button type="button" className="ot-back" onClick={() => navigate('/workouts')}>
          <ChevronLeft size={18} aria-hidden="true" /> {t('nav.workouts')}
        </button>
        <button
          type="button"
          className="hifi-pill"
          aria-expanded={showForm}
          onClick={() => setShowForm((open) => !open)}
        >
          {showForm ? t('ot.closeCheckIn') : t('ot.logCheckIn')}
        </button>
      </header>

      <div className="ot-page-title-row">
        <h1 className="hifi-page-title">{t('otBanner.readinessTitle')}</h1>
        <p>{t('ot.subtitle')}</p>
      </div>

      {notice && (
        <div className={`ot-notice${notice.kind === 'error' ? ' is-error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'error' ? <AlertCircle size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
          <span>{notice.text}</span>
        </div>
      )}

      {showForm && (
        <form className="hifi-card ot-form" onSubmit={handleSubmitCheckIn}>
          <h2 className="hifi-card-label">{t('ot.checkInTitle')}</h2>

          <label className="ot-slider-field">
            <span className="ot-slider-head">
              <span>{t('ot.systemicFatigue')}</span>
              <strong>{fatigueLevel}/10</strong>
            </span>
            <input type="range" min={1} max={10} value={fatigueLevel} onChange={(e) => setFatigueLevel(Number(e.target.value))} />
            <span className="hifi-muted">{describeScale(fatigueLevel, 'cns')}</span>
          </label>

          <label className="ot-slider-field">
            <span className="ot-slider-head">
              <span>{t('ot.soreness')}</span>
              <strong>{sorenessLevel}/10</strong>
            </span>
            <input type="range" min={1} max={10} value={sorenessLevel} onChange={(e) => setSorenessLevel(Number(e.target.value))} />
            <span className="hifi-muted">{describeScale(sorenessLevel, 'doms')}</span>
          </label>

          <div>
            <p className="hifi-muted" style={{ marginBottom: 6 }}>{t('ot.sleepTitle')}</p>
            <div className="ot-choice-grid">
              {SLEEP_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ot-choice${sleepQuality === opt.id ? ' is-selected' : ''}`}
                  aria-pressed={sleepQuality === opt.id}
                  onClick={() => setSleepQuality(opt.id)}
                >
                  {t(opt.label)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="hifi-muted" style={{ marginBottom: 6 }}>{t('ot.jointTitle')}</p>
            <div className="ot-choice-grid">
              {JOINT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ot-choice${jointStrain === opt.id ? ' is-selected' : ''}`}
                  aria-pressed={jointStrain === opt.id}
                  onClick={() => setJointStrain(opt.id)}
                >
                  {t(opt.label)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="hifi-muted" style={{ marginBottom: 6 }}>{t('ot.soreMuscles')}</p>
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
                    {valueLabel(t, 'muscle', muscle)}
                  </button>
                )
              })}
            </div>
          </div>

          <input
            type="text"
            className="ot-notes-input"
            maxLength={300}
            placeholder={t('ot.notesPlaceholder')}
            aria-label={t('ot.notesAria')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          <button type="submit" className="ot-action-btn is-primary" disabled={busy !== null}>
            {busy === 'checkin' ? t('ot.savingCheckIn') : t('ot.saveCheckIn')}
          </button>
        </form>
      )}

      {status && (
        <>
          <section className="hifi-card" aria-labelledby="ot-overview-heading">
            <h2 className="hifi-card-label" id="ot-overview-heading">{t('ot.summaryTitle')}</h2>
            <div className="ot-overview">
              <ReadinessGauge score={status.readiness_score} risk={risk} />
              <div className="ot-overview-copy">
                <div className="ot-overview-badges">
                  <span className={`ot-tier-badge ${modifier}`}>{tierLabel}</span>
                  {status.acwr !== null && (
                    <span className="ot-tier-badge">ACWR {status.acwr.toFixed(2)}x</span>
                  )}
                  {status.deload_active && (
                    <span className="ot-tier-badge">{t('ot.deloadBadge', { pct: status.volume_reduction_pct })}</span>
                  )}
                  {status.rest_day_scheduled && (
                    <span className="ot-tier-badge is-ready">{t('ot.restDaySet')}</span>
                  )}
                </div>
                <p className="ot-overview-headline">{status.headline}</p>
                <p className="ot-overview-summary">{status.summary}</p>
              </div>
            </div>

            <div className="ot-metrics">
              <div className="ot-metric">
                <span>{t('ot.sessions7d')}</span>
                <strong>{status.sessions_last_7_days}</strong>
              </div>
              <div className="ot-metric">
                <span>{t('ot.sets7d')}</span>
                <strong>{status.total_sets_last_7_days}</strong>
              </div>
              <div className="ot-metric">
                <span>RPE ≥ 8.5</span>
                <strong>{status.high_rpe_sets_count}</strong>
              </div>
              <div className="ot-metric">
                <span>{t('ot.avgFatigue')}</span>
                <strong>{status.avg_workout_fatigue_7d !== null ? `${status.avg_workout_fatigue_7d}/10` : '–'}</strong>
              </div>
            </div>
          </section>

          <section className="hifi-card" aria-labelledby="ot-signals-heading">
            <h2 className="hifi-card-label" id="ot-signals-heading">{t('ot.signals')}</h2>
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
              <h2 className="hifi-card-label" id="ot-muscles-heading">{t('ot.muscleRecovery')}</h2>
              <div className="ot-muscles-wrap">
                <MuscleBodyMap muscles={status.muscle_strain} />
                <ul className="ot-muscle-list">
                  {status.muscle_strain.map((item) => (
                    <li className="ot-muscle-row" key={item.muscle_group}>
                      <span>{valueLabel(t, 'muscle', item.muscle_group)}</span>
                      <span className="ot-muscle-meta">
                        {t('workouts.setMany', { count: item.sets_7d })}
                        {item.hours_since_trained !== null ? ` · ${t('ot.hoursAgo', { h: item.hours_since_trained })}` : ''}
                        {item.reported_sore ? ` · ${t('ot.sore')}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="hifi-card" aria-labelledby="ot-actions-heading">
            <h2 className="hifi-card-label" id="ot-actions-heading">{t('ot.actions')}</h2>
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
                    t('ot.deloadOff'),
                    t('ot.errorDeloadOff'),
                  )}
                >
                  {busy === 'clear' ? t('ot.updating') : t('ot.disableDeload', { pct: status.volume_reduction_pct })}
                </button>
              ) : (
                <button
                  type="button"
                  className="ot-action-btn is-primary"
                  disabled={busy !== null}
                  onClick={() => runAction(
                    'apply',
                    applyOvertrainingMods,
                    t('ot.deloadApplied', { pct: status.volume_reduction_pct }),
                    t('ot.errorDeloadApply'),
                  )}
                >
                  {busy === 'apply' ? t('ot.applying') : t('ot.applyDeload', { pct: status.volume_reduction_pct })}
                </button>
              )}

              <button
                type="button"
                className="ot-action-btn"
                disabled={busy !== null || status.rest_day_scheduled}
                onClick={() => runAction(
                  'rest',
                  scheduleRecoveryRestDay,
                  t('ot.restSwapped'),
                  t('ot.errorRestSwap'),
                )}
              >
                {busy === 'rest'
                  ? t('ot.updatingPlan')
                  : status.rest_day_scheduled
                    ? t('ot.restScheduled')
                    : t('ot.swapRest')}
              </button>

              {status.has_alert && (
                <button
                  type="button"
                  className="ot-action-btn is-ghost"
                  disabled={busy !== null}
                  onClick={() => runAction(
                    'dismiss',
                    dismissOvertrainingAlert,
                    t('ot.dismissed'),
                    t('ot.errorDismiss'),
                  )}
                >
                  {busy === 'dismiss' ? t('ot.dismissing') : t('ot.dismiss')}
                </button>
              )}
            </div>
          </section>

          <section className="hifi-card" aria-labelledby="ot-checkins-heading">
            <div className="hifi-card-footer">
              <h2 className="hifi-card-label" id="ot-checkins-heading">{t('ot.recentCheckIns')}</h2>
              {!showForm && (
                <button type="button" className="hifi-pill" onClick={() => setShowForm(true)}>
                  <Plus size={14} aria-hidden="true" /> {t('hydration.add')}
                </button>
              )}
            </div>
            {status.recent_checkins.length === 0 ? (
              <p className="hifi-muted">
                {t('ot.noCheckIns')}
              </p>
            ) : (
              <ul className="ot-checkins">
                {status.recent_checkins.map((entry) => (
                  <li className="ot-checkin-item" key={entry.id}>
                    <div className="ot-checkin-body">
                      <span className="ot-checkin-scores">
                        {t('ot.checkInScores', { fatigue: entry.fatigue_level, soreness: entry.soreness_level })}
                      </span>
                      <span className="ot-checkin-meta">
                        {formatShortDate(entry.created_at)} · {t('ot.sleepLabel', { value: valueLabel(t, 'ot.sleepShort', entry.sleep_quality) })} · {t('ot.jointsLabel', { value: valueLabel(t, 'ot.jointShort', entry.joint_strain) })}
                        {entry.sore_muscles.length > 0 ? ` · ${entry.sore_muscles.map((muscle) => valueLabel(t, 'muscle', muscle)).join(', ')}` : ''}
                      </span>
                      {entry.notes && <span className="ot-checkin-meta">“{entry.notes}”</span>}
                    </div>
                    <button
                      type="button"
                      className="ot-checkin-delete"
                      disabled={busy !== null}
                      aria-label={t('ot.deleteCheckIn', { date: formatShortDate(entry.created_at) })}
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
