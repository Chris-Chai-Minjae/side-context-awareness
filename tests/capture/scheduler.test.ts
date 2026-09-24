import { describe, expect, test } from "bun:test"
import { confirmAudible } from "../../src/capture/attention"
import { type CaptureGate, CaptureScheduler } from "../../src/capture/scheduler"
import { targetKey } from "../../src/capture/target"
import { FakeClock } from "../mocks/fake-clock"

const openGate = { paused: false, denied: false, secureInput: false, idle: false } as const

function identity(windowId: number) {
  return { bundleId: "com.example.browser", windowId, normalizedUrl: null }
}

async function settle(): Promise<void> {
  await Bun.sleep(0)
}

describe("CaptureScheduler", () => {
  test("promotes navigation to interaction and extends its deadline by at most one debounce", () => {
    // Given a recent capture on the same window before its URL changed.
    const clock = new FakeClock()
    const identity = {
      bundleId: "com.example.browser",
      windowId: 7,
      normalizedUrl: "https://example.test/new",
    }
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => targetKey(identity),
      getGate: () => ({ paused: false, denied: false, secureInput: false, idle: false }),
      capture: async () => "captured",
      onResult: () => {},
      onError: (error) => {
        throw error
      },
    })
    const target = scheduler.targets.upsert(identity, clock.now()).target
    target.lastCaptureAt = clock.now()
    target.lastUrl = "https://example.test/old"
    scheduler.schedule(identity, "navigation")
    const navigationDeadline = target.pending?.deadline

    // When an interaction follows 300 ms later.
    clock.advanceBy(300)
    scheduler.schedule(identity, "interaction")

    // Then its pending trigger is stronger and the deadline moves by at most 500 ms.
    expect(navigationDeadline).toBe(2_000)
    expect(target.pending).toEqual({ trigger: "interaction", deadline: 2_500 })
    scheduler.stop()
  })

  test("uses unchanged URL, activation, and changed URL intervals", () => {
    // Given three recently captured targets with different triggers and URLs.
    const clock = new FakeClock()
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => null,
      getGate: () => openGate,
      capture: async () => "captured",
      onResult: () => {},
      onError: (error) => {
        throw error
      },
    })
    const unchanged = scheduler.targets.upsert(
      { ...identity(1), normalizedUrl: "https://example.test/a" },
      clock.now(),
    ).target
    const activation = scheduler.targets.upsert(identity(2), clock.now()).target
    const changed = scheduler.targets.upsert(
      { ...identity(3), normalizedUrl: "https://example.test/new" },
      clock.now(),
    ).target
    for (const target of [unchanged, activation, changed]) target.lastCaptureAt = clock.now()
    unchanged.lastUrl = unchanged.currentUrl
    changed.lastUrl = "https://example.test/old"

    // When each target is scheduled at the same time.
    scheduler.schedule(unchanged, "navigation")
    scheduler.schedule(activation, "activation")
    scheduler.schedule(changed, "navigation")

    // Then the three documented intervals determine their deadlines.
    expect(unchanged.pending?.deadline).toBe(60_000)
    expect(activation.pending?.deadline).toBe(15_000)
    expect(changed.pending?.deadline).toBe(2_000)
    scheduler.stop()
  })

  test("limits simultaneous captures to two while draining later targets", async () => {
    // Given three targets due at the same fake time and captures held open.
    const clock = new FakeClock()
    const resolvers: ((value: string) => void)[] = []
    let active = 0
    let maximumActive = 0
    let completed = 0
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => null,
      getGate: () => openGate,
      capture: () => {
        active++
        maximumActive = Math.max(maximumActive, active)
        return new Promise<string>((resolve) => resolvers.push(resolve))
      },
      onResult: () => {
        active--
        completed++
      },
      onError: (error) => {
        throw error
      },
    })
    for (const windowId of [1, 2, 3]) scheduler.schedule(identity(windowId), "discovery")

    // When the debounce expires and then one capture completes.
    clock.advanceBy(500)
    expect(active).toBe(2)
    resolvers.shift()?.("first")
    await settle()

    // Then only one queued capture starts, keeping the ceiling at two.
    expect(active).toBe(2)
    expect(maximumActive).toBe(2)
    for (const resolve of resolvers) resolve("remaining")
    await settle()
    expect(completed).toBe(3)
    scheduler.stop()
  })

  test.each([
    ["pause", { ...openGate, paused: true }],
    ["denylist", { ...openGate, denied: true }],
    ["secure input", { ...openGate, secureInput: true }],
    ["idle", { ...openGate, idle: true }],
  ])("reevaluates %s before executing pending navigation", (_name, blockedGate) => {
    // Given a navigation scheduled while capture is allowed.
    const clock = new FakeClock()
    let gate: CaptureGate = openGate
    let calls = 0
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => null,
      getGate: () => gate,
      capture: async () => {
        calls++
        return "captured"
      },
      onResult: () => {},
      onError: (error) => {
        throw error
      },
    })
    scheduler.schedule(identity(1), "navigation")

    // When the gate changes before the deadline.
    gate = blockedGate
    clock.advanceBy(500)

    // Then no capture begins.
    expect(calls).toBe(0)
    scheduler.stop()
  })

  test("permits sweeps during idle and selects at most eight nonstale targets", async () => {
    // Given nine recent targets and one stale target while the user is idle.
    const clock = new FakeClock()
    const captured: string[] = []
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => null,
      getGate: () => ({ ...openGate, idle: true }),
      capture: async (target) => {
        captured.push(target.key)
        return "captured"
      },
      onResult: () => {},
      onError: (error) => {
        throw error
      },
    })
    for (let windowId = 1; windowId <= 9; windowId++) {
      scheduler.targets.upsert(identity(windowId), clock.now())
    }
    const confirmed = scheduler.targets.get(targetKey(identity(9)))
    if (!confirmed) throw new Error("Missing test target")
    confirmAudible(confirmed, clock.now())
    const stale = scheduler.targets.upsert(identity(10), -600_000).target
    scheduler.start()

    // When the 120 second sweep interval and capture debounce pass.
    clock.advanceBy(120_500)
    await settle()

    // Then eight recent targets are captured and the stale target is removed.
    expect(captured).toHaveLength(8)
    expect(captured).toContain(confirmed.key)
    expect(scheduler.targets.get(stale.key)).toBeUndefined()
    scheduler.stop()
  })

  test("discards a completed capture after the foreground URL changes", async () => {
    // Given an in-flight capture under one foreground app, window, and URL.
    const clock = new FakeClock()
    const capturedTarget = identity(1)
    let foreground = targetKey(capturedTarget)
    let finish: ((result: string) => void) | undefined
    let accepted = 0
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => foreground,
      getGate: () => openGate,
      capture: () => new Promise<string>((resolve) => (finish = resolve)),
      onResult: () => {
        accepted++
      },
      onError: (error) => {
        throw error
      },
    })
    scheduler.schedule(capturedTarget, "navigation")
    clock.advanceBy(500)

    // When the foreground URL changes before the result arrives.
    foreground = targetKey({ ...capturedTarget, normalizedUrl: "https://example.test/new" })
    finish?.("stale result")
    await settle()

    // Then the result is discarded and no successful capture time is recorded.
    expect(accepted).toBe(0)
    expect(scheduler.targets.get(targetKey(capturedTarget))?.lastCaptureAt).toBeNull()
    scheduler.stop()
  })

  test("pause discards an in-flight result and resume captures the foreground target", async () => {
    const clock = new FakeClock()
    const foreground = identity(1)
    const finish: Array<(result: string) => void> = []
    const accepted: string[] = []
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => targetKey(foreground),
      getGate: () => openGate,
      capture: () => new Promise<string>((resolve) => finish.push(resolve)),
      onResult: (result) => {
        accepted.push(result)
      },
      onError: (error) => {
        throw error
      },
    })
    scheduler.schedule(foreground, "discovery")
    clock.advanceBy(500)
    expect(finish).toHaveLength(1)

    scheduler.pause()
    scheduler.resume()
    finish[0]?.("stale")
    await settle()
    expect(accepted).toEqual([])

    clock.advanceBy(500)
    expect(finish).toHaveLength(2)
    finish[1]?.("fresh")
    await settle()
    expect(accepted).toEqual(["fresh"])
    scheduler.stop()
  })

  test("a stopped scheduler restarts after capture is re-enabled", async () => {
    const clock = new FakeClock()
    const captured: string[] = []
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => targetKey(identity(1)),
      getGate: () => openGate,
      capture: async () => "captured",
      onResult: (result) => {
        captured.push(result)
      },
      onError: (error) => {
        throw error
      },
    })
    scheduler.start()
    scheduler.schedule(identity(1), "activation")
    scheduler.stop()
    clock.advanceBy(500)
    expect(captured).toEqual([])

    scheduler.start()
    scheduler.schedule(identity(1), "activation")
    clock.advanceBy(500)
    await settle()
    expect(captured).toEqual(["captured"])
    scheduler.stop()
  })

  test("a result started before stop is discarded even if capture restarts first", async () => {
    const clock = new FakeClock()
    const finish: Array<(result: string) => void> = []
    const accepted: string[] = []
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => targetKey(identity(1)),
      getGate: () => openGate,
      capture: () => new Promise<string>((resolve) => finish.push(resolve)),
      onResult: (result) => {
        accepted.push(result)
      },
      onError: (error) => {
        throw error
      },
    })
    scheduler.start()
    scheduler.schedule(identity(1), "activation")
    clock.advanceBy(500)
    expect(finish).toHaveLength(1)

    scheduler.stop()
    scheduler.start()
    finish[0]?.("stale")
    await settle()
    expect(accepted).toEqual([])
    scheduler.stop()
  })
})
