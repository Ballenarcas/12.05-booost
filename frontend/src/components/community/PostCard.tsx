import { Heart, MessageCircle, MoreHorizontal, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { blockMember, deletePost, mediaUrl, setPostLike } from '../../services/api'
import type { Post, PrCardData, StreakCardData, WorkoutCardData } from '../../types/social'
import { describeError } from '../../utils/errors.js'
import { splitMentions } from '../../utils/mentions'
import { locale, useT } from '../../i18n'
import Avatar from './Avatar'

/** Post and comment text. Only React text nodes and internal links: nothing is read as HTML. */
export function MentionText({ text }: { text: string }) {
  return (
    <p className="cm-text">
      {splitMentions(text).map((part, index) => (
        part.mention
          ? <Link key={index} to={`/community/u/${part.mention}`}>{part.text}</Link>
          : <span key={index}>{part.text}</span>
      ))}
    </p>
  )
}

function ResultCard({ post }: { post: Post }) {
  const t = useT()
  if (!post.card) return null
  if (post.card_type === 'workout') {
    const card = post.card as WorkoutCardData
    return (
      <div className="cm-card">
        <span className="cm-card-kind">{t('community.workoutCard')}</span>
        <strong>{card.name}</strong>
        <span>
          {[
            t('community.minutes', { minutes: Math.round(card.duration_seconds / 60) }),
            t('community.exercises', { count: card.exercise_count }),
            t('community.sets', { count: card.completed_sets }),
            t('community.volume', { kg: card.total_volume_kg.toLocaleString(locale()) }),
          ].join(' · ')}
        </span>
      </div>
    )
  }
  if (post.card_type === 'pr') {
    const card = post.card as PrCardData
    return (
      <div className="cm-card">
        <span className="cm-card-kind">{t('community.prCard')}</span>
        <strong>{card.exercise_name}: {t('community.prBest', { weight: card.weight_kg, reps: card.reps })}</strong>
        <span>{t('community.prPrevious', { weight: card.previous_best_kg })}</span>
      </div>
    )
  }
  return (
    <div className="cm-card">
      <span className="cm-card-kind">{t('community.streakCard')}</span>
      <strong>{t('community.streakDays', { days: (post.card as StreakCardData).days })}</strong>
    </div>
  )
}

type Props = {
  post: Post
  onChange: (post: Post) => void
  onDeleted: (postId: string) => void
  onBlocked: (authorId: string) => void
}

export default function PostCard({ post, onChange, onDeleted, onBlocked }: Props) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [heartAnim, setHeartAnim] = useState<'pop' | 'unpop' | null>(null)
  // Deleting and blocking take a second tap.
  const [confirming, setConfirming] = useState<'delete' | 'block' | null>(null)
  const name = post.author.name || post.author.username

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(describeError(failure, t('community.error')))
    } finally {
      setBusy(false)
    }
  }

  // Taps reach the server in order (each waits for the one before), and only the latest
  // tap's answer is shown, so quick taps never flip the heart back.
  const likeRequest = useRef(0)
  const likeQueue = useRef<Promise<unknown>>(Promise.resolve())
  function toggleLike() {
    const before = post
    const liked = !post.liked_by_me
    const request = ++likeRequest.current
    setError(null)
    setHeartAnim(liked ? 'pop' : 'unpop')
    onChange({ ...post, liked_by_me: liked, like_count: Math.max(0, post.like_count + (liked ? 1 : -1)) })
    const sent = likeQueue.current.catch(() => undefined).then(() => setPostLike(post.id, liked))
    likeQueue.current = sent
    sent
      .then((saved) => { if (request === likeRequest.current) onChange(saved) })
      .catch((failure) => {
        if (request !== likeRequest.current) return
        onChange(before)
        setError(describeError(failure, t('community.error')))
      })
  }
  const remove = () => {
    if (confirming !== 'delete') return setConfirming('delete')
    void run(async () => { await deletePost(post.id); onDeleted(post.id) })
  }
  const block = () => {
    if (confirming !== 'block') return setConfirming('block')
    void run(async () => { await blockMember(post.author.id); onBlocked(post.author.id) })
  }

  return (
    <article className="hifi-card cm-post">
      <header className="cm-post-head">
        <Link to={`/community/u/${post.author.username}`} className="cm-author">
          <Avatar name={name} url={post.author.avatar_url} />
          <span className="cm-author-text">
            <strong>{name}</strong>
            <span>
              @{post.author.username} · {new Date(post.created_at).toLocaleDateString(locale(), { month: 'short', day: 'numeric' })}
            </span>
          </span>
        </Link>
        {!post.can_delete && (
          <details className="cm-menu">
            <summary aria-label={t('community.options')}><MoreHorizontal size={20} aria-hidden="true" /></summary>
            <button type="button" className="hifi-pill" disabled={busy} onClick={block}>
              {confirming === 'block' ? t('community.confirmBlock') : t('community.block', { username: post.author.username })}
            </button>
          </details>
        )}
      </header>

      {post.body && <MentionText text={post.body} />}

      {post.image_urls.length > 0 && (
        <div className="cm-photos" data-count={post.image_urls.length}>
          {post.image_urls.map((url, index) => (
            <img key={url} src={mediaUrl(url)} alt={t('community.photoAlt', { n: index + 1, name })} loading="lazy" />
          ))}
        </div>
      )}

      <ResultCard post={post} />

      <footer className="cm-actions">
        <button
          type="button"
          className="cm-action"
          aria-pressed={post.liked_by_me}
          aria-label={`${post.liked_by_me ? t('community.unlike') : t('community.like')} (${post.like_count})`}
          onClick={toggleLike}
        >
          <span className={`cm-heart${heartAnim ? ` is-${heartAnim}` : ''}`} onAnimationEnd={() => setHeartAnim(null)}>
            <Heart size={18} aria-hidden="true" fill={post.liked_by_me ? 'currentColor' : 'none'} />
          </span>
          <span aria-hidden="true">{post.like_count}</span>
        </button>
        <Link className="cm-action" to={`/community/post/${post.id}`} aria-label={t('community.commentCount', { count: post.comment_count })}>
          <MessageCircle size={18} aria-hidden="true" />
          <span aria-hidden="true">{post.comment_count}</span>
        </Link>
        {post.can_delete && (
          <button type="button" className="cm-action is-end" disabled={busy} onClick={remove} aria-label={t('common.delete')}>
            <Trash2 size={18} aria-hidden="true" />
            {confirming === 'delete' && <span>{t('community.confirmDelete')}</span>}
          </button>
        )}
      </footer>

      {error && <p className="cm-error" role="alert">{error}</p>}
    </article>
  )
}
