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

  // The button changes at once; the server's answer (or the old state, on an error) follows.
  function toggleFollow() {
    if (!profile) return
    const before = profile
    setError(null)
    setBusy(true)
    if (before.follow_state === 'none') {
      setProfile({
        ...before,
        follow_state: member.is_private ? 'pending' : 'following',
        followers: before.followers + (member.is_private ? 0 : 1),
      })
      followMember(member.id)
        .then(setProfile)
        .catch((failure) => { setProfile(before); fail(failure) })
        .finally(() => setBusy(false))
    } else {
      // What the server would answer: no follow, and a private account's posts hidden again.
      setProfile({
        ...before,
        follow_state: 'none',
        followers: Math.max(0, before.followers - (before.follow_state === 'following' ? 1 : 0)),
        posts_visible: !member.is_private,
      })
      unfollowMember(member.id)
        .catch((failure) => { setProfile(before); fail(failure) })
        .finally(() => setBusy(false))
    }
  }

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
            <button type="button" className="hifi-pill" disabled={busy} onClick={toggleFollow}>
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
        // Following or unfollowing a private account changes what may be read; a public one's posts stay.
        <PostList key={member.is_private ? profile.follow_state : 'public'} load={load} empty={t('community.emptyProfile')} />
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
