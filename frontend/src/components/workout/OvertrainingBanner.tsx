import { ArrowRight, CheckCircle2, Dumbbell, Sparkles, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  fetchOvertrainingAlerts,
  getCurrentUser,
  getSavedOvertrainingAlerts,
  type OvertrainingAlertStatus,
} from '../../services/api'
import type { WorkoutHistoryEntry } from '../../types/workout'
import { usePageNavigate } from '../../utils/usePageNavigate'
import '../../styles/overtraining.css'

interface OvertrainingBannerProps {
  workouts?: WorkoutHistoryEntry[]
  onStatusChange?: (status: OvertrainingAlertStatus) => void
}

function bannerSubtitle(status: OvertrainingAlertStatus): string {
  if (status.deload_active) {
    return `-${status.volume_reduction_pct}% deload active on your next workout or AI plan`
  }
  if (status.rest_day_scheduled) {
    return "Active recovery rest day set for today's AI workout"
  }
  const flagged = status.signals.find((signal) => signal.severity === 'high' || signal.severity === 'watch')
  if (flagged) return flagged.detail
  if (status.sessions_last_7_days > 0) {
    return `${status.sessions_last_7_days} sessions · ${status.total_sets_last_7_days} sets in 7d · tap to log check-in`
  }
  return 'Track post-workout fatigue, workload balance & deloads'
}

export function OvertrainingBanner({ workouts, onStatusChange }: OvertrainingBannerProps) {
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

  if (!userId) return null

  const risk = status?.has_alert ? status.risk_level : 'none'
  const modifier = risk === 'high' ? 'is-high' : risk === 'moderate' ? 'is-moderate' : 'is-ready'

  const title = risk === 'high'
    ? 'Deload recommended'
    : risk === 'moderate'
      ? 'Elevated training fatigue'
      : status?.deload_active
        ? 'Recovery deload active'
        : 'Recovery & readiness'

  const pillText = status
    ? `Readiness ${status.readiness_score}/100`
    : 'Check-in'

  return (
    <button
      type="button"
      className={`hifi-card ot-banner ${modifier}`}
      onClick={() => navigate('/overtraining-alerts')}
      aria-label={`${title}. ${pillText}. Open recovery & overtraining details`}
    >
      <span className="ot-banner-icon" aria-hidden="true">
        {risk === 'high' || risk === 'moderate' ? (
          <TriangleAlert size={18} />
        ) : status?.deload_active ? (
          <Sparkles size={18} />
        ) : status ? (
          <CheckCircle2 size={18} />
        ) : (
          <Dumbbell size={18} />
        )}
      </span>
      <span className="ot-banner-copy">
        <span className="ot-banner-top">
          <strong className="ot-banner-title">{title}</strong>
          <span className={`ot-tier-badge ${modifier}`}>{pillText}</span>
        </span>
        <span className="ot-banner-subtitle">
          {status ? bannerSubtitle(status) : 'Track post-workout fatigue, workload balance & deloads'}
        </span>
      </span>
      <ArrowRight className="ot-banner-arrow" size={17} aria-hidden="true" />
    </button>
  )
}

export default OvertrainingBanner
