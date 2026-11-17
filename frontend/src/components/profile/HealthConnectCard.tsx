import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Flame, Footprints, HeartPulse, Loader2, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { clearDashboardCache, fetchHealthConnectStatus } from '../../services/api'
import { connectHealthConnect, disconnectHealthConnect, ensureHealthConnectFresh, syncHealthConnect } from '../../services/healthConnect'
import type { HealthConnectStatus } from '../../types/health'
import { describeError } from '../../utils/errors.js'

type Notice = { kind: 'success' | 'error'; text: string }

function formatSyncTime(value: string | null): string {
  if (!value) return 'not yet'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'not yet'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Health Connect section of Profile (moved from the old Settings page). */
export default function HealthConnectCard({ userId }: { userId: string | undefined }) {
  const [health, setHealth] = useState<HealthConnectStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [busy, setBusy] = useState<'connecting' | 'syncing' | 'disconnecting' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isConnectOpen, setIsConnectOpen] = useState(false)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.kind === 'success' ? 5000 : 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!userId) {
      setIsLoading(false)
      return
    }
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
        if (isMounted) setNotice({ kind: 'error', text: describeError(error, "We couldn't load your Health Connect status. Please try again.") })
      })
      .finally(() => {
        if (isMounted) setIsLoading(false)
      })
    return () => { isMounted = false }
  }, [userId])

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
      'Health Connect is connected. Your steps and active calories now shape the AI trainer.',
      "We couldn't connect Health Connect. Please try again.")
  }
  const sync = () => {
    if (!userId) return
    void run('syncing', () => syncHealthConnect(userId), 'Activity synced from Health Connect.', "We couldn't sync your activity. Please try again.")
  }
  const disconnect = () => void run('disconnecting', disconnectHealthConnect,
    'Health Connect disconnected. The AI trainer no longer uses activity data.',
    "We couldn't disconnect Health Connect. Please try again.")

  return (
    <section className="section" aria-labelledby="health-connect-heading">
      <h2 className="section-title" id="health-connect-heading">Health Connect</h2>
      <div className="settings-card health-card">
        <div className="health-header">
          <HeartPulse size={20} aria-hidden="true" />
          <p>Steps and active calories that sharpen your AI trainer guidance.</p>
          <span className={`health-status${health?.connected ? ' is-connected' : ''}`}>
            {isLoading ? 'Checking' : health?.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>

        {isLoading ? (
          <p className="health-meta" role="status"><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Checking Health Connect...</p>
        ) : health?.connected ? (
          <>
            <div className="health-stats">
              <div className="health-stat">
                <Footprints size={18} aria-hidden="true" />
                <strong>{health.activity.steps_today.toLocaleString()}</strong>
                <span>steps today</span>
              </div>
              <div className="health-stat">
                <Flame size={18} aria-hidden="true" />
                <strong>{health.activity.active_calories_today}</strong>
                <span>active kcal today</span>
              </div>
            </div>
            <p className="health-meta">
              Last synced {formatSyncTime(health.last_sync_at)}. Seven-day average{' '}
              {health.activity.steps_avg_7d.toLocaleString()} steps and {health.activity.active_calories_avg_7d} active kcal.
            </p>
            {health.source === 'preview' && (
              <p className="health-meta">Browser preview uses sample activity. The Android app reads Health Connect directly.</p>
            )}
            <div className="health-actions">
              <button type="button" className="secondary-action" onClick={sync} disabled={busy !== null}>
                {busy === 'syncing' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
                {busy === 'syncing' ? 'Syncing...' : 'Sync now'}
              </button>
              <button type="button" className="secondary-action health-disconnect" onClick={disconnect} disabled={busy !== null}>
                {busy === 'disconnecting' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Unplug size={16} aria-hidden="true" />}
                {busy === 'disconnecting' ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="health-meta">
              Health Connect shares steps and active energy from your phone and wearables. SET&amp;PLATE reads only those two data types.
            </p>
            <button type="button" className="secondary-action health-connect-btn" onClick={() => setIsConnectOpen(true)} disabled={busy !== null}>
              {busy === 'connecting'
                ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Connecting...</>
                : <><HeartPulse size={16} aria-hidden="true" /> Connect Health Connect</>}
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
            <h2 id="health-connect-title">Allow SET&amp;PLATE to read your activity?</h2>
            <p>Your AI trainer uses these daily totals to adapt calorie and training guidance. Nothing else from Health Connect is read.</p>
            <ul className="health-permission-list">
              <li><Footprints size={18} aria-hidden="true" /><div><strong>Steps</strong><span>Daily step count</span></div></li>
              <li><Flame size={18} aria-hidden="true" /><div><strong>Active calories</strong><span>Energy burned above resting</span></div></li>
            </ul>
            <p className="health-privacy"><ShieldCheck size={16} aria-hidden="true" /> Only aggregated daily totals are stored. You can disconnect at any time.</p>
            <div className="modal-actions">
              <button className="primary-button" type="button" onClick={connect}>Allow access</button>
              <button className="secondary-action" type="button" onClick={() => setIsConnectOpen(false)}>Not now</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
