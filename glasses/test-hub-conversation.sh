#!/usr/bin/env bash
# Tests the conversation tile's hub side (docs/CONVERSATION.md) and its node route (POST /api/think).
# Fake services stand in for everything outside the machine: a Whisper server (HUD_TRANSCRIBE_URL), an
# OpenAI-compatible local model (HUD_LOCAL_LLM_URL), and fake claude and codex commands on PATH. The hubs and a
# node run with HOME in a temp folder, so your real ~/.config/agent-glasses is never read or written, and no
# real service, Muse or hub is contacted.
#   bash glasses/test-hub-conversation.sh     (needs node and python3)
set -u
here=$(cd "$(dirname "$0")" && pwd)

work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME/.config/agent-glasses"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

# Muse rule: this test never configures Muse. Fails if any config it writes mentions it.
printf '%s\n' '{"conversation":{"local":"self"}}' > "$work/guard.json"
if grep -qi 'muse' "$work/guard.json"; then
  echo "  FAIL  the test configs must not mention muse (Muse is off limits to this test)"
  exit 1
fi
echo "  ok    the test configs do not mention muse"

# Fake command-line tools: claude always fails (so the local model takes over), unless it is asked to wait
# (SLEEP in the prompt); codex answers with hints or with a summary, depending on which request it is.
mkdir -p "$work/bin"
cat > "$work/bin/claude" <<'FAKE'
#!/usr/bin/env bash
input=$(cat)
case "$input" in *SLEEP*) sleep 5 ;; esac
exit 1
FAKE
cat > "$work/bin/codex" <<'FAKE'
#!/usr/bin/env bash
input=$(cat)
case "$input" in
  *Summarize*) printf 'SUMMARY:\nCODEX talk summary.\nACTIONS:\n- Codex action\n' ;;
  *) printf 'CODEX hint one\nCODEX hint two\n' ;;
esac
FAKE
chmod +x "$work/bin/claude" "$work/bin/codex"

python3 - "$here" "$work" <<'PY'
import http.client, http.server, json, os, shutil, socket, subprocess, sys, threading, time, stat

NODE = shutil.which("node")  # the hubs are started by full path, so a test PATH can leave node's folder out

HERE, WORK = sys.argv[1], sys.argv[2]
HOME = os.environ["HOME"]
HUB_PORT, HUB_B, HUB_C, HUB_D, NODE_PORT, FAKE_PORT, DEAD_PORT = (
    int(os.environ.get(k, v)) for k, v in [
        ("CONV_HUB_PORT", 5401), ("CONV_HUB_B_PORT", 5402), ("CONV_HUB_C_PORT", 5403),
        ("CONV_HUB_D_PORT", 5404), ("CONV_NODE_PORT", 5405), ("CONV_FAKE_PORT", 5406), ("CONV_DEAD_PORT", 5407)])
HUB_B2, HUB_E, HUB_F1, HUB_F2, HUB_F3, HUB_F4, BAD_NODE_PORT, HUB_F5, HUB_F6, HUB_F7 = (
    int(os.environ.get(k, v)) for k, v in [
        ("CONV_HUB_B2_PORT", 5409), ("CONV_HUB_E_PORT", 5408), ("CONV_HUB_F1_PORT", 5410),
        ("CONV_HUB_F2_PORT", 5411), ("CONV_HUB_F3_PORT", 5412), ("CONV_HUB_F4_PORT", 5413),
        ("CONV_BAD_NODE_PORT", 5414), ("CONV_HUB_F5_PORT", 5415), ("CONV_HUB_F6_PORT", 5416), ("CONV_HUB_F7_PORT", 5417)])
TOKEN, NODE_TOKEN = "conversation-test-token", "conversation-node-token"
HUB_TOKEN_FILE, NODE_TOKEN_FILE = os.path.join(WORK, "hub.token"), os.path.join(WORK, "node.token")
open(HUB_TOKEN_FILE, "w").write(TOKEN + "\n")
open(NODE_TOKEN_FILE, "w").write(NODE_TOKEN + "\n")
CONVERSATIONS = os.path.join(HOME, ".config", "agent-glasses", "conversations")

passed = failed = 0
def ok(label):
    global passed
    passed += 1
    print(f"  ok    {label}", flush=True)
def check(label, cond):
    global failed
    if cond:
        ok(label)
    else:
        failed += 1
        print(f"  FAIL  {label}", flush=True)

# ---- fake Whisper and fake local model, on one port -----------------------------------------------------------
FLAKY = {"hints_to_fail": 1}  # shared by the Fake handler and Scenario E
class Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def reply(self, code, value):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.startswith("/whisper/"):
            i = body.find(b"RIFF")
            if i < 0 or b"WAVE" not in body[i:i + 12]:
                return self.reply(400, {"error": "not a wav"})
            pcm = int.from_bytes(body[i + 40:i + 44], "little")
            if pcm == 1500:  # the chunk the test makes fail
                return self.reply(500, {"error": "speech service said 500"})
            if pcm == 1234:  # a chunk the test makes silent: the service hears nothing
                return self.reply(200, {"text": ""})
            return self.reply(200, {"text": f"part {pcm}"})
        if self.path.startswith("/local/v1/chat/completions"):
            system = json.loads(body)["messages"][0]["content"]
            content = ("SUMMARY:\nLOCAL talk summary.\nACTIONS:\n- Local action" if "Summarize" in system
                       else "LOCAL hint one\nLOCAL hint two")
            return self.reply(200, {"choices": [{"message": {"content": content}}]})
        if self.path.startswith("/flaky/v1/chat/completions"):
            # The first hint request fails (the model is busy); the rest answer as the local model does.
            system = json.loads(body)["messages"][0]["content"]
            if "Summarize" not in system and FLAKY["hints_to_fail"] > 0:
                FLAKY["hints_to_fail"] -= 1
                return self.reply(500, {"error": "busy"})
            content = ("SUMMARY:\nLOCAL talk summary.\nACTIONS:\n- Local action" if "Summarize" in system
                       else "LOCAL hint one\nLOCAL hint two")
            return self.reply(200, {"choices": [{"message": {"content": content}}]})
        self.reply(404, {"error": "no route"})

fake = http.server.ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake)
threading.Thread(target=fake.serve_forever, daemon=True).start()

# ---- a node that answers /api/think with 200 but no answer: the bad answer is set per test -----------------------
BAD_NODE = {"body": b"not json", "short": False}
class BadNode(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if BAD_NODE["short"]:  # the header promises 50 bytes; only 5 arrive, then the connection closes
            self.send_response(200)
            self.send_header("Content-Length", "50")
            self.end_headers()
            self.wfile.write(b'{"te')
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BAD_NODE["body"])))
        self.end_headers()
        self.wfile.write(BAD_NODE["body"])
bad_node = http.server.ThreadingHTTPServer(("127.0.0.1", BAD_NODE_PORT), BadNode)
threading.Thread(target=bad_node.serve_forever, daemon=True).start()
WHISPER = f"http://127.0.0.1:{FAKE_PORT}/whisper/audio/transcriptions"
LOCAL = f"http://127.0.0.1:{FAKE_PORT}/local/v1"
FLAKY_LOCAL = f"http://127.0.0.1:{FAKE_PORT}/flaky/v1"

# ---- starting hubs and nodes (the real server, with the test's environment) -------------------------------------
procs = []
def start(port, mode, env_extra, hub_json=None, token_file=HUB_TOKEN_FILE, tag="hub"):
    cfg = os.path.join(WORK, f"{tag}-{port}.json")
    with open(cfg, "w") as f:
        json.dump(hub_json or {}, f)
    env = dict(os.environ, HUD_TOKEN_FILE=token_file, HUD_HUB_CONFIG=cfg,
               HUD_TRANSCRIBE_URL=WHISPER, GROQ_API_KEY="test-groq-key",
               PATH=os.path.join(WORK, "bin") + ":" + os.environ["PATH"])
    env.pop("HUD_THINK_FAKE", None)
    for name in ("HUD_CLAUDE_BIN", "HUD_CODEX_BIN", "HUD_LOCAL_LLM_URL"):  # a test sets these itself, or not at all
        env.pop(name, None)
    env.update(env_extra)
    log = open(os.path.join(WORK, f"{tag}-{port}.log"), "w")
    proc = subprocess.Popen([NODE, os.path.join(HERE, "hud-server.mjs"), "--mode", mode, "--port", str(port),
                             "--machine", "Conv Test"], env=env, stdout=log, stderr=subprocess.STDOUT)
    procs.append(proc)
    for _ in range(100):
        try:
            if call(port, "GET", "/api/health", token=None)[0] == 200:
                return proc
        except OSError:
            pass
        time.sleep(0.1)
    raise SystemExit(f"the {mode} on {port} did not start; see {WORK}/{tag}-{port}.log")
def stop_all():
    for p in procs:
        p.terminate()
    for p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
    procs.clear()
import atexit
atexit.register(stop_all)  # the hubs and the node end even if the test stops early

def call(port, method, path, body=None, raw=None, token=TOKEN, timeout=30):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if raw is not None:
        data = raw
        headers["Content-Type"] = "application/octet-stream"
    elif body is not None:
        data = body if isinstance(body, str) else json.dumps(body)
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    res = conn.getresponse()
    text = res.read().decode()
    conn.close()
    try:
        return res.status, json.loads(text)
    except ValueError:
        return res.status, text

def wait_for(fn, seconds=15):
    end = time.time() + seconds
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(0.1)
    return None

def view(port):
    return call(port, "GET", "/api/conversation")[1]

def pcm(n):
    return bytes(n)  # silence: the fake Whisper answers from its size

def chunk(port, cid, seq, n):
    return call(port, "POST", f"/api/conversation/chunk?id={cid}&seq={seq}", raw=pcm(n))

# ================================================================================================================
print("Scenario A: the whole session, with canned answers (HUD_THINK_FAKE=1)")
a = start(HUB_PORT, "hub", {"HUD_THINK_FAKE": "1"}, {"conversation": {"local": "self", "claude": "self", "codex": "self"}})
check("the conversation is idle before any start", view(HUB_PORT) == {"state": "idle"} or view(HUB_PORT).get("state") == "idle")
code, body = call(HUB_PORT, "POST", "/api/think", {"backend": "local", "system": "hint", "prompt": "budget talk", "timeoutSec": 5})
check("POST /api/think answers with the text and its time", code == 200 and "key point" in body.get("text", "") and isinstance(body.get("ms"), int))
code, body = call(HUB_PORT, "POST", "/api/think", {"backend": "robot", "prompt": "x"})
check("a backend that does not exist is 400", code == 400)
code, body = call(HUB_PORT, "POST", "/api/think", {"backend": "local", "prompt": "  "})
check("an empty prompt is 400", code == 400)

code, body = call(HUB_PORT, "POST", "/api/conversation/start", {"backend": "local"})
cid = body.get("id")
check("start answers with an id and a start time", code == 200 and isinstance(cid, str) and isinstance(body.get("startedAt"), int))
code, body = call(HUB_PORT, "POST", "/api/conversation/start", {"backend": "local"})
check("a second start while listening is 409 already listening", code == 409 and body.get("error") == "already listening")
code, body = call(HUB_PORT, "POST", "/api/conversation/start", {"backend": "robot"})
check("an unknown backend is 400", code == 400)

chunk(HUB_PORT, cid, 2, 2000)
chunk(HUB_PORT, cid, 0, 1000)
code, _ = chunk(HUB_PORT, cid, 1, 3000)
check("chunks are accepted at once, even out of order", code == 200)
code, body = chunk(HUB_PORT, cid, 0, 1000)
check("a repeated seq is accepted and not heard twice", code == 200)
check("the three chunks are transcribed, with words and hints", wait_for(lambda: view(HUB_PORT).get("chunks") == 3 and view(HUB_PORT).get("hints")) is not None)
v = view(HUB_PORT)
check("the words are counted (two per part)", v.get("words") == 6)
check("the hints are two or three lines, each under 40 characters", 2 <= len(v.get("hints", [])) <= 3 and all(len(h) <= 40 for h in v["hints"]))
code, body = chunk(HUB_PORT, "not-the-id", 9, 1000)
check("a chunk for an unknown id is 404", code == 404)
code, body = chunk(HUB_PORT, cid, -1, 1000)
check("a chunk with seq -1 is 400 (seq counts from 0)", code == 400)
code, body = call(HUB_PORT, "POST", f"/api/conversation/chunk?id={cid}&seq=50", raw=bytes(1024 * 1024 + 1))
check("a chunk over 1 MB is 413", code == 413)

chunk(HUB_PORT, cid, 3, 1500)  # the fake Whisper fails on this one
chunk(HUB_PORT, cid, 4, 2500)
check("a chunk that fails is skipped and the talk goes on", wait_for(lambda: view(HUB_PORT).get("chunks") == 4) is not None)
check("the failed chunk is counted as skipped", view(HUB_PORT).get("skipped") == 1)

code, body = call(HUB_PORT, "POST", "/api/conversation/stop", {"id": cid})
check("stop answers ok", code == 200 and body.get("ok") is True)
check("the summary and action items arrive", wait_for(lambda: view(HUB_PORT).get("state") == "done" and view(HUB_PORT).get("summary")) is not None)
v = view(HUB_PORT)
check("the summary is canned and the action items too", v.get("summary") == ["The talk covered the budget."] and v.get("actions") == ["Send the budget"])
check("the view has no transcript", "transcript" not in v and "pending" not in v)
code, body = call(HUB_PORT, "POST", "/api/conversation/stop", {"id": cid})
check("a second stop is still ok", code == 200)
code, body = call(HUB_PORT, "POST", "/api/conversation/stop", {"id": "nope"})
check("stopping an unknown id is 404", code == 404)
code, body = chunk(HUB_PORT, cid, 5, 1000)
check("a chunk after the stop is 404", code == 404)

files = sorted(os.listdir(CONVERSATIONS)) if os.path.isdir(CONVERSATIONS) else []
check("the record is in the conversations folder", len(files) == 1 and files[0].endswith(".md"))
if files:
    path = os.path.join(CONVERSATIONS, files[0])
    text = open(path).read()
    check("the folder is 0700 and the file 0600", stat.S_IMODE(os.stat(CONVERSATIONS).st_mode) == 0o700 and stat.S_IMODE(os.stat(path).st_mode) == 0o600)
    check("the record has the summary, the action items and the transcript", "The talk covered the budget." in text and "Send the budget" in text and "## Transcript" in text)
    check("the transcript keeps the seq order and skips the failed chunk", text.find("part 1000") < text.find("part 3000") < text.find("part 2000") < text.find("part 2500") and "part 1500" not in text)

code, body = call(HUB_PORT, "POST", "/api/conversation/start", {"backend": "local"})
empty = body.get("id")
call(HUB_PORT, "POST", "/api/conversation/stop", {"id": empty})
check("a talk with no chunks ends in error: nothing was heard", wait_for(lambda: view(HUB_PORT).get("state") == "error") is not None and view(HUB_PORT).get("error") == "Nothing was heard")
check("the newest session replaces the last one in memory", view(HUB_PORT).get("id") == empty)

code, body = call(HUB_PORT, "POST", "/api/conversation/start", {"backend": "local"})
silent = body.get("id")
chunk(HUB_PORT, silent, 0, 1234)  # heard, but silence: the service returns no words
call(HUB_PORT, "POST", "/api/conversation/stop", {"id": silent})
check("silence (no words, no failed chunks) ends in error: nothing was heard", wait_for(lambda: view(HUB_PORT).get("state") == "error") is not None and view(HUB_PORT).get("error") == "Nothing was heard" and view(HUB_PORT).get("skipped") == 0)

code, body = call(HUB_PORT, "POST", "/api/conversation/start", {"backend": "local"})
first = body.get("id")
chunk(HUB_PORT, first, 0, 1700)  # seq 0 is the first chunk of a session: it must be transcribed
check("seq 0 is transcribed (the first 9 s are not lost)", wait_for(lambda: view(HUB_PORT).get("chunks") == 1 and view(HUB_PORT).get("words") == 2, 5) is not None)
call(HUB_PORT, "POST", "/api/conversation/stop", {"id": first})
check("that talk ends with its summary", wait_for(lambda: view(HUB_PORT).get("state") == "done") is not None)

code, body = call(HUB_PORT, "POST", "/api/conversation/start", {"backend": "local"})
nothing = body.get("id")
chunk(HUB_PORT, nothing, 0, 1500)  # the only chunk fails
call(HUB_PORT, "POST", "/api/conversation/stop", {"id": nothing})
check("a talk where nothing could be transcribed ends in error, with the skipped count", wait_for(lambda: view(HUB_PORT).get("state") == "error") is not None and view(HUB_PORT).get("error") == "Nothing could be transcribed" and view(HUB_PORT).get("skipped") == 1)

code, body = call(HUB_PORT, "POST", "/api/conversation/start", {"backend": "local"})
gap = body.get("id")
chunk(HUB_PORT, gap, 1, 2200)  # chunk 0 never arrives
call(HUB_PORT, "POST", "/api/conversation/stop", {"id": gap})
check("a missing chunk does not hold the summary up", wait_for(lambda: view(HUB_PORT).get("state") == "done", 4) is not None)

code, body = call(HUB_PORT, "GET", "/api/diag")
names = [d["name"] for d in body.get("diagnostics", [])]
details = " ".join(d["detail"] for d in body.get("diagnostics", []) if d["name"].startswith("conv."))
check("diagnostics record start, chunk, hint, stop and the failed chunk", all(n in names for n in ["conv.start", "conv.chunk", "conv.hint", "conv.stop", "conv.error"]))
check("the diagnostics hold no transcript text", "part " not in details and "budget" not in details)
stop_all()

# ================================================================================================================
print("Scenario B: the real runners; Claude fails and the local model takes over (Codex is not set up here)")
b = start(HUB_B, "hub", {"HUD_LOCAL_LLM_URL": LOCAL, "HUD_CODEX_BIN": "/nonexistent/codex"}, {"conversation": {"local": "self", "claude": "self", "codex": "self"}})
code, body = call(HUB_B, "POST", "/api/conversation/start", {"backend": "claude"})
cid = body.get("id")
chunk(HUB_B, cid, 0, 2000)
check("Claude fails: the hints come from the local model", wait_for(lambda: "LOCAL hint one" in view(HUB_B).get("hints", [])) is not None)
check("and the tile says who answered and why", view(HUB_B).get("fallback") == "(local model answered: Claude didn't answer)")
call(HUB_B, "POST", "/api/conversation/stop", {"id": cid})
check("the summary comes from the local model too", wait_for(lambda: view(HUB_B).get("state") == "done") is not None and view(HUB_B).get("summary") == ["LOCAL talk summary."] and view(HUB_B).get("actions") == ["Local action"])
code, body = call(HUB_B, "POST", "/api/think", {"backend": "claude", "system": "x", "prompt": "SLEEP", "timeoutSec": 1})
check("a Claude that does not answer in time is 502 with the time", code == 502 and body.get("error") == "Claude didn't answer in 1 s")
stop_all()

# ================================================================================================================
print("Scenario B2: codex runs read-only and answers, with no fallback")
b2 = start(HUB_B2, "hub", {"HUD_LOCAL_LLM_URL": LOCAL}, {"conversation": {"local": "self", "claude": "self", "codex": "self"}})
code, body = call(HUB_B2, "POST", "/api/conversation/start", {"backend": "codex"})
cid = body.get("id")
chunk(HUB_B2, cid, 0, 2000)
check("codex runs read-only and answers with its own hints", wait_for(lambda: "CODEX hint one" in view(HUB_B2).get("hints", [])) is not None)
check("codex has no fallback", "fallback" not in view(HUB_B2))
call(HUB_B2, "POST", "/api/conversation/stop", {"id": cid})
check("codex's summary is parsed", wait_for(lambda: view(HUB_B2).get("state") == "done") is not None and view(HUB_B2).get("summary") == ["CODEX talk summary."])
stop_all()

# ================================================================================================================
print("Scenario C: the local model is not running; the error is one plain line")
d = start(HUB_D, "hub", {"HUD_LOCAL_LLM_URL": f"http://127.0.0.1:{DEAD_PORT}/v1"}, {"conversation": {"local": "self"}})
code, body = call(HUB_D, "POST", "/api/conversation/start", {"backend": "local"})
cid = body.get("id")
chunk(HUB_D, cid, 0, 2000)
check("a local model that is not running is shown as an error", wait_for(lambda: view(HUB_D).get("error")) is not None and view(HUB_D).get("error") == "The local model isn't running on this hub")
call(HUB_D, "POST", "/api/conversation/stop", {"id": cid})
check("the session still finishes", wait_for(lambda: view(HUB_D).get("state") in ("done", "error")) is not None)
stop_all()

# ================================================================================================================
print("Scenario D: a node runs the local model for the hub (POST /api/think on the node)")
node = start(NODE_PORT, "node", {"HUD_LOCAL_LLM_URL": LOCAL}, {}, token_file=NODE_TOKEN_FILE, tag="node")
hub_json = {"nodes": [{"name": "lap", "url": f"http://127.0.0.1:{NODE_PORT}", "tokenFile": NODE_TOKEN_FILE}],
            "conversation": {"local": "lap", "claude": "self", "codex": "self"}}
e = start(HUB_C, "hub", {"HUD_LOCAL_LLM_URL": f"http://127.0.0.1:{DEAD_PORT}/v1"}, hub_json)
code, body = call(HUB_C, "POST", "/api/conversation/start", {"backend": "local"})
cid = body.get("id")
chunk(HUB_C, cid, 0, 2000)
check("the hub sends local to the node, which answers with its own model", wait_for(lambda: "LOCAL hint one" in view(HUB_C).get("hints", [])) is not None)
call(HUB_C, "POST", "/api/conversation/stop", {"id": cid})
check("the node's answer is what the hub uses for the summary", wait_for(lambda: view(HUB_C).get("state") == "done") is not None and view(HUB_C).get("summary") == ["LOCAL talk summary."])
code, body = call(NODE_PORT, "POST", "/api/think", {"backend": "local", "prompt": "x"}, token=None)
check("the node refuses a think request without its token", code == 401)
stop_all()

# ================================================================================================================
print("Scenario E: a failed hint shows as an error; the next good hint and the summary clear it")
f = start(HUB_E, "hub", {"HUD_LOCAL_LLM_URL": FLAKY_LOCAL}, {"conversation": {"local": "self"}})
code, body = call(HUB_E, "POST", "/api/conversation/start", {"backend": "local"})
cid = body.get("id")
chunk(HUB_E, cid, 0, 2000)  # its hint request fails
check("a failed hint shows as the error while listening", wait_for(lambda: view(HUB_E).get("error")) is not None and view(HUB_E).get("state") == "listening")
chunk(HUB_E, cid, 1, 2000)  # the next hint succeeds
check("a good hint clears the error", wait_for(lambda: view(HUB_E).get("hints") and not view(HUB_E).get("error")) is not None)
call(HUB_E, "POST", "/api/conversation/stop", {"id": cid})
check("a good summary also leaves no error", wait_for(lambda: view(HUB_E).get("state") == "done") is not None and "error" not in view(HUB_E))
stop_all()

# ================================================================================================================
print("Scenario F: helpers on the hub: found outside PATH, missing, overridden, and the fallback names who answered")
# A LaunchAgent's PATH: node's folder and the system folders only. The helper lives in the temp HOME's ~/.local/bin.
BARE_PATH = ":".join(p for p in [os.path.dirname(NODE), "/usr/bin", "/bin"] if p)
check("the test PATH has no claude or codex in it", shutil.which("claude", path=BARE_PATH) is None and shutil.which("codex", path=BARE_PATH) is None)
LOCAL_BIN = os.path.join(HOME, ".local", "bin")
os.makedirs(LOCAL_BIN, exist_ok=True)
with open(os.path.join(LOCAL_BIN, "claude"), "w") as f:
    f.write("#!/usr/bin/env bash\n"
            "input=$(cat)\n"
            "case \"$input\" in *Summarize*) printf 'SUMMARY:\\nHOME talk summary.\\nACTIONS:\\n- Home action\\n' ;;\n"
            "  *) printf 'HOME hint one\\nHOME hint two\\n' ;; esac\n")
os.chmod(os.path.join(LOCAL_BIN, "claude"), 0o755)
DEAD_LOCAL = f"http://127.0.0.1:{DEAD_PORT}/v1"
NODE_CONF = {"conversation": {"local": "self", "claude": "self", "codex": "self"}}

# F1: claude is only in ~/.local/bin, which PATH lacks. It is found, logged, and answers.
f1 = start(HUB_F1, "hub", {"PATH": BARE_PATH, "HUD_CODEX_BIN": "/nonexistent/codex", "HUD_LOCAL_LLM_URL": DEAD_LOCAL}, NODE_CONF)
code, body = call(HUB_F1, "GET", "/api/diag")
h = body.get("helpers", {})
check("claude is found in ~/.local/bin although PATH lacks it", h.get("claude", {}).get("path") == os.path.join(LOCAL_BIN, "claude"))
check("codex and the local model are not set up here", h.get("codex", {}).get("path") is None and h.get("local", {}).get("reachable") is False)
log1 = open(os.path.join(WORK, f"hub-{HUB_F1}.log")).read()
check("the hub logs the path it found", f"conversation helpers: claude {os.path.join(LOCAL_BIN, 'claude')}" in log1)
code, body = call(HUB_F1, "POST", "/api/conversation/start", {"backend": "claude"})
cid = body.get("id")
chunk(HUB_F1, cid, 0, 2000)
check("the claude from ~/.local/bin gives the hints", wait_for(lambda: "HOME hint one" in view(HUB_F1).get("hints", [])) is not None)
check("no fallback line when the chosen helper answers", "fallback" not in view(HUB_F1))
call(HUB_F1, "POST", "/api/conversation/stop", {"id": cid})
check("and the summary", wait_for(lambda: view(HUB_F1).get("state") == "done") is not None and view(HUB_F1).get("summary") == ["HOME talk summary."])
stop_all()

# F2: nothing is set up and the local model is down: one plain error line, and the diagnostics say so.
f2 = start(HUB_F2, "hub", {"HUD_CLAUDE_BIN": "/nonexistent/claude", "HUD_CODEX_BIN": "/nonexistent/codex", "HUD_LOCAL_LLM_URL": DEAD_LOCAL}, NODE_CONF)
code, body = call(HUB_F2, "POST", "/api/conversation/start", {"backend": "claude"})
cid = body.get("id")
chunk(HUB_F2, cid, 0, 2000)
check("with no helper set up, the error is the chosen one's plain line", wait_for(lambda: view(HUB_F2).get("error")) is not None and view(HUB_F2).get("error") == "Claude isn't set up on this hub")
check("and there is no fallback line", "fallback" not in view(HUB_F2))
call(HUB_F2, "POST", "/api/conversation/stop", {"id": cid})
code, body = call(HUB_F2, "GET", "/api/diag")
h = body.get("helpers", {})
check("the diagnostics show no claude, no codex, and the local model unreachable", h.get("claude", {}).get("path") is None and h.get("codex", {}).get("path") is None and h.get("local", {}).get("reachable") is False)
check("the diagnostics hold no token", TOKEN not in json.dumps(body) and NODE_TOKEN not in json.dumps(body))
stop_all()

# F3: the overrides win, and when Claude fails, Codex answers and the tile says so.
f3 = start(HUB_F3, "hub", {"HUD_CLAUDE_BIN": os.path.join(WORK, "bin", "claude"), "HUD_CODEX_BIN": os.path.join(WORK, "bin", "codex"), "HUD_LOCAL_LLM_URL": DEAD_LOCAL}, NODE_CONF)
code, body = call(HUB_F3, "GET", "/api/diag")
h = body.get("helpers", {})
check("the overrides are the helpers' paths", h.get("claude", {}).get("path") == os.path.join(WORK, "bin", "claude") and h.get("codex", {}).get("path") == os.path.join(WORK, "bin", "codex"))
code, body = call(HUB_F3, "POST", "/api/conversation/start", {"backend": "claude"})
cid = body.get("id")
chunk(HUB_F3, cid, 0, 2000)
check("Claude fails and Codex gives the hints", wait_for(lambda: "CODEX hint one" in view(HUB_F3).get("hints", [])) is not None)
check("the fallback line names Codex and the reason", view(HUB_F3).get("fallback") == "(Codex answered: Claude didn't answer)")
call(HUB_F3, "POST", "/api/conversation/stop", {"id": cid})
check("Codex also gives the summary", wait_for(lambda: view(HUB_F3).get("state") == "done") is not None and view(HUB_F3).get("summary") == ["CODEX talk summary."])
stop_all()

# F4: both CLIs missing: the local model takes over for Claude, and for Codex.
f4 = start(HUB_F4, "hub", {"HUD_CLAUDE_BIN": "/nonexistent/claude", "HUD_CODEX_BIN": "/nonexistent/codex", "HUD_LOCAL_LLM_URL": LOCAL}, NODE_CONF)
code, body = call(HUB_F4, "POST", "/api/conversation/start", {"backend": "claude"})
cid = body.get("id")
chunk(HUB_F4, cid, 0, 2000)
check("missing Claude and Codex: the local model answers", wait_for(lambda: "LOCAL hint one" in view(HUB_F4).get("hints", [])) is not None)
check("the fallback line says the local model answered, and why", view(HUB_F4).get("fallback") == "(local model answered: Claude isn't set up on this hub)")
call(HUB_F4, "POST", "/api/conversation/stop", {"id": cid})
wait_for(lambda: view(HUB_F4).get("state") == "done")
code, body = call(HUB_F4, "POST", "/api/conversation/start", {"backend": "codex"})
cid = body.get("id")
chunk(HUB_F4, cid, 0, 2000)
check("a Codex session with no Codex also falls back to the local model", wait_for(lambda: view(HUB_F4).get("fallback") == "(local model answered: Codex isn't set up on this hub)") is not None)
call(HUB_F4, "POST", "/api/conversation/stop", {"id": cid})
stop_all()

# F5: a relative override is made absolute at startup, so the runner (which spawns from a temp folder) still finds it.
rel_claude = os.path.relpath(os.path.join(LOCAL_BIN, "claude"), os.getcwd())
f5 = start(HUB_F5, "hub", {"PATH": BARE_PATH, "HUD_CLAUDE_BIN": rel_claude, "HUD_CODEX_BIN": "/nonexistent/codex", "HUD_LOCAL_LLM_URL": DEAD_LOCAL}, NODE_CONF)
code, body = call(HUB_F5, "GET", "/api/diag")
check("a relative HUD_CLAUDE_BIN is reported as an absolute path", body.get("helpers", {}).get("claude", {}).get("path") == os.path.join(LOCAL_BIN, "claude"))
code, body = call(HUB_F5, "POST", "/api/conversation/start", {"backend": "claude"})
cid = body.get("id")
chunk(HUB_F5, cid, 0, 2000)
check("the relative override runs and answers the hints", wait_for(lambda: "HOME hint one" in view(HUB_F5).get("hints", [])) is not None)
check("with no fallback line", "fallback" not in view(HUB_F5))
call(HUB_F5, "POST", "/api/conversation/stop", {"id": cid})
stop_all()

# F6: a relative PATH entry is skipped: a claude in it is not found, and this temp HOME has no ~/.local/bin claude.
REL_BIN = os.path.join(WORK, "relbin")
os.makedirs(REL_BIN, exist_ok=True)
with open(os.path.join(REL_BIN, "claude"), "w") as f:
    f.write("#!/usr/bin/env bash\ninput=$(cat)\nprintf 'REL hint one\\n'\n")
os.chmod(os.path.join(REL_BIN, "claude"), 0o755)
HOME2 = os.path.join(WORK, "home2")
os.makedirs(HOME2, exist_ok=True)
rel_dir = os.path.relpath(REL_BIN, os.getcwd())
f6 = start(HUB_F6, "hub", {"HOME": HOME2, "PATH": rel_dir + ":" + BARE_PATH, "HUD_CODEX_BIN": "/nonexistent/codex", "HUD_LOCAL_LLM_URL": DEAD_LOCAL}, NODE_CONF)
code, body = call(HUB_F6, "GET", "/api/diag")
check("a relative PATH entry is skipped: no claude is found", body.get("helpers", {}).get("claude", {}).get("path") is None)
code, body = call(HUB_F6, "POST", "/api/conversation/start", {"backend": "claude"})
cid = body.get("id")
chunk(HUB_F6, cid, 0, 2000)
check("so Claude is reported as not set up", wait_for(lambda: view(HUB_F6).get("error")) is not None and view(HUB_F6).get("error") == "Claude isn't set up on this hub")
call(HUB_F6, "POST", "/api/conversation/stop", {"id": cid})
stop_all()

# F7: a node that answers 200 with no usable answer is "did not answer", so the chain goes on to Codex.
f7 = start(HUB_F7, "hub", {"HUD_CODEX_BIN": os.path.join(WORK, "bin", "codex"), "HUD_LOCAL_LLM_URL": DEAD_LOCAL},
           {"nodes": [{"name": "lap", "url": f"http://127.0.0.1:{BAD_NODE_PORT}", "tokenFile": NODE_TOKEN_FILE}],
            "conversation": {"local": "self", "claude": "lap", "codex": "self"}})
for label, setting in [("bad JSON", {"body": b"not json", "short": False}),
                       ("no text", {"body": b"{}", "short": False}),
                       ("a cut-off body", {"body": b"", "short": True})]:
    BAD_NODE.update(setting)
    code, body = call(HUB_F7, "POST", "/api/conversation/start", {"backend": "claude"})
    cid = body.get("id")
    chunk(HUB_F7, cid, 0, 2000)
    check(f"a node with {label} gives the hints from Codex", wait_for(lambda: "CODEX hint one" in view(HUB_F7).get("hints", [])) is not None)
    check(f"and the fallback line says the node did not answer ({label})", view(HUB_F7).get("fallback") == "(Codex answered: lap did not answer)")
    call(HUB_F7, "POST", "/api/conversation/stop", {"id": cid})
    wait_for(lambda: view(HUB_F7).get("state") == "done")
stop_all()

print()
print(f"{passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
PY
status=$?
[ "$status" = 0 ]
