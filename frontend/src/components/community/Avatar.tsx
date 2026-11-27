import { useCallback, useState } from 'react'
import { mediaUrl } from '../../services/api'

type Props = { name: string; url: string | null | undefined; large?: boolean; priority?: boolean }

function AvatarImage({ src, size, priority }: { src: string; size: number; priority: boolean }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  const checkCached = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true)
  }, [])

  if (failed) return null
  return (
    <img
      ref={checkCached}
      className={`cm-avatar-img${loaded ? ' is-loaded' : ''}`}
      src={src}
      alt=""
      width={size}
      height={size}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  )
}

/** A member's photo layered over their initials, so slow networks never flash an empty hole. */
export default function Avatar({ name, url, large = false, priority = false }: Props) {
  const initials = name.split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase()
  const className = large ? 'cm-avatar is-large' : 'cm-avatar'
  const size = large ? 104 : 40
  const src = url ? mediaUrl(url) : null

  return (
    <span className={className} aria-hidden="true">
      <span className="cm-avatar-initials">{initials || '?'}</span>
      {src && <AvatarImage key={src} src={src} size={size} priority={priority} />}
    </span>
  )
}
