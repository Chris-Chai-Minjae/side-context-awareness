# P5-T5.1 bundling evidence

## Bundle and runtime

`apps/side-mac/scripts/build-app.sh` builds `Side.app` with `Contents/Resources/side`, `lib/libsqlite3.dylib` (FTS5 and extension loading), `lib/vec0.dylib`, `lib/libonnxruntime.1.dylib`, `web/`, and the four q8 MiniLM model files under `models/Xenova/paraphrase-multilingual-MiniLM-L12-v2/`. The native ONNX addon is embedded in the compiled binary with a bundle-relative dylib reference. The build signs nested code ad hoc for local execution; Developer ID signing and notarization belong to P5-T5.2.

`bun run build` now invokes that script and writes `apps/side-mac/.build/release/Side.app`. The old `dist/side-daemon` build target is no longer the release artifact.

The copied SQLite dylib's install name is rewritten to `@rpath/libsqlite3.dylib` before signing. `otool -L` on the bundled file showed only that install name and `/usr/lib` dependencies, with no Homebrew path.

The build fetches and verifies the model at build time. `SIDE_MODEL_CACHE_SOURCE` can instead point to a prefilled cache with the same four files; an incomplete cache fails the build. Runtime loading uses the bundled cache offline and retains the Side data-directory cache path for source/development execution. This release choice makes model inference available without a first-run download or progress UI.

The measured app bundle is 234 MiB on this build Mac (`models/` 129 MiB, `side` 60 MiB, `lib/` 44 MiB). The larger download/install size is the cost of offline model availability.

The compiled build replaces Transformers' `sharp` import with a text-only stub because Side uses only feature extraction, and changes ONNX's dynamic native-addon lookup to a statically bundled addon. `scripts/build-daemon.ts` fails if either dependency's expected import layout changes, so a dependency update requires a fresh build and smoke gate.

## RED → GREEN

- Before the path changes, `bun test tests/memory/bundle-assets.test.ts` failed because the bundle resource and model cache resolvers were absent. It then passed 3 new tests.
- Before the packaging changes, the app bundle lacked all four required resource groups (`libsqlite3`, `vec0`, `web`, `models`); the file-presence command exited 1. The rebuilt app contained each asset and `codesign --verify --deep --strict` exited 0.
- Before the daemon web path change, `bun run scripts/gates/p5-bundle-smoke.ts` reached the compiled daemon but received HTTP 503 for the bundled web page. After the path change, the same gate reported `PASS bundled web, SQLite vec0, and compiled MiniLM inference`.
- A plain `bun build --compile` model probe failed on the `sharp` native addon. The patched compiled probe produced a 384-dimensional embedding, and the final smoke gate exercised model inference through the actual compiled `side daemon` and UDS `memorySearch` route.

## Checks (2026-09-24, macOS arm64)

| Command | Result |
|---|---|
| `bun run build` | exit 0; default model prefetch path used; `Side.app` emitted |
| `bun run scripts/gates/p5-bundle-smoke.ts` | exit 0; bundled web, FTS5/vec0, compiled model inference |
| `bun test` | 707 pass, 0 fail, 1 snapshot, 4,395 assertions |
| `npx tsc --noEmit` | exit 0 |
| `npx biome check .` | exit 0 after import-order correction |
| `swift test --package-path apps/side-mac` | exit 0, no failures |
| `bash -n apps/side-mac/scripts/build-app.sh` and `git diff --check` | exit 0 |

The smoke gate uses a temporary `SIDE_DATA_DIR`, synthetic master key, synthetic index row, and fake App protocol responses. It does not read or write the Aside ledger or user settings. It verifies the compiled binary's web route, FTS5/vec0 index, and actual local model inference, but does not exercise a physical Side.app UI or TCC permission flow.

The embedded ONNX addon is signed ad hoc at build time. P5-T5.2 must verify Developer ID signing and Hardened Runtime loading of that extracted addon as well as the visible bundle contents; this run does not prove notarized distribution.

## Open acceptance gate

The approved acceptance criterion requires launching on a clean Mac without Homebrew and seeing every `side doctor` item PASS. This run used a build Mac with Homebrew and did not have a fresh Mac/TCC grant or configured summary provider. An isolated compiled `side doctor` run showed `PASS custom SQLite`, `PASS vec0`, and `PASS model cache`, while Keychain, permissions, and provider connection failed because no Side.app helper or provider was running. Therefore P5-T5.1 remains unchecked in `docs/planning/06-tasks.md`; the clean-Mac doctor criterion is unproven.
