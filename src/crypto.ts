import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"

export function seal(value: unknown, key: Buffer): string {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")
}

export function open<T>(encoded: string, key: Buffer): T {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes")
  const raw = Buffer.from(encoded, "base64url")
  if (raw.length < 29) throw new Error("Invalid encrypted evidence")
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"),
  ) as T
}

export function keyedHash(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("hex")
}
