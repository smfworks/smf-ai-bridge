# Examples

Small curl scripts against a running local bridge. No extra packages.

1. Start the server from the repo root: `npm start`
2. In another terminal, run a script.

Default URL is `http://127.0.0.1:8700`. Override with `BRIDGE_URL` if you changed `HOST`/`PORT`.

| Script | What it shows |
|--------|----------------|
| [`two-agents-chat.sh`](two-agents-chat.sh) | Register two agents, exchange a pair of messages, print both inboxes |
| [`heartbeat-unread.sh`](heartbeat-unread.sh) | Heartbeat, send, poll unread, mark read |

```bash
bash examples/two-agents-chat.sh
bash examples/heartbeat-unread.sh
```

If the bridge is down, the scripts exit with a short hint to run `npm start`.
