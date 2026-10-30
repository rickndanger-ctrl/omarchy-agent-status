#!/usr/bin/env bash
# Tests the hub's tile routes: /api/layout, /api/reminders, /api/home reminders, /api/tile.
# A fake Mini 1 Reminders relay and a fake url: plug-in run on spare ports; the hub runs with
# HOME in a temp folder, so your real ~/.config/agent-glasses is never read or written.
#   bash glasses/test-hub-tiles.sh          (needs node and python3)
set -u
here=$(cd "$(dirname "$0")" && pwd)
RELAY_PORT=${RELAY_PORT:-5391}
HUB_PORT=${HUB_PORT:-5392}
BARE_PORT=${BARE_PORT:-5393}
DOWN_PORT=${DOWN_PORT:-5394}
PEER_A_PORT=${PEER_A_PORT:-5395}
PEER_B_PORT=${PEER_B_PORT:-5396}
ORCH_PORT=${ORCH_PORT:-5398}
ORCH_HUB_PORT=${ORCH_HUB_PORT:-5399}
RELAY="http://127.0.0.1:$RELAY_PORT"
HUB="http://127.0.0.1:$HUB_PORT"
BARE="http://127.0.0.1:$BARE_PORT"
DOWN="http://127.0.0.1:$DOWN_PORT"
TOKEN=hud-test-token
RELAY_TOKEN=relay-test-token

work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME/.config/agent-glasses"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$work"; }
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

# ---- fake relay: Reminders (Mini 1 shape) plus a url: plug-in, logging every request ----
cat > "$work/fake-relay.mjs" <<'JS'
import http from 'node:http'
const [port, token] = [Number(process.argv[2]), process.argv[3]]
const log = []
// The Mini 1 relay's real shapes (checked read-only 2026-10-28): GET /lists -> [{id,title,count}],
// GET /lists/<id>/items?open=1 -> [{id,title,due,notes,done}], POST /items {listId,title,due?} -> 201.
// Groceries comes before Reminders here, so a 30-cut before sorting would drop the Reminders items.
const lists = [{ id: 'L1', title: 'Errands', count: 2 }, { id: 'L2', title: 'Home', count: 1 }, { id: 'L4', title: 'Groceries', count: 0 }, { id: 'L3', title: 'Reminders', count: 0 }]
const items = [
  { id: 'R1', listId: 'L1', title: 'Buy milk', due: '2026-10-28T09:00:00-07:00', notes: '', done: false },
  { id: 'R2', listId: 'L2', title: 'Call dentist', due: null, notes: '', done: false },
  { id: 'R3', listId: 'L1', title: 'Mail the card', due: '2026-10-30T14:05:00-07:00', notes: 'before Friday', done: false },
]
let next = 4
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const url = new URL(req.url, 'http://x')
  log.push({ method: req.method, path: url.pathname + url.search, body })
  if (url.pathname === '/_log') return json(res, 200, log)
  // The plug-in: public, plain JSON.
  if (url.pathname === '/plugin' && req.method === 'GET') return json(res, 200, { title: 'Weather', lines: ['Sunny', '72 F'], actions: [{ label: 'Refresh', id: 'refresh' }] })
  if (url.pathname === '/plugin' && req.method === 'POST') return json(res, 200, { ok: true })
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'bad token' })
  if (url.pathname === '/lists' && req.method === 'GET') return json(res, 200, lists)
  const listItems = url.pathname.match(/^\/lists\/(\w+)\/items$/)
  if (listItems && req.method === 'GET') {
    const open = items.filter(i => i.listId === listItems[1] && !i.done).map(({ id, title, due, notes, done, created }) => ({ id, title, due, notes, done, ...(created ? { created } : {}) }))
    return json(res, 200, open)
  }
  const done = url.pathname.match(/^\/items\/(\w+)\/done$/)
  if (done && req.method === 'POST') {
    const item = items.find(i => i.id === done[1])
    if (!item) return json(res, 404, { error: 'no item' })
    item.done = true
    return res.writeHead(200).end() // the relay's reply to /done is a bare 200
  }
  if (url.pathname === '/items' && req.method === 'POST') {
    const b = JSON.parse(body || '{}')
    if (!lists.some(l => l.id === b.listId) || typeof b.title !== 'string' || !b.title) return json(res, 400, { error: 'listId and title are required' })
    const id = `R${next++}`
    items.push({ id, listId: b.listId, title: b.title, due: b.due ?? null, notes: '', done: false, created: b.created })
    return json(res, 201, { id, listId: b.listId, title: b.title })
  }
  return json(res, 404, { error: 'no route' })
}).listen(port, '127.0.0.1')
JS
node "$work/fake-relay.mjs" "$RELAY_PORT" "$RELAY_TOKEN" & pids+=($!)

# ---- config: a hub with the Reminders relay, and a bare hub with none ----
printf '%s\n' "$RELAY_TOKEN" > "$work/relay.token"
printf '%s\n' "$TOKEN" > "$work/hud.token"
cat > "$HOME/.config/agent-glasses/hub.json" <<JSON
{"remindersUrl":"$RELAY","remindersTokenFile":"$work/relay.token"}
JSON
echo '{}' > "$work/hub-bare.json"

export HUD_TOKEN_FILE="$work/hud.token"
HUD_HUB_CONFIG="$HOME/.config/agent-glasses/hub.json" node "$here/hud-server.mjs" --mode hub --port "$HUB_PORT" --machine "Mini 1" >"$work/hub.log" 2>&1 & pids+=($!)
HUD_HUB_CONFIG="$work/hub-bare.json" node "$here/hud-server.mjs" --mode hub --port "$BARE_PORT" --machine "Mini 1" >"$work/bare.log" 2>&1 & pids+=($!)
# A hub whose relay refuses its token: every relay call fails, the relay still logs each one.
printf '%s\n' "wrong-token" > "$work/wrong.token"
cat > "$work/hub-down.json" <<JSON
{"remindersUrl":"$RELAY","remindersTokenFile":"$work/wrong.token"}
JSON
# Muse rule: this test never configures Muse. Fails if any hub config it writes mentions it.
if grep -qi 'muse' "$HOME/.config/agent-glasses/hub.json" "$work/hub-bare.json" "$work/hub-down.json"; then
  echo "  FAIL  the test hub configs must not mention muse (Muse is off limits to this test)"
  exit 1
fi
echo "  ok    the test hub configs do not mention muse"
HUD_HUB_CONFIG="$work/hub-down.json" node "$here/hud-server.mjs" --mode hub --port "$DOWN_PORT" --machine "Mini 1" >"$work/down.log" 2>&1 & pids+=($!)

for url in "$RELAY/_log" "$HUB/api/health" "$BARE/api/health" "$DOWN/api/health"; do
  for _ in $(seq 50); do curl -s -o /dev/null "$url" && break; sleep 0.2; done
done

# ---- request helper: sets CODE and OUT. SEND_TOKEN=0 sends no token. ----
req() { # method base path [json-body]
  local m=$1 base=$2 path=$3 data=${4:-}
  local auth=(-H "Authorization: Bearer $TOKEN")
  [ "${SEND_TOKEN:-1}" = 0 ] && auth=()
  if [ -n "$data" ]; then
    CODE=$(curl -s -o "$work/out" -w '%{http_code}' -X "$m" "${auth[@]}" -H 'Content-Type: application/json' -d "$data" "$base$path")
  else
    CODE=$(curl -s -o "$work/out" -w '%{http_code}' -X "$m" "${auth[@]}" "$base$path")
  fi
  OUT=$(cat "$work/out")
}
# check LABEL WANT_CODE [PYTHON_EXPR]: the HTTP code must match and the JSON body (as d) must satisfy the expression
check() {
  local label=$1 want=$2 expr=${3:-True}
  if [ "$CODE" = "$want" ] && printf '%s' "$OUT" | python3 -c "import json,re,sys; d=json.load(sys.stdin); sys.exit(0 if ($expr) else 1)" 2>/dev/null; then
    ok "$label"
  else
    bad "$label (HTTP $CODE, wanted $want: $OUT)"
  fi
}
# logged PYTHON_EXPR: e is each request the fake relay has seen
logged() {
  curl -s "$RELAY/_log" | python3 -c "import json,sys; sys.exit(0 if any($1 for e in json.load(sys.stdin)) else 1)" 2>/dev/null
}

DEFAULT_PAGES='[{"left":"muse","right":"agent:Dell/claude"},{"left":"chat:recent","right":"agent:Mini 1/codex"},{"left":"reminders","right":"studio"},{"left":"approvals","right":"messages"},{"left":"clock","right":"empty"}]'
PLUGIN="$RELAY/plugin"

echo "Layout"
SEND_TOKEN=0 req GET "$HUB" /api/layout
check "GET /api/layout needs the token" 401
req GET "$HUB" /api/layout
check "GET /api/layout with no layout.json returns the default" 200 "d['pages']==$DEFAULT_PAGES"
req PUT "$HUB" /api/layout '{"pages":[{"left":"a","right":"b"}]}'
check "PUT /api/layout rejects a layout that is not five pages" 400
req PUT "$HUB" /api/layout '{"pages":[{"left":"a","right":1},{"left":"a","right":"b"},{"left":"a","right":"b"},{"left":"a","right":"b"},{"left":"a","right":"b"}]}'
check "PUT /api/layout rejects a non-string widget id" 400
PLUGIN_PAGES=$(python3 -c "import json,sys; p=json.loads(sys.argv[1]); p[4]['left']=sys.argv[2]; print(json.dumps({'pages':p}))" "$DEFAULT_PAGES" "url:$PLUGIN")
req PUT "$HUB" /api/layout "$PLUGIN_PAGES"
check "PUT /api/layout saves five pages" 200 "d['pages'][4]['left']=='url:$PLUGIN'"
req GET "$HUB" /api/layout
check "GET /api/layout reads back what was saved" 200 "d['pages'][4]['left']=='url:$PLUGIN'"
if [ -f "$HOME/.config/agent-glasses/layout.json" ]; then ok "layout.json is written under the config folder"; else bad "layout.json is written under the config folder"; fi

req GET "$HUB" /api/pinned
check "GET /api/pinned with no pinned.json returns the 8 default pins (Orchestrator on Dell, the home-agents sessions, Dell is the tile)" 200 "len(d['pins'])==8 and d['pins'][0]=={'label':'Claude · Orchestrator','machine':'Dell','agent':'claude','session':'orchestrator'} and d['pins'][1]=={'label':'Claude · Mini 1','machine':'Mini 1','agent':'claude','session':'claude'} and [x['session'] for x in d['pins'][1:7]]==['claude','codex']*3 and [x['machine'] for x in d['pins'][1:7]]==['Mini 1','Mini 1','Mini 2','Mini 2','Neo','Neo'] and d['pins'][7]=={'label':'Claude · Dell window','machine':'Dell','agent':'claude','session':'tile'}"
req PUT "$HUB" /api/pinned '{"pins":[{"label":"x","machine":"Mini 1","agent":"claude"}]}'
check "PUT /api/pinned rejects a pin with no session" 400
req PUT "$HUB" /api/pinned '{"pins":[{"label":"x","machine":"Mini 1","agent":"claude","session":7}]}'
check "PUT /api/pinned rejects a non-string field" 400
req PUT "$HUB" /api/pinned '{"pins":[{"label":"One","machine":"Mini 1","agent":"claude","session":"s1"},{"label":"Two","machine":"Neo","agent":"codex","session":"s2"}]}'
check "PUT /api/pinned saves the list" 200 "[x['label'] for x in d['pins']]==['One','Two'] and d['updatedAt']>0"
req GET "$HUB" /api/pinned
check "GET /api/pinned reads back what was saved" 200 "[x['session'] for x in d['pins']]==['s1','s2']"
req GET "$HUB" /api/home
check "/api/home carries the pins (the glasses read them from the poll they already make)" 200 "[x['label'] for x in d['pinned']]==['One','Two']"
if [ -f "$HOME/.config/agent-glasses/pinned.json" ]; then ok "pinned.json is written under the config folder"; else bad "pinned.json is written under the config folder"; fi

echo "Reminders"
req GET "$HUB" /api/reminders
check "GET /api/reminders lists open items with list titles" 200 "sorted((r['title'],r['list']) for r in d['reminders'])==[('Buy milk','Errands'),('Call dentist','Home'),('Mail the card','Errands')]"
check "a due time is a short tile label; no due stays null" 200 "all(re.match(r'^(Overdue|Today \d{1,2}(:\d{2})? (AM|PM)|Tomorrow|[A-Z][a-z]{2} \d{1,2})$', r['due']) for r in d['reminders'] if r['due']) and [r['due'] for r in d['reminders'] if r['title']=='Call dentist']==[None]"
req GET "$HUB" /api/home
check "GET /api/home carries reminders" 200 "len(d['reminders'])==3"
req POST "$HUB" /api/reminders/done '{"id":"R1"}'
check "POST /api/reminders/done answers ok" 200 "d['ok'] is True"
if logged "e['method']=='POST' and e['path']=='/items/R1/done'"; then ok "done reached the relay as POST /items/R1/done"; else bad "done reached the relay as POST /items/R1/done"; fi
req GET "$HUB" /api/reminders
check "a done item leaves the open list" 200 "sorted(r['id'] for r in d['reminders'])==['R2','R3']"
req POST "$HUB" /api/reminders/add '{"title":"Water plants","list":"Home"}'
check "POST /api/reminders/add answers ok" 200 "d['ok'] is True"
if logged "e['path']=='/items' and json.loads(e['body'])=={'listId':'L2','title':'Water plants'}"; then ok "add by title sends the Home listId"; else bad "add by title sends the Home listId"; fi
req POST "$HUB" /api/reminders/add '{"title":"Mow","list":"L1"}'
check "add by list id is accepted" 200 "d['ok'] is True"
if logged "e['path']=='/items' and json.loads(e['body'])['listId']=='L1' and json.loads(e['body'])['title']=='Mow'"; then ok "add by id sends listId L1"; else bad "add by id sends listId L1"; fi
req POST "$HUB" /api/reminders/add '{"title":"Fix sink"}'
check "add with no list goes to the list titled Reminders" 200 "d['ok'] is True"
if logged "e['path']=='/items' and json.loads(e['body'])['listId']=='L3' and json.loads(e['body'])['title']=='Fix sink'"; then ok "no list sends the Reminders list L3"; else bad "no list sends the Reminders list L3"; fi
req POST "$HUB" /api/reminders/add '{"title":"Nap","list":"Nope"}'
check "an unknown list falls back to Reminders" 200 "d['ok'] is True"
if logged "e['path']=='/items' and json.loads(e['body'])['listId']=='L3' and json.loads(e['body'])['title']=='Nap'"; then ok "an unknown list name sends L3"; else bad "an unknown list name sends L3"; fi
req GET "$HUB" /api/reminders
check "every added item shows in its list" 200 "sorted((r['title'],r['list']) for r in d['reminders'])==sorted([('Call dentist','Home'),('Fix sink','Reminders'),('Mow','Errands'),('Mail the card','Errands'),('Nap','Reminders'),('Water plants','Home')])"
req POST "$HUB" /api/reminders/add '{"title":""}'
check "POST /api/reminders/add refuses an empty title" 400
req GET "$BARE" /api/reminders
check "GET /api/reminders is 404 with no relay configured" 404
req GET "$BARE" /api/home
check "GET /api/home has reminders null with no relay" 200 "d['reminders'] is None"

echo "Sorting and the 30 cut"
# Straight to the fake relay: one item due in two hours (soon), a relay creation date, and 32 items due in
# a month (far future). Then a fresh undated voice-style add through the hub must still make the 30 kept.
relay_post() { curl -s -o /dev/null -X POST -H "Authorization: Bearer $RELAY_TOKEN" -H 'Content-Type: application/json' -d "$1" "$RELAY/items"; }
due_in_two_hours=$(python3 -c "import datetime as d; print((d.datetime.now(d.timezone.utc) + d.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
due_in_a_month=$(python3 -c "import datetime as d; print((d.datetime.now(d.timezone.utc) + d.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
relay_post "{\"listId\":\"L3\",\"title\":\"Pay rent\",\"due\":\"$due_in_two_hours\"}"
relay_post '{"listId":"L1","title":"Dated item","created":"2026-10-01T12:00:00Z"}'
for i in $(seq 32); do relay_post "{\"listId\":\"L4\",\"title\":\"Groceries $i\",\"due\":\"$due_in_a_month\"}"; done
req GET "$HUB" /api/reminders
check "the hub has seen the posted items" 200 "len(d['reminders'])>=34"
sleep 1 # so the fresh add is seen a moment later than the rest: it is the newest
req POST "$HUB" /api/reminders/add '{"title":"Fresh idea","list":"Groceries"}'
check "a fresh add goes through" 200 "d['ok'] is True"
req GET "$HUB" /api/home
check "the 30 kept include the soon item and the fresh undated add" 200 "len(d['reminders'])==30 and 'Pay rent' in [r['title'] for r in d['reminders']] and 'Fresh idea' in [r['title'] for r in d['reminders']]"
req GET "$HUB" /api/reminders
first=$OUT
req GET "$HUB" /api/reminders
second=$OUT
if python3 -c 'import json,sys
a={r["id"]:r["added"] for r in json.loads(sys.argv[1])["reminders"]}
b={r["id"]:r["added"] for r in json.loads(sys.argv[2])["reminders"]}
sys.exit(0 if a and a==b and all(isinstance(v,int) for v in a.values()) else 1)' "$first" "$second"; then
  ok "added is stable across polls"
else
  bad "added is stable across polls"
fi
if printf '%s' "$second" | python3 -c 'import datetime,json,sys
dated=[r for r in json.load(sys.stdin)["reminders"] if r["title"]=="Dated item"][0]
sys.exit(0 if dated["added"]==int(datetime.datetime(2026,10,1,12,tzinfo=datetime.timezone.utc).timestamp()*1000) else 1)'; then
  ok "a relay creation date is used as added"
else
  bad "a relay creation date is used as added"
fi

echo "Relay down"
# relay_count: how many requests the fake relay has seen for the Reminders lists
relay_count() { curl -s "$RELAY/_log" | python3 -c "import json,sys; print(sum(1 for e in json.load(sys.stdin) if e['path'].startswith('/lists')))"; }
before=$(relay_count)
req GET "$DOWN" /api/home
check "a failing relay leaves reminders null on /api/home" 200 "d['reminders'] is None"
after_first=$(relay_count)
req GET "$DOWN" /api/home
check "a second /api/home still answers with reminders null" 200 "d['reminders'] is None"
after_second=$(relay_count)
if [ "$after_first" -gt "$before" ] && [ "$after_second" = "$after_first" ]; then
  ok "the failure is cached: the second poll made no relay call"
else
  bad "the failure is cached: the second poll made no relay call (relay calls: $before, $after_first, $after_second)"
fi

echo "Plug-in tiles"
req GET "$HUB" "/api/tile?url=$PLUGIN"
check "GET /api/tile returns a tile for a url: endpoint in the layout" 200 "d['title']=='Weather' and d['lines']==['Sunny','72 F'] and d['actions'][0]['id']=='refresh'"
req GET "$HUB" "/api/tile?url=$RELAY/not-in-layout"
check "GET /api/tile refuses an endpoint not in the layout" 404
req POST "$HUB" /api/tile/action "{\"url\":\"$PLUGIN\",\"id\":\"refresh\"}"
check "POST /api/tile/action answers ok" 200 "d['ok'] is True"
if logged "e['path']=='/plugin' and e['method']=='POST' and '\"refresh\"' in e['body']"; then ok "the action reached the plug-in as POST {id}"; else bad "the action reached the plug-in as POST {id}"; fi
req POST "$HUB" /api/tile/action "{\"url\":\"$RELAY/not-in-layout\",\"id\":\"refresh\"}"
check "POST /api/tile/action refuses an endpoint not in the layout" 404
req POST "$HUB" /api/tile/action "{\"url\":\"$PLUGIN\"}"
check "POST /api/tile/action needs an action id" 400


echo "Sessions carry their tmux or screen name (fake tmux, screen and ps)"
SCREEN_PORT=${SCREEN_PORT:-5397}
mkdir -p "$work/fakebin" "$work/homeS/.config/agent-glasses"
cat > "$work/fakebin/screen" <<'SH'
#!/bin/sh
printf 'There is a screen on:\n\t1234.claude\t(Detached)\n1 Socket in /tmp/screens.\n'
SH
cat > "$work/fakebin/tmux" <<'SH'
#!/bin/sh
printf '%%3 1500 codex|/tmp/proj\n%%4 1600 two words|/tmp/other\n'
SH
cat > "$work/fakebin/ps" <<'SH'
#!/bin/sh
printf '1234 1 SCREEN -S claude\n1300 1234 claude --x\n1500 1 -bash\n1501 1500 codex\n1600 1 -bash\n1601 1600 claude\n'
SH
cat > "$work/fakebin/lsof" <<'SH'
#!/bin/sh
printf 'p1300\nfcwd\nn/tmp/proj\n'
SH
chmod +x "$work/fakebin/"*
PATH="$work/fakebin:$PATH" HOME="$work/homeS" HUD_TOKEN_FILE="$work/hud.token" node "$here/hud-server.mjs" --mode hub --port "$SCREEN_PORT" --machine "Fake" >"$work/screen.log" 2>&1 & pidS=$!; pids+=("$pidS")
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$SCREEN_PORT/api/health" && break; sleep 0.2; done
req GET "http://127.0.0.1:$SCREEN_PORT" /api/home
check "a GNU screen session '1234.claude (Detached)' becomes a session with tmux=claude" 200 "any(s.get('tmux')=='claude' and s['agent']=='claude' and s['pane']=='screen:1234.claude' for s in d['sessions'])"
check "a tmux pane carries its session name" 200 "any(s.get('tmux')=='codex' and s['agent']=='codex' and s['pane']=='%3' for s in d['sessions'])"
check "a tmux session name with a space is kept whole" 200 "any(s.get('tmux')=='two words' and s['pane']=='%4' for s in d['sessions'])"

echo "Orchestrator pin: config only on the NODE (Dell), read through a hub (fake HOMEs and a fixture transcript; never the real ~/.claude)"
ORCH_HOME="$work/homeO"
ORCH_SESSION=11111111-2222-3333-4444-555555555555
mkdir -p "$ORCH_HOME/.config/agent-glasses" "$ORCH_HOME/.claude/projects/-fixture"
python3 - "$ORCH_HOME/.claude/projects/-fixture/$ORCH_SESSION.jsonl" <<'PY'
import json, sys
rows = [{"type": "user", "message": {"role": "user", "content": "hi"}}]
rows.append({"type": "assistant", "message": {"content": [{"type": "text", "text": "x" * 300000}]}})  # pushes the early reply out of the 256 KB tail
rows.append({"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "SECRET-THOUGHT"}, {"type": "text", "text": "Release is ready.\nkey=abcd1234efgh and Bearer abcdefghijklmnop1234 and sk-abcdefghijklmnop and ghp_abcdefghijklmnopqrstu"}, {"type": "tool_use", "name": "Bash", "input": {"command": "TOOLUSE-CMD"}}]}})
rows.append({"type": "user", "message": {"content": [{"type": "tool_result", "content": "TOOLRESULT-OUT"}]}})
rows.append({"type": "assistant", "message": {"content": [{"type": "text", "text": "hex 0123456789abcdef0123456789abcdef01 b64 QWxhZGRpbjpvcGVuIHNlc2FtZVRoaXNJc0xvbmc9 done."}]}})
open(sys.argv[1], "w").write("\n".join(json.dumps(r) for r in rows) + "\n")
PY
printf '{"session":"%s","dir":"~/.claude/projects/-fixture"}\n' "$ORCH_SESSION" > "$ORCH_HOME/.config/agent-glasses/orchestrator.json"
HOME="$ORCH_HOME" HUD_ORCH_RESCAN_MS=200 HUD_TOKEN_FILE="$work/hud.token" node "$here/hud-server.mjs" --mode node --port "$ORCH_PORT" --machine "Dell" >"$work/orch.log" 2>&1 & pids+=($!)
mkdir -p "$work/homeH/.config/agent-glasses"
printf '{"nodes":[{"name":"Dell","url":"http://127.0.0.1:%s"}]}\n' "$ORCH_PORT" > "$work/hub-orch.json"
HOME="$work/homeH" HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/hub-orch.json" node "$here/hud-server.mjs" --mode hub --port "$ORCH_HUB_PORT" --machine "Mini 1" >"$work/orch-hub.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$ORCH_PORT/api/health" && curl -s -o /dev/null "http://127.0.0.1:$ORCH_HUB_PORT/api/health" && break; sleep 0.2; done
OH="http://127.0.0.1:$ORCH_HUB_PORT"
req GET "$OH" /api/home
check "/api/home lists the orchestrator as a Claude session on machine Dell, seen through the hub (working: the file was just written)" 200 "any(s.get('pane')=='orchestrator' and s['tmux']=='orchestrator' and s['machine']=='Dell' and s['agent']=='claude' and s['state']=='working' for s in d['sessions'])"
req GET "$OH" /api/pinned
check "the default pins start with Claude · Orchestrator, end with 'Claude · Dell window'" 200 "d['pins'][0]=={'label':'Claude · Orchestrator','machine':'Dell','agent':'claude','session':'orchestrator'} and d['pins'][-1]['label']=='Claude · Dell window' and len(d['pins'])==8"
req GET "$OH" "/api/terminal?machine=Dell&pane=orchestrator"
check "terminal: the last assistant text only (no thinking, tool_use or tool_result), the early reply cut with the tail" 200 "'Release is ready.' in ' '.join(d['lines']) and 'done.' in ' '.join(d['lines']) and not re.search('SECRET-THOUGHT|TOOLUSE-CMD|TOOLRESULT-OUT', ' '.join(d['lines'])) and len(' '.join(d['lines']))<2000"
check "terminal: key=/Bearer/sk-/ghp_/hex/base64 values are redacted" 200 "not re.search('abcd1234efgh|abcdefghijklmnop|0123456789abcdef0123|QWxhZGRpbjpvcGVu', ' '.join(d['lines'])) and ' '.join(d['lines']).count('[secret]')>=5"
sleep 0.1
touch -d '2 minutes ago' "$ORCH_HOME/.claude/projects/-fixture/$ORCH_SESSION.jsonl"
req GET "$OH" /api/home
check "idle when the file has not grown for 20 s" 200 "any(s.get('pane')=='orchestrator' and s['state']=='idle' for s in d['sessions'])"
req POST "$OH" /api/prompt '{"machine":"Dell","pane":"orchestrator","text":"start the release"}'
check "prompt on the orchestrator is accepted" 200 "d['ok']==True"
req POST "$OH" /api/prompt "{\"machine\":\"Dell\",\"pane\":\"orchestrator\",\"text\":\"$(python3 -c "print('y'*3000)")\"}"
INBOX="$ORCH_HOME/.config/agent-glasses/orchestrator-inbox.jsonl"
if python3 - "$INBOX" <<'PY'
import json, os, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
ok = len(rows) == 2 and rows[0]['text'] == 'start the release' and rows[0]['from'] == 'glasses' and isinstance(rows[0]['at'], int) and len(rows[1]['text']) == 2000
ok = ok and oct(os.stat(sys.argv[1]).st_mode & 0o777) == '0o600'
sys.exit(0 if ok else 1)
PY
then ok "the NODE's inbox: one JSON line {at, text, from:'glasses'} per message, text capped at 2000, file mode 0600"; else bad "inbox lines"; fi
req POST "$OH" /api/prompt '{"machine":"Dell","pane":"orchestrator","key":"Escape"}'
check "no Escape key for the orchestrator" 200 "d['ok']==False"
rm "$ORCH_HOME/.claude/projects/-fixture/$ORCH_SESSION.jsonl"
req GET "$OH" /api/home
check "missing transcript = not running (no session listed)" 200 "not any(s.get('pane')=='orchestrator' for s in d['sessions'])"
req GET "$OH" "/api/terminal?machine=Dell&pane=orchestrator"
check "missing transcript: the hub passes the node's 404 on as an error" 502
if [ ! -e "$HOME/.config/agent-glasses/orchestrator-inbox.jsonl" ]; then ok "the real inbox was not touched"; else bad "the real inbox was touched"; fi

echo "Orchestrator follows its session (order file, then a newer ORCHESTRATOR transcript after 30 min)"
ODIR="$ORCH_HOME/.claude/projects/-fixture"
mk() { # id first-user-text assistant-text
  python3 - "$ODIR/$1.jsonl" "$2" "$3" <<'PY'
import json, sys
rows = [{"type": "user", "message": {"role": "user", "content": sys.argv[2]}}, {"type": "assistant", "message": {"content": [{"type": "text", "text": sys.argv[3]}]}}]
open(sys.argv[1], "w").write("\n".join(json.dumps(r) for r in rows) + "\n")
PY
}
mk "$ORCH_SESSION" "hello" "From base"
req GET "$OH" "/api/terminal?machine=Dell&pane=orchestrator"; sleep 0.5; req GET "$OH" "/api/terminal?machine=Dell&pane=orchestrator"
check "the configured session is read" 200 "'From base' in ' '.join(d['lines'])"
mk fileone "hello" "From the order file"
printf 'fileone\n' > "$ORCH_HOME/.config/agent-glasses/orchestrator-session"
sleep 0.5; req GET "$OH" /api/home; req GET "$OH" "/api/terminal?machine=Dell&pane=orchestrator"
check "orchestrator-session file wins over orchestrator.json" 200 "'From the order file' in ' '.join(d['lines'])"
if grep -q 'orchestrator.session fileone (orchestrator-session file)' "$work/orch.log"; then ok "logged: orchestrator.session fileone (orchestrator-session file)"; else bad "session change not logged"; fi
printf 'bad id with spaces\n' > "$ORCH_HOME/.config/agent-glasses/orchestrator-session"
sleep 0.5; req GET "$OH" /api/home; req GET "$OH" "/api/terminal?machine=Dell&pane=orchestrator"
check "an id that is not [\\w.-]+ is ignored (back to orchestrator.json)" 200 "'From base' in ' '.join(d['lines'])"
rm "$ORCH_HOME/.config/agent-glasses/orchestrator-session"
mk newmarked "You are the ORCHESTRATOR of the studio" "From the new orchestrator"
mk newplain "just a chat" "From a plain chat"
mk oldmarked "ORCHESTRATOR old" "From an old marked one"
touch -d '3 hours ago' "$ODIR/oldmarked.jsonl"
sleep 0.5; req GET "$OH" /api/home; req GET "$OH" "/api/terminal?machine=Dell&pane=orchestrator"
check "while the transcript is fresh nothing else is followed" 200 "'From base' in ' '.join(d['lines'])"
touch -d '40 minutes ago' "$ODIR/$ORCH_SESSION.jsonl"
touch -d '5 minutes ago' "$ODIR/newplain.jsonl"
touch -d '2 minutes ago' "$ODIR/newmarked.jsonl"
sleep 0.5; req GET "$OH" /api/home; req GET "$OH" "/api/terminal?machine=Dell&pane=orchestrator"
check "unchanged 30 min: the newer transcript whose first user message says ORCHESTRATOR (not a plain chat, not an older one)" 200 "'From the new orchestrator' in ' '.join(d['lines'])"
if grep -q 'orchestrator.session newmarked (' "$work/orch.log"; then ok "logged: orchestrator.session newmarked (...)"; else bad "switch to newmarked not logged"; fi
req GET "$OH" /api/home
check "the session in /api/home follows it (working: just written)" 200 "any(s.get('pane')=='orchestrator' for s in d['sessions'])"

echo "set-tile.sh changes one slot"
ST="$here/set-tile.sh"
req GET "$HUB" /api/layout; BEFORE_LAYOUT=$OUT
out=$(DRY_RUN=1 HUD_TOKEN="$TOKEN" "$ST" "$HUB" 2 right orchestrator 2>&1)
if printf '%s' "$out" | grep -q 'before: page 2 right = ' && printf '%s' "$out" | grep -q 'after:  page 2 right = orchestrator' && printf '%s' "$out" | grep -q 'dry run'; then ok "DRY_RUN prints before and after"; else bad "dry run output: $out"; fi
req GET "$HUB" /api/layout
if [ "$OUT" = "$BEFORE_LAYOUT" ]; then ok "DRY_RUN saves nothing"; else bad "DRY_RUN changed the layout"; fi
HUD_TOKEN="$TOKEN" "$ST" "$HUB" 2 right orchestrator >/dev/null 2>&1
req GET "$HUB" /api/layout
check "page 2 right is the orchestrator and every other slot is unchanged" 200 "d['pages'][1]['right']=='orchestrator'"
python3 - "$BEFORE_LAYOUT" "$OUT" <<'PY' && ok "only that one slot differs" || bad "other slots changed"
import json, sys
a, b = json.loads(sys.argv[1])['pages'], json.loads(sys.argv[2])['pages']
diff = [(i, k) for i in range(len(a)) for k in ('left', 'right') if a[i][k] != b[i][k]]
sys.exit(0 if diff == [(1, 'right')] or (diff == [] and a[1]['right'] == 'orchestrator') else 1)
PY
if "$ST" "$HUB" 9 right x >/dev/null 2>&1 </dev/null; then bad "page 9 should fail"; else ok "a page that does not exist is refused"; fi
req PUT "$HUB" /api/layout "$BEFORE_LAYOUT"

echo "Two hubs keeping one layout"
PA="http://127.0.0.1:$PEER_A_PORT"
PB="http://127.0.0.1:$PEER_B_PORT"
mkdir -p "$work/homeA/.config/agent-glasses" "$work/homeB/.config/agent-glasses"
printf '{"peers":[{"url":"%s","tokenFile":"%s"}]}\n' "$PB" "$work/hud.token" > "$work/peer-a.json"
printf '{"peers":[{"url":"%s","tokenFile":"%s"}]}\n' "$PA" "$work/hud.token" > "$work/peer-b.json"
if grep -qi 'muse' "$work/peer-a.json" "$work/peer-b.json"; then
  echo "  FAIL  the peer test configs must not mention muse (Muse is off limits to this test)"
  exit 1
fi
HOME="$work/homeA" HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/peer-a.json" node "$here/hud-server.mjs" --mode hub --port "$PEER_A_PORT" --machine "Peer A" >"$work/peer-a.log" 2>&1 & pidA=$!; pids+=("$pidA")
HOME="$work/homeB" HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/peer-b.json" node "$here/hud-server.mjs" --mode hub --port "$PEER_B_PORT" --machine "Peer B" >"$work/peer-b.log" 2>&1 & pidB=$!; pids+=("$pidB")
wait_up() { for _ in $(seq 50); do curl -s -o /dev/null "$1/api/health" && return 0; sleep 0.2; done; return 1; }
wait_up "$PA" && wait_up "$PB"
# wait_until COMMAND: retries for about 4 s (peers push in the background)
wait_until() { local i; for i in $(seq 20); do eval "$1" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }
layout_field() { curl -s -H "Authorization: Bearer $TOKEN" "$1/api/layout" | python3 -c "import json,sys; d=json.load(sys.stdin); print($2)"; }
b_left() { layout_field "$PB" "d['pages'][0]['left']"; }
# relayed_body PAGES [UPDATED_AT]: a body as a peer sends it (relayed, with or without updatedAt)
relayed_body() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['relayed']=True; sys.argv[2] and d.update(updatedAt=int(sys.argv[2])); print(json.dumps(d))" "$1" "$2"; }
XPAGES='{"pages":[{"left":"clock","right":"agent:Dell/claude"},{"left":"chat:recent","right":"agent:Mini 1/codex"},{"left":"reminders","right":"studio"},{"left":"approvals","right":"messages"},{"left":"clock","right":"empty"}]}'
YPAGES=${XPAGES/clock/approvals}
ZPAGES=${XPAGES/clock/studio}

req PUT "$PA" /api/layout "$XPAGES"
check "A saves a layout and stamps it" 200 "d['updatedAt']>0"
upA1=$(layout_field "$PA" "d['updatedAt']")
if wait_until '[ "$(b_left)" = clock ]'; then ok "B shows the change made on A"; else bad "B shows the change made on A"; fi
if [ "$(layout_field "$PB" "d['updatedAt']")" = "$upA1" ]; then ok "B keeps A's stamp"; else bad "B keeps A's stamp"; fi
sleep 1
if [ "$(layout_field "$PA" "d['updatedAt']")" = "$upA1" ]; then ok "no loop: A is not re-stamped by B's copy"; else bad "no loop: A is not re-stamped by B's copy"; fi

req PUT "$PB" /api/layout "$(relayed_body "$ZPAGES" $((upA1 - 1000)))"
if [ "$CODE" = 200 ] && [ "$(b_left)" = clock ]; then ok "an older relayed copy is ignored"; else bad "an older relayed copy is ignored"; fi
req PUT "$PB" /api/layout "$(relayed_body "$ZPAGES" "")"
if [ "$CODE" = 200 ] && [ "$(b_left)" = clock ]; then ok "a relayed copy with no updatedAt counts as 0 and is ignored"; else bad "a relayed copy with no updatedAt counts as 0 and is ignored"; fi
req PUT "$PB" /api/layout "$(relayed_body "$ZPAGES" $((upA1 + 500)))"
if wait_until '[ "$(b_left)" = studio ]'; then ok "a newer relayed copy is saved"; else bad "a newer relayed copy is saved"; fi
if [ "$(layout_field "$PA" "d['pages'][0]['left']")" = clock ]; then ok "a relayed copy is not passed back to A"; else bad "a relayed copy is not passed back to A"; fi

pin_label() { curl -s -H "Authorization: Bearer $TOKEN" "$1/api/pinned" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['pins'][0]['label'], d['updatedAt'])"; }
req PUT "$PA" /api/pinned '{"pins":[{"label":"Synced","machine":"Neo","agent":"codex","session":"s"}]}'
if wait_until '[ "$(pin_label "$PB" | cut -d" " -f1)" = Synced ]'; then ok "B shows the pins saved on A"; else bad "B shows the pins saved on A"; fi
sleep 1
if [ "$(pin_label "$PA" | cut -d" " -f2)" = "$(pin_label "$PB" | cut -d" " -f2)" ]; then ok "pins: both hubs hold the same stamp, no loop"; else bad "pins: both hubs hold the same stamp, no loop"; fi
req PUT "$PB" /api/pinned '{"relayed":true,"updatedAt":1,"pins":[{"label":"Old","machine":"Neo","agent":"codex","session":"s"}]}'
if [ "$CODE" = 200 ] && [ "$(pin_label "$PB" | cut -d" " -f1)" = Synced ]; then ok "an older relayed pin list is ignored"; else bad "an older relayed pin list is ignored"; fi

kill "$pidB"; wait "$pidB" 2>/dev/null
req PUT "$PA" /api/layout "$YPAGES"
check "A saves a newer layout while B is down" 200 "d['updatedAt']>$upA1"
HOME="$work/homeB" HUD_TOKEN_FILE="$work/hud.token" HUD_HUB_CONFIG="$work/peer-b.json" node "$here/hud-server.mjs" --mode hub --port "$PEER_B_PORT" --machine "Peer B" >"$work/peer-b2.log" 2>&1 & pidB=$!; pids+=("$pidB")
wait_up "$PB"
if wait_until '[ "$(b_left)" = approvals ]'; then ok "a restarted B pulls A's newer layout on start"; else bad "a restarted B pulls A's newer layout on start"; fi
if [ "$(layout_field "$PB" "d['updatedAt']")" = "$(layout_field "$PA" "d['updatedAt']")" ]; then ok "after the pull B and A hold the same stamp"; else bad "after the pull B and A hold the same stamp"; fi

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
