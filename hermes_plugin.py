"""Observer-only status hooks for the local Omarchy bar."""

import json
import os
import pathlib
import subprocess
import sys

SCRIPT = pathlib.Path.home() / ".config/omarchy/plugins/rickom1.agent-status/status.py"


def _emit(session, state):
    if not SCRIPT.is_file():
        return
    try:
        subprocess.run(
            [sys.executable, str(SCRIPT), "event-stdin"],
            input=json.dumps({"agent": "hermes", "session": str(session or "hermes"),
                              "state": state, "page": os.getcwd()}).encode("utf-8"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=2, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def register(ctx):
    def working(session_id=None, **kwargs):
        _emit(session_id, "working")

    def finished(session_id=None, completed=False, failed=False, interrupted=False, **kwargs):
        _emit(session_id, "stopped" if interrupted else "error" if failed else "done" if completed else "stopped")

    def approval(session_key=None, **kwargs):
        _emit(session_key, "attention")

    def approval_done(session_key=None, choice="", **kwargs):
        _emit(session_key, "working" if choice in ("once", "session", "always", "smart_approve") else "stopped")

    def stopped(session_key=None, **kwargs):
        _emit(session_key, "stopped")

    ctx.register_hook("pre_llm_call", working)
    ctx.register_hook("on_session_end", finished)
    ctx.register_hook("pre_approval_request", approval)
    ctx.register_hook("post_approval_response", approval_done)
    ctx.register_hook("agent_loop_stopped", stopped)
