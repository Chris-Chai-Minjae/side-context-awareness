import {
  ATTENTION_INPUT_FRESH_S,
  ATTENTION_STALE_MS,
  AUDIBLE_CONFIRM_TTL_MS,
  POINTER_CONFIRM_TTL_MS,
} from "../constants"
import type { CaptureTarget } from "./target"

export function isIdle(secondsSinceInput: number): boolean {
  return secondsSinceInput > ATTENTION_INPUT_FRESH_S
}

export function recordInput(target: CaptureTarget, now: number): void {
  target.lastInputAt = now
}

export function confirmPointer(target: CaptureTarget, now: number): void {
  target.pointerConfirmedUntil = now + POINTER_CONFIRM_TTL_MS
}

// An audible signal must come from an explicit producer; the scheduler does not infer playback.
export function confirmAudible(target: CaptureTarget, now: number): void {
  target.audibleConfirmedUntil = now + AUDIBLE_CONFIRM_TTL_MS
}

export function attentionScore(target: CaptureTarget, now: number): number {
  const lastActivityAt = target.lastInputAt ?? target.lastSeenAt
  const age = now - lastActivityAt
  return ATTENTION_STALE_MS / Math.max(ATTENTION_STALE_MS, age)
}

function explicitlyConfirmed(target: CaptureTarget, now: number): boolean {
  return (
    (target.pointerConfirmedUntil !== null && now < target.pointerConfirmedUntil) ||
    (target.audibleConfirmedUntil !== null && now < target.audibleConfirmedUntil)
  )
}

export function compareAttention(
  left: CaptureTarget,
  right: CaptureTarget,
  now: number,
  foregroundTargetKey: string | null,
): number {
  const leftExplicit = explicitlyConfirmed(left, now)
  const rightExplicit = explicitlyConfirmed(right, now)
  if (leftExplicit !== rightExplicit) return leftExplicit ? -1 : 1

  const leftScore = attentionScore(left, now)
  const rightScore = attentionScore(right, now)
  const leftFreshForeground = left.key === foregroundTargetKey && leftScore === 1
  const rightFreshForeground = right.key === foregroundTargetKey && rightScore === 1
  if (leftFreshForeground !== rightFreshForeground) return leftFreshForeground ? -1 : 1
  if (leftScore !== rightScore) return rightScore - leftScore
  if (left.lastInputAt !== right.lastInputAt) {
    return (
      (right.lastInputAt ?? Number.NEGATIVE_INFINITY) -
      (left.lastInputAt ?? Number.NEGATIVE_INFINITY)
    )
  }
  if (left.lastSeenAt !== right.lastSeenAt) return right.lastSeenAt - left.lastSeenAt
  return left.key.localeCompare(right.key)
}
