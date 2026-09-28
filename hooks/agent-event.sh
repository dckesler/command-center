#!/usr/bin/env bash
# Normalizes Cursor and Claude Code hook payloads into a single NDJSON feed
# that the command center TUI reads to show per-worktree agent status and to
# keep its worktree/qa manager agents aware of what the ticket agents do.
#
# Usage (from hooks): bash agent-event.sh <source> <kind>
#   source: cursor | claude
#   kind:   state events   start | working | idle | attention | ended
#           activity events response | edit | shell
#           mail delivery   tool (Cursor postToolUse)
#
# State events:    {ts, source, state, dir, session, summary?, transcript?}
# Activity events: {ts, source, event, dir, session, text|file|command}
#   (no "state" field, so status readers ignore them)
#
# Reads the hook's JSON payload on stdin. Cursor provides workspace_roots and
# conversation_id; Claude Code provides cwd, session_id and transcript_path.
# Always exits 0 so a logging failure can never block an agent.
#
# Inter-agent mail (Cursor only): messages other agents sent to this agent's
# directory wait in a cc-mail mailbox. `tool` (postToolUse) hands them over as
# additional_context while the agent is working; `idle` (stop) hands them over
# as followup_message so a finishing agent picks them up as its next turn.
# Nothing else may write to stdout — Cursor parses it as the hook's JSON reply.

#
# Install: `bun run setup` symlinks this file to $CC_CONFIG_DIR/agent-event.sh
# and prints the hooks.json / settings.json entries that call it (see
# hooks/cursor-hooks.example.json and hooks/claude-settings.example.json).

SOURCE="${1:-unknown}"
KIND="${2:-unknown}"

# --- command-center config -------------------------------------------------
CC_CONFIG_DIR="${CC_CONFIG_DIR:-$HOME/.config/command-center}"
cc_cfg() { # cc_cfg <jq path> <default>
  local v=""
  if command -v jq >/dev/null 2>&1 && [ -f "$CC_CONFIG_DIR/config.json" ]; then
    v="$(jq -r "$1 // empty" "$CC_CONFIG_DIR/config.json" 2>/dev/null || true)"
  fi
  v="${v:-$2}"
  case "$v" in "~/"*) v="$HOME/${v#\~/}" ;; '$HOME/'*) v="$HOME/${v#\$HOME/}" ;; esac
  printf '%s' "$v"
}
FEED_DIR="$CC_CONFIG_DIR"
FEED="$FEED_DIR/agents.jsonl"
PROJECTS_DIR="${CC_PROJECTS_DIR:-$(cc_cfg .dirs.projects "$HOME/projects")}"
# Directory names under PROJECTS_DIR that are not projects (config projects.exclude).
PROJECTS_EXCLUDE="$(cc_cfg '.projects.exclude | join(" ")' "command-center node_modules")"
TEXT_MAX=600

# cc-mail CLI: PATH, ~/.local/bin, or the repo copy next to this script's real location.
cc_mail() {
  local bin
  bin="$(command -v cc-mail 2>/dev/null || true)"
  [ -n "$bin" ] || { [ -x "$HOME/.local/bin/cc-mail" ] && bin="$HOME/.local/bin/cc-mail"; }
  if [ -z "$bin" ]; then
    local here
    here="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")")" && pwd)"
    [ -x "$here/../skills/cc-mail/cc-mail" ] && bin="$here/../skills/cc-mail/cc-mail"
  fi
  [ -n "$bin" ] || return 0
  "$bin" "$@"
}

# Undelivered cc-mail for this agent's directory as one text block ("" if none).
# Cheap when the mailbox is empty: cc-mail only formats when there are lines.
pending_mail() {
  [ "$SOURCE" = "cursor" ] && [ -n "$DIR" ] || return 0
  [ -d "$FEED_DIR/mail" ] || return 0
  cc_mail drain --dir "$DIR" 2>/dev/null
}

mkdir -p "$FEED_DIR" 2>/dev/null || exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
DIR="$(printf '%s' "$INPUT" | jq -r '((.workspace_roots // [])[0] // .cwd // "")' 2>/dev/null)"

# postToolUse: deliver waiting mail mid-turn and stop — this fires on every
# tool call, so it must do nothing else.
if [ "$KIND" = "tool" ]; then
  MAIL="$(pending_mail)"
  [ -n "$MAIL" ] && jq -nc --arg m "$MAIL" '{additional_context: $m}'
  exit 0
fi

# jq programs (single-quoted: $vars are jq --arg variables, not shell ones).
BASE='{ts: (now | todate), source: $source, dir: ((.workspace_roots // [])[0] // .cwd // ""), session: (.conversation_id // .session_id // "")}'
RESPONSE_FILTER="$BASE"' + {event: "response", text: ($text | gsub("[[:space:]]+"; " ") | if length > $max then .[(length - $max):] else . end)}'
EDIT_FILTER="$BASE"' + {event: "edit", file: $file}'
SHELL_FILTER="$BASE"' + {event: "shell", command: ($cmd | .[:200])}'
STATE_FILTER="$BASE"' + {state: $state,
    summary: (.message // (.tool_name // "" | if . == "" then "" else "permission: " + . end)),
    transcript: (.transcript_path // "")}
  | with_entries(select(.value != "" or (.key | IN("dir", "session"))))'

append() {
  [ -n "$1" ] && printf '%s\n' "$1" >> "$FEED"
}

# Activity is only interesting inside git checkouts (ticket worktrees carry a
# .git file) or project directories (project agents); this keeps the hub's
# own agents, which run from $HOME, from flooding the feed with their
# responses and edits.
in_checkout() {
  [ -n "$DIR" ] || return 1
  case "$DIR" in
    "$PROJECTS_DIR"/*)
      local rel="${DIR#"$PROJECTS_DIR"/}" name
      name="${rel%%/*}"
      for ex in $PROJECTS_EXCLUDE; do [ "$name" = "$ex" ] && return 1; done
      return 0
      ;;
  esac
  [ -e "$DIR/.git" ] && return 0
  return 1
}

# Last assistant text of a Claude Code transcript (Claude's stop payload has no
# response text, only transcript_path).
last_claude_text() {
  local tp="$1"
  [ -n "$tp" ] && [ -r "$tp" ] || return 0
  tail -n 200 "$tp" 2>/dev/null | jq -rs \
    '[.[] | select(.type=="assistant") | [.message.content[]? | select(.type=="text") | .text] | join("\n") | select(length>0)] | last // ""' 2>/dev/null
}

emit_response() {
  local text="$1"
  [ -n "$text" ] || return 0
  in_checkout || return 0
  append "$(printf '%s' "$INPUT" | jq -c --arg source "$SOURCE" --arg text "$text" --argjson max "$TEXT_MAX" "$RESPONSE_FILTER" 2>/dev/null)"
}

case "$KIND" in
  response)
    emit_response "$(printf '%s' "$INPUT" | jq -r '.text // ""' 2>/dev/null)"
    ;;

  edit)
    in_checkout || exit 0
    FILE="$(printf '%s' "$INPUT" | jq -r '.file_path // .tool_input.file_path // ""' 2>/dev/null)"
    [ -n "$FILE" ] || exit 0
    append "$(printf '%s' "$INPUT" | jq -c --arg source "$SOURCE" --arg file "$FILE" "$EDIT_FILTER" 2>/dev/null)"
    ;;

  shell)
    in_checkout || exit 0
    CMD="$(printf '%s' "$INPUT" | jq -r '.command // .tool_input.command // ""' 2>/dev/null)"
    # Only state-changing git / MR commands are worth the managers' attention.
    if printf '%s' "$CMD" | grep -Eq '(^|[;&|][[:space:]]*)(git([[:space:]]+[^[:space:]]+){0,3}[[:space:]]+(commit|push|rebase|merge|reset|checkout|switch|stash|cherry-pick|revert)|glab mr (create|merge|update|close))([[:space:]]|$)'; then
      append "$(printf '%s' "$INPUT" | jq -c --arg source "$SOURCE" --arg cmd "$CMD" "$SHELL_FILTER" 2>/dev/null)"
    fi
    ;;

  start|working|idle|attention|ended)
    if [ "$SOURCE" = "claude" ] && [ "$KIND" = "idle" ]; then
      TP="$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null)"
      emit_response "$(last_claude_text "$TP")"
    fi
    append "$(printf '%s' "$INPUT" | jq -c --arg source "$SOURCE" --arg state "$KIND" "$STATE_FILTER" 2>/dev/null)"
    # stop: a finishing Cursor agent takes waiting mail as its next turn. Only
    # when the turn completed — an aborted/errored stop may not run follow-ups,
    # and the mail must stay queued for the wake path instead.
    if [ "$KIND" = "idle" ] && [ "$(printf '%s' "$INPUT" | jq -r '.status // "completed"' 2>/dev/null)" = "completed" ]; then
      MAIL="$(pending_mail)"
      [ -n "$MAIL" ] && jq -nc --arg m "$MAIL" '{followup_message: $m}'
    fi
    ;;

  *)
    exit 0
    ;;
esac

# Keep the feed from growing without bound.
if [ -f "$FEED" ] && [ "$(wc -l < "$FEED" 2>/dev/null || echo 0)" -gt 4000 ]; then
  tail -n 2000 "$FEED" > "$FEED.tmp" 2>/dev/null && mv "$FEED.tmp" "$FEED"
fi

exit 0
