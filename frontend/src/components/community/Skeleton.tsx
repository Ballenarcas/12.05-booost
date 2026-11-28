import { useT } from '../../i18n'

/** The shape of Twitter timeline posts while they load, so the screen never sits on a bare "Loading…". */
export function PostSkeleton({ count = 3 }: { count?: number }) {
  const t = useT()
  return (
    <div className="cm-skeletons" role="status" aria-busy="true">
      <span className="visually-hidden">{t('common.loading')}</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="cm-skeleton-post" aria-hidden="true">
          <span className="cm-skeleton cm-skeleton-avatar" />
          <div className="cm-skeleton-post-body">
            <span className="cm-skeleton" style={{ width: '48%' }} />
            <span className="cm-skeleton" style={{ width: '92%' }} />
            <span className="cm-skeleton" style={{ width: '68%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** The shape of a list of people or replies while it loads. */
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

/** A member's Twitter-style profile header while it loads. */
export function ProfileSkeleton() {
  const t = useT()
  return (
    <div className="cm-skeletons cm-profile-hero" role="status" aria-busy="true">
      <span className="visually-hidden">{t('common.loading')}</span>
      <div className="cm-skeleton cm-skeleton-banner" aria-hidden="true" />
      <div className="cm-profile-top" aria-hidden="true">
        <span className="cm-profile-avatar-ring">
          <span className="cm-skeleton" style={{ width: 76, height: 76, borderRadius: '50%' }} />
        </span>
      </div>
      <div className="cm-profile-meta" aria-hidden="true">
        <span className="cm-skeleton" style={{ width: '42%', height: 18 }} />
        <span className="cm-skeleton" style={{ width: '28%', marginTop: 4 }} />
        <span className="cm-skeleton" style={{ width: '54%', marginTop: 10 }} />
      </div>
    </div>
  )
}
