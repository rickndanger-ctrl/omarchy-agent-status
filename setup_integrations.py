#!/usr/bin/env python3
"""Opt in to local Claude Code and Hermes status hooks, and the G2 glasses HUD."""

import argparse
import json
import os
import pathlib
import platform
import shlex
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
HOME = pathlib.Path.home()
CLAUDE_SETTINGS = HOME / ".claude/settings.json"
HERMES_DEST = HOME / ".hermes/plugins/agent-status"
EVENTS = ("UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd")
HOOK_PREFIX = f"python3 {shlex.quote(str(ROOT / 'status.py'))} claude-hook "


def install_claude():
    settings = {}
    if CLAUDE_SETTINGS.exists():
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    hooks = settings.setdefault("hooks", {})
    for event in EVENTS:
        existing = hooks.get(event, [])
        existing = [item for item in existing if not any(
            hook.get("command", "").startswith(HOOK_PREFIX)
            for hook in item.get("hooks", [])
        )]
        existing.append({"hooks": [{
            "type": "command",
            "command": f"{HOOK_PREFIX}{event}",
            "timeout": 5,
        }]})
        hooks[event] = existing
    CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    CLAUDE_SETTINGS.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    print("Claude Code hooks installed. New sessions will report their status.")


GLASSES_HOOK = f"python3 {shlex.quote(str(ROOT / 'glasses/approve_hook.py'))}"
SYSTEMD_UNIT = HOME / ".config/systemd/user/agent-glasses.service"
LAUNCH_AGENT = HOME / "Library/LaunchAgents/com.rick.home-hud.plist"


def glasses_hosts():
    """Loopback for the hook, plus the Tailscale address so the hub and the phone can reach it."""
    hosts = ["127.0.0.1"]
    tailscale = shutil.which("tailscale") or "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    try:
        address = subprocess.run([tailscale, "ip", "-4"], capture_output=True, text=True, timeout=5).stdout.split()
    except OSError:
        address = []
    return ",".join(hosts + address[:1])


def install_glasses(mode, machine):
    settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8")) if CLAUDE_SETTINGS.exists() else {}
    hooks = settings.setdefault("hooks", {})
    kept = [item for item in hooks.get("PermissionRequest", []) if not any(
        hook.get("command", "") == GLASSES_HOOK for hook in item.get("hooks", []))]
    # Longer than approve_hook.py's own 170-second wait, so it always ends itself first.
    kept.append({"hooks": [{"type": "command", "command": GLASSES_HOOK, "timeout": 180}]})
    hooks["PermissionRequest"] = kept
    CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    CLAUDE_SETTINGS.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")

    # The `ag` launcher: agents started with it run in tmux, so the glasses can prompt them.
    launcher = HOME / ".local/bin/ag"
    launcher.parent.mkdir(parents=True, exist_ok=True)
    if launcher.is_symlink() or not launcher.exists():
        launcher.unlink(missing_ok=True)
        launcher.symlink_to(ROOT / "glasses/ag")

    node = shutil.which("node") or "/opt/homebrew/bin/node"
    args = [node, str(ROOT / "glasses/hud-server.mjs"), "--mode", mode, "--host", glasses_hosts()]
    if machine:
        args += ["--machine", machine]
    if platform.system() == "Darwin":
        items = "".join(f"<string>{arg}</string>" for arg in args)
        LAUNCH_AGENT.parent.mkdir(parents=True, exist_ok=True)
        LAUNCH_AGENT.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.rick.home-hud</string>
<key>ProgramArguments</key><array>{items}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
""", encoding="utf-8")
        subprocess.run(["launchctl", "unload", str(LAUNCH_AGENT)], capture_output=True)
        subprocess.run(["launchctl", "load", str(LAUNCH_AGENT)], check=True)
    else:
        SYSTEMD_UNIT.parent.mkdir(parents=True, exist_ok=True)
        SYSTEMD_UNIT.write_text(f"""[Unit]
Description=Home HUD for the G2 glasses (agent status and approvals)
After=network-online.target

[Service]
ExecStart={shlex.join(args)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
""", encoding="utf-8")
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", "agent-glasses.service"], check=True)
        subprocess.run(["systemctl", "--user", "restart", "agent-glasses.service"], check=True)
    print(f"Glasses HUD ({mode}) running on {glasses_hosts()}:5182; Claude Code approval hook installed.")


SESSIONS_AGENT = HOME / "Library/LaunchAgents/com.rick.home-agents.plist"


def install_sessions():
    """macOS: keep an always-open Claude and Codex in tmux (glasses/agent-sessions.sh, every minute)."""
    if platform.system() != "Darwin":
        print("Always-open sessions are for the Macs; on Linux, Home types into your terminal windows.")
        return
    script = ROOT / "glasses/agent-sessions.sh"
    SESSIONS_AGENT.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_AGENT.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.rick.home-agents</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>{script}</string></array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>
<key>AbandonProcessGroup</key><true/>
</dict></plist>
""", encoding="utf-8")
    # The logged-in desktop session (gui domain), so Claude can read its login from the keychain.
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain, str(SESSIONS_AGENT)], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(SESSIONS_AGENT)], check=True)
    print("Always-open Claude and Codex sessions on. Watch one with: tmux attach -t claude")


def remove_glasses():
    if CLAUDE_SETTINGS.exists():
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
        hooks = settings.get("hooks") or {}
        kept = [item for item in hooks.get("PermissionRequest", []) if not any(
            hook.get("command", "") == GLASSES_HOOK for hook in item.get("hooks", []))]
        if kept:
            hooks["PermissionRequest"] = kept
        else:
            hooks.pop("PermissionRequest", None)
        CLAUDE_SETTINGS.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    if LAUNCH_AGENT.exists():
        subprocess.run(["launchctl", "unload", str(LAUNCH_AGENT)], capture_output=True)
        LAUNCH_AGENT.unlink()
    if SESSIONS_AGENT.exists():
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(SESSIONS_AGENT)], capture_output=True)
        SESSIONS_AGENT.unlink()
    if SYSTEMD_UNIT.exists():
        subprocess.run(["systemctl", "--user", "disable", "--now", "agent-glasses.service"], capture_output=True)
        SYSTEMD_UNIT.unlink()
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    launcher = HOME / ".local/bin/ag"
    if launcher.is_symlink() and launcher.resolve() == (ROOT / "glasses/ag").resolve():
        launcher.unlink()
    print("Glasses HUD stopped and its approval hook removed.")


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


def remove_claude():
    if not CLAUDE_SETTINGS.exists():
        return
    settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    hooks = settings.get("hooks") or {}
    for event in EVENTS:
        kept = [item for item in hooks.get(event, []) if not any(
            hook.get("command", "").startswith(HOOK_PREFIX)
            for hook in item.get("hooks", [])
        )]
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)
    if not hooks:
        settings.pop("hooks", None)
    CLAUDE_SETTINGS.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    print("Agent status hooks removed from Claude Code settings.")


def remove_hermes():
    if shutil.which("hermes") and HERMES_DEST.exists():
        subprocess.run(["hermes", "plugins", "disable", "agent-status"], check=True)
    for source_name, target_name in (("hermes_plugin.py", "__init__.py"),
                                     ("hermes_plugin.yaml", "plugin.yaml")):
        source = ROOT / source_name
        target = HERMES_DEST / target_name
        if target.exists() and target.read_bytes() == source.read_bytes():
            target.unlink()
    if HERMES_DEST.is_dir() and not any(HERMES_DEST.iterdir()):
        HERMES_DEST.rmdir()
    print("Agent status Hermes plugin disabled and unchanged files removed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude", action="store_true", help="Install only Claude Code hooks")
    parser.add_argument("--hermes", action="store_true", help="Install only Hermes hooks")
    parser.add_argument("--glasses", action="store_true", help="Only the G2 glasses HUD server and approval hook")
    parser.add_argument("--hub", action="store_true", help="With --glasses: run as the hub (Mac mini 1)")
    parser.add_argument("--machine", default="", help="With --glasses: short machine name shown on the glasses")
    parser.add_argument("--sessions", action="store_true", help="macOS: keep an always-open Claude and Codex in tmux for the glasses")
    parser.add_argument("--remove", action="store_true", help="Remove selected integrations")
    args = parser.parse_args()
    if args.sessions and not args.remove:
        install_sessions()
        return
    if args.glasses:
        remove_glasses() if args.remove else install_glasses("hub" if args.hub else "node", args.machine)
        return
    if not args.claude and not args.hermes:
        args.claude = args.hermes = True
    if args.claude:
        remove_claude() if args.remove else install_claude()
    if args.hermes:
        remove_hermes() if args.remove else install_hermes()


if __name__ == "__main__":
    main()
