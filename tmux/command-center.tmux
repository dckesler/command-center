# Command Center two-row status line: projects on top, this project's tabs below.
# Source from ~/.tmux.conf (or ~/.tmux.conf.user) *after* your own status
# settings — it overrides status, status-format and the window-status formats.
#
#   row 0  ❐ command center │ factory-design-engine │ parity-skill …   one tab per tmux session
#   row 1  1: central  2: parity-skill-tag-spec …                       that session's windows
#
# Marks come from `cc-flag` (skills/cc-flag): a window's @tab_color and a
# session's @cc_flag hold a colour (colour196 attention, colour220 warn). They
# clear themselves when you look: selecting a window clears its mark, switching
# a client to a session clears the session's.
#
# Keys (prefix = whatever you use):
#   prefix Tab / BTab   next / previous project
#   prefix 0            command center (session 0)
#   prefix S            project picker (choose-tree, sessions collapsed)
#   prefix 1-9          windows, as before

set -g status 2
set -g status-interval 5

# --- row 0: sessions as project tabs ---------------------------------------
# #{S:…} iterates sessions; #{client_session} is the one on screen.
set -g status-format[0] "#[fg=colour245,bg=colour234] ❐ #{S:#{?#{==:#{session_name},#{client_session}},#[fg=black#,bg=colour39#,bold] #{?#{==:#{session_name},0},command center,#{session_name}} #[default#,bg=colour234] ,#{?#{@cc_flag},#[fg=colour16#,bg=#{@cc_flag}#,bold],#[fg=colour250#,bg=colour238]} #{?#{==:#{session_name},0},command center,#{session_name}} #[default#,bg=colour234] }}#[align=right#,fg=colour245] %H:%M "

# --- row 1: this session's windows -------------------------------------------
set -g window-status-format "#[fg=#{?#{@tab_color},colour16,colour235},bg=#{?#{@tab_color},#{@tab_color},colour252},bold] #I #W #[default,bg=colour234]"
set -g window-status-current-format "#[fg=black,bg=colour39,bold] #{?window_zoomed_flag,#[fg=colour226]🔍 ,}#I: #W #[default,bg=colour234]"
set -g status-format[1] "#[bg=colour234] #{W:#{E:window-status-format} ,#{E:window-status-current-format} }"

# --- marks clear when looked at ---------------------------------------------
# select-window, switch-client -t sess:win and last-window all land here;
# client-session-changed covers arriving in a session (its current window is
# now on screen too).
set-hook -g after-select-window "set-window-option @tab_color ''"
set-hook -g session-window-changed "set-window-option @tab_color ''"
set-hook -g client-session-changed "set-option @cc_flag '' ; set-window-option @tab_color ''"
set-hook -g client-attached "set-option @cc_flag '' ; set-window-option @tab_color ''"

# --- keyboard -----------------------------------------------------------------
bind -r Tab switch-client -n
bind -r BTab switch-client -p
bind 0 switch-client -t =0
bind S choose-tree -Zs
