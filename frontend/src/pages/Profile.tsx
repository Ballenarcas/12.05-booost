import { useEffect, useRef, useState } from 'react'
import { usePageNavigate } from '../utils/usePageNavigate'
import { AlertCircle, CheckCircle2, ChevronRight, Loader2, LogOut, Minus, Plus } from 'lucide-react'
import {
  cancelPremium,
  clearSession,
  fetchWorkoutStatistics,
  getCurrentUser,
  getSavedWorkoutStatistics,
  isPremiumActive,
  updateUserSettings,
} from '../services/api'
import { describeError } from '../utils/errors.js'
import { MAX_BODY_WEIGHT_KG, MIN_BODY_WEIGHT_KG } from '../utils/bodyLimits'
import { useDialogBehavior } from '../utils/useDialogBehavior'
import { applyTheme, getTheme } from '../utils/theme'
import type { WorkoutStatistics } from '../types/workout'
import { formatWorkoutCount } from '../utils/workoutStatistics'
import { BODY_COMPOSITION_PREVIEW, PROFILE_FRIENDS_PREVIEW } from '../data/profileMockups'
import LiquidToggle from '../components/ui/LiquidToggle'
import LanguageSwitch from '../components/ui/LanguageSwitch'
import { locale, useT, valueLabel } from '../i18n'
import HealthConnectCard from '../components/profile/HealthConnectCard'
import '../styles/profile.css'

type Notice = { kind: 'success' | 'error'; text: string }

const GOALS = ['Hypertrophy', 'Strength', 'Endurance', 'Lose Weight', 'Maintenance']

function splitWeight(raw: string): { whole: string; decimal: string } {
  const num = Number(raw)
  if (!raw.trim() || !Number.isFinite(num)) return { whole: '–', decimal: '' }
  const fixed = num.toFixed(1)
  const [whole, dec] = fixed.split('.')
  return { whole, decimal: dec && dec !== '0' ? `.${dec}` : '' }
}

function formatProgressHours(seconds: number): { value: string; unit: string } {
  if (!Number.isFinite(seconds) || seconds <= 0) return { value: '0', unit: 'h' }
  const hours = seconds / 3600
  if (hours < 1) return { value: String(Math.max(1, Math.round(seconds / 60))), unit: 'm' }
  return { value: String(Math.round(hours)), unit: 'h' }
}

function Profile() {
  const t = useT()
  const user = getCurrentUser()
  const navigate = usePageNavigate()
  const [isDark, setIsDark] = useState(getTheme() === 'dark')
  const toggleDark = (dark: boolean) => { setIsDark(dark); applyTheme(dark ? 'dark' : 'light') }

  const [age, setAge] = useState(user?.age?.toString() || '')
  const [weight, setWeight] = useState(user?.weight?.toString() || '')
  const [height, setHeight] = useState(user?.height?.toString() || '')
  const [gender, setGender] = useState(user?.gender || 'Male')
  // Sign-up saves "Lose Weight" and older profiles saved "Weight Loss": both mean the same goal.
  const [objective, setObjective] = useState<string>((user?.objective as string) === 'Weight Loss' ? 'Lose Weight' : user?.objective || 'Hypertrophy')
  const [saved, setSaved] = useState({ age, weight, height, gender, objective })
  const [goalPickerOpen, setGoalPickerOpen] = useState(false)
  const [isEditingWeight, setIsEditingWeight] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [quickNotice, setQuickNotice] = useState<Notice | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isLogoutOpen, setIsLogoutOpen] = useState(false)
  const [isCancelOpen, setIsCancelOpen] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [isCancelled, setIsCancelled] = useState(Boolean(user?.premium_cancel_at_period_end))
  const [cancelError, setCancelError] = useState<string | null>(null)

  const [workoutStats, setWorkoutStats] = useState<WorkoutStatistics | null>(() => (
    user?.id ? getSavedWorkoutStatistics(user.id, '3M') : null
  ))

  const cancelDialogRef = useDialogBehavior(isCancelOpen, () => setIsCancelOpen(false))
  const logoutDialogRef = useDialogBehavior(isLogoutOpen, () => setIsLogoutOpen(false))
  const settingsSectionRef = useRef<HTMLElement | null>(null)
  const subscriptionSectionRef = useRef<HTMLElement | null>(null)
  const heightInputRef = useRef<HTMLInputElement | null>(null)
  const weightInputRef = useRef<HTMLInputElement | null>(null)
  const weightBeforeEditRef = useRef<string>(weight)

  // "Jan 10, 2026" rather than 10/1/2026, which reads differently by region.
  const formatDay = (value: string) => new Date(value).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' })
  const premiumEndDate = user?.premium_expires_at ? formatDay(user.premium_expires_at) : null
  const premiumStartDate = user?.premium_started_at ? formatDay(user.premium_started_at) : null
  const premiumPlanLabel = user?.premium_plan === 'annual' ? t('profile.planAnnual') : user?.premium_plan === 'monthly' ? t('profile.planMonthly') : null

  useEffect(() => {
    if (!user?.id) return
    const controller = new AbortController()
    fetchWorkoutStatistics(user.id, '3M', controller.signal)
      .then((stats) => setWorkoutStats(stats))
      .catch(() => undefined)
    return () => controller.abort()
  }, [user?.id])

  useEffect(() => {
    if (!isEditingWeight) return
    const input = weightInputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [isEditingWeight])

  const confirmCancelPremium = async () => {
    setIsCancelling(true)
    setCancelError(null)
    try {
      await cancelPremium()
      setIsCancelled(true)
      setIsCancelOpen(false)
    } catch (error) {
      setCancelError(describeError(error, t('profile.errorCancel')))
    } finally {
      setIsCancelling(false)
    }
  }

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.kind === 'success' ? 5000 : 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!quickNotice) return
    const timer = window.setTimeout(() => setQuickNotice(null), quickNotice.kind === 'success' ? 4000 : 7000)
    return () => window.clearTimeout(timer)
  }, [quickNotice])

  const saveProfileChanges = async (fromQuickCard = false) => {
    const ageValue = Number(age)
    const weightValue = Number(weight)
    const heightValue = Number(height)

    const reportError = (text: string) => {
      const next: Notice = { kind: 'error', text }
      setNotice(next)
      if (fromQuickCard) setQuickNotice(next)
    }

    if (!age.trim() || !weight.trim() || !height.trim() || !gender.trim() || !objective.trim()) {
      reportError(t('profile.errorFillAll'))
      return
    }
    if (!Number.isInteger(ageValue) || ageValue < 12 || ageValue > 120) {
      reportError(t('profile.errorAge'))
      return
    }
    if (!Number.isFinite(weightValue) || weightValue < MIN_BODY_WEIGHT_KG || weightValue > MAX_BODY_WEIGHT_KG) {
      reportError(t('profile.errorWeight', { min: MIN_BODY_WEIGHT_KG, max: MAX_BODY_WEIGHT_KG }))
      return
    }
    if (!Number.isInteger(heightValue) || heightValue < 80 || heightValue > 250) {
      reportError(t('profile.errorHeight'))
      return
    }

    setIsSaving(true)
    setNotice(null)
    setQuickNotice(null)
    try {
      if (!user?.id) throw new Error(t('profile.errorNoProfile'))
      await updateUserSettings(user.id, {
        age: ageValue,
        weight: weightValue,
        height: heightValue,
        gender,
        objective,
      })
      setSaved({ age, weight, height, gender, objective })
      setGoalPickerOpen(false)
      const successMsg: Notice = {
        kind: 'success',
        text: t('profile.saved'),
      }
      setNotice(successMsg)
      if (fromQuickCard) {
        setQuickNotice({ kind: 'success', text: t('profile.savedQuick') })
      }
    } catch (error) {
      reportError(describeError(error, t('profile.errorSave')))
    } finally {
      setIsSaving(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    await saveProfileChanges(false)
  }

  const startWeightEdit = () => {
    weightBeforeEditRef.current = weight
    setIsEditingWeight(true)
  }

  // The input's max does not stop typing, so keep the number inside the limits when editing ends;
  // anything that is not a number goes back to the value before editing.
  const finishWeightEdit = () => {
    setWeight((current) => {
      const value = Number(current.trim())
      if (!current.trim() || !Number.isFinite(value)) return weightBeforeEditRef.current
      const clamped = Math.min(MAX_BODY_WEIGHT_KG, Math.max(MIN_BODY_WEIGHT_KG, value))
      return clamped === value ? current.trim() : String(clamped)
    })
    setIsEditingWeight(false)
  }

  const cancelWeightEdit = () => {
    setWeight(weightBeforeEditRef.current)
    setIsEditingWeight(false)
  }

  const stepWeight = (delta: number) => {
    setIsEditingWeight(false)
    const base = Number(weight)
    const current = Number.isFinite(base) && base >= MIN_BODY_WEIGHT_KG && base <= MAX_BODY_WEIGHT_KG ? base : 70
    const next = Math.min(MAX_BODY_WEIGHT_KG, Math.max(MIN_BODY_WEIGHT_KG, Math.round((current + delta) * 10) / 10))
    setWeight(next.toFixed(1))
  }

  const scrollToSettings = () => {
    settingsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.setTimeout(() => heightInputRef.current?.focus({ preventScroll: true }), 260)
  }

  const confirmLogout = () => {
    clearSession()
    setIsLogoutOpen(false)
    navigate('/login', { replace: true })
  }

  const hasChanges = age !== saved.age || weight !== saved.weight || height !== saved.height
    || gender !== saved.gender || objective !== saved.objective
  const isPremium = isPremiumActive(user)
  const initials = [user?.name, user?.surname].map((name) => name?.trim()[0] ?? '').join('').toUpperCase()
  const fullName = user ? `${user.name} ${user.surname}`.trim() : t('profile.title')
  const heroDate = new Date().toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
  const weightParts = splitWeight(weight)
  const timeSplit = formatProgressHours(workoutStats?.total_duration_seconds ?? 0)
  const totalWorkoutsLabel = formatWorkoutCount(workoutStats?.total_workouts ?? 0)
  const previewFriends = PROFILE_FRIENDS_PREVIEW.slice(0, 4)
  const remainingFriendsCount = Math.max(0, PROFILE_FRIENDS_PREVIEW.length - previewFriends.length)

  return (
    <div className="screen hifi-screen hifi-theme profile-screen">
      {/* Centered Figma Identity ("8/PERFIL") */}
      <header className="profile-hero">
        <div className="profile-hero-avatar" aria-hidden="true">{initials || '?'}</div>
        <h1 className="profile-hero-name">{fullName || t('profile.title')}</h1>
        <div className="profile-hero-pills">
          <button type="button" className="profile-chip-btn" onClick={scrollToSettings}>
            {t('common.edit')}
          </button>
          <button
            type="button"
            className={`profile-chip-btn${isPremium ? ' is-premium' : ''}`}
            onClick={() => {
              if (isPremium) {
                subscriptionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              } else {
                navigate('/premium', { state: { from: '/profile' } })
              }
            }}
          >
            {isPremium ? t('common.premium') : t('common.goPremium')}
          </button>
        </div>
      </header>

      {/* Frosted Weight & Main Goal Hero Card */}
      <section className="profile-hero-card" aria-label={t('profile.bodySummary')}>
        <div className="profile-hero-card-top">
          <span className="hifi-card-label">{t('profile.weight')}</span>
          <span className="profile-hero-date">{heroDate}</span>
        </div>

        <div className="profile-weight-row">
          <button
            type="button"
            className="profile-step-btn"
            aria-label={t('profile.decreaseWeight')}
            onClick={() => stepWeight(-0.1)}
          >
            <Minus size={18} aria-hidden="true" />
          </button>
          {isEditingWeight ? (
            <div className="profile-weight-editor">
              <input
                ref={weightInputRef}
                type="number"
                inputMode="decimal"
                step="0.1"
                min={MIN_BODY_WEIGHT_KG}
                max={MAX_BODY_WEIGHT_KG}
                aria-label={t('profile.weightInput')}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                onBlur={finishWeightEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    finishWeightEdit()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelWeightEdit()
                  }
                }}
                className="profile-weight-input"
              />
              <span className="profile-weight-unit" aria-hidden="true">kg</span>
            </div>
          ) : (
            <button
              type="button"
              className="profile-weight-readout"
              aria-live="polite"
              title={t('profile.editWeightHint')}
              aria-label={weightParts.whole === '–' ? t('profile.editWeight') : t('profile.editWeightCurrent', { value: `${weightParts.decimal}` })}
              onClick={startWeightEdit}
            >
              <span className="profile-weight-int">{weightParts.whole}</span>
              {weightParts.decimal && <span className="profile-weight-dec">{weightParts.decimal}</span>}
              {weightParts.whole !== '–' && <span className="profile-weight-unit">kg</span>}
            </button>
          )}
          <button
            type="button"
            className="profile-step-btn"
            aria-label={t('profile.increaseWeight')}
            onClick={() => stepWeight(0.1)}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="profile-goal-box">
          <button
            type="button"
            className="profile-goal-trigger"
            aria-expanded={goalPickerOpen}
            onClick={() => setGoalPickerOpen((open) => !open)}
          >
            <span>
              <span className="profile-goal-eyebrow">{t('profile.mainGoal')}</span>
              <span className="profile-goal-value">{valueLabel(t, 'goal', objective)}</span>
            </span>
            <ChevronRight className="profile-goal-chevron" size={20} aria-hidden="true" />
          </button>

          {goalPickerOpen && (
            <div className="profile-goal-chips" role="group" aria-label={t('profile.chooseGoal')}>
              {GOALS.map((goal) => (
                <button
                  key={goal}
                  type="button"
                  className="profile-goal-chip"
                  aria-pressed={objective === goal}
                  onClick={() => setObjective(goal)}
                >
                  {valueLabel(t, 'goal', goal)}
                </button>
              ))}
            </div>
          )}
        </div>

        {hasChanges && (
          <div className="profile-quick-save-row">
            <span className="hifi-caption">{t('profile.unsavedUpdate')}</span>
            <button
              type="button"
              className="hifi-pill"
              disabled={isSaving}
              onClick={() => { void saveProfileChanges(true) }}
            >
              {isSaving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        )}

        {quickNotice && (
          <p
            className="hifi-muted"
            role={quickNotice.kind === 'error' ? 'alert' : 'status'}
          >
            {quickNotice.text}
          </p>
        )}
      </section>

      {/* Progress 2x2 Grid + Body Measurements Preview */}
      <section className="profile-progress-section" aria-labelledby="progress-heading">
        <div className="profile-section-head">
          <h2 className="hifi-section-title" id="progress-heading">{t('profile.progress')}</h2>
          <span className="profile-section-since">{t('profile.last3Months')}</span>
        </div>

        <div className="profile-progress-grid">
          <button
            type="button"
            className="profile-stat-tile"
            aria-label={t('profile.muscleAria', { value: BODY_COMPOSITION_PREVIEW.muscleDeltaPct })}
            onClick={() => navigate('/profile/body-measurements')}
          >
            <span className="profile-stat-top">
              <span className="profile-stat-label">{t('profile.muscle')}</span>
              <span className="profile-soon-tag">{t('common.soon')}</span>
            </span>
            <p className="profile-stat-val">
              +{BODY_COMPOSITION_PREVIEW.muscleDeltaPct}
              <small>%</small>
            </p>
          </button>

          <button
            type="button"
            className="profile-stat-tile"
            aria-label={t('profile.fatAria', { value: BODY_COMPOSITION_PREVIEW.fatDeltaPct })}
            onClick={() => navigate('/profile/body-measurements')}
          >
            <span className="profile-stat-top">
              <span className="profile-stat-label">{t('profile.fat')}</span>
              <span className="profile-soon-tag">{t('common.soon')}</span>
            </span>
            <p className="profile-stat-val">
              {BODY_COMPOSITION_PREVIEW.fatDeltaPct}
              <small>%</small>
            </p>
          </button>

          <button
            type="button"
            className="profile-stat-tile"
            aria-label={t('profile.timeAria', { value: timeSplit.value, unit: timeSplit.unit })}
            onClick={() => navigate('/workouts/statistics')}
          >
            <span className="profile-stat-label">{t('profile.time')}</span>
            <p className="profile-stat-val">
              {timeSplit.value}
              <small>{timeSplit.unit}</small>
            </p>
          </button>

          <button
            type="button"
            className="profile-stat-tile"
            aria-label={t('profile.workoutsAria', { value: totalWorkoutsLabel })}
            onClick={() => navigate('/workouts/statistics')}
          >
            <span className="profile-stat-label">{t('profile.workouts')}</span>
            <p className="profile-stat-val">{totalWorkoutsLabel}</p>
          </button>
        </div>

        <div className="profile-preview-card">
          <div className="profile-section-head">
            <span className="hifi-card-label">{t('profile.bodyMeasurements')}</span>
            <span className="profile-soon-tag">{t('common.comingSoon')}</span>
          </div>
          <div className="profile-preview-foot">
            <p className="hifi-muted">{t('profile.bodyMeasurementsCopy')}</p>
            <button
              type="button"
              className="hifi-pill"
              onClick={() => navigate('/profile/body-measurements')}
            >
              {t('common.preview')}
            </button>
          </div>
        </div>
      </section>

      {/* Friends / Social Preview Card */}
      <section className="hifi-section" aria-labelledby="friends-heading">
        <div className="profile-section-head">
          <h2 className="hifi-section-title" id="friends-heading">{t('profile.friends')}</h2>
          <span className="profile-soon-tag">{t('common.comingSoon')}</span>
        </div>

        <div className="profile-preview-card">
          <p className="profile-preview-copy">
            {t('profile.friendsCopy')}<strong>{t('profile.friendsCopyStrong')}</strong>
          </p>
          <div className="profile-preview-foot">
            <div className="profile-avatar-stack" aria-hidden="true">
              {previewFriends.map((friend) => (
                <span
                  key={friend.id}
                  className="profile-mini-avatar"
                  style={{ background: friend.tone }}
                >
                  {friend.initials}
                </span>
              ))}
              {remainingFriendsCount > 0 && (
                <span className="profile-mini-avatar is-count">+{remainingFriendsCount}</span>
              )}
            </div>
            <button
              type="button"
              className="hifi-pill"
              onClick={() => navigate('/profile/friends')}
            >
              {t('common.viewAll')}
            </button>
          </div>
        </div>
      </section>

      {/* All Existing Settings Functionalities Preserved */}
      <section
        ref={settingsSectionRef}
        id="profile-settings"
        className="profile-settings-stack"
        aria-labelledby="settings-heading"
      >
        <h2 className="hifi-section-title" id="settings-heading">{t('profile.settings')}</h2>

        <form onSubmit={handleSave}>
          <section className="section" aria-labelledby="profile-body">
            <h3 className="section-title" id="profile-body">{t('profile.bodyDetails')}</h3>
            <div className="settings-card">
              <div className="settings-row">
                <label className="settings-label" htmlFor="profile-height">{t('profile.height')}</label>
                <span className="profile-field">
                  <input ref={heightInputRef} id="profile-height" type="number" inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} className="settings-input" />
                  <span>{t('common.cm')}</span>
                </span>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="profile-age">{t('profile.age')}</label>
                <span className="profile-field">
                  <input id="profile-age" type="number" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} className="settings-input" />
                  <span>{t('common.years')}</span>
                </span>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="profile-gender">
                  {t('profile.gender')}
                  <small>{t('profile.genderHint')}</small>
                </label>
                <select id="profile-gender" value={gender} onChange={(e) => setGender(e.target.value)} className="settings-input">
                  <option value="Male">{t('gender.Male')}</option>
                  <option value="Female">{t('gender.Female')}</option>
                  <option value="Other">{t('gender.Other')}</option>
                </select>
              </div>
            </div>
          </section>

          {notice && (
            <div
              className={`settings-notice ${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              {notice.kind === 'success'
                ? <CheckCircle2 size={18} aria-hidden="true" />
                : <AlertCircle size={18} aria-hidden="true" />}
              <span>{notice.text}</span>
            </div>
          )}

          {hasChanges && (
            <button type="submit" className="primary-button profile-save" disabled={isSaving}>
              {isSaving
                ? <><Loader2 size={20} className="animate-spin" aria-hidden="true" /> {t('common.saving')}</>
                : t('common.saveChanges')}
            </button>
          )}
        </form>

        <HealthConnectCard userId={user?.id} />

        <section ref={subscriptionSectionRef} className="section" aria-labelledby="subscription-title">
          <h3 className="section-title" id="subscription-title">{t('profile.subscription')}</h3>
          <div className="settings-card">
            {isPremium ? (
              <>
                <div className="settings-row">
                  <span className="settings-label">{t('profile.plan')}</span>
                  <span className="subscription-value">Premium{premiumPlanLabel ? ` · ${premiumPlanLabel}` : ''}</span>
                </div>
                <div className="settings-row">
                  <span className="settings-label">{t('profile.status')}</span>
                  <span className={`subscription-value${isCancelled ? ' is-cancelled' : ' is-active'}`} role="status">
                    {isCancelled ? t('profile.cancelled') : t('profile.active')}
                  </span>
                </div>
                {premiumStartDate && (
                  <div className="settings-row">
                    <span className="settings-label">{t('profile.started')}</span>
                    <span className="subscription-value">{premiumStartDate}</span>
                  </div>
                )}
                {premiumEndDate && (
                  <div className="settings-row">
                    <span className="settings-label">{isCancelled ? t('profile.accessEnds') : t('profile.activeUntil')}</span>
                    <span className="subscription-value">{premiumEndDate}</span>
                  </div>
                )}
                {isCancelled ? (
                  <p className="subscription-note">{t('profile.keepFeatures')}</p>
                ) : (
                  <button type="button" onClick={() => setIsCancelOpen(true)} className="profile-row-button is-danger">
                    {t('profile.cancelPremium')}
                  </button>
                )}
              </>
            ) : (
              <button type="button" onClick={() => navigate('/premium', { state: { from: '/profile' } })} className="profile-row-button">
                <span className="settings-label">
                  {t('common.goPremium')}
                  <small>{t('profile.freePlan')}</small>
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            )}
          </div>
        </section>

        <section className="section" aria-labelledby="profile-account">
          <h3 className="section-title" id="profile-account">{t('profile.account')}</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-label">{t('profile.darkMode')}</span>
              <LiquidToggle checked={isDark} onChange={toggleDark} label={t('profile.darkMode')} />
            </div>
            <div className="settings-row">
              <span className="settings-label">{t('language.label')}</span>
              <LanguageSwitch />
            </div>
            <div className="settings-row">
              <span className="settings-label">{t('profile.email')}</span>
              <span className="profile-email">{user?.email || '–'}</span>
            </div>
            <button type="button" onClick={() => navigate('/faq')} className="profile-row-button">
              <span className="settings-label">{t('profile.faq')}</span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setIsLogoutOpen(true)} className="profile-row-button is-danger">
              <LogOut size={17} aria-hidden="true" />
              {t('profile.logOut')}
            </button>
          </div>
        </section>
      </section>

      {isCancelOpen && (
        <div className="modal-backdrop">
          <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="cancel-premium-title" tabIndex={-1} ref={cancelDialogRef}>
            <p className="eyebrow">{t('profile.yourSubscription')}</p>
            <h2 id="cancel-premium-title">{t('profile.cancelPremiumQuestion')}</h2>
            <p>{premiumEndDate ? t('profile.cancelBodyUntil', { date: premiumEndDate }) : t('profile.cancelBodyPeriod')}</p>
            {cancelError && <p role="alert">{cancelError}</p>}
            <div className="modal-actions">
              <button className="secondary-action" type="button" disabled={isCancelling} onClick={() => setIsCancelOpen(false)}>
                {t('profile.keepPremium')}
              </button>
              <button className="danger-action" type="button" disabled={isCancelling} onClick={confirmCancelPremium}>
                {isCancelling ? t('profile.cancelling') : t('profile.cancelPremium')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isLogoutOpen && (
        <div className="modal-backdrop">
          <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="logout-title" tabIndex={-1} ref={logoutDialogRef}>
            <p className="eyebrow">{t('profile.yourSession')}</p>
            <h2 id="logout-title">{t('profile.logOutQuestion')}</h2>
            <p>{t('profile.logOutBody')}</p>
            <div className="modal-actions">
              <button className="secondary-action" type="button" onClick={() => setIsLogoutOpen(false)}>
                {t('profile.staySignedIn')}
              </button>
              <button className="danger-action" type="button" onClick={confirmLogout}>
                {t('profile.logOut')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Profile
