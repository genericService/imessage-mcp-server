#!/usr/bin/env bash
set -e

mkdir -p certs
cd certs

IP_ADDR=$(ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")

echo "Generating self-signed HTTPS certificate for IP: $IP_ADDR and localhost..."

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout server.key \
  -out server.crt \
  -subj "/CN=imessage-mcp-server" \
  -addext "subjectAltName=IP:$IP_ADDR,IP:127.0.0.1,DNS:localhost"

echo "Certificates generated successfully in certs/ directory!"
