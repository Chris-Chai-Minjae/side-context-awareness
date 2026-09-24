import { expect, test } from "bun:test"
import {
  AppToDaemonMessageSchema,
  DaemonToAppMessageSchema,
  HelperHealthSchema,
} from "../../src/contracts/protocol"

const health = {
  platform: "darwin",
  protocolVersion: 1,
  nativeCaptureAvailable: true,
  inputCaptureAvailable: true,
  screenOcrAvailable: true,
  screenOcrLanguages: ["en", "ko"],
  accessibilityTrusted: true,
  inputMonitoringTrusted: true,
  screenRecordingTrusted: true,
  eventTapHealthy: true,
  inputTapRunning: true,
  observerRegistrationFailures: 0,
  secureInput: false,
  permissionSheetVisible: false,
  systemSessionActive: true,
  idle: false,
  pid: 1,
  observerPid: 2,
  responsibleSelf: true,
  state: "running",
  asideAdapter: "off",
  perApp: {},
}

test("Given complete macOS health, when parsed, then all approved fields survive", () => {
  expect(HelperHealthSchema.safeParse(health).success).toBe(true)
  expect(HelperHealthSchema.safeParse({ ...health, platform: "win32" }).success).toBe(false)
  expect(HelperHealthSchema.safeParse({ ...health, responsibleSelf: false }).success).toBe(false)
})

test("Given app-to-daemon frames, when parsed, then hello, health, event and result variants are accepted", () => {
  const messages = [
    {
      type: "hello",
      protocolVersion: 1,
      key: Buffer.alloc(32).toString("base64"),
      appVersion: "1.0",
    },
    { type: "health", health },
    { type: "event", event: { kind: "window.changed", source: "mac_ax", occurredAt: 1 } },
    { type: "result", id: "a", ok: true, data: { status: "ok" } },
    { type: "result", id: "b", ok: false, error: "permission unavailable" },
    { type: "protocol-error", message: "bad frame" },
  ]
  for (const message of messages)
    expect(AppToDaemonMessageSchema.safeParse(message).success).toBe(true)
  expect(AppToDaemonMessageSchema.safeParse({ ...messages[0], key: "bad" }).success).toBe(false)
  expect(
    AppToDaemonMessageSchema.safeParse({ type: "result", id: "a", ok: false, data: {} }).success,
  ).toBe(false)
})

test("Given daemon commands, when parsed, then names and argument shapes are enforced", () => {
  expect(
    DaemonToAppMessageSchema.safeParse({ type: "command", id: "r", name: "keychain.rotate" })
      .success,
  ).toBe(true)
  expect(
    DaemonToAppMessageSchema.safeParse({
      type: "command",
      id: "r",
      name: "keychain.rotate",
      args: {},
    }).success,
  ).toBe(false)
  expect(
    DaemonToAppMessageSchema.safeParse({ type: "command", id: "a", name: "health" }).success,
  ).toBe(true)
  expect(
    DaemonToAppMessageSchema.safeParse({
      type: "command",
      id: "b",
      name: "requestPermissions",
      args: { kinds: ["accessibility"] },
    }).success,
  ).toBe(true)
  expect(
    DaemonToAppMessageSchema.safeParse({
      type: "command",
      id: "c",
      name: "observer.configure",
      args: { deniedBundleIds: [], captureTypedText: true, screenOcr: false, paused: false },
    }).success,
  ).toBe(true)
  expect(
    DaemonToAppMessageSchema.safeParse({
      type: "command",
      id: "d",
      name: "keychain.set",
      args: { ref: "provider/p", secret: "x" },
    }).success,
  ).toBe(true)
  expect(
    DaemonToAppMessageSchema.safeParse({
      type: "command",
      id: "web-1",
      name: "web.session",
      args: { port: 49152, token: "a".repeat(64) },
    }).success,
  ).toBe(true)
  expect(
    DaemonToAppMessageSchema.safeParse({
      type: "command",
      id: "web-2",
      name: "web.session",
      args: { port: 0, token: "a".repeat(64) },
    }).success,
  ).toBe(false)
  expect(
    DaemonToAppMessageSchema.safeParse({ type: "command", id: "e", name: "unknown" }).success,
  ).toBe(false)
  expect(
    DaemonToAppMessageSchema.safeParse({
      type: "command",
      id: "f",
      name: "keychain.set",
      args: { ref: "provider/p" },
    }).success,
  ).toBe(false)
})
