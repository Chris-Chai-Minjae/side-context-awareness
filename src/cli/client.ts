import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { z } from "zod"
import { dataDirectory } from "../config/index"
import { type RpcMethodName, RpcMethods } from "../contracts/rpc"

type ClientOptions = { readonly socketPath?: string }

export class DaemonUnavailableError extends Error {
  readonly name = "DaemonUnavailableError"
  constructor() {
    super("Side is not running. Open Side.app.")
  }
}

export async function callDaemon(
  method: RpcMethodName,
  params: unknown,
  options: ClientOptions = {},
): Promise<unknown> {
  const id = randomUUID()
  const input = RpcMethods[method].input.parse(params)
  let response: Response
  try {
    response = await fetch("http://localhost/rpc", {
      unix: options.socketPath ?? join(dataDirectory(), "run", "daemon.sock"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: input }),
    })
  } catch {
    throw new DaemonUnavailableError()
  }
  if (!response.ok) throw new DaemonUnavailableError()
  const body: unknown = await response.json()
  const envelope = z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.string(),
      result: z.unknown().optional(),
      error: z.unknown().optional(),
    })
    .parse(body)
  if (envelope.id !== id) throw new TypeError("Daemon response ID mismatch")
  if (envelope.error !== undefined) {
    const error = z.object({ code: z.number().int(), message: z.string() }).parse(envelope.error)
    throw new Error(error.message)
  }
  if (!("result" in envelope)) throw new TypeError("Daemon response has no result")
  return RpcMethods[method].output.parse(envelope.result)
}
