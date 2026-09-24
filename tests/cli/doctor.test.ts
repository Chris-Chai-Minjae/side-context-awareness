import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDoctor } from "../../src/cli/doctor"

test("Given a missing custom SQLite path, doctor reports FAIL, remediation, and exit 1", async () => {
  const lines: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => false,
    checkVec0: () => false,
    checkModelCache: () => true,
    async rpc(method) {
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions")
        return { accessibility: true, input_monitoring: true, screen_recording: true }
      if (method === "settings.get") return { screen_ocr: false, providers: [] }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(1)
  expect(lines.join("\n")).toContain("FAIL custom SQLite")
  expect(lines.join("\n")).toContain("Install or bundle libsqlite3.dylib")
  expect(lines.join("\n")).toContain("SKIP provider connection")
})

test("Given connected helper, permissions, cache, SQLite, vec0 and a synthetic provider probe, doctor passes", async () => {
  const calls: string[] = []
  const lines: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => true,
    checkVec0: () => true,
    checkModelCache: () => true,
    async rpc(method, params) {
      calls.push(method)
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions")
        return { accessibility: true, input_monitoring: true, screen_recording: true }
      if (method === "settings.get")
        return {
          screen_ocr: true,
          providers: [{ id: "synthetic", has_key: true, models: ["probe-model"] }],
        }
      if (method === "providers.test") {
        expect(params).toEqual({ providerId: "synthetic", modelId: "probe-model" })
        return { ok: true, toolChoiceSupported: true }
      }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(0)
  expect(calls).toEqual(["status", "settings.get", "permissions", "providers.test"])
  expect(lines.filter((line) => line.startsWith("PASS"))).toHaveLength(6)
})

test("Given missing required TCC permissions, doctor fails without requesting them", async () => {
  const lines: string[] = []
  const calls: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => true,
    checkVec0: () => true,
    checkModelCache: () => true,
    async rpc(method) {
      calls.push(method)
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions")
        return { accessibility: false, input_monitoring: true, screen_recording: false }
      if (method === "settings.get") return { screen_ocr: false, providers: [] }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(1)
  expect(lines.join("\n")).toContain("FAIL permissions")
  expect(calls).not.toContain("requestPermissions")
})

test("Given an isolated empty Side root, the real CLI doctor exits 1 without creating a ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "side-cli-doctor-process-"))
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "src/cli.ts", "doctor"],
      env: { ...process.env, SIDE_DATA_DIR: directory, LCA_DATA_DIR: directory },
      stdin: "ignore",
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("FAIL Keychain")
    expect(result.stdout.toString()).toContain("FAIL model cache")
    expect(existsSync(join(directory, "context-awareness", "ledger.db"))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
