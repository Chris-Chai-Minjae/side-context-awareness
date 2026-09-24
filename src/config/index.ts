import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../constants"
import { type Settings, SettingsSchema } from "../contracts/settings"
import { migrateConfig } from "./migrate"

export function dataDirectory(): string {
  return process.env["SIDE_DATA_DIR"] ?? join(homedir(), "Library", "Application Support", "Side")
}

function legacyDataDirectory(): string {
  return (
    process.env["LCA_DATA_DIR"] ??
    join(homedir(), "Library", "Application Support", "Local Context Awareness")
  )
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(directory, PRIVATE_DIRECTORY_MODE)
}

async function readJsonIfPresent(filename: string): Promise<unknown | undefined> {
  let content: string
  try {
    content = await readFile(filename, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
  return JSON.parse(content)
}

export async function loadSettings(
  directory = dataDirectory(),
  legacyDirectory = legacyDataDirectory(),
): Promise<Settings> {
  await ensurePrivateDirectory(directory)
  const filename = join(directory, "settings.json")
  const current = await readJsonIfPresent(filename)
  if (current !== undefined) {
    const parsed = SettingsSchema.parse(current)
    await chmod(filename, PRIVATE_FILE_MODE)
    return parsed
  }

  const legacy = await readJsonIfPresent(join(legacyDirectory, "config.json"))
  const settings =
    legacy === undefined
      ? SettingsSchema.parse({ version: 2, contextAwareness: {} })
      : migrateConfig(legacy)
  await saveSettings(directory, settings)
  return settings
}

export async function saveSettings(directory: string, settings: Settings): Promise<void> {
  const parsed = SettingsSchema.parse(settings)
  await ensurePrivateDirectory(directory)
  const temporary = join(directory, `.settings-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(parsed, null, 2), {
      mode: PRIVATE_FILE_MODE,
      flag: "wx",
    })
    await rename(temporary, join(directory, "settings.json"))
    await chmod(join(directory, "settings.json"), PRIVATE_FILE_MODE)
  } finally {
    await rm(temporary, { force: true })
  }
}
