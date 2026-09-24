import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { RpcMethods } from "../../contracts/rpc"
import { AgentConnectionSchema, McpUsageSchema } from "../../contracts/rpc-resources"

const UsageRecordSchema = z.strictObject({
  timestamp: z.number().int().nonnegative(),
  clientName: z.string().min(1),
  tool: z.enum(["history_search", "history_read", "memory_search"]),
  resultCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
})

type UsageRecord = z.infer<typeof UsageRecordSchema>
type McpUsageResult = z.output<(typeof RpcMethods)["mcp.usage"]["output"]>

function shellQuoted(path: string): string {
  return `"${path.replace(/[\\"$`]/gu, "\\$&")}"`
}

export function agentConnectionResource(binaryPath: string) {
  return AgentConnectionSchema.parse({
    binary_path: binaryPath,
    claude_code_command: `claude mcp add side -- ${shellQuoted(binaryPath)} mcp`,
    mcp_json_snippet: JSON.stringify(
      { mcpServers: { side: { command: binaryPath, args: ["mcp"] } } },
      null,
      2,
    ),
  })
}

async function readUsage(directory: string): Promise<readonly UsageRecord[]> {
  let content: string
  try {
    content = await readFile(join(directory, "run", "mcp-usage.jsonl"), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  const rows: UsageRecord[] = []
  for (const line of content.split("\n")) {
    if (!line) continue
    try {
      const parsed = UsageRecordSchema.safeParse(JSON.parse(line))
      if (parsed.success) rows.push(parsed.data)
    } catch {
      // no-excuse-ok: catch -- ignore an interrupted or malformed metadata-only log line.
    }
  }
  return rows
}

export function createMcpUsageHandlers(dependencies: { readonly directory: string }): {
  readonly "mcp.usage": (params: unknown) => Promise<McpUsageResult>
} {
  return {
    async "mcp.usage"(params) {
      const { sinceMs } = RpcMethods["mcp.usage"].input.parse(params)
      const groups = new Map<
        string,
        { calls: Record<string, number>; latency: number; count: number }
      >()
      for (const row of await readUsage(dependencies.directory)) {
        if (row.timestamp < sinceMs) continue
        const group = groups.get(row.clientName) ?? { calls: {}, latency: 0, count: 0 }
        group.calls[row.tool] = (group.calls[row.tool] ?? 0) + 1
        group.latency += row.latencyMs
        group.count++
        groups.set(row.clientName, group)
      }
      return [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([clientName, group]) =>
          McpUsageSchema.parse({
            client_name: clientName,
            calls: group.calls,
            avg_latency_ms: Math.round(group.latency / group.count),
          }),
        )
    },
  }
}
