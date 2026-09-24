import { execFile } from "node:child_process"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"

const execFileAsync = promisify(execFile)
const REPETITIONS = 100
const ASIDE_BUNDLE_ID = "at.studio.AsideBrowser"
const SESSIONS_DIR = join(homedir(), ".aside", "u", "0", "sessions")
const MARKER = "S1_METRIC "

// The REPL intentionally emits only counts, booleans, and elapsed time.
const REPL_CODE = `
try {
  const started = performance.now();
  const before = await listBrowserTabs();
  const activeBefore = before.find((tab) => tab.active)?.targetId ?? null;
  await attachActiveBrowserTab();
  await snapshot(page);
  const durationMs = performance.now() - started;
  const after = await listBrowserTabs();
  const activeAfter = after.find((tab) => tab.active)?.targetId ?? null;
  const beforeIds = before.map((tab) => tab.targetId).sort().join("|");
  const afterIds = after.map((tab) => tab.targetId).sort().join("|");
  console.log("${MARKER}" + JSON.stringify({
    kind: "ok",
    durationMs,
    tabCountBefore: before.length,
    tabCountAfter: after.length,
    activeChanged: activeBefore !== activeAfter,
    membershipChanged: beforeIds !== afterIds,
  }));
} catch (error) {
  console.log("${MARKER}" + JSON.stringify({
    kind: "error",
    errorName: error instanceof Error ? error.name : "UnknownError",
  }));
}
`

const metricSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    durationMs: z.number().finite().nonnegative(),
    tabCountBefore: z.number().int().nonnegative(),
    tabCountAfter: z.number().int().nonnegative(),
    activeChanged: z.boolean(),
    membershipChanged: z.boolean(),
  }),
  z.object({ kind: z.literal("error"), errorName: z.string() }),
])

type Metric = z.infer<typeof metricSchema>

const FOCUS_WATCHER = `
import AppKit
let workspace = NSWorkspace.shared
let observer = workspace.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification,
  object: nil,
  queue: nil
) { note in
  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  print(app?.bundleIdentifier == "${ASIDE_BUNDLE_ID}" ? "ASIDE" : "OTHER")
  fflush(stdout)
}
print(workspace.frontmostApplication?.bundleIdentifier == "${ASIDE_BUNDLE_ID}" ? "READY:ASIDE" : "READY:OTHER")
fflush(stdout)
withExtendedLifetime(observer) { RunLoop.current.run() }
`

type FocusObservation = {
  readonly ready: boolean
  readonly initiallyAside: boolean
  readonly otherActivations: number
  readonly asideActivations: number
  readonly stop: () => Promise<void>
}

async function startFocusWatcher(): Promise<FocusObservation> {
  const child = Bun.spawn(["swift", "-e", FOCUS_WATCHER], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  let ready = false
  let initiallyAside = false
  let otherActivations = 0
  let asideActivations = 0
  let resolveReady: (value: boolean) => void = () => undefined
  const readyPromise = new Promise<boolean>((resolve) => {
    resolveReady = resolve
  })
  const readTask = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    while (true) {
      const result = await reader.read()
      if (result.done) break
      pending += decoder.decode(result.value)
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) {
        if (line === "READY:ASIDE" || line === "READY:OTHER") {
          ready = true
          initiallyAside = line === "READY:ASIDE"
          resolveReady(true)
        } else if (line === "ASIDE") {
          asideActivations++
        } else if (line === "OTHER") {
          otherActivations++
        }
      }
    }
    resolveReady(false)
  })()
  const didStart = await Promise.race([readyPromise, Bun.sleep(10_000).then(() => false)])
  if (!didStart) {
    child.kill()
    await readTask
  }
  return {
    get ready() {
      return ready
    },
    get initiallyAside() {
      return initiallyAside
    },
    get otherActivations() {
      return otherActivations
    },
    get asideActivations() {
      return asideActivations
    },
    async stop() {
      if (didStart) child.kill()
      await readTask
    },
  }
}

async function sessionEntries(): Promise<Set<string>> {
  return new Set(await readdir(SESSIONS_DIR))
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
}

async function frontmostIsAside(): Promise<boolean> {
  const { stdout } = await execFileAsync("swift", [
    "-e",
    `import AppKit; print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "${ASIDE_BUNDLE_ID}")`,
  ])
  return stdout.trim() === "true"
}

async function runRepl(): Promise<{ readonly metric: Metric | null; readonly wallMs: number }> {
  const started = performance.now()
  try {
    const { stdout } = await execFileAsync("aside", ["repl", REPL_CODE], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    })
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(MARKER))
    const parsed = line ? metricSchema.safeParse(JSON.parse(line.slice(MARKER.length))) : null
    return { metric: parsed?.success ? parsed.data : null, wallMs: performance.now() - started }
  } catch {
    // no-excuse-ok: catch — CLI boundary records a failed attempt without exposing stderr.
    return { metric: null, wallMs: performance.now() - started }
  }
}

async function main(): Promise<void> {
  const { stdout: version } = await execFileAsync("aside", ["--version"])
  await execFileAsync("osascript", ["-e", `tell application id "${ASIDE_BUNDLE_ID}" to activate`])
  const watcher = await startFocusWatcher()
  const sessionsBefore = await sessionEntries()
  const startedAt = new Date().toISOString()
  const metrics: Metric[] = []
  const wallTimes: number[] = []
  try {
    for (let index = 0; index < REPETITIONS; index++) {
      const result = await runRepl()
      wallTimes.push(result.wallMs)
      if (result.metric) metrics.push(result.metric)
    }
    await Bun.sleep(2_000)
  } finally {
    await watcher.stop()
  }
  const sessionsAfter = await sessionEntries()
  const successes = metrics.filter((metric) => metric.kind === "ok")
  const workflowTimes = successes.map((metric) => metric.durationMs)
  const addedSessions = [...sessionsAfter].filter((entry) => !sessionsBefore.has(entry)).length
  const removedSessions = [...sessionsBefore].filter((entry) => !sessionsAfter.has(entry)).length
  const finalAside = await frontmostIsAside()
  const result = {
    spike: "S-1",
    startedAt,
    finishedAt: new Date().toISOString(),
    asideVersion: version.trim(),
    repetitions: REPETITIONS,
    successfulSnapshots: successes.length,
    replErrors: metrics.filter((metric) => metric.kind === "error").length,
    missingOrInvalidMetrics: REPETITIONS - metrics.length,
    sessionEntriesBefore: sessionsBefore.size,
    sessionEntriesAfter: sessionsAfter.size,
    sessionDelta: sessionsAfter.size - sessionsBefore.size,
    addedSessions,
    removedSessions,
    focusWatcherReady: watcher.ready,
    initiallyAside: watcher.initiallyAside,
    finallyAside: finalAside,
    otherAppActivations: watcher.otherActivations,
    asideActivations: watcher.asideActivations,
    tabCountChanges: successes.filter((metric) => metric.tabCountBefore !== metric.tabCountAfter)
      .length,
    activeTabChanges: successes.filter((metric) => metric.activeChanged).length,
    tabMembershipChanges: successes.filter((metric) => metric.membershipChanged).length,
    workflowP50Ms: percentile(workflowTimes, 0.5),
    workflowP95Ms: percentile(workflowTimes, 0.95),
    spawnIncludedP50Ms: percentile(wallTimes, 0.5),
    spawnIncludedP95Ms: percentile(wallTimes, 0.95),
  }
  console.log(JSON.stringify(result, null, 2))
}

await main()
