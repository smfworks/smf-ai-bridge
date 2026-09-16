#!/usr/bin/env bash
# Heartbeat + unread poll + mark-read, using the seeded lab agents aiona / harry.
set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:8700}"

if ! curl -sf "${BRIDGE_URL}/health" >/dev/null; then
  echo "Bridge is not running at ${BRIDGE_URL}" >&2
  echo "From the repo root: npm start" >&2
  exit 1
fi

echo "== aiona heartbeat =="
curl -sS -X POST "${BRIDGE_URL}/api/heartbeat" \
  -H 'Content-Type: application/json' \
  -d '{"name":"aiona"}'
echo

echo "== send unread mail to harry =="
SEND_JSON="$(curl -sS -X POST "${BRIDGE_URL}/api/send" \
  -H 'Content-Type: application/json' \
  -d '{"from":"aiona","to":"harry","subject":"poll-me","body":"Unread until you mark it."}')"
echo "${SEND_JSON}"

MSG_ID="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.message.id)" "${SEND_JSON}")"

echo
echo "== harry unread poll =="
curl -sS "${BRIDGE_URL}/api/inbox/harry?unreadOnly=true"
echo

echo "== harry marks ${MSG_ID} read =="
curl -sS -X POST "${BRIDGE_URL}/api/read" \
  -H 'Content-Type: application/json' \
  -d "{\"agent\":\"harry\",\"messageIds\":[\"${MSG_ID}\"]}"
echo

echo "== harry unread poll (should omit that id) =="
curl -sS "${BRIDGE_URL}/api/inbox/harry?unreadOnly=true"
echo
