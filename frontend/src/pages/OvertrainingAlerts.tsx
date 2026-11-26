import { AlertCircle, CalendarCheck2, CheckCircle2, ChevronLeft, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  applyOvertrainingMods,
  clearOvertrainingMods,
  dismissOvertrainingAlert,
  fetchOvertrainingAlerts,
  getCurrentUser,
  getSavedOvertrainingAlerts,
  scheduleRecoveryRestDay,
  type OvertrainingAlertStatus,
} from '../services/api'
import { describeError } from '../utils/errors.js'
import { usePageNavigate } from '../utils/usePageNavigate'
import { t as tr, useT, valueLabel } from '../i18n'
import '../styles/overtraining.css'

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
  const [busy, setBusy] = useState<'apply' | 'clear' | 'rest' | 'dismiss' | null>(null)

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

  const goBack = () => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/workouts')
  }

  if (loading) {
    return (
      <div className="screen hifi-screen ot-screen">
        <header className="ot-header">
          <button type="button" className="ot-back" onClick={goBack}>
            <ChevronLeft size={18} aria-hidden="true" /> {t('common.back')}
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
          <button type="button" className="ot-back" onClick={goBack}>
            <ChevronLeft size={18} aria-hidden="true" /> {t('common.back')}
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
  const tierLabel = risk === 'high'
    ? t('otBanner.deloadWeekRecommended')
    : risk === 'moderate'
      ? t('ot.watchFatigue')
      : t('ot.ready')
  const showDeloadCard = Boolean(status && (status.deload_week_recommended || status.deload_active))
  const showAllClearOnly = Boolean(
    status && status.risk_level === 'none' && !status.deload_active && !status.deload_week_recommended,
  )

  return (
    <div className="screen hifi-screen ot-screen">
      <header className="ot-header">
        <button type="button" className="ot-back" onClick={goBack}>
          <ChevronLeft size={18} aria-hidden="true" /> {t('common.back')}
        </button>
      </header>

      <div className="ot-page-title-row">
        <h1 className="hifi-page-title">{t('ot.pageTitle')}</h1>
        <p>{t('ot.subtitle')}</p>
      </div>

      {notice && (
        <div className={`ot-notice${notice.kind === 'error' ? ' is-error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'error' ? <AlertCircle size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
          <span>{notice.text}</span>
        </div>
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
                    <span className="ot-tier-badge is-deload">
                      {t('ot.deloadWeekBadge', { pct: status.volume_reduction_pct })} · {t(
                        status.deload_days_remaining === 1 ? 'ot.daysLeftOne' : 'ot.daysLeftMany',
                        { count: status.deload_days_remaining },
                      )}
                    </span>
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

          {showDeloadCard && (
            <section className="hifi-card ot-deload-card" aria-labelledby="ot-deload-heading">
              <div className="ot-deload-head">
                <h2 className="ot-deload-title" id="ot-deload-heading">
                  <CalendarCheck2 size={18} aria-hidden="true" />
                  {status.deload_active ? t('otBanner.deloadWeekActiveTitle') : t('ot.deloadWeekTitle')}
                </h2>
                {status.deload_active && (
                  <span className="ot-tier-badge is-deload">
                    {t(status.deload_days_remaining === 1 ? 'ot.daysLeftOne' : 'ot.daysLeftMany', {
                      count: status.deload_days_remaining,
                    })}
                  </span>
                )}
              </div>
              <p className="ot-deload-copy">
                {status.deload_active
                  ? t('ot.deloadWeekActiveBody', {
                      pct: status.volume_reduction_pct,
                      days: status.deload_days_remaining,
                    })
                  : status.deload_week_reason || t('ot.deloadWeekFallback', { pct: status.volume_reduction_pct })}
              </p>
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
                    {busy === 'clear' ? t('ot.updating') : t('ot.endDeloadWeek')}
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
                    <Sparkles size={15} aria-hidden="true" style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                    {busy === 'apply' ? t('ot.applying') : t('ot.startDeloadWeek', { pct: status.volume_reduction_pct })}
                  </button>
                )}
              </div>
            </section>
          )}

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
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section className="hifi-card" aria-labelledby="ot-actions-heading">
            <h2 className="hifi-card-label" id="ot-actions-heading">
              {showAllClearOnly ? t('ot.noOvertrainingTitle') : t('ot.actions')}
            </h2>
            <ul className="ot-recommendations">
              {status.recommendations.map((rec) => (
                <li key={rec}>{rec}</li>
              ))}
            </ul>
            <div className="ot-actions">
              {showAllClearOnly ? (
                <button
                  type="button"
                  className="ot-action-btn"
                  onClick={() => navigate('/workouts/statistics')}
                >
                  {t('ot.viewStats')}
                </button>
              ) : (
                <>
                  {!showDeloadCard && (
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
                      {busy === 'apply' ? t('ot.applying') : t('ot.startDeloadWeek', { pct: status.volume_reduction_pct })}
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
                </>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
