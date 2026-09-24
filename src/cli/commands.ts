import { HOUR_MS, PAUSE_15_MINUTES_MS, PAUSE_30_MINUTES_MS, PAUSE_INDEFINITE } from "../constants"
import type { RpcMethodName } from "../contracts/rpc"

type ClientEnvironment = {
  readonly rpc: (method: RpcMethodName, params: unknown) => Promise<unknown>
  readonly write: (line: string) => void
  readonly confirmClearAll?: () => Promise<boolean>
  readonly doctor?: () => Promise<number>
}

type Parsed = {
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, string | true>
}

function parse(
  args: readonly string[],
  values: readonly string[],
  booleans: readonly string[] = [],
): Parsed {
  const allowedValues = new Set(values)
  const allowedBooleans = new Set(booleans)
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token) continue
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    if (allowedBooleans.has(token)) {
      flags.set(token, true)
      continue
    }
    if (!allowedValues.has(token)) throw new TypeError(`Unknown option: ${token}`)
    const value = args[++index]
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${token}`)
    flags.set(token, value)
  }
  return { positionals, flags }
}

function flag(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value)) throw new TypeError(`${name} must be an integer`)
  return Number(value)
}

function requireCount(values: readonly string[], count: number, command: string): void {
  if (values.length !== count) throw new TypeError(`${command} requires ${count} argument(s)`)
}

function printResult(environment: ClientEnvironment, result: unknown, compact = false): void {
  environment.write(JSON.stringify(result, null, compact ? undefined : 2))
}

export async function runClientCommand(
  argv: readonly string[],
  environment: ClientEnvironment,
): Promise<number> {
  const [command, ...args] = argv
  switch (command) {
    case "status": {
      const { positionals, flags } = parse(args, [], ["--json"])
      requireCount(positionals, 0, command)
      const result = await environment.rpc("status", undefined)
      if (flags.has("--json")) printResult(environment, result, true)
      else {
        const state = result as { readonly enabled?: boolean; readonly state?: string }
        environment.write(
          `Side: ${state.state ?? "unknown"} (${state.enabled ? "enabled" : "disabled"})`,
        )
      }
      return 0
    }
    case "search": {
      const { positionals, flags } = parse(
        args,
        ["--from", "--to", "--app", "--domain", "--limit"],
        ["--json"],
      )
      if (positionals.length === 0) throw new TypeError("search requires a query")
      const params = {
        queries: [positionals.join(" ")],
        ...(flag(flags, "--from") ? { from: flag(flags, "--from") } : {}),
        ...(flag(flags, "--to") ? { to: flag(flags, "--to") } : {}),
        ...(flag(flags, "--app") ? { app: flag(flags, "--app") } : {}),
        ...(flag(flags, "--domain") ? { domain: flag(flags, "--domain") } : {}),
        ...(integer(flag(flags, "--limit"), "limit") !== undefined
          ? { limit: integer(flag(flags, "--limit"), "limit") }
          : {}),
      }
      printResult(environment, await environment.rpc("search", params), flags.has("--json"))
      return 0
    }
    case "read": {
      const { positionals, flags } = parse(args, ["--match", "--context"])
      requireCount(positionals, 1, command)
      const params = {
        id: positionals[0],
        ...(flag(flags, "--match") ? { match: flag(flags, "--match") } : {}),
        ...(integer(flag(flags, "--context"), "context") !== undefined
          ? { contextLines: integer(flag(flags, "--context"), "context") }
          : {}),
      }
      printResult(environment, await environment.rpc("read", params))
      return 0
    }
    case "memory": {
      const { positionals } = parse(args, [])
      if (positionals.length === 0) throw new TypeError("memory requires a query")
      printResult(
        environment,
        await environment.rpc("memorySearch", { query: positionals.join(" ") }),
      )
      return 0
    }
    case "pause": {
      const { positionals } = parse(args, [])
      if (positionals.length > 1) throw new TypeError("pause accepts one duration")
      const duration = positionals[0] ?? "forever"
      const durations: Readonly<Record<string, number>> = {
        "15m": PAUSE_15_MINUTES_MS,
        "30m": PAUSE_30_MINUTES_MS,
        "1h": HOUR_MS,
      }
      const params =
        duration === "forever"
          ? { until: PAUSE_INDEFINITE }
          : durations[duration] === undefined
            ? null
            : { durationMs: durations[duration] }
      if (params === null) throw new TypeError("pause duration must be 15m, 30m, 1h or forever")
      printResult(environment, await environment.rpc("pause", params))
      return 0
    }
    case "resume": {
      const { positionals } = parse(args, [])
      requireCount(positionals, 0, command)
      printResult(environment, await environment.rpc("resume", undefined))
      return 0
    }
    case "clear": {
      const { positionals, flags } = parse(args, [], ["--yes"])
      requireCount(positionals, 1, command)
      const target = positionals[0]
      if (!target || !["last10m", "lastHour", "today", "all"].includes(target))
        throw new TypeError("clear target must be last10m, lastHour, today or all")
      if (target === "all" && !flags.has("--yes")) {
        if (!(await environment.confirmClearAll?.())) {
          environment.write("Clear all cancelled. Use --yes for non-interactive use.")
          return 1
        }
      }
      printResult(environment, await environment.rpc("clear", { target }))
      return 0
    }
    case "digest": {
      const { positionals, flags } = parse(args, ["--day"])
      requireCount(positionals, 0, command)
      printResult(
        environment,
        await environment.rpc(
          "digest",
          flag(flags, "--day") ? { day: flag(flags, "--day") } : undefined,
        ),
      )
      return 0
    }
    case "doctor": {
      const { positionals } = parse(args, [])
      requireCount(positionals, 0, command)
      if (!environment.doctor) throw new TypeError("Doctor is unavailable")
      return environment.doctor()
    }
    default:
      throw new TypeError(`Unknown command: ${command ?? ""}`)
  }
}
