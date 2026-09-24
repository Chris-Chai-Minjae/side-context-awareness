import { describe, expect, test } from "bun:test"
import {
  attentionScore,
  compareAttention,
  confirmAudible,
  confirmPointer,
  isIdle,
  recordInput,
} from "../../src/capture/attention"
import {
  readTypedField,
  rememberTypedField,
  TargetStore,
  targetKey,
} from "../../src/capture/target"
import { TRACKED_TARGET_LIMIT } from "../../src/constants"

function target(windowId: number, lastSeenAt = 0) {
  return new TargetStore().upsert(
    { bundleId: "com.example.app", windowId, normalizedUrl: null },
    lastSeenAt,
  ).target
}

describe("attention", () => {
  test("reports idle only after the 180 second input threshold", () => {
    // Given a session at the exact threshold and one just beyond it.
    // When idle state is derived from seconds since the last input.
    // Then equality is still active and any later instant is idle.
    expect(isIdle(180)).toBe(false)
    expect(isIdle(181)).toBe(true)
  })

  test("starts score decay after 45 seconds without input", () => {
    // Given a foreground target that last received input at time zero.
    const current = target(1)
    recordInput(current, 0)

    // When time reaches and then exceeds the stale threshold.
    const atThreshold = attentionScore(current, 45_000)
    const afterThreshold = attentionScore(current, 90_000)

    // Then the score holds through 45 seconds and decays afterward.
    expect(atThreshold).toBe(1)
    expect(afterThreshold).toBe(0.5)
  })

  test("honors pointer and explicit audible confirmation TTLs", () => {
    // Given a target with pointer and explicit audible signals at time zero.
    const current = target(1)
    confirmPointer(current, 0)
    confirmAudible(current, 0)
    const other = target(2, 10_000)

    // When each confirmation reaches its TTL boundary.
    // Then pointer expires at 20 seconds and audible at 30 minutes.
    expect(current.pointerConfirmedUntil).toBe(20_000)
    expect(current.audibleConfirmedUntil).toBe(1_800_000)
    expect(compareAttention(current, other, 19_999, null)).toBeLessThan(0)
    expect(compareAttention(current, other, 20_000, null)).toBeLessThan(0)
    expect(compareAttention(current, other, 1_800_000, null)).toBeGreaterThan(0)
  })

  test("ranks confirmed and fresh foreground targets before recent background targets", () => {
    // Given a fresh foreground, a pointer-confirmed background, and another recent target.
    const foreground = target(1, 0)
    const pointer = target(2, 0)
    const background = target(3, 1_000)
    recordInput(foreground, 0)
    recordInput(background, 1_000)
    confirmPointer(pointer, 0)

    // When they are ranked at 2 seconds.
    const ordered = [background, foreground, pointer].sort((left, right) =>
      compareAttention(left, right, 2_000, foreground.key),
    )

    // Then confirmed targets lead, with recent input ordering the remainder.
    expect(ordered.map((item) => item.key)).toEqual([pointer.key, foreground.key, background.key])
  })

  test("uses lastSeen and then stable target key to break attention ties", () => {
    // Given equal input freshness and two targets last seen at the same time.
    const older = target(1, 0)
    const newer = target(2, 1_000)
    const sameTimeA = target(3, 1_000)
    recordInput(older, 0)
    recordInput(newer, 0)
    recordInput(sameTimeA, 0)

    // When background targets are ranked after stale onset.
    const ordered = [sameTimeA, older, newer].sort((left, right) =>
      compareAttention(left, right, 46_000, null),
    )

    // Then recent lastSeen leads and keys resolve the remaining tie.
    expect(ordered.map((item) => item.key)).toEqual([
      targetKey(newer),
      targetKey(sameTimeA),
      targetKey(older),
    ])
  })

  test("expires a typed field's previous value after five minutes", () => {
    // Given a prior field value held in a target cache.
    const current = target(1)
    rememberTypedField(current, "field-1", "draft", 0)

    // When it is read just before and at the retention boundary.
    const beforeExpiry = readTypedField(current, "field-1", 299_999)
    const atExpiry = readTypedField(current, "field-1", 300_000)

    // Then the previous value is usable before the boundary and removed at it.
    expect(beforeExpiry).toBe("draft")
    expect(atExpiry).toBeNull()
    expect(current.typedFieldCache.size).toBe(0)
  })
})

describe("TargetStore", () => {
  test("evicts the least recently seen target after the 512 target limit", () => {
    // Given a full store whose first target was seen again most recently.
    const store = new TargetStore()
    const identity = (windowId: number) => ({
      bundleId: "com.example.app",
      windowId,
      normalizedUrl: null,
    })
    for (let windowId = 0; windowId < TRACKED_TARGET_LIMIT; windowId++) {
      store.upsert(identity(windowId), windowId)
    }
    store.upsert(identity(0), TRACKED_TARGET_LIMIT)

    // When one more target is tracked.
    store.upsert(identity(TRACKED_TARGET_LIMIT), TRACKED_TARGET_LIMIT + 1)

    // Then the older second target is evicted, retaining the refreshed first.
    expect(store.get(targetKey(identity(0)))).toBeDefined()
    expect(store.get(targetKey(identity(1)))).toBeUndefined()
    expect([...store.values()]).toHaveLength(TRACKED_TARGET_LIMIT)
  })
})
