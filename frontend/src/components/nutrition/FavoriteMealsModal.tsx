import { useMemo, useState } from 'react';
import { ArrowLeft, Heart, Loader2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { FavoriteMeal } from '../../services/api';
import { locale, useT, valueLabel } from '../../i18n';

// The Meals page only lets you browse a week back, so logging further back would hide the meal.
const MAX_DAYS_BACK = 7;

function toInputDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

interface FavoriteMealsModalProps {
  favorites: FavoriteMeal[];
  isLoading: boolean;
  loadError: string | null;
  onClose: () => void;
  /** Logs the favorite at the given instant; resolves once saved. */
  onLog: (favorite: FavoriteMeal, consumedAt: Date | null) => Promise<void>;
  onEdit: (favorite: FavoriteMeal) => void;
  onDelete: (favorite: FavoriteMeal) => Promise<void>;
}

const rowStyle = { backgroundColor: 'var(--surface)', borderRadius: '16px', padding: '14px 16px', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: '12px' } as const;
const iconButton = { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '6px', display: 'flex' } as const;

export default function FavoriteMealsModal({ favorites, isLoading, loadError, onClose, onLog, onEdit, onDelete }: FavoriteMealsModalProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [logging, setLogging] = useState<FavoriteMeal | null>(null);
  const [day, setDay] = useState<'today' | 'past'>('today');
  const [pastDate, setPastDate] = useState(() => toInputDate(daysAgo(1)));
  const [pastTime, setPastTime] = useState('12:00');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Now" for validating a past time in render; confirmLog checks against the real clock again.
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return favorites.filter((favorite) => {
      const text = `${favorite.meal_type} ${favorite.name} ${favorite.ingredients.map((item) => item.name).join(' ')}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [favorites, query]);

  const startLogging = (favorite: FavoriteMeal) => {
    setLogging(favorite);
    setOpenedAt(Date.now());
    setDay('today');
    setPastDate(toInputDate(daysAgo(1)));
    setPastTime('12:00');
    setError(null);
  };

  const pastInstant = new Date(`${pastDate}T${pastTime || '12:00'}`);
  const pastIsValid = !Number.isNaN(pastInstant.getTime())
    && pastInstant.getTime() <= openedAt
    && pastDate >= toInputDate(daysAgo(MAX_DAYS_BACK));

  const confirmLog = async () => {
    if (!logging || (day === 'past' && (!pastIsValid || pastInstant.getTime() > Date.now()))) return;
    setBusyId(logging.id);
    setError(null);
    try {
      await onLog(logging, day === 'today' ? null : pastInstant);
      setLogging(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('fav.errorLog'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (favorite: FavoriteMeal) => {
    setBusyId(favorite.id);
    setError(null);
    try {
      await onDelete(favorite);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('fav.errorRemove'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busyId && onClose()}>
      <div className="modal-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="favorites-title">
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {logging && (
              <button type="button" style={{ ...iconButton, color: 'var(--text)', padding: 0 }} onClick={() => setLogging(null)} aria-label={t('fav.back')} disabled={!!busyId}>
                <ArrowLeft size={20} />
              </button>
            )}
            <div>
              <h2 id="favorites-title" className="modal-title">{logging ? t('fav.addToLog') : t('fav.title')}</h2>
              <p className="card-subtitle">
                {logging ? `${valueLabel(t, 'mealType', logging.meal_type)}: ${logging.name}` : t('fav.subtitle')}
              </p>
            </div>
          </div>
          <button type="button" className="btn-modal-close" onClick={onClose} aria-label={t('fav.close')} disabled={!!busyId}>
            <X size={20} />
          </button>
        </div>

        {logging ? (
          <div className="modal-form">
            <div role="radiogroup" aria-label={t('fav.whichDay')} style={{ display: 'flex', gap: '10px' }}>
              {(['today', 'past'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={day === option}
                  onClick={() => setDay(option)}
                  style={{
                    flex: 1, minHeight: '48px', borderRadius: '14px', cursor: 'pointer', fontSize: '14px', fontWeight: 700,
                    border: `1px solid ${day === option ? 'transparent' : 'var(--line)'}`,
                    color: day === option ? 'var(--hifi-on-selected)' : 'var(--text)',
                    backgroundColor: day === option ? 'var(--hifi-selected)' : 'var(--surface)',
                  }}
                >
                  {option === 'today' ? t('common.today') : t('fav.anotherDay')}
                </button>
              ))}
            </div>

            {day === 'past' && (
              <div className="inputs-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="favorite-day">{t('meals.day')}</label>
                  <input
                    id="favorite-day"
                    className="form-input"
                    type="date"
                    min={toInputDate(daysAgo(MAX_DAYS_BACK))}
                    max={toInputDate(new Date())}
                    value={pastDate}
                    onChange={(event) => setPastDate(event.target.value)}
                    style={{ colorScheme: 'dark' }}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="favorite-time">{t('fav.time')}</label>
                  <input
                    id="favorite-time"
                    className="form-input"
                    type="time"
                    value={pastTime}
                    onChange={(event) => setPastTime(event.target.value)}
                    style={{ colorScheme: 'dark' }}
                  />
                </div>
              </div>
            )}
            {day === 'past' && !pastIsValid && (
              <p className="calc-disclaimer" role="alert">{t('fav.pickMoment', { days: MAX_DAYS_BACK })}</p>
            )}

            <div className="calculation-preview-card">
              <div className="calc-header-row">
                <span className="calc-label">{t('meals.total', { grams: Math.round(logging.quantity_g) })}</span>
                <span className="calc-cals-badge">{logging.calories} kcal</span>
              </div>
              <div className="calc-macros-grid">
                <div className="calc-macro-item"><span className="macro-name">{t('macro.protein')}</span><span className="macro-num">{logging.proteins_g}g</span></div>
                <div className="calc-macro-item"><span className="macro-name">{t('macro.carbs')}</span><span className="macro-num">{logging.carbs_g}g</span></div>
                <div className="calc-macro-item"><span className="macro-name">{t('macro.fat')}</span><span className="macro-num">{logging.fats_g}g</span></div>
              </div>
            </div>

            {error && <div className="inline-alert" role="alert">{error}</div>}
            <button className="btn-modal-submit" type="button" onClick={confirmLog} disabled={!!busyId || (day === 'past' && !pastIsValid)}>
              {busyId ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> {t('fav.adding')}</> : t('fav.addToLogButton')}
            </button>
          </div>
        ) : (
          <div className="modal-form">
            <div className="form-group">
              <label className="form-label" htmlFor="favorite-search">{t('fav.search')}</label>
              <div className="input-with-icon">
                <input
                  id="favorite-search"
                  className="form-input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('fav.searchPlaceholder')}
                  autoComplete="off"
                />
                <Search size={16} className="input-spinner" aria-hidden="true" />
              </div>
            </div>

            {error && <div className="inline-alert" role="alert">{error}</div>}
            {loadError && <div className="inline-alert" role="alert">{loadError}</div>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {isLoading ? (
                <p className="calc-disclaimer" role="status">{t('fav.loading')}</p>
              ) : favorites.length === 0 ? (
                <p className="calc-disclaimer" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {t('fav.emptyBefore')} <Heart size={14} aria-label={t('fav.heart')} /> {t('fav.emptyAfter')}
                </p>
              ) : shown.length === 0 ? (
                <p className="calc-disclaimer">{t('fav.noMatch', { query: query.trim() })}</p>
              ) : (
                shown.map((favorite) => (
                  <div key={favorite.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)', overflowWrap: 'anywhere' }}>
                        {valueLabel(t, 'mealType', favorite.meal_type).toLocaleUpperCase(locale())}: {favorite.name.toLocaleUpperCase(locale())}
                      </div>
                      <div style={{ marginTop: '4px', color: 'var(--text-muted)', fontSize: '12.5px', display: 'flex', flexWrap: 'wrap', columnGap: '8px' }}>
                        {[`${favorite.calories} kcal`, t('fav.macroP', { g: favorite.proteins_g }), t('fav.macroC', { g: favorite.carbs_g }), t('fav.macroF', { g: favorite.fats_g })].map((part) => (
                          <span key={part} style={{ whiteSpace: 'nowrap' }}>{part}</span>
                        ))}
                      </div>
                    </div>
                    <button type="button" style={iconButton} onClick={() => onEdit(favorite)} disabled={!!busyId} aria-label={t('fav.editAria', { name: favorite.name })}>
                      <Pencil size={17} />
                    </button>
                    <button type="button" style={{ ...iconButton, color: 'var(--negative)' }} onClick={() => remove(favorite)} disabled={!!busyId} aria-label={t('meals.unfavorite', { name: favorite.name })}>
                      {busyId === favorite.id ? <Loader2 size={17} className="animate-spin" /> : <Trash2 size={17} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => startLogging(favorite)}
                      disabled={!!busyId}
                      aria-label={t('fav.addAria', { name: favorite.name })}
                      style={{ display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid var(--line)', borderRadius: '12px', color: 'var(--text)', backgroundColor: 'var(--surface-raised)', cursor: 'pointer', fontSize: '13px', fontWeight: 700, padding: '8px 12px' }}
                    >
                      <Plus size={15} aria-hidden="true" /> {t('hydration.add')}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
