#!/usr/bin/env bash
# Health check for the whole Home setup, run from the laptop (Dell):
#   bash ~/Projects/omarchy-agent-status/glasses/check-all.sh
# Prints one OK / FAIL line per piece. Read-only: it never types into agents or Muse.
# Your hub names and Tailscale suffix live in ~/.config/agent-glasses/check.conf (not in git):
#   TS=your-tailnet.ts.net
#   HUBS="hub-1 hub-2 hub-3"            # Tailscale machine names of the hubs, in order
#   MSG_HOST=hub-1                      # where the Messages relay runs
#   MUSE_HOSTS="hub-2 hub-1"            # where Muse relays run
CONF="$HOME/.config/agent-glasses/check.conf"
[ -f "$CONF" ] || { echo "Missing $CONF (see the top of this script)."; exit 1; }
. "$CONF"
pass=0; fail=0
ok()  { printf '  OK    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

T=$(ssh -o ConnectTimeout=8 macmini1 'python3 -c "import json,os;print(json.load(open(os.path.expanduser(\"~/.messages-relay/config.json\")))[\"token\"])"' 2>/dev/null)
[ -n "$T" ] || { echo "Cannot reach Mini 1 for the token; is it on?"; exit 1; }

echo "Hubs (the glasses talk to these)"
for hub in $HUBS; do
  home=$(curl -s -m 10 "https://$hub.$TS/hud/api/home" -H "Authorization: Bearer $T")
  if [ -z "$home" ]; then bad "$hub hub unreachable"; continue; fi
  ok "$hub hub answers"
  echo "$home" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for m in d["machines"]:
    print(("  OK    " if m["online"] else "  FAIL  ") + "  sees " + m["name"])
talk = sum(1 for s in d["sessions"] if s.get("pane") or s.get("window"))
print(("  OK    " if talk else "  FAIL  ") + f"  {talk} agents you can talk to")
print(("  OK    " if d.get("voice") else "  FAIL  ") + "  voice (Groq)")
print(("  OK    " if d.get("messages") is not None else "  FAIL  ") + "  messages")
print(("  OK    " if d.get("muse") else "  FAIL  ") + "  Muse")
print(("  OK    " if d.get("weather") else "  --    ") + "  weather" + ("" if d.get("weather") else " (appears after the phone shares its location)"))
'
done

echo "Relays"
check "Messages relay ($MSG_HOST)" "curl -sf -m 8 https://$MSG_HOST.$TS/msg/health"
for m in $MUSE_HOSTS; do
  check "Muse ready on $m" "curl -s -m 15 https://$m.$TS/muse/selftest | grep -q '\"composer\":true'"
done

echo "Background services"
check "Dell node service" "systemctl --user is-active agent-glasses.service"
for h in macmini1 macbook-neo; do
  check "$h node/hub service" "ssh -o ConnectTimeout=8 $h 'launchctl list | grep -q com.rick.home-hud'"
  check "$h always-open sessions job" "ssh -o ConnectTimeout=8 $h 'launchctl list | grep -q com.rick.home-agents'"
  check "$h always-open agents running" "ssh -o ConnectTimeout=8 $h 'DRY_RUN=1 bash ~/Projects/omarchy-agent-status/glasses/agent-sessions.sh | grep -qv would'"
done
check "Mini 2 node/hub service" "ssh -o ConnectTimeout=8 macmini1 \"ssh mini-2 'launchctl list | grep -q com.rick.home-hud'\""
check "Mini 2 always-open sessions job" "ssh -o ConnectTimeout=8 macmini1 \"ssh mini-2 'launchctl list | grep -q com.rick.home-agents'\""
check "Mini 2 always-open agents running" "ssh -o ConnectTimeout=8 macmini1 \"ssh mini-2 'DRY_RUN=1 bash ~/Projects/omarchy-agent-status/glasses/agent-sessions.sh | grep -qv would'\""

echo "Phone notifications"
check "ntfy configured on Mini 1" "ssh macmini1 'grep -q ntfy ~/.config/agent-glasses/hub.json'"
check "ntfy.sh reachable" "curl -sf -m 8 -o /dev/null https://ntfy.sh/v1/health"

echo "After a power cut (Macs must log in by themselves for anything to start)"
for h in macmini1 macbook-neo; do
  user=$(ssh -o ConnectTimeout=8 $h 'defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null')
  if [ -n "$user" ]; then ok "$h logs in automatically ($user)"; else bad "$h does NOT log in automatically after a restart"; fi
done
user=$(ssh -o ConnectTimeout=8 macmini1 "ssh mini-2 'defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null'")
if [ -n "$user" ]; then ok "Mini 2 logs in automatically ($user)"; else bad "Mini 2 does NOT log in automatically after a restart"; fi

echo
echo "$pass passed, $fail failed"
