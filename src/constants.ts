// Capture timing and target limits in the Side capture contract.
export const MIN_CAPTURE_INTERVAL_MS = 2_000 // [verified]
export const UNCHANGED_URL_INTERVAL_MS = 60_000 // [verified]
export const ACTIVATION_INTERVAL_MS = 15_000 // [verified]
export const MAX_CONCURRENT_CAPTURES = 2 // [verified]
export const TRACKED_TARGET_LIMIT = 512 // [verified]
export const SWEEP_INTERVAL_MS = 120_000 // [verified]
export const TAB_STALE_AFTER_MS = 600_000 // [verified]
export const MAX_SWEEP_TARGETS = 8 // [verified]
export const AUDIBLE_CONFIRM_TTL_MS = 1_800_000 // [verified]
export const ATTENTION_STALE_MS = 45_000 // [verified]
export const ATTENTION_INPUT_FRESH_S = 180 // [verified]
export const TYPED_FIELD_CACHE_MS = 300_000 // [verified]
export const POINTER_CONFIRM_TTL_MS = 20_000 // [verified]
export const TRIGGER_STRENGTH = {
  interaction: 4,
  activation: 3,
  navigation: 2,
  sweep: 1,
  discovery: 0,
} as const // [verified]
export const STAY_MAX_MS = 3_600_000 // [verified]
export const GLANCE_MS = 5_000 // [verified]
export const DWELL_GAP_MS = 600_000 // [verified]
export const DRAFT_IDLE_MS = 300_000 // [verified]
export const SELECTION_BURST_MS = 2_000 // [verified]

// Frames and raw evidence.
export const FRAME_IDLE_SEAL_MS = 1_200_000 // [verified]
export const FRAME_COLD_AGE_MS = 600_000 // [verified]
export const FRAME_MAX_MEMBERS = 32 // [verified]
export const FRAME_MAX_RAW_BYTES = 4_194_304 // [verified]
export const FRAME_ZSTD_LEVEL = 12 // [verified]
export const SEAL_BATCH_BLOBS = 1_024 // [verified]
export const FRAME_CACHE_MAX_BYTES = 16_777_216 // [verified]
export const EMPTY_TREE_BYTES = 2_048 // [verified]
export const CONTENT_BYTE_BUDGET = 67_108_864 // [verified]
export const READ_CALL_BYTES = 30_720 // [verified]
export const SNIPPET_CHARS = 300 // [verified]
export const INLINE_TEXT_BYTES = 2_048 // [verified]

// Summary jobs and briefing budgets.
export const COMPREHENSION_INTERVAL_MS = 60_000 // [verified]
export const TEN_MINUTES_MS = 600_000 // [verified]
export const HOUR_MS = 3_600_000 // [design] Clear-history lastHour window.
export const MAX_JOBS_PER_PASS = 6 // [verified]
export const MAX_ATTEMPTS = 3 // [verified]
export const RETRY_DELAYS_MS = [60_000, 300_000] as const // [verified]
export const RUNNING_LEASE_MS = 600_000 // [verified]
export const LATE_COMMIT_RESCAN_MS = 1_800_000 // [verified]
export const BRIEFING_CONTENT_BUDGET_BYTES = 49_152 // [verified]
export const REVISIT_BYTES = 4_096 // [verified]
export const TYPED_RUN_BYTES = 4_096 // [verified]
export const TYPED_FIELD_VALUE_MAX_CHARS = 20_000 // [design] Retained prototype field-value bound.
export const TYPED_MIN_SENTENCE_CHARS = 3 // [design] Retained prototype emission threshold.
export const SELECTION_BYTES = 600 // [verified]
export const CHILD_BODY_BYTES = 3_072 // [verified]
export const SNAPSHOTS_PER_SEGMENT = 2 // [verified]
export const BRIEFING_JACCARD_DUPLICATE_THRESHOLD = 0.9 // [design] 05-comprehension.md §3.
export const BRIEFING_SNAPSHOT_HEAD_FRACTION = 0.6 // [design] 05-comprehension.md §3.
export const PAGE_INDEX_LINES_PER_SEGMENT = 10 // [verified]
export const SUMMARIZATION_PROMPT_OVERHEAD_TOKENS = 4_096 // [verified]
export const UNTRUSTED_EVIDENCE_NONCE_BYTES = 16 // [design] 05-comprehension.md §3.6.
export const SUMMARY_PROVIDER_TIMEOUT_MS = 60_000 // [design] 05-comprehension.md §6.
export const SUMMARY_CALL_SLOT_WAIT_MS = 10_000 // Synthetic providers.test only: 10s queued + 60s provider request + 10s native RPC margin.
export const SUMMARY_CLAUDE_MAX_OUTPUT_BYTES = 1_048_576 // [design] 02-architecture.md §4, Claude CLI stdout+stderr cap.
export const SUMMARY_CLAUDE_CONSENT_POLL_MS = 100 // [design] 02-architecture.md §4, in-flight revocation check.
export const SUMMARY_CODEX_MAX_OUTPUT_BYTES = SUMMARY_CLAUDE_MAX_OUTPUT_BYTES // Same bounded CLI output budget.
export const SUMMARY_CODEX_CONSENT_POLL_MS = SUMMARY_CLAUDE_CONSENT_POLL_MS // Same in-flight revocation cadence.
export const SUMMARY_MAX_TOKENS = 4_096 // [design] 05-comprehension.md §6.
export const SUMMARY_TEMPERATURE = 0.2 // [design] 05-comprehension.md §6.
export const MAX_CONCURRENT_SUMMARY_CALLS = 2 // [design] 05-comprehension.md §2.

// Retention and storage accounting.
export const GC_INTERVAL_MS = 21_600_000 // [verified]
export const FOOTPRINT_TTL_MS = 300_000 // [verified]
export const VACUUM_SLACK_MIN_BYTES = 16_777_216 // [verified]
export const SUPPRESSION_BUCKET_MS = 3_600_000 // [verified]
export const RETENTION_DAYS_DEFAULT = 14 // [verified]
export const RETENTION_DAYS_MIN = 1 // [verified]
export const RETENTION_DAYS_MAX = 30 // [verified]

// Indexing. MOSS values are reference constants only; Side uses sqlite-vec (ADR-005).
export const CA_INDEX_VERSION = 2 // [verified]
export const EMBEDDING_DIMENSIONS = 384 // [measured, ADR-005]
export const EMBEDDING_IDLE_MS = 300_000 // [design, ADR-005]
export const CA_PAGE_RENDER_VERSION = "3" // [verified]
export const CHUNK_SIZE_TOKENS = 256 // [verified]
export const CHUNK_SIZE_CHARS = 1_024 // [verified]
export const CA_MAX_EMBED_CHARS = CHUNK_SIZE_CHARS * 1.4 // [verified]
export const SYNC_DEBOUNCE_MS = 750 // [verified]
export const MOSS_ADD_DOCS_BATCH_SIZE = 4 // [verified]
export const APPLICATION_ICON_CACHE_LIMIT = 64 // [design] Bounded app-picker icon LRU.
export const MOSS_CACHE_DIR = ".moss-cache" // [verified]
export const MOSS_CACHE_SCHEMA_VERSION = "moss-minilm-provenance-v1" // [verified]
export const MS_PER_DAY = 86_400_000 // [verified]
export const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000 // [design] Chromium visits use microseconds since 1601-01-01.
export const CA_WINDOW_HALFLIFE_DAYS = 7 // [verified]
export const CA_THREAD_HALFLIFE_DAYS = 21 // [verified]
export const CA_HYBRID_ALPHA = 0.8 // [verified default] 07-recall-index.md §3.
export const CA_MEMORY_SEARCH_MAX_LIMIT = 20 // [verified] 07-recall-index.md §6.
export const CA_SIBLING_ADJACENCY_MINUTES = 10 // [design] 07-recall-index.md §3.
export const TERM_SOURCE_CHARS = 8_000 // [design] Retained prototype indexTerms bound.
export const TERM_MAX_TOKENS = 1_000 // [design] Retained prototype indexTerms bound.
export const TERM_MAX_UNIQUE = 1_500 // [design] Retained prototype indexTerms bound.
export const TERM_MIN_TOKEN_CHARS = 2 // [design] Retained prototype indexTerms threshold.

// Lexical recall (07-recall-index.md §4).
export const RECALL_MAX_QUERIES = 8 // [verified]
export const RECALL_MAX_TERMS = 32 // [verified]
export const RECALL_CANDIDATE_LIMIT = 2_000 // [verified]
export const RECALL_SUMMARY_LIMIT = 500 // [verified]
export const RECALL_DEFAULT_LIMIT = 20 // [verified]
export const RECALL_MAX_LIMIT = 100 // [verified]
export const RECALL_RECENCY_WINDOW_MS = 21_600_000 // [verified]
export const RECALL_TOTAL_MATCH_WEIGHT = 0.25 // [verified]
export const RECALL_RECENCY_BONUS = 4 // [verified]
export const RECALL_EPOCH_RETRY_LIMIT = 1 // [verified]
export const READ_DEFAULT_CONTEXT_LINES = 10 // [verified] 07-recall-index.md §5.
export const READ_MAX_CONTEXT_LINES = 100 // [verified] 07-recall-index.md §5.
export const UNTRUSTED_BOUNDARY_NONCE_BYTES = 16 // [design] 05-comprehension.md §3.
export const RECALL_STOP_WORDS = [
  "a",
  "an",
  "and",
  "are",
  "at",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
  "그",
  "이",
  "저",
  "것",
  "좀",
] as const // [verified examples, design expansion]
export const RECALL_REQUEST_WORDS = [
  "find",
  "show",
  "what",
  "when",
  "where",
  "recall",
  "remember",
  "찾아",
  "찾아줘",
  "보여",
  "보여줘",
  "뭐였",
  "뭐였지",
  "언제",
  "어디",
  "기억",
  "기억나",
  "기억해",
] as const // [verified examples, design variants]

// Reference only: Side has no subscription gate (ADR-002).
export const CONTEXT_AWARENESS_ALLOWED_PLANS = ["max"] as const // [verified]

// Side-specific values fixed by the approved design.
export const CAPTURE_DEBOUNCE_MS = 500 // [design]
export const CA_SIBLING_DEMOTION = 0.85 // [design]
export const PAUSE_INDEFINITE = Number.MAX_SAFE_INTEGER // [design]
export const PAUSE_15_MINUTES_MS = 900_000 // [verified] Capture pause option.
export const PAUSE_30_MINUTES_MS = 1_800_000 // [verified] Capture pause option.
export const HELPER_COMMAND_TIMEOUT_MS = 10_000 // [design] 02-architecture.md §3.
export const HELPER_MAX_LINE_BYTES = 4_194_304 // [design] 02-architecture.md §3.
export const HELPER_CONSECUTIVE_TIMEOUT_LIMIT = 3 // [design] 02-architecture.md §3.
export const ASIDE_REPL_TIMEOUT_MS = 5_000 // [design] 06-tasks.md P1-T1.13.
export const ASIDE_ADAPTER_FAILURE_LIMIT = 3 // [design] 06-tasks.md P1-T1.13.
export const PRIVATE_DIRECTORY_MODE = 0o700 // [design] 02-architecture.md §2.
export const PRIVATE_FILE_MODE = 0o600 // [design] 02-architecture.md §2.
export const PRIVATE_UMASK = 0o077 // [design] 02-architecture.md §2.
export const BROWSER_URL_POLL_MS = 1_000 // [design] 03-capture.md §3 foreground browser URL poll.
export const API_TOKEN_BYTES = 32 // [design] 02-architecture.md §4.
export const API_MAX_REQUEST_BYTES = 1_048_576 // [design] 06-tasks.md P4-T4.1.
