import type { WorkoutStatisticsRange } from '../types/workout'
import { locale, t, type MessageKey } from '../i18n/index.ts'

export interface StatisticsRangeOption {
  value: WorkoutStatisticsRange
  label: string
  description: MessageKey
}

export const STATISTICS_RANGES: StatisticsRangeOption[] = [
  { value: '1W', label: '1W', description: 'stats.last7Days' },
  { value: '1M', label: '1M', description: 'stats.lastMonth' },
  { value: '3M', label: '3M', description: 'profile.last3Months' },
]

export const DEFAULT_STATISTICS_RANGE: WorkoutStatisticsRange = '1M'

// Numbers follow the app language: 1,234.5 in English, 1.234,5 in Spanish.
const volumeFormatter = () => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 })
const countFormatter = () => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 })

/** Format workout volume with the app language's grouping and decimal marks. */
export function formatVolumeKg(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return volumeFormatter().format(value)
}

export function formatWorkoutCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return countFormatter().format(Math.floor(value))
}

/** Format recorded seconds as a human-readable duration, e.g. "5 h 35 min". */
export function formatStatisticsDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return t('workouts.unavailable')
  const totalMinutes = Math.floor(seconds / 60)
  if (totalMinutes === 0) return seconds > 0 ? '<1 min' : '0 min'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} min`
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

/** A few round y-axis values (0, 5k, 10k, 15k) whose top tick sits at or above the highest reading. */
export function volumeAxisTicks(maxValue: number): number[] {
  const max = Math.max(1, maxValue)
  const rough = max / 3
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, index) => index * step)
}

/** Axis label: 0, 500, 2.5k, 10k. */
export function formatAxisVolume(value: number): string {
  return value >= 1000 ? `${volumeFormatter().format(value / 1000)}k` : volumeFormatter().format(value)
}

/** Short volume for the stat tiles, as in the wireframe: 950 kg, 9.8k kg, 79.1k kg. */
export function formatCompactVolumeKg(value: number): string {
  if (!Number.isFinite(value) || value < 1000) return `${formatVolumeKg(value)} kg`
  return `${volumeFormatter().format(Math.round(value / 100) / 10)}k kg`
}

/** Short duration for the stat tiles, as in the wireframe: 45m, 2h, 2h40m. */
export function formatCompactDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–'
  const totalMinutes = Math.floor(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, '0')}m`
}

function parseCalendarDate(value: string): Date | null {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

/** Format a YYYY-MM-DD bucket for chart axes without applying a UTC shift. */
export function formatChartDate(value: string, granularity: 'day' | 'week'): string {
  const date = parseCalendarDate(value)
  if (!date) return value
  const formatted = new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric' }).format(date)
  return granularity === 'week' ? t('stats.weekOf', { date: formatted }) : formatted
}

/** Format a fatigue average such as "6.3". */
export function formatFatigueAverage(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '—'
  return volumeFormatter().format(value)
}

/** Format a workout-day bucket without applying a UTC shift. */
export function formatFatigueDay(value: string): string {
  const date = parseCalendarDate(value)
  if (!date) return value
  return new Intl.DateTimeFormat(locale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

export function formatStatisticsDateRange(start: string, end: string): string {
  const startDate = new Date(start)
  const endDate = new Date(end)
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return ''
  const formatter = new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', year: 'numeric' })
  return `${formatter.format(startDate)} – ${formatter.format(endDate)}`
}

export function formatPercentage(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || part <= 0 || total <= 0) return '0%'
  return `${Math.round((part / total) * 100)}%`
}
