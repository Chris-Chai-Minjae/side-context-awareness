import type { SchedulerClock } from "../capture/scheduler"
import { PAUSE_INDEFINITE } from "../constants"
import type { HelperHealth } from "../contracts/protocol"
import type { Settings } from "../contracts/settings"
import type { HelperCommandRequest } from "../helper/client"
import { HARD_BLOCKED_BUNDLE_IDS } from "../policy/index"

type SchedulerControl = {
  readonly start: () => void
  readonly stop: () => void
  readonly pause: () => void
  readonly resume: () => void
}

type ReconcilerOptions<TimerId> = {
  readonly settings: Settings
  readonly clock: SchedulerClock<TimerId>
  readonly helper: { readonly sendCommand: (command: HelperCommandRequest) => Promise<unknown> }
  readonly scheduler: SchedulerControl
  readonly saveSettings: (settings: Settings) => Promise<void>
  readonly onError?: (error: unknown) => void
}

export type ReconcileState = "starting" | "running" | "paused" | "stopped"

export class Reconciler<TimerId> {
  private readonly options: ReconcilerOptions<TimerId>
  private settings: Settings
  private health: HelperHealth | null = null
  private timer: TimerId | null = null
  private pending: Promise<void> = Promise.resolve()
  private started = false
  private schedulerStarted = false
  private lastConfigure: string | null = null
  private lastRequestedPermissions: string | null = null
  private helperIdentity: string | null = null
  private captureBlocked = false
  state: ReconcileState = "starting"

  constructor(options: ReconcilerOptions<TimerId>) {
    this.options = options
    this.settings = options.settings
  }

  get currentSettings(): Settings {
    return this.settings
  }

  get currentHealth(): HelperHealth | null {
    return this.health
  }

  start(): Promise<void> {
    this.started = true
    return this.enqueue(() => this.reconcile())
  }

  settingsPatched(next: Settings): Promise<void> {
    const enabling = !this.settings.contextAwareness.enabled && next.contextAwareness.enabled
    if (enabling || !next.contextAwareness.enabled) this.lastRequestedPermissions = null
    this.settings = enabling
      ? { ...next, contextAwareness: { ...next.contextAwareness, pausedUntil: null } }
      : next
    return this.enqueue(async () => {
      if (enabling) await this.options.saveSettings(this.settings)
      await this.reconcile()
    })
  }

  healthChanged(next: HelperHealth): Promise<void> {
    const identity = `${next.pid}:${next.observerPid}`
    if (identity !== this.helperIdentity) {
      this.helperIdentity = identity
      this.lastConfigure = null
      this.lastRequestedPermissions = null
    }
    this.health = next
    return this.started ? this.enqueue(() => this.reconcile()) : Promise.resolve()
  }

  waitForIdle(): Promise<void> {
    return this.pending
  }

  setCaptureBlocked(blocked: boolean): Promise<void> {
    this.captureBlocked = blocked
    return this.enqueue(() => this.reconcile())
  }

  stop(): Promise<void> {
    this.started = false
    this.cancelTimer()
    if (this.schedulerStarted) {
      this.options.scheduler.stop()
      this.schedulerStarted = false
    }
    this.state = "stopped"
    return this.enqueue(() => this.configure(true))
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.pending.then(work, work)
    this.pending = next
    return next
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private schedulePauseExpiry(): void {
    this.cancelTimer()
    const until = this.settings.contextAwareness.pausedUntil
    if (until === null || until === PAUSE_INDEFINITE || until <= this.options.clock.now()) return
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null
      void this.enqueue(async () => {
        const current = this.settings.contextAwareness.pausedUntil
        if (current === null || current > this.options.clock.now()) return
        this.settings = {
          ...this.settings,
          contextAwareness: { ...this.settings.contextAwareness, pausedUntil: null },
        }
        await this.options.saveSettings(this.settings)
        await this.reconcile()
      }).catch((error: unknown) => this.options.onError?.(error))
    }, until - this.options.clock.now())
  }

  private async configure(paused: boolean): Promise<void> {
    const capture = this.settings.contextAwareness
    const deniedBundleIds = [
      ...new Set([
        ...HARD_BLOCKED_BUNDLE_IDS,
        ...capture.rules.flatMap((rule) =>
          rule.scope === "app" && rule.behavior === "do_not_observe" ? [rule.bundleId] : [],
        ),
      ]),
    ]
    const args = {
      deniedBundleIds,
      captureTypedText: capture.captureTypedText,
      screenOcr: capture.screenOcr,
      paused,
    }
    const serialized = JSON.stringify(args)
    if (serialized === this.lastConfigure) return
    await this.options.helper.sendCommand({ type: "command", name: "observer.configure", args })
    this.lastConfigure = serialized
  }

  private async requestMissingPermissions(
    missing: ("accessibility" | "inputMonitoring" | "screenRecording")[],
  ): Promise<void> {
    if (missing.length === 0) {
      this.lastRequestedPermissions = null
      return
    }
    const serialized = JSON.stringify(missing)
    if (serialized === this.lastRequestedPermissions) return
    await this.options.helper.sendCommand({
      type: "command",
      name: "requestPermissions",
      args: { kinds: missing },
    })
    this.lastRequestedPermissions = serialized
  }

  private async reconcile(): Promise<void> {
    if (!this.started) return
    this.schedulePauseExpiry()
    const capture = this.settings.contextAwareness
    const health = this.health
    const missing: ("accessibility" | "inputMonitoring" | "screenRecording")[] = []
    if (capture.enabled && health) {
      if (!health.accessibilityTrusted) missing.push("accessibility")
      if (!health.inputMonitoringTrusted) missing.push("inputMonitoring")
      if (capture.screenOcr && !health.screenRecordingTrusted) missing.push("screenRecording")
    }
    const active =
      capture.enabled &&
      health !== null &&
      health.platform === "darwin" &&
      health.nativeCaptureAvailable &&
      health.accessibilityTrusted &&
      health.inputMonitoringTrusted
    const paused =
      this.captureBlocked ||
      capture.pausedUntil === PAUSE_INDEFINITE ||
      (capture.pausedUntil !== null && capture.pausedUntil > this.options.clock.now())
    if (!active) {
      if (this.schedulerStarted) {
        this.options.scheduler.stop()
        this.schedulerStarted = false
      }
      this.state = capture.enabled && health === null ? "starting" : "stopped"
      await this.configure(true)
      await this.requestMissingPermissions(missing)
      return
    }
    if (!this.schedulerStarted) {
      this.options.scheduler.start()
      this.schedulerStarted = true
    }
    if (paused) this.options.scheduler.pause()
    else this.options.scheduler.resume()
    this.state = paused ? "paused" : "running"
    await this.configure(paused)
    await this.requestMissingPermissions(missing)
  }
}
