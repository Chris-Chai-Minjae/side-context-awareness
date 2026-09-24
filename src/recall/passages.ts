import { SNIPPET_CHARS } from "../constants"

type Span = { readonly start: number; readonly end: number }

function matches(text: string, terms: readonly string[]): readonly number[] {
  const found: number[] = []
  for (const term of terms) {
    let index = text.indexOf(term)
    while (index !== -1) {
      found.push(index)
      index = text.indexOf(term, index + 1)
    }
  }
  return found.sort((left, right) => left - right)
}

function boundedSpan(textLength: number, segment: Span, matchAt: number): Span {
  if (segment.end - segment.start <= SNIPPET_CHARS) return segment
  const half = Math.floor(SNIPPET_CHARS / 2)
  const start = Math.max(segment.start, Math.min(matchAt - half, segment.end - SNIPPET_CHARS))
  return { start, end: Math.min(textLength, start + SNIPPET_CHARS) }
}

export function selectPassages(text: string, terms: readonly string[]): readonly string[] {
  const normalized = text.normalize("NFKC")
  const haystack = normalized.toLowerCase()
  const needles = [...new Set(terms.map((term) => term.normalize("NFKC").toLowerCase()))].filter(
    (term) => term.length > 0,
  )
  if (needles.length === 0) return []

  const positions = matches(haystack, needles)
  if (positions.length === 0) return []
  const segments = [...normalized.matchAll(/[^.!?。！？\n]+[.!?。！？]?/gu)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  const windows: Span[] = []
  let segmentIndex = 0
  for (const position of positions) {
    while (true) {
      const current = segments[segmentIndex]
      if (!current || current.end > position) break
      segmentIndex++
    }
    const segment = segments[segmentIndex]
    if (!segment || position < segment.start) continue
    const next = boundedSpan(normalized.length, segment, position)
    const previous = windows.at(-1)
    if (previous && next.end - previous.start <= SNIPPET_CHARS) {
      windows[windows.length - 1] = { start: previous.start, end: Math.max(previous.end, next.end) }
    } else if (!previous || next.start !== previous.start || next.end !== previous.end) {
      windows.push(next)
    }
  }
  return windows.map((window) => normalized.slice(window.start, window.end).trim()).filter(Boolean)
}
