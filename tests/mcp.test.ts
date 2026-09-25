import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

test("Given an absent daemon, when the MCP entrypoint connects, then it serves the approved tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-mcp-"))
  const client = new Client({ name: "local-context-smoke", version: "0.1.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "..", "src", "mcp.ts")],
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      SIDE_DATA_DIR: directory,
      LCA_DATA_DIR: directory,
    },
  })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "history_read",
      "history_search",
      "memory_search",
    ])
    const result = await client.callTool({
      name: "history_search",
      arguments: { queries: ["synthetic"] },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "Side is not running. Open Side.app." }])
  } finally {
    await client.close()
    await transport.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
