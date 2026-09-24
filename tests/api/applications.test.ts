import { expect, test } from "bun:test"
import { createApplicationsHandlers } from "../../src/api/resources/applications"
import { handleRpcBody } from "../../src/api/rpc"
import { APPLICATION_ICON_CACHE_LIMIT } from "../../src/constants"
import { SettingsSchema } from "../../src/contracts/settings"

function rpc(method: string, params?: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
}

test("P4-R4-T1: listApplications marks denied apps from current settings", async () => {
  const commands: string[] = []
  const settings = SettingsSchema.parse({
    version: 2,
    contextAwareness: {
      rules: [{ scope: "app", behavior: "do_not_observe", bundleId: "com.tinyspeck.slackmacgap" }],
    },
  })
  const handlers = createApplicationsHandlers({
    getSettings: () => settings,
    helper: {
      async sendCommand(command) {
        commands.push(command.name)
        return [
          { bundleId: "com.tinyspeck.slackmacgap", name: "Slack", denied: false },
          { bundleId: "com.example.notes", name: "Notes", denied: false },
        ]
      },
    },
  })
  const response = await handleRpcBody(rpc("listApplications"), handlers)
  expect(response).toMatchObject({
    result: [
      { bundle_id: "com.tinyspeck.slackmacgap", name: "Slack", denied: true },
      { bundle_id: "com.example.notes", name: "Notes", denied: false },
    ],
  })
  expect(commands).toEqual(["applications.list"])
})

test("P4-R4-T1: appIcons deduplicates requests and caches returned PNGs", async () => {
  const requested: string[][] = []
  const settings = SettingsSchema.parse({ version: 2, contextAwareness: {} })
  const handlers = createApplicationsHandlers({
    getSettings: () => settings,
    helper: {
      async sendCommand(command) {
        if (command.name !== "applications.icons") throw new Error("Unexpected helper command")
        requested.push(command.args.bundleIds)
        return command.args.bundleIds.map((bundleId) => ({
          bundleId,
          iconPngBase64: "c3ludGhldGlj",
        }))
      },
    },
  })
  const first = await handleRpcBody(
    rpc("appIcons", { bundleIds: ["com.example.a", "com.example.a", "com.example.b"] }),
    handlers,
  )
  expect(first).toMatchObject({
    result: [
      { bundle_id: "com.example.a", icon_png_base64: "c3ludGhldGlj" },
      { bundle_id: "com.example.b", icon_png_base64: "c3ludGhldGlj" },
    ],
  })
  await handleRpcBody(rpc("appIcons", { bundleIds: ["com.example.b", "com.example.a"] }), handlers)
  expect(requested).toEqual([["com.example.a", "com.example.b"]])
})

test("P4-R4-T1: icon cache evicts the least recently used bundle", async () => {
  const requested: string[][] = []
  const settings = SettingsSchema.parse({ version: 2, contextAwareness: {} })
  const handlers = createApplicationsHandlers({
    getSettings: () => settings,
    helper: {
      async sendCommand(command) {
        if (command.name !== "applications.icons") throw new Error("Unexpected helper command")
        requested.push(command.args.bundleIds)
        return command.args.bundleIds.map((bundleId) => ({ bundleId, iconPngBase64: "YQ==" }))
      },
    },
  })
  const ids = Array.from({ length: APPLICATION_ICON_CACHE_LIMIT }, (_, index) => `app.${index}`)
  const evicted = ids.at(1)
  if (!evicted) throw new Error("Missing synthetic bundle")
  await handleRpcBody(rpc("appIcons", { bundleIds: ids }), handlers)
  await handleRpcBody(rpc("appIcons", { bundleIds: [ids[0]] }), handlers)
  await handleRpcBody(rpc("appIcons", { bundleIds: ["app.new"] }), handlers)
  await handleRpcBody(rpc("appIcons", { bundleIds: [evicted] }), handlers)
  expect(requested.at(-1)).toEqual([evicted])
})

test("P4-R4-T1: one request larger than the LRU still returns every icon", async () => {
  const settings = SettingsSchema.parse({ version: 2, contextAwareness: {} })
  const handlers = createApplicationsHandlers({
    getSettings: () => settings,
    helper: {
      async sendCommand(command) {
        if (command.name !== "applications.icons") throw new Error("Unexpected helper command")
        return command.args.bundleIds.map((bundleId) => ({ bundleId, iconPngBase64: "YQ==" }))
      },
    },
  })
  const ids = Array.from({ length: APPLICATION_ICON_CACHE_LIMIT + 1 }, (_, index) => `app.${index}`)
  const response = await handleRpcBody(rpc("appIcons", { bundleIds: ids }), handlers)
  expect(response).toMatchObject({ result: ids.map((bundle_id) => ({ bundle_id })) })
})
