import { resizeImage } from '../utils/resizeImage'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Flame,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  addMealLog,
  getCurrentUser,
  scanMealPhoto,
  type MealScanItem,
} from '../services/api'
import { describeError } from '../utils/errors.js'
import backIcon from '../assets/scan/back.svg'
import importIcon from '../assets/scan/import.svg'
import frameImage from '../assets/scan/frame.svg'
import shutterImage from '../assets/scan/shutter.svg'
import { locale, t as tr, useT } from '../i18n'
import '../styles/scan-meal.css'
import Collapse from '../components/ui/Collapse'

type ScanPhase = 'idle' | 'analyzing' | 'results' | 'saving' | 'error'

interface EditableItem {
  key: string
  name: string
  grams: string
  calories: string
  protein: string
  carbs: string
  fat: string
}

function itemKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `item-${Date.now()}-${Math.random()}`
}

function numberValue(value: string): number {
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : 0
}

function editableItem(item: MealScanItem): EditableItem {
  return {
    key: itemKey(),
    name: item.name,
    grams: String(item.grams),
    calories: String(item.calories),
    protein: String(item.protein_g),
    carbs: String(item.carbs_g),
    fat: String(item.fat_g),
  }
}

function per100(total: number, grams: number, maximum: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(grams) || grams <= 0) return 0
  return Math.max(0, Math.min(maximum, Math.round(((total / grams) * 100) * 10) / 10))
}

function todayLabel(): string {
  return new Date().toLocaleDateString(locale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export default function ScanMeal() {
  const t = useT()
  const navigate = useNavigate()
  const user = getCurrentUser()
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const imageUrlRef = useRef<string | null>(null)

  const [phase, setPhase] = useState<ScanPhase>('idle')
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageBlob, setImageBlob] = useState<Blob | null>(null)
  const [items, setItems] = useState<EditableItem[]>([])
  const [mealName, setMealName] = useState(() => tr('scan.defaultName'))
  const [notes, setNotes] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [camera, setCamera] = useState<'starting' | 'live' | 'unavailable'>(() =>
    typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'starting' : 'unavailable')

  // Live viewfinder while choosing a photo. Without camera access (refused, no camera, an old
  // WebView) the shutter falls back to the phone's own camera through the file input.
  useEffect(() => {
    if (phase !== 'idle') return
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return
    let stream: MediaStream | null = null
    let cancelled = false
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((next) => {
        if (cancelled) {
          next.getTracks().forEach((track) => track.stop())
          return
        }
        stream = next
        // The device's background blur follows faces and smears the food; turn it off where the camera lets us.
        const [track] = next.getVideoTracks()
        const blurOptions = (track?.getCapabilities?.() as { backgroundBlur?: boolean[] } | undefined)?.backgroundBlur
        if (blurOptions?.includes(false)) {
          track.applyConstraints({ advanced: [{ backgroundBlur: false } as MediaTrackConstraintSet] }).catch(() => {})
        }
        if (videoRef.current) videoRef.current.srcObject = next
        setCamera('live')
      })
      .catch(() => { if (!cancelled) setCamera('unavailable') })
    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
      // Back to idle later starts the camera again.
      setCamera('starting')
    }
  }, [phase])

  useEffect(() => () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
  }, [])

  const totalCalories = useMemo(
    () => Math.round(items.reduce((sum, item) => sum + numberValue(item.calories), 0)),
    [items],
  )
  const canSave = items.length > 0 && items.every((item) => (
    item.name.trim().length > 0
    && numberValue(item.grams) > 0
    && numberValue(item.calories) >= 0
  ))

  const setPreview = (blob: Blob) => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
    const url = URL.createObjectURL(blob)
    imageUrlRef.current = url
    setImageUrl(url)
  }

  const analyze = async (blob: Blob) => {
    setPhase('analyzing')
    setError(null)
    setItems([])
    setNotes(null)
    try {
      const result = await scanMealPhoto(blob)
      const detected = result.items.map(editableItem)
      const suggestedName = result.items.slice(0, 2).map((item) => item.name).join(' + ')
      setItems(detected)
      setNotes(result.notes)
      setMealName((suggestedName || t('scan.defaultName')).slice(0, 120))
      setPhase('results')
    } catch (err) {
      setError(describeError(err, t('scan.errorAnalyze')))
      setPhase('error')
    }
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (file.type && !file.type.startsWith('image/')) {
      setError(t('scan.errorNotPhoto'))
      setPhase('idle')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError(t('scan.errorTooLarge'))
      setPhase('idle')
      return
    }
    setPhase('analyzing')
    try {
      const blob = await resizeImage(file, tr('scan.errorRead'), tr('scan.errorPrepare'))
      if (blob.size > 8 * 1024 * 1024) {
        throw new Error(t('scan.errorStillLarge'))
      }
      setImageBlob(blob)
      setPreview(blob)
      await analyze(blob)
    } catch (err) {
      setError(describeError(err, t('scan.errorReadOther')))
      setPhase('error')
    }
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    void handleFile(file)
  }

  const takePhoto = () => {
    const video = videoRef.current
    if (camera !== 'live' || !video?.videoWidth) {
      cameraInputRef.current?.click()
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (blob) void handleFile(new File([blob], 'meal.jpg', { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.9)
  }

  const handleRetake = () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
    imageUrlRef.current = null
    setImageUrl(null)
    setImageBlob(null)
    setItems([])
    setNotes(null)
    setError(null)
    setExpandedKey(null)
    setPhase('idle')
  }

  const handleTryAgain = () => {
    if (imageBlob) void analyze(imageBlob)
  }

  const updateItem = (key: string, field: keyof Omit<EditableItem, 'key'>, value: string) => {
    setItems((current) => current.map((item) => (
      item.key === key ? { ...item, [field]: value } : item
    )))
  }

  const stepGrams = (item: EditableItem, delta: number) => {
    const next = Math.max(1, Math.min(5000, Math.round(numberValue(item.grams) + delta)))
    updateItem(item.key, 'grams', String(next))
  }

  const addItem = () => {
    const key = itemKey()
    setItems((current) => [
      ...current,
      { key, name: t('scan.newItem'), grams: '100', calories: '0', protein: '0', carbs: '0', fat: '0' },
    ])
    setExpandedKey(key)
  }

  const removeItem = (key: string) => {
    setItems((current) => current.filter((item) => item.key !== key))
  }

  const handleConfirm = async () => {
    if (!user?.id) {
      setError(t('scan.errorSignIn'))
      return
    }
    if (!canSave) {
      setError(t('scan.errorNoItems'))
      return
    }
    setPhase('saving')
    setError(null)
    try {
      const ingredients = items.map((item) => {
        const grams = Math.max(0.1, Math.min(10000, numberValue(item.grams)))
        const calories = Math.max(0, numberValue(item.calories))
        const protein = Math.max(0, numberValue(item.protein))
        const carbs = Math.max(0, numberValue(item.carbs))
        const fat = Math.max(0, numberValue(item.fat))
        return {
          name: item.name.trim().slice(0, 120),
          quantity_g: Math.round(grams * 10) / 10,
          calories_per_100g: per100(calories, grams, 1000),
          proteins_per_100g: per100(protein, grams, 100),
          carbs_per_100g: per100(carbs, grams, 100),
          fats_per_100g: per100(fat, grams, 100),
        }
      })
      await addMealLog({
        user_id: user.id,
        name: mealName.trim().slice(0, 120) || t('scan.defaultName'),
        ingredients,
      })
      navigate('/nutrition', { replace: true })
    } catch (err) {
      setError(describeError(err, t('add.errorSave')))
      setPhase('results')
    }
  }

  const showPreview = Boolean(imageUrl) && phase !== 'idle'

  return (
    <div className="screen hifi-theme scan-screen">
      <header className="scan-header">
        <button className="scan-back" type="button" onClick={() => navigate(-1)} aria-label={t('common.back')}>
          <img src={backIcon} alt="" width={36} height={37} />
        </button>
        <div className="scan-title-row">
          <h1>{phase === 'results' || phase === 'saving' ? t('scan.results') : t('add.scan')}</h1>
          {phase === 'idle' ? (
            <button className="scan-import" type="button" onClick={() => galleryInputRef.current?.click()}>
              <img src={importIcon} alt="" width={43.2143} height={43.2143} />
              <span>{t('scan.import')}</span>
            </button>
          ) : (
            <span className="scan-date">{todayLabel()}</span>
          )}
        </div>
      </header>

      {phase === 'idle' && (
        <section className="scan-capture" aria-labelledby="scan-capture-title">
          <div className="scan-viewfinder" data-camera={camera}>
            <video ref={videoRef} className="scan-video" autoPlay playsInline muted aria-hidden="true" />
            <img className="scan-frame" src={frameImage} alt="" width={286} height={445} />
            <div className="scan-viewfinder-copy">
              <h2 id="scan-capture-title">{t('scan.takePhoto')}</h2>
              <p>{camera === 'unavailable' ? t('scan.tapToOpen') : t('scan.capture')}</p>
            </div>
          </div>
          <button className="scan-shutter" type="button" onClick={takePhoto} aria-label={t('scan.takePhoto')}>
            <img src={shutterImage} alt="" width={79} height={79} />
          </button>
          <p className="scan-privacy">{t('scan.privacy')}</p>
          {error && <p className="scan-error" role="alert">{error}</p>}
        </section>
      )}

      {phase === 'error' && !imageUrl && (
        <section className="scan-capture" aria-label={t('scan.photoError')}>
          <div className="scan-error-card" role="alert">
            <p>{error}</p>
            <div className="scan-error-actions">
              <button type="button" className="scan-secondary" onClick={handleRetake}>
                {t('scan.chooseAnother')}
              </button>
            </div>
          </div>
        </section>
      )}

      {showPreview && (
        <section className="scan-preview" aria-label={t('scan.preview')}>
          <div className="scan-photo" data-scanning={phase === 'analyzing'}>
            <img src={imageUrl ?? ''} alt={t('scan.photoAlt')} className="scan-image" />
          </div>
          <button type="button" className="scan-retake" onClick={handleRetake}>
            <RotateCcw size={16} aria-hidden="true" /> {t('scan.retake')}
          </button>
          {phase === 'analyzing' && (
            <div className="scan-loading" role="status">
              <Loader2 size={22} className="animate-spin" aria-hidden="true" />
              <div>
                <strong>{t('scan.analyzing')}</strong>
                <span>{t('scan.fewSeconds')}</span>
              </div>
            </div>
          )}
          {phase === 'error' && (
            <div className="scan-error-card" role="alert">
              <p>{error}</p>
              <div className="scan-error-actions">
                {imageBlob && (
                  <button type="button" className="scan-secondary" onClick={handleTryAgain}>
                    <Sparkles size={16} aria-hidden="true" /> {t('common.retry')}
                  </button>
                )}
                <button type="button" className="scan-secondary" onClick={handleRetake}>
                  {t('scan.chooseAnother')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {(phase === 'results' || phase === 'saving') && (
        <>
          <section className="scan-name-card" aria-labelledby="scan-name-label">
            <label id="scan-name-label" htmlFor="scan-meal-name">{t('scan.mealName')}</label>
            <input
              id="scan-meal-name"
              value={mealName}
              maxLength={120}
              onChange={(event) => setMealName(event.target.value)}
            />
          </section>

          {notes && <p className="scan-notes"><Sparkles size={15} aria-hidden="true" /> {notes}</p>}

          <section className="scan-detected" aria-labelledby="scan-detected-title">
            <div className="scan-section-heading">
              <h2 id="scan-detected-title">{t('scan.detected')}</h2>
              <span>{t('scan.tapToEdit')}</span>
            </div>
            <div className="scan-items">
              {items.map((item) => {
                const expanded = expandedKey === item.key
                return (
                  <article className="scan-item" key={item.key}>
                    <div className="scan-item-top">
                      <input
                        className="scan-item-name"
                        value={item.name}
                        maxLength={120}
                        aria-label={t('scan.nameFor', { name: item.name || t('scan.item') })}
                        onChange={(event) => updateItem(item.key, 'name', event.target.value)}
                      />
                      <button
                        type="button"
                        className="scan-remove"
                        onClick={() => removeItem(item.key)}
                        aria-label={t('hydration.removeAria', { label: item.name || t('scan.item') })}
                      >
                        <Trash2 size={17} aria-hidden="true" />
                      </button>
                    </div>
                    <div className="scan-item-controls">
                      <div className="scan-stepper">
                        <button type="button" onClick={() => stepGrams(item, -10)} aria-label={t('scan.decrease', { name: item.name })}>
                          <Minus size={15} aria-hidden="true" />
                        </button>
                        <input
                          type="number"
                          min="1"
                          max="5000"
                          value={item.grams}
                          aria-label={t('meals.ingredientQuantity', { name: item.name })}
                          onChange={(event) => updateItem(item.key, 'grams', event.target.value)}
                        />
                        <span>g</span>
                        <button type="button" onClick={() => stepGrams(item, 10)} aria-label={t('scan.increase', { name: item.name })}>
                          <Plus size={15} aria-hidden="true" />
                        </button>
                      </div>
                      <label className="scan-calories">
                        <input
                          type="number"
                          min="0"
                          max="10000"
                          value={item.calories}
                          aria-label={t('scan.calories', { name: item.name })}
                          onChange={(event) => updateItem(item.key, 'calories', event.target.value)}
                        />
                        <span>kcal</span>
                      </label>
                    </div>
                    <button
                      type="button"
                      className="scan-macros-toggle"
                      onClick={() => setExpandedKey(expanded ? null : item.key)}
                      aria-expanded={expanded}
                    >
                      {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                      {t('scan.macros')}
                    </button>
                    <Collapse open={expanded}>
                      <div className="scan-macros">
                        <label>{t('scan.proteinG')}<input type="number" min="0" value={item.protein} onChange={(event) => updateItem(item.key, 'protein', event.target.value)} /></label>
                        <label>{t('scan.carbsG')}<input type="number" min="0" value={item.carbs} onChange={(event) => updateItem(item.key, 'carbs', event.target.value)} /></label>
                        <label>{t('scan.fatG')}<input type="number" min="0" value={item.fat} onChange={(event) => updateItem(item.key, 'fat', event.target.value)} /></label>
                      </div>
                    </Collapse>
                  </article>
                )
              })}
            </div>
            <button type="button" className="scan-add" onClick={addItem}>
              <Plus size={17} aria-hidden="true" /> {t('scan.addItem')}
            </button>
          </section>

          <div className="scan-total">
            <span><Flame size={17} aria-hidden="true" /> {t('scan.total')}</span>
            <strong>{totalCalories} kcal</strong>
          </div>

          {error && <p className="scan-error" role="alert">{error}</p>}

          <button
            type="button"
            className="scan-confirm"
            onClick={handleConfirm}
            disabled={phase === 'saving' || !canSave}
          >
            {phase === 'saving'
              ? <><Loader2 size={19} className="animate-spin" aria-hidden="true" /> {t('scan.logging')}</>
              : <><Check size={20} aria-hidden="true" /> {t('scan.confirm')}</>}
          </button>
        </>
      )}

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="scan-file-input"
        onChange={handleFileChange}
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="scan-file-input"
        onChange={handleFileChange}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  )
}
