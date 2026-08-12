#!/usr/bin/env bash
# Health check for the iMessage MCP Server.
# Exits non-zero if any critical check fails, so it can be used by a monitor.
set -uo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

PORT="${PORT:-8765}"
LOCAL_BASE="${LOCAL_BASE:-http://127.0.0.1:${PORT}}"
PUBLIC_BASE="${PUBLIC_BASE:-https://imessage.genericservice.app}"
FAILURES=0

echo "=== iMessage MCP Server Health Check ==="
echo ""

pass() { printf "  %-32s ${GREEN}OK${NC} %s\n" "$1" "${2:-}"; }
warn() { printf "  %-32s ${YELLOW}WARN${NC} %s\n" "$1" "${2:-}"; }
fail() { printf "  %-32s ${RED}FAIL${NC} %s\n" "$1" "${2:-}"; FAILURES=$((FAILURES + 1)); }

# 1. Local server
LOCAL_BODY=$(curl -s --connect-timeout 2 --max-time 5 "${LOCAL_BASE}/health" 2>/dev/null)
if [[ -n "$LOCAL_BODY" ]]; then
  pass "Local Server (:${PORT})" "HTTP 200"

  # Surface the richer diagnostics the /health payload now exposes.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$LOCAL_BODY" <<'PY' || true
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

up = d.get("uptime_seconds", 0)
h, rem = divmod(int(up), 3600)
m = rem // 60
print(f"    uptime            : {h}h {m}m")
print(f"    sessions          : {d.get('activeHttpSessions', 0)} http / {d.get('activeSseSessions', 0)} sse")
cli = d.get("cli", {})
print(f"    cli subprocesses  : {cli.get('inFlight', 0)} running, {cli.get('queued', 0)} queued (max {cli.get('maxConcurrent', '?')})")
mem = d.get("memory", {})
print(f"    memory            : {mem.get('rss_mb', '?')} MB rss / {mem.get('heap_used_mb', '?')} MB heap")

audit = d.get("audit", {})
if audit.get("degraded"):
    print(f"    audit log         : DEGRADED ({audit.get('reason', 'unknown')})")

for w in d.get("warnings", []):
    print(f"    config warning    : {w}")
PY
  fi
else
  fail "Local Server (:${PORT})" "no response"
fi

# 2. Readiness probe
READY_CODE=$(curl -so /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "${LOCAL_BASE}/ready" 2>/dev/null || echo "000")
case "$READY_CODE" in
  200) pass "Readiness Probe" "ready" ;;
  503) warn "Readiness Probe" "draining or unhealthy" ;;
  *)   fail "Readiness Probe" "HTTP ${READY_CODE}" ;;
esac

# 3. Cloudflare Tunnel (macOS launchd only)
if command -v launchctl >/dev/null 2>&1; then
  if launchctl list 2>/dev/null | grep -q "com.genericservice.imessage-tunnel"; then
    pass "Cloudflare Tunnel Service" "active"
  else
    warn "Cloudflare Tunnel Service" "inactive"
  fi
else
  warn "Cloudflare Tunnel Service" "launchctl unavailable (not macOS)"
fi

# 4. Public endpoint
PUBLIC_STATUS=$(curl -so /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 "${PUBLIC_BASE}/health" 2>/dev/null || echo "000")
if [[ "$PUBLIC_STATUS" == "200" ]]; then
  pass "Public Tunnel Endpoint" "HTTP 200"
else
  warn "Public Tunnel Endpoint" "HTTP ${PUBLIC_STATUS}"
fi

# 5. macOS prerequisites
if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ -f "${HOME}/Library/Messages/chat.db" ]]; then
    if head -c 1 "${HOME}/Library/Messages/chat.db" >/dev/null 2>&1; then
      pass "iMessage Database" "readable"
    else
      fail "iMessage Database" "exists but unreadable - grant Full Disk Access"
    fi
  else
    fail "iMessage Database" "not found"
  fi
fi

echo ""
if [[ "$FAILURES" -gt 0 ]]; then
  printf "${RED}%s critical check(s) failed.${NC}\n" "$FAILURES"
  exit 1
fi
printf "${GREEN}All critical checks passed.${NC}\n"
