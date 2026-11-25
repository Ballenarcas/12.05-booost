import { Link } from 'react-router-dom'
import IntakeCard from '../components/nutrition/IntakeCard'
import WorkoutPhoto from '../components/workout/WorkoutPhoto'
import '../styles/welcome.css'

function Welcome() {
  return (
    <main className="welcome-screen hifi-theme">
      <p className="welcome-mark">BOOOST</p>

      {/* A still of the Home screen with sample numbers, so people see the app before signing up. */}
      <div className="welcome-preview" aria-hidden="true" inert>
        <IntakeCard
          label="Nutrition"
          consumed={1545}
          goal={2400}
          pending={false}
          macros={[
            { label: 'Protein', current: 92, target: 150 },
            { label: 'Carbs', current: 180, target: 280 },
            { label: 'Fat', current: 48, target: 75 },
          ]}
          footer={<p className="hifi-caption">64% of goal</p>}
        />
        <div className="hifi-card welcome-workout">
          <span className="hifi-card-label">AI workout</span>
          <div className="welcome-workout-row">
            <WorkoutPhoto name="Upper body strength" exercises={[]} size={64} />
            <span className="welcome-workout-copy">
              <strong>Upper body strength</strong>
              <span className="hifi-caption">50 min · 6 exercises</span>
            </span>
          </div>
        </div>
      </div>

      <section className="welcome-hero" aria-labelledby="welcome-title">
        <h1 id="welcome-title">Train with purpose.<br />Eat with clarity.</h1>
        <p>Log your workouts and meals in one place, with a plan that follows your progress.</p>
      </section>

      <div className="welcome-actions">
        <Link className="hifi-pill is-big welcome-start" to="/onboarding">Get started</Link>
        <Link className="hifi-pill is-big welcome-login" to="/login">I have an account · Log in</Link>
      </div>
    </main>
  )
}

export default Welcome
