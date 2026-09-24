import { randomUUID } from "node:crypto"
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ContextStore } from "./store"

function localDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function pageDirectory(directory: string): string {
  return join(directory, "memory", "episodic")
}

export async function renderDayPage(
  store: ContextStore,
  directory: string,
  day: string,
): Promise<void> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day)
  if (!match) throw new Error("Invalid local day")
  const year = Number(match[1])
  const month = Number(match[2])
  const date = Number(match[3])
  const from = new Date(year, month - 1, date).getTime()
  const to = new Date(year, month - 1, date + 1).getTime()
  const summaries = store.summariesBetween(from, to).filter((summary) => summary.kind === "10min")
  const folder = pageDirectory(directory)
  const filename = join(folder, `context-awareness-${day}.md`)
  if (summaries.length === 0) {
    await rm(filename, { force: true })
    return
  }
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700)
  const sections = summaries.map((summary) => {
    const start = new Date(summary.windowFrom).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    })
    const end = new Date(summary.windowTo).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    })
    const citations = summary.sourceIds.map((id) => `e:${id}`).join(", ")
    return `### ${start}–${end} ${summary.title} s:${summary.id}\n\n${summary.body}\n\nSources: ${citations}`
  })
  const text = `---\nrender: 1\nupdated_at: ${new Date().toISOString()}\n---\n\n# Context awareness ${day}\n\n${sections.join("\n\n")}\n`
  const temporary = join(folder, `.context-awareness-${randomUUID()}.tmp`)
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" })
  await rename(temporary, filename)
}

export async function renderAllDayPages(store: ContextStore, directory: string): Promise<void> {
  for (const day of new Set(store.summaryStarts().map(localDate)))
    await renderDayPage(store, directory, day)
}

export async function removeAllDayPages(directory: string): Promise<void> {
  const folder = pageDirectory(directory)
  let entries: string[]
  try {
    entries = await readdir(folder)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
  for (const entry of entries) {
    if (/^context-awareness-\d{4}-\d{2}-\d{2}\.md$/u.test(entry)) await rm(join(folder, entry))
  }
}
