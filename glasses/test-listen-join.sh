#!/usr/bin/env bash
# The join test for Muse Listen (hub half glasses/listen.mjs + the G2 /api/muse routes): drives
# the REAL hub against a FAKE Muse relay and a FAKE transcription service. No real Muse, relay, Whisper or hub is
# contacted; HOME is a temp folder.
# LIVE PAGE (default notesFrom='page'): live.txt/live.html lines + clocks, note POST (form and JSON) -> /api/listen notes, every
#   forwarded/Tailscale/Host/Origin refusal -> 404 and nothing stored, ZERO relay calls from Listen, G2 untouched, no text in logs.
# The relay scenarios below start with notesFrom:'chat'. Replies/rolling-pacing scenarios are PAUSED (LISTEN_TEST_REPLIES_ROLLING=1).
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
import http.client, http.server, json, os, re, shutil, subprocess, sys, threading, time, atexit

HERE, WORK = sys.argv[1], sys.argv[2]
NODE = shutil.which("node")
BASE = int(os.environ.get("LISTEN_PORT_BASE", 5420))
TOKEN, RELAY_TOKEN = "listen-test-token", "listen-relay-token"
# Rolling pacing (CONTRACT-ROLLING): next snippet when none is in flight, >= snippetMinMs after the last SEND, >= settleMs after
# Muse FINISHED, with >= 1 new line and >= minWords new words. Small values here for speed. SNIPPET_MS = the gap the test
# leaves between chunks that must become separate snippets (job time + settle + snippetMinMs + margin).
SNIPPET_MIN_MS, SETTLE_MS, MIN_WORDS = 1000, 500, 3
BUSY_S, QUEUE_TIMEOUT_MS = 0.8, 5000
SNIPPET_MS = 2500
G2_PAUSE_MS = 2000  # hub.json listen.g2PauseMs (default 60000): Listen holds off this long after the last G2 route hit

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
        if k == 91: text = "alpha beta"                                    # 2 words
        elif k == 92: text = "gamma delta epsilon"                           # 3 words
        elif k == 94: text = '<script>alert(1)</script> & "q" <b>x</b>'
        elif k == 93: text = " ".join(f"long{n}" for n in range(400))        # ~2800 chars
        else: text = " ".join(f"word{n}" for n in range(29)) + f" topic{k}"
        data = json.dumps({"text": text}).encode()
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
def make_relay(port, busy_s=BUSY_S, reply_list=None):
    R = {"busy_s": busy_s, "reply_list": reply_list,"asks": [], "reqlog": [], "ask_while_busy": 0, "listen_while_busy": 0, "jobs": {}, "listen_n": 0, "free_at": 0.0, "lock": threading.Lock(), "opt": {}}
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
            with R["lock"]: R["reqlog"].append(("GET", self.path.split("?")[0]))
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
            with R["lock"]: R["reqlog"].append(("POST", self.path.split("?")[0]))
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
                    lst = R["reply_list"] or LISTEN_REPLIES
                    reply, kind = lst[min(R["listen_n"], len(lst) - 1)], "listen"
                    R["listen_n"] += 1
                start = max(now, R["free_at"])
                job = {"id": str(len(R["asks"]) + 1), "q": text, "reply": reply, "start": start, "until": start + R["busy_s"],
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
def start_hub(port, relay_ports, listen=None):
    cfg = os.path.join(WORK, f"hub-{port}.json")
    json.dump({"muse": [{"name": f"fake{i}", "url": f"http://127.0.0.1:{pt}", "tokenFile": os.path.join(WORK, "relay.token")} for i, pt in enumerate(relay_ports)],
               "listen": {"snippetMs": 1500, "minWords": 25, "snippetMinMs": SNIPPET_MIN_MS, "settleMs": SETTLE_MS, "pollMs": 200, "timeoutMs": QUEUE_TIMEOUT_MS, "g2PauseMs": G2_PAUSE_MS, **(listen or {})}}, open(cfg, "w"))
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
def new_scenario(n_relays=1, busy_s=BUSY_S, listen=None, reply_list=None):
    global PORT
    relays = [make_relay(BASE + 10 * (len(hubs) + 1) + i, busy_s, reply_list) for i in range(n_relays)]
    PORT = BASE + 300 + len(hubs)
    start_hub(PORT, [BASE + 10 * (len(hubs) + 1) + i for i in range(n_relays)], listen)
    return relays

# ================================================================================================================
print("Scenario 1: two Muses (Listen uses the last), 3 snippets, a G2 ask while a Listen snippet is in flight")
R1, R = new_scenario(2)  # R = Muse 2, the one Listen uses
code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat"})
lid = body.get("id") if isinstance(body, dict) else None
check("POST /api/listen/start -> {id, startedAt}", code == 200 and isinstance(lid, str) and isinstance(body.get("startedAt"), int), str(body))
t0 = time.time()
v = view(lid)
check("GET /api/listen echoes notesFrom: 'chat'", v.get("notesFrom") == "chat", str(v))
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
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat"})
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
code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat"})
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
code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat"})
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

# ================================================================================================================
print("Live page (default notesFrom='page'): Muse reads /listen/live.txt|html and posts notes to /listen/note; ZERO relay calls")
def raw_http(method, path, headers=None, body=None, port=None, host=None, timeout=15):
    """Plain request WITHOUT the hub bearer token (the page needs none from loopback); `host` overrides the Host header."""
    port = port or PORT
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    h = dict(headers or {})
    h["Host"] = host if host is not None else f"127.0.0.1:{port}"
    conn.request(method, path, body=body, headers=h)
    res = conn.getresponse(); data = res.read().decode("utf-8", "replace"); hdrs = {k.lower(): v for k, v in res.getheaders()}; conn.close()
    return res.status, data, hdrs
def notes_of(lid): return view(lid).get("notes", [])

(R,) = new_scenario()
code, body, _ = raw_http("GET", "/listen/live.txt")
check("no Listen session on this hub: live.txt is 200 and says so", code == 200 and "no Listen session on this hub" in body, f"{code} {body[:120]}")
code2, body2, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/json"}, json.dumps({"text": "too early"}))
check("... and a note POSTed then is 409 with a plain reason", code2 == 409, f"{code2} {body2[:120]}")
code, body = call("POST", "/api/listen/start", {"backend": "muse"})
lid = body.get("id") if isinstance(body, dict) else None
check("a default start (no notesFrom) works", code == 200 and isinstance(lid, str), f"{code} {body}")
check("GET /api/listen echoes notesFrom: 'page'", view(lid).get("notesFrom") == "page", str(view(lid)))
for k in (1, 2, 3):
    call("POST", f"/api/listen/chunk?id={lid}&seq={k - 1}", raw=bytes(1000 * k))
    time.sleep(0.4)
call("POST", f"/api/listen/chunk?id={lid}&seq=3", raw=bytes(94000))  # html-escape probe
code, txt, hdrs = raw_http("GET", "/listen/live.txt")
rows = txt.split("\n")
line_re = re.compile(r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] \[(\d\d:\d\d)\] (.+)$")
body_rows = [m for m in (line_re.match(r) for r in rows) if m]
check("live.txt: 200 text/plain", code == 200 and hdrs.get("content-type", "").startswith("text/plain"), f"{code} {hdrs.get('content-type')}")
check("live.txt: header line names the session id and says 'live'", any(lid in r and "live" in r for r in rows[:3]), str(rows[:3]))
check("live.txt: one '[YYYY-MM-DD HH:MM:SS] [mm:ss] text' line per transcript line (4), newest last",
      len(body_rows) == 4 and "topic1" in body_rows[0].group(3) and "topic3" in body_rows[2].group(3) and "<script>" in body_rows[3].group(3), str(rows[:8]))
now = time.time()
stamps = [time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")) for m in body_rows]
check("live.txt: the wall clock is local time and recent (within 2 min of now)", bool(stamps) and all(abs(now - t) < 120 for t in stamps), str([m.group(1) for m in body_rows]))
sess = [m.group(2) for m in body_rows]
check("live.txt: session times mm:ss rise from the start of the session", bool(sess) and sess == sorted(sess) and sess[0] <= "00:05", str(sess))
check("live.txt: Cache-Control no-store, X-Frame-Options DENY, CSP default-src 'none'",
      "no-store" in hdrs.get("cache-control", "") and hdrs.get("x-frame-options", "").upper() == "DENY" and "default-src 'none'" in hdrs.get("content-security-policy", ""), str(hdrs))
code, html, hdrs = raw_http("GET", "/listen/live.html")
csp = hdrs.get("content-security-policy", "")
def directive(name):
    m = re.search(rf"(?:^|;)\s*{name}\s+([^;]*)", csp)
    return m.group(1) if m else None
script_src = directive("script-src")
scripts = re.findall(r"<script\b([^>]*)>", html, re.I)
nonce_hdr = re.search(r"'nonce-([^']+)'", script_src or "")
check("live.html: 200 html, a <noscript> meta refresh of 2 s as the fallback, a note form (textarea 'note', 'about')",
      code == 200 and "html" in hdrs.get("content-type", "") and re.search(r"<noscript>\s*<meta[^>]*http-equiv=[\"']refresh[\"'][^>]*content=[\"']2", html, re.I)
      and re.search(r'action=["\']/listen/note', html) and re.search(r'<textarea[^>]*name=["\']note', html) and re.search(r'name=["\']about', html), html[:300])
check("live.html: any script carries a nonce, and CSP script-src has that nonce and NO 'unsafe-inline'",
      all(re.search(r'nonce=["\']', a) for a in scripts) and (not scripts or (bool(nonce_hdr) and "unsafe-inline" not in (script_src or "") and all(nonce_hdr.group(1) in a for a in scripts))),
      f"scripts={scripts} script-src={script_src}")
check("live.html: transcript text is HTML-escaped (<script> shows as &lt;script&gt;)", "&lt;script&gt;" in html and "<script>alert" not in html, "")
check("live.html: CSP default-src 'none' and the form limited to itself (form-action 'self')", "default-src 'none'" in csp and "form-action 'self'" in csp, csp)

# notes: form and JSON
code, _, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/x-www-form-urlencoded"}, "note=Hello+there&about=00%3A03")
check("POST /listen/note (form, about=00:03) is accepted (2xx/3xx)", 200 <= code < 400, str(code))
ns = wait_for(lambda: notes_of(lid), 3) or []
check("... it shows in GET /api/listen notes at once, text intact, at_t = 3000 ms", len(ns) == 1 and ns[0].get("text") == "Hello there" and ns[0].get("at_t") == 3000 and isinstance(ns[0].get("t"), int), str(ns))
last_t = view(lid).get("lines", [{}])[-1].get("t")
code, _, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/json"}, json.dumps({"text": "Json note"}))
ns = notes_of(lid)
check("POST /listen/note (JSON, no about) -> a note about the latest transcript line", code < 400 and len(ns) == 2 and ns[1].get("text") == "Json note" and ns[1].get("at_t") == last_t, f"{code} {ns} last_t={last_t}")
n_ids = len(notes_of(lid))
code, data, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/json"}, json.dumps({"text": "WRONGID note", "id": "deadbeefdeadbeefdeadbeef"}))
check("a note naming a WRONG session id is 409 and stored nothing (id is optional; absent = the current session)", code == 409 and len(notes_of(lid)) == n_ids, f"{code} {data[:100]}")
code, _, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/x-www-form-urlencoded"}, f"id={lid}&note=With+id&about=")
check("a form note carrying the right id (and an empty about) is accepted", code < 400 and len(notes_of(lid)) == n_ids + 1 and notes_of(lid)[-1].get("text") == "With id", str(notes_of(lid))[-200:])
code, _, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/json"}, json.dumps({"text": "x" * 400}))
ns = notes_of(lid)
check("a 400-char note is clipped to <= 300", code < 400 and len(ns) == 4 and len(ns[3].get("text", "")) <= 300, str([len(n.get("text", "")) for n in ns]))
code, _, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{PORT}"}, json.dumps({"text": "same origin ok"}))
check("an Origin exactly http://127.0.0.1:<PORT> is accepted", code < 400 and len(notes_of(lid)) == 5, str(code))

# refusals: 404 and NOTHING stored
n_before = len(notes_of(lid)); lines_before = len(view(lid).get("lines", []))
refusals = [
    ("X-Forwarded-For", {"X-Forwarded-For": "100.64.0.9"}, None), ("X-Forwarded-Host", {"X-Forwarded-Host": "mini1.ts.net"}, None),
    ("X-Forwarded-Proto", {"X-Forwarded-Proto": "https"}, None), ("Forwarded", {"Forwarded": "for=100.64.0.9"}, None),
    ("Via", {"Via": "1.1 tailscale"}, None), ("Tailscale-User-Login", {"Tailscale-User-Login": "rick@example.com"}, None),
    ("Tailscale-User-Name", {"Tailscale-User-Name": "Rick"}, None),
    ("wrong Host", {}, "evil.example:%d" % PORT), ("Host without the port", {}, "127.0.0.1"), ("DNS-rebinding Host", {}, "127.0.0.1.evil.example:%d" % PORT),
    ("Host 127.1 (short loopback)", {}, "127.1:%d" % PORT), ("Host 0177.0.0.1 (octal loopback)", {}, "0177.0.0.1:%d" % PORT),
    ("Host [::1]", {}, "[::1]:%d" % PORT),
]
for label, extra, host in refusals:
    codes = []
    for method, path, body_, ctype in (("GET", "/listen/live.txt", None, None), ("GET", "/listen/live.html", None, None),
                                      ("POST", "/listen/note", json.dumps({"text": "REFUSED " + label}), "application/json")):
        h = dict(extra); 
        if ctype: h["Content-Type"] = ctype
        code, data, _ = raw_http(method, path, h, body_, host=host)
        codes.append((code, "topic" in data or "REFUSED" in data))
    check(f"refused with 404 on all three paths, nothing leaked: {label}", all(c == 404 and not leak for c, leak in codes), str(codes))
import socket
def two_hosts(method, path, body=b""):
    sk = socket.create_connection(("127.0.0.1", PORT), timeout=10)
    head = (f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nHost: evil.example\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode()
    sk.sendall(head + body)
    data = b""
    while True:
        try: chunk = sk.recv(65536)
        except OSError: break
        if not chunk: break
        data += chunk
    sk.close()
    return int(data.split(b" ", 2)[1]) if data.startswith(b"HTTP/") else 0, data.decode("utf-8", "replace")
tw = [two_hosts("GET", "/listen/live.txt"), two_hosts("GET", "/listen/live.html"), two_hosts("POST", "/listen/note", json.dumps({"text": "REFUSED two hosts"}).encode())]
check("refused with 404 on all three paths, nothing leaked: TWO Host headers", all(c == 404 and "topic" not in d and "REFUSED" not in d for c, d in tw), str([c for c, _ in tw]))
code, data, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/json", "Origin": "http://evil.example"}, json.dumps({"text": "REFUSED cross-origin"}))
check("refused with 404: cross-origin Origin on a note POST", code == 404, f"{code} {data[:80]}")
code, data, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/json", "Origin": "null"}, json.dumps({"text": "REFUSED null origin"}))
check("refused with 404: Origin 'null' on a note POST", code == 404, f"{code} {data[:80]}")
code, data, _ = raw_http("POST", "/listen/note", {"Content-Type": "application/json"}, json.dumps({"text": "Z" * 6000}))
check("a note body over 4 KB is refused (not stored)", code in (400, 404, 413), str(code))
check("... and none of the refused requests stored a note or changed the transcript", [n.get("text") for n in notes_of(lid)][:5] == ["Hello there", "Json note", "With id", "x" * 300, "same origin ok"] and len(notes_of(lid)) == n_before and len(view(lid).get("lines", [])) == lines_before, str(notes_of(lid))[:300])
check("a note with an empty text is refused (400)", raw_http("POST", "/listen/note", {"Content-Type": "application/json"}, json.dumps({"text": "  "}))[0] == 400)

# G2 as at 56fe3b2 during a default (page) session, and zero Listen relay calls
code, body, gid = g2_ask("G2 QUESTION: during a page session")
r = g2_reply(gid, 20) if gid else {}
check("G2 OMAC Muse ask during a page session: 200 first try, id 0-*, reply drawn", gid is not None and str(gid).startswith("0-") and r.get("status") == "done" and r.get("reply") == "G2 answer.", f"{code} {body} {r}")
call("POST", "/api/listen/stop", {"id": lid})
time.sleep(1)
paths = [p for _, p in R["reqlog"]]
check("notesFrom=page: the fake relay saw ZERO Listen requests: only the G2 ask's own selftest, ask and replies",
      paths.count("/selftest") == 1 and paths.count("/ask") == 1 and all(p in ("/selftest", "/ask") or p.startswith("/reply/") for p in paths), str(R["reqlog"]))
check("... exactly one POST /ask (the G2 question)", len(R["asks"]) == 1 and R["asks"][0]["kind"] == "g2", str([a["kind"] for a in R["asks"]]))
log = open(os.path.join(WORK, f"hub-{PORT}.log")).read()
check("the hub log has no transcript or note text (names and sizes only)", not any(w in log for w in ("word0 word1", "topic1", "Hello there", "Json note", "alert(1)")), log[-200:])

# a page session with NO relay configured at all, and 'both' is accepted
code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "loud"})
check("notesFrom: an invalid value is refused (400)", code == 400, f"{code} {body}")

# PAUSED (replies + rolling pacing; A's code for them is not written yet): run with LISTEN_TEST_REPLIES_ROLLING=1.
if os.environ.get("LISTEN_TEST_REPLIES_ROLLING"):
    # ================================================================================================================
    print("Replies: 'always' is the default; every real reply becomes a note; no dash instruction in the prompt; invalid -> 400")
    (R,) = new_scenario(reply_list=["Reply A.", "Reply B.", "Reply C."])
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat", "replies": "loud"})
    check("replies:'loud' -> 400 'replies must be always or useful'", code == 400 and isinstance(body, dict) and body.get("error") == "replies must be always or useful", f"{code} {body}")
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat", "replies": 5})
    check("replies:5 -> 400", code == 400, f"{code} {body}")
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat"})
    lid = body.get("id") if isinstance(body, dict) else None
    check("start without replies works (default)", code == 200 and isinstance(lid, str), f"{code} {body}")
    check("GET /api/listen echoes replies: 'always'", view(lid).get("replies") == "always", str(view(lid)))
    for k in (1, 2, 3):
        call("POST", f"/api/listen/chunk?id={lid}&seq={k - 1}", raw=bytes(1000 * k))
        check(f"always: snippet {k} reached Muse", wait_for(lambda: len(R["asks"]) >= k, 15) is not None, f"asks={len(R['asks'])}")
        time.sleep(SNIPPET_MS / 1000 + 0.3)
    v = wait_for(lambda: (lambda x: x if len(x.get("notes", [])) >= 3 else None)(view(lid)), 15) or view(lid)
    check("always: every snippet with a real reply is a note (3 notes)", [n.get("text") for n in v.get("notes", [])] == ["Reply A.", "Reply B.", "Reply C."], str(v.get("notes")))
    check("always: the prompt never contains the dash instruction", len(R["asks"]) >= 3 and all("—" not in a["text"] for a in R["asks"]), str([a["text"][:160] for a in R["asks"][:1]]))
    check("always: the prompt still asks for ONE short reply (<= 25 words)", len(R["asks"]) >= 1 and "25" in R["asks"][0]["text"] and "—" not in R["asks"][0]["text"], str([a["text"][:200] for a in R["asks"][:1]]))
    call("POST", "/api/listen/stop", {"id": lid})
    # a dash-only reply is dropped in 'always' mode too
    (R,) = new_scenario(reply_list=["—", "Reply B."])
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat", "replies": "always"})
    lid = body.get("id")
    for k in (1, 2):
        call("POST", f"/api/listen/chunk?id={lid}&seq={k - 1}", raw=bytes(1000 * k))
        wait_for(lambda: len(R["asks"]) >= k, 15)
        time.sleep(SNIPPET_MS / 1000 + 0.3)
    v = wait_for(lambda: (lambda x: x if x.get("notes") else None)(view(lid)), 10) or view(lid)
    check("always: a dash-only reply is still dropped (1 note, never '—')", [n.get("text") for n in v.get("notes", [])] == ["Reply B."], str(v.get("notes")))
    call("POST", "/api/listen/stop", {"id": lid})

    # ================================================================================================================
    print("Rolling pacing (fake relay only)")
    def feed(lid, ks, every, sent):
        """One chunk per `every` s; chunk k is heard as 30 words ending 'topic<k>'. sent[k] = when the POST returned."""
        for k in ks:
            call("POST", f"/api/listen/chunk?id={lid}&seq={k - 1}", raw=bytes(1000 * k))
            sent[k] = time.time()
            time.sleep(every)

    def spacing_ok(R, min_gap_s, settle_s):
        jobs = [j for j in R["jobs"].values()]
        asks = R["asks"]
        bad = []
        for i in range(1, len(asks)):
            prev_end = jobs[i - 1]["until"]
            if asks[i]["at"] - asks[i - 1]["at"] < min_gap_s - 0.1: bad.append(f"ask {i + 1} only {asks[i]['at'] - asks[i - 1]['at']:.2f}s after the previous send")
            if asks[i]["at"] < prev_end + settle_s - 0.1: bad.append(f"ask {i + 1} {asks[i]['at'] - prev_end:.2f}s after Muse finished")
        return bad

    print(" fast speech: a line every 0.5 s for 8 s, Muse answers in 1 s, snippetMinMs 2000 from hub.json")
    (R,) = new_scenario(busy_s=1.0, listen={"snippetMinMs": 2000})
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat", "replies": "always"})
    lid = body.get("id"); sent = {}
    feed(lid, range(1, 17), 0.5, sent)
    time.sleep(4)
    check("fast: Listen sent several snippets (not one per line)", 2 <= len(R["asks"]) <= 6, f"asks={len(R['asks'])} for 16 lines")
    check("fast: never more than one Listen job in flight (no /ask POSTed to a busy Muse)", R["listen_while_busy"] == 0, str(R["listen_while_busy"]))
    check("fast: sends spaced >= snippetMinMs (2 s, from hub.json) and >= settleMs after Muse finished", not spacing_ok(R, 2.0, SETTLE_MS / 1000), str(spacing_ok(R, 2.0, SETTLE_MS / 1000)))
    seen = " ".join(a["text"] for a in R["asks"])
    has = lambda text, k: re.search(rf"topic{k}\b", text) is not None
    check("fast: nothing is lost: every line of speech went to Muse in some snippet", all(has(seen, k) for k in range(1, 17)), "missing: " + str([k for k in range(1, 17) if not has(seen, k)]))
    check("fast: the transcript keeps all 16 lines", len(view(lid).get("lines", [])) == 16, str(len(view(lid).get("lines", []))))
    call("POST", "/api/listen/stop", {"id": lid})

    print(" slow Muse (5 s): lines from those 5 s merge into ONE snippet")
    (R,) = new_scenario(busy_s=5.0)
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat", "replies": "always"})
    lid = body.get("id"); sent = {}
    feed(lid, range(1, 13), 1.0, sent)
    wait_for(lambda: len(R["asks"]) >= 2, 15)
    check("slow: the first snippet went out at once", len(R["asks"]) >= 1)
    check("slow: a second snippet followed", len(R["asks"]) >= 2, f"asks={len(R['asks'])}")
    if len(R["asks"]) >= 2:
        a1, a2 = R["asks"][0], R["asks"][1]
        during = [k for k, t in sent.items() if a1["at"] + 0.3 < t < a2["at"] - 0.3]
        check("slow: the second snippet carries ALL lines spoken while Muse was busy, merged in one", len(during) >= 3 and all(re.search(rf"topic{k}\b", a2["text"]) for k in during), f"during={during} text={a2['text'][-200:]!r}")
        check("slow: never two Listen jobs at once", R["listen_while_busy"] == 0, str(R["listen_while_busy"]))
        check("slow: the second send is >= 2 settle after Muse finished", not spacing_ok(R, SNIPPET_MIN_MS / 1000, SETTLE_MS / 1000), str(spacing_ok(R, SNIPPET_MIN_MS / 1000, SETTLE_MS / 1000)))
    call("POST", "/api/listen/stop", {"id": lid})

    print(" silence, a 2-word line, a 3-word line")
    (R,) = new_scenario()
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat", "replies": "always"})
    lid = body.get("id")
    time.sleep(3)
    check("silence: no snippet", len(R["asks"]) == 0, str(len(R["asks"])))
    call("POST", f"/api/listen/chunk?id={lid}&seq=0", raw=bytes(91000))   # 'alpha beta'
    time.sleep(3)
    check("a 2-word line: no snippet (needs >= 3 new words)", len(R["asks"]) == 0, str(len(R["asks"])))
    check("... but the line is still in the transcript", [l["text"] for l in view(lid).get("lines", [])] == ["alpha beta"], str(view(lid).get("lines")))
    call("POST", f"/api/listen/chunk?id={lid}&seq=1", raw=bytes(92000))   # 'gamma delta epsilon'
    check("3 words more: ONE snippet, carrying both lines", wait_for(lambda: len(R["asks"]) == 1, 10) is not None and "alpha beta" in R["asks"][0]["text"] and "gamma delta epsilon" in R["asks"][0]["text"], str([a["text"][:200] for a in R["asks"]]))
    time.sleep(2)
    check("... and no further snippet without new speech", len(R["asks"]) == 1, str(len(R["asks"])))
    call("POST", "/api/listen/stop", {"id": lid})

    print(" a long merge keeps the NEWEST words within 1200 chars (the prompt only; the transcript keeps everything)")
    (R,) = new_scenario()
    code, body = call("POST", "/api/listen/start", {"backend": "muse", "notesFrom": "chat", "replies": "always"})
    lid = body.get("id")
    call("POST", f"/api/listen/chunk?id={lid}&seq=0", raw=bytes(93000))   # 400 words, ~2800 chars
    wait_for(lambda: len(R["asks"]) >= 1, 10)
    if R["asks"]:
        t = R["asks"][0]["text"]
        check("long merge: the prompt is <= 1200 chars", len(t) <= 1200, f"{len(t)} chars")
        check("long merge: the newest words are kept, the oldest dropped from the prompt", "long399" in t and "long0 " not in t, t[:120])
    check("long merge: the transcript keeps every word", any("long0 " in l["text"] and "long399" in l["text"] for l in view(lid).get("lines", [])))
    call("POST", "/api/listen/stop", {"id": lid})


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
