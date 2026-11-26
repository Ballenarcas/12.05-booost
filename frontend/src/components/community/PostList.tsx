import { useEffect, useState } from 'react'
import type { FeedPage, Post } from '../../types/social'
import { describeError } from '../../utils/errors.js'
import { useT } from '../../i18n'
import PostCard from './PostCard'

type Props = {
  /** Must be stable (useCallback). Give the list a ``key`` to start over. */
  load: (before?: string) => Promise<FeedPage>
  empty: string
  /** A page to show at once while the fresh one loads. */
  initial?: FeedPage | null
}

export default function PostList({ load, empty, initial = null }: Props) {
  const t = useT()
  const [posts, setPosts] = useState<Post[] | null>(initial?.items ?? null)
  const [cursor, setCursor] = useState<string | null>(initial?.next_cursor ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let current = true
    load()
      .then((page) => {
        if (!current) return
        setPosts(page.items)
        setCursor(page.next_cursor)
      })
      .catch((failure) => { if (current) setError(describeError(failure, t('community.error'))) })
    return () => { current = false }
  }, [load, t])

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await load(cursor)
      setPosts((shown) => [...(shown ?? []), ...page.items])
      setCursor(page.next_cursor)
    } catch (failure) {
      setError(describeError(failure, t('community.error')))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="cm-list">
      {posts?.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          onChange={(changed) => setPosts((shown) => shown?.map((item) => (item.id === changed.id ? changed : item)) ?? null)}
          onDeleted={(id) => setPosts((shown) => shown?.filter((item) => item.id !== id) ?? null)}
          onBlocked={(authorId) => setPosts((shown) => shown?.filter((item) => item.author.id !== authorId) ?? null)}
        />
      ))}
      {posts === null && !error && <p className="hifi-muted" role="status">{t('common.loading')}</p>}
      {posts?.length === 0 && !cursor && <p className="hifi-muted">{empty}</p>}
      {error && <p className="cm-error" role="alert">{error}</p>}
      {cursor && (
        <button type="button" className="secondary-action" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t('common.loading') : t('community.loadMore')}
        </button>
      )}
    </div>
  )
}
