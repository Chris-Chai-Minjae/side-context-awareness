import { expect, test } from "bun:test"
import { FakeClock } from "../mocks/fake-clock"

test("Given ordered timers and a cancelled timer, when fake time advances, then only due callbacks fire", () => {
  const clock = new FakeClock(1_000)
  const calls: string[] = []
  clock.setTimeout(() => calls.push("late"), 20)
  clock.setTimeout(() => calls.push("early"), 10)
  const cancelled = clock.setTimeout(() => calls.push("cancelled"), 15)
  clock.clearTimeout(cancelled)
  clock.advanceBy(10)
  expect(clock.now()).toBe(1_010)
  expect(calls).toEqual(["early"])
  clock.advanceBy(10)
  expect(calls).toEqual(["early", "late"])
})
