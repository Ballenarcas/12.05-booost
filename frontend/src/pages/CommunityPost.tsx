import { ArrowLeft, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Avatar from '../components/community/Avatar'
import PostCard, { MentionText } from '../components/community/PostCard'
import { addComment, deleteComment, fetchComments, fetchPost } from '../services/api'
import type { Comment, Post } from '../types/social'
import { describeError } from '../utils/errors.js'
import { usePageNavigate } from '../utils/usePageNavigate'
import { useSocialMe } from '../utils/useSocialMe'
import { useT } from '../i18n'
import '../styles/community.css'

function Thread({ postId }: { postId: string }) {
  const t = useT()
  const navigate = usePageNavigate()
  const [post, setPost] = useState<Post | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [me] = useSocialMe()
  const pendingId = useRef(0)

  useEffect(() => {
    let current = true
    Promise.all([fetchPost(postId), fetchComments(postId)])
      .then(([loaded, list]) => {
        if (!current) return
        setPost(loaded)
        setComments(list)
      })
      .catch((failure) => { if (current) setError(describeError(failure, t('community.error'))) })
    return () => { current = false }
  }, [postId, t])

  const leave = () => navigate('/community', { direction: 'back' })

  const fail = (failure: unknown) => setError(describeError(failure, t('community.error')))
  const countComments = (step: number) =>
    setPost((current) => current && { ...current, comment_count: Math.max(0, current.comment_count + step) })

  // The comment shows at once and is swapped for the saved one when the server answers.
  function send(event: React.FormEvent) {
    event.preventDefault()
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

  function remove(comment: Comment) {
    setError(null)
    setComments((current) => current.filter((item) => item.id !== comment.id))
    countComments(-1)
    deleteComment(comment.id).catch((failure) => {
      // Put it back where it was.
      setComments((current) => [...current, comment].sort((a, b) => a.created_at.localeCompare(b.created_at)))
      countComments(1)
      fail(failure)
    })
  }

  return (
    <>
      {!post && !error && <p className="hifi-muted" role="status">{t('common.loading')}</p>}
      {error && <p className="cm-error" role="alert">{error}</p>}
      {post && (
        <>
          <PostCard post={post} onChange={setPost} onDeleted={leave} onBlocked={leave} />

          <section className="hifi-card" aria-label={t('community.commentCount', { count: post.comment_count })}>
            {comments.length === 0 && <p className="hifi-muted">{t('community.noComments')}</p>}
            <ul className="cm-comments">
              {comments.map((comment) => (
                <li key={comment.id}>
                  <Link to={`/community/u/${comment.author.username}`} className="cm-author">
                    <Avatar name={comment.author.name || comment.author.username} url={comment.author.avatar_url} />
                    <span className="cm-author-text">
                      <strong>{comment.author.name || comment.author.username}</strong>
                      <span>@{comment.author.username}</span>
                    </span>
                  </Link>
                  <MentionText text={comment.body} />
                  {comment.can_delete && (
                    <button
                      type="button"
                      className="cm-action is-end"
                      aria-label={t('common.delete')}
                      onClick={() => remove(comment)}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <form className="cm-comment-form" onSubmit={send}>
              <input
                className="settings-input"
                value={draft}
                maxLength={280}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t('community.addComment')}
                aria-label={t('community.addComment')}
              />
              <button type="submit" className="hifi-pill" disabled={!draft.trim()}>{t('community.send')}</button>
            </form>
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
      <header className="cm-header">
        <button type="button" className="icon-button" aria-label={t('common.back')} onClick={() => navigate(-1)}>
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h1 className="hifi-page-title">{t('community.postTitle')}</h1>
      </header>
      <Thread key={id} postId={id} />
    </div>
  )
}
