import { useEffect, useState } from 'react'
import { usePageNavigate } from '../utils/usePageNavigate'
import AiTipCard from '../components/home/AiTipCard'
import HydrationSummary from '../components/home/HydrationSummary'
import PremiumUpsellButton from '../components/premium/PremiumUpsellButton'
import { fetchDashboardSummary, getCachedDashboardSummary, getCurrentUser, planTodaysWorkout, type DashboardSummary } from '../services/api'
import { describeError } from '../utils/errors.js'
import orbImage from '../assets/home/orb.svg'
import workoutImage from '../assets/home/workout.webp'
import '../styles/home.css'

const percent = (current: number, target: number) => (target > 0 ? Math.max(0, Math.min(1, current / target)) : 0)

function ProgressBar({ value }: { value: number }) {
  return (
    <span className="home-bar" aria-hidden="true">
      <span style={{ width: `${value * 100}%` }} />
    </span>
  )
}

/** Today against the 7-day average: Health Connect gives no daily goal to measure against. */
function ActivityStat({ value, average, unit }: { value: number; average: number; unit: string }) {
  return (
    <div className="home-activity-stat">
      <strong>{value.toLocaleString('en-US')}</strong>
      <span>/{average.toLocaleString('en-US')} avg {unit}</span>
      <ProgressBar value={percent(value, average)} />
    </div>
  )
}

// Nothing shows while loading; screen readers still hear it.
function Home() {
  const [summary, setSummary] = useState<DashboardSummary | null>(() => getCachedDashboardSummary())
  const [error, setError] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const user = getCurrentUser()
  const userId = user?.id
  const navigate = usePageNavigate()

  useEffect(() => {
    let isMounted = true

    fetchDashboardSummary()
      .then(async (data) => {
        if (!isMounted) return
        setSummary(data)
        if (data.plan || data.completed_workout_today || !userId) return
        setPlanning(true)
        try {
          await planTodaysWorkout(userId)
          const refreshed = await fetchDashboardSummary({ forceRefresh: true })
          if (isMounted) setSummary(refreshed)
        } catch {
          // Keep the dashboard available when planning is temporarily unavailable.
        } finally {
          if (isMounted) setPlanning(false)
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

  // The page is drawn straight away; only the parts that need the dashboard wait for it, and the
  // tip and hydration load at the same time instead of after it.
  const nutrition = summary?.nutrition
  const plan = summary?.plan
  const completedWorkoutToday = summary?.completed_workout_today
  const activity = summary?.activity
  const consumed = nutrition ? nutrition.target_kcals - nutrition.remaining_kcals : 0
  const kcalGoal = nutrition?.target_kcals ?? 0
  const macros = [
    { label: 'Protein', current: nutrition?.current_protein ?? 0, target: nutrition?.target_protein ?? 0 },
    { label: 'Carbs', current: nutrition?.current_carbs ?? 0, target: nutrition?.target_carbs ?? 0 },
    { label: 'Fat', current: nutrition?.current_fat ?? 0, target: nutrition?.target_fat ?? 0 },
  ]
  const firstName = (summary?.user_name || user?.name || '').split(' ')[0]
  const today = summary?.current_date_formatted ?? new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 19 ? 'Good afternoon' : 'Good evening'
  // The dashboard's routine estimate only describes the plan when both name the same workout.
  const duration = summary?.workout && summary.workout.title === plan?.title ? summary.workout.estimated_duration_minutes : null

  return (
    <div className="screen home-screen">
      <header className="home-header">
        <div>
          <p className="home-date">{today}</p>
          <h1 className="home-greeting">{greeting}{firstName ? `, ${firstName}` : ''}</h1>
        </div>
        <PremiumUpsellButton />
      </header>

      <h2 className="home-heading">Daily overview</h2>
      <div className="home-cards">
        <section className="home-card" aria-labelledby="home-nutrition" aria-busy={!nutrition}>
          <h2 className="home-card-label" id="home-nutrition">Nutrition</h2>
          <div className="home-nutrition">
            <div className="home-orb" role="img" aria-label={nutrition ? `${Math.round(consumed)} of ${kcalGoal} kcal eaten` : 'Loading your daily intake'}>
              <img src={orbImage} alt="" width={135.45} height={140.934} />
              <p className="home-orb-value" aria-hidden="true">
                <strong>{nutrition ? Math.round(consumed).toLocaleString('en-US') : '–'}</strong>
                <span>/{nutrition ? kcalGoal.toLocaleString('en-US') : '–'} kcal</span>
              </p>
            </div>
            <ul className="home-macros">
              {macros.map((macro) => (
                <li key={macro.label}>
                  <span className="home-macro-name">{macro.label}</span>
                  <span className="home-macro-value">
                    <strong>{nutrition ? Math.round(macro.current) : '–'}</strong>/{nutrition ? Math.round(macro.target) : '–'} g
                  </span>
                  <ProgressBar value={percent(macro.current, macro.target)} />
                </li>
              ))}
            </ul>
          </div>
          <div className="home-card-footer">
            <p className="home-caption">{nutrition ? `${Math.round(percent(consumed, kcalGoal) * 100)}% of goal` : ' '}</p>
            <button className="home-pill" type="button" onClick={() => navigate('/log-meals')}>Log a meal</button>
          </div>
        </section>

        <AiTipCard onApplied={() => fetchDashboardSummary({ forceRefresh: true }).then(setSummary).catch(() => undefined)} />

        <section className="home-card" aria-labelledby="home-activity" aria-busy={!summary}>
          <h2 className="home-card-label" id="home-activity">Activity</h2>
          {activity?.connected ? (
            <>
              <div className="home-activity">
                <ActivityStat value={activity.steps_today} average={activity.steps_avg_7d} unit="steps" />
                <ActivityStat value={activity.active_calories_today} average={activity.active_calories_avg_7d} unit="kcal" />
              </div>
              {activity.source === 'preview' && (
                <p className="home-caption">Browser preview activity. The Android app reads Health Connect directly.</p>
              )}
            </>
          ) : (
            <div className="home-card-footer">
              <p className="home-muted">Connect Health Connect so the AI trainer can read your steps and active calories.</p>
              <button className="home-pill" type="button" onClick={() => navigate('/profile')} disabled={!summary}>Connect</button>
            </div>
          )}
        </section>

        <section className="home-card" aria-labelledby="home-workout">
          <h2 className="home-card-label" id="home-workout">AI workout</h2>
          {!summary || (planning && !plan && !completedWorkoutToday) ? (
            // Same card shape straight away, so nothing jumps in later at the bottom of the page.
            <p className="home-muted" role="status" aria-busy="true">
              {summary ? "Planning today's workout…" : "Loading today's workout…"}
            </p>
          ) : completedWorkoutToday ? (
            <p className="home-plan-intro">Workout completed today<span>{completedWorkoutToday.name}</span></p>
          ) : plan?.is_rest_day ? (
            <>
              <p className="home-plan-intro">Rest day<span>Recovery recommended by your AI trainer</span></p>
              {plan.ai_reasoning && <p className="home-muted">{plan.ai_reasoning}</p>}
            </>
          ) : plan ? (
            <>
              <p className="home-plan-intro">Today's plan<span>based on your goals and progress</span></p>
              <div className="home-workout">
                <img className="home-workout-image" src={workoutImage} alt="" width={88} height={88} />
                <div className="home-workout-body">
                  <h3>{plan.title}</h3>
                  {plan.routine_id === null ? (
                    <span className="home-badge">AI generated</span>
                  ) : plan.ai_adjusted && <span className="home-badge">AI adjusted</span>}
                  <div className="home-workout-meta">
                    <p className="home-caption">
                      {duration ? <span>{duration} min</span> : null}
                      <span>{plan.exercises.length} exercises</span>
                    </p>
                    <button className="home-pill" type="button" onClick={() => navigate('/workouts/active', { state: {
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
                    } })}>Start</button>
                  </div>
                </div>
              </div>
              {plan.ai_adjusted && plan.ai_reasoning && <p className="home-muted">{plan.ai_reasoning}</p>}
            </>
          ) : (
            <div className="home-card-footer">
              <p className="home-muted">No workout scheduled for today.</p>
              <button className="home-pill" type="button" onClick={() => navigate('/workouts')}>Workouts</button>
            </div>
          )}
        </section>

        <HydrationSummary />
      </div>
    </div>
  )
}

export default Home
