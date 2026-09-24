import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { EMBEDDING_DIMENSIONS, EMBEDDING_IDLE_MS } from "../constants"
import { bundledResourcePath } from "./sqlite"

export const EMBEDDING_MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"

export function modelCacheDirectory(dataDir: string, executablePath = process.execPath): string {
  const bundled = bundledResourcePath(executablePath, "models")
  const model = join(bundled, EMBEDDING_MODEL_ID)
  return existsSync(join(model, "config.json")) &&
    existsSync(join(model, "tokenizer_config.json")) &&
    existsSync(join(model, "tokenizer.json")) &&
    existsSync(join(model, "onnx", "model_quantized.onnx"))
    ? bundled
    : join(dataDir, "models")
}

export type EmbeddingModel = {
  embed(text: string): Promise<Float32Array>
  dispose(): Promise<void>
}

type TimerClock<TimerId> = {
  setTimeout(callback: () => void, delayMs: number): TimerId
  clearTimeout(id: TimerId): void
}

type EmbeddingOptions<TimerId> = {
  readonly clock?: TimerClock<TimerId>
  readonly load?: (cacheDir: string) => Promise<EmbeddingModel>
}

const systemClock: TimerClock<ReturnType<typeof setTimeout>> = {
  setTimeout,
  clearTimeout,
}

async function loadModel(cacheDir: string): Promise<EmbeddingModel> {
  mkdirSync(cacheDir, { recursive: true })
  const { pipeline } = await import("@huggingface/transformers")
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL_ID, {
    cache_dir: cacheDir,
    local_files_only: cacheDir === bundledResourcePath(process.execPath, "models"),
    device: "cpu",
    dtype: "q8",
  })
  return {
    async embed(text) {
      const output = await extractor(text, { pooling: "mean", normalize: true })
      return Float32Array.from(output.data as ArrayLike<number>)
    },
    async dispose() {
      await extractor.dispose()
    },
  }
}

export class EmbeddingManager<TimerId = ReturnType<typeof setTimeout>> {
  private readonly clock: TimerClock<TimerId>
  private readonly load: (cacheDir: string) => Promise<EmbeddingModel>
  private model: EmbeddingModel | null = null
  private loading: Promise<EmbeddingModel> | null = null
  private idleTimer: TimerId | null = null
  private active = 0
  private closed = false

  constructor(
    private readonly dataDir: string,
    options: EmbeddingOptions<TimerId> = {},
  ) {
    this.clock = options.clock ?? (systemClock as TimerClock<TimerId>)
    this.load = options.load ?? loadModel
  }

  private async getModel(): Promise<EmbeddingModel> {
    if (this.model) return this.model
    if (!this.loading) this.loading = this.load(modelCacheDirectory(this.dataDir))
    try {
      const model = await this.loading
      this.model = model
      return model
    } catch (error) {
      this.loading = null
      throw error
    }
  }

  private armIdle(): void {
    if (this.closed || this.active !== 0 || !this.model) return
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null
      if (this.active !== 0) return
      const model = this.model
      this.model = null
      this.loading = null
      void model?.dispose()
    }, EMBEDDING_IDLE_MS)
  }

  async embed(text: string): Promise<Float32Array> {
    if (this.closed) throw new Error("Embedding manager is closed")
    if (this.idleTimer !== null) this.clock.clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.active++
    try {
      const vector = await (await this.getModel()).embed(text)
      if (vector.length !== EMBEDDING_DIMENSIONS)
        throw new RangeError(`Expected ${EMBEDDING_DIMENSIONS}-dimensional embedding`)
      return vector
    } finally {
      this.active--
      this.armIdle()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.idleTimer !== null) this.clock.clearTimeout(this.idleTimer)
    this.idleTimer = null
    const model = this.model ?? (await this.loading)
    this.model = null
    this.loading = null
    await model?.dispose()
  }
}
