#!/bin/sh
set -eu
case "${1:-mcp}" in
  docs)
    shift
    exec python3 /opt/ma3-docs/scripts/serve.py "$@"
    ;;
  import)
    shift
    cd /opt/ma3-docs
    exec sh scripts/build_all.sh "$@"
    ;;
  mcp)
    if [ "$#" -gt 0 ]; then shift; fi
    ;;
  *) exec "$@" ;;
esac
if [ "${GMA3_DOCS_LOCAL:-0}" = 1 ]; then
  python3 /opt/ma3-docs/scripts/serve.py --host 127.0.0.1 --port 8765 >&2 &
  reference_pid=$!
  trap 'kill "$reference_pid" 2>/dev/null || true' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  python3 - <<'PY'
import time
import urllib.request
for attempt in range(100):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=1):
            break
    except OSError:
        time.sleep(0.1)
else:
    raise SystemExit('Bundled reference server did not become ready')
PY
  exec 3<&0
  node /app/dist/index.js "$@" <&3 &
  mcp_pid=$!
  trap 'kill "$mcp_pid" "$reference_pid" 2>/dev/null || true; exit 143' TERM
  trap 'kill "$mcp_pid" "$reference_pid" 2>/dev/null || true; exit 130' INT
  wait "$mcp_pid"
else
  exec node /app/dist/index.js "$@"
fi
