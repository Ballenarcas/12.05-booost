import { Link } from 'react-router-dom'
import IntakeCard from '../components/nutrition/IntakeCard'
import WorkoutPhoto from '../components/workout/WorkoutPhoto'
import LanguageSwitch from '../components/ui/LanguageSwitch'
import { useT } from '../i18n'
import '../styles/welcome.css'

function Welcome() {
  const t = useT()
  return (
    <main className="welcome-screen hifi-theme">
      <header className="welcome-top">
        <p className="welcome-mark">BOOOST</p>
        <LanguageSwitch />
      </header>

      {/* A still of the Home screen with sample numbers, so people see the app before signing up. */}
      <div className="welcome-preview" aria-hidden="true" inert>
        <IntakeCard
          label={t('welcome.nutrition')}
          consumed={1545}
          goal={2400}
          pending={false}
          macros={[
            { label: t('macro.protein'), current: 92, target: 150 },
            { label: t('macro.carbs'), current: 180, target: 280 },
            { label: t('macro.fat'), current: 48, target: 75 },
          ]}
          footer={<p className="hifi-caption">{t('welcome.ofGoal', { value: 64 })}</p>}
        />
        <div className="hifi-card welcome-workout">
          <span className="hifi-card-label">{t('welcome.aiWorkout')}</span>
          <div className="welcome-workout-row">
            <WorkoutPhoto name={t('welcome.sampleWorkout')} exercises={[]} size={64} />
            <span className="welcome-workout-copy">
              <strong>{t('welcome.sampleWorkout')}</strong>
              <span className="hifi-caption">{t('welcome.sampleWorkoutMeta')}</span>
            </span>
          </div>
        </div>
      </div>

      <section className="welcome-hero" aria-labelledby="welcome-title">
        <h1 id="welcome-title">{t('welcome.title1')}<br />{t('welcome.title2')}</h1>
        <p>{t('welcome.subtitle')}</p>
      </section>

      <div className="welcome-actions">
        <Link className="hifi-pill is-big welcome-start" to="/onboarding">{t('welcome.getStarted')}</Link>
        <Link className="hifi-pill is-big welcome-login" to="/login">{t('welcome.haveAccount')}</Link>
      </div>
    </main>
  )
}

export default Welcome
