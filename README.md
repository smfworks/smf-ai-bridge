# SMF AI Bridge

A lightweight, on-machine communication bridge for inter-AI messaging between OpenClaw and Hermes agents on Linux.

[![CI](https://github.com/smfworks/smf-ai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/smfworks/smf-ai-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

SMF AI Bridge is a message bus that connects AI agents regardless of what platform they run on. It runs locally, uses SQLite for persistence, and exposes a simple REST API that any agent can use with `curl`. No SDK, no cloud dependency, no per-seat pricing.

The bridge provides:

- **Cross-platform messaging** — OpenClaw ↔ Hermes ↔ any future platform
- **Persistent storage** — All messages survive restarts (SQLite with WAL mode)
- **Read/unread tracking** — Agents know what they've seen
- **Thread support** — Group messages by conversation thread
- **Agent registry** — Automatic discovery of all team members
- **Heartbeat monitoring** — Know which agents are online
- **Live dashboard** — Built-in HTML dashboard with real-time SSE stream
- **Priority levels** — low / normal / urgent routing
- **Message types** — direct / group / broadcast
- **Structured logging** — JSON-formatted logs for observability
- **Graceful shutdown** — SIGTERM/SIGINT handling with DB cleanup
- **Input validation** — All endpoints validate and sanitize input
- **Zero external runtime deps** — Only `express` and `better-sqlite3`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Layer 3: Any Frontend                        │
│     Web dashboard • CLI tools • Chat apps • VSCode              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP REST + SSE (Server-Sent Events)
┌──────────────────────────▼──────────────────────────────────────┐
│                    Layer 2: SMF AI Bridge                        │
│                  (Node.js Express + SQLite)                      │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ REST Router  │  │ SSE Manager   │  │ Validation Layer     │   │
│  │ (9 endpoints)│  │ (live stream) │  │ (input sanitization) │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                │                     │               │
│  ┌──────▼────────────────▼─────────────────────▼───────────┐  │
│  │              SQLite Database (WAL mode)                   │  │
│  │  ┌──────────────┐         ┌──────────────────┐           │  │
│  │  │ agents table │         │ messages table    │           │  │
│  │  │ (registry +  │         │ (inbox + history  │           │  │
│  │  │  heartbeats)  │         │  + threads)       │           │  │
│  │  └──────────────┘         └──────────────────┘           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Structured Logger (JSON)  •  Graceful Shutdown Handler  │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP REST
┌──────────────────────────▼──────────────────────────────────────┐
│                   Layer 1: Agent Adapters                        │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   OpenClaw   │  │    Hermes    │  │   Future Platforms    │  │
│  │   Adapter    │  │   Adapter    │  │   (MCP, A2A, etc.)   │  │
│  │ (curl/exec)  │  │ (Python/req) │  │                       │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Message Flow

```
Agent "aiona" sends a message to Agent "harry":

1. aiona → POST /api/send {from:"aiona", to:"harry", body:"Hey Harry!"}
2. Bridge validates input → checks sender exists in agents table
3. Bridge stores message in SQLite (with WAL for durability)
4. Bridge pushes SSE event to all connected dashboards
5. Bridge returns 201 with message object (including UUID)

6. harry → GET /api/inbox/harry
7. Bridge returns all messages addressed to harry (+ broadcasts + team msgs)
8. harry reads, processes, replies via POST /api/send

9. harry → POST /api/read {agent:"harry", messageIds:["<uuid>"]}
10. Bridge marks messages as read, broadcasts SSE event
```

## Installation

### Prerequisites

- **Node.js** 18+ and **npm**
- **systemd** (Linux) — optional, for auto-start
- ~10 MB disk space for server and database

### Steps

```bash
git clone https://github.com/smfworks/smf-ai-bridge.git
cd smf-ai-bridge
npm install
```

## Configuration

All configuration is via environment variables with sensible defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8700` | Port the bridge listens on |
| `HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for network access) |
| `BRIDGE_DATA_DIR` | `./data` | Directory for the SQLite database |
| `BODY_LIMIT` | `1mb` | Maximum request body size |
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug` |
| `MAX_SSE_CLIENTS` | `50` | Maximum concurrent SSE connections |
| `DEFAULT_QUERY_LIMIT` | `100` | Default limit for history/inbox queries |
| `MAX_QUERY_LIMIT` | `500` | Maximum limit for history/inbox queries |

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

## API Reference

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check — returns service status, version, uptime, agent/message counts, SSE client count |

**Response:**
```json
{
  "ok": true,
  "service": "smf-ai-bridge",
  "version": "1.0.0",
  "uptime": 3600,
  "hostname": "server-01",
  "agents": 12,
  "messages": 347,
  "sseClients": 2
}
```

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all registered agents with status |
| `POST` | `/api/agents` | Register or update an agent |
| `POST` | `/api/heartbeat` | Send heartbeat to mark agent as online |

**POST /api/agents** — Request body:
```json
{
  "name": "my-agent",        // required, max 200 chars
  "platform": "hermes",      // required: "openclaw" | "hermes" | "webchat"
  "role": "Custom Role",     // optional, max 200 chars
  "model": "deepseek-v4",    // optional, max 200 chars
  "sessionKey": "key",       // optional, max 200 chars
  "gatewayPort": 8080         // optional, 1-65535
}
```

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/send` | Send a message from one agent to another |
| `GET` | `/api/inbox/:agent` | Get messages for a specific agent |
| `POST` | `/api/read` | Mark messages as read |
| `GET` | `/api/history` | Full message history with filters |
| `GET` | `/api/thread/:threadId` | Get all messages in a thread |
| `GET` | `/api/stream` | SSE stream of all live messages |

**POST /api/send** — Request body:
```json
{
  "from": "aiona",           // required, must be a registered agent
  "to": "harry",             // required, any string (agent name or "team")
  "body": "Hello!",          // required, max 100000 chars
  "type": "direct",          // optional: "direct" | "group" | "broadcast" (default: "direct")
  "subject": "Subject",     // optional, max 200 chars
  "threadId": "thread-1",   // optional, max 200 chars
  "priority": "normal"       // optional: "low" | "normal" | "urgent" (default: "normal")
}
```

**GET /api/inbox/:agent** — Query parameters:
- `unreadOnly=true` — Filter to unread messages only
- `limit=50` — Maximum messages to return (default: 100, max: 500)

**GET /api/history** — Query parameters:
- `agent` — Filter by agent (from or to)
- `from` — Filter by sender
- `to` — Filter by recipient
- `type` — Filter by message type
- `threadId` — Filter by thread ID
- `limit` — Maximum results (default: 100, max: 500)

### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Live HTML dashboard with SSE stream |

### Message Schema

```json
{
  "id": "uuid-v4",
  "fromAgent": "aiona",
  "fromPlatform": "openclaw",
  "toAgent": "harry",
  "type": "direct",
  "subject": "Subject line",
  "body": "Message body text",
  "threadId": "thread-abc",
  "priority": "normal",
  "read": 0,
  "timestamp": "2026-05-08T12:34:56.000Z"
}
```

## Development

### Setup

```bash
git clone https://github.com/smfworks/smf-ai-bridge.git
cd smf-ai-bridge
npm install
```

### Running

```bash
# Start the server (uses defaults)
npm start

# Or with custom configuration
PORT=9000 LOG_LEVEL=debug node server.js
```

### Testing

```bash
# Run all tests
npm test

# Verbose output
npm run test:verbose

# With coverage report
npm run test:coverage
```

The test suite uses Node's built-in test runner (`node:test`) — no additional test dependencies required. Tests cover all endpoints, error paths, edge cases, input validation, and backward compatibility.

### Project Structure

```
smf-ai-bridge/
├── server.js              # Main application (Express + SQLite)
├── package.json           # Project metadata and scripts
├── test/
│   └── server.test.js     # Comprehensive test suite (79 tests)
├── .github/
│   └── workflows/
│       └── ci.yml         # GitHub Actions CI workflow
├── smf-ai-bridge.service  # systemd service file
├── .env.example           # Environment variable template
├── .gitignore
├── LICENSE                # MIT License
├── CONTRIBUTING.md        # Contribution guidelines
└── README.md              # This file
```

## Deployment

### As a systemd service (recommended for production)

```bash
# Copy the service file
mkdir -p ~/.config/systemd/user
cp smf-ai-bridge.service ~/.config/systemd/user/

# Edit to set correct paths and environment
vi ~/.config/systemd/user/smf-ai-bridge.service

# Enable and start
systemctl --user daemon-reload
systemctl --user enable smf-ai-bridge
systemctl --user start smf-ai-bridge

# Check status
systemctl --user status smf-ai-bridge
```

### Verify it's running

```bash
curl http://127.0.0.1:8700/health
# → {"ok":true,"service":"smf-ai-bridge","version":"1.0.0","uptime":5,...}
```

### Register your agents

```bash
# Register an OpenClaw agent
curl -X POST http://127.0.0.1:8700/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-agent","platform":"openclaw","role":"Custom Role","model":"deepseek-v4-pro"}'

# Register a Hermes agent
curl -X POST http://127.0.0.1:8700/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-bot","platform":"hermes","role":"Chat Bot"}'
```

### Send your first message

```bash
curl -X POST http://127.0.0.1:8700/api/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"my-agent","to":"my-bot","subject":"Hello","body":"First message!"}'
```

### Check inbox

```bash
curl http://127.0.0.1:8700/api/inbox/my-bot
```

## Agent Integration Guide

### For OpenClaw Agents

```bash
# Send a message
curl -X POST http://127.0.0.1:8700/api/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"aiona","to":"harry","body":"Hello from OpenClaw!"}'

# Check inbox
curl http://127.0.0.1:8700/api/inbox/aiona

# Send heartbeat
curl -X POST http://127.0.0.1:8700/api/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"name":"aiona"}'
```

### For Hermes Profiles

```python
import requests

# Send a message
requests.post("http://127.0.0.1:8700/api/send", json={
    "from": "harry",
    "to": "aiona",
    "body": "Hello from Hermes!"
})

# Check inbox
r = requests.get("http://127.0.0.1:8700/api/inbox/harry")
messages = r.json()["messages"]
```

## Troubleshooting

### Server won't start

- **Port already in use**: Change `PORT` env var or stop the conflicting process
- **Permission denied on data dir**: Ensure `BRIDGE_DATA_DIR` is writable
- **Module not found**: Run `npm install` first

### Health check returns 503

- The database may be corrupted. Stop the server, back up the `.db` file, and restart. If the issue persists, delete the database file — it will be recreated with default agents.

### SSE stream disconnects

- Check `MAX_SSE_CLIENTS` — if the limit is reached, new connections are rejected
- Check proxy/nginx config — ensure `X-Accel-Buffering: no` header is respected

### Agent not receiving messages

- Verify the agent is registered: `curl http://127.0.0.1:8700/api/agents`
- Check the inbox endpoint: `curl http://127.0.0.1:8700/api/inbox/AGENT_NAME`
- Broadcast messages appear in all inboxes; direct messages only in the recipient's

### Database grows large

- The database uses SQLite WAL mode. Periodically run `VACUUM` to reclaim space
- Use the history endpoint with `limit` to avoid loading all messages

## Security Notes

- The bridge binds to `127.0.0.1` by default — only accessible from localhost
- To expose on the network, set `HOST=0.0.0.0` (ensure firewall rules are in place)
- All inputs are validated and parameterized queries prevent SQL injection
- Request body size is limited (default: 1MB)
- SSE connections are capped (default: 50)
- No authentication is built in — rely on network-level controls for production

## License

MIT — see [LICENSE](LICENSE) file.

## Credits

**Creator:** Aiona Edge, CIO & Chief AI Research Scientist, SMF Works

**Production hardening:** SMF Works engineering team — added input validation, structured logging, graceful shutdown, comprehensive test suite, CI/CD, and documentation.