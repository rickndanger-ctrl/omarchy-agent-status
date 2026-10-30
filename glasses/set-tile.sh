#!/bin/bash
# Change ONE Tiles slot on a hub: set-tile.sh <hub-url> <page 1-5> <left|right> <widget>
# Reads the saved layout (GET /api/layout), changes that one slot (set-tile.py), saves it (PUT /api/layout; the hub passes it to its peers).
# Prints the page before and after. DRY_RUN=1 prints without saving. Token: $HUD_TOKEN, else the file $HUD_TOKEN_FILE (default ~/.config/agent-glasses/token).
# The token goes to curl in a header file (curl -H @file), never on the command line.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ $# -ne 4 ]; then echo "usage: $0 <hub-url> <page 1-5> <left|right> <widget>   (DRY_RUN=1 to only show)" >&2; exit 2; fi
url=${1%/}; page=$2; side=$3; widget=$4
case "$side" in left|right) ;; *) echo "side must be left or right" >&2; exit 2;; esac
case "$page" in [1-9]) ;; *) echo "page must be a number (1 is the first page)" >&2; exit 2;; esac
token=${HUD_TOKEN:-$(tr -d '\n' < "${HUD_TOKEN_FILE:-$HOME/.config/agent-glasses/token}")}
headers=$(mktemp)
trap 'rm -f "$headers"' EXIT
chmod 600 "$headers"
printf 'Authorization: Bearer %s\n' "$token" > "$headers"
before=$(curl -fsS -H "@$headers" "$url/api/layout")
after=$(printf '%s' "$before" | python3 "$here/set-tile.py" "$page" "$side" "$widget")
if [ "${DRY_RUN:-0}" = 1 ]; then echo "dry run: nothing saved" >&2; exit 0; fi
curl -fsS -X PUT -H "@$headers" -H 'Content-Type: application/json' -d "$after" "$url/api/layout" >/dev/null
echo "saved on $url" >&2
