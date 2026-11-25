import { useState, type CSSProperties } from 'react'

export interface BreakdownItem {
  id: string
  label: string
  valueText: string
  exactText: string
  share: number
}

interface StatsBreakdownProps {
  totalValue: string
  totalUnit: string
  totalExact: string
  totalLabel?: string
  items: BreakdownItem[]
  emptyMessage: string
  note?: string
  ariaLabel: string
}

const RADIUS = 67
const STROKE = 5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const RING_SHADES = ['#527fb2', '#709ecc', '#8dcfe8', '#9eb4cc', '#b8c8db', '#d2dce8']

export default function StatsBreakdown({
  totalValue,
  totalUnit,
  totalExact,
  totalLabel = 'CLASSIFIED',
  items,
  emptyMessage,
  note,
  ariaLabel,
}: StatsBreakdownProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const positiveItems = items.filter((item) => item.share > 0)
  const totalShare = positiveItems.reduce((sum, item) => sum + item.share, 0)

  const lengths = positiveItems.map((item) => (totalShare > 0 ? item.share / totalShare : 0) * CIRCUMFERENCE)
  const segments = positiveItems.map((item, index) => ({
    ...item,
    color: RING_SHADES[index % RING_SHADES.length],
    length: lengths[index],
    // Each segment starts where the previous ones end.
    dashOffset: -lengths.slice(0, index).reduce((sum, length) => sum + length, 0),
  }))

  const selectedItem = items.find((item) => item.id === selectedId) ?? null
  const centerValue = selectedItem ? `${Math.round(selectedItem.share)}` : totalValue
  const centerUnit = selectedItem ? '%' : totalUnit
  const centerSubtitle = selectedItem ? selectedItem.label : totalLabel
  const centerAria = selectedItem
    ? `${selectedItem.label}: ${selectedItem.exactText}, ${Math.round(selectedItem.share)}%`
    : `${totalExact} ${totalLabel.toLowerCase()}`

  function toggleItem(id: string) {
    setSelectedId((current) => (current === id ? null : id))
  }

  return (
    <div className="stats-breakdown" data-selected={selectedItem !== null || undefined}>
      <div className="stats-classified-wrap">
        <button
          type="button"
          className="stats-classified-disc"
          onClick={() => setSelectedId(null)}
          aria-label={centerAria}
        >
          <svg className="stats-classified-ring" viewBox="0 0 144 144" aria-hidden="true">
            <circle className="stats-classified-track" cx="72" cy="72" r={RADIUS} fill="none" strokeWidth={STROKE} />
            {segments.map((segment) => (
              <circle
                key={segment.id}
                className="stats-classified-segment"
                data-selected={selectedId === segment.id || undefined}
                cx="72"
                cy="72"
                r={RADIUS}
                fill="none"
                stroke={segment.color}
                strokeWidth={selectedId === segment.id ? STROKE + 2.5 : STROKE}
                strokeDasharray={`${Math.max(0, segment.length - (segments.length > 1 ? 3 : 0))} ${CIRCUMFERENCE}`}
                strokeDashoffset={segment.dashOffset}
                transform="rotate(-90 72 72)"
              />
            ))}
          </svg>
          <span className="stats-classified-center" aria-hidden="true">
            <strong className="stats-classified-value">
              {centerValue}<small>{centerUnit}</small>
            </strong>
            <span className="stats-classified-label">{centerSubtitle}</span>
          </span>
        </button>
      </div>

      {items.length === 0 ? (
        <p className="stats-breakdown-empty" role="status">
          {emptyMessage}
        </p>
      ) : (
        <ul className="stats-breakdown-grid" aria-label={ariaLabel}>
          {items.map((item, index) => {
            const isSelected = selectedId === item.id
            const widthPct = item.share > 0 ? Math.max(5, Math.min(100, item.share)) : 0
            return (
              <li key={item.id} style={{ '--row': index } as CSSProperties}>
                <button
                  type="button"
                  className="stats-breakdown-item"
                  aria-pressed={isSelected}
                  aria-label={`${item.label}: ${item.exactText}, ${Math.round(item.share)}%`}
                  onClick={() => toggleItem(item.id)}
                >
                  <span className="stats-breakdown-top">
                    <span className="stats-breakdown-name">{item.label}</span>
                    <span className="stats-breakdown-val">{item.valueText}</span>
                  </span>
                  <span className="stats-breakdown-track" aria-hidden="true">
                    {widthPct > 0 && (
                      <span className="stats-breakdown-fill" style={{ width: `${widthPct}%` }} />
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {note && <p className="stats-classification-note">{note}</p>}
    </div>
  )
}
