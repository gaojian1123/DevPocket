// Disposable, data-only UI. No runtime calls, arbitrary HTML, renderer assets, or storage.
const glyphs = {
  terminal: '<path d="m5 7 5 5-5 5m9 0h5"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 0 1-1-5 8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path d="M8 9h8m-8 4h5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  trend: '<path d="M4 4v16h17M7 14l4-5 4 3 6-8"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M11 4v16"/>',
  text: '<path d="M4 5h16M4 10h16M4 15h12M4 20h8"/>',
  turn: '<path d="M8 3H5v18h3m3-16h10m-10 7h10m-10 7h7"/>',
  append: '<rect x="3" y="3" width="12" height="13" rx="2"/><path d="M9 21h10a2 2 0 0 0 2-2V9m-10 8h8m-4-4v8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  expand: '<path d="M14 3h7v7M3 14v7h7M21 3l-7 7M3 21l7-7"/>',
  send: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-9c0 6-12 2-12 8"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  file: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10l-7-7Z"/><path d="M13 3v7h7M8 14h8m-8 3h5"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4m-4 1h8"/>',
  cube: '<path d="m12 2 10 5v10l-10 5-10-5V7l10-5Zm0 10L2 7m10 5 10-5M12 12v10M7 4.5l10 5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/>',
  inbox: '<path d="M3 14 6 4h12l3 10v6H3v-6Z"/><path d="M3 14h5l2 3h4l2-3h5"/>',
  pin: '<path d="m9 3 9 2-3 5 2 4-6 1-4 4-1-7-3-2 6-2V3Zm1 12-6 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M5 8h2m-2 4h2"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20 15A9 9 0 0 1 9 4 9 9 0 1 0 20 15Z"/>',
  wifi: '<path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4 4 0 0 1 6 0m-3 4h.01"/>',
  offline: '<path d="m3 3 18 18M3 8a14 14 0 0 1 5-2m4-1a14 14 0 0 1 9 3M6 12a9 9 0 0 1 6-2m-3 6a4 4 0 0 1 6 0m-3 4h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">${glyphs[name]}</svg>`;
const escapeText = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const iconButton = (glyph, action, label, attrs = "", extraClass = "") => `<button class="icon-button ${extraClass}" data-action="${action}" aria-label="${label}" title="${label}" ${attrs}>${icon(glyph)}</button>`;
const choice = (value, options, fallback) => options.includes(value) ? value : fallback;
const params = new URLSearchParams(location.search);
const previewDevices = ["iphone", "duo", "ipad", "mac"];
const duoPoses = {
  outer: { label: "外屏收起", width: 520, height: 700, description: "紧凑宽度 · 单列阅读，右侧保留相机、状态与导航空间。展开画布使用单一关闭按钮。" },
  open: { label: "内屏展开", width: 960, height: 700, description: "列表约占三成，聊天约占七成；展开画布后，对话与查看器并排。导航仍在右侧。" },
  book: { label: "书本式半折", width: 960, height: 700, description: "内屏横向半折 · 中间留出折叠预留区域，正文、输入框与按钮都留在两侧可用空间。" },
};
const sceneNames = { visual: "图文混排", plain: "普通多段对话", decision: "等待你的决定", legacy: "归属不明的历史", building: "画布生成中", unavailable: "画布不可显示", append: "后续追加新图" };
const previousWeek = Object.freeze([4, 6, 5, 7, 5, 6, 6]);
const currentWeek = Object.freeze([5, 8, 4, 10, 6, 8, 7]);
const allValues = Object.freeze([...previousWeek, ...currentWeek]);
const dates = Object.freeze(["9/28", "9/29", "9/30", "10/1", "10/2", "10/3", "10/4", "10/5", "10/6", "10/7", "10/8", "10/9", "10/10", "10/11"]);
const modules = Object.freeze([
  Object.freeze({ name: "Android 界面", count: 20 }),
  Object.freeze({ name: "会话与同步", count: 14 }),
  Object.freeze({ name: "Relay 与协议", count: 9 }),
  Object.freeze({ name: "文档与构建", count: 5 }),
]);
const originalCards = Object.freeze([
  Object.freeze({ id: "overview", kind: "text", title: "展示说明", turn: "turn-2", short: "说明" }),
  Object.freeze({ id: "trend", kind: "chart", title: "任务完成趋势", turn: "turn-2", short: "趋势" }),
  Object.freeze({ id: "modules", kind: "table", title: "模块工作分布", turn: "turn-2", short: "表格" }),
  Object.freeze({ id: "insights", kind: "text", title: "这一周的观察", turn: "turn-2", short: "解读" }),
]);
const sessions = [
  { id: "analysis", title: "回顾最近两周的进展", branch: "main", summary: "文字、趋势图与表格 · 同一轮回答", glyph: "trend", scene: "visual", status: "空闲" },
  { id: "ordinary", title: "完善通知与离线体验", branch: "feature/notifications", summary: "普通对话 · 过程与结论按轮归组", glyph: "chat", scene: "plain", status: "空闲" },
  { id: "approval", title: "确认下一步改动", branch: "feature/mobile-polish", summary: "有一个请求，正在等你确认", glyph: "shield", scene: "decision", status: "待确认" },
  { id: "archive", title: "继续上次的对话", branch: "fix/history-sync", summary: "历史保留 · 未知归属不强行合并", glyph: "clock", scene: "legacy", status: "空闲" },
];
const state = {
  scene: choice(params.get("scene"), Object.keys(sceneNames), "visual"),
  device: choice(params.get("device"), ["all", ...previewDevices], "all"),
  theme: choice(params.get("theme"), ["light", "dark"], "light"),
  reduced: params.get("transparency") === "reduced", offline: params.get("offline") === "1",
  phonePage: params.get("screen") === "home" ? "home" : "chat",
  duoPose: choice(params.get("pose"), Object.keys(duoPoses), "open"), duoPage: "chat",
  tab: "chat", selected: "analysis", search: "", ipadCompact: params.get("narrow") === "1",
  sidebar: true, viewer: { iphone: null, duo: null, ipad: null, mac: "trend" }, activeDevice: choice(params.get("device"), previewDevices, "iphone"),
  collapsedCanvas: false, expandedText: [],
  views: Object.fromEntries(originalCards.map((card) => [card.id, { range: 14, point: 10, tab: "chart", query: "", descending: true }])),
  drafts: Object.fromEntries(sessions.map((session) => [session.id, { text: "", reference: null }])),
  followups: [], request: { answer: "", answerStatus: "pending", permission: "pending", decision: null },
  cancelRequested: false, dialog: null,
};
let nextTurn = 3;
let toastTimer;
const positions = new Map();
const session = () => sessions.find((item) => item.id === state.selected);
const draft = () => state.drafts[state.selected];
const isDeckScene = () => ["visual", "append", "building", "unavailable"].includes(state.scene);
const renderedCards = () => [...originalCards, ...state.followups.flatMap((turn) => turn.card ? [turn.card] : [])];
const getCard = (id) => {
  const card = renderedCards().find((item) => item.id === id);
  if (!card) throw new Error(`Unknown prototype card: ${id}`);
  return card;
};
const viewFor = (id) => state.views[id];
const seriesFor = (id) => viewFor(id).range === 7 ? currentWeek : allValues;
const totalFor = (id) => seriesFor(id).reduce((sum, value) => sum + value, 0);
const dateFor = (id, point) => dates[(viewFor(id).range === 7 ? 7 : 0) + point];
const timeLabel = (id) => `示例 ${viewFor(id).range === 14 ? "9/28" : "10/5"}–10/11`;
const branch = () => `<span class="branch-label">${icon("branch")}<span>${session().branch}</span></span>`;
const marked = () => `<span class="assistant-mark">${icon("terminal")}</span>`;
const statusText = () => state.offline ? "离线缓存" : state.cancelRequested ? "取消待确认" : state.scene === "decision" ? "需要你" : state.scene === "building" ? "生成中" : "原会话";
const deviceAttrs = (device, card = "") => `data-platform="${device}"${card ? ` data-content="${card}"` : ""}`;
const phoneStatus = () => `<div class="phone-status" aria-hidden="true"><span>9:41</span><div class="status-symbols">${icon("wifi")}<span class="battery"></span></div></div>`;
const compactDuo = () => state.duoPose === "outer";
const modalReader = (device) => device === "iphone" || device === "ipad" && state.ipadCompact || device === "duo" && compactDuo();

function applyScene(scene) {
  state.scene = scene;
  state.selected = scene === "plain" ? "ordinary" : scene === "decision" ? "approval" : scene === "legacy" ? "archive" : "analysis";
  state.phonePage = "chat";
  state.duoPage = "chat";
  state.tab = "chat";
  state.cancelRequested = false;
  state.viewer = { iphone: null, duo: null, ipad: null, mac: ["visual", "append"].includes(scene) ? "trend" : null };
  if (scene === "append" && !state.followups.some((turn) => turn.card)) appendExample();
  if (scene === "append") state.viewer.mac = state.followups.filter((turn) => turn.card).at(-1).card.id;
}
function appendExample() {
  const number = nextTurn++;
  const id = `trend-${number}`;
  const card = Object.freeze({ id, kind: "bar", title: "任务完成趋势 · 柱状图", turn: `turn-${number}`, short: "新图" });
  state.views[id] = { range: 14, point: 10, tab: "chart", query: "", descending: true };
  state.followups.push({ id: `turn-${number}`, number, session: "analysis", text: "把刚才的折线图换成柱状图，保留原来的图。", reference: "trend", status: "completed", card });
}
applyScene(state.scene);
if (params.get("screen") === "home") { state.phonePage = "home"; state.duoPage = "home"; }
if (params.get("reader") === "1" && ["visual", "append"].includes(state.scene)) {
  const platforms = state.device === "all" ? previewDevices : [state.device];
  const cardId = state.scene === "append" ? state.viewer.mac : "trend";
  platforms.forEach((platform) => { state.viewer[platform] = cardId; });
}
document.body.dataset.export = params.get("export") === "1" ? "true" : "false";

function sessionSearch(key) {
  return `<label class="search-box">${icon("search")}<input type="search" data-focus="${key}" data-session-search aria-label="搜索项目、分支或会话" placeholder="搜索会话、项目或分支" value="${escapeText(state.search)}"><span class="shortcut">⌘ K</span></label>`;
}
function sessionRow(item, device) {
  return `<button class="session-row ${state.selected === item.id ? "selected" : ""}" data-action="session" data-session="${item.id}" data-session-row="${item.id}" ${deviceAttrs(device)}>
    <span class="session-symbol">${icon(item.glyph)}</span><span class="session-copy"><span class="session-title"><span>${item.title}</span></span><span class="session-preview">${item.summary}</span>
    <span class="session-meta"><span class="state-tag ${item.id === "approval" ? "waiting" : "idle"}">${item.status}</span><span class="branch-label">${icon("branch")}<span>${item.branch}</span></span></span></span></button>`;
}
function sessionList(device) {
  return `<aside class="session-list-pane" data-scroll="${device}-session-list"><h2>所有会话</h2><p class="pane-subtitle">同一个项目，不同的工作现场。</p>${sessionSearch(`${device}-search`)}
    <div class="pane-section-label"><span>DEVPOCKET</span><span>4 个已注册会话</span></div>${sessions.map((item) => sessionRow(item, device)).join("")}<p class="no-results" hidden>没有匹配的会话</p>
  </aside>`;
}
function sidebar() {
  return `<aside class="navigation-sidebar glass" ${state.sidebar ? "" : "hidden"}><div class="sidebar-logo"><span class="brand-icon">${icon("terminal")}</span>DevPocket</div>
    <button class="sidebar-item active" data-action="home">${icon("grid")}工作台</button><button class="sidebar-item" data-action="decision-scene">${icon("inbox")}待处理<small>1</small></button>
    <button class="sidebar-item" data-action="picker">${icon("pin")}已置顶</button><p class="sidebar-label">项目</p>
    <button class="sidebar-item" data-action="picker">${icon("cube")}DevPocket<small>4</small></button><p class="sidebar-label">电脑</p>
    <button class="sidebar-item" data-action="runtime">${icon("monitor")}Studio Dev Box</button>
    <div class="sidebar-footer"><button class="host-tile" data-action="runtime"><strong><span class="connection-dot ${state.offline ? "offline" : ""}"></span>${state.offline ? "示例连接已断开" : "连接到原始会话"}</strong><small>GitHub Copilot · 本地模拟</small></button><button class="sidebar-item" data-action="settings">${icon("settings")}设置</button></div></aside>`;
}
function windowHeader(device) {
  if (device === "ipad") return `<header class="window-titlebar tablet-titlebar glass">${iconButton("sidebar", "picker", "选择已注册会话", deviceAttrs(device))}<span class="window-title">DevPocket</span>
    <nav class="tablet-top-tabs glass" aria-label="应用导航"><button class="active" data-action="home">工作台</button><button data-action="decision-scene">待处理</button><button data-action="settings">设置</button></nav><div class="titlebar-trailing"><span class="demo-watermark">DEMO</span>${iconButton("plus", "pair", "配对流程示意")}</div></header>`;
  return `<header class="window-titlebar glass"><div class="traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div>${iconButton("sidebar", "sidebar", "显示或隐藏项目边栏")}
    <span class="window-title">DevPocket<small>流光工作台</small></span><div class="titlebar-trailing"><span class="demo-watermark">DESIGN PROTOTYPE</span><span>同一原始会话</span>${iconButton("search", "picker", "搜索会话")}${iconButton("panel", "toggle-reader", "显示或关闭画布查看器", deviceAttrs(device))}</div></header>`;
}
function phoneTabs() {
  return `<nav class="phone-tabbar glass chat-tabs" aria-label="应用导航"><button class="active" data-action="home">${icon("grid")}<span>工作台</span></button><button data-action="decision-scene">${icon("inbox")}<span>待处理</span><span class="tab-badge">1</span></button><button data-action="settings">${icon("settings")}<span>设置</span></button></nav>`;
}
function home(device) {
  return `<div class="phone-content" data-scroll="${device}-home"><div class="phone-topline"><h2>工作台</h2>${device === "duo" ? "" : iconButton("plus", "pair", "连接 Dev Box", "", "glass")}</div><p class="phone-greeting">进展不只是一段文字。</p>${sessionSearch(`${device}-home-search`)}
    <button class="host-control" data-action="runtime"><span class="host-chip">${icon("monitor")}Studio Dev Box<span class="connection-dot ${state.offline ? "offline" : ""}"></span>${state.offline ? "离线" : "在线"}${icon("down")}</span></button>
    <button class="attention-card" data-action="demo-chat"><div class="attention-heading">${icon("layers")}<span>最近的回答，有了新的维度</span></div><h3>把进展，看得更清楚。</h3><p>文字、趋势、表格和解读，都在原来的会话里。</p><div class="card-cta"><span>看看这轮回复</span>${icon("right")}</div></button>
    <div class="section-label"><span>${icon("cube")}DevPocket</span><span>已注册会话</span></div><div class="phone-session-group">${sessions.map((item) => sessionRow(item, device)).join("")}</div><p class="no-results" hidden>没有匹配的会话</p></div>`;
}

function chartSvg(card, device, detailed) {
  const values = seriesFor(card.id);
  const view = viewFor(card.id);
  const points = values.map((value, index) => [28 + index * 370 / (values.length - 1), 147 - value * 10.5]);
  const gradient = `fill-${card.id}-${device}-${detailed ? "reader" : "inline"}`;
  const selected = points[view.point];
  const line = points.map((point) => point.join(",")).join(" ");
  return `<svg class="trend-plot" data-action="plot" ${deviceAttrs(device, card.id)} data-focus="${gradient}" tabindex="0" viewBox="0 0 426 177" role="img" aria-label="${card.title}，${timeLabel(card.id)}，共 ${totalFor(card.id)} 项虚构任务。可点击或用左右方向键选择日期。">
    <defs><linearGradient id="${gradient}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".16"/><stop offset="100%" stop-color="var(--accent)" stop-opacity=".015"/></linearGradient></defs>
    ${[0, 5, 10].map((value) => `<line class="axis" x1="27" y1="${147 - value * 10.5}" x2="399" y2="${147 - value * 10.5}"/><text x="4" y="${151 - value * 10.5}">${value}</text>`).join("")}
    ${card.kind === "bar"
      ? points.map(([x, y], index) => `<rect x="${x - (view.range === 7 ? 15 : 9)}" y="${y}" width="${view.range === 7 ? 30 : 18}" height="${147 - y}" rx="4" fill="var(--accent)" opacity="${view.point === index ? "1" : ".5"}"/>`).join("")
      : `<polygon points="28,147 ${line} 398,147" fill="url(#${gradient})"/>${view.range === 7 ? `<polyline class="comparison" points="${previousWeek.map((value, i) => `${28 + i * 370 / 6},${147 - value * 10.5}`).join(" ")}"/>` : ""}<polyline class="trend" points="${line}"/>`}
    ${selected ? `<line class="selected-line" x1="${selected[0]}" y1="20" x2="${selected[0]}" y2="147"/><circle class="selected-point" cx="${selected[0]}" cy="${selected[1]}" r="4.5"/>` : ""}
    ${points.map(([x], index) => view.range === 7 || [0, 3, 6, 10, 13].includes(index) ? `<text x="${x}" y="170" text-anchor="middle">${dateFor(card.id, index)}</text>` : "").join("")}
  </svg>`;
}
function cardHeading(card, device, detailed) {
  const glyph = card.kind === "table" ? "table" : card.kind === "text" ? "text" : "trend";
  return `<header class="deck-card-heading"><span class="deck-card-symbol">${icon(glyph)}</span><div class="deck-card-title"><h4>${card.title}</h4><p>${card.kind === "text" ? "Canvas 文字" : card.kind === "table" ? "后一周 · 48 项示例任务" : "AgenticDeck · 只读示例"}</p></div>
    ${detailed ? "" : iconButton("expand", "open-card", `展开${card.title}`, deviceAttrs(device, card.id))}</header>`;
}
function cardFooter(card, device) {
  return `<footer class="deck-card-foot"><span>AgenticDeck · 属于第 ${card.turn.split("-")[1]} 轮</span><button data-action="ask-card" ${deviceAttrs(device, card.id)}>${icon("chat")}围绕它提问</button></footer>`;
}
function chartCard(card, device, detailed = false) {
  const view = viewFor(card.id);
  return `<article class="deck-card" data-object="${card.id}" data-origin-turn="${card.turn}">${cardHeading(card, device, detailed)}
    <div class="deck-metric"><strong>${totalFor(card.id)}</strong><small>项任务</small><span>${view.range === 7 ? "↑ 23% · 对比前一周" : "两周合计 · 示例"}</span></div>
    <p class="deck-chart-caption">${timeLabel(card.id)} · ${view.range} 天 · 虚构数据</p><div class="trend-wrap">${chartSvg(card, device, detailed)}</div>
    <output class="chart-readout" aria-live="polite"><span></span>${dateFor(card.id, view.point)} · ${seriesFor(card.id)[view.point]} 项任务</output>
    <div class="deck-legend"><span><i></i>${view.range === 14 ? "最近两周" : "后一周"}</span>${view.range === 7 && card.kind !== "bar" ? '<span><i class="previous"></i>前一周</span>' : ""}</div>
    ${detailed ? "" : cardFooter(card, device)}</article>`;
}
function tableCard(card, device, detailed = false) {
  const view = viewFor(card.id);
  const rows = modules.filter((row) => row.name.toLowerCase().includes(view.query.toLowerCase())).slice().sort((a, b) => view.descending ? b.count - a.count : a.count - b.count);
  return `<article class="deck-card" data-object="${card.id}" data-origin-turn="${card.turn}">${cardHeading(card, device, detailed)}
    <div class="deck-table-wrap">${rows.length ? `<table class="deck-table" aria-label="后一周模块分布，虚构数据"><thead><tr><th>模块</th><th aria-sort="${view.descending ? "descending" : "ascending"}"><button data-action="sort" ${deviceAttrs(device, card.id)}>任务数 ${view.descending ? "↓" : "↑"}</button></th><th>占比</th></tr></thead><tbody>${rows.map((row) => `<tr><td><span class="module-mark"></span>${row.name}</td><td>${row.count}</td><td><span class="share-meter"><i style="width:${row.count / 48 * 100}%"></i></span>${Math.round(row.count / 48 * 100)}%</td></tr>`).join("")}</tbody></table>` : '<div class="reader-empty">没有匹配的模块。<br>可以清空筛选重新查看。</div>'}</div>
    ${detailed ? "" : cardFooter(card, device)}</article>`;
}
function textCard(card, device, detailed = false) {
  const expanded = detailed || state.expandedText.includes(card.id);
  const paragraphs = card.id === "overview"
    ? ["这组虚构数据中，前一周 39 项，后一周 48 项，两周合计 87 项。日期只用于演示横轴，不是实际项目统计。", "下方的趋势、模块表与解读是同一轮回答里的不同内容块，不是另一位助手，也不会重复生成结论。"]
    : ["示例后一周完成 48 项，较前一周的 39 项增加约 23%。数量不等于工作质量。", "Android 界面占约 42%，对应 20 项；比例按整数显示。", "10/8 完成 10 项，10/7 完成 4 项。仅凭数量不能判断波动原因，需要结合任务难度与工作记录。"];
  return `<article class="deck-card canvas-copy" data-object="${card.id}" data-origin-turn="${card.turn}"><header class="deck-card-heading"><span class="deck-card-symbol">${icon("text")}</span><div class="deck-card-title"><h4>${card.title}</h4><p>Canvas 文字 · 原内容块</p></div>${detailed ? "" : `<button class="copy-toggle" data-action="copy-toggle" ${deviceAttrs(device, card.id)} aria-expanded="${expanded}">${expanded ? "收起" : "展开"}</button>`}</header>
    ${expanded ? `<div class="canvas-copy-body">${paragraphs.map((text) => `<p>${text}</p>`).join("")}</div>${detailed ? "" : cardFooter(card, device)}` : ""}</article>`;
}
const renderCard = (card, device, detailed = false) => card.kind === "table" ? tableCard(card, device, detailed) : card.kind === "text" ? textCard(card, device, detailed) : chartCard(card, device, detailed);

function userMessage(text, meta = "来自原始客户端 · 模拟记录") {
  return `<div class="user-message"><div class="user-bubble">${escapeText(text)}</div><p class="message-meta">${meta}</p></div>`;
}
const turnLabel = (number, stateText = "同一轮回答") => `<div class="turn-label">${marked()}<span>GitHub Copilot</span><small>第 ${number} 轮 · ${stateText}</small></div>`;
const activity = (text, detail) => `<details class="public-activity"><summary>${text}</summary><p>${detail} · 公开活动示意，不包含内部推理或原始工具参数。</p></details>`;

function visualTurn(device) {
  const building = state.scene === "building";
  const failed = state.scene === "unavailable";
  const canvas = building
    ? `<div class="canvas-fallback"><div class="spinner"></div><h4>正在生成可视化内容</h4><p>收到调用开始不等于成功。此时不展示完成标记，也不把占位卡计入已生成内容。</p><button class="simulation-button" data-action="finish-building">原型控制：模拟成功结果</button></div>`
    : failed ? `<div class="canvas-fallback">${icon("layers")}<h4>这张画布暂时无法显示</h4><p>示例原因：内容格式不受支持或未通过校验。普通文字保留，不运行未知 HTML / JavaScript。</p><button data-action="fallback-info">查看降级说明</button></div>`
    : state.collapsedCanvas ? `<button class="canvas-summary" data-action="canvas-toggle" data-origin-turn="turn-2" ${deviceAttrs(device)}>${icon("layers")}<span>4 个画布内容块已收起<small>展示说明 · 趋势图 · 模块分布 · 解读</small></span>${icon("right")}</button>`
    : originalCards.map((card) => renderCard(card, device)).join("");
  return `<section class="turn-section" data-turn="turn-2"><div data-anchor="request">${userMessage("用图表看看最近两周的进展，并列出后一周的模块分布。")}</div>
    ${turnLabel(2, building ? "正在生成" : "图文回复")}
    <article class="reply-turn" aria-label="第 2 轮回答，文字与画布保持顺序">
      <section data-anchor="text"><div class="phase-label">${icon("text")}过程文字</div><p class="reply-text">我会把趋势、模块分布和解读放在这一轮回复里。先整理展示数据，再给你结论。</p>
      ${activity(building ? "正在准备 AgenticDeck 内容 · 演示" : "已完成 · 整理展示数据", "内容来源：示例记录。只在确认生成结果后展示对应的画布卡片")}</section>
      <section data-anchor="canvas"><div class="deck-block-heading">${icon("layers")}<span>Canvas 回复 <small>· AgenticDeck${building || failed ? "" : " · 4 个内容块"}</small></span>${building || failed ? "" : `<button data-action="canvas-toggle" data-origin-turn="turn-2" ${deviceAttrs(device)} aria-expanded="${!state.collapsedCanvas}">${state.collapsedCanvas ? "展开" : "收起"}</button>`}</div>${canvas}</section>
      ${building ? "" : `<section data-anchor="final"><div class="phase-label final">${icon("check")}最终文字回复</div><p class="reply-text">${failed ? "文字结果仍然保留：示例后一周为 48 项，前一周为 39 项。画布未能展示，不意味着普通回复或历史被删除。" : "趋势图、模块分布和解读都在上方。示例后一周完成 48 项，前一周 39 项；Android 界面占约 42%。你可以展开图表查看每日数据，或围绕任一卡片继续问。"}</p><p class="reply-text">这些数量不能说明任务难度或工作质量，也不能单独解释某一天的波动。</p></section><div class="turn-end">${icon("check")}这一轮已结束 · ${failed ? "画布不可用已明确标记" : "文字和画布只归组，不重复拼接"}</div>`}
    </article></section>`;
}
function plainTurn() {
  return `<section class="turn-section" data-turn="plain-2"><div data-anchor="request">${userMessage("帮我梳理通知与离线体验，先说明你的思路，再给出建议。")}</div>${turnLabel(2)}
    <article class="reply-turn"><section data-anchor="text"><div class="phase-label">${icon("text")}过程文字</div><p class="reply-text">我先区分两件事：会话是否仍在电脑上运行，以及客户端是否还能实时接收事件。两者不能用同一个“停止”状态代替。</p>
    ${activity("已完成 · 检查现有行为说明", "阅读公开的界面行为说明")}
    <p class="reply-text">离线时保留可读历史和草稿，但不自动补发新消息。已发出的请求若缺少确认，应继续显示结果不确定。</p></section>
    <section data-anchor="final"><div class="phase-label final">${icon("check")}最终文字回复</div><p class="reply-text">建议保留明确的连接状态、手动发送入口和请求回执。Apple 的后台提醒还需要单独设计 APNs 与系统生命周期，不能直接沿用 Android 常驻服务。</p></section>
    <div class="turn-end">${icon("check")}两段过程文字、工具活动与结论 · 同一轮</div></article></section>
    <section class="simple-answer"><div class="phase-label">另一轮 · 只有一段正文时保持简洁</div>${userMessage("这会改变原始会话吗？", "独立用户请求 · 示例")}${turnLabel(3)}<p class="reply-text">不会。DevPocket 继续连接同一个已注册运行时，不启动替代会话。</p></section>`;
}
function decisionTurn(device) {
  const request = state.request;
  const answer = request.answerStatus === "pending"
    ? `<p>先确认这次要关注哪一部分。</p>${["通知与离线", "会话列表", "两者都看"].map((item) => `<button data-action="answer-choice" data-choice="${item}" ${deviceAttrs(device)} class="${request.answer === item ? "selected" : ""}" aria-pressed="${request.answer === item}" ${state.offline ? "disabled" : ""}>${item}</button>`).join("")}<div class="permission-actions"><button class="primary" data-action="submit-answer" ${request.answer && !state.offline ? "" : "disabled"}>提交回答 · 模拟</button></div>`
    : `<div class="request-status ${request.answerStatus === "confirmed" ? "confirmed" : ""}">${request.answerStatus === "confirmed" ? "已确认回答 · 只读" : "回答已发送 · 等待运行时确认"}<br>${escapeText(request.answer)}${request.answerStatus === "submitted" ? `<button class="simulation-button" data-action="confirm-answer" ${state.offline ? "disabled" : ""}>原型控制：模拟确认回执</button>` : ""}</div>`;
  const permission = request.permission === "pending"
    ? `<p>运行一次本地检查，确认是否有类型错误。</p><div class="command-block">${icon("terminal")}<code>npm run typecheck</code></div><p>DevPocket · feature/mobile-polish<br>内容来自工具，请先核对。组织策略仍然生效。</p><div class="permission-actions"><button data-action="permission" data-decision="reject" ${state.offline ? "disabled" : ""}>拒绝</button><button class="primary" data-action="permission" data-decision="approve" ${state.offline ? "disabled" : ""}>允许一次</button></div>`
    : `<div class="request-status ${request.permission === "confirmed" ? "confirmed" : ""}">${request.permission === "confirmed" ? "运行时已确认 · 只读记录" : "决定已发送 · 尚未确认"}<br>${request.decision === "approve" ? "仅允许这一次" : "拒绝此次操作"}${request.permission === "submitted" ? `<button class="simulation-button" data-action="confirm-permission" ${state.offline ? "disabled" : ""}>原型控制：模拟确认回执</button>` : ""}</div>`;
  return `<section class="turn-section" data-turn="decision-2"><div data-anchor="request">${userMessage("先检查这次客户端调整的范围，再做本地检查。")}</div>${turnLabel(2, "需要你的决定")}
    <article class="reply-turn"><section data-anchor="text"><p class="reply-text">我会先确认范围，再检查相关改动。下面的回答和审批都继续属于这一个独立请求，不开启新轮。</p></section>
    <section data-anchor="decision"><div class="request-card"><div class="phase-label">${icon("chat")}问题 · 第 2 轮</div><h4>优先看哪个部分？</h4>${answer}</div>
    <div class="request-card"><div class="phase-label">${icon("shield")}权限请求 · 第 2 轮</div><h4>运行一次本地检查？</h4>${permission}</div></section>
    <section data-anchor="final"><p class="reply-text">待处理问题、审批与错误不会被折叠隐藏。只有收到可信的回执，才能显示“已确认”。</p></section></article></section>`;
}
function followupTurns(device) {
  return state.followups.filter((turn) => turn.session === state.selected).map((turn) => `<section class="turn-section" data-turn="${turn.id}" data-followup="${turn.id}" ${turn.card ? 'data-anchor="append"' : ""}>
    ${userMessage(turn.text, `${turn.status === "completed" ? "已完成演示" : "模拟已接收 · 尚未确认开始"} · 独立用户请求`)}${turnLabel(turn.number, turn.status === "completed" ? "新的回答" : "等待执行")}
    <article class="reply-turn">${turn.reference ? `<div class="append-reference">${icon("layers")}引用：${getCard(turn.reference).title} · 不改变原卡片</div>` : ""}
    ${turn.status !== "completed" ? `<p class="reply-text">这是一轮新的请求。接收确认不等于已排队或正在执行，不会并入上一轮。</p><button class="simulation-button" data-action="finish-followup" data-turn="${turn.id}" ${state.offline ? "disabled" : ""}>原型控制：模拟完成这一轮</button>`
      : turn.card ? `<p class="reply-text">已追加一张柱状图。上一轮折线图仍保留，生成的数据没有被原地覆盖。</p>${renderCard(turn.card, device)}<div class="turn-end">${icon("check")}新内容块 ${turn.card.id} · 来自这一轮</div>`
      : '<p class="reply-text">这是预设的本地演示回复，没有调用真实模型。仅凭任务数量无法解释原因，需要结合实际任务内容与工作记录。</p><div class="turn-end">新的文字回复 · 不修改已有画布</div>'}</article></section>`).join("");
}
function timeline(device) {
  return `<div class="turn-timeline" data-scroll="${device}-${state.selected}-${state.scene}"><div class="turn-date">今天 09:41 · 模拟对话</div>
    ${isDeckScene() ? visualTurn(device) : state.scene === "decision" ? decisionTurn(device) : plainTurn()}
    ${state.scene === "legacy" ? '<article class="unassigned-record" data-origin="unknown"><strong>独立历史条目 · 所属轮次未确认</strong><p>我已整理出需要关注的变化，稍后可继续检查。</p><small>这条旧记录缺少可靠的请求关联。不按时间或最近一条用户消息猜测归属，也不丢弃正文。</small></article>' : ""}
    ${followupTurns(device)}
  </div>`;
}
function composer(device) {
  const value = draft();
  const stop = !value.text.trim() && (["building", "decision"].includes(state.scene) || state.cancelRequested);
  return `<div class="composer-wrap">${value.reference ? `<div class="compose-reference">${icon("layers")}<span>关于「${getCard(value.reference).title}」</span><button data-action="remove-reference" aria-label="移除卡片引用">${icon("close")}</button></div>` : ""}
    <div class="composer glass"><textarea rows="1" maxlength="1000" data-draft data-focus="${device}-draft" aria-label="继续原始会话的草稿" placeholder="${state.offline ? "离线草稿，不会自动补发…" : value.reference ? "围绕这张卡片继续问…" : "继续这轮思路，发起新的请求…"}">${escapeText(value.text)}</textarea>
    <div class="composer-controls">${iconButton("plus", "attachments", "附件入口示意")}<button class="model-button" data-action="models">${icon("spark")}跟随原会话${icon("down")}</button><button class="compose-action ${stop ? "stop" : ""}" data-action="send" ${deviceAttrs(device)} aria-label="${stop ? "请求停止当前工作" : "发送模拟消息"}" ${state.offline || (!stop && !value.text.trim()) ? "disabled" : ""}>${icon(stop ? "stop" : "send")}</button></div></div>
    <div class="composer-note">${icon("lock")}<span>原会话排队处理 · 仅本地模拟</span></div></div>`;
}
function nativeFiles() {
  if (state.offline) return '<section class="native-file-content"><h3>内容访问暂不可用</h3><p>只有在线且原始运行时明确允许时才会展示文件与 Git 内容。</p></section>';
  return `<section class="native-file-content"><h3>${state.tab === "files" ? "项目文件" : "工作区变更"}</h3><p>只读示例。正式版遵守原会话的内容策略；这不是可编辑的 AgenticDeck 表格。</p>${state.tab === "files" ? ["SessionPane.kt", "Wire.kt", "README.md"].map((name) => `<button class="file-row" data-action="file-info">${icon("file")}${name}<small>只读</small></button>`).join("") : '<div class="diff-file"><div class="diff-header">Timeline.kt · 示意差异</div><div class="diff-lines"><div>  ReplyTurn {</div><div class="added">+   OrderedContentBlocks()</div><div>  }</div></div></div>'}</section>`;
}
function conversation(device) {
  return `<section class="native-chat" aria-label="当前原始会话"><header class="conversation-toolbar glass">
    ${device === "iphone" ? iconButton("left", "home", "返回工作台") : device === "ipad" ? iconButton("sidebar", "picker", "选择会话", "", "compact-only") : ""}
    <div class="conversation-title"><h3>${session().title}</h3><p>${branch()}<span class="state-tag ${state.offline ? "" : state.scene === "decision" ? "waiting" : "idle"}">${statusText()}</span></p></div>${device === "duo" ? "" : iconButton("more", "runtime", "查看原始会话信息")}</header>
    ${state.offline ? '<div class="connection-banner">离线示例 · 画布仍可查看，消息和决定不会发送。</div>' : ""}
    ${state.cancelRequested ? `<div class="connection-banner">取消已请求，等待运行时证据；后台子进程仍需在原始客户端核实。<button class="simulation-button" data-action="confirm-idle" ${state.offline ? "disabled" : ""}>模拟空闲回执</button></div>` : ""}
    <nav class="content-tabs" aria-label="会话内容"><button data-tab="chat" class="${state.tab === "chat" ? "active" : ""}">${icon("chat")}对话</button><button data-tab="files" class="${state.tab === "files" ? "active" : ""}">${icon("folder")}文件</button><button data-tab="git" class="${state.tab === "git" ? "active" : ""}">${icon("branch")}变更<span class="tab-readonly">只读</span></button></nav>
    ${state.tab === "chat" ? `${timeline(device)}${composer(device)}` : nativeFiles()}
  </section>`;
}

function reader(cardId, device) {
  const card = getCard(cardId);
  const view = viewFor(cardId);
  const chart = ["chart", "bar"].includes(card.kind);
  const full = modalReader(device);
  const content = chart ? `<div class="reader-controls"><div class="segmented-control" role="group" aria-label="查看时间范围">${[7, 14].map((days) => `<button data-action="range" data-range="${days}" ${deviceAttrs(device, card.id)} class="${view.range === days ? "active" : ""}" aria-pressed="${view.range === days}">${days} 天</button>`).join("")}</div>
    <div class="segmented-control" role="group" aria-label="显示方式">${[["chart", "图表"], ["data", "数据"]].map(([tab, label]) => `<button data-action="reader-tab" data-value="${tab}" ${deviceAttrs(device, card.id)} class="${view.tab === tab ? "active" : ""}" aria-pressed="${view.tab === tab}">${label}</button>`).join("")}</div></div>
    ${view.tab === "chart" ? renderCard(card, device, true) : `<article class="deck-card"><div class="deck-table-wrap"><table class="deck-table" aria-label="每日虚构任务数据"><thead><tr><th>日期</th><th>任务数</th><th>来源</th></tr></thead><tbody>${seriesFor(cardId).map((value, i) => `<tr><td>${dateFor(cardId, i)}</td><td>${value}</td><td>示例</td></tr>`).join("")}</tbody></table></div></article>`}
    <div class="reader-point-control"><button data-action="point-step" data-step="-1" ${deviceAttrs(device, cardId)} aria-label="上一日">${icon("left")}</button><input type="range" min="0" max="${seriesFor(cardId).length - 1}" value="${view.point}" data-point-slider="${cardId}" data-platform="${device}" data-focus="${device}-${cardId}-slider" aria-label="选择图表日期" aria-valuetext="${dateFor(cardId, view.point)}，${seriesFor(cardId)[view.point]} 项"><button data-action="point-step" data-step="1" ${deviceAttrs(device, cardId)} aria-label="下一日">${icon("right")}</button></div>
    <div class="reader-label">${icon("text")}读图提示</div><div class="reader-explainer"><strong>10/8 是示例后一周的高点。</strong><br>10 项对比 10/7 的 4 项，仅表示完成数量；原因需要更多上下文，不能据此判断工作质量。</div>`
    : card.kind === "table" ? `<label class="reader-search">${icon("search")}<input type="search" data-grid-search="${cardId}" data-focus="${device}-${cardId}-search" value="${escapeText(view.query)}" placeholder="筛选模块，例如 Android" aria-label="筛选模块"></label>${renderCard(card, device, true)}<p class="reader-data-note">范围固定为示例后一周，总计 48 项。搜索和排序只影响显示；不会修改单元格或底层数据。</p>`
    : renderCard(card, device, true);
  return `<aside class="canvas-reader ${device === "iphone" ? "phone-reader" : device === "ipad" ? state.ipadCompact ? "tablet-reader tablet-overlay" : "tablet-reader" : device === "duo" ? `duo-reader${full ? " duo-modal-reader" : ""}` : ""}" aria-label="${card.title}查看器" ${full ? 'role="dialog" aria-modal="true"' : ""} ${deviceAttrs(device)}>
    <header class="reader-titlebar ${full ? "modal-titlebar" : "glass"}">${full ? '<span class="reader-title-spacer" aria-hidden="true"></span>' : ""}<h3>${card.title}</h3>${iconButton("close", "close-reader", "关闭画布查看器", deviceAttrs(device), full ? "glass reader-dismiss" : "")}</header>
    <div class="reader-origin">${icon("turn")}<span class="reader-source"><small>AgenticDeck · 只读查看器</small><span>来自第 ${card.turn.split("-")[1]} 轮 · 同一内容块</span></span><button data-action="origin" ${deviceAttrs(device, cardId)}>查看来源回复</button></div>
    ${state.offline ? '<div class="connection-banner">离线缓存示例 · 仍可筛选和查看</div>' : ""}
    <div class="reader-scroll" data-scroll="${device}-reader-${cardId}"><nav class="reader-card-index" aria-label="本会话画布内容">${renderedCards().map((item) => `<button data-action="open-card" ${deviceAttrs(device, item.id)} class="${item.id === cardId ? "active" : ""}" aria-pressed="${item.id === cardId}">${item.short}</button>`).join("")}</nav>${content}
    <p class="reader-data-note">${icon("lock")} 已生成内容只读。后续改图会追加新卡片，不覆盖这张卡片。</p></div>
    <footer class="reader-footer"><button data-action="ask-card" ${deviceAttrs(device, cardId)}>${icon("chat")}围绕这张卡片提问</button><small>${state.offline ? "可以写草稿，联网前不会发送" : "仅添加引用草稿，不会立即发送"}</small></footer>
  </aside>`;
}
function duoRail(modal) {
  return `<aside class="duo-side-area" aria-label="右侧系统与应用导航">
    <div class="duo-system" aria-hidden="true">${compactDuo() ? '<span class="duo-camera"></span>' : '<span class="duo-camera-space"></span>'}<strong>9:41</strong><div>${icon("wifi")}<span class="battery"></span></div></div>
    <div class="duo-side-controls" ${modal ? "inert" : ""}>
      <nav class="duo-tools glass" aria-label="会话工具">${compactDuo() && state.duoPage === "chat" ? iconButton("left", "home", "返回工作台", deviceAttrs("duo")) : iconButton("sidebar", "picker", "选择会话", deviceAttrs("duo"))}
        ${iconButton("plus", "pair", "连接 Dev Box", deviceAttrs("duo"))}${iconButton("info", "runtime", "查看原始会话信息", deviceAttrs("duo"))}</nav>
      <nav class="duo-tabs glass" aria-label="应用导航"><button class="active" data-action="home" data-platform="duo">${icon("grid")}<span>工作台</span></button><button data-action="decision-scene" data-platform="duo">${icon("inbox")}<span>待处理</span><span class="duo-badge">1</span></button><button data-action="settings" data-platform="duo">${icon("settings")}<span>设置</span></button></nav>
    </div><span class="duo-home-indicator" aria-hidden="true"></span>
  </aside>`;
}
function duoDevice() {
  const cardId = state.viewer.duo;
  const modal = compactDuo() && cardId;
  return `<div class="duo-shell deck-native" data-platform="duo" data-pose="${state.duoPose}">
    <div class="duo-body" ${modal ? "inert" : ""}>${compactDuo()
      ? state.duoPage === "home" ? home("duo") : conversation("duo")
      : `${cardId ? conversation("duo") : sessionList("duo")}<div class="duo-fold" aria-hidden="true"></div>${cardId ? reader(cardId, "duo") : conversation("duo")}`}</div>
    ${duoRail(modal)}${modal ? reader(cardId, "duo") : ""}
  </div>`;
}
function renderDevice(device) {
  const cardId = state.viewer[device];
  if (device === "duo") return duoDevice();
  if (device === "iphone") return `<div class="phone-app deck-native" ${deviceAttrs(device)}>${phoneStatus()}<div class="phone-layer" ${cardId ? "inert" : ""}>${state.phonePage === "home" ? home(device) : conversation(device)}${phoneTabs()}</div>${cardId ? reader(cardId, device) : ""}</div>`;
  const modal = device === "ipad" && state.ipadCompact && cardId;
  return `<div class="window-app deck-native" ${deviceAttrs(device)}>${windowHeader(device)}<div class="window-body" ${modal ? "inert" : ""}>${device === "mac" ? sidebar() : ""}${cardId ? "" : sessionList(device)}${conversation(device)}${cardId && !modal ? reader(cardId, device) : ""}</div>${modal ? reader(cardId, device) : ""}</div>`;
}

function fitDevices() {
  for (const device of previewDevices) {
    const mount = document.querySelector(`[data-mount="${device}"]`);
    const hardware = document.querySelector(`[data-hardware="${device}"]`);
    const [width, height] = device === "iphone" ? [390, 852] : device === "ipad" ? [state.ipadCompact ? 600 : 1080, 760] : device === "duo" ? [duoPoses[state.duoPose].width, duoPoses[state.duoPose].height] : [1180, 784];
    const scale = Math.min(1, mount.clientWidth / width);
    hardware.style.width = `${width}px`;
    hardware.style.height = `${height}px`;
    hardware.style.transform = `translateX(${-width * scale / 2}px) scale(${scale})`;
    if (device === "duo") hardware.dataset.pose = state.duoPose;
    mount.style.height = `${height * scale}px`;
  }
}
function jumpToTurnContent(device, turnId, target) {
  const root = document.querySelector(`#${device}-screen`);
  const reply = root.querySelector(`[data-turn="${turnId}"]`);
  const node = reply?.querySelector(`[data-object="${target}"], [data-anchor="${target}"]`);
  const scroll = node?.closest(".turn-timeline");
  if (!scroll) return;
  const hardware = document.querySelector(`[data-hardware="${device}"]`);
  const scale = hardware.getBoundingClientRect().width / hardware.offsetWidth;
  if (!scale) return;
  scroll.scrollTop += (node.getBoundingClientRect().top - scroll.getBoundingClientRect().top) / scale - 9;
}
function updateUrl() {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries({ device: state.device, scene: state.scene, theme: state.theme })) url.searchParams.set(key, value);
  if (state.offline) url.searchParams.set("offline", "1"); else url.searchParams.delete("offline");
  if (state.reduced) url.searchParams.set("transparency", "reduced"); else url.searchParams.delete("transparency");
  if ((state.device === "duo" ? state.duoPage : state.phonePage) === "home") url.searchParams.set("screen", "home"); else url.searchParams.delete("screen");
  url.searchParams.set("pose", state.duoPose);
  if (state.ipadCompact) url.searchParams.set("narrow", "1"); else url.searchParams.delete("narrow");
  const inspected = state.device === "all" ? "iphone" : state.device;
  if (state.viewer[inspected]) url.searchParams.set("reader", "1"); else url.searchParams.delete("reader");
  history.replaceState(null, "", url);
}
function updateState() {
  document.querySelector("#state-summary").textContent = `原型状态 · Apple 客户端 / ${sceneNames[state.scene]} / ${state.device}${state.device === "duo" ? ` · ${duoPoses[state.duoPose].label}` : ""} / ${state.offline ? "离线" : "模拟在线"} · 所有数据为虚构示例`;
  document.querySelector("#state-output").textContent = JSON.stringify({
    prototype: true, network: "disabled", persistence: "none", renderer: "original HTML/SVG, not AgenticDeck",
    ...state, dialog: state.dialog?.kind ?? null, originalCardIds: originalCards.map((card) => card.id),
    visibleCardIds: renderedCards().map((card) => card.id), originalData: { previousWeek, currentWeek, modules },
    readingMode: "Chronological; only explicit card actions navigate to their own source reply.",
    duo: { sizeClass: compactDuo() ? "compact" : "regular", controls: "trailing vertical", foldReserved: state.duoPose === "book", hardwareDimensions: "illustrative, not official specifications" },
    turnRule: "Independent requests start turns; answers/permissions stay in their existing turn; unknown provenance is not guessed.",
  }, null, 2);
}
function filterSessions() {
  for (const element of document.querySelectorAll("[data-session-row]")) {
    const item = sessions.find((s) => s.id === element.dataset.sessionRow);
    element.hidden = !`${item.title} ${item.branch} DevPocket Studio Dev Box`.toLowerCase().includes(state.search.toLowerCase());
  }
  document.querySelectorAll(".no-results").forEach((element) => { element.hidden = [...element.parentElement.querySelectorAll("[data-session-row]")].some((row) => !row.hidden); });
}
function render() {
  const active = document.activeElement;
  const focus = active?.dataset.focus;
  const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && ["text", "search"].includes(active.type) ? [active.selectionStart, active.selectionEnd] : null;
  document.querySelectorAll("[data-scroll]").forEach((element) => { if (element.clientWidth) positions.set(element.dataset.scroll, element.scrollTop); });
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.transparency = state.reduced ? "reduced" : "regular";
  document.querySelector("#design-board").dataset.view = state.device;
  document.querySelector("#scene").value = state.scene;
  document.querySelector("#theme-button").innerHTML = icon(state.theme === "light" ? "moon" : "sun");
  document.querySelector("#theme-button").setAttribute("aria-pressed", String(state.theme === "dark"));
  document.querySelector("#offline-button").innerHTML = icon(state.offline ? "offline" : "wifi");
  document.querySelector("#offline-button").setAttribute("aria-pressed", String(state.offline));
  document.querySelector("#transparency-button").innerHTML = icon("layers");
  document.querySelector("#transparency-button").setAttribute("aria-pressed", String(state.reduced));
  document.querySelector("#ipad-size-button").textContent = state.ipadCompact ? "恢复宽窗口 ↗" : "试试窄窗口 ↗";
  document.querySelector("#ipad-size-button").setAttribute("aria-pressed", String(state.ipadCompact));
  document.querySelectorAll("[data-device]").forEach((element) => element.setAttribute("aria-pressed", String(element.dataset.device === state.device)));
  document.querySelectorAll("[data-action='duo-pose']").forEach((element) => {
    element.setAttribute("aria-pressed", String(element.dataset.pose === state.duoPose));
    element.classList.toggle("active", element.dataset.pose === state.duoPose);
  });
  document.querySelector("#duo-pose-description").textContent = duoPoses[state.duoPose].description;
  for (const device of previewDevices) document.querySelector(`#${device}-screen`).innerHTML = renderDevice(device);
  fitDevices();
  document.querySelectorAll("[data-scroll]").forEach((element) => {
    if (positions.has(element.dataset.scroll)) element.scrollTop = positions.get(element.dataset.scroll);
  });
  filterSessions();
  const demoDevice = state.device === "all" ? "iphone" : state.device;
  const homeVisible = demoDevice === "duo" ? state.duoPage === "home" : state.phonePage === "home";
  document.querySelectorAll("#prototype-switcher > button").forEach((element) => element.classList.toggle("active", element.dataset.action === (state.viewer[demoDevice] ? "demo-reader" : homeVisible ? "demo-home" : "demo-chat")));
  updateUrl();
  updateState();
  if (focus && !document.querySelector("#prototype-dialog").open) {
    const replacement = [...document.querySelectorAll("[data-focus]")].find((element) => element.dataset.focus === focus && element.getBoundingClientRect().width);
    replacement?.focus({ preventScroll: true });
    if (selection && replacement?.setSelectionRange) replacement.setSelectionRange(...selection);
  }
}
function announce(text) {
  const toast = document.querySelector("#toast");
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4300);
}
function closeDialog() {
  document.querySelector("#prototype-dialog").close();
  state.dialog = null;
}
function dialog(kind, data = "") {
  state.dialog = { kind, data };
  const heading = (title) => `<span class="dialog-icon">${icon(kind === "permission" ? "shield" : "layers")}</span><h2 id="dialog-title">${title}</h2>`;
  const done = '<div class="dialog-actions"><button class="primary" data-action="close-dialog">知道了</button></div>';
  let html;
  if (kind === "about" || kind === "sources") html = `${heading("沿着对话，自然阅读。")}
    <p>流光工作台面向 iPhone、iPad、Mac 与 iPhone Duo。导航使用轻量玻璃材质，文字、代码与画布内容保持清晰的实色表面。</p>
    <div class="dialog-list"><div>${icon("turn")}<p><strong>顺序阅读，可靠归组</strong>文字、工具活动、画布和结论按顺序展示，不设置含糊的轮次导航或预设追问。审批与问题回应留在所属请求内，归属不明的历史独立显示。</p></div><div>${icon("layers")}<p><strong>画布与来源关联</strong>展开、收起和查看来源回复都绑定所选内容。全屏查看器只保留一个关闭按钮；关闭时保留阅读位置和草稿。</p></div><div>${icon("append")}<p><strong>只读查看，追加新内容</strong>排序、筛选与时间范围只改变显示。围绕卡片提问先添加引用，不自动发送；后续改图追加新卡片，不覆盖旧图。</p></div></div>
    <div class="dialog-callout"><strong>原型不等于原生实现</strong>本页仅使用本地虚构数据，不连接 SDK 或真实会话。原生客户端应复用仓库已有的组件协议与 packages/components 数据契约；这里的模拟回执、缓存和状态归组不是生产代码。<br>本次不实现自定义折叠或展开转场动画。</div>
    <p><button class="footer-link" data-action="duo-info">查看 iPhone Duo 布局依据与范围</button></p>
    <p>SwiftUI 原生材质、VoiceOver、键盘、真实会话同步、持久化与 APNs 均需要实施端分别实现和验证。</p>${done}`;
  else if (kind === "duo-info") html = `${heading("展开的是空间，思路保持连续。")}
    <p>依据 Apple 当前的 iPhone Duo 设计指南，外屏使用紧凑布局，内屏横向使用分栏；工具栏、导航和状态区沿右侧排列，不把普通 iPhone 界面直接拉宽。</p>
    <div class="dialog-list"><div>${icon("sidebar")}<p><strong>收起与展开保持同一状态</strong>会话选择、草稿、画布引用与筛选不因姿态改变而重置；外屏查看器仍然只有一个关闭按钮。</p></div><div>${icon("layers")}<p><strong>半折时避开中间区域</strong>书本式预览在两侧安排正文和交互控件。原生实现应使用自适应导航与系统 reserved regions，而不是照搬这里的 CSS 尺寸。</p></div></div>
    <div class="dialog-callout">此轮只展示外屏、完全展开的内屏横向、书本式半折。机身比例和预留区域是示意，不是官方硬件规格。内屏竖向、桌面姿态、双应用分屏、键盘和系统弹窗仍需原生设计与验证。</div>
    <p><a href="https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo" target="_blank" rel="noreferrer">Apple · Designing for iPhone Duo</a><br><a href="https://developer.apple.com/videos/play/tech-talks/111466/" target="_blank" rel="noreferrer">Apple · Design for iPhone Duo</a><br>查阅日期：2026-10-23</p>${done}`;
  else if (kind === "picker") html = `${heading("继续哪段会话？")}${sessionSearch("dialog-session-search")}<div class="dialog-list">${sessions.map((item) => sessionRow(item, state.activeDevice)).join("")}</div><p class="no-results" hidden>没有匹配的会话</p>`;
  else if (kind === "permission") html = `${heading(data === "approve" ? "只允许这一次？" : "拒绝这次操作？")}<p>此决定属于第 2 轮原始请求，不会改变权限模式。请核对工具提供的内容，组织策略仍由原始运行时执行。</p><div class="command-block">${icon("terminal")}<code>npm run typecheck</code></div><div class="dialog-callout">DevPocket · feature/mobile-polish<br>本页只模拟回执，不会执行命令。</div><div class="dialog-actions"><button data-action="close-dialog">取消</button><button class="primary" data-action="submit-permission" data-decision="${data}">${data === "approve" ? "允许一次" : "拒绝"} · 模拟</button></div>`;
  else if (kind === "stop") html = `${heading("请求停止当前工作？")}<p>运行时会收到取消请求，并可能清空排队输入。收到请求确认不等于任务或后台子进程已经停止。</p><div class="dialog-actions"><button data-action="close-dialog">继续运行</button><button class="destructive" data-action="submit-stop">请求停止 · 模拟</button></div>`;
  else if (kind === "settings") html = `${heading("你的 DevPocket")}<button class="settings-row" data-action="theme">${icon("moon")}<span>深色外观</span><span class="toggle ${state.theme === "dark" ? "on" : ""}"></span></button><button class="settings-row" data-action="transparency">${icon("layers")}<span>减少透明度</span><span class="toggle ${state.reduced ? "on" : ""}"></span></button><button class="settings-row" data-action="pair">${icon("monitor")}<span>连接 Dev Box</span>${icon("right")}</button><div class="dialog-callout">只影响本页。后台提醒需要单独设计 APNs，不继承 Android 常驻服务的行为。</div>${done}`;
  else if (kind === "runtime") html = `${heading("始终是原来的会话")}<p>${session().title}</p><div class="dialog-callout"><strong>Studio Dev Box · Windows · 示例</strong>原始客户端：GitHub Copilot App<br>分支：${session().branch}<br>权限模式：手动（只读）<br>会话：demo-${state.selected}</div><p>不创建、克隆或恢复替代运行时。文件与 Git 只读。原型中的图表与排序不会对原会话执行工具操作。</p>${done}`;
  else if (kind === "pair") html = `${heading("连接你的 Dev Box")}<p>正式流程使用管理员提供的 HTTPS 中转地址与五分钟一次性配对码。客户端不需要登录 GitHub。</p><div class="dialog-callout">这里只展示流程，不输入真实凭据、不进行配对、不访问其他设备。</div>${done}`;
  else if (kind === "models") html = `${heading("模型来自原始会话")}<p>模型与推理选项只能来自实时能力目录。本原型不硬编码支持清单，不切换模型，也不改动组织策略。</p>${done}`;
  else if (kind === "attachments") html = `${heading("附件与上下文")}<p>正式版使用系统文件选择器。沿用现有协议限制：每个附件不超过 2 MiB，每条消息最多 4 个。</p><div class="dialog-callout">此原型不读取或上传文件。正式版发送卡片引用时，由桥接端验证同会话的卡片及摘要，并将安全内容作为私有附件交给原始运行时；它占用一个附件位置。</div>${done}`;
  else if (kind === "fallback-info") html = `${heading("失败，不隐藏在漂亮卡片里")}<p>开始生成、生成成功、不可展示分别显示。未知格式或未通过校验的内容不执行，普通文字和已知归属仍保留。</p><div class="dialog-callout">这里只演示降级外观；没有把任意 HTML、JavaScript 或原始工具参数当作画布转发。</div>${done}`;
  else if (kind === "file-info") html = `${heading("只读文件示例")}<p>这里不读取真实文件。生产版只有在原始运行时明确允许内容访问后才能提供文件与 Git 预览；它们与 AgenticDeck 表格是不同对象。</p>${done}`;
  else throw new Error(`Unknown prototype dialog: ${kind}`);
  document.querySelector("#dialog-content").innerHTML = html;
  document.querySelector(".dialog-chrome button").innerHTML = icon("close");
  if (!document.querySelector("#prototype-dialog").open) document.querySelector("#prototype-dialog").showModal();
  filterSessions();
  updateState();
}
function focusReader(device) {
  document.querySelector(`#${device}-screen .canvas-reader [data-action="close-reader"]`)?.focus({ preventScroll: true });
}
function changeDuoPose(pose) {
  const anchors = [];
  const hardware = document.querySelector('[data-hardware="duo"]');
  const scale = hardware.getBoundingClientRect().width / hardware.offsetWidth;
  if (scale) {
    for (const scroll of document.querySelectorAll("#duo-screen .turn-timeline, #duo-screen .reader-scroll")) {
      const bounds = scroll.getBoundingClientRect();
      const node = [...scroll.querySelectorAll("[data-object], [data-anchor]")].find((element) =>
        !element.querySelector("[data-object], [data-anchor]") && element.getBoundingClientRect().bottom > bounds.top && element.getBoundingClientRect().top < bounds.bottom);
      if (node) anchors.push({
        scroll: scroll.dataset.scroll, object: node.dataset.object, anchor: node.dataset.anchor,
        turn: node.closest("[data-turn]")?.dataset.turn, offset: (node.getBoundingClientRect().top - bounds.top) / scale,
      });
    }
  }
  state.duoPose = pose;
  render();
  const newScale = hardware.getBoundingClientRect().width / hardware.offsetWidth;
  if (newScale) for (const anchor of anchors) {
    const scroll = [...document.querySelectorAll("#duo-screen [data-scroll]")].find((element) => element.dataset.scroll === anchor.scroll);
    const parent = anchor.turn ? scroll?.querySelector(`[data-turn="${anchor.turn}"]`) : scroll;
    const node = parent?.querySelector(anchor.object ? `[data-object="${anchor.object}"]` : `[data-anchor="${anchor.anchor}"]`);
    if (node) scroll.scrollTop += (node.getBoundingClientRect().top - scroll.getBoundingClientRect().top) / newScale - anchor.offset;
  }
}
function updateDraft(text, source) {
  draft().text = text;
  document.querySelectorAll("[data-draft]").forEach((element) => { if (element !== source) element.value = text; });
  const stop = !text.trim() && (["building", "decision"].includes(state.scene) || state.cancelRequested);
  document.querySelectorAll('[data-action="send"]').forEach((element) => {
    element.disabled = state.offline || (!stop && !text.trim());
    element.classList.toggle("stop", stop);
    element.innerHTML = icon(stop ? "stop" : "send");
    element.setAttribute("aria-label", stop ? "请求停止当前工作" : "发送模拟消息");
  });
  updateState();
}
function send(device) {
  if (state.offline) return;
  if (!draft().text.trim()) {
    if (["building", "decision"].includes(state.scene) || state.cancelRequested) dialog("stop");
    return;
  }
  const number = Math.max(nextTurn, ["ordinary", "archive"].includes(state.selected) ? 4 : 3);
  nextTurn = number + 1;
  state.followups.push({ id: `turn-${number}`, number, session: state.selected, text: draft().text.trim(), reference: draft().reference, status: "admitted", card: null });
  draft().text = "";
  draft().reference = null;
  render();
  const element = document.querySelector(`#${device}-screen .turn-timeline`);
  if (element) element.scrollTop = element.scrollHeight;
  announce("本地模拟：新的独立请求已接收，尚未确认执行。");
}
document.addEventListener("click", (event) => {
  const element = event.target instanceof Element ? event.target.closest("[data-action], [data-device], [data-tab]") : null;
  if (!element || element.disabled) return;
  const device = element.dataset.platform ?? element.closest("[data-platform]")?.dataset.platform ?? state.activeDevice;
  state.activeDevice = device;
  if (element.dataset.device) { state.device = element.dataset.device; if (state.device !== "all") state.activeDevice = state.device; render(); return; }
  if (element.dataset.tab) { state.tab = element.dataset.tab; render(); return; }
  const action = element.dataset.action;
  const id = element.dataset.content;
  if (action === "close-dialog") return closeDialog();
  if (action === "duo-pose") {
    state.activeDevice = "duo";
    changeDuoPose(element.dataset.pose);
    if (compactDuo() && state.viewer.duo) focusReader("duo");
    return;
  }
  if (action === "theme" || action === "transparency" || action === "offline") {
    if (action === "theme") state.theme = state.theme === "light" ? "dark" : "light";
    if (action === "transparency") state.reduced = !state.reduced;
    if (action === "offline") state.offline = !state.offline;
    render();
    if (state.dialog?.kind === "settings") dialog("settings");
    return;
  }
  if (action === "session") {
    const item = sessions.find((s) => s.id === element.dataset.session);
    applyScene(item.scene); state.search = ""; closeDialog(); render(); return;
  }
  if (action === "home" || action === "demo-home") {
    if (device === "duo" || action === "demo-home" && state.device === "all") { state.duoPage = "home"; state.viewer.duo = null; }
    if (device !== "duo" || action === "demo-home" && state.device === "all") { state.phonePage = "home"; state.viewer.iphone = null; }
    render(); return;
  }
  if (action === "demo-chat") { applyScene("visual"); state.phonePage = "chat"; render(); return; }
  if (action === "decision-scene") { applyScene("decision"); render(); return; }
  if (action === "demo-reader") {
    applyScene("visual");
    for (const platform of state.device === "all" ? previewDevices : [state.device]) state.viewer[platform] = "trend";
    render(); return;
  }
  if (action === "ipad-size") { state.ipadCompact = !state.ipadCompact; render(); return; }
  if (action === "sidebar") { state.sidebar = !state.sidebar; render(); return; }
  if (action === "toggle-reader") {
    if (!["visual", "append"].includes(state.scene)) return announce("当前示例没有已确认生成的画布。");
    state.viewer[device] = state.viewer[device] ? null : "trend"; render(); return;
  }
  if (action === "open-card") { state.viewer[device] = id; render(); focusReader(device); return; }
  if (action === "close-reader") {
    const previous = state.viewer[device]; state.viewer[device] = null; render();
    document.querySelector(`#${device}-screen [data-action="open-card"][data-content="${previous}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (action === "origin") {
    state.tab = "chat"; state.phonePage = "chat"; state.duoPage = "chat"; state.collapsedCanvas = false;
    if (modalReader(device)) state.viewer[device] = null;
    if (getCard(id).kind === "text" && !state.expandedText.includes(id)) state.expandedText.push(id);
    render(); jumpToTurnContent(device, getCard(id).turn, id); return;
  }
  if (action === "canvas-toggle") {
    state.collapsedCanvas = !state.collapsedCanvas;
    render(); jumpToTurnContent(device, element.dataset.originTurn, "canvas"); return;
  }
  if (action === "copy-toggle") {
    state.expandedText = state.expandedText.includes(id) ? state.expandedText.filter((value) => value !== id) : [...state.expandedText, id];
    render(); return;
  }
  if (action === "range") { viewFor(id).range = Number(element.dataset.range); viewFor(id).point = viewFor(id).range === 7 ? 3 : 10; render(); return; }
  if (action === "reader-tab") { viewFor(id).tab = element.dataset.value; render(); return; }
  if (action === "sort") { viewFor(id).descending = !viewFor(id).descending; render(); return; }
  if (action === "point-step") {
    const view = viewFor(id); view.point = Math.max(0, Math.min(seriesFor(id).length - 1, view.point + Number(element.dataset.step))); render(); return;
  }
  if (action === "plot") {
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 426;
    viewFor(id).point = Math.max(0, Math.min(seriesFor(id).length - 1, Math.round((x - 28) / 370 * (seriesFor(id).length - 1))));
    render(); return;
  }
  if (action === "ask-card") {
    draft().reference = id;
    state.tab = "chat"; state.phonePage = "chat"; state.duoPage = "chat";
    if (device !== "mac" && !(device === "duo" && !compactDuo())) state.viewer[device] = null;
    render(); document.querySelector(`#${device}-screen [data-draft]`)?.focus({ preventScroll: true });
    announce("已将卡片引用放进草稿；尚未发送。"); return;
  }
  if (action === "remove-reference") { draft().reference = null; render(); return; }
  if (action === "send") return send(device);
  if (action === "finish-followup") {
    if (state.offline) return;
    const turn = state.followups.find((item) => item.id === element.dataset.turn);
    if (turn.status !== "admitted") return;
    turn.status = "completed";
    if (turn.session === "analysis" && turn.text.includes("柱状")) {
      const newId = `trend-${turn.number}`;
      turn.card = Object.freeze({ id: newId, kind: "bar", title: "任务完成趋势 · 柱状图", turn: turn.id, short: "新图" });
      state.views[newId] = { range: 14, point: 10, tab: "chart", query: "", descending: true };
    }
    render(); const timeline = document.querySelector(`#${device}-screen .turn-timeline`); if (timeline) timeline.scrollTop = timeline.scrollHeight;
    announce("已显示预设演示结果；旧卡片和原数据保持不变。"); return;
  }
  if (action === "finish-building") {
    if (state.offline) return announce("离线时不能模拟新的成功结果。");
    state.scene = "visual"; render(); jumpToTurnContent(device, "turn-2", "canvas"); return;
  }
  if (action === "answer-choice") { state.request.answer = element.dataset.choice; render(); return; }
  if (action === "submit-answer") { if (state.offline || !state.request.answer) return; state.request.answerStatus = "submitted"; render(); return; }
  if (action === "confirm-answer") { if (state.offline) return; state.request.answerStatus = "confirmed"; render(); return; }
  if (action === "permission") return dialog("permission", element.dataset.decision);
  if (action === "submit-permission") {
    if (state.offline || state.request.permission !== "pending") return;
    state.request.permission = "submitted"; state.request.decision = element.dataset.decision; closeDialog(); render(); return;
  }
  if (action === "confirm-permission") { if (state.offline) return; state.request.permission = "confirmed"; render(); return; }
  if (action === "submit-stop") { if (state.offline) return; state.cancelRequested = true; closeDialog(); render(); return; }
  if (action === "confirm-idle") { if (state.offline) return; state.cancelRequested = false; applyScene("plain"); render(); announce("模拟收到空闲回执；没有停止真实任务或后台进程。"); return; }
  dialog(action);
});
document.addEventListener("input", (event) => {
  const element = event.target;
  if (element.matches("[data-draft]")) updateDraft(element.value, element);
  if (element.matches("[data-session-search]")) {
    state.search = element.value;
    document.querySelectorAll("[data-session-search]").forEach((input) => { if (input !== element) input.value = state.search; });
    filterSessions(); updateState();
  }
  if (element.dataset.gridSearch) { viewFor(element.dataset.gridSearch).query = element.value; render(); }
  if (element.dataset.pointSlider) {
    const id = element.dataset.pointSlider;
    viewFor(id).point = Number(element.value);
    element.setAttribute("aria-valuetext", `${dateFor(id, viewFor(id).point)}，${seriesFor(id)[viewFor(id).point]} 项`);
    updateState();
  }
});
document.addEventListener("change", (event) => {
  if (event.target.matches("[data-point-slider]")) render();
});
document.querySelector("#scene").addEventListener("change", (event) => { applyScene(event.target.value); render(); });
document.addEventListener("keydown", (event) => {
  if (document.querySelector("#prototype-dialog").open) return;
  const element = event.target;
  const platform = element.closest?.("[data-platform]")?.dataset.platform ?? state.activeDevice;
  if (event.key === "Escape" && state.viewer[platform]) { state.viewer[platform] = null; render(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); dialog("picker"); document.querySelector("#dialog-content input").focus(); return; }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && element.matches("[data-draft]") && !event.isComposing) {
    event.preventDefault();
    if (draft().text.trim()) send(platform);
    return;
  }
  const overlay = element.closest?.('.canvas-reader[aria-modal="true"]');
  if (overlay && event.key === "Tab") {
    const controls = [...overlay.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')].filter((control) => control.getBoundingClientRect().width > 0);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if (element.matches?.(".trend-plot") && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault(); const id = element.dataset.content;
    viewFor(id).point = Math.max(0, Math.min(seriesFor(id).length - 1, viewFor(id).point + (event.key === "ArrowLeft" ? -1 : 1)));
    render();
  }
});
document.querySelector("#prototype-dialog").addEventListener("close", () => { state.dialog = null; updateState(); });
window.addEventListener("popstate", () => location.reload());
document.querySelectorAll("[data-icon]").forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
document.querySelector("#prototype-switcher").hidden = !(location.protocol === "file:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));
const resizeObserver = new ResizeObserver(fitDevices);
document.querySelectorAll(".device-mount").forEach((element) => resizeObserver.observe(element));
render();
