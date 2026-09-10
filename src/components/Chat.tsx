import { useEffect, useRef, useState } from "react"
import { getStore, subscribeAgents, type ChatItem } from "../agents/stores.ts"
import { sendUser } from "../agents/hub.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  value: "#e5e7eb",
  user: "#93c5fd",
  error: "#f87171",
  yellow: "#facc15",
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

function colorFor(role: ChatItem["role"]): string {
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
  // The input is uncontrolled; bumping the key remounts it empty after a send.
  const draft = useRef("")
  const [inputGen, setInputGen] = useState(0)

  const textWidth = Math.max(20, width - 2)
  const all: { text: string; color: string }[] = []
  for (const item of store.items) {
    const prefix = item.role === "user" ? "❯ " : ""
    for (const line of wrap(prefix + item.text, textWidth)) {
      all.push({ text: line, color: colorFor(item.role) })
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
        title={store.busy ? `${title} (working)` : title}
        border
        borderColor={focused ? C.header : C.dim}
        height={3}
      >
        <input
          key={inputGen}
          value=""
          placeholder={focused ? "Message… (enter to send, esc to unfocus)" : "press i to focus"}
          focused={focused}
          onInput={(value: string) => {
            draft.current = value
          }}
          onSubmit={() => {
            const text = draft.current.trim()
            if (!text) return
            draft.current = ""
            setInputGen((g) => g + 1)
            sendUser(agentId, text)
          }}
        />
      </box>
    </box>
  )
}
