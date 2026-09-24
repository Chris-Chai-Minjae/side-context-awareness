import type { Database } from "bun:sqlite"

type FenceSnapshot = {
  readonly accountGeneration: string
  readonly deletionEpoch: string
}

export type FenceResult<T> =
  | { readonly status: "committed"; readonly value: T }
  | { readonly status: "discarded" }

export class FenceAsyncCommitError extends Error {
  readonly name = "FenceAsyncCommitError"
  constructor() {
    super("Fenced commit callback must be synchronous")
  }
}

type Commit = <Value>(
  write: () => Value,
  ...rejectAsync: Value extends PromiseLike<unknown> ? ["Async commit callbacks are forbidden"] : []
) => FenceResult<Value>

function readFence(db: Database): FenceSnapshot {
  const read = db.query<{ key: string; value: string }, []>(
    "SELECT key, value FROM side_meta WHERE key IN ('account_generation', 'deletion_epoch')",
  )
  const values = new Map(read.all().map((row) => [row.key, row.value]))
  return {
    accountGeneration: values.get("account_generation") ?? "0",
    deletionEpoch: values.get("deletion_epoch") ?? "0",
  }
}

export function withFence<T>(
  db: Database,
  prepare: (commit: Commit) => Promise<FenceResult<T>>,
): Promise<FenceResult<T>> {
  const started = readFence(db)
  const commit: Commit = <Value>(
    write: () => Value,
    ..._rejectAsync: Value extends PromiseLike<unknown>
      ? ["Async commit callbacks are forbidden"]
      : []
  ): FenceResult<Value> =>
    db
      .transaction(() => {
        const current = readFence(db)
        if (
          current.accountGeneration !== started.accountGeneration ||
          current.deletionEpoch !== started.deletionEpoch
        ) {
          return { status: "discarded" } as const
        }
        const value = write()
        if (
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          "then" in value &&
          typeof value.then === "function"
        ) {
          throw new FenceAsyncCommitError()
        }
        return { status: "committed", value } as const
      })
      .immediate()
  return prepare(commit)
}
