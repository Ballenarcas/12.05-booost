import { ArrowLeft, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Avatar from '../components/community/Avatar'
import Composer from '../components/community/Composer'
import JoinCommunity from '../components/community/JoinCommunity'
import MemberRow from '../components/community/MemberRow'
import PostList from '../components/community/PostList'
import { PostSkeleton } from '../components/community/Skeleton'
import { fetchFeed, lastFeedPage, rememberNewPost, searchMembers } from '../services/api'
import type { FeedMode, Member } from '../types/social'
import { describeError } from '../utils/errors.js'
import { useSocialMe } from '../utils/useSocialMe'
import { useT } from '../i18n'
import '../styles/community.css'

function Feed({ mode }: { mode: FeedMode }) {
  const t = useT()
  const load = useCallback((before?: string) => fetchFeed(mode, before), [mode])
  return <PostList live load={load} initial={lastFeedPage(mode)} empty={mode === 'following' ? t('community.emptyFollowing') : t('community.emptyDiscover')} />
}

export default function Community() {
  const t = useT()
  const [me, setMe, meError] = useSocialMe()
  // For you is the main feed, so it opens first.
  const [mode, setMode] = useState<FeedMode>('discover')
  const [version, setVersion] = useState(0)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ term: string; members: Member[] } | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const term = query.trim()

  // Asked together with /me, not after it; the feed then reuses this request. Someone who has not
  // joined gets a refusal here, which is ignored.
  useEffect(() => { void fetchFeed('discover').catch(() => undefined) }, [])

  // Once joined, quietly warm the inactive feed tab on idle so switching For you <-> Following feels instant.
  useEffect(() => {
    if (!me?.joined) return
    const other: FeedMode = mode === 'following' ? 'discover' : 'following'
    if (lastFeedPage(other)) return
    const timer = window.setTimeout(() => { void fetchFeed(other).catch(() => undefined) }, 400)
    return () => window.clearTimeout(timer)
  }, [me?.joined, mode])

  useEffect(() => {
    if (searching) searchInputRef.current?.focus()
  }, [searching])

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

  const showFeed = Boolean(me?.joined || (!me && !meError && Boolean(lastFeedPage(mode))))
  const myProfileTo = me?.joined && me.username ? `/community/u/${me.username}` : '/profile'

  function closeSearch() {
    setSearching(false)
    setQuery('')
    setFound(null)
    setSearchError(null)
  }

  return (
    <div className="screen hifi-screen hifi-theme community-screen">
      <div className="cm-topbar">
        {searching && showFeed ? (
          <div className="cm-topbar-search">
            <button type="button" className="cm-icon-btn" aria-label={t('common.back')} onClick={closeSearch}>
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
            <label className="cm-search-pill">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                maxLength={40}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('community.search')}
                aria-label={t('community.search')}
              />
              {query.length > 0 && (
                <button
                  type="button"
                  className="cm-search-clear"
                  aria-label={t('community.clearSearch')}
                  onClick={() => {
                    setQuery('')
                    setFound(null)
                    searchInputRef.current?.focus()
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </label>
          </div>
        ) : (
          <>
            <header className={`cm-topbar-row${showFeed ? '' : ' has-border'}`}>
              {me ? (
                <Link to={myProfileTo} className="cm-top-avatar" aria-label={t('community.myProfile')}>
                  <Avatar name={me.name || me.username || ''} url={me.avatar_url} priority />
                </Link>
              ) : (
                <span />
              )}
              <h1 className="cm-topbar-title">{t('community.title')}</h1>
              {showFeed ? (
                <button
                  type="button"
                  className="cm-icon-btn"
                  aria-label={t('community.search')}
                  onClick={() => setSearching(true)}
                >
                  <Search size={20} aria-hidden="true" />
                </button>
              ) : (
                <span />
              )}
            </header>

            {showFeed && (
              <div className="cm-tabs" role="tablist" aria-label={t('community.title')}>
                {(['discover', 'following'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={mode === option}
                    onClick={() => setMode(option)}
                  >
                    {t(option === 'following' ? 'community.following' : 'community.discover')}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {meError && <p className="cm-error cm-banner-error" role="alert">{meError}</p>}
      {!me && !meError && !lastFeedPage(mode) && <PostSkeleton count={3} />}
      {me && !me.joined && <JoinCommunity onJoined={setMe} />}

      {showFeed && (
        searching ? (
          <section aria-live="polite">
            {searchError && <p className="cm-error cm-banner-error" role="alert">{searchError}</p>}
            {term.length < 2 && (
              <div className="cm-empty">
                <p>{t('community.search')}</p>
              </div>
            )}
            {term.length >= 2 && found?.term === term && found.members.length === 0 && (
              <div className="cm-empty">
                <p>{t('community.noResults')}</p>
              </div>
            )}
            {term.length >= 2 && found && found.members.length > 0 && (
              <ul className="cm-members">
                {found.members.map((member) => <MemberRow key={member.id} member={member} />)}
              </ul>
            )}
          </section>
        ) : (
          <>
            <Composer onPosted={(post) => {
              rememberNewPost(post)
              setVersion((current) => current + 1)
            }} />
            <Feed key={`${mode}-${version}`} mode={mode} />
          </>
        )
      )}
    </div>
  )
}
