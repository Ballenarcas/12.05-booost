import { Ban, Dumbbell, Flame, Heart, Lock, MessageCircle, MoreHorizontal, Trash2, Trophy, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { blockMember, deletePost, mediaUrl, setPostLike } from '../../services/api'
import type { Post, PrCardData, StreakCardData, WorkoutCardData } from '../../types/social'
import { describeError } from '../../utils/errors.js'
import { splitMentions } from '../../utils/mentions'
import { usePageNavigate } from '../../utils/usePageNavigate'
import { locale, useT } from '../../i18n'
import Avatar from './Avatar'
import RollingCount from './RollingCount'
import { timeAgo } from '../../utils/timeAgo'

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
        <div className="cm-card-head">
          <Dumbbell size={14} aria-hidden="true" />
          <span>{t('community.workoutCard')}</span>
        </div>
        <div className="cm-card-body">
          <strong>{card.name}</strong>
          <span className="cm-card-meta">
            {[
              t('community.minutes', { minutes: Math.round(card.duration_seconds / 60) }),
              t('community.exercises', { count: card.exercise_count }),
              t('community.sets', { count: card.completed_sets }),
              t('community.volume', { kg: card.total_volume_kg.toLocaleString(locale()) }),
            ].join(' · ')}
          </span>
        </div>
      </div>
    )
  }
  if (post.card_type === 'pr') {
    const card = post.card as PrCardData
    return (
      <div className="cm-card">
        <div className="cm-card-head">
          <Trophy size={14} aria-hidden="true" />
          <span>{t('community.prCard')}</span>
        </div>
        <div className="cm-card-body">
          <strong>{card.exercise_name}: {t('community.prBest', { weight: card.weight_kg, reps: card.reps })}</strong>
          <span className="cm-card-meta">{t('community.prPrevious', { weight: card.previous_best_kg })}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="cm-card">
      <div className="cm-card-head">
        <Flame size={14} aria-hidden="true" />
        <span>{t('community.streakCard')}</span>
      </div>
      <div className="cm-card-body">
        <strong>{t('community.streakDays', { days: (post.card as StreakCardData).days })}</strong>
      </div>
    </div>
  )
}

function FeedPhoto({
  src,
  alt,
  priority,
  onOpen,
}: {
  src: string
  alt: string
  priority: boolean
  onOpen: (photo: { src: string; alt: string }) => void
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const checkCached = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true)
  }, [])

  return (
    <button
      type="button"
      className={`cm-photo-frame${loaded ? ' is-loaded' : failed ? ' is-error' : ' is-loading'}`}
      aria-label={alt}
      onClick={(event) => {
        event.stopPropagation()
        if (loaded) onOpen({ src, alt })
      }}
    >
      <img
        ref={checkCached}
        src={src}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </button>
  )
}

function PhotoLightbox({ photo, onClose }: { photo: { src: string; alt: string } | null; onClose: () => void }) {
  const t = useT()
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (photo && !dialog.open) dialog.showModal()
    else if (!photo && dialog.open) dialog.close()
  }, [photo])

  if (!photo) return null
  return (
    <dialog
      ref={dialogRef}
      className="cm-lightbox"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <button type="button" className="cm-lightbox-close" aria-label={t('common.close')} onClick={onClose}>
        <X size={20} aria-hidden="true" />
      </button>
      <img className="cm-lightbox-img" src={photo.src} alt={photo.alt} />
    </dialog>
  )
}

function formatDetailTime(iso: string): string {
  const date = new Date(iso)
  const loc = locale()
  const time = date.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' })
  const day = date.toLocaleDateString(loc, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${time} · ${day}`
}

type Props = {
  post: Post
  priority?: boolean
  variant?: 'timeline' | 'detail'
  onReplyClick?: () => void
  onChange: (update: (current: Post) => Post) => void
  onDeleted: (postId: string) => void
  onBlocked: (authorId: string) => void
}

export default function PostCard({
  post,
  priority = false,
  variant = 'timeline',
  onReplyClick,
  onChange,
  onDeleted,
  onBlocked,
}: Props) {
  const t = useT()
  const navigate = usePageNavigate()
  const menuId = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [heartAnim, setHeartAnim] = useState<'pop' | 'unpop' | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
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
  const inFlightLikes = useRef(0)
  const confirmedLike = useRef<{ liked_by_me: boolean; like_count: number } | null>(null)
  function toggleLike() {
    if (inFlightLikes.current === 0) {
      confirmedLike.current = { liked_by_me: post.liked_by_me, like_count: post.like_count }
    }
    inFlightLikes.current += 1
    const liked = !post.liked_by_me
    const request = ++likeRequest.current
    setError(null)
    setHeartAnim(liked ? 'pop' : 'unpop')
    onChange((current) => ({ ...current, liked_by_me: liked, like_count: Math.max(0, current.like_count + (liked ? 1 : -1)) }))
    const sent = likeQueue.current.catch(() => undefined).then(() => setPostLike(post.id, liked))
    likeQueue.current = sent
    sent
      .then((saved) => {
        confirmedLike.current = { liked_by_me: saved.liked_by_me, like_count: saved.like_count }
        if (request === likeRequest.current) {
          onChange((current) => ({ ...current, liked_by_me: saved.liked_by_me, like_count: saved.like_count }))
        }
      })
      .catch((failure) => {
        if (request !== likeRequest.current) return
        const rollback = confirmedLike.current
        if (rollback) {
          onChange((current) => ({ ...current, liked_by_me: rollback.liked_by_me, like_count: rollback.like_count }))
        }
        setError(describeError(failure, t('community.error')))
      })
      .finally(() => {
        inFlightLikes.current = Math.max(0, inFlightLikes.current - 1)
      })
  }

  const remove = () => {
    if (confirming !== 'delete') return setConfirming('delete')
    popoverRef.current?.hidePopover?.()
    void run(async () => { await deletePost(post.id); onDeleted(post.id) })
  }

  const block = () => {
    if (confirming !== 'block') return setConfirming('block')
    popoverRef.current?.hidePopover?.()
    void run(async () => { await blockMember(post.author.id); onBlocked(post.author.id) })
  }

  function handleCardClick(event: React.MouseEvent<HTMLElement>) {
    if (variant === 'detail') return
    if (window.getSelection()?.toString()) return
    const target = event.target as HTMLElement
    if (target.closest('a, button, [popover], dialog')) return
    navigate(`/community/post/${post.id}`)
  }

  const optionsMenu = (
    <>
      <button
        type="button"
        className="cm-more-btn"
        popoverTarget={menuId}
        aria-label={t('community.options')}
        onClick={() => setConfirming(null)}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      <div
        ref={popoverRef}
        id={menuId}
        popover="auto"
        className="cm-popover"
        onToggle={(event) => {
          if ((event.nativeEvent as ToggleEvent).newState === 'closed') setConfirming(null)
        }}
      >
        {post.can_delete ? (
          <button type="button" className="cm-popover-item is-danger" disabled={busy} onClick={remove}>
            <Trash2 size={17} aria-hidden="true" />
            <span>{confirming === 'delete' ? t('community.confirmDelete') : t('common.delete')}</span>
          </button>
        ) : (
          <button type="button" className="cm-popover-item is-danger" disabled={busy} onClick={block}>
            <Ban size={17} aria-hidden="true" />
            <span>{confirming === 'block' ? t('community.confirmBlock') : t('community.block', { username: post.author.username })}</span>
          </button>
        )}
      </div>
    </>
  )

  const photosBlock = post.image_urls.length > 0 && (
    <div className="cm-photos" data-count={post.image_urls.length}>
      {post.image_urls.map((url, index) => (
        <FeedPhoto
          key={url}
          src={mediaUrl(url)}
          alt={t('community.photoAlt', { n: index + 1, name })}
          priority={priority && index === 0}
          onOpen={setLightbox}
        />
      ))}
    </div>
  )

  const likeButton = (
    <button
      type="button"
      className="cm-action is-like"
      aria-pressed={post.liked_by_me}
      aria-label={`${post.liked_by_me ? t('community.unlike') : t('community.like')} (${post.like_count})`}
      onClick={toggleLike}
    >
      <span className="cm-action-icon">
        <span className={`cm-heart${heartAnim ? ` is-${heartAnim}` : ''}`} onAnimationEnd={() => setHeartAnim(null)}>
          <Heart size={variant === 'detail' ? 20 : 18} aria-hidden="true" fill={post.liked_by_me ? 'currentColor' : 'none'} />
        </span>
      </span>
      {variant === 'timeline' && <RollingCount value={post.like_count} />}
    </button>
  )

  if (variant === 'detail') {
    return (
      <article className="cm-detail">
        <header className="cm-detail-head">
          <Link to={`/community/u/${post.author.username}`} className="cm-detail-author">
            <Avatar name={name} url={post.author.avatar_url} priority={priority} />
            <span className="cm-detail-author-text">
              <span className="cm-detail-author-name">
                {name}
                {post.author.is_private && <Lock size={13} className="cm-post-lock" aria-hidden="true" />}
              </span>
              <span className="cm-detail-author-handle">@{post.author.username}</span>
            </span>
          </Link>
          {optionsMenu}
        </header>

        {post.body && <MentionText text={post.body} />}
        {photosBlock}
        <ResultCard post={post} />

        <time className="cm-detail-time" dateTime={post.created_at}>
          {formatDetailTime(post.created_at)}
        </time>

        {(post.comment_count > 0 || post.like_count > 0) && (
          <div className="cm-detail-stats">
            {post.comment_count > 0 && (
              <span>
                <strong>{post.comment_count.toLocaleString(locale())}</strong> {t('community.replies')}
              </span>
            )}
            {post.like_count > 0 && (
              <span>
                <strong>{post.like_count.toLocaleString(locale())}</strong> {t('community.likes')}
              </span>
            )}
          </div>
        )}

        <footer className="cm-detail-actions">
          <button
            type="button"
            className="cm-action is-reply"
            aria-label={t('community.reply')}
            onClick={onReplyClick}
          >
            <span className="cm-action-icon">
              <MessageCircle size={20} aria-hidden="true" />
            </span>
          </button>
          {likeButton}
        </footer>

        {error && <p className="cm-error" role="alert">{error}</p>}
        <PhotoLightbox photo={lightbox} onClose={() => setLightbox(null)} />
      </article>
    )
  }

  return (
    <article className="cm-post is-clickable" onClick={handleCardClick}>
      {/* The name link below already leads to the profile; this one is for the eye and the finger. */}
      <Link to={`/community/u/${post.author.username}`} className="cm-post-avatar" tabIndex={-1} aria-hidden="true">
        <Avatar name={name} url={post.author.avatar_url} priority={priority} />
      </Link>
      <div className="cm-post-main">
        <header className="cm-post-head">
          <div className="cm-post-byline-wrap">
            <Link to={`/community/u/${post.author.username}`} className="cm-post-byline">
              <strong>{name}</strong>
              {post.author.is_private && <Lock size={13} className="cm-post-lock" aria-hidden="true" />}
              <span className="cm-post-handle">@{post.author.username}</span>
            </Link>
            <span aria-hidden="true">·</span>
            <Link to={`/community/post/${post.id}`} className="cm-post-time">
              <time dateTime={post.created_at} title={new Date(post.created_at).toLocaleString(locale())}>
                {timeAgo(post.created_at)}
              </time>
            </Link>
          </div>
          {optionsMenu}
        </header>

        {post.body && <MentionText text={post.body} />}
        {photosBlock}
        <ResultCard post={post} />

        <footer className="cm-actions">
          <Link
            className="cm-action is-reply"
            to={`/community/post/${post.id}`}
            aria-label={t('community.commentCount', { count: post.comment_count })}
          >
            <span className="cm-action-icon">
              <MessageCircle size={18} aria-hidden="true" />
            </span>
            <RollingCount value={post.comment_count} />
          </Link>
          {likeButton}
        </footer>

        {error && <p className="cm-error" role="alert">{error}</p>}
      </div>
      <PhotoLightbox photo={lightbox} onClose={() => setLightbox(null)} />
    </article>
  )
}
