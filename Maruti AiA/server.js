/* ═══════════════════════════════════════════════════════
   MARUTI — SERVER.JS
   Node.js + Express backend
   Handles: AI proxy, knowledge API, history API, file serving
   Run with: node server.js
   ═══════════════════════════════════════════════════════ */

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const http     = require('http');

const app  = express();
const PORT = 3000;

// ── CORS MIDDLEWARE (localhost only) ──
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  // Allow localhost origins only
  if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));

// ── SERVE FRONTEND STATIC FILES ──
// Serve index.html and all frontend files from current directory
app.use(express.static(path.join(__dirname)));

// ── DATA FILE PATHS ──
const DATA_DIR     = path.join(__dirname, 'data');
const KNOWLEDGE_F  = path.join(DATA_DIR, 'knowledge.json');
const HISTORY_F    = path.join(DATA_DIR, 'history.json');
const ADMIN_F      = path.join(DATA_DIR, 'admin_data.json');

// Create data directory if missing
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── HELPER: Read JSON file safely ──
function readJSON(filePath, defaultVal = []) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultVal;
  }
}

// ── HELPER: Write JSON file ──
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── HELPER: Call Ollama API ──
function callOllama(prompt, model = 'llama3') {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ model, prompt, stream: false });
    const options = {
      hostname: 'localhost',
      port    : 11434,
      path    : '/api/generate',
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || '');
        } catch {
          reject(new Error('Failed to parse Ollama response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body);
    req.end();
  });
}

// ── HELPER: Build AI prompt ──
function buildPrompt(action, text, knowledge = [], instructions = '') {
  const kbContext = knowledge.length
    ? `\nKNOWLEDGE BASE:\n${knowledge.map(k => `[${k.topic}]: ${k.content}`).join('\n')}\n`
    : '';

  const customInstr = instructions ? `\nCUSTOM INSTRUCTIONS: ${instructions}\n` : '';

  const base = `You are MARUTI, a private local AI writing assistant. Output ONLY the improved text — no explanations.${customInstr}${kbContext}`;

  const map = {
    improve      : `${base}\nIMPROVE this text for clarity and impact:\n\n${text}`,
    grammar      : `${base}\nFIX all grammar and spelling errors:\n\n${text}`,
    professional : `${base}\nREWRITE in professional business tone:\n\n${text}`,
    casual       : `${base}\nREWRITE in friendly, casual tone:\n\n${text}`,
    expand       : `${base}\nEXPAND with more detail and context:\n\n${text}`,
    shorten      : `${base}\nSHORTEN to core message only:\n\n${text}`,
    linkedin     : `${base}\nCONVERT to LinkedIn post with strong hook, short paragraphs, CTA:\n\n${text}`,
    email        : `${base}\nCONVERT to professional email with subject, greeting, body, sign-off:\n\n${text}`,
    bullets      : `${base}\nCONVERT to clear bullet points:\n\n${text}`,
    script       : `${base}\nCONVERT to natural spoken script:\n\n${text}`,
    meeting      : `${base}\nFORMAT as structured meeting notes with Date, Key Points, Decisions, Action Items:\n\n${text}`,
    summary      : `${base}\nSUMMARIZE in 2-3 sentences:\n\n${text}`,
    translate    : `${base}\nTRANSLATE to Hindi (Devanagari). If already Hindi, translate to English:\n\n${text}`,
  };

  return map[action] || map.improve;
}

// ══════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// ── GET /knowledge — Return knowledge base ──
app.get('/knowledge', (req, res) => {
  const knowledge = readJSON(KNOWLEDGE_F, []);
  res.json({ knowledge, count: knowledge.length, version: `v1.${knowledge.length}.0` });
});

// ── POST /update-knowledge — Save knowledge base ──
app.post('/update-knowledge', (req, res) => {
  const { knowledge } = req.body;
  if (!Array.isArray(knowledge)) {
    return res.status(400).json({ error: 'knowledge must be an array' });
  }
  writeJSON(KNOWLEDGE_F, knowledge);
  res.json({ success: true, count: knowledge.length });
});

// ── GET /history — Return session history ──
app.get('/history', (req, res) => {
  const history = readJSON(HISTORY_F, []);
  res.json({ history, count: history.length });
});

// ── POST /save-history — Add history entry ──
app.post('/save-history', (req, res) => {
  const entry   = req.body;
  const history = readJSON(HISTORY_F, []);
  history.unshift(entry);
  // Keep max 200 entries on server
  if (history.length > 200) history.splice(200);
  writeJSON(HISTORY_F, history);
  res.json({ success: true, id: entry.id });
});

// ── DELETE /history/:id — Delete history entry ──
app.delete('/history/:id', (req, res) => {
  const id      = parseInt(req.params.id);
  let history   = readJSON(HISTORY_F, []);
  history       = history.filter(h => h.id !== id);
  writeJSON(HISTORY_F, history);
  res.json({ success: true });
});

// ── POST /process-text — Main AI processing endpoint ──
app.post('/process-text', async (req, res) => {
  const { action, text, knowledge = [], instructions = '' } = req.body;

  if (!text || !action) {
    return res.status(400).json({ error: 'action and text are required' });
  }

  const prompt = buildPrompt(action, text, knowledge, instructions);

  try {
    const result = await callOllama(prompt);
    res.json({ result, source: 'ollama' });
  } catch (err) {
    console.error('Ollama error:', err.message);
    // Return fallback indicator
    res.status(503).json({ error: 'Ollama unavailable', message: err.message });
  }
});

// ── GET /admin — Return admin data ──
app.get('/admin', (req, res) => {
  const data = readJSON(ADMIN_F, { instructions: '', settings: {} });
  res.json(data);
});

// ── POST /admin — Save admin data ──
app.post('/admin', (req, res) => {
  writeJSON(ADMIN_F, req.body);
  res.json({ success: true });
});

// ── Catch-all: serve index.html for any unmatched route ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ══════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════
app.listen(PORT, () => {
  console.log('\n');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         MARUTI — LOCAL AI SYSTEM         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Server : http://localhost:${PORT}           ║`);
  console.log('║  Status : Running locally                 ║');
  console.log('║  Privacy: Zero external connections       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('\n  Open http://localhost:3000 in your browser\n');
});