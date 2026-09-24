# 04 — Data Model (FR-3 · FR-9)

## 1. 도메인 용어 `[verified]`

- **Event**: 관찰된 한 순간(`03-capture.md` §1)
- **Blob**: `content_hash`로 중복 제거된 캡처 본문
- **Frame**: blob 묶음 압축본(멤버 ≤ 32, 원본 ≤ 4MB, zstd level 12)
- **Session / Stay / Dwell**: `03-capture.md` §4
- **Summary**: `10min` 창 요약 또는 `6h` 롤업. 작업 큐를 겸한다
- **Day page**: `memory/episodic/context-awareness-YYYY-MM-DD.md`

## 2. DDL — Aside ledger 원본 그대로 `[measured: 2026-09-24 sqlite_master 덤프]`

```sql
CREATE TABLE context_awareness_blobs (
  id TEXT PRIMARY KEY NOT NULL, content_hash TEXT NOT NULL, content BLOB NOT NULL,
  redacted_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  frame_id TEXT, frame_index INTEGER);
CREATE TABLE context_awareness_events (
  id TEXT PRIMARY KEY NOT NULL, occurred_at INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
  app_name TEXT NOT NULL DEFAULT '', bundle_id TEXT NOT NULL DEFAULT '', window_title TEXT NOT NULL DEFAULT '',
  url TEXT, domain TEXT, target TEXT NOT NULL DEFAULT '{}', payload TEXT NOT NULL,
  blob_id TEXT REFERENCES context_awareness_blobs(id) ON DELETE SET NULL, session_id TEXT);
CREATE TABLE context_awareness_frames (
  id TEXT PRIMARY KEY NOT NULL, content BLOB NOT NULL, member_count INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE context_awareness_summaries (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', body TEXT,
  apps TEXT NOT NULL DEFAULT '[]', domains TEXT NOT NULL DEFAULT '[]', citations TEXT NOT NULL DEFAULT '[]',
  source_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
  model TEXT NOT NULL DEFAULT '', input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0, digested_at INTEGER);
-- 인덱스 13개도 원본 그대로 (blobs_frame, blobs_hash UNIQUE, blobs_last_seen, events_app(bundle_id,occurred_at),
-- events_blob, events_domain(domain,occurred_at), events_occurred, events_session(session_id,occurred_at),
-- summaries_lease(status,lease_expires_at), summaries_ready(status,available_at), summaries_status(status,window_from),
-- summaries_unique_window(kind,window_from,window_to) UNIQUE, summaries_window(kind,window_to))
```

### 2.1 Side 보조 테이블 `[design]`
```sql
CREATE TABLE side_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- schema_version, deletion_epoch, account_generation, last_enqueued_10min, last_gc_at
CREATE TABLE side_terms (term_hash TEXT NOT NULL, event_id TEXT NOT NULL
  REFERENCES context_awareness_events(id) ON DELETE CASCADE, PRIMARY KEY(term_hash, event_id)) WITHOUT ROWID;
CREATE TABLE side_suppressions (bucket_start INTEGER NOT NULL, scope TEXT NOT NULL, key_hash TEXT NOT NULL,
  count INTEGER NOT NULL, PRIMARY KEY(bucket_start, scope, key_hash)) WITHOUT ROWID;
CREATE TABLE side_day_counters (day TEXT PRIMARY KEY, events INTEGER, blobs INTEGER, raw_bytes INTEGER,
  suppressions INTEGER, masks INTEGER);
```
- PRAGMA: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `secure_delete=ON`, `auto_vacuum=INCREMENTAL`(생성 시).

## 3. 컬럼별 저장 형식 (ADR-008)

| 컬럼 | 형식 | 비고 |
|---|---|---|
| `events.id`, `blobs.id`, `frames.id`, `summaries.id` | ULID | 인용 표기 `e:<id>`, `s:<id>` |
| `events.window_title`, `url`, `target` | `seal()` base64url | 빈 값이면 `''`(DEFAULT)를 그대로 둔다 |
| `events.payload` | `seal(JSON)` | `{trigger, shape, masks, inlineText?≤INLINE_TEXT_BYTES(2048), redactedField?, chord?, reason?}` |
| `events.domain` | 평문 소문자 host | 필터·denylist 통계 |
| `events.app_name`, `bundle_id`, `source`, `kind`, `session_id`, `occurred_at` | 평문 | |
| `blobs.content_hash` | HMAC-SHA256(subkey `content-hash`, 정규화 본문) | 평문 해시는 사전 공격에 노출되므로 keyed hash를 쓴다 |
| `blobs.content` | frame 편입 전: `seal(본문)` BLOB / 편입 후: 빈 BLOB, `frame_id`·`frame_index`로 참조 | |
| `blobs.redacted_bytes` | redaction 후 UTF-8 바이트 수 | 통계 `rawBytes` |
| `frames.content` | `seal(zstd12(concat(members)))` | 멤버 오프셋 표 포함 |
| `summaries.*` | 평문 | ADR-008 |

## 4. 키 관리

- 마스터 키: Keychain generic password `service=local-context-awareness-ledger`(기존 `key.swift`의 이름을 유지해 마이그레이션 불필요), `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
- HKDF-SHA256(salt = `"side/v1"`)로 파생한다:
  - `context-awareness.evidence`(원본 `DK_SUBKEY_PURPOSE` `[verified]`): seal에 쓴다
  - `context-awareness.terms`: term index 해시
  - `context-awareness.content-hash`: blob 중복 제거
- `seal` 형식: 기존 `crypto.ts`를 유지한다(iv 12B + tag 16B + ct, base64url). AAD로 `table:column:id`를 넣어 **컬럼 간 바꿔치기를 막는다** `[design]`.
- 키가 없거나 Keychain이 잠겨 있으면 데몬은 `state=stopped`, 사유 `keychain-locked`로 올라온다. 캡처하지 않는다.
- "Clear all history" 시에는 키도 교체한다(crypto-shred). 데몬은 캡처를 중지하고 진행 중인 요약이 끝나기를 기다린 뒤 삭제 트랜잭션을 커밋한다. 앱에 `keychain.rotate`를 요청하고, 앱은 기존 Keychain 키 항목을 삭제한 후 새 키를 생성·저장하고 32B 새 키를 stdio 결과로 한 번 돌려준다(`02-architecture.md` §3). 데몬은 이전 메모리 키와 복호화 캐시를 지우고 새 키로 교체한 뒤 캡처를 재개한다. 회전이 실패하거나 결과가 유효하지 않으면 캡처를 재개하지 않고 오류를 반환한다.

## 5. 쓰기 경로

```
observation → policy(denylist/pause/secure) → redact → normalize
  → blob upsert: hash=HMAC(content); 기존 있으면 last_seen_at 갱신, 없으면 seal 저장
  → event insert (seal 컬럼) → side_terms insert (title+inline+blob 앞 8,000자, 기존 indexTerms 유지)
  → day counters ++
```
- 트랜잭션은 이벤트 1건 단위로 묶는다. 기존 `store.ts`의 "같은 kind·지문이 300s 안에 반복되면 생략" 규칙은 blob 중복 제거로 대체한다. 이벤트는 남기고 blob만 공유한다.
- **프레임 봉인**: blob이 `FRAME_COLD_AGE_MS`(10분)보다 오래됐거나 `FRAME_IDLE_SEAL_MS`(20분) 동안 쓰기가 없으면 frame으로 묶는다. 한 번에 `SEAL_BATCH_BLOBS`(1024)개, 멤버는 32개 또는 4MB 이하로 나눈다. frame 읽기 캐시는 `FRAME_CACHE_MAX_BYTES`(16MB) LRU로 둔다.
- 읽기 1회 한도: `READ_CALL_BYTES`(30,720B), 스니펫 `SNIPPET_CHARS`(300)자.
- 전체 콘텐츠 상한: `CONTENT_BYTE_BUDGET`(64MB, `[verified]`). 초과하면 가장 오래된 frame부터 조기 만료시킨다 `[design]`.

## 6. 보존·GC·저장량 (FR-9)

- **보존 대상** `[verified]`: `RETENTION_BOUND_TABLES = [events, blobs, frames]`. summaries는 보존 기간에 묶이지 않는다.
- **GC**: 시작할 때와 `GC_INTERVAL_MS`(6h)마다 아래 순서로 돈다.
  1. **보존 삭제**: `occurred_at < now - retentionDays*MS_PER_DAY`인 events를 지운다. 참조가 없어진 blobs, 멤버가 0이 된 frames도 지운다.
  2. **frame 압축**: 멤버의 절반 이상이 삭제된 frame을 재압축한다.
  3. **공간 회수**: `PRAGMA incremental_vacuum`을 돌리고, freelist가 `VACUUM_SLACK_MIN_BYTES`(16MB) 이상이면 `VACUUM`한다. 이어 `wal_checkpoint(TRUNCATE)`.
- **Footprint**: DB 페이지 수 × 페이지 크기 + day page 파일 크기 + index.db. 결과는 `FOOTPRINT_TTL_MS`(5분) 동안 캐시한다.
- **통계** `[verified]`: `events, blobs, storeBytes, rawBytes, frames, sessions, lastEventAt, suppressions` + 오늘 카운터. UI에는 "Storage used"와 "Average usage: … / day"를 표시한다.

## 7. 삭제 (Clear history)와 write fence

- target → 구간:
  - `last10m`: [now-10m, now]
  - `lastHour`: [now-1h, now]
  - `today`: [로컬 자정, now]
  - `all`: 전체 + 키 교체
- 한 트랜잭션에서 순서대로 처리한다:
  1. `deletion_epoch += 1`
  2. 구간 events와 그에 딸린 terms를 삭제하고, 고아가 된 blobs·frames 정리
  3. `window_from`과 `window_to`가 구간과 겹치는 summaries(10min·6h 모두)를 삭제
  4. 영향받은 day를 `dirty`로 표시
- 커밋이 끝나면 dirty day를 다시 렌더한다. 요약이 하나도 남지 않은 day의 페이지는 삭제한다(원본 동작).
- **write fence** `[verified 개념]`: 모든 렌더·요약 커밋·인덱스 쓰기는 작업을 시작할 때 `(account_generation, deletion_epoch)`를 기록한다. 커밋 직전에 이 값이 바뀌었으면 결과를 **버린다**. 그래서 삭제가 항상 이긴다.
- `history_search`는 질의 시작과 끝의 epoch를 비교한다. 다르면 결과를 무효화하고 한 번 재시도한다 `[verified]`.
- 비활성화 확인 문구 `[verified]`: "Existing history stays on this device until it expires or you delete it." 즉 비활성화는 삭제하지 않는다.
