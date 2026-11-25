import { useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, X } from 'lucide-react';
import {
  addMealRecommendation,
  dismissMealRecommendation,
  fetchMealRecommendations,
  PremiumRequiredError,
  refreshMealRecommendations,
} from '../../services/api';
import { locale, useT, valueLabel } from '../../i18n';
import type { MealRecommendation, MealRecommendations } from '../../services/api';


interface MealRecommendationsModalProps {
  onClose: () => void;
  /** Called after a suggestion was logged to today. */
  onAdded: () => void;
  /** Called when the server says the user needs Premium. */
  onPremiumRequired: () => void;
}

// Same threshold as the server (GOAL_REACHED_KCAL in meal_recommendation_service.py).
const GOAL_REACHED_KCAL = 150;

const iconButton ={ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '6px', display: 'flex' } as const;
const cardStyle = { backgroundColor: 'var(--surface)', borderRadius: '16px', padding: '14px 16px', border: '1px solid var(--line)' } as const;

export default function MealRecommendationsModal({ onClose, onAdded, onPremiumRequired }: MealRecommendationsModalProps) {
  const t = useT();
  const [data, setData] = useState<MealRecommendations | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = (err: unknown, fallback: string) => {
    if (err instanceof PremiumRequiredError) onPremiumRequired();
    else setError(err instanceof Error ? err.message : fallback);
  };

  useEffect(() => {
    let current = true;
    fetchMealRecommendations()
      .then((result) => { if (current) setData(result); })
      .catch((err: unknown) => { if (current) handle(err, t('rec.errorLoad')); })
      .finally(() => { if (current) setIsLoading(false); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once when the modal opens
  }, []);

  const removeItem = (id: string) =>
    setData((current) => current && { ...current, items: current.items.filter((item) => item.id !== id) });

  const add = async (item: MealRecommendation) => {
    setBusy(item.id);
    setError(null);
    try {
      await addMealRecommendation(item.id);
      // Update what's left right away, the same way the server computes it (never below zero).
      setData((current) => {
        if (!current) return current;
        const left = (value: number, eaten: number) => Math.max(0, Math.round((value - eaten) * 10) / 10);
        const remainingCalories = Math.max(0, current.remaining_calories - item.calories);
        return {
          ...current,
          remaining_calories: remainingCalories,
          remaining_proteins_g: left(current.remaining_proteins_g, item.proteins_g),
          remaining_carbs_g: left(current.remaining_carbs_g, item.carbs_g),
          remaining_fats_g: left(current.remaining_fats_g, item.fats_g),
          goal_reached: remainingCalories < GOAL_REACHED_KCAL,
          items: current.items.filter((other) => other.id !== item.id),
        };
      });
      onAdded();
    } catch (err) {
      handle(err, t('rec.errorAdd'));
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (item: MealRecommendation) => {
    setBusy(item.id);
    setError(null);
    try {
      await dismissMealRecommendation(item.id);
      removeItem(item.id);
    } catch (err) {
      handle(err, t('rec.errorHide'));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    setError(null);
    try {
      setData(await refreshMealRecommendations());
    } catch (err) {
      handle(err, t('rec.errorRefresh'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="suggestions-title">
        <div className="modal-header">
          <div>
            <h2 id="suggestions-title" className="modal-title">{t('meals.suggested')}</h2>
            <p className="card-subtitle">{t('rec.subtitle')}</p>
          </div>
          <button type="button" className="btn-modal-close" onClick={onClose} aria-label={t('rec.close')} disabled={!!busy}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-form">
          {isLoading ? (
            <p className="calc-disclaimer" role="status" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" /> {t('rec.finding')}
            </p>
          ) : data && (
            <>
              <div className="calculation-preview-card">
                <div className="calc-header-row">
                  <span className="calc-label">{t('rec.leftToday')}</span>
                  <span className="calc-cals-badge">{data.remaining_calories} kcal</span>
                </div>
                <div className="calc-macros-grid">
                  <div className="calc-macro-item"><span className="macro-name">{t('macro.protein')}</span><span className="macro-num">{data.remaining_proteins_g}g</span></div>
                  <div className="calc-macro-item"><span className="macro-name">{t('macro.carbs')}</span><span className="macro-num">{data.remaining_carbs_g}g</span></div>
                  <div className="calc-macro-item"><span className="macro-name">{t('macro.fat')}</span><span className="macro-num">{data.remaining_fats_g}g</span></div>
                </div>
              </div>

              {data.goal_reached ? (
                <p className="calc-disclaimer">{t('rec.goalReached')}</p>
              ) : data.items.length === 0 ? (
                <p className="calc-disclaimer">{t('rec.noneLeft')}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {data.items.map((item) => (
                    <div key={item.id} style={cardStyle}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)', overflowWrap: 'anywhere' }}>
                            {valueLabel(t, 'mealType', item.meal_type).toLocaleUpperCase(locale())}: {item.name.toLocaleUpperCase(locale())}
                          </div>
                          <div style={{ marginTop: '4px', color: 'var(--text-muted)', fontSize: '12.5px', display: 'flex', flexWrap: 'wrap', columnGap: '8px' }}>
                            {[`${item.calories} kcal`, t('fav.macroP', { g: item.proteins_g }), t('fav.macroC', { g: item.carbs_g }), t('fav.macroF', { g: item.fats_g })].map((part) => (
                              <span key={part} style={{ whiteSpace: 'nowrap' }}>{part}</span>
                            ))}
                          </div>
                        </div>
                        <button type="button" style={iconButton} onClick={() => dismiss(item)} disabled={!!busy} aria-label={t('rec.hideAria', { name: item.name })}>
                          <X size={17} />
                        </button>
                      </div>
                      {item.reason && (
                        <p style={{ margin: '8px 0 0', color: 'var(--text)', fontSize: '13px', lineHeight: 1.4 }}>{item.reason}</p>
                      )}
                      <button
                        type="button"
                        onClick={() => add(item)}
                        disabled={!!busy}
                        aria-label={t('rec.addAria', { name: item.name })}
                        style={{ marginTop: '10px', width: '100%', minHeight: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', border: '1px solid var(--line)', borderRadius: '12px', color: 'var(--text)', backgroundColor: 'var(--surface-raised)', cursor: 'pointer', fontSize: '13.5px', fontWeight: 700 }}
                      >
                        {busy === item.id ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
                        {t('rec.addToday')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {error && <div className="inline-alert" role="alert">{error}</div>}

          {data && !data.goal_reached && (
            <button
              type="button"
              onClick={refresh}
              disabled={!!busy || data.refreshes_left <= 0}
              style={{ width: '100%', minHeight: '46px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: '1px solid var(--line)', borderRadius: '14px', color: data.refreshes_left > 0 ? 'var(--text)' : 'var(--text-faint)', backgroundColor: 'var(--surface)', cursor: data.refreshes_left > 0 ? 'pointer' : 'not-allowed', fontSize: '14px', fontWeight: 700 }}
            >
              {busy === 'refresh' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
              {data.refreshes_left > 0 ? t('rec.refresh', { count: data.refreshes_left }) : t('rec.noRefresh')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
