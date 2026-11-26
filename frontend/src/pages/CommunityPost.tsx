import { ArrowLeft, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Avatar from '../components/community/Avatar'
import PostCard, { MentionText } from '../components/community/PostCard'
import { addComment, deleteComment, fetchComments, fetchPost } from '../services/api'
import type { Comment, Post } from '../types/social'
import { describeError } from '../utils/errors.js'
import { usePageNavigate } from '../utils/usePageNavigate'
import { useT } from '../i18n'
import '../styles/community.css'

function Thread({ postId }: { postId: string }) {
  const t = useT()
  const navigate = usePageNavigate()
  const [post, setPost] = useState<Post | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      // The server owns the counts.
      setPost(await fetchPost(postId))
    } catch (failure) {
      setError(describeError(failure, t('community.error')))
    } finally {
      setBusy(false)
    }
  }

  function send(event: React.FormEvent) {
    event.preventDefault()
    if (!draft.trim()) return
    void run(async () => {
      const added = await addComment(postId, draft)
      setComments((current) => [...current, added])
      setDraft('')
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
                      disabled={busy}
                      onClick={() => void run(async () => {
                        await deleteComment(comment.id)
                        setComments((current) => current.filter((item) => item.id !== comment.id))
                      })}
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
              <button type="submit" className="hifi-pill" disabled={busy || !draft.trim()}>{t('community.send')}</button>
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
