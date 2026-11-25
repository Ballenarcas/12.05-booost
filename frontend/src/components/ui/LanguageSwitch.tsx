import { LANGUAGES, setLanguage, useLanguage, useT } from '../../i18n'

/** English / Español segmented control; the choice applies at once and is remembered on this device. */
export default function LanguageSwitch() {
  const language = useLanguage()
  const t = useT()
  return (
    <div className="language-switch" role="group" aria-label={t('language.choose')}>
      {LANGUAGES.map((option) => (
        <button
          key={option.id}
          type="button"
          lang={option.id}
          aria-pressed={language === option.id}
          onClick={() => setLanguage(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
