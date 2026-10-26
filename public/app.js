// ID AGENT · Curve Terminal 前端（无构建、原生 JS）
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const SUBS = '₀₁₂₃₄₅₆₇₈₉';

/* 持仓快照：放最前面，启动过程中（还没执行到持仓页代码）也能读 */
const HOLD = { data: null, open: new Set(), plats: new Set(['flap', 'four', 'gang', 'gwei']) };
const S = {
  tokens: new Map(), selected: null, detail: null, platform: 'four', listTab: 'curve', chips: new Set(),
  side: 'buy', amtMode: 'bnb', slippage: 35, selWallets: new Set(['big']), activeWallet: 'big',
  interval: 1, metric: 'mcap', bottomTab: 'trades', orders: [], logs: [], records: [], flow: [],
  wallets: [], positions: [], config: null, settings: {}, usage: {}, net: {}, block: 0, bnbUsd: 744, snipeCurve: [],
  hover: null, newTokens: new Set(), settingsPlat: 'four', mode: 'sim', baw: null,
  blk: { tokens: {}, devs: {} },
  rules: {},   // 单币规则：发射后领取 / 转出
  fav: (() => { try { return JSON.parse(localStorage.getItem('fav') || 'null') || { groups: ['默认'], items: {} }; } catch { return { groups: ['默认'], items: {} }; } })(),   // 收藏（服务器为准，本地先显示）   // 屏蔽列表（S.block 是区块高度）
};
const LIVE = () => S.mode === 'live';
const REAL = () => LIVE() && S.baw?.dryRun === false;   // LIVE_TRADE=1：手动订单会真实上链
const AUTH_OK = () => !LIVE() || S.baw?.auth?.state === 'ok';

/* ---------- 格式化 ---------- */
function sub(x, sig = 4) {
  if (!isFinite(x)) return '—';
  if (x === 0) return '0';
  if (Math.abs(x) >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (x >= 0.001) return x.toFixed(Math.max(4, sig + 1));
  const zeros = -Math.floor(Math.log10(x)) - 1;
  const digits = String(Math.round(x * 10 ** (zeros + sig))).slice(0, sig);
  return '0.0' + String(zeros).split('').map((d) => SUBS[d]).join('') + digits;
}
const K = (n, d = 2) => { const a = Math.abs(n); return a >= 1e9 ? (n / 1e9).toFixed(d) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(d) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(d) + 'K' : n.toFixed(d); };
const usd = (n) => (!n || !isFinite(n) ? '—' : Math.abs(n) < 0.01 ? '$' + sub(n) : '$' + K(n));
const bnb = (n, d = 4) => (n == null || !isFinite(n) ? '—' : n !== 0 && Math.abs(n) < 0.0001 ? sub(n) : n.toFixed(d));
const short = (a, h = 6, t = 4) => (a ? a.slice(0, h) + '…' + a.slice(-t) : '');
const age = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const hms = (ts) => new Date(ts).toTimeString().slice(0, 8);
const pctS = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 有图标就显示图片，加载失败时删掉图片、露出下面的文字占位
// 钱包列：有域名显示域名，鼠标悬停看完整地址，点击打开 bscscan
const NAMES = {}; let namesVer = -1;
const nameOf = (r) => r.name || NAMES[String(r.trader || '').toLowerCase()] || null;
setInterval(async () => { try { const j = await api(`/api/names?ver=${namesVer}`); if (j.names) { Object.assign(NAMES, j.names); namesVer = j.ver; } } catch { /* ignore */ } }, 3000);
// 自己的钱包（登录的 baw 地址，按地址比，不按域名字符串）：绿色 + 「我」；别人的 .ai 域名黄色；普通地址灰色
const myAddr = () => String(S.baw?.auth?.address || (LIVE() ? S.wallets[0]?.address : '') || '').toLowerCase();
const isMe = (a) => !!a && !!myAddr() && String(a).toLowerCase() === myAddr();
const whoHtml = (addr, name, a = 6, b = 4) => isMe(addr) ? `<b class="me">${esc(name || short(addr, a, b))}</b><i class="me-tag">我</i>` : name ? `<b class="y">${esc(name)}</b>` : `<span class="mono">${short(addr, a, b)}</span>`;
// 地址 / 域名：点击在新标签打开 GMGN 的地址页（点行的其他地方仍打开盈亏抽屉）
const gmgnWho = (addr, name, a = 6, b = 4) => /^0x[0-9a-fA-F]{40}$/.test(addr || '') ? `<a class="gm-addr" data-gmgn href="https://gmgn.ai/bsc/address/${esc(addr)}" target="_blank" rel="noopener noreferrer" title="在 GMGN 查看 ${esc(addr)}">${whoHtml(addr, name, a, b)}</a>` : whoHtml(addr, name, a, b);
document.addEventListener('click', (e) => { if (e.target.closest('a[data-gmgn]')) e.stopPropagation(); }, true);   /* 只打开链接，不再触发行点击 */
const traderHtml = (r, a = 6, b = 4) => !r.trader || !LIVE() ? short(r.trader, a, b)
  : gmgnWho(r.trader, nameOf(r), a, b);
// 头像：先在后台预加载，确认能打开才显示图片，否则一直用文字头像
// （列表每秒重画，直接放 <img> 的话加载失败的会一直闪空白方块）
const imgState = new Map();   // 原始地址 → 'ok' | 'bad' | 'loading'
const proxied = (src) => (/^https?:/i.test(src) ? '/api/img?u=' + encodeURIComponent(src) : src);
function probeImg(src) {
  imgState.set(src, 'loading');
  const i = new Image(); i.referrerPolicy = 'no-referrer';
  i.onload = () => { imgState.set(src, i.naturalWidth ? 'ok' : 'bad'); lastList = 0; scheduleRender(); };
  i.onerror = () => imgState.set(src, 'bad');
  i.src = proxied(src);
}
const logoImg = (t) => {
  const src = t.image || S.tokens.get(t.address)?.image; if (!src) return '';
  const st = imgState.get(src); if (!st) probeImg(src);
  return st === 'ok' ? `<img src="${esc(proxied(src))}" alt="" decoding="async" referrerpolicy="no-referrer">` : '';
};
const logoHtml = (t, cls = '') => t.platform === 'four' ? `<div class="logo ${cls}">.ai${logoImg(t)}</div>` : `<div class="logo flap ${cls}">${esc(String(t.symbol || '?').slice(0, 2).toUpperCase())}${logoImg(t)}</div>`;
// 底池数量：≥1 保留 2 位小数，<1 最多 4 位，去掉末尾的 0（666.5000177780021 → 666.5）
// 数量统一用紧凑写法：≥1000 用 K/M/B（两位小数），1～1000 两位小数，<1 最多 4 位；完整数字放在 title 里
const amt = (v) => { v = Number(v) || 0; if (!v) return '0'; if (Math.abs(v) >= 1000) return K(v, 2).replace(/\.?0+([KMB])$/, '$1'); if (v < 0.0001) return '<0.0001'; return (v >= 1 ? v.toFixed(2) : v.toFixed(4)).replace(/\.?0+$/, ''); };
const pool = (t) => `<span title="${esc(`${Number(t.raised) || 0} / ${Number(t.target) || 0} ${t.quote || 'BNB'}`)}">${amt(t.raised)}/${amt(t.target)}${t.quote && t.quote !== 'BNB' ? ' ' + esc(t.quote) : ''}</span>`;
// 买 / 卖总费率（代币税 + 平台费 + 防狙击税），≥5% 标红；不知道显示「—」
const pctTxt = (v) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(v >= 10 ? 0 : 1) + '%');
const taxHi = (t) => (t.buyFeePct || 0) >= 5 || (t.sellFeePct || 0) >= 5;
const taxChip = (t, cls = 'tag') => `<i class="${cls} tax ${taxHi(t) ? 'hi' : ''}" title="买入 / 卖出总费率（代币税 + 平台费${t.antiSniperPct ? ' + 防狙击税 ' + t.antiSniperPct.toFixed(1) + '%' : ''}）">税 ${pctTxt(t.buyFeePct)}/${pctTxt(t.sellFeePct)}${t.antiSniperPct >= 0.1 ? ' 🛡' : ''}</i>`;
// 买入再卖出的预计损耗（不含价格变动）：买入费 + 卖出费（按买入后剩下的部分）+ 约 0.00017 BNB gas
const roundTrip = (t, amount) => { const b = t.buyFeePct, s = t.sellFeePct; if (b == null || s == null || !(amount > 0)) return null; const left = amount * (1 - b / 100); const cost = amount * b / 100 + left * s / 100 + 0.00017; return { cost, pct: (cost / amount) * 100 }; };
// 涨幅：绿涨红跌，算不出来显示「—」
// 涨幅的说明：基准价和时间
const chgTip = (t, k) => { const b = t.chg?.base?.[k]; const what = { launch: '现价相对第一笔成交价', m5: '现价相对 5 分钟前的价格', h1: '现价相对 1 小时前的价格', h24: '现价相对 24 小时前的价格' }[k]; return b ? `${what}（基准 ${sub(b.p)} ${t.quote || 'BNB'}，${new Date(b.t * 1000).toLocaleString('zh-CN', { hour12: false })}）` : `${what}：币龄不够或历史数据不足`; };
const chgTxt = (v) => (v == null || !isFinite(v) ? '<span class="muted">—</span>' : `<span class="${v >= 0 ? 'g' : 'r'}">${v >= 0 ? '+' : ''}${Math.abs(v) >= 1000 ? K(v, 1) : v.toFixed(1)}%</span>`);
const tagsHtml = (t) => {
  const st = t.stage === 'curve' ? '<i class="tag b">内盘</i>' : t.stage === 'dex' ? '<i class="tag g">已迁移</i>' : '<i class="tag gray">已撤池</i>';
  const kind = t.platform === 'four' ? (t.agentExclusive !== false ? '<i class="tag r">Agent 专属</i>' : '<i class="tag r">Four 内盘</i>')
    : t.platform === 'gang' ? (t.gangTrack === 'v2' && t.stage === 'curve' ? '<i class="tag gangy">Gang V2</i>' : '<i class="tag gangy">Gang 内盘</i>')
    : t.platform === 'gwei' ? '<i class="tag gweiy">GWEI 曲线</i>'
    : (t.source && t.source !== 'agent-curve' ? '<i class="tag p">Flap 内盘</i>' : '<i class="tag p">Agent 曲线</i>');
  return st + kind + `<i class="tag y">${t.quote} 池</i>` + taxChip(t) + (t.chg?.h1 != null ? `<i class="tag chg" title="1 小时涨幅">1h ${chgTxt(t.chg.h1)}</i>` : '');
};
const wallet = (id) => S.wallets.find((w) => w.id === id) || {};
const eligible = (w, t) => LIVE() ? { ok: true, why: '以合约为准' } : !t || t.platform !== 'four' ? { ok: true } : t.officialTest ? { ok: false, why: '未在白名单' } : !w.agentId ? { ok: false, why: '未绑定 Agent ID' } : !w.whitelisted ? { ok: false, why: '未在白名单' } : { ok: true };

/* ---------- 网络 ---------- */
const api = async (url, body) => {
  if (url === '/api/order' && body && !body.clientTs) body = { ...body, clientTs: Date.now() };   // 记录点击到服务器收到的耗时（data/latency.jsonl）
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j;
};
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => S.selected && ws.send(JSON.stringify({ type: 'sub', token: S.selected }));
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
}
function onMsg({ type, data, full }) {
  switch (type) {
    case 'tick':
      Object.assign(S, { mode: data.mode, baw: data.baw, block: data.block, bnbUsd: data.bnbUsd, net: data.net, wallets: data.wallets, usage: data.usage, positions: data.positions, claimable: data.claimable || [] });
      S.tokens = new Map(data.tokens.map((t) => [t.address, t]));
      if (!S.selected) pickDefault();
      scheduleRender();
      break;
    case 'detail':
      if (data.address !== S.selected) break;
      if (full || !S.detail) { S.detail = data; autoInterval(); }
      else {
        const c = S.detail.candles;
        for (const k of data.candles) {
          let i = c.length - 1; while (i >= 0 && c[i].t > k.t) i--;
          if (i >= 0 && c[i].t === k.t) c[i] = k; else c.splice(i + 1, 0, k);
        }
        if (c.length > 4000) c.splice(0, c.length - 4000);
        S.detail = { ...data, candles: c };
      }
      drawChart(); renderHead(); if (S.bottomTab === 'trades') renderBottom();
      break;
    case 'launch':
      { const known = S.tokens.has(data.address); S.tokens.set(data.address, data); S.newTokens.add(data.address); setTimeout(() => S.newTokens.delete(data.address), 2000);
        // 顶栏🔊的新币提示：在战壕页由各列自己的声音负责；其他页面只对当前平台页签的新币响
        if (!known && data.stage !== 'dex' && Date.now() - (data.createdAt || 0) < 120_000 && S.view !== 'pulse' && data.platform === S.platform && !isBlocked(data)) newTokenChime(); }
      if (data.platform === S.platform && !isBlocked(data)) { if (S.config?.notify && document.hidden && Notification?.permission === 'granted') new Notification(`新内盘 ${data.symbol}`); }
      break;
    case 'trade':
      S.flow.unshift(data); if (S.flow.length > 150) S.flow.length = 150;
      if (S.bottomTab === 'flow') scheduleBottom();
      break;
    case 'order': {
      if (['filled', 'failed', 'unknown'].includes(data.status)) window.dispatchEvent(new Event('order-done'));
      const i = S.orders.findIndex((o) => o.id === data.id); i >= 0 ? (S.orders[i] = data) : S.orders.unshift(data);
      if (data.side === 'transfer' || data.side === 'approve') { if (['orders', 'fills'].includes(S.bottomTab)) scheduleBottom(); break; }
      if (data.status === 'pending' && data.stage === 'broadcast' && data.pendingTx && data.symbol && data.pendingTx !== data._popTx) { data._popTx = data.pendingTx; topPop(data); }
      // 已提交但结果未知 / 最终未知：灰蓝色提示，不算失败
      if ((data.status === 'pending' && data.stage === 'unknown') || data.status === 'unknown') { if (S._unk?.[data.id] !== data.status) { (S._unk ||= {})[data.id] = data.status; $('#topPop')?.classList.remove('show'); note(`${data.symbol}：${data.reason}`, 'info'); } if (['orders', 'fills'].includes(S.bottomTab)) scheduleBottom(); break; }
      if (data.status !== 'pending' && data.symbol) { toast(data); topPop(data); if (data.status === 'filled') beep(data.side === 'buy' ? 1200 : 600, 0.08); }
      if (['orders', 'fills'].includes(S.bottomTab)) scheduleBottom();
      break;
    }
    case 'autoTransfer': {
      let el = $('#topPop'); if (!el) { el = document.createElement('div'); el.id = 'topPop'; document.body.appendChild(el); }
      const ok = data.status === 'filled', dry = data.status === 'dry_run';
      el.className = 'toppop show ' + (ok ? 'buy' : dry ? 'dry' : 'err');
      el.innerHTML = ok ? `<b>已自动转出</b><span class="mono">${K(data.amountIn)} 枚 ${esc(data.symbol)} 到 ${esc(data.toShort)}</span>${data.tx ? txLink(data.tx) : ''}`
        : dry ? `<b>自动转出（模拟，未上链）</b><span class="mono">${K(data.amountIn)} 枚 ${esc(data.symbol)} → ${esc(data.toShort)}</span>`
        : `<b>自动转出失败</b><span>${esc(data.symbol)}</span><span class="mono">${esc(zhErr(data.reason))}</span>`;
      clearTimeout(popTimer); popTimer = setTimeout(() => el.classList.remove('show'), ok ? 6000 : 8000);
      break;
    }
    case 'log': S.logs.unshift(data); if (S.logs.length > 300) S.logs.length = 300; if (S.bottomTab === 'logs') scheduleBottom(); break;
    case 'record': S.records.unshift(data); if (!$('#settingsModal').classList.contains('hidden')) renderRecords(); break;
    case 'config': S.config = data; renderControls(); break;
    case 'blocklist': S.blk = data; afterBlock(); break;
    case 'favorites': setFav(data); break;
    case 'holdings': setHoldSnap(data); break;
    case 'rules': S.rules = data || {}; scheduleRender(); if (S.view === 'hold') renderHold(); break;
    case 'settings': S.settings = data; renderControls(); renderAutoSend(); break;
  }
}

/* ---------- 声音 ---------- */
let actx;
// 新内盘提示音：两声上扬「叮咚」，1.5 秒内最多响一次；受顶栏 🔊 开关控制
let chimeAt = 0;
function newTokenChime() {
  if (!S.config?.sound || Date.now() - chimeAt < 1500) return; chimeAt = Date.now();
  try {
    actx ||= new AudioContext(); if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime;
    [[988, 0], [1480, 0.11]].forEach(([f, dt]) => { const o = actx.createOscillator(), g = actx.createGain(); o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.18);
      o.connect(g).connect(actx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.2); });
  } catch { /* 浏览器未授权音频 */ }
}
// 浏览器自动播放限制：第一次点击 / 按键时解锁音频
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { try { actx ||= new AudioContext(); if (actx.state === 'suspended') actx.resume(); } catch { /* ignore */ } }, { capture: true, passive: true }));
function beep(f, d) {
  if (!S.config?.sound) return;
  try { actx ||= new AudioContext(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.04; o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + d); } catch { /* 浏览器未授权音频 */ }
}

/* ---------- 渲染调度 ---------- */
let rq = false, bq = false, lastList = 0;
function scheduleRender() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; renderAll(); }); }
function scheduleBottom() { if (bq) return; bq = true; setTimeout(() => { bq = false; renderBottom(); }, 200); }
function renderAll() {
  renderTop();
  if (S.view === 'pulse' && Date.now() - lastPulse > 1000) { renderPulse(); lastPulse = Date.now(); }
  if (Date.now() - lastList > 900) { renderList(); lastList = Date.now(); }
  renderStatus(); renderHead(); renderRight();
  if (['pos', 'assets'].includes(S.bottomTab)) renderBottom();
}

function parseRoute() {
  if (/^#\/?pulse/.test(location.hash)) return { pulse: true, p: null, t: null, ca: null };
  if (/^#\/?hold/.test(location.hash)) return { hold: true, p: null, t: null, ca: null };
  const [p, t, ca] = location.hash.replace(/^#\/?/, '').split('/');
  return { p: ['four', 'flap', 'gang', 'gwei'].includes(p) ? p : null, t: ['curve', 'soon', 'dex', 'mine'].includes(t) ? t : null, ca: /^0x[0-9a-fA-F]{40}$/.test(ca || '') ? ca.toLowerCase() : null };
}
// 左侧面板等选择记到 localStorage，Cmd+R 后恢复；URL hash 优先
function savePrefs() { try { localStorage.setItem('ui', JSON.stringify({ platform: S.platform, listTab: S.listTab, chips: [...S.chips], view: S.view, bottomTab: S.bottomTab, interval: S.interval, metric: S.metric, amtMode: S.amtMode, selected: S.selected, amount: $('#amount')?.value || '' })); } catch { /* ignore */ } }
function loadPrefs() {
  let p = {}; try { p = JSON.parse(localStorage.getItem('ui') || '{}') || {}; } catch { /* ignore */ }
  if (['four', 'flap', 'gang', 'gwei'].includes(p.platform)) S.platform = p.platform;
  if (['curve', 'soon', 'dex', 'mine'].includes(p.listTab)) S.listTab = p.listTab;
  if (Array.isArray(p.chips)) S.chips = new Set(p.chips);
  if (p.bottomTab) S.bottomTab = p.bottomTab; if (+p.interval) S.interval = +p.interval; if (p.metric) S.metric = p.metric;
  if (['bnb', 'pct'].includes(p.amtMode)) S.amtMode = p.amtMode;
  return p;
}
function applyActive() {
  const on = (sel, key, v) => $$(sel + ' button').forEach((b) => b.classList.toggle('active', b.dataset[key] === String(v)));
  on('#platTabs', 'p', S.platform); on('#listTabs', 't', S.listTab); on('#bottomTabs', 'b', S.bottomTab); on('#intervals', 'i', S.interval); on('#metric', 'm', S.metric); on('#amtMode', 'a', S.amtMode);
  $$('#chips button').forEach((b) => b.classList.toggle('active', S.chips.has(b.dataset.c)));
}
window.addEventListener('beforeunload', savePrefs); setInterval(savePrefs, 1500);
function syncUrl() {
  savePrefs();
  if (S.view === 'pulse') { if (location.hash !== '#/pulse') history.replaceState(null, '', '#/pulse'); return; }
  if (S.view === 'hold') { if (location.hash !== '#/hold') history.replaceState(null, '', '#/hold'); return; }
  const h = `#/${S.platform}/${S.listTab}${S.selected ? '/' + S.selected : ''}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}
function applyRoute() {
  const r = parseRoute();
  setView(r.pulse ? 'pulse' : r.hold ? 'hold' : 'trade', true);
  if (r.p) { S.platform = r.p; $$('#platTabs button').forEach((b) => b.classList.toggle('active', b.dataset.p === r.p)); }
  if (r.t) { S.listTab = r.t; $$('#listTabs button').forEach((b) => b.classList.toggle('active', b.dataset.t === r.t)); }
  return r;
}
window.addEventListener('hashchange', () => { const r = applyRoute(); lastList = 0; scheduleRender(); if (r.ca && r.ca !== S.selected?.toLowerCase()) select(r.ca); renderQB(); });
function pickDefault() {
  const rc = parseRoute().ca || (S.prefSel && S.tokens.has(S.prefSel) ? S.prefSel : null); S.prefSel = null; if (rc && !S.selected) { const hit = [...S.tokens.keys()].find((k) => k.toLowerCase() === rc); return select(hit || rc); }
  const list = filtered();
  const t = list.find((x) => x.symbol === 'Test4') || list[0];
  if (t) select(t.address);
}
// 兜底：hash 里有合约地址但没选中（初始化出错 / 列表还没到），每秒补选一次
setInterval(() => { const ca = parseRoute().ca; if (S.view !== 'pulse' && ca && S.selected?.toLowerCase() !== ca && S.tokens.size) { const hit = [...S.tokens.keys()].find((k) => k.toLowerCase() === ca); select(hit || ca); } else if (S.view !== 'pulse' && !S.selected && S.tokens.size) pickDefault(); }, 1000);

// 自动选周期：选中一个币后的前 15 秒（历史 K 线到齐前后），挑能画出 ≥60 根蜡烛的最大周期；稀疏的币就用 15s / 1m，不会全是细线。用户手动点过周期就不再自动改
const IVS = [1, 5, 15, 60, 300, 900, 3600];
function autoInterval() {
  if (!S.detail?.candles?.length || S.ivManual === S.selected || Date.now() > (S.ivAutoUntil || 0)) return;
  const cs = S.detail.candles; const count = (iv) => new Set(cs.map((c) => Math.floor(c.t / iv))).size;
  const iv = [...IVS].reverse().find((x) => count(x) >= 60) || IVS[0];
  if (iv !== S.interval) { S.interval = iv; $$('#intervals button').forEach((x) => x.classList.toggle('active', +x.dataset.i === iv)); resetView(); }
}
function select(addr) {
  S.selected = addr; S.detail = null; S.hover = null; resetView(); syncUrl(); S.ivAutoUntil = Date.now() + 15_000;
  renderQB();   // 一键买卖浮窗和详情页同一帧出现（预设、位置都在本地，余额 / 持仓之后再补）
  ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'sub', token: addr }));
  api(`/api/token/${addr}`).then((d) => { if (S.selected === addr) { S.detail = d; autoInterval(); drawChart(); renderHead(); renderBottom(); } }).catch(() => {});
  lastList = 0; scheduleRender(); refreshQuote();
}

/* ---------- 顶栏 ---------- */
// 顶栏的币安钱包登录徽章 + 未登录时的锁定弹窗（只在实盘模式）
function renderAuth() {
  const pill = $('#authPill'), modal = $('#loginModal'), a = S.baw?.auth;
  if (!LIVE() || !a) { pill.classList.add('hidden'); modal.classList.add('hidden'); return; }
  pill.classList.remove('hidden', 'bad', 'warn');
  if (a.state === 'ok') { pill.querySelector('span').textContent = '币安钱包已登录'; pill.title = `${a.agentId || ''} ${a.address || ''}`.trim(); modal.classList.add('hidden'); return; }
  pill.classList.add(a.state === 'checking' ? 'warn' : 'bad');
  pill.querySelector('span').textContent = a.state === 'checking' ? '检查登录中…' : '币安钱包未登录';
  pill.title = a.message || '';
  if (a.state === 'checking') return;   // 还在检查（或只失败了一次）时不挡住页面
  // 未登录：整页遮罩，关不掉；登录检测通过后自动消失。登录命令要在终端里自己运行，页面不代为执行
  modal.classList.remove('hidden');
  const k = [a.state, a.message].join('|');
  if (modal.dataset.k === k) return; modal.dataset.k = k;
  const cmd = (c) => `<div class="ag-cmd"><code>${esc(c)}</code><button class="ui-copy" data-agcopy="${esc(c)}">复制</button></div>`;
  $('#loginLead').innerHTML = a.state === 'missing' ? '没有找到币安 Agentic Wallet 命令行工具（baw）。先安装，再登录。' : '检测到币安钱包<b class="r">未登录</b>（或登录已过期）。登录前所有功能都不能使用。';
  $('#loginBody').innerHTML = (a.state === 'missing' ? `<li>在终端安装 baw：${cmd('npm i -g @binance/agentic-wallet')}</li>` : '')
    + `<li>在终端运行：${cmd('baw auth signin')}</li><li>打开终端里给出的链接 / 二维码，在<b>币安 App</b> 中确认登录</li><li>回到这里点「我已登录，重新检测」（每 10 秒也会自动检测）</li>`;
  $('#loginNote').textContent = a.state === 'error' ? `检测出错：${a.message || ''}` : a.message || '';
}
async function startLogin() {
  const btn = $('#loginGo'); btn.disabled = true; btn.textContent = '正在获取登录二维码…';
  try { const r = await api('/api/auth/login', {}); if (r && S.baw) S.baw.login = r; if (r?.state === 'waiting' && r.urlForWeb) window.open(r.urlForWeb, '_blank', 'noopener'); }
  catch (e) { if (S.baw) S.baw.login = { state: 'failed', message: e.message }; }
  btn.disabled = false; btn.textContent = '登录'; $('#loginModal').dataset.k = ''; renderAuth();
}
$('#loginGo')?.addEventListener('click', startLogin);   // 页面上不再提供登录按钮（登录命令在终端运行）
$('#loginModal').addEventListener('click', async (e) => { const b = e.target.closest('[data-agcopy]'); if (!b) return; try { await navigator.clipboard.writeText(b.dataset.agcopy); b.textContent = '已复制'; } catch { b.textContent = '请手动复制'; } setTimeout(() => (b.textContent = '复制'), 1500); });
$('#loginRecheck').addEventListener('click', async () => { const r = await api('/api/auth/check', {}); if (r && S.baw) S.baw.auth = r; $('#loginModal').dataset.k = ''; renderAuth(); });

function renderTop() {
  renderAuth();
  $('#wssMs').textContent = S.net.wss == null ? '断开' : (S.net.wss || 0) + 'ms';
  $('#rpcMs').textContent = S.net.rpc == null ? '断开' : (S.net.rpc || 0) + 'ms';
  $('#wssName').textContent = LIVE() ? 'shrine' : 'GetBlock';
  const rn = S.net.rpcNode;
  if (LIVE() && rn) {
    $('#rpcName').innerHTML = rn.fallback ? `<span class="y">备用: ${esc(rn.active)}</span>` : esc(rn.active);
    $('#rpcName').closest('.pill').title = `读链 / 查确认：${rn.active}${rn.fallback ? `（主节点 ${rn.primary} 出错，30 秒后重试${rn.primaryErr ? '：' + rn.primaryErr : ''}）` : '（主节点）'}\n扫 Four 事件：${rn.four || '—'}\nFlap 曲线数据：${rn.curve || '—'}`;
  } else $('#rpcName').textContent = LIVE() ? '…' : '48 Club';
  const mb = $('#modeBadge');
  mb.textContent = REAL() ? '实盘 · 真实下单' : LIVE() ? '实盘行情 · 只报价' : '模拟盘';
  mb.classList.toggle('sim-badge', !LIVE());
  // 8788 本应是实盘：如果这里跑成了模拟盘（启动时漏了 MODE=live），顶上挂红色提示，避免把模拟盘当实盘
  document.body.classList.toggle('sim-warn', !LIVE() && location.port === '8788');
  mb.title = REAL() ? `手动买卖会通过 baw 真实上链，单笔上限 ${S.baw.maxTradeBnb || '不限'} BNB；自动买/自动卖只报价` : LIVE() ? '真实链上行情；下单只做报价/预演，不会上链' : '所有交易都在本地模拟，不连接真实钱包';
  $('#blockNo').textContent = '#' + S.block.toLocaleString('en-US');
  $('#bnbPx').textContent = 'BNB $' + S.bnbUsd.toFixed(2);
  const w = wallet(S.activeWallet);
  if (!w.id && LIVE()) { $('#wsLabel').textContent = 'baw'; $('#wsAddr').textContent = '未连接'; $('#wsBal').textContent = S.baw?.error ? '点此查看' : ''; }
  if (w.id) {
    $('#wsLabel').textContent = w.label; $('#wsAvatar').style.background = w.color;
    $('#wsAddr').textContent = short(w.address, 6, 4); $('#wsBal').textContent = w.bnb.toFixed(4) + ' BNB';
  }
}

function renderWalletMenu() {
  $('#walletMenu').innerHTML = S.wallets.map((w) => `<div class="wi" data-w="${w.id}"><i class="wav" style="background:${w.color}"></i><b>${w.label}</b><span class="mono muted">${short(w.address)}</span><span class="spacer"></span><span class="mono">${w.bnb.toFixed(4)}</span></div>`).join('')
    + (LIVE() ? `<div class="note" style="padding:6px 8px">币安 Agentic Wallet（baw）。${S.baw?.connected ? (REAL() ? `已连接，手动买卖会真实上链（单笔上限 ${S.baw.maxTradeBnb || '不限'} BNB）。` : '已连接，只读余额和报价。') : esc(S.baw?.error || '未连接')}</div>`
      : '<div class="note" style="padding:6px 8px">模拟钱包。私钥不存在于本程序中，所有成交仅在本地撮合。</div>');
}

/* ---------- 左栏 ---------- */
function filtered() {
  const mine = new Set(S.positions.filter((p) => p.amount > 0).map((p) => p.token));
  return [...S.tokens.values()].filter((t) => {
    if (S.listTab !== 'mine' && t.platform !== S.platform) return false;
    if (S.listTab !== 'mine' && isBlocked(t)) return false;   // 屏蔽的币不进列表（「我的」里持有的照常显示）
    if (S.listTab === 'curve' && t.stage === 'dex') return false;
    if (S.listTab === 'soon' && !(t.stage === 'curve' && t.progress > 0)) return false;
    if (S.listTab === 'dex' && t.stage !== 'dex') return false;
    if (S.listTab === 'mine' && !mine.has(t.address)) return false;
    if (S.chips.has('bnb') && t.quote !== 'BNB') return false;
    if (S.chips.has('other') && t.quote === 'BNB') return false;
    if (S.chips.has('traded') && !(t.buys + t.sells)) return false;
    if (S.chips.has('h1') && Date.now() - t.createdAt > 3600_000) return false;
    return true;
  }).sort((a, b) => (S.listTab === 'soon' ? b.progress - a.progress : b.createdAt - a.createdAt));
}

function renderList() {
  // 和战壕同一套卡片（tcCard）：固定高度、按地址局部更新，不整列重画；点卡片在当前页打开详情
  const list = filtered().slice(0, 80);
  const body = $('#tokenList'); body.classList.add('tl-trench');
  if (!list.length) { body.innerHTML = '<div class="empty">暂无代币</div>'; }
  else {
    body.querySelector(':scope > .empty')?.remove();
    let anchor = null, anchorTop = 0;
    if (body.scrollTop > 4) for (const c of body.children) { if (c.dataset.pa && c.offsetTop + c.offsetHeight > body.scrollTop) { anchor = c.dataset.pa; anchorTop = c.offsetTop - body.scrollTop; break; } }
    const old = new Map([...body.children].filter((x) => x.dataset.pa).map((x) => [x.dataset.pa, x]));
    let prev = null;
    for (const t of list) {
      const html = tlCard(t);
      let el = old.get(t.address);
      if (!el) { const d = document.createElement('div'); d.innerHTML = html; el = d.firstElementChild; el._h = html; }
      else if (el._h !== html) { const d = document.createElement('div'); d.innerHTML = html; patchCard(el, d.firstElementChild); el._h = html; }
      old.delete(t.address);
      const want = prev ? prev.nextSibling : body.firstChild;
      if (el !== want) body.insertBefore(el, want);
      prev = el;
    }
    for (const el of old.values()) el.remove();
    if (anchor) { const x = body.querySelector(`:scope > [data-pa="${anchor}"]`); if (x) body.scrollTop = x.offsetTop - anchorTop; }
  }
  const cnt = (p) => [...S.tokens.values()].filter((t) => t.platform === p && t.stage === 'curve').length;
  $('#agentCnt').textContent = cnt('four');
  const fresh = (p) => [...S.tokens.values()].filter((t) => t.platform === p && Date.now() - t.createdAt < 60_000).length || '';
  $('[data-n="four"]').textContent = fresh('four'); $('[data-n="flap"]').textContent = fresh('flap'); if ($('[data-n="gwei"]')) $('[data-n="gwei"]').textContent = fresh('gwei');
}

function renderStatus() {
  const w = wallet(S.activeWallet); const t = S.tokens.get(S.selected);
  const el = eligible(w, t);
  const n = [...S.tokens.values()].filter((x) => x.platform === S.platform && x.stage === 'curve').length;
  const ago = (Date.now() - (S.net.detectAt || 0)) / 1000;
  $('#agentStatus').innerHTML = `
    <div class="l1"><span class="muted">${S.platform === 'four' ? 'Agent 专属' : S.platform === 'gang' ? 'Gang' : S.platform === 'gwei' ? 'GWEI' : 'Agent 曲线'} <b class="mono" style="color:var(--text)">${n}</b></span>
      ${LIVE() ? `<span class="muted">${S.baw?.connected ? '<b class="g">baw 已连接</b>' : '<b class="r">baw 未连接</b>'} · 白名单以合约为准</span>` : S.platform === 'four' ? `<b class="${w.agentId ? 'g' : 'r'}">Agent ID ${w.agentId ? '✓' : '✗'}</b><b class="${el.ok ? 'g' : 'r'}">${el.ok ? '已在白名单' : el.why}</b>` : '<b class="g">无需白名单</b>'}</div>
    ${LIVE() ? `<div class="l2" style="text-align:left;color:var(--muted)">Reader ${S.net.curve?.connected ? `<span class="g">✓ ${S.net.curve.total} 个市场</span>` : `<span class="r">✗ ${esc(S.net.curve?.lastError || '连接中')}</span>`} · Four ${S.net.four?.connected ? `<span class="g">✓ ${S.net.four.total}</span>` : `<span class="r">${S.net.four?.lastError ? '✗' : '回补中…'}</span>`} · Gang ${S.net.gang?.connected ? `<span class="g">✓ ${S.net.gang.total}</span>` : `<span class="r">${S.net.gang?.lastError ? '✗' : '连接中…'}</span>`} · shrine ${S.net.shrine?.launch?.connected ? '<span class="g">✓</span>' : '<span class="r">✗</span>'} · baw ${S.baw?.connected ? '<span class="g">✓</span>' : '<span class="r">✗</span>'}</div>` : ''}
    <div class="l2"><span class="spin">⟳</span> 链上检测中 · ${ago < 5 ? '刚刚' : Math.floor(ago) + 's 前'} · ${S.net.detect || 0}ms</div>`;
}

/* ---------- 中栏：头部 ---------- */
// 交易页顶部：我的余额 / 盈亏（与战壕卡片同一套数据：价格 × 数量 × 计价币 USD）
// 持仓行（和「持仓」页同一份数据：市值、成本都折成 BNB，报价币盘按汇率换算）。交易页每 15 秒最多拉一次
// 持仓快照：服务器每 5 秒推一次（下单后马上推），本地也存一份，刷新页面后立刻有数，不用等接口
function setHoldSnap(d) { if (!d) return; HOLD.data = d; HOLD.at = Date.now(); try { localStorage.setItem('holdSnap', JSON.stringify(d)); } catch { /* 太大或无痕模式就算了 */ } scheduleRender(); if (S.view === 'hold') renderHold(); renderQB(); if (S.selected && S.tokens.has(S.selected)) renderMyPos(S.tokens.get(S.selected)); if (S.bottomTab === 'pos') renderBottom(); }
function holdRow(t) {
  if (!HOLD.data) { try { HOLD.data = JSON.parse(localStorage.getItem('holdSnap') || 'null'); HOLD.stale = true; } catch { /* ignore */ } }
  return HOLD.data?.rows?.find((r) => r.token.toLowerCase() === String(t.address).toLowerCase()) || null;
}
function holdStats(t) {
  const hp = S.positions?.find((p) => p.token === t.address);
  const r = holdRow(t);
  const q = t.quote || 'BNB', qu = t.quoteUsd || (q === 'BNB' ? S.bnbUsd : 0);
  const pnlHtml = (pnl, pct, extra = '', pu = pnl * S.bnbUsd) => `<b class="${pu >= 0 ? 'g' : 'r'}">${pu >= 0 ? '+' : '−'}$${Math.abs(pu).toFixed(2)}<small>${pct != null ? ` ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}${extra}</small></b>`;   // 只显示美元盈亏和百分比
  const amount = r?.amount ?? hp?.amount ?? 0;
  if (!(amount > 0)) {
    const real = r && r.costBnb > 0 ? r.soldBnb - r.costBnb : null;
    return `<div><span>我的余额</span><b class="muted">0</b></div><div><span>盈亏</span>${real != null ? pnlHtml(real, (real / r.costBnb) * 100, ' · 已实现', r.soldUsd - r.costUsd) : '<b class="muted">—</b>'}</div>`;
  }
  const v = amount * (t.price || 0), vu = v * qu;
  const valTxt = q === 'BNB' || q === 'WBNB' ? `${bnb(v)} BNB` : `${K(v)} ${esc(q)}${r?.valueBnb != null ? ' ≈ ' + bnb(r.valueBnb) + ' BNB' : ''}`;
  // 盈亏 = 市值(BNB) + 已卖回(BNB) − 成本(BNB，含 gas)；数值没通过链上卖出报价核对时不显示
  const pnl = r?.pnlBnb != null ? pnlHtml(r.pnlBnb, r.pnlPct, '', r.pnlUsd) : `<b class="muted" title="${esc(r?.warn || '持仓成本还在读取')}">—</b>`;
  // 紧凑：数量 + BNB 价值；完整（报价币数量、美元）放在悬停提示里
  const short = r?.valueBnb != null ? bnb(r.valueBnb) + ' BNB' : q === 'BNB' || q === 'WBNB' ? bnb(v) + ' BNB' : K(v) + ' ' + esc(q);
  return `<div class="hold-st" title="我的余额 ${K(amount)} ≈ ${valTxt.replace(/<[^>]+>/g, '')}${vu ? ' / $' + K(vu) : ''}"><span>余额</span><b>${K(amount)}<small> ≈ ${short}</small></b></div><div class="hold-st"><span>盈亏</span>${pnl}</div>`;
}
function renderHead() {
  const t = S.detail ? { ...S.tokens.get(S.selected), ...S.detail } : S.tokens.get(S.selected);
  if (!t) { $('#tokenHead').innerHTML = '<div class="empty">选择左侧代币</div>'; return; }
  { const qb = $('#qBuy2'); if (qb) qb.innerHTML = `⚡ 买入 ${qPct(t)}% <kbd>空格+W</kbd>`; }
  const w = wallet(S.activeWallet); const el = eligible(w, t);
  $('#tokenHead').innerHTML = `
    <div class="th-row">
      ${logoHtml(t, 'lg')}
      <div class="th-main">
        <div class="th-title">${favStar(t.address)}<b class="ctick" data-ctick="${esc(t.symbol)}" title="点击复制代号">${esc(t.symbol)}</b><span class="muted">${esc(t.name)}</span>${tagsHtml(t)}</div>
        <div class="th-sub"><span>代币 <span class="mono">${short(t.address, 8, 6)}</span> <span class="copy" data-copy="${t.address}">⧉</span></span><span>创建者 ${whoHtml(t.creator, t.creatorName || NAMES[String(t.creator || '').toLowerCase()])}</span>${t.firstBuyer ? `<span>首买 <a href="https://bscscan.com/address/${esc(t.firstBuyer)}" target="_blank" rel="noopener" title="${esc(t.firstBuyer)}">${whoHtml(t.firstBuyer, t.firstBuyerName || NAMES[t.firstBuyer.toLowerCase()])}</a></span>` : ''}</div>
        <div class="th-sub"><span>预设 ${t.preset}</span><span>${age(t.createdAt)} 前创建</span></div>
      </div>
      <div class="links"><button class="ca-big ${caOk(t.address) ? 'ok' : ''}" data-cacopy="${t.address}" title="复制合约地址：${t.address}"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="8" y="8" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V4H4v12h4" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>${caOk(t.address) ? '已复制 ✓' : '复制 CA'}</span><b class="mono">${short(t.address, 6, 4)}</b></button><a href="#" data-ext="four">${t.platform === 'four' ? 'Four' : t.platform === 'gang' ? 'Gang' : 'Flap'}</a><a href="#" data-ext="bsc">BscScan</a><a href="#" data-ext="gmgn">GMGN</a>${blockLinks(t)}<a href="#" data-qbtoggle class="${qbOpen() ? 'qb-on' : ''}" title="显示 / 隐藏一键买卖面板">⚡ 一键买卖</a></div>${ruleBanner(t.address)}
      <div class="th-price"><div class="p">$${sub(t.priceUsd)}</div><div class="s">每枚 · ${sub(t.price)} ${esc(t.quote || 'BNB')}</div></div>
    </div>
    <div class="stats">
      <div><span>市值</span><b>${usd(t.mcapUsd)}</b></div>
      ${holdStats(t)}
      <div><span title="内盘进度">进度</span><b>${t.progress.toFixed(2)}%</b><div class="bar"><i style="width:${t.progress}%"></i></div></div>
      <div><span>已筹/目标</span><b style="white-space:nowrap">${pool(t)}</b></div>
      <div><span title="底池（美元）">底池</span><b>${usd(t.liqUsd || 0)}</b></div>
      <div><span title="买入 / 卖出笔数">成交</span><b><span class="g">${t.buys}</span>/<span class="r">${t.sells}</span></b></div>
      <div><span title="内盘成交量">成交量</span><b>${bnb(t.volume, 3)} ${esc(t.quote || 'BNB')}</b></div>
      <div><span title="内盘剩余可售">可售</span><b>${t.remaining == null ? '—' : K(t.remaining)}</b></div>
      ${!(t.buyTax > 0 || t.sellTax > 0) ? '' : `<div><span title="代币税：只算代币自己设置的税，不含平台费">代币税</span><b><span class="${t.buyTax >= 5 ? 'r' : ''}">${pctTxt(t.buyTax)}</span> / <span class="${t.sellTax >= 5 ? 'r' : ''}">${pctTxt(t.sellTax)}</span></b></div>`}
      ${el.ok ? '' : `<div><span>资格</span><b class="${el.ok ? 'g' : 'r'}" style="font-family:var(--sans)">${el.ok ? '可交易' : el.why}</b></div>`}
      <div><span title="总费率 买/卖：代币税 + 平台费 + 防狙击税，和标题里的「税」标签是同一个数">总费率</span><b class="${taxHi(t) ? 'r' : 'g'}">${pctTxt(t.buyFeePct)} / ${pctTxt(t.sellFeePct)}${t.antiSniperPct >= 0.1 ? ` <span class="y" title="最近一笔买入含防狙击税">🛡${t.antiSniperPct.toFixed(1)}%</span>` : ''}</b></div>
      <div><span title="涨幅（开盘以来）：${esc(chgTip(t, 'launch'))}">涨幅</span><b title="${esc(chgTip(t, 'launch'))}">${chgTxt(t.chg?.launch)}</b><small class="chg-row"> <span title="${esc(chgTip(t, 'm5'))}">5m ${chgTxt(t.chg?.m5)}</span> · <span title="${esc(chgTip(t, 'h1'))}">1h ${chgTxt(t.chg?.h1)}</span>${t.chg?.h24 != null ? ` · <span title="${esc(chgTip(t, 'h24'))}">24h ${chgTxt(t.chg.h24)}</span>` : ''}</small></div>
      <div><span>持有人</span><b>${t.holders ?? '—'}</b></div>
      
      <div><span>最新</span><b>${t.lastTradeAt ? age(t.lastTradeAt) + ' 前' : '—'}</b></div>
    </div>`;
}

/* ---------- K 线 ---------- */
// K 线用 TradingView Lightweight Charts（Apache-2.0，public/vendor/ 里的本地副本）：拖动、滚轮/捏合缩放、十字光标都由库处理
function aggregate() {
  const src = S.detail?.candles || []; const iv = S.interval; const out = [];
  const qu = S.detail?.quoteUsd || S.bnbUsd; const f = S.metric === 'mcap' ? (S.detail?.maxSupply || 1e9) * qu : qu;
  for (const c of src) {
    const b = Math.floor(c.t / iv) * iv; const l = out[out.length - 1];
    if (l && l.t === b) { l.h = Math.max(l.h, c.h * f); l.l = Math.min(l.l, c.l * f); l.c = c.c * f; l.v += c.v; }
    else out.push({ t: b, o: c.o * f, h: c.h * f, l: c.l * f, c: c.c * f, v: c.v });
  }
  return out;
}
function fmtAxis(v) { return S.metric === 'mcap' ? '$' + K(v, Math.abs(v) >= 1e3 ? 2 : 4) : '$' + sub(v, 4); }
const LWC = window.LightweightCharts;
const chartEl = $('.chart-wrap');
const tz = -new Date().getTimezoneOffset() * 60;   // 库按 UTC 显示时间，这里换成本地时间
const chart = LWC.createChart(chartEl, {
  autoSize: true,
  layout: { background: { color: 'transparent' }, textColor: '#7d8794', fontSize: 11, fontFamily: getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace' },
  grid: { vertLines: { color: '#151b22' }, horzLines: { color: '#151b22' } },
  crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: '#3a4350', labelBackgroundColor: '#2b3139' }, horzLine: { color: '#3a4350', labelBackgroundColor: '#2b3139' } },
  rightPriceScale: { borderColor: '#1e2329', scaleMargins: { top: 0.08, bottom: 0.26 } },
  timeScale: { borderColor: '#1e2329', timeVisible: true, secondsVisible: true, rightOffset: 3, barSpacing: 6, minBarSpacing: 0.5 },
  localization: { priceFormatter: fmtAxis },
});
const candles = chart.addCandlestickSeries({ upColor: '#1ecb81', downColor: '#f6465d', borderVisible: false, wickUpColor: '#1ecb81', wickDownColor: '#f6465d',
  priceFormat: { type: 'custom', formatter: fmtAxis, minMove: 1e-12 }, priceLineColor: '#1ecb81', priceLineStyle: LWC.LineStyle.Dashed,
  // 价格轴上滚轮调 K 线高度：在自动范围的基础上按 Y.zoom 放大/缩小（>1 = 范围变大、蜡烛变矮）
  autoscaleInfoProvider: (orig) => {
    const r = orig(); if (!r?.priceRange || Y.zoom === 1) return r;
    const { minValue, maxValue } = r.priceRange; const mid = (minValue + maxValue) / 2, half = Math.max((maxValue - minValue) / 2, Math.abs(mid) * 1e-6) * Y.zoom;
    return { ...r, priceRange: { minValue: mid - half, maxValue: mid + half } };
  } });
const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
const bar = (d) => ({ time: d.t + tz, open: d.o, high: d.h, low: d.l, close: d.c });
const volBar = (d) => ({ time: d.t + tz, value: d.v, color: d.c >= d.o ? 'rgba(30,203,129,.45)' : 'rgba(246,70,93,.45)' });
// 只在换代币 / 换周期 / 换市值-价格时 setData；其余只 update 最新一两根
const CH = { key: '', len: 0, lastT: 0, markers: '' };
const Y = { zoom: 1 };
function resetView() { CH.key = ''; Y.zoom = 1; }
// 鼠标在右侧价格轴上滚轮：拉伸 / 压缩 K 线高度（不动时间轴）；双击价格轴恢复自动
const overPriceAxis = (e) => { const r = chartEl.getBoundingClientRect(); return e.clientX >= r.right - chart.priceScale('right').width() && e.clientY <= r.bottom - chart.timeScale().height(); };
function applyYZoom() { chart.priceScale('right').applyOptions({ autoScale: true }); candles.applyOptions({ autoscaleInfoProvider: candles.options().autoscaleInfoProvider }); }
chartEl.addEventListener('wheel', (e) => {
  if (!overPriceAxis(e)) return;
  e.preventDefault(); e.stopPropagation();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1); if (!dy) return;
  const step = e.deltaMode !== 0 || Math.abs(dy) >= 50 ? 1.1 : Math.exp(Math.abs(dy) * 0.004);
  Y.zoom = Math.max(0.05, Math.min(50, dy > 0 ? Y.zoom * step : Y.zoom / step));   // 向下滚 = 蜡烛变矮，向上滚 = 拉高
  applyYZoom();
}, { capture: true, passive: false });
chartEl.addEventListener('dblclick', (e) => { if (overPriceAxis(e)) { Y.zoom = 1; applyYZoom(); } }, true);
function ohlc(d) {
  if (!d) { $('#ohlc').innerHTML = ''; return; }
  const ch = ((d.c - d.o) / d.o) * 100;
  $('#ohlc').innerHTML = `O <b>${fmtAxis(d.o)}</b> H <b>${fmtAxis(d.h)}</b> L <b>${fmtAxis(d.l)}</b> C <b class="${ch >= 0 ? 'g' : 'r'}">${fmtAxis(d.c)}</b> <span class="${ch >= 0 ? 'g' : 'r'}">${ch.toFixed(2)}%</span>`;
}
// 默认缩放：显示全部 K 线。每根宽度 = 图宽 ÷ 根数，限制在 0.5～7px：很少的几根不会被拉得很粗（保持细、靠右），太多的显示到最小宽度为止。
// 只在换币 / 换周期 / 历史重建时调用；实时更新用 update()，不会打乱用户拖动或缩放后的视图
function fitAll(n) {
  const ts = chart.timeScale(); const w = Math.max(100, chartEl.clientWidth - (chart.priceScale('right').width() || 60));
  const sp = Math.max(0.5, Math.min(7, (w - 24) / Math.max(1, n + 3)));
  ts.applyOptions({ barSpacing: sp, rightOffset: 3 }); ts.scrollToRealTime();
}
function drawChart() {
  const all = aggregate();
  const key = [S.selected, S.interval, S.metric].join('|');
  if (key !== CH.key || all.length < CH.len || (all.length && all[0].t !== CH.firstT)) {
    if (key !== CH.key && Y.zoom !== 1) { Y.zoom = 1; applyYZoom(); }
    candles.setData(all.map(bar)); volume.setData(all.map(volBar));
    // 新币 / 换周期 / 历史重建后：K 线少就铺满整个宽度，多就对齐到最新（右边留一点空）
    if (key !== CH.key || (all.length && all[0].t !== CH.firstT)) fitAll(all.length);
    CH.key = key; CH.markers = null;   // 换币 / 换周期一定重画标记（以前没有自己成交的币会留着上一个币的买卖标记）
  } else {
    for (const d of all.slice(Math.max(0, CH.len - 1))) { if (d.t >= CH.lastT) { candles.update(bar(d)); volume.update(volBar(d)); } }
  }
  CH.len = all.length; CH.firstT = all[0]?.t; CH.lastT = all[all.length - 1]?.t || 0;
  if (!CH.hovering) ohlc(all[all.length - 1]);
  // 自己的买卖标在 K 线上
  // 只标已上链、成交人是我钱包的成交：最近成交列表里 trader = 我，加上钱包历史（持仓数据，较早的也在）；按 tx 去重
  const seen = new Set(); const mine = [];
  for (const t of [...(S.detail?.trades || []).filter((x) => isMe(x.trader)), ...((S.detail && HOLD.data?.rows?.find((r) => r.token.toLowerCase() === S.detail.address.toLowerCase())?.trades) || [])]) {
    const k = String(t.tx || '').toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); mine.push(t);
  }
  const mk = S.selected + ':' + mine.map((t) => t.tx + t.side).join(',');
  if (mk !== CH.markers) {
    CH.markers = mk;
    candles.setMarkers(mine.map((t) => ({ time: Math.floor(t.ts / 1000 / S.interval) * S.interval + tz, position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: t.side === 'buy' ? '#1ecb81' : '#f6465d', shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown', text: t.side === 'buy' ? '买' : '卖' })).sort((a, b) => a.time - b.time));
  }
}
chart.subscribeCrosshairMove((p) => {
  const d = p?.time != null ? p.seriesData.get(candles) : null;
  CH.hovering = !!d;
  if (d) ohlc({ o: d.open, h: d.high, l: d.low, c: d.close }); else ohlc(aggregate().at(-1));
});
// 往回看历史时显示「回到最新」；双击或点按钮回到最新
chart.timeScale().subscribeVisibleLogicalRangeChange(() => $('#toLatest').classList.toggle('hidden', chart.timeScale().scrollPosition() > -2));
chartEl.addEventListener('dblclick', () => chart.timeScale().scrollToRealTime());
$('#toLatest').addEventListener('click', () => chart.timeScale().scrollToRealTime());

/* ---------- 底部表格 ---------- */
const qAmt = (v, q) => `${!(v > 0) ? '0' : q === 'BNB' || v < 1000 ? bnb(v, 4) : K(v)} ${esc(q)}`;   // 报价币金额：BNB 保留小数，大数（GANG 等）用 K / M
const usdAmt = (v) => (v == null || !isFinite(v) ? '—' : '$' + (v < 0.1 ? v.toFixed(4) : v.toFixed(2)));
const txLink = (tx) => (!tx ? '—' : LIVE() ? `<a href="https://bscscan.com/tx/${tx}" target="_blank" rel="noopener">${short(tx, 8, 6)} ↗</a>` : `${short(tx, 8, 6)} ↗`);
function renderBottom() {
  const b = $('#bottomBody'); const t = S.tokens.get(S.selected);
  const mineSet = new Set(S.wallets.map((w) => 'user:' + w.id));
  let html = '', cnt = '';
  switch (S.bottomTab) {
    case 'trades': {
      // 最新的来自实时推送（服务器只留最近 60 笔），更早的往下翻时按页从 /api/trades 拉；按 tx+方向 去重
      const OT = olderTrades(); const seen = new Set();
      const rows = [...(S.detail?.trades || []), ...OT.items].filter((r) => { const k = `${r.tx}:${r.side}:${r.tokens}`; if (seen.has(k)) return false; seen.add(k); return true; });
      cnt = rows.length + ' 笔' + (OT.end ? '（全部）' : '');
      // 价格：美元（悬停看报价币单价）；金额：报价币 + 美元；地址：自己的钱包绿色
      const q = t?.quote || 'BNB', qu = t?.quoteUsd || (q === 'BNB' ? S.bnbUsd : 0);
      html = `<table class="ttable"><tr><th>时间</th><th class="l">方向</th><th>数量</th><th>价格</th><th>金额</th><th>成交后市值</th><th class="l">地址</th><th class="l">交易</th></tr>
        ${rows.map((r) => `<tr class="${isMe(r.trader) ? 'mine' : ''} trow" data-trader="${esc(r.trader || '')}" title="点击查看这个地址在这个币上的盈亏"><td class="dim">${hms(r.ts)}</td><td class="l"><span class="${r.side === 'buy' ? 'g' : 'r'}">${r.side === 'buy' ? '买入' : '卖出'}</span></td>
        <td>${K(r.tokens)}</td><td title="${r.price ? sub(r.price) + ' ' + esc(q) : ''}">${r.price && qu ? '$' + sub(r.price * qu) : '—'}</td>
        <td><b>${usdAmt(r.usd ?? (qu ? r.bnb * qu : null))}</b><div class="hsub">${qAmt(r.bnb, q)}</div></td><td>${usd(tradeMc(r, t))}</td>
        <td class="l addr">${mineSet.has(r.trader) ? `<b class="me">${wallet(r.trader.slice(5)).label}</b><i class="me-tag">我</i>` : LIVE() && r.trader ? `<span class="tr-who">${gmgnWho(r.trader, nameOf(r))}</span>` : traderHtml(r)}</td><td class="l">${txLink(r.tx)}</td></tr>`).join('')}</table>`;
      html += LIVE() ? `<div class="tfoot" id="tradesFoot">${OT.end ? (OT.complete ? '— 已到开盘第一笔 —' : '— 已到能查到的最早一笔（成交太多，只保留了最近的部分）—') : OT.loading ? '正在加载更早的成交…' : OT.err ? `加载失败：${esc(OT.err)}（往下滚动重试）` : '往下滚动（或点这里）加载更早的成交'}</div>` : '';
      break;
    }
    case 'flow': {
      cnt = S.flow.length + ' 笔';
      html = `<table class="flowt"><tr><th>时间</th><th class="l">代币</th><th class="l">方向</th><th>金额</th><th>市值</th><th class="l">地址</th></tr>
        ${S.flow.slice(0, 120).map((r) => { const q = S.tokens.get(r.address)?.quote || 'BNB'; return `<tr data-a="${r.address}" class="${isMe(r.trader) ? 'mine' : ''}" style="cursor:pointer" title="点击打开这个币"><td class="dim">${hms(r.ts)}</td><td class="l"><span class="side">${logoHtml(r, 'xs')}${esc(r.symbol)}</span></td><td class="l ${r.side === 'buy' ? 'g' : 'r'}">${r.side === 'buy' ? '买入' : '卖出'}</td><td><b>${usdAmt(r.usd)}</b><div class="hsub">${qAmt(r.bnb, q)}</div></td><td>${usd(r.mcapUsd)}</td><td class="l addr">${traderHtml(r)}</td></tr>`; }).join('')}</table>`;
      break;
    }
    case 'pos': {
      // 详情页的「我的持仓」只看当前这个币（和持仓页同一份数据：均价、市值、盈亏都折成 BNB / 美元）
      const sel = S.selected?.toLowerCase(), hr = HOLD.data?.rows?.find((x) => x.token.toLowerCase() === sel);
      if (sel && t) {
        cnt = hr?.amount > 0 ? '持有中' : '';
        html = !hr ? `<div class="empty">没有持有 ${esc(t.symbol)}${LIVE() ? '' : '（模拟盘）'}</div>` : `<div class="mypos">
          <div><span>持有</span><b>${K(hr.amount)}</b><small>${hr.supplyPct != null ? hr.supplyPct.toFixed(3) + '% 总量' : ''}</small></div>
          <div title="${hr.avgBuyBnb ? sub(hr.avgBuyBnb) + ' BNB' : ''}${hr.avgBuyQuote && hr.quote !== 'BNB' ? ' / ' + sub(hr.avgBuyQuote) + ' ' + esc(hr.quote) : ''}"><span>买入均价</span><b>${hr.avgBuyUsd ? '$' + sub(hr.avgBuyUsd) : '—'}</b><small>${hr.avgBuyBnb ? sub(hr.avgBuyBnb) + ' BNB' : ''}</small></div>
          <div><span>现价</span><b>${t.priceUsd ? '$' + sub(t.priceUsd) : '—'}</b><small>${hr.priceBnb ? sub(hr.priceBnb) + ' BNB' : ''}</small></div>
          <div><span>市值</span><b>${hr.valueUsd != null ? '$' + (hr.valueUsd).toFixed(2) : '—'}</b><small>${hr.valueBnb != null ? bnb(hr.valueBnb) + ' BNB' : ''}</small></div>
          <div title="${usdTip(hr)}"><span>成本</span><b>$${(hr.costUsd || 0).toFixed(2)}</b><small>${bnb(hr.costBnb)} BNB</small></div>
          <div title="${usdTip(hr)}"><span>已卖出</span><b>$${(hr.soldUsd || 0).toFixed(2)}</b><small>${bnb(hr.soldBnb)} BNB</small></div>
          <div title="${usdTip(hr)}"><span>盈亏</span><b class="${(hr.pnlUsd ?? hr.pnlBnb ?? 0) >= 0 ? 'g' : 'r'}">${usdSigned(hr.pnlUsd)}</b><small>${hr.pnlPct != null ? (hr.pnlPct >= 0 ? '+' : '') + hr.pnlPct.toFixed(1) + '%' : ''}</small></div>
          ${hr.amount > 0 ? `<div class="acts"><button class="qb" data-hsell="${hr.walletId}:${hr.token}:50">卖 50%</button> <button class="qb" style="color:var(--r)" data-hsell="${hr.walletId}:${hr.token}:100">清仓</button></div>` : ''}
        </div>${hr.trades?.length ? `<table class="ttable"><tr><th>时间</th><th class="l">方向</th><th>数量</th><th>金额 (BNB)</th><th class="l">交易</th></tr>${hr.trades.map((x) => `<tr><td class="dim">${new Date(x.ts).toLocaleString('zh-CN', { hour12: false })}</td><td class="l ${x.side === 'buy' ? 'g' : 'r'}">${x.side === 'buy' ? '买入' : '卖出'}</td><td>${K(x.tokens)}</td><td>${bnb(x.bnb, 5)}</td><td class="l">${txLink(x.tx)}</td></tr>`).join('')}</table>` : ''}`;
        holdRow(t); break;
      }
      const rows = S.positions; cnt = rows.filter((p) => p.amount > 0).length + ' 个持仓';
      // 已迁移、还没领取的 Flap 曲线份额
      const cl = LIVE() && S.claimable?.length ? `<div class="note" style="margin:6px 0"><b class="y">可领取</b>（Flap 曲线已迁移，份额要领成代币）：${S.claimable.map((c) => `<span class="side" style="margin-right:12px">${logoHtml({ ...c, address: c.token, platform: 'flap' }, 'xs')}${esc(c.symbol)} ${K(c.shares)} 份 <button class="qb" style="display:inline" data-claim="${c.market}">领取</button></span>`).join('')}</div>` : '';
      html = cl + (rows.length ? `<table><tr><th>代币</th><th class="l">钱包</th><th>持有</th><th>价值 (BNB)</th><th>成本</th><th>累计买入/卖回</th><th>盈亏</th><th>浮盈%</th><th class="l">状态</th><th>操作</th></tr>
        ${rows.map((p) => `<tr><td><span class="side">${logoHtml({ ...p, address: p.token }, 'xs')}<a href="#" data-a="${p.token}">${esc(p.symbol)}</a></span></td><td class="l">${p.wallet}</td><td>${K(p.amount)}</td><td>${bnb(p.valueBnb)}</td><td>${bnb(p.costBnb)}</td><td>${bnb(p.boughtBnb)} / ${bnb(p.soldBnb)}</td>
        <td class="${p.pnlBnb >= 0 ? 'g' : 'r'}">${p.pnlBnb >= 0 ? '+' : ''}${bnb(p.pnlBnb)}</td><td class="${p.pnlPct >= 0 ? 'g' : 'r'}">${p.amount > 0 ? pctS(p.pnlPct) : '已清仓'}</td><td class="l">${p.stage === 'curve' ? '内盘' : p.stage === 'dex' ? '已迁移' : '已撤池'}</td>
        <td>${p.amount > 0 ? `<button class="qb" style="display:inline;color:var(--r);border-color:rgba(246,70,93,.4);background:var(--r-bg)" data-sell="${p.walletId}:${p.token}:50">卖50%</button> <button class="qb" style="display:inline;color:var(--r);border-color:rgba(246,70,93,.4);background:var(--r-bg)" data-sell="${p.walletId}:${p.token}:100">清仓</button>` : ''}</td></tr>`).join('')}</table>` : (cl ? '' : '<div class="empty">暂无持仓</div>'));
      break;
    }
    case 'orders': case 'fills': {
      const rows = S.bottomTab === 'fills' ? S.orders.filter((o) => o.status === 'filled') : S.orders; cnt = rows.length + ' 笔';
      html = rows.length ? `<table><tr><th>时间</th><th class="l">来源</th><th class="l">钱包</th><th class="l">代币</th><th class="l">方向</th><th>输入</th><th>输出</th><th>耗时</th><th class="l">状态 / 执行步骤</th>${S.bottomTab === 'fills' || REAL() ? '<th class="l">交易</th>' : ''}</tr>
        ${rows.slice(0, 150).map((o) => `<tr><td class="dim">${hms(o.ts)}</td><td class="l">${o.source}</td><td class="l"><b class="me">${esc(o.wallet)}</b></td><td class="l"><a href="#" data-a="${o.token}">${esc(o.symbol)}</a></td>
        <td class="l ${o.side === 'buy' || o.side === 'claim' ? 'g' : 'r'}">${o.side === 'claim' ? '领取' : o.side === 'buy' ? '买入' : '卖出'}</td><td>${o.side === 'claim' ? '—' : o.side === 'buy' ? bnb(o.amountIn ?? o.amount) + ' BNB' : (o.amountIn && !LIVE() ? K(o.amountIn) : o.amount + '%')}</td>
        <td>${o.out == null ? '—' : o.side === 'buy' ? K(o.out) : bnb(o.out) + ' BNB'}</td><td>${o.latencyMs != null ? o.latencyMs + 'ms' : '…'}</td>
        <td class="l"><span class="${o.status === 'filled' ? 'g' : o.status === 'failed' ? 'r' : 'y'}">${o.status === 'filled' ? '成交' : o.status === 'failed' ? esc(o.reason) : o.status === 'dry_run' ? '已报价（未上链）' : o.status === 'unknown' || o.stage === 'unknown' ? '待确认：' + esc(o.reason || '') : '提交中'}</span>
        <div class="steps">${(o.steps || []).map((s) => `${s.name} ${s.ms}ms`).join(' → ')}</div></td>${S.bottomTab === 'fills' || REAL() ? `<td class="l">${txLink(o.tx)}</td>` : ''}</tr>`).join('')}</table>` : '<div class="empty">暂无订单</div>';
      break;
    }
    case 'assets': {
      cnt = S.wallets.length + ' 个钱包';
      html = `<table><tr><th>钱包</th><th class="l">地址</th><th>BNB</th><th>USD</th><th>持仓价值</th><th class="l">Binance Agent ID</th><th class="l">Four 白名单</th><th>Nonce</th><th>操作</th></tr>
        ${S.wallets.map((w) => { const pv = S.positions.filter((p) => p.walletId === w.id).reduce((a, p) => a + p.valueBnb, 0);
          return `<tr><td><span class="side"><i class="wav" style="background:${w.color};width:14px;height:14px"></i>${w.label}</span></td><td class="l addr">${w.address}</td><td>${w.bnb.toFixed(5)}</td><td>$${(w.bnb * S.bnbUsd).toFixed(2)}</td><td>${bnb(pv)} BNB</td>
          <td class="l ${w.agentId ? 'g' : 'r'}">${w.agentId ? '已绑定 ✓' : '未绑定'}</td><td class="l ${w.whitelisted ? 'g' : 'r'}">${w.whitelisted ? '已在白名单' : '非白名单'}</td><td>${w.nonce}</td>
          <td>${LIVE() ? '—' : `<button class="qb" style="display:inline" data-faucet="${w.id}">+5 测试 BNB</button>`}</td></tr>`; }).join('') || `<tr><td colspan="9" class="l">${esc(S.baw?.error || '没有钱包')}</td></tr>`}</table>`;
      break;
    }
    case 'logs': {
      cnt = S.logs.length + ' 条';
      html = S.logs.map((l) => `<div class="log-line ${l.level}"><span class="t">${hms(l.ts)}</span><span>${esc(l.msg)}</span></div>`).join('') || '<div class="empty">暂无事件</div>';
      break;
    }
  }
  const keep = b.scrollTop; b.innerHTML = html; b.scrollTop = keep;
  $('#bottomCnt').textContent = cnt;
}

/* ---------- 右栏 ---------- */
function renderRight() {
  const t = S.tokens.get(S.selected);
  const buy = S.side === 'buy';
  $('#amtLabel').textContent = buy ? '买入金额' : '卖出比例';
  $('#amtMode').classList.toggle('hidden', !buy);
  $('#wLabel').textContent = buy ? '买入钱包' : '卖出钱包';
  const unit = buy ? (S.amtMode === 'bnb' ? 'BNB' : '%') : '%';
  $('#amtUnit').textContent = unit;
  const aw = wallet([...S.selWallets][0] || S.activeWallet);
  const held = S.positions.filter((p) => p.token === S.selected && S.selWallets.has(p.walletId)).reduce((a, p) => a + p.amount, 0);
  $('#avail').textContent = buy ? `${(aw.bnb ?? 0).toFixed(4)} BNB` : `${K(held)} ${t?.symbol || ''}`;
  const presets = buy && S.amtMode === 'bnb' ? [0.01, 0.05, 0.1, 0.2, 0.5] : buy ? [0.5, 1, 2, 3, 5] : [10, 25, 50, 75, 100];
  const ph = presets.join();
  if ($('#presets').dataset.k !== ph) { $('#presets').dataset.k = ph; $('#presets').innerHTML = presets.map((p) => `<button data-p="${p}">${p}${unit === '%' ? '%' : ''}</button>`).join(''); }
  $('#wchips').innerHTML = S.wallets.map((w) => { const el = eligible(w, t); return `<button class="wchip ${S.selWallets.has(w.id) ? 'on' : ''}" data-w="${w.id}" title="${el.ok ? '' : el.why}"><i class="wav" style="background:${w.color}"></i>${w.label}<span class="mono">${w.bnb.toFixed(w.bnb < 10 ? 3 : 2)}</span>${el.ok ? '' : '<span class="r" style="font-size:10px">非白名单</span>'}</button>`; }).join('');
  const n = S.selWallets.size;
  $('#wHint').textContent = S.wallets.length > 1 ? `已选 ${n} 个 · ${buy ? '每个钱包各买一份' : '每个钱包各卖同比例'}` : (LIVE() ? '币安 Agentic Wallet' : '单钱包');
  const btn = $('#submit');
  btn.className = 'big-btn ' + (buy ? '' : 'sell');
  btn.textContent = !t ? '选择代币' : REAL() ? `${buy ? '买入' : '卖出'} ${t.symbol}（真实上链）` : LIVE() ? `${buy ? '报价买入' : '报价卖出'} ${t.symbol}（只报价，不上链）` : n > 1 ? (buy ? `买入 ${t.symbol} · ${n} 个钱包各一份` : `卖出 ${t.symbol} · ${n} 个钱包`) : `${buy ? '买入' : '卖出'} ${t.symbol}`;
  const gangOnly = false;   // Gang V2 报价币盘也能下单了（BNB→报价币→buy，非原子）
  btn.disabled = !t || !n || t.stage === 'rugged' || (REAL() && !AUTH_OK()) || gangOnly;
  if (REAL() && !AUTH_OK() && t) btn.textContent = '币安钱包未登录，不能下单';
  $('#fastMode').checked = !!S.fast; $('#autoClaim').checked = S.settings.autoClaim !== false; $('#sellToBnb').checked = S.settings.sellToBnb !== false; $('#preApproveCap').checked = S.settings.preApproveCap !== false;
  renderAutoSend();
  renderMyPos(t); renderInfo(t);
}

function renderMyPos(t) {
  if (!t) { $('#myPos').innerHTML = ''; return; }
  const ps = S.positions.filter((p) => p.token === t.address);
  const sum = (k) => ps.reduce((a, p) => a + (p[k] || 0), 0);
  const hr = LIVE() ? holdRow(t) : null;   /* 实盘：和一键买卖、我的持仓用同一份持仓快照（报价币已按 BNB 价换算成美元） */
  const plat = t.platform === 'four' ? 'Four · Agent ID 专属' : t.platform === 'gang' ? (t.gangTrack === 'v2' ? `Gang V2 · 计价 ${esc(t.quote || '')}` : 'Gang · Agent ID 专属') : t.platform === 'gwei' ? 'GWEI · Agent ID 专属曲线' : 'Flap · Agent 曲线';
  const tag = LIVE() ? `${plat} · 资格以合约为准` : t.platform === 'four' ? `Four：${eligible(wallet(S.activeWallet), t).ok ? '钱包已在白名单' : '钱包不在白名单'}` : `${plat}`;
  const usd = (v) => (v == null ? '—' : '$' + v.toFixed(2)), sgn = (v) => (v == null ? '—' : `<b class="${v >= 0 ? 'g' : 'r'}">${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}</b>`);
  let amt, rows;
  if (hr) {
    amt = hr.amount || 0;
    const pnl = hr.valueUsd != null ? hr.valueUsd - (hr.costUsd || 0) + (hr.soldUsd || 0) : null;
    rows = `<div class="kv"><span>持仓价值（估）</span><b>${usd(hr.valueUsd)}${hr.valueBnb != null ? ` <small class="muted">≈ ${bnb(hr.valueBnb)} BNB</small>` : ''}</b></div>
    <div class="kv"><span>盈亏</span>${hr.costUsd || hr.soldUsd ? sgn(pnl) : '<b>—</b>'}</div>
    <div class="kv"><span>累计买入 / 卖出</span><b>${usd(hr.costUsd || 0)} / ${usd(hr.soldUsd || 0)}</b></div>`;
  } else if (LIVE()) {
    amt = 0; rows = '<div class="kv"><span>持仓</span><b class="muted">持仓快照里没有这个币</b></div>';
  } else {
    amt = sum('amount'); const val = sum('valueBnb'), buyB = sum('boughtBnb'), sold = sum('soldBnb'), pnl = val + sold - buyB;
    rows = `<div class="kv"><span>持仓价值（估）</span><b>${bnb(val)} BNB ≈ $${(val * S.bnbUsd).toFixed(2)}</b></div>
    <div class="kv"><span>盈亏</span><b class="${pnl >= 0 ? 'g' : 'r'}">${buyB ? (pnl >= 0 ? '+' : '') + bnb(pnl) + ' BNB' : '—'}</b></div>
    <div class="kv"><span>累计买入 / 卖回</span><b>${bnb(buyB)} / ${bnb(sold)} BNB</b></div>`;
  }
  $('#myPos').innerHTML = `<h4>我的仓位<span>${tag}</span></h4>
    <div class="kv"><span>持有代币</span><b>${K(amt)} ${esc(t.symbol)}</b></div>
    ${rows}
    ${amt > 0 ? `<div class="sellbtns">${[25, 50, 75, 100].map((p) => `<button data-qsell="${p}">卖 ${p}%</button>`).join('')}</div>` : ''}`;
}

function renderInfo(t) {
  if (!t) { $('#tokenInfo').innerHTML = ''; return; }
  const el = eligible(wallet(S.activeWallet), t);
  const box = (k, v) => `<div class="addrbox"><span>${k}</span><b data-copy="${v}" title="点击复制">${v}</b></div>`;
  $('#tokenInfo').innerHTML = `<h4>${t.platform === 'four' ? 'Binance Agent 专属代币信息' : t.platform === 'gang' ? (t.gangTrack === 'v2' ? 'Gang V2 代币信息' : 'Gang 代币信息') : t.platform === 'gwei' ? 'GWEI 代币信息' : 'Flap Agent 曲线代币信息'}</h4>
    ${box('代币', t.address)}${t.vault ? box(LIVE() ? 'Market' : 'Vault', t.vault) : ''}${t.creator ? box('创建者', t.creator) : ''}
    <div class="kv"><span>平台</span><b class="sans">${t.platform === 'four' ? 'OpenFour（four.meme）' : t.platform === 'gang' ? (t.gangTrack === 'v2' ? `gang.fun V2（报价币 ${esc(t.quote)}，买卖要先换币，非原子）` : 'gang.fun（Agent ID 专属，合约 0x315B…23A7）') : t.platform === 'gwei' ? 'gwe1.xyz（代币合约就是曲线，单笔 ≤ 0.1 BNB，100 BNB 迁移 PancakeSwap）' : 'Flap（flap.sh）'}</b></div>
    <div class="kv"><span>预设</span><b class="sans">${t.preset} <span class="muted mono">${t.presetId}</span></b></div>
    <div class="kv"><span>计价资产</span><b>${t.quote}${t.quote !== 'BNB' ? '（Core 同笔兑换）' : ''}</b></div>
    <div class="kv"><span>状态</span><b class="sans ${t.stage === 'curve' ? 'b' : t.stage === 'dex' ? 'g' : 'r'}">${t.stage === 'curve' ? `内盘 ${t.progress.toFixed(2)}%` : t.stage === 'dex' ? '已迁移 PancakeSwap' : '已撤池'}</b></div>
    <div class="kv"><span>交易资格</span><b class="sans ${el.ok ? 'g' : 'r'}">${el.ok ? '你的钱包可交易' : '你的钱包' + el.why}</b></div>
    ${LIVE() ? `<div class="kv"><span>已筹 / 上限</span><b>${amt(t.raised)} / ${amt(t.target)} ${esc(t.quote)}</b></div>`
      : `<div class="kv"><span>总量 / 内盘出售</span><b>1.00B / 800M</b></div><div class="kv"><span>每钱包上限</span><b>${t.platform === 'four' || t.platform === 'gang' ? '总量 1%（10M）' : '不限'}</b></div>`}
    ${t.platform === 'gwei' ? '<div class="kv"><span>总量 / 每钱包上限</span><b>21M / 总量 1%（210K）</b></div>' : ''}`;
}

let qTimer;
function refreshQuote() {
  clearTimeout(qTimer);
  qTimer = setTimeout(async () => {
    const t = S.tokens.get(S.selected); if (!t) return;
    const wid = [...S.selWallets][0] || S.activeWallet;
    if (S.side === 'buy' && S.amtMode === 'pct') {
      const v = parseFloat($('#amount').value);
      try { const c = v > 0 ? await api(`/api/cost-for-pct?wallet=${wid}&token=${t.address}&pct=${v}&slippage=${S.slippage}`) : { bnb: 0 }; S.pctBnb = c.bnb || 0; S.pctNote = c.note || (c.capReached ? c.error : ''); } catch { S.pctBnb = 0; S.pctNote = ''; }
    }
    const amount = orderAmount(wid);
    try {
      const q = await api(`/api/preview?wallet=${wid}&token=${t.address}&side=${S.side}&amount=${amount || 0}&slippage=${S.slippage}`);
      $('#route').textContent = '✦ ' + q.route; $('#route').title = q.route;
      const sym = S.side === 'buy' ? t.symbol : 'BNB';
      const f = (v) => (S.side === 'buy' ? K(v) : bnb(v, 6));
      $('#quote').innerHTML = q.out != null ? `
        ${S.side === 'buy' && S.amtMode === 'pct' ? `<div><span>需花费</span><b>${bnb(amount, 6)} BNB${S.pctNote ? ` <span style="color:#8fb3d9">ⓘ ${esc(S.pctNote)}</span>` : ''}</b></div>` : ''}<div><span>预计获得</span><b>${f(q.out)} ${esc(sym)}</b></div><div><span>最少获得</span><b>${f(q.minOut)} ${esc(sym)}</b></div>
        <div><span>手续费</span><b>${bnb(q.feeBnb, 6)} BNB</b></div><div><span>税率 买/卖</span><b class="${taxHi(t) ? 'r' : ''}">${pctTxt(t.buyFeePct)} / ${pctTxt(t.sellFeePct)}</b></div>${S.side === 'buy' ? (() => { const rt = roundTrip(t, S.amtMode === 'pct' ? S.pctBnb : amount); return rt ? `<div><span>买入再卖出预计损耗</span><b class="${rt.pct >= 5 ? 'r' : ''}">${bnb(rt.cost, 5)} BNB（${rt.pct.toFixed(1)}%）</b></div>` : ''; })() : ''}`
        : '<div><span>预计获得</span><b>—</b></div><div><span>最少获得</span><b>—</b></div><div><span>手续费</span><b>—</b></div><div><span>—</span><b>—</b></div>';
    } catch { /* ignore */ }
  }, 150);
}
setInterval(refreshQuote, 1500);

function orderAmount(wid) {
  const v = parseFloat($('#amount').value);
  if (!(v > 0)) return 0;
  if (S.side === 'sell') return Math.min(100, v);
  return S.amtMode === 'bnb' ? v : (S.pctBnb || 0);
}

async function submitOrder({ token = S.selected, side = S.side, wallets = [...S.selWallets], amountFor = orderAmount } = {}) {
  const t = S.tokens.get(token); if (!t) return;
  if (side === 'buy' && S.amtMode === 'pct' && amountFor === orderAmount) {   // 下单前按最新报价重新换算，避免用到旧的金额
    const v = parseFloat($('#amount').value);
    let c = { bnb: 0 };
    try { c = v > 0 ? await api(`/api/cost-for-pct?wallet=${wallets[0] || S.activeWallet}&token=${token}&pct=${v}&slippage=${S.slippage}`) : c; } catch { /* 下面按 0 处理 */ }
    S.pctBnb = c.bnb || 0;
    if (!S.pctBnb && c.capReached) return note(`${t.symbol}：${c.error}，没有下单`, 'info');
    if (c.note) note(`${t.symbol}：${c.note}`, 'info');
  }
  const items = wallets.map((w) => ({ w, amount: amountFor(w) })).filter((x) => x.amount > 0);
  if (!items.length) return toast({ status: 'failed', reason: side === 'buy' ? '请输入买入金额' : '请输入卖出比例', symbol: t.symbol });
  const go = async () => {
    const btn = $('#submit'); btn.classList.add('busy');
    topPop({ status: 'pending', side, symbol: t.symbol, amountIn: side === 'buy' ? items[0].amount : items[0].amount });
    try { await Promise.all(items.map((x) => api('/api/order', { wallets: [x.w], token, side, amount: x.amount, slippage: S.slippage }))); }
    catch (e) { toast({ status: 'failed', reason: e.message, symbol: t.symbol }); topPop({ status: 'failed', side, reason: e.message, symbol: t.symbol }); }
    btn.classList.remove('busy');
  };
  if (S.fast) return go();
  $('#confirmBody').innerHTML = `
    <div class="kv"><span>代币</span><b>${esc(t.symbol)}</b></div>
    <div class="kv"><span>方向</span><b class="${side === 'buy' ? 'g' : 'r'}">${side === 'buy' ? '买入' : '卖出'}</b></div>
    ${items.map((x) => `<div class="kv"><span>${wallet(x.w).label}</span><b>${side === 'buy' ? x.amount + ' BNB' : x.amount + '%'}</b></div>`).join('')}
    <div class="kv"><span>滑点</span><b>${S.slippage}%</b></div>
    <div class="kv"><span>税率 买/卖</span><b class="${taxHi(t) ? 'r' : ''}">${pctTxt(t.buyFeePct)} / ${pctTxt(t.sellFeePct)}</b></div>
    ${taxHi(t) && side === 'buy' ? (() => { const rt = roundTrip(t, items[0]?.amount); return `<div class="note" style="color:#f6465d">⚠ 当前税率 买 ${pctTxt(t.buyFeePct)} / 卖 ${pctTxt(t.sellFeePct)}${rt ? `，买入再卖出预计损耗约 ${rt.pct.toFixed(1)}%（${bnb(rt.cost, 5)} BNB，不含价格变动）` : ''}</div>`; })() : ''}
    ${REAL() ? `<div class="note" style="color:var(--red,#f6465d)">真实交易：会用你的币安 Agentic 钱包上链，花费真实 BNB，可能亏损，无法撤回。单笔上限 ${S.baw.maxTradeBnb || '不限'} BNB。${S.tokens.get(token)?.quote && S.tokens.get(token).quote !== 'BNB' && side === 'buy' ? `路径：BNB→${esc(S.tokens.get(token).quote)}→Portal.buyWithQuote，会有 2～4 笔交易。` : ''}</div>` : ''}
    <div class="note">打开「极速模式（免确认）」可跳过此确认，点击即直接提交链上请求。</div>
    <button class="big-btn ${side === 'buy' ? '' : 'sell'}" id="confirmGo">确认${side === 'buy' ? '买入' : '卖出'}</button>`;
  $('#confirmModal').classList.remove('hidden');
  $('#confirmGo').onclick = () => { $('#confirmModal').classList.add('hidden'); go(); };
}

// 普通提示（不是订单结果）
// 普通提示：kind='ok' 绿色，'info' 灰蓝色（自动调整金额之类，不是失败）
function note(text, kind = 'ok') { const el = document.createElement('div'); el.className = 'toast' + (kind === 'info' ? ' info' : ''); el.innerHTML = kind === 'info' ? `<span style="color:#8fb3d9">ⓘ ${esc(text)}</span>` : `<b class="g">${esc(text)}</b>`; $('#toasts').prepend(el); setTimeout(() => el.remove(), 5000); }

// 把链上 / baw 的英文报错翻成中文
const ERR_ZH = [
  [/wallet cap|max.*per wallet|exceeds? .*cap/i, '已达到单个钱包的持仓上限，不能再买了'],
  [/insufficient funds|insufficient balance|not enough/i, '余额不足'],
  [/slippage|too little received|min(imum)? ?out|INSUFFICIENT_OUTPUT/i, '价格变动超过滑点容忍度，请调大滑点后重试'],
  [/not whitelisted|whitelist/i, '钱包不在白名单'],
  [/deadline|expired/i, '交易超时过期'],
  [/balance is insufficient|insufficient balance|insufficient funds|exceeds balance|余额不足/i, '余额不足：要卖 / 要花的数量比钱包里的多（可能是刚卖过、余额还没刷新，或者 gas 用的 BNB 不够），这次没有成交'],
  [/min(imum)?\s*(order|amount|trade)|too small|below (the )?min|dust/i, '金额太小，低于最小下单额'],
  [/liquidity|no route|route not found|cannot find (a )?route/i, '找不到兑换路径或流动性不足'],
  [/slippage|price impact|INSUFFICIENT_OUTPUT/i, '价格变动超过滑点，没有成交（可以调大滑点再试）'],
  [/risk|rejected by risk|abnormal|AutoReject/i, '被币安风控拒绝（钱包设置为自动拒绝异常交易时会这样）'],
  [/daily limit|quota|exceed(ed)? (the )?limit/i, '超过币安钱包的每日额度'],
  [/nonce/i, '交易序号冲突，请稍后重试'],
  [/user rejected|denied|cancel/i, '已取消'],
  [/already in progress|same address on this network/i, '钱包里有一笔交易还在等待（多半要在币安 App 里确认或拒绝），处理完再下单，这次没有发出交易'],
  [/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed|network/i, '网络超时，请重试'],
  [/rate limit|429|too many requests/i, '请求太频繁，请稍后重试'],
  [/403|forbidden/i, '节点拒绝了请求'],
  [/not (signed|logged) in|unauthori[sz]ed|401|session/i, '币安钱包未登录或登录已过期'],
  [/trading (not|isn't) (open|started)|not started|paused/i, '还没开盘或交易已暂停'],
  [/migrat|graduat|curve (is )?(full|completed|closed)/i, '内盘已满或已迁移'],
  [/gas/i, 'Gas 不足或估算失败'],
];
function zhErr(msg) {
  const s = String(msg || ''); if (!s || /[\u4e00-\u9fa5]/.test(s) && !/[A-Za-z]{6,}/.test(s.replace(/BNB|baw|Four|Flap|Agent|Portal|PancakeSwap/g, ''))) return s;
  const sim = /simulation failed|execution reverted|revert/i.test(s);
  for (const [re, zh] of ERR_ZH) if (re.test(s)) return (sim ? '交易预演失败：' : '') + zh;
  const m = s.match(/reverted:?\s*([^"\n(]+)/i);
  if (sim) return '交易预演失败，合约拒绝' + (m ? `（${m[1].trim()}）` : '');
  return '下单失败：' + s.slice(0, 120);
}

// 顶部居中的买卖弹窗：提交时显示「提交中」，结果回来后变成成交 / 失败
let popTimer;
function topPop(o) {
  let el = $('#topPop'); if (!el) { el = document.createElement('div'); el.id = 'topPop'; document.body.appendChild(el); }
  const buy = o.side === 'buy', act = buy ? '买入' : '卖出';
  const amt = o.amountIn != null ? (buy ? `${bnb(o.amountIn)} BNB` : `${o.amountIn}%`) : '';
  const cls = o.status === 'pending' ? 'pend' : o.status === 'filled' ? (buy ? 'buy' : 'sell') : o.status === 'dry_run' ? 'dry' : 'err';
  const bc = o.status === 'pending' && o.stage === 'broadcast' && o.pendingTx;
  const title = bc ? (/授权/.test(o.steps?.at(-1)?.name || '') ? '授权已发出，等待上链…' : '已发出，等待上链…') : o.status === 'pending' ? `${act}已提交，处理中…` : o.status === 'filled' ? `${act}成功` : o.status === 'dry_run' ? `${act}已报价（未上链）` : `${act}失败`;
  const detail = o.status === 'failed' ? esc(zhErr(o.reason)) : o.status === 'filled'
    ? (buy ? `${amt} → ${K(o.out || 0)} ${esc(o.symbol)}` : `${amt} → ${o.out != null ? bnb(o.out) + ' BNB' : '?'}`) : amt;
  el.className = 'toppop show ' + cls;
  el.innerHTML = `<b>${title}</b><span>${esc(o.symbol || '')}</span><span class="mono">${detail}</span>${o.tx ? txLink(o.tx) : bc ? txLink(o.pendingTx) : ''}`;
  clearTimeout(popTimer);
  if (o.status !== 'pending') popTimer = setTimeout(() => el.classList.remove('show'), o.status === 'filled' ? 4000 : 6000);
}

function toast(o) {
  const el = document.createElement('div');
  const ok = o.status === 'filled';
  el.className = 'toast ' + (ok ? '' : o.status === 'dry_run' ? 'dry' : 'err');
  el.innerHTML = o.status === 'dry_run'
    ? `<b class="y">已报价（未上链）</b> · ${esc(o.symbol)} · ${o.wallet} · <span class="mono">${o.latencyMs}ms</span><div class="mono muted">${o.side === 'buy' ? `${bnb(o.amountIn)} BNB → ${o.out != null ? K(o.out) : '?'}` : `${K(o.amountIn || 0)} → ${o.out != null ? bnb(o.out) : '?'} BNB`}</div><div class="muted">${esc(o.route || '')}</div><div class="steps">${o.steps.map((s) => `${s.name} ${s.ms}ms`).join(' → ')}</div>`
    : ok
    ? o.side === 'claim' ? `<b class="g">领取成功</b> · ${esc(o.symbol)} · ${K(o.out || 0)} 个代币${o.tx ? `<div>${txLink(o.tx)}</div>` : ''}`
    : `<b class="${o.side === 'buy' ? 'g' : 'r'}">${o.side === 'buy' ? '买入' : '卖出'}成交</b> · ${esc(o.symbol)} · ${o.wallet} · <span class="mono">${o.latencyMs}ms</span><div class="mono muted">${o.side === 'buy' ? `${bnb(o.amountIn)} BNB → ${K(o.out || 0)}` : LIVE() ? `${o.amountIn}% → ${o.out != null ? bnb(o.out) + ' BNB' : '?'}` : `${K(o.amountIn)} → ${bnb(o.out)} BNB`}</div>${o.tx ? `<div>${txLink(o.tx)}</div>` : ''}${o.reason ? `<div class="y">${esc(o.reason)}</div>` : ''}<div class="steps">${o.steps.map((s) => `${s.name} ${s.ms}ms`).join(' → ')}</div>`
    : `<b class="r">失败</b> · ${esc(o.symbol || '')} ${o.wallet ? '· ' + o.wallet : ''}<div class="muted">${esc(zhErr(o.reason))}</div>`;
  $('#toasts').prepend(el);
  setTimeout(() => el.remove(), REAL() ? 15000 : ok ? 5000 : 4000);
  while ($('#toasts').children.length > 3) $('#toasts').lastChild.remove();
}

/* ---------- 控件状态 ---------- */
function renderControls() {
  const c = S.config; if (!c) return;
  $('#btnSound').classList.toggle('off', !c.sound); $('#btnSound').title = `声音：${c.sound ? '开' : '关'}。出新币「叮咚」、成交提示音（战壕各列的小喇叭单独控制）`;
  $('#btnBell').classList.toggle('off', !c.notify); $('#btnBell').title = `新币通知：${c.notify ? '开' : '关'}。页面在后台时，当前平台出新币弹系统通知`;
  if (document.activeElement !== $('#quickBuy')) $('#quickBuy').value = c.quickBuy;
  const gas = { normal: '普通', high: 'HIGH', turbo: '极速' }[S.settings.gas] || 'HIGH';
  const autos = ['four', 'flap'].filter((p) => c[p].enabled).map((p) => (p === 'four' ? 'Four' : 'Flap'));
  $('#settingsSummary').textContent = LIVE() ? `${REAL() ? '实盘 · 手动真实下单' : '实盘行情 · 只报价'} · 自动买只报价 · 🎯 自动买 ${c.paused ? '已暂停' : autos.join('/') || '关'}` : `${S.settings.execPath === 'ai' ? 'AI 思考后提交' : '直接提交'} · ${S.settings.multiRpc ? '多 RPC 加速' : '单 RPC'} · 外盘 ${gas} · 🎯 自动买 ${c.paused ? '已暂停' : autos.join('/') || '关'}`;
}

/* ---------- 交易设置弹窗 ---------- */
function renderSettings() {
  const c = S.config; const p = S.settingsPlat; const pc = c[p]; const u = S.usage[p] || { spent: 0, budget: 0, lastHour: 0, hourlyMax: 0 };
  const four = p === 'four';
  const notWl = pc.wallets.map(wallet).filter((w) => four && !(w.agentId && w.whitelisted));
  const f = (label, key, val, step = 'any') => `<label class="field"><span>${label}</span><input type="number" step="${step}" data-cfg="${p}.${key}" value="${val}" /></label>`;
  const tgl = (key, on, label = '开启') => `<label class="tgl"><input type="checkbox" data-cfgb="${key}" ${on ? 'checked' : ''}/><i></i>${label}</label>`;
  const curve = S.snipeCurve.length ? S.snipeCurve : [[0, 50.3], [0.5, 33.8], [1, 20.6], [1.5, 13.8], [2, 9.9], [2.5, 5.7], [3, 1.96]];
  $('#settingsBody').innerHTML = `
  <div class="note" style="margin-bottom:8px">自动买入已移除：程序不会再自动下任何买单，只有你手动点的买入才会下单。</div>

  ${LIVE() ? '' : `<div class="box">
    <div class="box-h">⛽ Gas 与加速</div>
    <div class="note">交易本质就是一个链上请求，Agent 慢都慢在提交前的流程。这里预先构建好交易模板、本地缓存 nonce，命中后只做「填参数 → 签名 → 多节点同时广播」。</div>
    <div><div class="note" style="margin-bottom:6px">Gas 档位（外盘 / 内盘通用）</div>
      <div class="seg" id="setGas">${[['normal', '普通 0.1 gwei'], ['high', 'HIGH 1 gwei'], ['turbo', '极速 3 gwei']].map(([k, l]) => `<button data-gas="${k}" class="${S.settings.gas === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <label class="tgl"><input type="checkbox" data-set="multiRpc" ${S.settings.multiRpc ? 'checked' : ''}/><i></i>多 RPC 并发广播（48 Club + GetBlock + bsc.publicnode.com）</label>
    <div><div class="note" style="margin-bottom:6px">执行路径</div>
      <div class="seg" id="setExec"><button data-exec="direct" class="${S.settings.execPath !== 'ai' ? 'active' : ''}">直接提交（跳过 AI 思考）</button><button data-exec="ai" class="${S.settings.execPath === 'ai' ? 'active' : ''}">AI 思考 → 确认 → 执行（对照）</button></div></div>
  </div>`}

  <div class="box">
    <div class="box-h">📤 自动卖出<span class="spacer"></span>${tgl('exit.enabled', c.exit.enabled)}</div>
    <div class="fgrid">
      <label class="field"><span>止盈 %</span><input type="number" data-cfg="exit.takeProfitPct" value="${c.exit.takeProfitPct}" /></label>
      <label class="field"><span>止盈时卖出 %</span><input type="number" data-cfg="exit.takeProfitSellPct" value="${c.exit.takeProfitSellPct}" /></label>
      <label class="field"><span>止损 %</span><input type="number" data-cfg="exit.stopLossPct" value="${c.exit.stopLossPct}" /></label>
      <label class="field"><span>止盈后移动止损回撤 %</span><input type="number" data-cfg="exit.trailingPct" value="${c.exit.trailingPct}" /></label>
      <label class="field"><span>最长持仓（分钟，0 = 不限）</span><input type="number" data-cfg="exit.maxHoldMin" value="${c.exit.maxHoldMin}" /></label>
    </div>
  </div>

  ${LIVE() ? `<div class="box">
    <div class="box-h">🔌 实盘行情连接</div>
    <div class="kv"><span>Flap Agent Curve Reader</span><b class="sans ${S.net.curve?.connected ? 'g' : 'r'}">${S.net.curve?.connected ? `已连接 · ${S.net.curve.total} 个市场 · 轮询 ${S.net.curve.lastPollMs}ms` : esc(S.net.curve?.lastError || '连接中')}</b></div>
    <div class="kv"><span>shrine 新盘推送 / 成交流</span><b class="sans">${S.net.shrine?.launch?.connected ? '<span class="g">新盘 ✓</span>' : '<span class="r">新盘 ✗</span>'} · ${S.net.shrine?.stream?.connected ? '<span class="g">成交 ✓</span>' : '<span class="r">成交 ✗</span>'}</b></div>
    <div class="kv"><span>BSC RPC</span><b class="sans ${S.net.rpcError ? 'r' : 'g'}">${S.net.rpcError ? esc(S.net.rpcError) : `#${S.block.toLocaleString('en-US')} · ${S.net.rpc}ms`}</b></div>
    <div class="kv"><span>币安 Agentic Wallet（baw）</span><b class="sans ${S.baw?.connected ? 'g' : 'r'}">${S.baw?.connected ? '已连接（只读）' : esc(S.baw?.error || '未连接')}</b></div>
    ${REAL() ? `<div class="kv"><span>实盘单笔上限 (BNB)</span><b class="sans"><input type="number" min="0" step="0.01" id="maxTradeBnb" value="${S.baw.maxTradeBnb || ''}" placeholder="不限" style="width:90px"/></b></div>
    <div class="note">每笔手动买入最多花这么多 BNB，填 0 或留空表示不限。改完立即生效，重启后也保留。</div>
    <div class="warn-box">手动买卖会通过 baw 真实上链；自动买 / 自动卖命中后只记录报价，不会下单。</div>`
    : '<div class="warn-box">当前是只报价模式：下单只做报价和预演，不会提交链上交易。</div>'}
  </div>` : `<div class="box">
    <div class="box-h">🧪 模拟钱包状态</div>
    ${S.wallets.map((w) => `<div class="inline" style="gap:14px"><span class="side" style="display:flex;gap:6px;align-items:center;width:70px"><i class="wav" style="background:${w.color};width:14px;height:14px"></i><b>${w.label}</b></span>
      <label class="tgl"><input type="checkbox" data-wflag="${w.id}:agentId" ${w.agentId ? 'checked' : ''}/><i></i>Agent ID</label>
      <label class="tgl"><input type="checkbox" data-wflag="${w.id}:whitelisted" ${w.whitelisted ? 'checked' : ''}/><i></i>白名单</label>
      <span class="spacer"></span><button class="optbtn" data-faucet="${w.id}">+5 BNB</button></div>`).join('')}
    <div class="note">推文提到：Four 前几个测试币（Test ~ Test4）只有官方测试地址在白名单，普通钱包都打不了，可以无视；开盘后所有 .ai 地址都会加入白名单。</div>
    <button class="optbtn" id="fakeLaunch" style="align-self:flex-start">＋ 立即发射一个 Four 新币（测试狙击）</button>
  </div>`}`;
  renderRecords();
}
function renderRecords() {
  const el = $('#records'); if (!el) return;
  const rs = S.records.filter((r) => r.platform === S.settingsPlat);
  el.innerHTML = rs.length ? rs.slice(0, 40).map((r) => `<div><span class="dim mono">${hms(r.ts)}</span> <span class="${r.status === 'buy' ? 'g' : r.status === 'fail' ? 'r' : ''}">${esc(r.symbol)}</span> ${esc(r.msg)}</div>`).join('') : '暂无记录';
}
const setPath = (obj, path, v) => { const ks = path.split('.'); const root = {}; let o = root; ks.slice(0, -1).forEach((k) => (o = o[k] = {})); o[ks[ks.length - 1]] = v; return root; };
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
async function patchCfg(path, v) { S.config = await api('/api/config', setPath({}, path, v)); renderControls(); }

/* ---------- 事件绑定 ---------- */
// 点代币名复制代号（详情页标题、战壕卡片）。捕获阶段处理并阻止冒泡，免得点卡片名字顺带打开详情 / 买入
async function copyText(v) {
  try { await navigator.clipboard.writeText(v); return true; } catch { /* 非安全上下文等，退回 textarea */ }
  const ta = document.createElement('textarea'); ta.value = v; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); return ok;
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-ctick]'); if (!el) return;
  e.stopPropagation(); e.preventDefault();
  const v = el.dataset.ctick; (await copyText(v)) ? note(`已复制 ${v}`) : note(`复制失败，请手动选中 ${v}`, 'info');
}, true);
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-qp],[data-qb],[data-a],[data-p],[data-s],[data-a2],[data-w],[data-copy],[data-sell],[data-qsell],[data-faucet],[data-ext],[data-close],[data-sp],[data-setw],[data-fee],[data-mode],[data-q],[data-gas],[data-exec],#fakeLaunch');
  if (!el) return;
  const d = el.dataset;
  if (d.qp) { e.stopPropagation(); e.preventDefault(); return pulseBuy1(d.qp); }
  if (d.qb) { e.stopPropagation(); const amt = S.config?.quickBuy || 0.1; S.fast = S.fast; return submitQuick(d.qb, amt); }
  if (el.closest('#walletMenu') && d.w) { S.activeWallet = d.w; $('#walletMenu').classList.add('hidden'); return scheduleRender(); }
  if (el.closest('#wchips') && d.w) { S.selWallets.has(d.w) ? S.selWallets.delete(d.w) : S.selWallets.add(d.w); renderRight(); return refreshQuote(); }
  if (d.a && !el.closest('#platTabs')) { e.preventDefault(); return select(d.a); }
  if (el.closest('#presets') && d.p) { $('#amount').value = d.p; return refreshQuote(); }
  if (el.closest('#platTabs') && d.p) { S.platform = d.p; $$('#platTabs button').forEach((b) => b.classList.toggle('active', b === el)); syncUrl(); lastList = 0; scheduleRender(); const f = filtered()[0]; if (f && S.tokens.get(S.selected)?.platform !== d.p) select(f.address); return; }
  if (el.closest('#sideTabs')) { S.side = d.s; $$('#sideTabs button').forEach((b) => b.classList.toggle('active', b === el)); $('#amount').value = ''; renderRight(); return refreshQuote(); }
  if (d.copy) { navigator.clipboard?.writeText(d.copy); return toast({ status: 'filled', side: 'buy', symbol: '已复制', wallet: short(d.copy), latencyMs: 0, amountIn: 0, out: 0, steps: [] }); }
  if (d.claim) { e.stopPropagation(); el.disabled = true; el.textContent = '领取中…'; try { await api('/api/claim', { market: d.claim }); } catch (err) { toast({ status: 'failed', symbol: '领取', reason: err.message }); } return; }
  if (d.sell) { const [w, tk, pct] = d.sell.split(':'); return api('/api/order', { wallets: [w], token: tk, side: 'sell', amount: +pct, slippage: S.slippage }); }
  if (d.qsell) { return submitOrder({ side: 'sell', amountFor: () => +d.qsell, wallets: LIVE() ? [S.activeWallet] : S.wallets.map((w) => w.id).filter((w) => S.positions.some((p) => p.walletId === w && p.token === S.selected && p.amount > 0)) }); }
  if (d.faucet) { S.wallets = await api(`/api/wallet/${d.faucet}`, { faucet: 5 }); scheduleRender(); return; }
  if (d.ext) {
    e.preventDefault();
    if (!LIVE()) return toast({ status: 'failed', symbol: '模拟盘', reason: '模拟代币没有真实链上页面' });
    const t = S.tokens.get(S.selected); if (!t) return;
    const url = { four: t.platform === 'four' ? `https://four.meme/token/${t.address}` : t.platform === 'gang' ? `https://gang.fun/token/${t.address.toLowerCase()}` /* Gang（老盘和 V2）：直接打开这个币在 gang.fun 的页面 */ : t.platform === 'gwei' ? 'https://gwe1.xyz/' :'https://flap.sh/apps/agent-bonding-curve?lang=zh' /* Flap：打开 Agent Bonding Curve 页面 */, bsc: `https://bscscan.com/token/${t.address}`, gmgn: `https://gmgn.ai/bsc/token/${t.address}` }[d.ext];
    return window.open(url, '_blank', 'noopener');
  }
  if (d.close !== undefined) return el.closest('.modal').classList.add('hidden');
  if (d.sp) { S.settingsPlat = d.sp; return renderSettings(); }
  if (d.setw) { const ws_ = new Set(S.config[S.settingsPlat].wallets); ws_.has(d.setw) ? ws_.delete(d.setw) : ws_.add(d.setw); await patchCfg(`${S.settingsPlat}.wallets`, [...ws_]); return renderSettings(); }
  if (d.fee) { await patchCfg('four.antiSnipe.maxFeePct', +d.fee); return renderSettings(); }
  if (d.mode) { await patchCfg(`${S.settingsPlat}.mode`, d.mode); return renderSettings(); }
  if (d.q) { await patchCfg(`${S.settingsPlat}.quote`, d.q); return renderSettings(); }
  if (d.gas) { S.settings = await api('/api/settings', { gas: d.gas }); renderControls(); return renderSettings(); }
  if (d.exec) { S.settings = await api('/api/settings', { execPath: d.exec }); renderControls(); return renderSettings(); }
  if (el.id === 'fakeLaunch') { await api('/api/launch', { platform: 'four' }); return toast({ status: 'filled', side: 'buy', symbol: '已发射新币', wallet: '看事件日志', latencyMs: 0, amountIn: 0, out: 0, steps: [] }); }
});

// 战壕卡片「⚡ 买 1%」：按该卡片的代币反推 1% 筹码需要的 BNB（已扣掉当前持仓和单钱包上限），再真实下单
const pBusy = new Set();
// 快捷买入比例：Flap 先 2%，失败（且没广播/成交）再自动试一次 1%；Four / Gang 只买 1%
function qPct(t) { return t?.platform === 'flap' ? 2 : 1; }
const notSent = (o) => o && !o.tx && !(o.txs || []).length && !(o.steps || []).some((x) => /已广播|已提交|已上链/.test(x.name || ''));
async function pulseBuy1(token) {
  const t = S.tokens.get(token); if (!t || pBusy.has(token)) return;
  const ws = [...S.selWallets]; if (!ws.length) return topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: '没有选钱包' });
  pBusy.add(token);
  try {
    const pcts = qPct(t) === 2 ? [2, 1] : [1];
    for (let n = 0; n < pcts.length; n++) {
      const pct = pcts[n], last = n === pcts.length - 1;
      topPop({ status: 'pending', side: 'buy', symbol: t.symbol });
      const c = await api(`/api/cost-for-pct?wallet=${ws[0]}&token=${t.address}&pct=${pct}&slippage=${S.slippage}`);
      if (!(c.bnb > 0)) {
        if (c.capReached) { $('#topPop')?.classList.remove('show'); note(`${t.symbol}：${c.error}，没有下单`, 'info'); return; }
        if (!last) { note(`${t.symbol}：买 ${pct}% 报价失败（${zhErr(c.error || '拿不到报价')}），改买 1%`, 'info'); continue; }
        return topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: c.error || '拿不到报价' });
      }
      if (c.note) note(`${t.symbol}：${c.note}`, 'info');
      topPop({ status: 'pending', side: 'buy', symbol: t.symbol, amountIn: c.bnb });
      let r, err;
      try { r = [].concat(await api('/api/order', { wallets: ws, token: t.address, side: 'buy', amount: c.bnb, slippage: S.slippage, via: 'quick' })); } catch (e) { err = e.message; }
      const f = err ? { reason: err } : r.find((o) => o?.status === 'failed');
      if (!f) return;
      // 只有第一次在广播前就失败（没有 tx、没有已广播步骤）、且是单钱包下单时才改 1% 重试，避免重复买入
      const safe = !err && ws.length === 1 && r.every((o) => o?.status === 'failed' && notSent(o));
      if (!last && safe) { note(`${t.symbol}：买 ${pct}% 失败（${zhErr(f.reason)}），自动改买 1%`, 'info'); continue; }
      return topPop({ ...f, status: 'failed', side: 'buy', symbol: t.symbol });
    }
  } catch (e) { topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: e.message }); }
  finally { pBusy.delete(token); }
}

async function submitQuick(token, amt) {
  const t = S.tokens.get(token); if (!t) return;
  const ws_ = [...S.selWallets];
  topPop({ status: 'pending', side: 'buy', symbol: t.symbol, amountIn: amt });
  try { await Promise.all(ws_.map((w) => api('/api/order', { wallets: [w], token, side: 'buy', amount: amt, slippage: S.slippage, via: 'quick' }))); }
  catch (e) { toast({ status: 'failed', reason: e.message, symbol: t.symbol }); }
}

document.addEventListener('change', async (e) => {
  const el = e.target; const d = el.dataset;
  if (d.cfg) await patchCfg(d.cfg, Number(el.value));
  else if (d.cfgs) await patchCfg(d.cfgs, el.value);
  else if (d.cfgb) { await patchCfg(d.cfgb, el.checked); renderSettings(); }
  else if (el.id === 'maxTradeBnb') { try { await api('/api/settings', { maxTradeBnb: el.value }); const st = await api('/api/state'); S.baw = st.baw; note(`已保存：实盘单笔上限 ${S.baw.maxTradeBnb || '不限'} BNB`); } catch (err) { toast({ status: 'failed', symbol: '设置', reason: err.message }); } }
  else if (d.set) { S.settings = await api('/api/settings', { [d.set]: el.checked }); renderControls(); }
  else if (d.wflag) { const [w, k] = d.wflag.split(':'); S.wallets = await api(`/api/wallet/${w}`, { [k]: el.checked }); renderSettings(); scheduleRender(); }
});

$('#amount').addEventListener('input', refreshQuote);
$('#submit').addEventListener('click', () => submitOrder());
$('#fastMode').addEventListener('change', (e) => { S.fast = e.target.checked; try { localStorage.fast = S.fast ? '1' : ''; } catch { /* */ } });
// 自动转出（Flap 领取后 / Four 发射后 / Gang 发射后，全部转到固定地址）：顶部栏按钮 → 弹窗里三个开关分别设置。
// 打开任何一个都要在确认弹窗里点确认；关闭直接生效
const AS = [
  { k: 'autoSendAfterClaim', name: 'Flap', what: 'Flap Agent 曲线发射后领取（claim）成功', how: '领到的全部代币' },
  { k: 'autoSendFourMigrated', name: 'Four', what: '你持有的 Four 代币从内盘发射（迁移到外盘）', how: '钱包里该币的全部余额' },
  { k: 'autoSendGangMigrated', name: 'Gang', what: '你持有的 Gang 代币（老盘和 V2 盘）从内盘发射（毕业）', how: '钱包里该币的全部余额' },
];
function renderAutoSend() {
  const to = S.settings.sendTo || '', sum = AS.map((x) => `${x.name}${S.settings[x.k] ? '✓' : '✗'}`).join(' ');
  const p = $('#autoSendPill'); p.classList.toggle('hidden', !LIVE() || !to);
  const any = AS.some((x) => S.settings[x.k]);
  p.classList.toggle('on', any);
  p.innerHTML = `<span class="${any ? 'y' : 'muted'}">⇢ 自动转出</span> <span class="mono">${AS.map((x) => `${x.name}<b class="${S.settings[x.k] ? 'g' : 'muted'}">${S.settings[x.k] ? '✓' : '✗'}</b>`).join(' ')}</span>`;
  p.title = to ? `自动转出到 ${to}：${sum}。点击设置` : '';
  $('#autoSendLink')?.classList.toggle('hidden', !LIVE() || !to); if ($('#autoSendSum')) $('#autoSendSum').textContent = sum;
  if ($('.as-dlg')) renderAutoSendDlg();
}
function renderAutoSendDlg() {
  const box = $('.as-dlg .as-rows'); if (!box) return; const to = S.settings.sendTo || '';
  box.innerHTML = AS.map((x) => `<div class="as-row"><div><b>${x.name}</b><div class="ui-note">${x.what}后，把${x.how}转到下面的地址</div></div>
    <button class="as-sw ${S.settings[x.k] ? 'on' : ''}" data-ask="${x.k}" role="switch" aria-checked="${!!S.settings[x.k]}"><i></i></button></div>`).join('');
}
function openAutoSend() {
  const to = S.settings.sendTo || ''; if (!to) return;
  const wrap = document.createElement('div'); wrap.className = 'ui-dlg-back';
  wrap.innerHTML = `<div class="ui-dlg as-dlg" role="dialog" aria-modal="true"><div class="ui-h">⇢ 自动转出</div>
    <div class="ui-b"><div class="as-rows"></div><p style="margin-top:10px">转出地址（固定，页面上改不了）：</p>
    <div class="ui-addr"><span class="mono">${esc(to)}</span><button class="ui-copy" data-v="${esc(to)}">复制</button></div>
    <p class="ui-note">打开要确认；关闭立刻生效。只处理打开之后发生的发射 / 领取；每个币只转一次，失败自动重试；币安 App 要确认时会等你处理。交易哈希记在订单列表和该币的规则栏里。</p></div>
    <div class="ui-f"><button class="ui-btn" data-close-as>关闭</button></div></div>`;
  document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('in')); renderAutoSendDlg();
  const close = () => { document.removeEventListener('keydown', key, true); wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 150); };
  const key = (e) => { if (document.querySelectorAll('.ui-dlg-back').length > 1) return; if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close-as]')) return close();
    const cp = e.target.closest('.ui-copy'); if (cp) { try { await navigator.clipboard.writeText(cp.dataset.v); cp.textContent = '已复制'; } catch { cp.textContent = '复制失败'; } return; }
    const sw = e.target.closest('[data-ask]'); if (!sw || sw.disabled) return;
    const x = AS.find((a) => a.k === sw.dataset.ask), on = !S.settings[x.k];
    if (on && !(await ui.confirm({ title: `打开「${x.name} 自动转出」？`, danger: true, confirmText: '打开自动转出',
      body: `<p>以后${x.what}后，都会把<b>${x.how}</b>自动转到：</p>`, address: to,
      after: '<p class="ui-note">不会再逐笔问你。真实转账，转出后无法撤回。随时可以在这里关掉。</p>' }))) return;
    sw.disabled = true;
    try { S.settings = await api('/api/settings', { [x.k]: on }); note(on ? `已打开：${x.name} 自动转到 ${to.slice(0, 6)}…${to.slice(-4)}` : `已关闭 ${x.name} 自动转出`); }
    catch (err) { toast({ status: 'failed', symbol: '设置', reason: err.message }); }
    sw.disabled = false; renderAutoSend();
  });
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-autosend]')) { e.preventDefault(); e.stopPropagation(); openAutoSend(); } }, true);
$('#sellToBnb').addEventListener('change', async (e) => { try { S.settings = await api('/api/settings', { sellToBnb: e.target.checked }); note(e.target.checked ? '已打开：卖出后自动换回 BNB' : '已关闭：卖出后报价币留在钱包'); } catch (err) { e.target.checked = !e.target.checked; toast({ status: 'failed', symbol: '设置', reason: err.message }); } });
$('#preApproveCap').addEventListener('change', async (e) => { try { S.settings = await api('/api/settings', { preApproveCap: e.target.checked }); note(e.target.checked ? '已打开：需要授权时授较大固定额度' : '已关闭：每次只授权本次数量'); } catch (err) { e.target.checked = !e.target.checked; toast({ status: 'failed', symbol: '设置', reason: err.message }); } });
// 授权管理：本程序授过的额度，逐条可撤销（approve 0，你点了才发）
async function openApprovals() {
  const wrap = document.createElement('div'); wrap.className = 'ui-dlg-back';
  wrap.innerHTML = `<div class="ui-dlg" style="width:min(560px,100%)"><div class="ui-h">🔑 授权管理</div><div class="ui-b" id="apBody"><div class="empty">正在读取链上授权额度…</div></div><div class="ui-f"><button class="ui-btn" data-apclose>关闭</button></div></div>`;
  document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => { document.removeEventListener('keydown', key, true); wrap.remove(); };
  const key = (e) => { if (e.key === 'Escape' && document.querySelectorAll('.ui-dlg-back').length === 1) close(); }; document.addEventListener('keydown', key, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  const render = async () => {
    let rows = []; try { rows = await api('/api/approvals'); } catch (e) { $('#apBody').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; return; }
    $('#apBody').innerHTML = rows.length ? `<table class="ttable"><tr><th class="l">代币</th><th class="l">授权给</th><th>当前额度</th><th>持有</th><th></th></tr>${rows.map((r) => `<tr><td class="l"><b>${esc(r.symbol || short(r.token))}</b><div class="hsub mono">${short(r.token, 6, 4)}</div></td><td class="l mono">${short(r.spender, 6, 4)}<div class="hsub">${r.kind === 'sell' ? '卖出用' : '报价币'}</div></td><td class="mono">${r.active ? K(+r.allowance) : '<span class="muted">0（已撤销 / 已用完）</span>'}</td><td class="mono">${K(+r.balance)}</td><td>${r.active ? `<button class="qb" style="color:var(--r)" data-aprevoke="${r.token}:${r.spender}">撤销</button>` : ''}</td></tr>`).join('')}</table><p class="ui-note">撤销 = 把这个额度改成 0，会发一笔链上交易（要一点 gas）。以后再卖出这个币时会重新授权。</p>`
      : '<div class="empty">本程序还没有授过额度。</div>';
  };
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-apclose]')) return close();
    const b = e.target.closest('[data-aprevoke]'); if (!b) return;
    const [token, spender] = b.dataset.aprevoke.split(':');
    if (!(await ui.confirm({ title: '撤销这个授权？', body: `<p>把 ${esc(short(token, 6, 4))} 对合约 ${esc(short(spender, 6, 4))} 的授权额度改成 0。</p>`, confirmText: '撤销', danger: true, after: '<p class="ui-note">会发一笔链上交易，要一点 gas。</p>' }))) return;
    b.disabled = true; b.textContent = '撤销中…';
    try { const o = await api('/api/approvals/revoke', { token, spender }); if (o.status === 'failed') toast(o); else note('已撤销授权'); } catch (err) { toast({ status: 'failed', symbol: '撤销授权', reason: err.message }); }
    render();
  });
  render();
}
$('#openApprovals').addEventListener('click', openApprovals);
$('#autoClaim').addEventListener('change', async (e) => { S.settings = await api('/api/settings', { autoClaim: e.target.checked }); });
$('#slip').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  let v = b.dataset.v;
  if (v === 'custom') { const x = await ui.prompt({ title: '自定义滑点', label: '滑点', value: S.slippage, suffix: '%' }); if (!x || !(+x > 0)) return; v = Math.min(99, +x); }
  S.slippage = +v; $$('#slip button').forEach((x) => x.classList.toggle('active', x === b)); $('#slipShow').textContent = S.slippage + '%'; refreshQuote();
});
$('#amtMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.amtMode = b.dataset.a; $$('#amtMode button').forEach((x) => x.classList.toggle('active', x === b)); S.pctBnb = 0; $('#amount').value = S.amtMode === 'pct' ? '2' : ''; renderRight(); refreshQuote(); });
$('#listTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.listTab = b.dataset.t; $$('#listTabs button').forEach((x) => x.classList.toggle('active', x === b)); syncUrl(); lastList = 0; scheduleRender(); });
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const c = b.dataset.c; S.chips.has(c) ? S.chips.delete(c) : S.chips.add(c); b.classList.toggle('active'); lastList = 0; scheduleRender(); });
$('#intervals').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.interval = +b.dataset.i; S.ivManual = S.selected; $$('#intervals button').forEach((x) => x.classList.toggle('active', x === b)); resetView(); drawChart(); });
$('#metric').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.metric = b.dataset.m; $$('#metric button').forEach((x) => x.classList.toggle('active', x === b)); drawChart(); });
$('#bottomTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.bottomTab = b.dataset.b; $$('#bottomTabs button').forEach((x) => x.classList.toggle('active', x === b)); renderBottom(); });
$('#openSettings').addEventListener('click', openSettings);
function openSettings() { S.settingsPlat = S.platform; renderSettings(); $('#settingsModal').classList.remove('hidden'); }
$('#btnSound').addEventListener('click', () => patchCfg('sound', !S.config.sound));
$('#btnBell').addEventListener('click', () => { if (!S.config.notify && window.Notification) Notification.requestPermission(); patchCfg('notify', !S.config.notify); });
$('#quickBuy').addEventListener('change', (e) => { const v = +e.target.value; if (v > 0) patchCfg('quickBuy', v); lastList = 0; });
$('#walletSel').addEventListener('click', (e) => { if (e.target.closest('#walletMenu')) return; renderWalletMenu(); $('#walletMenu').classList.toggle('hidden'); });
$$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

// 搜索：粘贴地址直接打开 / 名称符号模糊搜索
const sIn = $('#search');
// 搜索：代号 / 名称 / 地址；点击或回车打开，↑↓ 选择；粘贴的地址不在列表里时让服务端去链上查
let searchIdx = 0;
function renderSearch() {
  const q = sIn.value.trim().toLowerCase(); const box = $('#searchResults');
  if (!q) return renderHist();
  const isAddr = /^0x[0-9a-f]{40}$/.test(q);
  const hits = [...S.tokens.values()].filter((t) => t.address.toLowerCase().startsWith(q) || t.symbol.toLowerCase().includes(q) || String(t.name || '').toLowerCase().includes(q)).slice(0, 12);
  searchIdx = Math.min(searchIdx, Math.max(0, hits.length - 1));
  box.innerHTML = hits.length ? hits.map((t, i) => `<div data-a="${t.address}" class="${i === searchIdx ? 'on' : ''}">${logoHtml(t, 'xs')}<b>${esc(t.symbol)}</b><span class="mono muted">${short(t.address)}</span><span class="spacer"></span>${isBlocked(t) ? '<span class="blk-tag">已屏蔽</span><button class="qb" data-unblock="' + t.address + '">取消屏蔽</button>' : ''}<span class="mono">${usd(t.mcapUsd)}</span></div>`).join('')
    : isAddr ? `<div data-lookup="${q}" class="on">在链上查找 <span class="mono">${short(q)}</span> …</div>` : '<div class="muted">没有匹配</div>';
  box.classList.remove('hidden');
}
async function openFromSearch(addr) {
  $('#searchResults').classList.add('hidden'); sIn.value = ''; sIn.blur();
  let t = S.tokens.get(addr) || S.tokens.get(addr.toLowerCase());
  if (!t) {
    try { t = await api(`/api/lookup/${addr}`); S.tokens.set(t.address, t); }
    catch { return toast({ status: 'failed', symbol: short(addr), reason: '未找到该代币' }); }
  }
  histAdd(t);
  // 在战壕 / 持仓页搜索时先切回交易页，否则选中了也看不到
  if (S.view !== 'trade') setView('trade');
  // 代币在另一个平台页签时先切过去
  if (t.platform && t.platform !== S.platform) { S.platform = t.platform; $$('#platTabs button').forEach((b) => b.classList.toggle('active', b.dataset.p === t.platform)); lastList = 0; }
  select(t.address);
  setTimeout(() => document.querySelector(`#tokenList [data-a="${t.address}"], .tcard[data-a="${t.address}"]`)?.scrollIntoView({ block: 'nearest' }), 300);
}
sIn.addEventListener('input', () => { searchIdx = 0; renderSearch(); });
// 用 mousedown 选中：不等输入框失焦关下拉，按久一点也不会丢
$('#searchResults').addEventListener('mousedown', (e) => {
  if (histClick(e)) return;
  if (e.target.closest('[data-unblock]')) return;   // 取消屏蔽按钮：交给 click 处理，不打开代币
  const el = e.target.closest('[data-a],[data-lookup]'); if (!el) return;
  e.preventDefault(); e.stopPropagation(); openFromSearch(el.dataset.a || el.dataset.lookup);
});
$('#searchResults').addEventListener('click', (e) => { if (e.target.closest('[data-unblock]')) return; if (e.target.closest('[data-a],[data-lookup]')) { e.preventDefault(); e.stopPropagation(); } }, true);
sIn.addEventListener('keydown', (e) => {
  const items = $$('#searchResults [data-a],#searchResults [data-lookup]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); searchIdx = (searchIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); renderSearch(); return; }
  if (e.key === 'Enter') { const q = sIn.value.trim(); const f = items[searchIdx] || items[0]; if (f) openFromSearch(f.dataset.a || f.dataset.lookup); else if (/^0x[0-9a-fA-F]{40}$/.test(q)) openFromSearch(q.toLowerCase()); }
  if (e.key === 'Escape') sIn.blur();
});
sIn.addEventListener('blur', () => setTimeout(() => $('#searchResults').classList.add('hidden'), 200));
/* ---------- 快捷买卖：空格+W 买入 2%（超限自动改 1%），空格+F 清仓 ---------- */
const qBusy = { buy: false, sell: false };
async function quickOrder(side, pct) {
  const t = S.tokens.get(S.selected); if (!t || qBusy[side]) return;
  const ws = [...S.selWallets]; if (!ws.length) return toast({ status: 'failed', symbol: t.symbol, reason: '没有选钱包' });
  qBusy[side] = true; (side === 'buy' ? $('#qBuy2') : $('#qClear')).disabled = true;
  try {
    if (side === 'sell') {
      topPop({ status: 'pending', side: 'sell', symbol: t.symbol, amountIn: 100 });
      const r = await api('/api/order', { wallets: ws, token: t.address, side: 'sell', amount: 100, slippage: S.slippage, via: 'quick' });
      const f = [].concat(r).find((o) => o?.status === 'failed'); if (f) topPop({ ...f, side: 'sell', symbol: t.symbol });
      return;
    }
    if (side === 'buy') { await pulseBuy1(t.address); return; }   // 按平台选比例（Flap 2%→1%，Four/Gang 1%）
    // 服务端已经按「单钱包上限 → 单笔上限 → 余额」把金额压好，只下一单；调整了就给一条灰色提示，不算失败
    const c = await api(`/api/cost-for-pct?wallet=${ws[0]}&token=${t.address}&pct=${pct}&slippage=${S.slippage}`);
    if (!(c.bnb > 0)) { if (c.capReached) note(`${t.symbol}：${c.error}，没有下单`, 'info'); else topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: c.error || '拿不到报价' }); return; }
    if (c.note) note(`${t.symbol}：${c.note}`, 'info');
    topPop({ status: 'pending', side: 'buy', symbol: t.symbol, amountIn: c.bnb });
    let r, err;
    try { r = [].concat(await api('/api/order', { wallets: ws, token: t.address, side: 'buy', amount: c.bnb, slippage: S.slippage, via: 'quick' })); } catch (e) { err = e.message; }
    const f = err ? { reason: err } : r.find((o) => o?.status === 'failed');
    if (f) topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: f.reason });
  } catch (e) { topPop({ status: 'failed', side, symbol: t.symbol, reason: e.message }); }
  finally { qBusy[side] = false; (side === 'buy' ? $('#qBuy2') : $('#qClear')).disabled = false; }
}
$('#qBuy2').addEventListener('click', () => quickOrder('buy', 2));
$('#qClear').addEventListener('click', () => quickOrder('sell', 100));
let spaceDown = false, spaceUsed = false;
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) { spaceDown = true; spaceUsed = false; } return; }
  if (spaceDown && !e.repeat && (e.code === 'KeyW' || e.code === 'KeyF')) { e.preventDefault(); spaceUsed = true; return quickOrder(e.code === 'KeyW' ? 'buy' : 'sell', e.code === 'KeyW' ? 2 : 100); }
}, true);
document.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
window.addEventListener('blur', () => { spaceDown = false; });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (spaceDown) return;
  if (e.key === '/') { e.preventDefault(); sIn.focus(); }
  if (e.key === 'b' || e.key === 'B') $('#sideTabs [data-s="buy"]').click();
  if (e.key === 's' || e.key === 'S') $('#sideTabs [data-s="sell"]').click();
  if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.add('hidden'));
});


/* ---------- 屏蔽（GMGN 式，全局，存在服务器） ---------- */
// 屏蔽代币或开发者：战壕、左侧列表不显示，不响提示音、不弹通知、不自动买；搜索还能找到（标「已屏蔽」），持仓照常显示
const lcA = (a) => String(a || '').toLowerCase();
function isBlocked(t) { return !!(t && (S.blk.tokens[lcA(t.address)] || (t.creator && S.blk.devs[lcA(t.creator)]))); }
const blockCount = () => Object.keys(S.blk.tokens).length + Object.keys(S.blk.devs).length;
function blockLinks(t) {
  const tok = S.blk.tokens[lcA(t.address)], dev = t.creator && S.blk.devs[lcA(t.creator)];
  return (tok ? `<a href="#" data-unblock="${t.address}" class="blk-on" title="已屏蔽这个币，点击取消屏蔽">已屏蔽</a>` : `<a href="#" data-block="${t.address}" title="屏蔽这个币：不再出现在战壕和列表里">⊘</a>`)
    + (t.creator ? (dev ? `<a href="#" data-unblockdev="${t.creator}" class="blk-on" title="这个开发者已屏蔽，点击取消">开发者已屏蔽</a>` : `<a href="#" data-blockdev="${t.creator}" data-lbl="${esc(t.creatorName || short(t.creator, 6, 4))}" title="屏蔽该开发者：他发的所有币都不显示">⊘ 开发者</a>`) : '');
}
async function setBlock(kind, address, on, label, undo = true) {
  // 先在页面上立刻生效（不等服务器），保存失败再恢复
  const m = kind === 'dev' ? S.blk.devs : S.blk.tokens, a = lcA(address), prev = m[a];
  if (on) m[a] = { label, at: Date.now() }; else delete m[a];
  afterBlock();
  try { S.blk = await api('/api/blocklist', { kind, address, on, label }); }
  catch (e) { if (prev) m[a] = prev; else delete m[a]; afterBlock(); return toast({ status: 'failed', symbol: '屏蔽', reason: e.message }); }
  afterBlock();
  const what = `${kind === 'dev' ? '开发者 ' : ''}${label}`;
  if (on && undo) undoNote(`已屏蔽 ${what}`, () => setBlock(kind, address, false, label, false)); else if (!on && undo) note(`已取消屏蔽 ${what}`);
}
function afterBlock() {
  // 立刻把页面上已屏蔽的卡片拿掉（左侧列表、战壕），不等下一次重画
  document.querySelectorAll('#tokenList > .tcard[data-a], #tokenList > [data-pa], .tcb > [data-pa]').forEach((el) => { const t = S.tokens.get(el.dataset.a || el.dataset.pa); if (t && isBlocked(t) && !(S.listTab === 'mine' && el.closest('#tokenList'))) el.remove(); });
  lastList = 0; renderList(); lastList = Date.now(); scheduleRender(); if (S.view === 'pulse') { renderTrenchHeads(); renderPulse(); } if (!$('#blockModal').classList.contains('hidden')) renderBlockMgr(); if (!$('#searchResults').classList.contains('hidden')) renderSearch(); }
// 带「撤销」的提示，5 秒后消失
function undoNote(text, undo) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<b class="g">${esc(text)}</b> <button class="qb undo">撤销</button>`;
  el.querySelector('.undo').onclick = () => { el.remove(); undo(); };
  $('#toasts').prepend(el); setTimeout(() => el.remove(), 5000);
}
function renderBlockMgr() {
  const row = (kind, a, v) => { const t = kind === 'token' ? [...S.tokens.values()].find((x) => lcA(x.address) === a) : null;
    return `<div class="kv"><span>${kind === 'dev' ? '开发者' : '代币'} <b>${esc(t?.symbol || v.label || '')}</b> <span class="mono muted">${short(a, 6, 4)}</span></span><button class="qb" data-${kind === 'dev' ? 'unblockdev' : 'unblock'}="${a}">取消屏蔽</button></div>`; };
  const tk = Object.entries(S.blk.tokens).sort((a, b) => b[1].at - a[1].at), dv = Object.entries(S.blk.devs).sort((a, b) => b[1].at - a[1].at);
  $('#blockTitle').textContent = `已屏蔽 (${tk.length + dv.length})`;
  $('#blockBody').innerHTML = tk.length + dv.length ? tk.map(([a, v]) => row('token', a, v)).join('') + dv.map(([a, v]) => row('dev', a, v)).join('')
    : '<div class="muted">还没有屏蔽任何代币或开发者。在战壕卡片、左侧列表（鼠标移上去）、代币详情顶部点 ⊘ 屏蔽。</div>';
}
// 以前战壕「隐藏」存在本浏览器里，合并进全局屏蔽列表（只做一次）
async function migrateHidden() {
  const old = TR.hidden || []; if (!old.length) return;
  for (const a of old) { const t = S.tokens.get(a); try { S.blk = await api('/api/blocklist', { kind: 'token', address: a, on: true, label: t?.symbol || '' }); } catch { /* 地址无效就跳过 */ } }
  TR.hidden = []; trSave(); afterBlock();
}
// 捕获阶段处理，阻止冒泡：点 ⊘ 不会顺带打开代币 / 买入
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-block],[data-unblock],[data-blockdev],[data-unblockdev],[data-bmgr]'); if (!el) return;
  e.preventDefault(); e.stopPropagation(); const d = el.dataset;
  const sym = (a) => S.tokens.get(a)?.symbol || [...S.tokens.values()].find((x) => lcA(x.address) === lcA(a))?.symbol || short(a, 6, 4);
  if (d.bmgr != null) { renderBlockMgr(); $('#blockModal').classList.remove('hidden'); }
  else if (d.block) setBlock('token', d.block, true, sym(d.block));
  else if (d.unblock) setBlock('token', d.unblock, false, sym(d.unblock));
  else if (d.blockdev) setBlock('dev', d.blockdev, true, d.lbl || short(d.blockdev, 6, 4));
  else if (d.unblockdev) setBlock('dev', d.unblockdev, false, S.blk.devs[lcA(d.unblockdev)]?.label || short(d.unblockdev, 6, 4));
}, true);


/* ---------- 弹窗（替代浏览器自带的 confirm / prompt，和页面同一套深色样式） ---------- */
// await ui.confirm({ title, body, address, confirmText, danger }) → true / false；await ui.prompt({ title, label, value, suffix }) → 字符串或 null
// Esc / 点背景 = 取消，Enter = 确认
const ui = (() => {
  let open = null;
  const show = (html, onKey) => new Promise((resolve) => {
    open?.close(false);
    const wrap = document.createElement('div'); wrap.className = 'ui-dlg-back';
    wrap.innerHTML = `<div class="ui-dlg" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('in'));
    const close = (v) => { if (!wrap.isConnected) return; document.removeEventListener('keydown', key, true); wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 150); open = null; resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(onKey('cancel')); } else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(onKey('ok')); } };
    document.addEventListener('keydown', key, true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(onKey('cancel')); });
    wrap.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ui]'); if (!b) return;
      if (b.dataset.ui === 'copy') { try { await navigator.clipboard.writeText(b.dataset.v); b.textContent = '已复制'; } catch { b.textContent = '复制失败'; } return; }
      close(onKey(b.dataset.ui));
    });
    open = { close }; setTimeout(() => (wrap.querySelector('input') || wrap.querySelector('[data-ui="ok"]'))?.focus(), 30);
  });
  const addr = (a) => a ? `<div class="ui-addr"><span class="mono">${esc(a)}</span><button class="ui-copy" data-ui="copy" data-v="${esc(a)}">复制</button></div>` : '';
  return {
    confirm: ({ title, body = '', address = '', after = '', confirmText = '确认', cancelText = '取消', danger = false }) => show(
      `<div class="ui-h">${esc(title)}</div><div class="ui-b">${body}${addr(address)}${after}</div>
       <div class="ui-f"><button class="ui-btn" data-ui="cancel">${esc(cancelText)}</button><button class="ui-btn ${danger ? 'danger' : 'ok'}" data-ui="ok">${esc(confirmText)}</button></div>`,
      (k) => k === 'ok'),
    prompt: ({ title, label = '', value = '', suffix = '' }) => {
      let input; const p = show(`<div class="ui-h">${esc(title)}</div><div class="ui-b"><label class="ui-in">${esc(label)}<input class="mono" value="${esc(String(value))}" inputmode="decimal" />${esc(suffix)}</label></div>
       <div class="ui-f"><button class="ui-btn" data-ui="cancel">取消</button><button class="ui-btn ok" data-ui="ok">确定</button></div>`,
        (k) => (k === 'ok' ? (input = document.querySelector('.ui-dlg input'))?.value ?? null : null));
      return p;
    },
  };
})();

/* ---------- 单币规则（发射后立刻领取，确认后自动转出） ---------- */
function ruleBanner(addr) {
  const r = S.rules[String(addr || '').toLowerCase()]; if (!r) return '';
  const st = r.state || {}, to = r.to ? `${r.to.slice(0, 6)}…${r.to.slice(-4)}` : '';
  const claimTxt = st.claimedAt ? `已领取${st.claimTx ? ` <a href="https://bscscan.com/tx/${esc(st.claimTx)}" target="_blank" rel="noopener">↗</a>` : ''}` : r.claim ? '发射后立刻领取（每 2 秒检查）' : '';
  const sendTxt = !r.to ? '' : st.transferTx ? `已转到 ${to}${/^0x/.test(st.transferTx) ? ` <a href="https://bscscan.com/tx/${esc(st.transferTx)}" target="_blank" rel="noopener">↗</a>` : ''}`
    : r.transfer === 'armed' ? `领取后自动全部转到 <b title="${esc(r.to)}">${to}</b>` : `转到 <b title="${esc(r.to)}">${to}</b>：<span class="y">等你确认</span> <button class="qb" data-rule-arm="${r.token}">确认自动转出</button>`;
  const last = (r.log || []).at(-1);
  return `<div class="rule-bar"><b>⚙ 规则</b> ${claimTxt}${sendTxt ? ' · ' + sendTxt : ''}${last ? `<span class="hsub" title="${esc((r.log || []).map((x) => new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + x.msg).join('\n'))}"> · ${esc(last.msg)}</span>` : ''}${st.done ? '' : ` <button class="qb" data-rule-cancel="${r.token}">取消规则</button>`}</div>`;
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-rule-arm],[data-rule-cancel]'); if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const k = el.dataset.ruleArm || el.dataset.ruleCancel, r = S.rules[k]; if (!r) return;
  try {
    if (el.dataset.ruleArm) {
      if (!(await ui.confirm({ title: `确认 ${r.symbol} 自动转出`, danger: true, confirmText: '确认转出', body: `<p>${esc(r.symbol)} 发射并领取后，把钱包里<b>全部 ${esc(r.symbol)}</b> 自动转到：</p>`, address: r.to, after: '<p class="ui-note">这是真实转账，转出后无法撤回。只对这一个币生效。</p>' }))) return;
      S.rules = await api('/api/token-rules', { token: k, patch: { transfer: 'armed' } }); note(`已确认：${r.symbol} 领取后自动转到 ${r.to.slice(0, 6)}…${r.to.slice(-4)}`);
    } else {
      if (!(await ui.confirm({ title: `取消 ${r.symbol} 的规则？`, body: '<p>不再自动领取 / 转出这个币。</p>', confirmText: '取消规则', cancelText: '保留' }))) return;
      S.rules = await api('/api/token-rules', { token: k, remove: true }); note(`已取消 ${r.symbol} 的规则`);
    }
  } catch (err) { toast({ status: 'failed', symbol: '规则', reason: err.message }); }
  scheduleRender(); if (S.view === 'hold') renderHold();
}, true);

// 左上角 Logo：在当前页进入战壕（推一条历史记录，后退能回到原来的页面）
const goPulse = () => { if (S.view === 'pulse') return; location.hash = '#/pulse'; };
$('#brand').addEventListener('click', goPulse);
$('#brand').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goPulse(); } });



/* ---------- 收藏（参考 GMGN）：标题左边的 ★ 选分组；顶部 ⭐ 打开收藏栏，按分组筛选，实时显示市值和涨跌 ---------- */
const isFav = (a) => !!S.fav.items[String(a || '').toLowerCase()];
const favStar = (a) => `<button class="fav-star ${isFav(a) ? 'on' : ''}" data-fav="${a}" title="${isFav(a) ? '已收藏：' + esc(S.fav.items[String(a).toLowerCase()].group) + '（点击改分组 / 取消）' : '收藏'}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="currentColor"/></svg></button>`;
let favGroup = (() => { try { return localStorage.getItem('favGroup') || '全部'; } catch { return '全部'; } })();
function setFav(v) { S.fav = v || { groups: ['默认'], items: {} }; try { localStorage.setItem('fav', JSON.stringify(S.fav)); } catch { /* ignore */ } renderFavBar(); scheduleRender(); if (S.view === 'pulse') { lastPulse = 0; renderPulse(); } }
async function favOp(body) { try { setFav(await api('/api/favorites', body)); } catch (e) { toast({ status: 'failed', symbol: '收藏', reason: e.message }); } }
function favOn() { try { return localStorage.getItem('favBar') !== '0'; } catch { return true; } }
function renderFavBar() {
  document.body.classList.toggle('fav-on', favOn()); $('#favToggle').classList.toggle('on', favOn());
  if (!favOn()) return;
  const gs = ['全部', ...S.fav.groups]; if (!gs.includes(favGroup)) favGroup = '全部';
  $('#favGroups').innerHTML = gs.map((g) => `<button class="${g === favGroup ? 'on' : ''}" data-favg="${esc(g)}">${esc(g)}</button>`).join('') + '<button data-favmgr title="管理分组">⚙</button>';
  const list = Object.entries(S.fav.items).filter(([, v]) => favGroup === '全部' || v.group === favGroup).sort((a, b) => b[1].at - a[1].at);
  $('#favStrip').innerHTML = list.length ? list.map(([a, v]) => {
    const t = S.tokens.get(a) || [...S.tokens.values()].find((x) => x.address.toLowerCase() === a);
    const ch = t?.chg?.h24 ?? t?.chg?.h1 ?? t?.chg?.launch;
    return `<span class="fav-chip" data-favopen="${a}" title="${esc(t?.name || v.symbol)} · ${esc(v.group)}">${t ? logoHtml(t, 'xs') : ''}<b>${esc(t?.symbol || v.symbol || short(a))}</b><span class="mono">${t ? usd(t.mcapUsd) : '—'}</span>${ch != null ? `<span class="mono ${ch >= 0 ? 'g' : 'r'}">${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</span>` : ''}</span>`;
  }).join('') : `<span class="fav-empty">${favGroup === '全部' ? '还没有收藏：点代币名字左边的 ★' : '这个分组还没有收藏'}</span>`;
}
setInterval(() => { if (favOn() && Object.keys(S.fav.items).length) renderFavBar(); }, 3000);
function favMenu(btn, a) {
  $('.fav-menu')?.remove(); const t = S.tokens.get(a); const cur = S.fav.items[a.toLowerCase()];
  const m = document.createElement('div'); m.className = 'fav-menu';
  m.innerHTML = `<div class="t">收藏到分组</div>${S.fav.groups.map((g) => `<button class="${cur?.group === g ? 'on' : ''}" data-fg="${esc(g)}">${cur?.group === g ? '✓' : '　'} ${esc(g)}</button>`).join('')}
    <button data-fnew>＋ 新建分组</button>${cur ? '<div class="sep"></div><button class="rm" data-frm>取消收藏</button>' : ''}`;
  document.body.appendChild(m); const r = btn.getBoundingClientRect(); m.style.left = Math.min(r.left, innerWidth - 200) + 'px'; m.style.top = r.bottom + 6 + 'px';
  const close = () => { m.remove(); document.removeEventListener('mousedown', out, true); };
  const out = (e) => { if (!m.contains(e.target)) close(); }; setTimeout(() => document.addEventListener('mousedown', out, true), 0);
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.fg) { close(); return favOp({ op: 'set', address: a, group: b.dataset.fg, symbol: t?.symbol, platform: t?.platform }); }
    if (b.dataset.frm != null) { close(); return favOp({ op: 'remove', address: a }); }
    if (b.dataset.fnew != null) { close(); const g = await ui.prompt({ title: '新建分组', label: '名称', value: '' }); if (!g?.trim()) return; await favOp({ op: 'addGroup', group: g.trim() }); return favOp({ op: 'set', address: a, group: g.trim(), symbol: t?.symbol, platform: t?.platform }); }
  });
}
async function favManage() {
  const custom = S.fav.groups.filter((g) => g !== '默认'); if (!custom.length) { const g = await ui.prompt({ title: '新建分组', label: '名称', value: '' }); if (g?.trim()) favOp({ op: 'addGroup', group: g.trim() }); return; }
  const g = await ui.prompt({ title: '管理分组', label: `要改的分组（${custom.join(' / ')}）`, value: custom[0] }); if (!g || !custom.includes(g.trim())) return;
  const to = await ui.prompt({ title: `分组「${g.trim()}」`, label: '新名称（留空 = 删除这个分组，里面的币移到「默认」）', value: g.trim() }); if (to == null) return;
  if (!to.trim()) { if (await ui.confirm({ title: `删除分组「${g.trim()}」？`, body: '<p>里面的收藏会移到「默认」。</p>', confirmText: '删除', danger: true })) favOp({ op: 'deleteGroup', group: g.trim() }); }
  else if (to.trim() !== g.trim()) favOp({ op: 'renameGroup', group: g.trim(), to: to.trim() });
}
document.addEventListener('click', (e) => {
  const st = e.target.closest('[data-fav]'); if (st) { e.preventDefault(); e.stopPropagation(); const a = st.dataset.fav; const t = S.tokens.get(a);
    if (!isFav(a)) favOp({ op: 'set', address: a, group: '默认', symbol: t?.symbol, platform: t?.platform }).then(() => favMenu(st, a)); else favMenu(st, a); return; }
  const q = e.target.closest('[data-favq]'); if (q) { e.preventDefault(); e.stopPropagation(); const a = q.dataset.favq, t = S.tokens.get(a); return isFav(a) ? favOp({ op: 'remove', address: a }) : favOp({ op: 'set', address: a, group: '默认', symbol: t?.symbol, platform: t?.platform }); }
  const g = e.target.closest('[data-favg]'); if (g) { favGroup = g.dataset.favg; try { localStorage.setItem('favGroup', favGroup); } catch { /* ignore */ } return renderFavBar(); }
  if (e.target.closest('[data-favmgr]')) return favManage();
  const c = e.target.closest('[data-favopen]'); if (c) { const a = c.dataset.favopen; const t = S.tokens.get(a) || [...S.tokens.values()].find((x) => x.address.toLowerCase() === a);
    if (t) return openToken(t); location.hash = `#/${S.fav.items[a]?.platform || S.platform}/curve/${a}`; }
}, true);
$('#favToggle').addEventListener('click', () => { try { localStorage.setItem('favBar', favOn() ? '0' : '1'); } catch { /* ignore */ } renderFavBar(); window.dispatchEvent(new Event('resize')); });


/* ---------- 一键买卖浮窗（GMGN 那种）：只在交易详情页显示，战壕不显示；可拖动，预设可编辑，点按钮 = 你手动下单（走同一套下单流程和检查） ---------- */
const QB_DEF = { buy: [[0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5], [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5], [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5]], sell: [[10, 25, 50, 100, 5, 15, 35, 70], [10, 25, 50, 100, 5, 15, 35, 70], [10, 25, 50, 100, 5, 15, 35, 70]] };
const QBP = (() => { let x = {}; try { x = JSON.parse(localStorage.getItem('qbPanel') || '{}'); } catch { /* ignore */ } return { open: x.open !== false, x: x.x ?? null, y: x.y ?? null, pb: x.pb || 0, ps: x.ps || 0, edit: false, adv: false }; })();
const qbSave = () => { try { localStorage.setItem('qbPanel', JSON.stringify({ open: QBP.open, x: QBP.x, y: QBP.y, pb: QBP.pb, ps: QBP.ps })); } catch { /* ignore */ } };
const qbOpen = () => QBP.open;
const qbPresets = () => { const p = S.settings?.qbPresets; if (p) { try { localStorage.setItem('qbPresets', JSON.stringify(p)); } catch { /* ignore */ } return p; } try { return JSON.parse(localStorage.getItem('qbPresets') || 'null') || QB_DEF; } catch { return QB_DEF; } };
function renderQB() {
  let el = $('#qbPanel');
  const show = QBP.open && S.view === 'trade' && !!S.selected && LIVE();
  if (!show) { el?.classList.add('hidden'); return; }
  if (!el) { el = document.createElement('div'); el.id = 'qbPanel'; el.className = 'qbp'; document.body.appendChild(el); qbBind(el); }
  el.classList.remove('hidden');
  if (QBP.x != null) { el.style.left = Math.max(0, Math.min(innerWidth - 300, QBP.x)) + 'px'; el.style.top = Math.max(46, Math.min(innerHeight - 120, QBP.y)) + 'px'; el.style.right = 'auto'; }
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // 正在改预设时不重画
  const t = S.tokens.get(S.selected) || { address: S.selected, symbol: '…' };
  const P = qbPresets(), hr = S.tokens.has(S.selected) ? holdRow(t) : null, w = wallet(S.activeWallet) || S.wallets[0];
  const btns = (side, list) => list.map((v, i) => QBP.edit ? `<input class="qbp-in mono" data-qbi="${side}:${i}" value="${v}" inputmode="decimal" />` : `<button class="qbp-b ${side}" data-qbgo="${side}:${v}">${side === 'buy' ? v : v + '%'}</button>`).join('');
  const tabs = (side, cur) => [0, 1, 2].map((i) => `<button class="${cur === i ? 'on' : ''}" data-qbtab="${side}:${i}">P${i + 1}</button>`).join('');
  const sgnU = (v) => (v == null ? '—' : `<b class="${v >= 0 ? 'g' : 'r'}">${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}</b>`);
  el.innerHTML = `<div class="qbp-h" data-qbdrag><b>一键买卖</b><span class="muted">${esc(t.symbol)}</span><span class="spacer"></span><button class="ca-big sm ${caOk(t.address) ? 'ok' : ''}" data-cacopy="${t.address}" title="复制合约地址：${t.address}"><span>${caOk(t.address) ? '已复制 ✓' : '复制 CA'}</span></button><button class="qbp-x" data-qbedit title="编辑预设">${QBP.edit ? '完成' : '⚙'}</button><button class="qbp-x" data-qbclose title="关闭">×</button></div>
    <div class="qbp-sec"><div class="qbp-row"><b class="g">买入</b><span class="qbp-tabs">${tabs('buy', QBP.pb)}</span><span class="spacer"></span><span class="muted mono">${w ? bnb(w.bnb || 0, 4) : '—'} BNB</span></div>
      <div class="qbp-grid">${btns('buy', P.buy[QBP.pb])}</div>
      <div class="qbp-adv"><button data-qbadv>${QBP.adv ? '▾' : '▸'} 高级</button>${QBP.adv ? `<span>滑点 <b class="mono">${S.slippage}%</b>（在右侧下单区修改）</span><span>${S.fast ? '<b class="y">极速模式：点击直接下单</b>' : '每次会弹确认'}</span><span>单笔上限 ${S.baw?.maxTradeBnb || '不限'} BNB</span>` : ''}</div></div>
    <div class="qbp-sec"><div class="qbp-row"><b class="r">卖出</b><span class="qbp-tabs">${tabs('sell', QBP.ps)}</span><span class="spacer"></span><span class="muted mono">${hr?.amount > 0 ? `${K(hr.amount)} · ${hr.valueUsd != null ? '$' + hr.valueUsd.toFixed(2) : '—'}` : '没有持仓'}</span></div>
      <div class="qbp-grid">${btns('sell', P.sell[QBP.ps])}</div>
      ${hr?.amount > 0 && hr.costBnb > 0 && hr.valueBnb > hr.costBnb ? `<button class="qbp-b sell wide" data-qbgo="sell:${Math.min(100, (hr.costBnb / hr.valueBnb) * 100).toFixed(1)}" title="卖出刚好收回成本的比例（按现价估算）">回本（卖 ${Math.min(100, (hr.costBnb / hr.valueBnb) * 100).toFixed(1)}%）</button>` : ''}</div>
    <div class="qbp-f"><div><span>余额</span><b>${hr?.valueUsd != null ? '$' + hr.valueUsd.toFixed(2) : '—'}</b></div><div><span>总买入</span><b>${hr ? '$' + (hr.costUsd || 0).toFixed(2) : '—'}</b></div><div><span>总卖出</span><b>${hr ? '$' + (hr.soldUsd || 0).toFixed(2) : '—'}</b></div><div><span>未实现</span>${hr && hr.valueUsd != null && hr.amount > 0 ? sgnU(hr.valueUsd - (hr.costUsd || 0) + (hr.soldUsd || 0)) : '—'}</div></div>`;
}
function qbBind(el) {
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return; const d = b.dataset;
    if (d.qbclose != null) { QBP.open = false; qbSave(); renderQB(); renderHead(); return; }
    if (d.qbedit != null) {
      if (QBP.edit) {   // 保存
        const P = JSON.parse(JSON.stringify(qbPresets()));
        for (const i of el.querySelectorAll('[data-qbi]')) { const [side, k] = i.dataset.qbi.split(':'); const v = Number(i.value); if (!(v > 0) || (side === 'sell' && v > 100)) return toast({ status: 'failed', symbol: '预设', reason: `数值无效：${i.value}` }); P[side][side === 'buy' ? QBP.pb : QBP.ps][+k] = v; }
        try { S.settings = await api('/api/settings', { qbPresets: P }); note('一键买卖预设已保存'); } catch (err) { return toast({ status: 'failed', symbol: '预设', reason: err.message }); }
      }
      QBP.edit = !QBP.edit; return renderQB();
    }
    if (d.qbtab) { const [side, i] = d.qbtab.split(':'); if (side === 'buy') QBP.pb = +i; else QBP.ps = +i; qbSave(); return renderQB(); }
    if (d.qbadv != null) { QBP.adv = !QBP.adv; return renderQB(); }
    if (d.qbgo) {   // 你点的按钮：走正常的手动下单（单笔上限、钱包锁、待确认、提示都照常；非极速模式会先弹确认）
      const [side, v] = d.qbgo.split(':'); const amt = +v; if (!S.selected || !(amt > 0)) return;
      return submitOrder({ token: S.selected, side, wallets: [S.activeWallet], amountFor: () => amt });
    }
  });
  // 拖动标题栏移动，位置记住
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-qbdrag]') || e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top; el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const mv = (ev) => { QBP.x = ev.clientX - ox; QBP.y = ev.clientY - oy; el.style.left = Math.max(0, Math.min(innerWidth - 300, QBP.x)) + 'px'; el.style.top = Math.max(46, Math.min(innerHeight - 120, QBP.y)) + 'px'; el.style.right = 'auto'; };
    const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); qbSave(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-qbtoggle]')) { e.preventDefault(); e.stopPropagation(); QBP.open = !QBP.open; qbSave(); renderQB(); renderHead(); } }, true);
setInterval(renderQB, 2000);


// 大的「复制 CA」按钮（详情页顶部、一键买卖浮窗）：点一下复制完整合约地址，按钮显示「已复制 ✓」1.5 秒（状态记在内存里，页面重画也不丢）
const caCopied = { a: '', until: 0 };
const caOk = (a) => caCopied.a === String(a).toLowerCase() && Date.now() < caCopied.until;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cacopy]'); if (!b) return; e.preventDefault(); e.stopPropagation();
  const a = b.dataset.cacopy; const ok = await copyText(a);
  if (!ok) { note('复制失败，请手动选中地址', 'info'); return; }
  Object.assign(caCopied, { a: a.toLowerCase(), until: Date.now() + 1500 });
  document.querySelectorAll(`[data-cacopy="${a}"]`).forEach((x) => { x.classList.add('ok'); x.querySelector('span').textContent = '已复制 ✓'; });
  setTimeout(() => { document.querySelectorAll(`[data-cacopy="${a}"]`).forEach((x) => { x.classList.remove('ok'); x.querySelector('span').textContent = '复制 CA'; }); }, 1550);
}, true);


/* ---------- 持仓页「兑换」：BNB ⇄ 任意代币（BNCB / NVDAB / BTCB…），先报价，你确认后才兑换 ---------- */
const BNB_ADDR = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SW_PRESET = [
  ['BNCB', '0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f'], ['NVDAB', '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436'], ['BTCB', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c'],
  ['GANG', '0x0c6302401aa5325C2E36F170f52C00B1d220B405'], ['ZEC', '0x1Ba42e5193dfA8B03D15dd1B86a3113bbBEF8Eeb'], ['USDT', '0x55d398326f99059fF775485246999027B3197955'],
];
const SW = (() => { let x = {}; try { x = JSON.parse(localStorage.getItem('swapUI') || '{}'); } catch { /* ignore */ } return { dir: x.dir || 'buy', token: x.token || SW_PRESET[0][1], recent: x.recent || [], info: null, q: null, busy: false, err: null, amt: '' }; })();
const swSave = () => { try { localStorage.setItem('swapUI', JSON.stringify({ dir: SW.dir, token: SW.token, recent: SW.recent.slice(0, 8) })); } catch { /* ignore */ } };
async function swLoadInfo() {
  SW.info = null; SW.q = null; SW.err = null; renderSwap();
  try { SW.info = await api(`/api/token-info/${SW.token}`); } catch (e) { SW.err = e.message; }
  renderSwap();
}
function renderSwap() {
  const box = $('#holdSwap'); if (!box || S.view !== 'hold' || !LIVE()) { if (box) box.innerHTML = ''; return; }
  const i = SW.info, buy = SW.dir === 'buy', w = wallet(S.activeWallet) || S.wallets[0];
  const fromSym = buy ? 'BNB' : (i?.symbol || '…'), toSym = buy ? (i?.symbol || '…') : 'BNB';
  const bal = buy ? (w?.bnb ?? 0) : Number(i?.balance || 0);
  const chips = [...SW_PRESET, ...SW.recent.filter((r) => !SW_PRESET.some((p) => p[1].toLowerCase() === r[1].toLowerCase()))];
  const focused = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (focused && box.dataset.ready) { $('#swQ').innerHTML = swQuoteHtml(toSym); return; }
  box.dataset.ready = '1';
  box.innerHTML = `<div class="sw-h"><b>兑换</b><span class="seg sm"><button class="${buy ? 'active' : ''}" data-swdir="buy">BNB → 代币</button><button class="${buy ? '' : 'active'}" data-swdir="sell">代币 → BNB</button></span><span class="hsub">用 baw 市价单（币安聚合路由），先报价，确认后才兑换</span></div>
    <div class="sw-chips">${chips.map(([n, a]) => `<button class="${a.toLowerCase() === SW.token.toLowerCase() ? 'on' : ''}" data-swtok="${a}">${esc(n)}</button>`).join('')}
      <input class="mono" id="swCa" placeholder="或粘贴代币合约地址 0x…" value="${SW_PRESET.some((p) => p[1] === SW.token) || SW.recent.some((r) => r[1] === SW.token) ? '' : esc(SW.token)}" /></div>
    <div class="sw-tok">${i ? `${i.image ? `<img src="${esc(i.image)}" alt="" />` : ''}<b>${esc(i.symbol)}</b><span class="hsub">${esc(i.name || '')} · <span class="mono">${short(i.address, 6, 4)}</span> · 持有 ${swN(+i.balance)}</span>` : SW.err ? `<span class="r">${esc(SW.err)}</span>` : '<span class="hsub">读取代币信息…</span>'}</div>
    <div class="sw-row"><label class="sw-in"><span>${fromSym}</span><input class="mono" id="swAmt" inputmode="decimal" placeholder="数量" value="${esc(SW.amt)}" /></label>
      ${[25, 50, 100].map((p) => `<button class="qb" data-swpct="${p}">${p === 100 ? 'MAX' : p + '%'}</button>`).join('')}<span class="hsub">余额 ${buy ? bnb(bal, 4) + ' BNB' : K(bal) + ' ' + esc(fromSym)}</span></div>
    <div class="sw-row"><button class="qb" data-swquote>报价</button><span id="swQ">${swQuoteHtml(toSym)}</span><span class="spacer"></span><button class="sw-go ${buy ? 'buy' : 'sell'}" data-swgo ${SW.busy ? 'disabled' : ''}>${SW.busy ? '兑换中…' : `兑换 ${fromSym} → ${toSym}`}</button></div>`;
}
const swN = (v) => (v == null ? '—' : v >= 1000 ? K(v) : v >= 1 ? (+v).toFixed(4) : sub(v));
function swQuoteHtml(toSym) { const q = SW.q; if (!q) return '<span class="hsub">点「报价」看预计到手</span>'; if (q.err) return `<span class="r">${esc(q.err)}</span>`; return `预计 <b class="mono">${swN(q.out)} ${esc(toSym)}</b> · 最少 <span class="mono">${swN(q.minOut)}</span>（滑点 ${q.slippage}%）· <span class="hsub">${esc(q.route)}</span>`; }
function swPayload() {
  const buy = SW.dir === 'buy', i = SW.info; const amt = String(SW.amt || '').trim();
  return { from: buy ? BNB_ADDR : i.address, to: buy ? i.address : BNB_ADDR, amount: amt, slippage: 2 };   // 主流代币兑换用 2% 滑点（内盘那种 35% 太松）
}
document.addEventListener('input', (e) => { if (e.target.id === 'swAmt') { SW.amt = e.target.value; SW.q = null; $('#swQ').innerHTML = swQuoteHtml(''); } });
document.addEventListener('change', (e) => { if (e.target.id === 'swCa') { const v = e.target.value.trim(); if (/^0x[0-9a-fA-F]{40}$/.test(v)) { SW.token = v; swSave(); swLoadInfo(); } else if (v) note('合约地址格式不对（0x + 40 位）', 'info'); } });
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-swdir],[data-swtok],[data-swpct],[data-swquote],[data-swgo]'); if (!el || !el.closest('#holdSwap')) return;
  const d = el.dataset;
  if (d.swdir) { SW.dir = d.swdir; SW.q = null; SW.amt = ''; swSave(); return renderSwap(); }
  if (d.swtok) { SW.token = d.swtok; SW.amt = ''; swSave(); return swLoadInfo(); }
  if (d.swpct) { const buy = SW.dir === 'buy', w = wallet(S.activeWallet) || S.wallets[0]; const p = +d.swpct;
    if (buy) { const max = Math.max(0, (w?.bnb || 0) - 0.003); SW.amt = String(+(max * p / 100).toFixed(6)); }   // BNB 留 0.003 付 gas
    else SW.amt = p >= 100 ? 'MAX' : String(+(Number(SW.info?.balance || 0) * p / 100).toFixed(6));
    SW.pct = buy ? null : p; SW.q = null; return renderSwap(); }
  if (!SW.info) return note('先选一个代币', 'info');
  if (d.swquote != null) {
    const pl = swPayload(); if (pl.amount === 'MAX') pl.amount = SW.info.balance;
    if (!(Number(pl.amount) > 0)) return note('请输入数量', 'info');
    $('#swQ').innerHTML = '<span class="hsub">报价中…</span>';
    try { SW.q = await api('/api/swap/quote', pl); } catch (err) { SW.q = { err: zhErr(err.message) }; }
    return renderSwap();
  }
  if (d.swgo != null) {
    const pl = swPayload(); const buy = SW.dir === 'buy';
    if (!buy && (pl.amount === 'MAX' || SW.pct >= 100)) { pl.pct = 100; } else if (!(Number(pl.amount) > 0)) return note('请输入数量', 'info');
    if (!S.fast) {
      let q = SW.q; if (!q || q.err) { try { q = await api('/api/swap/quote', { ...pl, amount: pl.pct ? SW.info.balance : pl.amount }); } catch (err) { q = { err: zhErr(err.message) }; } }
      const ok = await ui.confirm({ title: `确认兑换 ${buy ? 'BNB → ' + SW.info.symbol : SW.info.symbol + ' → BNB'}`, danger: true, confirmText: '确认兑换',
        body: `<p>付出：<b class="mono">${pl.pct ? '全部 ' + swN(+SW.info.balance) : pl.amount} ${buy ? 'BNB' : esc(SW.info.symbol)}</b></p><p>预计到手：<b class="mono">${q?.err ? esc(q.err) : swN(q.out) + ' ' + (buy ? esc(SW.info.symbol) : 'BNB')}</b>${q?.minOut ? `（最少 ${swN(q.minOut)}）` : ''}</p>`,
        address: SW.info.address, after: `<p class="ui-note">真实交易，用币安 Agentic 钱包上链，无法撤回。单笔上限 ${S.baw?.maxTradeBnb || '不限'} BNB。</p>` });
      if (!ok) return;
    }
    if (!SW.recent.some((r) => r[1].toLowerCase() === SW.info.address.toLowerCase()) && !SW_PRESET.some((p) => p[1].toLowerCase() === SW.info.address.toLowerCase())) { SW.recent.unshift([SW.info.symbol, SW.info.address]); swSave(); }
    SW.busy = true; renderSwap(); topPop({ status: 'pending', side: buy ? 'buy' : 'sell', symbol: SW.info.symbol, amountIn: buy ? +pl.amount : 100 });
    try { const o = await api('/api/swap', { ...pl, clientTs: Date.now() }); if (o.status === 'failed') toast(o); else if (o.status === 'filled') { note(`兑换完成：${o.route} 到手 ${K(o.out || 0)}`); } }
    catch (err) { toast({ status: 'failed', symbol: '兑换', reason: err.message }); }
    SW.busy = false; SW.q = null; setTimeout(() => { swLoadInfo(); loadHold(true); }, 1500);
  }
});

/* ---------- 实时成交往下翻页 ---------- */
const OLDER = {};   // token → { items, end, complete, loading, err }
function olderTrades() { const k = S.selected || ''; return (OLDER[k] ||= { items: [], end: false, complete: true, loading: false, err: null }); }
async function loadOlderTrades() {
  const k = S.selected, o = olderTrades(); if (!k || !LIVE() || o.loading || o.end) return;
  const all = [...(S.detail?.trades || []), ...o.items]; const before = all.length ? Math.min(...all.map((x) => x.ts)) : 0;
  o.loading = true; o.err = null; renderBottom();
  try { const r = await api(`/api/trades/${k}?before=${before}&limit=150`); o.items.push(...r.items); o.end = r.end; o.complete = r.complete; }
  catch (e) { o.err = e.message; }
  o.loading = false; if (S.selected === k && S.bottomTab === 'trades') renderBottom(); if (S.selected === k) renderAct();
}
$('#bottomBody').addEventListener('click', (e) => { if (e.target.closest('#tradesFoot')) loadOlderTrades(); });
$('#bottomBody').addEventListener('scroll', (e) => { const b = e.currentTarget; if (S.bottomTab === 'trades' && b.scrollHeight - b.scrollTop - b.clientHeight < 120) loadOlderTrades(); }, { passive: true });


/* ---------- K 线右边的「活动」：和实时成交同一份数据；点「时间」切换倒序 / 正序（记住），点行打开交易者抽屉 ---------- */
let actAsc = (() => { try { return localStorage.getItem('actAsc') === '1'; } catch { return false; } })();
// 每笔成交当时的市值 = 这笔的成交价（报价币）× 总量 × 报价币美元价；拿不到成交价才用记录里的市值
const tradeMc = (r, t) => (r.price > 0 && t ? r.price * (t.maxSupply || 1e9) * (t.quoteUsd || (String(t.quote || 'BNB').toUpperCase() === 'BNB' ? S.bnbUsd : 0)) : 0) || r.mcapUsd || 0;
const relT = (ts) => { const s2 = Math.max(0, (Date.now() - ts) / 1000); return s2 < 60 ? Math.floor(s2) + 's' : s2 < 3600 ? Math.floor(s2 / 60) + 'm' : s2 < 86400 ? Math.floor(s2 / 3600) + 'h' : Math.floor(s2 / 86400) + 'd'; };
function actRows() {
  const OT = olderTrades(); const seen = new Set();
  return [...(S.detail?.trades || []), ...OT.items].filter((r) => { const k = `${r.tx}:${r.side}:${r.tokens}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => (actAsc ? a.ts - b.ts : b.ts - a.ts));
}
function renderAct() {
  const body = $('#actBody'); if (!body || S.view !== 'trade') return;
  const t = S.tokens.get(S.selected); const OT = olderTrades(); const rows = actRows();
  $('#actSort').textContent = `时间 ${actAsc ? '↑' : '↓'}`; $('#actSort').title = actAsc ? '正序（最早在上），点击切换为倒序' : '倒序（最新在上），点击切换为正序';
  $('#actCnt').textContent = rows.length ? `${rows.length} 笔${OT.end ? '（全部）' : ''}` : '';
  const qu = t?.quoteUsd || S.bnbUsd;
  // 正序时如果还没加载到开盘第一笔，先自动往前加载（最多加载到全部）
  if (actAsc && !OT.end && !OT.loading && LIVE()) loadOlderTrades();
  const prevTop = body.scrollTop, prevH = body.scrollHeight, atBottom = prevH - prevTop - body.clientHeight < 30;
  body.innerHTML = rows.slice(0, 1500).map((r) => `<div class="act-r ${isMe(r.trader) ? 'mine' : ''}" data-trader="${esc(r.trader || '')}" title="${new Date(r.ts).toLocaleString('zh-CN', { hour12: false })} · ${r.side === 'buy' ? '买入' : '卖出'} ${K(r.tokens)} 个">
    <span class="act-amt ${r.side === 'buy' ? 'g' : 'r'}"><i class="sd ${r.side}"></i>$${(r.usd ?? (r.bnb || 0) * qu).toFixed(2)}</span><span class="mc">${usd(tradeMc(r, t))}</span><span>${LIVE() && r.trader ? gmgnWho(r.trader, nameOf(r), 4, 4) : esc(short(r.trader || '', 4, 4))}</span><span class="tm">${relT(r.ts)}</span></div>`).join('')
    + (LIVE() ? `<div class="act-foot" id="actFoot">${OT.end ? '— 已到开盘第一笔 —' : OT.loading ? '正在加载…' : (actAsc ? '正在补全更早的成交…' : '往下滚动加载更早的成交')}</div>` : '');
  if (actAsc) { if (atBottom) body.scrollTop = body.scrollHeight; else body.scrollTop = prevTop; }   // 正序：在底部时跟着新成交往下，否则保持不动
  else body.scrollTop = prevTop;
}
$('#actSort').addEventListener('click', () => { actAsc = !actAsc; try { localStorage.setItem('actAsc', actAsc ? '1' : '0'); } catch { /* ignore */ } $('#actBody').scrollTop = 0; renderAct(); });
$('#actBody').addEventListener('scroll', (e) => { const b = e.currentTarget; if (!actAsc && b.scrollHeight - b.scrollTop - b.clientHeight < 80) loadOlderTrades(); }, { passive: true });
$('#actBody').addEventListener('click', (e) => {
  if (e.target.closest('#actFoot')) return loadOlderTrades();
  const row = e.target.closest('.act-r[data-trader]'); if (!row || !row.dataset.trader || row.dataset.trader.startsWith('user:')) return;
  e.preventDefault(); openTrader(row.dataset.trader);
});
setInterval(() => { if (S.view === 'trade') renderAct(); }, 1000);

/* ---------- 交易者抽屉：点实时成交里的一行 / 地址，右侧滑出这个地址在当前币上的盈亏（GMGN 那种） ---------- */
function openTrader(addr) {
  const t = S.tokens.get(S.selected); if (!t || !/^0x[0-9a-fA-F]{40}$/.test(addr || '')) return;
  $('.tr-drawer-back')?.remove();
  const back = document.createElement('div'); back.className = 'tr-drawer-back';
  back.innerHTML = `<aside class="tr-drawer" role="dialog" aria-modal="true"><div class="trd-h"><div class="trd-who">${gmgnWho(addr, NAMES[addr.toLowerCase()])}</div><button class="x" data-trd-close>×</button></div>
    <div class="trd-b"><div class="empty">正在读取 ${esc(short(addr, 6, 4))} 在 ${esc(t.symbol)} 上的成交…</div></div></aside>`;
  document.body.appendChild(back); requestAnimationFrame(() => back.classList.add('in'));
  const close = () => { document.removeEventListener('keydown', key, true); back.classList.remove('in'); setTimeout(() => back.remove(), 200); };
  const key = (e) => { if (e.key === 'Escape' && document.querySelectorAll('.ui-dlg-back').length === 0) { e.preventDefault(); close(); } };
  document.addEventListener('keydown', key, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.addEventListener('click', async (e) => {
    if (e.target.closest('[data-trd-close]')) return close();
    const cp = e.target.closest('[data-trd-copy]'); if (cp) { try { await navigator.clipboard.writeText(addr); cp.textContent = '已复制'; } catch { cp.textContent = '复制失败'; } }
  });
  api(`/api/trader/${t.address}/${addr}`).then((d) => { if (back.isConnected) back.querySelector('.trd-b').innerHTML = traderHtmlFull(d, t); }).catch((e) => { if (back.isConnected) back.querySelector('.trd-b').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; });
}
function traderHtmlFull(d, t) {
  const U = (q) => q * d.qUsd, B = (q) => q * d.qBnb, q = esc(d.quote);
  const money = (qv, signed) => { const u = U(qv), b = B(qv); const s2 = signed ? (u >= 0 ? '+' : '−') : ''; return `<b class="${signed ? (u >= 0 ? 'g' : 'r') : ''}">${s2}$${Math.abs(u).toFixed(2)}</b><small>${s2}${bnb(Math.abs(b), 4)} BNB · ${s2}${K(Math.abs(qv))} ${q}</small>`; };
  const px = (v) => (v == null ? '—' : `$${sub(v * d.qUsd)}`);
  const cell = (k, v, tip = '') => `<div title="${esc(tip)}"><span>${k}</span>${v}</div>`;
  return `<div class="trd-addr"><span class="mono">${esc(d.trader)}</span><button class="ui-copy" data-trd-copy>复制</button></div>
    <div class="trd-links"><a href="https://bscscan.com/address/${esc(d.trader)}" target="_blank" rel="noopener">BscScan ↗</a><a href="https://gmgn.ai/bsc/address/${esc(d.trader)}" target="_blank" rel="noopener">GMGN ↗</a>${isMe(d.trader) ? '<i class="me-tag">我</i>' : ''}</div>
    <div class="trd-pnl">${cell('总盈亏', money(d.total, true) + (d.pct != null ? `<small class="${d.pct >= 0 ? 'g' : 'r'}">${d.pct >= 0 ? '+' : ''}${d.pct.toFixed(1)}%</small>` : ''), '已实现 + 未实现（按现价）。买入按实际付出（含平台费），卖出按到手金额；不含 gas。美元 / BNB 按报价币现价换算')}</div>
    <div class="trd-grid">
      ${cell('已实现', money(d.realized, true), '卖出收入 − 卖出部分按买入均价算的成本')}${cell('未实现', money(d.unrealized, true), '当前持有 × 现价 − 持有部分按买入均价算的成本')}
      ${cell(`买入 ${d.buys} 笔`, money(d.boughtQ) + `<small>${K(d.boughtTokens)} 个</small>`)}${cell(`卖出 ${d.sells} 笔`, money(d.soldQ) + `<small>${K(d.soldTokens)} 个</small>`)}
      ${cell('买入均价', `<b>${px(d.avgBuy)}</b><small>${d.avgBuy != null ? sub(d.avgBuy) + ' ' + q : ''}</small>`)}${cell('卖出均价', `<b>${px(d.avgSell)}</b><small>${d.avgSell != null ? sub(d.avgSell) + ' ' + q : ''}</small>`)}
      ${cell('当前持有', `<b>${K(d.hold)}</b><small>${d.holdSrc === 'chain' ? '链上余额' : '按买卖差估算'}</small>`)}${cell('持有价值', money(d.holdQ))}
      ${cell('首次买入', `<b>${d.firstBuy ? new Date(d.firstBuy).toLocaleString('zh-CN', { hour12: false }) : '—'}</b>`)}
    </div>
    ${d.complete ? '' : '<p class="ui-note">成交很多，只统计了最近 1000 笔。</p>'}
    <div class="trd-t"><b>${esc(t.symbol)} 成交（${d.trades.length}）</b></div>
    <table class="ttable"><tr><th>时间</th><th class="l">方向</th><th>数量</th><th>价格</th><th title="买入按实际付出（含 1% 平台费），卖出按到手金额；美元按报价币现价换算">金额</th><th class="l">交易</th></tr>
      ${d.trades.map((x) => `<tr><td class="dim">${new Date(x.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td><td class="l ${x.side === 'buy' ? 'g' : 'r'}">${x.side === 'buy' ? '买入' : '卖出'}</td><td>${K(x.tokens)}</td><td>${x.tokens ? px(x.bnb / x.tokens) : '—'}</td><td>$${U(x.bnb).toFixed(2)}<div class="hsub">${K(x.bnb)} ${q}</div></td><td class="l">${x.tx ? `<a href="https://bscscan.com/tx/${x.tx}" target="_blank" rel="noopener">${x.tx.slice(0, 6)}↗</a>` : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">没有成交</td></tr>'}
    </table>`;
}
document.addEventListener('click', (e) => {
  const row = e.target.closest('#bottomBody tr.trow[data-trader]'); if (!row || e.target.closest('a')) return;
  if (row.dataset.trader.startsWith('user:')) return;   // 模拟盘钱包
  e.preventDefault(); openTrader(row.dataset.trader);
});

/* ---------- 启动 ---------- */
(async function boot() {
  try { S.fast = localStorage.fast === '1'; } catch { S.fast = false; }
  const st = await api('/api/state');
  if (st.holdings) setHoldSnap(st.holdings);
  Object.assign(S, { mode: st.mode, baw: st.baw, block: st.block, bnbUsd: st.bnbUsd, net: st.net, wallets: st.wallets, settings: st.settings, config: st.config, usage: st.usage, positions: st.positions, orders: st.orders, logs: st.logs, records: st.records, flow: st.flow, snipeCurve: st.snipeCurve });
  S.tokens = new Map(st.tokens.map((t) => [t.address, t]));
  S.selWallets = new Set(S.wallets.map((w) => w.id)); S.activeWallet = S.wallets[0]?.id || S.activeWallet;
  if (LIVE()) S.platform = 'flap';
  const prefs = loadPrefs(); S.prefSel = prefs.selected || null;
  const r0 = applyRoute(); if (!location.hash && prefs.view === 'pulse') setView('pulse', true);
  applyActive(); if (prefs.amount && !r0.ca) { const am = $('#amount'); if (am) am.value = prefs.amount; }
  renderControls(); renderAutoSend(); pickDefault(); connect(); renderBottom();
  if (LIVE()) api('/api/token-rules').then((r) => { S.rules = r || {}; scheduleRender(); }).catch(() => {});
  renderFavBar(); api('/api/favorites').then(setFav).catch(() => {});
  api('/api/blocklist').then(async (b) => { S.blk = b; afterBlock(); await migrateHidden(); }).catch(() => {});
  setInterval(() => { if (S.bottomTab === 'logs' || S.bottomTab === 'flow') return; renderBottom(); }, 2000);
})();

/* ---------- K 线 / 成交区 上下拖动 ---------- */
(() => {
  const sp = $('#vsplit'), bot = document.querySelector('.panel.bottom'); if (!sp || !bot) return;
  const saved = +localStorage.getItem('bottomH'); if (saved > 0) bot.style.height = saved + 'px';
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault(); const y0 = e.clientY, h0 = bot.offsetHeight; sp.classList.add('drag'); document.body.style.cursor = 'row-resize';
    const max = () => (bot.parentElement?.clientHeight || window.innerHeight) - 160;
    const mv = (ev) => { const h = Math.max(120, Math.min(max(), h0 + (y0 - ev.clientY))); bot.style.height = h + 'px'; window.dispatchEvent(new Event('resize')); };
    const up = () => { sp.classList.remove('drag'); document.body.style.cursor = ''; localStorage.setItem('bottomH', bot.offsetHeight); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
})();

try { applyRoute(); } catch {}

/* ---------- 左栏宽度：拖动中间的分隔条调整（320～640px），记在本机浏览器里，双击恢复 400px ---------- */
(() => {
  const layout = document.querySelector('main.layout'), bar = $('#splitter'); if (!layout || !bar) return;
  const DEF = 400, MIN = 320, MAX = 640;
  const set = (w) => { w = Math.round(Math.max(MIN, Math.min(MAX, w))); layout.style.setProperty('--leftW', w + 'px'); return w; };
  let saved = null; try { saved = Number(localStorage.getItem('leftW')); } catch { /* 无痕模式等 */ }
  if (saved) set(saved);
  let start = null;
  bar.addEventListener('pointerdown', (e) => { start = { x: e.clientX, w: layout.querySelector('.panel.left').getBoundingClientRect().width }; bar.setPointerCapture(e.pointerId); bar.classList.add('drag'); });
  bar.addEventListener('pointermove', (e) => { if (start) set(start.w + e.clientX - start.x); });
  bar.addEventListener('pointerup', () => { if (!start) return; start = null; bar.classList.remove('drag'); try { localStorage.setItem('leftW', parseInt(getComputedStyle(layout).getPropertyValue('--leftW'))); } catch { /* ignore */ } });
  bar.addEventListener('dblclick', () => { set(DEF); try { localStorage.removeItem('leftW'); } catch { /* ignore */ } });
})();

/* ---------- 头像放大预览：鼠标在头像上停 150ms 显示大图，跟着头像位置，始终在屏幕内 ---------- */
(() => {
  const peek = document.createElement('div'); peek.className = 'logo-peek hidden'; document.body.appendChild(peek);
  let key = null, timer = 0, hideTimer = 0;
  const tokenOf = (logo) => { const h = logo.closest('[data-a],[data-pa],[data-sel]'); return S.tokens.get(h?.dataset.a || h?.dataset.pa) || (h?.dataset.a ? null : S.tokens.get(S.selected)); };
  const place = (logo) => {
    const r = logo.getBoundingClientRect(), w = peek.offsetWidth, h = peek.offsetHeight;
    let x = r.right + 12, y = r.top + r.height / 2 - h / 2;
    if (x + w > innerWidth - 8) x = r.left - w - 12;
    peek.style.left = Math.max(8, x) + 'px'; peek.style.top = Math.max(8, Math.min(innerHeight - h - 8, y)) + 'px';
  };
  const show = (logo) => {
    const t = tokenOf(logo); const img = logo.querySelector('img');
    peek.innerHTML = `<div class="pk-img ${t?.platform === 'four' ? 'four' : ''}">${img ? `<img src="${esc(img.getAttribute('src'))}" alt="">` : esc(String(t?.symbol || logo.textContent || '?').slice(0, 2).toUpperCase())}</div>`
      + (t ? `<div class="pk-name">${esc(t.symbol)}${t.name && t.name !== t.symbol ? `<span>${esc(t.name)}</span>` : ''}</div>` : '');
    peek.classList.remove('hidden'); place(logo);
  };
  // 用事件委托：列表每秒重画，换成同一个代币的新元素时不重新计时、不闪
  document.addEventListener('pointerover', (e) => {
    const logo = e.target.closest?.('.logo');
    if (!logo || logo.closest('.logo-peek')) { clearTimeout(timer); clearTimeout(hideTimer); hideTimer = setTimeout(() => { key = null; peek.classList.add('hidden'); }, 60); return; }
    clearTimeout(hideTimer);
    const k = (tokenOf(logo)?.address || '') + '|' + logo.className;
    if (k === key && !peek.classList.contains('hidden')) { place(logo); return; }
    key = k; clearTimeout(timer); timer = setTimeout(() => show(logo), 150);
  });
  document.addEventListener('pointerleave', () => { clearTimeout(timer); key = null; peek.classList.add('hidden'); });
  window.addEventListener('scroll', () => peek.classList.add('hidden'), true);
})();

/* ---------- 持仓：链上数量 + 钱包历史算成本；每 15 秒刷新 ---------- */
try { const v = JSON.parse(localStorage.getItem('holdPlats') || 'null'); if (Array.isArray(v) && v.length) HOLD.plats = new Set(v); } catch { /* ignore */ }
async function loadHold(refresh = false) {
  try { HOLD.data = await api('/api/holdings' + (refresh ? '?refresh=1' : '')); } catch (e) { HOLD.err = e.message; }
  renderHold(); loadQuoteBal(refresh);
}
// 计价币余额（BNCB / GANG / NVDAB / WBNB 等）：Flap、Gang V2 买卖中间换出来没换回 BNB 的部分。每个币一个「全部换回 BNB」
async function loadQuoteBal(force = true) {
  if (!LIVE()) return;
  if (!force && Date.now() - (HOLD.quoteAt || 0) < 30_000) return renderQuoteBal(); HOLD.quoteAt = Date.now();   // baw 余额是 CLI 调用，定时刷新时 30 秒最多一次
  try { HOLD.quote = await api('/api/quote-balances'); HOLD.quoteErr = null; } catch (e) { HOLD.quoteErr = e.message; }
  renderQuoteBal();
}
function renderQuoteBal() {
  const box = $('#holdQuote'); if (!box || S.view !== 'hold') return;
  const q = (HOLD.quote || []).filter((r) => !(r.valueUsd != null && r.valueUsd < 0.5));   // 价值不到 $0.5 的零头不显示（只是不显示，余额和换回逻辑不变）
  if (!q.length && !HOLD.quoteErr) { box.innerHTML = ''; return; }
  const busy = (a) => S.orders?.some((o) => o.status === 'pending' && String(o.token).toLowerCase() === a.toLowerCase());
  box.innerHTML = `<div class="hq-h"><b>计价币余额</b><span class="hsub">Flap / Gang V2 买卖时中间换出来、还没换回 BNB 的币。按钮按点击那一刻的余额全部换回</span></div>
    ${HOLD.quoteErr ? `<div class="hsub r">读取失败：${esc(HOLD.quoteErr)}</div>` : ''}
    <table><tr><th class="l">币</th><th>余额</th><th>单价</th><th>价值 (BNB)</th><th>价值 (USD)</th><th class="l">操作</th></tr>
    ${q.map((r) => `<tr><td class="l"><b>${esc(r.symbol)}</b> <span class="hsub mono">${short(r.token, 6, 4)}</span></td><td class="mono">${esc(r.balance)}</td><td>${r.priceUsd ? usd(r.priceUsd) : '—'}</td>
      <td>${r.valueBnb != null ? bnb(r.valueBnb, 5) : '—'}</td><td>${usd(r.valueUsd || 0)}</td>
      <td class="l acts">${busy(r.token) ? '<span class="hsub">处理中…</span>' : `<button class="qb" data-q2b="${r.token}">${r.wbnb ? '解包成 BNB' : '全部换回 BNB'}</button>`}</td></tr>`).join('')}</table>`;
}
async function quoteToBnb(token) {
  if (!S.baw?.auth || S.baw.auth.state !== 'ok') { renderAuth(); return note('币安钱包未登录，请先登录', 'info'); }
  note('正在按当前余额报价…', 'info');
  let p; try { p = await api('/api/quote-to-bnb/preview', { token, slippage: 1 }); } catch (e) { return toast({ status: 'failed', symbol: '换回 BNB', reason: e.message }); }
  const go = async () => {
    topPop({ status: 'pending', side: 'sell', symbol: p.symbol, amountIn: 100 });
    try { const o = await api('/api/quote-to-bnb', { token, slippage: p.slippage }); if (o.status === 'failed') toast(o); }
    catch (e) { toast({ status: 'failed', symbol: p.symbol, reason: e.message }); }
    setTimeout(() => loadQuoteBal(true), 3000); setTimeout(() => loadHold(true), 8000);
  };
  const diff = p.midBnb ? ((p.out - p.midBnb) / p.midBnb) * 100 : null;
  $('#confirmBody').innerHTML = `
    <div class="kv"><span>换出</span><b>${esc(String(p.balance))} ${esc(p.symbol)}（全部）</b></div>
    <div class="kv"><span>预计到手</span><b class="g">${bnb(p.out, 6)} BNB</b></div>
    <div class="kv"><span>最少到手</span><b>${bnb(p.minOut, 6)} BNB${p.slippage ? `（滑点 ${p.slippage}%）` : ''}</b></div>
    ${diff != null ? `<div class="kv"><span>对比 DEX 参考价</span><b class="${diff < -2 ? 'r' : ''}">${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%（报价已含路由手续费）</b></div>` : ''}
    <div class="kv"><span>路径</span><b>${esc(p.route)}</b></div>
    <div class="note" style="color:#f6465d">真实交易：用你的币安 Agentic 钱包上链，无法撤回。实际成交以链上为准；如果币安 App 弹出确认，请在 App 里处理。</div>
    <button class="big-btn sell" id="confirmGo">确认换回 BNB</button>`;
  $('#confirmModal').classList.remove('hidden');
  $('#confirmGo').onclick = () => { $('#confirmModal').classList.add('hidden'); go(); };
}
// 带正负号的数：格式化用绝对值，避免小数格式化函数遇到负数出 NaN
const sgn = (v, f) => (v == null || !isFinite(v) ? '—' : `<span class="${v >= 0 ? 'g' : 'r'}">${v >= 0 ? '+' : '−'}${f(Math.abs(v))}</span>`);
const usdSigned = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`);
const usdTip = (r) => (r.usdBasis === 'trade' ? '美元按每笔成交当时的 BNB/USDT 价格（币安小时 K 线）；市值按现价' : '这个币没有钱包历史，美元按现在的 BNB 价格估算');
const ago = (ts) => { if (!ts) return '—'; const s = (Date.now() - ts) / 1000; return s < 3600 ? Math.round(s / 60) + ' 分钟' : s < 86400 ? (s / 3600).toFixed(1) + ' 小时' : (s / 86400).toFixed(1) + ' 天'; };
function renderHold() {
  if (S.view === 'hold' && LIVE() && !$('#holdSwap').dataset.ready) swLoadInfo();
  const d = HOLD.data; if (!d || S.view !== 'hold') return;
  const dust = $('#holdDust').checked;
  $$('#holdPlats [data-hp]').forEach((c) => c.classList.toggle('off', !HOLD.plats.has(c.dataset.hp)));
  const rows = d.rows.filter((r) => HOLD.plats.has(r.platform === 'four' || r.platform === 'gang' || r.platform === 'gwei' ? r.platform : 'flap') && (!dust || (r.amount > 0 && r.valueBnb >= 0.0005) || r.stage === 'claim'));
  const T = d.totals || {};
  // 「持仓中」按页面上实际显示的行数算；被「隐藏小额」藏起来的单独说明
  const openRows = d.rows.filter((r) => r.amount > 0), shownOpen = rows.filter((r) => r.amount > 0).length, hiddenOpen = openRows.length - shownOpen;
  const tip = '美元：市值按现在的 BNB 价；成本和卖出按每笔成交当时（所在小时）的 BNB/USDT 价格。所以美元盈亏 ≠ BNB 盈亏 × 现价，差额来自 BNB 本身涨跌';
  $('#holdTot').innerHTML = `<div><span>持仓市值</span><b>$${(T.valueUsd ?? (T.valueBnb || 0) * d.bnbUsd).toFixed(2)}</b> <span>${bnb(T.valueBnb || 0)} BNB</span></div>
    <div title="${tip}"><span>累计买入成本</span><b>$${(T.costUsd || 0).toFixed(2)}</b> <span>${bnb(T.costBnb || 0)} BNB</span></div><div title="${tip}"><span>累计卖出</span><b>$${(T.soldUsd || 0).toFixed(2)}</b> <span>${bnb(T.soldBnb || 0)} BNB</span></div>
    <div title="${tip}"><span>总盈亏（含已卖出）</span><b>${sgn(T.pnlUsd || 0, (v) => '$' + v.toFixed(2))}</b> <span>${T.costUsd > 0 ? sgn(((T.pnlUsd || 0) / T.costUsd) * 100, (v) => v.toFixed(1) + '%') : ''}</span></div>
    <div><span>BNB 余额</span><b>${bnb(d.bnb || 0)}</b></div><div><span>更新于</span><b style="font-size:14px">${new Date(d.updatedAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}</b></div><div><span>持仓中</span><b>${shownOpen} 个</b>${hiddenOpen ? ` <a href="#" class="hsub" data-hshow>（另有 ${hiddenOpen} 个小额已隐藏 · 显示）</a>` : ''}</div>`;
  const stageTxt = (r) => (r.stage === 'claim' ? '<span class="tag y">可领取</span>' : r.stage === 'curve' ? '<span class="tag">内盘</span>' : '<span class="tag g">已迁移</span>');
  const canTrade = (r) => r.amount > 0;
  $('#holdBody').innerHTML = rows.length ? `<table><tr><th class="l">代币</th><th class="l">状态</th><th>数量</th><th>占总量</th><th title="平均买入价（美元；悬停看报价币 / BNB 单价）">买入均价</th><th>市值</th><th>成本</th><th>已卖出</th><th>盈亏</th><th>卖出费率</th><th>首次买入</th><th class="l">操作</th></tr>
    ${rows.map((r) => `<tr class="hrow" data-hold="${r.token}"><td class="l"><span class="side" data-a="${r.token}">${logoHtml({ ...r, address: r.token })}<span><b>${esc(r.symbol)}</b> <i class="pbadge" style="margin-left:4px">${r.platform === 'four' ? 'Four' : r.platform === 'gang' ? 'Gang' : r.platform === 'gwei' ? 'GWEI' : 'Flap'}</i>${r.isQuote ? '<i class="pbadge" style="margin-left:4px;color:#f0b90b" title="这个币也是其他盘的报价币：Gang V2 / Flap 买卖时换出来、没换回 BNB 的部分会留在这里">计价币</i>' : ''}<div class="hsub">${esc(r.name || '')}${r.source === 'app' ? ' · 成本按本程序订单' : ''}</div>${ruleBanner(r.token)}</span></span></td>
      <td class="l">${stageTxt(r)}</td><td>${K(r.amount)}</td><td>${r.supplyPct != null ? r.supplyPct.toFixed(3) + '%' : '—'}</td><td title="${r.avgBuyQuote && r.quote !== 'BNB' ? sub(r.avgBuyQuote) + ' ' + esc(r.quote) : r.avgBuyBnb ? sub(r.avgBuyBnb) + ' BNB' : ''}">${r.avgBuyUsd ? '$' + sub(r.avgBuyUsd) : '—'}</td>
      <td>${r.valueBnb != null ? `<span title="${bnb(r.valueBnb)} BNB${r.quote !== 'BNB' && r.price ? ` · ${K(r.amount * r.price)} ${esc(r.quote)}` : ''}">$${(r.valueUsd || 0).toFixed(2)}</span>` : `<span class="y" title="${esc(r.warn || '')}">— ⚠</span>`}</td><td title="${usdTip(r)}">$${(r.costUsd || 0).toFixed(2)}</td><td title="${usdTip(r)}">${r.soldBnb ? '$' + (r.soldUsd || 0).toFixed(2) : '$0'}</td>
      <td title="${usdTip(r)}">${r.pnlUsd == null ? `<span class="muted" title="${esc(r.warn || '')}">—</span>` : sgn(r.pnlUsd, (v) => '$' + v.toFixed(2))}${r.pnlPct != null ? ' <span class="hsub">' + sgn(r.pnlPct, (v) => v.toFixed(1) + '%') + '</span>' : ''}</td><td class="${(S.tokens.get(r.token)?.sellFeePct || 0) >= 5 ? 'r' : ''}">${pctTxt(S.tokens.get(r.token)?.sellFeePct)}</td><td>${ago(r.firstAt)}</td>
      <td class="l acts">${r.stage === 'claim' ? `<button class="qb" data-claim="${r.claimMarket}">领取</button>` : ''}${canTrade(r) ? (r.isQuote ? `<button class="qb" data-hsell="${r.walletId}:${r.token}:100" title="全部换回 BNB">换回 BNB</button>` : [25, 50, 100].map((p) => `<button class="qb" style="color:var(--r)" data-hsell="${r.walletId}:${r.token}:${p}">${p === 100 ? '清仓' : '卖' + p + '%'}</button>`).join('')) : ''}</td></tr>
      ${HOLD.open.has(r.token) ? `<tr class="hist"><td colspan="12">${r.trades.length ? r.trades.map((x) => `<div class="hsub"><span class="${x.side === 'buy' ? 'g' : 'r'}">${x.side === 'buy' ? '买入' : '卖出'}</span> ${new Date(x.ts).toLocaleString('zh-CN', { hour12: false })} · ${K(x.tokens)} 个 · ${bnb(x.bnb)} BNB · ${txLink(x.tx)}</div>`).join('') : '<span class="hsub">钱包历史里没有这笔持仓的买卖记录（Flap 曲线份额只记录本程序下的单）</span>'}</td></tr>` : ''}`).join('')}</table>`
    : `<div class="empty">${HOLD.err ? esc(HOLD.err) : '暂无持仓'}</div>`;
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('#holdPlats [data-hp]');
  if (chip) { const p = chip.dataset.hp; if (HOLD.plats.has(p)) { if (HOLD.plats.size > 1) HOLD.plats.delete(p); } else HOLD.plats.add(p); try { localStorage.setItem('holdPlats', JSON.stringify([...HOLD.plats])); } catch { /* ignore */ } return renderHold(); }
  if (e.target.closest('[data-hshow]')) { e.preventDefault(); $('#holdDust').checked = false; return renderHold(); }
  const q2b = e.target.closest('[data-q2b]'); if (q2b) { e.stopPropagation(); q2b.disabled = true; quoteToBnb(q2b.dataset.q2b).finally(() => { q2b.disabled = false; }); return; }
  const sell = e.target.closest('[data-hsell]');
  if (sell) { e.stopPropagation(); const [w, tk, pct] = sell.dataset.hsell.split(':'); return submitOrder({ token: tk, side: 'sell', wallets: [w], amountFor: () => +pct }); }
  if (e.target.closest('[data-claim],.logo')) return;
  const a = e.target.closest('[data-a]'); if (a && a.closest('#hold')) { e.stopPropagation(); const t = S.tokens.get(a.dataset.a) || [...S.tokens.values()].find((x) => x.address.toLowerCase() === a.dataset.a.toLowerCase()); if (t) return openToken(t); setView('trade'); return select(a.dataset.a); }
  const row = e.target.closest('tr.hrow'); if (row) { const k = row.dataset.hold; HOLD.open.has(k) ? HOLD.open.delete(k) : HOLD.open.add(k); renderHold(); }
}, true);
$('#holdDust').addEventListener('change', renderHold);
$('#holdRefresh').addEventListener('click', () => loadHold(true));
setInterval(() => { if (S.view === 'hold') loadHold(); }, 12_000);
// 订单结束后持仓页也跟着刷新（服务端会在 3 / 5 / 20 秒重读链上余额）
for (const ms of [4000, 8000, 22000]) window.addEventListener('order-done', () => setTimeout(() => { if (S.view === 'hold') loadHold(); }, ms));

/* ---------- 战壕：三列（新创建 / 即将打满 / 已开盘），每列自己的搜索、快捷买入金额、P1-P3 预设、声音、隐藏、筛选 ---------- */
const PLATS = ['flap', 'four', 'gang', 'gwei'];
const platOf = (t) => (t.platform === 'four' || t.platform === 'gang' || t.platform === 'gwei' ? t.platform : 'flap');
const TCOLS = { new: '新创建', soon: '即将打满', dex: '已开盘' };
const defPreset = () => ({ amt: 0, slip: 35, f: { plats: [...PLATS], minMc: '', maxMc: '', minHolders: '', minProg: '', quote: '', social: false, maxTax: '', hideUnknownTax: false } });
const TR = (() => {
  let s = null; try { s = JSON.parse(localStorage.getItem('trench') || 'null'); } catch { /* ignore */ }
  const st = s && s.cols ? s : { cols: {}, hidden: [] };
  for (const k of Object.keys(TCOLS)) st.cols[k] = { preset: 1, presets: { 1: defPreset(), 2: defPreset(), 3: defPreset() }, q: '', sound: false, sort: 'pct', showHidden: false, ...(st.cols[k] || {}) };
  return st;
})();
const trSave = () => { try { localStorage.setItem('trench', JSON.stringify(TR)); } catch { /* ignore */ } };
const P = (k) => TR.cols[k].presets[TR.cols[k].preset];
const tcPaused = new Set();
// 卡片下单状态（点击后立刻显示，几秒后清掉）：busy 下单中 / ok 已提交 / pend 待确认 / err 失败
const tcState = new Map();
const TC_ST = { busy: '<i class="spin"></i>下单中…', ok: '✓ 已提交', pend: '… 待确认', err: '✗ 失败' };
const tcBuyLabel = (t, k) => `⚡ ${P(k).amt > 0 ? P(k).amt + ' BNB' : `买 ${qPct(t)}%`}`;                 // 鼠标停在某列里时暂停这一列的更新
const tcSeen = { new: new Set(), soon: new Set(), dex: new Set() };
const tcKnown = new Set(); let tcPrimed = false; const tcSoundAt = {};
// 列提示音单独控制（只看这一列的开关，不受顶栏🔊影响）
function colTone(f) { try { actx ||= new AudioContext(); if (actx.state === 'suspended') actx.resume(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.05; o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.07); } catch { /* 未授权音频 */ } }
var lastPulse = 0;

function setView(v, fromRoute) {
  S.view = v;
  $('#pulse')?.classList.toggle('hidden', v !== 'pulse');
  $('#hold')?.classList.toggle('hidden', v !== 'hold');
  document.querySelector('main.layout')?.classList.toggle('hidden', v === 'pulse' || v === 'hold');
  $$('#viewSw button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (!fromRoute) syncUrl();
  renderQB?.();
  if (v === 'hold') loadHold();
  if (v === 'pulse') { lastPulse = 0; renderPulse(); requestAnimationFrame(() => $$('.tcb').forEach((b) => { if (pulseScroll[b.id] != null) b.scrollTop = pulseScroll[b.id]; })); }
  else if (v === 'hold' && pulseScroll.hold != null) { requestAnimationFrame(() => { const h = $('#hold'); if (h) h.scrollTop = pulseScroll.hold; }); }
  if (v === 'pulse') {} else { window.dispatchEvent(new Event('resize')); lastList = 0; scheduleRender(); }
}

// 列头：搜索 / BNB 快捷金额 / P1-P3 / 声音 / 隐藏 / 筛选（即将打满多一个 % / MC 排序）
function tcHead(k) {
  const c = TR.cols[k], p = P(k), f = p.f;
  const active = f.plats.length < 3 || f.minMc || f.maxMc || f.minHolders || f.minProg || f.quote || f.social || f.maxTax !== '' && f.maxTax != null || f.hideUnknownTax;
  return `<div class="tch"><b>${TCOLS[k]}</b><span class="cnt" id="tcn-${k}">0</span><i class="tc-pause" id="tcp-${k}" title="鼠标在列里，暂停刷新">❚❚</i>
    <span class="tch-r">
      <label class="tc-search"><svg viewBox="0 0 16 16" width="12" height="12"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6"/></svg><input data-tq="${k}" value="${esc(c.q)}" placeholder="关键词1, ..."/></label>
      <label class="tc-amt" title="这一列 ⚡ 买入的 BNB 金额（0 = 按 1% 筹码买）"><i class="bnbcoin"></i><input data-ta="${k}" type="number" min="0" step="0.01" value="${p.amt || 0}"/></label>
      <span class="tc-pre">${[1, 2, 3].map((n) => `<button data-tp="${k}:${n}" class="${c.preset === n ? 'on' : ''}">P${n}</button>`).join('')}</span>
      ${k === 'soon' ? `<span class="tc-pre tc-sort"><button data-ts="${k}:pct" class="${c.sort === 'pct' ? 'on' : ''}">%</button><button data-ts="${k}:mc" class="${c.sort === 'mc' ? 'on' : ''}">MC</button></span>` : ''}
      <button class="tc-ic ${c.sound ? 'on' : ''}" data-tsound="${k}" title="新币提示音">${c.sound ? '🔊' : '🔈'}</button>
      <button class="tc-ic" data-bmgr title="已屏蔽 ${blockCount()} 个：点击查看 / 取消屏蔽（卡片上的 ⊘ 屏蔽）">⊘${blockCount() ? `<small>${blockCount()}</small>` : ''}</button>
      <button class="tc-ic tc-funnel ${active ? 'act' : ''}" data-tf="${k}" title="${esc(tcFilterSummary(k))}"><svg viewBox="0 0 16 16" width="15" height="15" style="pointer-events:none"><path d="M2 3h12l-4.6 5.4v4.4l-2.8 1.4V8.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></button>
    </span></div>`;
}
// 漏斗按钮的提示文字：当前预设下生效的筛选条件
function tcFilterSummary(k) {
  const f = P(k).f, x = [];
  if (f.plats.length < 3) x.push('平台 ' + f.plats.join('/'));
  if (f.maxTax !== '' && f.maxTax != null) x.push(`税率 ≤ ${f.maxTax}%`);
  if (f.hideUnknownTax) x.push('隐藏税率未知');
  if (f.minMc || f.maxMc) x.push(`市值 ${f.minMc || 0}~${f.maxMc || '∞'}`);
  if (f.minHolders) x.push(`持有人 ≥ ${f.minHolders}`);
  if (f.minProg) x.push(`进度 ≥ ${f.minProg}%`);
  if (f.quote) x.push('报价币 ' + f.quote);
  if (f.social) x.push('有社交链接');
  return `筛选（P${TR.cols[k].preset}）：${x.length ? x.join('，') : '无'}`;
}
function tcFilterPop(k) {
  const f = P(k).f;
  return `<div class="tc-pop" data-tpop="${k}">
    <div class="tp-row"><span>平台</span>${PLATS.map((p) => `<label><input type="checkbox" data-tfp="${k}:${p}" ${f.plats.includes(p) ? 'checked' : ''}/>${{ flap: 'Flap', four: 'Four', gang: 'Gang', gwei: 'GWEI' }[p]}</label>`).join('')}</div>
    <div class="tp-row"><span>市值 $</span><input data-tff="${k}:minMc" value="${f.minMc}" placeholder="最低"/><input data-tff="${k}:maxMc" value="${f.maxMc}" placeholder="最高"/></div>
    <div class="tp-row"><span>持有人 ≥</span><input data-tff="${k}:minHolders" value="${f.minHolders}"/><span>进度 ≥ %</span><input data-tff="${k}:minProg" value="${f.minProg}"/></div>
    <div class="tp-row"><span>报价币</span><input data-tff="${k}:quote" value="${esc(f.quote)}" placeholder="BNB, BNCB…"/><label><input type="checkbox" data-tfs="${k}" ${f.social ? 'checked' : ''}/>有社交链接</label></div>
    <div class="tp-row"><span>最高税率 %</span><input data-tff="${k}:maxTax" value="${f.maxTax ?? ''}" placeholder="如 5"/><label><input type="checkbox" data-tfu="${k}" ${f.hideUnknownTax ? 'checked' : ''}/>税率未知也隐藏</label><button class="qb" data-tfall="${k}" title="把这一列的税率条件复制到三列">应用到全部列</button></div>
    <div class="tp-row"><button class="qb" data-tfreset="${k}">重置</button><span class="muted">P${TR.cols[k].preset} 预设，自动保存</span></div></div>`;
}

function tcMatch(k, t) {
  const c = TR.cols[k], f = P(k).f;
  if (!f.plats.includes(platOf(t))) return false;
  if (isBlocked(t)) return false;
  const n = (v) => (v === '' || v == null ? null : Number(v));
  if (n(f.minMc) != null && !((t.mcapUsd || 0) >= n(f.minMc))) return false;
  if (n(f.maxMc) != null && !((t.mcapUsd || 0) <= n(f.maxMc))) return false;
  if (n(f.minHolders) != null && !((t.holders || 0) >= n(f.minHolders))) return false;
  if (n(f.minProg) != null && !((t.progress || 0) >= n(f.minProg))) return false;
  if (f.quote && !f.quote.toUpperCase().split(/[,，\s]+/).filter(Boolean).includes(String(t.quote || '').toUpperCase())) return false;
  if (f.social && !(t.website || t.twitter || t.telegram)) return false;
  // 税率：买或卖任一边超过上限就隐藏；不知道税率的默认照常显示
  // 用的就是卡片上显示的那两个数（buyFeePct / sellFeePct）。任何一边已知且超过上限就隐藏；两边都不知道才算「税率未知」
  if (n(f.maxTax) != null || f.hideUnknownTax) {
    const known = [t.buyFeePct, t.sellFeePct].filter((v) => v != null && isFinite(v));
    if (!known.length) { if (f.hideUnknownTax) return false; }
    else if (n(f.maxTax) != null && Math.max(...known) > n(f.maxTax)) return false;
  }
  const kw = c.q.toLowerCase().split(/[,，]+/).map((x) => x.trim()).filter(Boolean);
  if (kw.length && !kw.some((w) => `${t.symbol} ${t.name} ${t.address}`.toLowerCase().includes(w))) return false;
  return true;
}

function tcCard(t, k) {
  const plat = platOf(t), curve = t.stage === 'curve', prog = Math.min(100, Number(t.progress) || 0);
  const gangOnly = false;   // Gang V2 也能下单了
  const st = tcState.get(t.address);
  const dev = t.creatorName || (t.creator ? short(t.creator, 4, 4) : '');
  const fee = t.buyFeePct != null ? t.buyFeePct : t.buyTax;
  const soc = [t.website && ['🌐', t.website], t.twitter && ['𝕏', t.twitter], t.telegram && ['✈', t.telegram]].filter(Boolean)
    .map(([i, u]) => `<a class="soc" href="${esc(/^https?:/.test(u) ? u : 'https://' + u)}" target="_blank" rel="noopener" data-ext-link>${i}</a>`).join('');
  const hp = S.positions?.find((p) => p.token === t.address && p.amount > 0);
  const fb = t.firstBuyer ? (t.firstBuyerName || nameOf({ trader: t.firstBuyer }) || short(t.firstBuyer, 4, 4)) : '';
  const route = curve ? `${esc(t.quote || 'BNB')} | ${amtFmt(t.raised)}/${amtFmt(t.target)} → ${prog.toFixed(1)}%` : `${esc(t.quote || 'BNB')} | 已迁移 DEX`;
  return `<div class="tcard ${plat} ${hp ? 'held' : ''} " data-pa="${t.address}">
    <div class="tc-l"><div class="tc-img">${logoHtml(t, 'tl')}<i class="tc-badge ${plat}">${{ flap: 'F', four: '4', gang: 'G', gwei: 'W' }[plat]}</i></div>
      <div class="tc-prog"><i style="width:${curve ? prog : 100}%"></i></div><div class="tc-dev ${isMe(t.creator) ? 'me' : ''}" title="创建者（Dev）：${esc(t.creator || '')}${isMe(t.creator) ? '（我）' : ''}">${esc(dev)}</div></div>
    <div class="tc-m">
      <div class="tc-n"><b class="ctick" data-ctick="${esc(t.symbol)}" title="点击复制代号">${esc(t.symbol)}</b>${t.name && t.name !== t.symbol ? `<span>${esc(t.name)}</span>` : ''}<button class="tc-fav ${isFav(t.address) ? 'on' : ''}" data-favq="${t.address}" title="${isFav(t.address) ? '取消收藏' : '收藏'}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="currentColor"/></svg></button><button class="tc-hide" data-block="${t.address}" title="屏蔽"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6.5 17.5l11-11" stroke="currentColor" stroke-width="2"/></svg></button></div>
      <div class="tc-chips">${taxChip(t, 'chip')}<i class="chip q">◎ ${esc(t.quote || 'BNB')}</i>${t.agentExclusive ? '<i class="chip ag">Agent 专属</i>' : ''}</div>
      <div class="tc-meta"><span class="g">${age(t.createdAt)}</span>${t.chg?.h1 != null ? `<span title="1 小时涨幅">1h ${chgTxt(t.chg.h1)}</span>` : ''}${soc}<span title="持有人 / 交易笔数">👥 ${t.holders ?? '—'}/${(t.buys || 0) + (t.sells || 0)}</span></div>
      <div class="tc-route ${curve ? '' : 'dex'}">${route}</div>
      <div class="tc-who">${fb ? `<span class="g">👑</span> 首买 ${isMe(t.firstBuyer) ? `<b class="me">${esc(fb)}</b><i class="me-tag">我</i>` : esc(fb)}` : ''}${hp ? `<span class="y">持有 ${K(hp.amount)}</span>` : ''}</div>
    </div>
    ${gangOnly ? `<div class="tc-r off" title="Gang V2 报价币盘暂不支持下单"><div class="tc-mc"><span>MC</span> <b>${t.mcapEst ? '≈' : ''}${usd(t.mcapUsd)}</b></div><span class="tc-buy">仅行情</span></div>`
      : `<div class="tc-r buyable ${st ? 'st-' + st : ''}" data-tqb="${t.address}:${k}" title="点这里买入"><div class="tc-mc" title="${t.mcapEst ? '还没有成交，按同模板开盘价估算的市值' : '市值'}"><span>MC</span> <b class="${curve ? '' : 'cy'}">${t.mcapEst ? '≈' : ''}${usd(t.mcapUsd)}</b></div>
        <span class="tc-buy">${TC_ST[st] || tcBuyLabel(t, k)}</span></div>`}</div>`;
}
const amtFmt = (v) => amt(v);
// 交易页左栏的紧凑卡片（和战壕同一套颜色、直角、图标，但三行排版、约 80px 高）
// 第 1 行：头像 | 代号 名字 … MC | ★ ⊘；第 2 行：税 / 计价 / Agent 标签 + 时长 · 1h · 持有人；第 3 行：进度细条 + 已筹/目标 · % + ⚡买
function tlCard(t) {
  const plat = platOf(t), curve = t.stage === 'curve', prog = Math.min(100, Number(t.progress) || 0), k = curve ? 'new' : 'dex', st = tcState.get(t.address);
  const dev = t.creatorName || (t.creator ? short(t.creator, 6, 4) : '');
  const route = curve ? `${amtFmt(t.raised)}/${amtFmt(t.target)} ${esc(t.quote || 'BNB')} · ${prog.toFixed(1)}%` : `已迁移 DEX · ${esc(t.quote || 'BNB')}`;
  return `<div class="tlc ${plat} ${t.address === S.selected ? 'sel' : ''}" data-pa="${t.address}" title="${esc(t.name || t.symbol)}${dev ? ' · Dev ' + esc(dev) : ''}">
    <div class="tlc-img">${logoHtml(t, 'tl')}<i class="tc-badge ${plat}">${{ flap: 'F', four: '4', gang: 'G', gwei: 'W' }[plat]}</i></div>
    <div class="tlc-m">
      <div class="tlc-r1"><b class="ctick" data-ctick="${esc(t.symbol)}" title="点击复制代号">${esc(t.symbol)}</b>${t.name && t.name !== t.symbol ? `<span class="tlc-nm">${esc(t.name)}</span>` : ''}
        <span class="tlc-mc" title="${t.mcapEst ? '还没有成交，按同模板开盘价估算' : '市值'}">${t.mcapEst ? '≈' : ''}${usd(t.mcapUsd)}</span>
        <button class="tlc-ic tc-fav ${isFav(t.address) ? 'on' : ''}" data-favq="${t.address}" title="${isFav(t.address) ? '取消收藏' : '收藏'}"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="currentColor"/></svg></button><button class="tlc-ic tc-hide" data-block="${t.address}" title="屏蔽"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6.5 17.5l11-11" stroke="currentColor" stroke-width="2"/></svg></button></div>
      <div class="tlc-r2">${taxChip(t, 'chip')}<i class="chip q">${esc(t.quote || 'BNB')}</i>${t.agentExclusive ? '<i class="chip ag">Agent</i>' : ''}<span class="g">${age(t.createdAt)}</span>${t.chg?.h1 != null ? `<span>1h ${chgTxt(t.chg.h1)}</span>` : ''}<span title="持有人 / 交易笔数">👥 ${t.holders ?? '—'}/${(t.buys || 0) + (t.sells || 0)}</span></div>
      <div class="tlc-r3"><div class="tlc-bar ${curve ? '' : 'dex'}"><i style="width:${curve ? prog : 100}%"></i></div><span class="tlc-rt">${route}</span>
        <span class="tlc-buy ${st ? 'st-' + st : ''}" data-tqb="${t.address}:${k}" title="快捷买入（金额在战壕对应列设置）">${TC_ST[st] || '⚡' + tcBuyLabel(t, k).replace(/^[⚡\s]*/, '')}</span></div>
    </div></div>`;
}


// 每列按 key 增量更新：卡片内容没变就不动 DOM，顺序变了才移动节点，不整列重画
function renderPulse() {
  const every = [...S.tokens.values()].filter((t) => (t.stage === 'curve' || t.stage === 'dex') );
  // 第一次渲染先把现有的币都记成「见过」，之后才响
  if (!tcPrimed && every.length) { every.forEach((t) => tcKnown.add(t.address)); tcPrimed = true; }
  queueMicrotask(() => every.forEach((t) => tcKnown.add(t.address)));   // 这次出现的都记成见过（被筛掉的也算，之后进列表不响）
  const lists = {
    new: every.filter((t) => t.stage === 'curve' && tcMatch('new', t)).sort((a, b) => b.createdAt - a.createdAt || (a.address < b.address ? -1 : 1)),   // 同一时间的按地址排，顺序稳定
    soon: every.filter((t) => t.stage === 'curve' && t.progress > 0 && tcMatch('soon', t)).sort((a, b) => (TR.cols.soon.sort === 'mc' ? (b.mcapUsd || 0) - (a.mcapUsd || 0) : b.progress - a.progress)),
    dex: every.filter((t) => t.stage === 'dex' && tcMatch('dex', t)).sort((a, b) => b.createdAt - a.createdAt || (a.address < b.address ? -1 : 1)),
  };
  for (const [k, list] of Object.entries(lists)) {
    const body = $('#tcb-' + k); if (!body) continue;
    $('#tcn-' + k).textContent = list.length;
    $('#tcp-' + k).classList.toggle('on', tcPaused.has(k));
    if (tcPaused.has(k)) { body.querySelectorAll(':scope > [data-pa]').forEach((el) => { if (isBlocked(S.tokens.get(el.dataset.pa))) el.remove(); }); continue; }   // 鼠标停在列上时列表暂停刷新，但刚屏蔽的币要立刻拿掉
    const show = list.slice(0, 60);
    // 列提示音：只对「打开页面后第一次出现、开盘不到 2 分钟、通过这一列筛选」的币响；重排、换筛选、重新进入列表都不响；每列 3 秒最多一次
    const fresh = show.filter((t) => !tcKnown.has(t.address) && Date.now() - (t.createdAt || 0) < 120_000);
    if (fresh.length && TR.cols[k].sound && Date.now() - (tcSoundAt[k] || 0) > 3000) { tcSoundAt[k] = Date.now(); colTone(k === 'dex' ? 660 : 990); (window.__tcSoundLog ||= []).push({ at: new Date().toLocaleTimeString(), col: k, tokens: fresh.map((t) => t.symbol) }); }
    show.forEach((t) => tcSeen[k].add(t.address));
    const old = new Map([...body.children].filter((x) => x.dataset.pa).map((x) => [x.dataset.pa, x]));
    // 往下翻着看的时候，新币插到最上面不要把正在看的卡片挤走：记下第一张可见卡片的位置，更新后把它放回原处
    let anchor = null, anchorTop = 0;
    if (body.scrollTop > 4) for (const c of body.children) { if (c.dataset.pa && c.offsetTop + c.offsetHeight > body.scrollTop) { anchor = c.dataset.pa; anchorTop = c.offsetTop - body.scrollTop; break; } }
    let prev = null;
    for (const t of show) {
      const html = tcCard(t, k);
      let el = old.get(t.address);
      if (!el) { const d = document.createElement('div'); d.innerHTML = html; el = d.firstElementChild; el._h = html; if (fresh.some((x) => x.address === t.address)) el.classList.add('new'); /* 只有真正的新盘（打开页面后第一次出现、开盘不到 2 分钟）闪一下；旧币重新进列表、补数据都不闪 */ }
      else if (el._h !== html) { const d = document.createElement('div'); d.innerHTML = html; const n = d.firstElementChild; patchCard(el, n); el._h = html; }   // 只改变化的部分，头像等不重建
      old.delete(t.address);
      const want = prev ? prev.nextSibling : body.firstChild;
      if (el !== want) body.insertBefore(el, want);
      prev = el;
    }
    for (const el of old.values()) el.remove();
    body.querySelector(':scope > .empty')?.remove();
    if (anchor) { const a = body.querySelector(`:scope > [data-pa="${anchor}"]`); if (a) body.scrollTop = a.offsetTop - anchorTop; }
    if (!show.length) body.innerHTML = '<div class="empty">暂无代币</div>';
  }
}
// 卡片局部更新：结构一样就逐个子节点比较，只替换内容变了的部分（头像图片节点不动，避免闪烁和高度跳动）
function patchCard(el, n) {
  for (const { name, value } of [...n.attributes]) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  for (const { name } of [...el.attributes]) if (!n.hasAttribute(name)) el.removeAttribute(name);
  const a = [...el.children], b = [...n.children];
  if (a.length !== b.length) { el.innerHTML = n.innerHTML; return; }
  a.forEach((x, i) => { if (x.outerHTML === b[i].outerHTML) return;
    // 头像：只有图片地址真的变了才换，否则不动（避免重新加载、闪一下）
    if (x.classList?.contains('logo') || x.classList?.contains('tc-img') || x.classList?.contains('tlc-img')) { const si = x.querySelector('img')?.getAttribute('src') ?? x.getAttribute('src'), ni = b[i].querySelector('img')?.getAttribute('src') ?? b[i].getAttribute('src'); if (si === ni && x.textContent === b[i].textContent) { const bx = x.querySelector('.tc-badge'), by = b[i].querySelector('.tc-badge'); if (bx && by && bx.outerHTML !== by.outerHTML) bx.replaceWith(by); return; } } if (x.tagName === b[i].tagName && x.children.length && x.children.length === b[i].children.length && !x.matches('img')) patchCard(x, b[i]); else x.replaceWith(b[i]); });
}
function renderTrenchHeads() { for (const k of Object.keys(TCOLS)) { const h = $('#tch-' + k); if (h) h.innerHTML = tcHead(k); } }

// ⚡：金额 > 0 买这一列设置的 BNB；金额 = 0 按 1% 筹码买（沿用原来的「买 1%」逻辑）
async function trenchBuy(addr, k) {
  const amt = P(k).amt; if (!(amt > 0)) return pulseBuy1(addr);
  const t = S.tokens.get(addr); if (!t || pBusy.has(addr)) return;
  const ws = [...S.selWallets]; if (!ws.length) return topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: '没有选钱包' });
  pBusy.add(addr);
  try {
    topPop({ status: 'pending', side: 'buy', symbol: t.symbol, amountIn: amt });
    let r, err;
    try { r = [].concat(await api('/api/order', { wallets: ws, token: addr, side: 'buy', amount: amt, slippage: P(k).slip || S.slippage, via: 'quick' })); } catch (e) { err = e.message; }
    const f = err ? { reason: err } : r.find((o) => o?.status === 'failed');
    if (f) topPop({ ...f, status: 'failed', side: 'buy', symbol: t.symbol });
  } finally { pBusy.delete(addr); }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tp],[data-ts],[data-tsound],[data-thide],[data-tf],[data-thid],[data-tqb],[data-tfreset],[data-tfall],[data-ext-link]');
  if (!el || (!el.closest('#pulse') && el.dataset.tqb === undefined)) return;   // 左栏紧凑卡片的 ⚡ 也走这里
  if (el.dataset.extLink !== undefined) return e.stopPropagation();
  e.stopPropagation(); e.preventDefault();
  const d = el.dataset;
  if (d.tp) { const [k, n] = d.tp.split(':'); TR.cols[k].preset = +n; }
  else if (d.ts) { const [k, v] = d.ts.split(':'); TR.cols[k].sort = v; }
  else if (d.tsound) { TR.cols[d.tsound].sound = !TR.cols[d.tsound].sound; if (TR.cols[d.tsound].sound) colTone(990); }
  else if (d.tf) { tfModal(d.tf); return; }
  else if (d.tfall) { const src = P(d.tfall).f; for (const k of Object.keys(TCOLS)) Object.assign(P(k).f, { maxTax: src.maxTax, hideUnknownTax: src.hideUnknownTax }); note(`税率条件已应用到三列${src.maxTax !== '' ? `：最高 ${src.maxTax}%` : ''}`, 'info'); }
  else if (d.tfreset) { P(d.tfreset).f = defPreset().f; $('#tcf-' + d.tfreset).innerHTML = tcFilterPop(d.tfreset); }
  else if (d.tqb) {
    // 整个右侧框都是买入按钮：点下立刻显示「下单中」，结果按这次点击之后该币的最新买单判断
    const [a, k] = d.tqb.split(':'); if (tcState.get(a) === 'busy') return;
    const t0 = Date.now(), tok = S.tokens.get(a);
    const setSt = (s) => {
      if (s) tcState.set(a, s); else tcState.delete(a);
      $$(`[data-tqb^="${a}:"]`).forEach((x) => { x.classList.remove('st-busy', 'st-ok', 'st-err', 'st-pend'); if (s) x.classList.add('st-' + s); (x.querySelector('.tc-buy') || x).innerHTML = TC_ST[s] || (tok ? tcBuyLabel(tok, k) : '⚡'); });
    };
    setSt('busy');
    Promise.resolve(trenchBuy(a, k)).catch(() => null).then(() => {
      const o = S.orders.find((x) => x.token === a && x.ts >= t0 - 1000 && x.side === 'buy');
      setSt(!o ? null : o.status === 'failed' ? 'err' : o.status === 'filled' ? 'ok' : 'pend');
    }).finally(() => setTimeout(() => { tcState.delete(a); lastPulse = 0; renderPulse(); }, 2500));
    return;
  }
  trSave(); renderTrenchHeads(); lastPulse = 0; renderPulse();
}, true);
document.addEventListener('input', (e) => {
  const d = e.target.dataset; if (!e.target.closest?.('#pulse')) return;
  if (d.tq) TR.cols[d.tq].q = e.target.value;
  else if (d.ta) P(d.ta).amt = Math.max(0, Number(e.target.value) || 0);
  else if (d.tff) { const [k, f] = d.tff.split(':'); P(k).f[f] = e.target.value.trim(); }
  else if (d.tfp) { const [k, p] = d.tfp.split(':'); const s = new Set(P(k).f.plats); e.target.checked ? s.add(p) : s.size > 1 ? s.delete(p) : (e.target.checked = true); P(k).f.plats = PLATS.filter((x) => s.has(x)); }
  else if (d.tfs) P(d.tfs).f.social = e.target.checked;
  else if (d.tfu) P(d.tfu).f.hideUnknownTax = e.target.checked;
  else return;
  trSave(); lastPulse = 0; renderPulse();
  if (d.tff || d.tfp || d.tfs || d.tfu) { const k = (d.tff || d.tfp || d.tfs || d.tfu).split(':')[0]; $('#tcb-' + k) && ($(`#tch-${k} .tc-funnel`).classList.toggle('act', true)); }
});
for (const k of Object.keys(TCOLS)) {
  const col = $('#tc-' + k); if (!col) continue;
  col.querySelector('.tcb').addEventListener('mouseenter', () => { tcPaused.add(k); renderPulse(); });
  col.querySelector('.tcb').addEventListener('mouseleave', () => { tcPaused.delete(k); lastPulse = 0; renderPulse(); });
}
renderTrenchHeads();

document.addEventListener('click', (e) => {
  const b = e.target.closest('#viewSw button'); if (b) return setView(b.dataset.view);
  if (e.target.closest('[data-qb],[data-qp],[data-tqb]')) return;   // 点买入区不打开详情
  if (e.target.closest('a[href^="http"]')) return;   // 社交 / 外部链接照常新标签打开
  const c = e.target.closest('[data-pa]'); if (!c) return;
  const t = S.tokens.get(c.dataset.pa); if (!t) return;
  openToken(t);
});
// 在当前标签页打开代币详情（不新开窗口）：用 hash 路由推一条历史记录，浏览器「后退」回到战壕 / 持仓；离开战壕前记下各列滚动位置，回来时恢复
const pulseScroll = {};
function openToken(t) {
  if (S.view === 'pulse') $$('.tcb').forEach((b) => { pulseScroll[b.id] = b.scrollTop; });
  if (S.view === 'hold') pulseScroll.hold = $('#hold')?.scrollTop || 0;
  location.hash = `#/${t.platform}/${t.stage === 'dex' ? 'dex' : 'curve'}/${t.address}`;
}
setInterval(() => { if (S.view === 'pulse' && Date.now() - lastPulse > 1000) { renderPulse(); lastPulse = Date.now(); } }, 1000);
/* 鼠标侧键（后退/前进）返回战壕 */
['mousedown', 'mouseup', 'auxclick'].forEach((ev) => window.addEventListener(ev, (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault(); e.stopPropagation();
  if (ev === 'mouseup' && S.view !== 'pulse') setView('pulse');
}, true));



// ===== 战壕筛选弹窗（数据仍存 TR.cols[k].presets[preset].f，逻辑不变，只换 UI）=====
function tfModal(k) {
  document.getElementById('tfModal')?.remove();
  const f0 = P(k).f;
  const dr = { ...defPreset().f, ...JSON.parse(JSON.stringify(f0)) };
  const quotes = [...new Set([...S.tokens.values()].map((t) => String(t.quote || '').toUpperCase()).filter(Boolean))].sort();
  const PN = { flap: 'Flap', four: 'Four', gang: 'Gang', gwei: 'GWEI' };
  const m = document.createElement('div'); m.id = 'tfModal'; m.className = 'tfm-bg';
  const qset = () => new Set(String(dr.quote || '').toUpperCase().split(/[,，\s]+/).filter(Boolean));
  const draw = () => {
    const qs = qset();
    m.innerHTML = `<div class="tfm">
      <div class="tfm-h"><b>筛选 · ${TCOLS[k]} · P${TR.cols[k].preset}</b><button class="tfm-x" data-x>×</button></div>
      <div class="tfm-b">
        <div class="tfm-s"><div class="tfm-t"><span>平台</span><button class="tfm-all" data-pall>全选</button></div>
          <div class="tfm-chips">${PLATS.map((p) => `<button class="tfm-c pf-${p}${dr.plats.includes(p) ? ' on' : ''}" data-plat="${p}">${PN[p]}</button>`).join('')}</div></div>
        <div class="tfm-s"><div class="tfm-t"><span>报价代币</span><span class="muted">不选 = 全部</span></div>
          <div class="tfm-chips">${quotes.map((q) => `<button class="tfm-c${qs.has(q) ? ' on' : ''}" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>
        <div class="tfm-s"><div class="tfm-t"><span>市值 $</span></div><div class="tfm-row"><input data-f="minMc" value="${esc(dr.minMc)}" placeholder="最低"/><span>~</span><input data-f="maxMc" value="${esc(dr.maxMc)}" placeholder="最高"/></div></div>
        <div class="tfm-s tfm-2"><div><div class="tfm-t"><span>持有人 ≥</span></div><input data-f="minHolders" value="${esc(dr.minHolders)}" placeholder="不限"/></div>
          <div><div class="tfm-t"><span>进度 ≥ %</span></div><input data-f="minProg" value="${esc(dr.minProg)}" placeholder="不限"/></div></div>
        <div class="tfm-s"><label class="tfm-chk"><input type="checkbox" data-soc ${dr.social ? 'checked' : ''}/> 有社交链接</label></div>
        <div class="tfm-s tfm-2"><div><div class="tfm-t"><span>最高税率 %</span><span class="muted">买或卖超过就隐藏</span></div><input data-f="maxTax" value="${esc(dr.maxTax ?? '')}" placeholder="不限，如 5"/></div>
          <div><div class="tfm-t"><span>&nbsp;</span></div><label class="tfm-chk"><input type="checkbox" data-unk ${dr.hideUnknownTax ? 'checked' : ''}/> 税率未知也隐藏</label></div></div>
      </div>
      <div class="tfm-f"><button class="tfm-reset" data-reset>重置</button><button class="tfm-reset" data-alltax title="把这里的税率条件用到三列（当前预设）">税率应用到全部列</button><button class="tfm-ok" data-ok>应用</button></div></div>`;
  };
  const close = () => { m.remove(); document.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  m.addEventListener('input', (e) => { const x = e.target.dataset; if (x.f) dr[x.f] = e.target.value.trim(); if (x.soc != null) dr.social = e.target.checked; if (x.unk != null) dr.hideUnknownTax = e.target.checked; });
  m.addEventListener('click', (e) => {
    if (e.target === m) return close();
    const b = e.target.closest('button'); if (!b) return; const x = b.dataset;
    if (x.x != null) return close();
    if (x.plat) { const st = new Set(dr.plats); st.has(x.plat) ? (st.size > 1 && st.delete(x.plat)) : st.add(x.plat); dr.plats = PLATS.filter((p) => st.has(p)); }
    else if (x.pall != null) dr.plats = [...PLATS];
    else if (x.q) { const st = qset(); st.has(x.q) ? st.delete(x.q) : st.add(x.q); dr.quote = [...st].join(','); }
    else if (x.reset != null) Object.assign(dr, defPreset().f);
    else if (x.alltax != null) { for (const c of Object.keys(TCOLS)) Object.assign(P(c).f, { maxTax: dr.maxTax ?? '', hideUnknownTax: !!dr.hideUnknownTax }); P(k).f = dr; trSave(); renderTrenchHeads(); lastPulse = 0; renderPulse(); note(`税率条件已应用到三列${dr.maxTax ? `：最高 ${dr.maxTax}%` : ''}${dr.hideUnknownTax ? '，未知也隐藏' : ''}`, 'info'); return close(); }
    else if (x.ok != null) {
      // 税率条件改了就同时用到三列（只在一列设的话另外两列照常显示，容易以为没生效）
      const taxChanged = String(dr.maxTax ?? '') !== String(P(k).f.maxTax ?? '') || !!dr.hideUnknownTax !== !!P(k).f.hideUnknownTax;
      P(k).f = dr;
      if (taxChanged) { for (const c of Object.keys(TCOLS)) Object.assign(P(c).f, { maxTax: dr.maxTax ?? '', hideUnknownTax: !!dr.hideUnknownTax }); note(`税率条件已同时用到三列${dr.maxTax ? `：最高 ${dr.maxTax}%` : '：不限'}${dr.hideUnknownTax ? '，未知也隐藏' : ''}`, 'info'); }
      trSave(); renderTrenchHeads(); lastPulse = 0; renderPulse(); return close();
    }
    else return;
    draw();
  });
  document.addEventListener('keydown', esc_);
  draw(); document.body.appendChild(m);
}

/* ---------- 搜索历史：从搜索打开过的币，存 localStorage 'searchHist'（去重，最新在前，最多 20 个） ---------- */
const histGet = () => { try { return JSON.parse(localStorage.getItem('searchHist') || '[]'); } catch { return []; } };
const histSet = (a) => localStorage.setItem('searchHist', JSON.stringify(a.slice(0, 20)));
function histAdd(t) {
  const a = String(t.address).toLowerCase();
  histSet([{ address: t.address, symbol: t.symbol, name: t.name || '', logo: t.image || t.logo || null, platform: t.platform || '', ts: Date.now() }, ...histGet().filter((x) => String(x.address).toLowerCase() !== a)]);
}
const HIST_PLAT = { four: ['Four', '#f0b90b'], flap: ['Flap', '#a78bfa'], gang: ['Gang', '#f6465d'] };
const histAgo = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`; };
function renderHist() {
  const box = $('#searchResults'); const h = histGet();
  if (!h.length || document.activeElement !== sIn) return box.classList.add('hidden');
  searchIdx = Math.min(searchIdx, h.length - 1);
  box.innerHTML = `<div class="sh-head"><span>搜索历史</span><span class="spacer"></span><a data-hclr>清空</a></div>` + h.map((x, i) => {
    const t = S.tokens.get(x.address) || S.tokens.get(String(x.address).toLowerCase()); const img = t?.image || x.logo; const [pl, pc] = HIST_PLAT[x.platform] || [x.platform || '?', '#888'];
    return `<div data-a="${esc(x.address)}" class="sh-row${i === searchIdx ? ' on' : ''}">${img ? `<img class="sh-av" src="${esc(img)}" onerror="this.style.visibility='hidden'">` : `<span class="sh-av">${esc(String(x.symbol || '?').slice(0, 1))}</span>`}<b>${esc(x.symbol || '?')}</b><span class="muted sh-nm">${esc(x.name || '')}</span><span class="mono muted">${short(x.address)}</span><i class="sh-pl" style="color:${pc};border-color:${pc}">${esc(pl)}</i><span class="spacer"></span><span class="muted sh-ts">${histAgo(x.ts)}</span><a class="sh-del" data-hdel="${esc(x.address)}" title="删除">×</a></div>`;
  }).join('');
  box.classList.remove('hidden');
}
function histClick(e) {
  const d = e.target.closest('[data-hdel]'), c = e.target.closest('[data-hclr]');
  if (!d && !c) return false;
  e.preventDefault(); e.stopPropagation();
  histSet(c ? [] : histGet().filter((x) => x.address !== d.dataset.hdel)); renderHist(); return true;
}
sIn.addEventListener('focus', () => { if (!sIn.value.trim()) { searchIdx = 0; renderHist(); } });

/* ---------- 打赏作者 ---------- */
const DONATE_ADDR = '0xcD4750b7b09dc39d20F8bC1E92456615Da7B6688';
function openDonate() {
  if (document.querySelector('.donate-dlg')) return;
  const wrap = document.createElement('div'); wrap.className = 'ui-dlg-back';
  wrap.innerHTML = `<div class="ui-dlg donate-dlg" role="dialog" aria-modal="true"><div class="ui-h">☕ 打赏作者</div>
    <div class="ui-b"><div class="donate-qr"><img src="donate-qr.png?v=1" width="200" height="200" alt="打赏地址二维码" /></div>
      <div class="ui-addr"><span class="mono donate-addr" data-dcopy title="点击复制">${DONATE_ADDR}</span><button class="ui-copy" data-dcopy>复制</button></div>
      <div class="ui-note" style="text-align:center">BSC / BEP20 · 支持 BNB 及 BEP20 代币</div></div>
    <div class="ui-f"><button class="ui-btn" data-dclose>关闭</button></div></div>`;
  document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => { document.removeEventListener('keydown', key, true); wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 150); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-dclose]')) return close();
    if (e.target.closest('[data-dcopy]')) { let ok = false; try { await navigator.clipboard.writeText(DONATE_ADDR); ok = true; } catch { /* 剪贴板接口不可用时退回旧办法 */ }
      if (!ok) { const ta = document.createElement('textarea'); ta.value = DONATE_ADDR; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove(); }
      note(ok ? '已复制' : '复制失败，请手动选择地址', ok ? 'ok' : 'info'); }
  });
}
$('#donateBtn')?.addEventListener('click', openDonate);
