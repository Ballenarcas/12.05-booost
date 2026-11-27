import { Trash2 } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  addHydrationEntry,
  cachedHydrationToday,
  fetchHydrationToday,
  rememberHydration,
  removeHydrationEntry,
  updateHydrationGoal,
  type HydrationEntry,
  type HydrationToday,
} from '../../services/api'
import { locale, t as translateNow, useT } from '../../i18n'
import '../../styles/hydration-summary.css'

const GLASS_ML = 250
const UNIT_LIMITS = { ml: 5000, glass: 20 } as const
const GOAL_MIN_ML = 500
const GOAL_MAX_ML = 10000

const format = (ml: number) => ml.toLocaleString(locale())

function entryLabel(entry: HydrationEntry): string {
  if (entry.unit === 'glass') {
    const glasses = entry.amount_ml / GLASS_ML
    const count = Number.isInteger(glasses) ? String(glasses) : glasses.toFixed(1)
    return translateNow(count === '1' ? 'hydration.glassOne' : 'hydration.glassMany', { count, ml: format(entry.amount_ml) })
  }
  return `${format(entry.amount_ml)} ml`
}

function entryTime(entry: HydrationEntry): string | null {
  if (!entry.created_at) return null
  const moment = new Date(entry.created_at)
  if (Number.isNaN(moment.getTime())) return null
  return moment.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

/**
 * The hydration card from the mockup: today's total and a one-tap glass. With `detailed` (Meals)
 * it also opens custom amounts, the daily goal and today's drinks, all on the same data.
 */
export default function HydrationSummary({ detailed = false }: { detailed?: boolean }) {
  const t = useT()
  // Shows the last known water straight away; the fresh copy replaces it when it arrives.
  const [data, setData] = useState<HydrationToday | null>(() => cachedHydrationToday())
  const [loaded, setLoaded] = useState(() => cachedHydrationToday() !== null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [unit, setUnit] = useState<'ml' | 'glass'>('ml')
  const [amount, setAmount] = useState('')
  const [editingGoal, setEditingGoal] = useState(false)
  const [goalInput, setGoalInput] = useState('')
  const id = useId()
  const labelId = `hydration-${id}`
  const moreId = `hydration-more-${id}`
  const goalInputId = `hydration-goal-${id}`

  useEffect(() => {
    let mounted = true
    fetchHydrationToday()
      .then((next) => mounted && setData(next))
      .catch((error: Error) => mounted && setNotice(error.message))
      .finally(() => mounted && setLoaded(true))
    return () => {
      mounted = false
    }
  }, [])

  // Every change goes through here, so the bar and the list never disagree.
  async function update(request: () => Promise<HydrationToday>, failure: string): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setNotice(null)
    try {
      setData(rememberHydration(await request()))
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : failure)
      return false
    } finally {
      setBusy(false)
    }
  }

  const addGlass = () => update(() => addHydrationEntry({ amount: 1, unit: 'glass' }), t('hydration.errorSave'))

  async function logDrink(event: FormEvent) {
    event.preventDefault()
    const value = Math.round(Number(amount.replace(',', '.')))
    const limit = UNIT_LIMITS[unit]
    if (!Number.isFinite(value) || value < 1 || value > limit) {
      setNotice(t(unit === 'ml' ? 'hydration.errorAmountMl' : 'hydration.errorAmountGlasses', { max: limit }))
      return
    }
    if (await update(() => addHydrationEntry({ amount: value, unit }), t('hydration.errorSave'))) setAmount('')
  }

  async function applyGoal(value: number | null) {
    if (value !== null && (!Number.isFinite(value) || value < GOAL_MIN_ML || value > GOAL_MAX_ML)) {
      setNotice(`Enter a goal between ${format(GOAL_MIN_ML)} and ${format(GOAL_MAX_ML)} ml.`)
      return
    }
    if (await update(() => updateHydrationGoal(value), t('hydration.errorGoal'))) setEditingGoal(false)
  }

  const progress = Math.min(100, data?.progress_percentage ?? 0)

  return (
    <section className="hifi-card" aria-labelledby={labelId} aria-busy={!loaded}>
      <h2 className="hifi-card-label" id={labelId}>{t('hydration.title')}</h2>
      <div
        className="home-water"
        role="progressbar"
        aria-label={t('hydration.waterToday')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span className="home-water-fill" style={{ width: `${progress}%` }} />
        <p className="home-water-value">
          <strong>{data ? format(data.total_ml) : '–'}</strong>
          <span>/{data ? format(data.goal_ml) : '–'} ml</span>
        </p>
      </div>
      <div className="hifi-card-footer">
        <p className="hifi-caption">
          {data ? (
            <>
              <span>{t('welcome.ofGoal', { value: data.progress_percentage })}</span>
              <span>{t('hydration.remaining', { ml: format(Math.max(0, data.remaining_ml)) })}</span>
            </>
          ) : (
            <span>{loaded ? t('hydration.unavailable') : ' '}</span>
          )}
        </p>
        <span className="hifi-card-actions">
          <Link className="hifi-text-link" to="/hydration/history">{t('hydration.history')}</Link>
          <button className="hifi-pill" type="button" onClick={addGlass} disabled={!data || busy} aria-label={t('hydration.addGlassAria')}>
            {t('hydration.addWater')}
          </button>
        </span>
      </div>

      {detailed && (
        <button
          className="hifi-link-button hydration-more-toggle"
          type="button"
          aria-expanded={moreOpen}
          aria-controls={moreId}
          onClick={() => setMoreOpen((open) => !open)}
          disabled={!data}
        >
          {moreOpen ? t('hydration.hideOptions') : t('hydration.moreOptions')}
        </button>
      )}

      {detailed && moreOpen && data && (
        <div className="hydration-more" id={moreId}>
          <form className="hydration-controls" onSubmit={logDrink}>
            <div className="hydration-unit-toggle" role="group" aria-label={t('hydration.logIn')}>
              <button type="button" aria-pressed={unit === 'ml'} onClick={() => { setUnit('ml'); setNotice(null) }}>{t('hydration.milliliters')}</button>
              <button type="button" aria-pressed={unit === 'glass'} onClick={() => { setUnit('glass'); setNotice(null) }}>{t('hydration.glasses')}</button>
            </div>
            <div className="hydration-amount-row">
              <input
                className="hydration-amount-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={UNIT_LIMITS[unit]}
                step={1}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder={unit === 'ml' ? t('hydration.placeholderMl') : t('hydration.placeholderGlasses')}
                aria-label={unit === 'ml' ? t('hydration.amountMl') : t('hydration.amountGlasses')}
              />
              <button className="hifi-pill" type="submit" disabled={busy || !amount.trim()}>{t('hydration.add')}</button>
            </div>
          </form>

          {editingGoal ? (
            <form className="hydration-goal-editor" onSubmit={(event) => { event.preventDefault(); void applyGoal(Math.round(Number(goalInput.replace(',', '.')))) }}>
              <label className="hydration-goal-title" htmlFor={goalInputId}>{t('hydration.dailyGoal')}</label>
              <div className="hydration-goal-editor-row">
                <input
                  id={goalInputId}
                  className="hydration-amount-input"
                  type="number"
                  inputMode="numeric"
                  min={GOAL_MIN_ML}
                  max={GOAL_MAX_ML}
                  step={50}
                  value={goalInput}
                  onChange={(event) => setGoalInput(event.target.value)}
                />
                <button className="hifi-pill" type="submit" disabled={busy || !goalInput.trim()}>{t('common.save')}</button>
              </div>
              <span className="hifi-card-actions">
                <button className="hifi-link-button" type="button" onClick={() => { void applyGoal(null) }} disabled={busy}>
                  {t('hydration.useRecommended', { ml: format(data.default_goal_ml) })}
                </button>
                <button className="hifi-link-button" type="button" onClick={() => { setEditingGoal(false); setNotice(null) }} disabled={busy}>{t('common.cancel')}</button>
              </span>
            </form>
          ) : (
            <button
              className="hifi-link-button"
              type="button"
              onClick={() => { setGoalInput(String(data.goal_ml)); setNotice(null); setEditingGoal(true) }}
              disabled={busy}
            >
              {t(data.goal_ml !== data.default_goal_ml ? 'hydration.editGoalCustom' : 'hydration.editGoal', { ml: format(data.goal_ml) })}
            </button>
          )}

          {data.entries.length === 0 ? (
            <p className="hifi-muted">{t('hydration.none')}</p>
          ) : (
            <ul className="hydration-entries" aria-label={t('hydration.loggedToday')}>
              {data.entries.map((entry) => (
                <li className="hydration-entry" key={entry.id}>
                  <span className="hydration-entry-meta">
                    <span className="hydration-entry-amount">{entryLabel(entry)}</span>
                    {entryTime(entry) && <span className="hydration-entry-time">{entryTime(entry)}</span>}
                  </span>
                  <button
                    type="button"
                    className="hydration-entry-remove"
                    onClick={() => update(() => removeHydrationEntry(entry.id), t('hydration.errorRemove'))}
                    disabled={busy}
                    aria-label={t('hydration.removeAria', { label: entryLabel(entry) })}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {notice && <p className="form-error" role="alert">{notice}</p>}
    </section>
  )
}
