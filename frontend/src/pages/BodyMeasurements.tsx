import { useState } from 'react'
import {
  BODY_COMPOSITION_PREVIEW,
  BODY_MEASUREMENTS_PREVIEW,
} from '../data/profileMockups'
import { getCurrentUser } from '../services/api'
import { usePageNavigate } from '../utils/usePageNavigate'
import backIcon from '../assets/scan/back.svg'
import { useT, valueLabel } from '../i18n'
import '../styles/profile.css'

type Unit = 'cm' | 'in'

function formatMeasure(cm: number, unit: Unit): string {
  const val = unit === 'cm' ? cm : cm / 2.54
  return `${val.toFixed(1)} ${unit}`
}

function formatDelta(deltaCm: number, unit: Unit): string {
  const val = unit === 'cm' ? deltaCm : deltaCm / 2.54
  const prefix = val >= 0 ? '+' : ''
  return `${prefix}${val.toFixed(1)} ${unit}`
}

export default function BodyMeasurements() {
  const t = useT()
  const user = getCurrentUser()
  const navigate = usePageNavigate()
  const [unit, setUnit] = useState<Unit>('cm')
  const [previewNotice, setPreviewNotice] = useState<string | null>(null)

  const weightKg = typeof user?.weight === 'number' && user.weight > 0 ? user.weight : null
  const heightCm = typeof user?.height === 'number' && user.height > 0 ? user.height : null
  const bmi = weightKg && heightCm ? weightKg / ((heightCm / 100) ** 2) : null

  return (
    <div className="screen hifi-screen hifi-theme measurements-screen">
      <header className="friends-header">
        <button
          type="button"
          className="scan-back"
          aria-label={t('body.back')}
          onClick={() => navigate('/profile', { direction: 'back' })}
        >
          <img src={backIcon} alt="" width={36} height={37} />
        </button>
        <h1>{t('profile.bodyMeasurements')}</h1>
        <div className="measurements-unit-toggle" role="group" aria-label={t('body.unit')}>
          <button type="button" aria-pressed={unit === 'cm'} onClick={() => setUnit('cm')}>
            cm
          </button>
          <button type="button" aria-pressed={unit === 'in'} onClick={() => setUnit('in')}>
            in
          </button>
        </div>
      </header>

      <div className="preview-banner" role="note">
        <strong>{t('common.comingSoon')}</strong>
        <span>{t('body.sample')}</span>
      </div>

      <section className="hifi-section" aria-labelledby="comp-title">
        <div className="profile-section-head">
          <h2 className="hifi-section-title" id="comp-title">{t('body.composition')}</h2>
          <span className="profile-section-since">{t('body.previewTag')}</span>
        </div>

        <div className="profile-progress-grid">
          <div className="profile-preview-card">
            <div className="profile-stat-top">
              <span className="profile-stat-label">{t('body.muscle')}</span>
              <span className="profile-soon-tag">{t('body.soonTag')}</span>
            </div>
            <p className="profile-stat-val">
              {BODY_COMPOSITION_PREVIEW.muscleMassPct.toFixed(1)}
              <small>%</small>
            </p>
          </div>
          <div className="profile-preview-card">
            <div className="profile-stat-top">
              <span className="profile-stat-label">{t('body.bodyFat')}</span>
              <span className="profile-soon-tag">{t('body.soonTag')}</span>
            </div>
            <p className="profile-stat-val">
              {BODY_COMPOSITION_PREVIEW.bodyFatPct.toFixed(1)}
              <small>%</small>
            </p>
          </div>
          <div className="profile-preview-card">
            <span className="profile-stat-label">{t('body.weight')}</span>
            <p className="profile-stat-val">
              {weightKg !== null ? weightKg.toFixed(1) : '–'}
              {weightKg !== null && <small>kg</small>}
            </p>
          </div>
          <div className="profile-preview-card">
            <span className="profile-stat-label">{t('body.bmi')}</span>
            <p className="profile-stat-val">
              {bmi !== null ? bmi.toFixed(1) : '–'}
            </p>
          </div>
        </div>
      </section>

      <section className="hifi-section" aria-labelledby="trend-title">
        <h2 className="hifi-section-title" id="trend-title">{t('body.trend')}</h2>
        <div className="hifi-card">
          <ul className="measurements-trend-list">
            {BODY_COMPOSITION_PREVIEW.checkins.map((item) => (
              <li className="measurements-trend-row" key={item.month}>
                <span>{item.month}</span>
                <div className="measurements-trend-bars" aria-hidden="true">
                  <span className="hifi-bar">
                    <span style={{ width: `${Math.min(100, item.musclePct * 1.8)}%` }} />
                  </span>
                </div>
                <span>{item.musclePct}% M · {item.fatPct}% F</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="hifi-section" aria-labelledby="tape-title">
        <div className="profile-section-head">
          <h2 className="hifi-section-title" id="tape-title">{t('body.tape')}</h2>
          <button
            type="button"
            className="hifi-pill"
            onClick={() =>
              setPreviewNotice(t('body.tapeSoon'))
            }
          >
            {t('body.logMeasurement')}
          </button>
        </div>

        {previewNotice && (
          <div className="preview-banner" role="status">
            <span>{previewNotice}</span>
          </div>
        )}

        <div className="hifi-card">
          <ul className="measurements-tape-list">
            {BODY_MEASUREMENTS_PREVIEW.map((entry) => (
              <li className="measurements-tape-row" key={entry.id}>
                <span className="measurements-tape-name">{valueLabel(t, 'tape', entry.id) === entry.id ? entry.label : valueLabel(t, 'tape', entry.id)}</span>
                <span className="measurements-tape-right">
                  <span className="measurements-tape-val">{formatMeasure(entry.cm, unit)}</span>
                  <span
                    className={`measurements-tape-delta${
                      (entry.id === 'waist' ? entry.deltaCm < 0 : entry.deltaCm > 0) ? ' is-positive' : ''
                    }`}
                  >
                    {formatDelta(entry.deltaCm, unit)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}
