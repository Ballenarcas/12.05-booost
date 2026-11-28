import { locale } from '../../i18n'
import { useCountUp } from '../../utils/useCountUp'

/** A whole number that counts up to its value when it appears or changes. */
export default function CountUp({ value }: { value: number }) {
  return <>{Math.round(useCountUp(value)).toLocaleString(locale())}</>
}
