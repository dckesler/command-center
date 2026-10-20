import { config } from "../config.ts"
import { hiddenBy } from "./emailFilters.ts"
import { run } from "./exec.ts"

/**
 * Outlook mail via the CLI for Microsoft 365 (`m365`), read-only. Requires a
 * completed `m365 login` (device code) with the Mail.Read delegated permission.
 * There is deliberately no send path — the app registration has no Mail.Send.
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
  /** first line or two of the body, banner-free */
  bodyPreview: string
  /** name of the filter rule that hides this mail; null when it shows */
  hiddenBy: string | null
}

/** Outer-mail banners Exchange prepends; stripped from preview and filter text. */
const BANNER_RE = /^[\\\s]*\[EXTERNAL E-MAIL\][\s\S]*?know the content is safe\.\s*/i

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<(br|p|div|tr|li|h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
}

interface GraphMessage {
  id?: string
  subject?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  receivedDateTime?: string
  isRead?: boolean
  hasAttachments?: boolean
  webLink?: string
  bodyPreview?: string
  body?: { content?: string; contentType?: string }
}

export async function m365LoggedIn(): Promise<boolean> {
  const res = await run("m365", ["status", "--output", "json"])
  return res.ok && !res.stdout.includes("Logged out")
}

let cachedUpn: string | null | undefined

/**
 * UPN of the signed-in user (`connectedAs` from `m365 status`). The event
 * commands in current CLI versions insist on --userName even for delegated
 * auth; mail commands do not. Cached for the process lifetime; null when
 * logged out.
 */
export async function m365UserName(): Promise<string | null> {
  if (cachedUpn !== undefined) return cachedUpn
  const res = await run("m365", ["status", "--output", "json"])
  try {
    const upn = res.ok ? (JSON.parse(res.stdout) as { connectedAs?: string }).connectedAs : undefined
    cachedUpn = typeof upn === "string" && upn.includes("@") ? upn : null
  } catch {
    cachedUpn = null
  }
  return cachedUpn
}

const INBOX_SELECT = "id,subject,from,receivedDateTime,isRead,hasAttachments,webLink,bodyPreview,body"

/**
 * null = mail unavailable (not logged in, CLI missing, or command failed).
 * Reads Graph directly so bodies come along: the filters need them (Jira's
 * bodyPreview is only the external-mail banner) and they make a real preview.
 */
export async function getInbox(): Promise<EmailMessage[] | null> {
  const { days, filters } = config().email
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const url =
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages" +
    `?$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}` +
    `&$top=300&$orderby=receivedDateTime desc&$select=${INBOX_SELECT}`
  const res = await run("m365", ["request", "--url", url, "--output", "json"], { timeoutMs: 90_000 })
  if (!res.ok) return null
  try {
    const parsed = JSON.parse(res.stdout) as { value?: GraphMessage[] } | GraphMessage[]
    const messages = Array.isArray(parsed) ? parsed : (parsed.value ?? [])
    return messages
      .map((m): EmailMessage => {
        const raw = m.body?.content ?? ""
        const text = (m.body?.contentType?.toLowerCase() === "html" ? htmlToText(raw) : raw).replace(BANNER_RE, "").trim()
        const fromAddress = m.from?.emailAddress?.address ?? ""
        const subject = m.subject || "(no subject)"
        return {
          id: m.id ?? "",
          from: m.from?.emailAddress?.name || fromAddress || "unknown",
          fromAddress,
          subject,
          receivedAt: m.receivedDateTime ?? "",
          isRead: m.isRead ?? true,
          hasAttachments: m.hasAttachments ?? false,
          webLink: m.webLink ?? "",
          bodyPreview: (text || m.bodyPreview || "").replace(/\s+/g, " ").slice(0, 400),
          hiddenBy: hiddenBy({ fromAddress, subject, body: text.slice(0, 4000) }, filters),
        }
      })
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
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
    const text = (message.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content.trim()).replace(BANNER_RE, "").trim()
    return `subject: ${message.subject ?? ""}\n\n${text}`
  } catch {
    return null
  }
}
