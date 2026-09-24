import { t, type UiLanguage } from "../i18n"

interface UntrustedTextViewProps {
  readonly language: UiLanguage
  readonly text: string
  readonly match?: string
}

interface Segment {
  readonly text: string
  readonly matched: boolean
}

function segments(text: string, match: string): readonly Segment[] {
  if (!match) return [{ text, matched: false }]
  const source = text.toLocaleLowerCase()
  const needle = match.toLocaleLowerCase()
  const result: Segment[] = []
  let start = 0
  while (start < text.length) {
    const found = source.indexOf(needle, start)
    if (found < 0) {
      result.push({ text: text.slice(start), matched: false })
      break
    }
    if (found > start) result.push({ text: text.slice(start, found), matched: false })
    result.push({ text: text.slice(found, found + match.length), matched: true })
    start = found + match.length
  }
  return result
}

export function UntrustedTextView({ text, match = "", language }: UntrustedTextViewProps) {
  if (!text)
    return <p class="untrusted-text empty-text">{t(language, "No evidence text available.")}</p>
  return (
    <section class="untrusted-text" aria-label={t(language, "Evidence text")}>
      {segments(text, match).map((segment, index) =>
        segment.matched ? (
          <mark key={index}>{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </section>
  )
}
