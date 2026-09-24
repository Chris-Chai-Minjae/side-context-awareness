# P4-R5-T1 Clear all key rotation QA

## Scope

- `keychain.rotate` is a strict, no-argument helper command. The Swift supervisor uses `SideKeyStore.rotateMasterKey()` only after the daemon sends that command after the clear transaction commits; it replies with `{key}` only after the store returns a 32-byte replacement.
- The daemon blocks capture and observer input, waits for the running summary pass, clears all ledger history and affected day pages, rotates the in-memory key, clears the decrypted frame cache, synchronizes the index, and only then resumes capture. Rotation failure or malformed result leaves capture blocked and returns a generic RPC error.
- Partial clear continues through the existing handler and does not rotate the key.

## RED / GREEN evidence

- RED: `bun test tests/contracts/protocol.test.ts tests/helper/protocol.test.ts` failed because `keychain.rotate` was absent from the command schema and fake helper; the Swift targeted test failed because the supervisor returned no result.
- RED: `bun test tests/integration/clear-all-rotation.test.ts` failed because daemon `clear('all')` returned an error without a rotation callback and history remained. All synthetic fixtures used temporary Side directories and in-memory keys.
- GREEN: `bun test` → **701 pass, 0 fail**, 70 files; `npx tsc --noEmit` → exit 0; `npx biome check .` → **187 files, no fixes**; `git diff --check` → exit 0.
- GREEN: `swift test --package-path apps/side-mac` → **138 SideCaptureKit tests + 10 SideApp tests**, 0 failures.
- The real daemon plus fake helper scenarios prove that the pause command precedes rotation, an in-flight summary delays deletion and rotation, all-clear removes the old event, summary, day page, and index chunks, and a later event decrypts with the replacement key but not the previous key. An invalid rotation result leaves the event count at zero after a new event is delivered. The helper client test proves that its previous key buffer is zeroed on replacement or discard.

## Boundary and integration notes

- No real user Keychain item, Aside ledger row, or TCC permission was read or changed. Native Keychain delete/add behavior and capture permissions remain unverified on a signed app with real TCC grants.
- Crypto-shred destroys the app's old key and deletes its stored ciphertext; a pre-existing external copy of both the old key and ciphertext would remain decryptable by definition.
- Parallel `web.session` work may conflict at cherry-pick in `src/contracts/protocol.ts`, `src/daemon/index.ts`, and `apps/side-mac/Sources/Side/App/Supervisor.swift`. This branch does not implement or touch `web.session`. The coordinator's separate `day.get` change in `src/api/resources/history.ts` is untouched here.
