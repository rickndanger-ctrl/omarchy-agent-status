#!/usr/bin/env bash
# Agent voice privacy may change; Muse, its UI, the menu and Tiles stay at release 0.4.28.
# This gate does not freeze the entire home-app directory (see test-muse-frozen.sh for the Muse proof).
# An optional snapshot directory is for mutation tests; the baseline is always the pinned release.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
node "$here/test-helpers/orch-hold-frozen.mjs" "$@"
