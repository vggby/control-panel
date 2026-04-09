// OpenClaw Control Panel - Gateway WS Protocol
(function() {
'use strict';

const CONFIG_KEY = 'openclaw_config';
const defaults = {
  gatewayUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`,
  token: '6da6d44c1941ba5182bb4fb2fcbf482a892d7955ce34dae9',
  sessionKey: 'agent:main:main'
};

function loadConfig() {
  try {
    const saved = Object.assign({}, defaults, JSON.parse(localStorage.getItem(CONFIG_KEY)));
    return saved;
  }
  catch { return { ...defaults }; }
}
function saveConfig(c) { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); }

let config = loadConfig();
let ws = null;
let reconnectTimer = null;
let pendingRequests = new Map();
let reqIdCounter = 0;

// Chat state
let chatRunId = null;
let chatStream = null;
let chatMessages = [];
let chatLoading = false;
let systemMsgs = [];
let toolCalls = []; // { id, name, status, output }

const chatMessagesEl = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const connStatus = document.getElementById('connStatus');
const sidebar = document.getElementById('sidebar');
const mobileOverlay = document.getElementById('mobileOverlay');
const menuBtn = document.getElementById('menuBtn');

// --- Navigation ---
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const view = document.getElementById('view-' + btn.dataset.view);
    if (view) view.classList.add('active');
    if (btn.dataset.view === 'status') loadStatus();
    if (btn.dataset.view === 'sessions') loadSessions();
    if (btn.dataset.view === 'settings') initSettings();
    closeMobile();
  });
});

// --- Mobile ---
if (menuBtn) menuBtn.addEventListener('click', () => {
  sidebar.classList.toggle('open');
  mobileOverlay.classList.toggle('show');
});
if (mobileOverlay) mobileOverlay.addEventListener('click', closeMobile);
function closeMobile() { sidebar.classList.remove('open'); mobileOverlay.classList.remove('show'); }

// --- Chat Input ---
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});

// --- Helpers ---
function genId() { return 'r' + (++reqIdCounter) + '_' + Date.now(); }
function genUUID() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function extractText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n');
  }
  if (Array.isArray(msg)) {
    return msg.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n');
  }
  return '';
}

function setConnState(state) {
  connStatus.className = 'conn-status ' + state;
  const label = connStatus.querySelector('.label');
  if (state === 'ok') label.textContent = '已连接';
  else if (state === 'connecting') label.textContent = '连接中...';
  else label.textContent = '未连接';
}

function gwRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
    const id = genId();
    pendingRequests.set(id, { resolve, reject, timer: setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('request timeout'));
    }, 120000) });
    ws.send(JSON.stringify({ type: 'req', id, method, params: params || {} }));
  });
}

let connectNonce = null;
function sendConnect() {
  const auth = {};
  if (config.token) auth.token = config.token;
  gwRequest('connect', {
    minProtocol: 3, maxProtocol: 3,
    client: { id: 'openclaw-control-ui', version: '1.0.0', platform: navigator.platform || 'web', mode: 'ui' },
    role: 'operator', scopes: ['operator.read', 'operator.write'],
    caps: ['tool-events'], auth, userAgent: navigator.userAgent, locale: navigator.language
  }).then(() => {
    setConnState('ok');
    addSystemMsg('✅ 已连接到 OpenClaw');
    chatRunId = null;
    chatStream = null;
    loadChatHistory();
  }).catch(err => {
    setConnState('');
    addSystemMsg('❌ 连接失败: ' + err.message);
  });
}

function connect() {
  if (ws && ws.readyState <= 1) return;
  if (!config.token) { setConnState(''); addSystemMsg('请先在设置中填写 Token'); return; }
  setConnState('connecting');
  connectNonce = null;
  try { ws = new WebSocket(config.gatewayUrl); } catch(e) {
    setConnState(''); addSystemMsg('WebSocket 连接失败: ' + e.message); scheduleReconnect(); return;
  }
  ws.onopen = () => {};
  ws.onmessage = (evt) => { try { handleFrame(JSON.parse(evt.data)); } catch(e) { console.error('[ws]', e); } };
  ws.onclose = (evt) => { setConnState(''); if (evt.code !== 1000) scheduleReconnect(); };
  ws.onerror = () => { setConnState(''); };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

function handleFrame(data) {
  if (data.type === 'event') {
    if (data.event === 'connect.challenge') {
      var p = data.payload;
      if (p && typeof p.nonce === 'string') connectNonce = p.nonce;
      sendConnect();
      return;
    }
    if (data.event === 'chat' || data.event === 'agent') {
      var payload = data.payload || {};
      var stream = payload.stream || '';
      
      // Tool stream events: stream === 'tool'
      if (stream === 'tool') {
        handleToolStreamEvent(payload);
        return;
      }
      // Compaction/lifecycle/fallback streams - ignore
      if (stream === 'compaction' || stream === 'lifecycle' || stream === 'fallback') {
        return;
      }
      
      handleChatEvent(payload);
      return;
    }
    return;
  }
  if (data.type === 'res') {
    var p = pendingRequests.get(data.id);
    if (p) {
      pendingRequests.delete(p.id);
      clearTimeout(p.timer);
      data.ok ? p.resolve(data.payload) : p.reject(new Error(data.error?.message || 'failed'));
    }
  }
}

// --- Tool stream events (stream === 'tool') ---
function handleToolStreamEvent(payload) {
  var data = payload.data || {};
  var toolCallId = data.toolCallId || '';
  if (!toolCallId) return;
  
  var name = data.name || 'tool';
  var phase = data.phase || ''; // 'start', 'update', 'result'
  var args = phase === 'start' ? data.args : undefined;
  var output = phase === 'update' ? data.partialResult : (phase === 'result' ? data.result : undefined);
  if (typeof output === 'object' && output !== null) output = JSON.stringify(output);
  if (typeof output === 'string') output = output.slice(0, 500);
  
  var existing = toolCalls.find(function(t) { return t.id === toolCallId; });
  if (existing) {
    existing.name = name;
    if (args !== undefined) existing.args = typeof args === 'string' ? args.slice(0, 200) : JSON.stringify(args).slice(0, 200);
    if (output !== undefined) existing.output = output;
    existing.status = phase === 'result' ? 'done' : 'running';
  } else {
    toolCalls.push({
      id: toolCallId,
      name: name,
      status: phase === 'result' ? 'done' : 'running',
      args: typeof args === 'string' ? args.slice(0, 200) : (args ? JSON.stringify(args).slice(0, 200) : ''),
      output: output || ''
    });
  }
  renderChat();
}

function handleChatEvent(payload) {
  if (!payload) return;

  var state = payload.state;
  var data = payload.data || {};
  var stream = payload.stream;

  // For agent events: stream = "assistant" means delta
  if (stream === 'assistant') {
    state = 'delta';
  }

  if (state === 'delta' || stream === 'assistant') {
    var text = '';
    if (data.text) text = data.text;
    else if (data.delta) text = data.delta;
    else if (payload.message && payload.message.content) {
      var content = payload.message.content;
      if (Array.isArray(content)) {
        text = content.map(function(c) { return c.text || c.content || ''; }).join('');
      }
    }

    if (!chatRunId && payload.runId) {
      chatRunId = payload.runId;
    }

    if (typeof text === 'string' && text) {
      // Gateway sends full text each time, not incremental deltas
      if (!chatStream || text.length >= chatStream.length) {
        chatStream = text;
      }
      renderChat();
    }
  } else if (state === 'final') {
    chatStream = null;
    chatRunId = null;
    toolCalls = [];
    chatInput.disabled = false;
    chatInput.style.opacity = '1';
    chatInput.focus();
    loadChatHistory();
  } else if (state === 'error') {
    chatStream = null;
    chatRunId = null;
    toolCalls = [];
    chatInput.disabled = false;
    chatInput.style.opacity = '1';
    addSystemMsg('❌ ' + (payload.errorMessage || 'Error'));
  } else if (state === 'aborted') {
    chatStream = null;
    chatRunId = null;
    toolCalls = [];
    chatInput.disabled = false;
    chatInput.style.opacity = '1';
    addSystemMsg('⏹ 已中止');
  }
}

function filterMessages(msgs) {
  return msgs.filter(function(m) {
    var role = m.role || '';
    if (role === 'system' || role === 'tool' || role === 'toolResult' || role === 'tool_result') return false;
    var text = extractText(m);
    return text && text.trim() && text !== 'NO_REPLY' && text !== 'HEARTBEAT_OK';
  });
}

async function loadChatHistory() {
  if (chatLoading) return;
  chatLoading = true;
  try {
    var res = await gwRequest('chat.history', { sessionKey: config.sessionKey, limit: 200 });
    chatMessages = filterMessages(res.messages || []);
    renderChat();
  } catch(e) { console.error('[history]', e); }
  finally { chatLoading = false; }
}

function renderToolCalls() {
  if (toolCalls.length === 0) return '';
  return '<div class="tool-calls">' + toolCalls.map(function(tc) {
    var icon = tc.status === 'running' ? '⏳' : '✅';
    var cls = tc.status === 'running' ? 'tool-running' : 'tool-done';
    var html = '<div class="tool-item ' + cls + '"><span class="tool-icon">' + icon + '</span> ' +
      '<span class="tool-name">' + escapeHtml(tc.name) + '</span>';
    if (tc.args) {
      html += '<div class="tool-args">▸ ' + escapeHtml(tc.args.slice(0, 150)) + '</div>';
    }
    if (tc.output) {
      html += '<div class="tool-output">' + escapeHtml(tc.output.slice(0, 300)) + (tc.output.length > 300 ? '...' : '') + '</div>';
    }
    html += '</div>';
    return html;
  }).join('') + '</div>';
}

function renderGeneratingStatus() {
  if (chatRunId) {
    var parts = [];
    if (toolCalls.length > 0) {
      var running = toolCalls.filter(function(t) { return t.status === 'running'; });
      if (running.length > 0) parts.push('🔧 调用工具: ' + running.map(function(t) { return t.name; }).join(', '));
    }
    if (chatStream) parts.push('✍️ 生成中...');
    else if (toolCalls.length === 0) parts.push('🤔 思考中...');
    if (parts.length > 0) {
      return '<div class="generating-status">' + parts.join(' · ') + '</div>';
    }
  }
  return '';
}

function renderChat() {
  // If we have streaming content or active tool calls
  var isStreaming = chatRunId !== null;

  if (isStreaming) {
    chatMessagesEl.innerHTML = '';
    // Render history messages
    chatMessages.forEach(function(msg) {
      var role = (msg.role || 'assistant');
      var text = extractText(msg);
      if (text) appendMsgEl(role === 'user' ? 'user' : 'assistant', text);
    });
    // Render tool calls
    if (toolCalls.length > 0) {
      chatMessagesEl.insertAdjacentHTML('beforeend', renderToolCalls());
    }
    // Render streaming text
    if (chatStream) {
      appendMsgEl('assistant', chatStream);
    }
    // Generating status bar
    var statusHtml = renderGeneratingStatus();
    if (statusHtml) {
      chatMessagesEl.insertAdjacentHTML('beforeend', statusHtml);
    } else if (chatRunId && !chatStream && toolCalls.length === 0) {
      // Thinking indicator
      var existingTyping = chatMessagesEl.querySelector('.typing');
      if (!existingTyping) {
        var el = document.createElement('div');
        el.className = 'typing';
        el.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span> 思考中';
        chatMessagesEl.appendChild(el);
      }
    }
  } else {
    // Static render
    chatMessagesEl.innerHTML = '';
    systemMsgs.forEach(function(text) {
      var el = document.createElement('div');
      el.className = 'msg system';
      el.textContent = text;
      chatMessagesEl.appendChild(el);
    });
    chatMessages.forEach(function(msg) {
      var role = (msg.role || 'assistant');
      var text = extractText(msg);
      if (text) appendMsgEl(role === 'user' ? 'user' : 'assistant', text);
    });
  }

  scrollToBottom();
}

function appendMsgEl(role, text) {
  var el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = role === 'assistant' ? renderMarkdown(text) : escapeHtml(text);
  chatMessagesEl.appendChild(el);
}

function addSystemMsg(text) {
  systemMsgs.push(text);
  if (systemMsgs.length > 5) systemMsgs.shift();
  renderChat();
}

window.sendMessage = function() {
  var text = chatInput.value.trim();
  if (!text) return;
  if (chatRunId) {
    addSystemMsg('⏳ 等待当前回复完成后再发送');
    return;
  }
  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatInput.disabled = true;
  chatInput.style.opacity = '0.5';
  toolCalls = [];
  var lower = text.toLowerCase();
  if (lower === '/stop' || lower === 'stop' || lower === 'abort') {
    gwRequest('chat.abort', { sessionKey: config.sessionKey }).catch(function(){});
    return;
  }
  chatMessages = chatMessages.concat([{ role: 'user', content: [{ type: 'text', text: text }], timestamp: Date.now() }]);
  var idempotencyKey = genUUID();
  chatRunId = idempotencyKey;
  chatStream = '';
  renderChat();
  gwRequest('chat.send', {
    sessionKey: config.sessionKey, message: text, deliver: false, idempotencyKey: idempotencyKey
  }).then(function(res) {
    if (res && res.runId) chatRunId = res.runId;
  }).catch(function(err) {
    chatRunId = null;
    chatStream = null;
    chatInput.disabled = false;
    chatInput.style.opacity = '1';
    addSystemMsg('❌ 发送失败: ' + err.message);
  });
};

window.sendCommand = function(cmd) { chatInput.value = cmd; sendMessage(); };

function scrollToBottom() {
  requestAnimationFrame(function() { chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight; });
}
function escapeHtml(text) {
  var d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// --- Markdown Renderer (full) ---
function renderMarkdown(text) {
  if (!text) return '';
  // Escape HTML first
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks with syntax class
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
    var langAttr = lang ? ' class="language-' + lang + '"' : '';
    return '<pre' + langAttr + '><code>' + code + '</code></pre>';
  });

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Headings (# to ######)
  text = text.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  text = text.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rule
  text = text.replace(/^---+$/gm, '<hr>');

  // Tables
  text = text.replace(/^\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/gm, function(match, header, body) {
    var headers = header.split('|').map(function(h) { return '<th>' + h.trim() + '</th>'; }).join('');
    var rows = body.trim().split('\n').map(function(row) {
      var cols = row.replace(/^\||\|$/g, '').split('|').map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('');
      return '<tr>' + cols + '</tr>';
    }).join('');
    return '<table><thead><tr>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table>';
  });

  // Unordered lists
  text = text.replace(/^(\s*)[-*]\s+(.+)$/gm, function(_, indent, item) {
    return '<li>' + item + '</li>';
  });
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Blockquotes
  text = text.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');

  // Line breaks (but not inside pre/code blocks)
  text = text.replace(/\n/g, '<br>');

  // Clean up extra <br> around block elements
  text = text.replace(/<br>\s*(<\/?(?:pre|table|ul|ol|h[1-6]|hr|blockquote|li)[^>]*>)/g, '$1');
  text = text.replace(/(<\/(?:pre|table|ul|ol|h[1-6]|blockquote|li)>)\s*<br>/g, '$1');

  return text;
}

async function loadStatus() {
  var view = document.getElementById('view-status');
  view.innerHTML = '<div class="view-content"><div class="view-title">📊 系统状态</div><div id="statusContent">加载中...</div></div>';
  try {
    var res = await gwRequest('status', {});
    document.getElementById('statusContent').innerHTML =
      '<div class="card"><h3>概览</h3><div class="stat-grid">' +
      '<div class="stat"><div class="label">主机</div><div class="value">' + (res.hostname || '—') + '</div></div>' +
      '<div class="stat"><div class="label">运行时间</div><div class="value">' + (res.uptime || '—') + '</div></div>' +
      '<div class="stat"><div class="label">模型</div><div class="value">' + (res.model || '—') + '</div></div>' +
      '<div class="stat"><div class="label">会话数</div><div class="value">' + (res.sessions || '—') + '</div></div>' +
      '</div></div>';
  } catch(e) { document.getElementById('statusContent').textContent = '加载失败: ' + e.message; }
}

async function loadSessions() {
  var view = document.getElementById('view-sessions');
  view.innerHTML = '<div class="view-content"><div class="view-title">📋 会话管理</div><div id="sessionsContent">加载中...</div></div>';
  try {
    var res = await gwRequest('sessions.list', {});
    var list = res.sessions || [];
    document.getElementById('sessionsContent').innerHTML = '<div class="session-list">' + list.map(function(s) {
      var key = s.key || s.sessionKey;
      var safeKey = escapeHtml(key || '');
      return '<div class="session-item" data-key="' + safeKey + '">' +
        '<div class="info"><div class="name">' + (safeKey || '—') + '</div>' +
        '<div class="meta">' + (s.model || '') + ' · ' + (s.contextTokens ? s.contextTokens + ' tok' : '') + '</div></div>' +
        '<span class="badge ' + (s.active ? 'active' : '') + '">' + (s.active ? '活跃' : '空闲') + '</span></div>';
    }).join('') + '</div>';
    // Bind click events safely
    document.querySelectorAll('.session-item').forEach(function(el) {
      el.addEventListener('click', function() { switchSession(this.dataset.key); });
    });
  } catch(e) { document.getElementById('sessionsContent').textContent = '加载失败: ' + e.message; }
}

window.switchSession = function(key) {
  config.sessionKey = key; saveConfig(config);
  addSystemMsg('已切换到会话: ' + key);
  chatRunId = null; chatStream = null; chatMessages = []; toolCalls = [];
  loadChatHistory();
};

// Commands view (self-executing)
(function() {
  var view = document.getElementById('view-commands');
  var cmds = [
    { name: '/new', desc: '开始新会话', icon: '🔄' },
    { name: '/compact', desc: '压缩上下文', icon: '📦' },
    { name: '/status', desc: '查看状态', icon: '📊' },
    { name: '/reasoning', desc: '切换推理模式', icon: '🧠' },
    { name: '/model', desc: '切换模型', icon: '🤖' },
    { name: '/verbose', desc: '详细模式', icon: '📝' },
    { name: '/help', desc: '帮助信息', icon: '❓' }
  ];
  view.innerHTML = '<div class="view-content"><div class="view-title">⚡ 快捷命令</div>' +
    '<div class="cmd-grid">' + cmds.map(function(c) {
      return '<div class="cmd-card" onclick="sendCommand(\'' + c.name + '\')">' +
        '<div class="cmd-name">' + c.icon + ' ' + c.name + '</div><div class="cmd-desc">' + c.desc + '</div></div>';
    }).join('') + '</div>' +
    '<div style="margin-top:24px"><div class="view-title">自定义命令</div>' +
    '<div style="display:flex;gap:8px;margin-top:12px">' +
    '<input id="customCmd" placeholder="输入任意命令..." style="flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-size:.9em;outline:none">' +
    '<button class="btn" onclick="sendCommand(document.getElementById(\'customCmd\').value)">发送</button>' +
    '</div></div></div>';
})();

function initSettings() {
  config = loadConfig();
  document.getElementById('view-settings').innerHTML = '<div class="view-content">' +
    '<div class="view-title">⚙️ 设置</div><div class="card"><h3>连接配置</h3>' +
    '<div class="setting-group"><label>WebSocket 地址</label>' +
    '<input id="setWs" value="' + config.gatewayUrl + '" placeholder="ws://host:port"></div>' +
    '<div class="setting-group"><label>Token</label>' +
    '<input id="setToken" type="password" value="' + config.token + '" placeholder="Gateway auth token"></div>' +
    '<div class="setting-group"><label>会话 Key</label>' +
    '<input id="setSession" value="' + config.sessionKey + '" placeholder="main"></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px">' +
    '<button class="btn" onclick="saveSettings()">💾 保存并连接</button>' +
    '<button class="btn secondary" onclick="testConnection()">🔍 测试连接</button>' +
    '</div></div></div>';
}

window.saveSettings = function() {
  config.gatewayUrl = document.getElementById('setWs').value.trim();
  config.token = document.getElementById('setToken').value.trim();
  config.sessionKey = document.getElementById('setSession').value.trim() || 'main';
  saveConfig(config);
  addSystemMsg('⚙️ 设置已保存');
  if (ws) { ws.close(); ws = null; }
  pendingRequests.forEach(function(p) { clearTimeout(p.timer); p.reject(new Error('reconnecting')); });
  pendingRequests.clear();
  connect();
  document.querySelector('[data-view="chat"]').click();
};

window.testConnection = async function() {
  addSystemMsg('🔍 测试中...');
  try {
    var res = await gwRequest('status', {});
    addSystemMsg('✅ 连接正常 - ' + (res.hostname || 'ok'));
  } catch(e) { addSystemMsg('❌ ' + e.message); }
};

// --- Init ---
initSettings();
if (config.token) connect();
else addSystemMsg('👋 欢迎！请先到 ⚙️ 设置中填写连接信息');

// --- Server Info ---
async function updateServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    const data = await res.json();
    document.getElementById('memUsage').textContent = data.memory || '--';
    document.getElementById('diskUsage').textContent = data.disk || '--';
    document.getElementById('cpuUsage').textContent = data.cpu || '--';
  } catch(e) {
    console.error('Failed to fetch server info:', e);
  }
}

setInterval(updateServerInfo, 5000);
updateServerInfo();

})();
