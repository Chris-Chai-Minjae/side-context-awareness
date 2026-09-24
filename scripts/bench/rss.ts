import { positiveInteger, psValue } from "./cpu"

export function parsePsRss(output: string): number {
  const kib = Number(output.trim())
  if (!Number.isFinite(kib) || kib <= 0) throw new RangeError("Invalid ps RSS sample")
  return kib / 1024
}

export async function sampleRss(
  pid: number,
  durationMs: number,
  intervalMs: number,
): Promise<{ readonly peakMiB: number; readonly meanMiB: number; readonly samples: number }> {
  const values: number[] = []
  const deadline = performance.now() + durationMs
  do {
    values.push(parsePsRss(psValue(pid, "rss")))
    if (performance.now() >= deadline) break
    await Bun.sleep(Math.min(intervalMs, Math.max(0, deadline - performance.now())))
  } while (performance.now() < deadline)
  return {
    peakMiB: Math.max(...values),
    meanMiB: values.reduce((sum, value) => sum + value, 0) / values.length,
    samples: values.length,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string): string | undefined => args[args.indexOf(name) + 1]
  const daemonPid = positiveInteger(option("--daemon-pid"), "daemon pid")
  const seconds = args.includes("--seconds") ? positiveInteger(option("--seconds"), "seconds") : 600
  const intervalMs = args.includes("--interval-ms")
    ? positiveInteger(option("--interval-ms"), "interval ms")
    : 1000
  const daemon = await sampleRss(daemonPid, seconds * 1000, intervalMs)
  console.log(JSON.stringify({ scope: "live-process", durationSeconds: seconds, daemon }))
}
