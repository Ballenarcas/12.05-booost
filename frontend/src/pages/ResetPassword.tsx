import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, Eye, EyeOff } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { confirmPasswordReset } from '../services/api'
import { describeError } from '../utils/errors.js'
import { useT } from '../i18n'
import '../styles/onboarding.css'
import '../styles/login.css'

const MIN_PASSWORD_LENGTH = 12

function readResetToken(): string {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  const hashToken = new URLSearchParams(hash).get('token')
  if (hashToken) return hashToken
  return new URLSearchParams(window.location.search).get('token') ?? ''
}

function ResetPassword() {
  const t = useT()
  const navigate = useNavigate()
  // Read once, then dropped from the address bar so the token isn't kept in history.
  const [token] = useState(readResetToken)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [notice, setNotice] = useState('')
  // Set when the server refused the reset: offer a new link instead of matching its wording.
  const [linkFailed, setLinkFailed] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (window.location.search || window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password !== confirm) {
      setLinkFailed(false)
      setNotice(t('reset.mismatch'))
      return
    }
    setIsSubmitting(true)
    setNotice('')
    try {
      const message = await confirmPasswordReset(token, password)
      navigate('/login', { replace: true, state: { notice: message } })
    } catch (error) {
      setLinkFailed(true)
      setNotice(describeError(error, t('reset.errorUpdate')))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="onboarding-container hifi-theme login-container">
      <div className="onboarding-content login-content">
        <div className="login-mark">BOOOST</div>
        <header className="onboarding-header login-header">
          <h1 className="onboarding-title">{t('reset.newTitle')}</h1>
          <p className="onboarding-subtitle">{t('reset.minLength', { count: MIN_PASSWORD_LENGTH })}</p>
        </header>

        {!token ? (
          <div className="login-form">
            <p className="login-notice" role="alert">{t('reset.missingCode')}</p>
            <div className="onboarding-actions login-actions">
              <Link className="btn-primary-outline" to="/forgot-password">{t('reset.askNewLink')}</Link>
            </div>
          </div>
        ) : (
          <form className="onboarding-form login-form" onSubmit={handleSubmit}>
            <div className="form-field">
              <label htmlFor="new-password" className="form-label">{t('reset.newPassword')}</label>
              <div className="input-wrapper">
                <input
                  id="new-password"
                  className="form-input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  maxLength={128}
                  value={password}
                  onChange={(event) => { setPassword(event.target.value); setNotice('') }}
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
            </div>
            <div className="form-field">
              <label htmlFor="confirm-password" className="form-label">{t('reset.repeatPassword')}</label>
              <input
                id="confirm-password"
                className="form-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={128}
                value={confirm}
                onChange={(event) => { setConfirm(event.target.value); setNotice('') }}
              />
            </div>
            <div className="onboarding-actions login-actions">
              <button type="submit" className="btn-primary-outline" disabled={isSubmitting}>
                {isSubmitting ? t('common.saving') : t('reset.savePassword')}
              </button>
              <Link className="btn-secondary-outline login-back-link" to="/login">
                <ArrowLeft size={17} aria-hidden="true" /> {t('reset.backToSignIn')}
              </Link>
            </div>
            {notice && (
              <p className="login-notice" role="alert">
                {notice} {linkFailed && <Link to="/forgot-password">{t('reset.askNewLink')}</Link>}
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  )
}

export default ResetPassword
