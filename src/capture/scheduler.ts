import {
  ACTIVATION_INTERVAL_MS,
  CAPTURE_DEBOUNCE_MS,
  MAX_CONCURRENT_CAPTURES,
  MAX_SWEEP_TARGETS,
  MIN_CAPTURE_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
  TRIGGER_STRENGTH,
  UNCHANGED_URL_INTERVAL_MS,
} from "../constants"
import { compareAttention } from "./attention"
import { type CaptureTarget, type TargetIdentity, TargetStore, type Trigger } from "./target"

export type SchedulerClock<TimerId> = {
  readonly now: () => number
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerId
  readonly clearTimeout: (id: TimerId) => void
}

export type CaptureGate = {
  readonly paused: boolean
  readonly denied: boolean
  readonly secureInput: boolean
  readonly idle: boolean
}

export type CaptureSchedulerOptions<Result, TimerId> = {
  readonly clock: SchedulerClock<TimerId>
  readonly getForegroundTargetKey: () => string | null
  readonly getGate: (target: CaptureTarget) => CaptureGate
  readonly capture: (target: CaptureTarget, trigger: Trigger) => Promise<Result>
  readonly onResult: (result: Result, target: CaptureTarget) => void | Promise<void>
  readonly onError: (error: unknown) => void
}

export class CaptureScheduler<Result, TimerId> {
  readonly targets = new TargetStore()
  private readonly options: CaptureSchedulerOptions<Result, TimerId>
  private readonly timers = new Map<string, TimerId>()
  private readonly inFlight = new Set<string>()
  private sweepTimer: TimerId | null = null
  private stopped = false
  private paused = false
  private captureGeneration = 0

  constructor(options: CaptureSchedulerOptions<Result, TimerId>) {
    this.options = options
  }

  schedule(identity: TargetIdentity, trigger: Trigger): CaptureTarget {
    if (this.stopped) throw new CaptureSchedulerStoppedError()
    const now = this.options.clock.now()
    const { target, evicted } = this.targets.upsert(identity, now)
    if (evicted) this.cancelTimer(evicted.key)
    if (!this.paused) this.scheduleTarget(target, trigger, now)
    return target
  }

  start(): void {
    this.stopped = false
    if (this.sweepTimer !== null) return
    this.armSweep()
  }

  pause(): void {
    if (this.stopped || this.paused) return
    this.paused = true
    this.captureGeneration++
    for (const key of this.timers.keys()) this.cancelTimer(key)
    for (const target of this.targets.values()) target.pending = null
  }

  resume(): void {
    if (this.stopped) throw new CaptureSchedulerStoppedError()
    if (!this.paused) return
    this.paused = false
    this.captureGeneration++
    const foreground = this.options.getForegroundTargetKey()
    const target = foreground === null ? undefined : this.targets.get(foreground)
    if (target) this.scheduleTarget(target, "activation", this.options.clock.now())
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.captureGeneration++
    if (this.sweepTimer !== null) this.options.clock.clearTimeout(this.sweepTimer)
    this.sweepTimer = null
    for (const key of this.timers.keys()) this.cancelTimer(key)
    for (const target of this.targets.values()) target.pending = null
  }

  private scheduleTarget(target: CaptureTarget, trigger: Trigger, now: number): void {
    const interval =
      trigger === "interaction" || trigger === "activation"
        ? ACTIVATION_INTERVAL_MS
        : target.currentUrl !== null && target.currentUrl === target.lastUrl
          ? UNCHANGED_URL_INTERVAL_MS
          : MIN_CAPTURE_INTERVAL_MS
    const elapsed =
      target.lastCaptureAt === null ? Number.POSITIVE_INFINITY : now - target.lastCaptureAt
    const deadline = now + Math.max(CAPTURE_DEBOUNCE_MS, interval - elapsed)
    if (target.pending === null) {
      target.pending = { trigger, deadline }
    } else {
      const previous = target.pending
      target.pending = {
        trigger:
          TRIGGER_STRENGTH[trigger] > TRIGGER_STRENGTH[previous.trigger]
            ? trigger
            : previous.trigger,
        deadline: Math.min(
          Math.max(previous.deadline, deadline),
          previous.deadline + CAPTURE_DEBOUNCE_MS,
        ),
      }
    }
    this.armTarget(target)
  }

  private armTarget(target: CaptureTarget): void {
    this.cancelTimer(target.key)
    if (target.pending === null) return
    const delay = Math.max(0, target.pending.deadline - this.options.clock.now())
    const id = this.options.clock.setTimeout(() => {
      this.timers.delete(target.key)
      this.drain()
    }, delay)
    this.timers.set(target.key, id)
  }

  private cancelTimer(key: string): void {
    const id = this.timers.get(key)
    if (id !== undefined) this.options.clock.clearTimeout(id)
    this.timers.delete(key)
  }

  private armSweep(): void {
    this.sweepTimer = this.options.clock.setTimeout(() => {
      this.sweepTimer = null
      this.sweep()
      if (!this.stopped) this.armSweep()
    }, SWEEP_INTERVAL_MS)
  }

  private sweep(): void {
    const now = this.options.clock.now()
    for (const stale of this.targets.pruneStale(now)) this.cancelTimer(stale.key)
    if (this.paused) return
    const foreground = this.options.getForegroundTargetKey()
    const ranked = [...this.targets.values()].sort((left, right) =>
      compareAttention(left, right, now, foreground),
    )
    for (const target of ranked.slice(0, MAX_SWEEP_TARGETS)) {
      this.scheduleTarget(target, "sweep", now)
    }
  }

  private drain(): void {
    if (this.stopped || this.paused) return
    const now = this.options.clock.now()
    const due = [...this.targets.values()]
      .filter(
        (target) =>
          target.pending !== null &&
          target.pending.deadline <= now &&
          !this.inFlight.has(target.key),
      )
      .sort((left, right) => {
        const leftPending = left.pending
        const rightPending = right.pending
        if (!leftPending || !rightPending) return 0
        return (
          leftPending.deadline - rightPending.deadline ||
          TRIGGER_STRENGTH[rightPending.trigger] - TRIGGER_STRENGTH[leftPending.trigger] ||
          left.key.localeCompare(right.key)
        )
      })
    for (const target of due) {
      if (this.inFlight.size >= MAX_CONCURRENT_CAPTURES) return
      const pending = target.pending
      if (pending === null) continue
      target.pending = null
      const gate = this.options.getGate(target)
      if (
        gate.paused ||
        gate.denied ||
        gate.secureInput ||
        (gate.idle && pending.trigger !== "sweep")
      ) {
        continue
      }
      this.inFlight.add(target.key)
      void this.execute(target, pending.trigger)
    }
  }

  private async execute(target: CaptureTarget, trigger: Trigger): Promise<void> {
    const foregroundAtStart = this.options.getForegroundTargetKey()
    const generationAtStart = this.captureGeneration
    try {
      const result = await this.options.capture(target, trigger)
      if (
        !this.stopped &&
        !this.paused &&
        generationAtStart === this.captureGeneration &&
        this.targets.get(target.key) === target &&
        foregroundAtStart === this.options.getForegroundTargetKey()
      ) {
        await this.options.onResult(result, target)
        target.lastCaptureAt = this.options.clock.now()
        target.lastUrl = target.currentUrl
      }
    } catch (error) {
      this.options.onError(error)
    } finally {
      this.inFlight.delete(target.key)
      this.drain()
    }
  }
}

export class CaptureSchedulerStoppedError extends Error {
  readonly name = "CaptureSchedulerStoppedError"
  constructor() {
    super("Capture scheduler has stopped")
  }
}
