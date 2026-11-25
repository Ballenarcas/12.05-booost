export interface MockFriend {
  id: string
  name: string
  initials: string
  tone: string
  since: string
  workoutsDays: number
  workoutsDeltaPct: number
  timeHours: number
  timeDeltaPct: number
  defaultOpen?: boolean
}

export const PROFILE_FRIENDS_PREVIEW: MockFriend[] = [
  {
    id: 'maria-mota',
    name: 'Maria Mota',
    initials: 'MM',
    tone: '#5b84b1',
    since: 'Since NOV 2025',
    workoutsDays: 142,
    workoutsDeltaPct: 18,
    timeHours: 98,
    timeDeltaPct: 12,
  },
  {
    id: 'carmen-gomez',
    name: 'Carmen Gómez',
    initials: 'CG',
    tone: '#3f72af',
    since: 'Since JAN 2024',
    workoutsDays: 360,
    workoutsDeltaPct: 35,
    timeHours: 250,
    timeDeltaPct: 17,
    defaultOpen: true,
  },
  {
    id: 'andrea-campos',
    name: 'Andrea Campos',
    initials: 'AC',
    tone: '#6793b8',
    since: 'Since FEB 2026',
    workoutsDays: 84,
    workoutsDeltaPct: 22,
    timeHours: 61,
    timeDeltaPct: 15,
  },
  {
    id: 'pedro-garcia',
    name: 'Pedro García',
    initials: 'PG',
    tone: '#4d7a9c',
    since: 'Since SEP 2024',
    workoutsDays: 245,
    workoutsDeltaPct: 28,
    timeHours: 182,
    timeDeltaPct: 19,
  },
  {
    id: 'carlos-domene',
    name: 'Carlos Domene',
    initials: 'CD',
    tone: '#3a6b8c',
    since: 'Since OCT 2024',
    workoutsDays: 210,
    workoutsDeltaPct: 14,
    timeHours: 164,
    timeDeltaPct: 11,
  },
  {
    id: 'patricia-soriano',
    name: 'Patricia Soriano',
    initials: 'PS',
    tone: '#5a87a3',
    since: 'Since MAY 2025',
    workoutsDays: 176,
    workoutsDeltaPct: 24,
    timeHours: 129,
    timeDeltaPct: 16,
  },
  {
    id: 'marta-blasco',
    name: 'Marta Blasco',
    initials: 'MB',
    tone: '#4b7999',
    since: 'Since DEC 2025',
    workoutsDays: 118,
    workoutsDeltaPct: 19,
    timeHours: 88,
    timeDeltaPct: 13,
  },
  {
    id: 'sergio-cullera',
    name: 'Sergio Cullera',
    initials: 'SC',
    tone: '#3e6d8f',
    since: 'Since NOV 2024',
    workoutsDays: 228,
    workoutsDeltaPct: 21,
    timeHours: 174,
    timeDeltaPct: 14,
  },
  {
    id: 'eric-sanchis',
    name: 'Eric Sanchís',
    initials: 'ES',
    tone: '#5c8aa8',
    since: 'Since APR 2024',
    workoutsDays: 304,
    workoutsDeltaPct: 31,
    timeHours: 215,
    timeDeltaPct: 20,
  },
]

export const MONTHLY_CHALLENGE = {
  targetWorkouts: 25,
  daysLeft: 20,
  partnerName: 'Elena',
  partnerInitials: 'EL',
  partnerWorkouts: 8,
  userWorkouts: 5,
}

export interface CompositionCheckin {
  month: string
  musclePct: number
  fatPct: number
}

export const BODY_COMPOSITION_PREVIEW = {
  muscleDeltaPct: 24,
  fatDeltaPct: -10,
  muscleMassPct: 41.2,
  bodyFatPct: 18.4,
  leanMassKg: 45.1,
  checkins: [
    { month: 'AUG', musclePct: 37.8, fatPct: 20.6 },
    { month: 'SEP', musclePct: 39.0, fatPct: 19.9 },
    { month: 'OCT', musclePct: 40.3, fatPct: 19.0 },
    { month: 'NOV', musclePct: 41.2, fatPct: 18.4 },
  ] as CompositionCheckin[],
}

export interface BodyMeasurementEntry {
  id: string
  label: string
  cm: number
  deltaCm: number
}

export const BODY_MEASUREMENTS_PREVIEW: BodyMeasurementEntry[] = [
  { id: 'chest', label: 'Chest', cm: 96.5, deltaCm: 1.4 },
  { id: 'shoulders', label: 'Shoulders', cm: 112.0, deltaCm: 1.8 },
  { id: 'waist', label: 'Waist', cm: 73.2, deltaCm: -2.1 },
  { id: 'hips', label: 'Hips', cm: 94.8, deltaCm: -0.6 },
  { id: 'right-arm', label: 'Right arm', cm: 34.6, deltaCm: 0.9 },
  { id: 'left-arm', label: 'Left arm', cm: 34.2, deltaCm: 0.8 },
  { id: 'right-thigh', label: 'Right thigh', cm: 56.4, deltaCm: 1.5 },
  { id: 'calves', label: 'Calves', cm: 36.8, deltaCm: 0.4 },
]
