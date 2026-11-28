import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowUp } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeedPage, Post } from '../../types/social'
import { describeError } from '../../utils/errors.js'
import { prefersStillness } from '../../utils/useSpring'
import { useT } from '../../i18n'
import PostCard from './PostCard'
import { PostSkeleton } from './Skeleton'

/** How often a live feed looks for new posts while it is on screen. */
const CHECK_EVERY_MS = 60_000
/** Further down than this, new posts wait behind the "See new posts" pill instead of moving the list. */
const READING_FROM_PX = 240

type Props = {
  /** Must be stable (useCallback). Give the list a ``key`` to start over. */
  load: (before?: string) => Promise<FeedPage>
  empty: string
  /** A page to show at once while the fresh one loads. */
  initial?: FeedPage | null
  /** Looks for new posts now and then, and offers them with a pill, like the timeline on X. */
  live?: boolean
}

/** The posts in ``items`` that are newer than everything shown. */
function newerThan(shown: Post[], items: Post[]): Post[] {
  const known = new Set(shown.map((post) => post.id))
  const newest = shown[0]?.created_at ?? ''
  return items.filter((post) => !known.has(post.id) && post.created_at > newest)
}

export default function PostList({ load, empty, initial = null, live = false }: Props) {
  const t = useT()
  const still = useReducedMotion()
  const [posts, setPosts] = useState<Post[] | null>(initial?.items ?? null)
  const [cursor, setCursor] = useState<string | null>(initial?.next_cursor ?? null)
  const [waiting, setWaiting] = useState<Post[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Interactions on the cached initial page must not be undone when the initial refresh finishes.
  const touchedLikes = useRef<Map<string, Pick<Post, 'liked_by_me' | 'like_count'>>>(new Map())
  const removedPosts = useRef<Set<string>>(new Set())
  const blockedAuthors = useRef<Set<string>>(new Set())
  const shownRef = useRef<Post[] | null>(posts)
  useEffect(() => { shownRef.current = posts }, [posts])

  /** A fetched page as this screen knows it: without removed posts or blocked authors, with local likes. */
  function reconcile(items: Post[]): Post[] {
    return items
      .filter((item) => !removedPosts.current.has(item.id) && !blockedAuthors.current.has(item.author.id))
      .map((item) => {
        const local = touchedLikes.current.get(item.id)
        return local ? { ...item, ...local } : item
      })
  }

  useEffect(() => {
    let current = true
    load()
      .then((page) => {
        if (!current) return
        const items = reconcile(page.items)
        const shown = shownRef.current
        // Someone reading further down keeps their place; the new posts wait behind the pill.
        if (shown?.length && window.scrollY > READING_FROM_PX) {
          const fresh = newerThan(shown, items)
          if (fresh.length) setWaiting(fresh)
          return
        }
        setPosts(items)
        setCursor(page.next_cursor)
      })
      .catch((failure) => { if (current) setError(describeError(failure, t('community.error'))) })
    return () => { current = false }
  }, [load, t])

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !shownRef.current) return
      load()
        .then((page) => {
          const shown = shownRef.current
          if (!shown) return
          const fresh = newerThan(shown, reconcile(page.items))
          if (!fresh.length) return
          if (window.scrollY > READING_FROM_PX) setWaiting(fresh)
          else setPosts([...fresh, ...shown])
        })
        .catch(() => undefined) // a missed check is retried on the next one
    }, CHECK_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [live, load])

  function showWaiting() {
    const fresh = reconcile(waiting)
    setPosts((shown) => [...fresh, ...(shown ?? []).filter((post) => !fresh.some((item) => item.id === post.id))])
    setWaiting([])
    window.scrollTo({ top: 0, behavior: prefersStillness() ? 'auto' : 'smooth' })
  }

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    setError(null)
    try {
      const page = await load(cursor)
      setPosts((shown) => {
        const base = shown ?? []
        const seen = new Set(base.map((item) => item.id))
        const fresh = page.items.filter((item) => !seen.has(item.id) && !removedPosts.current.has(item.id) && !blockedAuthors.current.has(item.author.id))
        return [...base, ...fresh]
      })
      setCursor(page.next_cursor)
    } catch (failure) {
      setError(describeError(failure, t('community.error')))
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [cursor, load, t])

  // Twitter-style infinite scroll: prefetch the next page before the reader reaches the bottom.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!cursor || !sentinel || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { rootMargin: '700px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [cursor, loadMore])

  return (
    <div className="cm-list">
      {waiting.length > 0 && (
        <button type="button" className="cm-new-posts" onClick={showWaiting}>
          <ArrowUp size={16} aria-hidden="true" />
          <span>{t('community.newPosts', { count: waiting.length })}</span>
        </button>
      )}
      {/* Removed posts fold away instead of vanishing, so the ones below glide up. */}
      {posts && posts.length > 0 && (
        <div className="cm-timeline">
          <AnimatePresence initial={false}>
            {posts.map((post, index) => (
              <motion.div
                key={post.id}
                className={`cm-post-slot${index >= 3 ? ' is-deferred' : ''}`}
                exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
                transition={still ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.38 }}
              >
                <PostCard
                  post={post}
                  priority={index < 2}
                  onChange={(update) => setPosts((shown) => shown?.map((item) => {
                    if (item.id !== post.id) return item
                    const next = update(item)
                    touchedLikes.current.set(post.id, { liked_by_me: next.liked_by_me, like_count: next.like_count })
                    return next
                  }) ?? null)}
                  onDeleted={(id) => {
                    removedPosts.current.add(id)
                    setPosts((shown) => shown?.filter((item) => item.id !== id) ?? null)
                  }}
                  onBlocked={(authorId) => {
                    blockedAuthors.current.add(authorId)
                    setPosts((shown) => shown?.filter((item) => item.author.id !== authorId) ?? null)
                    setWaiting((queued) => queued.filter((item) => item.author.id !== authorId))
                  }}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
      {posts === null && !error && <PostSkeleton count={3} />}
      {posts?.length === 0 && !cursor && (
        <div className="cm-empty">
          <p>{empty}</p>
        </div>
      )}
      {error && <p className="cm-error cm-banner-error" role="alert">{error}</p>}
      {cursor && (
        <div className="cm-load-more">
          <div ref={sentinelRef} className="cm-sentinel" aria-hidden="true" />
          <button type="button" className="cm-btn-outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? t('common.loading') : t('community.loadMore')}
          </button>
        </div>
      )}
    </div>
  )
}
