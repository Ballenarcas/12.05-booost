import { ArrowRight, Sparkles, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  fetchOvertrainingAlerts,
  getCurrentUser,
  getSavedOvertrainingAlerts,
  type OvertrainingAlertStatus,
} from '../../services/api'
import type { WorkoutHistoryEntry } from '../../types/workout'
import { usePageNavigate } from '../../utils/usePageNavigate'
import { useT } from '../../i18n'
import '../../styles/overtraining.css'

interface OvertrainingBannerProps {
  workouts?: WorkoutHistoryEntry[]
  onStatusChange?: (status: OvertrainingAlertStatus) => void
}

function alertSubtitle(status: OvertrainingAlertStatus): string {
  if (status.deload_week_reason) return status.deload_week_reason
  const flagged = status.signals.find((signal) => signal.severity === 'high' || signal.severity === 'watch')
  if (flagged) return flagged.detail
  return status.summary
}

export function OvertrainingBanner({ workouts, onStatusChange }: OvertrainingBannerProps) {
  const t = useT()
  const navigate = usePageNavigate()
  const userId = getCurrentUser()?.id
  const [savedStatus, setStatus] = useState<OvertrainingAlertStatus | null>(() => getSavedOvertrainingAlerts(userId))
  const status = userId ? savedStatus : null
  const onStatusChangeRef = useRef(onStatusChange)
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  })

  useEffect(() => {
    if (!userId) return
    let active = true
    fetchOvertrainingAlerts({ forceRefresh: workouts !== undefined })
      .then((next) => {
        if (!active) return
        setStatus(next)
        onStatusChangeRef.current?.(next)
      })
      .catch(() => {
        // Keep cached readiness summary visible if network refresh fails.
      })
    return () => {
      active = false
    }
  }, [userId, workouts])

  if (!userId || !status || (!status.has_alert && !status.deload_active)) return null

  if (!status.has_alert && status.deload_active) {
    const title = t('otBanner.deloadWeekActiveTitle')
    const pillText = t(status.deload_days_remaining === 1 ? 'ot.daysLeftOne' : 'ot.daysLeftMany', {
      count: status.deload_days_remaining,
    })
    return (
      <button
        type="button"
        className="hifi-card ot-banner is-deload"
        onClick={() => navigate('/overtraining-alerts')}
        aria-label={t('otBanner.aria', { title, pill: pillText })}
      >
        <span className="ot-banner-icon" aria-hidden="true">
          <Sparkles size={18} />
        </span>
        <span className="ot-banner-copy">
          <span className="ot-banner-top">
            <strong className="ot-banner-title">{title}</strong>
            <span className="ot-tier-badge is-deload">{pillText}</span>
          </span>
          <span className="ot-banner-subtitle">
            {t('otBanner.deloadWeekActive', { pct: status.volume_reduction_pct })}
          </span>
        </span>
        <ArrowRight className="ot-banner-arrow" size={17} aria-hidden="true" />
      </button>
    )
  }

  const isHigh = status.risk_level === 'high' || status.deload_week_recommended
  const modifier = isHigh ? 'is-high' : 'is-moderate'
  const title = status.deload_week_recommended
    ? t('otBanner.deloadWeekRecommended')
    : status.risk_level === 'high'
      ? t('otBanner.overtrainingDetected')
      : t('otBanner.elevated')
  const pillText = t('otBanner.readinessScore', { score: status.readiness_score })

  return (
    <button
      type="button"
      className={`hifi-card ot-banner ${modifier}`}
      onClick={() => navigate('/overtraining-alerts')}
      aria-label={t('otBanner.aria', { title, pill: pillText })}
    >
      <span className="ot-banner-icon" aria-hidden="true">
        <TriangleAlert size={18} />
      </span>
      <span className="ot-banner-copy">
        <span className="ot-banner-top">
          <strong className="ot-banner-title">{title}</strong>
          <span className={`ot-tier-badge ${modifier}`}>{pillText}</span>
        </span>
        <span className="ot-banner-subtitle">{alertSubtitle(status)}</span>
      </span>
      <ArrowRight className="ot-banner-arrow" size={17} aria-hidden="true" />
    </button>
  )
}

export default OvertrainingBanner
