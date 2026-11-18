import { Apple, ArrowRight, CalendarDays, Camera, CircleUserRound, Dumbbell, Footprints, GlassWater, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AiTipCard from '../components/home/AiTipCard'
import HydrationCard from '../components/home/HydrationCard'
import PremiumUpsellButton from '../components/premium/PremiumUpsellButton'
import {
  getRestDayScheduleKey,
  inferMuscleGroupFromExerciseName,
  readTodayRestDaySchedule,
  type RestDayScheduleState,
} from './AiRestSuggestions'
import { fetchDashboardSummary, getCachedDashboardSummary, getCurrentUser, planTodaysWorkout, type DashboardSummary } from '../services/api'
import { describeError } from '../utils/errors.js'

function formatMacro(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function HomeSkeleton() {
  return (
    <div className="screen skeleton-screen" role="status" aria-busy="true" aria-label="Loading your dashboard">
      <header className="screen-header">
        <div className="profile-heading">
          <span className="skeleton skeleton-circle" aria-hidden="true" />
          <div className="skeleton-stack">
            <span className="skeleton skeleton-line w-short" aria-hidden="true" />
            <span className="skeleton skeleton-line w-mid tall" aria-hidden="true" />
          </div>
        </div>
        <div className="home-header-actions">
          <PremiumUpsellButton />
          <span className="skeleton skeleton-badge" aria-hidden="true" />
        </div>
      </header>

      <section className="skeleton-section" aria-hidden="true">
        <span className="skeleton skeleton-line w-short" />
        <div className="skeleton-card ai-banner-skeleton">
          <span className="skeleton skeleton-line w-long" />
        </div>
      </section>

      <section className="skeleton-section" aria-hidden="true">
        <span className="skeleton skeleton-line w-mid" />
        <span className="skeleton skeleton-line w-long" />
        <span className="skeleton skeleton-track" />
        <div className="skeleton-card skeleton-macros">
          <span className="skeleton skeleton-macro" />
          <span className="skeleton skeleton-macro" />
          <span className="skeleton skeleton-macro" />
        </div>
        <div className="skeleton-actions">
          <span className="skeleton skeleton-button" />
          <span className="skeleton skeleton-button" />
        </div>
      </section>

      <section className="skeleton-section" aria-hidden="true">
        <span className="skeleton skeleton-line w-mid" />
        <div className="skeleton-card">
          <span className="skeleton skeleton-line w-long tall" />
          <div className="skeleton-list">
            <span className="skeleton skeleton-meta" />
            <span className="skeleton skeleton-meta" />
          </div>
          <span className="skeleton skeleton-button" />
        </div>
      </section>
    </div>
  )
}

function Home() {
  const [summary, setSummary] = useState<DashboardSummary | null>(() => getCachedDashboardSummary())
  const [error, setError] = useState<string | null>(null)
  const user = getCurrentUser()
  const userId = user?.id
  const navigate = useNavigate()

  const [restDaySchedule, setRestDaySchedule] = useState<RestDayScheduleState | null>(() =>
    readTodayRestDaySchedule(userId),
  )

  useEffect(() => {
    setRestDaySchedule(readTodayRestDaySchedule(userId))
  }, [userId])

  useEffect(() => {
    let isMounted = true

    fetchDashboardSummary()
      .then(async (data) => {
        if (!isMounted) return
        setSummary(data)
        if (data.plan || data.completed_workout_today || !userId) return
        try {
          await planTodaysWorkout(userId)
          const refreshed = await fetchDashboardSummary({ forceRefresh: true })
          if (isMounted) setSummary(refreshed)
        } catch {
          // Keep the dashboard available when planning is temporarily unavailable.
        }
      })
      .catch((requestError: Error) => {
        if (isMounted && !getCachedDashboardSummary()) {
          setError(describeError(requestError, "We couldn't load your dashboard. Please try again."))
        }
      })

    return () => {
      isMounted = false
    }
  }, [userId])

  if (error) return <div className="screen state-card" role="alert">{error}</div>
  if (!summary) return <HomeSkeleton />

  const { nutrition } = summary
  const plan = summary.plan
  const completedWorkoutToday = summary.completed_workout_today
  const activity = summary.activity

  // Ajustement dynamique des cibles nutritionnelles si aujourd'hui est un Rest Day
  const kcalDelta = restDaySchedule ? restDaySchedule.caloricAdjustmentKcal : 0
  const proteinBonus = restDaySchedule ? (restDaySchedule.proteinBonusGrams ?? 15) : 0
  const carbsCut = restDaySchedule ? (restDaySchedule.carbsReductionGrams ?? 50) : 0

  const adjustedTargetKcals = Math.max(1200, nutrition.target_kcals + kcalDelta)
  const consumedKcals = Math.max(0, nutrition.target_kcals - nutrition.remaining_kcals)
  const adjustedRemainingKcals = Math.max(0, adjustedTargetKcals - consumedKcals)
  const adjustedTargetProtein = nutrition.target_protein + proteinBonus
  const adjustedTargetCarbs = Math.max(50, nutrition.target_carbs - carbsCut)

  const calorieProgress = Math.max(
    0,
    Math.min(100, Math.round((consumedKcals / adjustedTargetKcals) * 100)),
  )

  const macros = [
    {
      label: restDaySchedule ? 'Protein (+Recovery)' : 'Protein',
      value: `${formatMacro(nutrition.current_protein)} / ${formatMacro(adjustedTargetProtein)}g`,
    },
    {
      label: restDaySchedule ? 'Carbs (Rest Day)' : 'Carbs',
      value: `${formatMacro(nutrition.current_carbs)} / ${formatMacro(adjustedTargetCarbs)}g`,
    },
    { label: 'Fat', value: `${formatMacro(nutrition.current_fat)} / ${formatMacro(nutrition.target_fat)}g` },
  ]
  const displayName = summary.user_name || [user?.name, user?.surname].filter(Boolean).join(' ')

  const removeRestDayFromDashboard = () => {
    localStorage.removeItem(getRestDayScheduleKey(userId))
    setRestDaySchedule(null)
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <div className="profile-heading">
          <div className="avatar" aria-label={`${displayName}'s profile`}><CircleUserRound size={23} aria-hidden="true" /></div>
          <div>
            <p className="eyebrow">Good morning</p>
            <h1>Hello, {displayName}</h1>
          </div>
        </div>
        <div className="home-header-actions">
          <PremiumUpsellButton />
          <div className="date-badge"><CalendarDays size={16} aria-hidden="true" />{summary.current_date_formatted}</div>
        </div>
      </header>

      <section className="section" aria-labelledby="trainer-insight">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <h2 className="section-title" id="trainer-insight" style={{ margin: 0 }}>AI Trainer</h2>
          <button
            type="button"
            onClick={() => navigate('/ai-rest-suggestions')}
            style={{
              background: 'rgba(234, 179, 8, 0.14)',
              border: '1px solid rgba(234, 179, 8, 0.4)',
              color: '#facc15',
              borderRadius: '999px',
              padding: '5px 11px',
              fontSize: '11.5px',
              fontWeight: 800,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            👑 AI Rest Suggestions <ArrowRight size={13} />
          </button>
        </div>

        {restDaySchedule && (
          <div
            role="status"
            style={{
              backgroundColor: 'rgba(50, 215, 104, 0.12)',
              border: '1.5px solid #32d768',
              borderRadius: '14px',
              padding: '12px 15px',
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
            }}
          >
            <div onClick={() => navigate('/ai-rest-suggestions')} style={{ cursor: 'pointer', flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: '#32d768' }}>
                ✓ TODAY IS MARKED AS AN AI REST &amp; RECOVERY DAY
              </div>
              <div style={{ fontSize: '12px', color: '#d4d4d8', marginTop: '2px' }}>
                {restDaySchedule.reason}
              </div>
            </div>
            <button
              type="button"
              onClick={removeRestDayFromDashboard}
              style={{
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.2)',
                color: '#e4e4e7',
                borderRadius: '999px',
                padding: '4px 10px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Undo
            </button>
          </div>
        )}

        <AiTipCard onApplied={() => fetchDashboardSummary({ forceRefresh: true }).then(setSummary).catch(() => undefined)} />
      </section>

      <section className="section" aria-labelledby="daily-activity">
        <h2 className="section-title" id="daily-activity"><Footprints size={16} aria-hidden="true" /> Daily activity</h2>
        {activity?.connected ? (
          <div className="card activity-card">
            <div className="activity-stats">
              <div className="activity-stat">
                <span>Steps today</span>
                <strong>{activity.steps_today.toLocaleString()}</strong>
              </div>
              <div className="activity-stat">
                <span>Active kcal</span>
                <strong>{activity.active_calories_today}</strong>
              </div>
            </div>
            <p className="activity-note">
              Health Connect · 7-day average {activity.steps_avg_7d.toLocaleString()} steps and{' '}
              {activity.active_calories_avg_7d} active kcal. Included in your AI trainer guidance.
            </p>
            {activity.source === 'preview' && (
              <p className="activity-preview">Browser preview activity. The Android app reads Health Connect directly.</p>
            )}
          </div>
        ) : (
          <div className="card activity-card activity-empty">
            <div>
              <h3>Bring your steps into the plan</h3>
              <p>Connect Health Connect so the AI trainer can read steps and active calories.</p>
            </div>
            <button className="secondary-action" type="button" onClick={() => navigate('/settings')}>
              Connect in Settings
            </button>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="nutrition-summary">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
          <h2 className="section-title" id="nutrition-summary" style={{ margin: 0 }}>
            <Apple size={16} aria-hidden="true" /> Nutrition summary
          </h2>
          {restDaySchedule && (
            <span
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: '#32d768',
                backgroundColor: 'rgba(50, 215, 104, 0.14)',
                border: '1px solid rgba(50, 215, 104, 0.35)',
                borderRadius: '999px',
                padding: '3px 9px',
              }}
            >
              AI Rest Day Adjusted (-250 kcal · +15g Protein)
            </span>
          )}
        </div>
        <div className="progress-copy" style={{ marginTop: '8px' }}>
          <strong>{adjustedRemainingKcals.toLocaleString('de-DE')} kcals remaining today</strong>
          <span>{calorieProgress}% of {adjustedTargetKcals} kcal goal</span>
        </div>
        <div className="progress-track" role="progressbar" aria-label="Daily calorie progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={calorieProgress}><div className="progress-value" style={{ width: `${calorieProgress}%` }} /></div>
        <div className="card macro-card">
          {macros.map((macro) => <div className="macro" key={macro.label}><span className="macro-label">{macro.label}</span><span className="macro-value">{macro.value}</span></div>)}
        </div>
        <div className="action-row">
          <button
            className="action-button"
            type="button"
            onClick={() => navigate('/log-meals')}
          >
            <Plus size={17} aria-hidden="true" /> Manual Register
          </button>
          <button className="action-button" type="button" disabled><Camera size={17} aria-hidden="true" /> Scan plate <span className="pro-badge">PRO</span></button>
        </div>
      </section>

      <section className="section" aria-labelledby="hydration-summary">
        <h2 className="section-title" id="hydration-summary"><GlassWater size={16} aria-hidden="true" /> Daily hydration</h2>
        <HydrationCard />
      </section>

      <section className="section" aria-labelledby="programmed-training">
        <h2 className="section-title" id="programmed-training"><Dumbbell size={16} aria-hidden="true" /> Programmed training</h2>
        {restDaySchedule ? (
          <div className="card training-card" style={{ border: '1.5px solid #32d768' }}>
            <div className="scheduled-training-heading">
              <h3>Rest &amp; Active Recovery Day</h3>
              <span className="ai-adjusted-badge" style={{ backgroundColor: 'rgba(50, 215, 104, 0.2)', color: '#32d768' }}>
                AI Rest Day Active
              </span>
            </div>
            <ul className="training-meta">
              <li>Today · Active Recovery Protocol</li>
              <li>{restDaySchedule.activeRecoveryText || '20-30 min slow walk, mobility work, and stretching.'}</li>
            </ul>
            <p className="training-reasoning">{restDaySchedule.reason}</p>
            {plan && !plan.is_rest_day && plan.exercises.length > 0 && (
              <button
                className="secondary-action"
                type="button"
                style={{ marginTop: '10px', width: '100%' }}
                onClick={() => {
                  const cutPct = restDaySchedule.volumeReductionPct || 30
                  const fatiguedGroups = restDaySchedule.fatiguedMuscleGroups ?? []
                  navigate('/workouts/active', {
                    state: {
                      planId: plan.id,
                      routineId: plan.routine_id,
                      name: `${plan.title} (Rest Day Recovery Mode)`,
                      startedAt: new Date().toISOString(),
                      exercises: plan.exercises.map((exercise) => {
                        const group = inferMuscleGroupFromExerciseName(exercise.name || '')
                        const isFatigued =
                          restDaySchedule.isSystemic ||
                          fatiguedGroups.length === 0 ||
                          fatiguedGroups.includes(group)
                        const adjustedSets =
                          isFatigued && exercise.sets >= 2
                            ? Math.max(1, Math.min(exercise.sets - 1, Math.round(exercise.sets * (1 - cutPct / 100))))
                            : exercise.sets
                        const baseWeight = exercise.previous_weight_kg ?? 0
                        const adjustedWeight =
                          isFatigued && baseWeight > 0
                            ? Math.max(0, Math.round(baseWeight * (1 - cutPct / 100) * 2) / 2)
                            : baseWeight
                        return {
                          exercise_id: exercise.exercise_id,
                          name: exercise.name,
                          previous_weight_kg: exercise.previous_weight_kg ?? null,
                          previous_reps: exercise.reps,
                          target_sets: adjustedSets,
                          target_reps: exercise.reps,
                          sets: Array.from({ length: Math.max(1, adjustedSets) }, (_, index) => ({
                            set_number: index + 1,
                            weight_kg: adjustedWeight,
                            reps: exercise.reps,
                            rpe: isFatigued ? 6 : undefined,
                            is_completed: false,
                          })),
                        }
                      }),
                    },
                  })
                }}
              >
                Train anyway (Apply -{restDaySchedule.volumeReductionPct || 30}% on fatigued muscles)
              </button>
            )}
          </div>
        ) : completedWorkoutToday ? (
          <div className="card training-card">
            <div className="scheduled-training-heading">
              <h3>Workout completed today</h3>
            </div>
            <ul className="training-meta">
              <li>{completedWorkoutToday.name}</li>
            </ul>
          </div>
        ) : plan ? (
          plan.is_rest_day ? (
            <div className="card training-card">
              <div className="scheduled-training-heading">
                <h3>Rest day</h3>
              </div>
              <ul className="training-meta">
                <li>Recovery recommended by your AI trainer</li>
              </ul>
              {plan.ai_reasoning && (
                <p className="training-reasoning">{plan.ai_reasoning}</p>
              )}
            </div>
          ) : (
            <div className="card training-card">
              <div className="scheduled-training-heading">
                <h3>{plan.title}</h3>
                {plan.routine_id === null ? (
                  <span className="ai-adjusted-badge">AI generated</span>
                ) : plan.ai_adjusted && <span className="ai-adjusted-badge">AI adjusted</span>}
              </div>
              <ul className="training-meta">
                <li>Today</li>
                <li>Volume: {plan.exercises.length} exercises</li>
              </ul>
              {plan.exercises.length > 0 && (
                <ul className="scheduled-exercises" aria-label="Planned exercises and sets">
                  {plan.exercises.map((exercise) => (
                    <li key={exercise.exercise_id}>
                      <span>{exercise.name}</span>
                      <span className="scheduled-exercise-sets">{exercise.sets} sets · {exercise.reps} reps</span>
                    </li>
                  ))}
                </ul>
              )}
              {plan.ai_adjusted && plan.ai_reasoning && (
                <p className="training-reasoning">{plan.ai_reasoning}</p>
              )}
              <button className="primary-button" type="button" onClick={() => navigate('/workouts/active', { state: {
                planId: plan.id,
                routineId: plan.routine_id,
                name: plan.title,
                startedAt: new Date().toISOString(),
                exercises: plan.exercises.map((exercise) => ({
                  exercise_id: exercise.exercise_id,
                  name: exercise.name,
                  previous_weight_kg: exercise.previous_weight_kg ?? null,
                  previous_reps: exercise.reps,
                  target_sets: exercise.sets,
                  target_reps: exercise.reps,
                  sets: Array.from({ length: Math.max(1, exercise.sets) }, (_, index) => ({
                    set_number: index + 1,
                    weight_kg: exercise.previous_weight_kg ?? 0,
                    reps: exercise.reps,
                    is_completed: false,
                  })),
                })),
              } })}>START WORKOUT</button>
            </div>
          )
        ) : (
          <div className="card training-card empty-state">No workout scheduled for today.</div>
        )}
      </section>
    </div>
  )
}

export default Home