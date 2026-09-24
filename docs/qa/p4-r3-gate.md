# P4-R3-T1 provider key acceptance gate

2026-09-24, macOS arm64, Bun 1.3.5. `tests/daemon/provider-key-heap.test.ts` runs the real `src/cli.ts daemon` in a separate Bun process. It gives that process a fresh temporary `HOME`, `SIDE_DATA_DIR`, and `LCA_DATA_DIR`, so the test does not use `~/.aside` or a user Keychain item. A generated synthetic provider key is sent through the daemon's actual UDS `providers.setKey` RPC. An in-memory JSON-lines fake implements the Swift helper's `keychain.set` protocol and holds the key outside the daemon process.

## Acceptance evidence

| Check | Observed result |
|---|---|
| Helper delegation | Fake helper receives the exact synthetic key under `provider/synthetic`; `providers.setKey` returns only that reference. |
| Persisted settings | `settings.json` contains zero synthetic key bytes. |
| Read response | `settings.get` reports `has_key=true` and contains neither the key bytes nor `apiKey`/`apiKeyRef`. |
| Allowed daemon log | Captured daemon stderr contains zero synthetic key bytes before and after the heap scan. Daemon stdout is the designated helper protocol channel, which necessarily carries the `keychain.set` secret and is not a log. |
| Actual daemon heap | The test attaches to that daemon's loopback Bun Inspector, forces two synchronous GCs, writes a V8-format snapshot of its JavaScriptCore heap, and scans the snapshot bytes. The key has zero matches. An independently generated live marker is present in the same snapshot, proving the scan sees retained daemon strings. |

The RED sensitivity check temporarily retained the synthetic key in the daemon via Inspector; the snapshot assertion failed with `Received: true`. After removing that fault injection, `bun test tests/daemon/provider-key-heap.test.ts` passed (1 test, 12 assertions). No fault injection remains in the committed test.

Final checks after `bun install --frozen-lockfile` restored this worktree's missing dependencies:

| Command | Result |
|---|---|
| `bun test` | 665 pass, 0 fail, 1 snapshot, 4,102 assertions, 65 files |
| `npx tsc --noEmit` | exit 0 |
| `npx biome check .` | 173 files, 0 errors |
| `git diff --check` | exit 0 |

No Swift file changed, so the Swift test gate was not triggered. The existing provider tests also cover the fixed evidence-free `providers.test` request, safe errors, settings patch races, and helper failure.

## Proof boundary

This is a process-level snapshot of GC-live JavaScriptCore objects in the running source daemon. It does not inspect native/off-heap buffers, freed allocator pages, swap, crash dumps, a signed Side.app build, or a real Swift Keychain. The helper protocol frame contains the key by design; the test keeps it in memory and deletes its temporary settings and heap snapshot on exit. The zero-byte verdict is limited to the inspected settings file, `settings.get` response, captured daemon stderr, and post-GC heap snapshot for the generated key used in this run.
