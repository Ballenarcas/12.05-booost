import { ArrowRight, Dumbbell } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchWorkoutHistory, getCurrentUser } from '../../services/api'
import type { WorkoutHistoryEntry } from '../../types/workout'

interface OvertrainingBannerProps {
  workouts?: WorkoutHistoryEntry[]
}

interface StoredCheckIn {
  effectiveFatigue?: number
  effectiveSoreness?: number
  createdAt?: string
}

interface StoredState {
  modsApplied?: boolean
  dismissed?: boolean
  dismissedAt?: string | null
}

export function OvertrainingBanner({ workouts }: OvertrainingBannerProps) {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const userId = user?.id

  const [alertSummary, setAlertSummary] = useState<{
    hasAlert: boolean
    subtitle: string
  } | null>(null)

  useEffect(() => {
    let active = true

    const evaluate = async () => {
      const stateKey = `set_plate_overtraining_state_${userId ?? 'guest'}`
      const checkInsKey = `set_plate_recovery_checkins_${userId ?? 'guest'}`

      let state: StoredState = {}
      try {
        const raw = localStorage.getItem(stateKey)
        if (raw) state = JSON.parse(raw) as StoredState
      } catch {
        state = {}
      }

      let historyList: WorkoutHistoryEntry[] = []
      if (workouts !== undefined) {
        historyList = workouts
      } else if (userId) {
        try {
          historyList = await fetchWorkoutHistory(userId)
        } catch {
          historyList = []
        }
      }

      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
      const recent = historyList.filter((w) => {
        const t = Date.parse(w.started_at)
        return Number.isFinite(t) ? t >= sevenDaysAgo : true
      })

      let checkIns: StoredCheckIn[] = []
      try {
        const raw = localStorage.getItem(checkInsKey)
        if (raw) {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) checkIns = parsed as StoredCheckIn[]
        }
      } catch {
        checkIns = []
      }

      const highFatigueCount = checkIns.filter(
        (c) =>
          (c.effectiveFatigue ?? 0) >= 7 ||
          (c.effectiveSoreness ?? 0) >= 7 ||
          (c.effectiveFatigue ?? 0) + (c.effectiveSoreness ?? 0) >= 13,
      ).length

      const latestWorkoutTime = recent.reduce((max, w) => Math.max(max, Date.parse(w.started_at) || 0), 0)
      const latestCheckInTime = checkIns.reduce(
        (max, c) => Math.max(max, c.createdAt ? Date.parse(c.createdAt) || 0 : 0),
        0,
      )
      const latestActivityTime = Math.max(latestWorkoutTime, latestCheckInTime)
      const dismissedAtTime = state.dismissedAt ? Date.parse(state.dismissedAt) : 0

      if (state.dismissed && (!dismissedAtTime || latestActivityTime > dismissedAtTime)) {
        state.dismissed = false
        try {
          localStorage.setItem(stateKey, JSON.stringify({ ...state, dismissed: false }))
        } catch {
          // ignore
        }
      }

      if (state.dismissed) {
        if (active) setAlertSummary(null)
        return
      }

      const sessions7d = recent.length
      let highRpeSets = 0
      let totalCompletedSets = 0

      for (const w of recent) {
        for (const ex of w.exercises) {
          for (const s of ex.sets) {
            const setWeight = Number(s.weight_kg || 0)
            const setReps = Number(s.reps || 0)
            const isDone = s.is_completed !== false && (s.is_completed || setReps > 0 || setWeight > 0)
            if (!isDone) continue

            totalCompletedSets += 1
            if (typeof s.rpe === 'number' && s.rpe >= 8.5) {
              highRpeSets += 1
            }
          }
        }
      }

      const highFrequency = sessions7d >= 6
      const highCumulativeVolume = sessions7d >= 4 && totalCompletedSets >= 75
      const highCnsStrain = sessions7d >= 3 && highRpeSets >= 20
      const workoutTriggered = highFrequency || highCumulativeVolume || highCnsStrain
      const checkInTriggered =
        highFatigueCount >= 2 || (highFatigueCount >= 1 && sessions7d >= 4)

      if (workoutTriggered || checkInTriggered) {
        let subtitle = ''
        if (highCnsStrain) {
          subtitle = `${sessions7d} sessions & ${highRpeSets} sets at RPE ≥ 8.5 in 7 days — tap for AI deload plan`
        } else if (highCumulativeVolume || highFrequency) {
          subtitle = `${sessions7d} sessions & ${totalCompletedSets} working sets in 7 days — tap for AI deload plan`
        } else {
          subtitle = `${highFatigueCount} high-fatigue check-in${highFatigueCount > 1 ? 's' : ''} logged — tap to review AI recovery plan`
        }

        if (active) {
          setAlertSummary({
            hasAlert: true,
            subtitle,
          })
        }
        return
      }

      if (active) setAlertSummary(null)
    }

    void evaluate()
    return () => {
      active = false
    }
  }, [userId, workouts])

  if (alertSummary?.hasAlert) {
    return (
      <div
        role="alert"
        onClick={() => navigate('/overtraining-alerts')}
        style={{
          backgroundColor: '#23191b',
          border: '1.5px solid #c26d53',
          borderRadius: '14px',
          padding: '14px 16px',
          margin: '12px 0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          cursor: 'pointer',
          boxShadow: '0 6px 18px rgba(224, 122, 95, 0.2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '26px',
              height: '26px',
              borderRadius: '999px',
              border: '2px solid #e07a5f',
              color: '#e07a5f',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '14px',
              flexShrink: 0,
            }}
          >
            !
          </div>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: '#e07a5f' }}>
              CRITICAL ALERT: Overtraining Risk High
            </div>
            <div style={{ fontSize: '12.5px', color: '#d4d4d8', marginTop: '3px' }}>
              {alertSummary.subtitle}
            </div>
          </div>
        </div>
        <ArrowRight color="#e07a5f" size={18} />
      </div>
    )
  }

  return (
    <div
      onClick={() => navigate('/overtraining-alerts')}
      style={{
        backgroundColor: '#1b1a1f',
        border: '1px solid rgba(168, 85, 247, 0.28)',
        borderRadius: '14px',
        padding: '12px 15px',
        margin: '12px 0 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Dumbbell color="#a78bfa" size={18} />
        <div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#f4f4f6' }}>
            Recovery &amp; Overtraining Monitor
          </div>
          <div style={{ fontSize: '11.5px', color: '#8e8e93' }}>
            Log post-workout fatigue &amp; check CNS readiness
          </div>
        </div>
      </div>
      <ArrowRight color="#a78bfa" size={17} />
    </div>
  )
}

export default OvertrainingBanner