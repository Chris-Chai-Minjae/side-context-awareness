import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"

export type SubkeyPurpose = "evidence" | "terms" | "content-hash"

function requireKey(key: Buffer): void {
  if (key.length !== 32) throw new TypeError("Crypto key must be 32 bytes")
}

function encodeAad(aad: string): Buffer {
  if (aad.length === 0) throw new TypeError("AAD must not be empty")
  return Buffer.from(aad, "utf8")
}

export function deriveSubkey(masterKey: Buffer, purpose: SubkeyPurpose): Buffer {
  requireKey(masterKey)
  return Buffer.from(hkdfSync("sha256", masterKey, "side/v1", `context-awareness.${purpose}`, 32))
}

export function seal(value: unknown, key: Buffer, aad: string): string {
  requireKey(key)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(encodeAad(aad))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")
}

export function open<T>(encoded: string, key: Buffer, aad?: string): T {
  requireKey(key)
  const raw = Buffer.from(encoded, "base64url")
  if (raw.length < 29) throw new TypeError("Invalid encrypted evidence")
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  if (aad !== undefined) decipher.setAAD(encodeAad(aad))
  return JSON.parse(
    Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"),
  )
}

export function keyedHash(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("hex")
}
