#!/usr/bin/env bash
# One-time: restart the always-open Claude and Codex sessions with full access, resuming the same
# conversation (by its exact id). DRY_RUN=1 prints what it would do.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:/usr/sbin:/sbin"
here=$(cd "$(dirname "$0")" && pwd)

descendants() { # pid and everything under it, nearest first (parents before their children)
  ps -Ao pid=,ppid= | awk -v root="$1" '{ p[NR] = $1; pp[NR] = $2 } END {
    t[root] = 0; print root
    for (d = 1; d <= 8; d++) for (i = 1; i <= NR; i++) if ((pp[i] in t) && t[pp[i]] == d - 1 && !(p[i] in t)) { t[p[i]] = d; print p[i] } }'
}
agent_pid() { # top-most process under $1 named like the agent (not one of its helpers)
  for p in $(descendants "$1"); do
    a=$(ps -o args= -p "$p" 2>/dev/null) || continue
    set -- $a
    name=$(basename "$1"); [ "${name##*/}" = node ] && name=$(basename "${2:-}")
    [ "$name" = "$AGENT" ] && { echo "$p"; return; }
  done
}

for AGENT in claude codex; do
  if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$AGENT" 2>/dev/null; then
    root=$(tmux list-panes -a -F '#{session_name} #{pane_pid}' | awk -v s="$AGENT" '$1 == s { print $2; exit }')
    send() { tmux send-keys -t "$AGENT" "$1" Enter; }
  else
    sid=$(screen -ls 2>/dev/null | sed -n "s/^[[:space:]]*\([0-9][0-9]*\)\.$AGENT[[:space:]].*/\1/p" | head -1)
    [ -n "$sid" ] || { echo "$AGENT: no always-open session"; continue; }
    root=$sid
    send() { screen -S "$sid.$AGENT" -p 0 -X stuff "$1$(printf '\r')"; }
  fi
  pid=$(agent_pid "$root")
  [ -n "$pid" ] || { echo "$AGENT: not running; the minute job will start it with full access"; continue; }
  id=""
  if [ "$AGENT" = claude ]; then
    id=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('sessionId',''))" "$HOME/.claude/sessions/$pid.json" 2>/dev/null)
  else
    file=$(lsof -a -p "$(descendants "$pid" | paste -sd, -)" -Fn 2>/dev/null | sed -n 's/^n\(.*rollout-.*\.jsonl\)$/\1/p' | head -1)
    id=$(basename "${file:-}" .jsonl | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  fi
  echo "$AGENT: pid $pid, conversation ${id:-none (fresh start)}"
  [ -n "${DRY_RUN:-}" ] && continue
  kill $(descendants "$pid") 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  sleep 1
  send "exec bash $here/start-agent.sh $AGENT '' $id"
  echo "$AGENT: restarted with full access"
done
