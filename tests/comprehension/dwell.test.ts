import { expect, test } from "bun:test"
import { DwellTracker } from "../../src/comprehension/dwell"
import { GLANCE_MS } from "../../src/constants"
import { FakeClock } from "../mocks/fake-clock"

test("Given repeated accepted events on one foreground page, when its first five seconds elapse, then the first event qualifies without resetting the dwell", () => {
  const clock = new FakeClock(1_000)
  const marked: string[] = []
  const dwell = new DwellTracker(clock, (id) => marked.push(id))

  dwell.observe("page", "first", clock.now())
  clock.advanceBy(GLANCE_MS - 1)
  dwell.observe("page", "latest", clock.now())
  expect(marked).toEqual([])
  clock.advanceBy(1)
  expect(marked).toEqual(["first"])

  dwell.observe("page", "later", clock.now())
  expect(marked).toEqual(["first", "later"])
})

test("Given a dwell crossing a ten-minute boundary, when it reaches five seconds, then the first window receives the qualification", () => {
  const windowStart = new Date(2026, 8, 24, 10, 0).getTime()
  const clock = new FakeClock(windowStart + 10 * 60_000 - 2_000)
  const marked: string[] = []
  const dwell = new DwellTracker(clock, (id) => marked.push(id))

  dwell.observe("page", "first-window", clock.now())
  clock.advanceBy(GLANCE_MS - 1)
  dwell.observe("page", "next-window", clock.now())
  clock.advanceBy(1)

  expect(marked).toEqual(["first-window"])
})

test("Given an unfinished dwell, when capture pauses or stops, then its timer cannot qualify the page", () => {
  const clock = new FakeClock(1_000)
  const marked: string[] = []
  const dwell = new DwellTracker(clock, (id) => marked.push(id))

  dwell.observe("page", "before-pause", clock.now())
  clock.advanceBy(GLANCE_MS - 1)
  dwell.clear()
  clock.advanceBy(1)
  expect(marked).toEqual([])

  dwell.observe("page", "after-resume", clock.now())
  clock.advanceBy(GLANCE_MS)
  expect(marked).toEqual(["after-resume"])
  dwell.clear()
})

test("Given rapid page switches, when each visit is a glance, then at most one dwell timer remains armed", () => {
  const clock = new FakeClock(1_000)
  const pending = new Set<number>()
  const marked: string[] = []
  const dwell = new DwellTracker(
    {
      now: () => clock.now(),
      setTimeout: (callback, delayMs) => {
        const id = clock.setTimeout(() => {
          pending.delete(id)
          callback()
        }, delayMs)
        pending.add(id)
        return id
      },
      clearTimeout: (id) => {
        pending.delete(id)
        clock.clearTimeout(id)
      },
    },
    (id) => marked.push(id),
  )

  for (let index = 0; index < 100; index++) {
    dwell.observe(`page-${index}`, `event-${index}`, clock.now())
    expect(pending.size).toBe(1)
    clock.advanceBy(GLANCE_MS - 1)
  }
  dwell.clear()
  expect(pending.size).toBe(0)
  clock.advanceBy(GLANCE_MS)
  expect(marked).toEqual([])
})
