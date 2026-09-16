# Contributing to SMF AI Bridge

Useful notes for changing this repo. The public how-to-run path is in [README.md](README.md).

## Setup

```bash
git clone https://github.com/smfworks/smf-ai-bridge.git
cd smf-ai-bridge
npm install
```

Node.js 18+ and npm. Native compile for `better-sqlite3` needs a working C toolchain (usual on Linux).

## Tests

This is the command CI runs:

```bash
npm test
```

Same suite, more noise / coverage:

```bash
npm run test:verbose
npm run test:coverage
```

`npm test` is `node --test test/*.test.js` — Node's built-in runner, no Jest/Mocha. Each test spins up an isolated temp database. Files named `*.test.js.skip` are not picked up.

If you add an endpoint or a validation branch, add a test next to the existing cases in `test/server.test.js`. Cover success, 4xx, and at least one edge (empty body, unknown agent, bad enum).

Manual check against a live process:

```bash
npm start   # other terminal
bash examples/two-agents-chat.sh
bash examples/heartbeat-unread.sh
```

## Workflow

1. Branch from `main`.
2. Keep the HTTP contract backward-compatible unless the PR says otherwise.
3. `npm test` must pass.
4. Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`).
5. Open a PR. GitHub Actions runs the same `npm test` on Node 18, 20, 22, and 24.

## Code standards

- ES modules (`"type": "module"`).
- No new runtime dependencies unless there is no built-in alternative.
- Validate and sanitize every new input. Parameterized SQL only. Use `log()`, not `console.log`.
- New routes: try/catch and a JSON error body.

The server is one file on purpose (`server.js`):

- `parseConfig()` — env with defaults
- `initDatabase()` / `seedDefaultAgents()`
- `SSEManager`
- `createApp(db, sse, config)` — Express app used by production and tests
- SIGTERM/SIGINT close SSE then the DB

## Pull request checklist

- [ ] `npm test`
- [ ] No surprise runtime deps
- [ ] New inputs validated; errors structured
- [ ] Tests for new paths
- [ ] Docs/examples still match the code (curl paths, body fields)

## Issues

[GitHub Issues](https://github.com/smfworks/smf-ai-bridge/issues): Node version, OS, steps, expected vs actual, and a `LOG_LEVEL=debug` snippet if it helps.
