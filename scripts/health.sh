#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=== iMessage MCP Server Health Check ==="
echo ""

# 1. Local HTTP Server Check
LOCAL_STATUS=$(curl -so /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:8765/health" 2>/dev/null || echo "000")
if [[ "$LOCAL_STATUS" == "200" ]]; then
  printf "  %-30s ${GREEN}OK (HTTP %s)${NC}\n" "Local Server (127.0.0.1:8765)" "$LOCAL_STATUS"
else
  printf "  %-30s ${RED}FAIL (HTTP %s)${NC}\n" "Local Server (127.0.0.1:8765)" "$LOCAL_STATUS"
fi

# 2. Cloudflare Tunnel Service Check
TUNNEL_ACTIVE=$(launchctl list 2>/dev/null | grep "com.genericservice.imessage-tunnel" || true)
if [[ -n "$TUNNEL_ACTIVE" ]]; then
  printf "  %-30s ${GREEN}OK (Active Launchd Service)${NC}\n" "Cloudflare Tunnel Service"
else
  printf "  %-30s ${RED}FAIL (Service Inactive)${NC}\n" "Cloudflare Tunnel Service"
fi

# 3. Public HTTPS Endpoint Check
PUBLIC_STATUS=$(curl -so /dev/null -w '%{http_code}' --connect-timeout 3 -H "CF-Access-Client-Id: REDACTED_CF_ACCESS_ID.access" -H "CF-Access-Client-Secret: REDACTED_CF_ACCESS_SECRET" "https://imessage.genericservice.app/health" 2>/dev/null || echo "000")
if [[ "$PUBLIC_STATUS" == "200" ]]; then
  printf "  %-30s ${GREEN}OK (HTTP %s)${NC}\n" "Public Tunnel Endpoint" "$PUBLIC_STATUS"
else
  printf "  %-30s ${RED}FAIL (HTTP %s)${NC}\n" "Public Tunnel Endpoint" "$PUBLIC_STATUS"
fi
