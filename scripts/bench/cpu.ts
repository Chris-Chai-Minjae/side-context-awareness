import { spawnSync } from "node:child_process"

export function parsePsCpu(output: string): number {
  const value = Number(output.trim())
  if (!Number.isFinite(value) || value < 0 || output.trim() === "") {
    throw new RangeError("Invalid ps CPU sample")
  }
  return value
}

export function mean(samples: readonly number[]): number {
  if (samples.length === 0) throw new RangeError("No CPU samples")
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length
}

export function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RangeError(`Invalid ${name}`)
  return parsed
}

export function psValue(pid: number, column: "%cpu" | "rss"): string {
  const result = spawnSync("ps", ["-p", String(pid), "-o", `${column}=`], { encoding: "utf8" })
  if (result.status !== 0 || result.stdout.trim() === "") {
    throw new Error(`Process ${pid} unavailable for ${column}`)
  }
  return result.stdout
}

export async function sampleCpu(
  pid: number,
  durationMs: number,
  intervalMs: number,
): Promise<{ readonly meanPercent: number; readonly samples: number }> {
  const values: number[] = []
  const deadline = performance.now() + durationMs
  do {
    values.push(parsePsCpu(psValue(pid, "%cpu")))
    if (performance.now() >= deadline) break
    await Bun.sleep(Math.min(intervalMs, Math.max(0, deadline - performance.now())))
  } while (performance.now() < deadline)
  return { meanPercent: mean(values), samples: values.length }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string): string | undefined => args[args.indexOf(name) + 1]
  const daemonPid = positiveInteger(option("--daemon-pid"), "daemon pid")
  const appPid = positiveInteger(option("--app-pid"), "app pid")
  const seconds = args.includes("--seconds") ? positiveInteger(option("--seconds"), "seconds") : 600
  const intervalMs = args.includes("--interval-ms")
    ? positiveInteger(option("--interval-ms"), "interval ms")
    : 1000
  const [daemon, app] = await Promise.all([
    sampleCpu(daemonPid, seconds * 1000, intervalMs),
    sampleCpu(appPid, seconds * 1000, intervalMs),
  ])
  console.log(JSON.stringify({ scope: "live-process", durationSeconds: seconds, daemon, app }))
}
