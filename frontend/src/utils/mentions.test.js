import assert from 'node:assert/strict'
import test from 'node:test'
import { splitMentions } from './mentions.ts'

test('splits mentions and keeps punctuation as text', () => {
  assert.deepEqual(splitMentions('hi @ana_9, and @Bob_1!'), [
    { text: 'hi ' },
    { text: '@ana_9', mention: 'ana_9' },
    { text: ', and ' },
    { text: '@Bob_1', mention: 'bob_1' },
    { text: '!' },
  ])
})

test('markup, short names, long names and emails stay plain text', () => {
  for (const text of [
    '<script>alert(1)</script>',
    'javascript:alert(1)',
    '@ab',
    '@aaaaaaaaaaaaaaaaaaaaa',
    'email@host.com',
    '@josé',
  ]) {
    assert.deepEqual(splitMentions(text), [{ text }])
  }
})
