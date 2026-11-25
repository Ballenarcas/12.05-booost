import { Dumbbell, HeartPulse, Utensils } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import StatsBreakdown, { type BreakdownItem } from '../components/stats/StatsBreakdown'
import StatsCalendar, { type CalendarDayData } from '../components/stats/StatsCalendar'
import StatsProgressionChart, { type ProgressionDatum } from '../components/stats/StatsProgressionChart'
import FatigueHistoryChart from '../components/workout/FatigueHistoryChart'
import {
  fetchNutritionStatistics,
  fetchWorkoutStatistics,
  getCurrentUser,
  getSavedNutritionStatistics,
  getSavedWorkoutStatistics,
} from '../services/api'
import type { NutritionStatistics, NutritionStatisticsRange } from '../types/nutrition'
import type { WorkoutStatistics, WorkoutStatisticsRange } from '../types/workout'
import { describeError } from '../utils/errors.js'
import {
  formatCompactGrams,
  formatCompactHydration,
  formatCompactKgParts,
  toLocalDateKey,
  type SplitMetricValue,
} from '../utils/nutritionStatistics'
import {
  DEFAULT_STATISTICS_RANGE,
  STATISTICS_RANGES,
  formatCompactDuration,
  formatFatigueAverage,
  formatFatigueDay,
  formatStatisticsDateRange,
  formatStatisticsDuration,
  formatVolumeKg,
  formatWorkoutCount,
} from '../utils/workoutStatistics'
import { locale, t as tr, useT, valueLabel } from '../i18n'
import '../styles/workout-statistics.css'

type StatsTab = 'workouts' | 'meals'

// Half-oval range dial geometry in px so the sliding indicator dot follows the exact SVG arc.
const DIAL = (() => {
  const rx = 76
  const ry = 36
  const side = 22
  const top = 30
  const left = side
  const right = side + 2 * rx
  return {
    width: right + side,
    height: top + ry + 36,
    path: `M ${left} ${top} A ${rx} ${ry} 0 0 0 ${right} ${top}`,
    labels: [
      { left, top: top - 4, transform: 'translate(-100%, -40%)' },
      { left: left + rx, top: top + ry + 12, transform: 'translateX(-50%)' },
      { left: right, top: top - 4, transform: 'translate(0%, -40%)' },
    ],
  }
})()

function workoutDurationSplit(data: WorkoutStatistics): SplitMetricValue {
  if (data.total_workouts === 0) return { value: '0', unit: 'm', exact: '0 min' }
  if (data.workouts_with_duration === 0) return { value: '–', unit: '', exact: tr('workouts.unavailable') }
  const totalMinutes = Math.floor(data.total_duration_seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const exact = formatStatisticsDuration(data.total_duration_seconds)
  if (hours === 0) return { value: String(minutes), unit: 'm', exact }
  if (minutes === 0) return { value: String(hours), unit: 'h', exact }
  return { value: `${hours}h${String(minutes).padStart(2, '0')}`, unit: 'm', exact }
}

function pillDurationLabel(seconds: number, volumeKg: number): string {
  if (seconds > 0) {
    const totalMinutes = Math.floor(seconds / 60)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
    if (hours > 0) return `${hours}h`
    return `${Math.max(1, minutes)}m`
  }
  if (volumeKg > 0) return `${formatVolumeKg(volumeKg)}kg`
  return tr('stats.done')
}

function buildFallbackRangeBounds(range: WorkoutStatisticsRange): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end)
  if (range === '1W') start.setDate(start.getDate() - 7)
  else if (range === '1M') start.setMonth(start.getMonth() - 1)
  else start.setMonth(start.getMonth() - 3)
  return { start: toLocalDateKey(start), end: toLocalDateKey(end) }
}

function WorkoutStatisticsPage() {
  const t = useT()
  const userId = getCurrentUser()?.id
  const [searchParams, setSearchParams] = useSearchParams()
  // The URL is the one source of the tab, so back/forward and links switch it too.
  const tab: StatsTab = searchParams.get('tab') === 'meals' ? 'meals' : 'workouts'
  const [switchDir, setSwitchDir] = useState<'left' | 'right' | null>(null)
  const [range, setRange] = useState<WorkoutStatisticsRange>(DEFAULT_STATISTICS_RANGE)

  const [workoutData, setWorkoutData] = useState<WorkoutStatistics | null>(() => (
    userId ? getSavedWorkoutStatistics(userId, DEFAULT_STATISTICS_RANGE) : null
  ))
  const [workoutLoading, setWorkoutLoading] = useState(Boolean(userId))
  const [workoutError, setWorkoutError] = useState<string | null>(
    userId ? null : tr('stats.signInWorkouts'),
  )

  const [mealData, setMealData] = useState<NutritionStatistics | null>(() => (
    userId ? getSavedNutritionStatistics(userId, DEFAULT_STATISTICS_RANGE) : null
  ))
  const [mealLoading, setMealLoading] = useState(Boolean(userId))
  const [mealError, setMealError] = useState<string | null>(
    userId ? null : tr('stats.signInMeals'),
  )

  const [workoutRetryToken, setWorkoutRetryToken] = useState(0)
  const [mealRetryToken, setMealRetryToken] = useState(0)
  const workoutReqId = useRef(0)
  const mealReqId = useRef(0)
  const workoutTabRef = useRef<HTMLButtonElement | null>(null)
  const mealsTabRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!userId) return
    const currentRequest = ++workoutReqId.current
    const controller = new AbortController()

    fetchWorkoutStatistics(userId, range, controller.signal)
      .then((result) => {
        if (currentRequest === workoutReqId.current) {
          setWorkoutData(result)
          setWorkoutError(null)
        }
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted || currentRequest !== workoutReqId.current) return
        setWorkoutError(describeError(requestError, t('stats.errorWorkouts')))
      })
      .finally(() => {
        if (currentRequest === workoutReqId.current) setWorkoutLoading(false)
      })

    return () => controller.abort()
  }, [range, workoutRetryToken, userId, t])

  useEffect(() => {
    if (!userId) return
    const currentRequest = ++mealReqId.current
    const controller = new AbortController()

    fetchNutritionStatistics(userId, range as NutritionStatisticsRange, controller.signal)
      .then((result) => {
        if (currentRequest === mealReqId.current) {
          setMealData(result)
          setMealError(null)
        }
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted || currentRequest !== mealReqId.current) return
        setMealError(describeError(requestError, t('stats.errorMeals')))
      })
      .finally(() => {
        if (currentRequest === mealReqId.current) setMealLoading(false)
      })

    return () => controller.abort()
  }, [range, mealRetryToken, userId, t])

  function selectTab(nextTab: StatsTab) {
    if (nextTab === tab) return
    setSwitchDir(nextTab === 'meals' ? 'right' : 'left')
    const nextParams = new URLSearchParams(searchParams)
    if (nextTab === 'meals') nextParams.set('tab', 'meals')
    else nextParams.delete('tab')
    setSearchParams(nextParams, { replace: true })
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: StatsTab) {
    let target: HTMLButtonElement | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      target = current === 'workouts' ? mealsTabRef.current : workoutTabRef.current
    } else if (event.key === 'Home') {
      target = workoutTabRef.current
    } else if (event.key === 'End') {
      target = mealsTabRef.current
    }
    if (target) {
      event.preventDefault()
      target.focus()
    }
  }

  function changeRange(nextRange: WorkoutStatisticsRange) {
    if (nextRange === range) return
    workoutReqId.current += 1
    mealReqId.current += 1
    setWorkoutError(null)
    setMealError(null)
    setWorkoutLoading(true)
    setMealLoading(true)

    const savedWorkout = userId ? getSavedWorkoutStatistics(userId, nextRange) : null
    if (savedWorkout) setWorkoutData(savedWorkout)
    const savedMeals = userId ? getSavedNutritionStatistics(userId, nextRange) : null
    if (savedMeals) setMealData(savedMeals)

    setRange(nextRange)
  }

  function retryWorkouts() {
    workoutReqId.current += 1
    setWorkoutError(null)
    setWorkoutLoading(true)
    setWorkoutRetryToken((v) => v + 1)
  }

  function retryMeals() {
    mealReqId.current += 1
    setMealError(null)
    setMealLoading(true)
    setMealRetryToken((v) => v + 1)
  }

  const activeLoading = tab === 'workouts' ? workoutLoading : mealLoading
  const fallbackBounds = buildFallbackRangeBounds(range)

  // Workouts tab derived view data
  const workoutVolumeSplit = formatCompactKgParts(workoutData?.total_volume_kg ?? 0)
  const workoutTimeSplit = workoutData ? workoutDurationSplit(workoutData) : { value: '0', unit: 'm', exact: '0 min' }
  const volumePoints: ProgressionDatum[] = (workoutData?.volume_progression ?? []).map((p) => ({
    date: p.date,
    value: p.volume_kg,
  }))
  const workoutCalendarDays: CalendarDayData[] = (workoutData?.calendar_days ?? []).map((day) => ({
    date: day.date,
    summaryLabel: `${t(day.workout_count === 1 ? 'stats.workoutOne' : 'stats.workoutMany', { count: day.workout_count })}, ${formatCompactDuration(day.total_duration_seconds)}`,
    pills: day.items.map((item) => ({
      label: item.label.toLocaleUpperCase(locale()),
      value: pillDurationLabel(item.duration_seconds, item.volume_kg),
    })),
  }))
  const classifiedKg = workoutData?.classified_volume_kg ?? 0
  const muscleItems: BreakdownItem[] = (workoutData?.muscle_group_distribution ?? []).map((item) => ({
    id: item.muscle_group,
    label: valueLabel(t, 'muscle', item.muscle_group).toLocaleUpperCase(locale()),
    valueText: item.volume_kg >= 1000
      ? `${formatCompactKgParts(item.volume_kg).value}kg`
      : `${formatVolumeKg(item.volume_kg)}kg`,
    exactText: `${formatVolumeKg(item.volume_kg)} kg`,
    share: classifiedKg > 0 ? (item.volume_kg / classifiedKg) * 100 : 0,
  }))
  const classifiedSplit = formatCompactKgParts(classifiedKg)
  const fatigueHistory = workoutData?.fatigue_history ?? []
  const latestFatigue = fatigueHistory[fatigueHistory.length - 1]

  // Meals tab derived view data
  const hydrationSplit = formatCompactHydration(mealData?.total_hydration_ml ?? 0)
  const intakeSplit = formatCompactGrams(mealData?.total_macros_g ?? 0)
  const mealPoints: ProgressionDatum[] = (mealData?.calorie_progression ?? []).map((p) => ({
    date: p.date,
    value: p.calories,
    loggedDays: p.logged_days,
  }))
  const mealCalendarDays: CalendarDayData[] = (mealData?.calendar_days ?? []).map((day) => ({
    date: day.date,
    summaryLabel: `${t(day.meal_count === 1 ? 'stats.mealOne' : 'stats.mealMany', { count: day.meal_count })}, ${day.total_calories.toLocaleString(locale())} kcal`,
    pills: day.items.map((item) => ({
      label: valueLabel(t, 'mealType', item.meal_type).toLocaleUpperCase(locale()),
      value: `${item.calories}kcal`,
    })),
  }))
  const totalMacrosG = mealData?.total_macros_g ?? 0
  const macroItems: BreakdownItem[] = (mealData?.macro_distribution ?? []).map((item) => {
    const gramsSplit = formatCompactGrams(item.grams)
    return {
      id: item.macro,
      label: (valueLabel(t, 'macro', item.macro) === item.macro ? item.label : valueLabel(t, 'macro', item.macro)).toLocaleUpperCase(locale()),
      valueText: `${gramsSplit.value}${gramsSplit.unit}`,
      exactText: gramsSplit.exact,
      share: totalMacrosG > 0 ? (item.grams / totalMacrosG) * 100 : 0,
    }
  })

  return (
    <div className="screen hifi-screen stats-screen" data-tab={tab} aria-busy={activeLoading}>
      <h1 className="visually-hidden">{t('nav.statistics')}</h1>

      <section className="stats-range-section" aria-label={t('stats.dateRange')}>
        <div
          className="stats-range"
          role="group"
          aria-label={t('stats.dateRangeAria')}
          style={{ width: DIAL.width, height: DIAL.height }}
        >
          <svg className="stats-range-arc" width={DIAL.width} height={DIAL.height} aria-hidden="true">
            <path d={DIAL.path} />
          </svg>
          <span
            className="stats-range-dot"
            aria-hidden="true"
            style={{
              offsetPath: `path('${DIAL.path}')`,
              offsetDistance: `${50 * Math.max(0, STATISTICS_RANGES.findIndex((option) => option.value === range))}%`,
            }}
          />
          {STATISTICS_RANGES.map((option, index) => (
            <button
              className="stats-range-button"
              key={option.value}
              type="button"
              aria-pressed={range === option.value}
              aria-label={t(option.description)}
              onClick={() => changeRange(option.value)}
              style={DIAL.labels[index]}
            >
              {option.label}
            </button>
          ))}
        </div>
        {((tab === 'workouts' ? workoutData : mealData)?.range === range) && (
          <p className="visually-hidden">
            {formatStatisticsDateRange(
              (tab === 'workouts' ? workoutData : mealData)!.start_date,
              (tab === 'workouts' ? workoutData : mealData)!.end_date,
            )}
          </p>
        )}
      </section>

      <div className="stats-switcher-wrap">
        <div className="stats-switcher" role="tablist" aria-label={t('stats.category')}>
          <button
            ref={workoutTabRef}
            id="stats-tab-workouts"
            type="button"
            role="tab"
            className="stats-switcher-tab"
            aria-selected={tab === 'workouts'}
            tabIndex={tab === 'workouts' ? 0 : -1}
            onClick={() => selectTab('workouts')}
            onKeyDown={(e) => handleTabKeyDown(e, 'workouts')}
          >
            {t('stats.workoutsTab')}
          </button>
          <button
            ref={mealsTabRef}
            id="stats-tab-meals"
            type="button"
            role="tab"
            className="stats-switcher-tab"
            aria-selected={tab === 'meals'}
            tabIndex={tab === 'meals' ? 0 : -1}
            onClick={() => selectTab('meals')}
            onKeyDown={(e) => handleTabKeyDown(e, 'meals')}
          >
            {t('stats.mealsTab')}
          </button>
        </div>
      </div>

      {activeLoading && (
        <p className="visually-hidden" role="status">
          {t(tab === 'workouts' ? 'stats.loadingWorkouts' : 'stats.loadingMeals')}
        </p>
      )}

      {/* Workouts panel */}
      <section
        className="stats-panel-view"
        role="tabpanel"
        aria-labelledby="stats-tab-workouts"
        data-enter={switchDir ?? undefined}
        hidden={tab !== 'workouts'}
      >
        {!workoutLoading && workoutError && !workoutData && (
          <div className="card state-card stats-error-card" role="alert">
            <p>{workoutError}</p>
            <button className="secondary-action" type="button" onClick={retryWorkouts}>
              {t('common.retry')}
            </button>
          </div>
        )}

        {workoutData && (
          <div className="stats-content">
            {workoutError && (
              <div className="card state-card stats-error-card" role="alert">
                <p>{workoutError}</p>
                <button className="secondary-action" type="button" onClick={retryWorkouts}>
                  {t('common.retry')}
                </button>
              </div>
            )}

            <article className="stats-hero-card" aria-live="polite">
              <div className="stats-hero-top">
                <span className="stats-hero-title">{t('stats.workoutsTab')}</span>
                <span className="stats-hero-tag">{t('stats.total')}</span>
              </div>
              <p className="stats-hero-count">{formatWorkoutCount(workoutData.total_workouts)}</p>
              <div className="stats-hero-bottom">
                <div className="stats-hero-metric">
                  <span className="stats-hero-metric-label">{t('stats.time')}</span>
                  <strong className="stats-hero-metric-value" title={workoutTimeSplit.exact}>
                    <span aria-hidden="true">
                      {workoutTimeSplit.value}
                      {workoutTimeSplit.unit && <small>{workoutTimeSplit.unit}</small>}
                    </span>
                    <span className="visually-hidden">{workoutTimeSplit.exact}</span>
                  </strong>
                </div>
                <div className="stats-hero-metric is-right">
                  <span className="stats-hero-metric-label">{t('stats.volume')}</span>
                  <strong className="stats-hero-metric-value" title={workoutVolumeSplit.exact}>
                    <span aria-hidden="true">
                      {workoutVolumeSplit.value}
                      <small>{workoutVolumeSplit.unit}</small>
                    </span>
                    <span className="visually-hidden">{workoutVolumeSplit.exact}</span>
                  </strong>
                </div>
              </div>
            </article>

            {workoutData.total_workouts === 0 && (
              <div className="hifi-card stats-empty-callout">
                <Dumbbell size={20} aria-hidden="true" />
                <div>
                  <h2>{t('stats.noWorkouts')}</h2>
                  <p>{t('stats.noWorkoutsHint')}</p>
                </div>
              </div>
            )}

            <h2 className="stats-section-heading" id="volume-progression-title">
              {t('stats.volumeProg1')}
              <br />
              {t('stats.volumeProg2')}
            </h2>
            <section aria-labelledby="volume-progression-title">
              <StatsProgressionChart
                key={`workout-${workoutData.range}`}
                points={volumePoints}
                granularity={workoutData.progression_granularity}
                range={workoutData.range}
                unit="kg"
                ariaLabel={t('stats.volumeAria', { count: volumePoints.length, kg: formatVolumeKg(workoutData.total_volume_kg) })}
                emptyTitle={t('stats.noVolume')}
                emptyHint={t('stats.noVolumeHint')}
              />
            </section>

            <h2 className="stats-section-heading" id="muscle-distribution-title">
              {t('stats.muscleDist1')}
              <br />
              {t('stats.muscleDist2')}
            </h2>
            <section className="stats-distribution-section" aria-labelledby="muscle-distribution-title">
              <StatsCalendar
                rangeStart={workoutData.start_date.slice(0, 10) || fallbackBounds.start}
                rangeEnd={workoutData.end_date.slice(0, 10) || fallbackBounds.end}
                days={workoutCalendarDays}
                emptyDayCategory="workouts"
                tabKey={`workouts-${workoutData.range}`}
              />

              <StatsBreakdown
                key={`workout-breakdown-${workoutData.range}`}
                totalValue={classifiedSplit.value}
                totalUnit={classifiedSplit.unit}
                totalExact={classifiedSplit.exact}
                totalLabel={t('stats.classified')}
                items={muscleItems}
                ariaLabel={t('stats.muscleAria')}
                emptyMessage={
                  workoutData.unclassified_volume_kg > 0
                    ? t('stats.unmatched')
                    : t('stats.noMuscleData')
                }
                note={
                  workoutData.total_volume_kg > 0 && workoutData.unclassified_volume_kg > 0
                    ? t('stats.classifiedNote', { classified: formatVolumeKg(workoutData.classified_volume_kg), total: formatVolumeKg(workoutData.total_volume_kg), excluded: formatVolumeKg(workoutData.unclassified_volume_kg) })
                    : undefined
                }
              />
            </section>

            {fatigueHistory.length > 0 && (
              <section className="hifi-card stats-fatigue-card" aria-labelledby="fatigue-history-title">
                <div className="stats-panel-heading">
                  <div>
                    <h2 id="fatigue-history-title">
                      <HeartPulse size={17} aria-hidden="true" /> {t('stats.fatigueHistory')}
                    </h2>
                    <p>{t('stats.fatigueHistoryHint')}</p>
                  </div>
                  <span className="stats-panel-total">{t('stats.avgOutOf10', { value: formatFatigueAverage(workoutData.fatigue_average) })}</span>
                </div>
                <FatigueHistoryChart points={fatigueHistory} />
                <p className="stats-classification-note">
                  {t('stats.fatigueNote', {
                    days: t(fatigueHistory.length === 1 ? 'stats.ratedDayOne' : 'stats.ratedDayMany', { count: fatigueHistory.length }),
                    workouts: t(workoutData.fatigue_workouts === 1 ? 'stats.workoutOne' : 'stats.workoutMany', { count: workoutData.fatigue_workouts }),
                    latest: workoutData.fatigue_latest ?? '–',
                  })}
                  {latestFatigue ? ` ${t('stats.onDate', { date: formatFatigueDay(latestFatigue.date) })}` : ''}.
                </p>
              </section>
            )}
          </div>
        )}
      </section>

      {/* Meals panel */}
      <section
        className="stats-panel-view"
        role="tabpanel"
        aria-labelledby="stats-tab-meals"
        data-enter={switchDir ?? undefined}
        hidden={tab !== 'meals'}
      >
        {!mealLoading && mealError && !mealData && (
          <div className="card state-card stats-error-card" role="alert">
            <p>{mealError}</p>
            <button className="secondary-action" type="button" onClick={retryMeals}>
              {t('common.retry')}
            </button>
          </div>
        )}

        {mealData && (
          <div className="stats-content">
            {mealError && (
              <div className="card state-card stats-error-card" role="alert">
                <p>{mealError}</p>
                <button className="secondary-action" type="button" onClick={retryMeals}>
                  {t('common.retry')}
                </button>
              </div>
            )}

            <article className="stats-hero-card" aria-live="polite">
              <div className="stats-hero-top">
                <span className="stats-hero-title">{t('stats.mealsTab')}</span>
                <span className="stats-hero-tag">{t('stats.total')}</span>
              </div>
              <p className="stats-hero-count">{formatWorkoutCount(mealData.total_meals)}</p>
              <div className="stats-hero-bottom">
                <div className="stats-hero-metric">
                  <span className="stats-hero-metric-label">{t('stats.hydration')}</span>
                  <strong className="stats-hero-metric-value" title={hydrationSplit.exact}>
                    <span aria-hidden="true">
                      {hydrationSplit.value}
                      <small>{hydrationSplit.unit}</small>
                    </span>
                    <span className="visually-hidden">{hydrationSplit.exact}</span>
                  </strong>
                </div>
                <div className="stats-hero-metric is-right">
                  <span className="stats-hero-metric-label">
                    {t('stats.nutritionLabel')}
                    <br />
                    {t('stats.intakeLabel')}
                  </span>
                  <strong className="stats-hero-metric-value" title={intakeSplit.exact}>
                    <span aria-hidden="true">
                      {intakeSplit.value}
                      <small>{intakeSplit.unit}</small>
                    </span>
                    <span className="visually-hidden">{intakeSplit.exact}</span>
                  </strong>
                </div>
              </div>
            </article>

            {mealData.total_meals === 0 && (
              <div className="hifi-card stats-empty-callout">
                <Utensils size={20} aria-hidden="true" />
                <div>
                  <h2>{t('stats.noMeals')}</h2>
                  <p>{t('stats.noMealsHint')}</p>
                </div>
              </div>
            )}

            <h2 className="stats-section-heading" id="nutrition-progression-title">
              {t('stats.nutritionProg1')}
              <br />
              {t('stats.nutritionProg2')}
            </h2>
            <section aria-labelledby="nutrition-progression-title">
              <StatsProgressionChart
                key={`meals-${mealData.range}`}
                points={mealPoints}
                granularity={mealData.progression_granularity}
                range={mealData.range}
                unit="kcal"
                weeklyIsAverage
                ariaLabel={t('stats.nutritionAria', { count: mealPoints.length, kcal: mealData.total_calories.toLocaleString(locale()) })}
                emptyTitle={t('stats.noCalories')}
                emptyHint={t('stats.noCaloriesHint')}
              />
            </section>

            <h2 className="stats-section-heading" id="nutrition-intake-title">
              {t('stats.nutritionIntake1')}
              <br />
              {t('stats.nutritionIntake2')}
            </h2>
            <section className="stats-distribution-section" aria-labelledby="nutrition-intake-title">
              <StatsCalendar
                rangeStart={mealData.start_date.slice(0, 10) || fallbackBounds.start}
                rangeEnd={mealData.end_date.slice(0, 10) || fallbackBounds.end}
                days={mealCalendarDays}
                emptyDayCategory="meals"
                tabKey={`meals-${mealData.range}`}
              />

              <StatsBreakdown
                key={`meals-breakdown-${mealData.range}`}
                totalValue={intakeSplit.value}
                totalUnit={intakeSplit.unit}
                totalExact={intakeSplit.exact}
                totalLabel={t('stats.classified')}
                items={macroItems}
                ariaLabel={t('stats.macroAria')}
                emptyMessage={t('stats.noMacros')}
              />
            </section>
          </div>
        )}
      </section>
    </div>
  )
}

export default WorkoutStatisticsPage
