import { Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import Composer from '../components/community/Composer'
import JoinCommunity from '../components/community/JoinCommunity'
import MemberRow from '../components/community/MemberRow'
import PostList from '../components/community/PostList'
import { fetchFeed, lastFeedPage, rememberNewPost, searchMembers } from '../services/api'
import type { FeedMode, Member } from '../types/social'
import { describeError } from '../utils/errors.js'
import { useSocialMe } from '../utils/useSocialMe'
import { useT } from '../i18n'
import '../styles/community.css'

function Feed({ mode }: { mode: FeedMode }) {
  const t = useT()
  const load = useCallback((before?: string) => fetchFeed(mode, before), [mode])
  return <PostList load={load} initial={lastFeedPage(mode)} empty={mode === 'following' ? t('community.emptyFollowing') : t('community.emptyDiscover')} />
}

export default function Community() {
  const t = useT()
  const [me, setMe, meError] = useSocialMe()
  const [mode, setMode] = useState<FeedMode>('following')
  const [version, setVersion] = useState(0)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ term: string; members: Member[] } | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const term = query.trim()

  // Asked together with /me, not after it; the feed then reuses this request. Someone who has not
  // joined gets a refusal here, which is ignored.
  useEffect(() => { void fetchFeed('following').catch(() => undefined) }, [])

  useEffect(() => {
    if (term.length < 2) return
    let current = true
    // Waits for a pause in typing before asking the server.
    const timer = window.setTimeout(() => {
      searchMembers(term)
        .then((members) => {
          if (!current) return
          setFound({ term, members })
          setSearchError(null)
        })
        .catch((failure) => { if (current) setSearchError(describeError(failure, t('community.error'))) })
    }, 300)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [term, t])

  return (
    <div className="screen hifi-screen hifi-theme community-screen">
      <header className="hifi-page-header">
        <h1 className="hifi-page-title">{t('community.title')}</h1>
      </header>

      {meError && <p className="cm-error" role="alert">{meError}</p>}
      {!me && !meError && <p className="hifi-muted" role="status">{t('common.loading')}</p>}
      {me && !me.joined && <JoinCommunity onJoined={setMe} />}

      {me?.joined && (
        <>
          <label className="cm-search">
            <Search size={18} aria-hidden="true" />
            <input
              type="search"
              value={query}
              maxLength={40}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('community.search')}
              aria-label={t('community.search')}
            />
          </label>

          {term.length >= 2 ? (
            <section className="hifi-card" aria-live="polite">
              {searchError && <p className="cm-error" role="alert">{searchError}</p>}
              {found?.term === term && found.members.length === 0 && <p className="hifi-muted">{t('community.noResults')}</p>}
              <ul className="cm-members">
                {found?.members.map((member) => <MemberRow key={member.id} member={member} />)}
              </ul>
            </section>
          ) : (
            <>
              <div className="cm-tabs">
                {(['following', 'discover'] as const).map((option) => (
                  <button key={option} type="button" aria-pressed={mode === option} onClick={() => setMode(option)}>
                    {t(option === 'following' ? 'community.following' : 'community.discover')}
                  </button>
                ))}
              </div>
              <Composer onPosted={(post) => {
                rememberNewPost(post)
                setVersion((current) => current + 1)
              }} />
              <Feed key={`${mode}-${version}`} mode={mode} />
            </>
          )}
        </>
      )}
    </div>
  )
}
