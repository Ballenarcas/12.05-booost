import { Trash2 } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  addHydrationEntry,
  fetchHydrationToday,
  removeHydrationEntry,
  updateHydrationGoal,
  type HydrationEntry,
  type HydrationToday,
} from '../../services/api'
import '../../styles/hydration-summary.css'

const GLASS_ML = 250
const UNIT_LIMITS = { ml: 5000, glass: 20 } as const
const GOAL_MIN_ML = 500
const GOAL_MAX_ML = 10000

const format = (ml: number) => ml.toLocaleString('en-US')

function entryLabel(entry: HydrationEntry): string {
  if (entry.unit === 'glass') {
    const glasses = entry.amount_ml / GLASS_ML
    const count = Number.isInteger(glasses) ? String(glasses) : glasses.toFixed(1)
    return `${count} ${count === '1' ? 'glass' : 'glasses'} · ${format(entry.amount_ml)} ml`
  }
  return `${format(entry.amount_ml)} ml`
}

function entryTime(entry: HydrationEntry): string | null {
  if (!entry.created_at) return null
  const moment = new Date(entry.created_at)
  if (Number.isNaN(moment.getTime())) return null
  return moment.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The hydration card from the mockup: today's total and a one-tap glass. With `detailed` (Meals)
 * it also opens custom amounts, the daily goal and today's drinks, all on the same data.
 */
export default function HydrationSummary({ detailed = false }: { detailed?: boolean }) {
  const [data, setData] = useState<HydrationToday | null>(null)
  const [loaded, setLoaded] = useState(false)
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
      setData(await request())
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : failure)
      return false
    } finally {
      setBusy(false)
    }
  }

  const addGlass = () => update(() => addHydrationEntry({ amount: 1, unit: 'glass' }), "We couldn't save this drink.")

  async function logDrink(event: FormEvent) {
    event.preventDefault()
    const value = Math.round(Number(amount.replace(',', '.')))
    const limit = UNIT_LIMITS[unit]
    if (!Number.isFinite(value) || value < 1 || value > limit) {
      setNotice(`Enter an amount between 1 and ${limit} ${unit === 'ml' ? 'ml' : 'glasses'}.`)
      return
    }
    if (await update(() => addHydrationEntry({ amount: value, unit }), "We couldn't save this drink.")) setAmount('')
  }

  async function applyGoal(value: number | null) {
    if (value !== null && (!Number.isFinite(value) || value < GOAL_MIN_ML || value > GOAL_MAX_ML)) {
      setNotice(`Enter a goal between ${format(GOAL_MIN_ML)} and ${format(GOAL_MAX_ML)} ml.`)
      return
    }
    if (await update(() => updateHydrationGoal(value), "We couldn't update your hydration goal.")) setEditingGoal(false)
  }

  const progress = Math.min(100, data?.progress_percentage ?? 0)

  return (
    <section className="hifi-card" aria-labelledby={labelId} aria-busy={!loaded}>
      <h2 className="hifi-card-label" id={labelId}>Hydration</h2>
      <div
        className="home-water"
        role="progressbar"
        aria-label="Water today"
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
              <span>{data.progress_percentage}% of goal</span>
              <span>{format(Math.max(0, data.remaining_ml))} ml remaining</span>
            </>
          ) : (
            <span>{loaded ? 'Hydration unavailable' : ' '}</span>
          )}
        </p>
        <span className="hifi-card-actions">
          <Link className="hifi-text-link" to="/hydration/history">History</Link>
          <button className="hifi-pill" type="button" onClick={addGlass} disabled={!data || busy} aria-label="Add water, one glass (250 ml)">
            Add water
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
          {moreOpen ? 'Hide options' : 'Custom amount & goal'}
        </button>
      )}

      {detailed && moreOpen && data && (
        <div className="hydration-more" id={moreId}>
          <form className="hydration-controls" onSubmit={logDrink}>
            <div className="hydration-unit-toggle" role="group" aria-label="Log water in">
              <button type="button" aria-pressed={unit === 'ml'} onClick={() => { setUnit('ml'); setNotice(null) }}>Milliliters</button>
              <button type="button" aria-pressed={unit === 'glass'} onClick={() => { setUnit('glass'); setNotice(null) }}>Glasses (250 ml)</button>
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
                placeholder={unit === 'ml' ? 'e.g. 500' : 'e.g. 2'}
                aria-label={unit === 'ml' ? 'Amount in milliliters' : 'Number of glasses'}
              />
              <button className="hifi-pill" type="submit" disabled={busy || !amount.trim()}>Add</button>
            </div>
          </form>

          {editingGoal ? (
            <form className="hydration-goal-editor" onSubmit={(event) => { event.preventDefault(); void applyGoal(Math.round(Number(goalInput.replace(',', '.')))) }}>
              <label className="hydration-goal-title" htmlFor={goalInputId}>Daily goal (ml)</label>
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
                <button className="hifi-pill" type="submit" disabled={busy || !goalInput.trim()}>Save</button>
              </div>
              <span className="hifi-card-actions">
                <button className="hifi-link-button" type="button" onClick={() => { void applyGoal(null) }} disabled={busy}>
                  Use recommended ({format(data.default_goal_ml)} ml)
                </button>
                <button className="hifi-link-button" type="button" onClick={() => { setEditingGoal(false); setNotice(null) }} disabled={busy}>Cancel</button>
              </span>
            </form>
          ) : (
            <button
              className="hifi-link-button"
              type="button"
              onClick={() => { setGoalInput(String(data.goal_ml)); setNotice(null); setEditingGoal(true) }}
              disabled={busy}
            >
              Edit goal ({format(data.goal_ml)} ml{data.goal_ml !== data.default_goal_ml ? ', custom' : ''})
            </button>
          )}

          {data.entries.length === 0 ? (
            <p className="hifi-muted">No drinks logged yet today.</p>
          ) : (
            <ul className="hydration-entries" aria-label="Drinks logged today">
              {data.entries.map((entry) => (
                <li className="hydration-entry" key={entry.id}>
                  <span className="hydration-entry-meta">
                    <span className="hydration-entry-amount">{entryLabel(entry)}</span>
                    {entryTime(entry) && <span className="hydration-entry-time">{entryTime(entry)}</span>}
                  </span>
                  <button
                    type="button"
                    className="hydration-entry-remove"
                    onClick={() => update(() => removeHydrationEntry(entry.id), "We couldn't remove this drink.")}
                    disabled={busy}
                    aria-label={`Remove ${entryLabel(entry)}`}
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
