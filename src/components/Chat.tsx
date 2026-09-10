import { useEffect, useRef, useState } from "react"
import { chatState, sendChat, subscribeChat, type ChatItem } from "../data/chat.ts"

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
        for (let i = 0; i < word.length; i += width) line = word.slice(i, i + width)
        for (let i = 0; i + width < word.length; i += width) lines.push(word.slice(i, i + width))
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

export function Chat({
  focused,
  scroll,
  width,
  height,
}: {
  focused: boolean
  /** lines scrolled up from the bottom (0 = pinned to latest) */
  scroll: number
  width: number
  height: number
}) {
  // Re-render whenever the module-level chat store changes.
  const [, setTick] = useState(0)
  useEffect(() => subscribeChat(() => setTick((t) => t + 1)), [])

  const [spin, setSpin] = useState(0)
  useEffect(() => {
    if (!chatState.busy) return
    const interval = setInterval(() => setSpin((s) => s + 1), 120)
    return () => clearInterval(interval)
  }, [chatState.busy])

  // The input's submit event doesn't carry the value, so track it via onInput.
  // The input is uncontrolled; bumping the key remounts it empty after a send.
  const draft = useRef("")
  const [inputGen, setInputGen] = useState(0)

  const textWidth = Math.max(20, width - 2)
  const all: { text: string; color: string }[] = []
  for (const item of chatState.items) {
    const prefix = item.role === "user" ? "❯ " : ""
    const wrapped = wrap(prefix + item.text, textWidth)
    for (const line of wrapped) all.push({ text: line, color: colorFor(item.role) })
    all.push({ text: "", color: C.dim })
  }
  if (chatState.busy) {
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
          <text fg={C.dim}>
            chat with a local Cursor agent (skills + Atlassian MCP loaded) — type a message and press enter
          </text>
        ) : (
          visible.map((line, i) => (
            <text key={i} fg={line.color}>
              {line.text || " "}
            </text>
          ))
        )}
      </box>
      <box
        title={chatState.busy ? "Chat (agent is working)" : "Chat"}
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
            if (!text || chatState.busy) return
            draft.current = ""
            setInputGen((g) => g + 1)
            sendChat(text)
          }}
        />
      </box>
    </box>
  )
}
