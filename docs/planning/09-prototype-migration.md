# 09 — 기존 프로토타입(`local-context-awareness` v0.1.0) 이관

기준 상태 `[measured 2026-09-23]`: src 7모듈, 테스트 21개 통과, `tsc --noEmit` 0 오류.
`package.json`의 `start`는 `src/cli.ts`를 가리키지만 이 파일은 없다.

| 파일 | 판정 | 변경 내용 |
|---|---|---|
| `src/config.ts` | **제거됨** | v1→v2 읽기 전용 마이그레이션은 `config/migrate.ts`, 설정 저장은 `config/index.ts`가 담당한다 |
| `src/crypto.ts` | **제거됨** | 암호화는 `crypto/index.ts`의 HKDF·AAD 경로만 사용한다 |
| `src/policy.ts` | **제거됨** | URL 정규화는 `policy/url.ts`, 규칙·하드 차단은 `policy/index.ts`로 분리했다 |
| `src/redact.ts` | **제거됨** | 규칙별 마스킹과 필드 판정은 `redact/`가 담당한다 |
| `src/typed.ts` | **제거됨** | 문장 추적기는 `typed/index.ts`를 직접 사용한다 |
| `src/store.ts`, `src/day-pages.ts`, `src/memory-search.ts`, `src/recall.ts`, `src/summary.ts`, `src/runtime.ts` | **제거됨** | 현행 ledger·memory·recall·comprehension·daemon 경로로 대체했다 |
| `src/observe.ts` | **제거됨** | 상주 helper 프로토콜과 SideCaptureKit으로 대체했다 |
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
