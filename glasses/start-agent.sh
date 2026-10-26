#!/usr/bin/env bash
# Start an agent with full access and a first task, for a session Home created from the glasses.
#   start-agent.sh claude|codex <task-file>
# The task is read from a private file (then deleted) so its words never pass through a shell command line.
# Full access: Claude runs with --dangerously-skip-permissions, Codex with
# --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust (Rick chose: trust his own
# Codex hooks). When the agent exits, a shell stays open.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
agent=$1
task_file=$2
task=""
if [ -f "$task_file" ]; then
  task=$(cat "$task_file")
  rm -f "$task_file"
fi
case "$agent" in
  claude) flags=(--dangerously-skip-permissions) ;;
  codex) flags=(--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust) ;;
  *) echo "start-agent: unknown agent $agent" >&2; exec "${SHELL:-/bin/zsh}" -l ;;
esac
if [ -n "$task" ]; then "$agent" "${flags[@]}" "$task"; else "$agent" "${flags[@]}"; fi
exec "${SHELL:-/bin/zsh}" -l
