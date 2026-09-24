import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { modelCacheDirectory } from "../../src/memory/embed"
import { bundledResourcePath } from "../../src/memory/sqlite"

test("Given a Side.app executable, when resolving resources, then paths use Contents/Resources", () => {
  // Given
  const executable = "/Applications/Side.app/Contents/Resources/side"

  // When
  const sqlite = bundledResourcePath(executable, "lib", "libsqlite3.dylib")
  const vec0 = bundledResourcePath(executable, "lib", "vec0.dylib")
  const web = bundledResourcePath(executable, "web")

  // Then
  expect(sqlite).toBe("/Applications/Side.app/Contents/Resources/lib/libsqlite3.dylib")
  expect(vec0).toBe("/Applications/Side.app/Contents/Resources/lib/vec0.dylib")
  expect(web).toBe("/Applications/Side.app/Contents/Resources/web")
})

test("Given complete bundled model files, when choosing cache, then bundled cache is used", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "side-bundle-model-"))
  const resources = join(root, "Side.app", "Contents", "Resources")
  const model = join(resources, "models", "Xenova", "paraphrase-multilingual-MiniLM-L12-v2")
  mkdirSync(join(model, "onnx"), { recursive: true })
  writeFileSync(join(model, "config.json"), "{}")
  writeFileSync(join(model, "tokenizer_config.json"), "{}")
  writeFileSync(join(model, "tokenizer.json"), "{}")
  writeFileSync(join(model, "onnx", "model_quantized.onnx"), "fixture")
  try {
    // When
    const cache = modelCacheDirectory(join(root, "data"), join(resources, "side"))

    // Then
    expect(cache).toBe(join(resources, "models"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given no bundled model, when choosing cache, then Side data models is used", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "side-data-model-"))
  try {
    // When
    const cache = modelCacheDirectory(join(root, "data"), join(root, "side"))

    // Then
    expect(cache).toBe(join(root, "data", "models"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
