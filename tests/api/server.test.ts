import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleRpcBody } from "../../src/api/rpc"
import { type ApiServer, startApiServer } from "../../src/api/server"
import { API_MAX_REQUEST_BYTES, API_TOKEN_BYTES } from "../../src/constants"

const resumeRequest = JSON.stringify({ jsonrpc: "2.0", method: "resume", id: 7 })

async function withServer(
  run: (server: ApiServer, root: string, calls: () => number) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "side-api-test-"))
  let called = 0
  const server = await startApiServer({
    directory: root,
    handlers: {
      resume: () => {
        called += 1
        return null
      },
      pause: (params) => {
        called += 1
        return { paused_until: params === undefined ? null : 1 }
      },
    },
  })
  try {
    await run(server, root, () => called)
  } finally {
    await server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

function tcpRequest(server: ApiServer, body = resumeRequest, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${server.port}/rpc`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  })
}

test("P4-T4.1: startup creates private UDS and hash-only web discovery, then rotates the token", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-api-rotation-"))
  try {
    const first = await startApiServer({ directory: root, handlers: { resume: () => null } })
    const firstToken = first.token
    try {
      expect(first.port).toBeGreaterThan(0)
      expect(Buffer.from(firstToken, "hex")).toHaveLength(API_TOKEN_BYTES)
      expect(statSync(join(root, "run")).mode & 0o777).toBe(0o700)
      expect(statSync(first.socketPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, "run", "web.json")).mode & 0o777).toBe(0o600)
      const discovery = JSON.parse(readFileSync(join(root, "run", "web.json"), "utf8"))
      expect(discovery).toEqual({
        port: first.port,
        tokenHash: createHash("sha256").update(firstToken).digest("hex"),
      })
      expect(JSON.stringify(discovery)).not.toContain(firstToken)
      expect(
        (await tcpRequest(first, resumeRequest, { Authorization: `Bearer ${discovery.tokenHash}` }))
          .status,
      ).toBe(401)
    } finally {
      await first.stop()
    }
    const second = await startApiServer({ directory: root, handlers: { resume: () => null } })
    try {
      expect(second.token).not.toBe(firstToken)
    } finally {
      await second.stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("G10: missing or incorrect Bearer is 401; wrong Host and external Origin are 403", async () => {
  await withServer(async (server) => {
    const url = `http://127.0.0.1:${server.port}/rpc`
    const missing = await fetch(url, { method: "POST", body: resumeRequest })
    expect(missing.status).toBe(401)
    expect(
      (await tcpRequest(server, resumeRequest, { Authorization: "Bearer wrong" })).status,
    ).toBe(401)
    expect(
      (await tcpRequest(server, resumeRequest, { Host: `localhost:${server.port}` })).status,
    ).toBe(403)
    expect(
      (await tcpRequest(server, resumeRequest, { Origin: `http://localhost:${server.port}` }))
        .status,
    ).toBe(403)
    expect(
      (await tcpRequest(server, resumeRequest, { Origin: `http://127.0.0.1:${server.port}` }))
        .status,
    ).toBe(200)
  })
})

test("P4-T4.1: UDS accepts local RPC without TCP Bearer; both transports return JSON-RPC 2.0", async () => {
  await withServer(async (server) => {
    const uds = await fetch("http://localhost/rpc", {
      unix: server.socketPath,
      method: "POST",
      body: resumeRequest,
    })
    expect(uds.status).toBe(200)
    expect(await uds.json()).toEqual({ jsonrpc: "2.0", id: 7, result: null })
    const tcp = await tcpRequest(server)
    expect(tcp.status).toBe(200)
    expect(await tcp.json()).toEqual({ jsonrpc: "2.0", id: 7, result: null })
  })
})

test("P4-T4.1: RPC rejects malformed JSON, invalid envelopes, unknown methods and invalid zod params", async () => {
  await withServer(async (server, _root, calls) => {
    const cases = [
      { body: "{", code: -32700 },
      { body: JSON.stringify({ jsonrpc: "1.0", method: "resume", id: 7 }), code: -32600 },
      { body: JSON.stringify({ jsonrpc: "2.0", method: "invented", id: 7 }), code: -32601 },
      {
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "pause",
          params: { durationMs: -1 },
          id: 7,
        }),
        code: -32602,
      },
    ]
    for (const scenario of cases) {
      const response = await tcpRequest(server, scenario.body)
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload.error.code).toBe(scenario.code)
      expect(payload).not.toHaveProperty("result")
    }
    expect(calls()).toBe(0)
    const notification = await tcpRequest(
      server,
      JSON.stringify({ jsonrpc: "2.0", method: "resume" }),
    )
    expect(notification.status).toBe(204)
  })
})

test("P4-T4.1: batch RPC returns only calls with ids and preserves JSON-RPC errors", async () => {
  await withServer(async (server, _root, calls) => {
    const body = JSON.stringify([
      { jsonrpc: "2.0", method: "resume", id: 1 },
      { jsonrpc: "2.0", method: "resume" },
      { jsonrpc: "2.0", method: "pause", params: { durationMs: -1 }, id: 2 },
    ])
    const response = await tcpRequest(server, body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { jsonrpc: "2.0", id: 1, result: null },
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Invalid params" } },
    ])
    expect(calls()).toBe(2)
  })
})

test("P4-T4.1: handler failures return a generic RPC error without its detail", async () => {
  const response = await handleRpcBody(resumeRequest, {
    resume: () => {
      throw new Error("synthetic private detail")
    },
  })
  expect(response).toEqual({
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32603, message: "Internal error" },
  })
})

test("P4-T4.1: both transports enforce the 1 MB request-body limit", async () => {
  await withServer(async (server) => {
    const base = JSON.stringify({ jsonrpc: "2.0", method: "resume", id: 7, padding: "" })
    const atLimit = JSON.stringify({
      jsonrpc: "2.0",
      method: "resume",
      id: 7,
      padding: "x".repeat(API_MAX_REQUEST_BYTES - Buffer.byteLength(base)),
    })
    expect(Buffer.byteLength(atLimit)).toBe(API_MAX_REQUEST_BYTES)
    expect((await tcpRequest(server, atLimit)).status).toBe(200)
    const oversized = "x".repeat(API_MAX_REQUEST_BYTES + 1)
    const tcp = await tcpRequest(server, oversized)
    expect(tcp.status).toBe(413)
    const uds = await fetch("http://localhost/rpc", {
      unix: server.socketPath,
      method: "POST",
      body: oversized,
    })
    expect(uds.status).toBe(413)
  })
})

test("P4-T4.1: only POST /rpc is dispatched", async () => {
  await withServer(async (server, _root, calls) => {
    const wrongPath = await fetch(`http://127.0.0.1:${server.port}/other`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}` },
      body: resumeRequest,
    })
    expect(wrongPath.status).toBe(404)
    const wrongMethod = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
      method: "GET",
      headers: { Authorization: `Bearer ${server.token}` },
    })
    expect(wrongMethod.status).toBe(405)
    expect(calls()).toBe(0)
  })
})
