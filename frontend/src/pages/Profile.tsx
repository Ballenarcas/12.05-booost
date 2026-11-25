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
  const formatDay = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const premiumEndDate = user?.premium_expires_at ? formatDay(user.premium_expires_at) : null
  const premiumStartDate = user?.premium_started_at ? formatDay(user.premium_started_at) : null
  const premiumPlanLabel = user?.premium_plan === 'annual' ? 'Annual' : user?.premium_plan === 'monthly' ? 'Monthly' : null

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
      setCancelError(describeError(error, "We couldn't cancel your subscription. Please try again."))
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
      reportError('Fill in every field before saving your changes.')
      return
    }
    if (!Number.isInteger(ageValue) || ageValue < 12 || ageValue > 120) {
      reportError('Age must be a whole number between 12 and 120.')
      return
    }
    if (!Number.isFinite(weightValue) || weightValue < MIN_BODY_WEIGHT_KG || weightValue > MAX_BODY_WEIGHT_KG) {
      reportError(`Weight must be between ${MIN_BODY_WEIGHT_KG} and ${MAX_BODY_WEIGHT_KG} kg.`)
      return
    }
    if (!Number.isInteger(heightValue) || heightValue < 80 || heightValue > 250) {
      reportError('Height must be a whole number between 80 and 250 cm.')
      return
    }

    setIsSaving(true)
    setNotice(null)
    setQuickNotice(null)
    try {
      if (!user?.id) throw new Error('Your profile could not be found. Please sign in again.')
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
        text: 'Profile updated. Your next calorie and workout estimates will use these details.',
      }
      setNotice(successMsg)
      if (fromQuickCard) {
        setQuickNotice({ kind: 'success', text: 'Saved to your profile.' })
      }
    } catch (error) {
      reportError(describeError(error, "We couldn't save your changes. Please try again."))
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
  const fullName = user ? `${user.name} ${user.surname}`.trim() : 'Profile'
  const heroDate = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
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
        <h1 className="profile-hero-name">{fullName || 'Profile'}</h1>
        <div className="profile-hero-pills">
          <button type="button" className="profile-chip-btn" onClick={scrollToSettings}>
            Edit
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
            {isPremium ? 'Premium' : 'Go Premium'}
          </button>
        </div>
      </header>

      {/* Frosted Weight & Main Goal Hero Card */}
      <section className="profile-hero-card" aria-label="Body summary and goal">
        <div className="profile-hero-card-top">
          <span className="hifi-card-label">Weight</span>
          <span className="profile-hero-date">{heroDate}</span>
        </div>

        <div className="profile-weight-row">
          <button
            type="button"
            className="profile-step-btn"
            aria-label="Decrease weight by 0.1 kg"
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
                aria-label="Weight in kg"
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
              title="Click to edit weight"
              aria-label={weightParts.whole === '–' ? 'Edit weight in kg' : `Edit weight, currently ${weightParts.whole}${weightParts.decimal} kg`}
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
            aria-label="Increase weight by 0.1 kg"
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
              <span className="profile-goal-eyebrow">Main goal</span>
              <span className="profile-goal-value">{objective}</span>
            </span>
            <ChevronRight className="profile-goal-chevron" size={20} aria-hidden="true" />
          </button>

          {goalPickerOpen && (
            <div className="profile-goal-chips" role="group" aria-label="Choose your main goal">
              {GOALS.map((goal) => (
                <button
                  key={goal}
                  type="button"
                  className="profile-goal-chip"
                  aria-pressed={objective === goal}
                  onClick={() => setObjective(goal)}
                >
                  {goal}
                </button>
              ))}
            </div>
          )}
        </div>

        {hasChanges && (
          <div className="profile-quick-save-row">
            <span className="hifi-caption">Unsaved profile update</span>
            <button
              type="button"
              className="hifi-pill"
              disabled={isSaving}
              onClick={() => { void saveProfileChanges(true) }}
            >
              {isSaving ? 'Saving...' : 'Save'}
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
          <h2 className="hifi-section-title" id="progress-heading">Progress</h2>
          <span className="profile-section-since">Last 3 months</span>
        </div>

        <div className="profile-progress-grid">
          <button
            type="button"
            className="profile-stat-tile"
            aria-label={`Muscle gain +${BODY_COMPOSITION_PREVIEW.muscleDeltaPct} percent, coming soon preview`}
            onClick={() => navigate('/profile/body-measurements')}
          >
            <span className="profile-stat-top">
              <span className="profile-stat-label">Muscle</span>
              <span className="profile-soon-tag">Soon</span>
            </span>
            <p className="profile-stat-val">
              +{BODY_COMPOSITION_PREVIEW.muscleDeltaPct}
              <small>%</small>
            </p>
          </button>

          <button
            type="button"
            className="profile-stat-tile"
            aria-label={`Body fat ${BODY_COMPOSITION_PREVIEW.fatDeltaPct} percent, coming soon preview`}
            onClick={() => navigate('/profile/body-measurements')}
          >
            <span className="profile-stat-top">
              <span className="profile-stat-label">Fat</span>
              <span className="profile-soon-tag">Soon</span>
            </span>
            <p className="profile-stat-val">
              {BODY_COMPOSITION_PREVIEW.fatDeltaPct}
              <small>%</small>
            </p>
          </button>

          <button
            type="button"
            className="profile-stat-tile"
            aria-label={`Workout time ${timeSplit.value} ${timeSplit.unit} in last 3 months, open statistics`}
            onClick={() => navigate('/workouts/statistics')}
          >
            <span className="profile-stat-label">Time</span>
            <p className="profile-stat-val">
              {timeSplit.value}
              <small>{timeSplit.unit}</small>
            </p>
          </button>

          <button
            type="button"
            className="profile-stat-tile"
            aria-label={`${totalWorkoutsLabel} workouts in last 3 months, open statistics`}
            onClick={() => navigate('/workouts/statistics')}
          >
            <span className="profile-stat-label">Workouts</span>
            <p className="profile-stat-val">{totalWorkoutsLabel}</p>
          </button>
        </div>

        <div className="profile-preview-card">
          <div className="profile-section-head">
            <span className="hifi-card-label">Body measurements</span>
            <span className="profile-soon-tag">Coming soon</span>
          </div>
          <div className="profile-preview-foot">
            <p className="hifi-muted">Track tape circumferences and body composition trends.</p>
            <button
              type="button"
              className="hifi-pill"
              onClick={() => navigate('/profile/body-measurements')}
            >
              Preview
            </button>
          </div>
        </div>
      </section>

      {/* Friends / Social Preview Card */}
      <section className="hifi-section" aria-labelledby="friends-heading">
        <div className="profile-section-head">
          <h2 className="hifi-section-title" id="friends-heading">Friends</h2>
          <span className="profile-soon-tag">Coming soon</span>
        </div>

        <div className="profile-preview-card">
          <p className="profile-preview-copy">
            Train together, <strong>compare your progress</strong>
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
              View all
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
        <h2 className="hifi-section-title" id="settings-heading">Settings</h2>

        <form onSubmit={handleSave}>
          <section className="section" aria-labelledby="profile-body">
            <h3 className="section-title" id="profile-body">Body details</h3>
            <div className="settings-card">
              <div className="settings-row">
                <label className="settings-label" htmlFor="profile-height">Height</label>
                <span className="profile-field">
                  <input ref={heightInputRef} id="profile-height" type="number" inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} className="settings-input" />
                  <span>cm</span>
                </span>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="profile-age">Age</label>
                <span className="profile-field">
                  <input id="profile-age" type="number" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} className="settings-input" />
                  <span>yrs</span>
                </span>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="profile-gender">
                  Gender
                  <small>For BMR calculation</small>
                </label>
                <select id="profile-gender" value={gender} onChange={(e) => setGender(e.target.value)} className="settings-input">
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
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
                ? <><Loader2 size={20} className="animate-spin" aria-hidden="true" /> Saving...</>
                : 'Save changes'}
            </button>
          )}
        </form>

        <HealthConnectCard userId={user?.id} />

        <section ref={subscriptionSectionRef} className="section" aria-labelledby="subscription-title">
          <h3 className="section-title" id="subscription-title">Subscription</h3>
          <div className="settings-card">
            {isPremium ? (
              <>
                <div className="settings-row">
                  <span className="settings-label">Plan</span>
                  <span className="subscription-value">Premium{premiumPlanLabel ? ` · ${premiumPlanLabel}` : ''}</span>
                </div>
                <div className="settings-row">
                  <span className="settings-label">Status</span>
                  <span className={`subscription-value${isCancelled ? ' is-cancelled' : ' is-active'}`} role="status">
                    {isCancelled ? 'Cancelled' : 'Active'}
                  </span>
                </div>
                {premiumStartDate && (
                  <div className="settings-row">
                    <span className="settings-label">Started</span>
                    <span className="subscription-value">{premiumStartDate}</span>
                  </div>
                )}
                {premiumEndDate && (
                  <div className="settings-row">
                    <span className="settings-label">{isCancelled ? 'Access ends' : 'Active until'}</span>
                    <span className="subscription-value">{premiumEndDate}</span>
                  </div>
                )}
                {isCancelled ? (
                  <p className="subscription-note">You keep every Premium feature until your access ends.</p>
                ) : (
                  <button type="button" onClick={() => setIsCancelOpen(true)} className="profile-row-button is-danger">
                    Cancel Premium
                  </button>
                )}
              </>
            ) : (
              <button type="button" onClick={() => navigate('/premium', { state: { from: '/profile' } })} className="profile-row-button">
                <span className="settings-label">
                  Go Premium
                  <small>You're on the free plan</small>
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            )}
          </div>
        </section>

        <section className="section" aria-labelledby="profile-account">
          <h3 className="section-title" id="profile-account">Account</h3>
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-label">Dark mode</span>
              <LiquidToggle checked={isDark} onChange={toggleDark} label="Dark mode" />
            </div>
            <div className="settings-row">
              <span className="settings-label">Email</span>
              <span className="profile-email">{user?.email || '–'}</span>
            </div>
            <button type="button" onClick={() => navigate('/faq')} className="profile-row-button">
              <span className="settings-label">FAQ & support</span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => setIsLogoutOpen(true)} className="profile-row-button is-danger">
              <LogOut size={17} aria-hidden="true" />
              Log out
            </button>
          </div>
        </section>
      </section>

      {isCancelOpen && (
        <div className="modal-backdrop">
          <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="cancel-premium-title" tabIndex={-1} ref={cancelDialogRef}>
            <p className="eyebrow">Your subscription</p>
            <h2 id="cancel-premium-title">Cancel Premium?</h2>
            <p>You keep Premium {premiumEndDate ? `until ${premiumEndDate}` : 'until your paid period ends'}. After that, your account returns to the free plan. Your meals and workouts stay in your account.</p>
            {cancelError && <p role="alert">{cancelError}</p>}
            <div className="modal-actions">
              <button className="secondary-action" type="button" disabled={isCancelling} onClick={() => setIsCancelOpen(false)}>
                Keep Premium
              </button>
              <button className="danger-action" type="button" disabled={isCancelling} onClick={confirmCancelPremium}>
                {isCancelling ? 'Cancelling...' : 'Cancel Premium'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isLogoutOpen && (
        <div className="modal-backdrop">
          <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="logout-title" tabIndex={-1} ref={logoutDialogRef}>
            <p className="eyebrow">Your session</p>
            <h2 id="logout-title">Log out of BOOOST?</h2>
            <p>Your meals and workouts stay in your account. You can sign back in any time.</p>
            <div className="modal-actions">
              <button className="secondary-action" type="button" onClick={() => setIsLogoutOpen(false)}>
                Stay signed in
              </button>
              <button className="danger-action" type="button" onClick={confirmLogout}>
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Profile
