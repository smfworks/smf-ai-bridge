import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createApp, initDatabase, seedDefaultAgents, SSEManager, config,
         VALID_PLATFORMS, VALID_MESSAGE_TYPES, VALID_PRIORITIES,
         isValidString, validateEnum, validateInteger } from '../server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeTestEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const db = initDatabase(dataDir);
  seedDefaultAgents(db);
  const sse = new SSEManager(50);
  const appConfig = { ...config, dataDir, defaultLimit: 100, maxQueryLimit: 500, bodyLimit: '1mb', version: '1.0.0' };
  const app = createApp(db, sse, appConfig);
  const server = http.createServer(app);
  server.listen(0); // OS assigns random port
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { app, server, db, sse, dataDir, baseUrl, appConfig };
}

function cleanup(env) {
  try { env.server.close(); } catch { /* ignore */ }
  try { env.db.close(); } catch { /* ignore */ }
  try { rmSync(env.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function request(app, method, path, body) {
  // This variant is used for tests that pass env.app directly — we need the baseUrl
  // Most tests should use envRequest instead.
  throw new Error('Use envRequest(env, method, path, body) instead');
}

async function envRequest(env, method, path, body) {
  const url = `${env.baseUrl}${path}`;
  const opts = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: Object.fromEntries(res.headers) };
}

// ─── Validation Helpers Unit Tests ────────────────────────────────────────────

describe('Validation Helpers', () => {
  it('isValidString accepts non-empty strings under 200 chars', () => {
    assert.ok(isValidString('hello'));
    assert.ok(isValidString('a'));
    assert.ok(isValidString('a'.repeat(200)));
  });

  it('isValidString rejects empty, non-string, or oversized', () => {
    assert.ok(!isValidString(''));
    assert.ok(!isValidString('   '));
    assert.ok(!isValidString(null));
    assert.ok(!isValidString(undefined));
    assert.ok(!isValidString(123));
    assert.ok(!isValidString('a'.repeat(201)));
  });

  it('validateEnum accepts valid values', () => {
    const r = validateEnum('openclaw', VALID_PLATFORMS, 'platform');
    assert.ok(r.valid);
    assert.strictEqual(r.value, 'openclaw');
  });

  it('validateEnum returns null value for undefined/null', () => {
    const r = validateEnum(undefined, VALID_PLATFORMS, 'platform');
    assert.ok(r.valid);
    assert.strictEqual(r.value, null);
  });

  it('validateEnum rejects invalid values', () => {
    const r = validateEnum('invalid', VALID_PLATFORMS, 'platform');
    assert.ok(!r.valid);
    assert.ok(r.error.includes('platform'));
  });

  it('validateInteger accepts valid integers in range', () => {
    let r = validateInteger('50', 1, 100, 'limit');
    assert.ok(r.valid);
    assert.strictEqual(r.value, 50);

    r = validateInteger(50, 1, 100, 'limit');
    assert.ok(r.valid);
    assert.strictEqual(r.value, 50);
  });

  it('validateInteger rejects NaN, out of range', () => {
    assert.ok(!validateInteger('abc', 1, 100, 'limit').valid);
    assert.ok(!validateInteger('0', 1, 100, 'limit').valid);
    assert.ok(!validateInteger('200', 1, 100, 'limit').valid);
  });
});

// ─── SSE Manager Unit Tests ───────────────────────────────────────────────────

describe('SSEManager', () => {
  it('enforces max client limit', () => {
    const sse = new SSEManager(2);
    const fakeRes1 = { write: () => true, end: () => {} };
    const fakeRes2 = { write: () => true, end: () => {} };
    const fakeRes3 = { write: () => true, end: () => {} };

    assert.ok(sse.add(fakeRes1));
    assert.ok(sse.add(fakeRes2));
    assert.ok(!sse.add(fakeRes3)); // rejected
    assert.strictEqual(sse.count, 2);
  });

  it('removes clients', () => {
    const sse = new SSEManager(10);
    const fakeRes = { write: () => true, end: () => {} };
    sse.add(fakeRes);
    assert.strictEqual(sse.count, 1);
    sse.remove(fakeRes);
    assert.strictEqual(sse.count, 0);
  });

  it('broadcasts to all clients and removes dead ones', () => {
    const sse = new SSEManager(10);
    let received = [];
    const goodRes = { write: (payload) => received.push(payload), end: () => {} };
    const badRes = { write: () => { throw new Error('connection closed'); }, end: () => {} };

    sse.add(goodRes);
    sse.add(badRes);
    sse.broadcast('test', { hello: 'world' });

    assert.strictEqual(received.length, 1);
    assert.ok(received[0].includes('event: test'));
    assert.ok(received[0].includes('"hello":"world"'));
    assert.strictEqual(sse.count, 1); // bad one removed
  });

  it('closeAll ends all connections', () => {
    const sse = new SSEManager(10);
    let ended = 0;
    sse.add({ write: () => true, end: () => { ended++; } });
    sse.add({ write: () => true, end: () => { ended++; } });
    sse.closeAll();
    assert.strictEqual(ended, 2);
    assert.strictEqual(sse.count, 0);
  });
});

// ─── Health Endpoint ──────────────────────────────────────────────────────────

describe('GET /health', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('returns ok with service info', async () => {
    const res = await envRequest(env, 'GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
    assert.strictEqual(res.body.service, 'smf-ai-bridge');
    assert.ok(res.body.version);
    assert.ok(typeof res.body.uptime === 'number');
    assert.ok(typeof res.body.agents === 'number');
    assert.ok(typeof res.body.messages === 'number');
    assert.ok(typeof res.body.sseClients === 'number');
  });

  it('reports correct agent count after seeding', async () => {
    const res = await envRequest(env, 'GET', '/health');
    assert.ok(res.body.agents >= 12); // 12 default agents
  });
});

// ─── Agent Registration ───────────────────────────────────────────────────────

describe('GET /api/agents', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('returns list of seeded agents', async () => {
    const res = await envRequest(env, 'GET', '/api/agents');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.agents));
    assert.ok(res.body.agents.length >= 12);
  });

  it('includes name, platform, role, model, status fields', async () => {
    const res = await envRequest(env, 'GET', '/api/agents');
    const agent = res.body.agents[0];
    assert.ok('name' in agent);
    assert.ok('platform' in agent);
    assert.ok('role' in agent);
    assert.ok('model' in agent);
    assert.ok('status' in agent);
  });
});

describe('POST /api/agents', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('creates a new agent with valid data', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: 'test-bot',
      platform: 'hermes',
      role: 'Test Agent',
      model: 'test-model',
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.ok);
    assert.strictEqual(res.body.action, 'created');
    assert.strictEqual(res.body.name, 'test-bot');
  });

  it('updates an existing agent', async () => {
    await envRequest(env, 'POST', '/api/agents', {
      name: 'test-bot', platform: 'hermes', role: 'Original',
    });
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: 'test-bot', platform: 'hermes', role: 'Updated Role',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.action, 'updated');
  });

  it('rejects missing name', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      platform: 'hermes',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('name'));
  });

  it('rejects missing platform', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: 'test-bot',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('platform'));
  });

  it('rejects invalid platform', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: 'test-bot', platform: 'invalid',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('platform'));
  });

  it('rejects empty name', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: '', platform: 'hermes',
    });
    assert.strictEqual(res.status, 400);
  });

  it('rejects name exceeding 200 chars', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: 'a'.repeat(201), platform: 'hermes',
    });
    assert.strictEqual(res.status, 400);
  });

  it('rejects invalid gatewayPort', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: 'test-bot', platform: 'hermes', gatewayPort: 99999,
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('gatewayPort'));
  });

  it('accepts valid gatewayPort', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: 'test-bot', platform: 'hermes', gatewayPort: 8080,
    });
    assert.strictEqual(res.status, 201);
  });

  it('handles null optional fields gracefully', async () => {
    const res = await envRequest(env, 'POST', '/api/agents', {
      name: 'test-bot', platform: 'hermes', role: null, model: null, sessionKey: null, gatewayPort: null,
    });
    assert.strictEqual(res.status, 201);
  });
});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

describe('POST /api/heartbeat', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('marks a registered agent as online', async () => {
    const res = await envRequest(env, 'POST', '/api/heartbeat', { name: 'aiona' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
  });

  it('returns 404 for unregistered agent', async () => {
    const res = await envRequest(env, 'POST', '/api/heartbeat', { name: 'nonexistent' });
    assert.strictEqual(res.status, 404);
    assert.ok(res.body.error.includes('not registered'));
  });

  it('rejects missing name', async () => {
    const res = await envRequest(env, 'POST', '/api/heartbeat', {});
    assert.strictEqual(res.status, 400);
  });

  it('rejects empty name', async () => {
    const res = await envRequest(env, 'POST', '/api/heartbeat', { name: '' });
    assert.strictEqual(res.status, 400);
  });
});

// ─── Send Message ─────────────────────────────────────────────────────────────

describe('POST /api/send', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('sends a valid direct message', async () => {
    const res = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'Hello Harry!',
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.ok);
    assert.ok(res.body.message.id);
    assert.strictEqual(res.body.message.fromAgent, 'aiona');
    assert.strictEqual(res.body.message.toAgent, 'harry');
    assert.strictEqual(res.body.message.body, 'Hello Harry!');
    assert.strictEqual(res.body.message.type, 'direct');
    assert.strictEqual(res.body.message.priority, 'normal');
    assert.strictEqual(res.body.message.read, 0);
  });

  it('sends with subject, threadId, and priority', async () => {
    const res = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'Threaded message',
      subject: 'Important', threadId: 'thread-1', priority: 'urgent', type: 'group',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.message.subject, 'Important');
    assert.strictEqual(res.body.message.threadId, 'thread-1');
    assert.strictEqual(res.body.message.priority, 'urgent');
    assert.strictEqual(res.body.message.type, 'group');
  });

  it('rejects missing from', async () => {
    const res = await envRequest(env, 'POST', '/api/send', { to: 'harry', body: 'Hi' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('from'));
  });

  it('rejects missing to', async () => {
    const res = await envRequest(env, 'POST', '/api/send', { from: 'aiona', body: 'Hi' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('to'));
  });

  it('rejects missing body', async () => {
    const res = await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('body'));
  });

  it('rejects empty body', async () => {
    const res = await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: '' });
    assert.strictEqual(res.status, 400);
  });

  it('rejects unregistered sender', async () => {
    const res = await envRequest(env, 'POST', '/api/send', {
      from: 'ghost', to: 'harry', body: 'Boo',
    });
    assert.strictEqual(res.status, 404);
    assert.ok(res.body.error.includes('not registered'));
  });

  it('rejects invalid message type', async () => {
    const res = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'Hi', type: 'invalid',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('type'));
  });

  it('rejects invalid priority', async () => {
    const res = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'Hi', priority: 'critical',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('priority'));
  });

  it('rejects body exceeding 100000 chars', async () => {
    const res = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'a'.repeat(100001),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('maximum length'));
  });

  it('broadcasts SSE event for new message', async () => {
    // The SSE broadcast happens internally; we verify via the response
    const res = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'SSE test',
    });
    assert.strictEqual(res.status, 201);
    // If we got here without throwing, the broadcast didn't crash
  });
});

// ─── Inbox ─────────────────────────────────────────────────────────────────────

describe('GET /api/inbox/:agent', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('returns messages for the agent', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'Msg 1' });
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'Msg 2' });

    const res = await envRequest(env, 'GET', '/api/inbox/harry');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.agent, 'harry');
    assert.strictEqual(res.body.count, 2);
    assert.ok(res.body.messages.length === 2);
  });

  it('returns messages in descending timestamp order', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'First' });
    await new Promise(r => setTimeout(r, 10));
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'Second' });

    const res = await envRequest(env, 'GET', '/api/inbox/harry');
    assert.strictEqual(res.body.messages[0].body, 'Second');
    assert.strictEqual(res.body.messages[1].body, 'First');
  });

  it('filters unread only', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'Unread' });
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'Will be read' });

    const inbox = await envRequest(env, 'GET', '/api/inbox/harry');
    const msgId = inbox.body.messages[0].id;
    await envRequest(env, 'POST', '/api/read', { agent: 'harry', messageIds: [msgId] });

    const res = await envRequest(env, 'GET', '/api/inbox/harry?unreadOnly=true');
    assert.strictEqual(res.body.count, 1);
    assert.strictEqual(res.body.messages[0].body, 'Unread');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: `Msg ${i}` });
    }
    const res = await envRequest(env, 'GET', '/api/inbox/harry?limit=2');
    assert.strictEqual(res.body.count, 2);
  });

  it('rejects invalid limit', async () => {
    const res = await envRequest(env, 'GET', '/api/inbox/harry?limit=abc');
    assert.strictEqual(res.status, 400);
  });

  it('rejects limit exceeding max', async () => {
    const res = await envRequest(env, 'GET', '/api/inbox/harry?limit=1000');
    assert.strictEqual(res.status, 400);
  });

  it('includes broadcast messages', async () => {
    await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'nobody', body: 'Broadcast msg', type: 'broadcast',
    });
    const res = await envRequest(env, 'GET', '/api/inbox/harry');
    assert.ok(res.body.count >= 1);
  });

  it('includes team messages', async () => {
    await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'team', body: 'Team msg',
    });
    const res = await envRequest(env, 'GET', '/api/inbox/harry');
    assert.ok(res.body.count >= 1);
  });

  it('returns empty for agent with no messages', async () => {
    const res = await envRequest(env, 'GET', '/api/inbox/zayn');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.count, 0);
  });
});

// ─── Mark Read ────────────────────────────────────────────────────────────────

describe('POST /api/read', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('marks messages as read', async () => {
    const sendRes = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'Read me',
    });
    const msgId = sendRes.body.message.id;

    const res = await envRequest(env, 'POST', '/api/read', {
      agent: 'harry', messageIds: [msgId],
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
    assert.strictEqual(res.body.updated, 1);
  });

  it('does not mark messages for wrong agent', async () => {
    const sendRes = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'Private',
    });
    const msgId = sendRes.body.message.id;

    const res = await envRequest(env, 'POST', '/api/read', {
      agent: 'zayn', messageIds: [msgId],
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.updated, 0);
  });

  it('rejects missing agent', async () => {
    const res = await envRequest(env, 'POST', '/api/read', { messageIds: ['x'] });
    assert.strictEqual(res.status, 400);
  });

  it('rejects missing messageIds', async () => {
    const res = await envRequest(env, 'POST', '/api/read', { agent: 'harry' });
    assert.strictEqual(res.status, 400);
  });

  it('rejects non-array messageIds', async () => {
    const res = await envRequest(env, 'POST', '/api/read', { agent: 'harry', messageIds: 'not-array' });
    assert.strictEqual(res.status, 400);
  });

  it('rejects empty messageIds array', async () => {
    const res = await envRequest(env, 'POST', '/api/read', { agent: 'harry', messageIds: [] });
    assert.strictEqual(res.status, 400);
  });

  it('handles multiple message IDs', async () => {
    const r1 = await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'A' });
    const r2 = await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'B' });

    const res = await envRequest(env, 'POST', '/api/read', {
      agent: 'harry', messageIds: [r1.body.message.id, r2.body.message.id],
    });
    assert.strictEqual(res.body.updated, 2);
  });

  it('skips non-string message IDs gracefully', async () => {
    const r1 = await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'A' });
    const res = await envRequest(env, 'POST', '/api/read', {
      agent: 'harry', messageIds: [r1.body.message.id, 12345, null],
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.updated, 1);
  });
});

// ─── History ──────────────────────────────────────────────────────────────────

describe('GET /api/history', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('returns messages with default limit', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'Hist 1' });
    const res = await envRequest(env, 'GET', '/api/history');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.messages.length >= 1);
  });

  it('filters by agent', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'A->H' });
    await envRequest(env, 'POST', '/api/send', { from: 'gabriel', to: 'liam', body: 'G->L' });

    const res = await envRequest(env, 'GET', '/api/history?agent=aiona');
    assert.ok(res.body.messages.every(m => m.fromAgent === 'aiona' || m.toAgent === 'aiona'));
  });

  it('filters by from', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'X' });
    await envRequest(env, 'POST', '/api/send', { from: 'gabriel', to: 'harry', body: 'Y' });

    const res = await envRequest(env, 'GET', '/api/history?from=aiona');
    assert.ok(res.body.messages.every(m => m.fromAgent === 'aiona'));
  });

  it('filters by to', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'X' });
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'liam', body: 'Y' });

    const res = await envRequest(env, 'GET', '/api/history?to=harry');
    assert.ok(res.body.messages.every(m => m.toAgent === 'harry'));
  });

  it('filters by type', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'D', type: 'direct' });
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'all', body: 'B', type: 'broadcast' });

    const res = await envRequest(env, 'GET', '/api/history?type=broadcast');
    assert.ok(res.body.messages.every(m => m.type === 'broadcast'));
  });

  it('filters by threadId', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'T1', threadId: 't-100' });
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'T2', threadId: 't-200' });

    const res = await envRequest(env, 'GET', '/api/history?threadId=t-100');
    assert.ok(res.body.messages.every(m => m.threadId === 't-100'));
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: `M${i}` });
    }
    const res = await envRequest(env, 'GET', '/api/history?limit=2');
    assert.strictEqual(res.body.messages.length, 2);
  });

  it('rejects invalid type filter', async () => {
    const res = await envRequest(env, 'GET', '/api/history?type=invalid');
    assert.strictEqual(res.status, 400);
  });

  it('rejects invalid limit', async () => {
    const res = await envRequest(env, 'GET', '/api/history?limit=abc');
    assert.strictEqual(res.status, 400);
  });
});

// ─── Thread ───────────────────────────────────────────────────────────────────

describe('GET /api/thread/:threadId', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('returns messages in a thread in ascending order', async () => {
    await envRequest(env, 'POST', '/api/send', { from: 'aiona', to: 'harry', body: 'First', threadId: 't-1' });
    await new Promise(r => setTimeout(r, 10));
    await envRequest(env, 'POST', '/api/send', { from: 'harry', to: 'aiona', body: 'Second', threadId: 't-1' });

    const res = await envRequest(env, 'GET', '/api/thread/t-1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.threadId, 't-1');
    assert.strictEqual(res.body.count, 2);
    assert.strictEqual(res.body.messages[0].body, 'First');
    assert.strictEqual(res.body.messages[1].body, 'Second');
  });

  it('returns empty for non-existent thread', async () => {
    const res = await envRequest(env, 'GET', '/api/thread/nonexistent');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.count, 0);
  });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

describe('GET / (Dashboard)', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('returns HTML dashboard', async () => {
    const res = await envRequest(env, 'GET', '/');
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body === 'string');
    assert.ok(res.body.includes('SMF'));
    assert.ok(res.body.includes('<html'));
  });
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────

describe('404 handling', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('returns 404 for unknown routes', async () => {
    const res = await envRequest(env, 'GET', '/api/nonexistent');
    assert.strictEqual(res.status, 404);
    assert.ok(res.body.error.includes('not found'));
  });
});

// ─── Error Handling ───────────────────────────────────────────────────────────

describe('Error handling', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('rejects invalid JSON body', async () => {
    const res = await fetch(`${env.baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid json}',
    });
    assert.strictEqual(res.status, 400);
  });

  it('rejects oversized body', async () => {
    // Use a custom app with small body limit
    const smallDataDir = mkdtempSync(join(tmpdir(), 'bridge-small-'));
    const smallConfig = { ...config, dataDir: smallDataDir, bodyLimit: '10b', defaultLimit: 100, maxQueryLimit: 500, version: '1.0.0' };
    const db2 = initDatabase(smallDataDir);
    seedDefaultAgents(db2);
    const sse2 = new SSEManager(50);
    const app2 = createApp(db2, sse2, smallConfig);
    const server2 = http.createServer(app2);
    server2.listen(0);
    const port2 = server2.address().port;
    const baseUrl2 = `http://127.0.0.1:${port2}`;

    const res = await fetch(`${baseUrl2}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'aiona', to: 'harry', body: 'A'.repeat(100) }),
    });
    assert.strictEqual(res.status, 413);
    server2.close();
    db2.close();
    rmSync(smallDataDir, { recursive: true, force: true });
  });
});

// ─── Backward Compatibility ───────────────────────────────────────────────────

describe('Backward compatibility', () => {
  let env;
  beforeEach(() => { env = makeTestEnv(); });
  afterEach(() => cleanup(env));

  it('health endpoint returns ok:true (original contract)', async () => {
    const res = await envRequest(env, 'GET', '/health');
    assert.strictEqual(res.body.ok, true);
  });

  it('agents list returns { agents: [...] } shape', async () => {
    const res = await envRequest(env, 'GET', '/api/agents');
    assert.ok(Array.isArray(res.body.agents));
  });

  it('send returns { ok: true, message: {...} } shape', async () => {
    const res = await envRequest(env, 'POST', '/api/send', {
      from: 'aiona', to: 'harry', body: 'compat',
    });
    assert.ok(res.body.ok);
    assert.ok(res.body.message);
    assert.ok(res.body.message.id);
  });

  it('inbox returns { agent, count, messages } shape', async () => {
    const res = await envRequest(env, 'GET', '/api/inbox/harry');
    assert.ok('agent' in res.body);
    assert.ok('count' in res.body);
    assert.ok('messages' in res.body);
  });

  it('read returns { ok: true, updated: N } shape', async () => {
    const res = await envRequest(env, 'POST', '/api/read', {
      agent: 'harry', messageIds: ['nonexistent-id'],
    });
    assert.ok(res.body.ok);
    assert.ok(typeof res.body.updated === 'number');
  });

  it('history returns { messages: [...] } shape', async () => {
    const res = await envRequest(env, 'GET', '/api/history');
    assert.ok(Array.isArray(res.body.messages));
  });

  it('thread returns { threadId, count, messages } shape', async () => {
    const res = await envRequest(env, 'GET', '/api/thread/test');
    assert.ok('threadId' in res.body);
    assert.ok('count' in res.body);
    assert.ok('messages' in res.body);
  });
});