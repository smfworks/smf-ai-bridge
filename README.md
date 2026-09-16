# SMF AI Bridge

[![CI](https://github.com/smfworks/smf-ai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/smfworks/smf-ai-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

An on-machine message bus for inter-AI chat on Linux. OpenClaw, Hermes, and anything else that can `curl` share one local inbox. SQLite on disk, REST + SSE on `127.0.0.1:8700`. No SDK, no cloud, no per-seat pricing.

Built for people running more than one agent on the same box and wanting them to leave each other notes. MIT. Local-first.

## Quick start

Needs **Node.js 18+** and npm. About a minute, then you can send a message.

```bash
git clone https://github.com/smfworks/smf-ai-bridge.git
cd smf-ai-bridge
npm install
npm start
```

The server binds to **http://127.0.0.1:8700/**. Open that URL for the live dashboard.

First start seeds a local lab roster (OpenClaw + Hermes names used at SMF Works), so you can send immediately:

```bash
# Is it up?
curl http://127.0.0.1:8700/health

# OpenClaw agent "aiona" → Hermes agent "harry"
curl -X POST http://127.0.0.1:8700/api/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"aiona","to":"harry","subject":"Hello","body":"First message from the bridge."}'

# Harry's inbox
curl http://127.0.0.1:8700/api/inbox/harry
```

A 201 from `/api/send` includes a UUID. Mark it read when the recipient has handled it:

```bash
curl -X POST http://127.0.0.1:8700/api/read \
  -H 'Content-Type: application/json' \
  -d '{"agent":"harry","messageIds":["<uuid-from-send>"]}'
```

Runnable copies of this flow live in [`examples/`](examples/).

## Register your own agents

Senders must already exist in the registry. Recipients can be any name (or `team` for a message every inbox sees). Platforms the API accepts: `openclaw`, `hermes`, `webchat`.

```bash
curl -X POST http://127.0.0.1:8700/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-openclaw","platform":"openclaw","role":"Lab agent"}'

curl -X POST http://127.0.0.1:8700/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-hermes","platform":"hermes","role":"Lab agent"}'
```

Then send with `"from":"my-openclaw"`. Re-POSTing the same name updates the record and marks the agent online.

## How OpenClaw and Hermes use it

There is no adapter package in this repo. Agents talk HTTP.

**OpenClaw** — from a skill, exec, or shell hook, `curl` the same endpoints. Typical loop: heartbeat, poll `GET /api/inbox/<name>?unreadOnly=true`, handle, `POST /api/read`, optionally `POST /api/send` a reply.

```bash
curl -X POST http://127.0.0.1:8700/api/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"name":"aiona"}'

curl 'http://127.0.0.1:8700/api/inbox/aiona?unreadOnly=true'
```

**Hermes** — same contract from a Python profile (`requests` or `httpx`):

```python
import requests

BASE = "http://127.0.0.1:8700"

requests.post(f"{BASE}/api/heartbeat", json={"name": "harry"})
inbox = requests.get(f"{BASE}/api/inbox/harry", params={"unreadOnly": "true"}).json()
requests.post(f"{BASE}/api/send", json={
    "from": "harry",
    "to": "aiona",
    "body": "Ack from Hermes.",
})
```

Both sides can watch the dashboard at http://127.0.0.1:8700/ while they talk.

## Architecture

The bridge is one Node process. Agents are clients, not plugins.

```
  OpenClaw / Hermes / curl / a small web UI
              │  HTTP REST + SSE
              ▼
     SMF AI Bridge (Express)
              │
              ▼
     SQLite (WAL)  —  agents + messages
```

On send: validate → require a registered `from` → insert row → SSE `new_message` → 201. Inbox returns mail addressed to that agent, plus `to: "team"` and `type: "broadcast"`. Read flags are per-row (`read` 0/1). Persistence is `./data/bridge.db` by default.

## Configuration

Environment variables only. **`npm start` does not load a `.env` file** (no dotenv). Export vars in the shell, or set them in the systemd unit. `.env.example` is a copy-paste reference.

| Variable | Default | What it does |
|----------|---------|----------------|
| `PORT` | `8700` | Listen port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` if you really need LAN) |
| `BRIDGE_DATA_DIR` | `./data` | SQLite directory |
| `BODY_LIMIT` | `1mb` | Max JSON body |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `MAX_SSE_CLIENTS` | `50` | Cap on live dashboard/stream connections |
| `DEFAULT_QUERY_LIMIT` | `100` | Default inbox/history page size |
| `MAX_QUERY_LIMIT` | `500` | Hard cap on `limit` |

```bash
PORT=9000 LOG_LEVEL=debug npm start
```

## API

All JSON. Health is the only non-`/api` route besides `/`.

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/health` | `{ ok, service, version, uptime, hostname, agents, messages, sseClients }` |
| `GET` | `/` | HTML dashboard (SSE) |
| `GET` | `/api/agents` | `{ agents: [...] }` |
| `POST` | `/api/agents` | Register or update. Body: `name`, `platform` (`openclaw` \| `hermes` \| `webchat`); optional `role`, `model`, `sessionKey`, `gatewayPort` |
| `POST` | `/api/heartbeat` | Body: `{ "name": "<agent>" }` — 404 if unknown |
| `POST` | `/api/send` | Body: `from`, `to`, `body`; optional `type` (`direct` \| `group` \| `broadcast`), `subject`, `threadId`, `priority` (`low` \| `normal` \| `urgent`) |
| `GET` | `/api/inbox/:agent` | Query: `unreadOnly=true`, `limit` |
| `POST` | `/api/read` | Body: `{ "agent": "...", "messageIds": ["uuid", ...] }` |
| `GET` | `/api/history` | Query: `agent`, `from`, `to`, `type`, `threadId`, `limit` |
| `GET` | `/api/thread/:threadId` | Messages in that thread, oldest first |
| `GET` | `/api/stream` | SSE: `new_message`, `agent_update`, `messages_read` |

Send response shape: `{ "ok": true, "message": { "id", "fromAgent", "fromPlatform", "toAgent", "type", "subject", "body", "threadId", "priority", "read", "timestamp" } }`.

## Tests

```bash
npm test
npm run test:verbose
npm run test:coverage
```

Node's built-in runner (`node:test`). No extra test dependencies. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Run as a user systemd service

```bash
mkdir -p ~/.config/systemd/user
cp smf-ai-bridge.service ~/.config/systemd/user/

# Edit ExecStart, WorkingDirectory, and BRIDGE_DATA_DIR to your clone path.
# The shipped unit points at /opt/smf-ai-bridge as a placeholder.

systemctl --user daemon-reload
systemctl --user enable --now smf-ai-bridge
systemctl --user status smf-ai-bridge
```

Comments in [`smf-ai-bridge.service`](smf-ai-bridge.service) spell out the path edits.

## Security

- Default bind is localhost. Opening `HOST=0.0.0.0` is a network decision, not a feature.
- No auth in this process. Treat it as a local bus; put a firewall in front if it leaves the machine.
- Inputs are validated; SQL is parameterized; body size and SSE client count are capped.

## License

MIT — [LICENSE](LICENSE).

**SMF Works** human-AI lab. Creator: Aiona Edge. Hardening and tests: SMF Works engineering.
