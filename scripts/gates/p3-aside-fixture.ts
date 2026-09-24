import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEvidenceHandlers } from "../../src/api/resources/evidence"
import { startApiServer } from "../../src/api/server"
import { RpcMethods } from "../../src/contracts/rpc"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"

const TARGET_URL = "https://fixture.invalid/sqlite/extensions/vec0-guide"
const SNIPPET = "S6_SYNTHETIC_SNIPPET: vec0 가상 테이블의 합성 예시입니다."

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "side-p3v-aside-"))
  chmodSync(root, 0o700)
  const dataDir = join(root, "side-data")
  mkdirSync(dataDir, { mode: 0o700 })
  const db = openLedger(join(dataDir, "ledger.db"))
  const masterKey = Buffer.alloc(32, 0x53)
  let api: Awaited<ReturnType<typeof startApiServer>> | undefined
  try {
    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("sv-SE", {
      timeZone: "Asia/Tokyo",
    })
    const source = writeLedgerEvent(db, masterKey, {
      occurredAt: Date.parse(`${yesterday}T15:10:00+09:00`),
      source: "mac_ax",
      kind: "content.snapshot",
      appName: "Synthetic Browser",
      bundleId: "invalid.fixture.browser",
      windowTitle: "SQLite sqlite 확장 문서 — vec0 사용 설명",
      url: TARGET_URL,
      content: SNIPPET,
    })
    const expectedRef = `e:${source.id}`
    const handlers = createEvidenceHandlers({
      db,
      getMasterKey: () => Buffer.from(masterKey),
      browserHistory: async () => [],
    })
    if (!handlers.search || !handlers.read) throw new Error("Fixture handlers unavailable")
    const hits = RpcMethods.search.output.parse(
      await handlers.search({ queries: ["sqlite", "확장", "문서"], limit: 5 }),
    )
    const read = RpcMethods.read.output.parse(await handlers.read({ id: expectedRef }))
    if (
      !hits.some((hit) => hit.ref === expectedRef && hit.url === TARGET_URL) ||
      !read ||
      read.expired ||
      !read.text.includes(SNIPPET)
    )
      throw new Error("Synthetic search/read preflight failed")

    api = await startApiServer({ directory: dataDir, handlers })
    const wrapper = join(root, "side-mcp-fixture.sh")
    const sideCli = join(import.meta.dir, "../../src/cli.ts")
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec env HOME=${shellQuote(root)} SIDE_DATA_DIR=${shellQuote(dataDir)} LCA_DATA_DIR=${shellQuote(dataDir)} ${shellQuote(process.execPath)} ${shellQuote(sideCli)} mcp\n`,
      { mode: 0o700 },
    )
    console.log(
      JSON.stringify({
        status: "ready",
        root,
        socketPath: api.socketPath,
        fixturePreflight: "pass",
        expectedRef,
        registration: { command: wrapper, args: [] },
      }),
    )
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve)
      process.once("SIGTERM", resolve)
    })
  } finally {
    await api?.stop()
    db.close()
    masterKey.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
}

try {
  await main()
} catch {
  // no-excuse-ok: catch -- CLI boundary never prints fixture evidence or paths on failure.
  console.error("Synthetic Aside fixture failed to start or clean up")
  process.exitCode = 1
}
