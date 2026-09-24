import { mkdirSync } from "node:fs"
import { pipeline } from "@huggingface/transformers"
import { EMBEDDING_DIMENSIONS } from "../src/constants"
import { EMBEDDING_MODEL_ID } from "../src/memory/embed"

const cacheDir = process.argv[2]
if (!cacheDir) throw new TypeError("Expected model cache destination")
mkdirSync(cacheDir, { recursive: true })
const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL_ID, {
  cache_dir: cacheDir,
  device: "cpu",
  dtype: "q8",
})
try {
  const vector = await extractor("Side bundle model check", { pooling: "mean", normalize: true })
  if (vector.data.length !== EMBEDDING_DIMENSIONS)
    throw new RangeError("Bundled model has wrong dimensions")
} finally {
  await extractor.dispose()
}
console.log(`Cached ${EMBEDDING_MODEL_ID} q8 in ${cacheDir}`)
