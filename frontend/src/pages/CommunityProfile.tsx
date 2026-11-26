import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import Avatar from '../components/community/Avatar'
import PostList from '../components/community/PostList'
import { blockMember, fetchMember, fetchMemberPosts, followMember, unblockMember, unfollowMember } from '../services/api'
import type { MemberProfile } from '../types/social'
import { describeError } from '../utils/errors.js'
import { usePageNavigate } from '../utils/usePageNavigate'
import { useT } from '../i18n'
import '../styles/community.css'

function MemberPage({ username }: { username: string }) {
  const t = useT()
  const [profile, setProfile] = useState<MemberProfile | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [confirmBlock, setConfirmBlock] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fail = useCallback((failure: unknown) => setError(describeError(failure, t('community.error'))), [t])

  useEffect(() => {
    let current = true
    fetchMember(username)
      .then((value) => { if (current) setProfile(value) })
      .catch((failure) => { if (current) fail(failure) })
    return () => { current = false }
  }, [username, fail])

  const load = useCallback((before?: string) => fetchMemberPosts(username, before), [username])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(false)
    }
  }

  if (!profile) {
    return error
      ? <p className="cm-error" role="alert">{error}</p>
      : <p className="hifi-muted" role="status">{t('common.loading')}</p>
  }

  const member = profile.user
  const name = member.name || member.username

  if (blocked) {
    return (
      <section className="hifi-card">
        <p>{t('community.blockedTitle', { username: member.username })}</p>
        {error && <p className="cm-error" role="alert">{error}</p>}
        <button
          type="button"
          className="secondary-action"
          disabled={busy}
          onClick={() => void run(async () => {
            await unblockMember(member.id)
            setProfile(await fetchMember(username))
            setBlocked(false)
          })}
        >
          {t('community.unblock')}
        </button>
      </section>
    )
  }

  const toggleFollow = () => run(async () => {
    if (profile.follow_state === 'none') {
      setProfile(await followMember(member.id))
    } else {
      await unfollowMember(member.id)
      setProfile(await fetchMember(username))
    }
  })

  const followLabel = {
    none: t('community.follow'),
    pending: t('community.requested'),
    following: t('community.unfollow'),
  }[profile.follow_state]

  return (
    <>
      <section className="hifi-card cm-profile">
        <Avatar name={name} url={member.avatar_url} large />
        <h2 className="hifi-section-title">{name}</h2>
        <p className="hifi-muted">
          @{member.username}{profile.follows_you ? ` · ${t('community.followsYou')}` : ''}
        </p>
        <p>{t('community.friendsSummary', { followers: profile.followers, following: profile.following })}</p>
        {!profile.is_me && (
          <div className="cm-profile-actions">
            <button type="button" className="hifi-pill" disabled={busy} onClick={() => void toggleFollow()}>
              {followLabel}
            </button>
            <button
              type="button"
              className="hifi-pill"
              disabled={busy}
              onClick={() => {
                if (!confirmBlock) return setConfirmBlock(true)
                void run(async () => {
                  await blockMember(member.id)
                  setBlocked(true)
                  setConfirmBlock(false)
                })
              }}
            >
              {confirmBlock ? t('community.confirmBlock') : t('community.block', { username: member.username })}
            </button>
          </div>
        )}
        {error && <p className="cm-error" role="alert">{error}</p>}
      </section>

      {profile.posts_visible ? (
        // Following or unfollowing a private account changes what may be read.
        <PostList key={profile.follow_state} load={load} empty={t('community.emptyProfile')} />
      ) : (
        <section className="hifi-card">
          <strong>{t('community.privateTitle')}</strong>
          <p className="hifi-muted">{t('community.privateBody')}</p>
        </section>
      )}
    </>
  )
}

export default function CommunityProfile() {
  const t = useT()
  const navigate = usePageNavigate()
  const { username = '' } = useParams()

  return (
    <div className="screen hifi-screen hifi-theme community-screen">
      <header className="cm-header">
        <button type="button" className="icon-button" aria-label={t('common.back')} onClick={() => navigate(-1)}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h1 className="hifi-page-title">@{username}</h1>
      </header>
      <MemberPage key={username} username={username} />
    </div>
  )
}
