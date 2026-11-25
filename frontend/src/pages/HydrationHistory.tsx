import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Droplets, GlassWater, Target } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchHydrationHistory, type HydrationHistoryWeek } from '../services/api'
import { locale, t as tr, useT } from '../i18n'
import '../styles/hydration-history.css'

// Monday first, in the app language (1 Jan 2024 was a Monday).
const weekdays = () => Array.from({ length: 7 }, (_, index) =>
  new Date(2024, 0, 1 + index).toLocaleDateString(locale(), { weekday: 'short' }).replace('.', ''))
const CHART_WIDTH = 640
const CHART_HEIGHT = 268
const CHART_PADDING = { top: 34, right: 12, bottom: 46, left: 46 }

function formatMl(value: number): string {
  return value.toLocaleString('de-DE')
}

function formatLiters(value: number): string {
  return `${(value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} L`
}

function toDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function startOfWeek(value: Date): Date {
  const copy = new Date(value.getFullYear(), value.getMonth(), value.getDate())
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7))
  return copy
}

function addDays(value: Date, days: number): Date {
  const copy = new Date(value.getFullYear(), value.getMonth(), value.getDate())
  copy.setDate(copy.getDate() + days)
  return copy
}

function formatWeekRange(startKey: string, endKey: string): string {
  const start = parseDateKey(startKey)
  const end = parseDateKey(endKey)
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()
  const startText = start.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })
  const endText = end.toLocaleDateString(locale(), sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })
  return `${startText} – ${endText}, ${end.getFullYear()}`
}

interface MetricCardProps {
  icon: ReactNode
  label: string
  value: string
  note: string
}

function MetricCard({ icon, label, value, note }: MetricCardProps) {
  return (
    <article className="card hydration-metric-card">
      <span className="hydration-metric-icon" aria-hidden="true">{icon}</span>
      <p className="hydration-metric-label">{label}</p>
      <p className="hydration-metric-value">{value}</p>
      <p className="hydration-metric-note">{note}</p>
    </article>
  )
}

function WeekChart({ data, todayKey }: { data: HydrationHistoryWeek; todayKey: string }) {
  const goalValues = data.days.map((day) => day.goal_ml)
  const uniformGoal = goalValues.every((goal) => goal === goalValues[0])
  const highest = Math.max(...data.days.map((day) => Math.max(day.goal_ml, day.total_ml)), 1)
  const step = highest > 3000 ? 1000 : 500
  const axisMax = Math.ceil((highest * 1.12) / step) * step
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom
  const baseline = CHART_PADDING.top + plotHeight
  const slot = plotWidth / 7
  const barWidth = Math.min(46, slot * 0.56)
  const yFor = (value: number) => CHART_PADDING.top + (1 - value / axisMax) * plotHeight
  const ticks = [0, axisMax / 2, axisMax]
  const goalDescription = uniformGoal
    ? tr('hh.goalAria', { ml: formatMl(goalValues[0]) })
    : tr('hh.goalVariesAria', { min: formatMl(Math.min(...goalValues)), max: formatMl(Math.max(...goalValues)) })
  const chartLabel = `${tr('hh.chartFor', { range: formatWeekRange(data.week_start, data.week_end) })}: ${data.days
    .map((day, index) => tr('hh.dayAria', { day: weekdays()[index], ml: formatMl(day.total_ml) }))
    .join(', ')}. ${goalDescription}`

  return (
    <div className="hydration-chart-wrap" role="img" aria-label={chartLabel}>
      <svg className="hydration-chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} aria-hidden="true">
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="hydration-chart-grid"
              x1={CHART_PADDING.left}
              x2={CHART_WIDTH - CHART_PADDING.right}
              y1={yFor(tick)}
              y2={yFor(tick)}
            />
            <text className="hydration-chart-axis" x={CHART_PADDING.left - 8} y={yFor(tick) + 4} textAnchor="end">
              {tick === 0 ? '0' : formatLiters(tick)}
            </text>
          </g>
        ))}
        {uniformGoal && (
          <line
            className="hydration-chart-goal-line"
            x1={CHART_PADDING.left}
            x2={CHART_WIDTH - CHART_PADDING.right}
            y1={yFor(goalValues[0])}
            y2={yFor(goalValues[0])}
          />
        )}
        {!uniformGoal && data.days.map((day, index) => {
          const x = CHART_PADDING.left + slot * index + 6
          const y = yFor(day.goal_ml)
          return (
            <line
              key={`goal-${day.date}`}
              className="hydration-chart-goal-line hydration-chart-goal-tick"
              x1={x}
              x2={x + slot - 12}
              y1={y}
              y2={y}
            />
          )
        })}
        {data.days.map((day, index) => {
          const x = CHART_PADDING.left + slot * index + (slot - barWidth) / 2
          const y = yFor(day.total_ml)
          const isToday = day.date === todayKey
          return (
            <g key={day.date}>
              {day.total_ml > 0 && (
                <rect
                  className={`hydration-chart-bar${day.met_goal ? ' is-met' : ''}${isToday ? ' is-today' : ''}`}
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(3, baseline - y)}
                  rx={5}
                />
              )}
              <text
                className="hydration-chart-value"
                x={x + barWidth / 2}
                y={Math.max(18, y - 9)}
                textAnchor="middle"
              >
                {formatMl(day.total_ml)}
              </text>
              <text
                className={`hydration-chart-weekday${isToday ? ' is-today' : ''}`}
                x={x + barWidth / 2}
                y={baseline + 24}
                textAnchor="middle"
              >
                {weekdays()[index]}
              </text>
              <text
                className={`hydration-chart-date${isToday ? ' is-today' : ''}`}
                x={x + barWidth / 2}
                y={baseline + 40}
                textAnchor="middle"
              >
                {parseDateKey(day.date).getDate()}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export default function HydrationHistory() {
  const t = useT()
  const navigate = useNavigate()
  const currentWeekStart = toDateKey(startOfWeek(new Date()))
  const todayKey = toDateKey(new Date())
  const [weekStart, setWeekStart] = useState(currentWeekStart)
  const [data, setData] = useState<HydrationHistoryWeek | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    let active = true
    fetchHydrationHistory(weekStart)
      .then((next) => {
        if (!active) return
        setData(next)
        setError(null)
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setError(requestError instanceof Error ? requestError.message : t('hh.errorLoad'))
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [weekStart, retryToken, t])

  function goToWeek(offset: number) {
    setWeekStart(toDateKey(addDays(parseDateKey(weekStart), offset)))
    setData(null)
    setError(null)
    setIsLoading(true)
  }

  function retry() {
    setData(null)
    setError(null)
    setIsLoading(true)
    setRetryToken((value) => value + 1)
  }

  const isCurrentWeek = weekStart === currentWeekStart
  const rangeLabel = data ? formatWeekRange(data.week_start, data.week_end) : formatWeekRange(weekStart, toDateKey(addDays(parseDateKey(weekStart), 6)))
  const goalChanged = data ? data.days.some((day) => day.goal_ml !== data.days[0].goal_ml) : false

  return (
    <div className="screen hifi-theme hydration-history-screen" aria-busy={isLoading}>
      <header className="hydration-history-header">
        <button
          className="icon-button hydration-history-back"
          type="button"
          aria-label={t('common.back')}
          onClick={() => navigate(-1)}
        >
          <ArrowLeft size={21} aria-hidden="true" />
        </button>
        <div>
          <p className="eyebrow">{t('hh.eyebrow')}</p>
          <h1>{t('hh.title')}</h1>
        </div>
      </header>

      <div className="hydration-week-nav" role="group" aria-label={t('hh.chooseWeek')}>
        <button
          className="hydration-week-button"
          type="button"
          aria-label={t('hh.prevWeek')}
          onClick={() => goToWeek(-7)}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <div className="hydration-week-caption" aria-live="polite">
          <strong>{rangeLabel}</strong>
          <span>{isCurrentWeek ? t('hh.thisWeek') : t('hh.pastWeek')}</span>
        </div>
        <button
          className="hydration-week-button"
          type="button"
          aria-label={t('hh.nextWeek')}
          onClick={() => goToWeek(7)}
          disabled={isCurrentWeek}
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>

      {isLoading && !data && (
        <div className="card state-card hydration-history-state" role="status">
          {t('hh.loading')}
        </div>
      )}

      {!isLoading && error && (
        <div className="card state-card hydration-history-state" role="alert">
          <p>{error}</p>
          <button className="secondary-action" type="button" onClick={retry}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="hydration-history-metrics">
            <MetricCard
              icon={<Droplets size={18} />}
              label={t('hh.weeklyTotal')}
              value={formatLiters(data.total_ml)}
              note={t(data.entries_count === 1 ? 'hh.drinkOne' : 'hh.drinkMany', { count: data.entries_count })}
            />
            <MetricCard
              icon={<CalendarDays size={18} />}
              label={t('hh.dailyAverage')}
              value={formatLiters(data.daily_average_ml)}
              note={t('hh.across7')}
            />
            <MetricCard
              icon={<Target size={18} />}
              label={t('hh.goalDays')}
              value={`${data.days_met_goal} / 7`}
              note={goalChanged ? t('hh.goalChanged') : t('hh.goalIs', { ml: formatMl(data.goal_ml) })}
            />
          </div>

          <section className="card hydration-chart-card" aria-labelledby="hydration-week-overview">
            <div className="hydration-chart-heading">
              <div>
                <h2 id="hydration-week-overview">{t('hh.weekOverview')}</h2>
                <p>{t('hh.daysMetGoal', { count: data.days_met_goal })}</p>
              </div>
              <span className="hydration-chart-total">{formatLiters(data.total_ml)}</span>
            </div>

            <div className="hydration-chart-legend">
              <span><i className="hydration-legend-swatch is-goal" aria-hidden="true" /> {goalChanged ? t('hh.dailyGoal') : t('hh.goalPerDay', { ml: formatMl(data.goal_ml) })}</span>
              <span><i className="hydration-legend-swatch is-met" aria-hidden="true" /> {t('hh.goalMet')}</span>
            </div>

            {data.total_ml === 0 ? (
              <div className="hydration-history-empty">
                <GlassWater size={26} aria-hidden="true" />
                <div>
                  <h3>{t('hh.noneTitle')}</h3>
                  <p>{t('hh.noneBody')}</p>
                </div>
              </div>
            ) : (
              <WeekChart data={data} todayKey={todayKey} />
            )}

            <ul className="hydration-day-list" aria-label={t('hh.dailyAria')}>
              {data.days.map((day, index) => {
                const isToday = day.date === todayKey
                return (
                  <li key={day.date} className={`hydration-day-row${day.met_goal ? ' is-met' : ''}`}>
                    <span className="hydration-day-name">
                      <strong>{weekdays()[index]}</strong>
                      <span>{parseDateKey(day.date).toLocaleDateString(locale(), { month: 'short', day: 'numeric' })}</span>
                      {isToday && <span className="hydration-today-tag">{t('common.today')}</span>}
                    </span>
                    <span className="hydration-day-track" aria-hidden="true">
                      <span className="hydration-day-fill" style={{ width: `${day.progress_percentage}%` }} />
                    </span>
                    <span className="hydration-day-amount">
                      <strong>
                        {formatMl(day.total_ml)}
                        <span className="hydration-day-goal"> / {formatMl(day.goal_ml)} ml</span>
                      </strong>
                      <span>{day.met_goal ? t('hh.goalMet') : `${day.progress_percentage}%`}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
