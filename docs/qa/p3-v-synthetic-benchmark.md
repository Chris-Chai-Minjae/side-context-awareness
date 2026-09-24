# P3-V 합성 MCP 검색 성능 증거

- 측정: 2026-09-24 05:34 JST, macOS 27.0 arm64, Bun 1.3.5
- 실행: `bun run scripts/gates/g7b-benchmark.ts`
- 상태: 합성 검색 성능 측정 PASS. P3-V 전체 완료 판정은 보류.

## 데이터와 측정 경로

임시 디렉터리에 2026-09-10부터 2026-09-23까지 14일치 day page 14개를 만든다. 하루에 10분 창 48개, 창마다 합성 캡처 2건을 기록한다. 실제 DB에서 확인한 크기는 이벤트 1,344건, 완료 요약 672건, 메모리 청크 672건, 해시된 검색어 행 96,192건, day page 127,616바이트다.

SDK client가 별도 `side mcp` stdio 프로세스에 연결하고, 각 도구는 UDS JSON-RPC를 거쳐 실제 `createEvidenceHandlers` / `createMemorySearchHandler`, 암호화 ledger 검색, FTS5, sqlite-vec 검색을 수행한다. `sqlite`, `vector`, `browser`, `scheduler` 네 질의를 순환하며 도구별 질의당 2회(총 8회) 워밍업 후 질의당 30회(총 120회) 직렬 측정한다. p95는 정렬된 120개 시료의 `ceil(0.95 × 120)`번째 값이다. 통과 조건은 client 왕복과 MCP 사용 로그의 p95가 각각 문서의 상한 이하이고, 모든 응답이 성공·비어 있지 않으며, 사용 로그에 128회가 모두 기록된 경우다.

합성 master key는 메모리의 고정 버퍼이며 Keychain을 호출하지 않는다. `SIDE_DATA_DIR`와 `LCA_DATA_DIR`는 MCP 자식 프로세스에서도 해당 임시 디렉터리로 고정된다. 브라우저 이력 provider는 빈 합성 응답을 사용한다. 임베딩은 결정적 합성 384차원 벡터를 사용하므로 모델 다운로드·추론 시간은 측정에 포함되지 않는다. 임시 디렉터리는 측정 후 삭제한다.

## 결과

| 도구 | 측정 호출 | client 왕복 p95 | MCP 로그 p95 | 상한 | 판정 |
|---|---:|---:|---:|---:|---|
| `history_search` | 120 | 19.17ms | 18ms | 300ms | PASS |
| `memory_search` | 120 | 4.79ms | 4ms | 500ms | PASS |

```text
{"status":"pass","dataset":{"firstDay":"2026-09-10","lastDay":"2026-09-23","days":14,"events":1344,"summaries":672,"chunks":672,"termRows":96192,"dayPagesBytes":127616},"workload":{"queries":["sqlite","vector","browser","scheduler"],"callsPerQueryPerRoute":30},"scope":"synthetic MCP stdio + UDS + real search handlers and SQLite; deterministic embedding, no model inference","routes":[{"name":"history_search","warmupCalls":8,"measuredCalls":120,"thresholdMs":300,"roundTripP50Ms":16.08,"roundTripP95Ms":19.17,"mcpLogP95Ms":18,"passed":true},{"name":"memory_search","warmupCalls":8,"measuredCalls":120,"thresholdMs":500,"roundTripP50Ms":3.2,"roundTripP95Ms":4.79,"mcpLogP95Ms":4,"passed":true}]}
```

## 검사와 남은 게이트

- `bun test`: 625 pass, 0 fail, 1 snapshot, 3,939 assertions.
- `npx tsc --noEmit`: 종료 코드 0, 출력 없음.
- `npx biome check .`: 종료 코드 0.
- Swift 파일은 변경하지 않아 Swift 게이트는 실행하지 않았다.

P3-V의 S2(Claude Code 등록 후 실제 질의)와 S6(Aside와 Claude Code의 동일 ref 집합)는 이 측정에 포함되지 않는다. 실제 임베딩 모델을 로드한 `memory_search` 지연, 실제 브라우저 이력, 앱/헬퍼/Keychain 연동도 이 수치로 판정할 수 없다. `docs/planning/06-tasks.md`의 P3-V 체크박스는 변경하지 않았다.
