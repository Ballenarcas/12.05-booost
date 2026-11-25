import assert from 'node:assert/strict'
import test from 'node:test'
import { en } from './en.ts'
import { es } from './es.ts'
import { locale, translate } from './index.ts'

function placeholders(text) {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort()
}

test('English and Spanish dictionaries have the exact same keys', () => {
  const enKeys = Object.keys(en).sort()
  const esKeys = Object.keys(es).sort()
  assert.deepEqual(esKeys, enKeys)
})

test('every dictionary entry is non-empty and keeps matching placeholders', () => {
  for (const key of Object.keys(en)) {
    const enValue = en[key]
    const esValue = es[key]
    assert.equal(typeof enValue, 'string', `en[${key}] must be a string`)
    assert.equal(typeof esValue, 'string', `es[${key}] must be a string`)
    assert.ok(enValue.trim().length > 0, `en[${key}] must not be empty`)
    assert.ok(esValue.trim().length > 0, `es[${key}] must not be empty`)
    assert.deepEqual(
      placeholders(esValue),
      placeholders(enValue),
      `placeholders differ for key "${key}"`,
    )
  }
})

test('translate interpolates placeholders and locale maps each language', () => {
  assert.equal(translate('en', 'common.save'), 'Save')
  assert.equal(translate('es', 'common.save'), 'Guardar')
  assert.equal(locale('en'), 'en-US')
  assert.equal(locale('es'), 'es-ES')
})
