import { useState, type FormEvent } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { requestPasswordReset } from '../services/api'
import { describeError } from '../utils/errors.js'
import { useT } from '../i18n'
import '../styles/onboarding.css'
import '../styles/login.css'

function ForgotPassword() {
  const t = useT()
  const location = useLocation()
  const [email, setEmail] = useState((location.state as { email?: string } | null)?.email ?? '')
  const [sentMessage, setSentMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsSubmitting(true)
    setNotice('')
    try {
      setSentMessage(await requestPasswordReset(email))
    } catch (error) {
      setNotice(describeError(error, t('reset.errorSend')))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="onboarding-container hifi-theme login-container">
      <div className="onboarding-content login-content">
        <div className="login-mark">BOOOST</div>
        <header className="onboarding-header login-header">
          <h1 className="onboarding-title">{t('reset.forgotTitle')}</h1>
          <p className="onboarding-subtitle">
            {sentMessage
              ? t('reset.checkInbox')
              : t('reset.enterEmail')}
          </p>
        </header>

        {sentMessage ? (
          <div className="login-form">
            <p className="login-notice" role="status">{sentMessage}</p>
            <div className="onboarding-actions login-actions">
              <Link className="btn-secondary-outline login-back-link" to="/login">
                <ArrowLeft size={17} aria-hidden="true" /> {t('reset.backToSignIn')}
              </Link>
            </div>
          </div>
        ) : (
          <form className="onboarding-form login-form" onSubmit={handleSubmit}>
            <div className="form-field">
              <label htmlFor="reset-email" className="form-label">{t('login.email')}</label>
              <input
                id="reset-email"
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
            <div className="onboarding-actions login-actions">
              <button type="submit" className="btn-primary-outline" disabled={isSubmitting}>
                {isSubmitting ? t('reset.sending') : t('reset.sendLink')}
              </button>
              <Link className="btn-secondary-outline login-back-link" to="/login">
                <ArrowLeft size={17} aria-hidden="true" /> {t('reset.backToSignIn')}
              </Link>
            </div>
            {notice && <p className="login-notice" role="alert">{notice}</p>}
          </form>
        )}
      </div>
    </main>
  )
}

export default ForgotPassword
