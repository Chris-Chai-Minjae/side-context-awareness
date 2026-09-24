# P3-V S6: synthetic Aside MCP fixture

Status: **S6 passed on one live synthetic fixture** (2026-09-24). Aside and Claude Code each called the Side MCP tools against the same local socket and returned the same ref set. This proves the two clients agree for this fixture; it does not prove real user history or a long-running capture session.

Run from the repository root:

```sh
bun run scripts/gates/p3-aside-fixture.ts
```

Keep this terminal open. Its single `ready` JSON line contains `registration.command` (an executable wrapper path), `registration.args` (empty), and `expectedRef` (`e:`). The wrapper sets `HOME`, `SIDE_DATA_DIR`, and `LCA_DATA_DIR` to a private temporary root, then runs the repository's `side mcp` CLI. The harness first checks synthetic `history_search` and `history_read`, then keeps its approved local API and UDS alive. The line contains no key or captured plaintext.

In Aside **Settings → MCP → Add server**, enter a temporary name such as `side-s6-fixture`, set command to the printed `registration.command`, and leave args empty. Manually ask Aside to use `history_search` with `{"queries":["sqlite","확장","문서"],"limit":5}`, then `history_read` with the printed `expectedRef`. Compare the returned ref set with a separately observed Claude Code query against this same live fixture. Record both client transcripts and the comparison before assessing S6; a local preflight or SDK test alone does not satisfy S6.

Press Ctrl-C when finished. SIGINT/SIGTERM stops the local API, closes the synthetic ledger, clears the synthetic key, and removes the temporary root. Any temporary Aside registration must be removed manually in Aside; this harness never edits Aside settings or reads its ledger.

## Live client comparison

- Fixture: `side-s6-fixture`, synthetic URL `https://fixture.invalid/sqlite/extensions/vec0-guide`, expected ref `e:01M36E58P0139SQYT2GVP2MPKK`, synthetic body marker `S6_SYNTHETIC_SNIPPET`.
- Aside: the registered MCP server's raw `history_search({"queries":["sqlite","확장","문서"],"limit":5})` tool result returned exactly `["e:01M36E58P0139SQYT2GVP2MPKK"]`. Its raw `history_read({"id":"e:01M36E58P0139SQYT2GVP2MPKK"})` tool result returned the expected URL, `expired:false`, and the synthetic marker.
- Claude Code: a separate headless invocation with the same fixture wrapper called `mcp__side__history_search` with the same query and limit, then `mcp__side__history_read` with that ref. The raw JSONL tool results returned exactly the same one-ref search set, URL, `expired:false`, and marker. Claude exited 0 with no permission denials. Evidence transcript: `/tmp/side-s6-claude.WKER9m/stream.jsonl` (temporary local artifact).
- Comparison: both clients returned the same ordered ref set and read the same source. The verdict uses raw MCP tool results, not agent narrative.

## Local verification

- RED: the focused test failed with `Fixture exited before ready` before the harness existed.
- GREEN: `bun test tests/gates/p3-aside-fixture.test.ts` exercised the real MCP SDK through the printed wrapper and cleanup for both SIGINT and SIGTERM.
- `bun test`: 744 pass, 0 fail; `bunx tsc --noEmit`: exit 0; `bunx biome check .`: 202 files checked, exit 0; `swift test --package-path apps/side-mac`: exit 0.

These checks establish the synthetic fixture, source behavior, and one live Aside/Claude Code same-ref comparison. Manual removal of the temporary Aside MCP registration remains a user action.
