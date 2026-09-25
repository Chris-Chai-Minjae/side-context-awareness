import { expect, test } from "bun:test"
import { join } from "node:path"
import { z } from "zod"
import { RpcMethods, RpcResourceFieldSchemas } from "../../src/contracts/rpc"

test("Given the architecture API table, when methods are listed, then the contract has exactly those methods", async () => {
  const path = join(import.meta.dir, "..", "..", "docs", "planning", "02-architecture.md")
  const lines = (await Bun.file(path).text()).split("\n")
  const start = lines.findIndex((line) => line.startsWith("| 메서드 |"))
  expect(start).toBeGreaterThanOrEqual(0)
  const documented: string[] = []
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break
    const firstCell = line.split("|")[1] ?? ""
    for (const match of firstCell.matchAll(/`([^`]+)`/gu)) {
      if (match[1]) documented.push(match[1])
    }
  }
  expect(new Set(documented).size).toBe(documented.length)
  expect(Object.keys(RpcMethods).sort()).toEqual(documented.sort())
})

test("Given every resources.yaml field, when RPC output shapes are inspected, then each field is present", async () => {
  const path = join(import.meta.dir, "..", "..", "specs", "domain", "resources.yaml")
  const spec = z
    .object({
      resources: z.record(z.string(), z.object({ fields: z.record(z.string(), z.unknown()) })),
    })
    .parse(Bun.YAML.parse(await Bun.file(path).text()))
  for (const [resource, definition] of Object.entries(spec.resources)) {
    const schemas = RpcResourceFieldSchemas[resource]
    expect(schemas).toBeDefined()
    if (!schemas) continue
    const fields = new Set(schemas.flatMap((schema) => Object.keys(schema.shape)))
    for (const field of Object.keys(definition.fields)) {
      expect(fields.has(field)).toBe(true)
    }
  }
})

test("Given approved screen needs, when resource contracts are inspected, then every requested field exists", async () => {
  const indexPath = join(import.meta.dir, "..", "..", "specs", "screens", "index.yaml")
  const index = z
    .object({ screens: z.array(z.object({ id: z.string() })) })
    .parse(Bun.YAML.parse(await Bun.file(indexPath).text()))
  const schema = z.object({
    data_requirements: z.array(z.object({ resource: z.string(), needs: z.array(z.string()) })),
  })
  for (const screen of index.screens) {
    const path = join(import.meta.dir, "..", "..", "specs", "screens", `${screen.id}.yaml`)
    const spec = schema.parse(Bun.YAML.parse(await Bun.file(path).text()))
    for (const { resource, needs } of spec.data_requirements) {
      const outputs = RpcResourceFieldSchemas[resource]
      expect(outputs).toBeDefined()
      if (!outputs) continue
      const fields = new Set(outputs.flatMap((output) => Object.keys(output.shape)))
      for (const field of needs) expect(fields.has(field)).toBe(true)
    }
  }
})

test("Given RPC request boundaries, when invalid inputs are parsed, then they are rejected", () => {
  expect(RpcMethods.status.input.safeParse(undefined).success).toBe(true)
  expect(RpcMethods.requestPermissions.input.safeParse(undefined).success).toBe(true)
  expect(RpcMethods.digest.input.safeParse(undefined).success).toBe(true)
  expect(RpcMethods["pause"]?.input.safeParse({ until: 1, durationMs: 2 }).success).toBe(false)
  expect(RpcMethods["pause"]?.input.safeParse({ durationMs: 900_000 }).success).toBe(true)
  expect(RpcMethods["read"]?.input.safeParse({ id: "e:bad" }).success).toBe(false)
  expect(RpcMethods["settings.patch"]?.input.safeParse({ enabled: true }).success).toBe(true)
  expect(
    RpcMethods["settings.patch"]?.input.safeParse({ contextAwareness: { enabled: true } }).success,
  ).toBe(false)
  expect(RpcMethods["search"]?.input.safeParse({ queries: [] }).success).toBe(false)
  expect(RpcMethods["search"]?.input.safeParse({ queries: ["example"] }).success).toBe(true)
  expect(RpcMethods.memorySearch.input.safeParse({ query: "example", limit: 20 }).success).toBe(
    true,
  )
  expect(RpcMethods.memorySearch.input.safeParse({ query: "example", limit: 21 }).success).toBe(
    false,
  )
})
