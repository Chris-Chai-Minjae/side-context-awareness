# Phase 3 — M3 인덱스·회수·MCP·CLI

기준: 2026-09-24. P3-T3.1~T3.9와 P3-V의 명시된 세 수용 항목을 완료했다. 판정 범위는 합성 데이터와 로컬 MCP 클라이언트 검증이다.

## 완료와 증거

- 일간 페이지 청킹, MiniLM q8·SQLite vec0 인덱스, 증분 동기화, 하이브리드 `memory_search`, lexical `history_search`, `history_read`, 브라우저 이력 provider, `side mcp`, CLI·doctor를 구현했다. 태스크별 범위는 [06-tasks](../planning/06-tasks.md)의 Phase 3 항목을 따른다.
- [14일 합성 데이터의 실제 임베딩 벤치마크](p3-v-real-embedding.md): 672개 청크·128개 질의 임베딩, MCP stdio→UDS→검색 handler 왕복 `history_search` p95 33.97ms(상한 300ms), `memory_search` p95 11.95ms(상한 500ms). 첫 모델 로드는 p95에서 제외했다.
- [Claude Code S2](p3-v-claude-code.md): 실제 MCP `history_search`의 상위 5개에 합성 SQLite 문서 URL이 나왔고, 반환된 ref의 `history_read`에서 합성 스니펫을 확인했다.
- [Aside·Claude Code S6](p3-v-aside-s6.md): 같은 Side 합성 fixture에 대해 두 클라이언트의 원시 MCP 검색 결과가 동일한 한 개의 ref였고, 각 `history_read`가 같은 URL·본문 표식을 반환했다. 두 클라이언트의 설명문은 판정에 쓰지 않았다.
- Phase 3 fixture 추가 뒤 `bun test`: 744 pass, 0 fail; `bunx tsc --noEmit`: exit 0; `bunx biome check .`: 202 files, exit 0; `swift test --package-path apps/side-mac`: exit 0. S6 호출은 이 자동 게이트와 별도로 실제 Aside·Claude Code에서 관측했다.

## 미결과 범위

- 합성 master key와 임시 ledger를 썼다. 실제 사용자 ledger의 행 내용은 읽지 않았고, 실제 브라우저 이력·장시간 앱 캡처·Keychain·TCC 경로의 성능을 이 결과로 판정하지 않는다. 그 실기기 게이트는 Phase 1·2 및 전체 수용 검증에 남아 있다.
- S6용 임시 Aside MCP 등록 `side-s6-fixture`은 사용자가 Aside 설정에서 제거해야 한다. 로컬 fixture 프로세스는 종료했고 임시 ledger 디렉터리 삭제를 확인했다.
