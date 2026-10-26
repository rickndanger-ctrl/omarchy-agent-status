#!/usr/bin/env python3
"""Claude Code PermissionRequest hook: answer permission prompts from the G2 glasses.

If the glasses app hasn't polled this machine's HUD server in the last few
seconds (or the server isn't running, or approvals are paused), this exits at
once with no output and Claude Code asks in the terminal as usual. Otherwise it
sends a one-line summary to the glasses and waits. Allow or deny is returned to
Claude Code; "leave for desk" or no answer falls back to the terminal prompt.

Only the tool name and a short summary (command, file name, URL host) leave
this process, and only to the local HUD server's memory.
"""

import json
import os
import pathlib
import sys
import time
import urllib.parse
import urllib.request

HOME = pathlib.Path.home()
PORT = int(os.environ.get("HUD_PORT", "5182"))
BASE = f"http://127.0.0.1:{PORT}/api/hook"
WAIT_TOTAL = float(os.environ.get("HUD_HOOK_WAIT", "170"))  # keep under the hook timeout in settings


def token():
    file = pathlib.Path(os.environ.get("HUD_TOKEN_FILE", HOME / ".config/agent-glasses/token"))
    try:
        return file.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    for shared in (".messages-relay/config.json", ".muse-relay/config.json"):
        try:
            value = json.loads((HOME / shared).read_text(encoding="utf-8")).get("token")
        except (OSError, ValueError):
            continue
        if value:
            return value
    return ""


def call(method, path, body=None, timeout=3):
    request = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def tail(path, parts=2):
    return "/".join(pathlib.PurePath(str(path)).parts[-parts:])


def summarize(tool, data):
    """One short line the wearer can judge at a glance."""
    data = data if isinstance(data, dict) else {}
    if tool == "Bash":
        return str(data.get("command", ""))
    if tool in ("Edit", "Write", "MultiEdit", "Read", "NotebookEdit"):
        return tail(data.get("file_path") or data.get("notebook_path") or "")
    if tool == "WebFetch":
        return urllib.parse.urlparse(str(data.get("url", ""))).netloc
    if tool == "WebSearch":
        return str(data.get("query", ""))
    for value in data.values():
        if isinstance(value, str) and value:
            return value
    return ""


def tool_label(tool):
    if tool.startswith("mcp__"):
        parts = tool.split("__")
        return ":".join(parts[1:3])
    return tool


def answered_elsewhere(transcript, start):
    """True once the session transcript records a tool result after this prompt began:
    Rick answered at the keyboard, so the glasses card should go away."""
    if not transcript:
        return False
    try:
        with open(transcript, "rb") as stream:
            stream.seek(start)
            return b'"tool_result"' in stream.read()
    except OSError:
        return False


def decision(behavior):
    result = {"behavior": behavior}
    if behavior == "deny":
        result["message"] = "Denied from the glasses."
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": result}}


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    tool = str(data.get("tool_name", ""))
    try:
        ticket = call("POST", "/request", {
            "agent": "claude",
            "page": pathlib.PurePath(str(data.get("cwd", ""))).name,
            "tool": tool_label(tool),
            "summary": summarize(tool, data.get("tool_input")),
        }, timeout=2)
    except Exception:
        return  # server not running: normal terminal prompt
    if ticket.get("skip") or not ticket.get("id"):
        return
    ident = ticket["id"]
    transcript = data.get("transcript_path") or ""
    try:
        start = os.path.getsize(transcript) if transcript else 0
    except OSError:
        transcript, start = "", 0
    deadline = time.monotonic() + WAIT_TOTAL
    while True:
        left = deadline - time.monotonic()
        if left <= 1:
            break
        try:
            answer = call("GET", f"/wait/{ident}?ms={int(min(left - 1, 2) * 1000)}", timeout=6)
        except Exception:
            return
        behavior = answer.get("behavior")
        if behavior in ("allow", "deny"):
            print(json.dumps(decision(behavior)))
            return
        if answer.get("gone"):
            return  # "leave for desk" or expired
        if answered_elsewhere(transcript, start):
            break
    try:
        call("POST", f"/cancel/{ident}", {}, timeout=2)
    except Exception:
        pass


if __name__ == "__main__":
    main()
