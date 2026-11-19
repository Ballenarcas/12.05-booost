import type { WorkoutStatisticsFatiguePoint } from '../../types/workout'
import { formatChartDate, formatFatigueDay } from '../../utils/workoutStatistics'

interface FatigueHistoryChartProps {
  points: WorkoutStatisticsFatiguePoint[]
}

const WIDTH = 640
const HEIGHT = 260
const PADDING = { top: 18, right: 14, bottom: 38, left: 46 }
const MIN_LEVEL = 1
const MAX_LEVEL = 10
const HIGH_FATIGUE_THRESHOLD = 5.5
const Y_TICKS = [1, 3, 5, 7, 10]

function dayNumber(value: string): number {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  if (!year || !month || !day) return 0
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

function axisLabelAnchor(x: number): 'start' | 'middle' | 'end' {
  if (x <= PADDING.left + 16) return 'start'
  if (x >= WIDTH - PADDING.right - 16) return 'end'
  return 'middle'
}

export default function FatigueHistoryChart({ points }: FatigueHistoryChartProps) {
  if (points.length === 0) return null

  const orderedPoints = [...points].sort((first, second) => first.date.localeCompare(second.date))
  const plotWidth = WIDTH - PADDING.left - PADDING.right
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom
  const firstDay = dayNumber(orderedPoints[0].date)
  const lastDay = Math.max(firstDay + 1, dayNumber(orderedPoints[orderedPoints.length - 1].date))
  const xFor = (value: string) => {
    if (orderedPoints.length === 1) return PADDING.left + plotWidth / 2
    const position = (dayNumber(value) - firstDay) / (lastDay - firstDay)
    return PADDING.left + Math.max(0, Math.min(1, position)) * plotWidth
  }
  const yFor = (level: number) => (
    PADDING.top
    + (1 - (level - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL)) * plotHeight
  )

  const coordinates = orderedPoints.map((point) => ({
    ...point,
    x: xFor(point.date),
    y: yFor(point.fatigue_level),
  }))
  const linePath = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
  const highCount = orderedPoints.filter((point) => point.fatigue_level > 5).length
  const average = orderedPoints.reduce((sum, point) => sum + point.fatigue_level, 0) / orderedPoints.length
  const thresholdY = yFor(HIGH_FATIGUE_THRESHOLD)

  const labelCount = Math.min(4, orderedPoints.length)
  const labelIndexes = Array.from({ length: labelCount }, (_, index) => {
    if (orderedPoints.length === 1) return 0
    return Math.round((index / Math.max(1, labelCount - 1)) * (orderedPoints.length - 1))
  }).filter((value, index, values) => values.indexOf(value) === index)

  return (
    <div className="stats-line-chart-wrap">
      <div
        className="stats-chart-graphic"
        role="img"
        aria-label={`Fatigue history chart: ${orderedPoints.length} rated ${orderedPoints.length === 1 ? 'day' : 'days'}, average ${average.toFixed(1)} out of 10, ${highCount} above the high-fatigue threshold`}
      >
        <svg className="stats-line-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
          {Y_TICKS.map((tick) => {
            const y = yFor(tick)
            return (
              <g key={tick}>
                <line className="stats-chart-grid" x1={PADDING.left} x2={WIDTH - PADDING.right} y1={y} y2={y} />
                <text className="stats-chart-axis-label" x={PADDING.left - 10} y={y + 4} textAnchor="end">
                  {tick}
                </text>
              </g>
            )
          })}

          <line
            className="fatigue-chart-threshold"
            x1={PADDING.left}
            x2={WIDTH - PADDING.right}
            y1={thresholdY}
            y2={thresholdY}
          />
          <text
            className="fatigue-chart-threshold-label"
            x={WIDTH - PADDING.right}
            y={thresholdY - 6}
            textAnchor="end"
          >
            High fatigue
          </text>

          {coordinates.length > 1 && <path className="stats-line-path" d={linePath} pathLength={1} />}

          {coordinates.map((point) => (
            <g key={point.date}>
              <circle className="stats-line-point-hit" cx={point.x} cy={point.y} r={12} />
              <circle
                className={`stats-line-point${point.fatigue_level > 5 ? ' fatigue-chart-point-high' : ''}`}
                cx={point.x}
                cy={point.y}
                r={4.5}
              />
              <title>
                {`${formatFatigueDay(point.date)} — ${point.name}: ${point.fatigue_level}/10`}
                {point.workout_count > 1 ? ` (latest of ${point.workout_count} workouts)` : ''}
              </title>
            </g>
          ))}

          {labelIndexes.map((index) => {
            const point = coordinates[index]
            return (
              <text
                className="stats-chart-axis-label"
                key={point.date}
                x={point.x}
                y={HEIGHT - 12}
                textAnchor={axisLabelAnchor(point.x)}
              >
                {formatChartDate(point.date, 'day')}
              </text>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
