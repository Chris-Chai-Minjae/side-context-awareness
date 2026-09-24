import {
  DRAFT_IDLE_MS,
  TYPED_FIELD_VALUE_MAX_CHARS,
  TYPED_MIN_SENTENCE_CHARS,
  TYPED_RUN_BYTES,
} from "../constants"
import { type CaptureField, shouldBlockField } from "../redact/fields"

export type TypedFieldSignal = CaptureField & {
  secureInput?: boolean
  deniedApp?: boolean
  captureTypedText?: boolean
}

const utf8 = new TextEncoder()

export class TypedSentenceTracker {
  private key: string | null = null
  private previous = ""
  private pending = ""
  private lastInputAt: number | null = null

  observe(
    key: string | null,
    value: string | null,
    nowMs = Date.now(),
    signal: TypedFieldSignal = {},
  ): readonly string[] {
    if (
      !key ||
      value === null ||
      value.length > TYPED_FIELD_VALUE_MAX_CHARS ||
      this.isBlocked(signal)
    ) {
      this.reset()
      return []
    }

    if (key !== this.key || !value.startsWith(this.previous)) {
      this.key = key
      this.previous = value
      this.pending = ""
      this.lastInputAt = null
      return []
    }

    const addition = value.slice(this.previous.length)
    this.previous = value
    if (addition.length === 0) return []

    this.lastInputAt = nowMs
    this.pending += addition
    if (utf8.encode(this.pending).byteLength > TYPED_RUN_BYTES) {
      this.pending = ""
      return []
    }

    const sentences: string[] = []
    const end = /[.!?。！？\n]/gu
    let start = 0
    for (const match of this.pending.matchAll(end)) {
      const endIndex = (match.index ?? 0) + match[0].length
      const sentence = this.pending.slice(start, endIndex).trim()
      if (sentence.length >= TYPED_MIN_SENTENCE_CHARS) sentences.push(sentence)
      start = endIndex
    }
    this.pending = this.pending.slice(start)
    return sentences
  }

  submit(signal: TypedFieldSignal = {}): readonly string[] {
    if (this.isBlocked(signal)) {
      this.reset()
      return []
    }
    const output = this.flushPending()
    this.reset()
    return output
  }

  blur(signal: TypedFieldSignal = {}): readonly string[] {
    return this.submit(signal)
  }

  flushIdle(nowMs = Date.now(), signal: TypedFieldSignal = {}): readonly string[] {
    if (this.isBlocked(signal)) {
      this.reset()
      return []
    }
    if (this.lastInputAt === null || nowMs - this.lastInputAt < DRAFT_IDLE_MS) return []
    return this.flushPending()
  }

  private isBlocked(signal: TypedFieldSignal): boolean {
    return (
      signal.secureInput === true ||
      signal.deniedApp === true ||
      signal.captureTypedText === false ||
      shouldBlockField(signal)
    )
  }

  reset(): void {
    this.key = null
    this.previous = ""
    this.pending = ""
    this.lastInputAt = null
  }

  private flushPending(): readonly string[] {
    const sentence = this.pending.trim()
    this.pending = ""
    this.lastInputAt = null
    return sentence.length >= TYPED_MIN_SENTENCE_CHARS ? [sentence] : []
  }
}
