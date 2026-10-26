#!/usr/bin/env bash
# Keep an always-open Claude and Codex terminal session (tmux, or GNU screen where tmux is missing),
# so the G2 glasses can prompt them. Run every minute by a LaunchAgent. It starts a session that is
# missing, and restarts the agent inside a session whose agent has exited (e.g. after /exit).
#   Watch or type yourself:  tmux attach -t claude    (detach: Ctrl-b then d)
#   Without tmux (the Neo):   screen -r claude          (detach: Ctrl-a then d)
#   DRY_RUN=1 prints what it would do instead of doing it.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
dir="${AGENT_SESSIONS_DIR:-$HOME/Projects}"
[ -d "$dir" ] || dir="$HOME"

act() { if [ -n "${DRY_RUN:-}" ]; then echo "would: $*"; else "$@"; fi; }

# Is a process named like the agent ("claude", ".../codex", "node .../codex") anywhere under this pid?
agent_running() {
  ps -Ao pid=,ppid=,args= | awk -v root="$1" -v agent="$2" '
    { pid[NR] = $1; ppid[NR] = $2; a = $3; if (a ~ /(^|\/)node$/) a = $4; n = split(a, parts, "/"); name[NR] = parts[n] }
    END {
      tree[root] = 1
      for (round = 0; round < 8; round++) for (i = 1; i <= NR; i++) if (ppid[i] in tree) tree[pid[i]] = 1
      for (i = 1; i <= NR; i++) if ((pid[i] in tree) && name[i] == agent) found = 1
      exit found ? 0 : 1
    }'
}

for agent in claude codex; do
  command -v "$agent" >/dev/null 2>&1 || continue
  if command -v tmux >/dev/null 2>&1; then
    root=$(tmux list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null | awk -v s="$agent" '$1 == s { print $2; exit }')
    if [ -n "$root" ]; then
      if agent_running "$root" "$agent"; then [ -n "${DRY_RUN:-}" ] && echo "$agent: running"; continue; fi
      act tmux send-keys -t "$agent" "$agent" Enter
      continue
    fi
    act tmux new-session -d -s "$agent" -x 200 -y 50 -c "$dir" "$agent; exec \$SHELL -l"
  elif command -v screen >/dev/null 2>&1; then
    root=$(screen -ls 2>/dev/null | sed -n "s/^[[:space:]]*\([0-9][0-9]*\)\.$agent[[:space:]].*/\1/p" | head -1)
    if [ -n "$root" ]; then
      if agent_running "$root" "$agent"; then [ -n "${DRY_RUN:-}" ] && echo "$agent: running"; continue; fi
      act screen -S "$root.$agent" -p 0 -X stuff "$agent$(printf '\r')"
      continue
    fi
    (cd "$dir" && act screen -dmS "$agent" /bin/zsh -lc "$agent; exec \$SHELL -l")
  fi
done
