import type { MrExtras, Row } from "../types.ts"

const C = {
  label: "#93c5fd",
  dim: "#6b7280",
  value: "#e5e7eb",
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
}

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <text>
      <span fg={C.dim}>{label.padEnd(14)}</span>
      <span fg={color ?? C.value}>{value}</span>
    </text>
  )
}

export function DetailPanel({
  row,
  extras,
  extrasLoading,
}: {
  row: Row
  extras: MrExtras | null
  extrasLoading: boolean
}) {
  const mr = row.mr
  return (
    <box
      border
      borderStyle="rounded"
      borderColor="#4b5563"
      title={` ${row.repo} / ${row.branch} `}
      titleColor="#93c5fd"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <Field label="worktree" value={row.worktreePath} />
      {row.ticket ? (
        <>
          <Field label="ticket" value={`${row.ticket.key} · ${row.ticket.type} · ${row.ticket.status}`} />
          <Field label="summary" value={row.ticket.summary} />
        </>
      ) : (
        <Field label="ticket" value={row.ticketKey ? `${row.ticketKey} (not found in Jira)` : "none"} color={C.dim} />
      )}
      {row.git && (
        <Field
          label="git"
          value={`${row.git.dirtyCount} dirty · ↑${row.git.ahead ?? "?"} ↓${row.git.behind ?? "?"}${row.git.hasUpstream ? "" : " (vs default)"} · ${row.git.lastCommitRelative}`}
        />
      )}
      {mr ? (
        <>
          <Field label="mr" value={`!${mr.iid} ${mr.state}${mr.draft ? " (draft)" : ""} · ${mr.title}`} />
          {mr.state === "opened" && (
            <>
              <Field
                label="mergeable"
                value={mr.detailedMergeStatus ?? "unknown"}
                color={mr.detailedMergeStatus === "mergeable" ? C.green : C.yellow}
              />
              <Field
                label="conflicts"
                value={mr.hasConflicts ? "yes" : "no"}
                color={mr.hasConflicts ? C.red : C.green}
              />
              {extrasLoading ? (
                <Field label="approvals" value="loading…" color={C.dim} />
              ) : extras ? (
                <>
                  <Field
                    label="approvals"
                    value={
                      extras.approved
                        ? `approved by ${extras.approvedBy.join(", ") || "?"}`
                        : `${extras.approvalsLeft} of ${extras.approvalsRequired} still needed`
                    }
                    color={extras.approved ? C.green : C.yellow}
                  />
                  <Field
                    label="threads"
                    value={
                      extras.resolvableThreads === 0
                        ? "no resolvable threads"
                        : `${extras.unresolvedThreads} unresolved of ${extras.resolvableThreads}`
                    }
                    color={extras.unresolvedThreads > 0 ? C.yellow : C.green}
                  />
                </>
              ) : (
                <Field label="approvals" value="failed to load" color={C.red} />
              )}
              <Field label="pipeline" value={mr.pipelineStatus ?? "none"} />
            </>
          )}
          <Field label="mr url" value={mr.url} color={C.dim} />
        </>
      ) : (
        <Field label="mr" value="none" color={C.dim} />
      )}
      <Field label="tmux" value={row.tmuxWindow ?? "no window"} color={row.tmuxWindow ? C.green : C.dim} />
      <text fg={C.dim}>esc/enter close   o open MR   t open ticket</text>
    </box>
  )
}
