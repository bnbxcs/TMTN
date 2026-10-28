// RPC：有 NODEREAL_RPC 就用它当主节点，出错或被限流时自动换公共节点（bsc-dataseed / publicnode），30 秒后再试主节点。
// 地址里含 key，显示到页面 / 日志时一律用 maskRpc() 隐藏
import { ethers } from 'ethers';

export const maskRpc = (u) => String(u || '').replace(/(nodereal\.io\/(?:ws\/)?v1\/)[A-Za-z0-9]+/ig, '$1***').replace(/(\.dwellir\.com\/)[A-Za-z0-9-]+/ig, '$1***').replace(/(\.chainstack\.com\/)[A-Za-z0-9]+/ig, '$1***').replace(/([?&](api[-_]?key|key|token)=)[^&\s"']+/ig, '$1***');
// 任意文本（日志、错误信息、记录文件）里的 RPC key 一律打码：NodeReal 地址 + .env 里 NODEREAL_KEYS 的 key 原文（用到时再读，.env 在 config.js 里才加载）
export const redactSecrets = (s) => { let t = maskRpc(s); for (const k of (process.env.NODEREAL_KEYS || '').split(',').map((x) => x.trim()).filter((x) => x.length >= 16)) t = t.split(k).join('***'); return t; };

// 页面上显示的节点名（不含 key）
// 多个 NodeReal key：页面上只显示「NodeReal #1 / #2」，不显示 key
const NR_SLOTS = [];
export const setNodeRealSlots = (urls) => { NR_SLOTS.length = 0; for (const u of urls) NR_SLOTS.push(String(u).replace(/^wss:/, 'https:').replace('/ws/v1/', '/v1/')); };
const nrName = (h) => { const i = NR_SLOTS.indexOf(String(h).replace(/^wss:/, 'https:').replace('/ws/v1/', '/v1/')); return NR_SLOTS.length > 1 && i >= 0 ? `NodeReal #${i + 1}` : 'NodeReal'; };
export const nodeName = (u) => { const h = String(u || ''); return /nodereal/i.test(h) ? nrName(h) : /publicnode/i.test(h) ? 'PublicNode' : /dataseed|bnbchain/i.test(h) ? 'BNB Chain' : /48\.club/i.test(h) ? '48 Club' : /dwellir/i.test(h) ? 'Dwellir' : /chainstack/i.test(h) ? 'Chainstack' : h ? (h.match(/\/\/([^/:]+)/)?.[1] || '自定义') : '—'; };

// 用量统计：每个节点、每个用途（label）、每个方法各请求了多少次（NodeReal 有额度，要盯着）
export const RPC_USAGE = new Map();
export const bumpUsage = (label, url, payload) => { const node = nodeName(url); for (const x of Array.isArray(payload) ? payload : [payload]) { const k = `${node}|${label}|${x?.method || '?'}`; RPC_USAGE.set(k, (RPC_USAGE.get(k) || 0) + 1); } };
// NodeReal（BSC）每个方法的 CU（docs.nodereal.io/docs/compute-units-cus）；WebSocket 推送按字节 0.04 CU；没列出的按 20 估
export const CU = { eth_blockNumber: 5, eth_chainId: 5, eth_call: 20, eth_getLogs: 50, eth_getBalance: 15, eth_getTransactionReceipt: 15, eth_getBlockByNumber: 15, eth_subscribe: 10, eth_estimateGas: 75, eth_gasPrice: 15, eth_getCode: 15, eth_getTransactionCount: 25, eth_sendRawTransaction: 150, logs: 0 };
export const cuOf = (method, n) => (method === 'ws_bytes' ? n * 0.04 : n * (CU[method] ?? 20));
// 按调用位置计数（每 5 次抽 1 次看调用栈，乘 5 估算）：查 eth_call / getLogs 主要是哪段代码在用。键 = 用途|方法|文件:行 函数 < 上一层文件:行 函数
// 记两层：最里面一层常常只是 GangV2.call / FlapNft.state 这种薄封装，看不出到底是谁在调
export const RPC_CALLERS = new Map();
let callerTick = 0;
const callerOf = () => {
  const lim = Error.stackTraceLimit; Error.stackTraceLimit = 40; const st = new Error().stack || ''; Error.stackTraceLimit = lim;
  const out = [];
  for (const l of st.split('\n').slice(1)) {
    if (/node_modules|node:|\/engine\/live\/rpc\.js/.test(l)) continue;
    const m = /at (?:async )?(?:(\S+) )?\(?(?:file:\/\/)?[^()]*\/((?:engine\/)?[\w/.-]+\.m?js):(\d+):\d+\)?$/.exec(l.trim());
    if (m && out.push(`${m[2]}:${m[3]}${m[1] ? ' ' + m[1] : ''}`) >= 2) break;
  }
  return out.join(' < ') || '?';
};
export function takeCallers() { const out = {}; for (const [k, n] of RPC_CALLERS) out[k] = n; RPC_CALLERS.clear(); return out; }
export function takeUsage() { const out = {}; for (const [k, n] of RPC_USAGE) out[k] = n; RPC_USAGE.clear(); return out; }
export const PUBLIC_RPC = 'https://bsc-rpc.publicnode.com', PUBLIC_WSS = 'wss://bsc-rpc.publicnode.com';
// .env 的 WSS_URL（可填多个，逗号分隔，如 Dwellir 的 wss 地址）：排在 NodeReal 之后、PublicNode 之前，NodeReal 冷却 / PublicNode 限流时订阅不至于断。用到时再读（.env 在 config.js 里加载）
const customWss = () => (process.env.WSS_URL || '').split(',').map((x) => x.trim()).filter((x) => /^wss?:\/\//.test(x));

// 订阅链上事件（WebSocket）：按顺序用 urls（一般是 NodeReal → publicnode）。断线 / 被拒（如 429）5 秒后换下一个；
// 用的不是第一个时，10 分钟后再试回第一个。status.connected 表示订阅正常
// NodeReal 月额度用完时 wss 握手直接 429：这个地址 30 分钟内不再试（所有订阅共用），不然每 10 分钟切回去都要断十几秒
const WS_COOL = new Map();
const wsCooling = (u) => (WS_COOL.get(u) || 0) > Date.now();
export class WsLogs {
  constructor({ label, urls, filters, onLog, status }) { Object.assign(this, { label, urls: urls.filter(Boolean).flatMap((u) => (u === PUBLIC_WSS ? [...customWss(), u] : [u])), filters, onLog, status }); this.ws = null; }
  start() { this.connect(0); return this; }
  get live() { return !!this.ws && !!this.status.connected; }
  connect(i) {
    for (let k = 0; k < this.urls.length && wsCooling(this.urls[i]); k++) i = (i + 1) % this.urls.length;   // 跳过冷却中的（全在冷却就照常试）
    const url = this.urls[i]; if (!url) return;
    let ws; try { ws = new ethers.WebSocketProvider(url, 56); } catch (e) { return this.retry(i, e); }
    this.ws = ws; this.idx = i; this.status.wss = nodeName(url); this.status.connected = false;
    const sock = ws.websocket;
    let opened = false;
    sock?.addEventListener?.('open', () => { opened = true; if (this.ws === ws) { this.status.connected = true; this.status.connectedAt = Date.now(); this.status.lastError = null; } });
    sock?.addEventListener?.('close', () => this.retry(i, new Error('连接断开'), ws));
    sock?.addEventListener?.('error', (e) => { if (!opened && /nodereal/i.test(url)) WS_COOL.set(url, Date.now() + 30 * 60_000); this.retry(i, e?.error || new Error('连接出错'), ws); });
    for (const f of this.filters) ws.on(f, (log) => { this.status.connected = true; this.status.lastLogAt = Date.now(); bumpUsage(this.label + '-ws推送', url, { method: 'logs' }); const k = `${nodeName(url)}|${this.label}-ws推送|ws_bytes`; RPC_USAGE.set(k, (RPC_USAGE.get(k) || 0) + JSON.stringify(log).length + 200);   /* WS 按字节计费，估算每条推送的大小 */ try { this.onLog(log); } catch { /* 单条解析失败不影响订阅 */ } });
    bumpUsage(this.label, url, this.filters.map(() => ({ method: 'eth_subscribe' })));
    clearTimeout(this.backT);
    if (i > 0) this.backT = setTimeout(() => { if (this.ws === ws) { this.drop(ws); this.connect(0); } }, 10 * 60_000);
  }
  retry(i, e, ws) {
    if (ws && this.ws !== ws) return;
    this.drop(ws || this.ws); this.status.connected = false; this.status.lastError = String(e?.shortMessage || e?.message || e).slice(0, 160);
    if (this.pending) return; this.pending = setTimeout(() => { this.pending = null; this.connect((i + 1) % this.urls.length); }, 5_000);
  }
  drop(ws) { if (!ws) return; if (this.ws === ws) this.ws = null; try { ws.destroy(); } catch { /* ignore */ } }
}

// 日志 / 归档节点：.env 的 LOGS_RPC_URL（可填多个，逗号分隔），不填就用 RPC_URL（公共节点和 NodeReal 不算）。
// 所有 eth_getLogs（行情补查、Gang / Flap / Four 历史回补、追踪回补）优先发给它；一次最多 LOGS_SPAN 块（Chainstack 付费档上限 1 万块），更大的区间在 getLogs() 里自动拆段
export const logsUrls = () => (process.env.LOGS_RPC_URL || process.env.RPC_URL || '').split(',').map((x) => x.trim()).filter((u) => /^https?:\/\//.test(u) && !/publicnode|dataseed|bnbchain|nodereal|48\.club/i.test(u));
const logsSpan = () => Math.max(100, Number(process.env.LOGS_SPAN || 10_000));
// 付费节点（RPC_URL / LOGS_RPC_URL，如 Chainstack）每分钟的用量上限，按用途分开算（交易不计、不受限）：
// - 行情 eth_call 等溢出（公共节点限流时才会用到）：RPC_URL_MAX_PER_MIN，默认 150
// - eth_getLogs：LOGS_MAX_PER_MIN，默认 150
// 两个都跑满也只有 300 次/分 ≈ 1300 万次/月（Chainstack Growth 2000 万）；超了这一分钟就回到公共节点
const capUrl = () => process.env.RPC_URL || '', capMax = () => Number(process.env.RPC_URL_MAX_PER_MIN || 150), logsMax = () => Number(process.env.LOGS_MAX_PER_MIN || 150);
let capMin = 0, capUsed = 0, logsUsed = 0;
const paid = (u) => !!u && !/nodereal/i.test(u) && (u === capUrl() || logsUrls().includes(u));
const capTick = () => { const m = Math.floor(Date.now() / 60_000); if (m !== capMin) { capMin = m; capUsed = 0; logsUsed = 0; } };
const capped = (u, method) => { if (!paid(u)) return false; capTick(); return method === 'eth_getLogs' ? logsUsed >= logsMax() : capUsed >= capMax(); };
const capBump = (u, method, trade) => { if (trade || !paid(u)) return; capTick(); if (method === 'eth_getLogs') logsUsed++; else capUsed++; };

export class FailoverProvider extends ethers.JsonRpcProvider {
  // urls 按优先顺序；其中多个 NodeReal key 轮流用（round-robin）。某个节点被限流（429 等）就冷却 5 分钟，NodeReal 月额度用完冷却 1 小时，
  // 其他错误冷却 30 秒，期间用下一个；全都在冷却时只试冷却最快结束的 2 个（以前是全部硬试一遍，一个请求打 4 个节点）。
  // getLogs 不发给 bsc-dataseed（不支持，必报 limit exceeded）；某节点 getLogs 报 limit 只停它的 getLogs 10 分钟，不影响 eth_call。不让 ethers 自己退避重试（会卡很久）
  constructor(urls, label = 'rpc') {
    const list = urls.filter((u, i, a) => u && a.indexOf(u) === i);
    super(FailoverProvider.req(list[0]), 56, { staticNetwork: true, batchMaxCount: 1 });
    this.urls = list; this.label = label; this.rr = 0; this.trade = label === '交易';
    this.nodes = list.map((u) => ({ url: u, name: nodeName(u), nr: /nodereal/i.test(u), cool: 0, err: null, noLogs: /dataseed/i.test(u) ? Infinity : 0, p: new ethers.JsonRpcProvider(FailoverProvider.req(u), 56, { staticNetwork: true, batchMaxCount: 1 }) }));
    this.lastUsed = maskRpc(list[0]); this.primaryErr = null; this.coolUntil = 0;
  }
  static req(u) { const r = new ethers.FetchRequest(u); r.setThrottleParams({ maxAttempts: 1 }); r.timeout = 8_000; return r; }
  get info() {
    const now = Date.now(), first = this.nodes[0];
    const act = nodeName(this.lastUrl || this.urls[0]);
    return { active: act, primary: first?.name, fallback: act !== first?.name && !(first?.nr && /^NodeReal/.test(act)),
      coolUntil: this.coolUntil, primaryErr: this.primaryErr, keys: this.nodes.filter((n) => n.nr).map((n) => ({ name: n.name, cooling: n.cool > now, err: n.cool > now ? n.err : null })) };
  }
  order(method) {
    const now = Date.now(), all0 = method === 'eth_getLogs' ? this.nodes.filter((n) => n.noLogs <= now) : this.nodes, unb = all0.filter((n) => !(n.ban > now)), pool = unb.length ? unb : all0, ok = pool.filter((n) => n.cool <= now && (this.trade || !capped(n.url, method))), warm = pool.filter((n) => n.cool <= now);
    const nr = ok.filter((n) => n.nr);
    if (nr.length > 1) { this.rr = (this.rr + 1) % nr.length; const rot = nr.slice(this.rr).concat(nr.slice(0, this.rr)); let k = 0; for (let i = 0; i < ok.length; i++) if (ok[i].nr) ok[i] = rot[k++]; }
    if (method === 'eth_getLogs') { const L = logsUrls(); if (L.length) ok.sort((a, b) => L.includes(b.url) - L.includes(a.url)); }   // getLogs 先发日志 / 归档节点（稳定排序，其余顺序不变）
    if (!ok.length && warm.length && this.label === '交易') return warm;   // 只有交易可以突破每分钟上限；行情读取宁可慢一点也不吃付费额度
    if (!ok.length) { const rest = pool.filter((n) => !capped(n.url, method)); if (rest.length) return rest.sort((a, b) => a.cool - b.cool).slice(0, 2); }
    return ok.length ? ok : [...(pool.length ? pool : this.nodes)].sort((a, b) => a.cool - b.cool).slice(0, 2);
  }
  // 调用位置要在入口处抓（到 _send 时已经过了 ethers 的请求队列，调用栈里没有业务代码了）
  tagCaller(method) { if (++callerTick % 5 === 0) { const k = `${this.label}|${method}|${callerOf()}`; RPC_CALLERS.set(k, (RPC_CALLERS.get(k) || 0) + 5); } }
  call(tx) { this.tagCaller('eth_call'); return super.call(tx); }
  async getLogs(filter) {
    this.tagCaller('eth_getLogs');
    // 有日志节点时，超过 LOGS_SPAN 块的区间拆成几段依次查（Chainstack 一次最多 1 万块，超了报 Block range limit exceeded）
    const a = filter?.fromBlock, b = filter?.toBlock, span = logsSpan();
    if (typeof a === 'number' && typeof b === 'number' && b - a + 1 > span && logsUrls().length) {
      const out = []; for (let f = a; f <= b; f += span) out.push(...await super.getLogs({ ...filter, fromBlock: f, toBlock: Math.min(b, f + span - 1) })); return out;
    }
    return super.getLogs(filter);
  }
  async _send(payload) {
    const method = Array.isArray(payload) ? payload[0]?.method : payload?.method;
    try { return await this.sendList(payload, method, this.order(method)); }
    catch (e) {
      if (!this.trade) throw e;
      // 交易：整轮都失败（多半是公共节点短时 429「exceeded maximum retry limit」，被后台行情读取挤满）→ 等一下，所有节点按冷却先后再试一轮
      await new Promise((r) => setTimeout(r, 400));
      const now = Date.now(), all = (method === 'eth_getLogs' ? this.nodes.filter((n) => n.noLogs <= now) : this.nodes).slice().sort((a, b) => a.cool - b.cool);
      return this.sendList(payload, method, all.length ? all : this.nodes);
    }
  }
  async sendList(payload, method, list) {
    let last;
    for (let i = 0; i < list.length; i++) {
      const n = list[i]; bumpUsage(this.label, n.url, payload); capBump(n.url, method, this.trade);
      try {
        const r = await n.p._send(payload);
        const errs = (Array.isArray(r) ? r : [r]).filter((x) => x?.error).map((x) => String(x.error.message || ''));
        // 限流 / 额度：冷却这个节点换下一个；节点不支持（如 bsc-dataseed 的 getLogs「limit exceeded」）：换下一个；合约 revert 之类的正常错误直接返回
        const rl = errs.find((m) => /429|rate|too many|quota|exceed|limit/i.test(m));
        if (errs.some((m) => /not available on your current plan|archive/i.test(m)) && i < list.length - 1) { last = new Error(errs[0]); continue; }   // Chainstack 非归档档：只能查最近约 128 块的日志，更早的换下一个节点（不冷却）
        if (method === 'eth_getLogs' && errs.some((m) => /block range|range limit|too many blocks|range is too large/i.test(m)) && i < list.length - 1) { last = new Error(errs[0]); continue; }   // 区间超过这个节点的上限：换下一个，不冷却（不影响它的 eth_call）
        if (rl && method === 'eth_getLogs' && !n.nr && /^limit exceeded$/i.test(rl.trim())) { n.noLogs = Date.now() + 600_000; last = new Error(rl); continue; }
        if (rl && i < list.length - 1) { n.cool = Date.now() + (/monthly quota/i.test(rl) ? 3600_000 : n.nr ? 300_000 : 30_000); n.err = rl.slice(0, 120); if (n.nr) { this.primaryErr = n.err; this.coolUntil = n.cool; } last = new Error(rl); continue; }
        this.lastUsed = maskRpc(n.url); this.lastUrl = n.url; return r;
      } catch (e) {
        const body = /monthly quota/i.test(String(e.info?.responseBody || '')) ? '月额度已用完（monthly quota）' : '';   // 429 时 ethers 只给「exceeded maximum retry limit」，原因在响应体里
        const m = (body || String(e.shortMessage || e.message || e)).slice(0, 160); last = e;
        if (/\b403\b|forbidden/i.test(m)) n.ban = Date.now() + 600_000;   // 被封 IP 的节点：10 分钟内连「全都在冷却时挑冷却最快结束的」兜底也不选它
        n.cool = Date.now() + (body ? 3600_000 : /\b403\b|forbidden/i.test(m) ? 600_000 : /429|limit|quota|exceed|retry/i.test(m) ? (this.trade && !n.nr ? 20_000 : 300_000) : 30_000); n.err = m;   // 403（bsc-dataseed 把本机 IP 封了）冷却 10 分钟，不再每 30 秒白打一次；交易端：公共节点 429 只冷却 20 秒（多是一阵子，冷却 5 分钟会让交易只剩一两个节点可用）
        if (n.nr) { this.primaryErr = m; this.coolUntil = n.cool; }
      }
    }
    throw last;
  }
}
