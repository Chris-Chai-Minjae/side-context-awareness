# Claude Code login provider — synthetic runtime check

2026-09-24, Claude Code CLI 2.1.281. `callClaudeCliSummary` was invoked twice from the Side source with an explicitly fictional documentation event and one fixture citation ID. The process ran from `/tmp`, used the existing Claude Code login, and called no macOS `security` command. No real Side/Aside activity, credential, response body, or title was printed or retained.

| Check | Result |
|---|---|
| Existing login and headless CLI call | Both calls exited 0 through the Side adapter; each completed in under 9 seconds |
| Structured result | Both calls returned a JSON object through `structured_output` |
| `RecordSummaryArgumentsSchema` | Second call passed, zero schema issues |
| Citation boundary | Second call's `citations` and `sourceIds` contained only the fixture ID |
| Tool exposure | Adapter arguments include `--restricted`, `--safe-mode`, an empty `--tools` allowlist, `--strict-mcp-config`, and `--no-session-persistence`; this run did not independently trace global hook or file activity |

This proves that the optional Claude Code summary adapter can use this Mac's existing login for a synthetic response satisfying the Side record contract. It does not prove actual provider consent in the GUI, queued live summaries, or long briefing reliability. Those paths remain separate acceptance checks.

## Packaged parent environment regression

The independent Astra review found that the GUI helper starts the daemon with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, while this Mac installs Claude at `~/.local/bin/claude`. `0b7f405` resolves an executable at the explicit home path when it is absent from the restricted PATH. A synthetic test with that exact parent environment failed before the fix and passed afterward; a Swift test locks the daemon PATH allowlist. `bun test tests/comprehension/claude-cli.test.ts` passed 7 tests and `swift test --filter SupervisorTests` passed 24 tests. No real packaged GUI-to-Claude call was made, so that physical path remains unverified.

## Account identity in the packaged daemon

A second Astra review found that the supervisor's environment allowlist also dropped `USER` and `LOGNAME`, which the existing Claude login may need for credential refresh. `2dfcc14` passes those two account identifiers to the daemon while keeping API token variables excluded. A synthetic Swift child checks the values received at process launch, and the Claude CLI stub checks them for both auth and summary calls. The full Swift suite passed 168 SideCaptureKit and 23 SideApp tests; the Bun suite passed 783 tests. The packaged GUI-to-Claude login path still requires a physical check.
