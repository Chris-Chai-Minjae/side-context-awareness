import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { z } from "zod"

const Ready = z.object({
  status: z.literal("ready"),
  root: z.string(),
  socketPath: z.string(),
  fixturePreflight: z.literal("pass"),
  expectedRef: z.string().startsWith("e:"),
  registration: z.object({ command: z.string(), args: z.array(z.string()) }),
})

function payload(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const [item] = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(result.content)
  if (!item) throw new Error("Missing MCP text result")
  const opening = /^<untrusted-evidence nonce="([0-9a-f]{32})">/u.exec(item.text)
  const closing = `</untrusted-evidence nonce="${opening?.[1]}">`
  if (!opening || !item.text.endsWith(closing)) throw new Error("Missing evidence boundary")
  return JSON.parse(item.text.slice(opening[0].length, -closing.length))
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`Given a synthetic Aside fixture, when MCP queries and ${signal} run, then its isolated root is removed`, async () => {
    const script = join(import.meta.dir, "..", "..", "scripts", "gates", "p3-aside-fixture.ts")
    const fixture = Bun.spawn([process.execPath, script], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = fixture.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    let root = ""
    try {
      while (!output.includes("\n")) {
        const next = await reader.read()
        if (next.done) throw new Error("Fixture exited before ready")
        output += decoder.decode(next.value)
      }
      const ready = Ready.parse(JSON.parse(output.split("\n")[0] ?? ""))
      root = ready.root
      expect(root.startsWith(`${tmpdir()}${sep}`)).toBe(true)
      expect(existsSync(join(root, "side-data", "ledger.db"))).toBe(true)
      expect(existsSync(ready.socketPath)).toBe(true)
      expect(ready.registration.args).toEqual([])
      expect(ready.registration.command.startsWith(`${root}${sep}`)).toBe(true)
      const wrapper = readFileSync(ready.registration.command, "utf8")
      expect(wrapper).toContain("SIDE_DATA_DIR=")
      expect(wrapper).toContain(" mcp")

      const client = new Client({ name: "fixture-gate", version: "1.0.0" })
      const transport = new StdioClientTransport({
        command: ready.registration.command,
        args: ready.registration.args,
        stderr: "pipe",
      })
      try {
        await client.connect(transport)
        const search = await client.callTool({
          name: "history_search",
          arguments: { queries: ["sqlite", "확장", "문서"], limit: 5 },
        })
        expect(search.isError).toBeFalsy()
        const hits = z.array(z.object({ ref: z.string() })).parse(payload(search))
        expect(hits.map((hit) => hit.ref)).toContain(ready.expectedRef)
        const read = await client.callTool({
          name: "history_read",
          arguments: { id: ready.expectedRef },
        })
        expect(read.isError).toBeFalsy()
        expect(
          z.object({ id: z.string(), expired: z.literal(false) }).parse(payload(read)).id,
        ).toBe(ready.expectedRef)
      } finally {
        await client.close()
        await transport.close()
      }
    } finally {
      fixture.kill(signal)
      const exitCode = await fixture.exited
      if (root) {
        expect(exitCode).toBe(0)
        expect(existsSync(root)).toBe(false)
      }
      reader.releaseLock()
    }
  }, 20_000)
}
