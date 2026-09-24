import { expect, test } from "bun:test"
import { DRAFT_IDLE_MS, TYPED_FIELD_VALUE_MAX_CHARS, TYPED_RUN_BYTES } from "../src/constants"
import { TypedSentenceTracker } from "../src/typed"

test("Given an existing field value, when monitoring starts, then it is not copied as typed text", () => {
  const tracker = new TypedSentenceTracker()
  expect(tracker.observe("window:field", "Old private draft.")).toEqual([])
  expect(tracker.observe("window:field", "Old private draft. New sentence.")).toEqual([
    "New sentence.",
  ])
})

test("Given a focus change or edit in the middle, when observing, then the new field is only a baseline", () => {
  const tracker = new TypedSentenceTracker()
  tracker.observe("window:first", "")
  expect(tracker.observe("window:first", "Partial")).toEqual([])
  expect(tracker.observe("window:second", "Another existing sentence.")).toEqual([])
  expect(tracker.observe("window:second", "Changed existing sentence.")).toEqual([])
})

test("Given a field with no stable identity, when observing, then typed capture stays off", () => {
  const tracker = new TypedSentenceTracker()
  expect(tracker.observe(null, "secret sentence.")).toEqual([])
})

test("Given an unfinished Korean draft, when five minutes of input idle pass, then the draft flushes once", () => {
  const tracker = new TypedSentenceTracker()
  tracker.observe("window:draft", "", 0)
  expect(tracker.observe("window:draft", "안녕하세요 반갑", 1)).toEqual([])
  expect(tracker.flushIdle(DRAFT_IDLE_MS)).toEqual([])
  expect(tracker.flushIdle(DRAFT_IDLE_MS + 1)).toEqual(["안녕하세요 반갑"])
  expect(tracker.flushIdle(DRAFT_IDLE_MS * 2)).toEqual([])
})

test("Given an unfinished draft, when submit or blur arrives, then only appended text flushes", () => {
  const tracker = new TypedSentenceTracker()
  tracker.observe("window:draft", "Existing private draft", 0)
  tracker.observe("window:draft", "Existing private draft new draft", 1)
  expect(tracker.submit()).toEqual(["new draft"])
  expect(tracker.submit()).toEqual([])
  tracker.observe("window:next", "", 2)
  tracker.observe("window:next", "another draft", 3)
  expect(tracker.blur()).toEqual(["another draft"])
})

test("Given a typed run over the UTF-8 byte budget, when submitted, then it is not retained", () => {
  const tracker = new TypedSentenceTracker()
  tracker.observe("window:draft", "", 0)
  const bytesPerCharacter = new TextEncoder().encode("한").byteLength
  expect(
    tracker.observe(
      "window:draft",
      "한".repeat(Math.ceil(TYPED_RUN_BYTES / bytesPerCharacter) + 1),
      1,
    ),
  ).toEqual([])
  expect(tracker.submit()).toEqual([])
})

test("Given an oversized existing field, when it changes, then the tracker keeps no baseline copy", () => {
  const tracker = new TypedSentenceTracker()
  const oldText = "x".repeat(TYPED_FIELD_VALUE_MAX_CHARS + 1)
  expect(tracker.observe("window:draft", oldText, 0)).toEqual([])
  expect(tracker.observe("window:draft", `${oldText} new sentence.`, 1)).toEqual([])
  expect(tracker.submit()).toEqual([])
})

test("Given secure or excluded field signals, when text grows, then it is never emitted", () => {
  for (const signal of [
    { subrole: "AXSecureTextField" },
    { autocomplete: "current-password" },
    { inputType: "tel" },
    { label: "비밀번호" },
    { secureInput: true },
    { deniedApp: true },
    { captureTypedText: false },
  ]) {
    const tracker = new TypedSentenceTracker()
    tracker.observe("window:field", "", 0)
    expect(tracker.observe("window:field", "secret sentence.", 1, signal)).toEqual([])
    expect(tracker.submit()).toEqual([])
  }
})

test("Given secure input starts after a draft, when a flush event arrives, then pending text is discarded", () => {
  const tracker = new TypedSentenceTracker()
  tracker.observe("window:field", "", 0)
  tracker.observe("window:field", "synthetic draft", 1)
  expect(tracker.submit({ secureInput: true })).toEqual([])
  expect(tracker.flushIdle(DRAFT_IDLE_MS + 1)).toEqual([])

  tracker.observe("window:field", "", 2)
  tracker.observe("window:field", "another draft", 3)
  expect(tracker.blur({ deniedApp: true })).toEqual([])

  tracker.observe("window:field", "", 4)
  tracker.observe("window:field", "third draft", 5)
  expect(tracker.flushIdle(DRAFT_IDLE_MS + 6, { captureTypedText: false })).toEqual([])
  expect(tracker.submit()).toEqual([])
})
