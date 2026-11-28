import { ArrowLeft, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Avatar from '../components/community/Avatar'
import PostCard, { MentionText } from '../components/community/PostCard'
import { addComment, cachedPost, deleteComment, fetchComments, fetchPost, rememberCommentCount } from '../services/api'
import { PostSkeleton, RowSkeleton } from '../components/community/Skeleton'
import type { Comment, Post } from '../types/social'
import { describeError } from '../utils/errors.js'
import { timeAgo } from '../utils/timeAgo'
import { usePageNavigate } from '../utils/usePageNavigate'
import { useSocialMe } from '../utils/useSocialMe'
import { locale, useT } from '../i18n'
import '../styles/community.css'

function Thread({ postId }: { postId: string }) {
  const t = useT()
  const navigate = usePageNavigate()
  // The post from the feed shows at once; the comments load beside it.
  const [post, setPost] = useState<Post | null>(() => cachedPost(postId))
  const [comments, setComments] = useState<Comment[]>([])
  const [commentsLoaded, setCommentsLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [me] = useSocialMe()
  const pendingId = useRef(0)
  const replyInputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let current = true
    const failed = (failure: unknown) => {
      if (!current) return
      // A post that is gone or hidden now must not stay on screen from the feed's copy.
      setPost(null)
      setError(describeError(failure, t('community.error')))
    }
    fetchPost(postId).then((loaded) => { if (current) setPost(loaded) }).catch(failed)
    fetchComments(postId)
      .then((list) => {
        if (!current) return
        setComments(list)
        setCommentsLoaded(true)
      })
      .catch(failed)
    return () => { current = false }
  }, [postId, t])

  const leave = () => navigate('/community', { direction: 'back' })

  const fail = (failure: unknown) => setError(describeError(failure, t('community.error')))
  const countComments = (step: number) => {
    rememberCommentCount(postId, step)
    setPost((current) => current && { ...current, comment_count: Math.max(0, current.comment_count + step) })
  }

  function submitDraft() {
    const body = draft.trim()
    if (!body) return
    const id = `pending-${++pendingId.current}`
    setError(null)
    setDraft('')
    if (me) {
      const author = { id: me.id, username: me.username ?? '', name: me.name, avatar_url: me.avatar_url, is_private: me.is_private }
      setComments((current) => [...current, { id, author, body, can_delete: false, created_at: new Date().toISOString() }])
    }
    countComments(1)
    addComment(postId, body)
      .then((added) => setComments((current) => (
        current.some((item) => item.id === id) ? current.map((item) => (item.id === id ? added : item)) : [...current, added]
      )))
      .catch((failure) => {
        setComments((current) => current.filter((item) => item.id !== id))
        countComments(-1)
        setDraft((current) => current || body)
        fail(failure)
      })
  }

  // The comment shows at once and is swapped for the saved one when the server answers.
  function send(event: React.FormEvent) {
    event.preventDefault()
    submitDraft()
  }

  function remove(comment: Comment) {
    setError(null)
    setComments((current) => current.filter((item) => item.id !== comment.id))
    countComments(-1)
    deleteComment(comment.id).catch((failure) => {
      // Put it back where it was using numeric timestamps (handles Z vs +00:00).
      setComments((current) => (
        current.some((item) => item.id === comment.id)
          ? current
          : [...current, comment].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      ))
      countComments(1)
      fail(failure)
    })
  }

  return (
    <>
      {!post && !error && <PostSkeleton count={1} />}
      {error && <p className="cm-error cm-banner-error" role="alert">{error}</p>}
      {post && (
        <>
          <PostCard
            post={post}
            variant="detail"
            priority
            onReplyClick={() => replyInputRef.current?.focus()}
            onChange={(update) => setPost((current) => current && update(current))}
            onDeleted={leave}
            onBlocked={leave}
          />

          <form className="cm-reply-form" onSubmit={send}>
            <Avatar name={me?.name || me?.username || ''} url={me?.avatar_url} />
            <div className="cm-reply-main">
              <textarea
                ref={replyInputRef}
                rows={1}
                value={draft}
                maxLength={280}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    submitDraft()
                  }
                }}
                placeholder={t('community.replyPlaceholder')}
                aria-label={t('community.addComment')}
              />
              <button type="submit" className="cm-btn-primary cm-btn-sm" disabled={!draft.trim()}>
                {t('community.reply')}
              </button>
            </div>
          </form>

          <section aria-label={t('community.commentCount', { count: post.comment_count })}>
            {!commentsLoaded && comments.length === 0 && <RowSkeleton count={2} />}
            {commentsLoaded && comments.length === 0 && (
              <div className="cm-empty">
                <p>{t('community.noComments')}</p>
              </div>
            )}
            {comments.length > 0 && (
              <ul className="cm-comments">
                {comments.map((comment) => {
                  const authorName = comment.author.name || comment.author.username
                  return (
                    <li key={comment.id}>
                      <Link to={`/community/u/${comment.author.username}`} className="cm-post-avatar" tabIndex={-1} aria-hidden="true">
                        <Avatar name={authorName} url={comment.author.avatar_url} />
                      </Link>
                      <div className="cm-comment-main">
                        <div className="cm-comment-head">
                          <div className="cm-post-byline-wrap">
                            <Link to={`/community/u/${comment.author.username}`} className="cm-post-byline">
                              <strong>{authorName}</strong>
                              <span className="cm-post-handle">@{comment.author.username}</span>
                            </Link>
                            <span aria-hidden="true">·</span>
                            <time dateTime={comment.created_at} title={new Date(comment.created_at).toLocaleString(locale())}>
                              {timeAgo(comment.created_at)}
                            </time>
                          </div>
                          {comment.can_delete && (
                            <button
                              type="button"
                              className="cm-comment-delete"
                              aria-label={t('common.delete')}
                              onClick={() => remove(comment)}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                        <MentionText text={comment.body} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  )
}

export default function CommunityPost() {
  const t = useT()
  const navigate = usePageNavigate()
  const { id = '' } = useParams()

  return (
    <div className="screen hifi-screen hifi-theme community-screen">
      <div className="cm-topbar">
        <header className="cm-topbar-back">
          <button type="button" className="cm-icon-btn" aria-label={t('common.back')} onClick={() => navigate(-1)}>
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <div className="cm-topbar-heading">
            <h1>{t('community.postTitle')}</h1>
          </div>
        </header>
      </div>
      <Thread key={id} postId={id} />
    </div>
  )
}
