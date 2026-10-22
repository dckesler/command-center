# Command Center status line, at the bottom of the screen:
#
#   row 0   1 central  2 parity-skill-tag-spec …                           this session's windows
#   row 1   (blank spacer)
#   row 2   0 COMMAND CENTER   1 FACTORY-DESIGN-ENGINE   2 PARITY-SKILL …   one tab per session
#
# (set status-position top to flip the block to the top; the row order is
# windows / gap / sessions either way, swap the status-format indexes to change it.)
#
# Source from ~/.tmux.conf (or ~/.tmux.conf.user) *after* your own status
# settings — it overrides status, status-format and the window-status formats.
#
# Sessions are numbered by tmux/cc-session (0 = the Command Center work
# session, then 1..N in creation order — the order the row draws them, and
# numbers don't shift when a new project opens) and stored in each session's
# @idx/@label; hooks renumber whenever a session is created, closed or renamed.
#
# Marks come from `cc-flag` (skills/cc-flag): a window's @tab_color and a
# session's @cc_flag hold a colour (colour196 attention, colour220 warn). They
# clear themselves when you look: selecting a window clears its mark, switching
# a client to a session clears the session's.
#
# Keys:
#   Alt-0 … Alt-9       session by number, no prefix (0 = Command Center)
#   prefix 1-9          windows, as before
#   prefix Tab / BTab   next / previous session
#   prefix S            session picker (choose-tree, sessions collapsed)
#
# Alt needs the terminal to send Option as Meta: Alacritty `[window]
# option_as_alt = "Both"`, Ghostty `macos-option-as-alt = true`.

set -gF @cc_tmux_dir "#{d:current_file}"

set -g status 3
set -g status-position bottom
set -g status-interval 5

# --- session numbering --------------------------------------------------------
run-shell -b "#{@cc_tmux_dir}/cc-session index"
set-hook -g session-created "run-shell -b '#{@cc_tmux_dir}/cc-session index'"
set-hook -g session-closed  "run-shell -b '#{@cc_tmux_dir}/cc-session index'"
set-hook -g session-renamed "run-shell -b '#{@cc_tmux_dir}/cc-session index'"

# --- row 2: sessions as project tabs ---------------------------------------
# #{S:…} iterates sessions; #{client_session} is the one on screen.
set -g status-format[2] "#[fg=colour245,bg=colour234]  #{S:#{?#{==:#{session_name},#{client_session}},#[fg=colour24#,bg=colour39#,bold] #{@idx} #[fg=black] #{@label} ,#{?#{@cc_flag},#[fg=colour52#,bg=#{@cc_flag}#,bold] #{@idx} #[fg=colour16] #{@label} ,#[fg=colour245#,bg=colour237#,bold] #{@idx} #[fg=colour252] #{@label} }}#[default#,bg=colour234]  }#[align=right#,fg=colour245] %H:%M  "

# --- row 1: gap ---------------------------------------------------------------
set -g status-format[1] "#[fill=default]"

# --- row 0: this session's windows -------------------------------------------
set -g window-status-format "#[fg=#{?#{@tab_color},colour16,colour245},bg=#{?#{@tab_color},#{@tab_color},colour236}] #I #W #[default,bg=colour234]"
set -g window-status-current-format "#[fg=black,bg=colour39,bold] #{?window_zoomed_flag,#[fg=colour226]🔍 ,}#I: #W #[default,bg=colour234]"
set -g status-format[0] "#[bg=colour234] #{W:#{E:window-status-format} ,#{E:window-status-current-format} }"

# --- marks clear when looked at ---------------------------------------------
# select-window, switch-client -t sess:win and last-window all land here;
# client-session-changed covers arriving in a session (its current window is
# now on screen too).
set-hook -g after-select-window "set-window-option @tab_color ''"
set-hook -g session-window-changed "set-window-option @tab_color ''"
set-hook -g client-session-changed "set-option @cc_flag '' ; set-window-option @tab_color ''"
set-hook -g client-attached "set-option @cc_flag '' ; set-window-option @tab_color ''"

# --- keyboard -----------------------------------------------------------------
# Alt-N: the session numbered N. run-shell expands #{client_name} for the
# client that pressed the key, so the switch lands on that client.
bind -n M-0 run-shell "#{@cc_tmux_dir}/cc-session go 0 '#{client_name}'"
bind -n M-1 run-shell "#{@cc_tmux_dir}/cc-session go 1 '#{client_name}'"
bind -n M-2 run-shell "#{@cc_tmux_dir}/cc-session go 2 '#{client_name}'"
bind -n M-3 run-shell "#{@cc_tmux_dir}/cc-session go 3 '#{client_name}'"
bind -n M-4 run-shell "#{@cc_tmux_dir}/cc-session go 4 '#{client_name}'"
bind -n M-5 run-shell "#{@cc_tmux_dir}/cc-session go 5 '#{client_name}'"
bind -n M-6 run-shell "#{@cc_tmux_dir}/cc-session go 6 '#{client_name}'"
bind -n M-7 run-shell "#{@cc_tmux_dir}/cc-session go 7 '#{client_name}'"
bind -n M-8 run-shell "#{@cc_tmux_dir}/cc-session go 8 '#{client_name}'"
bind -n M-9 run-shell "#{@cc_tmux_dir}/cc-session go 9 '#{client_name}'"

# Tab/BTab walk the numbers (switch-client -n/-p walk sessions by *name*,
# which isn't the order the row shows). Not -r: a repeatable Tab keeps the
# prefix table open for repeat-time, so a quick second "prefix Tab" sends the
# prefix key itself into that table (last-window, if you bind it).
bind Tab  run-shell "#{@cc_tmux_dir}/cc-session next '#{session_id}' '#{client_name}'"
bind BTab run-shell "#{@cc_tmux_dir}/cc-session prev '#{session_id}' '#{client_name}'"
bind 0 switch-client -t =0
bind S choose-tree -Zs
