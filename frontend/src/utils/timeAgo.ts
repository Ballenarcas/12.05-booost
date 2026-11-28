import { locale, t } from '../i18n'

/** Short post age, as timelines show it: "now", "5 min", "4 h", "3 d", then the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return t('community.justNow')
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} d`
  return new Date(iso).toLocaleDateString(locale(), { month: 'short', day: 'numeric' })
}
