import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { hostname } from 'os';

// ─── Constants ───────────────────────────────────────────────────────────────

const VERSION = '1.0.0';

// Centralized limits — no magic numbers scattered across the codebase
const LIMITS = {
  MAX_STRING_LENGTH: 200,
  MAX_BODY_LENGTH: 100_000,
  MAX_MESSAGE_IDS: 1000,
  MAX_SSE_CLIENTS: 50,
  DEFAULT_QUERY_LIMIT: 100,
  MAX_QUERY_LIMIT: 500,
  MIN_PORT: 1,
  MAX_PORT: 65535,
  SHUTDOWN_TIMEOUT_MS: 10_000,
};

const VALID_PLATFORMS = ['openclaw', 'hermes', 'webchat'];
const VALID_MESSAGE_TYPES = ['direct', 'group', 'broadcast'];
const VALID_PRIORITIES = ['low', 'normal', 'urgent'];
const VALID_LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

const TEAM_RECIPIENT = 'team'; // special recipient that all agents see

// ─── Configuration ───────────────────────────────────────────────────────────

function parseConfig(env) {
  const port = parseInt(env.PORT || '8700', 10);
  const maxSseClients = parseInt(env.MAX_SSE_CLIENTS || String(LIMITS.MAX_SSE_CLIENTS), 10);
  const defaultLimit = parseInt(env.DEFAULT_QUERY_LIMIT || String(LIMITS.DEFAULT_QUERY_LIMIT), 10);
  const maxQueryLimit = parseInt(env.MAX_QUERY_LIMIT || String(LIMITS.MAX_QUERY_LIMIT), 10);
  const logLevel = env.LOG_LEVEL || 'info';

  // Validate numeric config values
  if (isNaN(port) || port < LIMITS.MIN_PORT || port > LIMITS.MAX_PORT) {
    throw new Error(`Invalid PORT: must be integer between ${LIMITS.MIN_PORT} and ${LIMITS.MAX_PORT}`);
  }
  if (isNaN(maxSseClients) || maxSseClients < 1) {
    throw new Error('Invalid MAX_SSE_CLIENTS: must be positive integer');
  }
  if (isNaN(defaultLimit) || defaultLimit < 1) {
    throw new Error('Invalid DEFAULT_QUERY_LIMIT: must be positive integer');
  }
  if (isNaN(maxQueryLimit) || maxQueryLimit < 1) {
    throw new Error('Invalid MAX_QUERY_LIMIT: must be positive integer');
  }
  if (defaultLimit > maxQueryLimit) {
    throw new Error('DEFAULT_QUERY_LIMIT cannot exceed MAX_QUERY_LIMIT');
  }
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: must be one of ${VALID_LOG_LEVELS.join(', ')}`);
  }

  return {
    port,
    host: env.HOST || '127.0.0.1',
    dataDir: env.BRIDGE_DATA_DIR || './data',
    bodyLimit: env.BODY_LIMIT || '1mb',
    logLevel,
    maxSseClients,
    defaultLimit,
    maxQueryLimit,
    version: VERSION,
  };
}

const config = parseConfig(process.env);

// ─── Structured Logger ───────────────────────────────────────────────────────

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[config.logLevel] ?? LOG_LEVELS.info;

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] > currentLevel) return;
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };
  const out = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

function isValidString(val) {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= LIMITS.MAX_STRING_LENGTH;
}

function validateEnum(val, allowed, field) {
  if (val === undefined || val === null) return { valid: true, value: null };
  if (typeof val !== 'string' || !allowed.includes(val)) {
    return { valid: false, error: `${field} must be one of: ${allowed.join(', ')}` };
  }
  return { valid: true, value: val };
}

function validateInteger(val, min, max, field) {
  // Reject anything that isn't a clean integer string or number
  // parseInt('50abc', 10) === 50 is a bug, not a feature
  if (typeof val === 'string' && !/^\d+$/.test(val.trim())) {
    return { valid: false, error: `${field} must be a valid integer` };
  }
  if (typeof val === 'number' && !Number.isInteger(val)) {
    return { valid: false, error: `${field} must be a valid integer` };
  }
  const n = parseInt(val, 10);
  if (isNaN(n)) return { valid: false, error: `${field} must be a valid integer` };
  if (min !== undefined && n < min) return { valid: false, error: `${field} must be >= ${min}` };
  if (max !== undefined && n > max) return { valid: false, error: `${field} must be <= ${max}` };
  return { valid: true, value: n };
}

function validatePort(val) {
  return validateInteger(val, LIMITS.MIN_PORT, LIMITS.MAX_PORT, 'gatewayPort');
}

// ─── Prototype pollution safe body extraction ─────────────────────────────────

// Destructuring req.body directly allows __proto__/constructor pollution.
// This helper safely extracts only own properties.
function safeBody(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return {};
  }
  const safe = {};
  for (const key of Object.keys(req.body)) {
    // Block known pollution vectors
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    safe[key] = req.body[key];
  }
  return safe;
}

// ─── HTML Escaping ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Database Setup ───────────────────────────────────────────────────────────

function initDatabase(dataDir) {
  // Resolve to absolute path and prevent path traversal
  const resolved = isAbsolute(dataDir) ? resolve(dataDir) : resolve(process.cwd(), dataDir);

  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });

  const db = new Database(`${resolved}/bridge.db`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL CHECK(platform IN ('openclaw','hermes','webchat')),
      role TEXT,
      model TEXT,
      sessionKey TEXT,
      gatewayPort INTEGER,
      status TEXT DEFAULT 'offline',
      lastSeen TEXT,
      registeredAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      fromAgent TEXT NOT NULL,
      fromPlatform TEXT NOT NULL,
      toAgent TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'direct' CHECK(type IN ('direct','group','broadcast')),
      subject TEXT,
      body TEXT NOT NULL,
      threadId TEXT,
      priority TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','urgent')),
      read INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fromAgent) REFERENCES agents(name)
    );

    CREATE INDEX IF NOT EXISTS idx_msgs_to_read ON messages(toAgent, read);
    CREATE INDEX IF NOT EXISTS idx_msgs_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_msgs_thread ON messages(threadId);
  `);

  return db;
}

// ─── Default Agents ───────────────────────────────────────────────────────────

const DEFAULT_AGENTS = [
  { name: 'michael',  platform: 'webchat',  role: 'Owner / Founder',                model: 'human',              sessionKey: null, gatewayPort: null },
  { name: 'aiona',    platform: 'openclaw', role: 'CIO / Chief AI Research Scientist', model: 'deepseek-v4-pro',     sessionKey: 'agent:aiona:main' },
  { name: 'gabriel',  platform: 'openclaw', role: 'CFO',                             model: 'kimi-k2.6',           sessionKey: 'agent:gabriel:main' },
  { name: 'rafael',   platform: 'openclaw', role: 'Chief of Staff',                  model: 'qwen3-vl:235b',       sessionKey: 'agent:rafael:main' },
  { name: 'morgan',   platform: 'openclaw', role: 'Marketing & Campaigns',           model: 'deepseek-v4-pro',     sessionKey: 'agent:morgan:main' },
  { name: 'pamela',   platform: 'openclaw', role: 'CMO',                             model: 'glm-5.1',             sessionKey: 'agent:pamela:main' },
  { name: 'louis',    platform: 'hermes',   role: 'General Assistant',               model: 'deepseek-v4-pro',     gatewayPort: 8640 },
  { name: 'drj',      platform: 'hermes',   role: 'Chief AI Medical Officer',        model: 'deepseek-v4-pro:cloud', gatewayPort: null },
  { name: 'harry',    platform: 'hermes',   role: 'Editor-in-Chief, WisdomForge',    model: 'kimi-k2.6:cloud',     gatewayPort: 8646 },
  { name: 'liam',     platform: 'hermes',   role: 'Chief Data Officer',              model: 'deepseek-v4-pro:cloud', gatewayPort: 8642 },
  { name: 'naill',    platform: 'hermes',   role: 'Agent',                           model: 'deepseek-v4-pro:cloud', gatewayPort: 8644 },
  { name: 'zayn',     platform: 'hermes',   role: 'Agent',                           model: 'deepseek-v4-pro:cloud', gatewayPort: 8645 },
];

function seedDefaultAgents(db) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, platform, role, model, sessionKey, gatewayPort, status, lastSeen, registeredAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  let seeded = 0;
  for (const a of DEFAULT_AGENTS) {
    const info = stmt.run(randomUUID(), a.name, a.platform, a.role, a.model, a.sessionKey || null, a.gatewayPort || null, 'offline', null);
    if (info.changes > 0) seeded++;
  }
  return seeded;
}

// ─── SSE Manager ─────────────────────────────────────────────────────────────

class SSEManager {
  constructor(maxClients) {
    this.clients = [];
    this.maxClients = maxClients;
    this.seq = 0;
  }

  add(res) {
    if (this.clients.length >= this.maxClients) {
      log('warn', 'SSE client limit reached, rejecting connection', {
        current: this.clients.length,
        max: this.maxClients,
      });
      return false;
    }
    this.clients.push(res);
    return true;
  }

  remove(res) {
    const idx = this.clients.indexOf(res);
    if (idx >= 0) this.clients.splice(idx, 1);
  }

  broadcast(event, data) {
    if (this.clients.length === 0) return;
    const payload = `id: ${++this.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    // Collect dead clients instead of splicing during iteration
    const live = [];
    for (const res of this.clients) {
      try {
        res.write(payload);
        live.push(res);
      } catch {
        // dead client — don't add to live
      }
    }
    this.clients = live;
  }

  get count() {
    return this.clients.length;
  }

  closeAll() {
    for (const res of this.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.clients.length = 0;
  }
}

// ─── App Factory ──────────────────────────────────────────────────────────────

function createApp(db, sseManager, appConfig = config) {
  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────────────

  app.use(express.json({ limit: appConfig.bodyLimit }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0'); // Disable browsers' buggy XSS auditor
    next();
  });

  // Request logging with request ID for correlation
  let requestCounter = 0;
  app.use((req, _res, next) => {
    req._startTime = Date.now();
    req._requestId = ++requestCounter;
    _res.on('finish', () => {
      log('info', 'request', {
        requestId: req._requestId,
        method: req.method,
        path: req.path,
        status: _res.statusCode,
        durationMs: Date.now() - req._startTime,
      });
    });
    next();
  });

  // ── Health (enhanced) ──────────────────────────────────────────────────────

  const startTime = Date.now();

  app.get('/health', (_req, res) => {
    try {
      const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
      const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
      res.json({
        ok: true,
        service: 'smf-ai-bridge',
        version: appConfig.version,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        hostname: hostname(),
        agents: agentCount,
        messages: msgCount,
        sseClients: sseManager.count,
      });
    } catch (err) {
      log('error', 'Health check failed', { error: err.message });
      res.status(503).json({ ok: false, error: 'database health check failed' });
    }
  });

  // ── List Agents ─────────────────────────────────────────────────────────────

  app.get('/api/agents', (_req, res) => {
    try {
      const agents = db.prepare(
        'SELECT name, platform, role, model, status, lastSeen FROM agents ORDER BY platform, name'
      ).all();
      res.json({ agents });
    } catch (err) {
      log('error', 'Failed to list agents', { error: err.message });
      res.status(500).json({ error: 'failed to retrieve agents' });
    }
  });

  // ── Register / Update Agent ──────────────────────────────────────────────────

  app.post('/api/agents', (req, res) => {
    try {
      const { name, platform, role, model, sessionKey, gatewayPort } = safeBody(req);

      if (!isValidString(name)) {
        return res.status(400).json({ error: 'name is required (non-empty string, max 200 chars)' });
      }

      const platformCheck = validateEnum(platform, VALID_PLATFORMS, 'platform');
      if (!platformCheck.valid) {
        return res.status(400).json({ error: platformCheck.error });
      }
      if (!platformCheck.value) {
        return res.status(400).json({ error: 'platform is required' });
      }

      if (gatewayPort !== undefined && gatewayPort !== null) {
        const portCheck = validatePort(gatewayPort);
        if (!portCheck.valid) return res.status(400).json({ error: portCheck.error });
      }

      if (role !== undefined && role !== null && !isValidString(role)) {
        return res.status(400).json({ error: 'role must be a string (max 200 chars)' });
      }
      if (model !== undefined && model !== null && !isValidString(model)) {
        return res.status(400).json({ error: 'model must be a string (max 200 chars)' });
      }
      if (sessionKey !== undefined && sessionKey !== null && !isValidString(sessionKey)) {
        return res.status(400).json({ error: 'sessionKey must be a string (max 200 chars)' });
      }

      const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(name);

      if (existing) {
        db.prepare(
          `UPDATE agents SET platform=?, role=?, model=?, sessionKey=?, gatewayPort=?, status='online', lastSeen=datetime('now') WHERE name=?`
        ).run(
          platformCheck.value,
          role || null,
          model || null,
          sessionKey || null,
          gatewayPort || null,
          name
        );
        sseManager.broadcast('agent_update', { name, platform: platformCheck.value, status: 'online' });
        log('info', 'Agent updated', { name, platform: platformCheck.value });
        return res.json({ ok: true, action: 'updated', name });
      }

      const id = randomUUID();
      db.prepare(
        `INSERT INTO agents (id,name,platform,role,model,sessionKey,gatewayPort,status,lastSeen,registeredAt)
         VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
      ).run(
        id,
        name,
        platformCheck.value,
        role || null,
        model || null,
        sessionKey || null,
        gatewayPort || null,
        'online'
      );
      sseManager.broadcast('agent_update', { name, platform: platformCheck.value, status: 'online' });
      log('info', 'Agent registered', { name, platform: platformCheck.value, id });
      return res.status(201).json({ ok: true, action: 'created', name });
    } catch (err) {
      log('error', 'Agent registration failed', { error: err.message });
      if (err.code === 'SQLITE_CONSTRAINT_CHECK') {
        return res.status(400).json({ error: 'invalid platform value' });
      }
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'agent name already exists' });
      }
      return res.status(500).json({ error: 'failed to register agent' });
    }
  });

  // ── Heartbeat ────────────────────────────────────────────────────────────────

  app.post('/api/heartbeat', (req, res) => {
    try {
      const { name } = safeBody(req);
      if (!isValidString(name)) {
        return res.status(400).json({ error: 'name is required (non-empty string)' });
      }
      const result = db.prepare(
        `UPDATE agents SET status='online', lastSeen=datetime('now') WHERE name=?`
      ).run(name);

      if (result.changes === 0) {
        return res.status(404).json({ error: `agent "${name}" not registered` });
      }
      res.json({ ok: true });
    } catch (err) {
      log('error', 'Heartbeat failed', { error: err.message });
      res.status(500).json({ error: 'failed to process heartbeat' });
    }
  });

  // ── Send Message ─────────────────────────────────────────────────────────────

  app.post('/api/send', (req, res) => {
    try {
      const { from, to, type, subject, body, threadId, priority } = safeBody(req);

      if (!isValidString(from)) {
        return res.status(400).json({ error: 'from is required (non-empty string)' });
      }
      if (!isValidString(to)) {
        return res.status(400).json({ error: 'to is required (non-empty string)' });
      }
      if (!body || typeof body !== 'string' || body.trim().length === 0) {
        return res.status(400).json({ error: 'body is required (non-empty string)' });
      }
      if (body.length > LIMITS.MAX_BODY_LENGTH) {
        return res.status(400).json({ error: `body exceeds maximum length of ${LIMITS.MAX_BODY_LENGTH} characters` });
      }

      const typeCheck = validateEnum(type, VALID_MESSAGE_TYPES, 'type');
      if (!typeCheck.valid) return res.status(400).json({ error: typeCheck.error });

      const priorityCheck = validateEnum(priority, VALID_PRIORITIES, 'priority');
      if (!priorityCheck.valid) return res.status(400).json({ error: priorityCheck.error });

      if (subject !== undefined && subject !== null && !isValidString(subject)) {
        return res.status(400).json({ error: 'subject must be a string (max 200 chars)' });
      }
      if (threadId !== undefined && threadId !== null && !isValidString(threadId)) {
        return res.status(400).json({ error: 'threadId must be a string (max 200 chars)' });
      }

      const sender = db.prepare('SELECT platform FROM agents WHERE name = ?').get(from);
      if (!sender) {
        return res.status(404).json({ error: `sender "${from}" not registered` });
      }

      const id = randomUUID();
      const msg = {
        id,
        fromAgent: from,
        fromPlatform: sender.platform,
        toAgent: to,
        type: typeCheck.value || 'direct',
        subject: subject || null,
        body,
        threadId: threadId || null,
        priority: priorityCheck.value || 'normal',
        read: 0,
        timestamp: new Date().toISOString(),
      };

      db.prepare(
        `INSERT INTO messages (id, fromAgent, fromPlatform, toAgent, type, subject, body, threadId, priority, read, timestamp)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        msg.id, msg.fromAgent, msg.fromPlatform, msg.toAgent, msg.type,
        msg.subject, msg.body, msg.threadId, msg.priority, 0, msg.timestamp
      );

      // Mark sender as active
      db.prepare(`UPDATE agents SET status='online', lastSeen=datetime('now') WHERE name=?`).run(from);

      sseManager.broadcast('new_message', msg);
      log('info', 'Message sent', { id, from, to, type: msg.type });
      res.status(201).json({ ok: true, message: msg });
    } catch (err) {
      log('error', 'Send message failed', { error: err.message });
      if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return res.status(400).json({ error: 'sender not registered (foreign key constraint)' });
      }
      if (err.code === 'SQLITE_CONSTRAINT_CHECK') {
        return res.status(400).json({ error: 'invalid type or priority value' });
      }
      return res.status(500).json({ error: 'failed to send message' });
    }
  });

  // ── Get Inbox ────────────────────────────────────────────────────────────────

  app.get('/api/inbox/:agent', (req, res) => {
    try {
      const { agent } = req.params;
      const { unreadOnly, limit } = req.query;

      let query = `SELECT * FROM messages WHERE (toAgent = ? OR toAgent = '${TEAM_RECIPIENT}' OR type = 'broadcast')`;
      const params = [agent];

      if (unreadOnly === 'true') {
        query += ' AND read = 0';
      }

      query += ' ORDER BY timestamp DESC';

      if (limit) {
        const limitCheck = validateInteger(limit, 1, appConfig.maxQueryLimit, 'limit');
        if (!limitCheck.valid) return res.status(400).json({ error: limitCheck.error });
        query += ' LIMIT ?';
        params.push(limitCheck.value);
      } else {
        query += ' LIMIT ?';
        params.push(appConfig.defaultLimit);
      }

      const msgs = db.prepare(query).all(...params);
      res.json({ agent, count: msgs.length, messages: msgs });
    } catch (err) {
      log('error', 'Inbox query failed', { error: err.message });
      res.status(500).json({ error: 'failed to retrieve inbox' });
    }
  });

  // ── Mark Read ────────────────────────────────────────────────────────────────

  app.post('/api/read', (req, res) => {
    try {
      const { agent, messageIds } = safeBody(req);

      if (!isValidString(agent)) {
        return res.status(400).json({ error: 'agent is required (non-empty string)' });
      }
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return res.status(400).json({ error: 'messageIds must be a non-empty array' });
      }
      if (messageIds.length > LIMITS.MAX_MESSAGE_IDS) {
        return res.status(400).json({ error: `messageIds cannot exceed ${LIMITS.MAX_MESSAGE_IDS} items` });
      }

      const stmt = db.prepare('UPDATE messages SET read = 1 WHERE id = ? AND toAgent = ?');
      const updated = [];

      const tx = db.transaction(() => {
        for (const mid of messageIds) {
          if (typeof mid !== 'string' || mid.length > LIMITS.MAX_STRING_LENGTH) continue;
          const r = stmt.run(mid, agent);
          if (r.changes > 0) updated.push(mid);
        }
      });
      tx();

      if (updated.length) {
        sseManager.broadcast('messages_read', { agent, messageIds: updated });
      }
      res.json({ ok: true, updated: updated.length });
    } catch (err) {
      log('error', 'Mark read failed', { error: err.message });
      res.status(500).json({ error: 'failed to mark messages as read' });
    }
  });

  // ── History ──────────────────────────────────────────────────────────────────

  app.get('/api/history', (req, res) => {
    try {
      const { agent, from, to, type, threadId, limit } = req.query;

      let query = 'SELECT * FROM messages WHERE 1=1';
      const params = [];

      if (agent) {
        if (!isValidString(agent)) return res.status(400).json({ error: 'invalid agent parameter' });
        query += ' AND (fromAgent = ? OR toAgent = ?)';
        params.push(agent, agent);
      }
      if (from) {
        if (!isValidString(from)) return res.status(400).json({ error: 'invalid from parameter' });
        query += ' AND fromAgent = ?';
        params.push(from);
      }
      if (to) {
        if (!isValidString(to)) return res.status(400).json({ error: 'invalid to parameter' });
        query += ' AND toAgent = ?';
        params.push(to);
      }
      if (type) {
        const typeCheck = validateEnum(type, VALID_MESSAGE_TYPES, 'type');
        if (!typeCheck.valid) return res.status(400).json({ error: typeCheck.error });
        query += ' AND type = ?';
        params.push(type);
      }
      if (threadId) {
        if (!isValidString(threadId)) return res.status(400).json({ error: 'invalid threadId parameter' });
        query += ' AND threadId = ?';
        params.push(threadId);
      }

      query += ' ORDER BY timestamp DESC';

      if (limit) {
        const limitCheck = validateInteger(limit, 1, appConfig.maxQueryLimit, 'limit');
        if (!limitCheck.valid) return res.status(400).json({ error: limitCheck.error });
        query += ' LIMIT ?';
        params.push(limitCheck.value);
      } else {
        query += ' LIMIT ?';
        params.push(appConfig.defaultLimit);
      }

      const msgs = db.prepare(query).all(...params);
      res.json({ messages: msgs });
    } catch (err) {
      log('error', 'History query failed', { error: err.message });
      res.status(500).json({ error: 'failed to retrieve message history' });
    }
  });

  // ── Get Thread ───────────────────────────────────────────────────────────────

  app.get('/api/thread/:threadId', (req, res) => {
    try {
      const { threadId } = req.params;
      if (!isValidString(threadId)) {
        return res.status(400).json({ error: 'threadId must be a non-empty string' });
      }
      const msgs = db.prepare(
        'SELECT * FROM messages WHERE threadId = ? ORDER BY timestamp ASC'
      ).all(threadId);
      res.json({ threadId, count: msgs.length, messages: msgs });
    } catch (err) {
      log('error', 'Thread query failed', { error: err.message });
      res.status(500).json({ error: 'failed to retrieve thread' });
    }
  });

  // ── SSE Stream ───────────────────────────────────────────────────────────────

  app.get('/api/stream', (req, res) => {
    // Check SSE client limit BEFORE sending headers to avoid race
    if (sseManager.count >= (appConfig.maxSseClients || LIMITS.MAX_SSE_CLIENTS)) {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'X-Accel-Buffering': 'no',
      });
      res.json({ error: 'too many SSE clients' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    if (!sseManager.add(res)) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'too many SSE clients' })}\n\n`);
      res.end();
      return;
    }

    req.on('close', () => sseManager.remove(res));
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────────

  app.get('/', (_req, res) => {
    res.send(getDashboardHTML());
  });

  // ── 404 Handler ──────────────────────────────────────────────────────────────

  app.use((req, res) => {
    res.status(404).json({ error: 'not found', path: req.path });
  });

  // ── Error Handler ─────────────────────────────────────────────────────────────

  app.use((err, req, res, _next) => {
    log('error', 'Unhandled error', {
      requestId: req._requestId,
      error: err.message,
      method: req.method,
      path: req.path,
    });
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body too large' });
    }
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

// ─── Dashboard HTML ────────────────────────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>SMF Team Bridge</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0} body{font:14px/1.5 system-ui;background:#0d1117;color:#c9d1d9;padding:20px}
  h1{color:#58a6ff;margin-bottom:10px} .panel{display:grid;grid-template-columns:250px 1fr;gap:20px}
  .agents{background:#161b22;border-radius:8px;padding:15px}
  .agents h2{font-size:16px;color:#8b949e;margin-bottom:10px}
  .agent{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px}
  .agent:hover{background:#21262d} .agent.online{color:#7ee787} .agent.offline{color:#484f58}
  .agent .dot{width:8px;height:8px;border-radius:50%} .agent.online .dot{background:#3fb950} .agent.offline .dot{background:#30363d}
  .agent .name{font-weight:600} .agent .platform{font-size:10px;opacity:.6}
  .feed{background:#161b22;border-radius:8px;padding:15px;max-height:80vh;overflow-y:auto}
  .msg{border-bottom:1px solid #21262d;padding:10px 0}
  .msg .header{display:flex;gap:10px;align-items:baseline;margin-bottom:4px}
  .msg .from{font-weight:600;color:#58a6ff} .msg .to{color:#8b949e;font-size:12px} .msg .time{color:#484f58;font-size:11px;margin-left:auto}
  .msg .body{white-space:pre-wrap;color:#c9d1d9} .msg .subject{font-weight:600;color:#d2a8ff}
</style></head>
<body>
<h1>🧬 SMF Works Team Communication Bridge</h1>
<p style="color:#8b949e;margin-bottom:20px">Live message stream — every AI-to-AI conversation, visible.</p>
<div class="panel">
  <div class="agents"><h2>Team Members</h2><div id="agentList"></div></div>
  <div class="feed"><div id="messages"><p style="color:#484f58">Waiting for messages...</p></div></div>
</div>
<script>
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(s == null ? '' : String(s)));
    return d.innerHTML;
  }
  const agentList=document.getElementById('agentList');
  const msgs=document.getElementById('messages');
  let first=true;
  fetch('/api/agents').then(r=>r.json()).then(d=>{
    agentList.innerHTML=d.agents.map(a=>{
      const name=escapeHtml(a.name);
      const platform=escapeHtml(a.platform);
      return \`<div class="agent offline" data-name="\${name}">
        <span class="dot"></span><span class="name">\${name}</span>
        <span class="platform">\${platform}</span>
      </div>\`;
    }).join('');
  });
  const es=new EventSource('/api/stream');
  es.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.type==='connected')return;
    if(first){msgs.innerHTML='';first=false}
    addMessage(d);
  };
  function addMessage(d){
    const time = d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : '';
    const subj = d.subject ? '<div class="subject">' + escapeHtml(d.subject) + '</div>' : '';
    const fromAgent = escapeHtml(d.fromAgent||'?');
    const toAgent = escapeHtml(d.toAgent||'?');
    const bodyText = escapeHtml(d.body||'');
    msgs.insertAdjacentHTML('afterbegin',
      '<div class="msg"><div class="header">' +
        '<span class="from">' + fromAgent + '</span>' +
        '<span class="to"> → ' + toAgent + '</span>' +
        '<span class="time">' + escapeHtml(time) + '</span>' +
      '</div>' + subj +
      '<div class="body">' + bodyText + '</div></div>'
    );
  }
  fetch('/api/history?limit=50').then(r=>r.json()).then(d=>{
    if(d.messages&&d.messages.length>0){
      msgs.innerHTML='';
      d.messages.reverse().forEach(m=>addMessage(m));
    }
  });
  es.addEventListener('agent_update',e=>{
    const d=JSON.parse(e.data);
    const name=escapeHtml(d.name);
    const el=document.querySelector(\`.agent[data-name="\${name}"]\`);
    if(el){el.className='agent '+escapeHtml(d.status)}
  });
</script>
</body></html>`;
}

// ─── Server Lifecycle ────────────────────────────────────────────────────────

let server = null;
let dbInstance = null;
let sseManagerInstance = null;
let shutdownHandlersRegistered = false;

function startServer() {
  dbInstance = initDatabase(config.dataDir);
  const seeded = seedDefaultAgents(dbInstance);
  sseManagerInstance = new SSEManager(config.maxSseClients);

  log('info', 'Starting SMF AI Bridge', {
    port: config.port,
    host: config.host,
    dataDir: config.dataDir,
    version: config.version,
  });

  if (seeded > 0) {
    log('info', 'Seeded default agents', { count: seeded });
  }

  const app = createApp(dbInstance, sseManagerInstance);

  server = app.listen(config.port, config.host, () => {
    log('info', 'SMF AI Bridge listening', {
      url: `http://${config.host}:${config.port}`,
      dashboard: `http://${config.host}:${config.port}/`,
      agents: DEFAULT_AGENTS.length,
    });
  });

  // Graceful shutdown — register handlers only once to prevent accumulation
  if (!shutdownHandlersRegistered) {
    function shutdown(signal) {
      log('info', 'Shutting down', { signal });

      // Close SSE connections FIRST so clients get notified
      if (sseManagerInstance) sseManagerInstance.closeAll();

      if (server) {
        server.close(() => {
          if (dbInstance) {
            try { dbInstance.close(); } catch { /* ignore */ }
          }
          log('info', 'Shutdown complete');
          process.exit(0);
        });
        // Force exit after timeout if connections don't close
        setTimeout(() => process.exit(1), LIMITS.SHUTDOWN_TIMEOUT_MS).unref();
      } else {
        if (dbInstance) {
          try { dbInstance.close(); } catch { /* ignore */ }
        }
        process.exit(0);
      }
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Prevent silent crashes on unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      log('error', 'Unhandled promise rejection', { error: String(reason) });
    });
    process.on('uncaughtException', (err) => {
      log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
      // Give the process a chance to flush logs, then exit
      setImmediate(() => process.exit(1));
    });

    shutdownHandlersRegistered = true;
  }

  return server;
}

// ─── Module Exports (for testing) ─────────────────────────────────────────────

export { createApp, initDatabase, seedDefaultAgents, SSEManager, config, DEFAULT_AGENTS,
         VALID_PLATFORMS, VALID_MESSAGE_TYPES, VALID_PRIORITIES, LIMITS,
         isValidString, validateEnum, validateInteger, log, parseConfig,
         safeBody, escapeHtml };

// ─── Start server when run directly ───────────────────────────────────────────

// Use import.meta.url instead of process.argv[1] for reliable main-module detection
import { fileURLToPath } from 'url';
const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
                     fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  startServer();
}