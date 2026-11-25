import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { TrendingUp } from 'lucide-react'
import { locale, t } from '../../i18n'
import type { NutritionStatisticsRange } from '../../types/nutrition'
import { formatAxisNumber, formatProgressionAxisLabel } from '../../utils/nutritionStatistics'
import { useSpring } from '../../utils/useSpring'
import { formatChartDate, volumeAxisTicks } from '../../utils/workoutStatistics'

export interface ProgressionDatum {
  date: string
  value: number
  loggedDays?: number
}

interface StatsProgressionChartProps {
  points: ProgressionDatum[]
  granularity: 'day' | 'week'
  range: NutritionStatisticsRange
  unit: 'kg' | 'kcal'
  weeklyIsAverage?: boolean
  ariaLabel: string
  emptyTitle: string
  emptyHint: string
}

type Point = { x: number; y: number }

const WIDTH = 640
const HEIGHT = 252
const PADDING = { top: 18, right: 20, bottom: 42, left: 62 }
const valueFormatter = { format: (value: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(value) }

function dayNumber(value: string): number {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  if (!year || !month || !day) return 0
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

function axisLabelAnchor(x: number): 'start' | 'middle' | 'end' {
  if (x <= PADDING.left + 32) return 'start'
  if (x >= WIDTH - PADDING.right - 32) return 'end'
  return 'middle'
}

// Monotone cubic spline: passes through every real reading without overshooting peaks or troughs.
function smoothLine(points: Point[]) {
  const slopes = points.slice(0, -1).map((point, index) => (
    (points[index + 1].y - point.y) / ((points[index + 1].x - point.x) || 1)
  ))
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0
    if (index === points.length - 1) return slopes[index - 1]
    const before = slopes[index - 1]
    const after = slopes[index]
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after)
  })
  const segments = points.slice(0, -1).map((start, index) => {
    const end = points[index + 1]
    const third = (end.x - start.x) / 3
    return {
      start,
      end,
      first: { x: start.x + third, y: start.y + tangents[index] * third },
      second: { x: end.x - third, y: end.y - tangents[index + 1] * third },
    }
  })
  const path = segments.reduce(
    (line, { first, second, end }) => `${line} C${first.x.toFixed(2)} ${first.y.toFixed(2)} ${second.x.toFixed(2)} ${second.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
    points.length ? `M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}` : '',
  )

  const pointAt = (position: number): Point => {
    if (!segments.length) return points[0]
    const index = Math.min(segments.length - 1, Math.max(0, Math.floor(position)))
    const { start, first, second, end } = segments[index]
    const t = Math.min(1, Math.max(0, position - index))
    const m = 1 - t
    const along = (a: number, b: number, c: number, d: number) =>
      m ** 3 * a + 3 * m * m * t * b + 3 * m * t * t * c + t ** 3 * d
    return { x: along(start.x, first.x, second.x, end.x), y: along(start.y, first.y, second.y, end.y) }
  }

  return { path, pointAt }
}

function formatReadingValue(value: number, unit: 'kg' | 'kcal', isWeeklyAvg: boolean): string {
  const formatted = valueFormatter.format(Math.round(value * 10) / 10)
  return isWeeklyAvg ? t('stats.perDay', { value: formatted, unit }) : `${formatted} ${unit}`
}

export default function StatsProgressionChart({
  points,
  granularity,
  range,
  unit,
  weeklyIsAverage = false,
  ariaLabel,
  emptyTitle,
  emptyHint,
}: StatsProgressionChartProps) {
  const [selected, setSelected] = useState<number | null>(null)
  const fillId = useId().replace(/:/g, '')

  const last = points.length - 1
  const shown = Math.min(Math.max(0, selected ?? last), Math.max(0, last))
  const travelling = useSpring(shown * 100) / 100

  if (points.length === 0) {
    return (
      <div className="stats-chart-card">
        <div className="stats-chart-empty" role="status">
          <TrendingUp size={22} aria-hidden="true" />
          <p>{emptyTitle}</p>
          <span>{emptyHint}</span>
        </div>
      </div>
    )
  }

  const maxData = Math.max(...points.map((point) => point.value))
  const yTicks = volumeAxisTicks(maxData)
  const maxY = yTicks[yTicks.length - 1]
  const visibleTicks = yTicks.filter((tick) => tick > 0)
  const plotWidth = WIDTH - PADDING.left - PADDING.right
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom
  const baseline = PADDING.top + plotHeight

  const firstDay = dayNumber(points[0].date)
  const lastDay = dayNumber(points[last].date)
  const daySpan = lastDay - firstDay

  const xFor = (bucketDate: string, index: number) => {
    if (points.length === 1) return PADDING.left + plotWidth / 2
    if (daySpan <= 0) {
      return PADDING.left + (index / Math.max(1, last)) * plotWidth
    }
    const position = (dayNumber(bucketDate) - firstDay) / daySpan
    return PADDING.left + Math.max(0, Math.min(1, position)) * plotWidth
  }
  const yFor = (val: number) => PADDING.top + (1 - val / maxY) * plotHeight

  const coordinates = points.map((point, index) => ({
    ...point,
    x: xFor(point.date, index),
    y: yFor(point.value),
  }))

  const { path, pointAt } = smoothLine(coordinates)
  const marker = coordinates.length > 1 ? pointAt(travelling) : coordinates[0]
  const reading = points[shown]
  const isWeeklyAvg = weeklyIsAverage && granularity === 'week'
  const readingDate = formatChartDate(reading.date, granularity)
  const readingText = formatReadingValue(reading.value, unit, isWeeklyAvg)

  let startLabel = formatProgressionAxisLabel(points[0].date, range)
  let endLabel = formatProgressionAxisLabel(points[last].date, range)
  if (points.length > 1 && startLabel === endLabel) {
    startLabel = formatProgressionAxisLabel(points[0].date, '1W')
    endLabel = formatProgressionAxisLabel(points[last].date, '1W')
  }

  const endpointLabels = points.length === 1
    ? [{ key: 'single', x: coordinates[0].x, text: startLabel, anchor: 'middle' as const }]
    : (() => {
        const leftX = coordinates[0].x
        const rightX = coordinates[last].x
        const tooClose = rightX - leftX < 130
        const resolvedLeft = tooClose ? PADDING.left : leftX
        const resolvedRight = tooClose ? WIDTH - PADDING.right : rightX
        return [
          { key: 'start', x: resolvedLeft, text: startLabel, anchor: tooClose ? 'start' as const : axisLabelAnchor(resolvedLeft) },
          { key: 'end', x: resolvedRight, text: endLabel, anchor: tooClose ? 'end' as const : axisLabelAnchor(resolvedRight) },
        ]
      })()

  function readAt(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - box.left) / (box.width || 1)) * WIDTH
    const nearest = coordinates.reduce((best, point, index) => (
      Math.abs(point.x - x) < Math.abs(coordinates[best].x - x) ? index : best
    ), 0)
    setSelected(nearest)
  }

  function readWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!step) return
    event.preventDefault()
    setSelected(Math.max(0, Math.min(last, shown + step)))
  }

  return (
    <div className="stats-chart-card">
      <p className="stats-chart-reading" aria-hidden="true">
        <strong>{readingText}</strong>
        <span>{readingDate}</span>
      </p>
      <div
        className="stats-chart-graphic"
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown}
        aria-valuetext={`${readingDate}: ${readingText}`}
        data-reading={selected !== null || undefined}
        onPointerDown={readAt}
        onPointerMove={readAt}
        onPointerLeave={() => setSelected(null)}
        onPointerCancel={() => setSelected(null)}
        onKeyDown={readWithKeys}
        onBlur={() => setSelected(null)}
      >
        <svg className="stats-line-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop className="stats-area-stop" offset="0" stopOpacity="0.62" />
              <stop className="stats-area-stop" offset="1" stopOpacity="0" />
            </linearGradient>
          </defs>

          {visibleTicks.map((tick) => {
            const y = yFor(tick)
            return (
              <g key={tick}>
                <line className="stats-chart-grid" x1={PADDING.left} x2={WIDTH - PADDING.right} y1={y} y2={y} />
                <text className="stats-chart-axis-label" x={PADDING.left - 12} y={y + 6} textAnchor="end">
                  {formatAxisNumber(tick)}
                </text>
              </g>
            )
          })}

          {coordinates.length > 1 ? (
            <>
              <path
                className="stats-area-path"
                d={`${path} L ${coordinates[last].x} ${baseline} L ${coordinates[0].x} ${baseline} Z`}
                fill={`url(#${fillId})`}
              />
              <path className="stats-line-path" d={path} pathLength={1} />
            </>
          ) : (
            <line
              className="stats-single-point-stem"
              x1={coordinates[0].x}
              x2={coordinates[0].x}
              y1={coordinates[0].y}
              y2={baseline}
            />
          )}

          <line className="stats-line-guide" x1={marker.x} x2={marker.x} y1={PADDING.top} y2={baseline} />
          <circle className="stats-line-marker" cx={marker.x} cy={marker.y} r={6} />

          {endpointLabels.map((item) => (
            <text
              className="stats-chart-axis-label stats-chart-date-label"
              key={item.key}
              x={item.x}
              y={HEIGHT - 10}
              textAnchor={item.anchor}
            >
              {item.text}
            </text>
          ))}
        </svg>
      </div>

      <ul className="visually-hidden">
        {points.map((point) => (
          <li key={point.date}>
            {formatChartDate(point.date, granularity)}: {formatReadingValue(point.value, unit, isWeeklyAvg)}
          </li>
        ))}
      </ul>
    </div>
  )
}
