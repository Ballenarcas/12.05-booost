/** The Community parts of the Profile page: photo, settings and the friends card. */
import { Camera } from 'lucide-react'
import { useRef, useState } from 'react'
import { removeAvatar, updateSocialMe, uploadAvatar } from '../../services/api'
import type { SocialMe } from '../../types/social'
import { describeError } from '../../utils/errors.js'
import { resizeImage } from '../../utils/resizeImage'
import { usePageNavigate } from '../../utils/usePageNavigate'
import { useT } from '../../i18n'
import LiquidToggle from '../ui/LiquidToggle'
import Avatar from './Avatar'
import '../../styles/community.css'

type MeProps = { me: SocialMe | null; onChange: (me: SocialMe) => void }

export function ProfilePhoto({ me, onChange, initials }: MeProps & { initials: string }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<SocialMe>) {
    setBusy(true)
    setError(null)
    try {
      onChange(await action())
    } catch (failure) {
      setError(describeError(failure, t('community.error')))
    } finally {
      setBusy(false)
    }
  }

  function choose(file: File | undefined) {
    if (file) {
      void run(async () => uploadAvatar(await resizeImage(file, t('community.photoError'), t('community.photoError'))))
    }
    if (input.current) input.current.value = ''
  }

  return (
    <div className="cm-profile-photo">
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => choose(event.target.files?.[0])} />
      <button type="button" className="cm-photo-button" aria-label={t('community.changePhoto')} disabled={busy} onClick={() => input.current?.click()}>
        {me?.avatar_url
          ? <Avatar name={me.name} url={me.avatar_url} large />
          : <span className="profile-hero-avatar" aria-hidden="true">{initials || '?'}</span>}
        <span className="cm-photo-badge" aria-hidden="true"><Camera size={16} /></span>
      </button>
      {me?.avatar_url && (
        <button type="button" className="hifi-link-button" disabled={busy} onClick={() => void run(removeAvatar)}>
          {t('community.removeProfilePhoto')}
        </button>
      )}
      {error && <p className="cm-error" role="alert">{error}</p>}
    </div>
  )
}

export function CommunitySettings({ me, onChange }: MeProps) {
  const t = useT()
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  if (!me?.joined) return null
  const username = draft ?? me.username ?? ''

  async function save(changes: { username?: string; is_private?: boolean }) {
    setBusy(true)
    setNotice(null)
    try {
      onChange(await updateSocialMe(changes))
      setDraft(null)
      setNotice({ ok: true, text: t('community.saved') })
    } catch (failure) {
      setNotice({ ok: false, text: describeError(failure, t('community.error')) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section" aria-labelledby="community-settings-title">
      <h3 className="section-title" id="community-settings-title">{t('community.title')}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <label className="settings-label" htmlFor="community-username">{t('community.username')}</label>
          <form className="cm-inline" onSubmit={(event) => { event.preventDefault(); void save({ username }) }}>
            <input
              id="community-username"
              className="settings-input"
              value={username}
              onChange={(event) => setDraft(event.target.value.toLowerCase())}
              required
              minLength={3}
              maxLength={20}
              pattern="[a-z0-9_]+"
              autoCapitalize="none"
              spellCheck={false}
            />
            {username !== me.username && <button type="submit" className="hifi-pill" disabled={busy}>{t('common.save')}</button>}
          </form>
        </div>
        <div className="settings-row">
          <span className="settings-label">
            {t('community.private')}
            <small>{t('community.privateHint')}</small>
          </span>
          <LiquidToggle checked={me.is_private} onChange={(value) => void save({ is_private: value })} label={t('community.private')} />
        </div>
      </div>
      {notice && <p className={notice.ok ? 'hifi-muted' : 'cm-error'} role={notice.ok ? 'status' : 'alert'}>{notice.text}</p>}
    </section>
  )
}

export function FriendsCard({ me }: { me: SocialMe | null }) {
  const t = useT()
  const navigate = usePageNavigate()
  const following = me?.following_preview ?? []

  return (
    <section className="hifi-section" aria-labelledby="friends-heading">
      <div className="profile-section-head">
        <h2 className="hifi-section-title" id="friends-heading">{t('profile.friends')}</h2>
      </div>
      <div className="profile-preview-card">
        <p className="profile-preview-copy">
          {me?.joined
            ? t('community.friendsSummary', { followers: me.followers, following: me.following })
            : <>{t('profile.friendsCopy')}<strong>{t('profile.friendsCopyStrong')}</strong></>}
        </p>
        {me && me.pending_requests > 0 && <p className="hifi-muted">{t('community.pendingRequests', { count: me.pending_requests })}</p>}
        <div className="profile-preview-foot">
          <div className="cm-stack" aria-hidden="true">
            {following.slice(0, 4).map((member) => (
              <Avatar key={member.id} name={member.name || member.username} url={member.avatar_url} />
            ))}
          </div>
          <button type="button" className="hifi-pill" onClick={() => navigate(me?.joined ? '/profile/friends' : '/community')}>
            {me?.joined ? t('common.viewAll') : t('community.openCommunity')}
          </button>
        </div>
      </div>
    </section>
  )
}
