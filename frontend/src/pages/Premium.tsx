import { BookOpen, Camera, Check, Crown, Dumbbell, Loader2, TrendingUp, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { usePageNavigate } from '../utils/usePageNavigate'
import {
  getCurrentUser,
  isPremiumActive,
  purchasePremium,
  type PremiumStatus,
} from '../services/api'
import type { PremiumPlan } from '../types'
import { locale, t as tr, useT, type MessageKey } from '../i18n'
import '../styles/premium.css'

interface PremiumFeature {
  title: MessageKey
  description: MessageKey
  Icon: LucideIcon
}

const FEATURES: PremiumFeature[] = [
  {
    title: 'premiumPage.f1Title',
    description: 'premiumPage.f1Body',
    Icon: Dumbbell,
  },
  {
    title: 'premiumPage.f2Title',
    description: 'premiumPage.f2Body',
    Icon: Camera,
  },
  {
    title: 'premiumPage.f3Title',
    description: 'premiumPage.f3Body',
    Icon: BookOpen,
  },
  {
    title: 'premiumPage.f4Title',
    description: 'premiumPage.f4Body',
    Icon: TrendingUp,
  },
]

function formatEndDate(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' })
}

function planLabel(plan: string | null | undefined): string {
  return plan === 'monthly' ? tr('profile.planMonthly') : tr('profile.planAnnual')
}

interface PremiumConfirmationProps {
  plan: string | null | undefined
  expiresAt: string | null | undefined
  isNew: boolean
  onContinue: () => void
}

function PremiumConfirmation({ plan, expiresAt, isNew, onContinue }: PremiumConfirmationProps) {
  const t = useT()
  const formattedExpiry = formatEndDate(expiresAt)
  return (
    <div className="premium-success">
      <div className="premium-success-icon"><Check size={30} strokeWidth={3} aria-hidden="true" /></div>
      <p className="eyebrow">{isNew ? t('premiumPage.unlocked') : t('premiumPage.yourMembership')}</p>
      <h1>{isNew ? t('premiumPage.allSet') : t('premiumPage.isActive')}</h1>
      <p>
        {formattedExpiry
          ? t('premiumPage.activeUntil', { plan: planLabel(plan), date: formattedExpiry })
          : t('premiumPage.active', { plan: planLabel(plan) })}
      </p>
      <button className="premium-cta" type="button" onClick={onContinue}>{t('premiumPage.startTraining')}</button>
    </div>
  )
}

function Premium() {
  const t = useT()
  const navigate = usePageNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  const user = getCurrentUser()
  const alreadyPremium = isPremiumActive(user)

  const [purchasing, setPurchasing] = useState<PremiumPlan | null>(null)
  const [purchase, setPurchase] = useState<PremiumStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const goBack = () => {
    navigate(from && from !== '/premium' ? from : '/', { replace: true })
  }

  const buy = async (plan: PremiumPlan) => {
    if (purchasing) return
    setError(null)
    setNotice(null)
    setPurchasing(plan)
    try {
      setPurchase(await purchasePremium(plan))
    } catch (purchaseError) {
      const timedOut = purchaseError instanceof Error
        && (purchaseError.name === 'TimeoutError' || purchaseError.name === 'AbortError')
      setError(
        timedOut
          ? t('premiumPage.timedOut')
          : purchaseError instanceof Error
            ? purchaseError.message
            : t('premiumPage.errorActivate'),
      )
    } finally {
      setPurchasing(null)
    }
  }

  if (purchase || alreadyPremium) {
    return (
      <div className="premium-screen">
        <button className="premium-close" type="button" onClick={goBack} aria-label={t('premiumPage.close')}>
          <X size={19} aria-hidden="true" />
        </button>
        <PremiumConfirmation
          plan={purchase?.plan ?? user?.premium_plan}
          expiresAt={purchase?.expires_at ?? user?.premium_expires_at}
          isNew={purchase !== null}
          onContinue={goBack}
        />
      </div>
    )
  }

  return (
    <div className="premium-screen">
      <button className="premium-close" type="button" onClick={goBack} aria-label={t('premiumPage.close')}>
        <X size={19} aria-hidden="true" />
      </button>

      <header className="premium-heading">
        <p className="premium-kicker"><Crown size={13} aria-hidden="true" /> BOOOST Premium</p>
        <h1>{t('premiumPage.title1')}<br />{t('premiumPage.title2')}</h1>
        <p className="premium-mock-note">{t('premiumPage.mock')}</p>
      </header>

      <ul className="premium-features" aria-label={t('premiumPage.features')}>
        {FEATURES.map(({ title, description, Icon }) => (
          <li className="premium-feature" key={title}>
            <span className="premium-feature-icon" aria-hidden="true"><Icon size={21} /></span>
            <div>
              <h3>{t(title)}</h3>
              <p>{t(description)}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="premium-plans" role="group" aria-label={t('premiumPage.choosePlan')}>
        <article className="premium-plan is-featured">
          <span className="premium-plan-badge">{t('premiumPage.bestValue')}</span>
          <h2>{t('profile.planAnnual')}</h2>
          <p className="premium-price"><span>€79.99</span><small>{t('premiumPage.perYear')}</small></p>
          <p className="premium-price-note">{t('premiumPage.annualNote')}</p>
          <button
            className="premium-cta"
            type="button"
            onClick={() => buy('annual')}
            disabled={purchasing !== null}
          >
            {purchasing === 'annual'
              ? <><Loader2 className="premium-spinner" size={15} aria-hidden="true" /> {t('premiumPage.activating')}</>
              : t('premiumPage.freeTrial')}
          </button>
        </article>

        <article className="premium-plan">
          <h2>{t('profile.planMonthly')}</h2>
          <p className="premium-price"><span>€9.99</span><small>{t('premiumPage.perMonth')}</small></p>
          <p className="premium-price-note">{t('premiumPage.monthlyNote')}</p>
          <button
            className="premium-cta is-secondary"
            type="button"
            onClick={() => buy('monthly')}
            disabled={purchasing !== null}
          >
            {purchasing === 'monthly'
              ? <><Loader2 className="premium-spinner" size={15} aria-hidden="true" /> {t('premiumPage.activating')}</>
              : t('premiumPage.subscribe')}
          </button>
        </article>
      </div>

      <p className="premium-trial-note">
        <Check size={13} aria-hidden="true" /> {t('premiumPage.trialNote')}
      </p>

      {error && <p className="premium-error" role="alert">{error}</p>}
      {notice && <p className="premium-notice" role="status">{notice}</p>}

      <nav className="premium-links" aria-label={t('premiumPage.info')}>
        <button
          type="button"
          onClick={() => setNotice(t('premiumPage.mockLegal'))}
        >
          {t('premiumPage.terms')}
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => setNotice(t('premiumPage.mockLegal'))}
        >
          {t('premiumPage.privacy')}
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => setNotice(
            isPremiumActive()
              ? t('premiumPage.alreadyActive')
              : t('premiumPage.noPurchase'),
          )}
        >
          {t('premiumPage.restore')}
        </button>
      </nav>

      <button className="premium-skip" type="button" onClick={goBack}>{t('premiumPage.limited')}</button>
    </div>
  )
}

export default Premium
