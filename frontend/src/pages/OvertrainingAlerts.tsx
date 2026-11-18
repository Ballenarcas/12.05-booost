import { Dumbbell, Plus, Repeat2 } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  inferMuscleGroupFromExerciseName,
  loadExerciseMuscleMap,
  type MuscleGroupBucket,
} from './AiRestSuggestions'
import { fetchWorkoutHistory, getCurrentUser } from '../services/api'
import type { WorkoutHistoryEntry } from '../types/workout'

export interface OvertrainingAlertStatus {
  has_alert: boolean
  risk_level: 'none' | 'moderate' | 'high'
  load_increase_pct: number
  sessions_last_7_days: number
  total_sets_last_7_days: number
  top_muscle_group: string
  top_muscle_group_sets: number
  high_rpe_sets_count: number
  repeated_fatigue_reports: number
  strained_muscles: string[]
  headline: string
  critical_alert_title: string | null
  critical_alert_body: string | null
  critical_recommendation: string | null
  fatigue_feedback_title: string | null
  fatigue_feedback_body: string | null
  fatigue_action: string | null
  ai_modification_title: string | null
  ai_modification_body: string | null
  volume_reduction_pct: number
  mods_applied: boolean
  dismissed: boolean
}

type SleepQualityId = 'restorative' | 'average' | 'poor'
type JointStrainId = 'none' | 'mild' | 'sharp'

interface LocalCheckInEntry {
  id: string
  cnsFatigue: number
  domsSoreness: number
  effectiveFatigue: number
  effectiveSoreness: number
  sleepQuality: SleepQualityId
  jointStrain: JointStrainId
  muscles: string[]
  notes?: string
  createdAt: string
}

interface StoredOvertrainingState {
  modsApplied?: boolean
  dismissed?: boolean
  dismissedAt?: string | null
}

const MUSCLE_OPTIONS: string[] = [
  'Chest',
  'Shoulders',
  'Triceps',
  'Back',
  'Biceps',
  'Quads',
  'Hamstrings',
  'Glutes',
  'Core',
]

const SLEEP_OPTIONS: Array<{ id: SleepQualityId; label: string; penalty: number }> = [
  { id: 'restorative', label: 'Restorative (7.5h+)', penalty: 0 },
  { id: 'average', label: 'Moderate (6–7h)', penalty: 1 },
  { id: 'poor', label: 'Fragmented (<6h)', penalty: 2 },
]

const JOINT_OPTIONS: Array<{ id: JointStrainId; label: string; penalty: number }> = [
  { id: 'none', label: 'No joint discomfort', penalty: 0 },
  { id: 'mild', label: 'Mild tendon stiffness', penalty: 1 },
  { id: 'sharp', label: 'Noticeable joint strain', penalty: 2 },
]

function getStorageKey(userId?: string): string {
  return `set_plate_recovery_checkins_${userId ?? 'guest'}`
}

function getStateStorageKey(userId?: string): string {
  return `set_plate_overtraining_state_${userId ?? 'guest'}`
}

function readLocalCheckIns(userId?: string): LocalCheckInEntry[] {
  try {
    const raw = localStorage.getItem(getStorageKey(userId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LocalCheckInEntry[]) : []
  } catch {
    return []
  }
}

function writeLocalCheckIns(userId: string | undefined, items: LocalCheckInEntry[]): void {
  try {
    localStorage.setItem(getStorageKey(userId), JSON.stringify(items))
  } catch {
    // ignore storage errors
  }
}

function readStoredState(userId?: string): StoredOvertrainingState {
  try {
    const raw = localStorage.getItem(getStateStorageKey(userId))
    if (!raw) return {}
    return JSON.parse(raw) as StoredOvertrainingState
  } catch {
    return {}
  }
}

function describeScale(value: number, kind: 'cns' | 'doms'): string {
  if (kind === 'cns') {
    if (value <= 3) return 'Fresh — normal energy & bar speed'
    if (value <= 6) return 'Moderate — standard post-session fatigue'
    if (value <= 8) return 'High — heavy legs, slower bar speed, elevated RPE'
    return 'Severe — systemic CNS exhaustion & suppressed HRV'
  }
  if (value <= 3) return 'Minimal — muscles feel recovered'
  if (value <= 6) return 'Moderate DOMS — noticeable stiffness on movement'
  if (value <= 8) return 'High DOMS — tender to touch, reduced force output'
  return 'Severe DOMS — persistent soreness >48h, range of motion limited'
}

function BodyHeatmapGraphic(props: { strainedMuscles: string[] }) {
  const lower = props.strainedMuscles.map((m) => m.toLowerCase())
  const upperActive =
    lower.length === 0 ||
    lower.some(
      (m) =>
        m.includes('chest') ||
        m.includes('shoulder') ||
        m.includes('tricep') ||
        m.includes('bicep') ||
        m.includes('arm') ||
        m.includes('back'),
    )
  const lowerActive =
    lower.length === 0 ||
    lower.some((m) => m.includes('quad') || m.includes('hamstring') || m.includes('glute') || m.includes('calf'))

  return (
    <svg
      width="56"
      height="118"
      viewBox="0 0 64 136"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="32" cy="14" r="9" fill="#E5A97B" />
      <rect x="28" y="23" width="8" height="6" rx="3" fill="#E5A97B" />
      <path
        d="M16 32C16 29.5 20 28 32 28C44 28 48 29.5 48 32L52 66C52 68 49 69 47 67L43 40H41L42 74H22L23 40H21L17 67C15 69 12 68 12 66L16 32Z"
        fill="#E5A97B"
      />
      <path d="M22 74H31L29 124C29 127 24 127 24 124L22 74Z" fill="#E5A97B" />
      <path d="M33 74H42L40 124C40 127 35 127 35 124L33 74Z" fill="#E5A97B" />
      {upperActive && (
        <>
          <circle cx="19" cy="35" r="5" fill="#EF4444" fillOpacity="0.85" />
          <circle cx="45" cy="35" r="5" fill="#EF4444" fillOpacity="0.85" />
          <circle cx="32" cy="43" r="6" fill="#F97316" fillOpacity="0.8" />
        </>
      )}
      <circle cx="32" cy="60" r="6" fill="#EF4444" fillOpacity="0.8" />
      {lowerActive && (
        <>
          <circle cx="26" cy="96" r="5" fill="#EF4444" fillOpacity="0.8" />
          <circle cx="38" cy="96" r="5" fill="#EF4444" fillOpacity="0.8" />
        </>
      )}
    </svg>
  )
}

function OvertrainingAlerts() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const userId = user?.id

  const [status, setStatus] = useState<OvertrainingAlertStatus | null>(null)
  const [checkIns, setCheckIns] = useState<LocalCheckInEntry[]>(() => readLocalCheckIns(userId))
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<'apply' | 'dismiss' | 'feedback' | null>(null)
  const [bannerMessage, setBannerMessage] = useState<string | null>(null)
  const [showCheckIn, setShowCheckIn] = useState(false)

  const [cnsFatigue, setCnsFatigue] = useState(8)
  const [domsSoreness, setDomsSoreness] = useState(8)
  const [sleepQuality, setSleepQuality] = useState<SleepQualityId>('poor')
  const [jointStrain, setJointStrain] = useState<JointStrainId>('mild')
  const [selectedMuscles, setSelectedMuscles] = useState<string[]>(['Chest', 'Shoulders'])
  const [notes, setNotes] = useState('')

  const computePhysiologicalStatus = useCallback(
    async (
      entries: LocalCheckInEntry[],
      modsAppliedOverride?: boolean,
      dismissedOverride?: boolean,
    ): Promise<OvertrainingAlertStatus> => {
      let sessions7d = 0
      let highRpeSets = 0
      let totalCompletedSets = 0
      let featuredLift = 'compound lifts'
      const setsByMuscle: Record<MuscleGroupBucket, number> = {
        Chest: 0,
        Shoulders: 0,
        Triceps: 0,
        Back: 0,
        Biceps: 0,
        Quads: 0,
        Hamstrings: 0,
        Glutes: 0,
        Calves: 0,
        Core: 0,
      }

      const muscleMap = await loadExerciseMuscleMap()

      if (userId) {
        try {
          const history: WorkoutHistoryEntry[] = await fetchWorkoutHistory(userId)
          const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
          const recent = history.filter((w) => {
            const t = Date.parse(w.started_at)
            return Number.isFinite(t) ? t >= sevenDaysAgo : true
          })
          sessions7d = recent.length
          for (const w of recent) {
            for (const ex of w.exercises) {
              if (ex.name && featuredLift === 'compound lifts') featuredLift = ex.name
              const muscle = inferMuscleGroupFromExerciseName(ex.name || '', ex.exercise_id, muscleMap)
              for (const s of ex.sets) {
                const weight = Number(s.weight_kg || 0)
                const reps = Number(s.reps || 0)
                const isDone = s.is_completed !== false && (s.is_completed || reps > 0 || weight > 0)
                if (!isDone) continue

                totalCompletedSets += 1
                setsByMuscle[muscle] += 1
                if (typeof s.rpe === 'number' && s.rpe >= 8.5) {
                  highRpeSets += 1
                }
              }
            }
          }
        } catch {
          // ignore network errors
        }
      }

      const sortedMuscles = (Object.entries(setsByMuscle) as Array<[MuscleGroupBucket, number]>).sort(
        (a, b) => b[1] - a[1],
      )
      const topMuscleGroup: MuscleGroupBucket = sortedMuscles[0]?.[0] ?? 'Chest'
      const topMuscleGroupSets: number = sortedMuscles[0]?.[1] ?? 0
      const overloadedMuscles = sortedMuscles.filter(([, count]) => count >= 18).map(([m]) => m)

      const highFatigueLogs = entries.filter(
        (item) =>
          item.effectiveFatigue >= 7 ||
          item.effectiveSoreness >= 7 ||
          item.effectiveFatigue + item.effectiveSoreness >= 13,
      )
      const repeatedFatigueCount = highFatigueLogs.length

      const strainedMuscles: string[] = [...overloadedMuscles]
      for (const log of highFatigueLogs) {
        for (const m of log.muscles) {
          if (!strainedMuscles.includes(m)) strainedMuscles.push(m)
        }
      }

      // Vrais seuils anatomiques par muscle individuel :
      // 1) Surcharge d'un muscle spécifique : >= 2 séances ET >= 18 séries sur le MÊME muscle (ex: Chest >= 18)
      // 2) Fréquence excessive : >= 6 séances sur 7 jours
      // 3) Volume hebdomadaire global excessif : >= 4 séances ET >= 75 séries au total
      // 4) Saturation nerveuse (CNS) : >= 3 séances ET >= 20 séries à RPE >= 8.5
      // 5) Récupération insuffisante : >= 2 check-ins de haute fatigue, OU (1 check-in + >= 4 séances)
      const localizedMuscleOverload = sessions7d >= 2 && topMuscleGroupSets >= 18
      const highFrequency = sessions7d >= 6
      const highCumulativeVolume = sessions7d >= 4 && totalCompletedSets >= 75
      const highCnsStrain = sessions7d >= 3 && highRpeSets >= 20
      const excessiveTrainingLoad =
        localizedMuscleOverload || highFrequency || highCumulativeVolume || highCnsStrain

      const insufficientRecovery =
        repeatedFatigueCount >= 2 || (repeatedFatigueCount >= 1 && sessions7d >= 4)

      const savedState = readStoredState(userId)
      const modsApplied = modsAppliedOverride ?? Boolean(savedState.modsApplied)
      const dismissed = dismissedOverride ?? Boolean(savedState.dismissed)

      if (!excessiveTrainingLoad && !insufficientRecovery) {
        return {
          has_alert: false,
          risk_level: 'none',
          load_increase_pct: 0,
          sessions_last_7_days: sessions7d,
          total_sets_last_7_days: totalCompletedSets,
          top_muscle_group: topMuscleGroup,
          top_muscle_group_sets: topMuscleGroupSets,
          high_rpe_sets_count: highRpeSets,
          repeated_fatigue_reports: repeatedFatigueCount,
          strained_muscles: strainedMuscles,
          headline: 'Your acute-to-chronic training load and individual muscle recovery are within optimal range.',
          critical_alert_title: null,
          critical_alert_body: null,
          critical_recommendation: null,
          fatigue_feedback_title: null,
          fatigue_feedback_body: null,
          fatigue_action: null,
          ai_modification_title: null,
          ai_modification_body: null,
          volume_reduction_pct: 15,
          mods_applied: modsApplied,
          dismissed: false,
        }
      }

      const displayLoadPct = localizedMuscleOverload
        ? Math.min(85, Math.max(25, Math.round(((topMuscleGroupSets - 14) / 14) * 100)))
        : totalCompletedSets > 60
          ? Math.min(85, Math.max(20, Math.round(((totalCompletedSets - 60) / 60) * 100)))
          : 35

      const musclesLabel =
        strainedMuscles.length > 0 ? strainedMuscles.slice(0, 2).join('/').toLowerCase() : topMuscleGroup.toLowerCase()

      const criticalBody = localizedMuscleOverload
        ? `Your 7-day volume on ${topMuscleGroup} is ${displayLoadPct}% above recommended recovery limits (${topMuscleGroupSets} sets specifically on ${topMuscleGroup} across ${sessions7d} sessions; max threshold per muscle is 18 sets).`
        : excessiveTrainingLoad
          ? `Your 7-day training load is ${displayLoadPct}% above recommended recovery thresholds (${sessions7d} sessions, ${totalCompletedSets} working sets${highRpeSets > 0 ? `, ${highRpeSets} sets at RPE ≥ 8.5` : ''}). Heart Rate Variability (HRV) and CNS readiness are suppressed.`
          : `You have logged ${repeatedFatigueCount} high-fatigue & soreness recovery check-ins. Systemic CNS readiness and muscle recovery are significantly suppressed.`

      return {
        has_alert: !dismissed,
        risk_level: 'high',
        load_increase_pct: displayLoadPct,
        sessions_last_7_days: sessions7d,
        total_sets_last_7_days: totalCompletedSets,
        top_muscle_group: topMuscleGroup,
        top_muscle_group_sets: topMuscleGroupSets,
        high_rpe_sets_count: highRpeSets,
        repeated_fatigue_reports: repeatedFatigueCount,
        strained_muscles: strainedMuscles.length > 0 ? strainedMuscles : [topMuscleGroup],
        headline:
          "Based on your per-muscle volume, fatigue tracking, and recent high-intensity workouts, we've detected signs of potential overtraining. Please review the recommendations below.",
        critical_alert_title: 'CRITICAL ALERT: Overtraining Risk High',
        critical_alert_body: criticalBody,
        critical_recommendation: localizedMuscleOverload
          ? `Stop training ${topMuscleGroup} for 48–72h. Take a rest day or rotate to a fresh muscle group (Back / Legs).`
          : "Take a dedicated rest day or swap today's high-intensity session for active recovery.",
        fatigue_feedback_title: 'Soreness & Fatigue Feedback Detected',
        fatigue_feedback_body:
          repeatedFatigueCount > 0
            ? `High soreness reported in ${musclesLabel} across ${repeatedFatigueCount} recovery check-in${repeatedFatigueCount > 1 ? 's' : ''}. Muscle recovery requires rest.`
            : `Excessive localized strain accumulated on ${topMuscleGroup} (${topMuscleGroupSets} sets, led by ${featuredLift}). Muscle tissue recovery requires rest.`,
        fatigue_action: `Force-adjust today's ${featuredLift} sets to RPE 6 or replace with lighter mobility movements.`,
        ai_modification_title: 'AI Modification Suggestion Active',
        ai_modification_body:
          'To prevent injury, we have automatically lowered your overall training volume for your next workout by 15%. Target sets are reduced.',
        volume_reduction_pct: 15,
        mods_applied: modsApplied,
        dismissed,
      }
    },
    [userId],
  )

  useEffect(() => {
    let active = true
    const currentEntries = readLocalCheckIns(userId)
    setCheckIns(currentEntries)

    computePhysiologicalStatus(currentEntries).then((localEval) => {
      if (active) {
        setStatus(localEval)
        setLoading(false)
      }
    })

    return () => {
      active = false
    }
  }, [userId, computePhysiologicalStatus])

  const toggleMuscle = (muscle: string) => {
    setSelectedMuscles((current) =>
      current.includes(muscle) ? current.filter((m) => m !== muscle) : [...current, muscle],
    )
  }

  const handleSubmitCheckIn = async (e: FormEvent) => {
    e.preventDefault()
    setBusyAction('feedback')

    const sleepPenalty = SLEEP_OPTIONS.find((o) => o.id === sleepQuality)?.penalty ?? 0
    const jointPenalty = JOINT_OPTIONS.find((o) => o.id === jointStrain)?.penalty ?? 0
    const effectiveFatigue = Math.min(10, cnsFatigue + sleepPenalty)
    const effectiveSoreness = Math.min(10, domsSoreness + jointPenalty)

    const newEntry: LocalCheckInEntry = {
      id: `${Date.now()}`,
      cnsFatigue,
      domsSoreness,
      effectiveFatigue,
      effectiveSoreness,
      sleepQuality,
      jointStrain,
      muscles: selectedMuscles.length > 0 ? selectedMuscles : ['Chest', 'Shoulders'],
      notes: notes.trim() || undefined,
      createdAt: new Date().toISOString(),
    }

    const updatedEntries = [newEntry, ...checkIns]
    setCheckIns(updatedEntries)
    writeLocalCheckIns(userId, updatedEntries)
    localStorage.setItem(
      getStateStorageKey(userId),
      JSON.stringify({ modsApplied: false, dismissed: false, dismissedAt: null }),
    )

    const nextStatus = await computePhysiologicalStatus(updatedEntries, false, false)
    setStatus(nextStatus)
    sessionStorage.setItem('set_plate_overtraining_state', JSON.stringify(nextStatus))
    setShowCheckIn(false)
    setNotes('')
    setBusyAction(null)

    if (nextStatus.has_alert) {
      setBannerMessage(
        'Recovery check-in saved: repeated fatigue pattern detected. Review the AI recommendations below.',
      )
    } else {
      setBannerMessage(
        `Check-in saved (${nextStatus.repeated_fatigue_reports}/2 high-fatigue logs). A single fatigued session is normal — an alert triggers only when fatigue repeats or an individual muscle exceeds 18 sets.`,
      )
    }
  }

  const handleApplyMods = async () => {
    setBusyAction('apply')
    localStorage.setItem(
      getStateStorageKey(userId),
      JSON.stringify({ modsApplied: true, dismissed: false, dismissedAt: null }),
    )
    localStorage.setItem('set_plate_overtraining_mod_pct', '15')
    const nextStatus = await computePhysiologicalStatus(checkIns, true, false)
    setStatus(nextStatus)
    sessionStorage.setItem('set_plate_overtraining_state', JSON.stringify(nextStatus))
    setBannerMessage('AI Deload applied: next workout volume lowered by 15% and target RPE capped at 6.')
    setBusyAction(null)
  }

  const handleDismiss = async () => {
    setBusyAction('dismiss')
    localStorage.setItem(
      getStateStorageKey(userId),
      JSON.stringify({ modsApplied: false, dismissed: true, dismissedAt: new Date().toISOString() }),
    )
    localStorage.removeItem('set_plate_overtraining_mod_pct')
    sessionStorage.removeItem('set_plate_overtraining_state')
    setBusyAction(null)
    navigate('/workouts')
  }

  const handleResetHistory = async () => {
    writeLocalCheckIns(userId, [])
    localStorage.removeItem(getStateStorageKey(userId))
    sessionStorage.removeItem('set_plate_overtraining_state')
    setCheckIns([])
    const nextStatus = await computePhysiologicalStatus([], false, false)
    setStatus(nextStatus)
    setBannerMessage('Fatigue logs cleared and re-synced with your workout history.')
  }

  if (loading) {
    return (
      <div className="screen state-card" style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        Loading recovery analysis...
      </div>
    )
  }

  const showAlertCards = Boolean(status && status.has_alert && status.risk_level !== 'none')
  const activeStrainedMuscles = status?.strained_muscles ?? []

  return (
    <div
      className="screen"
      style={{
        minHeight: '100vh',
        backgroundColor: '#121114',
        color: '#f4f4f6',
        padding: '20px 18px 110px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <button
          type="button"
          onClick={() => navigate(-1)}
          style={{
            background: 'none',
            border: 'none',
            color: '#8e8e93',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '15px',
            cursor: 'pointer',
            padding: '4px 0',
          }}
        >
          ← Back
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            onClick={handleResetHistory}
            title="Clear fatigue logs & re-sync"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#a1a1aa',
              borderRadius: '999px',
              padding: '7px 10px',
              fontSize: '11.5px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              cursor: 'pointer',
            }}
          >
            <Repeat2 size={13} /> Reset Logs
          </button>
          <button
            type="button"
            onClick={() => setShowCheckIn((prev) => !prev)}
            style={{
              background: showCheckIn ? 'rgba(168, 85, 247, 0.28)' : 'rgba(168, 85, 247, 0.14)',
              border: '1px solid rgba(168, 85, 247, 0.4)',
              color: '#d8b4fe',
              borderRadius: '999px',
              padding: '7px 13px',
              fontSize: '12px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
            }}
          >
            <Plus size={14} />
            {showCheckIn ? 'Close Check-in' : 'Recovery Check-in'}
          </button>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginBottom: '18px' }}>
        <h1
          style={{
            fontSize: '21px',
            fontWeight: 800,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            margin: '0 0 10px',
            color: '#ffffff',
          }}
        >
          OVERTRAINING ALERTS
        </h1>
        <p
          style={{
            margin: '0 auto',
            maxWidth: '360px',
            fontSize: '13.5px',
            lineHeight: 1.45,
            color: '#a1a1aa',
          }}
        >
          {showAlertCards
            ? status?.headline
            : 'The AI evaluates individual muscle volume (≥18 sets on the same muscle in 7d), total weekly volume (≥75 sets), and repeated fatigue check-ins.'}
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '8px',
          marginBottom: '18px',
        }}
      >
        <div
          style={{
            backgroundColor: '#1b1a1f',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '12px',
            padding: '10px 6px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '10.5px', color: '#8e8e93' }}>7d Sessions</div>
          <div style={{ fontSize: '15px', fontWeight: 800, color: '#fff', marginTop: '2px' }}>
            {status?.sessions_last_7_days ?? 0}
          </div>
        </div>
        <div
          style={{
            backgroundColor: '#1b1a1f',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '12px',
            padding: '10px 6px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '10.5px', color: '#8e8e93' }}>
            {status?.top_muscle_group ? `${status.top_muscle_group} Sets` : 'Top Muscle'}
          </div>
          <div style={{ fontSize: '15px', fontWeight: 800, color: '#fff', marginTop: '2px' }}>
            {status?.top_muscle_group_sets ?? 0}/18
          </div>
        </div>
        <div
          style={{
            backgroundColor: '#1b1a1f',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '12px',
            padding: '10px 6px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '10.5px', color: '#8e8e93' }}>RPE ≥ 8.5</div>
          <div style={{ fontSize: '15px', fontWeight: 800, color: '#fff', marginTop: '2px' }}>
            {status?.high_rpe_sets_count ?? 0}/20
          </div>
        </div>
        <div
          style={{
            backgroundColor: '#1b1a1f',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '12px',
            padding: '10px 6px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '10.5px', color: '#8e8e93' }}>Fatigue Logs</div>
          <div style={{ fontSize: '15px', fontWeight: 800, color: '#fff', marginTop: '2px' }}>
            {status?.repeated_fatigue_reports ?? 0}/2
          </div>
        </div>
      </div>

      {bannerMessage && (
        <div
          role="status"
          style={{
            backgroundColor: 'rgba(34, 197, 94, 0.12)',
            border: '1px solid rgba(34, 197, 94, 0.35)',
            color: '#86efac',
            padding: '12px 14px',
            borderRadius: '12px',
            fontSize: '13px',
            lineHeight: 1.4,
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
          }}
        >
          <span style={{ fontWeight: 800 }}>✓</span>
          <span>{bannerMessage}</span>
        </div>
      )}

      {showCheckIn && (
        <form
          onSubmit={handleSubmitCheckIn}
          style={{
            backgroundColor: '#1b1a1f',
            border: '1px solid rgba(168, 85, 247, 0.4)',
            borderRadius: '16px',
            padding: '16px',
            marginBottom: '18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '15px',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: '14.5px', color: '#f3e8ff' }}>
              Post-Workout Recovery &amp; Readiness Check-in
            </div>
            <div style={{ fontSize: '12px', color: '#8e8e93', marginTop: '2px' }}>
              Used by the AI to correlate your internal recovery with your logged training volume.
            </div>
          </div>

          <label style={{ fontSize: '12.5px', color: '#d4d4d8', display: 'grid', gap: '5px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Systemic / CNS Fatigue</span>
              <strong style={{ color: '#c084fc' }}>{cnsFatigue}/10</strong>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              value={cnsFatigue}
              onChange={(e) => setCnsFatigue(Number(e.target.value))}
            />
            <span style={{ fontSize: '11.5px', color: '#8e8e93' }}>{describeScale(cnsFatigue, 'cns')}</span>
          </label>

          <label style={{ fontSize: '12.5px', color: '#d4d4d8', display: 'grid', gap: '5px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Localized Muscle Soreness (DOMS)</span>
              <strong style={{ color: '#c084fc' }}>{domsSoreness}/10</strong>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              value={domsSoreness}
              onChange={(e) => setDomsSoreness(Number(e.target.value))}
            />
            <span style={{ fontSize: '11.5px', color: '#8e8e93' }}>{describeScale(domsSoreness, 'doms')}</span>
          </label>

          <div>
            <div style={{ fontSize: '12.5px', color: '#d4d4d8', marginBottom: '7px' }}>Last Night&apos;s Sleep Quality</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
              {SLEEP_OPTIONS.map((opt) => {
                const active = sleepQuality === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSleepQuality(opt.id)}
                    style={{
                      padding: '8px 6px',
                      borderRadius: '10px',
                      fontSize: '11.5px',
                      fontWeight: 600,
                      border: active ? '1px solid #a855f7' : '1px solid #2e2d35',
                      backgroundColor: active ? 'rgba(168, 85, 247, 0.22)' : '#141318',
                      color: active ? '#f3e8ff' : '#a1a1aa',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '12.5px', color: '#d4d4d8', marginBottom: '7px' }}>Joint &amp; Tendon Status</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
              {JOINT_OPTIONS.map((opt) => {
                const active = jointStrain === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setJointStrain(opt.id)}
                    style={{
                      padding: '8px 6px',
                      borderRadius: '10px',
                      fontSize: '11.5px',
                      fontWeight: 600,
                      border: active ? '1px solid #a855f7' : '1px solid #2e2d35',
                      backgroundColor: active ? 'rgba(168, 85, 247, 0.22)' : '#141318',
                      color: active ? '#f3e8ff' : '#a1a1aa',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '12.5px', color: '#d4d4d8', marginBottom: '7px' }}>
              Muscles Experiencing High Soreness
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {MUSCLE_OPTIONS.map((muscle) => {
                const active = selectedMuscles.includes(muscle)
                return (
                  <button
                    key={muscle}
                    type="button"
                    onClick={() => toggleMuscle(muscle)}
                    style={{
                      padding: '5px 11px',
                      borderRadius: '999px',
                      fontSize: '12px',
                      border: active ? '1px solid #a855f7' : '1px solid #2e2d35',
                      backgroundColor: active ? 'rgba(168, 85, 247, 0.25)' : '#141318',
                      color: active ? '#f3e8ff' : '#a1a1aa',
                      cursor: 'pointer',
                    }}
                  >
                    {muscle}
                  </button>
                )
              })}
            </div>
          </div>

          <input
            type="text"
            placeholder="Optional context (e.g. heavy bench PR, high work stress...)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: '10px',
              backgroundColor: '#121114',
              border: '1px solid #2e2d35',
              color: '#fff',
              fontSize: '13px',
              boxSizing: 'border-box',
            }}
          />

          <button
            type="submit"
            disabled={busyAction === 'feedback'}
            style={{
              backgroundColor: '#7c3aed',
              color: '#fff',
              border: 'none',
              borderRadius: '12px',
              padding: '12px',
              fontWeight: 700,
              fontSize: '13.5px',
              cursor: 'pointer',
            }}
          >
            {busyAction === 'feedback' ? 'Evaluating Recovery Pattern...' : 'Submit Recovery Check-in'}
          </button>
        </form>
      )}

      {!showAlertCards ? (
        <div
          style={{
            backgroundColor: '#1b1a1f',
            border: '1px solid rgba(34, 197, 94, 0.3)',
            borderRadius: '18px',
            padding: '26px 20px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '999px',
              backgroundColor: 'rgba(74, 222, 128, 0.14)',
              color: '#4ade80',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '22px',
              fontWeight: 800,
            }}
          >
            ✓
          </div>
          <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 700 }}>Recovery &amp; Workload Optimal</h2>
          <p style={{ margin: 0, fontSize: '13.5px', color: '#a1a1aa', lineHeight: 1.5 }}>
            Your 7-day workload ({status?.sessions_last_7_days ?? 0} workouts,{' '}
            {status?.total_sets_last_7_days ?? 0} total sets, max {status?.top_muscle_group_sets ?? 0}/18 sets on{' '}
            {status?.top_muscle_group ?? 'any single muscle'}) is well balanced.
          </p>
          <button
            type="button"
            onClick={() => setShowCheckIn(true)}
            style={{
              marginTop: '6px',
              backgroundColor: '#25232c',
              border: '1px solid rgba(168, 85, 247, 0.35)',
              color: '#e9d5ff',
              borderRadius: '999px',
              padding: '9px 16px',
              fontSize: '13px',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
            }}
          >
            <Dumbbell size={15} /> Log Post-Workout Recovery Check-in
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <section
            style={{
              backgroundColor: '#1d191b',
              border: '1.5px solid #c26d53',
              borderRadius: '16px',
              padding: '16px',
              display: 'flex',
              gap: '14px',
              alignItems: 'flex-start',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', paddingTop: '2px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '999px',
                  border: '2px solid #e07a5f',
                  color: '#e07a5f',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 800,
                  fontSize: '16px',
                }}
              >
                !
              </div>
              <BodyHeatmapGraphic strainedMuscles={activeStrainedMuscles} />
            </div>

            <div style={{ flex: 1 }}>
              <h2
                style={{
                  margin: '0 0 8px',
                  fontSize: '15px',
                  fontWeight: 800,
                  color: '#e07a5f',
                }}
              >
                {status?.critical_alert_title}
              </h2>
              <p style={{ margin: '0 0 10px', fontSize: '13.5px', lineHeight: 1.45, color: '#e4e4e7' }}>
                {status?.critical_alert_body}
              </p>
              <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.45, color: '#d4d4d8' }}>
                <strong style={{ color: '#ffffff' }}>Recommendation:</strong> {status?.critical_recommendation}
              </p>
            </div>
          </section>

          <section
            style={{
              backgroundColor: '#1b1922',
              border: '1.5px solid #6b4c8c',
              borderRadius: '16px',
              padding: '16px',
              display: 'flex',
              gap: '14px',
              alignItems: 'flex-start',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '12px',
                backgroundColor: 'rgba(139, 92, 246, 0.16)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Dumbbell color="#a78bfa" size={22} />
            </div>

            <div style={{ flex: 1 }}>
              <h2 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 700, color: '#ffffff' }}>
                {status?.fatigue_feedback_title}
              </h2>
              <p style={{ margin: '0 0 10px', fontSize: '13.5px', lineHeight: 1.45, color: '#d4d4d8' }}>
                {status?.fatigue_feedback_body}
              </p>
              <p style={{ margin: '0 0 13px', fontSize: '13px', lineHeight: 1.45, color: '#d4d4d8' }}>
                <strong style={{ color: '#ffffff' }}>Action:</strong> {status?.fatigue_action}
              </p>
            </div>
          </section>

          <section
            style={{
              backgroundColor: '#1c1c21',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '16px',
              padding: '16px',
              display: 'flex',
              gap: '14px',
              alignItems: 'flex-start',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '12px',
                backgroundColor: 'rgba(139, 92, 246, 0.14)',
                color: '#a78bfa',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                fontWeight: 800,
                fontSize: '14px',
              }}
            >
              AI
            </div>

            <div style={{ flex: 1 }}>
              <h2 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 700, color: '#ffffff' }}>
                {status?.ai_modification_title}
              </h2>
              <p style={{ margin: 0, fontSize: '13.5px', lineHeight: 1.45, color: '#d4d4d8' }}>
                {status?.ai_modification_body}
              </p>
            </div>
          </section>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
            <button
              type="button"
              onClick={handleApplyMods}
              disabled={busyAction !== null || status?.mods_applied}
              style={{
                width: '100%',
                padding: '15px',
                borderRadius: '999px',
                border: 'none',
                backgroundColor: status?.mods_applied ? '#3b2754' : '#582c83',
                color: '#ffffff',
                fontSize: '15px',
                fontWeight: 700,
                cursor: status?.mods_applied ? 'default' : 'pointer',
                boxShadow: '0 8px 24px rgba(88, 44, 131, 0.4)',
              }}
            >
              {busyAction === 'apply'
                ? 'Applying...'
                : status?.mods_applied
                  ? '✓ Suggested Rest/Mods Applied (-15% Volume)'
                  : 'Apply Suggested Rest/Mods'}
            </button>

            <button
              type="button"
              onClick={handleDismiss}
              disabled={busyAction !== null}
              style={{
                width: '100%',
                padding: '14px',
                borderRadius: '999px',
                border: '1px solid #4b4b52',
                backgroundColor: 'transparent',
                color: '#a1a1aa',
                fontSize: '14.5px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {busyAction === 'dismiss' ? 'Dismissing...' : 'Dismiss and continue anyway'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default OvertrainingAlerts