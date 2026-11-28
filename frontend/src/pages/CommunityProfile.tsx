import { ArrowLeft, Ban, Lock, MoreHorizontal } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Avatar from '../components/community/Avatar'
import PostList from '../components/community/PostList'
import { ProfileSkeleton } from '../components/community/Skeleton'
import { blockMember, fetchMember, fetchMemberPosts, followMember, unblockMember, unfollowMember } from '../services/api'
import type { MemberProfile } from '../types/social'
import { describeError } from '../utils/errors.js'
import { usePageNavigate } from '../utils/usePageNavigate'
import { locale, useT } from '../i18n'
import '../styles/community.css'

function MemberPage({ username }: { username: string }) {
  const t = useT()
  const navigate = usePageNavigate()
  const menuId = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
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

  const headerTitle = profile ? (profile.user.name || profile.user.username) : `@${username}`

  const topbar = (
    <div className="cm-topbar">
      <header className="cm-topbar-back">
        <button type="button" className="cm-icon-btn" aria-label={t('common.back')} onClick={() => navigate(-1)}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <div className="cm-topbar-heading">
          <h1>{headerTitle}</h1>
          {profile && <span className="cm-topbar-sub">@{profile.user.username}</span>}
        </div>
      </header>
    </div>
  )

  if (!profile) {
    return (
      <>
        {topbar}
        {error ? <p className="cm-error cm-banner-error" role="alert">{error}</p> : <ProfileSkeleton />}
      </>
    )
  }

  const member = profile.user
  const name = member.name || member.username

  if (blocked) {
    return (
      <>
        {topbar}
        <section className="cm-empty">
          <span className="cm-empty-icon" aria-hidden="true"><Ban size={22} /></span>
          <strong>{t('community.blockedTitle', { username: member.username })}</strong>
          {error && <p className="cm-error" role="alert">{error}</p>}
          <button
            type="button"
            className="cm-btn-outline"
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
      </>
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
      {topbar}

      <section className="cm-profile-hero">
        <div className="cm-profile-banner" aria-hidden="true" />
        <div className="cm-profile-top">
          <span className="cm-profile-avatar-ring">
            <Avatar name={name} url={member.avatar_url} priority />
          </span>

          <div className="cm-profile-actions">
            {profile.is_me ? (
              <Link to="/profile/friends" className="cm-btn-outline">
                {t('profile.friends')}
              </Link>
            ) : (
              <>
                <button
                  type="button"
                  className="cm-btn-circle"
                  popoverTarget={menuId}
                  aria-label={t('community.options')}
                  onClick={() => setConfirmBlock(false)}
                >
                  <MoreHorizontal size={18} aria-hidden="true" />
                </button>
                <div
                  ref={popoverRef}
                  id={menuId}
                  popover="auto"
                  className="cm-popover"
                  onToggle={(event) => {
                    if ((event.nativeEvent as ToggleEvent).newState === 'closed') setConfirmBlock(false)
                  }}
                >
                  <button
                    type="button"
                    className="cm-popover-item is-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirmBlock) return setConfirmBlock(true)
                      popoverRef.current?.hidePopover?.()
                      void run(async () => {
                        await blockMember(member.id)
                        setBlocked(true)
                        setConfirmBlock(false)
                      })
                    }}
                  >
                    <Ban size={17} aria-hidden="true" />
                    <span>{confirmBlock ? t('community.confirmBlock') : t('community.block', { username: member.username })}</span>
                  </button>
                </div>

                <button
                  type="button"
                  className={profile.follow_state === 'none' ? 'cm-btn-primary' : 'cm-btn-outline'}
                  disabled={busy}
                  onClick={toggleFollow}
                >
                  {followLabel}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="cm-profile-meta">
          <h2 className="cm-profile-name">
            {name}
            {member.is_private && <Lock size={16} aria-hidden="true" />}
          </h2>
          <div className="cm-profile-handle-row">
            <span>@{member.username}</span>
            {profile.follows_you && <span className="cm-follows-badge">{t('community.followsYou')}</span>}
          </div>

          <div className="cm-profile-stats">
            {profile.is_me ? (
              <>
                <Link to="/profile/friends">
                  <strong>{profile.following.toLocaleString(locale())}</strong> {t('community.following')}
                </Link>
                <Link to="/profile/friends">
                  <strong>{profile.followers.toLocaleString(locale())}</strong> {t('community.followers')}
                </Link>
              </>
            ) : (
              <>
                <span>
                  <strong>{profile.following.toLocaleString(locale())}</strong> {t('community.following')}
                </span>
                <span>
                  <strong>{profile.followers.toLocaleString(locale())}</strong> {t('community.followers')}
                </span>
              </>
            )}
          </div>

          {error && <p className="cm-error" role="alert">{error}</p>}
        </div>

        <div className="cm-tabs" role="tablist" aria-label={name}>
          <button type="button" role="tab" aria-selected="true">
            {t('community.posts')}
          </button>
        </div>
      </section>

      {profile.posts_visible ? (
        // Following or unfollowing a private account changes what may be read; a public one's posts stay.
        <PostList key={member.is_private ? profile.follow_state : 'public'} load={load} empty={t('community.emptyProfile')} />
      ) : (
        <section className="cm-empty">
          <span className="cm-empty-icon" aria-hidden="true"><Lock size={22} /></span>
          <strong>{t('community.privateTitle')}</strong>
          <p>{t('community.privateBody')}</p>
        </section>
      )}
    </>
  )
}

export default function CommunityProfile() {
  const { username = '' } = useParams()

  return (
    <div className="screen hifi-screen hifi-theme community-screen">
      <MemberPage key={username} username={username} />
    </div>
  )
}
