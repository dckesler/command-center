import type { EmailMessage } from "../data/outlook.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  value: "#e5e7eb",
  selectedBg: "#1f2937",
}

function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "yesterday" : `${days} days ago`
}

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

/** Preview lines under the list for the selected message. */
const PREVIEW_LINES = 4

export function Email({
  emails,
  loading,
  selected,
  width,
  height,
}: {
  /** null = Outlook unavailable (m365 not logged in) */
  emails: EmailMessage[] | null
  loading: boolean
  selected: number
  width: number
  height: number
}) {
  if (emails === null) {
    return (
      <box flexDirection="column">
        <text fg={C.dim}>{loading ? "checking Outlook…" : "Outlook unavailable — complete `m365 login` first"}</text>
        {!loading && (
          <text fg={C.dim}>once IT approves the app permissions, run: m365 login --authType deviceCode</text>
        )}
      </box>
    )
  }
  if (emails.length === 0) {
    return <text fg={C.dim}>{loading ? "loading inbox…" : "inbox empty (last 7 days)"}</text>
  }

  const selectedMail = emails[selected]
  const fromWidth = 26
  const timeWidth = 14
  const subjectWidth = Math.max(20, width - fromWidth - timeWidth - 8)

  const previewText = selectedMail?.bodyPreview ?? ""
  const previewWidth = Math.max(20, width - 4)
  const previewLines: string[] = []
  for (let i = 0; i < previewText.length && previewLines.length < PREVIEW_LINES; i += previewWidth) {
    previewLines.push(previewText.slice(i, i + previewWidth))
  }

  const maxVisible = Math.max(1, height - 1 - (previewLines.length ? previewLines.length + 1 : 0))
  let start = 0
  if (emails.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), emails.length - maxVisible)
  }
  const visible = emails.slice(start, start + maxVisible)

  return (
    <box flexDirection="column">
      <text fg={C.header}>
        {"   "}
        {pad("FROM", fromWidth)} {pad("SUBJECT", subjectWidth)} {pad("RECEIVED", timeWidth)}
      </text>
      {visible.map((mail, i) => {
        const idx = start + i
        const isSelected = idx === selected
        return (
          <box key={mail.id} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : mail.isRead ? C.dim : C.value}>
                {isSelected ? "▸" : " "}
                {mail.isRead ? "  " : "● "}
                {pad(mail.from, fromWidth)} {pad(mail.subject, subjectWidth)}
              </span>
              <span fg={C.dim}>
                {" "}
                {pad(relativeTime(mail.receivedAt), timeWidth)}
                {mail.hasAttachments ? "📎" : ""}
              </span>
            </text>
          </box>
        )
      })}
      {previewLines.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          {previewLines.map((line, i) => (
            <text key={i} fg={C.dim}>
              {"  "}
              {line}
            </text>
          ))}
        </box>
      )}
    </box>
  )
}
