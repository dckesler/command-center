import { useRef } from "react"

const C = {
  header: "#93c5fd",
  dim: "#6b7280",
}

/** Second step of the QA / code-review flow: repo is chosen, ask for the ticket (reviews also take an MR URL or !iid). */
export function QaTicketPrompt({
  repo,
  mode = "qa",
  onSubmit,
}: {
  repo: string
  mode?: "qa" | "review"
  onSubmit: (ticket: string) => void
}) {
  const label = mode === "qa" ? "QA" : "code review"
  const flag = mode === "qa" ? "--qa" : "--review"
  // Submit events carry no value, so track the draft via onInput.
  const draft = useRef("")

  return (
    <box flexDirection="column">
      <box title={`New ${label} in ${repo} — ${mode === "review" ? "ticket, branch or MR URL" : "ticket"}`} border borderColor={C.header} height={3}>
        <input
          placeholder={
            mode === "review"
              ? "e.g. LW-17124, a branch, https://gitlab…/-/merge_requests/123 or !123   (enter to open, esc to cancel)"
              : `e.g. LW-17124   (enter to open ${label} window, esc to cancel)`
          }
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
      <text fg={C.dim}>
        {mode === "review"
          ? `runs: mkpanes ${repo} -w <ticket|branch> --review — an MR link is looked up with glab and reviewed on its source branch, ticket or not`
          : `runs: mkpanes ${repo} -w <ticket> ${flag}`}
      </text>
    </box>
  )
}
