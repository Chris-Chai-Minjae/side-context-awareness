import { z } from "zod"
import type { ContextStore } from "./store"

const EmbedResponse = z.object({ embeddings: z.array(z.array(z.number().finite()).min(1)).min(1) })
type Fetcher = (input: string, init: RequestInit) => Promise<Response>

export async function embedLocal(
  model: string,
  input: string | readonly string[],
  fetcher: Fetcher = fetch,
): Promise<readonly number[][]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetcher("http://127.0.0.1:11434/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Local Ollama embedding returned ${response.status}`)
    const vectors = EmbedResponse.parse(await response.json()).embeddings
    if (vectors.length !== (typeof input === "string" ? 1 : input.length))
      throw new Error("Embedding count mismatch")
    return vectors
  } finally {
    clearTimeout(timeout)
  }
}

export async function indexPendingSummaries(store: ContextStore, model: string): Promise<number> {
  const pending = store.summariesWithoutVectors(model, 4)
  if (pending.length === 0) return 0
  const vectors = await embedLocal(
    model,
    pending.map((summary) => `${summary.title}\n${summary.body}`),
  )
  for (let index = 0; index < pending.length; index++) {
    const summary = pending[index]
    const vector = vectors[index]
    if (summary && vector) store.putVector(summary.id, model, vector)
  }
  return pending.length
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

export async function memorySearch(
  store: ContextStore,
  model: string,
  query: string,
  now = Date.now(),
): Promise<
  readonly {
    id: string
    title: string
    excerpt: string
    at: string
    score: number
    untrusted: true
  }[]
> {
  const queryVector = (await embedLocal(model, query))[0]
  if (!queryVector) return []
  return store
    .vectors(model)
    .map(({ summary, vector }) => ({
      id: `s:${summary.id}`,
      title: summary.title,
      excerpt: summary.body.slice(0, 500),
      at: new Date(summary.windowFrom).toISOString(),
      score:
        cosine(queryVector, vector) /
        (1 + Math.max(0, now - summary.windowFrom) / (7 * 86_400_000)),
      untrusted: true as const,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 20)
}
