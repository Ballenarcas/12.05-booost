import type { NutritionStatisticsRange } from '../types/nutrition'

const intFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const decimalFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export interface SplitMetricValue {
  value: string
  unit: string
  exact: string
}

/** Format hydration volume for the hero tile (ml under 1 L, liters at or above 1 L). */
export function formatCompactHydration(totalMl: number): SplitMetricValue {
  if (!Number.isFinite(totalMl) || totalMl <= 0) {
    return { value: '0', unit: 'l', exact: '0 ml' }
  }
  if (totalMl < 1000) {
    const rounded = Math.round(totalMl)
    return {
      value: intFormatter.format(rounded),
      unit: 'ml',
      exact: `${intFormatter.format(rounded)} ml`,
    }
  }
  const liters = Math.round((totalMl / 1000) * 10) / 10
  return {
    value: decimalFormatter.format(liters),
    unit: 'l',
    exact: `${decimalFormatter.format(liters)} l`,
  }
}

/** Format macro grams for tiles and breakdown items (up to 99,999g exact, then compact k). */
export function formatCompactGrams(grams: number): SplitMetricValue {
  if (!Number.isFinite(grams) || grams <= 0) {
    return { value: '0', unit: 'g', exact: '0 g' }
  }
  const rounded = Math.round(grams)
  const exact = `${intFormatter.format(rounded)} g`
  if (rounded >= 100_000) {
    return {
      value: `${decimalFormatter.format(Math.round(rounded / 100) / 10)}k`,
      unit: 'g',
      exact,
    }
  }
  return {
    value: intFormatter.format(rounded),
    unit: 'g',
    exact,
  }
}

/** Format weight volume in kg as split value + unit for Space Mono readouts. */
export function formatCompactKgParts(kg: number): SplitMetricValue {
  if (!Number.isFinite(kg) || kg <= 0) {
    return { value: '0', unit: 'kg', exact: '0 kg' }
  }
  const exact = `${decimalFormatter.format(kg)} kg`
  if (kg < 1000) {
    return {
      value: decimalFormatter.format(kg),
      unit: 'kg',
      exact,
    }
  }
  return {
    value: `${decimalFormatter.format(Math.round(kg / 100) / 10)}k`,
    unit: 'kg',
    exact,
  }
}

/** Y-axis ticks matching the Figma mockup ("1,000" .. "6,000", compacting at 10k+). */
export function formatAxisNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value >= 10_000) {
    return `${decimalFormatter.format(value / 1000)}k`
  }
  return intFormatter.format(Math.round(value))
}

export function parseDateKey(value: string): Date | null {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

export function toLocalDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Uppercase X-axis endpoint label for progression charts ("OCT 2026" for 1M/3M, "OCT 20" for 1W). */
export function formatProgressionAxisLabel(dateStr: string, range: NutritionStatisticsRange): string {
  const parsed = parseDateKey(dateStr)
  if (!parsed) return dateStr.toUpperCase()
  const formatted = range === '1W'
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(parsed)
    : new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(parsed)
  return formatted.toUpperCase()
}
