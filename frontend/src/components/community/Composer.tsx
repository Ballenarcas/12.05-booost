import { Dumbbell, Flame, ImagePlus, Paperclip, Trophy, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPost, fetchAttachables } from '../../services/api'
import type { Attachables, CardRef, Post } from '../../types/social'
import { describeError } from '../../utils/errors.js'
import { resizeImage } from '../../utils/resizeImage'
import { useT } from '../../i18n'
import { useSocialMe } from '../../utils/useSocialMe'
import Avatar from './Avatar'

const MAX_LENGTH = 280
const MAX_PHOTOS = 4
const RING_R = 9
const RING_C = 2 * Math.PI * RING_R

type Photo = { blob: Blob; url: string }
type Attached = { ref: CardRef; label: string }

function CardIcon({ type }: { type: CardRef['type'] }) {
  if (type === 'workout') return <Dumbbell size={16} aria-hidden="true" />
  if (type === 'pr') return <Trophy size={16} aria-hidden="true" />
  return <Flame size={16} aria-hidden="true" />
}

export default function Composer({ onPosted }: { onPosted: (post: Post) => void }) {
  const t = useT()
  const [me] = useSocialMe()
  const [body, setBody] = useState('')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [attached, setAttached] = useState<Attached | null>(null)
  const [options, setOptions] = useState<Attachables | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // Preview URLs hold memory until they are revoked.
  const previews = useRef<Photo[]>([])
  useEffect(() => { previews.current = photos }, [photos])
  useEffect(() => () => previews.current.forEach((photo) => URL.revokeObjectURL(photo.url)), [])

  // Counted in characters like the server does, not in UTF-16 units.
  const length = [...body].length
  const remaining = MAX_LENGTH - length
  const progress = Math.min(1, length / MAX_LENGTH)
  const dashOffset = RING_C * (1 - progress)
  const canPost = !busy && length <= MAX_LENGTH && Boolean(body.trim() || photos.length || attached)

  const fail = (failure: unknown) => setError(describeError(failure, t('community.error')))

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return
    setError(null)
    const room = MAX_PHOTOS - photos.length
    if (files.length > room) setError(t('community.maxPhotos'))
    try {
      const added = await Promise.all([...files].slice(0, room).map(async (file) => {
        const blob = await resizeImage(file, t('community.photoError'), t('community.photoError'))
        return { blob, url: URL.createObjectURL(blob) }
      }))
      setPhotos((current) => [...current, ...added].slice(0, MAX_PHOTOS))
    } catch {
      setError(t('community.photoError'))
    }
    if (input.current) input.current.value = ''
  }

  function removePhoto(url: string) {
    URL.revokeObjectURL(url)
    setPhotos((current) => current.filter((photo) => photo.url !== url))
  }

  function togglePicker() {
    setPicking((open) => !open)
    if (!picking) fetchAttachables().then(setOptions).catch(fail)
  }

  function attach(ref: CardRef, label: string) {
    setAttached({ ref, label })
    setPicking(false)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!canPost) return
    setBusy(true)
    setError(null)
    try {
      const created = await createPost(body, attached?.ref ?? null, photos.map((photo) => photo.blob))
      photos.forEach((photo) => URL.revokeObjectURL(photo.url))
      setBody('')
      setPhotos([])
      setAttached(null)
      onPosted(created)
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(false)
    }
  }

  const streak = options && options.streak_days >= options.streak_to_share ? options.streak_days : null
  const ringState = remaining < 0 ? ' is-over' : remaining <= 20 ? ' is-warn' : ''

  return (
    <form className="cm-composer" onSubmit={submit} aria-label={t('community.composeLabel')}>
      <Avatar name={me?.name || me?.username || ''} url={me?.avatar_url} />
      <div className="cm-composer-main">
        <textarea
          rows={2}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={t('community.composePlaceholder')}
          aria-label={t('community.composeLabel')}
        />

        {photos.length > 0 && (
          <div className="cm-previews" data-count={photos.length}>
            {photos.map((photo, index) => (
              <span key={photo.url} className="cm-preview">
                <img src={photo.url} alt="" />
                <button type="button" aria-label={t('community.removePhoto', { n: index + 1 })} onClick={() => removePhoto(photo.url)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}

        {attached && (
          <p className="cm-attached">
            <span className="cm-attached-label">
              <CardIcon type={attached.ref.type} />
              <span>{attached.label}</span>
            </span>
            <button type="button" aria-label={t('community.removeCard')} onClick={() => setAttached(null)}>
              <X size={16} aria-hidden="true" />
            </button>
          </p>
        )}

        <div className="cm-composer-bar">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={(event) => void addPhotos(event.target.files)}
          />
          <button
            type="button"
            className="cm-tool-btn"
            aria-label={t('community.addPhoto')}
            disabled={photos.length >= MAX_PHOTOS}
            onClick={() => input.current?.click()}
          >
            <ImagePlus size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="cm-tool-btn"
            aria-label={t('community.attach')}
            aria-expanded={picking}
            onClick={togglePicker}
          >
            <Paperclip size={20} aria-hidden="true" />
          </button>

          <div className="cm-composer-right">
            {length > 0 && (
              <>
                <span className={`cm-ring-wrap${ringState}`} aria-label={`${length}/${MAX_LENGTH}`}>
                  {remaining <= 20 && <span>{remaining}</span>}
                  <svg className="cm-ring" viewBox="0 0 24 24" aria-hidden="true">
                    <circle className="cm-ring-track" cx="12" cy="12" r={RING_R} />
                    <circle
                      className="cm-ring-fill"
                      cx="12"
                      cy="12"
                      r={RING_R}
                      strokeDasharray={RING_C}
                      strokeDashoffset={dashOffset}
                    />
                  </svg>
                </span>
                <span className="cm-bar-sep" aria-hidden="true" />
              </>
            )}
            <button type="submit" className="cm-btn-primary" disabled={!canPost}>
              {busy ? t('community.posting') : t('community.post')}
            </button>
          </div>
        </div>

        {picking && options && (
          <ul className="cm-options">
            {streak !== null && (
              <li>
                <button type="button" onClick={() => attach({ type: 'nutrition_streak' }, t('community.attachStreak', { days: streak }))}>
                  <Flame size={16} aria-hidden="true" />
                  <span>{t('community.attachStreak', { days: streak })}</span>
                </button>
              </li>
            )}
            {options.workouts.map((workout) => (
              <li key={workout.workout_id}>
                <button type="button" onClick={() => attach({ type: 'workout', workout_id: workout.workout_id }, t('community.attachWorkout', { name: workout.name }))}>
                  <Dumbbell size={16} aria-hidden="true" />
                  <span>{t('community.attachWorkout', { name: workout.name })}</span>
                </button>
                {workout.prs.map((record) => {
                  const label = t('community.attachPr', { exercise: record.exercise_name, weight: record.weight_kg })
                  return (
                    <button key={record.exercise_id} type="button" className="is-record" onClick={() => attach({ type: 'pr', workout_id: workout.workout_id, exercise_id: record.exercise_id }, label)}>
                      <Trophy size={15} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  )
                })}
              </li>
            ))}
            {streak === null && options.workouts.length === 0 && (
              <li className="cm-options-empty">{t('community.noAttachables')}</li>
            )}
          </ul>
        )}

        {error && <p className="cm-error" role="alert">{error}</p>}
      </div>
    </form>
  )
}
