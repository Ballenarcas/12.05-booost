import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Flame, Footprints, HeartPulse, Loader2, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { clearDashboardCache, fetchHealthConnectStatus } from '../../services/api'
import { connectHealthConnect, disconnectHealthConnect, ensureHealthConnectFresh, syncHealthConnect } from '../../services/healthConnect'
import type { HealthConnectStatus } from '../../types/health'
import { describeError } from '../../utils/errors.js'
import { locale, t as tr, useT } from '../../i18n'

type Notice = { kind: 'success' | 'error'; text: string }

function formatSyncTime(value: string | null): string {
  if (!value) return tr('health.notYet')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return tr('health.notYet')
  return date.toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Health Connect section of Profile (moved from the old Settings page). */
export default function HealthConnectCard({ userId }: { userId: string | undefined }) {
  const t = useT()
  const [health, setHealth] = useState<HealthConnectStatus | null>(null)
  const [isLoading, setIsLoading] = useState(Boolean(userId))
  const [busy, setBusy] = useState<'connecting' | 'syncing' | 'disconnecting' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isConnectOpen, setIsConnectOpen] = useState(false)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.kind === 'success' ? 5000 : 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!userId) return
    let isMounted = true
    fetchHealthConnectStatus()
      .then(async (initial) => {
        if (!isMounted) return
        setHealth(initial)
        if (!initial.connected) return
        const refreshed = await ensureHealthConnectFresh(userId, initial)
        if (isMounted) setHealth(refreshed)
      })
      .catch((error: unknown) => {
        if (isMounted) setNotice({ kind: 'error', text: describeError(error, t('health.errorLoad')) })
      })
      .finally(() => {
        if (isMounted) setIsLoading(false)
      })
    return () => { isMounted = false }
  }, [userId, t])

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<HealthConnectStatus>, success: string, failure: string) => {
    setBusy(kind)
    setNotice(null)
    try {
      setHealth(await action())
      clearDashboardCache()
      setNotice({ kind: 'success', text: success })
    } catch (error) {
      setNotice({ kind: 'error', text: describeError(error, failure) })
    } finally {
      setBusy(null)
    }
  }

  const connect = () => {
    if (!userId) return
    setIsConnectOpen(false)
    void run('connecting', () => connectHealthConnect(userId),
      t('health.connected'),
      t('health.errorConnect'))
  }
  const sync = () => {
    if (!userId) return
    void run('syncing', () => syncHealthConnect(userId), t('health.synced'), t('health.errorSync'))
  }
  const disconnect = () => void run('disconnecting', disconnectHealthConnect,
    t('health.disconnected'),
    t('health.errorDisconnect'))

  return (
    <section className="section" aria-labelledby="health-connect-heading">
      <h2 className="section-title" id="health-connect-heading">Health Connect</h2>
      <div className="settings-card health-card">
        <div className="health-header">
          <HeartPulse size={20} aria-hidden="true" />
          <p>{t('health.intro')}</p>
          <span className={`health-status${health?.connected ? ' is-connected' : ''}`}>
            {isLoading ? t('health.checking') : health?.connected ? t('health.statusConnected') : t('health.statusNotConnected')}
          </span>
        </div>

        {isLoading ? (
          <p className="health-meta" role="status"><Loader2 size={16} className="animate-spin" aria-hidden="true" /> {t('health.checkingLong')}</p>
        ) : health?.connected ? (
          <>
            <div className="health-stats">
              <div className="health-stat">
                <Footprints size={18} aria-hidden="true" />
                <strong>{health.activity.steps_today.toLocaleString(locale())}</strong>
                <span>{t('health.stepsToday')}</span>
              </div>
              <div className="health-stat">
                <Flame size={18} aria-hidden="true" />
                <strong>{health.activity.active_calories_today}</strong>
                <span>{t('health.kcalToday')}</span>
              </div>
            </div>
            <p className="health-meta">
              {t('health.lastSynced', { time: formatSyncTime(health.last_sync_at), steps: health.activity.steps_avg_7d.toLocaleString(locale()), kcal: health.activity.active_calories_avg_7d })}
            </p>
            {health.source === 'preview' && (
              <p className="health-meta">{t('health.preview')}</p>
            )}
            <div className="health-actions">
              <button type="button" className="secondary-action" onClick={sync} disabled={busy !== null}>
                {busy === 'syncing' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
                {busy === 'syncing' ? t('health.syncing') : t('health.syncNow')}
              </button>
              <button type="button" className="secondary-action health-disconnect" onClick={disconnect} disabled={busy !== null}>
                {busy === 'disconnecting' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Unplug size={16} aria-hidden="true" />}
                {busy === 'disconnecting' ? t('health.disconnecting') : t('health.disconnect')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="health-meta">
              {t('health.explain')}
            </p>
            <button type="button" className="secondary-action health-connect-btn" onClick={() => setIsConnectOpen(true)} disabled={busy !== null}>
              {busy === 'connecting'
                ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> {t('health.connecting')}</>
                : <><HeartPulse size={16} aria-hidden="true" /> {t('health.connect')}</>}
            </button>
          </>
        )}

        {notice && (
          <div className={`settings-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.kind === 'success' ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}
            <span>{notice.text}</span>
          </div>
        )}
      </div>

      {isConnectOpen && (
        <div className="modal-backdrop" onClick={() => setIsConnectOpen(false)}>
          <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="health-connect-title" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">Health Connect</p>
            <h2 id="health-connect-title">{t('health.allowQuestion')}</h2>
            <p>{t('health.allowBody')}</p>
            <ul className="health-permission-list">
              <li><Footprints size={18} aria-hidden="true" /><div><strong>{t('health.steps')}</strong><span>{t('health.stepsHint')}</span></div></li>
              <li><Flame size={18} aria-hidden="true" /><div><strong>{t('health.activeCalories')}</strong><span>{t('health.activeCaloriesHint')}</span></div></li>
            </ul>
            <p className="health-privacy"><ShieldCheck size={16} aria-hidden="true" /> {t('health.privacy')}</p>
            <div className="modal-actions">
              <button className="primary-button" type="button" onClick={connect}>{t('health.allow')}</button>
              <button className="secondary-action" type="button" onClick={() => setIsConnectOpen(false)}>{t('health.notNow')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
