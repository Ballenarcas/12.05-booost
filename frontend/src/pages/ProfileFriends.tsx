import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import MemberRow from '../components/community/MemberRow'
import { RowSkeleton } from '../components/community/Skeleton'
import {
  acceptFollowRequest,
  declineFollowRequest,
  fetchBlocked,
  fetchFollowRequests,
  fetchMemberList,
  removeFollower,
  unblockMember,
  unfollowMember,
} from '../services/api'
import type { Member } from '../types/social'
import { describeError } from '../utils/errors.js'
import { usePageNavigate } from '../utils/usePageNavigate'
import { useSocialMe } from '../utils/useSocialMe'
import { useT, type MessageKey } from '../i18n'
import '../styles/community.css'

type Tab = 'followers' | 'following' | 'requests' | 'blocked'
type Action = { label: MessageKey; primary?: boolean; run: (id: string) => Promise<void> }

const TABS: { id: Tab; label: MessageKey; actions: Action[] }[] = [
  { id: 'followers', label: 'community.followers', actions: [{ label: 'community.remove', run: removeFollower }] },
  { id: 'following', label: 'community.following', actions: [{ label: 'community.unfollow', run: unfollowMember }] },
  {
    id: 'requests',
    label: 'community.requests',
    actions: [
      { label: 'community.accept', primary: true, run: acceptFollowRequest },
      { label: 'community.decline', run: declineFollowRequest },
    ],
  },
  { id: 'blocked', label: 'community.blocked', actions: [{ label: 'community.unblock', run: unblockMember }] },
]

function load(tab: Tab, username: string): Promise<Member[]> {
  if (tab === 'requests') return fetchFollowRequests()
  if (tab === 'blocked') return fetchBlocked()
  return fetchMemberList(username, tab)
}

function MemberList({ tab, username, actions }: { tab: Tab; username: string; actions: Action[] }) {
  const t = useT()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    load(tab, username)
      .then((value) => { if (current) setMembers(value) })
      .catch((failure) => { if (current) setError(describeError(failure, t('community.error'))) })
    return () => { current = false }
  }, [tab, username, t])

  function act(action: Action, id: string) {
    const index = members?.findIndex((member) => member.id === id) ?? -1
    const removed = index >= 0 ? members?.[index] : undefined
    setBusyIds((current) => new Set(current).add(id))
    setError(null)
    setMembers((current) => current?.filter((member) => member.id !== id) ?? null)
    action.run(id)
      .catch((failure) => {
        // Only this row comes back: other rows may have been changed meanwhile.
        if (removed) {
          setMembers((current) => {
            if (!current || current.some((member) => member.id === removed.id)) return current
            const at = Math.min(index, current.length)
            return [...current.slice(0, at), removed, ...current.slice(at)]
          })
        }
        setError(describeError(failure, t('community.error')))
      })
      .finally(() => {
        setBusyIds((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      })
  }

  return (
    <section>
      {members === null && !error && <RowSkeleton />}
      {members?.length === 0 && (
        <div className="cm-empty">
          <p>{t('community.listEmpty')}</p>
        </div>
      )}
      {error && <p className="cm-error cm-banner-error" role="alert">{error}</p>}
      {members && members.length > 0 && (
        <ul className="cm-members">
          {members.map((member) => (
            <MemberRow key={member.id} member={member}>
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={`${action.primary ? 'cm-btn-primary' : 'cm-btn-outline'} cm-btn-sm`}
                  disabled={busyIds.has(member.id)}
                  onClick={() => void act(action, member.id)}
                >
                  {t(action.label)}
                </button>
              ))}
            </MemberRow>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function ProfileFriends() {
  const t = useT()
  const navigate = usePageNavigate()
  const [me, , meError] = useSocialMe()
  const [tab, setTab] = useState<Tab>('followers')
  const active = TABS.find((item) => item.id === tab) ?? TABS[0]
  const joined = Boolean(me?.joined && me.username)

  return (
    <div className="screen hifi-screen hifi-theme friends-screen">
      <div className="cm-topbar">
        <header className={`cm-topbar-back${joined ? ' no-border' : ''}`}>
          <button
            type="button"
            className="cm-icon-btn"
            aria-label={t('body.back')}
            onClick={() => navigate('/profile', { direction: 'back' })}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <div className="cm-topbar-heading">
            <h1>{t('profile.friends')}</h1>
            {me?.username && <span className="cm-topbar-sub">@{me.username}</span>}
          </div>
        </header>

        {joined && (
          <div className="cm-tabs" role="tablist" aria-label={t('profile.friends')}>
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        )}
      </div>

      {meError && <p className="cm-error cm-banner-error" role="alert">{meError}</p>}
      {!me && !meError && <RowSkeleton />}
      {me && !me.joined && (
        <section className="cm-empty">
          <p>{t('community.joinFirst')}</p>
          <Link to="/community" className="cm-btn-primary">{t('community.openCommunity')}</Link>
        </section>
      )}

      {me?.joined && me.username && (
        <MemberList key={tab} tab={tab} username={me.username} actions={active.actions} />
      )}
    </div>
  )
}
