import { expect, test } from "bun:test"
import { join } from "node:path"
import { ocrImage } from "../src/observe"

test("Given a synthetic screenshot under /tmp, when OCR runs, then its text is returned", async () => {
  const filename = join(import.meta.dir, "fixtures", "ocr.png")
  expect(await ocrImage(filename)).toContain("LOCAL CONTEXT")
})
