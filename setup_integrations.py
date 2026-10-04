#!/usr/bin/env python3
"""Opt in to local Claude Code and Hermes status hooks."""

import argparse
import json
import pathlib
import shlex
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
HOME = pathlib.Path.home()
CLAUDE_SETTINGS = HOME / ".claude/settings.json"
HERMES_DEST = HOME / ".hermes/plugins/agent-status"
EVENTS = ("UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd")


def install_claude():
    settings = {}
    if CLAUDE_SETTINGS.exists():
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    hooks = settings.setdefault("hooks", {})
    for event in EVENTS:
        existing = hooks.get(event, [])
        existing = [item for item in existing if not any(
            "status.py claude-hook " in hook.get("command", "")
            for hook in item.get("hooks", [])
        )]
        existing.append({"hooks": [{
            "type": "command",
            "command": f"python3 {shlex.quote(str(ROOT / 'status.py'))} claude-hook {event}",
            "timeout": 5,
        }]})
        hooks[event] = existing
    CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    CLAUDE_SETTINGS.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    print("Claude Code hooks installed. New sessions will report their status.")


def install_hermes():
    HERMES_DEST.mkdir(parents=True, exist_ok=True)
    for source_name, target_name in (("hermes_plugin.py", "__init__.py"),
                                     ("hermes_plugin.yaml", "plugin.yaml")):
        shutil.copy2(ROOT / source_name, HERMES_DEST / target_name)
    if shutil.which("hermes"):
        subprocess.run(["hermes", "plugins", "enable", "agent-status", "--no-allow-tool-override"], check=True)
        print("Hermes plugin enabled. New sessions will report their status.")
    else:
        print("Hermes hook files installed; enable them after installing Hermes.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude", action="store_true", help="Install only Claude Code hooks")
    parser.add_argument("--hermes", action="store_true", help="Install only Hermes hooks")
    args = parser.parse_args()
    if not args.claude and not args.hermes:
        args.claude = args.hermes = True
    if args.claude:
        install_claude()
    if args.hermes:
        install_hermes()


if __name__ == "__main__":
    main()
