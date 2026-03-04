/* ═══════════════════════════════════════════════════════
   MARUTI — SCRIPT.JS
   Complete frontend logic:
   - Speech recognition
   - AI text enhancement (Ollama + fallback)
   - Admin panel + knowledge management
   - History management
   - Settings
   - Keyboard shortcuts
   ═══════════════════════════════════════════════════════ */

// ── CONFIG ──
const CONFIG = {
  ADMIN_PASSWORD : 'maruti2024',
  SERVER_URL     : 'http://localhost:3000',
  OLLAMA_URL     : 'http://localhost:11434',
  OLLAMA_MODEL   : 'llama3',          // Change to your installed model
  STORAGE_KEYS   : {
    history       : 'maruti_history',
    knowledge     : 'maruti_knowledge',
    settings      : 'maruti_settings',
    adminUnlocked : 'maruti_admin',
    instructions  : 'maruti_instructions',
    kbVersion     : 'maruti_kb_version',
  },
};

// ── STATE ──
const state = {
  isRecording    : false,
  isAdminUnlocked: false,
  recognition    : null,
  finalTranscript: '',
  timerInterval  : null,
  timerSeconds   : 0,
  ollamaOnline   : false,
  serverOnline   : false,
  history        : [],
  knowledge      : [],
  settings       : {
    autoGrammar  : true,
    smartContext  : true,
    defaultTone   : 'professional',
    language      : 'en-US',
  },
  customInstructions: '',
};

// ── DOM HELPERS ──
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

/* ═══════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  loadSettings();
  loadHistory();
  loadKnowledge();
  checkOllama();
  checkServer();
  initSpeech();
  bindEvents();
  bindKeyboardShortcuts();
  restoreAdminSession();
});

/* ═══════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════ */
function loadSettings() {
  const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.settings);
  if (saved) Object.assign(state.settings, JSON.parse(saved));
  const instr = localStorage.getItem(CONFIG.STORAGE_KEYS.instructions);
  if (instr) state.customInstructions = instr;

  // Apply to UI
  $('autoGrammar').checked    = state.settings.autoGrammar;
  $('smartContext').checked   = state.settings.smartContext;
  $('defaultTone').value      = state.settings.defaultTone;
  $('langSelect').value       = state.settings.language;
  if ($('customInstructions') && state.customInstructions) {
    $('customInstructions').value = state.customInstructions;
  }
}

function saveSettings() {
  state.settings.autoGrammar = $('autoGrammar').checked;
  state.settings.smartContext = $('smartContext').checked;
  state.settings.defaultTone  = $('defaultTone').value;
  state.settings.language     = $('langSelect').value;
  localStorage.setItem(CONFIG.STORAGE_KEYS.settings, JSON.stringify(state.settings));
  // Update speech lang if active
  if (state.recognition) state.recognition.lang = state.settings.language;
  showToast('Settings saved', 'success');
}

/* ═══════════════════════════════════════════════════════
   HISTORY
   ═══════════════════════════════════════════════════════ */
function loadHistory() {
  const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.history);
  state.history = raw ? JSON.parse(raw) : [];
  renderHistory();
}

function saveHistoryToStorage() {
  localStorage.setItem(CONFIG.STORAGE_KEYS.history, JSON.stringify(state.history));
}

function addToHistory(text, mode) {
  const entry = {
    id       : Date.now(),
    text     : text.trim(),
    mode     : mode || 'transcript',
    timestamp: new Date().toLocaleString(),
    date     : new Date().toISOString(),
  };
  state.history.unshift(entry);
  if (state.history.length > 50) state.history.pop(); // Keep last 50
  saveHistoryToStorage();
  renderHistory();

  // Also post to server if online
  if (state.serverOnline) {
    fetch(`${CONFIG.SERVER_URL}/save-history`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(entry),
    }).catch(() => {});
  }
}

function renderHistory() {
  const list = $('historyList');
  if (!state.history.length) {
    list.innerHTML = `<div class="empty-s"><i data-lucide="mic-off"></i><p>No sessions yet.<br>Start recording to begin.</p></div>`;
    lucide.createIcons();
    return;
  }
  list.innerHTML = '';
  state.history.forEach(item => {
    const div = el('div', 'history-item');
    div.innerHTML = `
      <div class="history-item__time">${item.timestamp} · ${item.mode}</div>
      <div class="history-item__text">${escHtml(item.text.substring(0, 80))}...</div>
      <div class="history-item__actions">
        <button class="icon-btn h-load" data-id="${item.id}" title="Load"><i data-lucide="upload"></i></button>
        <button class="icon-btn h-del"  data-id="${item.id}" title="Delete"><i data-lucide="trash-2"></i></button>
      </div>
    `;
    list.appendChild(div);
  });
  lucide.createIcons();

  // Load session
  list.querySelectorAll('.h-load').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id   = parseInt(btn.dataset.id);
      const item = state.history.find(h => h.id === id);
      if (item) {
        $('outputEditor').value = item.text;
        updateOutputStats();
        showToast('Session loaded into output', 'success');
      }
    });
  });

  // Delete session
  list.querySelectorAll('.h-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      state.history = state.history.filter(h => h.id !== id);
      saveHistoryToStorage();
      renderHistory();
      showToast('Session deleted', '');
    });
  });
}

function clearHistory() {
  if (!confirm('Clear all session history?')) return;
  state.history = [];
  saveHistoryToStorage();
  renderHistory();
  showToast('History cleared', 'success');
}

/* ═══════════════════════════════════════════════════════
   KNOWLEDGE BASE
   ═══════════════════════════════════════════════════════ */
function loadKnowledge() {
  const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.knowledge);
  state.knowledge = raw ? JSON.parse(raw) : getDefaultKnowledge();
  if (!raw) saveKnowledge(); // Save defaults first time
  renderKnowledgeOverview();
  renderKnowledgeEntries();
  updateKbStats();
}

function getDefaultKnowledge() {
  return [
    {
      id        : 1,
      topic     : 'LinkedIn Writing Style',
      content   : 'Use strong hooks in the first line. Write short paragraphs (1-2 sentences). Be conversational and direct. Use line breaks for readability. End with a question or CTA.',
      tags      : ['linkedin', 'writing', 'social'],
      date_added: new Date().toISOString().split('T')[0],
    },
    {
      id        : 2,
      topic     : 'Professional Email Format',
      content   : 'Start with a clear subject. Use formal salutation. State purpose in first sentence. Keep body concise. End with clear next steps. Sign off professionally.',
      tags      : ['email', 'professional', 'communication'],
      date_added: new Date().toISOString().split('T')[0],
    },
    {
      id        : 3,
      topic     : 'Meeting Notes Structure',
      content   : 'Include: Date, Attendees, Agenda items, Key decisions made, Action items with owners and due dates, Next meeting date.',
      tags      : ['meeting', 'notes', 'structure'],
      date_added: new Date().toISOString().split('T')[0],
    },
  ];
}

function saveKnowledge() {
  localStorage.setItem(CONFIG.STORAGE_KEYS.knowledge, JSON.stringify(state.knowledge));
  const ver = `v1.${state.knowledge.length}.0`;
  localStorage.setItem(CONFIG.STORAGE_KEYS.kbVersion, ver);
  updateKbStats();

  // Post to server if online
  if (state.serverOnline) {
    fetch(`${CONFIG.SERVER_URL}/update-knowledge`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ knowledge: state.knowledge }),
    }).catch(() => {});
  }
}

function addKnowledgeEntry() {
  const topic   = $('kTopic').value.trim();
  const content = $('kContent').value.trim();
  const tagsRaw = $('kTags').value.trim();

  if (!topic) { showToast('Please enter a topic', 'error'); return; }
  if (!content) { showToast('Please enter content', 'error'); return; }

  const entry = {
    id        : Date.now(),
    topic,
    content,
    tags      : tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
    date_added: new Date().toISOString().split('T')[0],
  };

  state.knowledge.push(entry);
  saveKnowledge();
  renderKnowledgeOverview();
  renderKnowledgeEntries();

  // Reset form
  $('kTopic').value = '';
  $('kContent').value = '';
  $('kTags').value = '';

  showToast(`Knowledge added: "${topic}"`, 'gold');
}

function deleteKnowledgeEntry(id) {
  state.knowledge = state.knowledge.filter(k => k.id !== id);
  saveKnowledge();
  renderKnowledgeOverview();
  renderKnowledgeEntries();
  showToast('Entry deleted', '');
}

function renderKnowledgeOverview() {
  const list = $('kbOverviewList');
  if (!state.knowledge.length) {
    list.innerHTML = `<div class="empty-s"><i data-lucide="book-open"></i><p>No entries yet.<br>Add via Admin panel.</p></div>`;
    lucide.createIcons();
    return;
  }
  list.innerHTML = '';
  state.knowledge.forEach(k => {
    const div = el('div', 'kb-pill');
    div.innerHTML = `
      <div>
        <div class="kb-pill__topic">${escHtml(k.topic)}</div>
        <div class="kb-pill__preview">${escHtml(k.content)}</div>
      </div>
    `;
    list.appendChild(div);
  });
}

function renderKnowledgeEntries() {
  const list = $('entriesList');
  if (!list) return;
  if (!state.knowledge.length) {
    list.innerHTML = `<div class="empty-s">No entries yet.</div>`;
    return;
  }
  list.innerHTML = '';
  state.knowledge.forEach(k => {
    const div = el('div', 'entry-card');
    div.innerHTML = `
      <div class="entry-card__topic">${escHtml(k.topic)}</div>
      <div class="entry-card__content">${escHtml(k.content)}</div>
      <div class="entry-card__tags">
        ${k.tags.map(t => `<span class="entry-tag">${escHtml(t)}</span>`).join('')}
      </div>
      <div class="entry-card__actions">
        <button class="icon-btn del-entry" data-id="${k.id}" title="Delete"><i data-lucide="trash-2"></i></button>
      </div>
    `;
    list.appendChild(div);
  });
  lucide.createIcons();

  list.querySelectorAll('.del-entry').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this knowledge entry?')) {
        deleteKnowledgeEntry(parseInt(btn.dataset.id));
      }
    });
  });
}

function updateKbStats() {
  const ver = localStorage.getItem(CONFIG.STORAGE_KEYS.kbVersion) || 'v1.0.0';
  $('kbCount').textContent = `${state.knowledge.length} entries`;
  $('kbVer').textContent   = ver;
}

function buildKnowledgeContext() {
  if (!state.settings.smartContext || !state.knowledge.length) return '';
  const lines = state.knowledge.map(k => `[${k.topic}]: ${k.content}`).join('\n');
  return `\nKNOWLEDGE BASE CONTEXT:\n${lines}\n`;
}

/* ═══════════════════════════════════════════════════════
   SPEECH RECOGNITION
   ═══════════════════════════════════════════════════════ */
function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('Speech API not supported. Use Chrome or Edge.', 'error');
    return;
  }

  state.recognition = new SpeechRecognition();
  state.recognition.continuous      = true;
  state.recognition.interimResults  = true;
  state.recognition.maxAlternatives = 1;
  state.recognition.lang            = state.settings.language;

  state.recognition.onstart = () => {
    state.isRecording = true;
    updateMicUI(true);
    startTimer();
    hidePlaceholder();
  };

  state.recognition.onend = () => {
    if (state.isRecording) {
      // Auto-restart if still in recording mode
      try { state.recognition.start(); } catch(e) {}
    }
  };

  state.recognition.onresult = e => {
    let interim = '';
    let finalChunk = '';

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        finalChunk += text + ' ';
      } else {
        interim += text;
      }
    }

    if (finalChunk) {
      state.finalTranscript += finalChunk;
      $('tFinal').textContent = state.finalTranscript;
    }
    $('tInterim').textContent = interim;

    // Auto scroll
    const box = $('transcriptBox');
    box.scrollTop = box.scrollHeight;
  };

  state.recognition.onerror = e => {
    if (e.error === 'not-allowed') {
      showToast('Microphone permission denied. Please allow mic access.', 'error');
      stopRecording();
    } else if (e.error === 'no-speech') {
      // Normal — just no speech detected, continue
    } else {
      console.warn('Speech error:', e.error);
    }
  };
}

function startRecording() {
  if (!state.recognition) { showToast('Speech API not available', 'error'); return; }
  state.finalTranscript = '';
  $('tFinal').textContent = '';
  $('tInterim').textContent = '';
  state.recognition.lang = state.settings.language;
  try {
    state.recognition.start();
  } catch(e) {
    console.warn('Recognition start error:', e);
  }
}

function stopRecording() {
  state.isRecording = false;
  updateMicUI(false);
  stopTimer();
  if (state.recognition) {
    try { state.recognition.stop(); } catch(e) {}
  }
  $('tInterim').textContent = '';

  // Auto grammar fix if enabled
  if (state.settings.autoGrammar && state.finalTranscript.trim()) {
    setTimeout(() => processText('grammar'), 500);
  }
}

function toggleRecording() {
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function updateMicUI(recording) {
  const btn  = $('micBtn');
  const icon = $('micIcon');
  const dot  = $('recDot');
  const txt  = $('recStatusTxt');

  if (recording) {
    btn.classList.add('recording');
    icon.setAttribute('data-lucide', 'mic-off');
    dot.classList.add('active');
    txt.textContent = 'Recording...';
  } else {
    btn.classList.remove('recording');
    icon.setAttribute('data-lucide', 'mic');
    dot.classList.remove('active');
    txt.textContent = 'Ready';
  }
  lucide.createIcons();
}

function hidePlaceholder() {
  $('tPlaceholder').style.display = 'none';
}

function startTimer() {
  state.timerSeconds = 0;
  state.timerInterval = setInterval(() => {
    state.timerSeconds++;
    const m = String(Math.floor(state.timerSeconds / 60)).padStart(2, '0');
    const s = String(state.timerSeconds % 60).padStart(2, '0');
    $('recTimer').textContent = `${m}:${s}`;
  }, 1000);
}
function stopTimer() {
  clearInterval(state.timerInterval);
  $('recTimer').textContent = '00:00';
}

/* ═══════════════════════════════════════════════════════
   AI PROCESSING
   ═══════════════════════════════════════════════════════ */

// Check if Ollama is running
async function checkOllama() {
  $('aiDot').className = 'ai-dot ai-dot--checking';
  $('aiLabel').textContent = 'Checking AI...';
  try {
    const res = await fetch(`${CONFIG.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      state.ollamaOnline = true;
      $('aiDot').className    = 'ai-dot ai-dot--on';
      $('aiLabel').textContent = 'Ollama Online';
    } else throw new Error();
  } catch {
    state.ollamaOnline = false;
    $('aiDot').className    = 'ai-dot ai-dot--off';
    $('aiLabel').textContent = 'Fallback Mode';
  }
}

// Check if Node server is running
async function checkServer() {
  try {
    const res = await fetch(`${CONFIG.SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    state.serverOnline = res.ok;
  } catch {
    state.serverOnline = false;
  }
}

// Build prompt based on action
function buildPrompt(action, text) {
  const knowledgeCtx    = buildKnowledgeContext();
  const customInstr     = state.customInstructions ? `\nCUSTOM INSTRUCTIONS: ${state.customInstructions}\n` : '';
  const tone            = state.settings.defaultTone;

  const systemBase = `You are MARUTI, a private local AI writing assistant. Be concise and output ONLY the improved text — no explanations, no preamble, no meta-commentary.${customInstr}${knowledgeCtx}`;

  const prompts = {
    improve      : `${systemBase}\nIMPROVE this text for clarity, flow, and impact (${tone} tone):\n\n${text}`,
    grammar      : `${systemBase}\nFIX all grammar, punctuation, and spelling errors. Keep the original meaning and style:\n\n${text}`,
    professional : `${systemBase}\nREWRITE this in a polished, professional tone suitable for business communication:\n\n${text}`,
    casual       : `${systemBase}\nREWRITE this in a friendly, conversational, casual tone:\n\n${text}`,
    expand       : `${systemBase}\nEXPAND this text with more detail, context, and examples:\n\n${text}`,
    shorten      : `${systemBase}\nSHORTEN this text to its core message. Remove all fluff:\n\n${text}`,
    linkedin     : `${systemBase}\nCONVERT this into a high-performing LinkedIn post. Use a strong hook, short paragraphs, line breaks, and end with a question or insight:\n\n${text}`,
    email        : `${systemBase}\nCONVERT this into a professional email with subject line, greeting, body, and sign-off:\n\n${text}`,
    bullets      : `${systemBase}\nCONVERT this into clear, concise bullet points:\n\n${text}`,
    script       : `${systemBase}\nCONVERT this into a natural-sounding spoken script with clear delivery cues:\n\n${text}`,
    meeting      : `${systemBase}\nFORMAT this as structured meeting notes with: Date, Key Points, Decisions Made, and Action Items:\n\n${text}`,
    summary      : `${systemBase}\nSUMMARIZE this in 2-3 sentences capturing the core message:\n\n${text}`,
    translate    : `${systemBase}\nTRANSLATE this to Hindi (Devanagari script). If already Hindi, translate to English:\n\n${text}`,
  };

  return prompts[action] || prompts.improve;
}

// Process text via Ollama or fallback
async function processText(action) {
  const sourceText = action === 'clear' ? '' : (state.finalTranscript.trim() || $('outputEditor').value.trim());

  if (action === 'clear') {
    state.finalTranscript = '';
    $('tFinal').textContent = '';
    $('tInterim').textContent = '';
    $('tPlaceholder').style.display = '';
    $('outputEditor').value = '';
    $('lastAction').textContent = '—';
    updateOutputStats();
    return;
  }

  if (!sourceText) {
    showToast('Nothing to process — record or type some text first.', 'error');
    return;
  }

  const actionLabels = {
    improve: 'Improve Writing', grammar: 'Fix Grammar', professional: 'Make Professional',
    casual: 'Make Casual', expand: 'Expand', shorten: 'Shorten', linkedin: 'LinkedIn Post',
    email: 'Email Format', bullets: 'Bullet Points', script: 'Script Mode',
    meeting: 'Meeting Notes', summary: 'Summary', translate: 'Translate',
  };

  showThinking(true);
  $('lastAction').textContent = actionLabels[action] || action;

  try {
    let result = '';

    if (state.ollamaOnline) {
      result = await callOllama(action, sourceText);
    } else if (state.serverOnline) {
      result = await callServer(action, sourceText);
    } else {
      result = localFallback(action, sourceText);
    }

    $('outputEditor').value = result;
    updateOutputStats();
    showToast(`${actionLabels[action]} complete`, 'success');

  } catch (err) {
    console.error('Processing error:', err);
    // Try local fallback
    const result = localFallback(action, sourceText);
    $('outputEditor').value = result;
    updateOutputStats();
    showToast('Used local fallback engine', '');
  } finally {
    showThinking(false);
  }
}

// Call Ollama directly from browser
async function callOllama(action, text) {
  const prompt = buildPrompt(action, text);
  const res = await fetch(`${CONFIG.OLLAMA_URL}/api/generate`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      model : CONFIG.OLLAMA_MODEL,
      prompt: prompt,
      stream: false,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return (data.response || '').trim();
}

// Call Node.js server
async function callServer(action, text) {
  const res = await fetch(`${CONFIG.SERVER_URL}/process-text`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ action, text, knowledge: state.knowledge, instructions: state.customInstructions }),
    signal : AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();
  return data.result || '';
}

// Local structured fallback (no AI required)
function localFallback(action, text) {
  const cleanText = text.trim();

  const transforms = {
    improve: () => {
      const sentences = cleanText.split(/(?<=[.!?])\s+/);
      return sentences.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
    },
    grammar: () => {
      return cleanText
        .replace(/\bi\b/g, 'I')
        .replace(/\s+/g, ' ')
        .replace(/([.!?])\s*(\w)/g, (_, p, l) => `${p} ${l.toUpperCase()}`)
        .replace(/^(\w)/, l => l.toUpperCase())
        .trim();
    },
    professional: () => {
      return `Dear Reader,\n\n${cleanText}\n\nThank you for your consideration.\n\nBest regards`;
    },
    casual: () => {
      return cleanText.replace(/\. /g, '! ').replace(/however/gi, 'but').replace(/therefore/gi, 'so');
    },
    expand: () => {
      return `${cleanText}\n\nTo elaborate further on this point: The above statement represents an important consideration that deserves careful attention. There are multiple dimensions to this topic worth exploring, including the practical implications, the broader context, and the potential impact on stakeholders involved.`;
    },
    shorten: () => {
      const sentences = cleanText.split(/[.!?]+/).filter(s => s.trim());
      return sentences.slice(0, Math.max(1, Math.ceil(sentences.length / 3))).join('. ').trim() + '.';
    },
    linkedin: () => {
      const hook = cleanText.split('.')[0] + '.';
      const body = cleanText.substring(hook.length).trim();
      return `${hook}\n\n${body}\n\nWhat do you think? Drop your thoughts below 👇\n\n#AI #Productivity #Innovation`;
    },
    email: () => {
      return `Subject: [Add Subject Here]\n\nDear [Recipient],\n\nI hope this message finds you well.\n\n${cleanText}\n\nPlease feel free to reach out if you have any questions or require further information.\n\nBest regards,\n[Your Name]`;
    },
    bullets: () => {
      const sentences = cleanText.split(/[.!?]+/).filter(s => s.trim());
      return sentences.map(s => `• ${s.trim()}`).join('\n');
    },
    script: () => {
      return `[INTRO]\n${cleanText.split('.')[0]}.\n\n[MAIN POINT]\n${cleanText}\n\n[OUTRO]\nThat's the key takeaway. Thank you for listening.`;
    },
    meeting: () => {
      return `MEETING NOTES\nDate: ${new Date().toLocaleDateString()}\n\nKEY DISCUSSION POINTS:\n${cleanText}\n\nDECISIONS MADE:\n• [To be filled]\n\nACTION ITEMS:\n• [Owner] — [Action] — [Due Date]\n\nNEXT MEETING: [Date TBD]`;
    },
    summary: () => {
      const sentences = cleanText.split(/[.!?]+/).filter(s => s.trim());
      return sentences.slice(0, 2).join('. ').trim() + '.';
    },
    translate: () => {
      return `[⚠️ Translation requires Ollama to be running]\n\nOriginal text:\n${cleanText}`;
    },
  };

  const fn = transforms[action];
  return fn ? fn() : cleanText;
}

function showThinking(show) {
  $('thinkingBar').classList.toggle('active', show);
  // Disable all tool buttons while processing
  document.querySelectorAll('.tool-btn').forEach(b => b.disabled = show);
}

/* ═══════════════════════════════════════════════════════
   OUTPUT HELPERS
   ═══════════════════════════════════════════════════════ */
function updateOutputStats() {
  const text  = $('outputEditor').value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  $('wordCount').textContent = `${words} words`;
  $('charCount').textContent = `${text.length} chars`;
}

async function copyOutput() {
  const text = $('outputEditor').value;
  if (!text) { showToast('Nothing to copy', 'error'); return; }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard!', 'success');
  } catch {
    showToast('Copy failed — select text manually', 'error');
  }
}

function saveOutput() {
  const text = $('outputEditor').value.trim();
  const mode = $('lastAction').textContent;
  if (!text) { showToast('Nothing to save', 'error'); return; }
  addToHistory(text, mode);
  showToast('Saved to history', 'success');
}

/* ═══════════════════════════════════════════════════════
   ADMIN PANEL
   ═══════════════════════════════════════════════════════ */
function restoreAdminSession() {
  const saved = sessionStorage.getItem(CONFIG.STORAGE_KEYS.adminUnlocked);
  if (saved === 'true') unlockAdmin(true);
}

function tryAdminLogin() {
  const pw = $('adminPasswordInput').value;
  if (pw === CONFIG.ADMIN_PASSWORD) {
    unlockAdmin();
    closeModal('adminModal');
    $('adminPasswordInput').value = '';
    showToast('Admin panel unlocked', 'gold');
  } else {
    showToast('Incorrect password', 'error');
    $('adminPasswordInput').classList.add('shake');
    setTimeout(() => $('adminPasswordInput').classList.remove('shake'), 500);
  }
}

function unlockAdmin(silent = false) {
  state.isAdminUnlocked = true;
  sessionStorage.setItem(CONFIG.STORAGE_KEYS.adminUnlocked, 'true');

  $('lockScreen').style.display    = 'none';
  $('adminContent').style.display  = 'flex';
  $('adminContent').style.flexDirection = 'column';
  $('adminContent').style.gap      = '14px';

  $('adminBadge').classList.add('unlocked');
  $('adminBadgeIcon').setAttribute('data-lucide', 'shield-check');
  $('adminBadgeTxt').textContent = 'Unlocked';

  $('adminNavIcon').setAttribute('data-lucide', 'shield-check');
  $('adminNavLabel').textContent = 'Admin ✓';

  $('adminSettingsGroup').style.display = '';
  if ($('customInstructions')) $('customInstructions').value = state.customInstructions;

  renderKnowledgeEntries();
  lucide.createIcons();
  if (!silent) showToast('Admin panel unlocked', 'gold');
}

function lockAdmin() {
  state.isAdminUnlocked = false;
  sessionStorage.removeItem(CONFIG.STORAGE_KEYS.adminUnlocked);

  $('lockScreen').style.display    = '';
  $('adminContent').style.display  = 'none';

  $('adminBadge').classList.remove('unlocked');
  $('adminBadgeIcon').setAttribute('data-lucide', 'lock');
  $('adminBadgeTxt').textContent = 'Locked';

  $('adminNavIcon').setAttribute('data-lucide', 'lock');
  $('adminNavLabel').textContent = 'Admin';

  $('adminSettingsGroup').style.display = 'none';
  lucide.createIcons();
  showToast('Admin panel locked', '');
}

function saveInstructions() {
  const instr = $('customInstructions').value.trim();
  state.customInstructions = instr;
  localStorage.setItem(CONFIG.STORAGE_KEYS.instructions, instr);
  showToast('Custom instructions saved', 'success');
}

function exportKnowledge() {
  const data = JSON.stringify({ version: '1.0', knowledge: state.knowledge }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `maruti_knowledge_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Knowledge base exported', 'success');
}

function importKnowledge(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      const entries = data.knowledge || data;
      if (!Array.isArray(entries)) throw new Error('Invalid format');
      state.knowledge = entries;
      saveKnowledge();
      renderKnowledgeOverview();
      renderKnowledgeEntries();
      showToast(`Imported ${entries.length} entries`, 'success');
    } catch {
      showToast('Invalid JSON file', 'error');
    }
  };
  reader.readAsText(file);
}

function resetKnowledge() {
  if (!confirm('Reset knowledge base to defaults? This cannot be undone.')) return;
  state.knowledge = getDefaultKnowledge();
  saveKnowledge();
  renderKnowledgeOverview();
  renderKnowledgeEntries();
  showToast('Knowledge base reset to defaults', 'gold');
}

/* ═══════════════════════════════════════════════════════
   MODAL HELPERS
   ═══════════════════════════════════════════════════════ */
function openModal(id)  { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

/* ═══════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════ */
let toastTimer;
function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className   = `toast show ${type ? 'toast--' + type : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3000);
}

/* ═══════════════════════════════════════════════════════
   UTILITY
   ═══════════════════════════════════════════════════════ */
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ═══════════════════════════════════════════════════════
   EVENT BINDINGS
   ═══════════════════════════════════════════════════════ */
function bindEvents() {

  // Mic button
  $('micBtn').addEventListener('click', toggleRecording);

  // Tool buttons
  document.querySelectorAll('.tool-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => processText(btn.dataset.action));
  });

  // Output stats on typing
  $('outputEditor').addEventListener('input', updateOutputStats);

  // Copy + Save buttons
  $('copyBtn').addEventListener('click', copyOutput);
  $('saveBtn').addEventListener('click', saveOutput);

  // History
  $('clearHistoryBtn').addEventListener('click', clearHistory);

  // Knowledge reload
  $('reloadKbBtn').addEventListener('click', () => {
    loadKnowledge();
    showToast('Knowledge base reloaded', 'success');
  });

  // ── NAV BUTTONS ──
  $('settingsBtn').addEventListener('click', () => openModal('settingsModal'));
  $('adminNavBtn').addEventListener('click', () => {
    if (state.isAdminUnlocked) {
      lockAdmin();
    } else {
      openModal('adminModal');
    }
  });

  // ── ADMIN MODAL ──
  $('adminModalClose').addEventListener('click',  () => closeModal('adminModal'));
  $('adminModalCancel').addEventListener('click', () => closeModal('adminModal'));
  $('adminLoginSubmit').addEventListener('click', tryAdminLogin);
  $('adminPasswordInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryAdminLogin();
  });

  // Admin unlock button inside panel
  $('adminUnlockBtn').addEventListener('click', () => openModal('adminModal'));

  // ── SETTINGS MODAL ──
  $('settingsModalClose').addEventListener('click', () => closeModal('settingsModal'));
  $('saveSettingsBtn').addEventListener('click', () => { saveSettings(); closeModal('settingsModal'); });

  // Settings admin controls
  $('exportKnowledgeBtn').addEventListener('click', exportKnowledge);
  $('importKnowledgeBtn').addEventListener('click', () => $('importFileInput').click());
  $('importFileInput').addEventListener('change', e => {
    if (e.target.files[0]) importKnowledge(e.target.files[0]);
  });
  $('clearHistorySettingsBtn').addEventListener('click', () => { clearHistory(); closeModal('settingsModal'); });
  $('resetKnowledgeBtn').addEventListener('click', resetKnowledge);

  // ── ADMIN CONTENT BUTTONS ──
  $('addKbBtn').addEventListener('click', addKnowledgeEntry);
  $('saveInstructionsBtn').addEventListener('click', saveInstructions);
  $('adminLogoutBtn').addEventListener('click', lockAdmin);
  $('reloadEntriesBtn').addEventListener('click', () => {
    renderKnowledgeEntries();
    showToast('Entries reloaded', 'success');
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });
}

/* ═══════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════ */
function bindKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName.toLowerCase();
    const isTyping = ['input', 'textarea'].includes(tag);

    // Space = toggle recording (only when not typing)
    if (e.code === 'Space' && !isTyping) {
      e.preventDefault();
      toggleRecording();
    }

    // Ctrl + Enter = Improve text
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      processText('improve');
    }

    // Ctrl + S = Save to history
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      saveOutput();
    }

    // Escape = close any open modal
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
  });
}