import { run } from "./exec.ts"

/**
 * Outlook mail via the CLI for Microsoft 365 (`m365`). Requires a completed
 * `m365 login` (device code) with Mail.Read / Mail.Send delegated permissions.
 */

export interface EmailMessage {
  id: string
  from: string
  fromAddress: string
  subject: string
  receivedAt: string
  isRead: boolean
  hasAttachments: boolean
  webLink: string
  bodyPreview: string
}

/** How far back the inbox table looks. */
const INBOX_DAYS = 7
const INBOX_LIMIT = 50

interface GraphMessage {
  id?: string
  subject?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  receivedDateTime?: string
  isRead?: boolean
  hasAttachments?: boolean
  webLink?: string
  bodyPreview?: string
}

export async function m365LoggedIn(): Promise<boolean> {
  const res = await run("m365", ["status", "--output", "json"])
  return res.ok && !res.stdout.includes("Logged out")
}

/** null = mail unavailable (not logged in, CLI missing, or command failed). */
export async function getInbox(): Promise<EmailMessage[] | null> {
  const startTime = new Date(Date.now() - INBOX_DAYS * 86_400_000).toISOString()
  const res = await run(
    "m365",
    ["outlook", "message", "list", "--folderName", "Inbox", "--startTime", startTime, "--output", "json"],
    { timeoutMs: 60_000 },
  )
  if (!res.ok) return null
  try {
    const messages = JSON.parse(res.stdout) as GraphMessage[]
    return messages
      .map(
        (m): EmailMessage => ({
          id: m.id ?? "",
          from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "unknown",
          fromAddress: m.from?.emailAddress?.address ?? "",
          subject: m.subject || "(no subject)",
          receivedAt: m.receivedDateTime ?? "",
          isRead: m.isRead ?? true,
          hasAttachments: m.hasAttachments ?? false,
          webLink: m.webLink ?? "",
          bodyPreview: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim(),
        }),
      )
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, INBOX_LIMIT)
  } catch {
    return null
  }
}

/** Full plain-text body of one message (for the email agent). */
export async function getMessageBody(id: string): Promise<string | null> {
  const res = await run("m365", ["outlook", "message", "get", "--id", id, "--output", "json"], {
    timeoutMs: 60_000,
  })
  if (!res.ok) return null
  try {
    const message = JSON.parse(res.stdout) as { subject?: string; body?: { content?: string; contentType?: string } }
    const content = message.body?.content ?? ""
    const text =
      message.body?.contentType?.toLowerCase() === "html"
        ? content
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+\n/g, "\n")
            .replace(/[ \t]+/g, " ")
            .trim()
        : content.trim()
    return `subject: ${message.subject ?? ""}\n\n${text}`
  } catch {
    return null
  }
}

export async function sendMail(to: string, subject: string, body: string): Promise<{ ok: boolean; message: string }> {
  const res = await run(
    "m365",
    ["outlook", "mail", "send", "--to", to, "--subject", subject, "--bodyContents", body],
    { timeoutMs: 60_000 },
  )
  return res.ok
    ? { ok: true, message: `sent to ${to}` }
    : { ok: false, message: `send failed: ${res.stderr.trim().slice(0, 300)}` }
}
