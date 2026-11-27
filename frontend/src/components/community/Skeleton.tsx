import { useT } from '../../i18n'

/** The shape of a post while it loads, so the screen never sits on a bare "Loading…". */
export function PostSkeleton({ count = 2 }: { count?: number }) {
  const t = useT()
  return (
    <div className="cm-skeletons" role="status" aria-busy="true">
      <span className="visually-hidden">{t('common.loading')}</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="hifi-card cm-skeleton-post" aria-hidden="true">
          <div className="cm-skeleton-row">
            <span className="cm-skeleton cm-skeleton-avatar" />
            <span className="cm-skeleton-lines">
              <span className="cm-skeleton" style={{ width: '45%' }} />
              <span className="cm-skeleton" style={{ width: '30%' }} />
            </span>
          </div>
          <span className="cm-skeleton" style={{ width: '90%' }} />
          <span className="cm-skeleton" style={{ width: '65%' }} />
        </div>
      ))}
    </div>
  )
}

/** The shape of a list of people or comments while it loads. */
export function RowSkeleton({ count = 3 }: { count?: number }) {
  const t = useT()
  return (
    <div className="cm-skeletons" role="status" aria-busy="true">
      <span className="visually-hidden">{t('common.loading')}</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="cm-skeleton-row" aria-hidden="true">
          <span className="cm-skeleton cm-skeleton-avatar" />
          <span className="cm-skeleton-lines">
            <span className="cm-skeleton" style={{ width: `${55 - index * 8}%` }} />
            <span className="cm-skeleton" style={{ width: '35%' }} />
          </span>
        </div>
      ))}
    </div>
  )
}

/** A member's profile header while it loads. */
export function ProfileSkeleton() {
  const t = useT()
  return (
    <div className="cm-skeletons" role="status" aria-busy="true">
      <span className="visually-hidden">{t('common.loading')}</span>
      <div className="hifi-card cm-profile" aria-hidden="true">
        <span className="cm-skeleton cm-skeleton-avatar is-large" />
        <span className="cm-skeleton" style={{ width: '40%', height: 20 }} />
        <span className="cm-skeleton" style={{ width: '28%' }} />
        <span className="cm-skeleton" style={{ width: '55%' }} />
      </div>
    </div>
  )
}
