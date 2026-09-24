# P3-V 실제 MiniLM 임베딩 MCP 검색 성능 증거

- 측정: 2026-09-24 JST, Darwin 27.0.0 arm64, Bun 1.3.5
- 재현 명령: `bun run scripts/gates/g7b-benchmark.ts --real-embedding`
- 결과: 명세의 합성 데이터 p95 항목 PASS. P3-V 전체 판정은 보류.

## 데이터와 측정 경로

기존 결정적 벤치마크와 같은 2026-09-10~2026-09-23의 14일 합성 데이터를 임시 디렉터리에 만든다. 하루 48개 창, 창당 2개 캡처로 이벤트 1,344건, 완료 요약 672건, day page 14개(127,616바이트)를 만들었다. `syncMemoryIndex`가 672개 청크를 실제 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` q8 모델로 임베딩하고, `chunks_vec`의 행 수도 청크 수와 일치하는지 검사한다. 검색 handler는 같은 `EmbeddingManager`로 `memory_search` 질의를 임베딩한다. 모델 워밍업 호출 1회, 인덱스 임베딩 672회, 검색 질의 임베딩 128회를 확인했다.

SDK client → 별도 `side mcp` stdio 프로세스 → UDS JSON-RPC → 실제 검색 handler, 암호화 ledger, FTS5, sqlite-vec 경로를 측정했다. `sqlite`, `vector`, `browser`, `scheduler` 네 질의를 도구별 각 2회(총 8회) 워밍업한 뒤 각 30회(총 120회) 직렬 측정했다. 도구별 MCP 사용 로그는 워밍업과 측정을 합쳐 정확히 128개이며, 모든 응답이 성공하고 비어 있지 않아야 한다. p95는 측정 시료 120개 중 정렬된 114번째 값이다. client 왕복과 MCP 로그의 p95가 각각 해당 상한 이하여야 PASS다.

모델의 최초 로드 및 워밍업은 8,898.69ms였고, 데이터 생성과 인덱스 동기화를 합친 시간은 5,660.39ms였다. 둘 다 아래 MCP 검색 지연에는 포함하지 않았다. 임시 데이터 디렉터리와 모델 캐시는 실행 후 삭제한다.

## 실측 결과

| 도구 | 워밍업 / 측정 호출 | client p50 / p95 | MCP 로그 p95 | 상한 | 판정 |
|---|---:|---:|---:|---:|---|
| `history_search` | 8 / 120 | 20.48 / 33.97ms | 32ms | 300ms | PASS |
| `memory_search` | 8 / 120 | 6.41 / 11.95ms | 11ms | 500ms | PASS |

```json
{"status":"pass","dataset":{"firstDay":"2026-09-10","lastDay":"2026-09-23","days":14,"events":1344,"summaries":672,"chunks":672,"termRows":96192,"dayPagesBytes":127616},"workload":{"queries":["sqlite","vector","browser","scheduler"],"callsPerQueryPerRoute":30},"scope":"synthetic MCP stdio + UDS + real search handlers and SQLite; MiniLM q8 indexed vectors and query inference","embedding":{"modelId":"Xenova/paraphrase-multilingual-MiniLM-L12-v2","dtype":"q8","modelWarmupCalls":1,"modelWarmupMs":8898.69,"fixtureBuildMs":5660.39,"indexedEmbeddings":672,"queryEmbeddings":128},"routes":[{"name":"history_search","warmupCalls":8,"measuredCalls":120,"thresholdMs":300,"roundTripP50Ms":20.48,"roundTripP95Ms":33.97,"mcpLogP95Ms":32,"passed":true},{"name":"memory_search","warmupCalls":8,"measuredCalls":120,"thresholdMs":500,"roundTripP50Ms":6.41,"roundTripP95Ms":11.95,"mcpLogP95Ms":11,"passed":true}]}
```

## RED→GREEN 및 검사

- RED: 변경 전 `--real-embedding` 실행 결과에 실제 모델 정보가 없음을 검사했고 `RED: benchmark did not use actual MiniLM`으로 종료 코드 1을 확인했다.
- GREEN: 같은 실제 모델 조건에 더해 인덱스 임베딩 672회, 질의 임베딩 128회, p95 PASS를 검사해 종료 코드 0을 확인했다.
- `bun run scripts/gates/g7b-benchmark.ts`: 종료 코드 0. 기존 결정적 임베딩 경로와 출력 형식을 유지했다.
- `bun test`: 684 pass, 0 fail, 1 snapshot, 4,185 assertions.
- `npx tsc --noEmit`: 종료 코드 0. 이 checkout에는 `tsconfig.json`이 요구하는 `@types/chrome`이 선언·설치되어 있지 않아 최초 실행은 TS2688이었다. 검증을 위해 `npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @types/chrome`으로 무시된 `node_modules`에만 임시 설치했다. 새 checkout의 타입 검사 재현에는 이 기존 의존성 누락을 별도로 해결해야 한다.
- `npx biome check .`: 종료 코드 0, 181개 파일 검사.
- `swift test --package-path apps/side-mac`: 134 tests, 0 failures.

통합 브랜치에서는 사용되지 않는 `chrome` ambient type 요구를 `tsconfig.json`에서 제거했다(`6615e06`). 같은 `--real-embedding` 명령을 다시 실행해 14일/672벡터/128질의 조건을 확인했고, `history_search` p95 21.01ms와 `memory_search` p95 7.99ms로 종료 코드 0이었다. 최초 모델 워밍업 9,778.4ms는 p95에서 제외했다.

## 증거 범위와 남은 항목

브라우저 이력 provider는 빈 합성 응답이며, 실제 Aside ledger 행이나 사용자 데이터를 읽지 않았다. 합성 master key를 사용하므로 Keychain, 앱/헬퍼, 실제 브라우저 이력의 지연은 이 수치에 포함되지 않는다. 모델 ID와 q8 설정은 실제 앱 코드와 같지만 모델의 원격 revision을 고정한 검증은 아니다. `docs/planning/06-tasks.md`의 P3-V에서 S2(Claude Code 등록 후 실제 질의)와 S6(Aside와 Claude Code의 동일 ref 집합)는 별도 검증이 필요하며, P3-V 체크박스는 변경하지 않았다.
