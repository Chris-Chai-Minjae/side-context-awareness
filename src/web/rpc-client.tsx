type RpcMethod = keyof typeof import("../contracts/rpc").RpcMethods

export interface RpcClient {
  call(method: RpcMethod, params?: unknown): Promise<unknown>
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class RpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RpcError"
  }
}

export function readInjectedToken(browser: Window): string | null {
  const url = new URL(browser.location.href)
  if (!url.searchParams.has("t")) return null
  const token = url.searchParams.get("t")
  url.searchParams.delete("t")
  browser.history.replaceState(browser.history.state, "", `${url.pathname}${url.search}${url.hash}`)
  return token || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createRpcClient(token: string | null, fetcher: FetchLike = fetch): RpcClient {
  let nextId = 1
  return {
    async call(method, params) {
      if (!token) throw new RpcError("No app token was provided")
      const id = nextId++
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })
      const response = await fetcher("/rpc", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        cache: "no-store",
        credentials: "omit",
      })
      if (!response.ok) throw new RpcError(`RPC request failed (${response.status})`)
      const packet: unknown = await response.json()
      if (!isRecord(packet) || packet["jsonrpc"] !== "2.0" || packet["id"] !== id) {
        throw new RpcError("Invalid RPC response")
      }
      if (isRecord(packet["error"])) {
        const message = packet["error"]["message"]
        throw new RpcError(typeof message === "string" ? message : "RPC request failed")
      }
      if (!("result" in packet)) throw new RpcError("Invalid RPC response")
      return packet["result"]
    },
  }
}
