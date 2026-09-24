# P3-V S2: Claude Code → Side MCP 회수 검증

- 실행: 2026-09-24 06:17 JST 초기 실행, 14:44 JST 재검증. macOS arm64, Bun 1.3.5, Claude Code 2.1.281
- 판정: **S2 통과**. Claude Code가 등록된 Side MCP에서 `history_search`와 `history_read`를 실제 호출했다. P3-V 전체는 S6 미검증으로 열려 있다.
- 범위: P3-V의 S2만. 기능 명세와 `specs/`는 변경하지 않았고, 검증 결과에 따라 `docs/planning/06-tasks.md`의 S2 체크박스만 갱신했다.

## 재현 방법

```sh
bun run scripts/gates/p3-agent-recall.ts
bun run scripts/gates/p3-agent-recall.ts --normal
bun run scripts/gates/p3-agent-recall.ts --existing-auth
```

하네스는 매 실행마다 별도 임시 디렉터리에 합성 ledger와 Claude 설정을 만든다. 전날 15:10 JST에 `https://fixture.invalid/sqlite/extensions/vec0-guide`를 본 합성 `content.snapshot` 하나를 기록하며, 본문은 `S2_SYNTHETIC_SNIPPET: vec0 가상 테이블은 이 합성 문서의 예시입니다.`이다. 합성 master key와 실제 `createEvidenceHandlers`를 사용한 사전 검사에서 검색 상위 5개에 URL/ref가 있고 `history_read` 본문에 스니펫이 있음을 확인한다. 그다음 `claude mcp add --scope project side -- <bun> <side-cli> mcp`로 임시 프로젝트에 등록하고, 같은 데이터 디렉터리의 실제 UDS API와 별도 `side mcp` stdio 서버를 열어 Claude Code에 “어제 오후에 보던 sqlite 확장 문서”를 묻는다. 성공 판정은 **Claude Code의 stream-json transcript에 있는** `history_search` 응답의 상위 5개 URL/ref와, 그 ref를 입력으로 받은 `history_read` 응답의 스니펫을 검사한다. SDK client 호출만으로 S2를 통과시키지 않는다.

Claude 실행은 작업 디렉터리를 임시 경로로 고정하고, `--strict-mcp-config --mcp-config <임시 .mcp.json>`, `--setting-sources ""`, `--no-session-persistence`, `--no-chrome`, `--permission-mode dontAsk`를 사용한다. 허용 도구는 Side의 `history_search`와 `history_read`뿐이며 모델은 `sonnet`, 노력 수준은 `low`, 지출 상한은 USD 0.20, 실행 제한은 90초다. 기본 실행 `--bare`와 `--normal`은 임시 `CLAUDE_CONFIG_DIR`도 사용한다. `--existing-auth`만 기존 Claude Code 인증 경로를 사용한다. 임시 경로는 `finally`에서 삭제한다. 전역 MCP 등록이나 실제 Aside ledger 및 `~/.aside` 읽기·쓰기는 하지 않았다. Claude 내부의 전역 설정 쓰기 여부를 별도로 추적하지 않았으므로 그 범위의 무변경 주장은 하지 않는다.

## 초기 실패 기록

기본 `--bare` 실행은 종료 코드 1, `fixturePreflight=pass`, `toolUses=[]`, `mcpUsage=[]`였다. Claude의 진단은 `Not logged in · Please run /login`이었다. 이 실행 환경에는 `ANTHROPIC_API_KEY`가 없고 `--bare`는 OAuth/Keychain 인증을 사용하지 않는다.

```json
{"status":"unresolved","mode":"bare","claudeExitCode":1,"fixturePreflight":"pass","targetUrl":"https://fixture.invalid/sqlite/extensions/vec0-guide","sourceRef":"e:01M36E58P0NYPKFGFSAST3PCZB","historySearchRank":null,"historyReadSnippet":false,"toolUses":[],"mcpUsage":[],"cliError":"Not logged in · Please run /login","reason":"ANTHROPIC_API_KEY is absent; claude --bare has no OAuth or keychain authentication"}
```

기존 전역 Claude OAuth 상태는 코디네이터가 로그인 상태로 확인했으나, `--normal` 실행에서도 임시 `CLAUDE_CONFIG_DIR`에는 그 인증이 제공되지 않았다. 종료 코드 1과 동일한 로그인 진단이 나왔으며 Side MCP 호출은 0회였다.

```json
{"status":"unresolved","mode":"isolated-normal","claudeExitCode":1,"fixturePreflight":"pass","targetUrl":"https://fixture.invalid/sqlite/extensions/vec0-guide","sourceRef":"e:01M36E58P0SSJ90KCBB5VPPR4K","historySearchRank":null,"historyReadSnippet":false,"toolUses":[],"mcpUsage":[],"cliError":"Not logged in · Please run /login","reason":"Claude Code OAuth is unavailable in the isolated configuration"}
```

`--existing-auth`는 임시 MCP 설정과 합성 Side 데이터만 사용하되, 이 Mac의 기존 Claude Code OAuth를 사용하도록 `CLAUDE_CONFIG_DIR`을 덮어쓰지 않는다. 초기 하네스에서 `claude auth status --json`은 `loggedIn: true`였지만 실제 모델 호출은 즉시 `Failed to authenticate: OAuth session expired and could not be refreshed`로 실패했다. 당시 Side MCP 호출은 0회였다. 재검증에서 원인은 하네스가 자식 프로세스의 `USER`와 `LOGNAME`을 누락한 점으로 좁혀졌다. 인증 값은 이 보고서와 출력에 기록하지 않았다.

```json
{"status":"unresolved","mode":"existing-auth-normal","claudeExitCode":1,"fixturePreflight":"pass","historySearchRank":null,"historyReadSnippet":false,"toolUses":[],"mcpUsage":[],"cliError":"Failed to authenticate: OAuth session expired and could not be refreshed","reason":"Local Claude Code OAuth expired before MCP invocation"}
```

초기 세 실행에서는 실제 Claude Code 모델 호출, 검색 도구 호출, 읽기 도구 호출이 확인되지 않았다. 후크 실행 또는 전역 설정 변경의 증거는 관찰되지 않았지만, 파일시스템 감사로 이를 독립 검증하지는 않았다.

## 재검증 결과

일반 `claude` 모델 호출은 성공했고, `USER`와 `LOGNAME`만 복원한 격리 자식 프로세스도 성공했다. 수정된 하네스는 `claude mcp add --scope project`가 만든 `.mcp.json`을 확인한 후 이를 사용한다. Claude Code의 `stream-json`은 MCP 결과 JSON을 `<untrusted-evidence nonce="…">…</untrusted-evidence nonce="…">`로 감쌌다. 하네스는 일치하는 nonce의 태그 안쪽만 JSON으로 읽고, 형식이 다르면 실패로 판정한다.

```json
{"status":"pass","mode":"existing-auth-normal","claudeExitCode":0,"fixturePreflight":"pass","targetUrl":"https://fixture.invalid/sqlite/extensions/vec0-guide","sourceRef":"e:01M36E58P0BG9PFXXMKFNVA7N6","historySearchRank":1,"historyReadSnippet":true,"toolUses":["ToolSearch","mcp__side__history_search","mcp__side__history_read"],"mcpUsage":[{"clientName":"claude-code","tool":"history_search"},{"clientName":"claude-code","tool":"history_read"}],"cliError":null,"reason":null}
```

별도 임시 프로젝트에서 `claude mcp add --scope project side -- <bundled-side> mcp`도 종료 코드 0으로 완료했고, 생성된 `.mcp.json`의 command와 args가 번들 Side 실행 파일과 일치했다. 실제 질의는 Phase 3 소스 CLI로 실행했으므로 이 등록 점검을 번들 앱의 회상 런타임 검증으로 확대하지 않는다. P3-V의 S2 항목만 충족하며 S6의 Aside 대조는 아직 필요하다.

## 초기 프로젝트 검사(실패 시점의 기록)

- `bun test`: 종료 코드 0. 686 pass, 0 fail, 1 snapshot, 4,259 assertions (67개 파일).
- `npx tsc --noEmit`: 종료 코드 0, 출력 없음.
- `npx biome check .`: 종료 코드 0, 182개 파일 검사, 수정 없음.
- `swift test --package-path apps/side-mac`: 종료 코드 0. 출력 끝의 `All tests`는 10 tests, 0 failures였고 다른 Swift test bundle의 합계는 이 실행의 tail 출력에 포함되지 않았다.
- 최종 하네스에서 기본/`--normal` 재실행: 둘 다 종료 코드 1과 위의 인증 실패 진단. 따라서 S2는 여전히 미해결이다.
- `--existing-auth` 추가 후 전체 재검사: `bun test` 696 pass, 0 fail, 4,307 assertions (68개 파일); `npx tsc --noEmit` 종료 코드 0; `npx biome check .` 184개 파일 통과; `swift test --package-path apps/side-mac` 종료 코드 0. `--existing-auth` 게이트 자체는 만료된 OAuth로 종료 코드 1이며 S2를 통과하지 못했다.

## 14:52 JST 최종 검사

- `bun run scripts/gates/p3-agent-recall.ts --existing-auth`: 종료 코드 0, `status=pass`, URL 검색 순위 1위, `historyReadSnippet=true`, 두 Side 도구의 Claude Code transcript와 MCP 사용 기록 확인.
- `bun test`: 742 pass, 0 fail, 4,813 assertions (75개 파일).
- `npx tsc --noEmit`: 종료 코드 0. `npx biome check .`: 200개 파일 검사, 오류 없음.
- `swift test --package-path apps/side-mac`: 종료 코드 0, SideCaptureKit 및 SideApp 테스트 실패 없음.
- 최초 전체 Bun 실행은 Day view E2E fixture가 오늘 09:10을 미래 시각으로 만드는 UTC 조건에서 1건 실패했다. `tests/e2e/day-view-fixture.ts`의 오늘 요약 시작을 당일 00:00으로 고정한 뒤 해당 E2E 단독 실행과 전체 742개가 통과했다.
