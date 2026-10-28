// Flap 普通 Portal（v5.27+，0xe2cE…9De0）的「Agent ID 门槛」盘（NFT-gated，2026-10-24 上线）：
// 发币时 Portal 发 FlapNFTGated(token, nft)（data 里，没有 indexed）。还在内盘（getTokenV8Safe.status = 1）时，
// 每笔买卖都要 tx.origin 持有这个 NFT 集合里至少 1 个（不看具体 tokenId）；每个 tx.origin 最多买总量 2%（buyQuotaOf）。
// 迁移（status = 4，LaunchedToDEX）以后门槛不再适用，外盘谁都能买。管理员可以去掉门槛（FlapNFTGateUpdated，newNft = 0），不能加。
// 依据：https://docs.utter.cash/en/docs/nft-gated ，并在链上核对过（2026-10-27）：
//   - 两个币安 Agentic 钱包地址都是普通 EOA（没有合约代码，不是 7702），baw contract-call 发出的交易 from 就是钱包地址 → tx.origin 满足；
//   - 两个钱包各持有 1 个 Binance Agent ID（SPACE ID Agent ID，0x60B9…022F）；
//   - 用钱包地址 eth_call 模拟 swapExactInput 能成交，用没有 NFT 的地址模拟回滚 NFTGatedOnly。
// quoteExactInput 不检查 NFT（只检查 2% 额度），所以下单前自己查 balanceOf，再用 from = 钱包 模拟一遍。
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile, NODEREAL_WSS, ZERO } from './config.js';
import { WsLogs, PUBLIC_WSS } from './rpc.js';
import { cache } from './cache.js';
import { capFor, capLabel, sendApproval } from './approvals.js';

export const FLAP_PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const T_GATED = '0x2179156b3d2ade0f0de96eff28a7c29d924002784e113e69108d91a02cbf9098';      // FlapNFTGated(address token, address nft)
const T_GATE_UPD = '0xef4dac2f9b1190c744c50eaead877aa2f222bafb1ef8bb2c60baed13f4b63cd8';   // FlapNFTGateUpdated(address token, address oldNft, address newNft)
const T_DEX = '0x6e4f47630b8745b8cacbd44f42a8a33e7eea7cc08ef22fc7630f4f385784ff7d';        // LaunchedToDEX(address token, address pool, uint256 amount, uint256 eth)
// TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)：和 FlapNFTGated 在同一笔交易（紧跟在它后面），
// 名字 / 代号 / 图标 CID 直接从事件拿，不用等 name() / symbol()：刚发币时节点常读不到，列表里先显示几秒「?」（蝴蝶 2026-10-28）
const T_CREATED = '0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603';
const TOPICS = [[T_GATED, T_GATE_UPD, T_DEX, T_CREATED]];
// 内盘成交（链上核对过 FI 0x779c…7777 的买卖交易）：TokenBought / TokenSold(uint256 ts, address token, address trader, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)，
// 全在 data 里（没有 indexed）。ts = 区块时间（秒），amount = 代币数量，eth = 报价币金额（含手续费；BNCB 盘就是 BNCB），postPrice = 成交后价格（报价币 wei / 个）
const T_BUY = '0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7';
const T_SELL = '0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a';
const T_XFER = ethers.id('Transfer(address,address,uint256)');
const PORTAL_T = ethers.zeroPadValue(FLAP_PORTAL, 32).toLowerCase(), PORTAL_A = FLAP_PORTAL.toLowerCase();
const lim6 = async (xs, fn) => { const q = [...xs]; await Promise.all(Array.from({ length: Math.min(6, q.length) }, async () => { while (q.length) await fn(q.shift()); })); };   // 最多 6 个并行
const REG = dataFile('flapNftGated.json');
const BACKFILL = 450_000;   // 第一次启动往回补约 4 天（功能 10-24 才上线），之后从记下的区块接着补
export const AGENT_ID_NFT = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f';   // Binance Agent ID（SPACE ID）

const iface = new ethers.Interface([
  'function nftGate(address token) view returns (address)',
  'function buyQuotaOf(address token, address origin) view returns (uint256 bought, uint256 remaining)',
  'function maxBuyPerOrigin(address token) view returns (uint16 bps, uint256 maxBuyAmount)',
  'function quoteExactInput((address inputToken, address outputToken, uint256 inputAmount) p) returns (uint256)',
  'function swapExactInput((address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, bytes permitData) p) payable returns (uint256)',
  'error NFTGatedOnly(address wallet)', 'error BuyCapExceeded(address origin, uint256 held, uint256 cap)', 'error SlippageTooHigh(uint256 actual, uint256 minimum)', 'error TokenNotTradable(address token)',
]);
const erc = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function metaURI() view returns (string)', 'function tokenURI(uint256) view returns (string)']);
const coder = ethers.AbiCoder.defaultAbiCoder();
const f18 = (v) => Number(ethers.formatEther(v));
// 一笔交易里 Flap Portal 记的买入花费（BNB，含手续费）。Portal 会把超过每地址 2% 上限的部分在同一笔里退回，msg.value 不等于实际花的；没有这个钱包的买入事件就返回 null
// 只对 BNB 报价的盘有意义：报价币盘（BNCB 等）事件里的金额是报价币数量。maxBnb = 实际发出的 BNB，算出来超过它就不用（返回 null）
export function portalSpent(rc, wallet, maxBnb = Infinity) {
  const w = String(wallet || '').toLowerCase(); let s = 0, n = 0;
  for (const l of rc?.logs || []) {
    if (String(l.address).toLowerCase() !== FLAP_PORTAL.toLowerCase() || l.topics?.[0] !== T_BUY) continue;
    const [, , trader, , eth] = coder.decode(['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'], l.data);
    if (trader.toLowerCase() === w) { s += f18(eth); n++; }
  }
  return n && s <= maxBnb * (1 + 1e-9) ? s : null;
}
const minOut = (v, slippagePct) => (v * BigInt(10000 - Math.min(9900, Math.round(slippagePct * 100)))) / 10000n;
const ERR = { NFTGatedOnly: '钱包没有门槛 NFT（NFTGatedOnly）', BuyCapExceeded: '已到每个地址 2% 买入上限（BuyCapExceeded）', SlippageTooHigh: '滑点不够（SlippageTooHigh），重新报价再试', TokenNotTradable: '内盘已关闭（已迁移，TokenNotTradable）' };
const why = (e) => { const d = e?.data || e?.info?.error?.data; try { const p = d && iface.parseError(d); if (p) return ERR[p.name] || p.name; } catch { /* 不是已知错误 */ } return e?.reason ? e.reason : /^0x[0-9a-f]{8}/i.test(d || '') ? `合约拒绝（未知错误码 ${d.slice(0, 10)}）` : e?.shortMessage || e?.message || String(e); };

export class FlapNft extends EventEmitter {
  constructor(provider, send = null) {
    super();
    this.provider = provider; this.send = send;   // send = Portal.send（baw contract-call + 等上链），只有交易端传
    this.reg = (() => { try { return JSON.parse(readFileSync(REG, 'utf8')); } catch { return {}; } })();
    this.reg.tokens ||= {}; this.reg.nfts ||= {};
    this.holdCache = new Map();
    this.tr = new Map(); this.hist = new Map(); this.hq = [];   // 每个门槛盘的成交（tx:logIndex → 成交）、历史补到哪个区块
    this.status = { connected: false, wss: null, lastBlock: this.reg.lastBlock || 0, lastLogAt: 0, gated: 0, lastError: null, pollError: null };
  }
  save() { try { mkdirSync(new URL('.', REG), { recursive: true }); writeFileSync(REG, JSON.stringify(this.reg)); } catch { /* ignore */ } }
  list() { return Object.values(this.reg.tokens); }
  get(token) { return this.reg.tokens[String(token || '').toLowerCase()] || null; }

  async start() {
    // 自动收录的已开盘普通盘（auto）只留 48 小时，免得登记表越积越多、每次重启都全部恢复
    let pruned = false; for (const [k, g] of Object.entries(this.reg.tokens)) if (g.auto && Date.now() - (g.seenAt || 0) > 48 * 3600_000) { delete this.reg.tokens[k]; pruned = true; }
    if (pruned) this.save();
    for (const g of this.list()) this.emit('gated', g, { restore: true });
    this.sub = new WsLogs({ label: 'flap-nft', urls: [...NODEREAL_WSS, PUBLIC_WSS], filters: [{ address: FLAP_PORTAL, topics: TOPICS }], onLog: (l) => this.handle(l), status: this.status }).start();
    this.pollLoop(); this.tradeLoop();
  }

  // ---- 内盘成交 ----
  // Portal 上所有 Flap 币的成交很多（约 8700 笔 / 5000 块），不整条订阅：只订阅门槛盘代币自己的 Transfer，
  // 有一边是 Portal 的就是买卖，再按区块去读 Portal 的 TokenBought / TokenSold，只留门槛盘的
  parseTrade(l) {
    if (l.topics[0] !== T_BUY && l.topics[0] !== T_SELL) return null;
    const [ts, token, trader, amount, eth, fee, post] = coder.decode(['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'], l.data);
    const k = token.toLowerCase(); if (!this.reg.tokens[k]) return null;
    const tokens = f18(amount), bnb = f18(eth);
    return { token: k, trader: trader.toLowerCase(), side: l.topics[0] === T_BUY ? 'buy' : 'sell', tokens, bnb, fee: f18(fee), price: f18(post) || (tokens > 0 ? bnb / tokens : 0),
      tx: l.transactionHash, block: l.blockNumber, idx: l.index ?? l.logIndex, ts: Number(ts) * 1000 };
  }
  keep(tr) {
    let m = this.tr.get(tr.token); if (!m) this.tr.set(tr.token, (m = new Map()));
    const key = `${tr.tx}:${tr.idx}`; if (m.has(key)) return false; m.set(key, tr); return true;
  }
  trades(token) { return [...(this.tr.get(String(token).toLowerCase())?.values() || [])].sort((a, b) => a.block - b.block || a.idx - b.idx); }
  // 这些代币在 [from, to] 里哪些区块有经过 Portal 的转账（代币地址过滤的 getLogs 很轻，一次 2 万块；节点嫌多就减半）
  async portalBlocks(addrs, from, to) {
    const out = new Set();
    for (let a = from, span = 20_000; a <= to;) {
      const b = Math.min(to, a + span - 1);
      let ls; try { ls = await this.provider.getLogs({ address: addrs, topics: [T_XFER], fromBlock: a, toBlock: b }); }
      catch (e) { if (span > 2000) { span = Math.floor(span / 2); continue; } throw e; }
      const px = new Set();
      for (const l of ls) if (String(l.topics[1]).toLowerCase() === PORTAL_T || String(l.topics[2]).toLowerCase() === PORTAL_T) { out.add(l.blockNumber); px.add(l.transactionHash); }
      for (const l of ls) if (px.has(l.transactionHash)) this.noteXfer(l);
      a = b + 1;
    }
    return [...out].sort((x, y) => x - y);
  }
  // 区块 → 读 Portal 成交（相邻的区块合成一段，一段最多 500 块）
  async tradesAt(blocks, only = null) {   // only = 只要这个币的（按币补历史时）
    const ranges = [];
    for (const b of blocks) { const r = ranges.at(-1); if (r && b - r[1] <= 20 && b - r[0] < 500) r[1] = b; else ranges.push([b, b]); }
    const got = [];
    await lim6(ranges, async ([a, b]) => { for (const l of await this.provider.getLogs({ address: FLAP_PORTAL, topics: [[T_BUY, T_SELL]], fromBlock: a, toBlock: b })) { const tr = this.parseTrade(l); if (tr && (!only || tr.token === only)) got.push(tr); } });   // 几段并行（以前一段一段读，补一个活跃的币要半分钟）
    got.sort((x, y) => x.block - y.block || x.idx - y.idx);
    await this.realTraders(got);
    return got;
  }
  noteXfer(l) {
    this.xfers ||= new Map(); const h = l.transactionHash; let xs = this.xfers.get(h); if (!xs) this.xfers.set(h, (xs = []));
    if (!xs.some((e) => e.idx === (l.index ?? l.logIndex))) xs.push({ token: l.address.toLowerCase(), from: '0x' + l.topics[1].slice(26).toLowerCase(), to: '0x' + l.topics[2].slice(26).toLowerCase(), idx: l.index ?? l.logIndex });
    if (this.xfers.size > 30_000) this.xfers = new Map([...this.xfers].slice(-15_000));
  }
  // 事件里的 trader 是直接调 Portal 的地址：走 baw 市价单 / 聚合器时是路由合约（如 0x9e69…f364，代币再转给钱包），不是真正的人。
  // trader 是合约就改记成交易发起人（tx.from = tx.origin，门槛也是按它检查的），原地址留在 via。合约判断、tx.from 都缓存
  async realTraders(list) {
    this.isCode ||= new Map(); this.txFrom ||= new Map();
    const lim = lim6;
    await lim(new Set(list.map((x) => x.trader).filter((a) => !this.isCode.has(a))), async (a) => { try { const c = await this.provider.getCode(a); this.isCode.set(a, c !== '0x' && !c.startsWith('0xef0100'));   /* 0xef0100… = 7702 委托的普通钱包，不算合约 */ } catch { /* 下次再查 */ } });
    const routed = list.filter((x) => this.isCode.get(x.trader));
    // 先看同一笔交易里代币的转账（补历史 / WS 时已经拿到了，不用再请求）：买 = 从路由往下追到最后收币的地址，卖 = 往上追到最早发币的地址；追到的是普通地址就用它
    const hop = (x) => {
      const xs = this.xfers?.get(x.tx); if (!xs) return null;
      let cur = x.trader;
      for (let i = 0; i < 6; i++) { const n = xs.find((e) => e.token === x.token && (x.side === 'buy' ? e.from === cur && e.to !== cur : e.to === cur && e.from !== cur && e.from !== PORTAL_A)); if (!n) break; cur = x.side === 'buy' ? n.to : n.from; }
      return cur !== x.trader ? cur : null;
    };
    const ends = new Map(routed.map((x) => [x, hop(x)]));
    await lim(new Set([...ends.values()].filter((a) => a && !this.isCode.has(a))), async (a) => { try { const c = await this.provider.getCode(a); this.isCode.set(a, c !== '0x' && !c.startsWith('0xef0100')); } catch { /* 下次再查 */ } });
    for (const [x, a] of ends) if (a && this.isCode.get(a) === false) this.txFrom.set(x.tx + ':' + x.side, a);
    await lim(new Set(routed.filter((x) => !this.txFrom.has(x.tx + ':' + x.side)).map((x) => x.tx).filter((h) => !this.txFrom.has(h))), async (h) => { try { const tx = await this.provider.getTransaction(h); if (tx?.from) this.txFrom.set(h, tx.from.toLowerCase()); } catch { /* 留原地址 */ } });
    for (const x of routed) { const f = this.txFrom.get(x.tx + ':' + x.side) || this.txFrom.get(x.tx); if (f) { x.via = x.trader; x.trader = f; } }
    if (this.txFrom.size > 20_000) this.txFrom = new Map([...this.txFrom].slice(-10_000));
  }
  // 一个门槛盘从创建起的全部内盘成交（补过的接着补，排队一个一个来，启动时几十个币不会一起打节点）
  // urgent = 用户正点开的币：不排队直接补（启动时一百多个门槛盘排队补历史，排队的话选中的币要等几分钟，K 线只有一根轮询点）
  history(token, urgent = false) {
    const k = String(token).toLowerCase(), g = this.reg.tokens[k]; if (!g) return Promise.resolve([]);
    const h = this.hist.get(k) || {}; this.hist.set(k, h);
    this.hq ||= [];
    if (h.p) { if (urgent && h.job && !h.job.started) { this.hq.splice(this.hq.indexOf(h.job), 1); h.job.started = true; h.job.run(); } return h.p; }
    const job = { started: false };
    h.p = new Promise((ok, no) => { job.run = () => this.histRun(k, g, h).then(ok, no); }).finally(() => { h.p = null; h.job = null; });
    h.job = job; if (urgent) { job.started = true; job.run(); } else { this.hq.push(job); this.histPump(); }   // 选中的不排队，马上补（和后台那一个并行）
    return h.p;
  }
  async histPump() {
    if (this.hqBusy) return; this.hqBusy = true;
    try { while (this.hq.length) { const j = this.hq.shift(); j.started = true; await j.run().catch(() => {}); } } finally { this.hqBusy = false; }
  }
  async histRun(k, g, h) {
    if (!h.db) {   // 先从 MySQL 缓存读出已补过的成交，只补那之后的（往回多查 15 块防重组）。数据库暂时连不上（启动时偶尔超时）就下次再试，不是从此不用
      const c = await cache.loadTrades('flap-nft', k).catch(() => null);
      if (c) {
        h.db = true;
        if (!h.to && c.cursor) { for (const tr of c.rows) this.keep(tr); h.to = Math.max(0, c.cursor - 15); }
        else if (h.to && !(c.cursor >= h.to)) cache.saveTrades('flap-nft', k, this.trades(k), h.to, (x) => `${x.tx}:${x.idx}`).catch(() => {});   // 之前直接查链补的，补存进库
      }
    }
    const head = await this.provider.getBlockNumber();
    const from = h.to ? h.to + 1 : g.block || head - BACKFILL, to = g.dexBlock ? Math.min(head, g.dexBlock) : head;
    if (from <= to) { const got = await this.tradesAt(await this.portalBlocks([k], from, to), k); for (const tr of got) this.keep(tr); h.to = to; if (h.db) cache.saveTrades('flap-nft', k, got, to, (x) => `${x.tx}:${x.idx}`).catch(() => {}); }
    h.at = Date.now(); return this.trades(k);
  }
  // 实时：WS 订阅内盘门槛盘的 Transfer（币列表变了就重订），另外每 30 秒（WS 不通时 5 秒）用 getLogs 补一遍，两边按 tx:logIndex 去重
  curveTokens() { return this.list().filter((g) => !g.dex).map((g) => g.token).sort(); }
  resubTrades() {
    const addrs = this.curveTokens(), key = addrs.join(','); if (key === this.trKey) return; this.trKey = key;
    const old = this.trSub; if (old) { old.urls = []; clearTimeout(old.pending); clearTimeout(old.backT); old.drop(old.ws); }
    this.trStatus ||= { connected: false };
    this.trSub = addrs.length ? new WsLogs({ label: 'flap-nft成交', urls: [...NODEREAL_WSS, PUBLIC_WSS], filters: [{ address: addrs, topics: [T_XFER] }], onLog: (l) => this.onXfer(l), status: this.trStatus }).start() : null;
  }
  onXfer(l) {
    try { this.noteXfer(l); } catch { /* 解析失败跳过 */ }
    if (String(l.topics[1]).toLowerCase() !== PORTAL_T && String(l.topics[2]).toLowerCase() !== PORTAL_T) return;
    (this.xferBlocks ||= new Set()).add(l.blockNumber);
    clearTimeout(this.xferT); this.xferT = setTimeout(() => this.flushXfer(), 300);
  }
  async flushXfer() {
    const bs = [...(this.xferBlocks || [])].sort((a, b) => a - b); this.xferBlocks = new Set(); if (!bs.length) return;
    try { this.emitTrades(await this.tradesAt(bs)); } catch { for (const b of bs) this.xferBlocks.add(b); clearTimeout(this.xferT); this.xferT = setTimeout(() => this.flushXfer(), 3000); }
  }
  emitTrades(list) { for (const tr of list) if (this.keep(tr)) this.emit('trade', tr); }
  async tradeLoop() {
    for (let first = true; ; first = false) {
      if (!first) await new Promise((r) => setTimeout(r, this.trSub?.live ? 30_000 : 5_000));
      try {
        this.resubTrades();
        const head = await this.provider.getBlockNumber(), addrs = this.curveTokens();
        if (!this.trTo) { this.trTo = head; continue; }   // 更早的由 history() 按币补
        if (addrs.length && head > this.trTo) this.emitTrades(await this.tradesAt(await this.portalBlocks(addrs, this.trTo + 1, head)));
        this.trTo = head;
      } catch { /* 下一轮 */ }
    }
  }

  async pollLoop() {
    for (let first = true; ; first = false) {
      if (!first) await new Promise((r) => setTimeout(r, this.sub?.live ? 60_000 : 5_000));
      try {
        const head = await this.provider.getBlockNumber();
        let from = Math.max(this.status.lastBlock ? this.status.lastBlock + 1 : head - BACKFILL, head - BACKFILL);
        while (from <= head) {
          const to = Math.min(head, from + 4999);
          for (const l of await this.provider.getLogs({ address: FLAP_PORTAL, topics: TOPICS, fromBlock: from, toBlock: to })) this.handle(l);
          this.status.lastBlock = to; from = to + 1;
          if (to % 50_000 < 5000) { this.reg.lastBlock = to; this.save(); }   // 补历史时隔一段记一次进度，中途重启不用从头补
        }
        this.reg.lastBlock = this.status.lastBlock; this.save(); this.status.pollError = null;
      } catch (e) { this.status.pollError = String(e.shortMessage || e.message).slice(0, 160); }
    }
  }

  handle(l) {
    try {
      const t0 = l.topics[0];
      if (t0 === T_GATED) {
        const [token, nft] = coder.decode(['address', 'address'], l.data); const k = token.toLowerCase();
        if (this.reg.tokens[k]) return;
        const g = { token: k, nft: nft.toLowerCase(), block: l.blockNumber, tx: l.transactionHash, seenAt: Date.now(), at: null };
        const m = this.created?.get(k); if (m) g.meta = m;   // TokenCreated 先到了（一般是门槛事件先到）
        this.reg.tokens[k] = g; this.status.gated++; this.save();
        this.emit('gated', g, { restore: false }); this.resubTrades();
      } else if (t0 === T_CREATED) {
        // Portal 上所有 Flap 币的创建都会推过来，只留最近 64 个（门槛事件在同一笔交易里，前后差几毫秒）
        const [ts, , , token, name, symbol, meta] = coder.decode(['uint256', 'address', 'uint256', 'address', 'string', 'string', 'string'], l.data); const k = token.toLowerCase();
        const m = { ...(name && { name }), ...(symbol && { symbol }), ...(meta && { uri: /^https?:\/\//i.test(meta) ? meta : `https://flap.mypinata.cloud/ipfs/${meta}` }) };
        const g = this.reg.tokens[k];
        if (!g) {
          this.created ||= new Map(); if (this.created.has(k)) return;   // WS 和 getLogs 补查都会送来同一条
          this.created.set(k, m); if (this.created.size > 64) this.created.delete(this.created.keys().next().value);
          this.emit('created', { token: k, ...m, ts: Number(ts) * 1000 || 0, block: l.blockNumber });   // 普通盘（不是门槛盘）：战壕「普通盘」用（plainPools.js）
          return;
        }
        if (g.meta?.name && g.meta?.symbol) return;
        g.meta = { ...m, ...g.meta }; this.save(); this.emit('meta', g);
      } else if (t0 === T_GATE_UPD) {
        const [token, , newNft] = coder.decode(['address', 'address', 'address'], l.data); const g = this.get(token);
        if (g && newNft === ZERO && !g.removed) { g.removed = true; this.save(); this.emit('ungated', g); }
      } else if (t0 === T_DEX) {
        const [token] = coder.decode(['address', 'address', 'uint256', 'uint256'], l.data); const g = this.get(token);
        if (g && !g.dex) { g.dex = true; g.dexBlock = l.blockNumber; this.save(); this.emit('dex', g); this.resubTrades(); }
        else if (!g) this.emit('dexUnknown', token.toLowerCase(), l.blockNumber);   // 不在登记表里的普通 Flap 盘迁移了：「已开盘」要收录（liveMarket.autoQ）
      }
    } catch { /* 解析失败的跳过 */ }
  }

  async call(to, i, fn, args = [], from) { return i.decodeFunctionResult(fn, await this.provider.call({ to, from, data: i.encodeFunctionData(fn, args) })); }

  // getTokenV8Safe(token)：静态结构，按字（32 字节）读需要的字段（链上核对过）。0 状态 1=内盘 4=已迁移，1 储备（报价币），2 流通量，
  // 3 价格（报价币 wei / 个），8 迁移门槛（流通量），9 报价币地址，10 是否支持原生 BNB 自动换报价币，15 进度（1e18 = 100%）
  async state(token) {
    const raw = await this.provider.call({ to: FLAP_PORTAL, data: '0x62fafcca' + ethers.zeroPadValue(token, 32).slice(2) });
    const w = (i) => BigInt('0x' + raw.slice(2 + i * 64, 2 + (i + 1) * 64));
    const quote = ethers.getAddress('0x' + raw.slice(2 + 9 * 64 + 24, 2 + 10 * 64));
    return { status: Number(w(0)), reserve: w(1), circulating: w(2), price: w(3), dexThresh: w(8), quote, nativeSwap: w(10) !== 0n, progress: Number(w(15)) / 1e16 };
  }

  // 税币信息（门槛盘都是 FlapTaxTokenV3，地址 …7777）：买 / 卖税率在代币合约上；受益人、分红币、税收分配在 taxProcessor 上。
  // feeConfigV2() 前 4 个字 = 营销 / 销毁 / 回流 LP / 分红（万分比，合计 10000）。顺序按已迁移 Flap 币的实际流向核对过：
  // 营销 10000 的币钱只进 totalQuoteSentToMarketing，分红 10000 的币只进 totalQuoteSentToDividend，回流的币有 totalQuoteAddedToLiquidity
  // fixed = 之前读过的不变部分（税率、分配比例、受益人、分红币……创建后不能改）：只重读三个累计金额
  async taxInfo(token, fixed = null) {
    const sel = (s) => ethers.id(s).slice(0, 10);
    const raw = (to, f) => this.provider.call({ to, data: sel(f) });
    const u = async (to, f) => BigInt(await raw(to, f));
    const a = async (to, f) => ethers.getAddress('0x' + (await raw(to, f)).slice(26)).toLowerCase();
    if (fixed) {
      const proc = fixed.processor; if (!proc || proc === ZERO) return { ...fixed, at: Date.now() };
      const [sentMkt, sentDiv, lpQuote] = await Promise.all([u(proc, 'totalQuoteSentToMarketing()').catch(() => 0n), u(proc, 'totalQuoteSentToDividend()').catch(() => 0n), u(proc, 'totalQuoteAddedToLiquidity()').catch(() => 0n)]);
      return { ...fixed, sentMkt: f18(sentMkt), sentDiv: f18(sentDiv), lpQuote: f18(lpQuote), at: Date.now() };
    }
    const [buy, sell, proc] = await Promise.all([u(token, 'buyTaxRate()'), u(token, 'sellTaxRate()'), a(token, 'taxProcessor()').catch(() => ZERO)]);
    const v = { buyBps: Number(buy), sellBps: Number(sell), processor: proc, at: Date.now() };
    if (proc === ZERO) return v;
    const [cfg, ben, divToken, divContract, sentMkt, sentDiv, lpQuote] = await Promise.all([raw(proc, 'feeConfigV2()').catch(() => '0x'), a(proc, 'marketAddress()').catch(() => null), a(proc, 'dividendToken()').catch(() => null),
      a(proc, 'dividendAddress()').catch(() => null), u(proc, 'totalQuoteSentToMarketing()').catch(() => 0n), u(proc, 'totalQuoteSentToDividend()').catch(() => 0n), u(proc, 'totalQuoteAddedToLiquidity()').catch(() => 0n)]);
    const w = (i) => (cfg.length >= 2 + (i + 1) * 64 ? Number(BigInt('0x' + cfg.slice(2 + i * 64, 2 + (i + 1) * 64))) : 0);
    Object.assign(v, { mktBps: w(0), deflBps: w(1), lpBps: w(2), divBps: w(3), beneficiary: ben && ben !== ZERO ? ben : null, divToken, divContract, sentMkt: f18(sentMkt), sentDiv: f18(sentDiv), lpQuote: f18(lpQuote) });
    if (divToken && divToken !== ZERO) {
      v.divSym = divToken === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' ? 'BNB' : await this.call(divToken, erc, 'symbol').then((r) => r[0]).catch(() => '?');
      if (divToken === String(token).toLowerCase()) v.divSym = '本币';
    }
    if (v.divBps > 0 && divContract && divContract !== ZERO) v.divMin = await u(divContract, 'minimumShareBalance()').then(f18).catch(() => null);
    return v;
  }

  // 门槛还在吗（管理员可能去掉了）：nftGate(token)，0 = 不再有门槛
  async gateOf(token) { return (await this.call(FLAP_PORTAL, iface, 'nftGate', [token]))[0].toLowerCase(); }

  // 不在登记表里的地址（钱包 2 后端没订阅到、手动搜索的）：直接问 Portal，是门槛盘就补登记。
  // plain = 手动粘贴地址：没有门槛的普通 Portal 盘（如以 NOKB 计价的 NOKIA 0x1871…7777）也收录，按「门槛已取消」同一套买卖（Portal 自己做 BNB⇄报价币）
  async check(token, { plain = false, at: atHint, auto = false } = {}) {
    const k = String(token).toLowerCase(); if (this.reg.tokens[k]) return this.reg.tokens[k];
    let nft; try { nft = await this.gateOf(k); } catch { return null; }
    if (!nft || nft === ZERO) {
      if (!plain) return null;
      let st; try { st = await this.state(k); } catch { return null; }
      if (st.status !== 1 && st.status !== 4) return null;   // 不是 Portal 的币（读出来全 0）
      // 普通盘没有 FlapNFTGated 事件可以定创建区块：按 DexScreener 的创建时间估一个（往前多留 300 块），免得 history() 从 45 万块前开始补；查不到就只补最近约 5000 块
      // atHint：调用方已知的创建时间（自动发现时用 DexScreener flapsh 交易对的 pairCreatedAt，那里梗币是报价那一边，下面按 baseToken 查不到）
      const at = atHint > 0 ? atHint : await fetch('https://api.dexscreener.com/latest/dex/tokens/' + k, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
        .then((j) => Math.min(...(j.pairs || []).filter((x) => x.chainId === 'bsc' && x.baseToken?.address?.toLowerCase() === k && x.pairCreatedAt > 0).map((x) => x.pairCreatedAt))).catch(() => Infinity);
      let block = null;
      try {
        const head = await this.provider.getBlock('latest'), old = await this.provider.getBlock(head.number - 1000), ms = ((head.timestamp - old.timestamp) * 1000) / 1000 || 750;
        block = Number.isFinite(at) ? Math.max(0, head.number - Math.ceil((head.timestamp * 1000 - at) / ms) - 300) : head.number - 5000;
      } catch { /* 读不到就按默认回补 */ }
      if (auto && st.status !== 4) return null;   // 自动收录只要已迁移的
      const g = { token: k, nft: ZERO, plain: true, removed: true, dex: st.status === 4, block, tx: null, seenAt: Date.now(), at: Number.isFinite(at) ? at : null, ...(auto && { auto: true }) };
      this.reg.tokens[k] = g; this.save(); this.emit('gated', g, { restore: true }); return g;
    }
    const g = { token: k, nft, block: null, tx: null, seenAt: Date.now(), at: null };
    this.reg.tokens[k] = g; this.save(); this.emit('gated', g, { restore: true }); return g;
  }

  // NFT 集合信息（名字、代号、示例图片）。图片：Binance Agent ID 每个 NFT 一张名片，取最近一次转账的那个 tokenId 的图当示例
  async nftInfo(nft) {
    const k = nft.toLowerCase(), c = this.reg.nfts[k];
    if (c && (c.image || Date.now() - c.at < 6 * 3600_000)) return c;
    const [name, symbol] = await Promise.all([this.call(k, erc, 'name').then((r) => r[0]).catch(() => ''), this.call(k, erc, 'symbol').then((r) => r[0]).catch(() => '')]);
    let image = c?.image || null;
    try {
      const head = await this.provider.getBlockNumber();
      const ls = await this.provider.getLogs({ address: k, topics: [ethers.id('Transfer(address,address,uint256)')], fromBlock: head - 999, toBlock: head });
      const id = ls.length && ls.at(-1).topics[3] ? BigInt(ls.at(-1).topics[3]) : null;
      const uri = id != null ? (await this.call(k, erc, 'tokenURI', [id]))[0] : '';
      if (/^https:\/\//.test(uri)) { const j = await (await fetch(uri, { signal: AbortSignal.timeout(6000) })).json(); if (/^https:\/\//.test(j?.image || '')) image = j.image; }
    } catch { /* 没图就算了 */ }
    const v = { nft: k, name: k === AGENT_ID_NFT ? 'Binance Agent ID' : name || '未知 NFT', rawName: name, symbol, image, known: k === AGENT_ID_NFT, at: Date.now() };
    this.reg.nfts[k] = v; this.save(); return v;
  }

  // 这个地址持有几个门槛 NFT（30 秒缓存；force 时当场查）
  async holds(nft, wallet, force = false) {
    const key = `${nft}:${String(wallet).toLowerCase()}`, c = this.holdCache.get(key);
    if (!force && c && Date.now() - c.at < 30_000) return c.n;
    const n = Number((await this.call(nft, erc, 'balanceOf', [wallet]))[0]);
    this.holdCache.set(key, { n, at: Date.now() }); return n;
  }
  async quota(token, wallet) { const [bought, remaining] = await this.call(FLAP_PORTAL, iface, 'buyQuotaOf', [token, wallet]); return { bought, remaining, capped: remaining !== ethers.MaxUint256 }; }

  // 下单前的门槛检查：内盘 + 门槛还在 + 钱包没有 NFT → 返回原因（跳过，不报错）；能交易返回 null
  async block(token, wallet) {
    const g = this.get(token); if (!g || g.removed || g.dex) return null;
    // 门槛 NFT 和持有数同时查：先按登记的 NFT 查持有数，门槛换了才按新的再查一次
    const [nft, n0] = await Promise.all([this.gateOf(token).catch(() => g.nft), g.nft ? this.holds(g.nft, wallet, true).catch(() => null) : null]);
    if (!nft || nft === ZERO) { g.removed = true; this.save(); this.emit('ungated', g); return null; }
    const n = nft === g.nft && n0 != null ? n0 : await this.holds(nft, wallet, true);
    if (n > 0) return null;
    const info = this.reg.nfts[nft]; return `跳过：这个币还在内盘，要求钱包持有 ${info?.name || nft} NFT 才能买卖，这个钱包（${wallet.slice(0, 6)}…${wallet.slice(-4)}）没有`;
  }

  async quoteBuy(token, wallet, amountBnb) {
    const value = ethers.parseEther(String(amountBnb));
    const out = (await this.call(FLAP_PORTAL, iface, 'quoteExactInput', [[ZERO, token, value]], wallet).catch((e) => { throw Object.assign(new Error(`Flap Portal 报价被拒：${why(e)}`), { cause: e }); }))[0];
    return { value, out };
  }
  async quoteSell(token, wallet, amount) { return (await this.call(FLAP_PORTAL, iface, 'quoteExactInput', [[token, ZERO, amount]], wallet))[0]; }
  async balance(token, wallet) { return (await this.call(token, erc, 'balanceOf', [wallet]))[0]; }

  // 发交易前用钱包地址 eth_call 跑一遍（tx.origin = 钱包，会检查 NFT 门槛 / 2% 上限），回滚就直接报原因，不花 gas
  async simulate(from, data, value) {
    try { return iface.decodeFunctionResult('swapExactInput', await this.provider.call({ from, to: FLAP_PORTAL, data, value }))[0]; }
    catch (e) { throw Object.assign(new Error(`链上模拟失败：${why(e)}`), { code: /NFTGatedOnly/.test(why(e)) ? 'NFT_GATE' : undefined }); }
  }

  // 只报价 + 模拟（不上链）
  async previewBuy({ wallet, token, amountBnb, step }) {
    const q = await this.quoteBuy(token, wallet, amountBnb);
    step(`Flap Portal 报价 ${f18(q.out).toFixed(0)} 个`, 0);
    const got = await this.simulate(wallet, iface.encodeFunctionData('swapExactInput', [[ZERO, token, q.value, 0n, '0x']]), q.value);
    step('链上模拟通过（tx.origin = 钱包）', 0);
    return { dryRun: true, venue: 'Flap Portal.swapExactInput（Agent ID 门槛，未上链）', expected: f18(got) };
  }

  // 买入：一笔 swapExactInput{value}（BNB 盘原子完成；非 BNB 报价币盘由 Portal 自己把 BNB 换成报价币）。到 2% 上限时只成交到上限，多余 BNB 同笔退回
  async buy({ wallet, token, amountBnb, slippage, step, fast = false, bnbQuote = false }) {
    const q = await this.quoteBuy(token, wallet, amountBnb);
    if (q.out <= 0n) throw new Error('报价为 0：可能已到每个地址 2% 上限');
    step(`Flap Portal 报价 ${f18(q.out).toFixed(0)} 个`, 0);
    const inputData = iface.encodeFunctionData('swapExactInput', [[ZERO, token, q.value, minOut(q.out, slippage), '0x']]);
    if (!fast) await this.simulate(wallet, inputData, q.value);   // 快捷买入不模拟，直接发（报价 + 滑点保护照旧）
    const hash = await this.send({ wallet, to: FLAP_PORTAL, valueWei: q.value, inputData, label: 'Flap Portal.swapExactInput 买入', step });
    // 「买 N%」给的金额超过 2% 上限时 Portal 会退回多的：成本按回执里 Portal 记的实际花费，不按发出去的 msg.value
    // BNB 盘读 Portal 买入事件；报价币盘（BNCB 等，事件金额是报价币）按这一块前后的 BNB 余额差减 gas 算（多的 BNB 一样会退回）
    const rc = await this.provider.getTransactionReceipt(hash).catch(() => null);
    let spent = bnbQuote ? portalSpent(rc, wallet, f18(q.value)) : null;
    if (spent == null && rc) spent = await this.spentByBalance(rc, wallet, q.value).catch(() => null);
    return { venue: 'Flap Portal.swapExactInput（内盘，BNB）', expected: f18(q.out), txHash: hash, hashes: [hash], ...(spent != null ? { spent } : {}) };
  }

  // 一笔买入实际花的 BNB：这一块前后的余额差 − gas。不在 (0, 发出的 BNB] 里就当读不准（同一块里还有别的转账等），返回 null
  async spentByBalance(rc, wallet, valueWei) {
    const [b0, b1] = await Promise.all([this.provider.getBalance(wallet, rc.blockNumber - 1), this.provider.getBalance(wallet, rc.blockNumber)]);
    const d = b0 - b1 - rc.gasUsed * (rc.gasPrice ?? rc.effectiveGasPrice ?? 0n);
    return d > 0n && d <= BigInt(valueWei) ? f18(d) : null;
  }

  async sell({ wallet, token, pct, slippage, step }) {
    // 余额和授权额度同时读（原来先后各一次往返）
    const [bal, allowance] = await Promise.all([this.balance(token, wallet), this.call(token, erc, 'allowance', [wallet, FLAP_PORTAL]).then((r) => r[0])]);
    if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
    step(`卖出 ${f18(amt).toFixed(0)} 个（持有 ${f18(bal).toFixed(0)}）`, 0);
    const hashes = [];
    if (allowance < amt) { const cap = await capFor({ token, wallet, amount: amt, kind: 'sell' }); hashes.push(await sendApproval({ send: (o) => this.send(o), wallet, token, spender: FLAP_PORTAL, amount: amt, cap, label: `授权卖出（${capLabel('sell')}）`, kind: 'sell', step })); }
    else step('授权额度够用，跳过授权', 0);
    const out = await this.quoteSell(token, wallet, amt);
    const inputData = iface.encodeFunctionData('swapExactInput', [[token, ZERO, amt, minOut(out, slippage), '0x']]);
    await this.simulate(wallet, inputData, 0n);
    hashes.push(await this.send({ wallet, to: FLAP_PORTAL, inputData, label: 'Flap Portal.swapExactInput 卖出', step }));
    return { venue: 'Flap Portal.swapExactInput（内盘，卖出得 BNB）', expected: f18(out), txHash: hashes.at(-1), hashes };
  }
}
