import type { ComponentChildren, VNode } from "preact"
import { t, type UiLanguage } from "../i18n"

interface DayPageMarkdownProps {
  readonly language: UiLanguage
  readonly date: string
  readonly markdown: string
  readonly onSource: (ref: string, summaryRef: string | null) => void
}

const INLINE_PATTERN =
  /\[([^\]]+)\]\(([^)]+)\)|[es]:[0-9A-HJKMNP-TV-Z]{26}|\*\*([^*]+)\*\*|`([^`]+)`|_([^_]+)_|\*([^*]+)\*/gu

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

function summaryRef(line: string): string | null {
  return line.match(/s:[0-9A-HJKMNP-TV-Z]{26}/u)?.[0] ?? null
}

function inline(
  value: string,
  date: string,
  sectionRef: string | null,
  onSource: DayPageMarkdownProps["onSource"],
): ComponentChildren[] {
  const nodes: ComponentChildren[] = []
  let cursor = 0
  for (const match of value.matchAll(INLINE_PATTERN)) {
    const start = match.index
    if (start > cursor) nodes.push(value.slice(cursor, start))
    const token = match[0]
    const label = match[1]
    const destination = match[2]
    if (label !== undefined && destination !== undefined) {
      const external = safeExternalUrl(destination)
      const localSummary = /^#s:([0-9A-HJKMNP-TV-Z]{26})$/u.exec(destination)
      if (external) {
        nodes.push(
          <a key={start} href={external} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        )
      } else if (localSummary) {
        nodes.push(
          <a key={start} href={`#/history/${date}#s:${localSummary[1]}`}>
            {label}
          </a>,
        )
      } else if (/^[es]:[0-9A-HJKMNP-TV-Z]{26}$/u.test(destination)) {
        nodes.push(
          <a
            key={start}
            href={`#/history/${date}`}
            data-ref={destination}
            onClick={(event) => {
              event.preventDefault()
              onSource(destination, sectionRef)
            }}
          >
            {label}
          </a>,
        )
      } else {
        nodes.push(label)
      }
    } else if (/^[es]:/u.test(token)) {
      nodes.push(
        <a
          key={start}
          href={`#/history/${date}`}
          data-ref={token}
          onClick={(event) => {
            event.preventDefault()
            onSource(token, sectionRef)
          }}
        >
          {token}
        </a>,
      )
    } else if (match[3] !== undefined) {
      nodes.push(<strong key={start}>{match[3]}</strong>)
    } else if (match[4] !== undefined) {
      nodes.push(<code key={start}>{match[4]}</code>)
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(<em key={start}>{match[5] ?? match[6]}</em>)
    }
    cursor = start + token.length
  }
  if (cursor < value.length) nodes.push(value.slice(cursor))
  return nodes
}

function bodyLines(markdown: string): readonly string[] {
  const lines = markdown.split(/\r?\n/u)
  if (lines[0] !== "---") return lines
  const end = lines.indexOf("---", 1)
  return end < 0 ? lines : lines.slice(end + 1)
}

function localizedLine(line: string, language: UiLanguage): string {
  if (language === "en") return line
  if (line === "## Day overview") return `## ${t(language, "Day overview")}`
  if (line.startsWith("# Context awareness "))
    return `# ${t(language, "Context awareness")}${line.slice("# Context awareness".length)}`
  if (line.startsWith("Sources:"))
    return `${t(language, "Sources:")}${line.slice("Sources:".length)}`
  return line
}

export function DayPageMarkdown({ date, markdown, onSource, language }: DayPageMarkdownProps) {
  const lines = bodyLines(markdown)
  const blocks: VNode[] = []
  let sectionRef: string | null = null
  for (let index = 0; index < lines.length; index++) {
    const sourceLine = lines[index]
    const line = sourceLine === undefined ? undefined : localizedLine(sourceLine, language)
    if (line === undefined || line.trim() === "") continue
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line)
    if (heading) {
      const level = heading[1]?.length
      const label = heading[2] ?? ""
      if (level === 3) sectionRef = summaryRef(label)
      const id = level === 3 ? sectionRef : null
      const content = inline(label, date, sectionRef, onSource)
      if (level === 1) blocks.push(<h1 key={index}>{content}</h1>)
      if (level === 2) blocks.push(<h2 key={index}>{content}</h2>)
      if (level === 3)
        blocks.push(
          <h3 key={index} id={id ?? undefined}>
            {content}
          </h3>,
        )
      continue
    }
    if (line.startsWith("- ")) {
      const items: VNode[] = []
      let next = index
      while (lines[next]?.startsWith("- ")) {
        const item = lines[next]?.slice(2) ?? ""
        items.push(<li key={next}>{inline(item, date, sectionRef, onSource)}</li>)
        next++
      }
      blocks.push(<ul key={index}>{items}</ul>)
      index = next - 1
      continue
    }
    const paragraph = [line]
    while (lines[index + 1]?.trim() && !/^(#{1,3}\s|- )/u.test(lines[index + 1] ?? "")) {
      index++
      paragraph.push(localizedLine(lines[index] ?? "", language))
    }
    blocks.push(
      <p
        key={index}
        class={paragraph[0]?.startsWith(t(language, "Sources:")) ? "day-sources" : undefined}
      >
        {paragraph.map((text, position) => (
          <span key={position}>
            {position > 0 ? <br /> : null}
            {inline(text, date, sectionRef, onSource)}
          </span>
        ))}
      </p>,
    )
  }
  return <article class="day-markdown">{blocks}</article>
}
