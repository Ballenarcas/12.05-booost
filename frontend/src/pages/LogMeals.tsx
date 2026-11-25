import { useEffect, useState, useMemo, useRef } from 'react'
import { usePageNavigate } from '../utils/usePageNavigate'
import { Crown, Loader2, Sparkles, X } from 'lucide-react'
import {
  addMealLog,
  decideCalorieAdjustment,
  fetchCalorieAdjustment,
  fetchTodayNutrition,
  getCachedTodayNutrition,
  getCurrentUser,
  isPremiumActive,
  searchFoodItems,
  type CalorieAdjustmentData,
  type FoodSearchItem,
  type MealIngredient,
  type TodayNutritionData,
} from '../services/api'
import { summarizeMeal } from '../utils/mealComposition.js'
import { describeError } from '../utils/errors.js'
import backIcon from '../assets/scan/back.svg'
import { locale, useT, valueLabel } from '../i18n'
import '../styles/log-meals.css'
import '../styles/add-food.css'

type PlateFood = {
  name: string
  quantityGrams: number
  calories: number
  protein: number
  carbs: number
  fat: number
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
}

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Snack', 'Dinner']
// Used until a food from the search gives its real values.
const DEFAULT_DENSITY = { caloriesPer100g: 130, proteinPer100g: 8, carbsPer100g: 15, fatPer100g: 3.5 }

function mealTypeForNow(): string {
  const hour = new Date().getHours()
  if (hour < 11) return 'Breakfast'
  if (hour < 16) return 'Lunch'
  if (hour < 19) return 'Snack'
  return 'Dinner'
}

export function LogMeals() {
  const t = useT()
  const navigate = usePageNavigate()
  const currentUser = getCurrentUser()

  // 1. Session check: redirect to /login if unauthenticated
  useEffect(() => {
    if (!currentUser?.id) {
      navigate('/login')
    }
  }, [currentUser, navigate])

  const [initialNutrition] = useState(() => getCachedTodayNutrition(currentUser?.id ?? ''))
  const hadCachedNutrition = useRef(Boolean(initialNutrition))
  const [nutritionData, setNutritionData] = useState<TodayNutritionData | null>(initialNutrition)
  const [adjustment, setAdjustment] = useState<CalorieAdjustmentData | null>(null)
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null)
  const [isDeciding, setIsDeciding] = useState(false)
  const [isTipOpen, setIsTipOpen] = useState(false)

  // Add food form state
  const [foodInput, setFoodInput] = useState('')
  const [quantityGrams, setQuantityGrams] = useState('100')
  const [plateFoods, setPlateFoods] = useState<PlateFood[]>([])
  const [mealType, setMealType] = useState(mealTypeForNow)
  const [selectedFoodDensity, setSelectedFoodDensity] = useState<{
    caloriesPer100g: number
    proteinPer100g: number
    carbsPer100g: number
    fatPer100g: number
  }>(DEFAULT_DENSITY)

  // Food suggestions state
  const [suggestions, setSuggestions] = useState<FoodSearchItem[]>([])
  const [isFoodSearchOpen, setIsFoodSearchOpen] = useState(false)
  const [foodSearchMessage, setFoodSearchMessage] = useState<string | null>(null)
  const [isSearchingFoods, setIsSearchingFoods] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // 2. Fetch today's nutrition from database
  useEffect(() => {
    if (!currentUser?.id) return

    let isMounted = true

    fetchTodayNutrition(currentUser.id)
      .then((data) => {
        if (!isMounted) return
        setNutritionData(data)
        setErrorMessage(null)
      })
      .catch((err: Error) => {
        if (!isMounted || hadCachedNutrition.current) return
        setErrorMessage(describeError(err, t('add.errorLoad')))
      })

    return () => {
      isMounted = false
    }
  }, [currentUser?.id, t])

  const refetchNutrition = () => {
    if (!currentUser?.id) return
    fetchTodayNutrition(currentUser.id)
      .then((data) => {
        setNutritionData(data)
      })
      .catch(() => undefined)
  }

  // 2b. Fetch the calorie adjustment proposal for the popup (pending one is stored server side)
  useEffect(() => {
    if (!currentUser?.id) return

    let isMounted = true

    fetchCalorieAdjustment(currentUser.id)
      .then((data) => {
        if (!isMounted) return
        setAdjustment(data)
        setIsTipOpen(data.status === 'pending' && data.has_change)
      })
      .catch(() => undefined)

    return () => {
      isMounted = false
    }
  }, [currentUser?.id])

  const handleOpenTip = () => {
    if (adjustment) {
      setIsTipOpen(true)
      return
    }
    if (!currentUser?.id) return
    setIsTipOpen(true)
    setAdjustmentError(null)
    fetchCalorieAdjustment(currentUser.id)
      .then((data) => {
        setAdjustment(data)
        setAdjustmentError(null)
      })
      .catch((err: unknown) => {
        setAdjustmentError(describeError(err, t('add.errorProgress')))
      })
  }

  const handleConfirmTip = () => {
    if (!adjustment || !currentUser?.id) return
    const current = adjustment
    if (!current.adjustment_id || !current.has_change) {
      setIsTipOpen(false)
      setAdjustment({ ...current, status: 'accepted' })
      return
    }
    setIsDeciding(true)
    setAdjustmentError(null)
    decideCalorieAdjustment(currentUser.id, current.adjustment_id, 'accepted')
      .then((result) => {
        setAdjustment({ ...current, status: 'accepted', proposed_goal: result.calorie_goal })
        setIsTipOpen(false)
        refetchNutrition()
      })
      .catch((err: unknown) => {
        setAdjustmentError(describeError(err, t('add.errorGoal')))
      })
      .finally(() => setIsDeciding(false))
  }

  const handleDeclineTip = () => {
    if (!adjustment || !currentUser?.id) {
      setIsTipOpen(false)
      setAdjustmentError(null)
      return
    }
    const current = adjustment
    if (!current.adjustment_id || !current.has_change) {
      setIsTipOpen(false)
      return
    }
    setIsDeciding(true)
    setAdjustmentError(null)
    decideCalorieAdjustment(currentUser.id, current.adjustment_id, 'rejected')
      .then(() => {
        setAdjustment({ ...current, status: 'rejected' })
        setIsTipOpen(false)
      })
      .catch((err: unknown) => {
        setAdjustmentError(describeError(err, t('add.errorChoice')))
      })
      .finally(() => setIsDeciding(false))
  }

  // 3. Search suggestions as user types in modal
  useEffect(() => {
    if (!isFoodSearchOpen) return

    let isCurrent = true
    const timer = setTimeout(() => {
      setIsSearchingFoods(true)
      setFoodSearchMessage(null)
      searchFoodItems(foodInput.trim())
        .then((items) => {
          if (!isCurrent) return
          setSuggestions(items)
          setFoodSearchMessage(items.length === 0 ? t('add.noFoods') : null)
        })
        .catch((err: unknown) => {
          if (!isCurrent) return
          setSuggestions([])
          setFoodSearchMessage(describeError(err, t('add.errorSearch')))
        })
        .finally(() => {
          if (isCurrent) setIsSearchingFoods(false)
        })
    }, 200)

    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [foodInput, isFoodSearchOpen, t])

  // 4. Live Automatic Nutrition Calculation (User NEVER inputs calories manually)
  const calculatedNutrition = useMemo(() => {
    const qty = Math.max(1, parseFloat(quantityGrams) || 100)
    const ratio = qty / 100
    return {
      calories: Math.round(selectedFoodDensity.caloriesPer100g * ratio),
      protein: Math.round(selectedFoodDensity.proteinPer100g * ratio * 10) / 10,
      carbs: Math.round(selectedFoodDensity.carbsPer100g * ratio * 10) / 10,
      fat: Math.round(selectedFoodDensity.fatPer100g * ratio * 10) / 10,
    }
  }, [quantityGrams, selectedFoodDensity])

  const plateNutrition = useMemo(() => summarizeMeal(plateFoods), [plateFoods])

  const handleBack = () => {
    navigate(-1)
  }

  const handleSelectSuggestion = (item: FoodSearchItem) => {
    setIsFoodSearchOpen(false)
    setFoodInput(item.name)
    setSelectedFoodDensity({
      caloriesPer100g: item.calories_per_100g,
      proteinPer100g: item.proteins_per_100g,
      carbsPer100g: item.carbs_per_100g,
      fatPer100g: item.fats_per_100g,
    })
    setSuggestions([])
    setFoodSearchMessage(null)
  }

  const handleAddFood = () => {
    if (!foodInput.trim()) return
    const quantity = Math.max(1, parseFloat(quantityGrams) || 100)
    setPlateFoods((foods) => [...foods, {
      name: foodInput.trim(),
      quantityGrams: quantity,
      ...calculatedNutrition,
      caloriesPer100g: selectedFoodDensity.caloriesPer100g,
      proteinPer100g: selectedFoodDensity.proteinPer100g,
      carbsPer100g: selectedFoodDensity.carbsPer100g,
      fatPer100g: selectedFoodDensity.fatPer100g,
    }])
    setFoodInput('')
    setQuantityGrams('100')
    setSelectedFoodDensity(DEFAULT_DENSITY)
    setSuggestions([])
    setIsFoodSearchOpen(false)
    setFoodSearchMessage(null)
  }

  // 5. Submit new meal: auto-calculated calories & macros saved to database
  const handleSaveMeal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (plateFoods.length === 0) return
    if (!currentUser?.id) {
      navigate('/login')
      return
    }

    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      await addMealLog({
        user_id: currentUser.id,
        name: plateFoods.map((food) => food.name).join(' + '),
        calories: plateNutrition.calories,
        quantity_g: plateNutrition.quantityGrams,
        meal_type: mealType,
        proteins: Math.round(plateNutrition.protein * 10) / 10,
        carbs: Math.round(plateNutrition.carbs * 10) / 10,
        fats: Math.round(plateNutrition.fat * 10) / 10,
        ingredients: plateFoods.map((food): MealIngredient => ({
          name: food.name,
          quantity_g: food.quantityGrams,
          calories_per_100g: food.caloriesPer100g,
          proteins_per_100g: food.proteinPer100g,
          carbs_per_100g: food.carbsPer100g,
          fats_per_100g: food.fatPer100g,
        })),
      })

      navigate('/nutrition', { replace: true })
    } catch (err: unknown) {
      setErrorMessage(describeError(err, t('add.errorSave')))
    } finally {
      setIsSubmitting(false)
    }
  }

  const macroBars = [
    { label: t('macro.protein'), value: calculatedNutrition.protein, target: nutritionData?.target_proteins_g ?? 0 },
    { label: t('macro.fats'), value: calculatedNutrition.fat, target: nutritionData?.target_fats_g ?? 0 },
    { label: t('macro.carbs'), value: calculatedNutrition.carbs, target: nutritionData?.target_carbs_g ?? 0 },
  ]

  return (
    <div className="screen hifi-screen hifi-theme add-food-screen">
      <header className="add-food-header">
        <button type="button" className="scan-back" onClick={handleBack} aria-label={t('common.back')}>
          <img src={backIcon} alt="" width={36} height={37} />
        </button>
        <div className="hifi-page-header">
          <h1 className="hifi-page-title">{t('add.title')}</h1>
          <button
            type="button"
            className="hifi-pill add-food-scan"
            // Non-Premium users see the paywall; the server checks Premium again on every scan.
            onClick={() => navigate(isPremiumActive() ? '/scan-meal' : '/premium')}
            aria-label={isPremiumActive() ? t('add.scanAria') : t('add.scanAriaPro')}
          >
            {t('add.scan')} <Crown size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <form onSubmit={handleSaveMeal} className="add-food-form">
        <section className="hifi-section" aria-labelledby="meal-type-title">
          <h2 className="hifi-section-title" id="meal-type-title">{t('meals.mealType')}</h2>
          <div className="add-food-types" role="group" aria-labelledby="meal-type-title">
            {MEAL_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="add-food-type"
                aria-pressed={mealType === type}
                onClick={() => setMealType(type)}
              >
                {valueLabel(t, 'mealType', type)}
              </button>
            ))}
          </div>
        </section>

        <div className="add-food-fields">
          <div className="add-food-field">
            <label htmlFor="foodInput">{t('add.foodName')}</label>
            <input
              id="foodInput"
              type="text"
              placeholder={t('add.foodPlaceholder')}
              value={foodInput}
              onChange={(e) => {
                setFoodInput(e.target.value)
                setIsFoodSearchOpen(true)
                setFoodSearchMessage(null)
                setSelectedFoodDensity(DEFAULT_DENSITY)
              }}
              onFocus={() => setIsFoodSearchOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setIsFoodSearchOpen(false)
                  setSuggestions([])
                  setFoodSearchMessage(null)
                }
              }}
              autoComplete="off"
            />
            {isSearchingFoods && <Loader2 size={16} className="animate-spin add-food-spinner" aria-label={t('meals.searching')} />}
            {isFoodSearchOpen && suggestions.length > 0 && (
              <ul className="add-food-suggestions">
                {suggestions.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => handleSelectSuggestion(item)}>
                      <span>{item.name}</span>
                      <small>{item.calories_per_100g} kcal / 100g</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {isFoodSearchOpen && foodSearchMessage && <p className="hifi-muted" role="status">{foodSearchMessage}</p>}
          </div>

          <div className="add-food-field">
            <label htmlFor="quantityGrams">{t('meals.quantity')}</label>
            <span className="add-food-quantity">
              <input
                id="quantityGrams"
                type="number"
                min="1"
                inputMode="numeric"
                placeholder="100"
                value={quantityGrams}
                onChange={(e) => setQuantityGrams(e.target.value)}
              />
              <span aria-hidden="true">g</span>
            </span>
            <span className="add-food-presets" role="group" aria-label={t('add.quickPortions')}>
              {['50', '100', '150', '200', '250'].map((g) => (
                <button key={g} type="button" aria-pressed={quantityGrams === g} onClick={() => setQuantityGrams(g)}>{g}g</button>
              ))}
            </span>
          </div>
        </div>

        <ul className="add-food-macros" aria-label={t('add.macrosFor', { grams: quantityGrams || 100 })}>
          {macroBars.map((macro) => (
            <li key={macro.label}>
              <span className="add-food-macro-name">{macro.label}</span>
              <span className="add-food-macro-value">{macro.value}g</span>
              {/* The bar is this portion's share of the day's target for that macro. */}
              <span className="add-food-macro-bar" aria-hidden="true">
                <span style={{ width: `${macro.target > 0 ? Math.min(100, (macro.value / macro.target) * 100) : 0}%` }} />
              </span>
            </li>
          ))}
        </ul>

        <button type="button" className="hifi-pill add-food-add" onClick={handleAddFood} disabled={!foodInput.trim()}>
          + {t('add.addTo', { type: valueLabel(t, 'mealType', mealType).toLowerCase() })}
        </button>

        <section className="hifi-section" aria-labelledby="meal-contents-title">
          <h2 className="hifi-section-title" id="meal-contents-title">{t('add.contents', { type: valueLabel(t, 'mealType', mealType) })}</h2>
          {plateFoods.length === 0 ? (
            <p className="hifi-muted">{t('add.buildHint')}</p>
          ) : (
            <ul className="add-food-contents">
              {plateFoods.map((food, index) => (
                <li key={`${food.name}-${index}`}>
                  <span className="add-food-content-name">{food.name}</span>
                  <span className="add-food-content-grams">{food.quantityGrams}g</span>
                  <span className="add-food-content-kcal">{food.calories}kcal</span>
                  <button type="button" onClick={() => setPlateFoods((foods) => foods.filter((_, i) => i !== index))} aria-label={t('hydration.removeAria', { label: food.name })}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <dl className="add-food-totals">
          <div><dt>{t('add.estimate')}</dt><dd>{foodInput.trim() ? `${calculatedNutrition.calories}kcal` : '–'}</dd></div>
          <div><dt>{t('add.mealTotal')}</dt><dd>{plateNutrition.calories}kcal</dd></div>
        </dl>

        {errorMessage && <div className="inline-alert" role="alert">{errorMessage}</div>}

        <button type="submit" className="hifi-pill is-big add-food-save" disabled={isSubmitting || plateFoods.length === 0}>
          {isSubmitting ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> {t('common.saving')}</> : t('add.saveMeal')}
        </button>
        <button type="button" className="hifi-link-button add-food-tip" onClick={handleOpenTip}>
          <Sparkles size={14} aria-hidden="true" /> {t('add.aiTip')}
        </button>
      </form>

      {isTipOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="calorie-adjustment-title">
          <div className="modal-dialog tip-dialog">
            <div className="modal-header">
              <h2 className="modal-title" id="calorie-adjustment-title">
                {adjustment?.has_change ? t('add.goalAdjustment') : t('add.trainerTip')}
              </h2>
              <button type="button" className="btn-modal-close" onClick={handleDeclineTip} aria-label={t('add.closeTip')}>
                <X size={18} />
              </button>
            </div>
            <div className="tip-body">
              {adjustmentError ? (
                <p className="tip-error" role="alert">{adjustmentError}</p>
              ) : !adjustment ? (
                <p className="tip-message">{t('add.checking7')}</p>
              ) : (
                <>
                  {adjustment.has_change && (
                    <p className="tip-goals">
                      <span className="tip-goal-old">{adjustment.previous_goal} kcal</span>
                      <span className="tip-goal-arrow">→</span>
                      <span className="tip-goal-new">{adjustment.proposed_goal} kcal</span>
                    </p>
                  )}
                  <p className="tip-message">{adjustment.reason}</p>
                  {(adjustment.status === 'pending' || adjustment.status === 'advice') && (
                    <p className="tip-reasoning">
                      <strong>{t('add.why')}</strong> {t('add.whyBody', { pct: Math.round(adjustment.compliance_rate * 100), kcal: adjustment.avg_daily_intake, volume: adjustment.weekly_volume })}
                    </p>
                  )}
                  {adjustment.fatigue_workouts > 0 && (
                    <p className="tip-reasoning">
                      <strong>{t('add.fatigue')}</strong>{' '}
                      {adjustment.fatigue_latest > 0
                        ? t('add.fatigueLatest', { value: adjustment.fatigue_latest })
                        : t('add.fatigueAvg', { value: adjustment.fatigue_avg })}
                      {adjustment.fatigue_workouts > 1
                        && ` · ${t('add.fatigueAvgOver', { value: adjustment.fatigue_avg, count: adjustment.fatigue_workouts })}`}.
                      {adjustment.fatigue_latest > 5
                        ? ` ${t('add.recoveryIncluded')}`
                        : ` ${t('add.noRecovery')}`}
                    </p>
                  )}
                  {adjustment.activity?.connected && (
                    <p className="tip-reasoning">
                      <strong>Health Connect:</strong>{' '}
                      {t('add.healthBody', { steps: adjustment.activity.steps_avg_7d.toLocaleString(locale()), kcal: adjustment.activity.active_calories_avg_7d })}
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="tip-actions">
              {adjustment ? (
                <>
                  <button
                    type="button"
                    className="primary-button tip-accept-btn"
                    onClick={handleConfirmTip}
                    disabled={isDeciding}
                  >
                    {isDeciding
                      ? t('common.saving')
                      : adjustment.has_change
                        ? t('add.apply', { kcal: adjustment.proposed_goal })
                        : t('tip.gotIt')}
                  </button>
                  {adjustment.has_change && (
                    <button
                      type="button"
                      className="tip-decline-btn"
                      onClick={handleDeclineTip}
                      disabled={isDeciding}
                    >
                      {t('add.keep', { kcal: adjustment.previous_goal })}
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="primary-button tip-accept-btn"
                  onClick={handleOpenTip}
                  disabled={!adjustmentError}
                >
                  {adjustmentError ? t('common.retry') : t('add.checking')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default LogMeals
