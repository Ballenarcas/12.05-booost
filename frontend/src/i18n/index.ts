import { useMemo, useSyncExternalStore } from 'react'
import { en, type MessageKey } from './en.ts'
import { es } from './es.ts'

export type Language = 'en' | 'es'
export type { MessageKey }
export type TranslationVars = Record<string, string | number>
export type Translate = (key: MessageKey, vars?: TranslationVars) => string

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
]

const KEY = 'booost-language'
const dictionaries: Record<Language, Record<MessageKey, string>> = { en, es }
const listeners = new Set<() => void>()

function detectLanguage(): Language {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'en' || saved === 'es') return saved
  } catch { /* private mode: fall back to the browser language */ }
  // Only in a browser: Node (unit tests) also has navigator.language, which would make tests depend on the machine.
  return typeof window !== 'undefined' && navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en'
}

let current: Language = detectLanguage()
if (typeof document !== 'undefined') document.documentElement.lang = current

export function getLanguage(): Language {
  return current
}

/** Switches the whole app; screens using useT() re-render, and onLanguageChange listeners run. */
export function setLanguage(language: Language): void {
  if (language === current) return
  current = language
  try { localStorage.setItem(KEY, language) } catch { /* private mode: lasts this visit only */ }
  document.documentElement.lang = language
  listeners.forEach((listener) => listener())
}

export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function translate(language: Language, key: MessageKey, vars?: TranslationVars): string {
  const text = dictionaries[language][key] ?? en[key] ?? key
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : text
}

/** Translation in the current language, for code outside components (services, helpers). */
export const t: Translate = (key, vars) => translate(current, key, vars)

/** Label for a value the app stores in English (a goal, a meal type…): its translation, or the value itself when it has none. */
export function valueLabel(translateFn: Translate, group: string, value: string): string {
  const key = `${group}.${value}`
  return key in en ? translateFn(key as MessageKey) : value
}

/** BCP 47 locale for dates and numbers in the current language. */
export function locale(language: Language = current): string {
  return language === 'es' ? 'es-ES' : 'en-US'
}

/** The current language; the component re-renders when it changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(onLanguageChange, getLanguage, getLanguage)
}

/** A translate function for components. Its identity changes with the language, so memos that use it update. */
export function useT(): Translate {
  const language = useLanguage()
  return useMemo<Translate>(() => (key, vars) => translate(language, key, vars), [language])
}
