#!/usr/bin/env bash
# Proves Muse itself is untouched: muse-clean.mjs, every /api/muse* route, museReply, askMuse, museMoved/museMoving,
# museTrimLogged and every Muse-named home-app/src file are byte-identical to commit 56fe3b2, and the Home Muse spans
# pinned by orch-hold-frozen.mjs still match. Fails closed on a missing anchor. Read-only.
#   bash glasses/test-muse-frozen.sh      (needs git and node)
set -u
here=$(cd "$(dirname "$0")" && pwd)
pass=0; fail=0
ok() { echo "  ok    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

git -C "$here" rev-parse --verify -q "56fe3b2^{commit}" >/dev/null || { echo "  FAIL  base commit 56fe3b2 not found"; exit 1; }

if node "$here/test-helpers/muse-frozen-check.mjs"; then
  ok "hub Muse and Home Muse files byte-identical to 56fe3b2"
else
  bad "a Muse block or file differs from 56fe3b2, or an anchor is missing"
fi
if node "$here/test-helpers/orch-hold-frozen.mjs"; then
  ok "Home Muse spans pinned by orch-hold-frozen.mjs match"
else
  bad "orch-hold-frozen.mjs failed"
fi
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
