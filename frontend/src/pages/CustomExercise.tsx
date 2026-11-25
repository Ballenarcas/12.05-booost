import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Save, Trash2, Loader2, AlertCircle, Sparkles } from 'lucide-react'
import { 
  getCurrentUser, 
  isPremiumActive,
  fetchExerciseMuscleGroups, 
  createCustomExercise, 
  updateCustomExercise,
  deleteCustomExercise,
  fetchExerciseById,
  fetchExercises
} from '../services/api'
import { useDialogBehavior } from '../utils/useDialogBehavior'
import { useT, valueLabel } from '../i18n'

export default function CustomExercise() {
  const t = useT()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const user = getCurrentUser()
  const isPremium = isPremiumActive(user)
  const isEditing = Boolean(id)

  const [name, setName] = useState('')
  const [muscleGroup, setMuscleGroup] = useState('Quads')
  const [equipment, setEquipment] = useState('')
  const [secondaryMuscles, setSecondaryMuscles] = useState('')
  const [notes, setNotes] = useState('')
  const [availableGroups, setAvailableGroups] = useState<string[]>([])
  
  const [isLoading, setIsLoading] = useState(isEditing)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const deleteDialogRef = useDialogBehavior(showDeleteModal, () => setShowDeleteModal(false))

  useEffect(() => {
    if (!isPremium && !isEditing) return

    fetchExerciseMuscleGroups().then(groups => {
      if (groups.length > 0) {
        setAvailableGroups(groups)
        if (!isEditing) setMuscleGroup(groups.includes('Quads') ? 'Quads' : groups[0])
      }
    }).catch(() => {
      setAvailableGroups(['Quads', 'Chest', 'Back', 'Shoulders', 'Arms', 'Hamstrings', 'Calves', 'Glutes', 'Abs'])
    })

    if (isEditing && id) {
      fetchExerciseById(id).then(data => {
        setName(data.name)
        setMuscleGroup(data.muscle_group || 'General')
        setEquipment(Array.isArray(data.equipment) ? data.equipment.join(', ') : '')
        setSecondaryMuscles(Array.isArray(data.muscles_secondary) ? data.muscles_secondary.join(', ') : '')
        setNotes(data.description || '')
        setIsLoading(false)
      }).catch(() => {
        setError(t('custom.errorLoad'))
        setIsLoading(false)
      })
    }
  }, [id, isEditing, isPremium, t])

  if (!isPremium && !isEditing) {
    return (
      <div className="screen hifi-theme">
        <header className="active-workout-header">
          <button className="icon-button" type="button" onClick={() => navigate(-1)} aria-label={t('common.back')}>
            <ChevronLeft size={22} />
          </button>
          <div className="workout-title">
            <h1>{t('custom.title')}</h1>
          </div>
        </header>

        <div className="card" style={{ margin: '24px 16px', padding: '24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '50%', backgroundColor: 'rgba(21, 99, 166, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}>
            <Sparkles size={24} />
          </div>
          <h2 style={{ margin: 0, fontSize: '20px' }}>{t('aw.upgrade')}</h2>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '14px', lineHeight: 1.5 }}>
            {t('custom.premiumBody')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '10px', marginTop: '8px' }}>
            <button className="primary-button" type="button" onClick={() => navigate('/premium')}>
              {t('aw.upgrade')}
            </button>
            <button className="secondary-action" type="button" onClick={() => navigate(-1)}>
              {t('custom.goBack')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user?.id) return

    const trimmedName = name.trim()
    if (!trimmedName) {
      return setError(t('custom.errorEmpty'))
    }
    if (trimmedName.length < 2) {
      return setError(t('custom.errorShort'))
    }
    if (trimmedName.length > 50) {
      return setError(t('custom.errorLong'))
    }

    setIsSaving(true)
    setError(null)

    try {
      const searchRes = await fetchExercises({ q: trimmedName, limit: 100 })
      const duplicate = searchRes.items.find(ex => ex.name.trim().toLowerCase() === trimmedName.toLowerCase() && ex.id !== id)
      
      if (duplicate) {
        setIsSaving(false)
        return setError(t('custom.errorDuplicate', { name: duplicate.name }))
      }

      const payload = {
        name: trimmedName,
        muscle_group: muscleGroup,
        equipment: equipment.split(',').map(s => s.trim()).filter(Boolean),
        muscles_secondary: secondaryMuscles.split(',').map(s => s.trim()).filter(Boolean),
        description: notes.trim() || undefined,
      }

      if (isEditing && id) {
        await updateCustomExercise(user.id, id, payload)
      } else {
        await createCustomExercise(user.id, payload)
      }
      sessionStorage.setItem('booost_reopen_exercise_modal', 'true')
      navigate(-1)
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : t('custom.errorSave'))
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!user?.id || !id) return
    setIsSaving(true)
    try {
      await deleteCustomExercise(user.id, id)
      sessionStorage.setItem('booost_reopen_exercise_modal', 'true')
      navigate(-1)
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : t('custom.errorDelete'))
      setIsSaving(false)
      setShowDeleteModal(false)
    }
  }

  if (isLoading) {
    return <div className="screen hifi-theme state-card"><Loader2 className="animate-spin" /></div>
  }

  return (
    <div className="screen hifi-theme">
      <header className="active-workout-header">
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            sessionStorage.setItem('booost_reopen_exercise_modal', 'true')
            navigate(-1)
          }}
          aria-label={t('common.back')}
        >
          <ChevronLeft size={22} />
        </button>
        <div className="workout-title">
          <h1>{isEditing ? t('custom.editTitle') : t('custom.createTitle')}</h1>
        </div>
      </header>

      <form onSubmit={handleSave} style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>{t('custom.name')}</label>
          <input 
            type="text" 
            value={name} 
            onChange={(e) => {
                setName(e.target.value)
                setError(null)
            }}
            placeholder={t('custom.namePlaceholder')}
            style={{ width: '100%', padding: '12px', borderRadius: '8px', backgroundColor: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: '16px', boxSizing: 'border-box' }}
          />
          {error && (
            <div role="alert" style={{ color: 'var(--negative)', fontSize: '13px', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <AlertCircle size={14} /> {error}
            </div>
          )}
        </div>

        <div>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>{t('custom.mainGroup')}</label>
          <select 
            value={muscleGroup} 
            onChange={(e) => setMuscleGroup(e.target.value)}
            style={{ width: '100%', padding: '12px', borderRadius: '8px', backgroundColor: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: '16px', boxSizing: 'border-box' }}
          >
            {availableGroups.map(group => (
              <option key={group} value={group}>{valueLabel(t, 'muscle', group)}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>{t('custom.equipment')}</label>
          <input 
            type="text" 
            value={equipment} 
            onChange={(e) => setEquipment(e.target.value)}
            placeholder={t('custom.equipmentPlaceholder')}
            style={{ width: '100%', padding: '12px', borderRadius: '8px', backgroundColor: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: '16px', boxSizing: 'border-box' }}
          />
        </div>

        <div>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>{t('custom.secondary')}</label>
          <input 
            type="text" 
            value={secondaryMuscles} 
            onChange={(e) => setSecondaryMuscles(e.target.value)}
            placeholder={t('custom.secondaryPlaceholder')}
            style={{ width: '100%', padding: '12px', borderRadius: '8px', backgroundColor: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: '16px', boxSizing: 'border-box' }}
          />
        </div>

        <div>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>{t('custom.notes')}</label>
          <textarea 
            value={notes} 
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('custom.notesPlaceholder')}
            rows={3}
            style={{ width: '100%', padding: '12px', borderRadius: '8px', backgroundColor: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: '16px', boxSizing: 'border-box', resize: 'vertical' }}
          />
        </div>

        <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <button className="primary-button" type="submit" disabled={isSaving} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}>
            {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            {isEditing ? t('common.saveChanges') : t('common.save')}
          </button>
          
          {isEditing && (
            <button 
              className="danger-action" 
              type="button" 
              onClick={() => setShowDeleteModal(true)}
              style={{ padding: '14px', borderRadius: '8px', border: '1px solid var(--negative)', backgroundColor: 'transparent', color: 'var(--negative)', fontWeight: 600, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
            >
              <Trash2 size={18} /> {t('aw.removeExercise')}
            </button>
          )}
        </div>
      </form>

      {showDeleteModal && (
        <div className="modal-backdrop">
          <div className="confirmation-modal" role="dialog" aria-modal="true" ref={deleteDialogRef}>
            <h2 id="delete-title">{t('custom.removeQuestion')}</h2>
            <p>{t('custom.removeBody')}</p>
            <div className="modal-actions">
              <button className="secondary-action" type="button" onClick={() => setShowDeleteModal(false)} disabled={isSaving}>{t('common.cancel')}</button>
              <button className="danger-action" type="button" onClick={handleDelete} disabled={isSaving}>
                {isSaving ? t('custom.removing') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
