import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';

const DATA_DIR = process.env.BRIDGE_DATA_DIR || '/home/mikesai1/.openclaw/agents/aiona/workspace/team-bridge/data';
const PORT = parseInt(process.env.PORT || '8700');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(`${DATA_DIR}/bridge.db`);
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

const app = express();
app.use(express.json());

// SSE clients array
const sseClients = [];
let messageSeq = 0;

function notifySSE(event, data) {
  const payload = `id: ${++messageSeq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead = [];
  sseClients.forEach((res, i) => {
    try { res.write(payload); } catch (_) { dead.push(i); }
  });
  dead.reverse().forEach(i => sseClients.splice(i, 1));
}

// --- Registration ---
const DEFAULT_AGENTS = [
  { name: 'michael',  platform: 'webchat', role: 'Owner / Founder',               model: 'human',              sessionKey: null, gatewayPort: null },
  { name: 'aiona',     platform: 'openclaw', role: 'CIO / Chief AI Research Scientist', model: 'deepseek-v4-pro',     sessionKey: 'agent:aiona:main' },
  { name: 'gabriel',   platform: 'openclaw', role: 'CFO',                              model: 'kimi-k2.6',           sessionKey: 'agent:gabriel:main' },
  { name: 'rafael',    platform: 'openclaw', role: 'Chief of Staff',                   model: 'qwen3-vl:235b',       sessionKey: 'agent:rafael:main' },
  { name: 'morgan',    platform: 'openclaw', role: 'Marketing & Campaigns',            model: 'deepseek-v4-pro',     sessionKey: 'agent:morgan:main' },
  { name: 'pamela',    platform: 'openclaw', role: 'CMO',                              model: 'glm-5.1',             sessionKey: 'agent:pamela:main' },
  { name: 'louis',     platform: 'hermes',   role: 'General Assistant',                model: 'deepseek-v4-pro',     gatewayPort: 8640 },
  { name: 'drj',       platform: 'hermes',   role: 'Chief AI Medical Officer',         model: 'deepseek-v4-pro:cloud', gatewayPort: null },
  { name: 'harry',     platform: 'hermes',   role: 'Editor-in-Chief, WisdomForge',     model: 'kimi-k2.6:cloud',     gatewayPort: 8646 },
  { name: 'liam',      platform: 'hermes',   role: 'Chief Data Officer',               model: 'deepseek-v4-pro:cloud', gatewayPort: 8642 },
  { name: 'naill',     platform: 'hermes',   role: 'Agent',                            model: 'deepseek-v4-pro:cloud', gatewayPort: 8644 },
  { name: 'zayn',      platform: 'hermes',   role: 'Agent',                            model: 'deepseek-v4-pro:cloud', gatewayPort: 8645 },
];

// Seed default agents on startup
const seed = db.prepare('INSERT OR IGNORE INTO agents (id, name, platform, role, model, sessionKey, gatewayPort, status, lastSeen, registeredAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))');
for (const a of DEFAULT_AGENTS) {
  seed.run(randomUUID(), a.name, a.platform, a.role, a.model, a.sessionKey || null, a.gatewayPort || null, 'offline', null);
}

// --- Endpoints ---

// Health
app.get('/health', (_req, res) => res.json({ ok: true, service: 'smf-team-bridge', agents: db.prepare('SELECT COUNT(*) as count FROM agents').get().count }));

// List agents
app.get('/api/agents', (_req, res) => {
  res.json({ agents: db.prepare('SELECT name, platform, role, model, status, lastSeen FROM agents ORDER BY platform, name').all() });
});

// Register/update agent
app.post('/api/agents', (req, res) => {
  const { name, platform, role, model, sessionKey, gatewayPort } = req.body;
  if (!name || !platform) return res.status(400).json({ error: 'name and platform required' });
  const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(name);
  if (existing) {
    db.prepare(`UPDATE agents SET platform=?, role=?, model=?, sessionKey=?, gatewayPort=?, status='online', lastSeen=datetime('now') WHERE name=?`)
      .run(platform, role || null, model || null, sessionKey || null, gatewayPort || null, name);
    notifySSE('agent_update', { name, platform, status: 'online' });
    return res.json({ ok: true, action: 'updated', name });
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO agents (id,name,platform,role,model,sessionKey,gatewayPort,status,lastSeen,registeredAt) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
    .run(id, name, platform, role || null, model || null, sessionKey || null, gatewayPort || null, 'online');
  notifySSE('agent_update', { name, platform, status: 'online' });
  return res.status(201).json({ ok: true, action: 'created', name });
});

// Heartbeat
app.post('/api/heartbeat', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.prepare(`UPDATE agents SET status='online', lastSeen=datetime('now') WHERE name=?`).run(name);
  res.json({ ok: true });
});

// Send message
app.post('/api/send', (req, res) => {
  const { from, to, type, subject, body, threadId, priority } = req.body;
  if (!from || !to || !body) return res.status(400).json({ error: 'from, to, and body are required' });

  const sender = db.prepare('SELECT platform FROM agents WHERE name = ?').get(from);
  if (!sender) return res.status(404).json({ error: `sender "${from}" not registered` });

  const id = randomUUID();
  const msg = {
    id, fromAgent: from, fromPlatform: sender.platform,
    toAgent: to, type: type || 'direct',
    subject: subject || null, body, threadId: threadId || null,
    priority: priority || 'normal', read: 0,
    timestamp: new Date().toISOString()
  };

  db.prepare(`INSERT INTO messages (id, fromAgent, fromPlatform, toAgent, type, subject, body, threadId, priority, read, timestamp)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, msg.fromAgent, msg.fromPlatform, msg.toAgent, msg.type, msg.subject, msg.body, msg.threadId, msg.priority, 0, msg.timestamp
  );

  // Mark sender as active
  db.prepare(`UPDATE agents SET status='online', lastSeen=datetime('now') WHERE name=?`).run(from);

  notifySSE('new_message', msg);
  res.status(201).json({ ok: true, message: msg });
});

// Get inbox
app.get('/api/inbox/:agent', (req, res) => {
  const { agent } = req.params;
  const { unreadOnly, limit } = req.query;
  // Include messages addressed directly to this agent + all broadcasts/team messages
  let query = 'SELECT * FROM messages WHERE (toAgent = ? OR toAgent = \'team\' OR type = \'broadcast\')';
  const params = [agent];
  if (unreadOnly === 'true') { query += ' AND read = 0'; }
  query += ' ORDER BY timestamp DESC';
  if (limit) { query += ' LIMIT ?'; params.push(parseInt(limit)); }
  const msgs = db.prepare(query).all(...params);
  res.json({ agent, count: msgs.length, messages: msgs });
});

// Mark read
app.post('/api/read', (req, res) => {
  const { agent, messageIds } = req.body;
  if (!agent || !messageIds || !Array.isArray(messageIds)) return res.status(400).json({ error: 'agent and messageIds[] required' });
  const stmt = db.prepare('UPDATE messages SET read = 1 WHERE id = ? AND toAgent = ?');
  const updated = [];
  for (const mid of messageIds) {
    const r = stmt.run(mid, agent);
    if (r.changes > 0) updated.push(mid);
  }
  if (updated.length) notifySSE('messages_read', { agent, messageIds: updated });
  res.json({ ok: true, updated: updated.length });
});

// History
app.get('/api/history', (req, res) => {
  const { agent, from, to, type, threadId, limit } = req.query;
  let query = 'SELECT * FROM messages WHERE 1=1';
  const params = [];
  if (agent) { query += ' AND (fromAgent = ? OR toAgent = ?)'; params.push(agent, agent); }
  if (from) { query += ' AND fromAgent = ?'; params.push(from); }
  if (to) { query += ' AND toAgent = ?'; params.push(to); }
  if (type) { query += ' AND type = ?'; params.push(type); }
  if (threadId) { query += ' AND threadId = ?'; params.push(threadId); }
  query += ' ORDER BY timestamp DESC';
  if (limit) { query += ' LIMIT ?'; params.push(parseInt(limit)); }
  else { query += ' LIMIT 100'; }
  res.json({ messages: db.prepare(query).all(...params) });
});

// Get thread
app.get('/api/thread/:threadId', (req, res) => {
  const msgs = db.prepare('SELECT * FROM messages WHERE threadId = ? ORDER BY timestamp ASC').all(req.params.threadId);
  res.json({ threadId: req.params.threadId, count: msgs.length, messages: msgs });
});

// SSE stream for live dashboard
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// Dashboard HTML (simple)
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
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
  const agentList=document.getElementById('agentList');
  const msgs=document.getElementById('messages');
  let first=true;
  fetch('/api/agents').then(r=>r.json()).then(d=>{
    agentList.innerHTML=d.agents.map(a=>
      \`<div class="agent offline" data-name="\${a.name}">
        <span class="dot"></span><span class="name">\${a.name}</span>
        <span class="platform">\${a.platform}</span>
      </div>\`
    ).join('');
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
    const subj = d.subject ? '<div class="subject">' + d.subject + '</div>' : '';
    msgs.insertAdjacentHTML('afterbegin',
      '<div class="msg"><div class="header">' +
        '<span class="from">' + (d.fromAgent||'?') + '</span>' +
        '<span class="to"> → ' + (d.toAgent||'?') + '</span>' +
        '<span class="time">' + time + '</span>' +
      '</div>' + subj +
      '<div class="body">' + (d.body||'') + '</div></div>'
    );
  }
  // Load history on page load
  fetch('/api/history?limit=50').then(r=>r.json()).then(d=>{
    if(d.messages&&d.messages.length>0){
      msgs.innerHTML='';
      d.messages.reverse().forEach(m=>addMessage(m));
    }
  });
  es.addEventListener('agent_update',e=>{
    const d=JSON.parse(e.data);
    const el=document.querySelector(\`.agent[data-name="\${d.name}"]\`);
    if(el){el.className='agent '+d.status}
  });
</script>
</body></html>`);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`🧬 SMF Team Bridge running at http://127.0.0.1:${PORT}`);
  console.log(`   Dashboard: http://127.0.0.1:${PORT}/`);
  console.log(`   ${DEFAULT_AGENTS.length} agents registered`);
});
