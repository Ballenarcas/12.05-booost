import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { addHydrationEntry, fetchHydrationToday, type HydrationToday } from '../../services/api'

const format = (ml: number) => ml.toLocaleString('en-US')

/** Home's hydration card: today's total and a one-tap glass. Custom amounts and edits live on Nutrition. */
export default function HydrationSummary() {
  const [data, setData] = useState<HydrationToday | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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

  async function addGlass() {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      setData(await addHydrationEntry({ amount: 1, unit: 'glass' }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "We couldn't save this drink.")
    } finally {
      setBusy(false)
    }
  }

  const progress = Math.min(100, data?.progress_percentage ?? 0)

  return (
    <section className="home-card" aria-labelledby="home-hydration" aria-busy={!loaded}>
      <h2 className="home-card-label" id="home-hydration">Hydration</h2>
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
      <div className="home-card-footer">
        <p className="home-caption">
          {data ? (
            <>
              <span>{data.progress_percentage}% of goal</span>
              <span>{format(Math.max(0, data.remaining_ml))} ml remaining</span>
            </>
          ) : (
            <span>{loaded ? 'Hydration unavailable' : ' '}</span>
          )}
        </p>
        <span className="home-card-actions">
          <Link className="home-text-link" to="/hydration/history">History</Link>
          <button className="home-pill" type="button" onClick={addGlass} disabled={!data || busy} aria-label="Add water, one glass (250 ml)">
            Add water
          </button>
        </span>
      </div>
      {notice && <p className="form-error" role="alert">{notice}</p>}
    </section>
  )
}
