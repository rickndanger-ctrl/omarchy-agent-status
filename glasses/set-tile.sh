#!/bin/bash
# Change ONE Tiles slot on a hub: set-tile.sh <hub-url> <page 1-5> <left|right> <widget>
# Reads the saved layout (GET /api/layout), changes that one slot, saves it (PUT /api/layout; the hub passes it to its peers).
# Prints the page before and after. DRY_RUN=1 prints without saving. Token: $HUD_TOKEN, else the file $HUD_TOKEN_FILE (default ~/.config/agent-glasses/token).
set -eu
if [ $# -ne 4 ]; then echo "usage: $0 <hub-url> <page 1-5> <left|right> <widget>   (DRY_RUN=1 to only show)" >&2; exit 2; fi
url=${1%/}; page=$2; side=$3; widget=$4
case "$side" in left|right) ;; *) echo "side must be left or right" >&2; exit 2;; esac
case "$page" in [1-9]) ;; *) echo "page must be a number (1 is the first page)" >&2; exit 2;; esac
token=${HUD_TOKEN:-$(tr -d '\n' < "${HUD_TOKEN_FILE:-$HOME/.config/agent-glasses/token}")}
before=$(curl -fsS -H "Authorization: Bearer $token" "$url/api/layout")
export before page side widget
after=$(python3 - <<'PY'
import json, os, sys
d = json.loads(os.environ['before'])
i = int(os.environ['page']) - 1
if not 0 <= i < len(d['pages']):
    sys.exit('page %s does not exist (the layout has %d pages)' % (os.environ['page'], len(d['pages'])))
print('before: page %s %s = %s' % (os.environ['page'], os.environ['side'], d['pages'][i][os.environ['side']]), file=sys.stderr)
d['pages'][i][os.environ['side']] = os.environ['widget']
print('after:  page %s %s = %s' % (os.environ['page'], os.environ['side'], os.environ['widget']), file=sys.stderr)
print(json.dumps({'pages': d['pages']}))
PY
)
if [ "${DRY_RUN:-0}" = 1 ]; then echo "dry run: nothing saved" >&2; exit 0; fi
curl -fsS -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$after" "$url/api/layout" >/dev/null
echo "saved on $url" >&2
