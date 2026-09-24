export class FakeClock {
  private nextId = 0
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>()

  constructor(private currentMs = 0) {}

  now(): number {
    return this.currentMs
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId
    this.timers.set(id, { dueAt: this.currentMs + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout(id: number): void {
    this.timers.delete(id)
  }

  advanceBy(durationMs: number): void {
    if (durationMs < 0) throw new RangeError("Fake time cannot move backwards")
    const target = this.currentMs + durationMs
    while (true) {
      const due = [...this.timers]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort(([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId)[0]
      if (!due) break
      const [id, timer] = due
      this.timers.delete(id)
      this.currentMs = timer.dueAt
      timer.callback()
    }
    this.currentMs = target
  }
}
