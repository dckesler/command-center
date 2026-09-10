import { useRef } from "react"

const C = {
  header: "#93c5fd",
  dim: "#6b7280",
}

export function MkpanesPrompt({ onSubmit }: { onSubmit: (args: string[]) => void }) {
  // Submit events carry no value, so track the draft via onInput.
  const draft = useRef("")

  return (
    <box flexDirection="column">
      <box title="New worktree — mkpanes arguments" border borderColor={C.header} height={3}>
        <input
          placeholder="e.g. lists -w LW-17124   (enter to run, esc to cancel)"
          focused
          onInput={(value: string) => {
            draft.current = value
          }}
          onSubmit={() => {
            const args = draft.current.trim().split(/\s+/).filter(Boolean)
            if (args.length > 0) onSubmit(args)
            draft.current = ""
          }}
        />
      </box>
      <text fg={C.dim}>
        mkpanes &lt;repo-or-path&gt; [-w &lt;branch&gt;] [--no-ticket] [--no-format] [--qa] [--cursor] [--from &lt;base&gt;]
      </text>
      <text fg={C.dim}>-s &lt;session&gt; is added automatically unless you pass your own</text>
    </box>
  )
}
