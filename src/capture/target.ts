import {
  TAB_STALE_AFTER_MS,
  TRACKED_TARGET_LIMIT,
  type TRIGGER_STRENGTH,
  TYPED_FIELD_CACHE_MS,
} from "../constants"

export type TargetIdentity = {
  readonly bundleId: string
  readonly windowId: number | null
  readonly normalizedUrl: string | null
}

export type Trigger = keyof typeof TRIGGER_STRENGTH

export type PendingCapture = {
  readonly trigger: Trigger
  readonly deadline: number
}

// A tracked target is intentionally mutable scheduler state.
export type CaptureTarget = TargetIdentity & {
  readonly key: string
  currentUrl: string | null
  lastUrl: string | null
  lastCaptureAt: number | null
  lastSeenAt: number
  pending: PendingCapture | null
  lastInputAt: number | null
  pointerConfirmedUntil: number | null
  audibleConfirmedUntil: number | null
  readonly typedFieldCache: Map<string, { readonly value: string; readonly updatedAt: number }>
}

export function targetKey(identity: TargetIdentity): string {
  return `${identity.bundleId}|${identity.windowId ?? "-"}|${identity.normalizedUrl ?? "-"}`
}

export function rememberTypedField(
  target: CaptureTarget,
  fieldKey: string,
  value: string,
  now: number,
): void {
  for (const [key, cached] of target.typedFieldCache) {
    if (now - cached.updatedAt >= TYPED_FIELD_CACHE_MS) target.typedFieldCache.delete(key)
  }
  target.typedFieldCache.set(fieldKey, { value, updatedAt: now })
}

export function readTypedField(
  target: CaptureTarget,
  fieldKey: string,
  now: number,
): string | null {
  const cached = target.typedFieldCache.get(fieldKey)
  if (!cached) return null
  if (now - cached.updatedAt < TYPED_FIELD_CACHE_MS) return cached.value
  target.typedFieldCache.delete(fieldKey)
  return null
}

export class TargetStore {
  private readonly targets = new Map<string, CaptureTarget>()

  get(key: string): CaptureTarget | undefined {
    return this.targets.get(key)
  }

  values(): IterableIterator<CaptureTarget> {
    return this.targets.values()
  }

  pruneStale(now: number): readonly CaptureTarget[] {
    const removed: CaptureTarget[] = []
    for (const target of this.targets.values()) {
      if (now - target.lastSeenAt > TAB_STALE_AFTER_MS) {
        this.targets.delete(target.key)
        removed.push(target)
      }
    }
    return removed
  }

  upsert(
    identity: TargetIdentity,
    now: number,
  ): { target: CaptureTarget; evicted?: CaptureTarget } {
    const key = targetKey(identity)
    const existing = this.targets.get(key)
    if (existing) {
      existing.lastSeenAt = now
      existing.currentUrl = identity.normalizedUrl
      return { target: existing }
    }
    const target: CaptureTarget = {
      ...identity,
      key,
      currentUrl: identity.normalizedUrl,
      lastUrl: null,
      lastCaptureAt: null,
      lastSeenAt: now,
      pending: null,
      lastInputAt: null,
      pointerConfirmedUntil: null,
      audibleConfirmedUntil: null,
      typedFieldCache: new Map(),
    }
    this.targets.set(key, target)
    if (this.targets.size <= TRACKED_TARGET_LIMIT) return { target }
    let oldest: CaptureTarget | undefined
    for (const candidate of this.targets.values()) {
      if (!oldest || candidate.lastSeenAt < oldest.lastSeenAt) oldest = candidate
    }
    if (!oldest) return { target }
    this.targets.delete(oldest.key)
    return { target, evicted: oldest }
  }
}
