import { CircleHelp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { decideTip, fetchCurrentTip, undoTip, type AiTip } from '../../services/api'
import { useDialogBehavior } from '../../utils/useDialogBehavior'
import { usePageNavigate } from '../../utils/usePageNavigate'
import closeIcon from '../../assets/home/close.svg'
import { useT } from '../../i18n'

const UNDO_WINDOW_MS = 8000

export default function AiTipCard({ onApplied }: { onApplied: () => void }) {
  const t = useT()
  const navigate = usePageNavigate()
  const [tip, setTip] = useState<AiTip | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [undoTipId, setUndoTipId] = useState<string | null>(null)
  const [showWhy, setShowWhy] = useState(false)
  const dialogRef = useDialogBehavior(showWhy, () => setShowWhy(false))

  useEffect(() => {
    let mounted = true
    fetchCurrentTip()
      .then((next) => mounted && setTip(next))
      .catch(() => undefined) // The dashboard stays usable and shows the encouragement message.
      .finally(() => mounted && setLoaded(true))
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!undoTipId) return
    const timer = window.setTimeout(() => {
      setUndoTipId(null)
      setNotice(null)
    }, UNDO_WINDOW_MS)
    return () => window.clearTimeout(timer)
  }, [undoTipId])

  async function decide(status: 'accepted' | 'dismissed') {
    if (!tip || busy) return
    setBusy(true)
    setNotice(null)
    setUndoTipId(null)
    try {
      const result = await decideTip(tip.id, status)
      setTip(result.tip)
      setNotice(result.confirmation ?? result.notice)
      if (status === 'accepted' && result.applied) {
        setUndoTipId(tip.id)
        onApplied()
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('tip.errorUpdate'))
    } finally {
      setBusy(false)
    }
  }

  async function undo() {
    if (!undoTipId || busy) return
    setBusy(true)
    try {
      const result = await undoTip(undoTipId)
      setTip(result.tip)
      setNotice(result.notice)
      setUndoTipId(null)
      if (result.applied) onApplied()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('tip.errorUndo'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="hifi-card ai-insight" aria-labelledby="ai-insight-label" aria-live="polite" aria-busy={!loaded}>
        <div className="ai-insight-top">
          <h2 className="hifi-card-label" id="ai-insight-label">{t('tip.title')}</h2>
          {tip && (
            <button type="button" className="ai-insight-close" aria-label={t('tip.dismiss')} disabled={busy} onClick={() => decide('dismissed')}>
              <img src={closeIcon} alt="" width={14} height={14} />
            </button>
          )}
        </div>
        <p className="ai-insight-message" key={tip?.id ?? (loaded ? 'done' : 'loading')}>{tip ? tip.message : loaded ? t('tip.encouragement') : t('tip.thinking')}</p>
        {notice && (
          <div className="ai-tip-notice" role="status">
            <p>{notice}</p>
            {undoTipId && <button type="button" className="hifi-pill" disabled={busy} onClick={undo}>{t('tip.undo')}</button>}
          </div>
        )}
        <div className="ai-insight-actions">
          {tip && (
            <button type="button" className="ai-insight-why" aria-label={t('tip.why')} onClick={() => setShowWhy(true)}>
              <CircleHelp size={18} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="hifi-pill" onClick={() => navigate('/coach')}>{t('coach.ask')}</button>
          {tip && (
            <button type="button" className="hifi-pill is-big" disabled={busy} onClick={() => decide('accepted')}>{t('tip.accept')}</button>
          )}
        </div>
      </section>

      {showWhy && tip && (
        <div className="ai-tip-backdrop" onClick={() => setShowWhy(false)}>
          <div
            className="ai-tip-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-tip-why-title"
            tabIndex={-1}
            ref={dialogRef}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="ai-tip-why-title">{t('tip.why')}</h3>
            <p>{tip.reasoning}</p>
            <button type="button" className="primary-button" onClick={() => setShowWhy(false)}>{t('tip.gotIt')}</button>
          </div>
        </div>
      )}
    </>
  )
}
