import { ArrowLeft, Crown, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import {
  acceptAiWeeklyRoutine,
  generateAiWeeklyRoutine,
  getCurrentUser,
  isPremiumActive,
  modifyAiWeeklyRoutine,
  PREMIUM_UPDATED_EVENT,
} from '../services/api'
import type {
  EquipmentKey,
  ExperienceLevel,
  TrainingPhilosophy,
  Weekday,
  WeeklyRoutineDraft,
  WeeklyRoutineGenerateRequest,
} from '../types/workout'
import { describeError } from '../utils/errors.js'
import { usePageNavigate } from '../utils/usePageNavigate'
import { useT, type MessageKey } from '../i18n'
import '../styles/ai-weekly-routine.css'

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DURATIONS = [30, 45, 60, 75, 90] as const
const EXPERIENCE_LEVELS: ExperienceLevel[] = ['beginner', 'intermediate', 'advanced']
const PHILOSOPHIES: TrainingPhilosophy[] = ['heavy_duty', 'high_volume', 'powerbuilding', 'minimalist']
const PHILOSOPHY_GUIDES: Record<TrainingPhilosophy, MessageKey> = {
  heavy_duty: 'aiWeekly.philGuideHeavyDuty',
  high_volume: 'aiWeekly.philGuideHighVolume',
  powerbuilding: 'aiWeekly.philGuidePowerbuilding',
  minimalist: 'aiWeekly.philGuideMinimalist',
}
const EQUIPMENT_OPTIONS: EquipmentKey[] = [
  'full_gym',
  'barbell',
  'dumbbell',
  'machine',
  'cable',
  'bodyweight',
  'kettlebell',
  'bands',
]

const OBJECTIVE_PRESETS: Array<{ value: string; labelKey: MessageKey }> = [
  { value: 'Muscle gain', labelKey: 'aiWeekly.goal.hypertrophy' },
  { value: 'Strength', labelKey: 'aiWeekly.goal.strength' },
  { value: 'Fat loss', labelKey: 'aiWeekly.goal.fatLoss' },
  { value: 'Endurance', labelKey: 'aiWeekly.goal.endurance' },
]

function normalizeGoalValue(raw: string | null | undefined): string {
  const lower = (raw ?? '').toLowerCase()
  if (lower.includes('strength') || lower.includes('fuerza') || lower.includes('power')) return 'Strength'
  if (lower.includes('loss') || lower.includes('lose') || lower.includes('fat') || lower.includes('grasa')) return 'Fat loss'
  if (lower.includes('endurance') || lower.includes('resistencia')) return 'Endurance'
  return 'Muscle gain'
}

export default function AiWeeklyRoutine() {
  const t = useT()
  const navigate = usePageNavigate()
  const [isPremium, setIsPremium] = useState(() => isPremiumActive())

  const [days, setDays] = useState<Weekday[]>(['mon', 'wed', 'fri'])
  const [durationMinutes, setDurationMinutes] = useState<number>(60)
  const [equipment, setEquipment] = useState<EquipmentKey[]>(['full_gym'])
  const [objective, setObjective] = useState<string>(() => normalizeGoalValue(getCurrentUser()?.objective))
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevel>('intermediate')
  const [trainingPhilosophy, setTrainingPhilosophy] = useState<TrainingPhilosophy | null>(null)
  const [showPhilosophyGuide, setShowPhilosophyGuide] = useState(false)
  const [notes, setNotes] = useState('')

  const [draft, setDraft] = useState<WeeklyRoutineDraft | null>(null)
  const [feedback, setFeedback] = useState('')
  const [feedbackHistory, setFeedbackHistory] = useState<string[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [isModifying, setIsModifying] = useState(false)
  const [isAccepting, setIsAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const syncPremium = () => setIsPremium(isPremiumActive())
    window.addEventListener(PREMIUM_UPDATED_EVENT, syncPremium)
    window.addEventListener('storage', syncPremium)
    return () => {
      window.removeEventListener(PREMIUM_UPDATED_EVENT, syncPremium)
      window.removeEventListener('storage', syncPremium)
    }
  }, [])

  function toggleDay(day: Weekday) {
    setError(null)
    setDays((current) => {
      if (current.includes(day)) return current.filter((item) => item !== day)
      const next = [...current, day]
      return WEEKDAYS.filter((item) => next.includes(item))
    })
  }

  function toggleEquipment(item: EquipmentKey) {
    setError(null)
    setEquipment((current) => {
      if (item === 'full_gym') return current.includes('full_gym') ? [] : ['full_gym']
      const withoutFull = current.filter((entry) => entry !== 'full_gym')
      return withoutFull.includes(item)
        ? withoutFull.filter((entry) => entry !== item)
        : [...withoutFull, item]
    })
  }

  function buildPreferences(): WeeklyRoutineGenerateRequest {
    return {
      days,
      duration_minutes: durationMinutes,
      equipment,
      objective,
      experience_level: experienceLevel,
      training_philosophy: trainingPhilosophy,
      notes: notes.trim() || null,
    }
  }

  async function handleGenerate(event: FormEvent) {
    event.preventDefault()
    if (days.length === 0) {
      setError(t('aiWeekly.errorSelectDay'))
      return
    }
    if (equipment.length === 0) {
      setError(t('aiWeekly.errorSelectEquipment'))
      return
    }
    setError(null)
    setIsGenerating(true)
    try {
      const created = await generateAiWeeklyRoutine(buildPreferences())
      setDraft(created)
      setFeedback('')
      setFeedbackHistory([])
    } catch (err) {
      setError(describeError(err, t('aiWeekly.errorGeneric')))
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleModify(event?: FormEvent) {
    event?.preventDefault()
    if (!draft) return
    const trimmed = feedback.trim()
    if (!trimmed) {
      setError(t('aiWeekly.errorFeedback'))
      return
    }
    setError(null)
    setIsModifying(true)
    try {
      const updated = await modifyAiWeeklyRoutine({
        preferences: buildPreferences(),
        current_draft: draft,
        feedback: trimmed,
        feedback_history: feedbackHistory,
      })
      setDraft(updated)
      setFeedbackHistory((prev) => [...prev, trimmed].slice(-10))
      setFeedback('')
    } catch (err) {
      setError(describeError(err, t('aiWeekly.errorGeneric')))
    } finally {
      setIsModifying(false)
    }
  }

  async function handleAccept() {
    if (!draft) return
    setError(null)
    setIsAccepting(true)
    try {
      await acceptAiWeeklyRoutine(draft.days)
      navigate('/workouts')
    } catch (err) {
      setError(describeError(err, t('aiWeekly.errorGeneric')))
    } finally {
      setIsAccepting(false)
    }
  }

  function handleDismiss() {
    setDraft(null)
    setFeedback('')
    setFeedbackHistory([])
    navigate('/workouts')
  }

  const busy = isGenerating || isModifying || isAccepting

  return (
    <div className="screen hifi-screen ai-weekly-screen">
      <button className="ai-weekly-back" type="button" onClick={() => navigate('/workouts')}>
        <ArrowLeft size={16} aria-hidden="true" />
        <span>{t('aiWeekly.backWorkouts')}</span>
      </button>

      <header className="hifi-page-header">
        <div>
          <p className="eyebrow">{t('aiWeekly.eyebrow')}</p>
          <h1 className="hifi-page-title">{t('aiWeekly.title')}</h1>
          <p className="hifi-muted">{t('aiWeekly.subtitle')}</p>
        </div>
      </header>

      {!isPremium ? (
        <section className="hifi-card ai-weekly-gate" aria-label={t('aiWeekly.lockedTitle')}>
          <span className="ai-weekly-gate-badge">
            <Crown size={14} aria-hidden="true" />
            <span>{t('workouts.aiWeeklyPremiumTag')}</span>
          </span>
          <h2>{t('aiWeekly.lockedTitle')}</h2>
          <p className="hifi-muted">{t('aiWeekly.lockedBody')}</p>
          <div>
            <button
              className="primary-button"
              type="button"
              onClick={() => navigate('/premium', { state: { from: '/workouts/ai-weekly' } })}
            >
              {t('aiWeekly.unlock')}
            </button>
          </div>
        </section>
      ) : !draft ? (
        <form className="hifi-card ai-weekly-form" onSubmit={handleGenerate}>
          <div className="ai-weekly-group">
            <span className="ai-weekly-label">{t('aiWeekly.daysLabel')}</span>
            <div className="ai-weekly-chips">
              {WEEKDAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  className="ai-weekly-chip"
                  aria-pressed={days.includes(day)}
                  onClick={() => toggleDay(day)}
                  disabled={busy}
                >
                  {t(`aiWeekly.day.${day}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="ai-weekly-group">
            <span className="ai-weekly-label">{t('aiWeekly.durationLabel')}</span>
            <div className="ai-weekly-chips">
              {DURATIONS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className="ai-weekly-chip"
                  aria-pressed={durationMinutes === minutes}
                  onClick={() => setDurationMinutes(minutes)}
                  disabled={busy}
                >
                  {t('aiWeekly.durationOption', { minutes })}
                </button>
              ))}
            </div>
          </div>

          <div className="ai-weekly-group">
            <span className="ai-weekly-label">{t('aiWeekly.equipmentLabel')}</span>
            <div className="ai-weekly-chips">
              {EQUIPMENT_OPTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="ai-weekly-chip"
                  aria-pressed={equipment.includes(item)}
                  onClick={() => toggleEquipment(item)}
                  disabled={busy}
                >
                  {t(`aiWeekly.equip.${item}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="ai-weekly-group">
            <span className="ai-weekly-label">{t('aiWeekly.objectiveLabel')}</span>
            <div className="ai-weekly-chips">
              {OBJECTIVE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className="ai-weekly-chip"
                  aria-pressed={objective === preset.value}
                  onClick={() => setObjective(preset.value)}
                  disabled={busy}
                >
                  {t(preset.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="ai-weekly-group">
            <span className="ai-weekly-label">{t('aiWeekly.levelLabel')}</span>
            <div className="ai-weekly-chips">
              {EXPERIENCE_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className="ai-weekly-chip"
                  aria-pressed={experienceLevel === level}
                  onClick={() => setExperienceLevel(level)}
                  disabled={busy}
                >
                  {t(`aiWeekly.level.${level}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="ai-weekly-group">
            <div className="ai-weekly-label-row">
              <span className="ai-weekly-label">{t('aiWeekly.philosophyLabel')}</span>
              <button
                type="button"
                className="ai-weekly-help-button"
                aria-expanded={showPhilosophyGuide}
                aria-controls="philosophy-guide-panel"
                aria-label={t('aiWeekly.philosophyToggle')}
                title={t('aiWeekly.philosophyToggle')}
                onClick={() => setShowPhilosophyGuide((open) => !open)}
                disabled={busy}
              >
                ?
              </button>
            </div>
            {showPhilosophyGuide && (
              <div id="philosophy-guide-panel" className="ai-weekly-guide" role="region" aria-label={t('aiWeekly.philGuideTitle')}>
                <p className="ai-weekly-guide-intro">{t('aiWeekly.philGuideIntro')}</p>
                {PHILOSOPHIES.map((phil) => (
                  <div className="ai-weekly-guide-row" key={phil}>
                    <span className="ai-weekly-guide-name">{t(`aiWeekly.philosophy.${phil}`)}</span>
                    <span>{t(PHILOSOPHY_GUIDES[phil])}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="ai-weekly-chips">
              {PHILOSOPHIES.map((phil) => (
                <button
                  key={phil}
                  type="button"
                  className="ai-weekly-chip"
                  aria-pressed={trainingPhilosophy === phil}
                  onClick={() => setTrainingPhilosophy((current) => (current === phil ? null : phil))}
                  disabled={busy}
                >
                  {t(`aiWeekly.philosophy.${phil}`)}
                </button>
              ))}
            </div>
          </div>

          <label className="ai-weekly-group">
            <span className="ai-weekly-label">{t('aiWeekly.notesLabel')}</span>
            <textarea
              className="ai-weekly-textarea"
              maxLength={400}
              placeholder={t('aiWeekly.notesPlaceholder')}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={busy}
            />
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}

          <button className="primary-button" type="submit" disabled={busy}>
            {isGenerating ? (
              <>
                <Loader2 size={16} className="spin" aria-hidden="true" />
                <span>{t('aiWeekly.generating')}</span>
              </>
            ) : (
              <>
                <Sparkles size={16} aria-hidden="true" />
                <span>{t('aiWeekly.generate')}</span>
              </>
            )}
          </button>
        </form>
      ) : (
        <>
          <section className="hifi-card ai-weekly-overview" aria-label={draft.plan_title}>
            <div className="ai-weekly-overview-head">
              <h2>{draft.plan_title}</h2>
              <div className="ai-weekly-meta-tags">
                <span className="ai-weekly-split-tag">{draft.split_name}</span>
                {draft.experience_level && (
                  <span className="ai-weekly-split-tag">{t(`aiWeekly.level.${draft.experience_level}`)}</span>
                )}
                {draft.training_philosophy && (
                  <span className="ai-weekly-split-tag">{t(`aiWeekly.philosophy.${draft.training_philosophy}`)}</span>
                )}
              </div>
            </div>
            <p className="hifi-muted">{draft.summary}</p>
            {draft.change_summary && (
              <p className="ai-weekly-change-note" role="status">
                {t('aiWeekly.adaptedBanner', { summary: draft.change_summary })}
              </p>
            )}
          </section>

          <section className="ai-weekly-days" aria-label={draft.split_name}>
            {draft.days.map((dayPlan) => (
              <article className="hifi-card ai-weekly-day-card" key={dayPlan.day}>
                <div className="ai-weekly-day-header">
                  <h3>{dayPlan.routine_name}</h3>
                  <span className="ai-weekly-day-meta">
                    {t('aiWeekly.durationOption', { minutes: dayPlan.estimated_duration_minutes })}
                  </span>
                </div>
                <ul className="ai-weekly-ex-list">
                  {dayPlan.exercises.map((exercise) => (
                    <li className="ai-weekly-ex-row" key={`${dayPlan.day}-${exercise.exercise_id}`}>
                      <span className="ai-weekly-ex-name">
                        <span>{exercise.name}</span>
                        <span className="ai-weekly-ex-sub">
                          {exercise.muscle_group}{exercise.equipment.length > 0 ? ` · ${exercise.equipment.join(', ')}` : ''}
                        </span>
                      </span>
                      <span className="ai-weekly-ex-rx">{exercise.target_sets}×{exercise.target_reps}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>

          <form className="hifi-card ai-weekly-feedback-card" onSubmit={handleModify}>
            <label className="ai-weekly-group">
              <span className="ai-weekly-label">{t('aiWeekly.modifyLabel')}</span>
              <textarea
                className="ai-weekly-textarea"
                maxLength={500}
                placeholder={t('aiWeekly.modifyPlaceholder')}
                value={feedback}
                onChange={(event) => { setFeedback(event.target.value); setError(null) }}
                disabled={busy}
              />
            </label>
            <div className="ai-weekly-quick-prompts">
              <button type="button" className="ai-weekly-quick-chip" onClick={() => setFeedback(t('aiWeekly.quickSwapBench'))} disabled={busy}>
                {t('aiWeekly.quickSwapBench')}
              </button>
              <button type="button" className="ai-weekly-quick-chip" onClick={() => setFeedback(t('aiWeekly.quickBackFocus'))} disabled={busy}>
                {t('aiWeekly.quickBackFocus')}
              </button>
              <button type="button" className="ai-weekly-quick-chip" onClick={() => setFeedback(t('aiWeekly.quickLessVolume'))} disabled={busy}>
                {t('aiWeekly.quickLessVolume')}
              </button>
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="secondary-action" type="submit" disabled={busy}>
              {isModifying ? t('aiWeekly.modifying') : t('aiWeekly.modify')}
            </button>
          </form>

          <div className="ai-weekly-actions">
            <div className="ai-weekly-actions-left">
              <button className="hifi-link-button" type="button" onClick={() => setDraft(null)} disabled={busy}>
                {t('aiWeekly.editPrefs')}
              </button>
              <button className="danger-action" type="button" onClick={handleDismiss} disabled={busy}>
                {t('aiWeekly.dismiss')}
              </button>
            </div>
            <button className="primary-button" type="button" onClick={handleAccept} disabled={busy}>
              {isAccepting ? t('aiWeekly.accepting') : t('aiWeekly.accept')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
