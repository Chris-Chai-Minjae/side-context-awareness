import type { HelperHealth } from "../contracts/protocol"

export type HelperBanner =
  | "starting"
  | "not-running"
  | "permissions-needed"
  | "some-unavailable"
  | null

type HealthSnapshot =
  | { readonly kind: "starting" }
  | { readonly kind: "reported"; readonly health: HelperHealth }
  | { readonly kind: "disconnected" }

type BannerOptions = {
  readonly screenOcrEnabled: boolean
  readonly automationUnavailable: boolean
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected health state: ${String(value)}`)
}

export class HelperHealthMachine {
  private snapshot: HealthSnapshot = { kind: "starting" }

  get state(): HelperHealth["state"] {
    switch (this.snapshot.kind) {
      case "starting":
        return "starting"
      case "reported":
        return this.snapshot.health.state
      case "disconnected":
        return "stopped"
      default:
        return assertNever(this.snapshot)
    }
  }

  get current(): HelperHealth | null {
    return this.snapshot.kind === "reported" ? this.snapshot.health : null
  }

  update(health: HelperHealth): void {
    this.snapshot = { kind: "reported", health }
  }

  disconnect(): void {
    this.snapshot = { kind: "disconnected" }
  }

  banner(options: BannerOptions): HelperBanner {
    switch (this.snapshot.kind) {
      case "starting":
        return "starting"
      case "disconnected":
        return "not-running"
      case "reported": {
        const health = this.snapshot.health
        if (health.state === "starting") return "starting"
        if (health.state === "stopped" || !health.nativeCaptureAvailable) return "not-running"
        if (!health.accessibilityTrusted || !health.inputMonitoringTrusted) {
          return "permissions-needed"
        }
        if (
          (options.screenOcrEnabled &&
            (!health.screenOcrAvailable || !health.screenRecordingTrusted)) ||
          options.automationUnavailable ||
          !health.eventTapHealthy ||
          health.observerRegistrationFailures > 0
        ) {
          return "some-unavailable"
        }
        return null
      }
      default:
        return assertNever(this.snapshot)
    }
  }
}
