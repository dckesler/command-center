import { useRef } from "react"

const C = {
  header: "#93c5fd",
  dim: "#6b7280",
}

/** Second step of the QA flow: repo is chosen, ask for the ticket to QA. */
export function QaTicketPrompt({
  repo,
  onSubmit,
}: {
  repo: string
  onSubmit: (ticket: string) => void
}) {
  // Submit events carry no value, so track the draft via onInput.
  const draft = useRef("")

  return (
    <box flexDirection="column">
      <box title={`New QA in ${repo} — ticket`} border borderColor={C.header} height={3}>
        <input
          placeholder="e.g. LW-17124   (enter to open QA window, esc to cancel)"
          focused
          onInput={(value: string) => {
            draft.current = value
          }}
          onSubmit={() => {
            const ticket = draft.current.trim()
            if (ticket) onSubmit(ticket)
            draft.current = ""
          }}
        />
      </box>
      <text fg={C.dim}>runs: mkpanes {repo} -w &lt;ticket&gt; --qa</text>
    </box>
  )
}
