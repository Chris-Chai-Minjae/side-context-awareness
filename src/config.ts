import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const ConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  pausedUntil: z.number().int().nonnegative().or(z.literal("indefinite")).nullable(),
  deniedApps: z.array(z.string().regex(/^[A-Za-z0-9.-]+$/)).max(100),
  deniedWebsites: z.array(z.string().regex(/^[A-Za-z0-9.-]+$/)).max(100),
  screenOcr: z.boolean(),
  captureTypedText: z.boolean(),
  summaryModel: z.string().min(1).nullable(),
  embeddingModel: z.string().min(1).nullable(),
  retentionDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]),
  intervalSeconds: z.number().int().min(1).max(600),
})

export type Config = z.infer<typeof ConfigSchema>

const DEFAULT_CONFIG: Config = {
  version: 1,
  enabled: false,
  pausedUntil: null,
  deniedApps: [],
  deniedWebsites: [],
  screenOcr: false,
  captureTypedText: false,
  summaryModel: null,
  embeddingModel: null,
  retentionDays: 14,
  intervalSeconds: 2,
}

export function dataDirectory(): string {
  return (
    process.env["LCA_DATA_DIR"] ??
    join(homedir(), "Library", "Application Support", "Local Context Awareness")
  )
}

export async function loadConfig(directory: string): Promise<Config> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const filename = join(directory, "config.json")
  try {
    const raw: unknown = JSON.parse(await readFile(filename, "utf8"))
    return ConfigSchema.parse(raw)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    await writeFile(filename, JSON.stringify(DEFAULT_CONFIG, null, 2), { mode: 0o600, flag: "wx" })
    return DEFAULT_CONFIG
  }
}

export async function saveConfig(directory: string, config: Config): Promise<void> {
  const parsed = ConfigSchema.parse(config)
  const temporary = join(directory, `config-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(parsed, null, 2), { mode: 0o600, flag: "wx" })
  await rename(temporary, join(directory, "config.json"))
}
