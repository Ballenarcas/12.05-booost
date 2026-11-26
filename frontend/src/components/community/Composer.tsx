import { ImagePlus, Paperclip, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPost, fetchAttachables } from '../../services/api'
import type { Attachables, CardRef } from '../../types/social'
import { describeError } from '../../utils/errors.js'
import { resizeImage } from '../../utils/resizeImage'
import { useT } from '../../i18n'

const MAX_LENGTH = 280
const MAX_PHOTOS = 4

type Photo = { blob: Blob; url: string }
type Attached = { ref: CardRef; label: string }

export default function Composer({ onPosted }: { onPosted: () => void }) {
  const t = useT()
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
      await createPost(body, attached?.ref ?? null, photos.map((photo) => photo.blob))
      photos.forEach((photo) => URL.revokeObjectURL(photo.url))
      setBody('')
      setPhotos([])
      setAttached(null)
      onPosted()
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(false)
    }
  }

  const streak = options && options.streak_days >= options.streak_to_share ? options.streak_days : null

  return (
    <form className="hifi-card cm-composer" onSubmit={submit} aria-label={t('community.composeLabel')}>
      <textarea
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={t('community.composePlaceholder')}
        aria-label={t('community.composeLabel')}
      />

      {photos.length > 0 && (
        <div className="cm-previews">
          {photos.map((photo, index) => (
            <span key={photo.url} className="cm-preview">
              <img src={photo.url} alt="" />
              <button type="button" aria-label={t('community.removePhoto', { n: index + 1 })} onClick={() => removePhoto(photo.url)}>
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {attached && (
        <p className="cm-attached">
          <span>{attached.label}</span>
          <button type="button" aria-label={t('community.removeCard')} onClick={() => setAttached(null)}>
            <X size={16} aria-hidden="true" />
          </button>
        </p>
      )}

      <div className="cm-actions">
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(event) => void addPhotos(event.target.files)}
        />
        <button type="button" className="cm-action" aria-label={t('community.addPhoto')} disabled={photos.length >= MAX_PHOTOS} onClick={() => input.current?.click()}>
          <ImagePlus size={20} aria-hidden="true" />
        </button>
        <button type="button" className="cm-action" aria-label={t('community.attach')} aria-expanded={picking} onClick={togglePicker}>
          <Paperclip size={20} aria-hidden="true" />
        </button>
        <span className={`cm-count${length > MAX_LENGTH ? ' is-over' : ''}`}>{length}/{MAX_LENGTH}</span>
        <button type="submit" className="hifi-pill" disabled={!canPost}>
          {busy ? t('community.posting') : t('community.post')}
        </button>
      </div>

      {picking && options && (
        <ul className="cm-options">
          {streak !== null && (
            <li>
              <button type="button" onClick={() => attach({ type: 'nutrition_streak' }, t('community.attachStreak', { days: streak }))}>
                {t('community.attachStreak', { days: streak })}
              </button>
            </li>
          )}
          {options.workouts.map((workout) => (
            <li key={workout.workout_id}>
              <button type="button" onClick={() => attach({ type: 'workout', workout_id: workout.workout_id }, t('community.attachWorkout', { name: workout.name }))}>
                {t('community.attachWorkout', { name: workout.name })}
              </button>
              {workout.prs.map((record) => {
                const label = t('community.attachPr', { exercise: record.exercise_name, weight: record.weight_kg })
                return (
                  <button key={record.exercise_id} type="button" className="is-record" onClick={() => attach({ type: 'pr', workout_id: workout.workout_id, exercise_id: record.exercise_id }, label)}>
                    {label}
                  </button>
                )
              })}
            </li>
          ))}
          {streak === null && options.workouts.length === 0 && <li className="hifi-muted">{t('community.noAttachables')}</li>}
        </ul>
      )}

      {error && <p className="cm-error" role="alert">{error}</p>}
    </form>
  )
}
