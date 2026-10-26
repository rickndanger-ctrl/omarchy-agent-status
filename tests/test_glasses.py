"""End-to-end checks for the glasses HUD server and the Claude Code approval hook."""

import json
import os
import shutil
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "glasses/hud-server.mjs"
HOOK = ROOT / "glasses/approve_hook.py"
TOKEN = "test-token"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, tmp, mode="node", hub=None, machine="lap"):
        self.port = free_port()
        token_file = Path(tmp) / f"token-{self.port}"
        token_file.write_text(TOKEN)
        env = {**os.environ, "HUD_TOKEN_FILE": str(token_file), "HUD_PORT": str(self.port),
               "HUD_MODE": mode, "HUD_MACHINE": machine, "XDG_STATE_HOME": str(Path(tmp) / "state")}
        if hub is not None:
            config = Path(tmp) / f"hub-{self.port}.json"
            config.write_text(json.dumps(hub))
            env["HUD_HUB_CONFIG"] = str(config)
        self.env = env
        self.proc = subprocess.Popen(["node", str(SERVER)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                self.get("/api/health", token=None)
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def request(self, method, path, body=None, token=TOKEN):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        with urllib.request.urlopen(req, timeout=5) as res:
            return json.loads(res.read())

    def get(self, path, token=TOKEN):
        return self.request("GET", path, token=token)

    def hook(self, payload, wait="20"):
        return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload).encode(), capture_output=True,
                              env={**self.env, "HUD_HOOK_WAIT": wait}, timeout=30)

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)


BASH = {"tool_name": "Bash", "tool_input": {"command": "git push origin main"}, "cwd": "/x/proj"}


class GlassesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.server = Server(self.tmp)

    def tearDown(self):
        self.server.stop()

    def answer_when_pending(self, behavior):
        def run():
            for _ in range(50):
                pending = self.server.get("/api/home")["pending"]
                if pending:
                    self.server.request("POST", "/api/decide", {"machine": "lap", "id": pending[0]["id"], "behavior": behavior})
                    return
                time.sleep(0.1)
        thread = threading.Thread(target=run)
        thread.start()
        return thread

    def test_hook_steps_aside_when_glasses_are_not_connected(self):
        started = time.monotonic()
        result = self.server.hook(BASH)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertLess(time.monotonic() - started, 2)

    def test_hook_steps_aside_when_server_is_down(self):
        self.server.stop()
        result = self.server.hook(BASH)
        self.server.proc = subprocess.Popen(["true"])  # keep tearDown happy
        self.assertEqual((result.returncode, result.stdout), (0, b""))

    def test_allow_and_deny_from_glasses(self):
        for behavior in ("allow", "deny"):
            self.server.get("/api/home")
            thread = self.answer_when_pending(behavior)
            result = self.server.hook(BASH)
            thread.join()
            decision = json.loads(result.stdout)["hookSpecificOutput"]["decision"]
            self.assertEqual(decision["behavior"], behavior)
            self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["hookEventName"], "PermissionRequest")

    def test_leave_for_desk_falls_back_to_terminal(self):
        self.server.get("/api/home")
        thread = self.answer_when_pending("desk")
        result = self.server.hook(BASH)
        thread.join()
        self.assertEqual((result.returncode, result.stdout), (0, b""))

    def test_answer_at_desk_clears_the_glasses_card(self):
        transcript = Path(self.tmp) / "t.jsonl"
        transcript.write_text('{"type":"assistant"}\n')
        self.server.get("/api/home")

        def answer_at_desk():
            time.sleep(1)
            with transcript.open("a") as f:
                f.write('{"type":"user","message":{"content":[{"type":"tool_result"}]}}\n')
        threading.Thread(target=answer_at_desk).start()
        result = self.server.hook({**BASH, "transcript_path": str(transcript)})
        self.assertEqual(result.stdout, b"")
        self.assertEqual(self.server.get("/api/home")["pending"], [])

    def test_summary_is_short_and_private(self):
        self.server.get("/api/home")
        payload = {"tool_name": "Write", "tool_input": {"file_path": "/home/x/secret-client/notes/plan.md", "content": "PRIVATE"}, "cwd": "/home/x/secret-client"}
        thread = threading.Thread(target=self.server.hook, args=(payload, "3"))
        thread.start()
        time.sleep(1)
        pending = self.server.get("/api/home")["pending"][0]
        thread.join()
        self.assertEqual(pending["summary"], "notes/plan.md")
        self.assertNotIn("PRIVATE", json.dumps(pending))

    def test_token_is_required(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.server.get("/api/home", token="wrong")
        self.assertEqual(error.exception.code, 401)

    def test_focus_accepts_only_a_workspace_number(self):
        for bad in ("1; rm -rf /", "exec kitty", 0, 99):
            self.assertFalse(self.server.request("POST", "/api/focus", {"machine": "lap", "workspace": bad})["ok"])

    def test_pause_makes_the_hook_step_aside(self):
        self.server.get("/api/home")
        self.server.request("POST", "/api/pause", {"paused": True})
        self.server.get("/api/home")
        self.assertEqual(self.server.hook(BASH).stdout, b"")

    def test_hub_merges_nodes_and_marks_dead_ones_offline(self):
        dead = free_port()
        hub = Server(self.tmp, mode="hub", machine="m1", hub={"nodes": [
            {"name": "lap", "url": f"http://127.0.0.1:{self.server.port}"},
            {"name": "neo", "url": f"http://127.0.0.1:{dead}"}]})
        try:
            home = hub.get("/api/home")
            self.assertEqual({m["name"]: m["online"] for m in home["machines"]}, {"m1": True, "lap": True, "neo": False})
            # The glasses polling the hub counts as the glasses being connected on each node.
            thread = threading.Thread(target=lambda: self.__setattr__("hooked", self.server.hook(BASH)))
            thread.start()
            for _ in range(50):
                pending = hub.get("/api/home")["pending"]
                if pending:
                    break
                time.sleep(0.1)
            self.assertEqual(pending[0]["machine"], "lap")
            self.assertTrue(hub.request("POST", "/api/decide", {"machine": "lap", "id": pending[0]["id"], "behavior": "allow"})["ok"])
            thread.join()
            self.assertEqual(json.loads(self.hooked.stdout)["hookSpecificOutput"]["decision"]["behavior"], "allow")
        finally:
            hub.stop()


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.server = Server(self.tmp)

    def tearDown(self):
        self.server.stop()

    def pair(self, code):
        try:
            return self.server.request("POST", "/api/pair", {"code": code}, token=None)
        except urllib.error.HTTPError as error:
            return {"status": error.code}

    def test_code_gives_the_token_once(self):
        self.assertEqual(self.pair("123456"), {"status": 403})
        code = self.server.request("POST", "/api/pair/new", {})["code"]
        self.assertEqual(self.pair(code), {"token": TOKEN})
        self.assertEqual(self.pair(code), {"status": 403})

    def test_five_wrong_guesses_cancel_the_code(self):
        code = self.server.request("POST", "/api/pair/new", {})["code"]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(5):
            self.pair(wrong)
        self.assertEqual(self.pair(code), {"status": 403})

    def test_auto_pair_only_for_the_owner_through_serve(self):
        self.server.stop()
        self.server = Server(self.tmp)
        self.server.proc.terminate(); self.server.proc.wait()
        env = {**self.server.env, "HUD_OWNER": "rick@example.com"}
        self.server.proc = subprocess.Popen(["node", str(SERVER)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        def auto(who):
            req = urllib.request.Request(f"http://127.0.0.1:{self.server.port}/api/pair/auto", method="POST", headers={"Tailscale-User-Login": who})
            try:
                with urllib.request.urlopen(req, timeout=5) as res:
                    return json.loads(res.read())
            except urllib.error.HTTPError as error:
                return {"status": error.code}
        self.assertEqual(auto("rick@example.com"), {"token": TOKEN})
        self.assertEqual(auto("someone@else.com"), {"status": 403})

    def test_only_the_token_holder_can_make_a_code(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.server.request("POST", "/api/pair/new", {}, token="nope")


class PromptTests(unittest.TestCase):
    """A fake `claude` in a private tmux server stands in for a real agent."""

    def setUp(self):
        if not shutil.which("tmux"):
            self.skipTest("tmux not installed")
        self.tmp = tempfile.mkdtemp()
        bin_dir = Path(self.tmp) / "bin"
        bin_dir.mkdir()
        self.received = Path(self.tmp) / "received.txt"
        fake = bin_dir / "claude"
        fake.write_text(f"#!/bin/sh\nwhile read -r line; do echo \"$line\" >> {self.received}; done\n")
        fake.chmod(0o755)
        os.environ["TMUX_TMPDIR"] = self.tmp  # a private tmux server, not Rick's
        os.environ["PATH"] = f"{bin_dir}:{os.environ['PATH']}"
        subprocess.run(["tmux", "new-session", "-d", "-s", "claude-test", "-c", self.tmp, "claude"], check=True)
        self.server = Server(self.tmp, machine="Dell")

    def tearDown(self):
        self.server.stop()
        subprocess.run(["tmux", "kill-server"], capture_output=True)
        os.environ.pop("TMUX_TMPDIR", None)

    def test_prompt_is_typed_into_the_agent_pane(self):
        for _ in range(30):
            sessions = self.server.get("/api/home")["sessions"]
            panes = [s for s in sessions if s.get("pane")]
            if panes:
                break
            time.sleep(0.2)
        self.assertEqual(panes[0]["agent"], "claude")
        ok = self.server.request("POST", "/api/prompt", {"machine": "Dell", "pane": panes[0]["pane"], "text": "run the tests\u0007"})
        self.assertTrue(ok["ok"])
        for _ in range(30):
            if self.received.exists() and self.received.read_text().strip():
                break
            time.sleep(0.1)
        self.assertEqual(self.received.read_text().strip(), "run the tests")

    def test_unknown_panes_and_keys_are_refused(self):
        self.assertFalse(self.server.request("POST", "/api/prompt", {"machine": "Dell", "pane": "%999", "text": "x"})["ok"])
        self.assertFalse(self.server.request("POST", "/api/prompt", {"machine": "Dell", "pane": "; rm -rf ~", "text": "x"})["ok"])


if __name__ == "__main__":
    unittest.main()
