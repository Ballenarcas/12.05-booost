import { mediaUrl } from '../../services/api'

type Props = { name: string; url: string | null | undefined; large?: boolean }

/** A member's photo, or their initials. Decorative: the name is always written next to it. */
export default function Avatar({ name, url, large = false }: Props) {
  const initials = name.split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase()
  const className = large ? 'cm-avatar is-large' : 'cm-avatar'
  return url
    ? <img className={className} src={mediaUrl(url)} alt="" />
    : <span className={className} aria-hidden="true">{initials || '?'}</span>
}
