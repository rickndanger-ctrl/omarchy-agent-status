#!/usr/bin/env bash
# The join test for Muse Listen (hub half glasses/listen.mjs + the G2 /api/muse routes): drives
# the REAL hub against a FAKE Muse relay and a FAKE transcription service. No real Muse, relay, Whisper or hub is
# contacted; HOME is a temp folder.
# Scenario 1 (TWO Muses; Listen asks only the last, only when /selftest says idle and no G2 ask is in flight):
#   3 snippets -> 2 notes + 1 "—" dropped; at_t on the session clock; ?since; a G2 ask made while a Listen snippet is
#   in flight lands on Muse 1 on its FIRST try, one POST per question, its reply is drawn; Listen then holds off
#   while a G2 ask is in flight; stop ends it. A one-Muse overlap is a "known risk" note, never a fail.
# Then G2 must ALWAYS succeed: one Muse, and two Muses with Muse 1 down, with a Listen snippet in flight (hard checks).
# Scenario 2 (failure proof): /ask hangs past the hub's 10 s timeout once (uncertain admission) -> does a later G2 ask work?
# Scenario 3 (failure proof): the relay restarts mid-Listen job (/reply/<id> is 404 forever) -> does a later G2 ask work?
# Scenario 4 (failure proof): a G2 job fails with "Command failed" on 2 Muses, two clients poll /api/muse/reply at once
#   -> is the question POSTed more than once to the same Muse?
# Not covered here (the app's own test): remote down x2 selecting note 2 and the left box scrolling to its at_t.
# S2/S3/S4 use the failure switches below; each: a LATER G2 ask must still work.
# The hubs run with a built (not inherited) environment and the deny-by-default network guard of A's test.
# Knobs go in the hub config: {"listen":{"snippetMs","minWords","pollMs","timeoutMs"}}.
#   bash glasses/test-listen-join.sh      (needs node and python3; about 2 minutes)
set -u
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME/.config/agent-glasses"
trap 'rm -rf "$work"' EXIT

python3 - "$here" "$work" <<'PY'
import http.client, http.server, json, os, shutil, subprocess, sys, threading, time, atexit

HERE, WORK = sys.argv[1], sys.argv[2]
NODE = shutil.which("node")
BASE = int(os.environ.get("LISTEN_PORT_BASE", 5420))
TOKEN, RELAY_TOKEN = "listen-test-token", "listen-relay-token"
SNIPPET_MS, BUSY_S, QUEUE_TIMEOUT_MS = 1500, 0.8, 5000

passed = failed = 0
def check(label, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print(f"  ok    {label}", flush=True)
    else:
        failed += 1; print(f"  FAIL  {label} {extra}"[:700], flush=True)
def note(msg): print(f"  note  {msg}", flush=True)

# ---- fake transcription: a chunk of 1000*k bytes of PCM is heard as 30 words ending in "topic<k>" -----------------
class Whisper(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        i = body.find(b"RIFF")
        k = int.from_bytes(body[i + 40:i + 44], "little") // 1000 if i >= 0 else 0
        data = json.dumps({"text": " ".join(f"word{n}" for n in range(29)) + f" topic{k}"}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
whisper = http.server.ThreadingHTTPServer(("127.0.0.1", BASE), Whisper)
threading.Thread(target=whisper.serve_forever, daemon=True).start()

# ---- fake Muse relay, copied from the REAL one (macmini1 ~/muse-relay/server.mjs, read 2026-10-30) ----------------
# POST /ask never refuses: it queues the job behind the running one (FIFO) and answers {id, status, question, reply,
# error, timing}. GET /selftest (no auth) answers {ok, museRunning, accessibility, composer, busy}, composer:false and
# busy:true while any job is queued or running. Status goes queued -> sending -> waiting -> done.
# Failure switches (opt): hang_next_ask  = accept the ask but answer only after 11.5 s (the hub gives up at 10 s);
#   forget_jobs = after the next Listen ask, forget every job (a restarted relay: /reply/<id> is 404 forever);
#   fail_g2 = a G2 job ends status "error" with error "Command failed: x" (musectl failed before typing).
LISTEN_REPLIES = ["Note one: ask about the budget.", "—", "Note three: they agreed on Friday."]
def make_relay(port):
    R = {"asks": [], "ask_while_busy": 0, "listen_while_busy": 0, "jobs": {}, "listen_n": 0, "free_at": 0.0, "lock": threading.Lock(), "opt": {}}
    busy_now = lambda: time.time() < R["free_at"]
    R["busy_now"] = busy_now
    class Relay(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def send(self, code, value):
            data = json.dumps(value).encode()
            try:
                self.send_response(code); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            except OSError: pass
        def authed(self): return self.headers.get("Authorization") == f"Bearer {RELAY_TOKEN}"
        def view(self, job):
            now = time.time()
            status = "done" if now >= job["until"] else "queued" if now < job["start"] else "waiting" if now > job["start"] + 0.2 else "sending"
            if job.get("fail") and status == "done": status = "error"
            return {"id": job["id"], "status": status, "question": job["q"], "reply": job["reply"] if status == "done" else "",
                    "error": "Command failed: x" if status == "error" else "", "timing": {}}
        def do_GET(self):
            if R.get("down"): return self.send(503, {"error": "down"})
            with R["lock"]:
                if self.path == "/selftest":
                    b = busy_now()
                    return self.send(200, {"ok": True, "museRunning": True, "accessibility": True, "composer": not b, "busy": b})
                if not self.authed(): return self.send(401, {"error": "unauthorized"})
                if self.path.startswith("/reply/"):
                    job = R["jobs"].get(self.path.split("/")[-1])
                    return self.send(200, self.view(job)) if job else self.send(404, {"error": "unknown id"})
                if self.path == "/latest": return self.send(200, {"question": "q", "reply": "latest"})
            self.send(404, {"error": "not found"})
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if R.get("down"): return self.send(503, {"error": "down"})
            if not self.authed(): return self.send(401, {"error": "unauthorized"})
            if self.path.split("?")[0] != "/ask": return self.send(404, {"error": "not found"})
            hang = False
            with R["lock"]:
                now = time.time()
                if busy_now():
                    R["ask_while_busy"] += 1
                    if "G2 QUESTION" not in str(body.get("text", "")): R["listen_while_busy"] += 1
                text = str(body.get("text", "")).strip()
                if "G2 QUESTION" in text: reply, kind = "G2 answer.", "g2"
                else:
                    reply, kind = LISTEN_REPLIES[min(R["listen_n"], len(LISTEN_REPLIES) - 1)], "listen"
                    R["listen_n"] += 1
                start = max(now, R["free_at"])
                job = {"id": str(len(R["asks"]) + 1), "q": text, "reply": reply, "start": start, "until": start + BUSY_S,
                       "fail": bool(R["opt"].get("fail_g2")) and kind == "g2"}
                R["jobs"][job["id"]] = job
                R["free_at"] = job["until"]
                R["asks"].append({"kind": kind, "text": text, "at": now})
                if R["opt"].pop("hang_next_ask", False): hang = True
                if kind == "listen" and R["opt"].pop("forget_jobs", False):
                    forget = True
                else: forget = False
                resp = self.view(job)
                if forget: R["jobs"].clear()
            if hang: time.sleep(11.5)
            return self.send(200, resp)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Relay)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return R
def posts_of(R, needle): return sum(1 for a in R["asks"] if needle in a["text"])

open(os.path.join(WORK, "hud.token"), "w").write(TOKEN + "\n")
open(os.path.join(WORK, "relay.token"), "w").write(RELAY_TOKEN + "\n")
hubs = []
guard_logs = []
atexit.register(lambda: [h.terminate() for h in hubs])
PORT = BASE + 1
def start_hub(port, relay_ports):
    cfg = os.path.join(WORK, f"hub-{port}.json")
    json.dump({"muse": [{"name": f"fake{i}", "url": f"http://127.0.0.1:{pt}", "tokenFile": os.path.join(WORK, "relay.token")} for i, pt in enumerate(relay_ports)],
               "listen": {"snippetMs": SNIPPET_MS, "minWords": 25, "pollMs": 200, "timeoutMs": QUEUE_TIMEOUT_MS}}, open(cfg, "w"))
    # Clean environment, built rather than copied (no inherited proxy, credential, HUD, Studio or Node preload), plus the
    # deny-by-default network guard (test-helpers/listen-network-guard.mjs): only the fixture's own loopback ports are
    # reachable and no child command may start. Anything else is refused and logged; the test fails if the log is not empty.
    guard_log = os.path.join(WORK, f"guard-{port}.jsonl")
    guard_logs.append(guard_log)
    env = {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C.UTF-8", "TMPDIR": WORK,
           "HUD_TOKEN_FILE": os.path.join(WORK, "hud.token"), "HUD_HUB_CONFIG": cfg,
           "HUD_TRANSCRIBE_URL": f"http://127.0.0.1:{BASE}/whisper", "GROQ_API_KEY": "test-groq-key",
           "LISTEN_TEST_ALLOW_PORTS": ",".join(str(x) for x in [BASE, port, *relay_ports]), "LISTEN_TEST_GUARD_LOG": guard_log}
    proc = subprocess.Popen([NODE, "--import", os.path.join(HERE, "test-helpers", "listen-network-guard.mjs"),
                             os.path.join(HERE, "hud-server.mjs"), "--mode", "hub", "--host", "127.0.0.1", "--port", str(port), "--machine", "Listen Test"],
                            env=env, cwd=WORK, stdin=subprocess.DEVNULL, stdout=open(os.path.join(WORK, f"hub-{port}.log"), "w"), stderr=subprocess.STDOUT)
    hubs.append(proc)
    for _ in range(100):
        try:
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=2); c.request("GET", "/api/health"); good = c.getresponse().status == 200; c.close()
            if good: return proc
        except OSError: pass
        time.sleep(0.1)
    sys.exit(f"hub on {port} did not start; see {WORK}/hub-{port}.log")

def call(method, path, body=None, raw=None, timeout=30):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    data = None
    if raw is not None: data, headers["Content-Type"] = raw, "application/octet-stream"
    elif body is not None: data, headers["Content-Type"] = json.dumps(body), "application/json"
    conn.request(method, path, body=data, headers=headers)
    res = conn.getresponse(); text = res.read().decode(); conn.close()
    try: return res.status, json.loads(text)
    except ValueError: return res.status, text
def wait_for(fn, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.15)
    return None
def view(lid, since=None):
    code, body = call("GET", f"/api/listen?id={lid}" + (f"&since={since}" if since is not None else ""))
    return body if code == 200 and isinstance(body, dict) else {}
def g2_ask(text):
    code, body = call("POST", "/api/muse/ask", {"text": text}, timeout=40)
    return code, body, (body.get("id") if code == 200 and isinstance(body, dict) else None)
def g2_reply(gid, seconds=20):
    last = {}
    def poll():
        nonlocal last
        code, body = call("GET", f"/api/muse/reply?id={gid}")
        last = body if isinstance(body, dict) else {}
        return last if last.get("status") in ("done", "error", "timeout") else None
    return wait_for(poll, seconds) or last
def new_scenario(n_relays=1):
    global PORT
    relays = [make_relay(BASE + 10 * (len(hubs) + 1) + i) for i in range(n_relays)]
    PORT = BASE + 100 + len(hubs)
    start_hub(PORT, [BASE + 10 * (len(hubs) + 1) + i for i in range(n_relays)])
    return relays

# ================================================================================================================
print("Scenario 1: two Muses (Listen uses the last), 3 snippets, a G2 ask while a Listen snippet is in flight")
R1, R = new_scenario(2)  # R = Muse 2, the one Listen uses
code, body = call("POST", "/api/listen/start", {"backend": "muse"})
lid = body.get("id") if isinstance(body, dict) else None
check("POST /api/listen/start -> {id, startedAt}", code == 200 and isinstance(lid, str) and isinstance(body.get("startedAt"), int), str(body))
t0 = time.time()
v = view(lid)
check("GET /api/listen: listening, no lines or notes yet, muse idle",
      v.get("state") == "listening" and v.get("lines") == [] and v.get("notes") == [] and v.get("muse", {}).get("state") in ("idle", "thinking"), str(v))
gid = None
for k in (1, 2, 3):
    code, body = call("POST", f"/api/listen/chunk?id={lid}&seq={k - 1}", raw=bytes(1000 * k))
    check(f"chunk {k} accepted -> {{ok, lines}} with the words timestamped", code == 200 and body.get("ok") is True
          and body.get("lines") and all(isinstance(l.get("t"), int) for l in body["lines"]), str(body))
    if k == 3:
        check("Listen's third question is in flight on Muse 2", wait_for(lambda: R["busy_now"]() and R["listen_n"] >= 3, 15) is not None, f"listen_n={R['listen_n']}")
        t_ask = time.time()
        code, body, gid = g2_ask("G2 QUESTION: what time is it?")
        check("a G2 ask during a Listen snippet is accepted on its FIRST try, at once (< 3 s)", gid is not None and time.time() - t_ask < 3, f"{code} {body} {time.time() - t_ask:.1f}s")
        check("... and it lands on Muse 1 (id starts 0-)", str(gid).startswith("0-"), str(gid))
        break
    check(f"snippet {k} reached Muse", wait_for(lambda: len(R["asks"]) >= k) is not None, f"asks={len(R['asks'])}")
    time.sleep(SNIPPET_MS / 1000 + 0.3)
if gid:
    r = g2_reply(gid)
    check("... its reply is drawn from Muse 1: status done, answer 'G2 answer.'", r.get("status") == "done" and r.get("reply") == "G2 answer.", str(r))
check("all three listen snippets were asked", wait_for(lambda: R["listen_n"] >= 3, 30) is not None, f"listen_n={R['listen_n']}")
v = wait_for(lambda: (lambda x: x if len(x.get("notes", [])) >= 2 and x.get("muse", {}).get("state") == "idle" else None)(view(lid)), 20) or view(lid)
notes, lines = v.get("notes", []), v.get("lines", [])
check("3 snippets -> exactly 2 notes (the '—' reply is dropped)", len(notes) == 2 and all(n.get("text") != "—" for n in notes), str(notes))
check("note texts are Muse's, short (<= 300 chars)", [n.get("text") for n in notes] == ["Note one: ask about the budget.", "Note three: they agreed on Friday."], str(notes))
check("each note has t and at_t on the session clock (ms since start), at_t <= t",
      len(notes) == 2 and all(isinstance(n.get("t"), int) and isinstance(n.get("at_t"), int) and 0 <= n["at_t"] <= n["t"] for n in notes), str(notes))
check("notes are in order; note 2 is about later speech than note 1", len(notes) == 2 and notes[0]["at_t"] < notes[1]["at_t"], str(notes))
check("the transcript has 3 timestamped lines, in order", len(lines) == 3 and [l["t"] for l in lines] == sorted(l["t"] for l in lines), str(lines))
check("every note's at_t lands on or after a transcript line (the jump target exists)",
      len(notes) == 2 and all(any(l["t"] <= n["at_t"] for l in lines) for n in notes))
check("now_t is ms since startedAt and >= the last line and note",
      isinstance(v.get("now_t"), int) and v["now_t"] >= max([l["t"] for l in lines] + [n["t"] for n in notes]) and v["now_t"] <= (time.time() - t0) * 1000 + 3000, str(v.get("now_t")))
if len(lines) == 3:
    only = view(lid, since=lines[1]["t"])
    got = [l["t"] for l in only.get("lines", [])]
    check("?since=<t> returns no line before t", bool(got) and all(t >= lines[1]["t"] for t in got) and lines[2]["t"] in got, str(only))
    if lines[1]["t"] in got: note("?since=<t> is INCLUSIVE (the line at exactly t comes back); the contract does not say which")
check("Muse never got two questions at once (no /ask POSTed to a busy Muse)", R["listen_n"] >= 3 and R["ask_while_busy"] == 0, f"ask_while_busy={R['ask_while_busy']}")
k1, k2 = [a["kind"] for a in R1["asks"]], [a["kind"] for a in R["asks"]]
check("Listen asked ONLY the last Muse (3 listen asks on Muse 2); Muse 1 got only the G2 ask", k2 == ["listen"] * 3 and k1 == ["g2"], f"{k1} / {k2}")
check("exactly ONE POST /ask per question (all texts distinct across both Muses)", posts_of(R1, "G2 QUESTION") == 1 and len({a["text"] for a in R1["asks"] + R["asks"]}) == len(R1["asks"] + R["asks"]), str([a["text"][:30] for a in R1["asks"] + R["asks"]]))
check("neither Muse was ever POSTed to while busy", R1["ask_while_busy"] == 0 and R["ask_while_busy"] == 0, f"{R1['ask_while_busy']},{R['ask_while_busy']}")
# Listen holds off while a G2 ask is in flight: ask G2 (job runs on Muse 1 for BUSY_S), poll its reply like the app, and
# feed a 4th snippet at once; Listen's POST must come only after the G2 job has finished.
time.sleep(SNIPPET_MS / 1000 + 0.3)
n_before = len(R["asks"])
code, body, gid2 = g2_ask("G2 QUESTION: second, while Listen waits")
call("POST", f"/api/listen/chunk?id={lid}&seq=3", raw=bytes(4000))
if gid2: g2_reply(gid2)
g2_until = max((j["until"] for j in R1["jobs"].values() if "second, while" in j["q"]), default=None)
check("the second G2 ask is accepted and answered", gid2 is not None and g2_until is not None, f"{code} {body}")
got = wait_for(lambda: len(R["asks"]) > n_before, 15)
check("Listen's 4th snippet was asked only AFTER the G2 ask finished", bool(got) and g2_until is not None and R["asks"][n_before]["at"] >= g2_until - 0.3,
      f"listen POST at +{(R['asks'][n_before]['at'] - g2_until) if got and g2_until else 'n/a'} s relative to the G2 job's end")
if len(R["asks"]) >= 2:
    first, second = R["asks"][0]["text"], R["asks"][1]["text"]  # Muse 2 only has Listen's
    check("the prompt frame asks for ONE short note, or exactly '—'", "—" in first and "25" in first, first[:200])
    check("snippet 1 carries its 30 new words and a time label", "topic1" in first and "00:" in first, first[:200])
    check("snippet 2 carries earlier context, labelled with times", "topic1" in second and "topic2" in second and "00:" in second, second[:200])
check("no G2 question went to Muse 2", all("G2 QUESTION" not in a["text"] for a in R["asks"]))
for _ in range(2):
    code, body = call("POST", "/api/input", {"input": "down"})
    check("remote 'down' accepted by /api/input", code == 200, str(body))
    time.sleep(0.2)
code, body = call("POST", "/api/listen/stop", {"id": lid})
check("POST /api/listen/stop -> {ok}", code == 200 and body.get("ok") is True, str(body))
check("state is 'stopped' after stop", view(lid).get("state") == "stopped")
asks_at_stop = len(R["asks"])
code, body = call("POST", f"/api/listen/chunk?id={lid}&seq=9", raw=bytes(4000))
check("a chunk after stop is refused (not a 200 ok)", lid is not None and not (code == 200 and isinstance(body, dict) and body.get("ok") is True), f"{code} {body}")
time.sleep(SNIPPET_MS / 1000 * 2 + 1)
check("no more Muse asks after stop", lid is not None and len(R["asks"]) == asks_at_stop, f"{asks_at_stop} -> {len(R['asks'])}")
code, body = call("GET", "/api/listen?id=nope")
check("an unknown session id is a plain 404 reason, never raw relay text", code == 404 and isinstance(body, dict) and body.get("error") not in (None, "not found") and "fake" not in json.dumps(body), f"{code} {body}")
code, body = call("GET", "/api/muse")
check("GET /api/muse (G2) still answers", code == 200 and body.get("reply") == "latest", str(body))

# ================================================================================================================
print("G2 must ALWAYS succeed: one Muse, and two Muses with Muse 1 down, while Listen's snippet is in flight")
def always_g2(label, relays, down=()):
    global PORT
    R = relays[-1]  # Listen uses the last Muse; with one Muse it is the only one
    code, body = call("POST", "/api/listen/start", {"backend": "muse"})
    lid = body.get("id")
    call("POST", f"/api/listen/chunk?id={lid}&seq=0", raw=bytes(1000))
    check(f"{label}: Listen's snippet is in flight", wait_for(lambda: R["busy_now"]() and R["listen_n"] >= 1, 15) is not None, f"listen_n={R['listen_n']}")
    snippet_until = max((j["until"] for j in R["jobs"].values() if "G2 QUESTION" not in j["q"]), default=0)
    text = f"G2 QUESTION: {label}"
    t_ask = time.time()
    code, body, gid = g2_ask(text)
    check(f"{label}: a G2 ask during the snippet is 200 on its FIRST try, at once (< 3 s)", gid is not None and time.time() - t_ask < 3, f"{code} {body} {time.time() - t_ask:.1f}s")
    r = g2_reply(gid, 20) if gid else {}
    check(f"{label}: its reply is drawn (status done, 'G2 answer.')", r.get("status") == "done" and r.get("reply") == "G2 answer.", f"raw reply: {r}")
    allasks = [a for rr in relays for a in rr["asks"]]
    check(f"{label}: exactly ONE POST /ask for the G2 question", sum(1 for a in allasks if text in a["text"]) == 1, str([a["text"][:30] for a in allasks]))
    check(f"{label}: exactly ONE POST /ask for the Listen snippet", sum(1 for a in allasks if a["kind"] == "listen") == 1)
    g2job = [j for rr in relays for j in rr["jobs"].values() if text in j["q"]]
    check(f"{label}: the G2 question ran AFTER the snippet, never alongside it", bool(g2job) and g2job[0]["start"] >= snippet_until - 0.05, f"g2 start {g2job[0]['start'] - snippet_until if g2job else 'n/a'} s after the snippet's end")
    check(f"{label}: Listen itself never POSTed to a busy Muse", all(rr["listen_while_busy"] == 0 for rr in relays), str([rr["listen_while_busy"] for rr in relays]))
    call("POST", "/api/listen/stop", {"id": lid})

(R,) = new_scenario()
always_g2("one Muse", [R])
R1, R2 = new_scenario(2)
R1["down"] = True  # Muse 1 is down: its relay refuses every request
always_g2("two Muses, Muse 1 down", [R1, R2])

# ================================================================================================================
print("Scenario 2 (failure proof): the relay hangs on /ask past the hub's 10 s timeout once (uncertain admission)")
(R,) = new_scenario()
R["opt"]["hang_next_ask"] = True
code, body = call("POST", "/api/listen/start", {"backend": "muse"})
lid = body.get("id")
call("POST", f"/api/listen/chunk?id={lid}&seq=0", raw=bytes(1000))
check("the hung Listen question reached the relay", wait_for(lambda: R["listen_n"] >= 1, 10) is not None)
time.sleep(13)  # past the hub's 10 s POST timeout; the relay did accept it
call("POST", "/api/listen/stop", {"id": lid})
code, body, gid = g2_ask("G2 QUESTION: after the hang")
note(f"G2 ask after the hang -> {code} {body}")
r = g2_reply(gid, 20) if gid else {}
check("a LATER G2 ask still works after an uncertain Listen admission (status done, 'G2 answer.')", r.get("status") == "done" and r.get("reply") == "G2 answer.", f"raw reply: {r}")
check("... and was POSTed exactly once", posts_of(R, "after the hang") == 1, f"posts={posts_of(R, 'after the hang')}")

# ================================================================================================================
print("Scenario 3 (failure proof): the relay restarts mid-Listen job (/reply/<id> is 404 forever)")
(R,) = new_scenario()
R["opt"]["forget_jobs"] = True
code, body = call("POST", "/api/listen/start", {"backend": "muse"})
lid = body.get("id")
call("POST", f"/api/listen/chunk?id={lid}&seq=0", raw=bytes(1000))
check("the Listen question reached the relay (which then forgot it)", wait_for(lambda: R["listen_n"] >= 1, 10) is not None)
time.sleep(QUEUE_TIMEOUT_MS / 1000 + 3)  # past the queue's own timeout
call("POST", "/api/listen/stop", {"id": lid})
code, body, gid = g2_ask("G2 QUESTION: after the restart")
note(f"G2 ask after the restart -> {code} {body}")
r = g2_reply(gid, 20) if gid else {}
check("a LATER G2 ask still works after the relay lost the Listen job (status done, 'G2 answer.')", r.get("status") == "done" and r.get("reply") == "G2 answer.", f"raw reply: {r}")
check("... and was POSTed exactly once", posts_of(R, "after the restart") == 1, f"posts={posts_of(R, 'after the restart')}")

# ================================================================================================================
print("Scenario 4 (failure proof): a G2 job fails 'Command failed' on 2 Muses; two clients poll /api/muse/reply at once")
R1, R2 = new_scenario(2)
R1["opt"]["fail_g2"] = True
code, body, gid = g2_ask("G2 QUESTION: duplicate probe")
check("the G2 ask is accepted", gid is not None, f"{code} {body}")
results = []
def poller():
    end = time.time() + 15
    while time.time() < end:
        c, b = call("GET", f"/api/muse/reply?id={gid}")
        if isinstance(b, dict) and b.get("status") in ("done", "error", "timeout"):
            results.append(b); return
        time.sleep(0.05)
if gid:
    ts = [threading.Thread(target=poller) for _ in range(3)]
    [t.start() for t in ts]; [t.join() for t in ts]
    time.sleep(2)
note(f"POSTs of the question: Muse 1 = {posts_of(R1, 'duplicate probe')}, Muse 2 = {posts_of(R2, 'duplicate probe')}; final replies: {[r.get('status') for r in results]}")
check("the question was POSTed at most once to each Muse (never twice to the same one)", posts_of(R1, "duplicate probe") <= 1 and posts_of(R2, "duplicate probe") <= 1,
      f"Muse1={posts_of(R1, 'duplicate probe')} Muse2={posts_of(R2, 'duplicate probe')}")

print("Network guard")
blocked = []
for g in guard_logs:
    if os.path.exists(g): blocked += open(g).read().split("\n")
blocked = [b for b in blocked if b.strip()]
check("no hub reached a non-fixture network destination or started a child command (guard logs empty)", not blocked, str(blocked[:5]))
check("the guard was loaded for every hub (one log path each, hub ran under --import)", len(guard_logs) == len(hubs) and len(hubs) >= 5)

print(f"{passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
PY
