import { useRef } from "react"

const C = {
  header: "#93c5fd",
  dim: "#6b7280",
}

/** Free-text prompt for starting or following up a cloud agent. */
export function CloudPrompt({
  title,
  placeholder,
  hint,
  onSubmit,
}: {
  title: string
  placeholder: string
  hint: string
  onSubmit: (text: string) => void
}) {
  const draft = useRef("")

  return (
    <box flexDirection="column">
      <box title={title} border borderColor={C.header} height={3}>
        <input
          placeholder={placeholder}
          focused
          onInput={(value: string) => {
            draft.current = value
          }}
          onSubmit={() => {
            const text = draft.current.trim()
            if (text) onSubmit(text)
            draft.current = ""
          }}
        />
      </box>
      <text fg={C.dim}>{hint}</text>
    </box>
  )
}
