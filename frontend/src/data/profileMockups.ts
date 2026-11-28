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
