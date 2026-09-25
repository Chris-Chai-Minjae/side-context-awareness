import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { ASIDE_ADAPTER_FAILURE_LIMIT, ASIDE_REPL_TIMEOUT_MS } from "../constants"
import { normalizePageUrl } from "../policy/url"
import { suppressAriaFields } from "./aria-fields"

const ASIDE_BUNDLE_ID = "at.studio.AsideBrowser"
const OUTPUT_MARKER = "SIDE_ASIDE_SNAPSHOT "
const REPL_CODE = `
const before = (await listBrowserTabs()).find((tab) => tab.active);
if (!before?.targetId || !before?.url) throw new Error("Active tab identity unavailable");
await attachBrowserTab(before.targetId);
const aria = await snapshot(page);
const attachedUrl = page.url();
const after = (await listBrowserTabs()).find((tab) => tab.active);
console.log("${OUTPUT_MARKER}" + JSON.stringify({
  kind: "snapshot", content: aria.tree,
  beforeTabId: before.targetId, beforeUrl: before.url,
  afterTabId: after?.targetId, afterUrl: after?.url, attachedUrl,
}));
`

const OutputSchema = z.strictObject({
  kind: z.literal("snapshot"),
  content: z.string().min(1),
  beforeTabId: z.string().min(1),
  beforeUrl: z.url(),
  afterTabId: z.string().min(1),
  afterUrl: z.url(),
  attachedUrl: z.url(),
})

export type AsideAdapterHealth = "off" | "available" | "unavailable" | "error"

export type AsideSnapshot = {
  readonly source: "aside_dom"
  readonly shape: "aria"
  readonly content: string
  readonly rawUrl: string
  readonly suppressedFields?: number
}

export type AsideCommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>

export type AsideCaptureOptions<Fallback> = {
  readonly enabled: boolean
  readonly foregroundBundleId: string | null
  readonly expectedNormalizedUrl: string
  readonly captureAx: () => Promise<Fallback>
}

export class AsideOutputError extends Error {
  readonly name = "AsideOutputError"
  constructor() {
    super("Aside REPL returned an invalid snapshot")
  }
}

const execFileAsync = promisify(execFile)

export function resolveAsideExecutable(
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  return (
    [join(home, ".local/bin/aside"), "/usr/local/bin/aside", "/opt/homebrew/bin/aside"].find(
      exists,
    ) ?? "aside"
  )
}

async function runAsideCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    command === "aside" ? resolveAsideExecutable() : command,
    [...args],
    {
      timeout: timeoutMs,
      encoding: "utf8",
    },
  )
  return stdout
}

function parseSnapshot(stdout: string, expectedNormalizedUrl: string): AsideSnapshot {
  const marked = stdout.split(/\r?\n/u).filter((line) => line.startsWith(OUTPUT_MARKER))
  if (marked.length !== 1) throw new AsideOutputError()
  const line = marked[0]
  if (line === undefined) throw new AsideOutputError()
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(OUTPUT_MARKER.length))
  } catch (error) {
    if (error instanceof SyntaxError) throw new AsideOutputError()
    throw error
  }
  const parsed = OutputSchema.safeParse(raw)
  if (!parsed.success) throw new AsideOutputError()
  const snapshot = parsed.data
  if (
    snapshot.beforeTabId !== snapshot.afterTabId ||
    normalizePageUrl(snapshot.beforeUrl) !== expectedNormalizedUrl ||
    snapshot.afterUrl !== snapshot.beforeUrl ||
    snapshot.attachedUrl !== snapshot.beforeUrl
  )
    throw new AsideOutputError()
  const safe = suppressAriaFields(snapshot.content)
  return {
    source: "aside_dom",
    shape: "aria",
    content: safe.tree,
    rawUrl: snapshot.beforeUrl,
    ...(safe.suppressed > 0 ? { suppressedFields: safe.suppressed } : {}),
  }
}

export class AsideDomAdapter {
  private state: AsideAdapterHealth = "off"
  private failures = 0

  constructor(private readonly runCommand: AsideCommandRunner = runAsideCommand) {}

  get health(): AsideAdapterHealth {
    return this.state
  }

  async capture<Fallback>(
    options: AsideCaptureOptions<Fallback>,
  ): Promise<AsideSnapshot | Fallback> {
    if (!options.enabled) {
      this.state = "off"
      this.failures = 0
      return options.captureAx()
    }
    if (options.foregroundBundleId !== ASIDE_BUNDLE_ID) return options.captureAx()

    try {
      const stdout = await this.runCommand("aside", ["repl", REPL_CODE], ASIDE_REPL_TIMEOUT_MS)
      const snapshot = parseSnapshot(stdout, options.expectedNormalizedUrl)
      this.failures = 0
      this.state = "available"
      return snapshot
    } catch (error) {
      if (!(error instanceof Error)) throw error
      if ("code" in error && error.code === "ENOENT") {
        this.failures = 0
        this.state = "unavailable"
      } else {
        this.failures++
        this.state = this.failures >= ASIDE_ADAPTER_FAILURE_LIMIT ? "error" : "unavailable"
      }
      return options.captureAx()
    }
  }
}
