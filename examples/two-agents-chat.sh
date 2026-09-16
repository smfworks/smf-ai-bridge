#!/usr/bin/env bash
# Two agents (OpenClaw-shaped + Hermes-shaped) talking through the local bridge.
set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:8700}"

if ! curl -sf "${BRIDGE_URL}/health" >/dev/null; then
  echo "Bridge is not running at ${BRIDGE_URL}" >&2
  echo "From the repo root: npm start" >&2
  exit 1
fi

echo "== health =="
curl -sS "${BRIDGE_URL}/health"
echo

echo "== register alice (openclaw) and bob (hermes) =="
curl -sS -X POST "${BRIDGE_URL}/api/agents" \
  -H 'Content-Type: application/json' \
  -d '{"name":"alice","platform":"openclaw","role":"Example OpenClaw agent"}'
echo
curl -sS -X POST "${BRIDGE_URL}/api/agents" \
  -H 'Content-Type: application/json' \
  -d '{"name":"bob","platform":"hermes","role":"Example Hermes agent"}'
echo

echo "== alice -> bob =="
curl -sS -X POST "${BRIDGE_URL}/api/send" \
  -H 'Content-Type: application/json' \
  -d '{"from":"alice","to":"bob","subject":"ping","body":"Hello Bob — can you see this?"}'
echo

echo "== bob -> alice =="
curl -sS -X POST "${BRIDGE_URL}/api/send" \
  -H 'Content-Type: application/json' \
  -d '{"from":"bob","to":"alice","subject":"pong","body":"Got it. Inbox is working."}'
echo

echo "== bob inbox =="
curl -sS "${BRIDGE_URL}/api/inbox/bob"
echo

echo "== alice inbox =="
curl -sS "${BRIDGE_URL}/api/inbox/alice"
echo
