import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { z } from "zod"
import { createEvidenceHandlers } from "../../src/api/resources/evidence"
import { createMemorySearchHandler } from "../../src/api/resources/memory"
import { startApiServer } from "../../src/api/server"
import { RpcMethods } from "../../src/contracts/rpc"
import { openLedger } from "../../src/ledger/schema"
import { EMBEDDING_MODEL_ID, EmbeddingManager } from "../../src/memory/embed"
import { openIndexDb } from "../../src/memory/index-db"
import {
  createSyntheticFixture,
  SYNTHETIC_TOPICS,
  syntheticEmbedder,
} from "./g7b-benchmark-fixture"

const WARMUP_CALLS = 8
const MEASURED_CALLS = 120
const CLIENT_NAME = "synthetic-benchmark"
const ROUTES = [
  {
    name: "history_search",
    arguments: (query: string) => ({ queries: [query], limit: 5 }),
    output: RpcMethods.search.output,
    thresholdMs: 300,
  },
  {
    name: "memory_search",
    arguments: (query: string) => ({ query, limit: 5 }),
    output: RpcMethods.memorySearch.output,
    thresholdMs: 500,
  },
] as const

const UsageSchema = z.strictObject({
  timestamp: z.number().int().nonnegative(),
  clientName: z.string(),
  tool: z.string(),
  resultCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
})
const ToolResponseSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
})

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new RangeError("Benchmark has no samples")
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

async function callRoute(
  client: Client,
  route: (typeof ROUTES)[number],
  query: string,
): Promise<number> {
  const started = performance.now()
  const response = await client.callTool({ name: route.name, arguments: route.arguments(query) })
  const elapsed = performance.now() - started
  const parsed = ToolResponseSchema.parse(response)
  if (parsed.isError) throw new Error(`${route.name} returned a tool error`)
  const content = parsed.content[0]
  if (!content) throw new Error(`${route.name} returned no text result`)
  const hits = route.output.parse(JSON.parse(content.text))
  if (hits.length === 0) throw new Error(`${route.name} returned no synthetic hits`)
  return elapsed
}

async function runBenchmark(realEmbedding: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "side-g7b-benchmark-"))
  const masterKey = Buffer.alloc(32, 0x42)
  const model = realEmbedding ? new EmbeddingManager(root) : null
  const sourceEmbedder = model ?? syntheticEmbedder
  let embeddingCalls = 0
  const embedder = {
    async embed(text: string): Promise<Float32Array> {
      embeddingCalls++
      return sourceEmbedder.embed(text)
    },
  }
  try {
    const modelWarmupStarted = performance.now()
    if (model) await model.embed(SYNTHETIC_TOPICS[0])
    const modelWarmupMs = rounded(performance.now() - modelWarmupStarted)
    const ledgerDb = openLedger(join(root, "ledger.db"))
    try {
      const indexDb = openIndexDb(join(root, "index.db"))
      try {
        const fixtureStarted = performance.now()
        const dataset = await createSyntheticFixture({
          root,
          ledgerDb,
          indexDb,
          masterKey,
          embedder,
        })
        const fixtureBuildMs = rounded(performance.now() - fixtureStarted)
        const indexedEmbeddings = embeddingCalls
        if (indexedEmbeddings !== dataset.chunks)
          throw new Error("Benchmark index embedding count does not match chunk count")
        const api = await startApiServer({
          directory: root,
          handlers: {
            ...createEvidenceHandlers({
              db: ledgerDb,
              getMasterKey: () => Buffer.from(masterKey),
              browserHistory: async () => [],
            }),
            memorySearch: createMemorySearchHandler({
              ledgerDb,
              getIndexDb: () => indexDb,
              embedder,
              dataDir: root,
              now: () => Date.now(),
            }),
          },
        })
        try {
          const client = new Client({ name: CLIENT_NAME, version: "1.0.0" })
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(import.meta.dir, "../../src/cli.ts"), "mcp"],
            env: {
              PATH: process.env["PATH"] ?? "/usr/bin:/bin",
              SIDE_DATA_DIR: root,
              LCA_DATA_DIR: root,
            },
            stderr: "pipe",
          })
          transport.stderr?.on("data", () => undefined)
          try {
            await client.connect(transport)
            for (let iteration = 0; iteration < WARMUP_CALLS; iteration++) {
              const query = SYNTHETIC_TOPICS[iteration % SYNTHETIC_TOPICS.length]
              if (query === undefined) throw new RangeError("Missing benchmark query")
              for (const route of ROUTES) await callRoute(client, route, query)
            }
            const samples = new Map(ROUTES.map((route) => [route.name, [] as number[]]))
            for (let iteration = 0; iteration < MEASURED_CALLS; iteration++) {
              const query = SYNTHETIC_TOPICS[iteration % SYNTHETIC_TOPICS.length]
              if (query === undefined) throw new RangeError("Missing benchmark query")
              for (const route of ROUTES) {
                const elapsed = await callRoute(client, route, query)
                samples.get(route.name)?.push(elapsed)
              }
            }
            const queryEmbeddings = embeddingCalls - indexedEmbeddings
            if (queryEmbeddings !== WARMUP_CALLS + MEASURED_CALLS)
              throw new Error("Benchmark query embedding count does not match MCP calls")

            const usage = readFileSync(join(root, "run", "mcp-usage.jsonl"), "utf8")
              .trim()
              .split("\n")
              .map((line) => UsageSchema.parse(JSON.parse(line)))
            const routes = ROUTES.map((route) => {
              const calls = usage.filter((record) => record.tool === route.name)
              const measured = calls.slice(WARMUP_CALLS)
              const roundTrips = samples.get(route.name) ?? []
              if (
                calls.length !== WARMUP_CALLS + MEASURED_CALLS ||
                measured.length !== MEASURED_CALLS ||
                roundTrips.length !== MEASURED_CALLS ||
                calls.some((call) => call.clientName !== CLIENT_NAME || call.resultCount === 0)
              )
                throw new Error(`${route.name} MCP usage log is incomplete`)
              const logged = measured.map((call) => call.latencyMs)
              const roundTripP95 = percentile(roundTrips, 0.95)
              const loggedP95 = percentile(logged, 0.95)
              return {
                name: route.name,
                warmupCalls: WARMUP_CALLS,
                measuredCalls: MEASURED_CALLS,
                thresholdMs: route.thresholdMs,
                roundTripP50Ms: rounded(percentile(roundTrips, 0.5)),
                roundTripP95Ms: rounded(roundTripP95),
                mcpLogP95Ms: rounded(loggedP95),
                passed: roundTripP95 <= route.thresholdMs && loggedP95 <= route.thresholdMs,
              }
            })
            const passed = routes.every((route) => route.passed)
            console.log(
              JSON.stringify({
                status: passed ? "pass" : "fail",
                dataset,
                workload: {
                  queries: SYNTHETIC_TOPICS,
                  callsPerQueryPerRoute: MEASURED_CALLS / SYNTHETIC_TOPICS.length,
                },
                scope: realEmbedding
                  ? "synthetic MCP stdio + UDS + real search handlers and SQLite; MiniLM q8 indexed vectors and query inference"
                  : "synthetic MCP stdio + UDS + real search handlers and SQLite; deterministic embedding, no model inference",
                ...(realEmbedding
                  ? {
                      embedding: {
                        modelId: EMBEDDING_MODEL_ID,
                        dtype: "q8",
                        modelWarmupCalls: 1,
                        modelWarmupMs,
                        fixtureBuildMs,
                        indexedEmbeddings,
                        queryEmbeddings,
                      },
                    }
                  : {}),
                routes,
              }),
            )
            if (!passed) process.exitCode = 1
          } finally {
            await client.close()
            await transport.close()
          }
        } finally {
          await api.stop()
        }
      } finally {
        indexDb.close()
      }
    } finally {
      ledgerDb.close()
    }
  } finally {
    try {
      await model?.close()
    } finally {
      masterKey.fill(0)
      rmSync(root, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  try {
    await runBenchmark(process.argv.includes("--real-embedding"))
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "error",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    )
    process.exitCode = 1
  }
}
