#!/usr/bin/env python3
"""Live-page HTTP proof: isolated real hub, fake ASR/relay, deny-by-default network guard."""
import datetime
import http.client
import importlib.util
import json
import re
from pathlib import Path
import signal
import socket
import subprocess
import os
import sys
import tempfile
import unittest
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("listen_http_fixture", HERE / "test-hub-listen.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def request(fixture, method, route, body=None, headers=None, token=False):
    conn = http.client.HTTPConnection("127.0.0.1", fixture.hub_port, timeout=5)
    headers = dict(headers or {})
    if token:
        headers["Authorization"] = "Bearer " + base.HUB_TOKEN
    try:
        conn.request(method, route, body=body, headers=headers)
        response = conn.getresponse()
        return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read().decode()
    finally:
        conn.close()


class DefaultPageFixture(base.Fixture):
    def __init__(self, **options):
        super().__init__(fake_clock=True, **options)
        self.options.pop("notesFrom", None)  # Test the actual production default.


RAW_OWNED = []

class RawPageFixture:
    """Real Node parser + production page handler, fake engine read/write counters."""
    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="listen-page-raw-")
        self.root = Path(self.temp.name)
        self.home = self.root / "home"; self.home.mkdir()
        self.port = base.port()
        self.guard = self.root / "guard.jsonl"
        source = self.root / "raw-page.mjs"
        source.write_text("import http from 'node:http';\nimport {createListenPage} from " + json.dumps((base.HERE / "listen-page.mjs").as_uri()) + ";\n" + r"""
let reads=0,writes=0,notes=[];
const text='PRIVATE_FIXTURE_TRANSCRIPT_NEVER_LEAK';
const engine={snapshot(){reads++;return {status:200,body:{id:'raw-fixture-session',startedAt:1700000000000,now_t:20000,state:'listening',notesFrom:'page',lines:[{t:0,text}],notes,muse:{state:'idle'}}};},addNote(id,value){writes++;const note={t:1,at_t:0,text:value.text};notes.push(note);return {status:200,body:{note}};}};
const handler=createListenPage({listen:engine});
http.createServer(async(req,res)=>{
 if(req.url==='/fixture/counts'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({reads,writes,notes}));return;}
 if(req.url==='/fixture/reset'){reads=0;writes=0;notes=[];res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
 try{if(!await handler(req,res,new URL(req.url,'http://fixture.invalid').pathname)){res.writeHead(404);res.end();}}
 catch{res.writeHead(500);res.end('fixture error');}
}).listen(Number(process.argv[2]),'127.0.0.1');
""")
        self.log = (self.root / "node.log").open("w")
        env = base.clean_env(self.home)
        env.update(LISTEN_TEST_ALLOW_PORTS=str(self.port), LISTEN_TEST_GUARD_LOG=str(self.guard))
        self.process = subprocess.Popen([base.NODE, "--import", str(base.GUARD), str(source), str(self.port)], env=env,
                                        cwd=self.root, stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        RAW_OWNED.append(self)
        try:
            def ready():
                if self.process.poll() is not None: raise AssertionError("raw fixture exited")
                try: return self.control("counts") == {"reads": 0, "writes": 0, "notes": []}
                except OSError: return False
            base.wait_for(ready, label="raw page fixture")
            return self
        except BaseException:
            self.close(); raise

    def control(self, kind):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            conn.request("GET", "/fixture/" + kind)
            response = conn.getresponse()
            assert response.status == 200
            return json.loads(response.read())
        finally: conn.close()

    def raw(self, method, route, headers, body=b""):
        # A list of header tuples preserves duplicates, casing and empty values
        # through the real Node HTTP parser. No dict-normalized substitute.
        fields = list(headers) + [("Connection", "close"), ("Content-Type", "application/json"), ("Content-Length", str(len(body)))]
        wire = (method + " " + route + " HTTP/1.1\r\n" + "".join(key + ": " + value + "\r\n" for key, value in fields) + "\r\n").encode("ascii") + body
        with socket.create_connection(("127.0.0.1", self.port), timeout=3) as sock:
            sock.sendall(wire)
            response = http.client.HTTPResponse(sock); response.begin()
            return response.status, response.read(65536).decode("utf-8", "replace")

    def close(self):
        if getattr(self, "process", None) is not None and self.process.poll() is None:
            try: os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL); self.process.wait(timeout=2)
        if getattr(self, "log", None): self.log.close()
        if self in RAW_OWNED: RAW_OWNED.remove(self)
        if getattr(self, "temp", None): self.temp.cleanup()

    def __exit__(self, kind, value, traceback):
        try:
            if kind is None and self.guard.exists():
                assert not self.guard.read_text().strip(), "raw fixture attempted forbidden effects"
        finally: self.close()


class LivePageTests(unittest.TestCase):
    def test_default_page_no_token_timestamps_refresh_and_zero_relay_calls(self):
        with DefaultPageFixture() as f:
            f.start()
            f.advance_clock(5000)
            self.assertEqual(f.chunk(0, marker=17, milliseconds=5000)[0], 200)
            view = f.view()
            code, headers, text = request(f, "GET", "/listen/live.txt")
            self.assertEqual(code, 200)
            self.assertIn("text/plain", headers["content-type"])
            self.assertIn("default-src 'none'", headers.get("content-security-policy", ""))
            self.assertIn(f.session["id"], text)
            self.assertIn("live", text.lower())
            line = view["lines"][0]
            wall = datetime.datetime.fromtimestamp((f.session["startedAt"] + line["t"]) / 1000).strftime("%Y-%m-%d %H:%M:%S")
            seconds = line["t"] // 1000
            stamp = f"{seconds // 60:02}:{seconds % 60:02}"
            self.assertIn(f"[{wall}] [{stamp}] {line['text']}", text)
            code, headers, page = request(f, "GET", "/listen/live.html")
            self.assertEqual(code, 200)
            self.assertIn("text/html", headers["content-type"])
            csp = headers.get("content-security-policy", "")
            self.assertIn("default-src 'none'", csp)
            script_policy = re.search(r"(?:^|;)\s*script-src\s+([^;]+)", csp)
            self.assertIsNotNone(script_policy)
            self.assertNotIn("'unsafe-inline'", script_policy.group(1))
            scripts = re.findall(r"<script\b([^>]*)>", page, re.I)
            for attributes in scripts:
                nonce = re.search(r'nonce=["\']([^"\']+)["\']', attributes)
                self.assertIsNotNone(nonce)
                self.assertIn("'nonce-" + nonce.group(1) + "'", script_policy.group(1))
            self.assertRegex(page, r'(?is)http-equiv=["\']refresh["\'][^>]*content=["\']2["\']')
            self.assertIn('action="/listen/note"', page)
            self.assertIn('name="note"', page)
            self.assertIn('name="about"', page)
            f.advance_clock(60000)
            # Allow the real short snippet timer to fire under the fixture clock.
            base.wait_for(lambda: f.view()["muse"]["state"] == "idle")
            self.assertEqual(f.state.count(), 0)
            self.assertEqual(f.state.health_calls, [])
            self.assertEqual(f.state.reply_calls, [])
            f.stop()
            self.assertNotIn(line["text"], Path(f.log.name).read_text())

    def test_json_note_is_sanitized_anchored_and_visible_via_existing_listen_api(self):
        with base.Fixture(notesFrom="page", fake_clock=True) as f:
            f.start(); f.advance_clock(5000); self.assertEqual(f.chunk(0, marker=22)[0], 200)
            f.advance_clock(5000)
            value = {"text": "Confirm the deadline.\nStatus\nApprovals history\nAllowed once · 2h ago\n", "about": "00:03"}
            code, headers, raw = request(f, "POST", "/listen/note", json.dumps(value), {"Content-Type": "application/json"})
            self.assertEqual(code, 200, raw)
            notes = f.view()["notes"]
            self.assertEqual(len(notes), 1)
            self.assertEqual(notes[0]["text"], "Confirm the deadline.")
            self.assertEqual(notes[0]["at_t"], 3000)
            self.assertGreaterEqual(notes[0]["t"], 10000)
            self.assertNotIn("access-control-allow-origin", headers)
            self.assertEqual(f.state.count(), 0)
            f.stop()

    def test_early_about_03_accepts_future_anchor_without_inflating_arrival_clock(self):
        # Real wall clock, no sleeps and no fixture time advance. A manual
        # annotation may refer to03s before this young session reaches03s.
        with base.Fixture(notesFrom="page") as f:
            f.start()
            self.assertLess(f.view()["now_t"], 3000)
            for content, body in (
                ("application/x-www-form-urlencoded", urlencode({"note": "Early form annotation", "about": "00:03"})),
                ("application/json", json.dumps({"text": "Early JSON annotation", "about": "00:03"})),
            ):
                code, _, response = request(f, "POST", "/listen/note", body, {"Content-Type": content})
                self.assertIn(code, (200, 303), response)
                state = f.view()
                note = state["notes"][-1]
                self.assertEqual(note["at_t"], 3000)
                self.assertLess(note["t"], 3000)
                self.assertLess(state["now_t"], 3000)
                self.assertLessEqual(note["t"], state["now_t"])
            self.assertEqual(len(f.view()["notes"]), 2)
            self.assertEqual(f.state.count(), 0)
            f.stop()

    def test_form_note_default_anchor_and_safe_html(self):
        with base.Fixture(notesFrom="page", fake_clock=True) as f:
            f.start(); f.advance_clock(5000); self.assertEqual(f.chunk(0, marker=31)[0], 200)
            code, _, page = request(f, "GET", "/listen/live.html")
            self.assertEqual(code, 200)
            body = urlencode({"note": '<b>Remember & verify</b>', "about": ""})
            code, _, reply = request(f, "POST", "/listen/note", body, {"Content-Type": "application/x-www-form-urlencoded", "Origin": f"http://127.0.0.1:{f.hub_port}"})
            self.assertIn(code, (200, 303), reply)
            note = f.view()["notes"][-1]
            self.assertEqual(note["at_t"], f.view()["lines"][-1]["t"])
            _, _, page = request(f, "GET", "/listen/live.html")
            self.assertNotIn('<b>Remember & verify</b>', page)
            self.assertIn('&lt;b&gt;Remember &amp; verify&lt;/b&gt;', page)
            self.assertEqual(f.state.count(), 0)
            f.stop()

    def test_proxy_origin_host_and_token_cannot_bypass_local_only_page(self):
        with base.Fixture(notesFrom="page") as f:
            f.start()
            for headers in ({"X-Forwarded-For": "198.51.100.12"}, {"Forwarded": "for=198.51.100.12"}, {"X-Real-IP": "198.51.100.12"}, {"Host": "external.invalid"}):
                for token in (False, True):
                    code, _, body = request(f, "GET", "/listen/live.txt", headers=headers, token=token)
                    self.assertEqual(code, 404, (headers, token))
                    self.assertNotIn(f.session["id"], body)
            code, _, _ = request(f, "POST", "/listen/note", json.dumps({"text": "blocked"}), {"Content-Type": "application/json", "Origin": "https://untrusted.invalid"}, token=True)
            self.assertEqual(code, 404)
            self.assertEqual(f.view()["notes"], [])
            f.stop()

    def test_actual_handler_sees_nonloopback_socket_and_rejects_even_with_token(self):
        # Private preload-like launcher changes ONLY the fake request's socket
        # view. The actual network remains guarded fixture loopback, and the
        # real production handler—not a copied implementation—makes the decision.
        with tempfile.TemporaryDirectory(prefix="listen-page-remote-fixture-") as temp:
            launcher = Path(temp) / "remote-fixture.mjs"
            launcher.write_text("import http from 'node:http';\nconst create=http.createServer;\nhttp.createServer=function(handler){return create.call(this,(req,res)=>{if(req.headers['x-fixture-remote-address'])Object.defineProperty(req.socket,'remoteAddress',{value:'198.51.100.12',configurable:true});return handler(req,res);});};\nawait import(" + json.dumps((base.HERE / "hud-server.mjs").as_uri()) + ");\n")
            with base.Fixture(hub_script=launcher, notesFrom="page") as f:
                f.start()
                for token in (False, True):
                    code, _, body = request(f, "GET", "/listen/live.txt", headers={"X-Fixture-Remote-Address": "external"}, token=token)
                    self.assertEqual(code, 404)
                    self.assertNotIn(f.session["id"], body)
                f.stop()

    def test_page_mount_preserves_existing_api_auth_and_stopped_note_rejection(self):
        with base.Fixture(notesFrom="page") as f:
            self.assertEqual(f.call("POST", "/api/listen/start", {}, token=None)[0], 401)
            code, headers, text = request(f, "GET", "/listen/live.txt")
            self.assertEqual(code, 200)
            self.assertIn("no Listen session on this hub", text)
            self.assertIn("default-src 'none'", headers.get("content-security-policy", ""))
            code, _, page = request(f, "GET", "/listen/live.html")
            self.assertEqual(code, 200)
            self.assertIn("no Listen session on this hub", page)
            self.assertEqual(request(f, "POST", "/listen/note", json.dumps({"text": "too early"}), {"Content-Type": "application/json"})[0], 409)
            f.start(); f.stop()
            code, _, _ = request(f, "POST", "/listen/note", json.dumps({"text": "late note"}), {"Content-Type": "application/json"})
            self.assertIn(code, (404, 410))


    def test_raw_duplicate_authority_and_proxy_presence_deny_before_engine_reads(self):
        with RawPageFixture() as f:
            host = "127.0.0.1:" + str(f.port)
            origin = "http://" + host
            cases = [
                [("Host", host), ("Via", "1.1 fixture")],
                [("Host", host), ("vIa", "")],
                [("Host", host), ("Via", ""), ("VIA", "")],
                [("Host", host), ("Forwarded", "")],
                [("Host", host), ("x-FORWARDED-for", "")],
                [("Host", host), ("X-Forwarded-Unknown", "")],
                [("Host", host), ("Tailscale-User-Login", "")],
                [("Host", host), ("Host", host)],
                [("Host", host), ("hOsT", "external.invalid")],
                [("Host", "external.invalid"), ("HOST", host)],
                [("Host", host), ("Origin", origin), ("oRiGiN", origin)],
                [("Host", host), ("Origin", origin), ("Origin", "")],
                [("Host", host), ("Origin", "https://external.invalid"), ("Origin", origin)],
            ]
            for alias in ("127.1", "0177.0.0.1", "2130706433", "0x7f000001", "127.0.0.1.external.invalid", "[::1]"):
                cases.append([("Host", alias + ":" + str(f.port))])
            cases.extend([[("Host", "127.0.0.1")], [("Host", "localhost:0" + str(f.port))]])
            for index, headers in enumerate(cases):
                for method, route in (("GET", "/listen/live.txt"), ("GET", "/listen/live.html"), ("POST", "/listen/note")):
                    with self.subTest(case=index, method=method):
                        f.control("reset")
                        body = json.dumps({"text": "REJECTED_FIXTURE_NOTE"}).encode() if method == "POST" else b""
                        # A valid hub token must not waive the page's boundary.
                        code, text = f.raw(method, route, headers + [("Authorization", "Bearer " + base.HUB_TOKEN)], body)
                        self.assertEqual(code, 404)
                        self.assertNotIn("PRIVATE_FIXTURE_TRANSCRIPT_NEVER_LEAK", text)
                        self.assertNotIn("REJECTED_FIXTURE_NOTE", text)
                        self.assertEqual(f.control("counts"), {"reads": 0, "writes": 0, "notes": []})

    def test_raw_positive_control_exact_localhost_case_is_allowed(self):
        with RawPageFixture() as f:
            for name in ("127.0.0.1", "localhost", "LOCALHOST"):
                f.control("reset")
                code, text = f.raw("GET", "/listen/live.txt", [("Host", name + ":" + str(f.port))])
                self.assertEqual(code, 200)
                self.assertIn("PRIVATE_FIXTURE_TRANSCRIPT_NEVER_LEAK", text)
                self.assertEqual(f.control("counts"), {"reads": 1, "writes": 0, "notes": []})

    def test_note_body_limit_is_4096_bytes_and_rejected_body_is_not_stored(self):
        with base.Fixture(notesFrom="page") as f:
            f.start()
            overhead = len(json.dumps({"text": ""}, separators=(",", ":")).encode())
            exact = json.dumps({"text": "x" * (4096 - overhead)}, separators=(",", ":")).encode()
            self.assertEqual(len(exact), 4096)
            self.assertEqual(request(f, "POST", "/listen/note", exact, {"Content-Type": "application/json"})[0], 200)
            before = f.view()["notes"]
            for body in (exact + b" ", json.dumps({"text": "é" * 2043}, ensure_ascii=False, separators=(",", ":")).encode()):
                self.assertGreater(len(body), 4096)
                self.assertEqual(request(f, "POST", "/listen/note", body, {"Content-Type": "application/json"})[0], 413)
                self.assertEqual(f.view()["notes"], before)
            f.stop()

    def test_note_optional_and_wrong_id_form_json_never_cross_sessions(self):
        with base.Fixture(notesFrom="page") as f:
            f.start()
            for form in (False, True):
                content = "application/x-www-form-urlencoded" if form else "application/json"
                encode = urlencode if form else json.dumps
                field = "note" if form else "text"
                accepted = request(f, "POST", "/listen/note", encode({field: "note without id"}), {"Content-Type": content})[0]
                self.assertIn(accepted, (200, 303))
                before = f.view()["notes"]
                denied = request(f, "POST", "/listen/note", encode({field: "wrong target", "id": "wrong-session"}), {"Content-Type": content})[0]
                self.assertEqual(denied, 409)
                self.assertEqual(f.view()["notes"], before)
            f.stop()

    def test_start_selects_per_session_notes_source_and_rejects_unknown_values(self):
        with base.Fixture(notesFrom="chat") as f:
            for source in ("page", "chat", "both"):
                code, started = f.call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": source})
                self.assertEqual(code, 200)
                f.session = started
                self.assertEqual(f.view()["notesFrom"], source)
                f.stop()
            for invalid in ("loud", "", None, 7, {}):
                code, body = f.call("POST", "/api/listen/start", {"notesFrom": invalid})
                self.assertEqual(code, 400)
                self.assertIsInstance(body.get("error"), str)


    def test_configured_g2_pause_reaches_chat_http_admission_gate(self):
        with base.Fixture(notesFrom="chat", g2PauseMs=2000, fake_clock=True) as f:
            f.start()
            self.assertEqual(f.call("GET", "/api/muse")[0], 200)
            self.assertEqual(f.chunk(0, marker=73)[0], 200)
            f.advance_clock(1999)
            self.assertFalse(f.state.ask_event.wait(.2), "configured pause must still hold at 1999ms")
            self.assertEqual(f.state.count(), 0)
            # The queue pause expires at2000; allow the retained-speech
            # retry cadence (100ms) too, without advancing toward60000.
            f.advance_clock(101)
            self.assertTrue(f.state.ask_event.wait(3), "custom 2000ms pause must not silently remain 60000ms")
            self.assertEqual(f.state.count(), 1)
            f.stop()


def main():
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(sig, interrupted)
    def deadline(signum, frame):
        raise TimeoutError("Live-page fixture exceeded 60 second owner deadline")
    signal.signal(signal.SIGALRM, deadline); signal.alarm(60)
    try:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LivePageTests))
        return 0 if result.wasSuccessful() else 1
    finally:
        signal.alarm(0)
        for raw_fixture in list(RAW_OWNED):
            raw_fixture.close()
        for fixture in list(base.OWNED):
            try: fixture.close()
            finally: fixture.stack.close()


if __name__ == "__main__":
    sys.exit(main())
