// Interactive API playground — self-contained HTML served at GET /playground.
// Zero external dependencies. Dark mode. Modern dev-tool aesthetic.

function playgroundCSS(): string {
  return `
    :root {
      --bg-0: #09090b;
      --bg-1: #0f0f12;
      --bg-2: #18181b;
      --bg-3: #232328;
      --border: #27272a;
      --border-subtle: #1e1e22;
      --text-0: #fafafa;
      --text-1: #a1a1aa;
      --text-2: #63636e;
      --accent: #5b9dff;
      --accent-soft: rgba(91, 157, 255, 0.1);
      --accent-border: rgba(91, 157, 255, 0.25);
      --green: #4ade80;
      --green-soft: rgba(74, 222, 128, 0.1);
      --green-border: rgba(74, 222, 128, 0.25);
      --red: #f87171;
      --red-soft: rgba(248, 113, 113, 0.1);
      --amber: #fbbf24;
      --amber-soft: rgba(251, 191, 36, 0.1);
      --font-sans: -apple-system, 'Inter', system-ui, 'Segoe UI', sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', Consolas, monospace;
      --radius: 8px;
      --radius-sm: 6px;
    }

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-sans);
      background: var(--bg-0);
      color: var(--text-0);
      height: 100vh;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }

    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--bg-3); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-2); }

    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 2px; }

    /* ── App layout ── */
    .app {
      display: grid;
      grid-template-rows: 52px 1fr;
      height: 100vh;
    }

    /* ── Header ── */
    .header {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      padding: 0 20px;
      background: var(--bg-1);
      border-bottom: 1px solid var(--border);
      z-index: 10;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo {
      font-size: 18px;
      line-height: 1;
    }
    .logo-text {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-0);
      letter-spacing: -0.3px;
    }
    .version-badge {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-2);
      background: var(--bg-3);
      padding: 2px 7px;
      border-radius: 4px;
    }
    .header-center {
      display: flex;
      justify-content: center;
    }
    .header-right {
      display: flex;
      justify-content: flex-end;
      align-items: center;
    }

    /* ── Nav (segmented control) ── */
    .nav {
      display: inline-flex;
      gap: 1px;
      background: var(--bg-2);
      border-radius: var(--radius);
      padding: 3px;
    }
    .nav-item {
      padding: 6px 16px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-1);
      background: transparent;
      border: none;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
      font-family: var(--font-sans);
      white-space: nowrap;
    }
    .nav-item:hover { color: var(--text-0); background: var(--bg-3); }
    .nav-item.active {
      color: var(--text-0);
      background: var(--bg-3);
      box-shadow: 0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04);
    }

    /* ── API key input ── */
    .key-wrapper {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0 10px;
      height: 32px;
      transition: border-color 0.15s;
    }
    .key-wrapper:focus-within { border-color: var(--accent); }
    .key-wrapper svg { flex-shrink: 0; color: var(--text-2); }
    .key-input {
      background: none;
      border: none;
      color: var(--text-0);
      font-size: 12px;
      font-family: var(--font-mono);
      width: 160px;
      outline: none;
    }
    .key-input::placeholder { color: var(--text-2); }
    .key-input:focus { outline: none; }

    /* ── Content ── */
    .content {
      overflow: hidden;
      position: relative;
    }
    .panel { display: none; height: 100%; }
    .panel.active { display: flex; }

    /* ── Split pane ── */
    .split-pane {
      display: grid;
      grid-template-columns: 1fr 1fr;
      width: 100%;
      height: 100%;
    }
    .split-pane > .pane {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .split-pane > .pane:first-child {
      border-right: 1px solid var(--border);
    }
    .pane-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
      min-height: 44px;
    }
    .pane-head-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .pane-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
    }

    /* ── Method badges ── */
    .method-badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      font-family: var(--font-mono);
      letter-spacing: 0.5px;
    }
    .method-get { color: var(--green); background: var(--green-soft); }
    .method-post { color: var(--accent); background: var(--accent-soft); }
    .method-ws { color: var(--amber); background: var(--amber-soft); }
    .endpoint-path {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-1);
    }

    /* ── Form elements ── */
    .field-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-2);
      margin-bottom: 6px;
    }
    .field-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .field-row .label-inline {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-2);
      min-width: 90px;
    }
    input[type="text"] {
      flex: 1;
      background: var(--bg-0);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-0);
      padding: 7px 10px;
      font-size: 12px;
      font-family: var(--font-mono);
      transition: border-color 0.15s;
    }
    input[type="text"]:focus { outline: none; border-color: var(--accent); }
    input[type="text"]::placeholder { color: var(--text-2); }

    textarea {
      flex: 1;
      min-height: 120px;
      background: var(--bg-0);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-0);
      padding: 12px 14px;
      font-size: 13px;
      font-family: var(--font-mono);
      line-height: 1.6;
      resize: none;
      tab-size: 2;
      transition: border-color 0.15s;
    }
    textarea:focus { outline: none; border-color: var(--accent); }
    textarea::placeholder { color: var(--text-2); }

    /* ── Collapsible sections ── */
    .section-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-2);
      cursor: pointer;
      user-select: none;
      padding: 6px 0;
      margin-bottom: 4px;
      background: none;
      border: none;
      font-family: var(--font-sans);
    }
    .section-toggle:hover { color: var(--text-1); }
    .section-toggle svg {
      transition: transform 0.15s;
    }
    .section-toggle.open svg {
      transform: rotate(90deg);
    }
    .collapsible { display: none; margin-bottom: 12px; }
    .collapsible.open { display: block; }

    /* ── Buttons ── */
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      flex-shrink: 0;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 32px;
      padding: 0 14px;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      font-family: var(--font-sans);
      transition: all 0.15s;
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary {
      background: var(--accent);
      color: #fff;
    }
    .btn-primary:hover:not(:disabled) { background: #4a8df0; }
    .btn-ghost {
      background: transparent;
      color: var(--text-1);
      border: 1px solid var(--border);
    }
    .btn-ghost:hover:not(:disabled) { background: var(--bg-2); color: var(--text-0); }
    .btn-sm {
      height: 26px;
      padding: 0 10px;
      font-size: 12px;
    }

    /* ── Response area ── */
    .res-status {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .status-pill.ok { color: var(--green); background: var(--green-soft); }
    .status-pill.err { color: var(--red); background: var(--red-soft); }
    .status-pill.pending { color: var(--amber); background: var(--amber-soft); }
    .status-pill.cancelled { color: var(--text-2); background: var(--bg-3); }
    .res-duration { color: var(--text-2); font-size: 12px; font-family: var(--font-mono); }

    .mode-toggle {
      display: inline-flex;
      background: var(--bg-2);
      border-radius: 5px;
      padding: 2px;
      gap: 1px;
    }
    .mode-toggle button {
      padding: 3px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-2);
      background: transparent;
      border: none;
      cursor: pointer;
      font-family: var(--font-sans);
      transition: all 0.15s;
    }
    .mode-toggle button.active { color: var(--text-0); background: var(--bg-3); }
    .mode-toggle button:hover:not(.active) { color: var(--text-1); }

    .code-output {
      flex: 1;
      overflow-y: auto;
      background: var(--bg-0);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 14px 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      margin-top: 12px;
    }
    .code-output.empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-2);
      font-family: var(--font-sans);
      font-size: 13px;
    }

    /* ── JSON syntax highlighting ── */
    .json-key { color: #c4c4cc; }
    .json-string { color: #7dd3a8; }
    .json-number { color: #8cb4ff; }
    .json-boolean { color: #fbbf24; }
    .json-null { color: #63636e; }

    /* ── Streaming ── */
    .stream-area {
      flex: 1;
      overflow-y: auto;
      background: var(--bg-0);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 14px 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      margin-top: 12px;
      position: relative;
    }
    .cursor-blink {
      display: inline-block;
      width: 2px;
      height: 15px;
      background: var(--accent);
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
      margin-left: 1px;
      border-radius: 1px;
    }
    @keyframes blink { 50% { opacity: 0; } }

    .tool-block {
      border-left: 2px solid var(--amber);
      margin: 8px 0;
      padding: 8px 12px;
      background: var(--bg-2);
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }
    .tool-block-head {
      font-weight: 600;
      font-size: 12px;
      color: var(--amber);
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tool-block-head svg { transition: transform 0.15s; }
    .tool-block.open .tool-block-head svg { transform: rotate(90deg); }
    .tool-block-body {
      display: none;
      margin-top: 6px;
      font-size: 12px;
      color: var(--text-1);
    }
    .tool-block.open .tool-block-body { display: block; }
    .tool-block.result-ok { border-left-color: var(--green); }
    .tool-block.result-ok .tool-block-head { color: var(--green); }
    .tool-block.result-err { border-left-color: var(--red); }
    .tool-block.result-err .tool-block-head { color: var(--red); }

    .summary-bar {
      display: flex;
      gap: 20px;
      padding: 10px 14px;
      background: var(--bg-2);
      border-radius: var(--radius-sm);
      font-size: 12px;
      color: var(--text-1);
      margin-top: 10px;
      flex-shrink: 0;
    }
    .summary-bar span { font-family: var(--font-mono); }
    .summary-bar .label { color: var(--text-2); margin-right: 4px; }

    .jump-btn {
      position: sticky;
      bottom: 8px;
      float: right;
      padding: 4px 10px;
      font-size: 11px;
      background: var(--bg-3);
      color: var(--text-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      display: none;
      font-family: var(--font-sans);
    }
    .jump-btn:hover { background: var(--bg-2); }

    /* ── Status dashboard ── */
    .status-panel {
      width: 100%;
      height: 100%;
      overflow-y: auto;
      padding: 32px;
    }
    .status-inner {
      max-width: 720px;
      margin: 0 auto;
    }
    .status-hero {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 28px;
    }
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.green { background: var(--green); box-shadow: 0 0 8px rgba(74, 222, 128, 0.4); }
    .status-dot.red { background: var(--red); box-shadow: 0 0 8px rgba(248, 113, 113, 0.4); }
    .status-headline {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-0);
    }
    .status-sub {
      font-size: 12px;
      color: var(--text-2);
      margin-top: 1px;
    }

    .metrics-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 1px;
      background: var(--border-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .metric {
      background: var(--bg-1);
      padding: 16px 18px;
    }
    .metric-value {
      font-size: 20px;
      font-weight: 600;
      font-family: var(--font-mono);
      color: var(--text-0);
      line-height: 1.2;
    }
    .metric-label {
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-2);
      margin-top: 4px;
    }
    .metric-sub {
      font-size: 11px;
      color: var(--text-2);
      font-family: var(--font-mono);
      margin-top: 2px;
    }
    .metric-value.green { color: var(--green); }
    .metric-value.red { color: var(--red); }
    .metric-value.amber { color: var(--amber); }

    .queue-section {
      margin-top: 20px;
    }
    .queue-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-2);
      margin-bottom: 8px;
    }
    .queue-bar-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .queue-bar {
      flex: 1;
      height: 4px;
      background: var(--bg-3);
      border-radius: 2px;
      overflow: hidden;
    }
    .queue-bar-fill {
      height: 100%;
      border-radius: 2px;
      background: var(--accent);
      transition: width 0.3s;
    }
    .queue-bar-fill.warn { background: var(--amber); }
    .queue-bar-fill.crit { background: var(--red); }
    .queue-text {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-1);
      min-width: 70px;
      text-align: right;
    }

    .status-footer {
      margin-top: 20px;
      font-size: 11px;
      color: var(--text-2);
    }

    .status-error {
      color: var(--red);
      padding: 20px;
      font-size: 14px;
    }

    /* ── WebSocket ── */
    .ws-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .ws-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-2);
      flex-shrink: 0;
      transition: background 0.2s, box-shadow 0.2s;
    }
    .ws-dot.connected { background: var(--green); box-shadow: 0 0 6px rgba(74,222,128,0.4); }
    .ws-dot.connecting { background: var(--amber); box-shadow: 0 0 6px rgba(251,191,36,0.3); }
    .ws-label {
      font-size: 12px;
      color: var(--text-2);
      font-family: var(--font-mono);
    }

    .ws-log {
      flex: 1;
      overflow-y: auto;
      background: var(--bg-0);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.6;
    }
    .ws-msg { margin-bottom: 2px; }
    .ws-msg.sent { color: var(--accent); }
    .ws-msg.received { color: var(--green); }
    .ws-msg.system { color: var(--text-2); }
    .ws-msg .ws-prefix {
      display: inline-block;
      width: 16px;
      text-align: center;
      margin-right: 6px;
      opacity: 0.6;
    }

    .ws-input-wrap {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      flex-shrink: 0;
    }
    .ws-input-wrap textarea {
      min-height: 50px;
      flex: 1;
    }
    .ws-input-wrap .btn {
      align-self: flex-end;
    }

    /* ── Utilities ── */
    .hidden { display: none !important; }
    .gap-8 { gap: 8px; }
    .mt-12 { margin-top: 12px; }
    .mb-6 { margin-bottom: 6px; }

    /* ── Skeleton loading ── */
    @keyframes shimmer {
      0% { opacity: 0.5; }
      50% { opacity: 0.2; }
      100% { opacity: 0.5; }
    }
    .skeleton {
      background: var(--bg-3);
      border-radius: 4px;
      animation: shimmer 1.5s ease-in-out infinite;
    }
  `;
}

function playgroundJS(port: number): string {
  return `
(function() {
  var PORT = ${port};
  var BASE = location.origin;
  var WS_BASE = BASE.replace(/^http/, 'ws');

  var ENDPOINTS = {
    run: { method: 'POST', path: '/api/run' },
    stream: { method: 'POST', path: '/api/stream' },
    chat: { method: 'POST', path: '/v1/chat/completions' },
  };

  var state = {
    activeTab: 'status',
    apiKey: localStorage.getItem('otterly_api_key') || '',
    ws: null,
    wsConnected: false,
    activeAbort: null,
    statusInterval: null,
    autoScroll: true,
    history: [],
  };

  var $ = function(sel) { return document.querySelector(sel); };
  var $$ = function(sel) { return document.querySelectorAll(sel); };

  var chevronSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ── Init ──
  document.addEventListener('DOMContentLoaded', function() {
    var keyInput = $('#api-key');
    keyInput.value = state.apiKey;
    keyInput.addEventListener('input', function(e) {
      state.apiKey = e.target.value;
      localStorage.setItem('otterly_api_key', state.apiKey);
    });

    $$('.nav-item').forEach(function(btn) {
      btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
    });

    $$('.section-toggle').forEach(function(h) {
      h.addEventListener('click', function() {
        h.classList.toggle('open');
        var target = h.nextElementSibling;
        if (target) target.classList.toggle('open');
      });
    });

    $('#send-run').addEventListener('click', function() { sendRequest('run'); });
    $('#send-stream').addEventListener('click', function() { sendStream(); });
    $('#send-chat').addEventListener('click', function() { sendChat(); });

    $$('.btn-cancel').forEach(function(btn) {
      btn.addEventListener('click', cancelRequest);
    });

    // Mode toggles (formatted/raw)
    $$('.mode-toggle').forEach(function(group) {
      group.querySelectorAll('button').forEach(function(btn) {
        btn.addEventListener('click', function() {
          group.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          var panel = group.closest('.pane') || group.closest('.panel');
          var formatted = panel.querySelector('.response-formatted');
          var raw = panel.querySelector('.response-raw');
          if (formatted && raw) {
            var mode = btn.dataset.mode;
            formatted.classList.toggle('hidden', mode !== 'formatted');
            raw.classList.toggle('hidden', mode !== 'raw');
          }
        });
      });
    });

    // WebSocket
    $('#ws-connect').addEventListener('click', wsConnect);
    $('#ws-disconnect').addEventListener('click', wsDisconnect);
    $('#ws-send').addEventListener('click', wsSend);

    // Jump buttons
    $$('.jump-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var container = btn.closest('.stream-area') || btn.closest('.ws-log');
        if (container) {
          container.scrollTop = container.scrollHeight;
          state.autoScroll = true;
          btn.style.display = 'none';
        }
      });
    });

    $$('.stream-area, .ws-log').forEach(function(el) {
      el.addEventListener('scroll', function() {
        var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        state.autoScroll = atBottom;
        var jumpBtn = el.querySelector('.jump-btn');
        if (jumpBtn) jumpBtn.style.display = atBottom ? 'none' : 'block';
      });
    });

    switchTab('status');
  });

  function switchTab(tab) {
    state.activeTab = tab;
    $$('.nav-item').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === tab); });
    $$('.panel').forEach(function(p) { p.classList.toggle('active', p.id === 'panel-' + tab); });

    if (tab === 'status') {
      fetchStatus();
      state.statusInterval = setInterval(fetchStatus, 5000);
    } else if (state.statusInterval) {
      clearInterval(state.statusInterval);
      state.statusInterval = null;
    }
  }

  function getHeaders() {
    var h = { 'Content-Type': 'application/json' };
    if (state.apiKey) h['Authorization'] = 'Bearer ' + state.apiKey;
    var sid = $('#session-id-' + state.activeTab);
    if (sid && sid.value) h['X-Session-Id'] = sid.value;
    return h;
  }

  // ── JSON syntax highlighting ──
  function syntaxHighlight(json) {
    if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(
      /("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
      function(match) {
        var cls = 'json-number';
        if (/^"/.test(match)) {
          if (/:$/.test(match)) cls = 'json-key';
          else cls = 'json-string';
        } else if (/true|false/.test(match)) {
          cls = 'json-boolean';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  // ── Status ──
  var lastStatusData = null;
  async function fetchStatus() {
    try {
      var res = await fetch(BASE + '/api/status');
      var data = await res.json();
      lastStatusData = data;
      renderStatus(data);
    } catch (err) {
      $('#status-content').innerHTML = '<div class="status-error">Failed to connect: ' + escHtml(err.message) + '</div>';
    }
  }

  function renderStatus(d) {
    var isOk = d.status === 'ok';
    var cb = d.circuitBreaker || 'closed';
    var cbClass = cb === 'closed' ? 'green' : cb === 'open' ? 'red' : 'amber';
    var q = d.queue || {};
    var activeP = q.maxConcurrent ? Math.round((q.active || 0) / q.maxConcurrent * 100) : 0;
    var queuedP = q.maxQueueSize ? Math.round((q.queued || 0) / q.maxQueueSize * 100) : 0;
    var activeBarClass = activeP > 80 ? 'crit' : activeP > 50 ? 'warn' : '';
    var queuedBarClass = queuedP > 80 ? 'crit' : queuedP > 50 ? 'warn' : '';

    $('#status-content').innerHTML =
      '<div class="status-inner">' +
        '<div class="status-hero">' +
          '<div class="status-dot ' + (isOk ? 'green' : 'red') + '"></div>' +
          '<div>' +
            '<div class="status-headline">' + (isOk ? 'All systems operational' : 'System issue detected') + '</div>' +
            '<div class="status-sub">v' + escHtml(d.version || '?') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="metrics-row">' +
          '<div class="metric"><div class="metric-value">' + escHtml(d.version || '?') + '</div><div class="metric-label">Version</div></div>' +
          '<div class="metric"><div class="metric-value">' + (d.activeSessions || 0) + '</div><div class="metric-label">Sessions</div></div>' +
          '<div class="metric"><div class="metric-value ' + cbClass + '">' + escHtml(cb) + '</div><div class="metric-label">Circuit</div></div>' +
          '<div class="metric"><div class="metric-value">' + (q.active || 0) + '</div><div class="metric-label">Active</div><div class="metric-sub">/ ' + (q.maxConcurrent || '?') + ' max</div></div>' +
          '<div class="metric"><div class="metric-value">' + (q.queued || 0) + '</div><div class="metric-label">Queued</div><div class="metric-sub">/ ' + (q.maxQueueSize || '?') + ' max</div></div>' +
        '</div>' +
        '<div class="queue-section">' +
          '<div class="queue-label">Queue utilization</div>' +
          '<div class="queue-bar-wrap">' +
            '<div style="font-size:12px;color:var(--text-2);min-width:50px">Active</div>' +
            '<div class="queue-bar"><div class="queue-bar-fill ' + activeBarClass + '" style="width:' + Math.max(activeP, 1) + '%"></div></div>' +
            '<div class="queue-text">' + (q.active || 0) + ' / ' + (q.maxConcurrent || '?') + '</div>' +
          '</div>' +
          '<div class="queue-bar-wrap">' +
            '<div style="font-size:12px;color:var(--text-2);min-width:50px">Waiting</div>' +
            '<div class="queue-bar"><div class="queue-bar-fill ' + queuedBarClass + '" style="width:' + Math.max(queuedP, 1) + '%"></div></div>' +
            '<div class="queue-text">' + (q.queued || 0) + ' / ' + (q.maxQueueSize || '?') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="status-footer">Auto-refreshing every 5s</div>' +
      '</div>';
  }

  // ── Run (one-shot) ──
  async function sendRequest(tab) {
    var bodyEl = $('#body-' + tab);
    var resStatus = $('#res-status-' + tab);
    var resFormatted = $('#res-formatted-' + tab);
    var resRaw = $('#res-raw-' + tab);
    var sendBtn = $('#send-' + tab);
    var emptyEl = $('#res-empty-' + tab);

    var body;
    try { body = JSON.parse(bodyEl.value); } catch (e) {
      resStatus.innerHTML = '<span class="status-pill err">JSON Error</span> <span style="color:var(--text-1);font-size:12px">' + escHtml(e.message) + '</span>';
      return;
    }

    sendBtn.disabled = true;
    if (emptyEl) emptyEl.classList.add('hidden');
    resStatus.innerHTML = '<span class="status-pill pending">Pending</span>';
    resFormatted.innerHTML = '';
    resRaw.textContent = '';

    var startTime = Date.now();
    var controller = new AbortController();
    state.activeAbort = controller;

    try {
      var ep = ENDPOINTS[tab];
      var res = await fetch(BASE + ep.path, {
        method: ep.method,
        headers: getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      var duration = Date.now() - startTime;
      var raw = await res.text();
      var parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }

      var ok = res.status >= 200 && res.status < 300;
      resStatus.innerHTML =
        '<span class="status-pill ' + (ok ? 'ok' : 'err') + '">' + res.status + '</span>' +
        '<span class="res-duration">' + duration + 'ms</span>';

      if (typeof parsed === 'object') {
        resFormatted.innerHTML = syntaxHighlight(parsed);
      } else {
        resFormatted.textContent = raw;
      }
      resRaw.textContent = raw;

      var newSid = res.headers.get('X-Session-Id');
      var sidInput = $('#session-id-' + tab);
      if (newSid && sidInput) sidInput.value = newSid;
    } catch (err) {
      if (err.name === 'AbortError') {
        resStatus.innerHTML = '<span class="status-pill cancelled">Cancelled</span>';
      } else {
        resStatus.innerHTML = '<span class="status-pill err">Error</span> <span style="color:var(--text-1);font-size:12px">' + escHtml(err.message) + '</span>';
      }
    } finally {
      sendBtn.disabled = false;
      state.activeAbort = null;
    }
  }

  // ── Stream (NDJSON) ──
  async function sendStream() {
    var bodyEl = $('#body-stream');
    var output = $('#stream-output');
    var textArea = $('#stream-text');
    var rawArea = $('#stream-raw');
    var summary = $('#stream-summary');
    var sendBtn = $('#send-stream');
    var rawToggle = $('#stream-raw-toggle');

    var body;
    try { body = JSON.parse(bodyEl.value); } catch (e) {
      output.classList.remove('hidden');
      textArea.textContent = 'JSON parse error: ' + e.message;
      return;
    }

    sendBtn.disabled = true;
    output.classList.remove('hidden');
    textArea.innerHTML = '<span class="cursor-blink"></span>';
    rawArea.textContent = '';
    summary.classList.add('hidden');
    state.autoScroll = true;

    var controller = new AbortController();
    state.activeAbort = controller;
    var showRaw = false;
    rawToggle.textContent = 'Raw';
    rawToggle.onclick = function() {
      showRaw = !showRaw;
      rawToggle.textContent = showRaw ? 'Formatted' : 'Raw';
      textArea.classList.toggle('hidden', showRaw);
      rawArea.classList.toggle('hidden', !showRaw);
    };
    rawArea.classList.add('hidden');

    var fullText = '';

    try {
      var res = await fetch(BASE + '/api/stream', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.trim()) continue;
          rawArea.textContent += line + '\\n';

          var event;
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === 'text_delta') {
            fullText += event.delta || '';
            textArea.innerHTML = escHtml(fullText) + '<span class="cursor-blink"></span>';
          } else if (event.type === 'tool_use') {
            var block = makeToolBlock(event.name || 'tool_use', JSON.stringify(event.input || {}, null, 2));
            textArea.insertBefore(block, textArea.querySelector('.cursor-blink'));
          } else if (event.type === 'tool_result') {
            var content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content, null, 2);
            var block2 = makeToolBlock('Result' + (event.isError ? ' (error)' : ''), content, event.isError ? 'result-err' : 'result-ok');
            textArea.insertBefore(block2, textArea.querySelector('.cursor-blink'));
          } else if (event.type === 'result') {
            var cur = textArea.querySelector('.cursor-blink');
            if (cur) cur.remove();
            summary.classList.remove('hidden');
            summary.innerHTML =
              '<span><span class="label">Cost</span>$' + (event.cost || 0).toFixed(4) + '</span>' +
              '<span><span class="label">Duration</span>' + (event.duration || 0) + 'ms</span>' +
              (event.usage ? '<span><span class="label">Tokens</span>' + (event.usage.inputTokens || 0) + ' in / ' + (event.usage.outputTokens || 0) + ' out</span>' : '');
            var sidInput = $('#session-id-stream');
            if (event.sessionId && sidInput) sidInput.value = event.sessionId;
          } else if (event.type === 'session_init' && event.sessionId) {
            var sidInput2 = $('#session-id-stream');
            if (sidInput2) sidInput2.value = event.sessionId;
          }

          if (state.autoScroll) output.scrollTop = output.scrollHeight;
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        textArea.innerHTML = fullText + '\\n<span style="color:var(--red)">Error: ' + escHtml(err.message) + '</span>';
      } else {
        var cur2 = textArea.querySelector('.cursor-blink');
        if (cur2) cur2.remove();
        textArea.innerHTML += '\\n<span style="color:var(--text-2)">[Cancelled]</span>';
      }
    } finally {
      sendBtn.disabled = false;
      state.activeAbort = null;
      var cur3 = textArea.querySelector('.cursor-blink');
      if (cur3) cur3.remove();
    }
  }

  function makeToolBlock(name, content, extraClass) {
    var block = document.createElement('div');
    block.className = 'tool-block' + (extraClass ? ' ' + extraClass : '');
    block.innerHTML =
      '<div class="tool-block-head">' + chevronSvg + ' ' + escHtml(name) + '</div>' +
      '<div class="tool-block-body"><pre>' + escHtml(content) + '</pre></div>';
    block.querySelector('.tool-block-head').onclick = function() { block.classList.toggle('open'); };
    return block;
  }

  // ── Chat (OpenAI) ──
  async function sendChat() {
    var bodyEl = $('#body-chat');
    var sendBtn = $('#send-chat');

    var body;
    try { body = JSON.parse(bodyEl.value); } catch (e) {
      $('#res-status-chat').innerHTML = '<span class="status-pill err">JSON Error</span> <span style="color:var(--text-1);font-size:12px">' + escHtml(e.message) + '</span>';
      return;
    }

    if (body.stream === true) {
      await sendChatStream(body, sendBtn);
    } else {
      sendBtn.disabled = true;
      var resStatus = $('#res-status-chat');
      var resFormatted = $('#res-formatted-chat');
      var resRaw = $('#res-raw-chat');
      var emptyEl = $('#res-empty-chat');
      resStatus.innerHTML = '<span class="status-pill pending">Pending</span>';
      resFormatted.innerHTML = '';
      resRaw.textContent = '';
      if (emptyEl) emptyEl.classList.add('hidden');

      $('#chat-response-standard').classList.remove('hidden');
      $('#chat-stream-output').classList.add('hidden');

      var startTime = Date.now();
      var controller = new AbortController();
      state.activeAbort = controller;

      try {
        var res = await fetch(BASE + '/v1/chat/completions', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        var duration = Date.now() - startTime;
        var raw = await res.text();
        var parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }

        var ok = res.status >= 200 && res.status < 300;
        resStatus.innerHTML =
          '<span class="status-pill ' + (ok ? 'ok' : 'err') + '">' + res.status + '</span>' +
          '<span class="res-duration">' + duration + 'ms</span>';

        if (typeof parsed === 'object') {
          resFormatted.innerHTML = syntaxHighlight(parsed);
        } else {
          resFormatted.textContent = raw;
        }
        resRaw.textContent = raw;
      } catch (err) {
        if (err.name === 'AbortError') {
          resStatus.innerHTML = '<span class="status-pill cancelled">Cancelled</span>';
        } else {
          resStatus.innerHTML = '<span class="status-pill err">Error</span> <span style="color:var(--text-1);font-size:12px">' + escHtml(err.message) + '</span>';
        }
      } finally {
        sendBtn.disabled = false;
        state.activeAbort = null;
      }
    }
  }

  async function sendChatStream(body, sendBtn) {
    var output = $('#chat-stream-output');
    var textArea = $('#chat-stream-text');
    var summary = $('#chat-stream-summary');

    sendBtn.disabled = true;
    $('#chat-response-standard').classList.add('hidden');
    output.classList.remove('hidden');
    textArea.innerHTML = '<span class="cursor-blink"></span>';
    summary.classList.add('hidden');
    state.autoScroll = true;

    var controller = new AbortController();
    state.activeAbort = controller;
    var fullText = '';
    var startTime = Date.now();

    try {
      var res = await fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();

        for (var j = 0; j < lines.length; j++) {
          var line = lines[j];
          if (!line.startsWith('data: ')) continue;
          var data = line.slice(6);
          if (data === '[DONE]') {
            var cur = textArea.querySelector('.cursor-blink');
            if (cur) cur.remove();
            var duration = Date.now() - startTime;
            summary.classList.remove('hidden');
            summary.innerHTML = '<span><span class="label">Duration</span>' + duration + 'ms</span><span>Stream complete</span>';
            continue;
          }

          var event;
          try { event = JSON.parse(data); } catch { continue; }

          var delta = event.choices && event.choices[0] && event.choices[0].delta;
          if (delta && delta.content) {
            fullText += delta.content;
            textArea.innerHTML = escHtml(fullText) + '<span class="cursor-blink"></span>';
          }
          if (delta && delta.tool_calls) {
            for (var k = 0; k < delta.tool_calls.length; k++) {
              var tc = delta.tool_calls[k];
              if (tc.function && tc.function.name) {
                var block = makeToolBlock(tc.function.name, tc.function.arguments || '');
                textArea.insertBefore(block, textArea.querySelector('.cursor-blink'));
              }
            }
          }

          if (state.autoScroll) output.scrollTop = output.scrollHeight;
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        textArea.innerHTML = fullText + '\\n<span style="color:var(--red)">Error: ' + escHtml(err.message) + '</span>';
      } else {
        var cur2 = textArea.querySelector('.cursor-blink');
        if (cur2) cur2.remove();
        textArea.innerHTML += '\\n<span style="color:var(--text-2)">[Cancelled]</span>';
      }
    } finally {
      sendBtn.disabled = false;
      state.activeAbort = null;
      var cur3 = textArea.querySelector('.cursor-blink');
      if (cur3) cur3.remove();
    }
  }

  // ── WebSocket ──
  function wsConnect() {
    if (state.ws) return;
    var dot = $('#ws-dot');

    dot.className = 'ws-dot connecting';
    wsLog('Connecting to ' + WS_BASE + '/ws ...', 'system');

    var ws = new WebSocket(WS_BASE + '/ws');
    state.ws = ws;

    ws.onopen = function() {
      state.wsConnected = true;
      dot.className = 'ws-dot connected';
      wsLog('Connected', 'system');
      $('#ws-connect').disabled = true;
      $('#ws-disconnect').disabled = false;
      $('#ws-send').disabled = false;
      $('#ws-label').textContent = 'Connected';
    };

    ws.onmessage = function(e) {
      var display;
      try { display = JSON.stringify(JSON.parse(e.data), null, 2); }
      catch { display = e.data; }
      wsLog(display, 'received');
    };

    ws.onerror = function() { wsLog('Connection error', 'system'); };

    ws.onclose = function(e) {
      state.ws = null;
      state.wsConnected = false;
      dot.className = 'ws-dot';
      wsLog('Disconnected (code: ' + e.code + ')', 'system');
      $('#ws-connect').disabled = false;
      $('#ws-disconnect').disabled = true;
      $('#ws-send').disabled = true;
      $('#ws-label').textContent = 'Disconnected';
    };
  }

  function wsDisconnect() {
    if (state.ws) state.ws.close();
  }

  function wsSend() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    var input = $('#ws-input');
    var msg = input.value.trim();
    if (!msg) return;
    state.ws.send(msg);
    wsLog(msg, 'sent');
  }

  function wsLog(text, type) {
    var log = $('#ws-log');
    var div = document.createElement('div');
    div.className = 'ws-msg ' + type;
    var prefix = type === 'sent' ? '\\u25B6' : type === 'received' ? '\\u25C0' : '\\u2022';
    div.innerHTML = '<span class="ws-prefix">' + prefix + '</span>' + escHtml(text);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  // ── Utilities ──
  function cancelRequest() {
    if (state.activeAbort) {
      state.activeAbort.abort();
      state.activeAbort = null;
    }
  }

  function escHtml(str) {
    if (typeof str !== 'string') str = String(str);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
`;
}

function playgroundHTML(): string {
  return `
  <div class="app">
    <header class="header">
      <div class="header-left">
        <span class="logo">\u{1F9A6}</span>
        <span class="logo-text">otterly</span>
        <span class="version-badge">v0.3.6</span>
      </div>
      <div class="header-center">
        <nav class="nav">
          <button class="nav-item active" data-tab="status">Status</button>
          <button class="nav-item" data-tab="run">Run</button>
          <button class="nav-item" data-tab="stream">Stream</button>
          <button class="nav-item" data-tab="chat">Chat</button>
          <button class="nav-item" data-tab="ws">WebSocket</button>
        </nav>
      </div>
      <div class="header-right">
        <div class="key-wrapper">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <input type="password" id="api-key" class="key-input" placeholder="API Key">
        </div>
      </div>
    </header>

    <div class="content">
      <!-- ── Status ── -->
      <div class="panel active" id="panel-status">
        <div class="status-panel" id="status-content">
          <div class="status-inner">
            <div class="status-hero">
              <div class="skeleton" style="width:10px;height:10px;border-radius:50%"></div>
              <div><div class="skeleton" style="width:180px;height:18px;margin-bottom:4px"></div><div class="skeleton" style="width:60px;height:14px"></div></div>
            </div>
            <div class="skeleton" style="width:100%;height:100px;border-radius:8px"></div>
          </div>
        </div>
      </div>

      <!-- ── Run ── -->
      <div class="panel" id="panel-run">
        <div class="split-pane">
          <div class="pane">
            <div class="pane-head">
              <span class="method-badge method-post">POST</span>
              <span class="endpoint-path">/api/run</span>
            </div>
            <div class="pane-body">
              <button class="section-toggle" type="button">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Headers
              </button>
              <div class="collapsible">
                <div class="field-row">
                  <span class="label-inline">X-Session-Id</span>
                  <input type="text" id="session-id-run" placeholder="auto from response">
                </div>
              </div>
              <div class="field-label">Request body</div>
              <textarea id="body-run"></textarea>
              <div class="actions">
                <button class="btn btn-primary" id="send-run">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Send
                </button>
                <button class="btn btn-ghost btn-cancel">Cancel</button>
              </div>
            </div>
          </div>
          <div class="pane">
            <div class="pane-head">
              <span style="font-size:13px;font-weight:500;color:var(--text-1)">Response</span>
              <div class="pane-head-right">
                <div id="res-status-run" class="res-status"></div>
                <div class="mode-toggle">
                  <button class="active" data-mode="formatted">Formatted</button>
                  <button data-mode="raw">Raw</button>
                </div>
              </div>
            </div>
            <div class="pane-body">
              <div id="res-empty-run" class="code-output empty-state">Send a request to see the response</div>
              <pre id="res-formatted-run" class="code-output hidden response-formatted"></pre>
              <pre id="res-raw-run" class="code-output hidden response-raw"></pre>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Stream ── -->
      <div class="panel" id="panel-stream">
        <div class="split-pane">
          <div class="pane">
            <div class="pane-head">
              <span class="method-badge method-post">POST</span>
              <span class="endpoint-path">/api/stream</span>
            </div>
            <div class="pane-body">
              <button class="section-toggle" type="button">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Headers
              </button>
              <div class="collapsible">
                <div class="field-row">
                  <span class="label-inline">X-Session-Id</span>
                  <input type="text" id="session-id-stream" placeholder="auto from response">
                </div>
              </div>
              <div class="field-label">Request body</div>
              <textarea id="body-stream"></textarea>
              <div class="actions">
                <button class="btn btn-primary" id="send-stream">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Send
                </button>
                <button class="btn btn-ghost btn-cancel">Cancel</button>
                <button class="btn btn-ghost btn-sm" id="stream-raw-toggle">Raw</button>
              </div>
            </div>
          </div>
          <div class="pane">
            <div class="pane-head">
              <span style="font-size:13px;font-weight:500;color:var(--text-1)">Stream output</span>
            </div>
            <div class="pane-body">
              <div class="stream-area hidden" id="stream-output">
                <div id="stream-text"></div>
                <pre id="stream-raw" class="hidden"></pre>
                <button class="jump-btn">Jump to bottom</button>
              </div>
              <div id="stream-empty" class="code-output empty-state">Send a request to start streaming</div>
              <div class="summary-bar hidden" id="stream-summary"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Chat ── -->
      <div class="panel" id="panel-chat">
        <div class="split-pane">
          <div class="pane">
            <div class="pane-head">
              <span class="method-badge method-post">POST</span>
              <span class="endpoint-path">/v1/chat/completions</span>
            </div>
            <div class="pane-body">
              <button class="section-toggle" type="button">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Headers
              </button>
              <div class="collapsible">
                <div class="field-row">
                  <span class="label-inline">X-Session-Id</span>
                  <input type="text" id="session-id-chat" placeholder="auto from response">
                </div>
              </div>
              <div class="field-label">Request body</div>
              <textarea id="body-chat"></textarea>
              <div class="actions">
                <button class="btn btn-primary" id="send-chat">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Send
                </button>
                <button class="btn btn-ghost btn-cancel">Cancel</button>
              </div>
            </div>
          </div>
          <div class="pane">
            <div class="pane-head">
              <span style="font-size:13px;font-weight:500;color:var(--text-1)">Response</span>
              <div class="pane-head-right">
                <div id="res-status-chat" class="res-status"></div>
                <div class="mode-toggle">
                  <button class="active" data-mode="formatted">Formatted</button>
                  <button data-mode="raw">Raw</button>
                </div>
              </div>
            </div>
            <div class="pane-body">
              <div id="chat-response-standard">
                <div id="res-empty-chat" class="code-output empty-state">Send a request to see the response</div>
                <pre id="res-formatted-chat" class="code-output hidden response-formatted"></pre>
                <pre id="res-raw-chat" class="code-output hidden response-raw"></pre>
              </div>
              <div class="stream-area hidden" id="chat-stream-output">
                <div id="chat-stream-text"></div>
                <button class="jump-btn">Jump to bottom</button>
              </div>
              <div class="summary-bar hidden" id="chat-stream-summary"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── WebSocket ── -->
      <div class="panel" id="panel-ws">
        <div class="split-pane">
          <div class="pane">
            <div class="pane-head">
              <span class="method-badge method-ws">WS</span>
              <span class="endpoint-path">/ws</span>
            </div>
            <div class="pane-body">
              <div class="ws-controls">
                <span class="ws-dot" id="ws-dot"></span>
                <span class="ws-label" id="ws-label">Disconnected</span>
                <div style="margin-left:auto;display:flex;gap:6px">
                  <button class="btn btn-primary btn-sm" id="ws-connect">Connect</button>
                  <button class="btn btn-ghost btn-sm" id="ws-disconnect" disabled>Disconnect</button>
                </div>
              </div>
              <div class="field-label mt-12">Message</div>
              <textarea id="ws-input" style="min-height:80px"></textarea>
              <div class="actions">
                <button class="btn btn-primary" id="ws-send" disabled>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  Send
                </button>
              </div>
            </div>
          </div>
          <div class="pane">
            <div class="pane-head">
              <span style="font-size:13px;font-weight:500;color:var(--text-1)">Messages</span>
            </div>
            <div class="pane-body">
              <div class="ws-log" id="ws-log" style="flex:1"></div>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>
  `;
}

export function getPlaygroundHtml(port: number): string {
  const templateScript = `
<script>
document.addEventListener('DOMContentLoaded', function() {
  var T = {
    run: ${JSON.stringify(JSON.stringify({ prompt: "What is 2 + 2?", options: { maxTurns: 1 } }, null, 2))},
    stream: ${JSON.stringify(JSON.stringify({ prompt: "Write a haiku about coding", options: { maxTurns: 1 } }, null, 2))},
    chat: ${JSON.stringify(JSON.stringify({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "Hello! What can you do?" }], stream: false }, null, 2))},
    ws: ${JSON.stringify(JSON.stringify({ type: "start", prompt: "Hello from WebSocket" }, null, 2))}
  };
  var el;
  el = document.getElementById('body-run'); if (el) el.value = T.run;
  el = document.getElementById('body-stream'); if (el) el.value = T.stream;
  el = document.getElementById('body-chat'); if (el) el.value = T.chat;
  el = document.getElementById('ws-input'); if (el) el.value = T.ws;

  // Hide empty states when content appears
  document.querySelectorAll('.code-output.empty-state').forEach(function(empty) {
    var observer = new MutationObserver(function() {
      var panel = empty.closest('.pane-body');
      if (!panel) return;
      var formatted = panel.querySelector('.response-formatted');
      var raw = panel.querySelector('.response-raw');
      if ((formatted && formatted.innerHTML) || (raw && raw.textContent)) {
        empty.classList.add('hidden');
        if (formatted) formatted.classList.remove('hidden');
      }
    });
    var panel = empty.closest('.pane-body');
    if (panel) observer.observe(panel, { childList: true, subtree: true, characterData: true });
  });

  // Hide stream empty state when streaming starts
  var streamEmpty = document.getElementById('stream-empty');
  var streamOutput = document.getElementById('stream-output');
  if (streamEmpty && streamOutput) {
    new MutationObserver(function() {
      if (!streamOutput.classList.contains('hidden')) {
        streamEmpty.classList.add('hidden');
      }
    }).observe(streamOutput, { attributes: true, attributeFilter: ['class'] });
  }
});
</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>otterly playground</title>
<style>${playgroundCSS()}</style>
</head>
<body>
${playgroundHTML()}
<script>${playgroundJS(port)}</script>
${templateScript}
</body>
</html>`;
}
