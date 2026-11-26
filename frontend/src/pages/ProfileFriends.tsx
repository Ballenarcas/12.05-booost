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
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    load(tab, username)
      .then((value) => { if (current) setMembers(value) })
      .catch((failure) => { if (current) setError(describeError(failure, t('community.error'))) })
    return () => { current = false }
  }, [tab, username, t])

  async function act(action: Action, id: string) {
    setBusy(id)
    setError(null)
    try {
      await action.run(id)
      setMembers((current) => current?.filter((member) => member.id !== id) ?? null)
    } catch (failure) {
      setError(describeError(failure, t('community.error')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="hifi-card">
      {members === null && !error && <p className="hifi-muted" role="status">{t('common.loading')}</p>}
      {members?.length === 0 && <p className="hifi-muted">{t('community.listEmpty')}</p>}
      {error && <p className="cm-error" role="alert">{error}</p>}
      <ul className="cm-members">
        {members?.map((member) => (
          <MemberRow key={member.id} member={member}>
            {actions.map((action) => (
              <button key={action.label} type="button" className="hifi-pill" disabled={busy === member.id} onClick={() => void act(action, member.id)}>
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
      {!me && !meError && <p className="hifi-muted" role="status">{t('common.loading')}</p>}
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
