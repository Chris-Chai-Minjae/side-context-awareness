import { TERM_MAX_TOKENS, TERM_MAX_UNIQUE, TERM_MIN_TOKEN_CHARS } from "../constants"

// Preserve the prototype's NFKC tokens and two-character substrings.
export function indexTerms(input: string): readonly string[] {
  const words = (
    input
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .filter((word) => word.length >= TERM_MIN_TOKEN_CHARS)
    .slice(0, TERM_MAX_TOKENS)
  const result = new Set<string>()
  for (const word of words) {
    if (result.size >= TERM_MAX_UNIQUE) break
    result.add(word)
    if (word.length <= TERM_MIN_TOKEN_CHARS) continue
    for (let index = 0; index + TERM_MIN_TOKEN_CHARS <= word.length; index++) {
      if (result.size >= TERM_MAX_UNIQUE) break
      result.add(word.slice(index, index + TERM_MIN_TOKEN_CHARS))
    }
  }
  return [...result]
}
