#!/usr/bin/env bash
# Tests the phone remote's hub routes (docs/REMOTE-INPUT.md): POST /api/input and the glasses' long-poll
# GET /api/input/wait. A fake glasses app holds the long-poll and a fake phone posts; the timing, the 429,
# the 400 and 401 answers, the 3 s "closed recently" rule, and the 2 s no-replay rule are all checked.
# The hub runs with HOME in a temp folder, with a 1.5 s wait timeout (HUD_INPUT_WAIT_MS), so your real
# ~/.config/agent-glasses is never read or written, and no real hub or Muse is contacted.
#   bash glasses/test-hub-input.sh          (needs node and python3)
set -u
here=$(cd "$(dirname "$0")" && pwd)
HUB_PORT=${HUB_PORT:-5397}
HUB="http://127.0.0.1:$HUB_PORT"
TOKEN=hud-input-test-token

work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME/.config/agent-glasses"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$work"; }
trap cleanup EXIT

printf '%s\n' "$TOKEN" > "$work/hud.token"
echo '{}' > "$work/hub.json"
# Muse rule: this test never configures Muse. Fails if the config it writes mentions it.
if grep -qi 'muse' "$work/hub.json"; then
  echo "  FAIL  the test hub config must not mention muse (Muse is off limits to this test)"
  exit 1
fi
echo "  ok    the test hub config does not mention muse"

HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/hub.json" HUD_INPUT_WAIT_MS=1500 \
  node "$here/hud-server.mjs" --mode hub --port "$HUB_PORT" --machine "Input Test" >"$work/hub.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "$HUB/api/health" && break; sleep 0.2; done

# The fake glasses app and the fake phone, in Python: timings are measured where the requests are made.
python3 - "$HUB" "$TOKEN" <<'PY'
import http.client, json, sys, threading, time
from urllib.parse import urlparse

HUB, TOKEN = sys.argv[1], sys.argv[2]
host = urlparse(HUB)
pass_count = 0
fail_count = 0

def ok(label):
    global pass_count
    pass_count += 1
    print(f"  ok    {label}", flush=True)

def bad(label):
    global fail_count
    fail_count += 1
    print(f"  FAIL  {label}", flush=True)

def call(method, path, body=None, token=TOKEN, timeout=10):
    conn = http.client.HTTPConnection(host.hostname, host.port, timeout=timeout)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = body if isinstance(body, str) else json.dumps(body)
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    res = conn.getresponse()
    raw = res.read().decode()
    conn.close()
    try:
        return res.status, json.loads(raw)
    except ValueError:
        return res.status, raw

def post(value, token=TOKEN):
    return call("POST", "/api/input", {"input": value}, token=token)

def wait_in_background(after, out, token=TOKEN):
    # The fake glasses app's long-poll: records what came back and when.
    def run():
        started = time.monotonic()
        code, body = call("GET", f"/api/input/wait?after={after}", token=token, timeout=20)
        out.update(code=code, body=body, at=time.monotonic(), took=time.monotonic() - started)
    thread = threading.Thread(target=run)
    thread.start()
    return thread

def check(label, cond):
    (ok if cond else bad)(label)

print("Phone remote: the hub's routes")

# 401 and 400 come before anything else.
code, _ = post("up", token=None)
check("posting an input needs the token (401)", code == 401)
code, _ = call("GET", "/api/input/wait?after=0", token=None)
check("the glasses' wait needs the token (401)", code == 401)
code, body = post("left")
check("an input that is not up, down, select or back is 400", code == 400 and body.get("ok") is False and "up, down, select or back" in body.get("error", ""))
code, body = call("POST", "/api/input", "not json")
check("a body that is not JSON is 400, not a server error", code == 400)
code, body = call("POST", "/api/input", {})
check("a body with no input is 400", code == 400)

# Nothing listening yet: the hub says so, and does not hold the input.
code, body = post("up")
check("no glasses listening: delivered false, with the reason", code == 200 and body == {"ok": True, "delivered": False, "reason": "no glasses listening on this hub"})

print("Wait, then post: the glasses get the button at once")
first = {}
waiter = wait_in_background(0, first)
time.sleep(0.3)  # the wait is open before the phone presses
sent_at = time.monotonic()
code, body = post("select")
posted = time.monotonic()
waiter.join(timeout=10)
latency = first["at"] - sent_at
check("a listening glasses app gets the input: delivered true, with a seq", code == 200 and body.get("delivered") is True and isinstance(body.get("seq"), int))
check("the wait answers with that input, in the list", first.get("code") == 200 and [i["input"] for i in first["body"]["inputs"]] == ["select"] and first["body"]["seq"] == body.get("seq"))
check(f"the glasses get it within 300 ms ({latency * 1000:.0f} ms)", 0 <= latency < 0.3)
first_seq = first["body"]["seq"]

print("Closed less than 3 s ago still counts as listening; no replay after 2 s")
code, body = post("down")
check("the wait closed a moment ago: the input is still delivered", code == 200 and body.get("delivered") is True)
second_seq = body.get("seq")
time.sleep(2.2)  # past the 2 s retention: the input is stale now
stale = {}
waiter = wait_in_background(first_seq, stale)
waiter.join(timeout=10)
check("a stale input is not replayed to a later wait", stale.get("code") == 200 and stale["body"]["inputs"] == [])
check("the stale wait holds until its timeout, then answers with the latest seq and no inputs", stale["took"] >= 1.3 and stale["body"]["seq"] == second_seq)

print("Closed more than 3 s ago: no glasses listening")
time.sleep(3.2)
code, body = post("back")
check("a wait closed over 3 s ago: delivered false", code == 200 and body.get("delivered") is False)

print("The shared limit: 10 inputs a second, then 429")
time.sleep(1.2)  # clear the window from the posts above
codes = [post("up")[0] for _ in range(10)]
check("the first ten inputs in a second are accepted", all(c == 200 for c in codes))
code, body = post("up")
check("the eleventh within a second is 429 too fast", code == 429 and body == {"ok": False, "error": "too fast"})
code, body = post("nope")
check("a bad input is 400 even while the limit is hit", code == 400)

print("Diagnostics: names and inputs only")
code, body = call("GET", "/api/diag")
names = [d["name"] for d in body.get("diagnostics", [])]
details = [d["detail"] for d in body.get("diagnostics", []) if d["name"] == "remote.input"]
check("remote.input is recorded for each post", "remote.input" in names and any("delivered" in d for d in details))
check("remote.limited is recorded when a post is rate-limited", "remote.limited" in names)

print()
print(f"{pass_count} passed, {fail_count} failed")
sys.exit(0 if fail_count == 0 else 1)
PY
status=$?
echo
[ "$status" = 0 ]
