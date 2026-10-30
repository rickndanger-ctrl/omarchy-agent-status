#!/usr/bin/env bash
# The hub trims Muse's window chrome off every reply it takes from the relay (/api/muse and /api/muse/reply).
# A FAKE Muse relay (this script, on a local port) serves a polluted reply; no real Muse or relay is contacted, HOME is a temp folder.
#   bash glasses/test-hub-muse.sh          (needs node and python3)
set -u
here=$(cd "$(dirname "$0")" && pwd)
HUB_PORT=${HUB_PORT:-5388}
FAKE_PORT=${FAKE_PORT:-5389}
HUB="http://127.0.0.1:$HUB_PORT"
TOKEN=hud-muse-test-token
work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME/.config/agent-glasses"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$work"; }
trap cleanup EXIT
pass=0; fail=0
ok() { echo "  ok    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

printf '%s\n' "$TOKEN" > "$work/hud.token"
cp "$here/fixtures/muse-polluted.txt" "$work/polluted.txt"
printf 'Your calendar is clear today.\nMy plan: Muse is a good name for it.\nDone.\n' > "$work/clean.txt"
printf 'Approvals history shows two pending requests.\nAllow access to your calendar only after you review it.\nPlace this order? No, compare prices first.\n' > "$work/sentences.txt"
printf 'Approvals history\nNo approvals are pending.\n' > "$work/heading.txt"
printf 'Muse is on it.\nThe word Muse and Connected here are just talk.\n' > "$work/midline.txt"
cat > "$work/fake-muse.mjs" <<'JS'
import http from 'node:http'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
const [port, dir] = process.argv.slice(2)
const read = n => readFileSync(`${dir}/${n}.txt`, 'utf8')
http.createServer((req, res) => {
  const send = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
  if (req.url === '/selftest') { const slow = existsSync(`${dir}/slow`); setTimeout(() => send({ ok: !existsSync(`${dir}/notrunning`), composer: existsSync(`${dir}/ready`) }), slow ? 1500 : 0); return }
  if (req.url === '/ask' && req.method === 'POST') { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { appendFileSync(`${dir}/asks.log`, b + '\n'); if (b.includes('boom')) { res.statusCode = 500; res.end('{}'); return } send({ id: 'job1' }) }); return }
  if (req.url === '/reply/cmdfail') return send({ status: 'error', question: 'q', reply: '', error: 'Command failed: /usr/local/bin/musectl type --secret-path /Users/x' })
  if (req.url === '/reply/job1') return send({ status: 'done', question: 'asked once', reply: 'Answered once.' })
  if (req.url === '/latest') return send({ question: 'Can you hear me?', reply: read('polluted') })
  if (req.url === '/reply/polluted') return send({ status: 'done', question: 'Can you hear me?', reply: read('polluted') })
  if (req.url === '/reply/clean') return send({ status: 'done', question: 'q', reply: read('clean') })
  if (req.url === '/reply/sentences') return send({ status: 'done', question: 'q', reply: read('sentences') })
  if (req.url === '/reply/heading') return send({ status: 'done', question: 'q', reply: read('heading') })
  if (req.url === '/reply/midline') return send({ status: 'done', question: 'q', reply: read('midline') })
  if (req.url === '/reply/sending') return send({ status: 'sending', question: 'q', reply: '' })
  res.statusCode = 404; res.end('{}')
}).listen(Number(port), '127.0.0.1')
JS
node "$work/fake-muse.mjs" "$FAKE_PORT" "$work" & pids+=($!)
printf '%s\n' "$TOKEN" > "$work/relay.token"
printf '{"muse":[{"name":"fake","url":"http://127.0.0.1:%s","tokenFile":"%s"}]}\n' "$FAKE_PORT" "$work/relay.token" > "$work/hub.json"
HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/hub.json" node "$here/hud-server.mjs" --mode hub --port "$HUB_PORT" --machine "Muse Test" >"$work/hub.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$HUB_PORT/api/health" && break; sleep 0.2; done

get() { curl -s -H "Authorization: Bearer $TOKEN" "$HUB$1" > "$work/out"; }
check() { # label python-expr over d
  if python3 -c "import json,sys; d=json.load(open('$work/out')); sys.exit(0 if ($2) else 1)" 2>/dev/null; then ok "$1"; else bad "$1: $(head -c 300 "$work/out")"; fi
}
CHROME_RE="Approvals history|Connected|Place this order|Allowed ·|Allow access to|one-time code|\\\\n\\\\nMuse\\\\n"

get "/api/muse/reply?id=0-polluted"
check "/api/muse/reply: the answer only" "d['reply']=='Yes, I can hear you. The connection looks good and everything is coming through fine.' and d['status']=='done'"
check "/api/muse/reply: no chrome or approval history in the body" "not __import__('re').search(r'$CHROME_RE', json.dumps(d))"
check "/api/muse/reply: the question is untouched" "d['question']=='Can you hear me?'"
get "/api/muse"
check "/api/muse (latest): the answer only, question untouched" "d['reply'].endswith('coming through fine.') and 'Approvals' not in d['reply'] and 'Allowed' not in d['reply'] and d['question']=='Can you hear me?'"
get "/api/muse/reply?id=0-clean"
check "a clean reply is untouched (a mid-line 'Muse' stays)" "d['reply']=='Your calendar is clear today.\nMy plan: Muse is a good name for it.\nDone.\n'"
get "/api/muse/reply?id=0-midline"
check "a reply that mentions Muse and Connected mid-line is kept whole" "d['reply'].startswith('Muse is on it.') and 'Connected here' in d['reply']"
get "/api/muse/reply?id=0-sentences"
check "real sentences that start like chrome (Allow access to… / Place this order? No…) are kept" "d['reply']=='Approvals history shows two pending requests.\nAllow access to your calendar only after you review it.\nPlace this order? No, compare prices first.\n'"
get "/api/muse/reply?id=0-heading"
check "a lone 'Approvals history' line followed by prose is kept (no chrome context)" "d['reply']=='Approvals history\nNo approvals are pending.\n'"
get "/api/muse/reply?id=0-sending"
check "a reply still being typed passes through" "d['status']=='sending' and d['reply']==''"
if grep -qE '^muse\.trimmed [0-9]+ chars$' "$work/hub.log"; then ok "the trim is logged: $(grep -m1 '^muse.trimmed' "$work/hub.log")"; else bad "muse.trimmed not logged"; fi
n=$(grep -c '^muse.trimmed' "$work/hub.log"); if [ "$n" -le 2 ]; then ok "logged once per reply, not per poll ($n lines)"; else bad "log spam: $n lines"; fi

# ---- waiting for a Muse that is not ready: accepted at once, sent ONCE when it is, an error with a reason when it never is ----
mkdir -p "$work/relayA" "$work/relayB"
cp "$work/polluted.txt" "$work/clean.txt" "$work/relayA/"; cp "$work/polluted.txt" "$work/clean.txt" "$work/relayB/"
node "$work/fake-muse.mjs" 5386 "$work/relayA" & pids+=($!)
node "$work/fake-muse.mjs" 5385 "$work/relayB" & pids+=($!)
printf '{"muse":[{"name":"fakeA","url":"http://127.0.0.1:5386","tokenFile":"%s"}]}\n' "$work/relay.token" > "$work/hubA.json"
printf '{"muse":[{"name":"fakeB","url":"http://127.0.0.1:5385","tokenFile":"%s"}]}\n' "$work/relay.token" > "$work/hubB.json"
HUD_MUSE_WAIT_MS=12000 HUD_MUSE_WAIT_STEP_MS=500 HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/hubA.json" node "$here/hud-server.mjs" --mode hub --port 5384 --machine "Wait A" >"$work/hubA.log" 2>&1 & pids+=($!)
HUD_MUSE_WAIT_MS=3000 HUD_MUSE_WAIT_STEP_MS=500 HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/hubB.json" node "$here/hud-server.mjs" --mode hub --port 5383 --machine "Wait B" >"$work/hubB.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:5384/api/health" && curl -s -o /dev/null "http://127.0.0.1:5383/api/health" && break; sleep 0.2; done
post() { curl -s -m 5 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"text":"asked once"}' "$1/api/muse/ask" > "$work/out"; }
getr() { curl -s -H "Authorization: Bearer $TOKEN" "$1/api/muse/reply?id=$2" > "$work/out"; }
asks() { if [ -f "$1/asks.log" ]; then wc -l < "$1/asks.log" | tr -d ' '; else echo 0; fi; }

t0=$(date +%s%N)
post http://127.0.0.1:5384
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
WID=$(python3 -c "import json; print(json.load(open('$work/out'))['id'])")
check "the ask returns at once with a waiting job id (took ${ms} ms)" "d['status']=='waiting' and d['id'].startswith('w-')"
[ "$ms" -lt 1500 ] && ok "not held: answered in under 1.5 s" || bad "ask took $ms ms"
getr http://127.0.0.1:5384 "$WID"
check "while no relay is ready the job says waiting" "d['status']=='waiting' and d['question']=='asked once'"
sleep 2; [ "$(asks "$work/relayA")" = 0 ] && ok "nothing reached the relay while it was not ready" || bad "an /ask reached a relay that was not ready"
touch "$work/relayA/ready"   # (about 6 s after the ask in the real timeline; the hub checks every 0.5 s here)
sleep 2
[ "$(asks "$work/relayA")" = 1 ] && ok "exactly ONE /ask reached the relay once it was ready" || bad "asks: $(asks "$work/relayA")"
getr http://127.0.0.1:5384 "$WID"
check "the reply follows the sent question: done" "d['status']=='done' and d['reply']=='Answered once.'"
sleep 1.5; [ "$(asks "$work/relayA")" = 1 ] && ok "and still only one /ask after more checks" || bad "extra asks: $(asks "$work/relayA")"
grep -q '^muse.wait [0-9]* sent via fakeA' "$work/hubA.log" && ok "logged: $(grep -m1 '^muse.wait' "$work/hubA.log")" || bad "muse.wait sent not logged"

post http://127.0.0.1:5383
WID2=$(python3 -c "import json; print(json.load(open('$work/out'))['id'])")
sleep 4
getr http://127.0.0.1:5383 "$WID2"
check "never ready: the job ends in an error with a plain reason" "d['status']=='error' and d['error']=='Muse is updating or busy' and 'server said' not in d['error']"
[ "$(asks "$work/relayB")" = 0 ] && ok "and ZERO /ask calls reached the relay" || bad "asks reached a relay that was never ready"
grep -q '^muse.wait [0-9]* Muse is updating or busy' "$work/hubB.log" && ok "logged: $(grep -m1 '^muse.wait' "$work/hubB.log")" || bad "muse.wait failure not logged"

# ---- review: one question reaches a relay in every case ----
mkdir -p "$work/relayD1" "$work/relayD2" "$work/relayE"
cp "$work/polluted.txt" "$work/clean.txt" "$work/relayD1/"; cp "$work/polluted.txt" "$work/clean.txt" "$work/relayD2/"; cp "$work/polluted.txt" "$work/clean.txt" "$work/relayE/"
touch "$work/relayD1/ready" "$work/relayD2/ready"
node "$work/fake-muse.mjs" 5378 "$work/relayD1" & pids+=($!)
node "$work/fake-muse.mjs" 5377 "$work/relayD2" & pids+=($!)
printf '{"muse":[{"name":"d1","url":"http://127.0.0.1:5378","tokenFile":"%s"},{"name":"d2","url":"http://127.0.0.1:5377","tokenFile":"%s"}]}\n' "$work/relay.token" "$work/relay.token" > "$work/hubD.json"
HUD_MUSE_WAIT_MS=3000 HUD_MUSE_WAIT_STEP_MS=300 HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/hubD.json" node "$here/hud-server.mjs" --mode hub --port 5376 --machine "Wait D" >"$work/hubD.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:5376/api/health" && break; sleep 0.2; done
postj() { curl -s -m 5 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2" "$1/api/muse/ask" > "$work/out"; }
postj http://127.0.0.1:5376 '{"text":"boom","clientId":"c1"}'
sleep 1.5
n1=$(asks "$work/relayD1"); n2=$(asks "$work/relayD2")
[ "$n1" = 1 ] && [ "$n2" = 0 ] && ok "(1) an /ask that fails is never passed to the next ready relay (d1 $n1, d2 $n2)" || bad "(1) d1 $n1 d2 $n2"
WIDB=$(python3 -c "import json; print(json.load(open('$work/out'))['id'])")
getr http://127.0.0.1:5376 "$WIDB"
check "and the owner reads a plain line" "d['status']=='error' and d['error']=='Muse did not confirm the question'"
postj http://127.0.0.1:5376 '{"text":"hello","clientId":"c2"}'; ID1=$(python3 -c "import json; print(json.load(open('$work/out'))['id'])")
postj http://127.0.0.1:5376 '{"text":"hello","clientId":"c2"}'; ID2=$(python3 -c "import json; print(json.load(open('$work/out'))['id'])")
sleep 1
[ "$ID1" = "$ID2" ] && [ "$(asks "$work/relayD1")" = 2 ] && ok "(3) a repeated request with the same client id is the same ask: one more /ask in total, one id" || bad "(3) $ID1 $ID2 asks=$(asks "$work/relayD1")"
# (6) a relay job error is never passed on raw
getr http://127.0.0.1:5376 "0-cmdfail"
check "(2)(6) a relay's raw job error ('Command failed …') becomes a plain reason" "d['status']=='error' and d['error']=='Muse ran into a problem' and 'Command' not in json.dumps(d) and '/Users' not in json.dumps(d)"
[ "$(asks "$work/relayD2")" = 0 ] && ok "(2) and no other relay was asked because of it" || bad "(2) relay d2 was asked"
grep -q '^muse.error Muse ran into a problem$' "$work/hubD.log" && ! grep -q 'Command failed' "$work/hubD.log" && ok "(6) the log has only the plain reason" || bad "(6) log: $(grep muse.error "$work/hubD.log")"
# (4) slow selftest: nothing is sent after the deadline
touch "$work/relayE/ready" "$work/relayE/slow"
printf '{"muse":[{"name":"e","url":"http://127.0.0.1:5375","tokenFile":"%s"}]}\n' "$work/relay.token" > "$work/hubE.json"
node "$work/fake-muse.mjs" 5375 "$work/relayE" & pids+=($!)
HUD_MUSE_WAIT_MS=600 HUD_MUSE_WAIT_STEP_MS=200 HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/hubE.json" node "$here/hud-server.mjs" --mode hub --port 5374 --machine "Wait E" >"$work/hubE.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:5374/api/health" && break; sleep 0.2; done
postj http://127.0.0.1:5374 '{"text":"late","clientId":"c3"}'; WIDE=$(python3 -c "import json; print(json.load(open('$work/out'))['id'])")
sleep 3.5
getr http://127.0.0.1:5374 "$WIDE"
check "(4) a relay whose selftest answers after the deadline (and after the 2 s check timeout) gets nothing: error, no send" "d['status']=='error'"
[ "$(asks "$work/relayE")" = 0 ] && ok "(4) zero /ask calls" || bad "(4) asks reached the slow relay"
# (5) hub restart: the old waiting id is lost, said plainly and at once
getr http://127.0.0.1:5374 "w-doesnotexist"
check "(5) an unknown waiting id (hub restarted) is an error at once" "d['status']=='error' and d['error']=='Muse job was lost (hub restarted)'"
printf '{"muse":[{"name":"gone","url":"http://127.0.0.1:5379","tokenFile":"%s"}]}\n' "$work/relay.token" > "$work/hubC.json"
HUD_MUSE_WAIT_MS=1200 HUD_MUSE_WAIT_STEP_MS=400 HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/hubC.json" node "$here/hud-server.mjs" --mode hub --port 5382 --machine "Wait C" >"$work/hubC.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:5382/api/health" && break; sleep 0.2; done
post http://127.0.0.1:5382
WID3=$(python3 -c "import json; print(json.load(open('$work/out'))['id'])")
sleep 2.5
getr http://127.0.0.1:5382 "$WID3"
check "a relay that cannot be reached: 'no Muse reachable'" "d['status']=='error' and d['error']=='no Muse reachable'"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
