#!/usr/bin/env bash
# Agent voice privacy may change; Muse, its UI, the menu and Tiles stay at release 0.4.28.
# Unlike test-listen-frozen.sh, this gate does not freeze the entire home-app directory.
# An optional snapshot directory is for mutation tests; the baseline is always the pinned release.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
node "$here/test-helpers/orch-hold-frozen.mjs" "$@"
