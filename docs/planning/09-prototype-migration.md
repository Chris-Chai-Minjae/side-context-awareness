# 09 — 기존 프로토타입(`local-context-awareness` v0.1.0) 이관

기준 상태 `[measured 2026-09-23]`: src 7모듈, 테스트 21개 통과, `tsc --noEmit` 0 오류.
`package.json`의 `start`는 `src/cli.ts`를 가리키지만 이 파일은 없다.

| 파일 | 판정 | 변경 내용 |
|---|---|---|
| `src/config.ts` | **수정** | v2 스키마(`02-architecture.md` §6)로 교체하고 v1→v2 마이그레이션을 추가한다. 데이터 디렉터리를 `Side`로 옮긴다(`LCA_DATA_DIR`는 읽기 호환만). 원자적 저장 패턴은 유지한다. 기본값은 `captureTypedText=true`, `screenOcr=true`로 바꾼다. 마스터 스위치 `enabled=false`는 그대로다 |
| `src/crypto.ts` | **유지 + 확장** | HKDF subkey 파생과 `seal/open`의 AAD 인자를 추가한다. 기존 포맷(iv·tag·ct)은 유지한다 |
| `src/policy.ts` | **유지 + 확장** | 규칙 유니온(`app`/`url`, `do_not_observe`)을 받게 하고, 하드 차단 bundle 목록을 추가한다 |
| `src/redact.ts` | **유지 + 확장** | `{text, masks}` 반환, 규칙 라벨, `api-key`·`otp-numeric`·`labeled-secret` 확장, 한국어 라벨 |
| `src/typed.ts` | **유지 + 확장** | flush 트리거(submit·blur·5분 idle)와 4096B 상한 |
| `src/store.ts` | **교체** | 정본 DDL ledger(`ledger/`)로 대체한다. keyed-hash term index 아이디어와 `indexTerms`는 `side_terms`로 옮긴다. `memory_vectors` 테이블은 폐기한다(인덱스는 `index.db`로 분리) |
| `src/observe.ts` | **교체** | 폴링·프로세스 spawn 방식을 폐기하고 helper 프로토콜 클라이언트(`helper/`)로 바꾼다. AppleScript URL 조회는 Side.app(NSAppleScript)으로 옮긴다. tesseract OCR은 Vision으로 대체한다. 전경 변경 이중 확인 로직은 스케줄러의 실행 단계로 옮긴다 |
| `native/observe.swift` | **흡수** | AX 텍스트 추출(BFS 400노드·12,000자, SecureTextField 제외)을 `SideCaptureKit`으로 옮기고 상주형으로 전환한다 |
| `native/key.swift` | **흡수** | Keychain 로직을 Side.app으로 옮긴다. 서비스 이름을 유지해 기존 키를 재사용한다 |
| `tests/*` | **유지 + 확장** | 기존 21개는 새 API에 맞춰 수정하되 기대값은 보존한다. `tests/fixtures/ocr.png`는 Vision OCR 테스트로 재사용한다 |
| `package.json` | **수정** | 이름 `side`, 스크립트 `dev`/`build`(bun compile + swift build)/`test`/`check`(tsc+biome)로 바꾼다. 의존성: `sqlite-vec@0.1.9`, `@huggingface/transformers@4.3.0`, `@modelcontextprotocol/sdk@1.30.0`, `ulid` |

## 목표 디렉터리 구조

```
apps/side-mac/            # Xcode/SwiftPM: Side.app + SideCaptureKit(테스트 가능한 순수 로직)
src/
  constants.ts            # 캡처·요약·보존 상수(게이트 G5 대상)
  config/                 # settings v2 + migration
  crypto/ redact/ policy/ typed/
  helper/                 # JSON-lines 프로토콜 클라이언트, health
  capture/                # scheduler, attention, target, aside-adapter
  ledger/                 # DDL, 쓰기 경로, frames, gc, delete, stats
  comprehension/          # enqueue, claim, briefing, neutralize, prompt, contract, providers
  memory/                 # render, digest, chunk, index(sqlite-vec+fts5), embed
  recall/                 # history_search, history_read, browser-history
  api/                    # JSON-RPC 서버(UDS+TCP), 인증
  mcp/                    # MCP stdio 서버
  web/                    # 설정 SPA
  cli.ts                  # 진입점(서브커맨드)
tests/                    # 층별 테스트(08 §3)
```
