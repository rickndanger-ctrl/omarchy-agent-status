#!/usr/bin/env python3
"""Real hub HTTP tests with private HOME, fake Groq/Muse and a deny-by-default Node guard."""
import argparse
import contextlib
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import quote, urlencode

HERE = Path(__file__).resolve().parents[1]
GUARD = HERE / "test-helpers" / "listen-network-guard.mjs"
NODE = shutil.which("node")
HUB_TOKEN = "fixture-listen-hub-auth"
RELAY_TOKEN = "fixture-listen-relay-auth"
GROQ_KEY = "fixture-listen-groq-auth"
RAW_ERROR = "RAW_FAKE_RELAY_TEXT_DO_NOT_FORWARD"
OWNED = []
LIVE_PORTS = {5180, 5181, 5182, 8765, 8791, 18080, 18081}


def wait_for(predicate, seconds=5, label="fixture condition"):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.02)
    raise AssertionError(label + " timed out")


def port():
    while True:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            value = sock.getsockname()[1]
        if value not in LIVE_PORTS:
            return value


def clean_env(home):
    # Construct rather than copy: no inherited provider, HUD, Studio, relay,
    # proxy, Node preload, CLI or credential environment can reach the hub.
    return {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C.UTF-8",
            "TMPDIR": str(home.parent), "PYTHONDONTWRITEBYTECODE": "1"}


def speech(marker, words=25):
    return " ".join(f"b{marker}w{i}" for i in range(words))


class State:
    def __init__(self):
        self.lock = threading.RLock()
        self.relays = {name: {"health": "ready", "mode": "normal", "manual": False} for name in ("a", "b")}
        self.asks, self.jobs, self.active = [], {}, set()
        self.max_active, self.auth_errors = 0, 0
        self.pcm, self.bad_pcm, self.unexpected = [], [], []
        self.texts = {}
        self.asr_gates, self.asr_entered = {}, {}
        self.health_gates, self.health_entered = {}, {}
        self.post_gates, self.post_entered = {}, {}
        self.reply_gates, self.reply_entered = {}, {}
        self.health_calls, self.reply_calls = [], []
        self.ask_event, self.health_event, self.reply_event = threading.Event(), threading.Event(), threading.Event()
        self.redirect_hits = 0
        self.replies = ["Remember to confirm the deadline.\nStatus\nApprovals history\nAllowed once · 2h ago\n", "—", "A useful note " + "x" * 450]

    def count(self, relay=None):
        with self.lock:
            return sum(relay is None or a["relay"] == relay for a in self.asks)

    def complete(self, jid):
        with self.lock:
            self.jobs[jid]["ready"] = True
            # Real Muse can finish independently of whether this client polls.
            self.active.discard(jid)

    def completed(self, jid):
        with self.lock:
            return self.jobs.get(jid, {}).get("delivered", False)

    def release_all(self):
        for event in (list(self.asr_gates.values()) + list(self.health_gates.values())
                      + list(self.post_gates.values()) + list(self.reply_gates.values())):
            event.set()
        with self.lock:
            for job in self.jobs.values():
                job["ready"] = True


class FakeServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class FakeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value, headers=None):
        data = json.dumps(value, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self, key):
        if self.headers.get("Authorization") == "Bearer " + key:
            return True
        self.server.state.auth_errors += 1
        self.reply(401, {"error": "fixture auth mismatch"})
        return False

    def do_POST(self):
        state = self.server.state
        data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/groq/audio/transcriptions":
            if not self.authorized(GROQ_KEY):
                return
            start = data.find(b"RIFF")
            wav = data[start:] if start >= 0 else b""
            valid = (len(wav) >= 46 and wav[8:16] == b"WAVEfmt " and wav[36:40] == b"data"
                     and struct.unpack_from("<HHIIHH", wav, 20) == (1, 1, 16000, 32000, 2, 16))
            size = struct.unpack_from("<I", wav, 40)[0] if valid else 0
            valid = valid and size > 0 and size % 2 == 0 and len(wav) >= 44 + size
            if not valid:
                state.bad_pcm.append(True)
                return self.reply(400, {"error": "fixture expected PCM16 mono WAV"})
            marker = struct.unpack_from("<h", wav, 44)[0]
            with state.lock:
                state.pcm.append({"marker": marker, "bytes": size})
                text = state.texts.get(marker, speech(marker))
            if marker in state.asr_gates:
                state.asr_entered[marker].set()
                state.asr_gates[marker].wait(8)
            return self.reply(200, {"text": text})
        parts = self.path.strip("/").split("/")
        if len(parts) == 2 and parts[0] in state.relays and parts[1] == "ask":
            if not self.authorized(RELAY_TOKEN):
                return
            try:
                text = json.loads(data)["text"]
            except (ValueError, KeyError, TypeError):
                return self.reply(400, {"error": "bad fixture ask"})
            name = parts[0]
            with state.lock:
                relay = state.relays[name]
                jid = f"j{len(state.asks) + 1}"
                is_g2 = "G2_FIXTURE" in text
                reply = "G2 fixture answer." if is_g2 else state.replies[min(len([a for a in state.asks if not a['g2']]), len(state.replies) - 1)]
                if relay["mode"] == "command-error":
                    reply = ""
                job = {"id": jid, "relay": name, "text": text, "reply": reply, "g2": is_g2,
                       "ready": not relay["manual"], "mode": relay["mode"], "delivered": False,
                       "accepted_t": time.monotonic()}
                state.asks.append(job)
                state.ask_event.set()
                state.jobs[jid] = job
                state.active.add(jid)
                state.max_active = max(state.max_active, len(state.active))
            if name in state.post_gates:
                state.post_entered[name].set()
                state.post_gates[name].wait(8)
            if relay["mode"] == "malformed":
                return self.reply(200, {"accepted": True})
            if relay["mode"] == "failed-post":
                return self.reply(500, {"error": RAW_ERROR})
            if relay["mode"] == "forgotten":
                with state.lock:
                    state.jobs.pop(jid)
                    state.active.discard(jid)
            return self.reply(200, {"id": jid})
        state.unexpected.append(self.path)
        self.reply(404, {"error": "fixture route unavailable"})

    def do_GET(self):
        state = self.server.state
        if self.path == "/redirect":
            return self.reply(302, {}, {"Location": f"http://127.0.0.1:{self.server.server_port}/redirect-target"})
        if self.path == "/redirect-target":
            state.redirect_hits += 1
            return self.reply(200, {"fixture": True})
        parts = self.path.strip("/").split("/")
        if parts[0] in state.relays:
            if not self.authorized(RELAY_TOKEN):
                return
            relay = state.relays[parts[0]]
            if len(parts) == 2 and parts[1] == "selftest":
                state.health_calls.append(parts[0])
                state.health_event.set()
                if parts[0] in state.health_gates:
                    state.health_entered[parts[0]].set()
                    state.health_gates[parts[0]].wait(8)
                if relay["health"] == "failed":
                    return self.reply(500, {"error": RAW_ERROR})
                with state.lock:
                    active_here = any(state.jobs[jid]["relay"] == parts[0] for jid in state.active)
                health = {"ok": True, "composer": relay["health"] == "ready" and not active_here, "busy": active_here}
                return self.reply(200, relay.get("health_fields", health))
            if len(parts) == 2 and parts[1] == "latest":
                return self.reply(200, {"question": "Legacy fixture question", "reply": self.server.polluted})
            if len(parts) == 3 and parts[1] == "reply":
                state.reply_calls.append(parts[2])
                state.reply_event.set()
                if parts[0] in state.reply_gates:
                    state.reply_entered[parts[0]].set()
                    state.reply_gates[parts[0]].wait(8)
                with state.lock:
                    job = state.jobs.get(parts[2])
                    if not job:
                        return self.reply(404, {"error": "unknown fixture reply"})
                    if job["ready"]:
                        job["delivered"] = True
                        state.active.discard(job["id"])
                        status = "error" if job["mode"] == "command-error" else "done"
                        error = "Command failed: fixture composer was not ready" if status == "error" else ""
                        return self.reply(200, {"status": status, "question": job["text"], "reply": job["reply"], "error": error})
                    return self.reply(200, {"status": "waiting", "question": job["text"], "reply": "", "error": ""})
        if self.path == "/local/v1/models":
            return self.reply(200, {"data": []})
        if self.path == "/studio":
            return self.reply(200, {"teams": []})
        state.unexpected.append(self.path)
        self.reply(404, {"error": "fixture route unavailable"})


class Fixture:
    def __init__(self, hub_script=None, **listen):
        self.options = dict(snippetMs=100, minWords=25, idleMs=30000, pollMs=20, requestMs=250, timeoutMs=1500)
        # The public hub config keeps the original timeoutMs knob. The adapter
        # calls the same whole-attempt limit attemptMs.
        if "attemptMs" in listen:
            listen["timeoutMs"] = listen.pop("attemptMs")
        self.options.update(listen)
        self.process = None
        self.state = State()
        self.stack = contextlib.ExitStack()
        self.forced = False
        self.hub_script = str(hub_script or HERE / "hud-server.mjs")

    def __enter__(self):
        self.temp = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="hub-listen-"))
        self.root = Path(self.temp)
        self.home = self.root / "home"
        (self.home / ".config" / "agent-glasses").mkdir(parents=True)
        self.guard_log = self.root / "guard.jsonl"
        self.server = FakeServer(("127.0.0.1", 0), FakeHandler)
        self.server.state = self.state
        self.server.polluted = (HERE / "fixtures" / "muse-polluted.txt").read_text()
        self.fake_port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.hub_port = port()
        self.env = clean_env(self.home)
        relay_token, hub_token = self.root / "relay.token", self.root / "hub.token"
        for filename, value in ((relay_token, RELAY_TOKEN), (hub_token, HUB_TOKEN)):
            filename.write_text(value + "\n")
            filename.chmod(0o600)
        config = self.root / "hub.json"
        config.write_text(json.dumps({"nodes": [], "peers": [], "listen": self.options,
            "muse": [{"name": "fake-" + name, "url": f"http://127.0.0.1:{self.fake_port}/{name}",
                      "tokenFile": str(relay_token)} for name in ("a", "b")]}))
        self.env.update(HUD_TOKEN_FILE=str(hub_token), HUD_HUB_CONFIG=str(config),
                        HUD_TRANSCRIBE_URL=f"http://127.0.0.1:{self.fake_port}/groq/audio/transcriptions",
                        GROQ_API_KEY=GROQ_KEY, HUD_CLAUDE_BIN=str(self.root / "missing-claude"),
                        HUD_CODEX_BIN=str(self.root / "missing-codex"),
                        HUD_LOCAL_LLM_URL=f"http://127.0.0.1:{self.fake_port}/local/v1",
                        STUDIO_URL=f"http://127.0.0.1:{self.fake_port}/studio",
                        LISTEN_TEST_ALLOW_PORTS=f"{self.fake_port},{self.hub_port}",
                        LISTEN_TEST_GUARD_LOG=str(self.guard_log))
        self.log = self.stack.enter_context((self.root / "hub.log").open("w+"))
        self.machine = "Listen Fixture " + self.root.name
        try:
            self.process = subprocess.Popen([NODE, "--import", str(GUARD), self.hub_script,
                                             "--mode", "hub", "--host", "127.0.0.1", "--port", str(self.hub_port),
                                             "--machine", self.machine], env=self.env, cwd=self.root,
                                            stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT,
                                            start_new_session=True)
            OWNED.append(self)
            def ready():
                if self.process.poll() is not None:
                    raise AssertionError("fixture hub exited before readiness")
                try:
                    code, body = self.call("GET", "/api/health", token=None)
                    return code == 200 and body.get("machine") == self.machine
                except OSError:
                    return False
            wait_for(ready, label="fixture hub readiness")
            return self
        except BaseException:
            try:
                self.close()
            finally:
                self.stack.close()
            raise

    def call(self, method, route, body=None, raw=None, token=HUB_TOKEN, timeout=3):
        connection = http.client.HTTPConnection("127.0.0.1", self.hub_port, timeout=timeout)
        headers = {"Authorization": "Bearer " + token} if token is not None else {}
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        elif raw is not None:
            headers["Content-Type"] = "application/octet-stream"
        try:
            connection.request(method, route, data, headers)
            response = connection.getresponse()
            value = json.loads(response.read())
            return response.status, value
        finally:
            connection.close()

    def start(self):
        code, body = self.call("POST", "/api/listen/start", {"backend": "muse"})
        if code != 200:
            raise AssertionError(f"listen start returned HTTP {code}")
        self.session = body
        return body

    def view(self, since=None):
        query = {"id": self.session["id"]}
        if since is not None:
            query["since"] = since
        code, body = self.call("GET", "/api/listen?" + urlencode(query))
        if code != 200:
            raise AssertionError(f"listen view returned HTTP {code}")
        return body

    def chunk(self, seq, marker=None, milliseconds=100):
        marker = seq + 1 if marker is None else marker
        pcm = struct.pack("<h", marker) * (milliseconds * 16)
        return self.call("POST", "/api/listen/chunk?" + urlencode({"id": self.session["id"], "seq": seq}), raw=pcm, timeout=10)

    def stop(self):
        return self.call("POST", "/api/listen/stop", {"id": self.session["id"]})

    def close(self):
        self.state.release_all()
        if self.process is not None and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.forced = True
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=2)
        if hasattr(self, "server"):
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
        if self in OWNED:
            OWNED.remove(self)

    def __exit__(self, kind, value, traceback):
        try:
            self.close()
            if kind is None:
                if self.forced:
                    raise AssertionError("fixture hub required forced teardown")
                if self.guard_log.exists() and self.guard_log.read_text().strip():
                    raise AssertionError("hub attempted a nonfixture network destination or child command")
                if self.state.auth_errors or self.state.bad_pcm or self.state.unexpected:
                    raise AssertionError("fake HTTP contract or authorization was violated")
        finally:
            self.stack.close()


class GuardTests(unittest.TestCase):
    def test_g2_function_and_muse_routes_match_selected_baseline_exactly(self):
        with tempfile.TemporaryDirectory(prefix="listen-baseline-") as temp:
            baseline = subprocess.run(["git", "-C", str(HERE.parent), "show", "56fe3b2:glasses/hud-server.mjs"],
                                      env=clean_env(Path(temp)), cwd=temp, capture_output=True, text=True, timeout=5)
        self.assertEqual(baseline.returncode, 0, "selected G2 baseline must be available")
        current = (HERE / "hud-server.mjs").read_text()
        def blocks(source):
            start = source.index("async function askMuse(")
            end = source.index("// Glasses id", start)
            routes = source.index("    if (req.method === 'POST' && p === '/api/muse/ask')")
            route_end = source.index("    if (req.method === 'GET' && p === '/api/layout')", routes)
            return source[start:end], source[routes:route_end]
        self.assertTrue(blocks(current) == blocks(baseline.stdout), "G2 askMuse and Muse route bodies must remain exactly56fe3b2")

    def test_guard_blocks_remote_live_ports_named_child_imports_and_redirects(self):
        with Fixture() as f:
            script = """
import childProcess, {execFile,ChildProcess} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
// Independent backstops keep this guard self-test fake-only even if a guard
// regression occurs. A backstop error does not count as a successful denial.
const fixture=`http://127.0.0.1:${process.env.TEST_FIXTURE_PORT}`;
const realFetch=globalThis.fetch, realConnect=net.Socket.prototype.connect;
globalThis.fetch=(url,options)=>{
  if(!String(url).startsWith(fixture+'/')) throw Error('fixture backstop');
  return realFetch(url,options);
};
http.get=http.request=()=>{throw Error('fixture backstop')};
childProcess.execFile=()=>{throw Error('fixture backstop')};
ChildProcess.prototype.spawn=()=>{throw Error('fixture backstop')};
net.Socket.prototype.connect=function(...args){
  const first=Array.isArray(args[0])?args[0][0]:args[0];
  if(!first||typeof first!=='object'||Number(first.port)!==Number(process.env.TEST_FIXTURE_PORT)) throw Error('fixture backstop');
  return Reflect.apply(realConnect,this,args);
};
await import(process.env.TEST_GUARD_MODULE);
let denied=0;
for (const action of [()=>fetch('https://provider.invalid'),
  ()=>fetch('http://127.0.0.1:18081/v1/models'),
  ()=>http.get('http://127.0.0.1:8765/api/studio'),
  ()=>http.request({hostname:'127.0.0.1',port:Number(process.env.TEST_FIXTURE_PORT),createConnection(){throw Error('escape')}}),
  ()=>execFile('/not-a-fixture-command',[]),
  ()=>http.request(fixture+'/probe',{hostname:'provider.invalid'}),
  ()=>new net.Socket().connect(8765,'127.0.0.1'),
  ()=>fetch(fixture+'/probe',{dispatcher:{dispatch(){throw Error('escape')}}}),
  ()=>new ChildProcess().spawn({file:'/not-a-fixture-command',args:[]})]) {
  try { await action(); } catch(error) { if(error.message.startsWith('Listen fixture guard blocked ')) denied++; }
}
let redirectBlocked=false;
try { await fetch(fixture+'/redirect'); } catch { redirectBlocked=true; }
process.stdout.write(JSON.stringify({denied,redirectBlocked}));
"""
            env = dict(f.env, TEST_FIXTURE_PORT=str(f.fake_port), TEST_GUARD_MODULE=GUARD.as_uri(),
                       LISTEN_TEST_GUARD_LOG=str(f.root / "guard-selftest.jsonl"))
            result = subprocess.run([NODE, "--input-type=module", "-e", script],
                                    env=env, cwd=f.root, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, "guard self-test failed")
            self.assertEqual(json.loads(result.stdout), {"denied": 9, "redirectBlocked": True})
            self.assertEqual(f.state.redirect_hits, 0)

    def test_interrupted_fixture_reaps_hub_and_removes_private_home(self):
        fixture = Fixture()
        with self.assertRaisesRegex(RuntimeError, "controlled interruption"):
            with fixture:
                raise RuntimeError("controlled interruption")
        self.assertIsNotNone(fixture.process.returncode)
        self.assertFalse(fixture.root.exists())

    def test_failed_startup_reaps_child_and_removes_private_home(self):
        with tempfile.TemporaryDirectory(prefix="listen-startup-") as temp:
            script = Path(temp) / "exit.mjs"
            script.write_text("process.exit(7)\n")
            fixture = Fixture(hub_script=script)
            with self.assertRaisesRegex(AssertionError, "exited before readiness"):
                with fixture:
                    pass
            self.assertIsNotNone(fixture.process.returncode)
            self.assertFalse(fixture.root.exists())


class ListenTests(unittest.TestCase):
    def assert_no_more_requests(self, f, event_name, counter, seconds=.25):
        before = counter()
        event = getattr(f.state, event_name)
        event.clear()
        self.assertFalse(event.wait(seconds), "dropped Listen work must not keep sending or polling")
        self.assertEqual(counter(), before)

    def assert_g2_works(self, f, label):
        before = f.state.count()
        code, receipt = f.call("POST", "/api/muse/ask", {"text": "G2_FIXTURE " + label})
        self.assertEqual(code, 200)
        self.assertRegex(receipt["id"], r"^0-j\d+$")
        self.assertEqual(receipt["muse"], "fake-a")
        route = "/api/muse/reply?id=" + quote(receipt["id"])
        done = wait_for(lambda: (r if (r := f.call("GET", route)[1]).get("status") == "done" else None))
        self.assertEqual(done["reply"], "G2 fixture answer.")
        self.assertEqual(f.state.count(), before + 1)
        self.assertTrue(f.state.asks[-1]["g2"])
        self.assertEqual(f.state.asks[-1]["relay"], "a")

    def diag(self, f, name, detail):
        self.assertEqual(f.call("POST", "/api/diag", {"name": name, "detail": detail}), (200, {"ok": True}))

    def test_diagnostic_g2_gate_defers_and_merges_speech_then_asks_last_once(self):
        with Fixture(snippetMs=300) as f:
            self.diag(f, "muse.ask", "queued")
            f.start()
            f.chunk(0)
            f.chunk(1)
            wait_for(lambda: f.view()["muse"]["state"] == "busy")
            self.assert_no_more_requests(f, "ask_event", f.state.count, seconds=.15)
            self.assertEqual(f.state.count(), 0)
            self.diag(f, "muse.reply", "done")
            wait_for(lambda: f.state.count() == 1, label="merged busy speech after G2 done")
            wait_for(lambda: len(f.view()["notes"]) == 1)
            self.assertEqual(f.state.asks[0]["relay"], "b")
            self.assertTrue(all(speech(i) in f.state.asks[0]["text"] for i in (1, 2)))
            self.assert_no_more_requests(f, "ask_event", f.state.count)
            f.stop()

    def test_direct_g2_health_veto_defers_listen_without_client_diagnostics(self):
        with Fixture(snippetMs=300) as f:
            f.state.relays["a"]["manual"] = True
            code, receipt = f.call("POST", "/api/muse/ask", {"text": "G2_FIXTURE direct busy relay"})
            self.assertEqual(code, 200)
            self.assertRegex(receipt["id"], r"^0-j\d+$")
            f.start()
            f.chunk(0)
            wait_for(lambda: f.view()["muse"]["state"] == "busy")
            self.assert_no_more_requests(f, "ask_event", f.state.count, seconds=.15)
            self.assertEqual(f.state.count("b"), 0)
            f.state.complete(f.state.asks[0]["id"])
            route = "/api/muse/reply?id=" + quote(receipt["id"])
            self.assertEqual(f.call("GET", route)[1]["status"], "done")
            wait_for(lambda: f.state.count("b") == 1, label="Listen after direct G2 terminal")
            wait_for(lambda: len(f.view()["notes"]) == 1)
            self.assertEqual(f.state.max_active, 1)
            self.assertEqual([a["relay"] for a in f.state.asks], ["a", "b"])
            f.stop()

    def test_g2_becoming_busy_during_last_relay_health_vetoes_listen_post(self):
        with Fixture(snippetMs=300, requestMs=1000) as f:
            f.state.health_gates["b"] = threading.Event()
            f.state.health_entered["b"] = threading.Event()
            f.start()
            f.chunk(0)
            self.assertTrue(f.state.health_entered["b"].wait(3))
            f.state.relays["a"]["manual"] = True
            code, receipt = f.call("POST", "/api/muse/ask", {"text": "G2_FIXTURE health race"})
            self.assertEqual(code, 200)
            self.assertRegex(receipt["id"], r"^0-j\d+$")
            f.state.health_gates["b"].set()
            wait_for(lambda: f.view()["muse"]["state"] == "busy")
            self.assert_no_more_requests(f, "ask_event", f.state.count, seconds=.15)
            self.assertEqual(f.state.count("b"), 0)
            f.stop()

    def test_diagnostic_gate_is_rechecked_after_last_relay_health(self):
        with Fixture(snippetMs=300, requestMs=1000) as f:
            f.state.health_gates["b"] = threading.Event()
            f.state.health_entered["b"] = threading.Event()
            f.start()
            f.chunk(0)
            self.assertTrue(f.state.health_entered["b"].wait(3))
            self.diag(f, "muse.ask", "queued")
            f.state.health_gates["b"].set()
            wait_for(lambda: f.view()["muse"]["state"] == "busy")
            self.assert_no_more_requests(f, "ask_event", f.state.count, seconds=.15)
            self.assertEqual(f.state.count(), 0)
            self.diag(f, "muse.reply", "done")
            wait_for(lambda: len(f.view()["notes"]) == 1, label="retained speech after diagnostic gate clears")
            self.assertEqual(f.state.count(), 1)
            self.assertEqual(f.state.asks[0]["relay"], "b")
            f.stop()

    def test_hung_health_has_request_and_whole_attempt_deadlines_without_late_post(self):
        for request_ms, attempt_ms in ((70, 1500), (1000, 120)):
            with self.subTest(request_ms=request_ms, attempt_ms=attempt_ms), Fixture(requestMs=request_ms, attemptMs=attempt_ms) as f:
                f.state.health_gates["a"] = threading.Event()
                f.state.health_entered["a"] = threading.Event()
                f.start()
                before = time.monotonic()
                f.chunk(0)
                self.assertTrue(f.state.health_entered["a"].wait(3))
                wait_for(lambda: f.view()["muse"]["state"] == "unavailable", seconds=.8, label="bounded hung selftest")
                self.assertLess(time.monotonic() - before, .8)
                self.assertEqual(f.state.count(), 0)
                f.state.health_gates["a"].set()
                self.assert_no_more_requests(f, "ask_event", f.state.count)
                f.stop()
                self.assert_g2_works(f, "after hung health")

    def test_hung_accepted_post_times_out_without_retry_then_later_g2_works(self):
        with Fixture(requestMs=70, attemptMs=500) as f:
            f.state.post_gates["b"] = threading.Event()
            f.state.post_entered["b"] = threading.Event()
            f.state.relays["b"]["manual"] = True
            f.start()
            before = time.monotonic()
            f.chunk(0)
            self.assertTrue(f.state.post_entered["b"].wait(3))
            wait_for(lambda: f.view()["muse"]["state"] == "unavailable", seconds=.8, label="bounded hung POST")
            self.assertLess(time.monotonic() - before, .8)
            self.assertEqual(f.state.count(), 1)
            self.assertEqual(f.state.count("a"), 0)
            f.state.post_gates["b"].set()
            self.assert_no_more_requests(f, "reply_event", lambda: len(f.state.reply_calls))
            self.assert_no_more_requests(f, "ask_event", f.state.count)
            f.state.complete(f.state.asks[0]["id"])
            f.stop()
            self.assertEqual(f.view()["notes"], [])
            self.assert_g2_works(f, "after hung accepted POST")

    def test_hung_reply_times_out_and_stops_polling_without_late_note(self):
        with Fixture(requestMs=70, attemptMs=500) as f:
            f.state.reply_gates["b"] = threading.Event()
            f.state.reply_entered["b"] = threading.Event()
            f.start()
            before = time.monotonic()
            f.chunk(0)
            self.assertTrue(f.state.reply_entered["b"].wait(3))
            wait_for(lambda: f.view()["muse"]["state"] == "unavailable", seconds=.8, label="bounded hung reply")
            self.assertLess(time.monotonic() - before, .8)
            f.state.reply_gates["b"].set()
            self.assert_no_more_requests(f, "reply_event", lambda: len(f.state.reply_calls))
            self.assertEqual(f.state.count(), 1)
            self.assertEqual(f.view()["notes"], [])
            f.state.complete(f.state.asks[0]["id"])
            f.stop()
            self.assert_g2_works(f, "after hung reply")

    def test_forever_404_reply_is_bounded_and_later_g2_works(self):
        with Fixture(requestMs=70, attemptMs=200) as f:
            f.state.relays["b"]["mode"] = "forgotten"
            f.start()
            before = time.monotonic()
            f.chunk(0)
            wait_for(lambda: len(f.state.reply_calls) >= 1)
            wait_for(lambda: f.view()["muse"]["state"] == "unavailable", seconds=.8, label="bounded missing job")
            self.assertLess(time.monotonic() - before, .8)
            self.assert_no_more_requests(f, "reply_event", lambda: len(f.state.reply_calls))
            self.assert_no_more_requests(f, "ask_event", f.state.count)
            self.assertEqual(f.state.count(), 1)
            self.assertEqual(f.state.count("a"), 0)
            self.assertEqual(f.view()["notes"], [])
            f.stop()
            self.assert_g2_works(f, "after forgotten Listen job")

    def test_waiting_reply_keeps_polling_only_until_whole_attempt_deadline(self):
        with Fixture(requestMs=100, attemptMs=220) as f:
            f.state.relays["b"]["manual"] = True
            f.start()
            before = time.monotonic()
            f.chunk(0)
            wait_for(lambda: len(f.state.reply_calls) >= 2, seconds=.8, label="actual waiting relay status")
            wait_for(lambda: f.view()["muse"]["state"] == "unavailable", seconds=.8, label="whole waiting deadline")
            self.assertLess(time.monotonic() - before, .8)
            self.assert_no_more_requests(f, "reply_event", lambda: len(f.state.reply_calls))
            self.assertEqual(f.state.count(), 1)
            f.state.complete(f.state.asks[0]["id"])
            self.assertEqual(f.view()["notes"], [])
            f.stop()
            self.assert_g2_works(f, "after waiting deadline")

    def test_three_pcm_snippets_produce_two_clean_capped_notes_on_one_clock(self):
        with Fixture() as f:
            started = f.start()
            self.assertIsInstance(started.get("id"), str)
            self.assertIsInstance(started.get("startedAt"), int)
            for seq in range(3):
                code, body = f.chunk(seq)
                self.assertEqual(code, 200)
                self.assertEqual(body.get("lines", [{}])[0].get("text"), speech(seq + 1))
                wait_for(lambda: f.state.count() == seq + 1, label="snippet admission")
                expected = 1 if seq < 2 else 2
                wait_for(lambda: len(f.view().get("notes", [])) == expected, label="useful Muse notes")
                wait_for(lambda: f.state.completed(f.state.asks[seq]["id"]), label="snippet terminal reply")
            view = f.view()
            self.assertEqual(len(view["lines"]), 3)
            self.assertEqual(len(view["notes"]), 2)
            self.assertEqual(view["notes"][0]["text"], "Remember to confirm the deadline.")
            self.assertTrue(all(n["text"] != "—" and len(n["text"]) <= 300 for n in view["notes"]))
            self.assertTrue(all(0 <= n["at_t"] <= n["t"] <= view["now_t"] for n in view["notes"]))
            self.assertTrue(all(0 <= line["t"] <= view["now_t"] for line in view["lines"]))
            self.assertEqual(f.view(0)["lines"], view["lines"])
            self.assertTrue(all(speech(i) in f.state.asks[2]["text"] for i in (1, 2, 3)))
            self.assertEqual([a["relay"] for a in f.state.asks], ["b"] * 3)
            self.assertGreaterEqual(f.state.health_calls.count("a"), 6)
            self.assertEqual(f.state.max_active, 1)
            self.assertEqual(f.stop(), (200, {"ok": True}))

    def test_delayed_transcript_since_uses_publication_not_spoken_line_time(self):
        with Fixture(minWords=100) as f:
            f.state.asr_gates[1] = threading.Event()
            f.state.asr_entered[1] = threading.Event()
            f.start()
            result = []
            thread = threading.Thread(target=lambda: result.append(f.chunk(0, milliseconds=1000)))
            thread.start()
            try:
                self.assertTrue(f.state.asr_entered[1].wait(3))
                snapshot = wait_for(lambda: (v if (v := f.view())["now_t"] > 40 else None))
                cutoff = snapshot["now_t"]
                f.state.asr_gates[1].set()
                thread.join(timeout=4)
                self.assertFalse(thread.is_alive())
                self.assertEqual(result[0][0], 200)
                late = f.view(cutoff)
                self.assertEqual(late["lines"][0]["text"], speech(1))
                self.assertLess(late["lines"][0]["t"], cutoff)
                later = wait_for(lambda: (v if (v := f.view())["now_t"] > late["now_t"] + 30 else None))
                self.assertEqual(f.view(later["now_t"])["lines"], [])
            finally:
                f.state.asr_gates[1].set()
                thread.join(timeout=4)

    def test_stop_app_close_path_cancels_pending_snippets_and_late_note(self):
        with Fixture() as f:
            f.state.relays["b"]["manual"] = True
            f.start()
            f.chunk(0)
            wait_for(lambda: f.state.count() == 1)
            first = f.state.asks[0]["id"]
            f.chunk(1)
            self.assertEqual(f.stop(), (200, {"ok": True}))
            f.state.complete(first)
            self.assert_no_more_requests(f, "reply_event", lambda: len(f.state.reply_calls))
            self.assertEqual(f.view()["state"], "stopped")
            self.assertEqual(f.view()["notes"], [])
            self.assertEqual(f.state.count(), 1)
            self.assertNotEqual(f.chunk(2)[0], 200)

    def test_stop_during_health_probe_posts_no_listen_ask_and_g2_still_works(self):
        with Fixture() as f:
            f.state.health_gates["a"] = threading.Event()
            f.state.health_entered["a"] = threading.Event()
            f.start()
            f.chunk(0)
            self.assertTrue(f.state.health_entered["a"].wait(3))
            self.assertEqual(f.state.count(), 0)
            self.assertEqual(f.stop(), (200, {"ok": True}))
            f.state.health_gates["a"].set()
            code, receipt = f.call("POST", "/api/muse/ask", {"text": "G2_FIXTURE after stopped health probe"})
            self.assertEqual(code, 200)
            self.assertRegex(receipt["id"], r"^0-j\d+$")
            route = "/api/muse/reply?id=" + quote(receipt["id"])
            done = wait_for(lambda: (r if (r := f.call("GET", route)[1]).get("status") == "done" else None))
            self.assertEqual(done["reply"], "G2 fixture answer.")
            self.assertEqual(f.state.count(), 1)
            self.assertTrue(f.state.asks[0]["g2"])
            self.assertEqual(f.view()["notes"], [])

    def test_timeout_then_stop_during_health_posts_no_listen_ask_and_g2_works(self):
        with Fixture(attemptMs=120, requestMs=1000) as f:
            f.state.health_gates["a"] = threading.Event()
            f.state.health_entered["a"] = threading.Event()
            f.start()
            f.chunk(0)
            self.assertTrue(f.state.health_entered["a"].wait(3))
            wait_for(lambda: f.view()["muse"]["state"] == "unavailable", label="Listen caller timeout")
            self.assertEqual(f.state.count(), 0)
            self.assertEqual(f.stop(), (200, {"ok": True}))
            f.state.health_gates["a"].set()
            code, receipt = f.call("POST", "/api/muse/ask", {"text": "G2_FIXTURE after timed out health probe"})
            self.assertEqual(code, 200)
            self.assertRegex(receipt["id"], r"^0-j\d+$")
            route = "/api/muse/reply?id=" + quote(receipt["id"])
            done = wait_for(lambda: (r if (r := f.call("GET", route)[1]).get("status") == "done" else None))
            self.assertEqual(done["reply"], "G2 fixture answer.")
            self.assertEqual(f.state.count(), 1)
            self.assertTrue(f.state.asks[0]["g2"])
            self.assertEqual(f.view()["state"], "stopped")
            self.assertEqual(f.view()["notes"], [])

    def test_inactivity_is_reset_by_speech_and_not_by_state_polls(self):
        with Fixture(idleMs=250) as f:
            f.state.texts = {i: "short speech" for i in (1, 2, 3)}
            f.start()
            for seq in range(3):
                f.chunk(seq)
                wait_for(lambda: f.view()["now_t"] >= (seq + 1) * 100)
                self.assertEqual(f.view()["state"], "listening")
            wait_for(lambda: f.view()["state"] == "stopped", seconds=3, label="speech inactivity stop")
            self.assertEqual(f.state.count(), 0)

    def test_failed_or_unready_selftest_never_posts_an_ask(self):
        for health in ("failed", "unready"):
            with self.subTest(health=health), Fixture() as f:
                for relay in f.state.relays.values(): relay["health"] = health
                f.start()
                f.chunk(0)
                wait_for(lambda: f.view()["muse"]["state"] in ("busy", "unavailable"), label="safe dropped state")
                self.assertEqual(f.state.count(), 0)
                self.assert_no_more_requests(f, "ask_event", f.state.count)
                self.assertNotIn(RAW_ERROR, json.dumps(f.view()))
                f.stop()

    def test_strict_health_fields_on_each_relay_prevent_listen_posts(self):
        values = ({"ok": True, "composer": True}, {"ok": True, "busy": False},
                  {"composer": True, "busy": False}, {"ok": True, "composer": True, "busy": True},
                  {"ok": True, "composer": "true", "busy": False}, {"ok": True, "composer": True, "busy": "false"},
                  {"ok": True, "composer": False, "busy": False})
        for name in ("a", "b"):
            for value in values:
                with self.subTest(relay=name, fields=value), Fixture(snippetMs=300) as f:
                    f.state.relays[name]["health_fields"] = value
                    f.start()
                    f.chunk(0)
                    wait_for(lambda: f.view()["muse"]["state"] in ("busy", "unavailable"), label="strict health refusal")
                    self.assertEqual(f.state.count(), 0)
                    self.assert_no_more_requests(f, "ask_event", f.state.count, seconds=.12)
                    # Busy speech may be retried on the snippet cadence; it
                    # must never be POSTed while either relay lacks evidence.
                    f.stop()

    def test_uncertain_post_is_dropped_without_retry_or_fallback(self):
        for mode in ("malformed", "failed-post"):
            with self.subTest(mode=mode), Fixture(attemptMs=200) as f:
                f.state.relays["b"].update(mode=mode, manual=True)
                f.start()
                f.chunk(0)
                wait_for(lambda: f.state.count() == 1)
                wait_for(lambda: f.view()["muse"]["state"] == "unavailable")
                self.assert_no_more_requests(f, "ask_event", f.state.count)
                self.assertEqual(f.state.count(), 1)
                self.assertEqual(f.state.count("a"), 0)
                self.assertNotIn(RAW_ERROR, json.dumps(f.view()))
                self.assertEqual(f.state.max_active, 1)
                # An uncertain attempt drops; it must not permanently poison
                # the adapter after independent relay readiness is restored.
                f.state.complete(f.state.asks[0]["id"])
                f.state.relays["b"].update(mode="normal", manual=False)
                self.assert_g2_works(f, "after uncertain Listen admission")
                f.state.replies = ["Fresh useful note."]
                f.chunk(1)
                wait_for(lambda: len(f.view()["notes"]) == 1, label="fresh attempt after uncertainty")
                self.assertEqual(f.state.count(), 3)
                f.stop()

    def test_legacy_muse_latest_and_command_failed_fallback_are_preserved(self):
        with Fixture() as f:
            code, latest = f.call("GET", "/api/muse")
            self.assertEqual(code, 200)
            self.assertEqual(latest["question"], "Legacy fixture question")
            self.assertNotIn("Approvals history", latest["reply"])
            self.assertEqual(f.state.count(), 0)
            f.state.relays["a"]["mode"] = "command-error"
            code, receipt = f.call("POST", "/api/muse/ask", {"text": "G2_FIXTURE fallback question"})
            self.assertEqual(code, 200)
            self.assertRegex(receipt["id"], r"^0-j\d+$")
            self.assertEqual(receipt["muse"], "fake-a")
            route = "/api/muse/reply?id=" + quote(receipt["id"])
            done = wait_for(lambda: (r if (r := f.call("GET", route)[1]).get("status") == "done" else None), seconds=6)
            self.assertEqual(done["reply"], "G2 fixture answer.")
            self.assertEqual([a["relay"] for a in f.state.asks], ["a", "b"])
            self.assertEqual(f.state.max_active, 1)

    def test_listen_authorization_bad_id_and_duplicate_sequence(self):
        with Fixture() as f:
            self.assertEqual(f.call("POST", "/api/listen/start", {}, token=None)[0], 401)
            f.start()
            self.assertEqual(f.call("POST", "/api/listen/start", {})[0], 409)
            self.assertEqual(f.call("GET", "/api/listen?id=not-the-session")[0], 404)
            first = f.chunk(0)
            self.assertEqual(first[0], 200)
            self.assertEqual(f.chunk(0), first)
            self.assertEqual(len(f.state.pcm), 1)
            self.assertEqual(f.call("POST", "/api/listen/chunk?" + urlencode({"id": f.session["id"], "seq": -1}), raw=b"\0\0")[0], 400)
            f.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--guard-only", action="store_true")
    args = parser.parse_args()
    if not NODE:
        parser.error("node is required")
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, interrupted)
    def deadline(signum, frame):
        raise TimeoutError("Listen HTTP fixture exceeded its 90 second owner deadline")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(90)
    suite = unittest.TestSuite()
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(GuardTests))
    if not args.guard_only:
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(ListenTests))
    try:
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1
    finally:
        signal.alarm(0)
        for fixture in list(OWNED):
            try: fixture.close()
            finally: fixture.stack.close()


if __name__ == "__main__":
    sys.exit(main())
