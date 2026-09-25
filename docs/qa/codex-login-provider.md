# Codex CLI login provider QA — 2026-09-25

## Scope

Side now accepts `codex-cli` as a keyless provider using the user's existing official Codex CLI ChatGPT login. The web Settings page and Swift onboarding expose **OpenAI (Codex login)** alongside the existing **OpenAI API** option; MiMo stays first in onboarding and Codex is an explicit choice. Both UIs show a bilingual warning to check each CLI provider's terms and usage limits.

The provider persists `id`, `kind`, `models`, and `allowEvidence` only. The settings resource reports no URL or Keychain reference. `providers.test` uses fictional empty activity, and ordinary summaries still require provider evidence consent. The existing summary chain, one-repair `record_summary` validator, and provider fallback path remain in use.

## CLI boundary

- Resolve and launch the `codex` executable; Side never opens or copies Codex auth files.
- Remove inherited API-key and auth-token environment variables, then require `codex login status` to report `Logged in using ChatGPT` before invoking `codex exec`.
- Create a private temporary directory with an empty working directory and a separate output-schema file; delete the directory after completion or failure.
- Run `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --skip-git-repo-check --json --output-schema ... --model ... -`, with the prompt on stdin.
- The strict schema has every property listed in `required`, including the nested citation `ref`. It covers the required `record_summary` fields; the shared validator checks lengths, citations, source IDs, redaction, and evidence membership.
- Bound stdout and stderr to 1 MiB together, share a 60-second deadline across login status and execution, poll evidence consent during execution, and kill the detached process group on revocation, timeout, overflow, or a tool event. A synthetic wrapper test proved that killing only the wrapper left its child running; group termination stopped both. Nonzero exit, malformed JSONL, missing final response, tool events, and invalid login fail closed.

## Test evidence

The new Codex runner tests were RED before implementation: calling a `codex-cli` provider attempted the HTTP branch and failed on `provider.baseUrl`; the provider test initially rejected an output with citations absent from its fictional probe. UI tests were RED for the missing Codex preset and for Automation buttons that remained active with all grants or no target. Swift tests were RED because the new preset and provider kind did not exist.

| Gate | Observed result |
| --- | --- |
| `bun test` | Latest integration run: 863 pass, 0 fail, 1 snapshot; synthetic CLI stub covers login, isolation, safe flags, empty cwd, schema, API-key scrubbing, wrapper-child termination, revocation, output cap, repair, fallback, and provider test. |
| `npx tsc --noEmit` | Exit 0. |
| `npx biome check .` | Checked 214 files, no fixes. |
| `swift test --package-path apps/side-mac` | Final full run: 179 SideCaptureKit tests and 25 SideApp tests pass. An earlier full invocation returned a SideCaptureKit test-target failure; the full rerun passed. |
| `SIDE_MODEL_CACHE_SOURCE=/Applications/Side.app/Contents/Resources/models bun run build` | Exit 0; Swift release, daemon, web assets, bundled public model assets, and app code-sign verification completed. Build output was left under `apps/side-mac/.build/release/Side.app`; the app was not installed. |

The first `bun run build` reached the web bundle and then failed when the public model CDN closed a tokenizer download. The successful build reused the same public model assets from the existing installed Side app as a read-only source. The initial worker run checked `codex login status` locally and verified CLI behavior with synthetic subprocess fixtures; it did not send captured user evidence.

## Coordinator follow-up: real CLI smoke with fictional input

The installed CLI writes `codex login status` to stderr. The original synthetic stub wrote to stdout, so a first real call failed before generation. The login stub was changed to match the installed CLI (focused test: 6 failed, 3 passed before the fix). The runner now captures bounded stdout and stderr separately and requires the combined auth-status text to equal `Logged in using ChatGPT`. Focused tests then passed (9/9), and Biome checked the three touched files.

A single real `gpt-6-luna` call using only a fictional `example.invalid` activity sentence and a synthetic evidence ID returned structured JSON in 10.7 seconds. CLI usage reported **21,412 input tokens and 123 output tokens**. This is one measurement, not a per-summary estimate. No real captured activity, URL, API key, or login token was sent or printed. The full suite and rebuilt app are checked at release integration.

## Final-review isolation repair

Astra high found that `--ignore-user-config` does not exclude the global `AGENTS.md` in the authenticated Codex home and that `--sandbox read-only` alone does not remove shell or web tools. It also found that the GUI daemon's restricted PATH omitted Homebrew and `/usr/local/bin`.

Side now checks only the existing Codex `auth.json` file's type, owner, and permissions, then links it into a private temporary `CODEX_HOME`. Side does **not** open, copy, or log the token contents; the official CLI reads its own OAuth state. The temporary HOME and working directory contain no personal instructions. Execution sets `project_doc_max_bytes=0`, disables shell, web, apps, plugins, and related tools before the model request, and still aborts if any tool event occurs. A synthetic global instruction marker was absent from the outbound request captured by a local fake HTTP server using the installed CLI. That request exposed no shell or web tool. No real account login or model call was made in this follow-up.

This isolated path supports **file-backed ChatGPT CLI login only**. Missing, unsafe, or Keychain-only auth fails closed; Side never falls back to the original Codex home. The GUI daemon PATH now includes `/opt/homebrew/bin` and `/usr/local/bin`, with a Swift regression test. Focused tests passed, followed by `bun test` (863 pass), `npx tsc --noEmit`, `npx biome check .`, and the full Swift suite. A fresh release build after the isolation and MCP connection fixes exited 0, and `codesign --verify --deep --strict` passed. Installation, macOS permissions, and real-account credential refresh still require separate checks.
