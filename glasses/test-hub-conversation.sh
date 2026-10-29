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
import http.client, http.server, json, os, socket, subprocess, sys, threading, time, stat

HERE, WORK = sys.argv[1], sys.argv[2]
HOME = os.environ["HOME"]
HUB_PORT, HUB_B, HUB_C, HUB_D, NODE_PORT, FAKE_PORT, DEAD_PORT = (
    int(os.environ.get(k, v)) for k, v in [
        ("CONV_HUB_PORT", 5401), ("CONV_HUB_B_PORT", 5402), ("CONV_HUB_C_PORT", 5403),
        ("CONV_HUB_D_PORT", 5404), ("CONV_NODE_PORT", 5405), ("CONV_FAKE_PORT", 5406), ("CONV_DEAD_PORT", 5407)])
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
            return self.reply(200, {"text": f"part {pcm}"})
        if self.path.startswith("/local/v1/chat/completions"):
            system = json.loads(body)["messages"][0]["content"]
            content = ("SUMMARY:\nLOCAL talk summary.\nACTIONS:\n- Local action" if "Summarize" in system
                       else "LOCAL hint one\nLOCAL hint two")
            return self.reply(200, {"choices": [{"message": {"content": content}}]})
        self.reply(404, {"error": "no route"})

fake = http.server.ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake)
threading.Thread(target=fake.serve_forever, daemon=True).start()
WHISPER = f"http://127.0.0.1:{FAKE_PORT}/whisper/audio/transcriptions"
LOCAL = f"http://127.0.0.1:{FAKE_PORT}/local/v1"

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
    env.update(env_extra)
    log = open(os.path.join(WORK, f"{tag}-{port}.log"), "w")
    proc = subprocess.Popen(["node", os.path.join(HERE, "hud-server.mjs"), "--mode", mode, "--port", str(port),
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
check("an empty talk ends in error: nothing could be transcribed", wait_for(lambda: view(HUB_PORT).get("state") == "error") is not None and view(HUB_PORT).get("error") == "Nothing could be transcribed")
check("the newest session replaces the last one in memory", view(HUB_PORT).get("id") == empty)

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
print("Scenario B: the real runners; Claude fails and the local model takes over")
b = start(HUB_B, "hub", {"HUD_LOCAL_LLM_URL": LOCAL}, {"conversation": {"local": "self", "claude": "self", "codex": "self"}})
code, body = call(HUB_B, "POST", "/api/conversation/start", {"backend": "claude"})
cid = body.get("id")
chunk(HUB_B, cid, 0, 2000)
check("Claude fails: the hints come from the local model", wait_for(lambda: "LOCAL hint one" in view(HUB_B).get("hints", [])) is not None)
check("and the tile is told it was the fallback", view(HUB_B).get("fallback") == "(local model: Claude didn't answer)")
call(HUB_B, "POST", "/api/conversation/stop", {"id": cid})
check("the summary comes from the local model too", wait_for(lambda: view(HUB_B).get("state") == "done") is not None and view(HUB_B).get("summary") == ["LOCAL talk summary."] and view(HUB_B).get("actions") == ["Local action"])
code, body = call(HUB_B, "POST", "/api/think", {"backend": "claude", "system": "x", "prompt": "SLEEP", "timeoutSec": 1})
check("a Claude that does not answer in time is 502 with the time", code == 502 and body.get("error") == "Claude did not answer in 1 s")
code, body = call(HUB_B, "POST", "/api/conversation/start", {"backend": "codex"})
cid = body.get("id")
chunk(HUB_B, cid, 0, 2000)
check("codex runs read-only and answers with its own hints", wait_for(lambda: "CODEX hint one" in view(HUB_B).get("hints", [])) is not None)
check("codex has no fallback", "fallback" not in view(HUB_B))
call(HUB_B, "POST", "/api/conversation/stop", {"id": cid})
check("codex's summary is parsed", wait_for(lambda: view(HUB_B).get("state") == "done") is not None and view(HUB_B).get("summary") == ["CODEX talk summary."])
stop_all()

# ================================================================================================================
print("Scenario C: the local model is not running; the error is one plain line")
d = start(HUB_D, "hub", {"HUD_LOCAL_LLM_URL": f"http://127.0.0.1:{DEAD_PORT}/v1"}, {"conversation": {"local": "self"}})
code, body = call(HUB_D, "POST", "/api/conversation/start", {"backend": "local"})
cid = body.get("id")
chunk(HUB_D, cid, 0, 2000)
check("a local model that is not running is shown as an error", wait_for(lambda: view(HUB_D).get("error")) is not None and view(HUB_D).get("error") == f"The local model is not running at http://127.0.0.1:{DEAD_PORT}/v1")
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

print()
print(f"{passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
PY
status=$?
[ "$status" = 0 ]
