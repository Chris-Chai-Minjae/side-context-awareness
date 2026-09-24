import type { Database } from "bun:sqlite"
import { z } from "zod"
import { CHILD_BODY_BYTES } from "../constants"
import type { Briefing } from "./briefing"

type ChildSummary = {
  readonly id: string
  readonly window_from: number
  readonly window_to: number
  readonly title: string
  readonly description: string
  readonly body: string | null
  readonly apps: string
  readonly domains: string
}

const Strings = z.array(z.string())

function headBytes(value: string, limit: number): string {
  let bytes = 0
  let head = ""
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > limit) break
    head += character
    bytes += size
  }
  return head
}

function timeLabel(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function assembleRollupBriefing(db: Database, from: number, to: number): Briefing {
  const children = db
    .query<ChildSummary, [number, number]>(`
      SELECT id, window_from, window_to, title, description, body, apps, domains
      FROM context_awareness_summaries
      WHERE kind = '10min' AND status = 'done'
        AND window_from >= ? AND window_to <= ?
      ORDER BY window_from, id
    `)
    .all(from, to)
  const evidenceIds = new Set<string>()
  const apps = new Set<string>()
  const domains = new Set<string>()
  const lines: string[] = []
  for (const child of children) {
    const ref = `s:${child.id}`
    evidenceIds.add(ref)
    for (const app of Strings.parse(JSON.parse(child.apps))) apps.add(app)
    for (const domain of Strings.parse(JSON.parse(child.domains))) domains.add(domain)
    lines.push(
      `[${timeLabel(child.window_from)}–${timeLabel(child.window_to)}] ${child.title}  ${ref}`,
      `Description: ${Strings.parse(JSON.parse(child.description)).join(" ")}`,
      `Body: ${headBytes(child.body ?? "", CHILD_BODY_BYTES)}`,
    )
  }
  return { text: lines.join("\n"), evidenceIds, apps, domains }
}
