#!/usr/bin/env bash
# Fake-only live transcript page tests; owns bounded children and guarded local sockets.
set -euo pipefail
listen_page_test_dir=$(cd "$(dirname "$0")" && pwd)
exec python3 "$listen_page_test_dir/test-helpers/test-hub-listen-page.py" "$@"
