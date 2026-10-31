#!/usr/bin/env python3
"""Live-page HTTP proof: isolated real hub, fake ASR/relay, deny-by-default network guard."""
import datetime
import http.client
import importlib.util
import json
from pathlib import Path
import signal
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
                    self.assertEqual(code, 403, (headers, token))
                    self.assertNotIn(f.session["id"], body)
            code, _, _ = request(f, "POST", "/listen/note", json.dumps({"text": "blocked"}), {"Content-Type": "application/json", "Origin": "https://untrusted.invalid"}, token=True)
            self.assertEqual(code, 403)
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
                    self.assertEqual(code, 403)
                    self.assertNotIn(f.session["id"], body)
                f.stop()

    def test_page_mount_preserves_existing_api_auth_and_stopped_note_rejection(self):
        with base.Fixture(notesFrom="page") as f:
            self.assertEqual(f.call("POST", "/api/listen/start", {}, token=None)[0], 401)
            self.assertEqual(request(f, "GET", "/listen/live.txt")[0], 404)
            f.start(); f.stop()
            code, _, _ = request(f, "POST", "/listen/note", json.dumps({"text": "late note"}), {"Content-Type": "application/json"})
            self.assertIn(code, (404, 410))


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
        for fixture in list(base.OWNED):
            try: fixture.close()
            finally: fixture.stack.close()


if __name__ == "__main__":
    sys.exit(main())
