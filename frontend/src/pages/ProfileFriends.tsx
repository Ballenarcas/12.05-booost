import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import MemberRow from '../components/community/MemberRow'
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
import backIcon from '../assets/scan/back.svg'
import { useT, type MessageKey } from '../i18n'
import '../styles/profile.css'
import '../styles/community.css'
import { RowSkeleton } from '../components/community/Skeleton'

type Tab = 'followers' | 'following' | 'requests' | 'blocked'
type Action = { label: MessageKey; run: (id: string) => Promise<void> }

const TABS: { id: Tab; label: MessageKey; actions: Action[] }[] = [
  { id: 'followers', label: 'community.followers', actions: [{ label: 'community.remove', run: removeFollower }] },
  { id: 'following', label: 'community.following', actions: [{ label: 'community.unfollow', run: unfollowMember }] },
  {
    id: 'requests',
    label: 'community.requests',
    actions: [
      { label: 'community.accept', run: acceptFollowRequest },
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
    <section className="hifi-card">
      {members === null && !error && <RowSkeleton />}
      {members?.length === 0 && <p className="hifi-muted">{t('community.listEmpty')}</p>}
      {error && <p className="cm-error" role="alert">{error}</p>}
      <ul className="cm-members">
        {members?.map((member) => (
          <MemberRow key={member.id} member={member}>
            {actions.map((action) => (
              <button key={action.label} type="button" className="hifi-pill" disabled={busyIds.has(member.id)} onClick={() => void act(action, member.id)}>
                {t(action.label)}
              </button>
            ))}
          </MemberRow>
        ))}
      </ul>
    </section>
  )
}

export default function ProfileFriends() {
  const t = useT()
  const navigate = usePageNavigate()
  const [me, , meError] = useSocialMe()
  const [tab, setTab] = useState<Tab>('followers')
  const active = TABS.find((item) => item.id === tab) ?? TABS[0]

  return (
    <div className="screen hifi-screen hifi-theme friends-screen">
      <header className="friends-header">
        <button type="button" className="scan-back" aria-label={t('body.back')} onClick={() => navigate('/profile', { direction: 'back' })}>
          <img src={backIcon} alt="" width={36} height={37} />
        </button>
        <h1>{t('profile.friends')}</h1>
      </header>

      {meError && <p className="cm-error" role="alert">{meError}</p>}
      {!me && !meError && <RowSkeleton />}
      {me && !me.joined && (
        <section className="hifi-card">
          <p>{t('community.joinFirst')}</p>
          <Link to="/community" className="secondary-action">{t('community.openCommunity')}</Link>
        </section>
      )}

      {me?.joined && me.username && (
        <>
          <div className="cm-tabs">
            {TABS.map((item) => (
              <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>
                {t(item.label)}
              </button>
            ))}
          </div>
          <MemberList key={tab} tab={tab} username={me.username} actions={active.actions} />
        </>
      )}
    </div>
  )
}
