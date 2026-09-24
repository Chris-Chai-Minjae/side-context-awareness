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

export function isDeniedHost(hostname: string, deniedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  return deniedHosts.some((entry) => {
    const denied = entry.trim().toLowerCase()
    return denied.length > 0 && (host === denied || host.endsWith(`.${denied}`))
  })
}

export function isDeniedApp(bundleId: string, deniedApps: readonly string[]): boolean {
  return deniedApps.includes(bundleId)
}

type CapturePolicy = {
  readonly enabled: boolean
  readonly pausedUntil: number | "indefinite" | null
  readonly deniedApps: readonly string[]
  readonly deniedWebsites: readonly string[]
}

export function shouldCapture(
  policy: CapturePolicy,
  bundleId: string,
  url: string | null,
  now: number,
): boolean {
  if (!policy.enabled || policy.pausedUntil === "indefinite") return false
  if (typeof policy.pausedUntil === "number" && now < policy.pausedUntil) return false
  if (isDeniedApp(bundleId, policy.deniedApps)) return false
  if (url && isDeniedHost(new URL(url).hostname, policy.deniedWebsites)) return false
  return true
}
