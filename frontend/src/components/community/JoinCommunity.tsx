import { useState } from 'react'
import { joinCommunity } from '../../services/api'
import type { SocialMe } from '../../types/social'
import { describeError } from '../../utils/errors.js'
import { useT } from '../../i18n'
import LiquidToggle from '../ui/LiquidToggle'

/** Nobody is visible to other members until they send this form. */
export default function JoinCommunity({ onJoined }: { onJoined: (me: SocialMe) => void }) {
  const t = useT()
  const [username, setUsername] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onJoined(await joinCommunity(username, isPrivate))
    } catch (failure) {
      setError(describeError(failure, t('community.error')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="hifi-card cm-join" onSubmit={submit}>
      <h2 className="hifi-section-title">{t('community.joinTitle')}</h2>
      <p className="hifi-muted">{t('community.joinBody')}</p>
      <label className="cm-field">
        <span>{t('community.username')}</span>
        <input
          className="settings-input"
          value={username}
          onChange={(event) => setUsername(event.target.value.toLowerCase())}
          required
          minLength={3}
          maxLength={20}
          pattern="[a-z0-9_]+"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <small>{t('community.usernameHint')}</small>
      </label>
      <div className="cm-switch">
        <span>
          {t('community.private')}
          <small>{t('community.privateHint')}</small>
        </span>
        <LiquidToggle checked={isPrivate} onChange={setIsPrivate} label={t('community.private')} />
      </div>
      {error && <p className="cm-error" role="alert">{error}</p>}
      <button type="submit" className="primary-button" disabled={busy}>{t('community.join')}</button>
    </form>
  )
}
