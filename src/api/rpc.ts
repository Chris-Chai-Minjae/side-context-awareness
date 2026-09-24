import { z } from "zod"
import { type RpcMethodName, RpcMethods } from "../contracts/rpc"

const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
  id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
})

type RpcId = string | number | null
type RpcError = {
  readonly jsonrpc: "2.0"
  readonly id: RpcId
  readonly error: { readonly code: number; readonly message: string }
}
type RpcResult = {
  readonly jsonrpc: "2.0"
  readonly id: RpcId
  readonly result: unknown
}
type RpcResponse = RpcError | RpcResult

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>
export type RpcHandlers = Readonly<Partial<Record<RpcMethodName, RpcHandler>>>

function rpcError(id: RpcId, code: number, message: string): RpcError {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function requestError(id: RpcId | undefined, code: number, message: string): RpcError | null {
  return id === undefined ? null : rpcError(id, code, message)
}

async function dispatchRpc(value: unknown, handlers: RpcHandlers): Promise<RpcResponse | null> {
  const request = RpcRequestSchema.safeParse(value)
  if (!request.success) return rpcError(null, -32600, "Invalid Request")

  const { id, method, params } = request.data
  const entry = Object.entries(RpcMethods).find(([name]) => name === method)
  if (!entry) return requestError(id, -32601, "Method not found")
  const handler = Object.entries(handlers).find(([name]) => name === method)?.[1]
  if (!handler) return requestError(id, -32601, "Method not found")

  const input = entry[1].input.safeParse(params)
  if (!input.success) return requestError(id, -32602, "Invalid params")

  try {
    const result = await handler(input.data)
    if (id === undefined) return null
    const output = entry[1].output.safeParse(result)
    if (!output.success) return rpcError(id, -32603, "Internal error")
    return { jsonrpc: "2.0", id, result: output.data }
  } catch {
    // no-excuse-ok: catch -- RPC boundary must not expose handler errors.
    return requestError(id, -32603, "Internal error")
  }
}

export async function handleRpcBody(
  body: string,
  handlers: RpcHandlers,
): Promise<RpcResponse | RpcResponse[] | null> {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    if (error instanceof SyntaxError) return rpcError(null, -32700, "Parse error")
    throw error
  }

  if (!Array.isArray(value)) return dispatchRpc(value, handlers)
  if (value.length === 0) return rpcError(null, -32600, "Invalid Request")
  const responses = await Promise.all(value.map((item: unknown) => dispatchRpc(item, handlers)))
  const sent = responses.filter((response): response is RpcResponse => response !== null)
  return sent.length === 0 ? null : sent
}
