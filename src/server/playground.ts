// Interactive UI for otterly — served at GET /playground and GET /dashboard.
// Single-file HTML with inline CSS + JS. Zero deps. Light + dark mode.
// Exports getPlaygroundHtml(port, version) — both args come from server/index.ts.

function styles(): string {
  return `
    /* ── Design tokens ── */
    :root[data-theme="dark"] {
      --bg-0:#0a0a0c; --bg-1:#111114; --bg-2:#17171a; --bg-3:#1f1f23;
      --bd-1:#26262b; --bd-2:#1c1c20;
      --tx-0:#fafafa; --tx-1:#a1a1aa; --tx-2:#71717a; --tx-3:#52525b;
      --ac:#818cf8; --ac-strong:#6366f1; --ac-soft:rgba(129,140,248,.12); --ac-border:rgba(129,140,248,.28);
      --ok:#34d399; --ok-soft:rgba(52,211,153,.12); --ok-border:rgba(52,211,153,.28);
      --err:#f87171; --err-soft:rgba(248,113,113,.12); --err-border:rgba(248,113,113,.28);
      --warn:#fbbf24; --warn-soft:rgba(251,191,36,.12); --warn-border:rgba(251,191,36,.28);
      --json-key:#cbd5e1; --json-string:#7dd3a8; --json-number:#93c5fd; --json-bool:#fbbf24; --json-null:#6b7280; --json-punct:#71717a; --indent-guide:#26262b;
      --shadow-card:0 1px 0 rgba(255,255,255,.04) inset, 0 1px 2px rgba(0,0,0,.4);
    }
    :root[data-theme="light"] {
      --bg-0:#fafaf9; --bg-1:#ffffff; --bg-2:#f5f5f4; --bg-3:#e7e5e4;
      --bd-1:#e7e5e4; --bd-2:#f0efed;
      --tx-0:#0a0a0a; --tx-1:#3f3f46; --tx-2:#71717a; --tx-3:#a1a1aa;
      --ac:#4f46e5; --ac-strong:#4338ca; --ac-soft:rgba(79,70,229,.08); --ac-border:rgba(79,70,229,.22);
      --ok:#059669; --ok-soft:rgba(5,150,105,.08); --ok-border:rgba(5,150,105,.22);
      --err:#dc2626; --err-soft:rgba(220,38,38,.08); --err-border:rgba(220,38,38,.22);
      --warn:#d97706; --warn-soft:rgba(217,119,6,.08); --warn-border:rgba(217,119,6,.22);
      --json-key:#3f3f46; --json-string:#047857; --json-number:#1d4ed8; --json-bool:#b45309; --json-null:#9ca3af; --json-punct:#71717a; --indent-guide:#e7e5e4;
      --shadow-card:0 1px 0 rgba(255,255,255,1) inset, 0 1px 2px rgba(0,0,0,.04);
    }
    :root {
      --font-sans:'Inter','-apple-system',BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
      --font-mono:'JetBrains Mono','SF Mono','Cascadia Code','Fira Code',Consolas,monospace;
      --r-sm:6px; --r:8px; --r-lg:12px;
      --t:150ms cubic-bezier(.4,0,.2,1);
    }

    *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

    body {
      font-family:var(--font-sans);
      background:var(--bg-0); color:var(--tx-0);
      height:100vh; overflow:hidden;
      -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
      font-feature-settings:"cv11","ss03";
    }
    button { font-family:inherit; cursor:pointer; }
    input, textarea { font-family:inherit; }

    /* ── Scrollbars ── */
    ::-webkit-scrollbar { width:8px; height:8px; }
    ::-webkit-scrollbar-track { background:transparent; }
    ::-webkit-scrollbar-thumb { background:var(--bd-1); border-radius:4px; border:2px solid transparent; background-clip:padding-box; }
    ::-webkit-scrollbar-thumb:hover { background:var(--tx-3); background-clip:padding-box; border:2px solid transparent; }
    * { scrollbar-width:thin; scrollbar-color:var(--bd-1) transparent; }

    :focus-visible { outline:2px solid var(--ac); outline-offset:1px; border-radius:3px; }

    /* ── App shell ── */
    .app {
      display:grid;
      grid-template-rows:56px 1fr;
      grid-template-columns:240px 1fr;
      grid-template-areas:'header header' 'sidebar main';
      height:100vh;
    }
    .header {
      grid-area:header;
      display:flex; align-items:center;
      padding:0 20px 0 20px;
      background:var(--bg-1);
      border-bottom:1px solid var(--bd-1);
      z-index:10;
      gap:16px;
    }
    .sidebar {
      grid-area:sidebar;
      background:var(--bg-1);
      border-right:1px solid var(--bd-1);
      padding:18px 12px;
      display:flex; flex-direction:column; gap:4px;
      overflow-y:auto;
    }
    .main { grid-area:main; overflow:hidden; position:relative; }

    /* ── Brand / Header ── */
    .brand { display:flex; align-items:center; gap:10px; min-width:208px; }
    .brand-mark { width:28px; height:28px; flex-shrink:0; border-radius:7px; overflow:hidden; }
    .brand-name { font-size:15px; font-weight:600; color:var(--tx-0); letter-spacing:-.2px; }
    .brand-version {
      font-size:11px; font-family:var(--font-mono);
      color:var(--tx-2); padding:2px 7px;
      background:var(--bg-2); border:1px solid var(--bd-1); border-radius:5px;
    }

    .header-status {
      display:flex; align-items:center; gap:8px;
      font-size:12px; color:var(--tx-1);
      padding:6px 10px; border-radius:var(--r-sm);
      background:var(--bg-2); border:1px solid var(--bd-1);
    }
    .header-status .dot {
      width:6px; height:6px; border-radius:50%;
      background:var(--tx-3);
      transition:background var(--t), box-shadow var(--t);
    }
    .header-status .dot.ok { background:var(--ok); box-shadow:0 0 0 3px var(--ok-soft); }
    .header-status .dot.err { background:var(--err); box-shadow:0 0 0 3px var(--err-soft); }
    .header-status .lbl { font-family:var(--font-mono); font-size:11px; color:var(--tx-2); }

    .header-spacer { flex:1; }

    .header-right { display:flex; align-items:center; gap:10px; }

    /* ── Theme toggle ── */
    .icon-btn {
      width:32px; height:32px;
      display:inline-flex; align-items:center; justify-content:center;
      border-radius:var(--r-sm);
      background:transparent; border:1px solid transparent;
      color:var(--tx-1);
      transition:background var(--t), color var(--t), border-color var(--t);
    }
    .icon-btn:hover { background:var(--bg-2); color:var(--tx-0); border-color:var(--bd-1); }
    .icon-btn svg { width:16px; height:16px; }
    :root[data-theme="dark"] .theme-sun { display:none; }
    :root[data-theme="light"] .theme-moon { display:none; }

    /* ── API key input ── */
    .key {
      display:flex; align-items:center; gap:8px;
      background:var(--bg-2); border:1px solid var(--bd-1);
      border-radius:var(--r-sm);
      padding:0 10px; height:32px;
      transition:border-color var(--t);
    }
    .key:focus-within { border-color:var(--ac); }
    .key svg { width:14px; height:14px; color:var(--tx-2); flex-shrink:0; }
    .key input {
      background:none; border:none; outline:none;
      color:var(--tx-0); font-family:var(--font-mono);
      font-size:12px; width:160px;
    }
    .key input::placeholder { color:var(--tx-3); }

    /* ── Sidebar nav ── */
    .nav-group-label {
      font-size:10px; font-weight:600;
      text-transform:uppercase; letter-spacing:.6px;
      color:var(--tx-3);
      padding:14px 12px 6px 12px;
    }
    .nav-item {
      display:flex; align-items:center; gap:10px;
      padding:7px 12px; border-radius:var(--r-sm);
      font-size:13px; font-weight:500;
      color:var(--tx-1);
      background:transparent; border:none;
      width:100%; text-align:left;
      transition:background var(--t), color var(--t);
    }
    .nav-item svg { width:14px; height:14px; color:var(--tx-2); transition:color var(--t); flex-shrink:0; }
    .nav-item:hover { background:var(--bg-2); color:var(--tx-0); }
    .nav-item:hover svg { color:var(--tx-1); }
    .nav-item.active {
      background:var(--ac-soft); color:var(--ac);
      border:1px solid var(--ac-border);
      padding:6px 11px;
    }
    .nav-item.active svg { color:var(--ac); }
    .nav-item .badge {
      margin-left:auto;
      font-size:10px; font-family:var(--font-mono);
      padding:1px 6px; border-radius:4px;
      background:var(--bg-3); color:var(--tx-2);
    }
    .nav-item.active .badge { background:var(--ac-soft); color:var(--ac); }

    .nav-sub {
      padding-left:24px;
      display:none;
      margin-top:2px;
    }
    .nav-sub.show { display:block; }
    .nav-sub .nav-item { font-size:12.5px; }

    /* ── View panels ── */
    .view { display:none; height:100%; }
    .view.active { display:flex; flex-direction:column; }

    /* ── Split pane (playground) ── */
    .split {
      display:grid; grid-template-columns:1fr 1fr;
      height:100%;
    }
    .pane {
      display:flex; flex-direction:column;
      overflow:hidden;
      min-width:0;
    }
    .pane + .pane { border-left:1px solid var(--bd-1); }
    .pane-head {
      display:flex; align-items:center; gap:10px;
      padding:14px 20px;
      min-height:52px;
      border-bottom:1px solid var(--bd-2);
      flex-shrink:0;
    }
    .pane-head-title { font-size:13px; font-weight:500; color:var(--tx-1); }
    .pane-head-right { margin-left:auto; display:flex; align-items:center; gap:8px; }
    .pane-body {
      flex:1; overflow-y:auto;
      padding:16px 20px;
      display:flex; flex-direction:column;
      min-height:0;
    }

    /* ── Method badge ── */
    .mb {
      display:inline-flex; align-items:center;
      padding:3px 7px; border-radius:4px;
      font-size:10.5px; font-weight:700;
      font-family:var(--font-mono); letter-spacing:.5px;
    }
    .mb-get { color:var(--ok); background:var(--ok-soft); }
    .mb-post { color:var(--ac); background:var(--ac-soft); }
    .mb-ws { color:var(--warn); background:var(--warn-soft); }
    .endpoint {
      font-family:var(--font-mono); font-size:13px;
      color:var(--tx-1);
    }

    /* ── Field label ── */
    .lbl {
      font-size:10.5px; font-weight:600;
      text-transform:uppercase; letter-spacing:.6px;
      color:var(--tx-2);
      margin-bottom:6px;
    }
    .field-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
    .field-row .field-name {
      font-size:12px; font-family:var(--font-mono);
      color:var(--tx-2); min-width:96px;
    }

    /* ── Inputs ── */
    input[type=text], input[type=password], input[type=search] {
      flex:1;
      background:var(--bg-0); border:1px solid var(--bd-1);
      border-radius:var(--r-sm);
      color:var(--tx-0);
      padding:7px 10px;
      font-size:12.5px; font-family:var(--font-mono);
      transition:border-color var(--t), background var(--t);
      outline:none;
    }
    input[type=text]:focus { border-color:var(--ac); background:var(--bg-1); }
    input[type=text]::placeholder { color:var(--tx-3); }

    /* ── Code editor (textarea) ── */
    .editor-wrap {
      position:relative; flex:1;
      display:flex; flex-direction:column;
      min-height:200px;
      background:var(--bg-0); border:1px solid var(--bd-1);
      border-radius:var(--r-sm);
      overflow:hidden;
      transition:border-color var(--t);
    }
    .editor-wrap:focus-within { border-color:var(--ac); }
    .editor-wrap.error { border-color:var(--err); }
    .editor {
      flex:1;
      background:transparent; border:none; outline:none; resize:none;
      color:var(--tx-0);
      padding:14px 16px 14px 50px;
      font-size:13px; line-height:1.65;
      font-family:var(--font-mono);
      tab-size:2;
      width:100%;
    }
    .editor::placeholder { color:var(--tx-3); }
    .editor-line-numbers {
      position:absolute; left:0; top:0; bottom:0; width:38px;
      padding:14px 0;
      font-family:var(--font-mono);
      font-size:13px; line-height:1.65;
      color:var(--tx-3);
      text-align:right;
      pointer-events:none;
      border-right:1px solid var(--bd-2);
      user-select:none;
      overflow:hidden;
    }
    .editor-line-numbers div { padding:0 8px 0 0; }
    .editor-err-msg {
      padding:6px 12px;
      background:var(--err-soft);
      color:var(--err);
      font-size:11.5px; font-family:var(--font-mono);
      border-top:1px solid var(--err-border);
      display:none;
    }
    .editor-wrap.error .editor-err-msg { display:block; }

    /* ── Buttons ── */
    .actions { display:flex; gap:8px; margin-top:12px; flex-shrink:0; }
    .btn {
      display:inline-flex; align-items:center; justify-content:center; gap:6px;
      height:34px; padding:0 14px;
      border:1px solid transparent; border-radius:var(--r-sm);
      font-size:13px; font-weight:500;
      transition:background var(--t), border-color var(--t), color var(--t), opacity var(--t);
    }
    .btn:disabled { opacity:.45; cursor:not-allowed; }
    .btn svg { width:14px; height:14px; }
    .btn-primary {
      background:var(--ac-strong); color:#fff;
      box-shadow:0 1px 0 rgba(255,255,255,.1) inset, 0 1px 2px rgba(0,0,0,.2);
    }
    .btn-primary:hover:not(:disabled) { background:var(--ac); }
    .btn-ghost {
      background:transparent; color:var(--tx-1); border-color:var(--bd-1);
    }
    .btn-ghost:hover:not(:disabled) { background:var(--bg-2); color:var(--tx-0); border-color:var(--bd-1); }
    .btn-sm { height:28px; padding:0 10px; font-size:12px; }
    .btn-kbd {
      margin-left:auto;
      font-family:var(--font-mono); font-size:11px;
      color:var(--tx-3);
      padding:2px 6px; border-radius:4px;
      background:rgba(255,255,255,.06);
    }
    :root[data-theme="light"] .btn-kbd { background:rgba(0,0,0,.04); }

    /* ── Response area ── */
    .resp-meta { display:flex; align-items:center; gap:10px; }
    .pill {
      display:inline-flex; align-items:center;
      padding:3px 8px; border-radius:4px;
      font-size:11.5px; font-weight:600;
      font-family:var(--font-mono);
    }
    .pill-ok { color:var(--ok); background:var(--ok-soft); }
    .pill-err { color:var(--err); background:var(--err-soft); }
    .pill-pending { color:var(--warn); background:var(--warn-soft); }
    .pill-cancelled { color:var(--tx-2); background:var(--bg-3); }
    .pill-dur { color:var(--tx-2); font-size:11.5px; font-family:var(--font-mono); }

    .seg {
      display:inline-flex; gap:1px;
      background:var(--bg-2);
      border:1px solid var(--bd-1);
      border-radius:5px; padding:2px;
    }
    .seg button {
      padding:3px 9px; border-radius:3px;
      font-size:11.5px; font-weight:500;
      color:var(--tx-2);
      background:transparent; border:none;
      transition:background var(--t), color var(--t);
    }
    .seg button:hover { color:var(--tx-1); }
    .seg button.active { color:var(--tx-0); background:var(--bg-1); box-shadow:0 1px 1px rgba(0,0,0,.1); }

    /* ── Code output / JSON view ── */
    .code-block {
      flex:1; overflow:auto;
      background:var(--bg-0); border:1px solid var(--bd-2);
      border-radius:var(--r-sm);
      margin-top:12px;
      position:relative;
    }
    .code-block.empty {
      display:flex; align-items:center; justify-content:center;
      color:var(--tx-3); font-size:13px;
      min-height:160px;
    }
    .json-view {
      display:grid; grid-template-columns:38px 1fr;
      font-family:var(--font-mono); font-size:13px;
      line-height:1.65;
      min-height:0;
    }
    .json-gutter {
      padding:14px 0;
      text-align:right;
      color:var(--tx-3);
      user-select:none;
      border-right:1px solid var(--bd-2);
      background:var(--bg-1);
    }
    .json-gutter div { padding:0 8px 0 0; }
    .json-body {
      padding:14px 16px;
      white-space:pre-wrap; word-break:break-word;
      overflow:auto;
    }
    .json-body .ln { position:relative; min-height:1.65em; }
    .json-body .ind { display:inline-block; color:var(--indent-guide); }
    .json-body .ind::before {
      content:''; display:inline-block;
      width:1ch; border-left:1px solid var(--indent-guide);
      margin-right:-1ch;
    }
    .jk { color:var(--json-key); }
    .js { color:var(--json-string); }
    .jn { color:var(--json-number); }
    .jb { color:var(--json-bool); }
    .jl { color:var(--json-null); }
    .jp { color:var(--json-punct); }

    .copy-btn {
      position:absolute; top:10px; right:14px;
      padding:5px 10px; border-radius:5px;
      font-size:11px; font-family:var(--font-sans);
      color:var(--tx-1); background:var(--bg-1); border:1px solid var(--bd-1);
      display:inline-flex; align-items:center; gap:5px;
      opacity:0; transition:opacity var(--t), background var(--t);
      z-index:2;
    }
    .code-block:hover .copy-btn { opacity:1; }
    .copy-btn:hover { background:var(--bg-2); color:var(--tx-0); }
    .copy-btn svg { width:11px; height:11px; }
    .copy-btn.ok { color:var(--ok); border-color:var(--ok-border); background:var(--ok-soft); opacity:1; }

    /* ── Stream area ── */
    .stream-area {
      flex:1; overflow:auto;
      background:var(--bg-0); border:1px solid var(--bd-2);
      border-radius:var(--r-sm);
      padding:14px 16px;
      font-family:var(--font-mono);
      font-size:13px; line-height:1.65;
      white-space:pre-wrap; word-break:break-word;
      margin-top:12px;
      color:var(--tx-0);
    }
    .cursor {
      display:inline-block; width:2px; height:14px;
      background:var(--ac);
      animation:blink 1s step-end infinite;
      vertical-align:text-bottom;
      margin-left:1px; border-radius:1px;
    }
    @keyframes blink { 50% { opacity:0; } }

    .tool {
      border-left:2px solid var(--warn);
      margin:8px 0; padding:8px 12px;
      background:var(--bg-1);
      border-radius:0 var(--r-sm) var(--r-sm) 0;
    }
    .tool-head {
      font-weight:600; font-size:12px; color:var(--warn);
      display:flex; align-items:center; gap:6px;
      user-select:none;
    }
    .tool-head svg { transition:transform var(--t); }
    .tool.open .tool-head svg { transform:rotate(90deg); }
    .tool-body { display:none; margin-top:6px; font-size:12px; color:var(--tx-1); }
    .tool.open .tool-body { display:block; }
    .tool.ok { border-left-color:var(--ok); }
    .tool.ok .tool-head { color:var(--ok); }
    .tool.err { border-left-color:var(--err); }
    .tool.err .tool-head { color:var(--err); }

    .summary {
      display:flex; gap:20px; flex-wrap:wrap;
      padding:12px 16px;
      background:var(--bg-1); border:1px solid var(--bd-1);
      border-radius:var(--r-sm);
      font-size:12px; color:var(--tx-1);
      margin-top:10px; flex-shrink:0;
    }
    .summary span { font-family:var(--font-mono); }
    .summary .sl { color:var(--tx-2); margin-right:6px; font-family:var(--font-sans); }

    /* ── Section toggle (collapsible) ── */
    .sec-toggle {
      display:flex; align-items:center; gap:6px;
      font-size:10.5px; font-weight:600;
      text-transform:uppercase; letter-spacing:.6px;
      color:var(--tx-2);
      padding:6px 0;
      background:none; border:none;
      user-select:none;
    }
    .sec-toggle:hover { color:var(--tx-1); }
    .sec-toggle svg { transition:transform var(--t); }
    .sec-toggle.open svg { transform:rotate(90deg); }
    .collapsible { display:none; margin-bottom:10px; padding-bottom:2px; }
    .collapsible.open { display:block; }

    /* ── Dashboard ── */
    .dash-scroll {
      width:100%; height:100%; overflow:auto;
      padding:28px 32px;
    }
    .dash-inner { max-width:1100px; margin:0 auto; }
    .dash-h {
      display:flex; align-items:baseline; justify-content:space-between;
      margin-bottom:24px;
    }
    .dash-title { font-size:22px; font-weight:600; letter-spacing:-.4px; color:var(--tx-0); }
    .dash-sub { font-size:12.5px; color:var(--tx-2); margin-top:3px; }

    .section-h {
      display:flex; align-items:baseline; justify-content:space-between;
      margin:32px 0 12px;
    }
    .section-h .t { font-size:13px; font-weight:600; color:var(--tx-1); text-transform:uppercase; letter-spacing:.5px; }
    .section-h .sub { font-size:11.5px; color:var(--tx-3); font-family:var(--font-mono); }

    .stat-grid {
      display:grid;
      grid-template-columns:repeat(4, 1fr);
      gap:12px;
    }
    @media (max-width:980px) { .stat-grid { grid-template-columns:repeat(2, 1fr); } }
    .stat {
      background:var(--bg-1); border:1px solid var(--bd-1);
      border-radius:var(--r);
      padding:16px 18px;
      box-shadow:var(--shadow-card);
      transition:border-color var(--t);
    }
    .stat .lbl-row { display:flex; align-items:center; gap:8px; }
    .stat .stat-lbl {
      font-size:11px; font-weight:500;
      text-transform:uppercase; letter-spacing:.5px;
      color:var(--tx-2);
    }
    .stat .stat-val {
      font-size:24px; font-weight:600;
      font-family:var(--font-mono);
      color:var(--tx-0);
      margin-top:6px;
      letter-spacing:-.3px;
    }
    .stat .stat-foot {
      font-size:11.5px; color:var(--tx-2);
      margin-top:4px; font-family:var(--font-mono);
    }
    .stat .stat-val.ok { color:var(--ok); }
    .stat .stat-val.err { color:var(--err); }
    .stat .stat-val.warn { color:var(--warn); }

    .two-col {
      display:grid;
      grid-template-columns:1.4fr 1fr;
      gap:14px;
    }
    @media (max-width:980px) { .two-col { grid-template-columns:1fr; } }

    .card {
      background:var(--bg-1); border:1px solid var(--bd-1);
      border-radius:var(--r);
      box-shadow:var(--shadow-card);
      overflow:hidden;
    }
    .card-head {
      padding:14px 18px;
      border-bottom:1px solid var(--bd-2);
      display:flex; align-items:center; justify-content:space-between;
    }
    .card-h { font-size:13px; font-weight:600; color:var(--tx-0); }
    .card-sub { font-size:11.5px; color:var(--tx-3); font-family:var(--font-mono); }
    .card-body { padding:8px 0; }
    .card-body-padded { padding:14px 18px; }

    .runs-table {
      width:100%; border-collapse:collapse;
      font-size:12.5px;
    }
    .runs-table th, .runs-table td {
      padding:9px 18px;
      text-align:left;
      border-bottom:1px solid var(--bd-2);
      font-family:var(--font-mono);
      color:var(--tx-1);
    }
    .runs-table tr:last-child td { border-bottom:none; }
    .runs-table th {
      font-size:10.5px; font-weight:600;
      text-transform:uppercase; letter-spacing:.5px;
      color:var(--tx-3);
      font-family:var(--font-sans);
      background:var(--bg-2);
    }
    .runs-table td.right { text-align:right; }
    .runs-table .ep {
      display:inline-block;
      padding:1px 7px; border-radius:4px;
      font-size:10.5px; font-weight:700;
      letter-spacing:.4px;
    }
    .runs-table .ep-run { color:var(--ac); background:var(--ac-soft); }
    .runs-table .ep-stream { color:var(--warn); background:var(--warn-soft); }
    .runs-table .ep-chat { color:var(--ok); background:var(--ok-soft); }
    .runs-table .ep-ws { color:#a78bfa; background:rgba(167,139,250,.12); }
    .runs-table .st-ok { color:var(--ok); }
    .runs-table .st-err { color:var(--err); }

    .empty-card {
      padding:32px 18px;
      text-align:center;
      color:var(--tx-3);
      font-size:13px;
    }

    .tool-list { padding:6px 0; }
    .tool-row {
      display:flex; align-items:center; gap:10px;
      padding:8px 18px;
      font-size:12.5px;
    }
    .tool-row .nm { color:var(--tx-0); font-family:var(--font-mono); flex-shrink:0; min-width:80px; }
    .tool-row .bar {
      flex:1; height:6px;
      background:var(--bg-2); border-radius:3px; overflow:hidden;
    }
    .tool-row .bar .fill {
      height:100%; background:var(--ac);
      border-radius:3px;
    }
    .tool-row .ct {
      font-family:var(--font-mono); font-size:12px;
      color:var(--tx-2); min-width:30px; text-align:right;
    }

    .meta-list { padding:10px 0; }
    .meta-row {
      display:flex; align-items:center; justify-content:space-between;
      padding:8px 18px;
      font-size:12.5px;
    }
    .meta-row .k { color:var(--tx-2); }
    .meta-row .v { color:var(--tx-0); font-family:var(--font-mono); }
    .meta-row .v.ok { color:var(--ok); }
    .meta-row .v.err { color:var(--err); }
    .meta-row .v.warn { color:var(--warn); }

    .queue-bar-row { padding:10px 18px; }
    .queue-bar-row .qhead {
      display:flex; align-items:center; justify-content:space-between;
      font-size:12px;
    }
    .queue-bar-row .qhead .k { color:var(--tx-2); }
    .queue-bar-row .qhead .v { color:var(--tx-0); font-family:var(--font-mono); font-size:11.5px; }
    .queue-bar-row .qbar {
      height:5px; background:var(--bg-2); border-radius:3px;
      margin-top:6px; overflow:hidden;
    }
    .queue-bar-row .qbar .qfill {
      height:100%; background:var(--ac); border-radius:3px;
      transition:width var(--t);
    }
    .queue-bar-row .qbar .qfill.warn { background:var(--warn); }
    .queue-bar-row .qbar .qfill.crit { background:var(--err); }

    /* ── Toast ── */
    .toast-anchor { position:fixed; bottom:24px; right:24px; z-index:50; pointer-events:none; }
    .toast {
      background:var(--bg-1); border:1px solid var(--bd-1);
      box-shadow:0 8px 24px rgba(0,0,0,.18), var(--shadow-card);
      border-radius:var(--r);
      padding:10px 14px;
      font-size:12.5px; color:var(--tx-0);
      display:flex; align-items:center; gap:8px;
      animation:toast-in .18s ease;
      pointer-events:auto;
    }
    @keyframes toast-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }

    /* ── WebSocket ── */
    .ws-controls { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
    .ws-dot {
      width:8px; height:8px; border-radius:50%;
      background:var(--tx-3);
      transition:background var(--t), box-shadow var(--t);
    }
    .ws-dot.connected { background:var(--ok); box-shadow:0 0 0 3px var(--ok-soft); }
    .ws-dot.connecting { background:var(--warn); box-shadow:0 0 0 3px var(--warn-soft); }
    .ws-label { font-size:12px; color:var(--tx-2); font-family:var(--font-mono); }
    .ws-log {
      flex:1; overflow:auto;
      background:var(--bg-0); border:1px solid var(--bd-2);
      border-radius:var(--r-sm);
      padding:12px 14px;
      font-family:var(--font-mono); font-size:12px; line-height:1.65;
    }
    .ws-msg { margin-bottom:2px; }
    .ws-msg.sent { color:var(--ac); }
    .ws-msg.received { color:var(--ok); }
    .ws-msg.system { color:var(--tx-2); }
    .ws-msg .pf {
      display:inline-block; width:16px; text-align:center;
      margin-right:6px; opacity:.6;
    }

    /* ── Utilities ── */
    .hidden { display:none !important; }
    .gap-8 { gap:8px; }
    .mt-12 { margin-top:12px; }

    /* ── Responsive ── */
    @media (max-width:760px) {
      .app { grid-template-columns:0 1fr; }
      .sidebar { display:none; }
      .brand { min-width:auto; }
      .key input { width:120px; }
    }
  `;
}

function shell(version: string): string {
  const otterMark = `
    <svg viewBox="0 0 32 32" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="32" height="32" rx="8" fill="url(#og)"/>
      <circle cx="11" cy="14" r="3.2" fill="#fff"/>
      <circle cx="21" cy="14" r="3.2" fill="#fff"/>
      <circle cx="11" cy="14.5" r="1.2" fill="#0a0a0c"/>
      <circle cx="21" cy="14.5" r="1.2" fill="#0a0a0c"/>
      <ellipse cx="16" cy="21" rx="3.2" ry="1.6" fill="#fff" opacity=".95"/>
      <defs>
        <linearGradient id="og" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#6366f1"/>
          <stop offset="1" stop-color="#8b5cf6"/>
        </linearGradient>
      </defs>
    </svg>
  `;

  const iconHome = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5L8 2l5.5 4.5V13a1 1 0 01-1 1H3.5a1 1 0 01-1-1V6.5z"/><path d="M6.5 14V9h3v5"/></svg>`;
  const iconPlay = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="4,3 13,8 4,13" fill="currentColor" stroke="none"/></svg>`;
  const iconBolt = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 2 3 9 8 9 7 14 13 7 8 7 9 2"/></svg>`;
  const iconChat = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9.5A1.5 1.5 0 0 1 12.5 11H6l-4 3V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z"/></svg>`;
  const iconSocket = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h3"/><path d="M11 8h3"/><circle cx="8" cy="8" r="3"/></svg>`;
  const iconStatus = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h2.5l1.5-4 3 8 1.5-4H14"/></svg>`;
  const iconDocs = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5A.5.5 0 0 1 3.5 2h6L13 5.5V13.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5z"/><path d="M9 2v3.5h4"/></svg>`;
  const iconKey = `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="10" height="6" rx="1.5"/><path d="M5 6V4a2 2 0 0 1 4 0v2"/></svg>`;
  const iconSun = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>`;
  const iconMoon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/></svg>`;
  const iconSend = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="14" y1="2" x2="7" y2="9"/><polygon points="14 2 9 14 7 9 2 7 14 2"/></svg>`;
  const iconCopy = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.2"/><path d="M3 7H2.5A.5.5 0 0 1 2 6.5V2.5A.5.5 0 0 1 2.5 2h4a.5.5 0 0 1 .5.5V3"/></svg>`;
  const iconChev = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3L7.5 6L4.5 9"/></svg>`;

  return `
  <div class="app">
    <header class="header">
      <div class="brand">
        <div class="brand-mark">${otterMark}</div>
        <div class="brand-name">otterly</div>
        <div class="brand-version">v${version}</div>
      </div>
      <div class="header-status" id="header-status" title="Server status">
        <div class="dot" id="h-dot"></div>
        <span class="lbl" id="h-lbl">checking…</span>
      </div>
      <div class="header-spacer"></div>
      <div class="header-right">
        <div class="key">
          ${iconKey}
          <input type="password" id="api-key" placeholder="Bearer token" autocomplete="off" spellcheck="false">
        </div>
        <button class="icon-btn" id="theme-toggle" title="Toggle theme">
          <span class="theme-moon">${iconMoon}</span>
          <span class="theme-sun">${iconSun}</span>
        </button>
      </div>
    </header>

    <aside class="sidebar">
      <div class="nav-group-label">Overview</div>
      <button class="nav-item" data-view="dashboard">${iconHome}<span>Dashboard</span></button>

      <div class="nav-group-label">Playground</div>
      <button class="nav-item" data-view="run">${iconPlay}<span>Run</span><span class="badge">POST</span></button>
      <button class="nav-item" data-view="stream">${iconBolt}<span>Stream</span><span class="badge">POST</span></button>
      <button class="nav-item" data-view="chat">${iconChat}<span>Chat</span><span class="badge">POST</span></button>
      <button class="nav-item" data-view="ws">${iconSocket}<span>WebSocket</span><span class="badge">WS</span></button>

      <div class="nav-group-label">Reference</div>
      <button class="nav-item" data-view="status">${iconStatus}<span>Status</span></button>
      <a class="nav-item" href="/swagger.json" target="_blank" rel="noopener">${iconDocs}<span>Swagger</span></a>
    </aside>

    <main class="main">
      <!-- DASHBOARD -->
      <div class="view" id="view-dashboard">
        <div class="dash-scroll">
          <div class="dash-inner">
            <div class="dash-h">
              <div>
                <div class="dash-title">Dashboard</div>
                <div class="dash-sub">Local inference at <span style="font-family:var(--font-mono);color:var(--tx-1)">localhost</span></div>
              </div>
              <div class="dash-sub" id="dash-uptime"></div>
            </div>

            <div class="section-h"><div class="t">Today</div><div class="sub" id="dash-today-sub"></div></div>
            <div class="stat-grid" id="stats-today"></div>

            <div class="section-h"><div class="t">All time</div><div class="sub" id="dash-totals-sub"></div></div>
            <div class="stat-grid" id="stats-totals"></div>

            <div class="section-h" style="margin-top:32px"><div class="t">Recent runs</div><div class="sub">latest 25</div></div>
            <div class="card">
              <div class="card-body" id="recent-runs">
                <div class="empty-card">No requests yet. Send one from Run, Stream, or Chat.</div>
              </div>
            </div>

            <div class="two-col" style="margin-top:18px;margin-bottom:32px">
              <div class="card">
                <div class="card-head"><div class="card-h">Top tools</div><div class="card-sub">cumulative</div></div>
                <div class="tool-list" id="top-tools">
                  <div class="empty-card">No tool calls yet.</div>
                </div>
              </div>
              <div class="card">
                <div class="card-head"><div class="card-h">Server</div></div>
                <div class="meta-list" id="server-meta"></div>
                <div class="queue-bar-row" id="qbar-active"></div>
                <div class="queue-bar-row" id="qbar-queued"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- STATUS (compact, raw view) -->
      <div class="view" id="view-status">
        <div class="dash-scroll">
          <div class="dash-inner" style="max-width:680px">
            <div class="dash-h">
              <div>
                <div class="dash-title">Status</div>
                <div class="dash-sub">/api/status, auto-refreshing every 5s</div>
              </div>
            </div>
            <div class="card">
              <div class="card-body" id="status-block">
                <div class="empty-card">Loading…</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- RUN -->
      <div class="view" id="view-run">
        ${playgroundPane('run', 'POST', '/api/run')}
      </div>

      <!-- STREAM -->
      <div class="view" id="view-stream">
        ${playgroundPaneStream('stream', 'POST', '/api/stream')}
      </div>

      <!-- CHAT -->
      <div class="view" id="view-chat">
        ${playgroundPaneChat('chat', 'POST', '/v1/chat/completions')}
      </div>

      <!-- WEBSOCKET -->
      <div class="view" id="view-ws">
        ${playgroundPaneWs()}
      </div>
    </main>
  </div>

  <div class="toast-anchor" id="toast-anchor"></div>
  `;
}

function playgroundPane(tab: string, method: string, endpoint: string): string {
  const m = method.toLowerCase();
  return `
  <div class="split">
    <div class="pane">
      <div class="pane-head">
        <span class="mb mb-${m}">${method}</span>
        <span class="endpoint">${endpoint}</span>
      </div>
      <div class="pane-body">
        <button class="sec-toggle" type="button">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3L7.5 6L4.5 9"/></svg>
          Headers
        </button>
        <div class="collapsible">
          <div class="field-row">
            <span class="field-name">X-Session-Id</span>
            <input type="text" id="sid-${tab}" placeholder="auto from response" spellcheck="false">
          </div>
        </div>
        <div class="lbl" style="margin-top:6px">Request body</div>
        <div class="editor-wrap" id="ew-${tab}">
          <div class="editor-line-numbers" id="ln-${tab}"></div>
          <textarea class="editor" id="body-${tab}" spellcheck="false" wrap="off"></textarea>
          <div class="editor-err-msg" id="em-${tab}"></div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" id="send-${tab}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="14" y1="2" x2="7" y2="9"/><polygon points="14 2 9 14 7 9 2 7 14 2"/></svg>
            Send
          </button>
          <button class="btn btn-ghost btn-cancel" data-tab="${tab}">Cancel</button>
          <span class="btn-kbd">⌘ ⏎</span>
        </div>
      </div>
    </div>
    <div class="pane">
      <div class="pane-head">
        <span class="pane-head-title">Response</span>
        <div class="pane-head-right">
          <div id="rm-${tab}" class="resp-meta"></div>
          <div class="seg">
            <button class="active" data-mode="formatted" data-tab="${tab}">Formatted</button>
            <button data-mode="raw" data-tab="${tab}">Raw</button>
          </div>
        </div>
      </div>
      <div class="pane-body">
        <div id="resp-empty-${tab}" class="code-block empty">Send a request to see the response.</div>
        <div id="resp-fmt-${tab}" class="code-block hidden response-formatted">
          <button class="copy-btn" data-copy="resp-fmt-${tab}">${'<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.2"/><path d="M3 7H2.5A.5.5 0 0 1 2 6.5V2.5A.5.5 0 0 1 2.5 2h4a.5.5 0 0 1 .5.5V3"/></svg>'} Copy</button>
          <div class="json-view"><div class="json-gutter" id="gut-fmt-${tab}"></div><div class="json-body" id="body-fmt-${tab}"></div></div>
        </div>
        <pre id="resp-raw-${tab}" class="code-block hidden response-raw" style="padding:14px 16px; font-family:var(--font-mono); font-size:13px; line-height:1.65;"></pre>
      </div>
    </div>
  </div>
  `;
}

function playgroundPaneStream(tab: string, method: string, endpoint: string): string {
  const m = method.toLowerCase();
  return `
  <div class="split">
    <div class="pane">
      <div class="pane-head">
        <span class="mb mb-${m}">${method}</span>
        <span class="endpoint">${endpoint}</span>
      </div>
      <div class="pane-body">
        <button class="sec-toggle" type="button">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3L7.5 6L4.5 9"/></svg>
          Headers
        </button>
        <div class="collapsible">
          <div class="field-row">
            <span class="field-name">X-Session-Id</span>
            <input type="text" id="sid-${tab}" placeholder="auto from response" spellcheck="false">
          </div>
        </div>
        <div class="lbl" style="margin-top:6px">Request body</div>
        <div class="editor-wrap" id="ew-${tab}">
          <div class="editor-line-numbers" id="ln-${tab}"></div>
          <textarea class="editor" id="body-${tab}" spellcheck="false" wrap="off"></textarea>
          <div class="editor-err-msg" id="em-${tab}"></div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" id="send-${tab}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="14" y1="2" x2="7" y2="9"/><polygon points="14 2 9 14 7 9 2 7 14 2"/></svg>
            Send
          </button>
          <button class="btn btn-ghost btn-cancel" data-tab="${tab}">Cancel</button>
          <button class="btn btn-ghost btn-sm" id="stream-raw-toggle">Raw</button>
        </div>
      </div>
    </div>
    <div class="pane">
      <div class="pane-head">
        <span class="pane-head-title">Stream</span>
        <div class="pane-head-right">
          <div id="rm-${tab}" class="resp-meta"></div>
        </div>
      </div>
      <div class="pane-body">
        <div id="resp-empty-${tab}" class="code-block empty">Send a request to start streaming.</div>
        <div class="stream-area hidden" id="stream-output">
          <div id="stream-text"></div>
          <pre id="stream-raw" class="hidden" style="margin:0;padding:0;font-family:inherit;font-size:inherit;line-height:inherit"></pre>
        </div>
        <div class="summary hidden" id="stream-summary"></div>
      </div>
    </div>
  </div>
  `;
}

function playgroundPaneChat(tab: string, method: string, endpoint: string): string {
  const m = method.toLowerCase();
  return `
  <div class="split">
    <div class="pane">
      <div class="pane-head">
        <span class="mb mb-${m}">${method}</span>
        <span class="endpoint">${endpoint}</span>
      </div>
      <div class="pane-body">
        <button class="sec-toggle" type="button">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3L7.5 6L4.5 9"/></svg>
          Headers
        </button>
        <div class="collapsible">
          <div class="field-row">
            <span class="field-name">X-Session-Id</span>
            <input type="text" id="sid-${tab}" placeholder="auto from response" spellcheck="false">
          </div>
        </div>
        <div class="lbl" style="margin-top:6px">Request body</div>
        <div class="editor-wrap" id="ew-${tab}">
          <div class="editor-line-numbers" id="ln-${tab}"></div>
          <textarea class="editor" id="body-${tab}" spellcheck="false" wrap="off"></textarea>
          <div class="editor-err-msg" id="em-${tab}"></div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" id="send-${tab}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="14" y1="2" x2="7" y2="9"/><polygon points="14 2 9 14 7 9 2 7 14 2"/></svg>
            Send
          </button>
          <button class="btn btn-ghost btn-cancel" data-tab="${tab}">Cancel</button>
          <span class="btn-kbd">⌘ ⏎</span>
        </div>
      </div>
    </div>
    <div class="pane">
      <div class="pane-head">
        <span class="pane-head-title">Response</span>
        <div class="pane-head-right">
          <div id="rm-${tab}" class="resp-meta"></div>
          <div class="seg">
            <button class="active" data-mode="formatted" data-tab="${tab}">Formatted</button>
            <button data-mode="raw" data-tab="${tab}">Raw</button>
          </div>
        </div>
      </div>
      <div class="pane-body">
        <div id="chat-response-standard">
          <div id="resp-empty-${tab}" class="code-block empty">Send a request to see the response.</div>
          <div id="resp-fmt-${tab}" class="code-block hidden response-formatted">
            <button class="copy-btn" data-copy="resp-fmt-${tab}">${'<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.2"/><path d="M3 7H2.5A.5.5 0 0 1 2 6.5V2.5A.5.5 0 0 1 2.5 2h4a.5.5 0 0 1 .5.5V3"/></svg>'} Copy</button>
            <div class="json-view"><div class="json-gutter" id="gut-fmt-${tab}"></div><div class="json-body" id="body-fmt-${tab}"></div></div>
          </div>
          <pre id="resp-raw-${tab}" class="code-block hidden response-raw" style="padding:14px 16px; font-family:var(--font-mono); font-size:13px; line-height:1.65;"></pre>
        </div>
        <div class="stream-area hidden" id="chat-stream-output">
          <div id="chat-stream-text"></div>
        </div>
        <div class="summary hidden" id="chat-stream-summary"></div>
      </div>
    </div>
  </div>
  `;
}

function playgroundPaneWs(): string {
  return `
  <div class="split">
    <div class="pane">
      <div class="pane-head">
        <span class="mb mb-ws">WS</span>
        <span class="endpoint">/ws</span>
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
        <div class="lbl mt-12">Message</div>
        <div class="editor-wrap">
          <textarea class="editor" id="ws-input" spellcheck="false" wrap="off" style="padding-left:14px"></textarea>
        </div>
        <div class="actions">
          <button class="btn btn-primary" id="ws-send" disabled>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="14" y1="2" x2="7" y2="9"/><polygon points="14 2 9 14 7 9 2 7 14 2"/></svg>
            Send
          </button>
        </div>
      </div>
    </div>
    <div class="pane">
      <div class="pane-head">
        <span class="pane-head-title">Messages</span>
      </div>
      <div class="pane-body">
        <div class="ws-log" id="ws-log" style="flex:1"></div>
      </div>
    </div>
  </div>
  `;
}

function client(port: number): string {
  // Heads up to future-you: every backslash inside this template literal that's
  // meant to end up in the page's JS must be doubled.
  return `
(function() {
  var PORT = ${port};
  var BASE = location.origin;
  var WS_BASE = BASE.replace(/^http/, 'ws');

  var ENDPOINTS = {
    run:    { method:'POST', path:'/api/run' },
    stream: { method:'POST', path:'/api/stream' },
    chat:   { method:'POST', path:'/v1/chat/completions' },
  };

  // ── State ──
  var urlTheme = new URLSearchParams(location.search).get('theme');
  var savedTheme = localStorage.getItem('otterly_theme');
  var defaultTheme = (urlTheme === 'light' || urlTheme === 'dark')
    ? urlTheme
    : (savedTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  var state = {
    view: 'dashboard',
    apiKey: localStorage.getItem('otterly_api_key') || '',
    theme: defaultTheme,
    ws: null,
    activeAbort: null,
    pollTimer: null,
    autoScroll: true,
  };

  var $  = function(s){ return document.querySelector(s); };
  var $$ = function(s){ return document.querySelectorAll(s); };

  var ROUTES = {
    '/playground': 'run',
    '/dashboard':  'dashboard',
  };
  var INITIAL_VIEW = ROUTES[location.pathname] || 'dashboard';

  document.documentElement.setAttribute('data-theme', state.theme);

  document.addEventListener('DOMContentLoaded', function() {
    // ── Header ──
    var key = $('#api-key');
    key.value = state.apiKey;
    key.addEventListener('input', function(e) {
      state.apiKey = e.target.value;
      localStorage.setItem('otterly_api_key', state.apiKey);
    });

    $('#theme-toggle').addEventListener('click', function() {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('otterly_theme', state.theme);
      document.documentElement.setAttribute('data-theme', state.theme);
    });

    // ── Nav ──
    $$('.nav-item[data-view]').forEach(function(btn) {
      btn.addEventListener('click', function() { switchView(btn.dataset.view); });
    });

    // ── Section toggles ──
    $$('.sec-toggle').forEach(function(h) {
      h.addEventListener('click', function() {
        h.classList.toggle('open');
        var nx = h.nextElementSibling;
        if (nx) nx.classList.toggle('open');
      });
    });

    // ── Editors with line numbers ──
    ['run','stream','chat'].forEach(function(tab) {
      var ta = $('#body-' + tab);
      var ln = $('#ln-' + tab);
      if (!ta || !ln) return;
      var update = function() { renderLineNumbers(ta, ln); validateJson(tab); };
      ta.addEventListener('input', update);
      ta.addEventListener('scroll', function() { ln.scrollTop = ta.scrollTop; });
      ta.addEventListener('keydown', function(e) {
        // Tab inserts two spaces
        if (e.key === 'Tab') {
          e.preventDefault();
          var start = ta.selectionStart, end = ta.selectionEnd;
          ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
          ta.selectionStart = ta.selectionEnd = start + 2;
          update();
        }
        // Cmd/Ctrl + Enter sends
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          var sendBtn = $('#send-' + tab);
          if (sendBtn && !sendBtn.disabled) sendBtn.click();
        }
      });
    });

    // ── Send buttons ──
    var runBtn = $('#send-run'); if (runBtn) runBtn.addEventListener('click', function() { sendOneshot('run'); });
    var chatBtn = $('#send-chat'); if (chatBtn) chatBtn.addEventListener('click', function() { sendChat(); });
    var streamBtn = $('#send-stream'); if (streamBtn) streamBtn.addEventListener('click', function() { sendStream(); });

    $$('.btn-cancel').forEach(function(btn) { btn.addEventListener('click', cancel); });

    // ── Formatted/Raw toggles ──
    $$('.seg button[data-mode]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var group = btn.parentElement;
        group.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
        var tab = btn.dataset.tab;
        var fmt = $('#resp-fmt-' + tab);
        var raw = $('#resp-raw-' + tab);
        if (!fmt || !raw) return;
        if (btn.dataset.mode === 'formatted') {
          fmt.classList.remove('hidden'); raw.classList.add('hidden');
        } else {
          raw.classList.remove('hidden'); fmt.classList.add('hidden');
        }
      });
    });

    // ── Copy buttons (delegated) ──
    document.addEventListener('click', function(e) {
      var btn = e.target.closest && e.target.closest('.copy-btn');
      if (!btn) return;
      var srcEl = document.getElementById(btn.dataset.copy);
      if (!srcEl) return;
      // Read the raw text from the matching raw element if present
      var tab = (btn.dataset.copy || '').replace('resp-fmt-','');
      var rawEl = document.getElementById('resp-raw-' + tab);
      var txt = rawEl && rawEl.textContent ? rawEl.textContent : srcEl.textContent;
      navigator.clipboard.writeText(txt).then(function() {
        btn.classList.add('ok');
        var orig = btn.innerHTML;
        btn.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5 6.5 5 9 9.5 3.5"/></svg> Copied';
        setTimeout(function() {
          btn.classList.remove('ok');
          btn.innerHTML = orig;
        }, 1400);
      });
    });

    // ── WebSocket ──
    var wsC = $('#ws-connect'); if (wsC) wsC.addEventListener('click', wsConnect);
    var wsD = $('#ws-disconnect'); if (wsD) wsD.addEventListener('click', wsDisconnect);
    var wsS = $('#ws-send'); if (wsS) wsS.addEventListener('click', wsSend);

    // ── Stream raw toggle ──
    var srt = $('#stream-raw-toggle');
    if (srt) srt.addEventListener('click', function() {
      var t = $('#stream-text'), r = $('#stream-raw');
      var showRaw = !t.classList.contains('hidden');
      t.classList.toggle('hidden', showRaw);
      r.classList.toggle('hidden', !showRaw);
      srt.textContent = showRaw ? 'Formatted' : 'Raw';
    });

    // ── Set initial editor templates ──
    var T = {
      run:    JSON.stringify({ prompt:'What is 2 + 2?', options:{ maxTurns:1 } }, null, 2),
      stream: JSON.stringify({ prompt:'Write a haiku about coding', options:{ maxTurns:1 } }, null, 2),
      chat:   JSON.stringify({ model:'claude-sonnet-4-20250514', messages:[{ role:'user', content:'Hello! What can you do?' }], stream:false }, null, 2),
      ws:     JSON.stringify({ type:'start', prompt:'Hello from WebSocket' }, null, 2),
    };
    ['run','stream','chat'].forEach(function(tab) {
      var ta = $('#body-' + tab); if (ta) ta.value = T[tab];
      var ln = $('#ln-' + tab); if (ta && ln) renderLineNumbers(ta, ln);
    });
    var wsIn = $('#ws-input'); if (wsIn) wsIn.value = T.ws;

    // Header status poll
    pollHeaderStatus();
    setInterval(pollHeaderStatus, 5000);

    // Initial view + browser back/forward
    switchView(INITIAL_VIEW, true);
    window.addEventListener('popstate', function() {
      var v = ROUTES[location.pathname] || state.view;
      switchView(v, true);
    });
  });

  // ── View routing ──
  function switchView(view, skipHistory) {
    state.view = view;
    $$('.nav-item[data-view]').forEach(function(b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    $$('.view').forEach(function(v) {
      v.classList.toggle('active', v.id === 'view-' + view);
    });

    if (!skipHistory) {
      var path = view === 'dashboard' ? '/dashboard' : '/playground';
      try { history.pushState({}, '', path); } catch(_){}
    }

    // Poll loops per view
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (view === 'dashboard') {
      fetchDashboard(); state.pollTimer = setInterval(fetchDashboard, 3000);
    } else if (view === 'status') {
      fetchStatusRaw(); state.pollTimer = setInterval(fetchStatusRaw, 5000);
    }
  }

  function getHeaders() {
    var h = { 'Content-Type':'application/json' };
    if (state.apiKey) h['Authorization'] = 'Bearer ' + state.apiKey;
    var sid = $('#sid-' + state.view);
    if (sid && sid.value) h['X-Session-Id'] = sid.value;
    return h;
  }

  // ── Header status poll ──
  async function pollHeaderStatus() {
    var dot = $('#h-dot'), lbl = $('#h-lbl');
    try {
      var r = await fetch(BASE + '/api/status');
      var d = await r.json();
      dot.className = 'dot ok';
      lbl.textContent = d.queue ? (d.queue.running||0) + ' active · ' + (d.queue.queued||0) + ' queued' : 'ready';
    } catch (e) {
      dot.className = 'dot err';
      lbl.textContent = 'unreachable';
    }
  }

  // ── Editor: line numbers ──
  function renderLineNumbers(ta, ln) {
    var lines = (ta.value.match(/\\n/g)||[]).length + 1;
    var html = '';
    for (var i = 1; i <= lines; i++) html += '<div>' + i + '</div>';
    ln.innerHTML = html;
  }

  function validateJson(tab) {
    var ta = $('#body-' + tab), wrap = $('#ew-' + tab), em = $('#em-' + tab);
    if (!ta || !wrap || !em) return;
    var v = ta.value.trim();
    if (!v) { wrap.classList.remove('error'); em.textContent=''; return; }
    try { JSON.parse(v); wrap.classList.remove('error'); em.textContent=''; }
    catch (e) { wrap.classList.add('error'); em.textContent = e.message; }
  }

  // ── JSON renderer with indent guides + line numbers ──
  function renderJson(target, gutter, obj) {
    var str = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    var lines = str.split('\\n');
    var gut = '', body = '';

    for (var i = 0; i < lines.length; i++) {
      gut += '<div>' + (i+1) + '</div>';

      // Compute indent depth (2-space units)
      var rawLine = lines[i];
      var m = rawLine.match(/^( +)/);
      var indent = m ? Math.floor(m[1].length / 2) : 0;
      var content = m ? rawLine.slice(m[1].length) : rawLine;

      var ind = '';
      for (var d = 0; d < indent; d++) ind += '<span class="ind">&nbsp;&nbsp;</span>';

      body += '<div class="ln">' + ind + highlightJsonLine(content) + '</div>';
    }
    gutter.innerHTML = gut;
    target.innerHTML = body;
  }

  function highlightJsonLine(s) {
    // Escape first
    s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Tokens: string-keys (followed by ":"), strings, numbers, booleans, null, punctuation
    return s.replace(
      /("(?:\\\\.|[^"\\\\])*")(\\s*:)?|\\b(true|false|null)\\b|(-?\\d+(?:\\.\\d+)?(?:[eE][+\\-]?\\d+)?)|([{}\\[\\],])/g,
      function(_, str, isKey, kw, num, punct) {
        if (str) return '<span class="' + (isKey ? 'jk' : 'js') + '">' + str + '</span>' + (isKey ? '<span class="jp">' + isKey + '</span>' : '');
        if (kw) return '<span class="' + (kw === 'null' ? 'jl' : 'jb') + '">' + kw + '</span>';
        if (num) return '<span class="jn">' + num + '</span>';
        if (punct) return '<span class="jp">' + punct + '</span>';
        return '';
      }
    );
  }

  // ── Dashboard ──
  async function fetchDashboard() {
    try {
      var [mr, sr] = await Promise.all([
        fetch(BASE + '/api/metrics').then(function(r){ return r.json(); }),
        fetch(BASE + '/api/status').then(function(r){ return r.json(); }),
      ]);
      renderDashboard(mr, sr);
    } catch (e) {
      // silently retry on next poll
    }
  }

  function fmtCost(n) {
    if (!n) return '$0.0000';
    if (n < 0.001) return '$' + n.toExponential(2).replace('e-','e\\u2212');
    return '$' + n.toFixed(4);
  }
  function fmtNum(n) {
    if (!n) return '0';
    if (n >= 1e6) return (n/1e6).toFixed(1).replace(/\\.0$/,'') + 'M';
    if (n >= 1e3) return (n/1e3).toFixed(1).replace(/\\.0$/,'') + 'k';
    return String(n);
  }
  function fmtMs(n) {
    if (!n) return '0ms';
    if (n >= 1000) return (n/1000).toFixed(1) + 's';
    return n + 'ms';
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
    return (h<10?'0':'')+h + ':' + (m<10?'0':'')+m + ':' + (s<10?'0':'')+s;
  }
  function fmtUptime(start) {
    var s = Math.floor((Date.now() - start)/1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s/60);
    if (m < 60) return m + 'm ' + (s%60) + 's';
    var h = Math.floor(m/60);
    return h + 'h ' + (m%60) + 'm';
  }

  function statCard(label, value, foot, cls) {
    return '<div class="stat">'
      + '<div class="lbl-row"><div class="stat-lbl">' + label + '</div></div>'
      + '<div class="stat-val' + (cls ? ' ' + cls : '') + '">' + value + '</div>'
      + (foot ? '<div class="stat-foot">' + foot + '</div>' : '')
      + '</div>';
  }

  function renderDashboard(m, s) {
    var t = m.today, all = m.totals;

    var todayHtml = ''
      + statCard('Spend today',       fmtCost(t.cost),    t.requests + ' requests', t.cost > 0 ? 'ok' : '')
      + statCard('Tokens (in / out)', fmtNum(t.inputTokens) + ' / ' + fmtNum(t.outputTokens), null)
      + statCard('Avg latency',       fmtMs(t.avgLatencyMs), 'p50 by recent runs')
      + statCard('Errors',            String(t.errors), t.errors > 0 ? 'today' : 'none', t.errors > 0 ? 'err' : '');
    $('#stats-today').innerHTML = todayHtml;
    $('#dash-today-sub').textContent = 'since 00:00';

    var totHtml = ''
      + statCard('Total spend',       fmtCost(all.cost), all.requests + ' requests')
      + statCard('Total tokens',      fmtNum(all.inputTokens + all.outputTokens), fmtNum(all.inputTokens) + ' in · ' + fmtNum(all.outputTokens) + ' out')
      + statCard('Tool calls',        fmtNum(all.toolCalls), null)
      + statCard('Errors',            fmtNum(all.errors), all.errors > 0 ? 'lifetime' : 'none', all.errors > 0 ? 'err' : '');
    $('#stats-totals').innerHTML = totHtml;
    $('#dash-totals-sub').textContent = 'v' + (m.version || '?');

    // Uptime
    $('#dash-uptime').textContent = 'up ' + fmtUptime(m.startedAt);

    // Recent runs
    var recent = m.recent || [];
    if (recent.length === 0) {
      $('#recent-runs').innerHTML = '<div class="empty-card">No requests yet. Send one from Run, Stream, or Chat.</div>';
    } else {
      var rows = '<table class="runs-table">'
        + '<thead><tr><th>Time</th><th>Endpoint</th><th>Status</th><th class="right">Duration</th><th class="right">Cost</th><th class="right">Tokens</th><th class="right">Tools</th></tr></thead><tbody>';
      for (var i = 0; i < recent.length; i++) {
        var r = recent[i];
        var stCls = r.status >= 200 && r.status < 300 ? 'st-ok' : 'st-err';
        rows += '<tr>'
          + '<td>' + fmtTime(r.ts) + '</td>'
          + '<td><span class="ep ep-' + r.endpoint + '">' + r.endpoint.toUpperCase() + '</span></td>'
          + '<td class="' + stCls + '">' + r.status + '</td>'
          + '<td class="right">' + fmtMs(r.durationMs) + '</td>'
          + '<td class="right">' + fmtCost(r.cost) + '</td>'
          + '<td class="right">' + fmtNum(r.inputTokens) + ' / ' + fmtNum(r.outputTokens) + '</td>'
          + '<td class="right">' + (r.toolCalls || 0) + '</td>'
          + '</tr>';
      }
      rows += '</tbody></table>';
      $('#recent-runs').innerHTML = rows;
    }

    // Top tools
    var tt = m.topTools || [];
    if (tt.length === 0) {
      $('#top-tools').innerHTML = '<div class="empty-card">No tool calls yet.</div>';
    } else {
      var max = tt[0].count;
      var th = '<div class="tool-list">';
      for (var j = 0; j < tt.length; j++) {
        var pct = Math.max(4, Math.round(tt[j].count / max * 100));
        th += '<div class="tool-row">'
          + '<div class="nm">' + escHtml(tt[j].tool) + '</div>'
          + '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>'
          + '<div class="ct">' + tt[j].count + '</div>'
          + '</div>';
      }
      th += '</div>';
      $('#top-tools').innerHTML = th;
    }

    // Server meta + queue bars
    var q = s.queue || {};
    var cb = s.circuitBreaker || 'closed';
    var cbCls = cb === 'closed' ? 'ok' : cb === 'open' ? 'err' : 'warn';
    var serverHtml = ''
      + '<div class="meta-row"><span class="k">Version</span><span class="v">v' + escHtml(s.version || '?') + '</span></div>'
      + '<div class="meta-row"><span class="k">Sessions</span><span class="v">' + (s.activeSessions || 0) + '</span></div>'
      + '<div class="meta-row"><span class="k">Circuit</span><span class="v ' + cbCls + '">' + escHtml(cb) + '</span></div>'
      + '<div class="meta-row"><span class="k">Processed</span><span class="v">' + (q.totalProcessed || 0) + '</span></div>'
      + '<div class="meta-row"><span class="k">Rejected</span><span class="v">' + (q.totalRejected || 0) + '</span></div>';
    $('#server-meta').innerHTML = serverHtml;

    var activeP = q.maxConcurrent ? Math.round((q.running||0) / q.maxConcurrent * 100) : 0;
    var queuedP = q.maxQueueSize ? Math.round((q.queued||0) / q.maxQueueSize * 100) : 0;
    var activeFillCls = activeP > 80 ? 'crit' : activeP > 50 ? 'warn' : '';
    var queuedFillCls = queuedP > 80 ? 'crit' : queuedP > 50 ? 'warn' : '';

    $('#qbar-active').innerHTML = ''
      + '<div class="qhead"><span class="k">Active workers</span><span class="v">' + (q.running||0) + ' / ' + (q.maxConcurrent||'?') + '</span></div>'
      + '<div class="qbar"><div class="qfill ' + activeFillCls + '" style="width:' + Math.max(activeP, 2) + '%"></div></div>';
    $('#qbar-queued').innerHTML = ''
      + '<div class="qhead"><span class="k">Queue</span><span class="v">' + (q.queued||0) + ' / ' + (q.maxQueueSize||'?') + '</span></div>'
      + '<div class="qbar"><div class="qfill ' + queuedFillCls + '" style="width:' + Math.max(queuedP, 2) + '%"></div></div>';
  }

  // ── Status (raw, debug view) ──
  async function fetchStatusRaw() {
    try {
      var r = await fetch(BASE + '/api/status');
      var d = await r.json();
      $('#status-block').innerHTML = '<pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-word">' + escHtml(JSON.stringify(d, null, 2)) + '</pre>';
    } catch (e) {
      $('#status-block').innerHTML = '<div class="empty-card" style="color:var(--err)">Failed to connect: ' + escHtml(e.message) + '</div>';
    }
  }

  // ── One-shot request ──
  async function sendOneshot(tab) {
    var bodyEl = $('#body-' + tab);
    var rm = $('#rm-' + tab);
    var fmt = $('#resp-fmt-' + tab);
    var raw = $('#resp-raw-' + tab);
    var bodyFmt = $('#body-fmt-' + tab);
    var gutFmt = $('#gut-fmt-' + tab);
    var empty = $('#resp-empty-' + tab);
    var sendBtn = $('#send-' + tab);

    var body;
    try { body = JSON.parse(bodyEl.value); }
    catch (e) { rm.innerHTML = pillErr('JSON', e.message); return; }

    sendBtn.disabled = true;
    if (empty) empty.classList.add('hidden');
    rm.innerHTML = '<span class="pill pill-pending">Pending</span>';
    bodyFmt.innerHTML = ''; gutFmt.innerHTML = ''; raw.textContent = '';
    fmt.classList.remove('hidden'); raw.classList.add('hidden');

    var start = Date.now();
    var controller = new AbortController();
    state.activeAbort = controller;

    try {
      var ep = ENDPOINTS[tab];
      var res = await fetch(BASE + ep.path, {
        method:ep.method, headers:getHeaders(),
        body:JSON.stringify(body), signal:controller.signal,
      });
      var dur = Date.now() - start;
      var rawText = await res.text();
      var parsed; try { parsed = JSON.parse(rawText); } catch { parsed = null; }

      rm.innerHTML = pillStatus(res.status, dur);

      if (parsed !== null && typeof parsed === 'object') {
        renderJson(bodyFmt, gutFmt, parsed);
      } else {
        bodyFmt.textContent = rawText;
      }
      raw.textContent = parsed ? JSON.stringify(parsed, null, 2) : rawText;

      var newSid = res.headers.get('X-Session-Id');
      var sidIn = $('#sid-' + tab);
      if (newSid && sidIn) sidIn.value = newSid;
    } catch (err) {
      if (err.name === 'AbortError') {
        rm.innerHTML = '<span class="pill pill-cancelled">Cancelled</span>';
      } else {
        rm.innerHTML = pillErr('Error', err.message);
      }
    } finally {
      sendBtn.disabled = false;
      state.activeAbort = null;
    }
  }

  function pillStatus(s, dur) {
    var ok = s >= 200 && s < 300;
    return '<span class="pill pill-' + (ok ? 'ok' : 'err') + '">' + s + '</span>'
         + '<span class="pill-dur">' + dur + 'ms</span>';
  }
  function pillErr(label, msg) {
    return '<span class="pill pill-err">' + escHtml(label) + '</span>'
         + '<span class="pill-dur" style="color:var(--tx-1)">' + escHtml(msg) + '</span>';
  }

  // ── Stream (NDJSON) ──
  async function sendStream() {
    var bodyEl = $('#body-stream');
    var output = $('#stream-output');
    var textArea = $('#stream-text');
    var rawArea = $('#stream-raw');
    var summary = $('#stream-summary');
    var sendBtn = $('#send-stream');
    var rm = $('#rm-stream');
    var empty = $('#resp-empty-stream');

    var body;
    try { body = JSON.parse(bodyEl.value); }
    catch (e) { rm.innerHTML = pillErr('JSON', e.message); return; }

    sendBtn.disabled = true;
    if (empty) empty.classList.add('hidden');
    output.classList.remove('hidden');
    textArea.classList.remove('hidden');
    rawArea.classList.add('hidden');
    textArea.innerHTML = '<span class="cursor"></span>';
    rawArea.textContent = '';
    summary.classList.add('hidden');
    rm.innerHTML = '<span class="pill pill-pending">Streaming</span>';
    state.autoScroll = true;

    var controller = new AbortController();
    state.activeAbort = controller;
    var fullText = '';
    var start = Date.now();

    try {
      var res = await fetch(BASE + '/api/stream', {
        method:'POST', headers:getHeaders(),
        body:JSON.stringify(body), signal:controller.signal,
      });

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream:true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.trim()) continue;
          rawArea.textContent += line + '\\n';
          var ev; try { ev = JSON.parse(line); } catch { continue; }

          if (ev.type === 'text_delta') {
            fullText += ev.delta || '';
            textArea.innerHTML = escHtml(fullText) + '<span class="cursor"></span>';
          } else if (ev.type === 'tool_use') {
            var block = makeTool(ev.tool || 'tool_use', JSON.stringify(ev.input || {}, null, 2));
            textArea.insertBefore(block, textArea.querySelector('.cursor'));
          } else if (ev.type === 'tool_result') {
            var c = typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output, null, 2);
            var b2 = makeTool('Result' + (ev.isError ? ' (error)' : ''), c, ev.isError ? 'err' : 'ok');
            textArea.insertBefore(b2, textArea.querySelector('.cursor'));
          } else if (ev.type === 'result') {
            var cur = textArea.querySelector('.cursor');
            if (cur) cur.remove();
            summary.classList.remove('hidden');
            summary.innerHTML =
              '<span><span class="sl">Cost</span>' + fmtCost(ev.cost || 0) + '</span>' +
              '<span><span class="sl">Duration</span>' + (ev.duration || 0) + 'ms</span>' +
              (ev.usage ? '<span><span class="sl">Tokens</span>' + (ev.usage.input_tokens || ev.usage.inputTokens || 0) + ' in / ' + (ev.usage.output_tokens || ev.usage.outputTokens || 0) + ' out</span>' : '');
            var sidIn = $('#sid-stream');
            if (ev.sessionId && sidIn) sidIn.value = ev.sessionId;
          } else if (ev.type === 'session_init' && ev.sessionId) {
            var sidIn2 = $('#sid-stream');
            if (sidIn2) sidIn2.value = ev.sessionId;
          }
          if (state.autoScroll) output.scrollTop = output.scrollHeight;
        }
      }
      rm.innerHTML = pillStatus(200, Date.now() - start);
    } catch (err) {
      if (err.name === 'AbortError') {
        rm.innerHTML = '<span class="pill pill-cancelled">Cancelled</span>';
        var cur2 = textArea.querySelector('.cursor');
        if (cur2) cur2.remove();
      } else {
        rm.innerHTML = pillErr('Error', err.message);
        textArea.innerHTML = fullText + '\\n<span style="color:var(--err)">' + escHtml(err.message) + '</span>';
      }
    } finally {
      sendBtn.disabled = false;
      state.activeAbort = null;
      var cur3 = textArea.querySelector('.cursor');
      if (cur3) cur3.remove();
    }
  }

  function makeTool(name, content, extraClass) {
    var div = document.createElement('div');
    div.className = 'tool' + (extraClass ? ' ' + extraClass : '');
    div.innerHTML =
      '<div class="tool-head"><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3L7.5 6L4.5 9"/></svg> ' + escHtml(name) + '</div>' +
      '<div class="tool-body"><pre style="margin:0;font-family:inherit;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word">' + escHtml(content) + '</pre></div>';
    div.querySelector('.tool-head').onclick = function() { div.classList.toggle('open'); };
    return div;
  }

  // ── Chat (OpenAI) ──
  async function sendChat() {
    var bodyEl = $('#body-chat');
    var sendBtn = $('#send-chat');
    var rm = $('#rm-chat');

    var body;
    try { body = JSON.parse(bodyEl.value); }
    catch (e) { rm.innerHTML = pillErr('JSON', e.message); return; }

    if (body.stream === true) return sendChatStream(body, sendBtn);

    var fmt = $('#resp-fmt-chat');
    var raw = $('#resp-raw-chat');
    var bodyFmt = $('#body-fmt-chat');
    var gutFmt = $('#gut-fmt-chat');
    var empty = $('#resp-empty-chat');

    sendBtn.disabled = true;
    if (empty) empty.classList.add('hidden');
    $('#chat-response-standard').classList.remove('hidden');
    $('#chat-stream-output').classList.add('hidden');
    rm.innerHTML = '<span class="pill pill-pending">Pending</span>';
    bodyFmt.innerHTML = ''; gutFmt.innerHTML = ''; raw.textContent = '';
    fmt.classList.remove('hidden'); raw.classList.add('hidden');

    var start = Date.now();
    var controller = new AbortController();
    state.activeAbort = controller;

    try {
      var res = await fetch(BASE + '/v1/chat/completions', {
        method:'POST', headers:getHeaders(),
        body:JSON.stringify(body), signal:controller.signal,
      });
      var dur = Date.now() - start;
      var rawText = await res.text();
      var parsed; try { parsed = JSON.parse(rawText); } catch { parsed = null; }
      rm.innerHTML = pillStatus(res.status, dur);
      if (parsed !== null && typeof parsed === 'object') renderJson(bodyFmt, gutFmt, parsed);
      else bodyFmt.textContent = rawText;
      raw.textContent = parsed ? JSON.stringify(parsed, null, 2) : rawText;
    } catch (err) {
      if (err.name === 'AbortError') rm.innerHTML = '<span class="pill pill-cancelled">Cancelled</span>';
      else rm.innerHTML = pillErr('Error', err.message);
    } finally {
      sendBtn.disabled = false;
      state.activeAbort = null;
    }
  }

  async function sendChatStream(body, sendBtn) {
    var output = $('#chat-stream-output');
    var textArea = $('#chat-stream-text');
    var summary = $('#chat-stream-summary');
    var rm = $('#rm-chat');
    var empty = $('#resp-empty-chat');

    sendBtn.disabled = true;
    if (empty) empty.classList.add('hidden');
    $('#chat-response-standard').classList.add('hidden');
    output.classList.remove('hidden');
    textArea.innerHTML = '<span class="cursor"></span>';
    summary.classList.add('hidden');
    rm.innerHTML = '<span class="pill pill-pending">Streaming</span>';
    state.autoScroll = true;

    var controller = new AbortController();
    state.activeAbort = controller;
    var fullText = '';
    var start = Date.now();

    try {
      var res = await fetch(BASE + '/v1/chat/completions', {
        method:'POST', headers:getHeaders(),
        body:JSON.stringify(body), signal:controller.signal,
      });

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream:true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();

        for (var j = 0; j < lines.length; j++) {
          var line = lines[j];
          if (!line.startsWith('data: ')) continue;
          var data = line.slice(6);
          if (data === '[DONE]') {
            var cur = textArea.querySelector('.cursor');
            if (cur) cur.remove();
            var dur = Date.now() - start;
            rm.innerHTML = pillStatus(200, dur);
            summary.classList.remove('hidden');
            summary.innerHTML = '<span><span class="sl">Duration</span>' + dur + 'ms</span><span>Stream complete</span>';
            continue;
          }
          var ev; try { ev = JSON.parse(data); } catch { continue; }
          var delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
          if (delta && delta.content) {
            fullText += delta.content;
            textArea.innerHTML = escHtml(fullText) + '<span class="cursor"></span>';
          }
          if (state.autoScroll) output.scrollTop = output.scrollHeight;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        rm.innerHTML = '<span class="pill pill-cancelled">Cancelled</span>';
        var cur2 = textArea.querySelector('.cursor'); if (cur2) cur2.remove();
      } else {
        rm.innerHTML = pillErr('Error', err.message);
        textArea.innerHTML = fullText + '\\n<span style="color:var(--err)">' + escHtml(err.message) + '</span>';
      }
    } finally {
      sendBtn.disabled = false;
      state.activeAbort = null;
      var cur3 = textArea.querySelector('.cursor'); if (cur3) cur3.remove();
    }
  }

  // ── WebSocket ──
  function wsConnect() {
    if (state.ws) return;
    var dot = $('#ws-dot');
    dot.className = 'ws-dot connecting';
    wsLog('Connecting to ' + WS_BASE + '/ws …', 'system');
    var ws = new WebSocket(WS_BASE + '/ws');
    state.ws = ws;
    ws.onopen = function() {
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
      dot.className = 'ws-dot';
      wsLog('Disconnected (code ' + e.code + ')', 'system');
      $('#ws-connect').disabled = false;
      $('#ws-disconnect').disabled = true;
      $('#ws-send').disabled = true;
      $('#ws-label').textContent = 'Disconnected';
    };
  }
  function wsDisconnect() { if (state.ws) state.ws.close(); }
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
    var pf = type === 'sent' ? '\\u25B6' : type === 'received' ? '\\u25C0' : '\\u2022';
    div.innerHTML = '<span class="pf">' + pf + '</span>' + escHtml(text);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function cancel() {
    if (state.activeAbort) { state.activeAbort.abort(); state.activeAbort = null; }
  }

  function escHtml(s) {
    if (typeof s !== 'string') s = String(s);
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
`;
}

export function getPlaygroundHtml(port: number, version = "0.0.0"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>otterly — local inference server</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%236366f1'/><circle cx='11' cy='14' r='3.2' fill='white'/><circle cx='21' cy='14' r='3.2' fill='white'/><circle cx='11' cy='14.5' r='1.2' fill='%230a0a0c'/><circle cx='21' cy='14.5' r='1.2' fill='%230a0a0c'/><ellipse cx='16' cy='21' rx='3.2' ry='1.6' fill='white'/></svg>">
<style>${styles()}</style>
</head>
<body>
${shell(version)}
<script>${client(port)}</script>
</body>
</html>`;
}
