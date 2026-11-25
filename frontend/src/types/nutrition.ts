export type NutritionStatisticsRange = '1W' | '1M' | '3M'

export interface NutritionProgressionPoint {
  date: string
  calories: number
  logged_days: number
}

export interface MacroBreakdownItem {
  macro: 'protein' | 'carbs' | 'fats'
  label: string
  grams: number
}

export interface MealCalendarItem {
  meal_type: string
  calories: number
  meal_count: number
}

export interface MealCalendarDay {
  date: string
  meal_count: number
  total_calories: number
  items: MealCalendarItem[]
}

export interface NutritionStatistics {
  range: NutritionStatisticsRange
  start_date: string
  end_date: string
  total_meals: number
  total_hydration_ml: number
  total_calories: number
  total_macros_g: number
  protein_g: number
  carbs_g: number
  fats_g: number
  macro_distribution: MacroBreakdownItem[]
  progression_granularity: 'day' | 'week'
  calorie_progression: NutritionProgressionPoint[]
  calendar_days: MealCalendarDay[]
}
