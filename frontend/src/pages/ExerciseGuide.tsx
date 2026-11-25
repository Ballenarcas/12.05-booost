import { Lightbulb, Pause, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { fetchExerciseById } from '../services/api'
import { describeError } from '../utils/errors.js'
import { useT } from '../i18n'
import '../styles/exercise-guide.css'
import MediaCredit from '../components/workout/MediaCredit'
import type { Exercise } from '../types'
import backIcon from '../assets/scan/back.svg'

function GuideList({ id, title, items, ordered = false }: { id: string; title: string; items?: string[]; ordered?: boolean }) {
  if (!items?.length) return null
  const List = ordered ? 'ol' : 'ul'
  return <section className="exercise-guide-section" aria-labelledby={id}>
    <h2 id={id} className="hifi-card-label">{title}</h2>
    <List className="exercise-guide-steps">{items.map((item) => <li key={item}>{item}</li>)}</List>
  </section>
}

// The catalog stores one paragraph; split it into numbered steps at sentence ends.
function toSteps(description?: string | null): string[] {
  return (description ?? '')
    .split(/(?<=\.)\s+/)
    .map((step) => step.trim())
    .filter((step) => step && !/^repeat for the desired/i.test(step))
}

function ExerciseGuide() {
  const t = useT()
  const navigate = useNavigate()
  const { id = '' } = useParams()
  const location = useLocation()
  const { replaceExerciseIndex, fromWorkout } = (location.state as { replaceExerciseIndex?: number; fromWorkout?: boolean } | null) ?? {}
  const [exercise, setExercise] = useState<Exercise | null>(null)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    let active = true
    fetchExerciseById(id)
      .then((data: Exercise) => { if (active) setExercise(data) })
      .catch((err) => { if (active) setError(describeError(err, t('guide.errorLoad'))) })
    return () => { active = false }
  }, [id, t])

  const still = exercise?.images?.find((url) => !url.endsWith('.gif'))
  const animation = exercise?.images?.find((url) => url.endsWith('.gif'))
  const shown = (playing ? animation : still) ?? animation
  const steps = toSteps(exercise?.description)
  const guide = exercise?.guide
  const chips = exercise ? [exercise.category, ...exercise.equipment, ...exercise.muscles_secondary.slice(0, 2)].filter(Boolean) : []

  function addToWorkout() {
    if (!exercise) return
    sessionStorage.setItem('booost_pending_exercise', JSON.stringify({
      id: exercise.id,
      name: exercise.name,
      category: exercise.category,
      equipment: exercise.equipment,
      images: still ? [still] : [],
      is_custom: exercise.is_custom,
      replaceExerciseIndex,
    }))
    navigate('/workouts/active')
  }

  return (
    <div className="screen hifi-screen hifi-theme exercise-guide-screen">
      <header className="exercise-guide-header">
        <button className="scan-back" type="button" onClick={() => navigate(-1)} aria-label={t('common.back')}>
          <img src={backIcon} alt="" width={36} height={37} />
        </button>
        <div>
          <h1 className="hifi-page-title">{exercise?.name ?? t('guide.title')}</h1>
          {exercise && <p className="hifi-caption">{exercise.muscles.join(' · ') || exercise.category} / {exercise.category}</p>}
        </div>
      </header>

      {error && <div className="card state-card" role="alert">{error}</div>}
      {!exercise && !error && <p className="visually-hidden" role="status">{t('guide.loading')}</p>}

      {exercise && <>
        <div className="exercise-guide-media">
          {shown
            ? <img src={shown} alt={t(shown === animation ? 'guide.altAnimated' : 'aw.imageAlt', { name: exercise.name })} />
            : <div className="exercise-image-placeholder" aria-hidden="true">+</div>}
          {animation && still && (
            <button className="hifi-pill exercise-guide-play" type="button" onClick={() => setPlaying((value) => !value)} aria-pressed={playing}>
              {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
              {playing ? t('aw.pause') : t('guide.play')}
            </button>
          )}
        </div>
        <MediaCredit />

        <ul className="exercise-guide-chips" aria-label={t('guide.details')}>
          {chips.map((chip) => <li key={chip}>{chip}</li>)}
        </ul>

        {!steps.length && !guide && <p className="exercise-guide-empty">{t('guide.none')}</p>}
        <GuideList id="guide-setup" title={t('guide.setup')} items={guide?.setup} />
        <GuideList id="guide-steps" title={t('guide.instructions')} items={steps} ordered />
        <GuideList id="guide-cues" title={t('guide.cues')} items={guide?.cues} />
        {guide?.breathing && <section className="exercise-guide-section" aria-labelledby="guide-breathing">
          <h2 id="guide-breathing" className="hifi-card-label">{t('guide.breathing')}</h2>
          <p>{guide.breathing}</p>
        </section>}
        <GuideList id="guide-mistakes" title={t('guide.mistakes')} items={guide?.mistakes} />

        {guide?.tip && <p className="exercise-guide-tip"><Lightbulb size={18} aria-hidden="true" /><span><strong>{t('guide.proTip')}</strong> {guide.tip}</span></p>}
        {guide?.safety && <p className="exercise-guide-safety">{guide.safety}</p>}

        {!fromWorkout && <button className="hifi-pill is-big exercise-guide-cta" type="button" onClick={addToWorkout}>
          {replaceExerciseIndex === undefined ? t('guide.addToWorkout') : t('guide.replaceWith')}
        </button>}
      </>}
    </div>
  )
}

export default ExerciseGuide
