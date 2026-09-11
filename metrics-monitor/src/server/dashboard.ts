/**
 * Built-in dashboard (single page, zero dependencies, hand-rolled SVG charts).
 * Served at `GET /` by the metrics server; data comes from `/api/v1/overview`.
 */

export function dashboardHtml(): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI 能效管理平台 · metrics-monitor</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #21262d; --text: #e6edf3;
    --muted: #8b949e; --accent: #4c8dff; --green: #3fb950; --red: #f85149;
    --orange: #d29922; --purple: #a371f7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 24px;
           border-bottom: 1px solid var(--border); background: var(--panel); flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header h1 span { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 8px; }
  .controls { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  select { background: var(--bg); color: var(--text); border: 1px solid var(--border);
           border-radius: 6px; padding: 5px 8px; font-size: 13px; }
  .refresh-note { color: var(--muted); font-size: 12px; }
  main { padding: 20px 24px 40px; max-width: 1280px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .label { color: var(--muted); font-size: 12px; }
  .card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .card .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .panel h2 { font-size: 13px; margin: 0 0 10px; color: var(--muted); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar-cell { position: relative; min-width: 120px; }
  .bar-cell .bar { height: 6px; border-radius: 3px; background: var(--accent); opacity: .8; }
  .empty { color: var(--muted); text-align: center; padding: 30px 0; }
  .rate-ok { color: var(--green); } .rate-mid { color: var(--orange); } .rate-low { color: var(--red); }
  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 20px; }
  svg text { fill: var(--muted); font-size: 10px; }
</style>
</head>
<body>
<header>
  <h1>AI 能效管理平台 <span>metrics-monitor</span></h1>
  <div class="controls">
    <label class="refresh-note" id="updated"></label>
    <select id="window">
      <option value="1">今日</option>
      <option value="7" selected>近 7 天</option>
      <option value="30">近 30 天</option>
      <option value="90">近 90 天</option>
    </select>
    <select id="tool"><option value="">全部工具</option></select>
  </div>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div class="grid">
    <div class="panel"><h2>每日 Token 消耗量</h2><div id="chart-tokens"></div></div>
    <div class="panel"><h2>每日活跃用户数</h2><div id="chart-users"></div></div>
    <div class="panel"><h2>每日成本（USD）</h2><div id="chart-cost"></div></div>
    <div class="panel"><h2>每日采纳率</h2><div id="chart-adoption"></div></div>
  </div>
  <div class="grid">
    <div class="panel"><h2>按工具</h2><div id="table-tools"></div></div>
    <div class="panel"><h2>按用户</h2><div id="table-users"></div></div>
  </div>
  <div class="grid">
    <div class="panel"><h2>按模型</h2><div id="table-models"></div></div>
    <div class="panel"><h2>数据接入状态</h2><div id="health"></div></div>
  </div>
</main>
<footer>metrics-monitor · 指标口径：活跃用户=窗口内有活动的去重用户；采纳率=接受次数/(接受+拒绝) · 推送/拉取双模接入</footer>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const fmt = (n) => {
  if (n == null || isNaN(n)) return "-";
  if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(1) + "k";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};
const pct = (r) => r == null ? "-" : (r * 100).toFixed(1) + "%";
const rateClass = (r) => r == null ? "" : r >= 0.6 ? "rate-ok" : r >= 0.3 ? "rate-mid" : "rate-low";

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function svgChart(container, series, opts) {
  // series: [{label, points:[{x,y}], color, kind:"line"|"bar"}]
  const width = 560, height = 180, padL = 46, padB = 22, padT = 8, padR = 8;
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  if (!xs.length) { container.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymax = Math.max(1, Math.max(...ys));
  const X = (x) => padL + (xmax === xmin ? 0 : ((x - xmin) / (xmax - xmin)) * (width - padL - padR));
  const Y = (y) => padT + (1 - y / ymax) * (height - padT - padB);
  const parts = [];
  for (let i = 0; i <= 3; i++) {
    const gy = padT + (i / 3) * (height - padT - padB);
    const gv = ymax * (1 - i / 3);
    parts.push('<line x1="'+padL+'" y1="'+gy+'" x2="'+(width-padR)+'" y2="'+gy+'" stroke="#21262d"/>');
    parts.push('<text x="'+(padL-6)+'" y="'+(gy+3)+'" text-anchor="end">'+fmt(gv)+'</text>');
  }
  for (const s of series) {
    if (s.kind === "bar") {
      for (const p of s.points) {
        const bw = Math.max(2, (width - padL - padR) / Math.max(1, s.points.length) - 2);
        parts.push('<rect x="'+(X(p.x)-bw/2)+'" y="'+Y(p.y)+'" width="'+bw+'" height="'+(height-padB-Y(p.y))+'" fill="'+s.color+'" rx="1"/>');
      }
    } else {
      const d = s.points.map((p, i) => (i ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
      parts.push('<path d="'+d+'" fill="none" stroke="'+s.color+'" stroke-width="1.6"/>');
      for (const p of s.points) parts.push('<circle cx="'+X(p.x)+'" cy="'+Y(p.y)+'" r="2" fill="'+s.color+'"/>');
    }
  }
  const labels = series[0].points;
  const every = Math.max(1, Math.ceil(labels.length / 6));
  labels.forEach((p, i) => {
    if (i % every === 0 || i === labels.length - 1)
      parts.push('<text x="'+X(p.x)+'" y="'+(height-6)+'" text-anchor="middle">'+String(p.label).slice(5)+'</text>');
  });
  container.innerHTML = '<svg viewBox="0 0 '+width+' '+height+'" style="width:100%">' + parts.join("") + "</svg>";
}

function barList(container, rows) {
  if (!rows.length) { container.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const max = Math.max(...rows.map((r) => r.value), 1);
  container.innerHTML = rows.map((r) =>
    '<table><tr><td style="width:120px">'+r.label+'</td>' +
    '<td class="bar-cell"><div class="bar" style="width:'+(r.value/max*100)+'%;background:'+(r.color||"var(--accent)")+'"></div></td>' +
    '<td class="num" style="width:90px">'+fmt(r.value)+(r.sub?' <span class="refresh-note">'+r.sub+"</span>":"")+'</td></tr></table>'
  ).join("");
}

function kpiCards(data) {
  const t = data.totals, cards = [
    { label: "日活跃用户 (DAU)", value: fmt(data.activeUsers.dau), sub: "WAU " + fmt(data.activeUsers.wau) + " · MAU " + fmt(data.activeUsers.mau) },
    { label: "Token 消耗量", value: fmt(t.tokens.total), sub: "输入 " + fmt(t.tokens.input) + " · 输出 " + fmt(t.tokens.output) },
    { label: "预估成本 (USD)", value: "$" + fmt(t.costUsd), sub: "缓存读 " + fmt(t.tokens.cache_read) },
    { label: "编辑采纳率", value: pct(data.adoption.rate), sub: data.adoption.total ? data.adoption.accepted + " / " + data.adoption.total + " 次决策" : "暂无决策数据" },
    { label: "LLM 请求数", value: fmt(t.requests), sub: "会话 " + fmt(t.sessions) },
    { label: "工具调用", value: fmt(t.toolCalls), sub: "错误 " + fmt(t.toolErrors) },
    { label: "AI 代码行数", value: fmt(t.locAdded), sub: "删除 " + fmt(t.locRemoved) },
    { label: "活跃时长", value: fmt(t.activeTimeSec) + "s", sub: "上报的活跃时间" },
  ];
  $("cards").replaceChildren(...cards.map((c) => {
    const value = el("div", { class: "value " + (c.label.includes("采纳率") ? rateClass(data.adoption.rate) : ""), text: c.value });
    return el("div", { class: "card" }, [
      el("div", { class: "label", text: c.label }), value, el("div", { class: "sub", text: c.sub }),
    ]);
  }));
}

function tables(data) {
  const toolRows = data.byTool.slice(0, 10);
  $("table-tools").innerHTML = toolRows.length ? '<table><tr><th>工具</th><th class="num">Tokens</th><th class="num">成本</th><th class="num">请求</th><th class="num">采纳率</th><th class="num">活跃用户</th></tr>' +
    toolRows.map((t) => '<tr><td>'+t.tool+'</td><td class="num">'+fmt(t.tokens)+'</td><td class="num">$'+fmt(t.costUsd)+'</td><td class="num">'+fmt(t.requests)+'</td><td class="num '+rateClass(t.adoptionRate)+'">'+pct(t.adoptionRate)+'</td><td class="num">'+fmt(t.activeUsers)+'</td></tr>').join("") + "</table>"
    : '<div class="empty">暂无数据</div>';

  const userRows = data.byUser.slice(0, 10);
  $("table-users").innerHTML = userRows.length ? '<table><tr><th>用户</th><th class="num">Tokens</th><th class="num">成本</th><th class="num">采纳率</th><th class="num">活跃天数</th></tr>' +
    userRows.map((u) => '<tr><td>'+u.user+'</td><td class="num">'+fmt(u.tokens)+'</td><td class="num">$'+fmt(u.costUsd)+'</td><td class="num '+rateClass(u.adoptionRate)+'">'+pct(u.adoptionRate)+'</td><td class="num">'+fmt(u.activeDays)+'</td></tr>').join("") + "</table>"
    : '<div class="empty">暂无数据</div>';

  const modelRows = data.byModel.slice(0, 10);
  $("table-models").innerHTML = modelRows.length ? '<table><tr><th>模型</th><th>工具</th><th class="num">Tokens</th><th class="num">成本</th><th class="num">请求</th></tr>' +
    modelRows.map((m) => '<tr><td>'+m.model+'</td><td>'+m.tool+'</td><td class="num">'+fmt(m.tokens)+'</td><td class="num">$'+fmt(m.costUsd)+'</td><td class="num">'+fmt(m.requests)+'</td></tr>').join("") + "</table>"
    : '<div class="empty">暂无数据</div>';
}

async function loadHealth() {
  try {
    const res = await fetch("/api/v1/health");
    const h = await res.json();
    $("health").innerHTML = '<table>' +
      '<tr><td>状态</td><td>'+(h.ok ? "正常" : "异常")+'</td></tr>' +
      '<tr><td>样本总数</td><td>'+fmt(h.sampleCount)+'</td></tr>' +
      '<tr><td>接入 agent</td><td>'+fmt(h.agentCount)+'</td></tr>' +
      '<tr><td>接入工具</td><td>'+(h.tools || []).join(", ")+'</td></tr>' +
      '<tr><td>最近写入</td><td>'+(h.lastWriteAt ? new Date(h.lastWriteAt).toLocaleString() : "-")+'</td></tr>' +
      '<tr><td>版本</td><td>'+h.version+'</td></tr></table>';
  } catch { $("health").innerHTML = '<div class="empty">无法获取</div>'; }
}

async function load() {
  const win = $("window").value;
  const tool = $("tool").value;
  const url = "/api/v1/overview?window=" + win + "d" + (tool ? "&tool=" + encodeURIComponent(tool) : "");
  const data = await (await fetch(url)).json();
  kpiCards(data);
  tables(data);
  const daily = data.daily;
  const mk = (key) => daily.map((d) => ({ x: Date.parse(d.date), y: d[key] || 0, label: d.date }));
  svgChart($("chart-tokens"), [{ label: "tokens", points: mk("tokens"), color: "#4c8dff", kind: "bar" }]);
  svgChart($("chart-users"), [{ label: "users", points: mk("activeUsers"), color: "#a371f7", kind: "line" }]);
  svgChart($("chart-cost"), [{ label: "cost", points: mk("costUsd"), color: "#d29922", kind: "bar" }]);
  svgChart($("chart-adoption"), [{ label: "rate", points: daily.map((d) => ({ x: Date.parse(d.date), y: (d.adoptionRate ?? 0) * 100, label: d.date })), color: "#3fb950", kind: "line" }]);
  $("chart-adoption").querySelectorAll("svg")[0]?.setAttribute("data-max", "100");
  $("updated").textContent = "更新于 " + new Date().toLocaleTimeString();
}

fetch("/api/v1/health").then((r) => r.json()).then((h) => {
  for (const t of h.tools || []) {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    $("tool").appendChild(opt);
  }
}).catch(() => {});

$("window").addEventListener("change", load);
$("tool").addEventListener("change", load);
load();
loadHealth();
setInterval(load, 30000);
</script>
</body>
</html>`;
}
