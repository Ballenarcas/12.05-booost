import { useEffect, useState } from 'react'
import { usePageNavigate } from '../utils/usePageNavigate'
import AiTipCard from '../components/home/AiTipCard'
import WeekActivity from '../components/home/WeekActivity'
import DailyIntake from '../components/nutrition/DailyIntake'
import HydrationCard from '../components/home/HydrationCard'
import PremiumUpsellButton from '../components/premium/PremiumUpsellButton'
import { fetchDashboardSummary, getCachedDashboardSummary, getCurrentUser, planTodaysWorkout, type DashboardSummary } from '../services/api'
import { describeError } from '../utils/errors.js'

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
  // tip and activity load at the same time instead of after it.
  const nutrition = summary?.nutrition
  const plan = summary?.plan
  const completedWorkoutToday = summary?.completed_workout_today
  const activity = summary?.activity
  const macros = [
    { label: 'Protein', current: nutrition?.current_protein ?? 0, target: nutrition?.target_protein ?? 0 },
    { label: 'Carbs', current: nutrition?.current_carbs ?? 0, target: nutrition?.target_carbs ?? 0 },
    { label: 'Fat', current: nutrition?.current_fat ?? 0, target: nutrition?.target_fat ?? 0 },
  ]
  const firstName = (summary?.user_name || user?.name || '').split(' ')[0]
  const today = summary?.current_date_formatted ?? new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' })

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">{today}</p>
          <h1>Hello, {firstName}</h1>
        </div>
        <PremiumUpsellButton />
      </header>

      <section className="section" aria-labelledby="nutrition-summary">
        <div className="section-heading">
          <h2 className="section-title" id="nutrition-summary">Nutrition</h2>
          <button className="text-link" type="button" onClick={() => navigate('/log-meals')}>Log a meal</button>
        </div>
        <DailyIntake
          consumed={nutrition ? nutrition.target_kcals - nutrition.remaining_kcals : 0}
          goal={nutrition?.target_kcals ?? 0}
          macros={macros}
          pending={!nutrition}
        />
      </section>

      {user?.id && (
        <section className="section" aria-labelledby="activity-summary">
          <div className="section-heading">
            <h2 className="section-title" id="activity-summary">Activity</h2>
            <button className="text-link" type="button" onClick={() => navigate('/workouts')}>Log a workout</button>
          </div>
          <WeekActivity userId={user.id} />
        </section>
      )}

      <section className="section" aria-labelledby="trainer-insight">
        <h2 className="section-title" id="trainer-insight">Recommended for you</h2>
        <AiTipCard onApplied={() => fetchDashboardSummary({ forceRefresh: true }).then(setSummary).catch(() => undefined)} />
      </section>

      <section className="section" aria-labelledby="daily-steps">
        <h2 className="section-title" id="daily-steps">Steps</h2>
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
              <p className="activity-note">Browser preview activity. The Android app reads Health Connect directly.</p>
            )}
          </div>
        ) : (
          <div className="card activity-card activity-empty">
            <div>
              <h3>Bring your steps into the plan</h3>
              <p>Connect Health Connect so the AI trainer can read steps and active calories.</p>
            </div>
            <button className="secondary-action" type="button" onClick={() => navigate('/profile')}>
              Connect
            </button>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="hydration-summary">
        <h2 className="section-title" id="hydration-summary">Hydration</h2>
        <HydrationCard />
      </section>

      <section className="section" aria-labelledby="programmed-training">
        <h2 className="section-title" id="programmed-training">Today's set</h2>
        {!summary || (planning && !plan && !completedWorkoutToday) ? (
          // Same card shape straight away, so nothing jumps in later at the bottom of the page.
          <div className="card training-card empty-state" role="status" aria-busy="true">
            {summary ? "Planning today's workout…" : "Loading today's workout…"}
          </div>
        ) : completedWorkoutToday ? (
          <div className="card training-card">
            <div className="scheduled-training-heading">
              <h3>Workout completed today</h3>
            </div>
            <p className="training-meta">{completedWorkoutToday.name}</p>
          </div>
        ) : plan ? (
          plan.is_rest_day ? (
            <div className="card training-card">
              <div className="scheduled-training-heading">
                <h3>Rest day</h3>
              </div>
              <p className="training-meta">Recovery recommended by your AI trainer</p>
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
            <p className="training-meta">{plan.exercises.length} exercises</p>
            {plan.exercises.length > 0 && (
              <ul className="scheduled-exercises" aria-label="Planned exercises and sets">
                {plan.exercises.map((exercise) => (
                  <li key={exercise.exercise_id}>
                    <span>{exercise.name}</span>
                    <span className="scheduled-exercise-sets">{exercise.sets} × {exercise.reps}{exercise.previous_weight_kg ? ` · ${exercise.previous_weight_kg} kg` : ''}</span>
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
            } })}>Start workout</button>
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
