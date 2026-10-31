#!/usr/bin/env bash
# Guards the Muse Listen stitch: G2 OMAC and its Muse path must stay byte-identical to the frozen base commit.
# Fails unless muse-clean.mjs is unchanged since the base, home-app/ is unchanged since the base (or since the approved
# Conversation removal 8e57984 when that is an ancestor; files ADDED under home-app/tests/ are allowed), and every /api/muse* route block plus
# museReply and askMuse in hud-server.mjs is byte-identical to the base. Read-only; touches nothing.
#   bash glasses/test-listen-frozen.sh      (needs git and python3)
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
BASE=${FROZEN_BASE:-56fe3b2}
cd "$repo" || exit 1
pass=0; fail=0
ok() { echo "  ok    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

git rev-parse --verify -q "$BASE^{commit}" >/dev/null || { echo "  FAIL  base commit $BASE not found"; exit 1; }

# 1. whole paths: no diff against the base (committed or not), and no untracked file added inside them.
# home-app/ is the approved exception: the Claude Conversation removal (8e57984) changed it on purpose, so when that commit
# is an ancestor of HEAD, home-app/ must equal 8e57984 (not the older base); otherwise it must equal the base.
HOME_BASE=${FROZEN_HOME_BASE:-8e57984}
if git rev-parse --verify -q "$HOME_BASE^{commit}" >/dev/null && git merge-base --is-ancestor "$HOME_BASE" HEAD; then
  home_ref=$HOME_BASE
else
  home_ref=$BASE
fi
# muse-clean.mjs: no difference at all.
if git diff --quiet "$BASE" -- glasses/muse-clean.mjs; then ok "glasses/muse-clean.mjs: git diff $BASE is empty"; else bad "glasses/muse-clean.mjs differs from $BASE: $(git diff --stat "$BASE" -- glasses/muse-clean.mjs | tail -1)"; fi
# home-app/: every file equals the reference, except that files ADDED under glasses/home-app/tests/ are allowed (new tests, e.g.
# the simulator check). A modified, deleted or renamed file anywhere in home-app/, or an added file outside tests/, fails.
changes=$(git diff --name-status --no-renames "$home_ref" -- glasses/home-app)
disallowed=$(printf '%s\n' "$changes" | awk -F'\t' 'NF >= 2 && !($1 == "A" && index($2, "glasses/home-app/tests/") == 1) { print $1 " " $2 }')
added_ok=$(printf '%s\n' "$changes" | awk -F'\t' '$1 == "A" && index($2, "glasses/home-app/tests/") == 1 { print $2 }')
if [ -z "$disallowed" ]; then
  ok "glasses/home-app: equal to $home_ref except files added under tests/ ($(printf '%s' "$added_ok" | grep -c . ) added)"
else
  bad "glasses/home-app differs from $home_ref beyond added tests/ files: $(printf '%s' "$disallowed" | tr '\n' ';')"
fi
extra=$(git ls-files --others --exclude-standard -- glasses/home-app glasses/muse-clean.mjs | grep -v '^glasses/home-app/tests/' || true)
if [ -z "$extra" ]; then ok "no untracked files in the frozen paths (outside home-app/tests/)"; else bad "untracked in a frozen path: $extra"; fi

# 2. the Muse blocks of hud-server.mjs, compared as text with the base's
git show "$BASE:glasses/hud-server.mjs" > "${TMPDIR:-/tmp}/frozen-base.$$" || exit 1
trap 'rm -f "${TMPDIR:-/tmp}/frozen-base.$$"' EXIT
python3 - "${TMPDIR:-/tmp}/frozen-base.$$" "$here/hud-server.mjs" <<'PY'
import re, sys
base, cur = (open(p, encoding="utf-8").read().split("\n") for p in sys.argv[1:3])

def blocks(lines):
    """Name -> exact source text of: each `if (... p === '/api/muse...') {` route block, museReply (with the comment
    lines above it, from the museTrimLogged line) and askMuse. A block runs to the line that closes its indent."""
    out = {}
    for i, line in enumerate(lines):
        m = re.match(r"^(\s*)if \(.*p === '(/api/muse[^']*)'", line)
        if m:
            key = f"route {m.group(2)}" + (f" [{re.search(r'req.method === .(\w+).', line).group(1)}]" if "req.method" in line else "")
        elif line.startswith("const museTrimLogged"):
            key, m = "museTrimLogged", re.match(r"^()", line)
        elif line.startswith("function museReply"):
            key, m = "museReply", re.match(r"^()", line)
        elif line.startswith("async function askMuse"):
            key, m = "askMuse", re.match(r"^()", line)
        elif line.startswith("const museMoved") or line.startswith("const museMoving"):
            key, m = line.split()[1], re.match(r"^()", line)
        else:
            continue
        indent = m.group(1)
        if line.rstrip().endswith("{"):
            j = i + 1
            while j < len(lines) and not (lines[j].startswith(indent + "}") and not lines[j].startswith(indent + "  ")):
                j += 1
            text = "\n".join(lines[i:j + 1])
        else:
            text = line
        out[key] = text
    return out

b, c = blocks(base), blocks(cur)
# askMuse may differ from the base by EXACTLY ONE substitution (Listen's Muse may be asked while its composer is busy,
# because the real relay queues the question): nothing else in it, and every other block stays byte-identical.
OLD = "if (!health.ok || !health.composer) continue"
NEW = "if (!health.ok || (!health.composer && !LISTEN_MUSE.holds(i))) continue"
if "askMuse" in b and b["askMuse"].count(OLD) == 1:
    b["askMuse"] = b["askMuse"].replace(OLD, NEW)
else:
    print("  FAIL  askMuse: the base no longer has the one line this check allows to change"); sys.exit(2)
need = {"museReply", "askMuse", "museTrimLogged", "museMoved", "museMoving"}
routes = {k for k in b if k.startswith("route ")}
if not routes or not need <= set(b):
    print(f"  FAIL  could not find the Muse blocks in the base (found {sorted(b)})"); sys.exit(2)
bad = 0
for name in sorted(b):
    if name not in c:
        print(f"  FAIL  {name}: missing from hud-server.mjs"); bad += 1
    elif c[name] != b[name]:
        print(f"  FAIL  {name}: differs from the base"); bad += 1
    else:
        print(f"  ok    {name}: byte-identical to the base")
for name in sorted(set(c) - set(b)):
    print(f"  FAIL  {name}: a new Muse block that the base does not have (Listen belongs under /api/listen/* only)"); bad += 1
sys.exit(1 if bad else 0)
PY
rc=$?
# the python lines count as pass/fail too
[ "$rc" -eq 0 ] && ok "hud-server.mjs: all Muse blocks frozen" || bad "hud-server.mjs: a Muse block changed (rc=$rc)"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
