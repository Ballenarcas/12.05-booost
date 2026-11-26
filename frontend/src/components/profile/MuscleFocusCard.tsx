import { useEffect, useState } from 'react'
import { fetchMuscleFocus, saveMuscleFocus } from '../../services/api'
import { useT, valueLabel } from '../../i18n'
import { describeError } from '../../utils/errors'

const MUSCLES = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Abs', 'Calves']

/** Which muscle the coach and the workout plan should favour. Saved as soon as it is chosen. */
export default function MuscleFocusCard() {
  const t = useT()
  const [focus, setFocus] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    fetchMuscleFocus()
      .then((muscle) => {
        if (!mounted) return
        setFocus(muscle ?? '')
        setReady(true)
      })
      .catch((failure) => mounted && setError(describeError(failure, t('api.saveSettings'))))
    return () => {
      mounted = false
    }
  }, [t])

  async function choose(value: string) {
    const previous = focus
    setFocus(value)
    setReady(false)
    setError(null)
    try {
      await saveMuscleFocus(value || null)
    } catch (failure) {
      setFocus(previous)
      setError(describeError(failure, t('api.saveSettings')))
    } finally {
      setReady(true)
    }
  }

  return (
    <section className="section" aria-labelledby="profile-training">
      <h3 className="section-title" id="profile-training">{t('profile.training')}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <label className="settings-label" htmlFor="profile-muscle-focus">
            {t('profile.muscleFocus')}
            <small>{t('profile.muscleFocusHint')}</small>
          </label>
          <select id="profile-muscle-focus" className="settings-input" value={focus} disabled={!ready} onChange={(event) => void choose(event.target.value)}>
            <option value="">{t('profile.muscleFocusAuto')}</option>
            {MUSCLES.map((muscle) => <option key={muscle} value={muscle}>{valueLabel(t, 'muscle', muscle)}</option>)}
          </select>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}
