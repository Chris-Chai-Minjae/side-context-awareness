import type { SchedulerClock } from "../capture/scheduler"
import { GLANCE_MS } from "../constants"

type DwellState = {
  readonly key: string
  readonly eventId: string
  readonly occurredAt: number
  qualified: boolean
}

export class DwellTracker<TimerId> {
  private current: DwellState | null = null
  private timer: TimerId | null = null

  constructor(
    private readonly clock: SchedulerClock<TimerId>,
    private readonly mark: (eventId: string, occurredAt: number) => void,
  ) {}

  observe(key: string, eventId: string, occurredAt: number): void {
    const current = this.current
    if (current?.key === key) {
      if (current.qualified) this.mark(eventId, occurredAt)
      return
    }

    this.clear()
    const next: DwellState = { key, eventId, occurredAt, qualified: false }
    this.current = next
    this.timer = this.clock.setTimeout(() => {
      if (this.current !== next) return
      this.timer = null
      next.qualified = true
      this.mark(next.eventId, next.occurredAt)
    }, GLANCE_MS)
  }

  clear(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.current = null
  }
}
