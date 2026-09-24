import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import {
  type DaemonToAppMessage,
  DaemonToAppMessageSchema,
  type HelperHealth,
} from "../../src/contracts/protocol"
import { HelperClient, type HelperProtocolError } from "../../src/helper/client"
import { FakeClock } from "../mocks/fake-clock"

export const health: HelperHealth = {
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
  observerPid: 1,
  responsibleSelf: true,
  state: "running",
  asideAdapter: "off",
  perApp: {},
}

export const hello = {
  type: "hello",
  protocolVersion: 1,
  key: Buffer.alloc(32, 7).toString("base64"),
  appVersion: "test",
} as const

export type Command = Extract<DaemonToAppMessage, { type: "command" }>
export type ProtocolErrorFrame = Extract<DaemonToAppMessage, { type: "protocol-error" }>

export function harness(onCommand?: (command: Command, input: PassThrough) => void) {
  const input = new PassThrough()
  const output = new PassThrough()
  const clock = new FakeClock()
  const sent: DaemonToAppMessage[] = []
  const errors: HelperProtocolError[] = []
  createInterface({ input: output }).on("line", (line) => {
    const frame = DaemonToAppMessageSchema.parse(JSON.parse(line))
    sent.push(frame)
    if (frame.type === "command") onCommand?.(frame, input)
  })
  const client = new HelperClient({
    input,
    output,
    scheduleTimeout(callback, delayMs) {
      const id = clock.setTimeout(callback, delayMs)
      return () => clock.clearTimeout(id)
    },
    onProtocolError: (error) => errors.push(error),
  })
  const running = client.run()
  input.write(`${JSON.stringify(hello)}\n`)
  return { client, clock, input, output, sent, errors, running }
}
