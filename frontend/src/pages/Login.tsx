import { useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { usePageNavigate } from '../utils/usePageNavigate'
import { loginUser } from '../services/api'
import { describeError } from '../utils/errors.js'
import type { UserProfile } from '../types'
import LanguageSwitch from '../components/ui/LanguageSwitch'
import { useT } from '../i18n'
import '../styles/onboarding.css'
import '../styles/login.css'

function Login() {
  const t = useT()
  const navigate = usePageNavigate()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const location = useLocation()
  // Set when the user arrives from a successful password reset.
  const [notice, setNotice] = useState((location.state as { notice?: string } | null)?.notice ?? '')
  const [email, setEmail] = useState('')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsSubmitting(true)
    setNotice('')
    const formData = new FormData(event.currentTarget)
    try {
      const signedInProfile = await loginUser(
        String(formData.get('email') ?? ''),
        String(formData.get('password') ?? ''),
      )
      setProfile(signedInProfile)
      window.setTimeout(() => navigate('/'), 1600)
    } catch (error) {
      setNotice(describeError(error, t('login.errorSignIn')))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (profile) {
    return (
      <main className="onboarding-container hifi-theme login-container">
        <div className="completion-overlay">
          <div className="completion-icon-wrapper"><Check size={34} aria-hidden="true" /></div>
          <h1 className="onboarding-title">{t('login.welcomeName', { name: profile.name })}</h1>
          <p className="onboarding-subtitle">{t('login.planReady')}</p>
        </div>
      </main>
    )
  }

  return (
    <main className="onboarding-container hifi-theme login-container">
      <div className="onboarding-content login-content">
        <div className="login-top">
          <div className="login-mark">BOOOST</div>
          <LanguageSwitch />
        </div>
        <header className="onboarding-header login-header">
          <h1 className="onboarding-title">{t('login.title')}</h1>
          <p className="onboarding-subtitle">{t('login.subtitle')}</p>
        </header>

        <form className="onboarding-form login-form" onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="login-email" className="form-label">{t('login.email')}</label>
            <input
              id="login-email"
              name="email"
              className="form-input"
              type="email"
              placeholder={t('login.emailPlaceholder')}
              autoComplete="email"
              required
              maxLength={255}
              value={email}
              onChange={(event) => { setEmail(event.target.value); setNotice('') }}
            />
          </div>

          <div className="form-field">
            <label htmlFor="login-password" className="form-label">{t('login.password')}</label>
            <div className="input-wrapper">
              <input
                id="login-password"
                name="password"
                className="form-input"
                type={showPassword ? 'text' : 'password'}
                placeholder={t('login.passwordPlaceholder')}
                autoComplete="current-password"
                required
                maxLength={1024}
                onChange={() => setNotice('')}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
              >
                {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </div>
            <Link className="login-forgot-link" to="/forgot-password" state={{ email }}>{t('login.forgot')}</Link>
          </div>

          <div className="onboarding-actions login-actions">
            <button type="submit" className="btn-primary-outline" disabled={isSubmitting}>
              {isSubmitting ? t('login.signingIn') : <>{t('login.signIn')} <ArrowRight size={18} aria-hidden="true" /></>}
            </button>
            <Link className="btn-secondary-outline login-back-link" to="/welcome">
              <ArrowLeft size={17} aria-hidden="true" /> {t('login.backToWelcome')}
            </Link>
          </div>
          {notice && <p className="login-notice" role="alert">{notice}</p>}
        </form>
      </div>

      <p className="login-create-prompt">
        {t('login.newHere')} <Link to="/onboarding">{t('login.createProfile')}</Link>
      </p>
    </main>
  )
}

export default Login
