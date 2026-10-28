import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { Market, SNIPE_FEE_CURVE } from './engine/market.js';
import { SimTrader, GAS_PRESETS } from './engine/trader.js';
import { Agent } from './engine/agent.js';
import { Blocklist } from './engine/blocklist.js';
import { Favorites } from './engine/favorites.js';
import { DATA_DIR as DATA_DIR_UI } from './engine/live/config.js';
import { MODE, LIVE_TRADE, WALLET_SLOT, WALLET_PEERS, BAW_DIR, WALLET_LABEL } from './engine/live/config.js';
import * as latency from './engine/live/latency.js';
import { redactSecrets } from './engine/live/rpc.js';
import { dataFile } from './engine/live/config.js';
import { cache } from './engine/live/cache.js';
import { fairPctBnb } from './engine/live/gangFair.js';
import { mountUpdater } from './engine/updater.js';
import { mediaHostOk } from './engine/live/meta.js';
import { routeEvents, routeAlerts } from './engine/live/routeGuard.js';
import { getCallouts, startGmgnCollector } from './engine/live/callouts.js';

// 日志脱敏：控制台 / live.log 里出现的 RPC 地址（含 NodeReal key）一律打码
for (const k of ['log', 'info', 'warn', 'error']) { const f = console[k].bind(console); console[k] = (...a) => f(...a.map((x) => (typeof x === 'string' ? redactSecrets(x) : x instanceof Error ? redactSecrets(x.stack || x.message) : x))); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

// MODE=live：真实行情（shrine + Flap Agent Curve Reader + fsi）+ baw 报价/预演；再加 LIVE_TRADE=1 才会把手动订单真实上链
const LIVE = MODE === 'live';
let market, trader;
if (LIVE) {
  const { LiveMarket } = await import('./engine/live/liveMarket.js');
  const { LiveTrader } = await import('./engine/live/liveTrader.js');
  market = new LiveMarket();
  trader = new LiveTrader(market);
  await trader.init();
} else {
  market = new Market();
  trader = new SimTrader(market);
}
const agent = new Agent(market, trader, { live: LIVE });
const favorites = new Favorites();
// RPC 用量：每分钟汇总一次（按节点 / 用途 / 方法），打印到控制台并追加到 data/rpc-usage.jsonl；/api/rpc-usage 看最近 60 分钟
const rpcUsageLog = [];
if (LIVE) {
  const { takeUsage, takeCallers, cuOf } = await import('./engine/live/rpc.js');
  const { appendFileSync, mkdirSync } = await import('node:fs');
  setInterval(() => {
    const u = takeUsage(), callers = takeCallers(), nr = Object.entries(u).filter(([k]) => k.startsWith('NodeReal'));
    const total = nr.filter(([k]) => !k.endsWith('|ws_bytes')).reduce((a, [, n]) => a + n, 0);
    const perKey = {}; for (const [k, n] of nr) { const [node, , m] = k.split('|'); const o = (perKey[node] ||= { req: 0, cu: 0 }); if (m !== 'ws_bytes') o.req += n; o.cu += cuOf(m, n); }
    for (const o of Object.values(perKey)) o.cu = Math.round(o.cu);
    const row = { ts: Date.now(), nodereal: total, cu: Object.values(perKey).reduce((a, o) => a + o.cu, 0), perKey, all: Object.values(u).reduce((a, n) => a + n, 0), detail: u, callers };
    rpcUsageLog.push(row); if (rpcUsageLog.length > 60) rpcUsageLog.shift();
    const top = nr.filter(([k]) => !k.endsWith('|ws_bytes')).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`).join('，');
    console.log(`[RPC] 最近 1 分钟 NodeReal ${total} 次 / ${row.cu} CU（${Object.entries(perKey).map(([k, o]) => `${k} ${o.req} 次 ${o.cu} CU`).join('，')}）${top ? '：' + top : ''}`);
    const topC = Object.entries(callers).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}×${n}`).join('，');
    if (topC) console.log(`[RPC] 调用位置前 6（抽样估算，不含重试）：${topC}`);
    try { mkdirSync(path.join(__dirname, 'data'), { recursive: true }); appendFileSync(path.join(__dirname, 'data', 'rpc-usage.jsonl'), JSON.stringify(row) + '\n'); } catch { /* 写不了就算了 */ }
  }, 60_000);
}
// 行情列表满了会淘汰最老的币：持有中（本程序记录 + 持仓快照）和收藏的币不能被淘汰，否则持仓页会少掉它们
market.keepSet = () => new Set([
  ...[...(trader.positions?.values?.() || [])].filter((p) => p.amount > 0).map((p) => String(p.token).toLowerCase()),
  ...(() => { try { return holdSnap?.rows || []; } catch { return []; } })().filter((r) => r.amount > 0).map((r) => String(r.token).toLowerCase()),   // 启动早期 holdSnap 还没定义
  ...Object.keys(favorites.items || {}).map((a) => a.toLowerCase()),
]);
const blocklist = new Blocklist(); agent.isBlocked = (s) => blocklist.has(s);   // 屏蔽的币不自动买
// 实盘的 ⚡ 快捷买入金额存进 data/live-settings.json，重启后沿用（以前每次重启都回到默认 0.1）
if (LIVE) { const q = Number(trader.loadSaved?.().quickBuy); if (q > 0) agent.setConfig({ quickBuy: q }); }
// 持仓页：链上数量 + baw 钱包历史算成本（只在实盘模式）
const holdings = LIVE ? new (await import('./engine/live/holdings.js')).Holdings(market, trader) : null;
market.start();
// 收藏的币重启后要回到列表（不然顶栏收藏条只剩「—」、点开一片空白，如已迁移的老盘 Gangstar 2026-10-29）：启动 20 秒后逐个上链查一次，之后每 10 分钟补一次被漏掉的
const favRestore = async () => { if (!LIVE) return; for (const a of Object.keys(favorites.items || {})) if (!market.get(a)) await market.lookup(a).catch(() => null); };
setTimeout(() => { favRestore(); setInterval(favRestore, 600_000).unref?.(); }, 20_000);

const net = { wss: 302, rpc: 102, detect: 146, detectAt: Date.now() };
setInterval(() => {
  if (LIVE) Object.assign(net, market.netStatus());
  else { net.wss = Math.round(260 + Math.random() * 90); net.rpc = Math.round(80 + Math.random() * 50); }
}, LIVE ? 1000 : 3000);
agent.on('detect', (ms) => { net.detect = ms; net.detectAt = Date.now(); });
const modeInfo = () => ({ mode: LIVE ? 'live' : 'sim', baw: LIVE ? trader.status : null });

const app = express();
// ---------- 本地 API 防护 ----------
// 1) Host 只认本机名（防 DNS rebinding：别的网站把域名解析到 127.0.0.1 再来调接口）
// 2) 改动类请求（POST 等）和 WebSocket：浏览器发来的必须是本页面同源（Origin = http://localhost:端口），别的网页（含本机其他端口）一律拒绝
// 3) 没有 Origin 的请求（其他钱包后端、脚本）必须带访问令牌 x-tmtn-token：TMTN_API_TOKEN，没配就用 data/api-token（首次启动随机生成）
// 额外允许的主机名 / 来源用 ALLOWED_HOSTS / ALLOWED_ORIGINS（逗号分隔）
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', ...String(process.env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)]);
const EXTRA_ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '').toLowerCase()).filter(Boolean));
const API_TOKEN = (() => {
  if (process.env.TMTN_API_TOKEN) return process.env.TMTN_API_TOKEN;
  const f = dataFile('api-token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* 第一次启动 */ }
  const t = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(new URL('.', f), { recursive: true }); fs.writeFileSync(f, t + '\n', { mode: 0o600 }); return t;
})();
const hostOk = (h) => LOCAL_HOSTS.has(String(h || '').toLowerCase().replace(/:\d+$/, ''));
const originOk = (o) => { try { const u = new URL(o); return EXTRA_ORIGINS.has(u.origin.toLowerCase()) || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname.toLowerCase()) && Number(u.port || 80) === PORT); } catch { return false; } };
const tokenOk = (t) => { const a = Buffer.from(String(t || '')), b = Buffer.from(API_TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const guard = (req, write) => {
  if (!hostOk(req.headers.host)) return 'Host 不是本机，已拒绝';
  if (!write) return null;
  const o = req.headers.origin;
  if (o) return originOk(o) ? null : `来源 ${String(o).slice(0, 80)} 不是本页面，已拒绝`;
  return tokenOk(req.headers['x-tmtn-token']) ? null : '缺少访问令牌（x-tmtn-token），已拒绝';
};
// CSP：只运行本站自己的 .js 文件。代币名 / 代号里藏的 <img onerror=import('//恶意网站/x.js')> 之类，就算哪里漏了转义也执行不了，
// 也连不到别的网站（connect-src 只许本机）；图片只走本机 /api/img 代理，不让陌生图床拿到你的 IP
const csp = (req) => { const h = String(req.headers.host || '').replace(/[^\w.:[\]-]/g, ''); return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://${h} wss://${h}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`; };
app.use((req, res, next) => {
  const e = guard(req, !['GET', 'HEAD', 'OPTIONS'].includes(req.method));
  if (e) { console.warn(`[security] ${req.method} ${req.path}：${e}`); return res.status(403).json({ error: e }); }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp(req) });   // 页面不许被别的网站嵌进 iframe（防点击劫持）
  next();
});
app.use(express.json());
// 强制登录：实盘模式下币安钱包未登录时，所有动用资金的接口一律拒绝（买卖、兑换、换回 BNB、领取、撤销授权、单币转出规则）
const AUTH_GATED = new Set(['/api/order', '/api/swap', '/api/quote-to-bnb', '/api/quote-to-bnb/sweep', '/api/quote-to-bnb/sweep-own', '/api/claim', '/api/approvals/revoke', '/api/token-rules']);
app.use((req, res, next) => {
  if (LIVE && req.method === 'POST' && AUTH_GATED.has(req.path) && !((req.path === '/api/order' || req.path === '/api/quote-to-bnb/sweep') && WALLET_PEERS.length) && !(req.path === '/api/quote-to-bnb' && Number(req.body?.slot) > 0 && Number(req.body.slot) !== WALLET_SLOT) && trader.status?.auth?.state !== 'ok') return res.status(401).json({ error: '币安钱包未登录', auth: trader.status?.auth?.state });   // 多钱包时下单按钱包分别处理（未登录的跳过）
  next();
});
// 首页：把 app.js / style.css 的版本号换成文件修改时间（每次改动都是新地址，浏览器不会用旧缓存），首页本身不缓存
app.get(['/', '/index.html'], (req, res) => {
  try {
    const pub = path.join(__dirname, 'public'), v = (f) => Math.round(fs.statSync(path.join(pub, f)).mtimeMs);
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/(app\.js|style\.css)\?v=[^"']*/g, (m, f) => `${f}?v=${v(f)}`);
    res.setHeader('Cache-Control', 'no-store'); res.type('html').send(html);
  } catch (e) { res.status(500).send(e.message); }
});
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));   // 每次都向服务器确认有没有更新（没变就 304），避免浏览器一直用旧的 app.js / style.css
mountUpdater(app, { rootDir: __dirname, peers: WALLET_PEERS.length });   // 版本管理：检查更新 / 切换版本 / 恢复备份（页面右下角的版本号）

const state = () => ({
  ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, gangMcap: market.gangMcap || 0, net,
  wallets: trader.walletsView(), settings: trader.settings, gasPresets: GAS_PRESETS, config: agent.config, usage: agent.usageView(),
  tokens: market.list(), positions: trader.positionsView(), snipeCurve: SNIPE_FEE_CURVE, claimable: LIVE ? trader.claimable : [],
  routeAlerts: routeAlerts.slice(0, 10),
});

app.post('/api/claim', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式能领取' }); res.json(await trader.claimOne(req.body.market, '手动领取')); });
app.post('/api/auth/login', async (req, res) => { try { res.json(LIVE ? loginView(await trader.startLogin()) : null); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/auth/login-cancel', (req, res) => { res.json(LIVE ? loginView(trader.cancelLogin()) : null); });
app.post('/api/auth/check', async (req, res) => res.json(LIVE ? await trader.checkAuth() : null));
setTimeout(() => { for (const o of [...trader.orders].reverse()) latency.record(o); }, 5000);   // 启动时把内存里已有订单补记一次（按 id/tx 去重）
app.get('/api/latency-stats', (req, res) => res.json(latency.stats(Math.max(0.01, Number(req.query.days) || 1))));
// 「下单耗时」页面（latency.html）：本钱包 + WALLET_PEERS 里其他钱包后端的每笔买卖耗时（own=1 只返回本钱包，给主后端汇总用）
app.get('/api/latency/orders', async (req, res) => {
  const days = Math.min(90, Math.max(0.01, Number(req.query.days) || 7));
  const rows = latency.ordersView(days, WALLET_LABEL).map((r) => ({ ...r, slot: WALLET_SLOT })), wallets = [{ slot: WALLET_SLOT, label: WALLET_LABEL, ok: true }];
  if (req.query.own !== '1') await Promise.all(WALLET_PEERS.map(async (p) => {
    const label = p.label || `钱包 ${p.slot}`;
    try { const v = await peerFetch(p, `/api/latency/orders?own=1&days=${days}`, null, 8000); for (const r of v?.rows || []) rows.push({ ...r, wallet: label, slot: p.slot }); wallets.push({ slot: p.slot, label, ok: true }); }
    catch (e) { wallets.push({ slot: p.slot, label, ok: false, error: e.status === 404 ? '这个钱包后端还没更新到有耗时接口的版本' : e.message }); }
  }));
  rows.sort((a, b) => b.ts - a.ts); wallets.sort((a, b) => a.slot - b.slot);
  res.json({ days, now: Date.now(), stages: latency.STAGES, wallets, rows });
});
app.get('/api/state', (req, res) => res.json({ ...state(), orderSlots: true, holdings: holdView || holdSnap, orders: trader.orders.slice(0, 100), logs: agent.logs.slice(0, 150), records: agent.records }));
// 持仓快照：后台每 5 秒算一次（下单 / 领取 / 转账结束后立刻再算），通过 WebSocket 推给页面、也放进 /api/state，
// 页面打开详情时直接用快照，不再每次现算（现算要读钱包历史和链上报价，慢）
let holdSnap = null, holdView = null, holdBusy = false, holdAgain = false;   // holdSnap：本钱包；holdView：多钱包时合并后的（给页面）
// ---------- 多钱包（同时下单）----------
// 每个钱包是一个独立的后端（各自的 baw 登录目录 BINANCE_BAW_DIR、数据目录 DATA_DIR、设置 / 授权）。
// 主后端（钱包 1）在 WALLET_PEERS 里登记其他钱包的后端地址；页面上的一笔订单由主后端同时发给所有「参与下单」的钱包。
const peerFetch = async (peer, p, body, ms = 2500) => {
  const r = await fetch(peer.url.replace(/\/$/, '') + p, { method: body ? 'POST' : 'GET', headers: { 'x-tmtn-token': peer.token || API_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });   // 其他钱包后端要用同一个 TMTN_API_TOKEN（或在 WALLET_PEERS 里写 token）
  const j = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(j?.error || `HTTP ${r.status}`), { status: r.status }); return j;
};
// 其他钱包的 baw 用自己的登录目录 + 自己的设备标识（BINANCE_INSTANCE_ID），避免和钱包 1 的登录互相影响
const signinCmd = (dir, inst) => (dir ? `BINANCE_BAW_DIR=${dir}${inst ? ` BINANCE_INSTANCE_ID=${inst}` : ''} baw auth signin` : 'baw auth signin');
// 给页面 / 主后端看的登录进度（不含 qrCodeId 等内部字段）
const loginView = (l) => (l ? { id: l.id, state: l.state, urlForWeb: l.urlForWeb, pairingCode: l.pairingCode, expireAt: l.expireAt, message: l.message, address: l.address || null } : null);
const selfInfo = () => ({ slot: WALLET_SLOT, expect: process.env.WALLET_ADDRESS || null, login: loginView(trader.status?.login), authMessage: trader.status?.auth?.message || '', label: WALLET_LABEL, agentId: trader.status?.auth?.agentId || null, address: trader.wallets?.[0]?.address || null, bnb: trader.wallets?.[0]?.bnb ?? null, auth: trader.status?.auth?.state || 'checking', bawDir: BAW_DIR || null, signin: signinCmd(BAW_DIR, process.env.BINANCE_INSTANCE_ID) });
const walletOn = (slot) => { const v = (trader.settings?.walletOn || {})[slot]; return v === undefined ? slot === WALLET_SLOT : v !== false; };   // 其他钱包默认不参与，要在钱包菜单里打开
// Agent ID 门槛盘：每个钱包（本后端 + 其他钱包后端的地址）持有几个门槛 NFT。地址列表 60 秒缓存
let walletAddrs = { at: 0, list: [] };
async function nftHolders(nft) {
  if (Date.now() - walletAddrs.at > 60_000) walletAddrs = { at: Date.now(), list: (await walletsView()).filter((w) => w.address || w.expect).map((w) => ({ slot: w.slot, label: w.label, address: w.address || w.expect })) };
  return Promise.all(walletAddrs.list.map(async (w) => ({ ...w, n: await trader.flapNft.holds(nft, w.address).catch(() => null) })));
}
async function walletsView() {
  const out = [{ ...selfInfo(), self: true, reachable: true, on: walletOn(WALLET_SLOT) }];
  for (const p of WALLET_PEERS) {
    let info = null, err = null; try { info = await peerFetch(p, '/api/wallet-info'); } catch (e) { err = e.message; }
    out.push({ slot: p.slot, expect: info?.expect || p.address || null, login: info?.login || null, authMessage: info?.authMessage || '', label: p.label || info?.label || `钱包 ${p.slot}`, agentId: info?.agentId || null, address: info?.address || null, bnb: info?.bnb ?? null, auth: info ? info.auth : 'offline', bawDir: p.bawDir || info?.bawDir || null, signin: p.signin || signinCmd(p.bawDir || info?.bawDir, p.instanceId),   /* WALLET_PEERS 里可以直接写登录命令（比如钱包 2 跑在 Docker 里） */ reachable: !!info, error: err, on: walletOn(p.slot) });
  }
  return out;
}
// 持仓合并：同一个币各钱包的数量 / 市值 / 成本 / 已卖出 / 盈亏相加，byWallet 里留每个钱包自己的；wallets 里留每个钱包完整的持仓（页面可按钱包筛选）
async function mergeHoldings(own) {
  if (!WALLET_PEERS.length || !own) return own;
  const parts = [{ slot: WALLET_SLOT, label: WALLET_LABEL, snap: own }];
  for (const p of WALLET_PEERS) { try { const s = await peerFetch(p, '/api/holdings?own=1'); if (s?.rows) parts.push({ slot: p.slot, label: p.label || `钱包 ${p.slot}`, snap: s }); } catch { /* 这个钱包暂时连不上就先不算 */ } }
  const by = new Map(), sumK = ['amount', 'supplyPct', 'valueBnb', 'valueUsd', 'costBnb', 'soldBnb', 'costUsd', 'soldUsd', 'pnlBnb', 'pnlUsd'];
  for (const part of parts) for (const r of part.snap.rows || []) {
    const k = String(r.token).toLowerCase(), cur = by.get(k);
    const mine = { slot: part.slot, label: part.label, amount: r.amount, valueUsd: r.valueUsd, costUsd: r.costUsd, soldUsd: r.soldUsd, pnlUsd: r.pnlUsd };
    if (!cur) { by.set(k, { ...r, byWallet: [mine] }); continue; }
    for (const f of sumK) if (r[f] != null) cur[f] = (cur[f] || 0) + r[f];
    cur.byWallet.push(mine); cur.firstAt = Math.min(cur.firstAt || Infinity, r.firstAt || Infinity);
    cur.trades = [...(cur.trades || []), ...(r.trades || [])].sort((a, b) => b.ts - a.ts);
  }
  const rows = [...by.values()].map((r) => ({ ...r, pnlPct: r.costUsd > 0 && r.pnlUsd != null ? (r.pnlUsd / r.costUsd) * 100 : r.pnlPct }));
  const totals = {}; for (const part of parts) for (const [k, v] of Object.entries(part.snap.totals || {})) if (typeof v === 'number') totals[k] = (totals[k] || 0) + v;
  return { ...own, rows, totals, bnb: parts.reduce((a, x) => a + (x.snap.bnb || 0), 0), wallets: parts.map((x) => ({ slot: x.slot, label: x.label, rows: x.snap.rows, totals: x.snap.totals, bnb: x.snap.bnb })) };
}
let holdSent = '';   // 持仓没变就不再推（每次约 250KB）
async function refreshHoldSnap() {
  if (!holdings) return; if (holdBusy) { holdAgain = true; return; } holdBusy = true;
  try { holdSnap = await holdings.view(); holdView = await mergeHoldings(holdSnap); const s = JSON.stringify(holdView); if (s !== holdSent) { holdSent = s; broadcast({ type: 'holdings', data: holdView }); } } catch { /* 下次再算 */ }
  holdBusy = false; if (holdAgain) { holdAgain = false; setTimeout(refreshHoldSnap, 200); }
}
if (holdings) { setTimeout(refreshHoldSnap, 3000); setInterval(refreshHoldSnap, 5000); }
app.get('/api/holdings', async (req, res) => {
  if (!holdings) return res.json({ rows: [], totals: {}, bnb: 0 });
  if (req.query.refresh) { trader.syncAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); await holdings.loadHistory(true).catch(() => {}); holdSnap = await holdings.view(); holdView = await mergeHoldings(holdSnap); broadcast({ type: 'holdings', data: holdView }); return res.json(req.query.own ? holdSnap : holdView); }
  res.json(req.query.own ? holdSnap || await holdings.view() : holdView || holdSnap || await holdings.view());   // own=1：只要本钱包的（其他后端合并时用）
});
// 计价币余额与一键换回 BNB（只在点击后执行；先 preview 给确认框看报价）
// 按钱包：?slot= / body.slot 是其他钱包时转给它自己的后端；不填 slot = 本钱包（其他后端合并时用）。?slot=0 = 所有「参与下单」的钱包，每行带 slot / label
const quotePeer = (slot) => (Number(slot) > 0 && Number(slot) !== WALLET_SLOT ? WALLET_PEERS.find((x) => x.slot === Number(slot)) || { missing: true } : null);
app.get('/api/quote-balances', async (req, res) => {
  if (!LIVE) return res.json([]);
  if (req.query.slot === undefined) { try { return res.json(await trader.quoteBalances()); } catch (e) { return res.status(500).json({ error: e.message }); } }
  const ws = sweepTargets(req.query.slot); const errs = [];
  const parts = await Promise.all(ws.map(async (w) => { try { return (w.self ? await trader.quoteBalances() : await peerFetch(w.peer, '/api/quote-balances', null, 30_000)).map((r) => ({ ...r, slot: w.slot, label: w.label })); } catch (e) { errs.push(`${w.label}：${e.message}`); return []; } }));
  if (errs.length && errs.length === ws.length) return res.status(500).json({ error: errs.join('；') });
  res.json(parts.flat());
});
app.post('/api/quote-to-bnb/preview', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' });
  const p = quotePeer(req.body.slot); if (p?.missing) return res.status(400).json({ error: '没有这个钱包' });
  try { res.json(p ? await peerFetch(p, '/api/quote-to-bnb/preview', { token: req.body.token, slippage: req.body.slippage }, 60_000) : await trader.quoteToBnbPreview(String(req.body.token || ''), Number(req.body.slippage) || 1)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/quote-to-bnb', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' });
  const p = quotePeer(req.body.slot); if (p?.missing) return res.status(400).json({ error: '没有这个钱包' });
  if (!p) return res.json(await trader.quoteToBnb({ token: String(req.body.token || ''), slippage: Number(req.body.slippage) || 1 }));
  const label = p.label || `钱包 ${p.slot}`;
  try { const o = await peerFetch(p, '/api/quote-to-bnb', { token: req.body.token, slippage: req.body.slippage }, 600_000); const x = { ...o, id: `w${p.slot}-${o.id}`, wallet: label, walletSlot: p.slot }; broadcast({ type: 'order', data: x }); res.json(x); }
  catch (e) { res.json({ status: 'failed', side: 'sell', wallet: label, walletSlot: p.slot, symbol: '换回 BNB', reason: e.status === 401 ? '币安钱包未登录' : e.name === 'TimeoutError' ? '等结果超时（可能已经在执行，请看订单记录，不要重复点）' : e.message }); }
});
// 一键全部换回 BNB：*-own 每个钱包后端都有（只管自己的钱包）；plan / sweep 由主后端分发给各钱包（slot = 只那一个钱包；不填 = 所有「参与下单」的钱包）。
// plan 只报价不发交易；sweep 只换页面确认框里列出的钱包 × 币（plan 已经按钱包选择过滤），各钱包同时执行、同一个钱包内按顺序
const sweepTargets = (slot) => { const all = [{ slot: WALLET_SLOT, label: WALLET_LABEL, self: true }, ...WALLET_PEERS.map((p) => ({ slot: p.slot, label: p.label || `钱包 ${p.slot}`, peer: p }))]; return slot === 'any' ? all : Number(slot) > 0 ? all.filter((w) => w.slot === Number(slot)) : all.filter((w) => walletOn(w.slot)); };
const sweepErr = (e) => (e.status === 401 ? '币安钱包未登录' : e.message);
app.post('/api/quote-to-bnb/plan-own', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' }); try { res.json(await trader.quoteSweepPlan(Number(req.body?.slippage) || 1)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/quote-to-bnb/sweep-own', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' }); res.json(await trader.quoteSweep({ tokens: Array.isArray(req.body?.tokens) ? req.body.tokens.slice(0, 30) : [], slippage: Number(req.body?.slippage) || 1 })); });
app.post('/api/quote-to-bnb/plan', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' });
  const ws = sweepTargets(req.body?.slot), slippage = Number(req.body?.slippage) || 1; if (!ws.length) return res.status(400).json({ error: '没有开启「参与下单」的钱包' });
  res.json(await Promise.all(ws.map(async (w) => {
    try { return { slot: w.slot, label: w.label, ...(w.self ? await trader.quoteSweepPlan(slippage) : await peerFetch(w.peer, '/api/quote-to-bnb/plan-own', { slippage }, 120_000)) }; }
    catch (e) { return { slot: w.slot, label: w.label, items: [], skipped: [], error: sweepErr(e) }; }
  })));
});
app.post('/api/quote-to-bnb/sweep', async (req, res) => {   // { plan: [{ slot, tokens }], slippage }
  if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' });
  const want = new Map((Array.isArray(req.body?.plan) ? req.body.plan : []).map((x) => [Number(x.slot), (Array.isArray(x.tokens) ? x.tokens : []).map(String).slice(0, 30)]));
  const ws = sweepTargets('any').filter((w) => want.get(w.slot)?.length), slippage = Number(req.body?.slippage) || 1;
  if (!ws.length) return res.status(400).json({ error: '没有要换的币' });
  res.json(await Promise.all(ws.map(async (w) => {
    const tag = (o) => ({ ...o, wallet: w.label, walletSlot: w.slot, ...(w.self ? {} : { id: `w${w.slot}-${o.id || Date.now()}` }) });
    try {
      if (w.self && trader.status?.auth?.state !== 'ok') throw Object.assign(new Error('币安钱包未登录'), { status: 401 });
      const r = w.self ? await trader.quoteSweep({ tokens: want.get(w.slot), slippage }) : await peerFetch(w.peer, '/api/quote-to-bnb/sweep-own', { tokens: want.get(w.slot), slippage }, 900_000);
      const orders = (r || []).map(tag); if (!w.self) orders.forEach((o) => broadcast({ type: 'order', data: o }));
      return { slot: w.slot, label: w.label, orders };
    } catch (e) { return { slot: w.slot, label: w.label, orders: [], error: e.name === 'TimeoutError' ? '等结果超时（可能已经在执行，请看钱包 / 订单记录，不要重复点）' : sweepErr(e) }; }
  })));
});
app.get('/api/trades/:token', async (req, res) => { try { const v = LIVE ? await market.tradesPage(req.params.token, Number(req.query.before) || 0, Math.min(500, Number(req.query.limit) || 100)) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/trader/:token/:addr', async (req, res) => { try { const v = LIVE ? await market.traderStats(req.params.token, req.params.addr) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/holders/:token', async (req, res) => { try { const v = LIVE ? await market.holders(req.params.token) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });   // HOLDERS_FEATURE 详情页「持有人」
app.get('/api/callouts', async (req, res) => { try { res.set('Cache-Control', 'no-store').json(await getCallouts(req.query.ca, String(req.query.source || 'all'))); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });   // 详情页「喊单」：four.meme 代币评论（engine/live/callouts.js）
app.get('/api/rpc-usage', (req, res) => res.json(rpcUsageLog));
app.get('/api/cache-status', (req, res) => res.json(cache.status()));   // 历史数据缓存（MySQL / Redis）是否启用、连上没有、命中次数
cache.mysql(); cache.redis();   // 启动时先连一下（没配置就什么都不做），日志里能看到连上没有
// 页面布局偏好（左侧钱包追踪栏开 / 关、宽度）：服务器也存一份，浏览器数据丢了或换了地址也能恢复
const UI_PREFS = path.join(DATA_DIR_UI, 'ui-prefs.json');
app.get('/api/ui-prefs', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(UI_PREFS, 'utf8'))); } catch { res.json({}); } });
app.post('/api/ui-prefs', (req, res) => {
  const b = req.body || {}, cur = (() => { try { return JSON.parse(fs.readFileSync(UI_PREFS, 'utf8')); } catch { return {}; } })();
  if (typeof b.trkPanel === 'boolean') cur.trkPanel = b.trkPanel; if (Number(b.trkPanelW) > 0) cur.trkPanelW = Math.min(640, Math.max(260, Number(b.trkPanelW)));
  try { fs.mkdirSync(path.dirname(UI_PREFS), { recursive: true }); fs.writeFileSync(UI_PREFS, JSON.stringify(cur)); } catch { /* ignore */ }
  res.json(cur);
});
// ---------- 追踪 + 跟单（只在实盘、只在主后端）----------
let tracker = null;
if (WALLET_SLOT === 1) startGmgnCollector();   // GMGN 全链喊单后台收集 + 存盘（第二个钱包后端不重复拉）
if (LIVE && WALLET_SLOT === 1) {
  const { Tracker } = await import('./engine/live/tracker.js');
  tracker = new Tracker({ market, provider: market.provider, placeOrder, log: (m) => console.log(m) });
  market.on('trade', (t) => tracker.onTrade(t).catch(() => {}));
  tracker.on('event', (e) => broadcast({ type: 'track', data: e }));
  tracker.on('targets', (v) => broadcast({ type: 'trackTargets', data: v }));
  tracker.on('tasks', (v) => broadcast({ type: 'copyTasks', data: v }));
  tracker.on('log', (r) => broadcast({ type: 'copyLog', data: r }));
  tracker.on('reload', () => broadcast({ type: 'trackReload' }));   // 历史回补完成：页面重新拉追踪数据
  setTimeout(() => tracker.backfillPending(), 20_000);   // 启动后补一次还没回补过的追踪地址（最近 24 小时，只写历史，不跟单）
}
// ---------- Gang 新盘狙击（只在实盘主后端；默认关闭 + 模拟，本人在顶栏「狙击」模块里打开）----------
let sniper = null;
if (LIVE && WALLET_SLOT === 1) {
  const { Sniper } = await import('./engine/live/sniper.js');
  const { wbnbTopUp } = await import('./engine/live/sniper.js');
  // 预备 WBNB：本钱包直接做，其他钱包发给它们自己的后端（/api/snipe/float）
  const floatFn = (target, slots) => Promise.all(slots.map((slot) => slot === WALLET_SLOT ? wbnbTopUp(trader, target, LIVE_TRADE)
    : (() => { const p = WALLET_PEERS.find((x) => x.slot === slot); return p ? peerFetch(p, '/api/snipe/float', { target }, 60_000).catch((e) => ({ wallet: p.label || `钱包 ${slot}`, error: e.message })) : { wallet: `钱包 ${slot}`, skip: '没有这个钱包' }; })()));
  sniper = new Sniper({ market, trader, placeOrder, floatFn, isBlocked: (t) => blocklist.has(t), log: (m) => console.log(m) });
  sniper.on('state', (v) => broadcast({ type: 'snipeState', data: v }));
  sniper.on('log', (r) => { broadcast({ type: 'snipeLog', data: r }); if (r.kind !== 'skip') console.log(`[狙击] ${r.symbol} ${r.kind}：${r.reason}`); });
}
// 交易节点保持热连接（每个钱包后端都做）：冷连接第一次读链要 0.7～1.8 秒，狙击时钱包 2 的后端也要马上能读曲线、模拟
if (LIVE) setInterval(() => trader.gangV2?.provider?.getBlockNumber?.().catch(() => {}), 10_000);
// 每个钱包后端都有：把自己钱包的 WBNB 补到 target（主后端的狙击调用；只在 LIVE_TRADE=1 时真的包装）
app.post('/api/snipe/float', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const { wbnbTopUp } = await import('./engine/live/sniper.js'); res.json(await wbnbTopUp(trader, Math.min(2, Math.max(0, Number(req.body?.target) || 0)), LIVE_TRADE)); } catch (e) { res.status(400).json({ error: e.message }); } });
const needSniper = (res) => { if (!sniper) { res.status(400).json({ error: '只有实盘主后端支持狙击' }); return false; } return true; };
app.get('/api/snipe', (req, res) => { if (!needSniper(res)) return; res.json({ ...sniper.view(), log: sniper.log.slice(0, 300) }); });
app.post('/api/snipe', (req, res) => {   // { params } 改参数；{ enabled: true/false } 开 / 关（急停 = enabled:false）
  if (!needSniper(res)) return; const b = req.body || {};
  try { if (b.params) sniper.update(b.params); if (b.forget) sniper.forget(b.forget); if (b.enabled !== undefined) sniper.setEnabled(b.enabled === true); res.json(sniper.view()); } catch (e) { res.status(400).json({ error: e.message }); }
});
const needTracker = (res) => { if (!tracker) { res.status(400).json({ error: '只有实盘主后端支持追踪 / 跟单' }); return false; } return true; };
app.get('/api/track', (req, res) => { if (!needTracker(res)) return; res.json({ ...tracker.targetsView(), feed: tracker.feed.slice(0, 300) }); });
app.get('/api/track/resolve', async (req, res) => {   // .ai / .bnb 域名 → 地址
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  const name = String(req.query.name || '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(name)) return res.json({ address: name, name: market.names?.peek?.(name) || null });
  if (!/^[a-z0-9-_.]+\.[a-z]+$/.test(name)) return res.status(400).json({ error: '请填 .ai / .bnb 域名或 0x 地址' });
  try { const { resolveDomain } = await import('./engine/live/baw.js'); const d = await resolveDomain(name); if (!d?.address) throw new Error('没有解析到地址'); res.json({ address: String(d.address).toLowerCase(), name }); }
  catch (e) { res.status(400).json({ error: `解析失败：${e.message}` }); }
});
app.get('/api/track/feed', (req, res) => { if (!needTracker(res)) return; res.json(tracker.feedPage({ before: Number(req.query.before) || undefined, limit: Math.min(300, Number(req.query.limit) || 100) })); });   // 追踪历史往回翻
app.post('/api/track/targets', (req, res) => {
  if (!needTracker(res)) return; const b = req.body || {};
  try { if (b.remove) tracker.removeTarget(b.address); else tracker.addTarget(b); res.json(tracker.targetsView()); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/copy', (req, res) => { if (!needTracker(res)) return; res.json({ ...tracker.tasksView(), log: tracker.log.slice(0, 300) }); });
app.post('/api/copy/tasks', (req, res) => {   // 新建：一律暂停 + 模拟；改参数 / 启动 / 暂停 / 关闭
  if (!needTracker(res)) return; const b = req.body || {};
  try { res.json(b.id && b.delete ? tracker.deleteTask(b.id) : b.id ? tracker.updateTask(b.id, b) : tracker.createTask(b)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/copy/pause-all', (req, res) => { if (!needTracker(res)) return; tracker.setAllPaused(req.body?.paused !== false); res.json(tracker.tasksView()); });
app.get('/api/wallet-info', (req, res) => res.json(LIVE ? selfInfo() : null));
// 登录遮罩下的网络检测（只读，返回里不带任何密钥 / 节点地址）：币安接口（baw 连的 WALLET_API_URL，默认 www.binance.com；配了代理就经代理）、
// BSC 节点池 eth_blockNumber、本机代理端口。每项 5 秒超时；超过 NETCHECK_SLOW_MS（默认 1500ms）算高延迟
const NET_SLOW_MS = Number(process.env.NETCHECK_SLOW_MS || 1500), NET_TO = 5000;
const proxyUrl = () => { const v = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy; try { return v ? new URL(v) : null; } catch { return null; } };
const netTimed = async (name, fn) => {
  const t0 = Date.now(); let tm;
  try { const detail = await Promise.race([fn(), new Promise((_, no) => { tm = setTimeout(() => no(new Error('超时（5 秒）')), NET_TO); })]); const ms = Date.now() - t0; return { name, state: ms > NET_SLOW_MS ? 'slow' : 'ok', ms, detail: detail ?? null }; }
  catch (e) { return { name, state: 'fail', ms: Date.now() - t0, reason: String(e.code || e.message || e).slice(0, 100) }; }
  finally { clearTimeout(tm); }
};
const tcpOpen = (host, port) => new Promise((ok, no) => { const s = tcpConnect({ host, port }, () => { s.destroy(); ok(); }); s.on('error', no); });
const tlsHead = (opts, host) => new Promise((ok, no) => {   // 发一个 HEAD 请求，收到状态行就算通（不管状态码）
  const t = tls.connect({ ...opts, servername: host }, () => t.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: tmtn-netcheck\r\n\r\n`));
  t.once('data', (d) => { const m = /^HTTP\/1\.[01] (\d{3})/.exec(d.toString('latin1')); t.destroy(); m ? ok(`HTTP ${m[1]}`) : no(new Error('响应格式不对')); });
  t.on('error', no); t.setTimeout(NET_TO, () => t.destroy(new Error('超时')));
});
const httpsHead = (u) => new Promise((ok, no) => {
  const url = new URL(u), host = url.hostname, port = Number(url.port || 443), px = proxyUrl();
  if (!px) return tlsHead({ host, port }, host).then(ok, no);
  const headers = px.username ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(px.username)}:${decodeURIComponent(px.password)}`).toString('base64') } : {};
  const r = http.request({ host: px.hostname, port: Number(px.port || 80), method: 'CONNECT', path: `${host}:${port}`, headers });
  r.on('connect', (res, sock) => { if (res.statusCode !== 200) { sock.destroy(); return no(new Error(`代理返回 ${res.statusCode}`)); } tlsHead({ socket: sock }, host).then(ok, no); });
  r.on('error', no); r.end();
});
async function netCheckOwn() {
  const px = proxyUrl(), api = process.env.WALLET_API_URL || 'https://www.binance.com', host = new URL(api).hostname;
  return Promise.all([
    netTimed(`币安接口 ${host}${px ? `（经代理 ${px.host}）` : ''}`, () => httpsHead(api)),
    netTimed('BSC 节点（eth_blockNumber）', async () => '#' + await market.provider.getBlockNumber()),
    ...(px ? [netTimed(`本机代理 ${px.host}`, () => tcpOpen(px.hostname, Number(px.port || 80)))] : []),
  ]);
}
app.get('/api/netcheck', async (req, res) => {
  if (req.query.own) return res.json(await netCheckOwn());
  res.json(await Promise.all([{ slot: WALLET_SLOT, label: WALLET_LABEL, self: true }, ...WALLET_PEERS.map((p) => ({ slot: p.slot, label: p.label || `钱包 ${p.slot}`, peer: p }))].map(async (w) => {
    if (w.self) return { slot: w.slot, label: w.label, items: await netCheckOwn() };
    const t0 = Date.now();
    try { return { slot: w.slot, label: w.label, items: await peerFetch(w.peer, '/api/netcheck?own=1', null, 12_000) }; }
    catch (e) { return { slot: w.slot, label: w.label, items: [{ name: '钱包后端', state: 'fail', ms: Date.now() - t0, reason: String(e.message).slice(0, 100) }] }; }
  })));
});
// 页面上按钱包点「登录」/「取消」：本钱包由自己的 baw 登录；其他钱包把请求转给它自己的后端（钱包 2 在 Docker 容器里用容器里的 baw 登录，绝不在本机为它发起）
app.post('/api/wallets/login', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘支持' });
  const slot = Number(req.body?.slot), cancel = !!req.body?.cancel;
  try {
    if (slot === WALLET_SLOT) return res.json(loginView(cancel ? trader.cancelLogin() : await trader.startLogin()));
    const p = WALLET_PEERS.find((x) => x.slot === slot); if (!p) return res.status(400).json({ error: '没有这个钱包' });
    res.json(await peerFetch(p, cancel ? '/api/auth/login-cancel' : '/api/auth/login', {}, 40_000));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/wallets', async (req, res) => res.json(LIVE ? await walletsView() : []));
app.post('/api/wallets', (req, res) => {   // 某个钱包是否「参与下单」（存在主后端的设置里）
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  const slot = Number(req.body?.slot); if (!slot) return res.status(400).json({ error: '缺少 slot' });
  trader.settings.walletOn = { ...(trader.settings.walletOn || {}), [slot]: req.body.on !== false }; trader.saveSetting('walletOn', trader.settings.walletOn);
  walletsView().then((v) => { broadcast({ type: 'wallets', data: v }); res.json(v); });
});
if (LIVE && WALLET_PEERS.length) setInterval(() => walletsView().then((v) => broadcast({ type: 'wallets', data: v })).catch(() => {}), 10_000);
// 普通盘总开关（默认关，关着不拉任何普通盘数据）：页面「显示普通盘」任意一列打开时 POST { on: true }，全部关掉时 { on: false }
app.get('/api/plain-pools', (req, res) => res.json(LIVE ? { on: !!market.plain?.on, plats: market.plain?.onP } : { on: false }));
app.post('/api/plain-pools', (req, res) => { if (!LIVE) return res.json({ on: false }); const b = req.body || {}; res.json(market.setPlainOn(b.on === true, true, b.plats && typeof b.plats === 'object' ? b.plats : null)); });   // plats = { four, flap, genius }：按平台开
app.get('/api/lookup/:a', async (req, res) => {
  // 搜索：最多等 1.5 秒（链上查 Four 盘）；查不到 = 不是本终端跟踪的内盘（外盘 / 已毕业 / 其他平台），页面改为打开 GMGN
  const t = LIVE ? await Promise.race([market.lookup(req.params.a).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]) : (market.get(req.params.a) ? market.summary(market.get(req.params.a)) : null);
  t ? res.json(t) : res.status(404).json({ error: '未找到该代币', external: true });
});
app.get('/api/token/:a', async (req, res) => {
  // 直接打开网址里的合约（重启后不在列表里的老盘 / 已迁移盘）：先按搜索的办法上链查一次收进来，最多等 5 秒（Gangstar 0x6b2c…e694 2026-10-29 页面一片空白）
  if (LIVE && !market.get(req.params.a) && /^0x[0-9a-fA-F]{40}$/.test(req.params.a)) await Promise.race([market.lookup(req.params.a).catch(() => null), new Promise((r) => setTimeout(r, 5000))]);
  if (LIVE) await market.refresh(req.params.a);
  const d = market.detail(req.params.a); if (!d) return res.status(404).json({ error: '代币不存在' });
  if (LIVE && d.nftGate) d.nftGate = { ...d.nftGate, wallets: await nftHolders(d.nftGate.nft).catch(() => []) };
  res.json(d);
});
// 地址 → 域名本地映射（前端定时拉取，ver 不变就返回空）
// 代币头像代理缓存：/api/img?u=<url> → data/img/<sha1>.<ext>，命中直接读盘，浏览器端 immutable 长缓存
const IMG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const imgInflight = new Map(), imgFail = new Map(), imgFailN = new Map();
const IPFS_GW = ['https://flap.mypinata.cloud/ipfs/', 'https://ipfs.filebase.io/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://cloudflare-ipfs.com/ipfs/'];
// 只代理白名单里的图床（engine/live/meta.js 的 MEDIA_HOSTS，和元数据共用一份；.env IMG_HOSTS 可追加），只走 https；别的地址一律拒绝（防止被当成访问内网 / 任意网站的跳板）
// unavatar.io 只放行 /x/<推特号>?fallback=false 这一种地址（GMGN 喊单头像，见 engine/live/callouts.js）
const unavatarOk = (u) => /^https:\/\/unavatar\.io\/x\/[A-Za-z0-9_]{1,15}\?fallback=false$/.test(u);
// pbs.twimg.com 只放行推特头像 profile_images/<数字>/<名>_200x200.<ext>（GMGN 喊单头像，经 api.fxtwitter.com 查到）
const twimgOk = (u) => /^https:\/\/pbs\.twimg\.com\/profile_images\/\d+\/[\w-]+_200x200\.(jpe?g|png|webp)$/i.test(u);
const imgHostOk = (u) => unavatarOk(u) || twimgOk(u) || mediaHostOk(u);
// unavatar 查到没设头像的号会给推特默认灰色人像（不是 404），按文件 sha1 认出来当作没有，页面显示自己的占位头像
const DEFAULT_AVATAR_SHA1 = new Set(['c89753dd9d4eaca510eedac17cd0e485b8cca17f']);
let unavatarUntil = 0;   // unavatar 免费版每个 IP 每天 25 次；429 以后按 retry-after 整体暂停，不再一张张去撞
// 只收位图：按文件头判断真实格式（不信对方的 Content-Type），SVG（可以带脚本）一律不收
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
const sniffImg = (b) => {
  const s = (i, j) => b.subarray(i, j).toString('latin1');
  if (b[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s(0, 4) === 'GIF8') return 'image/gif';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (s(4, 8) === 'ftyp' && /^avi[fs]$/.test(s(8, 12))) return 'image/avif';
  return null;
};
async function imgFetchOne(u) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000);
  try {
    let r;
    for (let hop = 0; ; hop++) {   // 跳转自己跟，每一跳都要在白名单里
      if (!imgHostOk(u)) throw new Error('host not allowed');
      if (unavatarOk(u) && Date.now() < unavatarUntil) throw new Error('unavatar rate limited');
      r = await fetch(u, { signal: ac.signal, redirect: 'manual', headers: { accept: 'image/*' } });
      if (r.status === 429 && unavatarOk(u)) unavatarUntil = Date.now() + Math.min(Number(r.headers.get('retry-after')) || 3600, 86400) * 1000;
      if (r.status < 300 || r.status >= 400) break;
      if (hop >= 3 || !r.headers.get('location')) throw new Error('redirect');
      u = new URL(r.headers.get('location'), u).href;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    if (Number(r.headers.get('content-length') || 0) > 2e6) throw new Error('too big');
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 2e6 || !buf.length) throw new Error('size');
    const ct = sniffImg(buf); if (!ct) throw new Error('not raster image');
    if (DEFAULT_AVATAR_SHA1.has(crypto.createHash('sha1').update(buf).digest('hex'))) throw new Error('http 404');   // 默认头像 = 没有（按 404 记失败）
    if (ct === 'image/avif' && /(^|\.)alphapulsehq\.top$/i.test(new URL(u).hostname)) throw new Error('format not allowed');   // 第三方转存图床只收 PNG / JPEG / WebP / GIF
    return { ct, buf };
  } finally { clearTimeout(tm); }
}
async function imgFetch(u) {
  const m = u.match(/\/ipfs\/(.+)$/); const urls = [u, ...(m ? IPFS_GW.map((g) => g + m[1]).filter((x) => x !== u) : [])];
  let err; for (const x of urls) { try { return await imgFetchOne(x); } catch (e) { err = e; } } throw err;
}
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (u.length > 2000 || !imgHostOk(u)) return res.status(403).set('Cache-Control', 'no-store').end();   // 不缓存：白名单改了（比如重新放行某个图床）以后页面马上能拿到
  const key = crypto.createHash('sha1').update(u).digest('hex'); const meta = path.join(IMG_DIR, key + '.json');
  // nosniff + 沙箱 CSP：就算文件内容有问题，浏览器也不会把它当网页 / 脚本执行
  const send = (m) => { res.set({ 'Content-Type': m.ct, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Img-Cache': m.hit ? 'HIT' : 'MISS', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename="${m.file}"` }); res.sendFile(path.join(IMG_DIR, m.file)); };
  try { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); if (EXT[m.ct] && /^[0-9a-f]{40}\.[a-z]+$/.test(m.file) && fs.existsSync(path.join(IMG_DIR, m.file))) return send({ ...m, hit: true }); } catch { /* 未缓存 */ }   // 旧缓存里的 SVG 等非位图不再返回
  if ((imgFail.get(key) || 0) > Date.now()) return res.status(404).set('Cache-Control', 'no-store').end();
  try {
    send(await imgWarm(u, key));
  } catch { res.status(404).set('Cache-Control', 'no-store').end(); }   // 失败不让浏览器缓存（以前 404 带 max-age=600，浏览器 10 分钟内都不再要这张图）
});
// 下载并缓存一张图（同一张同时只下一次）。元数据一读到图片地址就先在服务端下好（market 'image' 事件），页面第一次要时直接命中缓存；
// 失败记 60 秒（以前 10 分钟：刚发币时网关慢 / 429 一次，图标就十分钟不出来）
function imgWarm(u, key = crypto.createHash('sha1').update(u).digest('hex')) {
  const meta = path.join(IMG_DIR, key + '.json');
  try { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); if (EXT[m.ct] && /^[0-9a-f]{40}\.[a-z]+$/.test(m.file) && fs.existsSync(path.join(IMG_DIR, m.file))) return Promise.resolve({ ...m, hit: true }); } catch { /* 未缓存 */ }
  if ((imgFail.get(key) || 0) > Date.now()) return Promise.reject(new Error('recently failed'));
  {
    let p = imgInflight.get(key);
    if (!p) { p = imgFetch(u).then(({ ct, buf }) => { const file = key + '.' + (EXT[ct] || 'img'); fs.writeFileSync(path.join(IMG_DIR, file), buf); const m = { ct, file, url: u }; fs.writeFileSync(meta, JSON.stringify(m)); return m; }).finally(() => imgInflight.delete(key)); imgInflight.set(key, p); }
    return p.catch((e) => { const n = (imgFailN.get(key) || 0) + 1; imgFailN.set(key, n); if (imgFailN.size > 5000) imgFailN.clear(); imgFail.set(key, Date.now() + (unavatarOk(u) ? (e?.message === 'http 404' ? 6 * 3600_000 : 600_000) : n <= 40 ? 3000 : 60_000));   /* unavatar 免费额度有限：查不到的推特号 6 小时内不再问，其它失败（限流 / 超时）10 分钟 */   /* 失败只记 3 秒（页面 3 秒重试时真的会重新下载），连续 40 次以后 60 秒 */ if (imgFail.size > 5000) for (const [k, until] of imgFail) if (until < Date.now()) imgFail.delete(k);   /* 失败记录以前只增不减 */ throw e; });
  }
}
app.get('/api/names', (req, res) => {
  const n = market.names; if (!n) return res.json({ ver: 0, names: {} });
  if (Number(req.query.ver) === n.ver) return res.json({ ver: n.ver });
  res.json({ ver: n.ver, names: n.all() });
});

// 地址备注（不用追踪也能备注；追踪列表里的备注名优先）：data/remarks.json { 地址小写: 备注 }
const REMARKS_FILE = dataFile('remarks.json');
let remarks = {}; try { remarks = JSON.parse(fs.readFileSync(REMARKS_FILE, 'utf8')) || {}; } catch { /* 第一次没有文件 */ }
app.get('/api/remarks', (req, res) => res.json(remarks));
app.post('/api/remarks', (req, res) => {
  const a = String(req.body?.address || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return res.status(400).json({ error: '地址格式不对' });
  const v = String(req.body?.remark ?? '').trim().slice(0, 40); if (v) remarks[a] = v; else delete remarks[a];
  try { fs.writeFileSync(REMARKS_FILE, JSON.stringify(remarks, null, 1)); } catch (e) { return res.status(500).json({ error: `保存失败：${e.message}` }); }
  res.json(remarks);
});
// 地址 → .ai / .bnb 域名（反查，现查不排队）；模拟盘没有实盘行情的域名缓存，就临时建一个
let lookupNames = null;
app.get('/api/names/lookup', async (req, res) => {
  const a = String(req.query.address || '').trim().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return res.status(400).json({ error: '请填 0x 地址' });
  try { const nc = market.names || (lookupNames ||= new (await import('./engine/live/names.js')).NameCache()); res.json({ address: a, ...(await nc.lookupBoth(a)) }); }
  catch (e) { res.status(502).json({ error: `查询失败：${e.message}` }); }
});

app.get('/api/preview', async (req, res) => {
  const q = req.query;
  res.json(await trader.preview({ walletId: q.wallet, token: q.token, side: q.side, amount: Number(q.amount), slippage: Number(q.slippage || 35) }));
});

// 按代币总量百分比买入：反推需要多少 BNB（多轮报价逼近）
// 买「总量的 X%」需要多少 BNB（按这个钱包自己的持仓上限 / 余额 / 单笔上限压好）。多钱包时每个钱包各自算
async function costForPct(q) {
  q = q || {}; let pct = Math.min(100, Number(q.pct) || 0);
  if (!(pct > 0)) return ({ bnb: 0 });
  // Four Agent 专属币每个钱包最多持有总量 1%，超过的部分买不到，按 1% 算，避免反推出离谱的 BNB
  const tk = market.get?.(q.token); let capped = false; const asked = pct; const notes = [];
  if (LIVE && tk && trader.fairMinting?.(tk)) {   // 打新认购：份数 × 单价（含认购费）
    if (!tk.gangFair) await market.gangFairState?.(tk).catch(() => {});
    if (tk.gangFair && !tk.gangFair.launched) { const f = fairPctBnb(tk.gangFair, pct); return { bnb: f.bnb, pct, capped: f.shares < Math.round(pct * 100), note: `打新认购 ${f.shares} 份（每地址上限 ${tk.gangFair.capShares} 份）` }; }
  }
  // Four / Gang 都是单钱包最多持有总量 1%
  if ((tk?.platform === 'four' || tk?.platform === 'gang') && pct > 1) { pct = 1; capped = true; }
  let target = 1_000_000_000 * pct / 100;
  // Four 单钱包最多 1%：扣掉当前持仓，只买剩下的部分
  if (tk?.platform === 'four') {
    try {
      const w = trader.wallet?.(q.wallet); const mine = w ? await trader.tokenBal(w, tk.address) : 0;
      const room = (1e7 - (mine || 0)) * 0.99;
      if (room <= 1e7 * 0.001) return ({ bnb: 0, capReached: true, error: '已达单钱包上限 1%' });
      if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
    } catch { /* 读不到持仓就按 1% */ }
  }
  // Gang 老盘：合约 walletRoom 直接给出这个钱包还能买多少
  if (tk?.source === 'gang' && (trader.useGang?.(tk) || trader.useGangV2?.(tk))) {
    try {
      const w = trader.wallet?.(q.wallet);
      const room = !w ? 1e7 : (trader.useGangV2(tk) ? Number(await trader.gangV2.room(tk.address, w.address)) / 1e18 : await trader.gangTrade.walletRoom(tk.address, w.address)) * 0.99;
      if (room <= 1e7 * 0.001) return ({ bnb: 0, capReached: true, error: '已达单钱包上限 1%' });
      if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
    } catch { /* 读不到额度就按 1% */ }
  }
  // Flap Agent 曲线有单钱包持仓上限 maxSharesPerWallet：目标不超过「上限 - 已持有」再留 1% 余量
  if (tk?.market && tk.source === 'agent-curve' && trader.portal?.provider) {
    try {
      const { ethers } = await import('ethers');
      const w = trader.wallet?.(q.wallet);
      const c = new ethers.Contract(tk.market, ['function maxSharesPerWallet() view returns (uint256)', 'function sharesOf(address) view returns (uint256)'], trader.portal.provider);
      const [cap, mine] = await Promise.all([c.maxSharesPerWallet().catch(() => 0n), w ? c.sharesOf(w.address).catch(() => 0n) : 0n]);
      if (cap > 0n) {
        const room = Number(ethers.formatEther(cap - (mine > cap ? cap : mine))) * 0.99;
        if (room <= 0) return ({ bnb: 0, capReached: true, error: '已达单钱包持仓上限' });
        if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
      }
    } catch { /* 读不到上限就按原目标 */ }
  }
  try {
    let a = 0.01, ok = false, lastErr = null;
    for (let i = 0; i < 6; i++) {
      const p = await trader.preview({ walletId: q.wallet, token: q.token, side: 'buy', amount: a, slippage: Number(q.slippage || 35) });
      if (!(p?.out > 0)) { lastErr = p?.error || null; break; }
      ok = true;
      const next = a * target / p.out;
      if (Math.abs(next - a) / a < 0.002) { a = next; break; }
      a = next;
    }
    if (!ok) return ({ bnb: 0, error: `拿不到报价${lastErr ? '：' + lastErr : ''}` });
    // 下单前一次性把金额压到能成交的范围：持仓上限 → 单笔上限 → 余额（留 0.002 BNB 付 gas），不让后端先失败再重试
    if (capped) notes.push(asked > 1 && pct >= 0.98 ? `${asked}% 超过单钱包上限 1%，已按 1% 买入` : `${asked}% 超过单钱包剩余额度，已按剩余额度（约 ${pct}%）买入`);
    const maxTrade = LIVE ? Number(trader.status?.maxTradeBnb) || 0 : 0;
    if (maxTrade > 0 && a > maxTrade) { a = maxTrade; notes.push(`超过单笔上限 ${maxTrade} BNB，已按 ${maxTrade} BNB 买入`); }
    const w = trader.wallet?.(q.wallet); const bal = Number(w?.bnb) || 0;
    if (LIVE && bal > 0 && a > bal - 0.002) { a = Math.max(0, bal - 0.002); notes.push(`BNB 余额不足，已按余额 ${a.toFixed(4)} BNB 买入`); }
    if (!(a > 0)) return ({ bnb: 0, error: 'BNB 余额不足' });
    return ({ bnb: +a.toFixed(6), tokens: target, pct, capped, note: notes.join('；') || null });
  } catch (e) { return { bnb: 0, error: e.message }; }
}
app.get('/api/cost-for-pct', async (req, res) => res.json(await costForPct(req.query)));

// 下单（页面、跟单都走这里）。slots：指定哪几个钱包下单（跟单任务用）；不填 = 所有开了「参与下单」的钱包
// Gang V2 / V3 内盘每个钱包最多买 1%：「买 ≥1%」不先报价，直接给这么多 BNB，下单时按剩余额度只换需要的报价币、额度满了不发交易（省掉下单前约 1 秒的报价）
const PCT_FAST_BNB = Number(process.env.PCT_FAST_BNB ?? 0.1);
// Flap Agent ID 门槛盘每个地址最多买 2%：swapExactInput 到上限只成交到上限、多余 BNB 同笔退回（报价也按剩余额度给），「买 ≥2%」直接给这么多 BNB（默认 0.3）
const PCT_FAST_FLAP_BNB = Number(process.env.PCT_FAST_FLAP_BNB ?? 0.3), PCT_FAST_FLAP_LOW = Number(process.env.PCT_FAST_FLAP_LOW ?? 0.2);
// 余额（后台缓存，不另查）不够 0.3 + gas 就用 0.2；也不超过交易设置里的单笔上限
const flapFastBnb = (w) => { const bal = Number(trader.wallet?.(w)?.bnb), cap = Number(trader.status?.maxTradeBnb) || 0; let a = Number.isFinite(bal) && bal > 0 && bal < PCT_FAST_FLAP_BNB + 0.005 ? PCT_FAST_FLAP_LOW : PCT_FAST_FLAP_BNB; if (cap > 0 && a > cap) a = cap; return a; };
// 市值超过 PCT_FAST_MCAP_USD（默认 $7k）时固定金额买不满：按 市值 × N% ÷ BNB 价 × 1.3 估算要花的 BNB（只看已缓存的市值，不另报价），和固定金额取大的那个，再压到单笔上限和余额（留 gas）。给多了不亏：Gang 按剩余额度只换需要的报价币，Flap 门槛盘多余 BNB 同笔退回，成本按链上实际花的算（市值超过 7k 不要按 0.1）
const PCT_FAST_MCAP_USD = Number(process.env.PCT_FAST_MCAP_USD ?? 7000);
const fastByMcap = (w, tk, pct, cap, fixed) => {
  const m = Number(tk?.mcapUsd), u = Number(market.bnbUsd);
  if (!(PCT_FAST_MCAP_USD > 0 && m > PCT_FAST_MCAP_USD && u > 0)) return fixed;
  let a = Math.max(fixed, m * Math.min(Number(pct), cap) / 100 / u * 1.3);
  const mx = Number(trader.status?.maxTradeBnb) || 0, bal = Number(trader.wallet?.(w)?.bnb);
  if (mx > 0 && a > mx) a = mx;
  if (Number.isFinite(bal) && bal > 0 && a > bal - 0.005) a = bal - 0.005;
  return a > 0 ? +a.toFixed(4) : fixed;
};
// 主后端把 Gang 盘的基本信息一起转给其他钱包：对方还没收录这个币时直接用，不用先去链上查
const gangHint = (t) => (t && t.source === 'gang' && ['v2', 'v3'].includes(t.gangTrack) ? { address: t.address, name: t.name, symbol: t.symbol, creator: t.creator, createdAt: Math.floor((t.createdAt || Date.now()) / 1000), graduated: t.stage === 'dex', quoteSymbol: t.quote, quoteAddress: t.quoteAddress, track: t.gangTrack, taxed: !!t.gangDiv?.taxed } : null);
function useHint(token, h) {
  if (!LIVE || !h || market.get(token) || !market.upsertGang || String(h.address || '').toLowerCase() !== String(token).toLowerCase() || !['v2', 'v3'].includes(h.track) || !/^0x[0-9a-fA-F]{40}$/.test(String(h.quoteAddress || ''))) return;
  const s = (v, n = 64) => String(v ?? '').slice(0, n);
  try { market.upsertGang({ address: s(h.address).toLowerCase(), name: s(h.name), symbol: s(h.symbol, 32), creator: s(h.creator, 42).toLowerCase(), createdAt: Number(h.createdAt) || Math.floor(Date.now() / 1000), graduated: !!h.graduated, raisedQuote: 0, progressPct: 0, quoteSymbol: s(h.quoteSymbol, 16), quoteAddress: s(h.quoteAddress, 42).toLowerCase(), track: h.track, taxed: !!h.taxed }, false); } catch { /* 用不上就照旧去链上查 */ }
}
async function placeOrder({ wallets = ['baw'], token, side, amount, slippage, via, clientTs, pctSupply, slots = null, source = '手动', symbol = null, tokenHint = null }) {
  {
    if (LIVE && token && !market.get(token)) useHint(token, tokenHint);
    if (LIVE && token && !market.get(token)) await market.lookup(token).catch(() => null);   // 本后端还没收录这个币（多钱包时第二个后端可能会这样）
    if (LIVE && token && /-plain$/.test(market.get(token)?.source || '')) await market.lookup(token).catch(() => null);   // 战壕里的普通盘：Flap 升级成可交易的 Portal 普通盘，Four 查是不是 OpenFour
    if (LIVE && token && market.get(token)?.viewOnly) throw new Error('这个普通盘只能看行情，本终端暂不支持下单（普通 Four 内盘 / genius 内盘）');
    const local = () => Promise.all(wallets.map(async (w) => {
      let amt = amount;
      const tk = market.get(token);
      if (side === 'buy' && Number(pctSupply) > 0 && LIVE && tk && trader.fairMinting?.(tk)) {   // 打新认购：N% = N% × 10000 份（夹到每地址上限），不另报价
        if (!tk.gangFair) await market.gangFairState?.(tk).catch(() => {});
        if (tk.gangFair && !tk.gangFair.launched) amt = fairPctBnb(tk.gangFair, pctSupply).bnb;
      } else if (side === 'buy' && Number(pctSupply) >= 1 && PCT_FAST_BNB > 0 && LIVE && tk && trader.useGangV2?.(tk)) amt = fastByMcap(w, tk, pctSupply, 1, PCT_FAST_BNB);
      else if (side === 'buy' && Number(pctSupply) >= 2 && PCT_FAST_FLAP_BNB > 0 && LIVE && tk && trader.useFlapNft?.(tk)) amt = fastByMcap(w, tk, pctSupply, 2, flapFastBnb(w));
      else if (side === 'buy' && Number(pctSupply) > 0) {   // 每个钱包自己报价：买到总量的 X% 要多少 BNB
        const c = await costForPct({ wallet: w, token, pct: Number(pctSupply), slippage });
        if (!(c.bnb > 0)) { const o = { id: `pct-${Date.now()}`, ts: Date.now(), wallet: WALLET_LABEL, token, symbol: market.get(token)?.symbol || '', side, amount: 0, status: 'failed', reason: c.capReached ? c.error : `买 ${pctSupply}% 报价失败：${c.error || '拿不到报价'}` }; broadcast({ type: 'order', data: o }); return o; }
        amt = c.bnb;
      }
      return trader.execute({ walletId: w, token, side, amount: amt, slippage, source: String(source || '手动').slice(0, 40), via: via === 'quick' ? 'quick' : null, clientTs: Number(clientTs) || null, symbol: symbol ? String(symbol).slice(0, 32) : null });
    }));
    if (!LIVE || !WALLET_PEERS.length) { if (slots && !slots.includes(WALLET_SLOT)) return []; return await local(); }
    // 多钱包：所有「参与下单」的钱包同时执行（买入 = 每个钱包各买 amount BNB；卖出 = 每个钱包卖自己持仓的 amount%）。未登录 / 连不上的跳过，其他照常
    const t = market.get(token), sym = (t?.symbol && t.symbol !== '?' ? t.symbol : symbol) || '';
    const skip = (slot, label, reason) => { const o = { id: `w${slot}-skip-${Date.now()}`, ts: Date.now(), wallet: label, walletSlot: slot, token, symbol: sym, side, amount, status: 'failed', reason: `${label}：${reason}，已跳过` }; broadcast({ type: 'order', data: o }); return [o]; };
    const jobs = [];
    const want = (slot) => (slots ? slots.includes(slot) : walletOn(slot));
    if (want(WALLET_SLOT)) jobs.push(trader.status?.auth?.state === 'ok' ? local().then((r) => r.map((o) => ({ ...o, walletSlot: WALLET_SLOT }))) : Promise.resolve(skip(WALLET_SLOT, WALLET_LABEL, '币安钱包未登录')));
    for (const p of WALLET_PEERS) {
      if (!want(p.slot)) continue; const label = p.label || `钱包 ${p.slot}`;
      jobs.push(peerFetch(p, '/api/order', { wallets: ['baw'], token, side, amount, slippage, via, clientTs, pctSupply, source, symbol: sym || null, tokenHint: gangHint(t) }, 200_000)
        .then((r) => (r || []).map((o) => { const x = { ...o, id: `w${p.slot}-${o.id}`, wallet: label, walletSlot: p.slot }; broadcast({ type: 'order', data: x }); return x; }))
        .catch((e) => skip(p.slot, label, e.status === 401 ? '币安钱包未登录' : `后端连不上（${e.message}）`)));
    }
    if (!jobs.length) throw new Error(slots ? '跟单任务选的钱包都不可用' : '没有开启「参与下单」的钱包');
    return (await Promise.all(jobs)).flat();
  }
}
app.post('/api/order', async (req, res) => {
  const b = req.body || {};
  try { res.json(await placeOrder({ wallets: b.wallets?.length ? b.wallets : ['big'], token: b.token, side: b.side, amount: b.amount, slippage: b.slippage, via: b.via, clientTs: b.clientTs, pctSupply: b.pctSupply, tokenHint: b.tokenHint && typeof b.tokenHint === 'object' ? b.tokenHint : null, slots: Array.isArray(b.slots) && b.slots.length ? b.slots.map(Number) : null, source: b.source || '手动', symbol: b.symbol || null })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 单币规则（发射后立刻领取）
app.get('/api/token-rules', (req, res) => res.json(LIVE ? trader.rulesView() : {}));
// 页面只能改「是否领取」，以及取消规则
app.post('/api/token-rules', (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  try {
    if (req.body.remove) return res.json(trader.setRule(req.body.token, null));
    const p = req.body.patch || {}, patch = {};
    if (p.claim !== undefined) patch.claim = p.claim === true;
    res.json(trader.setRule(req.body.token, patch));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 迁移即清仓（engine/migSell.js）：只在主后端（钱包 1）或模拟盘跑；新建默认关闭，本人用 scripts/mig-sell.mjs 打开（没有页面）
let migSell = null;
if (!LIVE || WALLET_SLOT === 1) {
  const { MigSell } = await import('./engine/migSell.js');
  const slotsAll = LIVE ? [{ slot: WALLET_SLOT, label: WALLET_LABEL }, ...WALLET_PEERS.map((p) => ({ slot: p.slot, label: p.label || `钱包 ${p.slot}` }))] : [{ slot: WALLET_SLOT, label: '模拟钱包' }];
  migSell = new MigSell({ market, trader, placeOrder, dataFile, slotsAll, live: LIVE });
}
app.get('/api/mig-sell', (req, res) => res.json(migSell ? { rules: migSell.view(), wallets: migSell.slotsAll } : { rules: {}, wallets: [] }));
app.post('/api/mig-sell', (req, res) => {   // { token, patch: { armed, pct, slippage, slots, rearm } } | { token, remove: true } | { token, test: true }（模拟盘）
  if (!migSell) return res.status(400).json({ error: '只有主后端支持迁移清仓' });
  const b = req.body || {};
  try {
    if (b.remove) return res.json(migSell.set(b.token, null));
    if (b.test) return res.json(migSell.testFire(b.token));
    const p = b.patch || {}, patch = {};
    for (const k of ['armed', 'pct', 'slippage', 'slots', 'rearm']) if (p[k] !== undefined) patch[k] = p[k];
    res.json(migSell.set(b.token, patch));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/favorites', (req, res) => res.json(favorites.view()));
app.post('/api/favorites', (req, res) => { try { const v = favorites.op(req.body || {}); broadcast({ type: 'favorites', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/approvals', async (req, res) => { if (!LIVE) return res.json([]); try { res.json(await trader.allowancesView()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/approvals/revoke', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await trader.revokeApproval(String(req.body.token || ''), String(req.body.spender || ''))); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/token-info/:a', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await trader.tokenInfo(req.params.a)); } catch (e) { res.status(400).json({ error: e.shortMessage || e.message }); } });
app.post('/api/swap/quote', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const { from, to, amount, slippage } = req.body; res.json(await trader.swapQuote({ from, to, amount, slippage: Number(slippage) || 1 })); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/swap', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); const { from, to, amount, pct, slippage, clientTs } = req.body; res.json(await trader.swapManual({ from, to, amount, pct: pct != null ? Number(pct) : null, slippage: Number(slippage) || 1, clientTs: Number(clientTs) || null })); });
app.get('/api/blocklist', (req, res) => res.json(blocklist.view()));
app.post('/api/blocklist', (req, res) => { try { const v = blocklist.set(req.body.kind, req.body.address, !!req.body.on, req.body.label); broadcast({ type: 'blocklist', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/config', (req, res) => { agent.setConfig(req.body); if (LIVE && Number(req.body?.quickBuy) > 0) trader.saveSetting('quickBuy', Number(req.body.quickBuy)); res.json(agent.config); });
app.post('/api/settings', (req, res) => {
  const { maxTradeBnb, ...rest } = req.body;
  if (maxTradeBnb !== undefined) { if (!LIVE) return res.status(400).json({ error: '只有实盘模式有单笔上限' }); try { trader.setMaxTrade(maxTradeBnb); } catch (e) { return res.status(400).json({ error: e.message }); } }
  // 只接受已知的设置项，并且先校验再写入（以前先 Object.assign 再校验：格式错的预设会留在内存里直到重启，任意键也能写进 settings）
  if (rest.qbPresets !== undefined) { const q = rest.qbPresets; const ok = q && ['buy', 'sell'].every((k) => Array.isArray(q[k]) && q[k].length === 3 && q[k].every((a) => Array.isArray(a) && a.length === 8 && a.every((v) => Number(v) > 0 && Number(v) <= (k === 'sell' ? 100 : 1000))));
    if (!ok) return res.status(400).json({ error: '预设格式不对' }); }
  if (rest.gas !== undefined) { if (!GAS_PRESETS[rest.gas]) return res.status(400).json({ error: 'gas 档位不对' }); trader.settings.gas = rest.gas; }
  if (rest.execPath !== undefined) trader.settings.execPath = rest.execPath === 'ai' ? 'ai' : 'direct';
  if (rest.multiRpc !== undefined) trader.settings.multiRpc = rest.multiRpc === true;
  if (rest.autoClaim !== undefined) trader.settings.autoClaim = !!rest.autoClaim;
  if (rest.qbPresets !== undefined) { trader.settings.qbPresets = rest.qbPresets; if (LIVE) trader.saveSetting('qbPresets', rest.qbPresets); }
  if (rest.sellToBnb !== undefined) { trader.settings.sellToBnb = rest.sellToBnb !== false; if (LIVE) trader.saveSetting('sellToBnb', trader.settings.sellToBnb); }
  if (rest.preApproveCap !== undefined) { trader.settings.preApproveCap = rest.preApproveCap !== false; if (LIVE) trader.saveSetting('preApproveCap', trader.settings.preApproveCap); }
  // 「预先授权」「卖出后自动换回 BNB」对所有钱包生效：同步给 WALLET_PEERS 里的其他钱包后端（以前只改了主后端，钱包 2 还是旧设置，卖出前要当场授权）
  const sync = Object.fromEntries(['preApproveCap', 'sellToBnb'].filter((k) => rest[k] !== undefined).map((k) => [k, rest[k] !== false]));
  if (Object.keys(sync).length) for (const p of WALLET_PEERS) peerFetch(p, '/api/settings', sync).catch((e) => console.warn(`[settings] 同步到钱包 ${p.slot} 失败：${e.message}`));
  if (LIVE && rest.autoClaim !== undefined) { trader.saveSetting('autoClaim', !!rest.autoClaim); if (rest.autoClaim) trader.scanClaims(); } broadcast({ type: 'settings', data: trader.settings }); res.json(trader.settings); });
app.post('/api/wallet/:id', (req, res) => {
  if (LIVE) return res.status(400).json({ error: '实盘行情模式不能修改钱包' });
  const w = trader.wallet(req.params.id);
  const { whitelisted, agentId, faucet } = req.body;
  if (whitelisted != null) w.whitelisted = !!whitelisted;
  if (agentId != null) w.agentId = !!agentId;
  if (faucet) w.bnb += Number(faucet);
  res.json(trader.walletsView());
});
app.post('/api/launch', (req, res) => LIVE ? res.status(400).json({ error: '实盘行情模式不能模拟发射' }) : res.json(market.summary(market.launch(req.body || {}))));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => { const e = guard(req, true); if (e) console.warn(`[security] WebSocket：${e}`); return !e; } });   // WebSocket 同样要同源 / 令牌
// 序列化失败只跳过这一帧，不让整个服务崩溃
let badFrameLogged = false;
const broadcast = (msg) => {
  let s;
  try { s = JSON.stringify(msg); } catch (e) { if (!badFrameLogged) { badFrameLogged = true; console.error(`推送 ${msg?.type} 序列化失败，已跳过：${e.message}`); } return; }
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.stack || e));

wss.on('connection', (ws) => {
  ws.sub = null;
  try { ws.send(JSON.stringify({ type: 'tokens', data: market.list() })); } catch { /* 下一次全量兜底 */ }
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'sub') {
        ws.sub = m.token;
        const send = () => { const d = market.detail(m.token); if (d && ws.sub === m.token) ws.send(JSON.stringify({ type: 'detail', full: true, data: d })); };
        send();
        if (LIVE) market.refresh(m.token).then(send);
      }
    } catch { /* ignore */ }
  });
});

market.on('launch', (s) => broadcast({ type: 'launch', data: s }));
routeEvents.on('alert', (a) => broadcast({ type: 'routeAlert', data: a }));   // 路由自检报警：页面顶部红条
// 实盘行情：选中的代币每 3 秒刷新一次详情
if (LIVE) setInterval(() => new Set([...wss.clients].map((c) => c.sub).filter(Boolean)).forEach((a) => market.refresh(a)), 3000);
market.on('image', (u) => { if (u.length <= 2000 && imgHostOk(u)) imgWarm(u).catch(() => {}); });
market.on('detail', (a) => { for (const c of wss.clients) if (c.readyState === 1 && c.sub === a) c.send(JSON.stringify({ type: 'detail', full: true, data: market.detail(a) })); });
// 订单结束（成交或失败）后马上重读链上余额，3 / 5 / 20 秒后再读一次，等区块和 baw 索引跟上
const resync = async () => { trader.syncAt = 0; if (holdings) holdings.histAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); };
trader.on('order', (o) => { broadcast({ type: 'order', data: o }); if (LIVE && ['filled', 'failed', 'unknown'].includes(o.status)) { for (const ms of [3000, 5000, 20000]) setTimeout(() => resync(), ms); for (const ms of [1500, 6000, 15000]) setTimeout(refreshHoldSnap, ms); } });
trader.on('rules', (r) => broadcast({ type: 'rules', data: r }));
trader.on('settings', (st) => broadcast({ type: 'settings', data: st }));
market.on('migrate', (s) => { if (LIVE && s?.platform === 'four') { trader.syncAt = 0; trader.refreshBalance?.(); } });
agent.on('log', (l) => broadcast({ type: 'log', data: l }));
agent.on('record', (r) => broadcast({ type: 'record', data: r }));
agent.on('config', (c) => broadcast({ type: 'config', data: c }));

// 行情列表只推有变化的币：原来每 500ms 推全量（1000 个币约 1.5MB，每个标签页约 3MB/s），浏览器会卡到「页面无响应」
// 新连接先收一次全量（type 'tokens'），之后 tick 只带 tokDelta（变了 / 新增的币）和 tokGone（已移除的地址）；每 30 秒带一次全量兜底
const tokSent = new Map(); let tokFullAt = Date.now();
function tokFrame() {
  const list = market.list(), seen = new Set(), tokDelta = [], tokGone = [];
  for (const t of list) { seen.add(t.address); let s; try { s = JSON.stringify(t); } catch { continue; } if (tokSent.get(t.address) !== s) { tokSent.set(t.address, s); tokDelta.push(t); } }
  for (const a of tokSent.keys()) if (!seen.has(a)) { tokSent.delete(a); tokGone.push(a); }
  if (Date.now() - tokFullAt > 30_000) { tokFullAt = Date.now(); return { tokens: list }; }
  return { tokDelta, tokGone };
}
setInterval(() => {
  broadcast({ type: 'tick', data: { ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, gangMcap: market.gangMcap || 0, net, wallets: trader.walletsView(), usage: agent.usageView(), ...tokFrame(), positions: trader.positionsView(), claimable: LIVE ? trader.claimable : [] } });
  for (const c of wss.clients) {
    if (c.readyState !== 1 || !c.sub) continue;
    const d = market.detail(c.sub);
    if (d) c.send(JSON.stringify({ type: 'detail', full: false, data: { ...d, candles: d.candles.slice(-5) } }));
  }
}, 500);

// 默认只监听本机。HOST 只给 Docker 容器用（容器里要监听 0.0.0.0，端口再只映射到宿主机的 127.0.0.1）
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`\n  TMTN（${!LIVE ? '模拟盘' : LIVE_TRADE ? `实盘 · 手动订单真实下单 · 单笔上限 ${trader.status.maxTradeBnb || '不限'} BNB` : '实盘行情 · 只报价不下单'}）`);
  if (LIVE) console.log(`  baw：${trader.status.connected ? `已连接 ${trader.wallets[0].address}` : `未连接（${trader.status.error}）`}`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
});
