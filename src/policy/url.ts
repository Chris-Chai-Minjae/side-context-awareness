export function normalizePageUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}
