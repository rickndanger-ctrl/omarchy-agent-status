#!/usr/bin/env bash
# The real app code (main.ts + glasses + queue + model, with a fake Even bridge) against TWO real hud-servers (a hub and a node, fake HOMEs)
# and a fake Muse relay on the hub: pair.auto, touch presses, remote presses, a typed ask through the real askMuse path. No real service or Muse.
# Every press must log 'input', the ask must reach the relay exactly once, and the reply must be drawn on the glasses.
#   bash glasses/test-e2e-two-hubs.sh          (needs node and python3)
set -u
here=$(cd "$(dirname "$0")" && pwd)
HUB_PORT=${E2E_HUB_PORT:-5361}; NODE_PORT=${E2E_NODE_PORT:-5362}; RELAY_PORT=${E2E_RELAY_PORT:-5363}
TOKEN=e2e-two-hubs-token; OWNER=owner@example.com
work=$(mktemp -d); pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$work"; }
trap cleanup EXIT
pass=0; fail=0
ok() { echo "  ok    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
mkdir -p "$work/homeH/.config/agent-glasses" "$work/homeN/.config/agent-glasses"
printf '%s\n' "$TOKEN" > "$work/token"
cat > "$work/relay.mjs" <<'JS'
import http from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
const [port, dir] = process.argv.slice(2)
let n = 0
http.createServer((req, res) => {
  const send = b => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)) }
  if (req.url === '/selftest') return send({ ok: true, composer: true })
  if (req.url === '/ask') { let b = ''; req.on('data', c => { b += c }); req.on('end', () => { appendFileSync(`${dir}/asks.log`, b + '\n'); n++; writeFileSync(`${dir}/counter`, String(n)); send({ id: `job${n}` }) }); return }
  const m = /^\/reply\/job(\d+)$/.exec(req.url); if (m) return send({ status: 'done', question: 'hello muse', reply: `Answer ${m[1]} from the fake Muse.` })
  if (req.url === '/latest') return send({ question: 'earlier', reply: 'an earlier answer' })
  res.statusCode = 404; res.end('{}')
}).listen(Number(port), '127.0.0.1')
JS
node "$work/relay.mjs" "$RELAY_PORT" "$work" & pids+=($!)
printf '{"nodes":[{"name":"Node","url":"http://127.0.0.1:%s"}],"muse":[{"name":"fake","url":"http://127.0.0.1:%s","tokenFile":"%s"}],"owner":"%s"}\n' "$NODE_PORT" "$RELAY_PORT" "$work/token" "$OWNER" > "$work/hub.json"
HOME="$work/homeN" HUD_TOKEN_FILE="$work/token" node "$here/hud-server.mjs" --mode node --port "$NODE_PORT" --machine Node >"$work/node.log" 2>&1 & pids+=($!)
GROQ_API_KEY=fake-key-for-the-test HOME="$work/homeH" HUD_TOKEN_FILE="$work/token" HUD_HUB_CONFIG="$work/hub.json" node "$here/hud-server.mjs" --mode hub --port "$HUB_PORT" --machine Hub >"$work/hub.log" 2>&1 & pids+=($!)
for _ in $(seq 60); do curl -s -o /dev/null "http://127.0.0.1:$HUB_PORT/api/health" && curl -s -o /dev/null "http://127.0.0.1:$NODE_PORT/api/health" && break; sleep 0.2; done

run_app() { # label hubs-in-the-app's-order scenario
  local label=$1 hubs=$2 scenario=${3:-basic}
  local asked; asked=$(cat "$work/counter" 2>/dev/null || echo 0)
  ( cd "$here/home-app" && E2E_SCENARIO="$scenario" E2E_ASK_BASE="$asked" E2E_HUBS="$hubs" E2E_HUB="http://127.0.0.1:$HUB_PORT" E2E_TOKEN="$TOKEN" E2E_OWNER="$OWNER" timeout 90 node --import tsx --import "$here/e2e/hooks.mjs" "$here/e2e/driver.mts" 2>&1 | grep -v ShadowTimers | tail -1 ) > "$work/out.json"
  python3 - "$work/out.json" "$label" <<'PY'
import json, sys
try:
    r = json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
except Exception as e:
    print('  FAIL  %s: the driver printed no result (%s): %s' % (sys.argv[2], e, open(sys.argv[1]).read()[-300:])); sys.exit(1)
if r['ok']:
    print('  ok    %s' % sys.argv[2])
else:
    print('  FAIL  %s: %s' % (sys.argv[2], '; '.join(r['problems'])))
    print('        diag: ' + ' | '.join(r['diag'][-45:]))
    sys.exit(1)
PY
}
HUBURL="http://127.0.0.1:$HUB_PORT/"; NODEURL="http://127.0.0.1:$NODE_PORT/"
if run_app "hub first, node second (presses)" "$HUBURL,$NODEURL" basic; then pass=$((pass+1)); else fail=$((fail+1)); fi
if run_app "restart, node first, hub second (presses)" "$NODEURL,$HUBURL" basic; then pass=$((pass+1)); else fail=$((fail+1)); fi
before=$(cat "$work/counter" 2>/dev/null || echo 0)
if run_app "ask from the Muse TILE: back on Tiles, the answer in a drawn frame" "$HUBURL,$NODEURL" tile; then pass=$((pass+1)); else fail=$((fail+1)); fi
[ "$(( $(cat "$work/counter" 2>/dev/null || echo 0) - before ))" = 1 ] && ok "the tile ask reached the relay exactly once" || bad "tile ask: wrong number of /ask calls"
before=$(cat "$work/counter" 2>/dev/null || echo 0)
if run_app "two asks from the FULL-SCREEN Muse view: each answer in a drawn frame" "$HUBURL,$NODEURL" full; then pass=$((pass+1)); else fail=$((fail+1)); fi
[ "$(( $(cat "$work/counter" 2>/dev/null || echo 0) - before ))" = 2 ] && ok "the two full-screen asks reached the relay exactly once each" || bad "full-screen asks: wrong number of /ask calls"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
