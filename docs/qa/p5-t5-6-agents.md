# P5-T5.6 에이전트 연결 문서 중간 검증

`README.md`에 설치, macOS 권한, 프라이버시, Side 데이터 위치와 삭제 방법을 작성했다. `docs/agents.md`에는 Claude Code·Codex·Cursor·Aside 등록 방법과 MCP 도구 3종 사용 예를 작성했다. 이 문서는 앱이 `/Applications/Side.app`에 설치된 경우를 기준으로 한다.

## 확인한 근거

- 로컬 `claude mcp add --help`에서 stdio 명령과 `--scope user` 형식을 확인했다. `claude mcp get side`는 현재 사용자의 Claude 설정에 Side가 아직 등록되지 않았음을 반환했다.
- 로컬 `codex mcp add --help`와 `codex mcp list --help`에서 명령 형식을 확인했다.
- Cursor 공식 [MCP 문서](https://docs.cursor.com/context/model-context-protocol)에서 `mcpServers.side.command`/`args`와 프로젝트 `.cursor/mcp.json`, 전역 `~/.cursor/mcp.json` 위치를 확인했다.
- Aside의 MCP client 지원과 Settings → MCP 등록 경로는 승인된 `docs/planning/00-decisions.md` ADR-003 및 `docs/planning/06-screens.md` S2를 따른다. Aside 설정 파일은 수정하지 않았다.
- `bun test tests/mcp/server.test.ts tests/cli/commands.test.ts` → 7 pass, 0 fail, 47 assertions. 테스트는 `side mcp`의 도구 목록, 요청 스키마, 데몬 중지 오류 및 CLI 승인 메서드 경로를 확인한다.

## 남은 수용 조건

`P5-T5.6`의 최종 수용은 새 Mac에서 문서만 따라 Claude Code를 연결하고 `history_search`의 실제 결과를 받는 것이다. 이 Mac에서는 `scripts/gates/p3-agent-recall.ts --existing-auth`가 임시 프로젝트에 Side 소스 CLI를 등록한 뒤 Claude Code의 `history_search`와 `history_read` 호출을 확인했다(`docs/qa/p3-v-claude-code.md`). 새 Mac의 설치·등록과 번들 Side 실행 파일을 통한 회상은 아직 검증하지 못했으므로 태스크 체크박스는 열어 둔다. README의 빌드 경로는 현재 `bun run build`가 만드는 `Side.app`과 일치하는지 릴리스 게이트에서 다시 대조한다.
