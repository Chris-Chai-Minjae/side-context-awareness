import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { API_TOKEN_BYTES } from "../constants"

export type WebToken = {
  readonly token: string
  readonly tokenHash: string
}

export function createWebToken(): WebToken {
  const token = randomBytes(API_TOKEN_BYTES).toString("hex")
  return { token, tokenHash: createHash("sha256").update(token).digest("hex") }
}

export function tcpAuthStatus(request: Request, port: number, tokenHash: string): 401 | 403 | null {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return 401
  const presentedHash = createHash("sha256").update(authorization.slice("Bearer ".length)).digest()
  if (!timingSafeEqual(presentedHash, Buffer.from(tokenHash, "hex"))) return 401

  const authority = `127.0.0.1:${port}`
  if (request.headers.get("host") !== authority) return 403
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== `http://${authority}`) return 403
  return null
}
