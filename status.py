#!/usr/bin/env python3
"""Small local event bridge for the Omarchy agent status widget.

Only state, session identity, and a short project label are stored. Prompts,
tool arguments, and credentials are never copied into the bar state.
"""

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

HOME = pathlib.Path.home()
STATE = pathlib.Path(os.environ.get("XDG_STATE_HOME", HOME / ".local/state")) / "omarchy/agent-status"
EVENTS = STATE / "events"
SNAPSHOT = STATE / "snapshot.json"
CONFIG = HOME / ".config/omarchy/agent-status.json"
SOUNDS = {
    "Off": "",
    "Complete": "/usr/share/sounds/freedesktop/stereo/complete.oga",
    "Bell": "/usr/share/sounds/freedesktop/stereo/bell.oga",
    "Message": "/usr/share/sounds/freedesktop/stereo/message.oga",
    "Warning": "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga",
}
DEFAULT_SOUNDS = {"working": "Off", "done": "Complete", "attention": "Message",
                  "stopped": "Warning", "error": "Warning"}
AGENTS = ("codex", "claude", "hermes", "herder")
LABELS = {"codex": "Codex", "claude": "Claude", "hermes": "Hermes", "herder": "Herder"}
SYMBOLS = {"working": "●", "done": "✓", "attention": "●", "error": "●", "stopped": "●", "idle": "○"}
PRIORITY = {"attention": 5, "error": 4, "working": 3, "done": 2, "stopped": 1, "idle": 0}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, path)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def label_for(path):
    if not path:
        return ""
    name = pathlib.Path(str(path)).name
    return name[:32] if name else ""


def write_event(agent, session, state, page="", source="hook"):
    if agent not in AGENTS or state not in PRIORITY:
        return
    key = hashlib.sha256(str(session or agent).encode()).hexdigest()[:20]
    item = {
        "agent": agent, "session": key, "state": state,
        "page": label_for(page), "source": source, "at": time.time(),
    }
    write_json(EVENTS / agent / f"{key}.json", item)


def claude_hook(event_name):
    data = json.load(sys.stdin)
    session = data.get("session_id") or data.get("transcript_path") or "claude"
    page = data.get("session_title") or data.get("cwd") or ""
    notification = data.get("notification_type")
    state = {
        "UserPromptSubmit": "working", "PreToolUse": "working",
        "Stop": "done", "SessionEnd": "stopped",
        "PermissionRequest": "attention",
    }.get(event_name)
    if event_name == "Notification" and notification in ("permission_prompt", "elicitation_dialog", "elicitation_url_dialog"):
        state = "attention"
    if state:
        write_event("claude", session, state, page)


def reverse_lines(path):
    with path.open("rb") as stream:
        stream.seek(0, 2)
        position = stream.tell()
        pending = b""
        while position > 0:
            size = min(65536, position)
            position -= size
            stream.seek(position)
            pending = stream.read(size) + pending
            lines = pending.split(b"\n")
            pending = lines.pop(0)
            for line in reversed(lines):
                if line:
                    yield line
        if pending:
            yield pending


def codex_sessions():
    base = HOME / ".codex/sessions"
    if not base.is_dir():
        return []
    files = sorted(base.glob("**/rollout-*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:16]
    result = []
    now = time.time()
    for path in files:
        if now - path.stat().st_mtime > 7 * 86400:
            continue
        page = ""
        state = "idle"
        at = path.stat().st_mtime
        try:
            with path.open("r", encoding="utf-8", errors="replace") as f:
                first = f.readline()
                meta = json.loads(first)
                page = (meta.get("payload") or {}).get("cwd", "")
            found_state = False
            found_page = False
            for line in reverse_lines(path):
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                typ = item.get("type")
                payload = item.get("payload") or {}
                if not found_page and typ == "turn_context" and payload.get("cwd"):
                    page = payload["cwd"]
                    found_page = True
                if not found_state and typ == "event_msg":
                    event_type = payload.get("type")
                    if event_type == "task_started":
                        state = "working"
                        found_state = True
                    elif event_type == "task_complete":
                        state = "done"
                        found_state = True
                    elif event_type in ("task_aborted", "turn_aborted"):
                        state = "stopped"
                        found_state = True
                if found_state and found_page:
                    break
        except (OSError, ValueError):
            continue
        # A crashed or abandoned process must not show working forever.
        if state == "working" and now - at > 3600:
            state = "stopped"
        page_label = label_for(page)
        if "/Documents/Codex/" in str(page):
            page_label = "Codex task"
        result.append({"agent": "codex", "session": path.stem, "state": state,
                       "page": page_label, "source": "session", "at": at})
    return result


def active_processes():
    found = set()
    try:
        output = subprocess.check_output(["ps", "-eo", "comm="], text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return found
    for name in output.splitlines():
        name = name.strip().lower()
        if name in ("claude", "hermes", "herder"):
            found.add(name)
        if name in ("chatgpt", "codex"):
            found.add("codex")
    return found


def window_workspaces():
    """Map visible agent windows to Hyprland workspace numbers."""
    result = {agent: set() for agent in AGENTS}
    try:
        clients = json.loads(subprocess.check_output(
            ["hyprctl", "clients", "-j"], text=True, timeout=2))
        process_rows = subprocess.check_output(
            ["ps", "-eo", "pid=,ppid=,comm="], text=True, timeout=2)
    except (OSError, ValueError, subprocess.SubprocessError):
        return result
    parents = {}
    processes = {}
    for row in process_rows.splitlines():
        fields = row.split(None, 2)
        if len(fields) == 3:
            pid, parent, name = fields
            parents[int(pid)] = int(parent)
            processes[int(pid)] = name.lower()

    for client in clients:
        workspace = (client.get("workspace") or {}).get("id")
        if not isinstance(workspace, int) or workspace <= 0:
            continue
        name = (client.get("class") or "").lower()
        title = (client.get("title") or "").lower()
        pid = client.get("pid")
        matched = set()
        if name in ("chatgpt", "codex"):
            matched.add("codex")
        for agent in ("claude", "hermes", "herder"):
            if agent in name or agent in title:
                matched.add(agent)
        if isinstance(pid, int):
            for process_pid, process_name in processes.items():
                if process_name not in AGENTS:
                    continue
                ancestor = process_pid
                for _ in range(32):
                    if ancestor == pid:
                        matched.add(process_name)
                        break
                    ancestor = parents.get(ancestor, 0)
                    if not ancestor:
                        break
        for agent in matched:
            result[agent].add(workspace)
    return result


def collect():
    now = time.time()
    items = codex_sessions()
    if EVENTS.is_dir():
        for path in EVENTS.glob("*/*.json"):
            record = read_json(path)
            if isinstance(record, dict) and record.get("agent") in AGENTS:
                if now - float(record.get("at", 0)) < 3600:
                    items.append(record)
    processes = active_processes()
    workspaces = window_workspaces()
    selected = {}
    for agent in AGENTS:
        pool = [r for r in items if r.get("agent") == agent and
                now - float(r.get("at", 0)) < 3600]
        if pool:
            # Attend to blocking states first; otherwise show the newest session.
            pool.sort(key=lambda r: (PRIORITY.get(r.get("state"), 0), float(r.get("at", 0))), reverse=True)
            chosen = dict(pool[0])
            if chosen["state"] == "working" and now - float(chosen.get("at", 0)) > 3600:
                chosen["state"] = "stopped"
        else:
            chosen = {"agent": agent, "state": "idle", "page": "", "at": 0, "session": ""}
        age = now - float(chosen.get("at", 0))
        chosen["visible"] = (agent == "herder" or agent in processes or
                             (chosen["state"] in ("done", "attention", "error", "stopped") and age < 3600) or
                             (chosen["state"] == "working" and age < 3600))
        chosen["name"] = LABELS[agent]
        chosen["symbol"] = SYMBOLS[chosen["state"]]
        chosen["workspace"] = ",".join(str(number) for number in sorted(workspaces[agent]))
        selected[agent] = chosen
    return selected


def play_sound(name):
    file = SOUNDS.get(name, "")
    if file and pathlib.Path(file).is_file():
        subprocess.Popen(["pw-play", file], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)


def poll():
    old = read_json(SNAPSHOT, {}) or {}
    config = read_json(CONFIG, {}) or {}
    sounds = dict(DEFAULT_SOUNDS)
    sounds.update(config.get("sounds") or {})
    selected = collect()
    previous = old.get("agents") or {}
    for agent, current in selected.items():
        prior = previous.get(agent)
        if not prior:
            continue
        if prior.get("state") != current["state"] and current["state"] in sounds:
            play_sound(sounds[current["state"]])
    output = {"agents": selected, "sounds": sounds, "at": time.time()}
    write_json(SNAPSHOT, output)
    print(json.dumps(output, ensure_ascii=False))


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit("usage: status.py poll | claude-hook EVENT | event AGENT SESSION STATE [PAGE] | sound STATE NAME | preview NAME")
    if args[0] == "poll":
        poll()
    elif args[0] == "claude-hook" and len(args) == 2:
        claude_hook(args[1])
    elif args[0] == "event" and len(args) >= 4:
        write_event(args[1], args[2], args[3], args[4] if len(args) > 4 else "")
    elif args[0] == "sound" and len(args) == 3 and args[1] in DEFAULT_SOUNDS and args[2] in SOUNDS:
        config = read_json(CONFIG, {}) or {}
        config.setdefault("sounds", {})[args[1]] = args[2]
        write_json(CONFIG, config)
        play_sound(args[2])
    elif args[0] == "preview" and len(args) == 2:
        play_sound(args[1])
    else:
        raise SystemExit("invalid status command")


if __name__ == "__main__":
    main()
