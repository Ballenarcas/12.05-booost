import { useMemo, useState } from 'react';
import { ArrowLeft, Heart, Loader2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { FavoriteMeal } from '../../services/api';

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

const rowStyle = { backgroundColor: '#1c1c1e', borderRadius: '16px', padding: '14px 16px', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: '12px' } as const;
const iconButton = { background: 'none', border: 'none', color: '#8e8e93', cursor: 'pointer', padding: '6px', display: 'flex' } as const;

export default function FavoriteMealsModal({ favorites, isLoading, loadError, onClose, onLog, onEdit, onDelete }: FavoriteMealsModalProps) {
  const [query, setQuery] = useState('');
  const [logging, setLogging] = useState<FavoriteMeal | null>(null);
  const [day, setDay] = useState<'today' | 'past'>('today');
  const [pastDate, setPastDate] = useState(() => toInputDate(daysAgo(1)));
  const [pastTime, setPastTime] = useState('12:00');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return favorites.filter((favorite) => {
      const text = `${favorite.meal_type} ${favorite.name} ${favorite.ingredients.map((item) => item.name).join(' ')}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [favorites, query]);

  const startLogging = (favorite: FavoriteMeal) => {
    setLogging(favorite);
    setDay('today');
    setPastDate(toInputDate(daysAgo(1)));
    setPastTime('12:00');
    setError(null);
  };

  const pastInstant = new Date(`${pastDate}T${pastTime || '12:00'}`);
  const pastIsValid = !Number.isNaN(pastInstant.getTime())
    && pastInstant.getTime() <= Date.now()
    && pastDate >= toInputDate(daysAgo(MAX_DAYS_BACK));

  const confirmLog = async () => {
    if (!logging || (day === 'past' && !pastIsValid)) return;
    setBusyId(logging.id);
    setError(null);
    try {
      await onLog(logging, day === 'today' ? null : pastInstant);
      setLogging(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't log this meal.");
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
      setError(err instanceof Error ? err.message : "We couldn't remove this favorite.");
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
              <button type="button" style={{ ...iconButton, color: '#f3f3f5', padding: 0 }} onClick={() => setLogging(null)} aria-label="Back to favorites" disabled={!!busyId}>
                <ArrowLeft size={20} />
              </button>
            )}
            <div>
              <h2 id="favorites-title" className="modal-title">{logging ? 'Add to your log' : 'Favorite meals'}</h2>
              <p className="card-subtitle">
                {logging ? `${logging.meal_type}: ${logging.name}` : 'Log a meal you eat often in one tap.'}
              </p>
            </div>
          </div>
          <button type="button" className="btn-modal-close" onClick={onClose} aria-label="Close favorites" disabled={!!busyId}>
            <X size={20} />
          </button>
        </div>

        {logging ? (
          <div className="modal-form">
            <div role="radiogroup" aria-label="Which day" style={{ display: 'flex', gap: '10px' }}>
              {(['today', 'past'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={day === option}
                  onClick={() => setDay(option)}
                  style={{
                    flex: 1, minHeight: '48px', borderRadius: '14px', cursor: 'pointer', fontSize: '14px', fontWeight: 700,
                    border: `1px solid ${day === option ? '#f3f3f5' : '#333'}`,
                    color: day === option ? '#121212' : '#f3f3f5',
                    backgroundColor: day === option ? '#f3f3f5' : '#1c1c1e',
                  }}
                >
                  {option === 'today' ? 'Today' : 'Another day'}
                </button>
              ))}
            </div>

            {day === 'past' && (
              <div className="inputs-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="favorite-day">Day</label>
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
                  <label className="form-label" htmlFor="favorite-time">Time</label>
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
              <p className="calc-disclaimer" role="alert">Pick a moment in the last {MAX_DAYS_BACK} days, not in the future.</p>
            )}

            <div className="calculation-preview-card">
              <div className="calc-header-row">
                <span className="calc-label">Meal total · {Math.round(logging.quantity_g)}g</span>
                <span className="calc-cals-badge">{logging.calories} kcal</span>
              </div>
              <div className="calc-macros-grid">
                <div className="calc-macro-item"><span className="macro-name">Protein</span><span className="macro-num">{logging.proteins_g}g</span></div>
                <div className="calc-macro-item"><span className="macro-name">Carbs</span><span className="macro-num">{logging.carbs_g}g</span></div>
                <div className="calc-macro-item"><span className="macro-name">Fat</span><span className="macro-num">{logging.fats_g}g</span></div>
              </div>
            </div>

            {error && <div className="inline-alert" role="alert">{error}</div>}
            <button className="btn-modal-submit" type="button" onClick={confirmLog} disabled={!!busyId || (day === 'past' && !pastIsValid)}>
              {busyId ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> Adding...</> : 'Add to log'}
            </button>
          </div>
        ) : (
          <div className="modal-form">
            <div className="form-group">
              <label className="form-label" htmlFor="favorite-search">Search</label>
              <div className="input-with-icon">
                <input
                  id="favorite-search"
                  className="form-input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Meal, type or ingredient..."
                  autoComplete="off"
                />
                <Search size={16} className="input-spinner" aria-hidden="true" />
              </div>
            </div>

            {error && <div className="inline-alert" role="alert">{error}</div>}
            {loadError && <div className="inline-alert" role="alert">{loadError}</div>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {isLoading ? (
                <p className="calc-disclaimer" role="status">Loading your favorites...</p>
              ) : favorites.length === 0 ? (
                <p className="calc-disclaimer" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  Tap the <Heart size={14} aria-label="heart" /> on a meal to save it here.
                </p>
              ) : shown.length === 0 ? (
                <p className="calc-disclaimer">No favorites match “{query.trim()}”.</p>
              ) : (
                shown.map((favorite) => (
                  <div key={favorite.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: '#ffffff', overflowWrap: 'anywhere' }}>
                        {favorite.meal_type.toUpperCase()}: {favorite.name.toUpperCase()}
                      </div>
                      <div style={{ marginTop: '4px', color: '#8e8e93', fontSize: '12.5px', display: 'flex', flexWrap: 'wrap', columnGap: '8px' }}>
                        {[`${favorite.calories} kcal`, `P ${favorite.proteins_g}g`, `C ${favorite.carbs_g}g`, `F ${favorite.fats_g}g`].map((part) => (
                          <span key={part} style={{ whiteSpace: 'nowrap' }}>{part}</span>
                        ))}
                      </div>
                    </div>
                    <button type="button" style={iconButton} onClick={() => onEdit(favorite)} disabled={!!busyId} aria-label={`Edit ${favorite.name}`}>
                      <Pencil size={17} />
                    </button>
                    <button type="button" style={{ ...iconButton, color: '#ff4d4d' }} onClick={() => remove(favorite)} disabled={!!busyId} aria-label={`Remove ${favorite.name} from favorites`}>
                      {busyId === favorite.id ? <Loader2 size={17} className="animate-spin" /> : <Trash2 size={17} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => startLogging(favorite)}
                      disabled={!!busyId}
                      aria-label={`Add ${favorite.name} to your log`}
                      style={{ display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid #333', borderRadius: '12px', color: '#f3f3f5', backgroundColor: '#262628', cursor: 'pointer', fontSize: '13px', fontWeight: 700, padding: '8px 12px' }}
                    >
                      <Plus size={15} aria-hidden="true" /> Add
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
