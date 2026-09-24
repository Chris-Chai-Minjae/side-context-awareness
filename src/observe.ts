import { chmod, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { Config } from "./config"
import { normalizePageUrl, shouldCapture } from "./policy"
import type { Capture } from "./store"
import { TypedSentenceTracker } from "./typed"

const nativeDirectory = join(import.meta.dir, "..", "native")
const FrontWindowSchema = z.object({
  bundleId: z.string(),
  appName: z.string(),
  windowTitle: z.string(),
  windowId: z.number().int().nullable(),
  readableText: z.string().nullable(),
  focusedText: z.string().nullable(),
  focusedElementKey: z.string().nullable(),
  accessibilityAvailable: z.boolean(),
})
type FrontWindow = z.infer<typeof FrontWindowSchema>

const browserScripts: Readonly<Record<string, string>> = {
  "at.studio.AsideBrowser": 'tell application "Aside" to get URL of active tab of front window',
  "com.google.Chrome": 'tell application "Google Chrome" to get URL of active tab of front window',
  "com.apple.Safari": 'tell application "Safari" to get URL of current tab of front window',
  "company.thebrowser.Browser": 'tell application "Arc" to get URL of active tab of front window',
  "com.brave.Browser": 'tell application "Brave Browser" to get URL of active tab of front window',
  "com.microsoft.edgemac":
    'tell application "Microsoft Edge" to get URL of active tab of front window',
}

async function command(args: readonly string[], timeout = 5_000): Promise<string | null> {
  try {
    const process = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe", timeout })
    const output = new Response(process.stdout).text()
    const exit = await process.exited
    return exit === 0 ? await output : null
  } catch {
    return null
  }
}

export async function loadEncryptionKey(): Promise<Buffer> {
  const encoded = await command([join(nativeDirectory, "key")])
  if (!encoded)
    throw new Error("Unable to read encryption key from macOS Keychain; run bun run build")
  const key = Buffer.from(encoded.trim(), "base64")
  if (key.length !== 32) throw new Error("Invalid Keychain encryption key")
  return key
}

async function frontWindow(
  includeText: boolean,
  expectedBundle?: string,
  includeFields = false,
): Promise<FrontWindow | null> {
  const args = [join(nativeDirectory, "observe")]
  if (includeText) args.push("--text")
  if (includeFields) args.push("--include-fields")
  if (expectedBundle) args.push("--expect-bundle", expectedBundle)
  const output = await command(args)
  if (!output) return null
  try {
    return FrontWindowSchema.parse(JSON.parse(output))
  } catch {
    return null
  }
}

async function browserUrl(bundleId: string): Promise<string | null> {
  const script = browserScripts[bundleId]
  if (!script) return null
  const result = await command(["osascript", "-e", script], 3_000)
  return result ? normalizePageUrl(result.trim()) : null
}

export async function ocrImage(filename: string): Promise<string | null> {
  const canonical = await realpath(filename)
  const output = await command(["tesseract", canonical, "stdout", "-l", "eng+kor"], 15_000)
  return output?.trim() || null
}

async function windowOcr(windowId: number): Promise<string | null> {
  const temporary = await mkdtemp(join(tmpdir(), "local-context-ocr-"))
  await chmod(temporary, 0o700)
  const image = join(temporary, "window.png")
  try {
    const captured = await command(
      ["screencapture", "-x", "-l", String(windowId), "-t", "png", image],
      5_000,
    )
    if (captured === null) return null
    return await ocrImage(image)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export class Observer {
  private readonly typed = new TypedSentenceTracker()

  async capture(config: Config, now = Date.now()): Promise<readonly Capture[]> {
    if (
      !config.enabled ||
      config.pausedUntil === "indefinite" ||
      (typeof config.pausedUntil === "number" && now < config.pausedUntil)
    ) {
      this.typed.reset()
      return []
    }
    const metadata = await frontWindow(false)
    if (!metadata?.bundleId) return []
    const browser = Object.hasOwn(browserScripts, metadata.bundleId)
    const url = browser ? await browserUrl(metadata.bundleId) : null
    if (browser && !url) return []
    if (!shouldCapture(config, metadata.bundleId, url, now)) {
      this.typed.reset()
      return []
    }
    const content = await frontWindow(true, metadata.bundleId, config.captureTypedText)
    if (!content || content.windowId !== metadata.windowId) return []
    if (browser && (await browserUrl(metadata.bundleId)) !== url) return []

    const base = {
      capturedAt: now,
      bundleId: content.bundleId,
      appName: content.appName,
      windowTitle: content.windowTitle,
      url,
    }
    const captures: Capture[] = [{ ...base, kind: "window", text: "" }]
    const readable = content.readableText?.trim()
    if (readable) captures.push({ ...base, kind: "ax", text: readable })
    else if (config.screenOcr && content.windowId !== null) {
      const imageText = await windowOcr(content.windowId)
      if (imageText && (!browser || (await browserUrl(content.bundleId)) === url)) {
        captures.push({ ...base, kind: "ocr", text: imageText })
      }
    }
    if (config.captureTypedText) {
      const key =
        content.focusedElementKey &&
        `${content.bundleId}:${content.windowId}:${content.focusedElementKey}`
      for (const sentence of this.typed.observe(key, content.focusedText)) {
        captures.push({ ...base, kind: "typed", text: sentence })
      }
    } else this.typed.reset()
    return captures
  }
}
