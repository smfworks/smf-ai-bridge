# Contributing to SMF AI Bridge

Thank you for your interest in contributing! This document covers the development workflow and standards.

## Development Setup

```bash
git clone https://github.com/smfworks/smf-ai-bridge.git
cd smf-ai-bridge
npm install
```

Prerequisites:
- Node.js 18+
- npm

## Development Workflow

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes.** Keep the existing API surface backward-compatible unless explicitly discussed.

3. **Run tests** — they must all pass:
   ```bash
   npm test
   ```

4. **Run with coverage** to verify meaningful paths are covered:
   ```bash
   npm run test:coverage
   ```

5. **Commit with conventional commit messages:**
   ```bash
   git commit -m "feat: add new endpoint for X"
   git commit -m "fix: handle edge case in Y"
   git commit -m "docs: update API reference"
   git commit -m "test: add coverage for Z"
   git commit -m "refactor: extract validation logic"
   ```

6. **Push and open a PR.** CI will run automatically.

## Commit Message Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Use for |
|------|---------|
| `feat` | New features |
| `fix` | Bug fixes |
| `docs` | Documentation changes |
| `test` | Test additions/changes |
| `refactor` | Code restructuring (no behavior change) |
| `perf` | Performance improvements |
| `chore` | Maintenance tasks |
| `ci` | CI/CD changes |

Format: `type: brief description`

## Code Standards

- **ES Modules** — the project uses `"type": "module"` in package.json
- **No new runtime dependencies** unless absolutely necessary — prefer Node built-ins
- **Input validation** — all new endpoints must validate and sanitize input
- **Error handling** — all new endpoints must have try/catch with structured error responses
- **Structured logging** — use the `log()` function, not `console.log`
- **Parameterized queries** — never concatenate SQL strings

## Testing Standards

- Write tests for all new endpoints and code paths
- Cover success cases, error cases, and edge cases
- Tests use Node's built-in test runner (`node:test`) — no Jest, no Mocha
- Each test creates an isolated temp database — no shared state between tests
- Aim for >80% coverage of meaningful code paths

## Architecture Notes

The server is intentionally a single file (`server.js`) for simplicity. Key components:

- **Config object** — all environment variables with defaults
- **Validation helpers** — `isValidString`, `validateEnum`, `validateInteger`
- **Database initialization** — `initDatabase()` creates tables and indexes
- **SSE Manager** — class managing SSE client connections with limits
- **App factory** — `createApp()` returns an Express app (used by both server and tests)
- **Graceful shutdown** — SIGTERM/SIGINT handlers close DB and SSE connections

The `createApp()` factory pattern allows tests to create isolated app instances with their own databases, ensuring no shared state between test runs.

## Pull Request Checklist

- [ ] All tests pass (`npm test`)
- [ ] No new runtime dependencies added (or justified)
- [ ] Input validation on new endpoints
- [ ] Error handling on new endpoints
- [ ] Tests cover new code paths
- [ ] Conventional commit messages
- [ ] Backward compatibility maintained

## Reporting Issues

Use [GitHub Issues](https://github.com/smfworks/smf-ai-bridge/issues) to report bugs or request features. Include:

- Node.js version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output (with `LOG_LEVEL=debug`)