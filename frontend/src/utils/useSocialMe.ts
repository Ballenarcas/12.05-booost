import { useEffect, useState } from 'react'
import { fetchSocialMe, lastSocialMe } from '../services/api'
import type { SocialMe } from '../types/social'
import { describeError } from './errors.js'
import { t } from '../i18n'

/** The signed-in member. Shows the in-memory copy at once while a fresh one revalidates. */
export function useSocialMe() {
  const [me, setMe] = useState<SocialMe | null>(() => lastSocialMe())
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    fetchSocialMe()
      .then((value) => { if (current) setMe(value) })
      .catch((failure) => { if (current) setError(describeError(failure, t('community.error'))) })
    return () => { current = false }
  }, [])
  return [me, setMe, error] as const
}
