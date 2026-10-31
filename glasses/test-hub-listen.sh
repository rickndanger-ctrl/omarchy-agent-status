#!/usr/bin/env bash
# Fake-only Muse Listen HTTP integration. The foreground Python owner bounds
# every hub child and tears down its exact process group on exit or interruption.
set -euo pipefail
listen_test_here=$(cd "$(dirname "$0")" && pwd)
exec python3 "$listen_test_here/test-helpers/test-hub-listen.py" "$@"
