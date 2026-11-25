import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { locale, t } from '../../i18n'
import { monthWeeks, sameDay } from '../../utils/monthGrid'
import { parseDateKey, toLocalDateKey } from '../../utils/nutritionStatistics'

export interface CalendarPillItem {
  label: string
  value: string
}

export interface CalendarDayData {
  date: string
  summaryLabel: string
  pills: CalendarPillItem[]
}

interface StatsCalendarProps {
  rangeStart: string
  rangeEnd: string
  days: CalendarDayData[]
  emptyDayCategory: string
  tabKey: string
}

// Monday first; names come from the app language (1 Jan 2024 was a Monday).
const weekdays = () => Array.from({ length: 7 }, (_, index) =>
  new Date(2024, 0, 1 + index).toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '').toLocaleUpperCase(locale()))

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export default function StatsCalendar({
  rangeStart,
  rangeEnd,
  days,
  emptyDayCategory,
  tabKey,
}: StatsCalendarProps) {
  const daysByKey = new Map(days.map((item) => [item.date, item]))
  const latestActiveKey = days.length > 0 ? days[days.length - 1].date : null
  const today = new Date()
  const scopeKey = `${tabKey}:${rangeStart}:${rangeEnd}`

  const defaultFocusDate = (latestActiveKey ? parseDateKey(latestActiveKey) : null) ?? parseDateKey(rangeEnd) ?? today
  const defaultMonth = monthStart(defaultFocusDate)

  const [pickedState, setPickedState] = useState<{ scope: string; dateKey: string | null }>({
    scope: scopeKey,
    dateKey: null,
  })
  const [monthState, setMonthState] = useState<{ scope: string; year: number; month: number } | null>(null)

  const activeScopeMatch = pickedState.scope === scopeKey
  const selectedKey = activeScopeMatch && pickedState.dateKey !== null
    ? pickedState.dateKey
    : latestActiveKey

  const viewYear = monthState?.scope === scopeKey ? monthState.year : defaultMonth.getFullYear()
  const viewMonth = monthState?.scope === scopeKey ? monthState.month : defaultMonth.getMonth()

  const minBound = monthStart(parseDateKey(rangeStart) ?? today)
  const latestMonth = monthStart(defaultFocusDate)
  const todayMonth = monthStart(today)
  const maxBound = latestMonth > todayMonth ? latestMonth : todayMonth

  const currentViewStart = new Date(viewYear, viewMonth, 1)
  const canGoBack = currentViewStart > minBound
  const canGoForward = currentViewStart < maxBound

  function moveMonth(step: number) {
    const next = new Date(viewYear, viewMonth + step, 1)
    setMonthState({ scope: scopeKey, year: next.getFullYear(), month: next.getMonth() })
  }

  function selectDay(day: Date, key: string) {
    setPickedState({ scope: scopeKey, dateKey: key })
    if (day.getFullYear() !== viewYear || day.getMonth() !== viewMonth) {
      const targetMonth = monthStart(day)
      if (targetMonth >= minBound && targetMonth <= maxBound) {
        setMonthState({ scope: scopeKey, year: targetMonth.getFullYear(), month: targetMonth.getMonth() })
      }
    }
  }

  const weeks = monthWeeks(viewYear, viewMonth)
  const headerMonth = new Date(viewYear, viewMonth, 1)
  const showYear = viewYear !== today.getFullYear()
  const monthLabel = headerMonth
    .toLocaleDateString(locale(), showYear ? { month: 'long', year: 'numeric' } : { month: 'long' })
    .toLocaleUpperCase(locale())

  const selectedDayData = selectedKey ? daysByKey.get(selectedKey) : undefined
  const selectedDateObj = selectedKey ? parseDateKey(selectedKey) : null
  const formattedSelectedDate = selectedDateObj
    ? selectedDateObj.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })
    : null

  return (
    <div className="stats-cal">
      <div className="stats-cal-head">
        <span className="stats-cal-month">{monthLabel}</span>
        {(canGoBack || canGoForward) && (
          <div className="stats-cal-nav">
            <button
              type="button"
              className="stats-cal-nav-btn"
              onClick={() => moveMonth(-1)}
              disabled={!canGoBack}
              aria-label={t('stats.prevMonth')}
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="stats-cal-nav-btn"
              onClick={() => moveMonth(1)}
              disabled={!canGoForward}
              aria-label={t('stats.nextMonth')}
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <div className="stats-cal-grid" role="grid" aria-label={t('stats.calendarAria', { month: monthLabel })}>
        <div className="stats-cal-row" role="row">
          {weekdays().map((weekday) => (
            <span className="stats-cal-weekday" role="columnheader" key={weekday}>
              {weekday}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div className="stats-cal-row" role="row" key={toLocalDateKey(week[0])}>
            {week.map((day) => {
              const key = toLocalDateKey(day)
              const outside = day.getMonth() !== viewMonth
              const isToday = sameDay(day, today)
              const isSelected = selectedKey === key
              const dayInfo = daysByKey.get(key)
              const hasData = Boolean(dayInfo)
              const accessibleLabel = day.toLocaleDateString(locale(), {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              }) + (dayInfo ? `, ${dayInfo.summaryLabel}` : `, no ${emptyDayCategory}`)

              return (
                <span className="stats-cal-cell" role="gridcell" key={key}>
                  <button
                    type="button"
                    className="stats-cal-day"
                    data-outside={outside || undefined}
                    data-active-day={hasData || undefined}
                    data-today={isToday || undefined}
                    aria-pressed={isSelected}
                    aria-label={accessibleLabel}
                    onClick={() => selectDay(day, key)}
                  >
                    {isToday && <span className="stats-cal-today-dot" aria-hidden="true" />}
                    <span>{day.getDate()}</span>
                  </button>
                </span>
              )
            })}
          </div>
        ))}
      </div>

      {selectedDayData ? (
        <ul className="stats-cal-pills" aria-label={t('stats.activityOn', { date: formattedSelectedDate ?? selectedDayData.date })}>
          {selectedDayData.pills.map((pill, index) => (
            <li className="stats-cal-pill" key={`${pill.label}-${index}`}>
              <span className="stats-cal-pill-label">{pill.label}</span>
              <span className="stats-cal-pill-value">{pill.value}</span>
            </li>
          ))}
        </ul>
      ) : formattedSelectedDate ? (
        <p className="stats-cal-note">
          {t(emptyDayCategory === 'workouts' ? 'stats.noWorkoutsOn' : 'stats.noMealsOn', { date: formattedSelectedDate })}
        </p>
      ) : (
        <p className="stats-cal-note">
          {t(emptyDayCategory === 'workouts' ? 'stats.noWorkoutsRange' : 'stats.noMealsRange')}
        </p>
      )}
    </div>
  )
}
