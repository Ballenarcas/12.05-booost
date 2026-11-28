export type TextPart = { text: string; mention?: string }

// "@name" standing on its own: not inside an e-mail or a longer word, and 3 to 20 characters.
const MENTION = /(?<![\p{L}\p{N}_@])@([A-Za-z0-9_]{3,20})(?![\p{L}\p{N}_])/gu

/** Splits post text so mentions can be links. The text is only ever rendered as text. */
export function splitMentions(text: string): TextPart[] {
  const parts: TextPart[] = []
  let end = 0
  for (const match of text.matchAll(MENTION)) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index) })
    parts.push({ text: match[0], mention: match[1].toLowerCase() })
    end = match.index + match[0].length
  }
  if (end < text.length) parts.push({ text: text.slice(end) })
  return parts
}
