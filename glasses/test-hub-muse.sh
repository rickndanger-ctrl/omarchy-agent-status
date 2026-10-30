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
cp "$here/fixtures/muse-chrome2.txt" "$work/chrome2.txt"
printf 'Got it — test received.\nStatus\nApprovals history\n' > "$work/chrome2partial.txt"
printf 'Try these:\nAllow access to [site]\n' > "$work/errlabel.txt"
printf 'The build is green.\nStatus\n' > "$work/statusalone.txt"
printf 'Approvals history\nAllowed once · 2h ago\n' > "$work/onlychrome.txt"
printf 'Your calendar is clear today.\nMy plan: Muse is a good name for it.\nDone.\n' > "$work/clean.txt"
printf 'Approvals history shows two pending requests.\nAllow access to your calendar only after you review it.\nPlace this order? No, compare prices first.\n' > "$work/sentences.txt"
printf 'Approvals history\nNo approvals are pending.\n' > "$work/heading.txt"
printf 'Muse is on it.\nThe word Muse and Connected here are just talk.\n' > "$work/midline.txt"
cat > "$work/fake-muse.mjs" <<'JS'
import http from 'node:http'
import { readFileSync } from 'node:fs'
const [port, dir] = process.argv.slice(2)
const read = n => readFileSync(`${dir}/${n}.txt`, 'utf8')
http.createServer((req, res) => {
  const send = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
  if (req.url === '/latest') return send({ question: 'Can you hear me?', reply: read('polluted') })
  if (req.url === '/reply/polluted') return send({ status: 'done', question: 'Can you hear me?', reply: read('polluted') })
  if (req.url === '/reply/clean') return send({ status: 'done', question: 'q', reply: read('clean') })
  if (req.url === '/reply/chrome2') return send({ status: 'done', question: 'q', reply: read('chrome2') })
  if (req.url === '/reply/chrome2partial') return send({ status: 'sending', question: 'q', reply: read('chrome2partial') })
  if (req.url === '/reply/errlabel') return send({ status: 'error', question: 'q', reply: read('errlabel'), error: 'Command failed: x' })
  if (req.url === '/reply/timeoutlabel') return send({ status: 'timeout', question: 'q', reply: read('errlabel'), error: '' })
  if (req.url === '/reply/runninglabel') return send({ status: 'running', question: 'q', reply: read('errlabel') })
  if (req.url === '/reply/statusalone') return send({ status: 'done', question: 'q', reply: read('statusalone') })
  if (req.url === '/reply/onlychrome') return send({ status: 'done', question: 'q', reply: read('onlychrome') })
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
get "/api/muse/reply?id=0-chrome2"
check "chrome variant 2 (Status / Approvals history / Fill saved credentials / Allowed once · …): the answer only" "d['reply']=='Got it — test received.'"
get "/api/muse/reply?id=0-chrome2partial"
check "the same in a PARTIAL reply (status sending, chrome just started)" "d['status']=='sending' and d['reply']=='Got it — test received.'"
get "/api/muse/reply?id=0-errlabel"
check "(1) a terminal status (error) uses the FINAL rule: a real answer with one label line is kept" "d['status']=='error' and d['reply']=='Try these:\nAllow access to [site]\n'"
get "/api/muse/reply?id=0-timeoutlabel"
check "(1) timeout uses the final rule too" "d['status']=='timeout' and d['reply']=='Try these:\nAllow access to [site]\n'"
get "/api/muse/reply?id=0-runninglabel"
check "(1) while running the partial rule hides it" "d['status']=='running' and d['reply']=='Try these:'"
get "/api/muse/reply?id=0-statusalone"
check "an answer followed by 'Status' alone is kept (no anchor)" "d['reply']=='The build is green.\nStatus\n'"
grep -q '^muse.trimmed [0-9]* chars at Approvals history$' "$work/hub.log" && ok "logged with the anchor: $(grep -m1 'at Approvals history' "$work/hub.log")" || bad "anchor not in the log: $(grep muse.trimmed "$work/hub.log" | head -3)"
get "/api/muse/reply?id=0-onlychrome"
check "a final reply that was only window chrome becomes the note, never the chrome" "d['reply']=='Muse sent no text' and 'Approvals' not in json.dumps(d)"
get "/api/muse/reply?id=0-sending"
check "a reply still being typed passes through" "d['status']=='sending' and d['reply']==''"
if grep -qE '^muse\.trimmed [0-9]+ chars at ' "$work/hub.log"; then ok "the trim is logged: $(grep -m1 '^muse.trimmed' "$work/hub.log")"; else bad "muse.trimmed not logged"; fi
n=$(grep -c '^muse.trimmed 181 chars' "$work/hub.log"); if [ "$n" -le 2 ]; then ok "logged once per reply, not per poll ($n lines)"; else bad "log spam: $n lines"; fi
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
