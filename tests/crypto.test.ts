import { expect, test } from "bun:test"
import { deriveSubkey, keyedHash, open, seal } from "../src/crypto/index"

test("Given a master key, when deriving domain subkeys, then HKDF uses the specified salt and purposes", () => {
  const masterKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index))

  const evidence = deriveSubkey(masterKey, "evidence")
  const terms = deriveSubkey(masterKey, "terms")
  const contentHash = deriveSubkey(masterKey, "content-hash")

  expect(evidence.toString("hex")).toBe(
    "49ffb9d6447973471669d281c46a5e4d1687a88a73a2eaf36a6b1b02b78b2889",
  )
  expect(terms.toString("hex")).toBe(
    "3b883466b319782541e8740e7a8f64fb3c462702addcd6f951fdc5c5e40b9892",
  )
  expect(contentHash.toString("hex")).toBe(
    "dc1cc3ab0ecc5097056475c59cb2a9e7e4a08edde410a34c49483c315ecd7743",
  )
  expect(keyedHash("same term", terms)).not.toBe(keyedHash("same term", contentHash))
})

test("Given a short master key, when deriving a subkey, then derivation rejects it", () => {
  expect(() => deriveSubkey(Buffer.alloc(31), "evidence")).toThrow()
})

test("Given evidence, when stored with AES-GCM, then plaintext is absent and tampering is rejected", () => {
  const key = Buffer.alloc(32, 7)
  const aad = "context_awareness_events:payload:01SYNTHETIC"
  const encrypted = seal({ text: "private synthetic detail" }, key, aad)
  expect(encrypted).not.toContain("private synthetic detail")
  expect(open<{ text: string }>(encrypted, key, aad).text).toBe("private synthetic detail")
  const bytes = Buffer.from(encrypted, "base64url")
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
  expect(() => open(bytes.toString("base64url"), key, aad)).toThrow()
})

test("Given column-bound evidence, when opened with its AAD, then the original value is returned", () => {
  const key = Buffer.alloc(32, 7)
  const aad = "context_awareness_events:payload:01SYNTHETIC"
  const encrypted = seal({ text: "synthetic detail" }, key, aad)

  expect(open<{ text: string }>(encrypted, key, aad)).toEqual({ text: "synthetic detail" })
  expect(Buffer.from(encrypted, "base64url").length).toBeGreaterThanOrEqual(29)
})

test("Given column-bound evidence, when opened with a different AAD, then authentication fails", () => {
  const key = Buffer.alloc(32, 7)
  const encrypted = seal({ text: "synthetic detail" }, key, "context_awareness_events:payload:01")

  expect(() => open(encrypted, key, "context_awareness_events:target:01")).toThrow()
})

test("Given column-bound evidence, when opened without AAD, then authentication fails", () => {
  const key = Buffer.alloc(32, 7)
  const encrypted = seal({ text: "synthetic detail" }, key, "context_awareness_events:payload:01")

  expect(() => open(encrypted, key)).toThrow()
})

test("Given an empty AAD, when sealing evidence, then encryption rejects the missing binding", () => {
  const key = Buffer.alloc(32, 7)

  expect(() => seal({ text: "synthetic detail" }, key, "")).toThrow()
})

test("Given a legacy iv-tag-ciphertext value, when opened without AAD, then its value is restored", () => {
  const key = Buffer.alloc(32, 7)
  const legacy =
    "CQkJCQkJCQkJCQkJRfAGeEA5j6Oat-XXW4swL1yn8PHGhONbgg6uX4eJ2v-nyQ2HXIuDqQyOIsOhFWgW8Zg"

  expect(open<{ text: string }>(legacy, key)).toEqual({ text: "legacy synthetic detail" })
})

test("Given a legacy value, when opened with an empty AAD, then decryption rejects the binding", () => {
  const key = Buffer.alloc(32, 7)
  const legacy =
    "CQkJCQkJCQkJCQkJRfAGeEA5j6Oat-XXW4swL1yn8PHGhONbgg6uX4eJ2v-nyQ2HXIuDqQyOIsOhFWgW8Zg"

  expect(() => open(legacy, key, "")).toThrow()
})
