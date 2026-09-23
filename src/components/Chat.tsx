import { useEffect, useRef, useState } from "react"
import { SyntaxStyle, type InputRenderable } from "@opentui/core"
import { getStore, subscribeAgents, type ChatItem } from "../agents/stores.ts"
import { formatClock } from "../data/inbox.ts"
import { sendUser } from "../agents/hub.ts"
import { scanSlashTokens, type SlashToken } from "../data/skills.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  value: "#e5e7eb",
  user: "#93c5fd",
  error: "#f87171",
  yellow: "#facc15",
  skill: "#4ade80",
}

// ---------------------------------------------------------------------------
// `/skill` colouring inside the input

let slashStyle: SyntaxStyle | null = null
/** Highlight styles for `/name` tokens; created lazily (needs the native lib). */
function getSlashStyle(): SyntaxStyle {
  if (!slashStyle) {
    slashStyle = SyntaxStyle.fromStyles({
      skill: { fg: C.skill },
      partial: { fg: C.yellow },
      none: { fg: C.error },
    })
  }
  return slashStyle
}

/** Colour for a token: green when it resolves, yellow/red only while being typed. */
function tokenStyleName(t: SlashToken): "skill" | "partial" | "none" | null {
  if (t.match === "skill" || t.match === "builtin") return "skill"
  if (!t.active) return null // finished token that matched nothing: probably a path, leave it
  return t.match === "partial" ? "partial" : "none"
}

/** Re-apply `/name` highlights to the input's edit buffer for the given text. */
function applySlashHighlights(input: InputRenderable | null, text: string): SlashToken[] {
  const tokens = scanSlashTokens(text)
  if (!input) return tokens
  try {
    const style = getSlashStyle()
    if (input.syntaxStyle !== style) input.syntaxStyle = style
    const buffer = input.editBuffer
    buffer.clearAllHighlights()
    for (const t of tokens) {
      const name = tokenStyleName(t)
      if (!name) continue
      const styleId = style.getStyleId(name)
      if (styleId == null) continue
      buffer.addHighlightByCharRange({ start: t.start, end: t.end, styleId })
    }
  } catch {
    // colouring is cosmetic; never let it break input
  }
  return tokens
}

/** Title badge while a `/name` is being typed (nothing after it yet). */
function slashBadge(tokens: SlashToken[]): string {
  const active = tokens.find((t) => t.active)
  if (!active) return ""
  if (active.match === "skill" || active.match === "builtin") return ` ✓ /${active.name}`
  if (active.match === "partial") return ` ${active.matches} match${active.matches === 1 ? "" : "es"}`
  return " ✗ no match"
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const raw of text.split("\n")) {
    let line = ""
    for (const word of raw.split(" ")) {
      if (word.length > width) {
        if (line) lines.push(line)
        for (let i = 0; i + width < word.length; i += width) lines.push(word.slice(i, i + width))
        line = word.slice(Math.floor((word.length - 1) / width) * width)
        continue
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

function colorFor(role: ChatItem["role"], accent?: ChatItem["accent"]): string {
  if (accent === "skill") return C.skill
  if (role === "user") return C.user
  if (role === "tool" || role === "info") return C.dim
  if (role === "error") return C.error
  return C.value
}

/** Chat pane bound to one hub agent. Used full-screen (central) and as a drawer. */
export function Chat({
  agentId,
  title,
  emptyHint,
  focused,
  scroll,
  width,
  height,
}: {
  agentId: string
  title: string
  emptyHint: string
  focused: boolean
  /** lines scrolled up from the bottom (0 = pinned to latest) */
  scroll: number
  width: number
  height: number
}) {
  // Re-render whenever any agent store changes.
  const [, setTick] = useState(0)
  useEffect(() => subscribeAgents(() => setTick((t) => t + 1)), [])
  const store = getStore(agentId)

  const [spin, setSpin] = useState(0)
  useEffect(() => {
    if (!store.busy) return
    const interval = setInterval(() => setSpin((s) => s + 1), 120)
    return () => clearInterval(interval)
  }, [store.busy])

  // The input's submit event doesn't carry the value, so track it via onInput.
  // Draft text lives on the per-agent store so switching tabs restores that
  // tab's prompt instead of carrying the previous one over. The input is
  // uncontrolled; the key remounts it when the tab changes or after a send.
  const draft = useRef(store.draft)
  const [inputGen, setInputGen] = useState(0)
  // Live `/skill` recognition: tokens are coloured in the edit buffer directly;
  // the title badge is React state and only changes when its text changes.
  const inputRef = useRef<InputRenderable | null>(null)
  const [badge, setBadge] = useState("")
  const refreshSlash = (value: string) => {
    const next = slashBadge(applySlashHighlights(inputRef.current, value))
    setBadge((prev) => (prev === next ? prev : next))
  }
  useEffect(() => {
    draft.current = getStore(agentId).draft
    refreshSlash(draft.current)
  }, [agentId, inputGen])

  const textWidth = Math.max(20, width - 2)
  const all: { text: string; color: string }[] = []
  for (const item of store.items) {
    const stamp = item.ts ? `${formatClock(item.ts)} ` : ""
    const prefix = item.role === "user" ? "❯ " : ""
    const innerWidth = Math.max(10, textWidth - stamp.length)
    const wrapped = wrap(prefix + item.text, innerWidth)
    for (let i = 0; i < wrapped.length; i++) {
      const pad = i === 0 ? stamp : " ".repeat(stamp.length)
      all.push({ text: pad + wrapped[i], color: colorFor(item.role, item.accent) })
    }
    all.push({ text: "", color: C.dim })
  }
  if (store.busy) {
    all.push({ text: `${SPINNER_FRAMES[spin % SPINNER_FRAMES.length]} working…`, color: C.yellow })
  }

  const bodyHeight = Math.max(1, height - 3)
  const maxScroll = Math.max(0, all.length - bodyHeight)
  const offset = Math.min(scroll, maxScroll)
  const start = Math.max(0, all.length - bodyHeight - offset)
  const visible = all.slice(start, start + bodyHeight)

  return (
    <box flexDirection="column">
      <box flexDirection="column" height={bodyHeight}>
        {visible.length === 0 ? (
          <text fg={C.dim}>{emptyHint}</text>
        ) : (
          visible.map((line, i) => (
            <text key={i} fg={line.color}>
              {line.text || " "}
            </text>
          ))
        )}
      </box>
      <box
        title={`${store.busy ? `${title} (working)` : title}${badge}`}
        border
        borderColor={focused ? C.header : C.dim}
        height={3}
      >
        <input
          key={`${agentId}-${inputGen}`}
          ref={inputRef}
          value={store.draft}
          placeholder={focused ? "Message… (/skill args, /skills to list, esc to unfocus)" : "press i to focus"}
          focused={focused}
          onInput={(value: string) => {
            draft.current = value
            getStore(agentId).draft = value
            refreshSlash(value)
          }}
          onSubmit={() => {
            const text = draft.current.trim()
            if (!text) return
            draft.current = ""
            getStore(agentId).draft = ""
            setInputGen((g) => g + 1)
            sendUser(agentId, text)
          }}
        />
      </box>
    </box>
  )
}
