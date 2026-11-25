import React, { useState, useEffect, useRef } from 'react';
import { AlertTriangle, ChefHat, ChevronDown, ChevronLeft, ChevronRight, Heart, Loader2, Plus, Scale, Search, Trash2, X } from 'lucide-react';
import { usePageNavigate } from '../utils/usePageNavigate';
import {
  addFavoriteMeal,
  addMealLog,
  deleteFavoriteMeal,
  deleteMealLog,
  fetchFavoriteMeals,
  fetchTodayNutrition,
  getCurrentUser,
  getSavedDayNutrition,
  isPremiumActive,
  searchFoodItems,
  updateFavoriteMeal,
  updateMealLog,
  type TodayNutritionData,
} from '../services/api';
import IntakeCard from '../components/nutrition/IntakeCard';
import MealDatePicker from '../components/nutrition/MealDatePicker';
import FavoriteMealsModal from '../components/nutrition/FavoriteMealsModal';
import MealRecommendationsModal from '../components/nutrition/MealRecommendationsModal';
import { sameDay } from '../utils/monthGrid';
import type { FavoriteMeal, FoodSearchItem, MealIngredient, MealLogItem } from '../services/api';
import HydrationSummary from '../components/home/HydrationSummary';
import { locale, useT, valueLabel } from '../i18n';
import '../styles/log-meals.css';
import '../styles/meals.css';

// Names match ignoring case, like the server's unique rule.
const favoriteKey = (mealType: string, name: string) => `${mealType}|${name.trim().toLowerCase()}`;

const DEFAULT_FOOD_DENSITY = {
  calories_per_100g: 130,
  proteins_per_100g: 8,
  carbs_per_100g: 15,
  fats_per_100g: 3.5,
};

const MAX_REASONABLE_QUANTITY_G = 1000;
const FALLBACK_QUANTITY_G = 100;

type HighQuantityWarning =
  | {
    target: 'ingredient';
    index: number;
    name: string;
    previous: number;
    next: number;
  }
  | {
    target: 'new';
    name: string;
    previous: number;
    next: number;
  };

const MAX_DAYS_BACK = 7;

/** YYYY-MM-DD in the phone's own time zone. */
function toInputDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function Nutrition() {
  const t = useT();
  const navigate = usePageNavigate();
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  // Start from the copy saved earlier in this visit, so the card and list show at once.
  const [cachedToday] = useState(() => getSavedDayNutrition(getCurrentUser()?.id ?? '', toInputDate(new Date())));
  const [meals, setMeals] = useState<MealLogItem[]>(cachedToday?.meals ?? []);
  const [targets, setTargets] = useState<Pick<TodayNutritionData, 'daily_goal' | 'target_proteins_g' | 'target_carbs_g' | 'target_fats_g'> | null>(cachedToday);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const daySwipeRef = useRef<{ x: number; y: number; swiped: boolean } | null>(null);
  const [isLoading, setIsLoading] = useState(!cachedToday);
  // When the day changes, show its saved copy in the same render; the effect below refreshes it.
  const [shownDate, setShownDate] = useState(selectedDate);
  if (shownDate !== selectedDate) {
    setShownDate(selectedDate);
    const userId = getCurrentUser()?.id;
    const saved = userId ? getSavedDayNutrition(userId, toInputDate(selectedDate)) : null;
    if (saved) {
      setMeals(saved.meals || []);
      setTargets(saved);
    }
    setIsLoading(!saved);
  }

  // États pour l'édition et la suppression
  const [editingMeal, setEditingMeal] = useState<MealLogItem | null>(null);
  const [editIngredients, setEditIngredients] = useState<MealIngredient[]>([]);
  const [editMealType, setEditMealType] = useState('Meal');
  const [editFoodName, setEditFoodName] = useState('');
  const [editQuantity, setEditQuantity] = useState('100');
  const [editDensity, setEditDensity] = useState(DEFAULT_FOOD_DENSITY);
  const [foodSuggestions, setFoodSuggestions] = useState<FoodSearchItem[]>([]);
  const [isFoodSearchOpen, setIsFoodSearchOpen] = useState(false);
  const [isSearchingFoods, setIsSearchingFoods] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deletingMeal, setDeletingMeal] = useState<MealLogItem | null>(null);
  const [isDeletingMeal, setIsDeletingMeal] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [highQuantityWarning, setHighQuantityWarning] = useState<HighQuantityWarning | null>(null);
  const ingredientQuantityStartRef = useRef<Record<number, number>>({});
  const newQuantityStartRef = useRef<number>(FALLBACK_QUANTITY_G);

  const [favorites, setFavorites] = useState<FavoriteMeal[]>([]);
  const [isLoadingFavorites, setIsLoadingFavorites] = useState(true);
  const [favoritesError, setFavoritesError] = useState<string | null>(null);
  const [isFavoritesOpen, setIsFavoritesOpen] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  // Set while the edit dialog is editing a favorite instead of a logged meal.
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | null>(null);
  const [heartBusyId, setHeartBusyId] = useState<string | null>(null);
  const [openMealId, setOpenMealId] = useState<string | null>(null);
  // Which heart just changed, so only that one animates (not hearts already set on load).
  const [heartAnim, setHeartAnim] = useState<{ id: string; kind: 'pop' | 'unpop' } | null>(null);
  const [favoriteNotice, setFavoriteNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchFavoriteMeals()
      .then(setFavorites)
      .catch((error: unknown) => setFavoritesError(error instanceof Error ? error.message : t('meals.errorFavorites')))
      .finally(() => setIsLoadingFavorites(false));
  }, [t]);

  const favoritesByKey = new Map(favorites.map((favorite) => [favoriteKey(favorite.meal_type, favorite.name), favorite]));

  const toggleFavorite = async (meal: MealLogItem) => {
    const existing = favoritesByKey.get(favoriteKey(meal.meal_type, meal.meal_name));
    const pendingId = `pending-${meal.id}`;
    setHeartBusyId(meal.id);
    setFavoriteNotice(null);
    // The heart changes on tap; the request confirms it, and a failure puts it back.
    if (existing) {
      setFavorites((current) => current.filter((favorite) => favorite.id !== existing.id));
      setHeartAnim({ id: meal.id, kind: 'unpop' });
    } else {
      setFavorites((current) => [{
        id: pendingId,
        name: meal.meal_name,
        meal_type: meal.meal_type,
        calories: meal.item_calories,
        proteins_g: meal.proteins_g ?? 0,
        carbs_g: meal.carbs_g ?? 0,
        fats_g: meal.fats_g ?? 0,
        quantity_g: Number(meal.weight_g) || 100,
        ingredients: meal.ingredients ?? [],
      }, ...current]);
      setHeartAnim({ id: meal.id, kind: 'pop' });
    }
    try {
      if (existing) {
        await deleteFavoriteMeal(existing.id);
      } else {
        const saved = await addFavoriteMeal(meal.id);
        setFavorites((current) => [saved, ...current.filter((favorite) => favorite.id !== pendingId && favorite.id !== saved.id)]);
      }
    } catch (error) {
      setFavorites((current) => (existing
        ? [existing, ...current.filter((favorite) => favorite.id !== existing.id)]
        : current.filter((favorite) => favorite.id !== pendingId)));
      setFavoriteNotice(error instanceof Error ? error.message : t('meals.errorFavoriteUpdate'));
    } finally {
      setHeartBusyId(null);
    }
  };

  const logFavorite = async (favorite: FavoriteMeal, consumedAt: Date | null) => {
    const user = getCurrentUser();
    if (!user?.id) throw new Error(t('meals.errorSignInLog'));
    await addMealLog({
      user_id: user.id,
      name: favorite.name,
      meal_type: favorite.meal_type,
      ...(favorite.ingredients.length
        ? { ingredients: favorite.ingredients }
        : { calories: favorite.calories, quantity_g: favorite.quantity_g, proteins: favorite.proteins_g, carbs: favorite.carbs_g, fats: favorite.fats_g }),
      ...(consumedAt ? { consumed_at: consumedAt.toISOString() } : {}),
    });
    setIsFavoritesOpen(false);
    // Show the day it was logged to; a new Date also reloads the list when it's the same day.
    setSelectedDate(consumedAt ?? new Date());
  };

  const removeFavorite = async (favorite: FavoriteMeal) => {
    await deleteFavoriteMeal(favorite.id);
    setFavorites((current) => current.filter((item) => item.id !== favorite.id));
  };

  const editFavorite = (favorite: FavoriteMeal) => {
    setIsFavoritesOpen(false);
    setEditingFavoriteId(favorite.id);
    openEditModal({
      id: favorite.id,
      user_id: '',
      meal_name: favorite.name,
      meal_type: favorite.meal_type,
      portion_amount: '1',
      weight_g: String(favorite.quantity_g),
      item_calories: favorite.calories,
      proteins_g: favorite.proteins_g,
      carbs_g: favorite.carbs_g,
      fats_g: favorite.fats_g,
      ingredients: favorite.ingredients,
    });
  };

  const closeEditor = () => {
    setEditingMeal(null);
    if (editingFavoriteId) {
      setEditingFavoriteId(null);
      setIsFavoritesOpen(true);
    }
  };

  // Reloads the meals each time the selected day changes.
  useEffect(() => {
    const user = getCurrentUser();
    if (!user?.id) return;

    const formattedDate = toInputDate(selectedDate);
    const cached = getSavedDayNutrition(user.id, formattedDate);

    // A slower answer for a day the user already left must not overwrite the current day.
    let isCurrent = true;
    fetchTodayNutrition(user.id, formattedDate)
      .then(data => {
        if (!isCurrent) return;
        setMeals(data.meals || []);
        setTargets(data);
      })
      .catch(error => {
        if (!isCurrent) return;
        console.error("Could not load meals:", error);
        if (!cached) setMeals([]);
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [selectedDate]);

  useEffect(() => {
    if (!editingMeal || !isFoodSearchOpen || !editFoodName.trim()) {
      return;
    }

    let isCurrent = true;
    const timer = window.setTimeout(() => {
      setIsSearchingFoods(true);
      searchFoodItems(editFoodName.trim())
        .then((items) => {
          if (isCurrent) setFoodSuggestions(items);
        })
        .catch((error: unknown) => {
          if (isCurrent) setEditError(error instanceof Error ? error.message : t('meals.errorSearch'));
        })
        .finally(() => {
          if (isCurrent) setIsSearchingFoods(false);
        });
    }, 200);

    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [editingMeal, editFoodName, isFoodSearchOpen, t]);

  const consumedKcal = meals.reduce((total, meal) => total + meal.item_calories, 0);
  const today = new Date();
  const oldestDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - MAX_DAYS_BACK);
  const canGoBack = !sameDay(selectedDate, oldestDay) && selectedDate > oldestDay;
  const canGoForward = !sameDay(selectedDate, today);
  const moveDay = (step: number) => {
    if (step < 0 ? !canGoBack : !canGoForward) return;
    setSelectedDate((current) => new Date(current.getFullYear(), current.getMonth(), current.getDate() + step));
  };


  const formatDateLabel = (date: Date) => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
    const dateString = date.toLocaleDateString(locale(), options);

    if (date.toDateString() === today.toDateString()) return t('meals.todayDate', { date: dateString });
    if (date.toDateString() === yesterday.toDateString()) return t('meals.yesterdayDate', { date: dateString });
    return dateString;
  };

  const openEditModal = (meal: MealLogItem) => {
    setEditingMeal(meal);
    const quantity = Math.max(1, Number(meal.weight_g) || 100);
    setEditIngredients(meal.ingredients?.length ? meal.ingredients.map((ingredient) => ({ ...ingredient })) : [{
      name: meal.meal_name,
      quantity_g: quantity,
      calories_per_100g: meal.item_calories / quantity * 100,
      proteins_per_100g: (meal.proteins_g ?? 0) / quantity * 100,
      carbs_per_100g: (meal.carbs_g ?? 0) / quantity * 100,
      fats_per_100g: (meal.fats_g ?? 0) / quantity * 100,
    }]);
    setEditMealType(meal.meal_type || 'Meal');
    setEditFoodName('');
    setIsFoodSearchOpen(false);
    setIsSearchingFoods(false);
    setEditQuantity('100');
    setEditDensity(DEFAULT_FOOD_DENSITY);
    setEditError(null);
    setHighQuantityWarning(null);
    ingredientQuantityStartRef.current = {};
    newQuantityStartRef.current = FALLBACK_QUANTITY_G;
  };

  const selectFoodSuggestion = (food: FoodSearchItem) => {
    setEditFoodName(food.name);
    setIsFoodSearchOpen(false);
    setIsSearchingFoods(false);
    setEditDensity({
      calories_per_100g: food.calories_per_100g,
      proteins_per_100g: food.proteins_per_100g,
      carbs_per_100g: food.carbs_per_100g,
      fats_per_100g: food.fats_per_100g,
    });
    setFoodSuggestions([]);
  };

  const addEditIngredient = () => {
    const name = editFoodName.trim();
    const quantity = Number(editQuantity);
    if (!name || !Number.isFinite(quantity) || quantity <= 0) return;
    setEditIngredients((current) => [...current, { name, quantity_g: quantity, ...editDensity }]);
    setEditFoodName('');
    setIsFoodSearchOpen(false);
    setIsSearchingFoods(false);
    setEditQuantity('100');
    setEditDensity(DEFAULT_FOOD_DENSITY);
    setFoodSuggestions([]);
  };

  const rememberIngredientQuantityStart = (index: number, quantity: number) => {
    ingredientQuantityStartRef.current[index] = quantity;
  };

  const updateIngredientQuantity = (index: number, rawValue: string) => {
    const ingredient = editIngredients[index];
    if (!ingredient) return;
    const nextQuantity = Number(rawValue);
    setEditIngredients((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, quantity_g: nextQuantity } : item));

    if (!Number.isFinite(nextQuantity)) return;
    if (nextQuantity > MAX_REASONABLE_QUANTITY_G && nextQuantity !== ingredient.quantity_g) {
      const previous = ingredientQuantityStartRef.current[index] ?? ingredient.quantity_g;
      setHighQuantityWarning({
        target: 'ingredient',
        index,
        name: ingredient.name,
        previous: previous > 0 ? previous : FALLBACK_QUANTITY_G,
        next: nextQuantity,
      });
    }
  };

  const rememberNewQuantityStart = () => {
    const quantity = Number(editQuantity);
    newQuantityStartRef.current = Number.isFinite(quantity) && quantity > 0 ? quantity : FALLBACK_QUANTITY_G;
  };

  const updateNewQuantity = (rawValue: string) => {
    const previousQuantity = Number(editQuantity);
    const nextQuantity = Number(rawValue);
    setEditQuantity(rawValue);

    if (!Number.isFinite(nextQuantity)) return;
    if (nextQuantity > MAX_REASONABLE_QUANTITY_G && nextQuantity !== previousQuantity) {
      setHighQuantityWarning({
        target: 'new',
        name: editFoodName.trim() || t('meals.thisIngredient'),
        previous: newQuantityStartRef.current,
        next: nextQuantity,
      });
    }
  };

  const acceptHighQuantity = () => {
    setHighQuantityWarning(null);
  };

  const rollbackHighQuantity = () => {
    const warning = highQuantityWarning;
    if (!warning) return;
    const previous = Number.isFinite(warning.previous) && warning.previous > 0
      ? warning.previous
      : FALLBACK_QUANTITY_G;

    if (warning.target === 'ingredient') {
      setEditIngredients((current) => current.map((item, itemIndex) =>
        itemIndex === warning.index ? { ...item, quantity_g: previous } : item));
    } else {
      setEditQuantity(String(previous));
    }
    setHighQuantityWarning(null);
  };

  const editNutrition = editIngredients.reduce((total, ingredient) => {
    const ratio = ingredient.quantity_g / 100;
    return {
      quantity: total.quantity + ingredient.quantity_g,
      calories: total.calories + ingredient.calories_per_100g * ratio,
      protein: total.protein + ingredient.proteins_per_100g * ratio,
      carbs: total.carbs + ingredient.carbs_per_100g * ratio,
      fat: total.fat + ingredient.fats_per_100g * ratio,
    };
  }, { quantity: 0, calories: 0, protein: 0, carbs: 0, fat: 0 });

  const confirmEdit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingMeal || highQuantityWarning || editIngredients.length === 0 || editIngredients.some((ingredient) => ingredient.quantity_g <= 0)) return;
    const user = getCurrentUser();
    if (!user?.id) {
      setEditError(t('meals.errorSignInUpdate'));
      return;
    }
    setIsSavingEdit(true);
    setEditError(null);
    const changes = {
      name: editIngredients.map((ingredient) => ingredient.name).join(' + '),
      meal_type: editMealType,
      ingredients: editIngredients,
    };
    try {
      if (editingFavoriteId) {
        const updated = await updateFavoriteMeal(editingFavoriteId, changes);
        setFavorites((current) => current.map((favorite) => favorite.id === updated.id ? updated : favorite));
        closeEditor();
        return;
      }
      const updatedMeal = await updateMealLog(user.id, editingMeal.id, changes);
      setMeals((current) => current.map((meal) => meal.id === updatedMeal.id ? updatedMeal : meal));
      setEditingMeal(null);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : t('meals.errorUpdate'));
    } finally {
      setIsSavingEdit(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingMeal) return;
    const user = getCurrentUser();
    if (!user?.id) {
      setDeleteError(t('meals.errorSignInRemove'));
      return;
    }
    setIsDeletingMeal(true);
    setDeleteError(null);
    try {
      await deleteMealLog(user.id, deletingMeal.id);
      setMeals((current) => current.filter((meal) => meal.id !== deletingMeal.id));
      setDeletingMeal(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('meals.errorRemove'));
    } finally {
      setIsDeletingMeal(false);
    }
  };

  return (
    <div
      className="screen hifi-screen hifi-theme meals-screen"
      // Swipe left or right anywhere on the page to change day.
      onPointerDown={(event) => { daySwipeRef.current = { x: event.clientX, y: event.clientY, swiped: false }; }}
      onPointerUp={(event) => {
        const start = daySwipeRef.current;
        if (!start) return;
        const dx = event.clientX - start.x;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(event.clientY - start.y) * 1.5) {
          start.swiped = true;
          moveDay(dx < 0 ? 1 : -1);
        }
      }}
      onClickCapture={(event) => {
        if (daySwipeRef.current?.swiped) event.stopPropagation();
        daySwipeRef.current = null;
      }}
    >
      <header className="hifi-page-header">
        <h1 className="hifi-page-title">{t('meals.title')}</h1>
        <button className="hifi-pill" type="button" onClick={() => navigate('/log-meals')}>{t('meals.addMeal')}</button>
      </header>

      <nav className="meal-day-nav" aria-label={t('meals.day')}>
        <button className="subpage-button" type="button" onClick={() => moveDay(-1)} disabled={!canGoBack} aria-label={t('meals.prevDay')}>
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button className="meal-day-button" type="button" onClick={() => setIsDatePickerOpen(true)} aria-haspopup="dialog" aria-label={t('meals.chooseDay', { date: formatDateLabel(selectedDate) })}>
          {formatDateLabel(selectedDate)}
        </button>
        <button className="subpage-button" type="button" onClick={() => moveDay(1)} disabled={!canGoForward} aria-label={t('meals.nextDay')}>
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </nav>

      {isDatePickerOpen && (
        <MealDatePicker
          selected={selectedDate}
          min={oldestDay}
          max={today}
          onSelect={(date) => {
            setSelectedDate(date);
            setIsDatePickerOpen(false);
          }}
          onClose={() => setIsDatePickerOpen(false)}
        />
      )}

      {/* Always drawn, so it never pops in late: it shows its shape while the day loads. */}
      <IntakeCard
        label={t('meals.dailyIntake')}
        consumed={consumedKcal}
        goal={targets?.daily_goal ?? 0}
        pending={!targets}
        macros={[
          { label: t('macro.protein'), current: meals.reduce((total, meal) => total + (meal.proteins_g ?? 0), 0), target: targets?.target_proteins_g ?? 0 },
          { label: t('macro.carbs'), current: meals.reduce((total, meal) => total + (meal.carbs_g ?? 0), 0), target: targets?.target_carbs_g ?? 0 },
          { label: t('macro.fat'), current: meals.reduce((total, meal) => total + (meal.fats_g ?? 0), 0), target: targets?.target_fats_g ?? 0 },
        ]}
        footer={<p className="hifi-caption meals-remaining">
          {targets ? t(consumedKcal > targets.daily_goal ? 'meals.over' : 'meals.remaining', { value: Math.abs(Math.round(targets.daily_goal - consumedKcal)).toLocaleString(locale()) }) : ' '}
        </p>}
      />

      <div className="action-row">
        <button className="action-button" type="button" onClick={() => { setFavoriteNotice(null); setIsFavoritesOpen(true); }}>
          <Heart size={17} aria-hidden="true" /> {t('meals.favorites')}{favorites.length > 0 && ` · ${favorites.length}`}
        </button>
        <button
          className="action-button"
          type="button"
          // Non-Premium users see the paywall; the server checks Premium again on every request.
          onClick={() => (isPremiumActive() ? setIsSuggestionsOpen(true) : navigate('/premium'))}
          aria-label={isPremiumActive() ? t('meals.suggested') : t('meals.suggestedPro')}
        >
          <ChefHat size={17} aria-hidden="true" /> {t('meals.suggestions')} {!isPremiumActive() && <span className="pro-badge">Pro</span>}
        </button>
      </div>
      {favoriteNotice && <p className="form-error" role="alert">{favoriteNotice}</p>}

      <section className="meals-panel" aria-labelledby="meals-list-title">
        <h2 className="hifi-section-title" id="meals-list-title">{sameDay(selectedDate, today) ? t('meals.todaysMeals') : t('meals.thisDay')}</h2>
        <div className="meals-panel-list">
          {isLoading ? (
            <p className="visually-hidden" role="status">{t('meals.loading')}</p>
          ) : meals.length === 0 ? (
            <p className="hifi-muted">{t('meals.none')}</p>
          ) : (
            meals.map((meal) => {
              const isFavorite = favoritesByKey.has(favoriteKey(meal.meal_type, meal.meal_name));
              return (
                <article className="meals-card" key={meal.id} data-open={openMealId === meal.id}>
                  <div className="meals-card-top">
                    <button
                      className="meals-card-main"
                      type="button"
                      onClick={() => setOpenMealId(openMealId === meal.id ? null : meal.id)}
                      aria-expanded={openMealId === meal.id}
                      aria-label={t(openMealId === meal.id ? 'meals.cardAriaHide' : 'meals.cardAriaShow', { type: valueLabel(t, 'mealType', meal.meal_type), name: meal.meal_name, kcal: meal.item_calories })}
                    >
                      <span className="meals-card-type">{valueLabel(t, 'mealType', meal.meal_type)}</span>
                      <span className="meals-card-name">{meal.meal_name}</span>
                    </button>
                    <span className="meals-card-side">
                      <span className="meals-card-icons">
                        <button
                          className={`meals-card-heart${heartAnim?.id === meal.id ? ` is-${heartAnim.kind}` : ''}`}
                          onAnimationEnd={() => setHeartAnim(null)}
                          type="button"
                          onClick={() => toggleFavorite(meal)}
                          disabled={heartBusyId === meal.id}
                          aria-pressed={isFavorite}
                          aria-label={isFavorite ? t('meals.unfavorite', { name: meal.meal_name }) : t('meals.favorite', { name: meal.meal_name })}
                        >
                          <Heart size={18} aria-hidden="true" fill={isFavorite ? 'currentColor' : 'none'} />
                        </button>
                        <ChevronDown className="meals-card-chevron" size={22} strokeWidth={1.5} aria-hidden="true" />
                      </span>
                      <span className="meals-card-kcal">{meal.item_calories}kcal</span>
                    </span>
                  </div>
                  {openMealId === meal.id && (
                    <div className="meals-card-details">
                      {meal.ingredients?.length ? (
                        <ul className="meals-card-foods" aria-label={t('meals.contents', { name: meal.meal_name })}>
                          {meal.ingredients.map((ingredient, index) => (
                            <li key={`${ingredient.name}-${index}`}>
                              <span>{ingredient.name}</span>
                              <span><b>{Math.round(ingredient.quantity_g)}g</b> {Math.round(ingredient.calories_per_100g * ingredient.quantity_g / 100)}kcal</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="meals-card-foods-empty">{meal.weight_g ? `${Math.round(Number(meal.weight_g))}g · ` : ''}{t('meals.noBreakdown')}</p>
                      )}
                      <button className="hifi-link-button meals-card-edit" type="button" onClick={() => openEditModal(meal)}>{t('common.edit')}</button>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>

      <HydrationSummary detailed />

      {editingMeal && (
        <div className="modal-backdrop" onClick={() => !isSavingEdit && closeEditor()}>
          <div className="modal-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="edit-meal-title">
            <div className="modal-header">
              <div>
                <h2 id="edit-meal-title" className="modal-title">{editingFavoriteId ? t('meals.editFavorite') : t('meals.editMeal')}</h2>
                <p className="card-subtitle">
                  {editingFavoriteId ? t('meals.editFavoriteHint') : t('meals.editMealHint')}
                </p>
              </div>
              <button type="button" className="btn-modal-close" onClick={closeEditor} aria-label={t('meals.closeEditor')} disabled={isSavingEdit}>
                <X size={20} />
              </button>
            </div>

            <form className="modal-form" onSubmit={confirmEdit}>
              <div className="form-group">
                <label className="form-label" htmlFor="edit-meal-type">{t('meals.mealType')}</label>
                <select id="edit-meal-type" className="form-input" value={editMealType} onChange={(event) => setEditMealType(event.target.value)}>
                  {['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Meal'].map((type) => <option key={type} value={type}>{valueLabel(t, 'mealType', type)}</option>)}
                </select>
              </div>

              <div className="form-group" style={{ position: 'relative' }}>
                <label className="form-label" htmlFor="edit-food-name">{t('meals.addIngredientLabel')}</label>
                <div className="input-with-icon">
                  <input
                    id="edit-food-name"
                    className="form-input"
                    value={editFoodName}
                    onChange={(event) => {
                      setEditFoodName(event.target.value);
                      setIsFoodSearchOpen(true);
                      setFoodSuggestions([]);
                      setIsSearchingFoods(false);
                      setEditDensity(DEFAULT_FOOD_DENSITY);
                      setEditError(null);
                    }}
                    placeholder={t('meals.searchFoods')}
                    autoComplete="off"
                  />
                  {isSearchingFoods
                    ? <Loader2 size={16} className="animate-spin input-spinner" aria-label={t('meals.searching')} />
                    : <Search size={16} className="input-spinner" aria-hidden="true" />}
                </div>
                {isFoodSearchOpen && foodSuggestions.length > 0 && (
                  <ul className="suggestions-list">
                    {foodSuggestions.map((food) => (
                      <li key={food.id}>
                        <button type="button" className="suggestion-item" onClick={() => selectFoodSuggestion(food)}>
                          <span className="suggestion-name">{food.name}</span>
                          <span className="suggestion-cals">{food.calories_per_100g} kcal / 100g</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="inputs-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="edit-food-quantity">{t('meals.quantity')}</label>
                  <div className="input-with-suffix">
                    <input
                      id="edit-food-quantity"
                      className="form-input"
                      type="number"
                      min="1"
                      value={editQuantity}
                      onFocus={rememberNewQuantityStart}
                      onChange={(event) => updateNewQuantity(event.target.value)}
                    />
                    <span className="input-suffix"><Scale size={16} aria-hidden="true" /> {t('meals.grams')}</span>
                  </div>
                </div>
                <button className="btn-add-food" type="button" onClick={addEditIngredient} disabled={!editFoodName.trim() || Number(editQuantity) <= 0}>
                  <Plus size={16} aria-hidden="true" /> {t('meals.addIngredient')}
                </button>
              </div>

              <section className="plate-foods" aria-label={t('meals.ingredientsAria')}>
                <div className="calc-header-row">
                  <span className="calc-label">{t('meals.ingredients')}</span>
                  <span className="plate-food-count">{editIngredients.length}</span>
                </div>
                {editIngredients.length === 0 ? (
                  <p className="calc-disclaimer">{t('meals.needIngredient')}</p>
                ) : (
                  <ul className="plate-food-list">
                    {editIngredients.map((ingredient, index) => (
                      <li className="plate-food-row" key={`${ingredient.name}-${index}`}>
                        <span>{ingredient.name}</span>
                        <label className="edit-ingredient-quantity">
                          <input
                            aria-label={t('meals.ingredientQuantity', { name: ingredient.name })}
                            type="number"
                            min="1"
                            value={ingredient.quantity_g || ''}
                            onFocus={() => rememberIngredientQuantityStart(index, ingredient.quantity_g)}
                            onChange={(event) => updateIngredientQuantity(index, event.target.value)}
                          />
                          <small>g</small>
                        </label>
                        <button type="button" onClick={() => setEditIngredients((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={t('hydration.removeAria', { label: ingredient.name })}>
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="calculation-preview-card">
                <div className="calc-header-row">
                  <span className="calc-label">{t('meals.total', { grams: Math.round(editNutrition.quantity) })}</span>
                  <span className="calc-cals-badge">{Math.round(editNutrition.calories)} kcal</span>
                </div>
                <div className="calc-macros-grid">
                  <div className="calc-macro-item"><span className="macro-name">{t('macro.protein')}</span><span className="macro-num">{editNutrition.protein.toFixed(1)}g</span></div>
                  <div className="calc-macro-item"><span className="macro-name">{t('macro.carbs')}</span><span className="macro-num">{editNutrition.carbs.toFixed(1)}g</span></div>
                  <div className="calc-macro-item"><span className="macro-name">{t('macro.fat')}</span><span className="macro-num">{editNutrition.fat.toFixed(1)}g</span></div>
                </div>
              </div>

              {editError && <div className="inline-alert" role="alert">{editError}</div>}
              <button className="primary-button" type="submit" disabled={isSavingEdit || editIngredients.length === 0 || editIngredients.some((ingredient) => ingredient.quantity_g <= 0)}>
                {isSavingEdit ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> {t('common.saving')}</> : t('common.saveChanges')}
              </button>
              <button className="text-action meal-delete-link" type="button" disabled={isSavingEdit} onClick={() => { setDeletingMeal(editingMeal); setEditingMeal(null); }}>
                <Trash2 size={16} aria-hidden="true" /> {t('meals.deleteMeal')}
              </button>
            </form>
          </div>
        </div>
      )}

      {isFavoritesOpen && (
        <FavoriteMealsModal
          favorites={favorites}
          isLoading={isLoadingFavorites}
          loadError={favoritesError}
          onClose={() => setIsFavoritesOpen(false)}
          onLog={logFavorite}
          onEdit={editFavorite}
          onDelete={removeFavorite}
        />
      )}

      {isSuggestionsOpen && (
        <MealRecommendationsModal
          onClose={() => setIsSuggestionsOpen(false)}
          // Suggestions are logged to today, so show today with the new meal.
          onAdded={() => setSelectedDate(new Date())}
          onPremiumRequired={() => navigate('/premium')}
        />
      )}

      {highQuantityWarning && (
        <div className="quantity-warning-backdrop">
          <div
            className="quantity-warning-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="quantity-warning-title"
            aria-describedby="quantity-warning-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                rollbackHighQuantity();
              }
            }}
          >
            <div className="quantity-warning-icon" aria-hidden="true">
              <AlertTriangle size={24} />
            </div>
            <h3 id="quantity-warning-title">{t('meals.quantityQuestion', { grams: highQuantityWarning.next.toLocaleString(locale()) })}</h3>
            <p id="quantity-warning-description">
              <strong>{highQuantityWarning.name}</strong>{' '}
              {t('meals.quantityWarning', { grams: highQuantityWarning.next.toLocaleString(locale()), max: MAX_REASONABLE_QUANTITY_G.toLocaleString(locale()) })}
            </p>
            <div className="quantity-warning-actions">
              <button type="button" className="quantity-warning-rollback" onClick={rollbackHighQuantity} autoFocus>
                {t('meals.rollback')}
              </button>
              <button type="button" className="quantity-warning-accept" onClick={acceptHighQuantity}>
                {t('tip.accept')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingMeal && (
        <div className="modal-backdrop">
          <div className="confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="delete-meal-title">
            <h2 id="delete-meal-title">{t('workouts.deleteQuestion', { name: deletingMeal.meal_name })}</h2>
            <p>{t('meals.deleteBody')}</p>
            {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
            <div className="modal-actions">
              <button className="secondary-action" type="button" onClick={() => { setDeletingMeal(null); setDeleteError(null) }} disabled={isDeletingMeal}>{t('common.cancel')}</button>
              <button className="danger-action" type="button" onClick={confirmDelete} disabled={isDeletingMeal}>
                {isDeletingMeal ? t('workouts.deleting') : t('meals.deleteMeal')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
