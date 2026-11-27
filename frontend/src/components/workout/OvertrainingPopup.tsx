import { AlertCircle, ArrowRight, Sparkles, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  OVERTRAINING_POPUP_SESSION_PREFIX,
  dismissOvertrainingAlert,
  fetchOvertrainingAlerts,
  getCurrentUser,
  getSavedOvertrainingAlerts,
  type OvertrainingAlertStatus,
} from '../../services/api'
import { useT } from '../../i18n'
import { describeError } from '../../utils/errors.js'
import { usePageNavigate } from '../../utils/usePageNavigate'
import LiquidToggle from '../ui/LiquidToggle'
import '../../styles/overtraining.css'

interface OvertrainingPopupProps {
  onStatusChange?: (status: OvertrainingAlertStatus) => void
}

function alertSubtitle(status: OvertrainingAlertStatus): string {
  if (status.deload_week_reason) return status.deload_week_reason
  const flagged = status.signals.find((signal) => signal.severity === 'high' || signal.severity === 'watch')
  if (flagged) return flagged.detail
  return status.summary
}

function popupSessionKey(userId: string | undefined): string | null {
  return userId ? `${OVERTRAINING_POPUP_SESSION_PREFIX}${userId}` : null
}

function readPopupClosed(key: string | null): boolean {
  if (!key) return false
  try {
    return sessionStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writePopupClosed(key: string | null): void {
  if (!key) return
  try {
    sessionStorage.setItem(key, '1')
  } catch {
    // Ignore storage restriction errors.
  }
}

export function OvertrainingPopup({ onStatusChange }: OvertrainingPopupProps) {
  const t = useT()
  const navigate = usePageNavigate()
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const userId = getCurrentUser()?.id
  const sessionKey = popupSessionKey(userId)

  const [savedStatus, setStatus] = useState<OvertrainingAlertStatus | null>(() => getSavedOvertrainingAlerts(userId))
  const status = userId ? savedStatus : null
  const [closedKey, setClosedKey] = useState<string | null>(() => (readPopupClosed(sessionKey) ? sessionKey : null))
  const [timedDismiss, setTimedDismiss] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onStatusChangeRef = useRef(onStatusChange)
  const timedDismissRef = useRef(timedDismiss)
  const busyRef = useRef(busy)
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
    timedDismissRef.current = timedDismiss
    busyRef.current = busy
  })

  useEffect(() => {
    if (!userId) return
    let active = true
    fetchOvertrainingAlerts()
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
  }, [userId])

  const sessionClosed = Boolean(sessionKey && (closedKey === sessionKey || readPopupClosed(sessionKey)))
  const shouldShowPopup = Boolean(userId && status && status.has_alert && !sessionClosed)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (shouldShowPopup) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close('handled')
    }
  }, [shouldShowPopup])

  // Mandatory light-dismiss fallback for browsers without native <dialog closedby="any">.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) return
    const outside = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect()
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
    }
    let pressedOutside = false
    const onPointerDown = (event: PointerEvent) => {
      pressedOutside = dialog.open && outside(event)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (pressedOutside && dialog.open && outside(event) && !busyRef.current) {
        dialog.close()
      }
      pressedOutside = false
    }
    dialog.addEventListener('pointerdown', onPointerDown)
    dialog.addEventListener('pointerup', onPointerUp)
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown)
      dialog.removeEventListener('pointerup', onPointerUp)
    }
  }, [status?.has_alert, sessionClosed])

  const markSessionClosed = useCallback(() => {
    writePopupClosed(sessionKey)
    setClosedKey(sessionKey)
  }, [sessionKey])

  const handleNativeClose = () => {
    const dialog = dialogRef.current
    const reason = dialog?.returnValue ?? ''
    if (dialog) dialog.returnValue = ''
    markSessionClosed()
    if (reason !== 'handled' && timedDismissRef.current && !busyRef.current) {
      dismissOvertrainingAlert()
        .then((next) => {
          setStatus(next)
          onStatusChangeRef.current?.(next)
        })
        .catch(() => {
          // Light-dismiss/Esc already closed the dialog cleanly.
        })
    }
  }

  const handleCloseAction = async () => {
    if (busy) return
    if (!timedDismiss) {
      markSessionClosed()
      dialogRef.current?.close('handled')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const next = await dismissOvertrainingAlert()
      setStatus(next)
      onStatusChangeRef.current?.(next)
      markSessionClosed()
      dialogRef.current?.close('handled')
    } catch (err) {
      setError(describeError(err, t('ot.errorDismiss')))
    } finally {
      setBusy(false)
    }
  }

  const handleViewDetails = () => {
    markSessionClosed()
    dialogRef.current?.close('handled')
    navigate('/overtraining-alerts')
  }

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
  const flaggedSignals = status.signals
    .filter((signal) => signal.severity === 'high' || signal.severity === 'watch')
    .slice(0, 3)

  return (
    <dialog
      ref={dialogRef}
      className={`ot-popup ${modifier}`}
      aria-labelledby={titleId}
      onClose={handleNativeClose}
      onCancel={(event) => {
        if (busy) event.preventDefault()
      }}
      {...({ closedby: 'any' } as Record<string, string>)}
    >
      <div className="ot-popup-surface">
        <div className="ot-popup-head">
          <div className="ot-popup-heading">
            <span className={`ot-popup-icon ${modifier}`} aria-hidden="true">
              <TriangleAlert size={18} />
            </span>
            <div className="ot-popup-title-wrap">
              <div className="ot-banner-top">
                <h1 id={titleId} className="ot-popup-title">{title}</h1>
                <span className={`ot-tier-badge ${modifier}`}>{pillText}</span>
              </div>
              <p className="ot-popup-subtitle">{alertSubtitle(status)}</p>
            </div>
          </div>
          <button
            type="button"
            className="ot-popup-close"
            onClick={handleCloseAction}
            aria-label={t('otPopup.close')}
            disabled={busy}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {flaggedSignals.length > 0 && (
          <ul className="ot-popup-signals">
            {flaggedSignals.map((signal) => (
              <li className="ot-popup-signal" key={signal.id}>
                <span className="ot-signal-name">
                  <span className={`ot-dot is-${signal.severity}`} aria-hidden="true" />
                  {signal.label}
                </span>
                <span className="ot-signal-value">{signal.value}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="ot-popup-toggle-row">
          <div className="ot-popup-toggle-copy">
            <strong>{t('otPopup.timedDismissTitle')}</strong>
            <span>{t('otPopup.timedDismissHint')}</span>
          </div>
          <LiquidToggle
            checked={timedDismiss}
            onChange={setTimedDismiss}
            label={t('otPopup.timedDismissTitle')}
          />
        </div>

        {error && (
          <p className="ot-notice is-error" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="ot-popup-actions">
          {timedDismiss ? (
            <>
              <button
                type="button"
                className="ot-action-btn is-primary"
                disabled={busy}
                onClick={handleCloseAction}
              >
                {busy ? t('ot.dismissing') : t('otPopup.dismissTimed')}
              </button>
              <button
                type="button"
                className="ot-action-btn is-ghost"
                disabled={busy}
                onClick={handleViewDetails}
              >
                {t('otPopup.viewDetails')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ot-action-btn is-primary"
                autoFocus
                onClick={handleViewDetails}
              >
                {t('otPopup.viewDetails')}
              </button>
              <button
                type="button"
                className="ot-action-btn is-ghost"
                onClick={handleCloseAction}
              >
                {t('otPopup.closeForNow')}
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}

export default OvertrainingPopup
