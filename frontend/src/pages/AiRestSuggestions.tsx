import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchExercises, fetchWorkoutHistory, getCurrentUser } from '../services/api'
import type { WorkoutHistoryEntry } from '../types/workout'

export type MuscleGroupBucket =
  | 'Chest'
  | 'Shoulders'
  | 'Triceps'
  | 'Back'
  | 'Biceps'
  | 'Quads'
  | 'Hamstrings'
  | 'Glutes'
  | 'Calves'
  | 'Core'

export type ExerciseMuscleMap = Record<string, MuscleGroupBucket>

const ALL_MUSCLE_BUCKETS: MuscleGroupBucket[] = [
  'Chest',
  'Shoulders',
  'Triceps',
  'Back',
  'Biceps',
  'Quads',
  'Hamstrings',
  'Glutes',
  'Calves',
  'Core',
]

let cachedExerciseMuscleMap: ExerciseMuscleMap | null = null

export function normalizeRawMuscleToBucket(raw?: string | null): MuscleGroupBucket | null {
  if (!raw) return null
  const m = raw.toLowerCase().trim()
  if (m.includes('chest') || m.includes('pec')) return 'Chest'
  if (m.includes('tricep')) return 'Triceps'
  if (m.includes('bicep') || m.includes('forearm') || m.includes('brachialis')) return 'Biceps'
  if (m.includes('lat') || m.includes('back') || m.includes('trap') || m.includes('rhomboid')) return 'Back'
  if (m.includes('shoulder') || m.includes('delt') || m.includes('neck')) return 'Shoulders'
  if (m.includes('quad')) return 'Quads'
  if (m.includes('hamstring')) return 'Hamstrings'
  if (m.includes('glute') || m.includes('abductor') || m.includes('adductor')) return 'Glutes'
  if (m.includes('calf') || m.includes('calves')) return 'Calves'
  if (m.includes('ab') || m.includes('core') || m.includes('oblique') || m.includes('waist') || m.includes('lower back')) {
    return 'Core'
  }
  return null
}

export function inferMuscleGroupFromExerciseName(
  name: string,
  exerciseId?: string,
  muscleMap?: ExerciseMuscleMap | null,
): MuscleGroupBucket {
  const activeMap = muscleMap ?? cachedExerciseMuscleMap
  if (exerciseId && activeMap && activeMap[exerciseId]) {
    return activeMap[exerciseId]
  }

  const n = (name || '').toLowerCase()
  if (activeMap && n && activeMap[`name:${n}`]) {
    return activeMap[`name:${n}`]
  }

  // Fallback anatomique précis muscle par muscle (si l'exercice n'est pas encore dans le cache)
  if (n.includes('tricep') || n.includes('pushdown') || n.includes('skullcrusher') || n.includes('kickback')) {
    return 'Triceps'
  }
  if (n.includes('bicep') || n.includes('curl') || n.includes('preacher') || n.includes('hammer')) {
    return 'Biceps'
  }
  if (
    n.includes('pulldown') ||
    n.includes('pull-up') ||
    n.includes('pullup') ||
    n.includes('chin-up') ||
    n.includes('chinup') ||
    n.includes('row') ||
    n.includes('lat ') ||
    n.includes('lats') ||
    n.includes('back') ||
    n.includes('shrug') ||
    n.includes('pullover')
  ) {
    return 'Back'
  }
  if (
    n.includes('shoulder') ||
    n.includes('delt') ||
    n.includes('lateral raise') ||
    n.includes('front raise') ||
    n.includes('overhead press') ||
    n.includes('military press') ||
    n.includes('arnold') ||
    n.includes('face pull') ||
    n.includes('upright row')
  ) {
    return 'Shoulders'
  }
  if (
    n.includes('bench') ||
    n.includes('chest') ||
    n.includes('pec') ||
    n.includes('fly') ||
    n.includes('dip') ||
    n.includes('push-up') ||
    n.includes('pushup')
  ) {
    return 'Chest'
  }
  if (n.includes('hamstring') || n.includes('leg curl') || n.includes('romanian') || n.includes('rdl') || n.includes('stiff')) {
    return 'Hamstrings'
  }
  if (n.includes('glute') || n.includes('hip thrust') || n.includes('bridge') || n.includes('kickback')) {
    return 'Glutes'
  }
  if (n.includes('calf') || n.includes('calves')) {
    return 'Calves'
  }
  if (
    n.includes('squat') ||
    n.includes('leg press') ||
    n.includes('leg extension') ||
    n.includes('lunge') ||
    n.includes('quad') ||
    n.includes('deadlift') ||
    n.includes('hack')
  ) {
    return 'Quads'
  }
  return 'Core'
}

export async function loadExerciseMuscleMap(): Promise<ExerciseMuscleMap> {
  if (cachedExerciseMuscleMap) return cachedExerciseMuscleMap
  const map: ExerciseMuscleMap = {}
  try {
    const res = await fetchExercises({ limit: 500, compact: true })
    const rawList = (res as unknown as { items?: unknown[]; exercises?: unknown[] })?.items ??
      (res as unknown as { exercises?: unknown[] })?.exercises ??
      (Array.isArray(res) ? res : [])

    for (const rawItem of rawList) {
      if (!rawItem || typeof rawItem !== 'object') continue
      const item = rawItem as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id : typeof item.exercise_id === 'string' ? item.exercise_id : null
      const name = typeof item.name === 'string' ? item.name.toLowerCase() : null

      const primaryList = Array.isArray(item.primary_muscles) ? item.primary_muscles : []
      const firstPrimary = typeof primaryList[0] === 'string' ? primaryList[0] : null
      const rawMuscle =
        firstPrimary ??
        (typeof item.muscle === 'string' ? item.muscle : null) ??
        (typeof item.muscle_group === 'string' ? item.muscle_group : null) ??
        (typeof item.target_muscle === 'string' ? item.target_muscle : null) ??
        (typeof item.body_part === 'string' ? item.body_part : null)

      const bucket =
        normalizeRawMuscleToBucket(rawMuscle) ??
        (name ? inferMuscleGroupFromExerciseName(name) : null)

      if (bucket) {
        if (id) map[id] = bucket
        if (name) map[`name:${name}`] = bucket
      }
    }
    if (Object.keys(map).length > 0) {
      cachedExerciseMuscleMap = map
    }
  } catch {
    // Fallback sur l'analyse anatomique si l'API exercices est hors ligne
  }
  return map
}

interface StoredCheckIn {
  cnsFatigue?: number
  domsSoreness?: number
  effectiveFatigue?: number
  effectiveSoreness?: number
  sleepQuality?: 'restorative' | 'average' | 'poor'
  jointStrain?: 'none' | 'mild' | 'sharp'
  muscles?: string[]
  createdAt?: string
}

interface SuggestionSet {
  immediateTitle: string
  immediateBody: string
  activeTitle: string
  activeBody: string
  sleepTitle: string
  sleepBody: string
  adjustmentTitle: string
  adjustmentBody: string
  recommendedVolumeCutPct: number
  fatiguedMuscleGroups: MuscleGroupBucket[]
  isSystemicFatigue: boolean
}

export interface RestDayScheduleState {
  date: string
  appliedAt: string
  reason: string
  activeRecoveryText: string
  caloricAdjustmentKcal: number
  proteinBonusGrams: number
  carbsReductionGrams: number
  volumeReductionPct: number
  fatiguedMuscleGroups: MuscleGroupBucket[]
  isSystemic: boolean
}

export function getRestDayScheduleKey(userId?: string): string {
  return `set_plate_rest_day_schedule_${userId ?? 'guest'}`
}

export function getTodayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function readTodayRestDaySchedule(userId?: string): RestDayScheduleState | null {
  try {
    const raw = localStorage.getItem(getRestDayScheduleKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as RestDayScheduleState
    if (parsed && parsed.date === getTodayIsoDate()) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function checkUserIsPremium(user: ReturnType<typeof getCurrentUser>): boolean {
  const override = localStorage.getItem('set_plate_premium_override')
  if (override === 'true') return true
  if (override === 'false') return false
  if (!user) return false
  const record = user as Record<string, unknown>
  return Boolean(
    record.is_premium ||
      record.isPremium ||
      record.subscription_tier === 'premium' ||
      record.plan === 'premium' ||
      record.tier === 'premium',
  )
}

function readUserCheckIns(userId?: string): StoredCheckIn[] {
  try {
    const raw = localStorage.getItem(`set_plate_recovery_checkins_${userId ?? 'guest'}`)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as StoredCheckIn[]) : []
  } catch {
    return []
  }
}

function getFreshAlternativeMuscles(fatigued: MuscleGroupBucket[]): string {
  const isPushFatigued = fatigued.some((m) => m === 'Chest' || m === 'Shoulders' || m === 'Triceps')
  const isPullFatigued = fatigued.some((m) => m === 'Back' || m === 'Biceps')
  const isLegsFatigued = fatigued.some((m) => m === 'Quads' || m === 'Hamstrings' || m === 'Glutes')

  if (isPushFatigued && !isPullFatigued && !isLegsFatigued) return 'Back & Biceps (Pull) or Legs'
  if (isPullFatigued && !isPushFatigued && !isLegsFatigued) return 'Chest & Shoulders (Push) or Legs'
  if (isLegsFatigued && !isPushFatigued && !isPullFatigued) return 'Upper Body (Push or Pull)'
  if (!isLegsFatigued) return 'Lower Body (Quads, Hamstrings & Glutes)'
  if (!isPullFatigued) return 'Back & Biceps'
  return 'fresh opposing muscles'
}

function buildDynamicSuggestionVariants(
  workouts: WorkoutHistoryEntry[],
  checkIns: StoredCheckIn[],
  muscleMap: ExerciseMuscleMap,
): { profileSummary: string; variants: SuggestionSet[] } {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const recentWorkouts = workouts.filter((w) => {
    const t = Date.parse(w.started_at)
    return Number.isFinite(t) ? t >= sevenDaysAgo : true
  })

  const sessions7d = recentWorkouts.length
  let totalSets7d = 0
  let highRpeSets7d = 0
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

  for (const w of recentWorkouts) {
    for (const ex of w.exercises) {
      const muscle = inferMuscleGroupFromExerciseName(ex.name || '', ex.exercise_id, muscleMap)
      for (const s of ex.sets) {
        const weight = Number(s.weight_kg || 0)
        const reps = Number(s.reps || 0)
        const isDone = s.is_completed !== false && (s.is_completed || reps > 0 || weight > 0)
        if (!isDone) continue

        totalSets7d += 1
        setsByMuscle[muscle] += 1
        if (typeof s.rpe === 'number' && s.rpe >= 8.5) {
          highRpeSets7d += 1
        }
      }
    }
  }

  const sortedMuscles = (Object.entries(setsByMuscle) as Array<[MuscleGroupBucket, number]>).sort(
    (a, b) => b[1] - a[1],
  )
  const topMuscle: MuscleGroupBucket = sortedMuscles[0]?.[0] ?? 'Chest'
  const topMuscleSets: number = sortedMuscles[0]?.[1] ?? 0
  const activeMusclesList = sortedMuscles.filter(([, count]) => count > 0)

  // Vrais muscles sollicités lors de la toute dernière séance (< 48h)
  const latestWorkout = recentWorkouts[0]
  const latestWorkoutMuscles: MuscleGroupBucket[] = []
  if (latestWorkout) {
    for (const ex of latestWorkout.exercises) {
      const m = inferMuscleGroupFromExerciseName(ex.name || '', ex.exercise_id, muscleMap)
      if (!latestWorkoutMuscles.includes(m)) latestWorkoutMuscles.push(m)
    }
  }

  const recentExerciseNames =
    latestWorkout && latestWorkout.exercises.length > 0
      ? latestWorkout.exercises
          .slice(0, 2)
          .map((e) => e.name)
          .join(' & ')
      : null

  const latestCheckIn = checkIns[0]
  const hasCheckIn = Boolean(latestCheckIn)
  const cnsScore = latestCheckIn?.cnsFatigue ?? latestWorkout?.fatigue_level ?? 0
  const domsScore = latestCheckIn?.domsSoreness ?? 0
  const sleepState = latestCheckIn?.sleepQuality
  const jointState = latestCheckIn?.jointStrain ?? 'none'
  const highFatigueCheckInsCount = checkIns.filter(
    (c) => (c.cnsFatigue ?? 0) >= 7 || (c.domsSoreness ?? 0) >= 7,
  ).length

  const muscleBreakdownText =
    activeMusclesList.length > 0
      ? activeMusclesList
          .slice(0, 3)
          .map(([m, c]) => `${m}: ${c}/18 sets`)
          .join(' · ')
      : 'No muscle sets logged'

  const profileSummary = `${sessions7d} workout${sessions7d === 1 ? '' : 's'} (${totalSets7d} total sets) · ${muscleBreakdownText}${
    cnsScore > 0 ? ` · Fatigue: ${cnsScore}/10` : ''
  }`

  // =========================================================================
  // CAS 0 : AUCUN ENTRAÎNEMENT ET AUCUN CHECK-IN (0 workouts, 0 check-ins)
  // =========================================================================
  if (sessions7d === 0 && !hasCheckIn) {
    return {
      profileSummary,
      variants: [
        {
          immediateTitle: '100% Fresh — No Fatigue Accumulated',
          immediateBody:
            'You have 0 workouts and 0 fatigue check-ins logged in the last 7 days. All muscle groups and your CNS are fully rested.',
          activeTitle: 'Light Mobility or Zone-2 Warmup',
          activeBody:
            'If taking a rest day today, 20 min brisk walk and dynamic joint mobility will keep blood flow elevated.',
          sleepTitle: 'Baseline Sleep & Protein Readiness',
          sleepBody:
            'No sleep deficit logged. Aim for 7.5–8h of sleep and 1.6–2.0g/kg protein to stay primed for your next session.',
          adjustmentTitle: 'No Volume Reduction Needed (100% Capacity)',
          adjustmentBody:
            'If you train today, you can perform your full programmed sets at normal intensity (RPE 7.5–8.5).',
          recommendedVolumeCutPct: 0,
          fatiguedMuscleGroups: [],
          isSystemicFatigue: false,
        },
        {
          immediateTitle: 'Baseline Readiness — Ready to Train or Rest',
          immediateBody:
            'Zero mechanical or neurological strain recorded over the past 7 days. Ideal window to start a new training block.',
          activeTitle: 'Daily Step Goal & Posture Reset',
          activeBody:
            'Target 8,000–10,000 steps today with 10 minutes of thoracic and hip flexor stretching.',
          sleepTitle: 'Pre-Session Nutrition & Hydration',
          sleepBody:
            'Stay hydrated (2.5–3L water) and consume a balanced meal with 30–40g protein 2 hours before training.',
          adjustmentTitle: 'Train at Standard Volume (Full Capacity)',
          adjustmentBody:
            'Coming off multiple rest days, keep 2 Reps in Reserve (RIR) on your first compound lift to avoid excessive DOMS.',
          recommendedVolumeCutPct: 0,
          fatiguedMuscleGroups: [],
          isSystemicFatigue: false,
        },
      ],
    }
  }

  // =========================================================================
  // CAS 1A : SURCHARGE D'UN MUSCLE INDIVIDUEL (>= 18 séries sur le MÊME muscle, ex: Chest >= 18)
  // =========================================================================
  const overloadedMuscles = sortedMuscles.filter(([, count]) => count >= 18).map(([m]) => m)
  const isLocalizedMuscleOverload = sessions7d >= 2 && overloadedMuscles.length > 0

  if (isLocalizedMuscleOverload) {
    const overloadedLabel = overloadedMuscles.join(' & ')
    const freshAlternatives = getFreshAlternativeMuscles(overloadedMuscles)
    const sleepBodyText =
      sleepState === 'poor'
        ? 'Sleep duration was low (<6.5h). Target 8+ hours & 30g protein before bed.'
        : `High volume on ${overloadedLabel} (${topMuscleSets}/18 sets) requires 8+ hours of sleep & 30g protein before bed.`

    return {
      profileSummary,
      variants: [
        {
          immediateTitle: `Rest ${overloadedLabel} Today (Muscle Overload)`,
          immediateBody: `High localized fatigue detected in ${overloadedLabel} (${topMuscleSets} working sets logged on ${topMuscle} in 7d, reaching the 18-set muscle recovery limit).`,
          activeTitle: 'Light Active Recovery',
          activeBody: `20-30 min slow walk, mobility work, and light stretching for ${overloadedLabel.toLowerCase()}. Keep heart rate low.`,
          sleepTitle: 'Increase Sleep & Protein Intake',
          sleepBody: sleepBodyText,
          adjustmentTitle: `Reduce ${overloadedLabel} by 35% (Keep ${freshAlternatives} at 100%)`,
          adjustmentBody: `Only ${overloadedLabel} exercises are reduced by 35%. Training ${freshAlternatives} today will run at 100% normal weights!`,
          recommendedVolumeCutPct: 35,
          fatiguedMuscleGroups: overloadedMuscles,
          isSystemicFatigue: false,
        },
        {
          immediateTitle: 'Take a Rest Day or Switch to Fresh Muscles',
          immediateBody: `You accumulated ${topMuscleSets} sets specifically on ${topMuscle} across ${sessions7d} workouts. Allow 48–72h for myofibrillar repair.`,
          activeTitle: 'Zone 1 Blood-Flow & Tendon Recovery',
          activeBody: '20 min incline walk + band decompression to flush metabolites without adding eccentric damage.',
          sleepTitle: 'Evening Protein & Collagen Synthesis',
          sleepBody: 'Target 140g+ daily protein (including 35g protein before sleep) and 8.5 hours in bed.',
          adjustmentTitle: `Cut Top Sets Only on ${overloadedLabel}`,
          adjustmentBody: `If you still train ${overloadedLabel.toLowerCase()} today, drop working sets by 35% and cap RPE at 6.`,
          recommendedVolumeCutPct: 35,
          fatiguedMuscleGroups: overloadedMuscles,
          isSystemicFatigue: false,
        },
      ],
    }
  }

  // =========================================================================
  // CAS 1B : HAUTE FATIGUE SYSTÉMIQUE GLOBALE (>= 75 sets totaux, RPE >= 20, >= 6 séances, ou >= 2 check-ins)
  // =========================================================================
  const isHighSystemicFatigue =
    (sessions7d >= 4 && totalSets7d >= 75) ||
    (sessions7d >= 3 && highRpeSets7d >= 20) ||
    sessions7d >= 6 ||
    highFatigueCheckInsCount >= 2

  if (isHighSystemicFatigue) {
    const workoutContext = recentExerciseNames
      ? `from recent ${recentExerciseNames} (${sessions7d} sessions, ${totalSets7d} total sets)`
      : `across ${highFatigueCheckInsCount} high-fatigue recovery check-ins (CNS ${cnsScore}/10, DOMS ${domsScore}/10)`

    const sleepBodyText =
      sleepState === 'poor'
        ? 'Sleep duration was low (<6.5h). Target 8+ hours & 30g protein before bed.'
        : 'High systemic strain requires extra recovery: target 8+ hours of sleep & 30g protein before bed.'

    return {
      profileSummary,
      variants: [
        {
          immediateTitle: 'Take a Full Rest Day Today',
          immediateBody: `High systemic fatigue detected ${workoutContext}.`,
          activeTitle: 'Light Active Recovery',
          activeBody: '20-30 min slow walk, mobility work, and stretching. Keep heart rate low.',
          sleepTitle: 'Increase Sleep & Protein Intake',
          sleepBody: sleepBodyText,
          adjustmentTitle: 'Reduce Volume by 30-40%',
          adjustmentBody: 'If training, focus on light technique work. Cut top sets entirely across all lifts.',
          recommendedVolumeCutPct: 35,
          fatiguedMuscleGroups: ALL_MUSCLE_BUCKETS,
          isSystemicFatigue: true,
        },
        {
          immediateTitle: 'Prioritize Complete CNS Recovery Today',
          immediateBody: `Elevated neuromuscular strain ${workoutContext}. Avoid heavy axial loading and failure sets for 24h.`,
          activeTitle: 'Zone 1 Blood-Flow & Mobility Session',
          activeBody: '15-20 min full-body mobility + 15 min incline walk under 115 BPM.',
          sleepTitle: 'Evening Glycogen & Magnesium Protocol',
          sleepBody: 'Target 8.5 hours in bed, 40g complex carbs at dinner, and 400mg magnesium glycinate.',
          adjustmentTitle: 'Cap Intensity at RPE 6 (Global Deload)',
          adjustmentBody: 'If you still enter the gym, swap heavy free weights for machine isolation at -35% load.',
          recommendedVolumeCutPct: 35,
          fatiguedMuscleGroups: ALL_MUSCLE_BUCKETS,
          isSystemicFatigue: true,
        },
      ],
    }
  }

  // =========================================================================
  // CAS 2 : VOLUME PAR MUSCLE SAIN (< 18 sets par muscle, ex: 1 ou 2 Push Days où Chest = 9 ou 12/18 sets)
  // =========================================================================
  const recentlyWorkedMuscles = latestWorkoutMuscles.length > 0 ? latestWorkoutMuscles : [topMuscle]
  const recentlyWorkedLabel = recentlyWorkedMuscles.join(' & ')
  const freshAlternatives = getFreshAlternativeMuscles(recentlyWorkedMuscles)
  const hasHighSessionEffort = cnsScore >= 7 || domsScore >= 7 || highRpeSets7d >= 6 || totalSets7d >= 12
  const targetedCut = hasHighSessionEffort ? 25 : 15

  return {
    profileSummary,
    variants: [
      {
        immediateTitle: `Rest ${recentlyWorkedLabel} or Train ${freshAlternatives}`,
        immediateBody: `Per-muscle volume is within safe limits (${muscleBreakdownText}). No single muscle exceeds the 18-set weekly limit, though ${recentlyWorkedLabel} worked recently (${recentExerciseNames ?? 'latest session'}) benefits from 48h recovery.`,
        activeTitle: 'Light Active Recovery',
        activeBody: `20-30 min slow walk, mobility work, and stretching on ${recentlyWorkedLabel.toLowerCase()}. Keep heart rate low.`,
        sleepTitle: 'Sleep & Post-Workout Protein Target',
        sleepBody:
          sleepState === 'poor'
            ? 'Sleep duration was low (<6.5h). Target 8+ hours tonight & 30g protein before bed.'
            : 'Target 8 hours of sleep tonight and +15g extra protein today to remodel worked muscle fibers.',
        adjustmentTitle: `Keep ${freshAlternatives} at 100% (-${targetedCut}% Only on ${recentlyWorkedLabel})`,
        adjustmentBody: `If you apply a Rest Day today, ${freshAlternatives} (e.g. Pull Day / Legs) stay at 100% full load! Only ${recentlyWorkedLabel} exercises are reduced by ${targetedCut}% if repeated today.`,
        recommendedVolumeCutPct: targetedCut,
        fatiguedMuscleGroups: recentlyWorkedMuscles,
        isSystemicFatigue: false,
      },
      {
        immediateTitle: 'Healthy Per-Muscle Volume — 48h Local Recovery',
        immediateBody: `Highest individual muscle volume is ${topMuscle} at ${topMuscleSets}/18 sets across ${sessions7d} session${sessions7d === 1 ? '' : 's'}. Systemic CNS readiness is intact.`,
        activeTitle: 'Decompression Mobility & Zone-1 Walk',
        activeBody:
          jointState !== 'none'
            ? '20 min walk + joint decompression mobility. Zero tendon strain today.'
            : '15 min thoracic & shoulder opener + 20 min incline treadmill walk (12% incline, 4.5 km/h).',
        sleepTitle: 'Evening Protein & Glycogen Refill',
        sleepBody: 'Aim for 130g–150g daily protein and 30g slow-digesting protein before bed.',
        adjustmentTitle: `100% Normal Load on ${freshAlternatives}`,
        adjustmentBody: `Rotate to ${freshAlternatives} today at 100% normal volume, or take an active recovery day.`,
        recommendedVolumeCutPct: targetedCut,
        fatiguedMuscleGroups: recentlyWorkedMuscles,
        isSystemicFatigue: false,
      },
    ],
  }
}

function CrownBadge() {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        backgroundColor: 'rgba(234, 179, 8, 0.14)',
        border: '1px solid rgba(234, 179, 8, 0.35)',
        borderRadius: '10px',
        padding: '6px 11px',
        color: '#facc15',
        fontSize: '11.5px',
        fontWeight: 800,
        letterSpacing: '0.04em',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="#facc15" aria-hidden="true">
        <path d="M2 19h20v2H2v-2zm0-13l5 5 5-7 5 7 5-5v11H2V6z" />
      </svg>
      PREMIUM
    </div>
  )
}

function InfoBullet({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        marginTop: '8px',
        color: '#d4d4d8',
        fontSize: '14px',
        lineHeight: 1.45,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '17px',
          height: '17px',
          borderRadius: '999px',
          border: '1.5px solid #8e8e93',
          color: '#a1a1aa',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          fontWeight: 700,
          flexShrink: 0,
          marginTop: '2px',
        }}
      >
        i
      </span>
      <span>{text}</span>
    </div>
  )
}

function AiRestSuggestions() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const userId = user?.id

  const [isPremium, setIsPremium] = useState<boolean>(() => {
    const stored = localStorage.getItem('set_plate_premium_override')
    if (stored === 'false') return false
    if (stored === 'true') return true
    return checkUserIsPremium(user) || true
  })

  const [workouts, setWorkouts] = useState<WorkoutHistoryEntry[]>([])
  const [muscleMap, setMuscleMap] = useState<ExerciseMuscleMap>(() => cachedExerciseMuscleMap ?? {})
  const [checkIns, setCheckIns] = useState<StoredCheckIn[]>([])
  const [isInitialLoading, setIsInitialLoading] = useState<boolean>(true)
  const [isRegenerating, setIsRegenerating] = useState<boolean>(false)
  const [variantIndex, setVariantIndex] = useState<number>(0)
  const [restDayState, setRestDayState] = useState<RestDayScheduleState | null>(() =>
    readTodayRestDaySchedule(userId),
  )
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  const loadUserData = useCallback(async () => {
    setIsInitialLoading(true)
    const loadedCheckIns = readUserCheckIns(userId)
    setCheckIns(loadedCheckIns)

    const [loadedMap, loadedHistory] = await Promise.all([
      loadExerciseMuscleMap(),
      userId ? fetchWorkoutHistory(userId).catch(() => [] as WorkoutHistoryEntry[]) : Promise.resolve([] as WorkoutHistoryEntry[]),
    ])

    setMuscleMap(loadedMap)
    setWorkouts(loadedHistory)

    setTimeout(() => {
      setIsInitialLoading(false)
    }, 380)
  }, [userId])

  useEffect(() => {
    void loadUserData()
  }, [loadUserData])

  const { profileSummary, variants } = buildDynamicSuggestionVariants(workouts, checkIns, muscleMap)
  const activeSuggestion = variants[variantIndex % variants.length]

  const handleRegenerate = () => {
    setIsRegenerating(true)
    setToastMessage(null)
    setTimeout(() => {
      setVariantIndex((prev) => (prev + 1) % variants.length)
      setIsRegenerating(false)
      setToastMessage('Fresh AI recovery recommendations generated from your per-muscle logs.')
    }, 520)
  }

  const handleApplyRestDay = () => {
    const cutPct = activeSuggestion.recommendedVolumeCutPct
    const fatiguedGroups = activeSuggestion.fatiguedMuscleGroups
    const isSystemic = activeSuggestion.isSystemicFatigue

    const scheduleReason =
      workouts.length === 0 && checkIns.length === 0
        ? 'Scheduled voluntary recovery & mobility day (CNS 100% fresh).'
        : activeSuggestion.immediateBody

    const newState: RestDayScheduleState = {
      date: getTodayIsoDate(),
      appliedAt: new Date().toISOString(),
      reason: scheduleReason,
      activeRecoveryText: activeSuggestion.activeBody,
      caloricAdjustmentKcal: -250,
      proteinBonusGrams: 15,
      carbsReductionGrams: 50,
      volumeReductionPct: cutPct,
      fatiguedMuscleGroups: fatiguedGroups,
      isSystemic,
    }
    localStorage.setItem(getRestDayScheduleKey(userId), JSON.stringify(newState))
    localStorage.removeItem('set_plate_overtraining_mod_pct')
    setRestDayState(newState)

    if (cutPct > 0 && fatiguedGroups.length > 0) {
      const scopeLabel = isSystemic
        ? `all workouts (-${cutPct}%)`
        : `${fatiguedGroups.join(', ')} exercises (-${cutPct}%), while fresh muscles (e.g. Back/Legs) stay at 100%`
      setToastMessage(
        `Schedule & Dashboard updated: Today is a Rest Day (-250 kcal, +15g Protein). Targeted deload active on ${scopeLabel}.`,
      )
    } else {
      setToastMessage(
        'Schedule & Dashboard updated: Today is marked as a Rest Day (-250 kcal, +15g Protein).',
      )
    }
  }

  const handleClearRestDay = () => {
    localStorage.removeItem(getRestDayScheduleKey(userId))
    setRestDayState(null)
    setToastMessage('Rest day removed from today’s schedule and dashboard.')
  }

  const togglePremiumDemoMode = () => {
    const next = !isPremium
    setIsPremium(next)
    localStorage.setItem('set_plate_premium_override', String(next))
  }

  return (
    <div
      className="screen"
      style={{
        minHeight: '100vh',
        backgroundColor: '#0f0e13',
        color: '#f4f4f6',
        padding: '18px 18px 115px',
        boxSizing: 'border-box',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingBottom: '14px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          marginBottom: '16px',
        }}
      >
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Go back"
          style={{
            background: 'none',
            border: 'none',
            color: '#f4f4f6',
            fontSize: '22px',
            cursor: 'pointer',
            padding: '4px 8px 4px 0',
            lineHeight: 1,
          }}
        >
          ‹
        </button>

        <h1
          style={{
            margin: 0,
            fontSize: '18px',
            fontWeight: 800,
            letterSpacing: '0.03em',
            textTransform: 'uppercase',
            color: '#ffffff',
          }}
        >
          AI REST SUGGESTIONS
        </h1>

        <button
          type="button"
          onClick={togglePremiumDemoMode}
          title="Click to toggle Free vs Premium paywall for testing"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          <CrownBadge />
        </button>
      </header>

      {!isPremium ? (
        <div
          role="region"
          aria-label="Premium Paywall"
          style={{
            backgroundColor: '#191722',
            border: '1.5px solid rgba(234, 179, 8, 0.45)',
            borderRadius: '18px',
            padding: '28px 20px',
            textAlign: 'center',
            marginTop: '24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '14px',
          }}
        >
          <CrownBadge />
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: '#ffffff' }}>
            Unlock AI Rest &amp; Recovery Coaching
          </h2>
          <p style={{ margin: 0, fontSize: '14px', color: '#a1a1aa', lineHeight: 1.5, maxWidth: '340px' }}>
            AI Rest Suggestions is a Premium feature. Upgrade to analyze your per-muscle volume, workout intensity, and sleep logs for 1-tap schedule adjustments.
          </p>
          <button
            type="button"
            onClick={togglePremiumDemoMode}
            style={{
              marginTop: '8px',
              width: '100%',
              maxWidth: '300px',
              padding: '14px 18px',
              borderRadius: '999px',
              border: 'none',
              backgroundColor: '#eab308',
              color: '#0f0e13',
              fontSize: '15px',
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            Upgrade to Premium (Unlock Now)
          </button>
        </div>
      ) : isInitialLoading ? (
        <div
          role="status"
          style={{
            backgroundColor: '#181622',
            border: '1px solid rgba(168, 85, 247, 0.35)',
            borderRadius: '16px',
            padding: '36px 20px',
            textAlign: 'center',
            marginTop: '20px',
          }}
        >
          <div style={{ fontSize: '15px', fontWeight: 700, color: '#e9d5ff', marginBottom: '6px' }}>
            Analyzing individual muscle volume, intensity &amp; fatigue logs...
          </div>
          <div style={{ fontSize: '13px', color: '#a1a1aa' }}>
            Mapping exercise IDs to anatomical muscle groups
          </div>
        </div>
      ) : (
        <>
          <p
            style={{
              margin: '0 0 6px',
              fontSize: '15px',
              color: '#a1a1aa',
              lineHeight: 1.4,
            }}
          >
            Based on your recent workout intensity and fatigue patterns:
          </p>
          <div
            style={{
              fontSize: '11.5px',
              color: '#9d65c9',
              backgroundColor: 'rgba(157, 101, 201, 0.1)',
              border: '1px solid rgba(157, 101, 201, 0.25)',
              borderRadius: '10px',
              padding: '7px 11px',
              marginBottom: '16px',
            }}
          >
            {profileSummary}
          </div>

          {toastMessage && (
            <div
              role="status"
              style={{
                backgroundColor: 'rgba(46, 213, 115, 0.14)',
                border: '1.5px solid #2ed573',
                color: '#a3f7bf',
                borderRadius: '14px',
                padding: '12px 14px',
                marginBottom: '16px',
                fontSize: '13.5px',
                lineHeight: 1.45,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <span>✓ {toastMessage}</span>
                {restDayState && (
                  <button
                    type="button"
                    onClick={handleClearRestDay}
                    style={{
                      background: 'rgba(255,255,255,0.1)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      color: '#ffffff',
                      borderRadius: '999px',
                      padding: '4px 10px',
                      fontSize: '11.5px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    Undo
                  </button>
                )}
              </div>
              {restDayState && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => navigate('/')}
                    style={{
                      background: '#32d768',
                      border: 'none',
                      color: '#0b2211',
                      borderRadius: '999px',
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    View Adjusted Dashboard →
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/workouts')}
                    style={{
                      background: 'rgba(255,255,255,0.12)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      color: '#ffffff',
                      borderRadius: '999px',
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    View Workouts →
                  </button>
                </div>
              )}
            </div>
          )}

          {isRegenerating ? (
            <div
              role="status"
              style={{
                backgroundColor: '#191722',
                border: '1.5px solid #7e57c2',
                borderRadius: '16px',
                padding: '40px 18px',
                textAlign: 'center',
                marginBottom: '20px',
              }}
            >
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#d8b4fe', marginBottom: '6px' }}>
                Recalculating recovery tactics...
              </div>
              <div style={{ fontSize: '13px', color: '#a1a1aa' }}>
                Evaluating individual muscle sets, RPE strain, and sleep recovery markers
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '22px' }}>
              <section
                style={{
                  backgroundColor: '#191820',
                  border: '1.5px solid #7c5295',
                  borderRadius: '16px',
                  padding: '16px',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 800,
                    letterSpacing: '0.05em',
                    color: '#9d65c9',
                    textTransform: 'uppercase',
                    marginBottom: '8px',
                  }}
                >
                  IMMEDIATE REST RECOMMENDATION
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '999px',
                      backgroundColor: '#9d65c9',
                      color: '#191820',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 900,
                      fontSize: '13px',
                      flexShrink: 0,
                    }}
                  >
                    ✓
                  </span>
                  <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#ffffff' }}>
                    {activeSuggestion.immediateTitle}
                  </h2>
                </div>
                <InfoBullet text={activeSuggestion.immediateBody} />
              </section>

              <section
                style={{
                  backgroundColor: '#191820',
                  border: '1.5px solid #7c5295',
                  borderRadius: '16px',
                  padding: '16px',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 800,
                    letterSpacing: '0.05em',
                    color: '#9d65c9',
                    textTransform: 'uppercase',
                    marginBottom: '8px',
                  }}
                >
                  ACTIVE RECOVERY OPTION
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span aria-hidden="true" style={{ fontSize: '19px', color: '#9d65c9', lineHeight: 1 }}>
                    🚶
                  </span>
                  <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#ffffff' }}>
                    {activeSuggestion.activeTitle}
                  </h2>
                </div>
                <InfoBullet text={activeSuggestion.activeBody} />
              </section>

              <section
                style={{
                  backgroundColor: '#191820',
                  border: '1.5px solid #7c5295',
                  borderRadius: '16px',
                  padding: '16px',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 800,
                    letterSpacing: '0.05em',
                    color: '#9d65c9',
                    textTransform: 'uppercase',
                    marginBottom: '8px',
                  }}
                >
                  SLEEP &amp; NUTRITION GOAL
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span aria-hidden="true" style={{ fontSize: '18px', color: '#9d65c9', lineHeight: 1 }}>
                    🛏️
                  </span>
                  <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#ffffff' }}>
                    {activeSuggestion.sleepTitle}
                  </h2>
                </div>
                <InfoBullet text={activeSuggestion.sleepBody} />
              </section>

              <section
                style={{
                  backgroundColor: '#191820',
                  border: '1.5px solid #7c5295',
                  borderRadius: '16px',
                  padding: '16px',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 800,
                    letterSpacing: '0.05em',
                    color: '#9d65c9',
                    textTransform: 'uppercase',
                    marginBottom: '8px',
                  }}
                >
                  TRAINING ADJUSTMENT (IF YOU STILL WORKOUT)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      fontSize: '20px',
                      fontWeight: 900,
                      color: '#9d65c9',
                      lineHeight: 1,
                    }}
                  >
                    ↓
                  </span>
                  <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#ffffff' }}>
                    {activeSuggestion.adjustmentTitle}
                  </h2>
                </div>
                <InfoBullet text={activeSuggestion.adjustmentBody} />
              </section>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <button
              type="button"
              onClick={handleApplyRestDay}
              style={{
                width: '100%',
                padding: '16px',
                borderRadius: '999px',
                border: 'none',
                backgroundColor: '#32d768',
                color: '#0b2211',
                fontSize: '16px',
                fontWeight: 800,
                cursor: 'pointer',
                boxShadow: '0 6px 20px rgba(50, 215, 104, 0.28)',
              }}
            >
              {restDayState ? '✓ Rest Day Applied to Today’s Schedule' : '+ Apply Rest Day to Schedule'}
            </button>

            <button
              type="button"
              onClick={handleRegenerate}
              disabled={isRegenerating}
              style={{
                width: '100%',
                padding: '15px',
                borderRadius: '999px',
                border: '1.5px solid #7c5295',
                backgroundColor: 'transparent',
                color: '#9d65c9',
                fontSize: '16px',
                fontWeight: 700,
                cursor: isRegenerating ? 'default' : 'pointer',
              }}
            >
              {isRegenerating ? 'Recalculating...' : 'Regenerate Suggestions'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default AiRestSuggestions