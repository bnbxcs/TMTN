// 实盘行情适配器：把 Flap Agent Curve Reader + fsi、four.meme Agentic Wallet 专属内盘（链上事件）+ shrine 统一成和模拟盘一样的接口（list / get / detail / 事件）。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { RPC_URL, RPC_LIST, BNB_PRICE_URL, dataFile } from './config.js';
import { FailoverProvider, nodeName, PUBLIC_RPC } from './rpc.js';
import { AgentCurve } from './agentCurve.js';
import { FourMeme, AGENT_ID_TEMPLATE } from './fourMeme.js';
import { MetaFetcher, ipfsUrl } from './meta.js';
import { GangFun } from './gangFun.js';
import { FeastApi } from './feastApi.js';
import { GangChain, QUOTE_DEC } from './gangChain.js';
import { FlapChain } from './flapChain.js';
import { FlapNft } from './flapNft.js';
import { GangPadChain } from './gangPadChain.js';
import { GangV2 } from './gangV2Pads.js';
import { V3_TRADE } from './gangV3.js';
import { fairList } from './gangFair.js';
import { DexFeed, dexBars, compactCandles } from './dexFeed.js';
import { NameCache } from './names.js';
import { ShrineFeeds, tokenInfo } from './shrine.js';
import * as fsi from './fsi.js';
import { cache } from './cache.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getRoute } from './quoteRoutes.js';
const FOUR_REG = dataFile('fourTokens.json');
const FLAP_REG = dataFile('flapCreated.json');
const BOOT = Date.now();

const MAX = 1000;                      // Flap Agent 曲线市场、持有中 / 收藏的币不参与淘汰，超出时淘汰最老的盘
const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const m = String(v).replace(/[$,\s]/g, '').match(/^(-?[\d.]+)([KMB])?$/i); if (!m) return Number(v) || null; return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1); };
const sec2ms = (v) => { const x = Number(v); return !x ? Date.now() : x < 1e12 ? x * 1000 : x; };
const isAgentish = (l) => l.agentExclusive === true || l.agent === true || l.isAgent === true || (Array.isArray(l.tags) && l.tags.some((t) => /agent/i.test(t)));

// 报价币美元价兜底：gang.fun 对 FXIon 等 Ondo 币给 quoteUsd=0、DexScreener 偶尔失败 / 限流时，直接读路线表里最深池子（只读 slot0 / getReserves）
// 池子另一边是稳定币按 $1，是 WBNB 按 BNB 价；别的配对币不算（返回 0）
const STABLE = new Set(['USDT', 'USDC', 'USD1', 'U', 'BUSD', 'FDUSD']);
const POOL_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)', 'function getReserves() view returns (uint112,uint112,uint32)'];
const DEC_ABI = ['function decimals() view returns (uint8)'];
async function poolPriceUsd(provider, addr, bnbUsd) {
  const k = String(addr).toLowerCase(), bp = getRoute(k)?.bestPool; if (!bp?.pair) return 0;
  const w = String(bp.with || '').toUpperCase(), wUsd = STABLE.has(w) ? 1 : w === 'WBNB' || w === 'BNB' ? bnbUsd : 0; if (!(wUsd > 0)) return 0;
  const pool = new ethers.Contract(bp.pair, POOL_ABI, provider);
  const [t0, t1] = (await Promise.all([pool.token0(), pool.token1()])).map((a) => a.toLowerCase());
  if (t0 !== k && t1 !== k) return 0;
  const [d0, d1] = (await Promise.all([t0, t1].map((a) => new ethers.Contract(a, DEC_ABI, provider).decimals()))).map(Number);
  let p1per0;   // 1 个 token0 值多少 token1（已按小数位换算）
  try { const sq = Number((await pool.slot0())[0]) / 2 ** 96; p1per0 = sq * sq * 10 ** (d0 - d1); }
  catch { const [r0, r1] = await pool.getReserves(); p1per0 = (Number(r1) / 10 ** d1) / (Number(r0) / 10 ** d0); }
  if (!(p1per0 > 0) || !isFinite(p1per0)) return 0;
  return (t0 === k ? p1per0 : 1 / p1per0) * wUsd;
}

export class LiveMarket extends EventEmitter {
  quoteUsd(t) { const q = String(t?.quote || 'BNB').toUpperCase(); if (q === 'BNB' || q === 'WBNB') return this.bnbUsd; if (['USDT','USDC','USD1'].includes(q)) return 1; const a = String(t.quoteAddress || '').toLowerCase(), v = this.qUsd[a]; if (!(v > 0) && a && this.qpx && !this._qpxSoon && Date.now() - (this._qpxAt || 0) > 30_000) { this._qpxAt = Date.now(); this._qpxSoon = setTimeout(() => { this._qpxSoon = null; this.qpx(); }, 2000); } return v || 0; }   // 新出现的报价币没价格：2 秒后补查一次（30 秒最多一次），不等 60 秒轮询
  constructor() {
    super();
    // 两套节点：行情 / 持仓 / 监控这类不赶时间的读取走公共节点优先（省 NodeReal 额度）；下单、确认、卖前余额这条交易链路走 NodeReal 优先
    this.provider = new FailoverProvider([PUBLIC_RPC, 'https://bsc-dataseed.bnbchain.org', ...RPC_LIST], '行情读取');   // 两个公共节点都不行时才用 NodeReal
    this.tradeProvider = new FailoverProvider(RPC_LIST, '交易');
    this.curve = new AgentCurve(this.provider);
    this.four = new FourMeme();
    this.gang = new GangFun();
    this.feast = new FeastApi();   // Feast（feast.meme）：公开接口的币列表 + 24 小时快照，10 秒一轮
    this.dexFeed = new DexFeed(new ethers.JsonRpcProvider(PUBLIC_RPC, 56, { staticNetwork: true }));   // 已发射币的外盘成交（PancakeSwap V2 池子的 Swap 事件）
    this.gangChain = new GangChain(this.provider);   // 链上创建事件，比接口轮询快
    this.gangChain.on('token', (it) => this.onGangChainToken(it));
    this.flapChain = new FlapChain(this.provider);   // Flap 成交 / 新市场：链上订阅（代替 shrine 推送）
    this.flapChain.on('trade', (tr) => this.onFlapChainTrade(tr));
    this.gangPads = new GangPadChain(this.provider);   // Gang V2 全部成交（链上），以前只有最活跃的几个盘有成交（接口轮询）
    this.gangPads.on('trade', (tr) => this.onGangTrade(tr, true));
    // Flap 普通 Portal 的 Agent ID 门槛盘（NFT-gated）：只有这类 Portal 盘会进列表（普通 Flap Portal 盘本终端不跟踪）
    this.flapNft = new FlapNft(this.provider);
    this.flapNft.on('gated', (g, o) => this.upsertFlapNft(g, o).catch(() => {}));
    this.flapNft.on('ungated', (g) => { const t = this.get(g.token); if (t?.nftGate) { t.nftGate = { ...t.nftGate, removed: true }; this.emit('detail', t.address); } });
    this.flapNft.on('trade', (tr) => this.onFlapNftTrade(tr));
    this.flapNft.on('dex', (g) => { const t = this.get(g.token); if (t && t.stage === 'curve') { t.stage = 'dex'; t.progress = 100; this.emit('migrate', this.summary(t)); } });
    this.flapChain.on('created', () => { try { this.curve.tick?.(); } catch { /* 下一轮 Reader 轮询也会扫到 */ } });
    this.meta = new MetaFetcher();
    this.names = new NameCache();
    this.feeds = new ShrineFeeds();
    this.tokens = new Map();
    this.flow = [];
    this.bnbUsd = 0; this.qUsd = {}; this.block = 0; this.rpcMs = 0; this.rpcError = null;
  }

  start() {
    this.curve.on('market', (item, { isNew }) => this.upsertCurve(item, isNew));
    this.four.on('token', (it, { isNew }) => this.upsertFour(it, isNew));
    this.four.on('trade', (tr) => this.onFourTrade(tr));
    this.gang.on('token', (it, { isNew }) => this.upsertGang(it, isNew));
    setInterval(() => { for (const t of this.tokens.values()) if (t.source === 'gang' && t.gangTrack === 'v3fair' && t.stage === 'curve') this.gangFairState(t).catch(() => {}); }, 15_000).unref?.();   // 打新盘：进度 / 是否已发射从 pad 读
    this.gang.on('trade', (tr, { live }) => this.onGangTrade(tr, live));
    this.feast.on('token', (it, { isNew }) => this.upsertFeast(it, isNew));
    this.feast.on('meta', (a, m) => { const t = this.get(a); if (t) { Object.assign(t, m); this.emit('detail', t.address); } });
    this.feeds.on('launch', (l) => this.upsertShrine(l));
    this.feeds.on('trade', (m) => this.onStreamTrade(m));
    this.feeds.on('graduated', (m) => { const t = this.get(m.token); if (t) { t.stage = 'dex'; this.emit('migrate', this.summary(t)); } });
    this.curve.start();
    this.four.start();
    this.fourRestore();
    setTimeout(() => this.fourDexCheck(), 20_000); this.fourDexTimer = setInterval(() => this.fourDexCheck(), 60_000);
    this.loadFairSales(); setInterval(() => this.loadFairSales(), 30_000).unref?.();   // 打新盘：gang.fun 普通代币接口不列，重启后链上订阅也不会补以前的，从打新列表接口补
    this.gang.start(); this.gangChain.start(); this.flapChain.start(); this.gangPads.start(); this.flapNft.start(); this.feast.start();
    this.feeds.start();
    const blk = async () => { const t0 = Date.now(); try { this.block = await this.provider.getBlockNumber(); this.rpcMs = Date.now() - t0; this.rpcError = null; } catch (e) { this.rpcError = e.shortMessage || e.message; } };
    const px = async () => { try { const j = await (await fetch(BNB_PRICE_URL)).json(); if (+j.price) this.bnbUsd = +j.price; } catch { /* 保留上次 */ } };
    const qpx = async () => { const qs = new Set(); for (const t of this.tokens.values()) if (t.quoteAddress && t.quote && !['BNB','WBNB','USDT','USDC','USD1'].includes(String(t.quote).toUpperCase())) qs.add(String(t.quoteAddress).toLowerCase());
      for (const a of qs) { try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + a, { signal: AbortSignal.timeout(6000) })).json(); const ps = (j.pairs || []).filter((x) => x.chainId === 'bsc' && x.baseToken?.address?.toLowerCase() === a && +x.priceUsd).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0)); if (ps[0]) this.qUsd[a] = +ps[0].priceUsd; } catch { /* 保留上次 */ }
        if (!(this.qUsd[a] > 0)) { try { const v = await poolPriceUsd(this.provider, a, this.bnbUsd); if (v > 0) this.qUsd[a] = v; } catch { /* 下次再试 */ } } } };   // DexScreener 没给出价格：读链上池子兜底
    this.qpx = qpx; blk(); px(); setTimeout(qpx, 3000);
    this.timers = [setInterval(blk, 3000), setInterval(px, 30_000), setInterval(qpx, 60_000), setInterval(() => this.warm(), 8000), setInterval(() => this.flapHolders(), 90_000), setInterval(() => this.flapNftTick(), 6000)];
    setTimeout(() => this.flapHolders(), 15_000);
  }

  stop() { this.timers?.forEach(clearInterval); }

  key(a) { return String(a || '').toLowerCase(); }
  get(a) { return a ? this.tokens.get(this.key(a)) : null; }

  base(address) {
    const k = this.key(address);
    if (!this.tokens.has(k)) {
      this.tokens.set(k, { address: k, symbol: '?', name: '', platform: 'flap', quote: 'BNB', createdAt: Date.now(), stage: 'curve', price: 0, mcapUsd: 0, raised: 0, target: 0, progress: 0,
        remaining: 0, holders: null, buys: 0, sells: 0,   // holders：null = 还不知道，页面显示「—」
 volume: 0, buyTax: 0, sellTax: 0, feeBps: null, trades: [], candles: [], creator: '', market: null });
      if (this.tokens.size > MAX) {
        const keep = this.keepSet?.() || new Set();   // 持有中、收藏的币（server.js 设置），永远不淘汰
        const old = [...this.tokens.values()].filter((t) => !t.pinned && !keep.has(t.address) && t.source !== 'agent-curve' && t.source !== 'flap-nft' && !(t.source === 'four-agent' && t.stage === 'dex')).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (old) this.tokens.delete(old.address);
      }
    }
    return this.tokens.get(k);
  }

  upsertCurve(it, isNew) {
    const existed = this.tokens.has(this.key(it.token));
    const t = this.base(it.token);
    Object.assign(t, {
      source: 'agent-curve', platform: 'flap', agentExclusive: true, market: it.market, symbol: it.symbol, name: it.name, quote: it.quote, quoteAddress: it.quoteAddress,
      stage: it.phase === 'graduated' ? 'dex' : 'curve', progress: it.progress, raised: it.pool, target: it.cap, buys: it.buys, sells: it.sells,
      buyTax: it.buyTaxBps != null ? it.buyTaxBps / 100 : t.buyTax, sellTax: it.sellTaxBps != null ? it.sellTaxBps / 100 : t.sellTax, realToken: it.realToken,
    });
    if (!existed) {
      // 真实创建时间：先查 data/flapCreated.json；没有就先给个「启动前 1 天以上」的旧值（真新盘才用 now），再后台用 fsi 第一笔买入时间补（Reader 的 launchedAt 是迁移时间，曲线阶段为 0）
      this.flapReg ||= (() => { try { return JSON.parse(readFileSync(FLAP_REG, 'utf8')); } catch { return {}; } })();
      const known = this.flapReg[this.key(it.market)];
      t.createdAt = known || (isNew ? Date.now() : BOOT - 86400_000 - (this.curve.status.total - it.index) * 60_000);
      if (!known) this.flapQueue(t);
    }
    this.loadMeta(t, ipfsUrl(it.meta));
    if (isNew) this.emit('launch', { ...this.summary(t), detectMs: this.curve.status.lastPollMs });
  }

  flapQueue(t) {
    (this.flapQ ||= []).push(t);
    if (this.flapQRun) return; this.flapQRun = true;
    (async () => {
      while (this.flapQ.length) {
        const x = this.flapQ.shift();
        try { const ms = await fsi.firstTradeAt(x.market); if (ms > 0) { x.createdAt = ms; this.flapReg[this.key(x.market)] = ms; this.flapDirty = true; } } catch { /* 下次重启再补 */ }
        await new Promise((ok) => setTimeout(ok, 250));
        if (this.flapDirty && (!this.flapQ.length || this.flapQ.length % 20 === 0)) { try { writeFileSync(FLAP_REG, JSON.stringify(this.flapReg)); this.flapDirty = false; } catch { /* ignore */ } }
      }
      this.flapQRun = false;
    })();
  }

  // four.meme Agentic Wallet 专属内盘：新盘
  upsertFour(it, isNew) {
    const existed = this.tokens.has(this.key(it.token));
    const t = this.base(it.token);
    Object.assign(t, {
      source: 'four-agent', platform: 'four', agentExclusive: it.agentOnly !== false, presetId: it.agentOnly === false ? '' : String(AGENT_ID_TEMPLATE), symbol: it.symbol, name: it.name,
      quote: it.quote, quoteAddress: it.quoteAddress, creator: it.creator, target: it.raiseAmount, maxSupply: it.maxSupply, saleAmount: it.saleAmount,
      antiSniper: it.antiSniper, paused: it.paused,
    });
    if (!existed) {
      t.createdAt = it.createdAt; t.remaining = it.saleAmount;
      // 链上扫到创建事件的盘，之后的每笔成交都能看到（内盘期间代币不能转账），持有人可以直接按成交算；搜索地址补进来的看不到全部成交，不算
      t.holdersKnown = false; t.bal = new Map(); t.holders = null;
    }
    // 扫到了它的创建事件（不是搜索 / 重启补回来的）：之后的成交都在扫描范围内，从这里开始按成交算持有人
    if (it.agentOnly === undefined && !t.holdersKnown) { t.holdersKnown = true; t.bal = new Map(); t.holders = 0; }
    this.loadMeta(t, it.metaUri);
    if (!existed) this.fourSave();
    if (isNew) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - it.createdAt) });
  }

  // Four 盘登记表：链上 getLogs 只能回看约 2 万块（publicnode 不给归档），所以见过的盘都存到 data/fourTokens.json，重启后用 Core.tokens() 逐个补回
  fourSave() { clearTimeout(this.fourSaveT); this.fourSaveT = setTimeout(() => { try { const o = {}; for (const t of this.tokens.values()) if (t.source === 'four-agent') o[t.address] = { createdAt: t.createdAt, metaUri: t.metaUrl || null, stage: t.stage }; const old = this.fourReg || {}; mkdirSync(new URL('.', FOUR_REG), { recursive: true }); writeFileSync(FOUR_REG, JSON.stringify({ ...old, ...o })); this.fourReg = { ...old, ...o }; } catch { /* ignore */ } }, 3000); }
  async fourRestore() {
    try { this.fourReg = JSON.parse(readFileSync(FOUR_REG, 'utf8')); } catch { this.fourReg = {}; return; }
    for (const [a, r] of Object.entries(this.fourReg)) {
      if (this.tokens.has(a)) continue;
      try { const it = await this.four.lookup(a); const t = this.get(a); if (it && t) { if (r.createdAt) t.createdAt = r.createdAt; if (r.stage === 'dex') t.stage = 'dex'; this.loadMeta(t, r.metaUri); } } catch { /* ignore */ }
      await new Promise((ok) => setTimeout(ok, 400));
    }
  }
  // 迁移判定 + 外盘价格：DexScreener 批量查（每批 30 个，不占 RPC）；有 PancakeSwap 池子就算已迁移
  async fourDexCheck() {
    const list = [...this.tokens.values()].filter((t) => t.source === 'four-agent');
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      try {
        const r = await (await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + chunk.map((t) => t.address).join(','))).json();
        const best = {};
        for (const p of Array.isArray(r) ? r : []) { const a = String(p.baseToken?.address || '').toLowerCase(); if (!/pancake/i.test(p.dexId || '') || !+p.priceUsd) continue; if (!best[a] || (p.liquidity?.usd || 0) > (best[a].liquidity?.usd || 0)) best[a] = p; }
        for (const t of chunk) {
          const p = best[t.address]; if (!p) continue;
          const was = t.stage; const q = this.quoteUsd(t);
          Object.assign(t, { stage: 'dex', progress: 100, pair: p.pairAddress, dexLiqUsd: p.liquidity?.usd || 0, dexMcapUsd: +p.marketCap || +p.fdv || 0 });
          if (q) t.price = +p.priceUsd / q;
          if (was !== 'dex') { this.emit('migrate', this.summary(t)); this.fourSave(); }
        }
      } catch { /* 下次再查 */ }
      await new Promise((ok) => setTimeout(ok, 1200));
    }
  }

  // Flap Portal 门槛盘：名字 / 代号 / 图标（metaURI 是 IPFS CID）+ 门槛 NFT 信息 + 内盘状态
  async upsertFlapNft(g, { restore } = {}) {
    const k = g.token, existed = this.tokens.has(k);
    if (existed && this.get(k).source !== 'flap-nft') return;
    // 先同步登记进列表（门槛 + 来源），名字 / 状态 / NFT 信息随后补上：搜索、钱包 2 收到订单时不用等这些读取
    const t = this.base(k);
    if (g.meta) Object.assign(t, { symbol: t.symbol === '?' ? g.meta.symbol || '?' : t.symbol, name: t.name || g.meta.name || '' });   // 上次读到的名字先用上：节点限流时也不显示「?」
    Object.assign(t, { source: 'flap-nft', platform: 'flap', agentExclusive: g.nft === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f', quote: t.quote || 'BNB', createdAt: g.at || g.seenAt, maxSupply: 1e9,
      nftGate: { capPct: 2, ...t.nftGate, nft: g.nft, removed: !!g.removed, known: g.nft === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' } });
    {
      const [st, info] = await Promise.all([this.flapNftMeta(t).catch(() => {}), this.flapNft.state(k).catch(() => null), this.flapNft.nftInfo(g.nft).catch(() => null)]).then((r) => r.slice(1));
      if (!g.at && g.block) { try { g.at = (await this.provider.getBlock(g.block)).timestamp * 1000; this.flapNft.save(); } catch { /* 用发现时间 */ } }
      Object.assign(t, { createdAt: g.at || g.seenAt });
      if (info) Object.assign(t.nftGate, { name: info.name, symbol: info.symbol, image: info.image, known: info.known });
      if (st) await this.applyFlapNftState(t, st);
      this.flapNftHistory(t).then(() => { if (t.stage === 'dex') return this.dexRefresh(t).then(() => this.emit('detail', t.address)); }).catch(() => {});   // 内盘成交从创建起补齐；已迁移的顺便读一次外盘价，列表里市值不再是「—」
      await this.flapNftTax(t).catch(() => {});
      if (!existed && !restore && t.stage === 'curve') this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - (t.createdAt || Date.now())) });
    }
  }
  // 名字 / 代号 / 图标：读失败（节点限流等）时为空，代号留着「?」；flapNftTick 每 30 秒重试一次，直到读到为止
  async flapNftMeta(t) {
    t.metaTryAt = Date.now();
    const i = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function metaURI() view returns (string)']);
    const rd = (fn) => this.provider.call({ to: t.address, data: i.encodeFunctionData(fn) }).then((r) => i.decodeFunctionResult(fn, r)[0]).catch(() => '');
    const [name, symbol, meta] = await Promise.all([rd('name'), rd('symbol'), rd('metaURI')]);
    Object.assign(t, { symbol: symbol || t.symbol, name: name || t.name });
    if (name || symbol) this.emit('detail', t.address);
    // 读到的名字 / 代号 / 图标地址存进门槛盘登记表（data/flapNftGated.json），重启后直接用，不再依赖这一次读取成功
    const g = this.flapNft.reg?.tokens?.[t.address];
    this.loadMeta(t, ipfsUrl(meta) || g?.meta?.uri);
    if (g && (name || symbol || meta)) { const m = { ...g.meta, ...(name && { name }), ...(symbol && { symbol }), ...(meta && { uri: ipfsUrl(meta) }) }; if (JSON.stringify(m) !== JSON.stringify(g.meta || {})) { g.meta = m; this.flapNft.save(); } }
  }
  async applyFlapNftState(t, st) {
    if (st.quote !== ethers.ZeroAddress && t.quoteAddress?.toLowerCase() !== st.quote.toLowerCase()) {
      t.quoteAddress = st.quote; t.quote = await this.provider.call({ to: st.quote, data: '0x95d89b41' }).then((r) => ethers.AbiCoder.defaultAbiCoder().decode(['string'], r)[0]).catch(() => '?');
      t.flapNativeSwap = st.nativeSwap;
    }
    const price = Number(ethers.formatEther(st.price));
    t.raised = Number(ethers.formatEther(st.reserve)); t.progress = st.status === 4 ? 100 : Math.min(100, st.progress);
    t.target = t.progress > 0 && t.progress < 100 ? t.raised / (t.progress / 100) : t.target;
    t.remaining = Math.max(0, Number(ethers.formatEther(st.dexThresh)) - Number(ethers.formatEther(st.circulating)));
    // 有链上成交以后 K 线只按成交画（成交时间、成交后价格）；还没补到成交时才用轮询价格兜底。已迁移的内盘价格读出来是 0，不覆盖
    if (price > 0 && price !== t.price) { t.price = price; if (!t.nftHistAt && !t.nftKeys?.size) this.pushCandle(t, Date.now(), price, 0); }
    if (st.status !== 4 && t.price > 0) t.mcapUsd = t.price * 1e9 * this.quoteUsd(t);
    if (st.status === 4 && t.stage === 'curve') { t.stage = 'dex'; t.progress = 100; this.emit('migrate', this.summary(t)); }
    else if (st.status === 1 && !t.migrated) t.stage = 'curve';
  }
  // 税率 / 受益人 / 分红：读链上（flapNft.taxInfo），5 分钟刷新一次（累计分红、营销金额会变）
  async flapNftTax(t, force = false) {
    if (!force && t.flapTax && Date.now() - t.flapTax.at < 300_000) return;
    const v = await this.flapNft.taxInfo(t.address); t.flapTax = v;
    t.buyTax = v.buyBps / 100; t.sellTax = v.sellBps / 100;
    const q = v.divSym === 'BNB' ? this.bnbUsd : 0;
    t.gangDiv = { flap: true, taxed: v.divBps > 0, taxBps: Math.round(Math.max(v.buyBps, v.sellBps) * v.divBps / 10000), vault: v.divContract || null,
      stats: v.divBps > 0 ? { quoteSymbol: v.divSym || '?', total: v.sentDiv, totalUsd: q ? v.sentDiv * q : null } : null };
  }
  // 门槛盘数量很少（每天几个）：内盘的每 6 秒读一次 Portal 状态（价格 / 进度 / 是否迁移）；已迁移的交给外盘逻辑
  async flapNftTick() {
    if (this.nftBusy) return; this.nftBusy = true;
    try {
      for (const t of [...this.tokens.values()].filter((x) => x.source === 'flap-nft')) {
        if (t.stage === 'curve') try { await this.applyFlapNftState(t, await this.flapNft.state(t.address)); await this.flapNftTax(t); } catch { /* 下一轮 */ }
        // 名字没读到就重试（已迁移的也要：以前只重试内盘，迁移盘读失败一次就一直显示「?」）
        if ((!t.name || t.symbol === '?' || !t.metaUrl) && Date.now() - (t.metaTryAt || 0) > 30_000) await this.flapNftMeta(t).catch(() => {});
      }
    } finally { this.nftBusy = false; }
  }

  // 图标 / 简介 / 社交链接，异步补上；列表每 0.5 秒推送一次，到了就显示
  loadMeta(t, url) {
    if (!url || t.metaUrl === url) return;
    t.metaUrl = url;
    this.meta.get(url, (m) => { Object.assign(t, m); this.emit('detail', t.address); });
  }

  // 搜索粘贴地址：已在列表直接返回；否则查 Four 链上，查到就加进列表
  async lookup(address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    let t = this.get(address);
    if (!t && await this.four.lookup(address)) t = this.get(address);
    if (!t) t = await this.lookupGangV2(address).catch(() => null);
    if (!t && await this.flapNft.check(address).catch(() => null)) t = this.get(address);
    if (!t) t = await this.lookupFair(address).catch(() => null);
    if (!t) return null;
    t.pinned = true;               // 手动打开的盘不被自动淘汰
    return this.summary(t);
  }

  // Gang V2 新盘：本后端的订阅还没看到、但主后端已经发来狙击订单时（钱包 2 等），直接读链上曲线把它加进列表
  async lookupGangV2(address) {
    this._gv2 ||= new GangV2(this.provider, null);
    const { c } = await this._gv2.curve(address);
    const erc = new ethers.Contract(address, ['function name() view returns (string)', 'function symbol() view returns (string)'], this.provider);
    const [name, symbol] = await Promise.all([erc.name().catch(() => ''), erc.symbol().catch(() => '?')]);
    const q = String(c.quote).toLowerCase(), quoteSymbol = q === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' || c.quote === ethers.ZeroAddress ? 'BNB' : await this.gangChain.symbolOf(q);
    if (this.get(address)) return this.get(address);   // 读链期间订阅已经收录
    this.upsertGang({ address: address.toLowerCase(), name, symbol, creator: String(c.creator).toLowerCase(), createdAt: Math.floor(Date.now() / 1000), graduated: !!c.graduated, raisedQuote: 0, progressPct: 0, quoteSymbol, quoteAddress: q, track: c.v3 ? 'v3' : 'v2', taxed: !!c.taxed }, false);
    return this.get(address);
  }

  // Gang V3 曲线盘 + 打新盘：以前只靠链上 Created 事件收录，重启后之前创建的都没了。启动时和每 30 秒从 gang.fun 列表补齐：
  // V3 = /api/v3/tokens（没毕业的 + 24 小时内毕业的），打新 = /api/fair/sales 的认购中 + 24 小时内开盘的（进度等从 pad 读，见 gangFairState）
  async loadFairSales() {
    const day = Date.now() / 1000 - 86_400;
    try {
      const j = await fetch('https://gang.fun/api/v3/tokens?limit=100', { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
      for (const x of j?.items || []) {
        if (!x?.address || this.get(x.address) || (x.graduated && !(x.graduatedAt > day))) continue;
        const qa = String(x.quoteAddress || '').toLowerCase(), dec = Number(x.quoteDecimals) || 18;
        this.upsertGang({ address: x.address.toLowerCase(), name: x.name, symbol: x.symbol, creator: String(x.creator || '').toLowerCase(), creatorHandle: x.creatorHandle, logo: x.hasLogo ? x.logoUrl : null,
          createdAt: x.createdAt || Math.floor(Date.now() / 1000), graduated: !!x.graduated, graduatedAt: x.graduatedAt || null, pair: x.pair || null, quoteAddress: qa,
          quoteSymbol: qa === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' ? 'BNB' : x.quoteSymbol, raisedQuote: Number(ethers.formatUnits(BigInt(x.realQuote || 0), dec)), progressPct: Number(x.progressPct) || 0,
          gradAmtQuote: Number(ethers.formatUnits(BigInt(x.gradAmt || 0), dec)) || undefined, priceQuote: Number(x.priceQuote) || 0, trades: x.trades || 0, track: 'v3', taxed: Number(x.dividendBps) > 0 }, false);
        const t = this.get(x.address); if (t && !x.graduated) this.gangV2Curve(t).catch(() => {});
      }
    } catch { /* 下次再补 */ }
    const lists = await Promise.all(['minting', 'launched'].map((st) => fairList(st).catch(() => [])));
    for (const x of lists.flat()) {
      if (this.get(x.token) || (x.status === 'launched' && !(x.createdAt > day))) continue;
      this.upsertGang({ address: x.token.toLowerCase(), name: x.name, symbol: x.symbol, creator: String(x.creator || '').toLowerCase(), creatorHandle: x.creatorHandle, logo: x.logo, createdAt: x.createdAt || Math.floor(Date.now() / 1000),
        graduated: x.status === 'launched', raisedQuote: 0, progressPct: 0, quoteSymbol: 'BNB', quoteAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', track: 'v3fair' }, false);
    }
  }
  // 搜索 / 下单时本后端还没收录的打新币：pad.sales() 有这个币就加进来
  async lookupFair(address) {
    const I = new ethers.Interface(['function sales(address) view returns (address creator)', 'function name() view returns (string)', 'function symbol() view returns (string)']);
    const r = await this.provider.call({ to: '0x15cfd2dc8278fb87a1783ef42111618e20874365', data: I.encodeFunctionData('sales', [address]) });
    const creator = ethers.AbiCoder.defaultAbiCoder().decode(['address'], r.slice(0, 66))[0];
    if (creator === ethers.ZeroAddress) return null;
    const rd = (fn) => this.provider.call({ to: address, data: I.encodeFunctionData(fn) }).then((x) => I.decodeFunctionResult(fn, x)[0]).catch(() => '');
    const [name, symbol] = await Promise.all([rd('name'), rd('symbol')]);
    if (!this.get(address)) this.upsertGang({ address: address.toLowerCase(), name, symbol: symbol || '?', creator: creator.toLowerCase(), createdAt: Math.floor(Date.now() / 1000), graduated: false, raisedQuote: 0, progressPct: 0, quoteSymbol: 'BNB', quoteAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', track: 'v3fair' }, false);
    const t = this.get(address); await this.gangFairState(t).catch(() => {}); return t;
  }

  // gang.fun：接口给的列表（已筹 / 进度 / 价格 / FDV / 持有人）；毕业门槛按 已筹 ÷ 进度 推算
  upsertGang(it, isNew) {
    const existed = this.tokens.has(this.key(it.address));
    const t = this.base(it.address);
    const qa = String(it.quoteAddress || '').toLowerCase();
    if (t._qDec == null && qa && QUOTE_DEC[qa]) t._qDec = QUOTE_DEC[qa];   // 已知的非 18 位报价币（XAUt 6 位、BEM 8 位）马上用，不等链上曲线
    else if (t._qDec == null && qa && (it.track === 'v2' || it.track === 'v3') && qa !== '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') { this._gv2 ||= new GangV2(this.provider, null); this._gv2.decimals(qa).then((d) => { t._qDec ??= d; }).catch(() => {}); }
    const raised = Number(it.raisedQuote ?? it.raisedBnb) || 0, pct = Number(it.progressPct) || 0;
    Object.assign(t, {
      source: 'gang', platform: 'gang', agentExclusive: true, symbol: it.symbol, name: it.name, quote: it.quoteSymbol || 'BNB', quoteAddress: it.quoteAddress || null, creator: it.creator,
      creatorName: it.creatorHandle || null, feeBps: 100, sellFeeBps: 100, stage: it.graduated ? 'dex' : 'curve', migratedAt: it.graduatedAt ? it.graduatedAt * 1000 : t.migratedAt, raised: t._qDec && t._qDec !== 18 ? t.raised : raised, progress: pct, target: t._qDec && t._qDec !== 18 ? t.target : it.gradAmtQuote || (pct > 0 ? Math.round((raised / (pct / 100)) * 10) / 10 : (t.target || 15)),   /* 非 18 位报价币（XAUt）接口按 18 位给，数会小 1e12 倍，用链上读的 */ gangTrack: /^v3/.test(t.gangTrack || '') ? t.gangTrack : it.track || 'v1' /* 链上认出的 V3 不被接口的 v2 覆盖 */, remaining: t._v2Rem ?? null,   // 剩余可售：V2 从合约读，读到之前 / 老盘未知 = null（页面显示「—」）
     
      price: (t._qDec && t._qDec !== 18 ? 0 : Number(it.priceQuote ?? it.priceBnb)) || t.price, mcapUsd: (t._qDec && t._qDec !== 18 ? 0 : Number(it.fdvUsd)) || t.mcapUsd || 0, holders: it.holders ?? null,   // 币股等报价币盘接口常不给 fdvUsd，别把成交算出的市值覆盖成 0 volume: Number(it.volume24hBnb) || 0, pair: it.pair || null, tradeCount: it.trades || 0,
    });
    if (t.gangTrack === 'v3fair' && t._fair) this.applyFair(t);   // 打新币：接口 / 链上事件按内盘给的 0/15、curve 不对，用 pad 读到的覆盖
    else if (t.gangTrack === 'v3fair' && !t._fairAt) this.gangFairState(t).catch(() => {});   // 新打新盘（链上 Created 事件刚进来）：马上读一次 pad，不等 15 秒轮询
    if (!existed) t.createdAt = it.createdAt * 1000;
    if (it.lastTradeAt) t.lastTradeAt = Math.max(t.lastTradeAt || 0, it.lastTradeAt * 1000);
    if (it.creatorHandle) this.names.set(it.creator, it.creatorHandle);
    if (it.logo) t.image = it.logo;
    if (it.taxed != null) t.gangDiv = { taxed: !!it.taxed, taxBps: it.taxBps ?? (it.taxed ? 100 : 0), vault: it.dividendVault || t.gangDiv?.vault || null, stats: it.dividends || t.gangDiv?.stats || null };   // 分红币 / 不分红（见 gangFun.fromV2）
    // V2 报价币（GANG / ZEC / 币股…）的美元价用 gang.fun 给的，quoteUsd() 换美元要用
    if (it.quoteAddress && it.quoteUsd && !(this.qUsd[it.quoteAddress.toLowerCase()] > 0)) this.qUsd[it.quoteAddress.toLowerCase()] = it.quoteUsd;
    if (isNew && !existed) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - t.createdAt) });   // 链上已经先发现过的，接口再看到时不重复提示
    // 最近有成交的几个 + 当前选中的，定时拉成交
    const hot = [...this.tokens.values()].filter((x) => x.source === 'gang' && x.lastTradeAt).sort((a, b) => b.lastTradeAt - a.lastTradeAt).slice(0, 5).map((x) => x.address);
    this.gang.setHot(hot);
  }

  // Feast（feast.meme）：接口给的池子 + 24 小时快照。真池子没有曲线也没有迁移，一直按「内盘」处理（stage = curve，进度 100）；
  // 价格用报价币单位（WBNB 池 = BNB；币股池换美元靠 quoteUsd），市值优先用快照给的 BNB 市值
  upsertFeast(it, isNew) {
    const existed = this.tokens.has(this.key(it.address));
    const t = this.base(it.address);
    Object.assign(t, {
      source: 'feast', platform: 'feast', agentExclusive: false, symbol: it.symbol, name: it.name, quote: it.quoteSymbol, quoteAddress: it.quoteAddress, creator: it.creator,
      feeBps: it.hookFeeBps, sellFeeBps: it.hookFeeBps, stage: 'curve', progress: 100, raised: 0, target: 0, maxSupply: 1e9, holders: it.holders ?? t.holders ?? null,
      price: it.priceQuote || t.price, volume: Number(it.volume24hBnb) || 0, tradeCount: it.trades24h || 0,
      feastPool: { poolId: it.poolId, feeSplitBps: it.feeSplitBps, opening: it.opening, isStock: it.isStock, windows: it.windows },
    });
    if (it.mcapBnb && this.bnbUsd) t.mcapUsd = it.mcapBnb * this.bnbUsd;
    if (!existed) t.createdAt = it.createdAt * 1000;
    if (it.lastTradeAt) t.lastTradeAt = Math.max(t.lastTradeAt || 0, it.lastTradeAt * 1000);
    if (isNew && !existed) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - t.createdAt) });
  }

  // 链上发现的 Gang 新盘：先上列表（名称、符号、创建者、计价币都来自事件），市值 / 头像等等接口轮询补上
  onGangChainToken(it) {
    // 链上订阅先推送、后补区块时间（it.timeP）：延迟统计和日志等真实区块时间到了再记，币的创建时间也随之改正
    const apiFirst = this.tokens.has(this.key(it.address));
    Promise.resolve(it.timeP).then((ts) => {
      if (ts != null) { it.createdAt = ts; const t = this.get(it.address); if (t && it.fromChain && !apiFirst) t.createdAt = ts * 1000; }
      const lat = it.seenAt - it.createdAt * 1000;
      (this.gangLat ||= []).unshift({ symbol: it.symbol, address: it.address, block: it.block, createdAt: it.createdAt * 1000, seenAt: it.seenAt, latencyMs: lat, viaApiFirst: apiFirst }); this.gangLat.length = Math.min(this.gangLat.length, 20);
      console.log(`[Gang 链上] 新盘 ${it.symbol}（${it.track === 'v3' ? 'V3 · ' + it.quoteSymbol : it.track === 'v3fair' ? 'V3 打新 · ' + it.quoteSymbol : it.track === 'v2' ? 'V2 · ' + it.quoteSymbol : '老盘 · BNB'}）区块 ${it.block}，出块后 ${lat}ms 发现${apiFirst ? '（接口已先收录）' : ''}`);
    });
    if (this.tokens.has(this.key(it.address))) return;
    this.gang.seen.set(it.address, -1);
    this.upsertGang(it, true);
    const t = this.get(it.address);
    if (t && it.track === 'v3fair') this.gangFairState(t).catch(() => {});
    if (t && (it.track === 'v2' || it.track === 'v3')) this.gangV2Curve(t).then(() => { if (!(t.price > 0) && t.launchPrice > 0) { t.price = t.launchPrice; const q = this.quoteUsd(t); if (q && !(t.mcapUsd > 0)) t.mcapUsd = t.price * 1e9 * q; } }).catch(() => {});
  }

  // 链上 Flap 成交（virtualBuyFill / virtualSellFill）：金额是报价币单位，和其他平台一致；按 tx + 方向去重（shrine 若也推了同一笔不会重复）
  onFlapChainTrade(tr) {
    const t = this.get(tr.token); if (!t || t.source !== 'agent-curve') return;
    if (t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    const trade = { ts: tr.ts || Date.now(), side: tr.side, bnb: tr.bnb, tokens: tr.tokens, price: tr.price, trader: tr.trader, tx: tr.tx };
    this.addTrade(t, trade);
    const q = this.quoteUsd(t); if (q && tr.price > 0) t.mcapUsd = tr.price * (t.maxSupply || 1e9) * q;
    this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: tr.bnb * q, mcapUsd: t.mcapUsd });
  }

  // Flap Portal 门槛盘成交（flapNft.js 读 TokenBought / TokenSold）：金额是报价币单位，价格 = 成交后价格；按 tx:logIndex 去重
  ingestFlapNft(t, tr) {
    const key = `${tr.tx}:${tr.idx}`; t.nftKeys ||= new Set(); if (t.nftKeys.has(key)) return null; t.nftKeys.add(key);
    if (tr.side === 'buy') t.buys++; else t.sells++;
    t.volume += tr.bnb;
    if (t.holdersKnown && tr.trader) {
      const v = (t.bal.get(tr.trader) || 0) + (tr.side === 'buy' ? tr.tokens : -tr.tokens);
      if (v > 1e-6) t.bal.set(tr.trader, v); else t.bal.delete(tr.trader);
      t.holders = t.bal.size;
    }
    return { ts: tr.ts, side: tr.side, bnb: tr.bnb, tokens: tr.tokens, price: tr.price, trader: tr.trader, tx: tr.tx };
  }
  onFlapNftTrade(tr) {
    const t = this.get(tr.token); if (!t || t.source !== 'flap-nft') return;
    const trade = this.ingestFlapNft(t, tr); if (!trade) return;
    if (t.stage === 'curve' && tr.ts >= (t.lastTradeAt || 0)) { const q = this.quoteUsd(t); if (q && tr.price > 0) t.mcapUsd = tr.price * 1e9 * q; }
    this.addTrade(t, trade);
    if (Date.now() - tr.ts < 60_000) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: tr.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });
  }
  // 从创建起的全部内盘成交重建：买卖笔数、成交量、持有人（净买入 > 0 的地址）、K 线（换掉轮询价格画的点，外盘部分留着）、最近 100 笔
  async flapNftHistory(t, urgent = false) {
    if (t.nftHistAt && Date.now() - t.nftHistAt < 30_000) return;
    const list = await this.flapNft.history(t.address, urgent);
    Object.assign(t, { nftKeys: new Set(), buys: 0, sells: 0, volume: 0, holdersKnown: true, bal: new Map(), holders: 0, nftHistAt: Date.now() });
    t.candles = (t.candles || []).filter((c) => c.dex); t.trades = (t.trades || []).filter((x) => x.dex);
    const q = this.quoteUsd(t), keep = [];
    for (const tr of list) { const x = this.ingestFlapNft(t, tr); if (!x) continue; this.noteFirstBuy(t, x); if (x.price) this.pushCandle(t, x.ts, x.price, x.bnb); keep.push(x); }
    for (const x of keep.slice(-100)) { x.usd = x.bnb * q; x.mcapUsd = x.price * 1e9 * q; x.name = this.names.peek(x.trader); }
    t.trades = [...keep.slice(-100), ...t.trades].sort((a, b) => b.ts - a.ts).slice(0, 100);
    const last = keep.at(-1);
    if (last) { t.lastTradeAt = Math.max(t.lastTradeAt || 0, last.ts); if (t.stage === 'curve') { t.price = last.price; if (q) t.mcapUsd = last.price * 1e9 * q; } else if (!(t.price > 0)) { t.price = last.price; if (q) t.mcapUsd = last.price * 1e9 * q; } }
    if (t.stage === 'dex') Object.assign(t, { holdersKnown: false, holders: null });   // 迁移以后外盘转账不经过 Portal，内盘算出来的持有人不准，不显示
    t._chgAt = 0;
  }

  // Four：从创建起的全部成交（fourMeme.tokenTrades，走 MySQL 缓存只补新区块）→ 内盘 K 线、最近 100 笔、买卖笔数和成交量。外盘 K 线（dex）留着
  async fourHistory(t) {
    const list = await this.four.tokenTrades(t.address); if (!list.length) return;
    const q = this.quoteUsd(t);
    t.candles = (t.candles || []).filter((c) => c.dex);
    let buys = 0, sells = 0, vol = 0;
    for (const x of list) { if (x.side === 'buy') buys++; else sells++; vol += x.bnb || 0; if (x.price) this.pushCandle(t, x.ts, x.price, x.bnb || 0); }
    Object.assign(t, { buys: Math.max(t.buys || 0, buys), sells: Math.max(t.sells || 0, sells), volume: Math.max(t.volume || 0, vol) });
    const seen = new Set(t.trades.map((x) => `${x.tx}:${x.side}`));
    for (const x of list.slice(-100)) if (!seen.has(`${x.tx}:${x.side}`)) t.trades.push({ ts: x.ts, side: x.side, bnb: x.bnb, tokens: x.tokens, price: x.price, trader: x.trader, tx: x.tx, usd: x.bnb * q, mcapUsd: x.price * (t.maxSupply || 1e9) * q, name: this.names.peek(x.trader) });
    t.trades.sort((a, b) => b.ts - a.ts); if (t.trades.length > 100) t.trades.length = 100;
    t.lastTradeAt = Math.max(t.lastTradeAt || 0, list.at(-1).ts); t._chgAt = 0;
  }

  // Flap Agent 曲线：fsi 成交记录。有 MySQL 缓存时只拉最新一页（每边 200 笔），接不上库里最新那笔才整份重拉（每边 5000 笔）
  async fsiHistory(t) {
    return cache.history('fsi', t.market, async (cur, old) => {
      if (cur && old?.rows.length) {
        const page = await fsi.fetchTrades(t.market, 200);
        const gap = ['buy', 'sell'].some((sd) => { const a = page.filter((x) => x.side === sd); return a.length >= 200 && a.at(-1).ts > cur; });
        if (!gap) return { rows: page, cursor: Math.max(cur, ...page.map((x) => x.ts)) };
      }
      const all = await fsi.fetchTrades(t.market, 5000);
      return { rows: all, cursor: all.length ? Math.max(...all.map((x) => x.ts)) : null };
    }, (x) => `${x.tx}:${x.side}:${x.tokens}`);
  }

  onGangTrade(tr, live) {
    const t = this.get(tr.token); if (!t || t.source !== 'gang') return;
    // 去重要看所有见过的成交，不能只看留着的最近 100 笔：选中时一次拉 200 笔，更早的那些以前会被当成新成交重复加，
    // 把价格改回旧成交的价、买卖笔数越加越多
    const id = `${tr.tx}:${tr.side}:${tr.tokens}`; t.seenTx ||= new Set();
    if (tr.tx && (t.seenTx.has(id) || t.trades.some((x) => x.tx === tr.tx && x.side === tr.side))) return;
    if (tr.tx) { t.seenTx.add(id); if (t.seenTx.size > 5000) t.seenTx = new Set([...t.seenTx].slice(-2500)); }
    if (tr.name) this.names.set(tr.trader, tr.name);
    if (tr.side === 'buy') t.buys++; else t.sells++;
    if (t.gangTrack === 'v3') t.volume = (t.volume || 0) + tr.bnb * this.qScale(t);   // V3 内盘成交量：开盘起的从链上历史算（gangV3History），之后的实时累加
    // 链上事件和 gang.fun 接口都把报价币金额按 18 位小数给；BEM（8 位）、XAUt（6 位）这类要乘回 10^(18-dec)
    const k = this.qScale(t);
    const trade = { ts: tr.ts, side: tr.side, bnb: tr.bnb * k, tokens: tr.tokens, price: tr.price * k, trader: tr.trader, tx: tr.tx, name: tr.name };
    this.addTrade(t, trade);
    if (k !== 1 && trade.price > 0 && trade.ts >= (t.lastTradeAt || 0) - 1) { const u = this.quoteUsd(t); if (u) t.mcapUsd = t.price * 1e9 * u; }   // 接口的 fdvUsd 也按 18 位算错了，用成交价重算
    if (live) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: trade.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });   // Gang V2 的金额是报价币（GANG / BNCB…），按报价币价格换美元
  }

  // Gang V3 曲线盘从开盘起的全部成交（pad 的链上 Buy / Sell，真实出块时间）→ 重建内盘 K 线、买卖笔数、成交量，最近 100 笔换成带真实时间的。
  // 第一次从创建前一点的区块查起，之后只补新区块（15 秒内不重复查）。返回新增的笔数
  async gangV3History(t) {
    const h = t._v3Hist ||= { rows: [], block: 0, at: 0 };
    if (h.busy) return h.busy;
    if (Date.now() - h.at < 15_000) return 0;
    h.busy = (async () => {
      this._gv2 ||= new GangV2(this.provider, null);
      const { pad } = await this._gv2.curve(t.address);
      const head = await this.provider.getBlockNumber();
      if (!h.block) {   // 按平均出块时间从创建时间倒推起始区块，多往前 600 块
        const [a, b] = await Promise.all([this.provider.getBlock(head), this.provider.getBlock(head - 10_000)]);
        let c = t.createdAt || (a.timestamp - 86_400) * 1000; if (c > 1e14) c /= 1000;   // 接口给毫秒时 createdAt 会被多乘一次 1000
        const bt = (a.timestamp - b.timestamp) / 10_000 || 0.45, age = Math.max(0, a.timestamp - Math.floor(c / 1000));
        h.block = Math.max(1, head - 400_000, head - Math.ceil(age / bt) - 600) - 1;
      }
      // 每 2000 块记一次进度：中途被限流 / 出错，下次从断点接着查，不从头重来；出错 60 秒后再试
      const seen = new Set(h.rows.map((x) => `${x.tx}:${x.side}:${x.tokens}`)); let n = 0;
      try {
        while (h.block < head) {
          const to = Math.min(head, h.block + 2000);
          for (const x of await this.gangPads.history(t.address, pad, h.block + 1, to)) { const id = `${x.tx}:${x.side}:${x.tokens}`; if (!seen.has(id)) { seen.add(id); h.rows.push(x); n++; } }
          h.block = to;
        }
      } finally { h.at = Date.now() + (h.block < head ? 45_000 : 0); if (n) this.applyV3History(t); }
      return n;
    })().finally(() => { h.busy = null; });
    return h.busy;
  }
  v3Row(t, x) { const k = this.qScale(t); return { ts: x.ts, side: x.side, bnb: x.bnb * k, tokens: x.tokens, price: x.price * k, trader: x.trader, tx: x.tx }; }
  applyV3History(t) {
    const rows = (t._v3Hist?.rows || []).map((x) => this.v3Row(t, x)); if (!rows.length) return;
    const last = rows.at(-1), tx = new Set(rows.map((x) => `${x.tx}:${x.side}`));
    // 历史之后才到的实时成交（还没进历史的）补在后面，K 线不会少最新一两笔
    const live = (t.trades || []).filter((x) => !tx.has(`${x.tx}:${x.side}`) && x.ts > last.ts && !x.dex);
    t.candles = (t.candles || []).filter((c) => c.dex);
    let buys = 0, sells = 0, vol = 0;
    for (const x of [...rows, ...live.slice().reverse()]) { if (x.side === 'buy') buys++; else sells++; vol += x.bnb || 0; if (x.price > 0) this.pushCandle(t, x.ts, x.price, x.bnb || 0); }
    Object.assign(t, { buys, sells, volume: vol });
    t.seenTx ||= new Set(); for (const x of rows) t.seenTx.add(`${x.tx}:${x.side}:${x.tokens}`);
    const q = this.quoteUsd(t), old = new Map((t.trades || []).map((x) => [`${x.tx}:${x.side}`, x]));
    const keep = rows.slice(-100).map((x) => { const o = old.get(`${x.tx}:${x.side}`); return { ...x, name: o?.name || this.names.peek(x.trader), usd: x.bnb * q, mcapUsd: x.price * 1e9 * q }; });
    t.trades = [...keep, ...(t.trades || []).filter((x) => !tx.has(`${x.tx}:${x.side}`))].sort((a, b) => b.ts - a.ts).slice(0, 100);
    for (const x of rows) this.noteFirstBuy(t, x);
    t.lastTradeAt = Math.max(t.lastTradeAt || 0, last.ts); t._chgAt = 0;
  }

  // 报价币不是 18 位小数时，18 位口径的金额 / 价格要乘的倍数（BEM 8 位 = 1e10）
  qScale(t) { return t._qDec && t._qDec !== 18 ? 10 ** (18 - t._qDec) : 1; }

  // four.meme 成交：更新已筹、进度、价格、K 线和成交列表
  onFourTrade(tr) {
    const t = this.get(tr.token); if (!t || t.source !== 'four-agent') return;
    if (tr.tx && t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    // 同一模板的盘开盘价都一样：记下「几乎没筹到钱时」的最低成交价，当作还没成交的新盘的开盘价，用来估市值
    if (tr.price > 0 && tr.raised < 0.05) this.fourP0 = Math.min(this.fourP0 || Infinity, tr.price);
    Object.assign(t, { raised: tr.raised, remaining: tr.remaining, progress: t.target ? Math.min(100, (tr.raised / t.target) * 100) : 0, stage: tr.remaining <= 0 ? 'dex' : 'curve' });
    if (tr.side === 'buy') t.buys++; else t.sells++;
    t.volume += tr.bnb;
    // 持有人 = 净买入数量 > 0 的地址数
    if (t.holdersKnown && tr.trader) {
      const k = tr.trader.toLowerCase(); const v = (t.bal.get(k) || 0) + (tr.side === 'buy' ? tr.tokens : -tr.tokens);
      if (v > 1e-6) t.bal.set(k, v); else t.bal.delete(k);
      t.holders = t.bal.size;
    }
    // 费率按最近一笔真实成交倒推：买入 =（付出 − 进曲线）/ 付出；卖出 =（曲线给出 − 到手）/ 曲线给出。含代币税 + 平台费 + 开发者费 + 防狙击税
    if (tr.curveBnb > 0) {
      if (tr.side === 'buy' && tr.bnb > 0) { t.feeBps = Math.max(0, Math.round(((tr.bnb - tr.curveBnb) / tr.bnb) * 10000)); t.buyTax = (tr.taxFee / tr.curveBnb) * 100; t.antiSniperPct = (tr.antiSniperFee / tr.curveBnb) * 100; t.feeAt = tr.ts; }
      if (tr.side === 'sell') { t.sellFeeBps = Math.max(0, Math.round(((tr.curveBnb - tr.bnb) / tr.curveBnb) * 10000)); t.sellTax = (tr.taxFee / tr.curveBnb) * 100; }
    }
    t.price = tr.price; t.mcapUsd = tr.price * (t.maxSupply || 1e9) * this.quoteUsd(t);
    const trade = { ts: tr.ts, side: tr.side, bnb: tr.bnb, tokens: tr.tokens, price: tr.price, trader: tr.trader, tx: tr.tx };
    this.addTrade(t, trade);
    if (Date.now() - tr.ts < 60_000) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: tr.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });
  }

  upsertShrine(l) {
    if (!l.token) return;
    // 列表只来自链上：Flap 用 Agent Curve Reader，Four 用 Agentic Wallet 专属模板事件；shrine 只给已有的盘补充信息
    if (!this.tokens.has(this.key(l.token))) return;
    const isNew = !this.tokens.has(this.key(l.token));
    const t = this.base(l.token);
    const created = sec2ms(l.timestamp || l.createdAt);
    Object.assign(t, {
      source: t.source === 'agent-curve' ? 'agent-curve' : 'shrine', platform: l.protocol === 'FOURMEME' ? 'four' : 'flap',
      agentExclusive: t.agentExclusive || isAgentish(l), symbol: l.symbol || t.symbol, name: l.name || t.name,
      quote: String(l.quoteAsset?.symbol || (String(l.quoteToken || '').startsWith('0x') ? 'BNB' : l.quoteToken) || 'BNB').toUpperCase(),
      quoteAddress: l.quoteAddress || t.quoteAddress, creator: l.creator || t.creator, market: l.market || t.market,
      antiSniper: l.antiSniper ?? t.antiSniper, createdAt: isNew ? Math.min(Date.now(), created) : t.createdAt,
    });
    if (num(l.marketCap)) t.mcapUsd = num(l.marketCap);
    if (isNew) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - created) });
  }

  onStreamTrade(m) {
    const t = this.get(m.token); if (!t) return;
    const price = num(m.priceFormatted) ?? (num(m.price) ? num(m.price) / 1e18 : null);
    const bnb = num(m.quoteAmountFormatted) || 0;
    const trade = { ts: sec2ms(m.timestamp), side: m.type, bnb, tokens: num(m.tokenAmountFormatted) || 0, price: price || t.price, trader: m.trader, tx: m.txHash };
    this.addTrade(t, trade);
    if (num(m.marketCap)) t.mcapUsd = num(m.marketCap);
    this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });
  }

  // 记下这个币最早的一笔买入（trades 只留 100 条，所以单独存）
  noteFirstBuy(t, tr) { if (tr?.side === 'buy' && tr.trader && (!t.firstBuy || tr.ts < t.firstBuy.ts)) t.firstBuy = { ts: tr.ts, trader: tr.trader }; }

  addTrade(t, tr) {
    if (tr.tx && t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    this.noteFirstBuy(t, tr);
    tr.usd = tr.bnb * this.quoteUsd(t); tr.mcapUsd = t.mcapUsd; tr.name = this.names.peek(tr.trader);
    t.trades.unshift(tr); t.trades.sort((a, b) => b.ts - a.ts); if (t.trades.length > 100) t.trades.length = 100;
    if (tr.price) { if (tr.ts >= (t.lastTradeAt || 0)) t.price = tr.price; this.pushCandle(t, tr.ts, tr.price, tr.bnb); }   // 补进来的旧成交只画 K 线，不改现价
    t.lastTradeAt = Math.max(t.lastTradeAt || 0, tr.ts);
    this.flow.unshift({ ...tr, address: t.address, symbol: t.symbol, platform: t.platform }); if (this.flow.length > 150) this.flow.length = 150;
  }

  pushCandle(t, ts, price, vol) {
    const b = Math.floor(ts / 1000);
    let i = t.candles.length - 1; while (i >= 0 && t.candles[i].t > b) i--;
    const c = t.candles[i];
    if (c && c.t === b) { c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.v += vol; }
    else { const o = c ? c.c : price; t.candles.splice(i + 1, 0, { t: b, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: vol }); if (t.candles.length > 4000) t.candles.shift(); }
  }

  // 已迁移（dex）的币：读 PancakeSwap V2 池子的 Swap 事件（dexFeed.js），接在内盘 K 线后面，并补成交列表、24 小时外盘成交量、底池、现价。
  // 第一次最多等 2.5 秒，补不完的历史在后台接着补，补到了再推一次详情。找不到池子（或链上读不到）时退回 GeckoTerminal 分钟 K 线
  async dexRefresh(t) {
    const run = this.dexFeed.sync(t).then((n) => { if (n) { this.applyDex(t); this.emit('detail', t.address); } }).catch(() => {});
    const has = () => t.dexSwaps?.length || t.dexHist?.length;
    if (!has()) await Promise.race([run, new Promise((r) => setTimeout(r, 2500))]);
    if (has()) this.applyDex(t); else await this.dexCandles(t);
  }
  applyDex(t) {
    const s = t.dexSwaps || [], bars = dexBars(s, t.dexHist || []); if (!bars.length) return;
    const q = this.quoteUsd(t); this.joinDex(t, bars);
    const last = s[s.length - 1]; t.price = last ? last.price : bars[bars.length - 1].c; if (last) t.lastTradeAt = Math.max(t.lastTradeAt || 0, last.ts);
    if (q) { t.mcapUsd = t.dexMcapUsd = t.price * (t.maxSupply || 1e9) * q; if (t.dexQuoteRes) t.dexLiqUsd = t.dexQuoteRes * 2 * q; }
    const day = Date.now() - 86_400_000; let v = 0, nb = 0, ns = 0;
    for (let k = s.length - 1; k >= 0 && s[k].ts >= day; k--) { v += s[k].bnb; if (s[k].side === 'buy') nb++; else ns++; }
    const from = s.length ? s[0].ts / 1000 : Infinity; for (const c of t.dexHist || []) if (c.t * 1000 >= day && c.t < Math.floor(from / 60) * 60) v += c.v;   // 链上读不到的更早部分用 GeckoTerminal 分钟线的成交量
    Object.assign(t, { dexVol24: v, dexBuys24: nb, dexSells24: ns, dexCountMin: s.length ? Math.max(1, Math.round((Date.now() - Math.max(day, s[0].ts)) / 60_000)) : 0 });   // 买卖笔数只有链上读到的这段（约 1 小时）
    const recent = s.slice(-100).reverse().map((x) => ({ ...x, usd: x.bnb * q, mcapUsd: x.price * (t.maxSupply || 1e9) * q, name: x.trader ? this.names.peek(x.trader) : null }));
    t.trades = [...recent, ...t.trades.filter((x) => !x.dex)].sort((a, b) => b.ts - a.ts).slice(0, 100);
  }
  // 内盘 K 线 + 外盘 K 线接成一条：内盘的全部保留（只换掉上次接上的外盘部分）
  joinDex(t, bars) {
    const curve = (t.candles || []).filter((c) => !c.dex), end = curve.length ? curve[curve.length - 1].t : -Infinity;
    // 外盘第一根分钟线的起点（如 06:40:00）常早于内盘最后一笔（06:40:43）：以前把这一分钟里的内盘成交整段删掉，K 线在毕业处断开一截。
    // 现在内盘全部保留，落在内盘结束之前的外盘线并成一根，放在内盘最后一笔之后
    const head = bars.filter((c) => c.t <= end), tail = bars.filter((c) => c.t > end);
    if (head.length) tail.unshift({ t: end + 1, o: head[0].o, h: Math.max(...head.map((c) => c.h)), l: Math.min(...head.map((c) => c.l)), c: head[head.length - 1].c, v: head.reduce((x, c) => x + c.v, 0), dex: 1 });
    if (tail[0] && tail[1] && tail[0].t >= tail[1].t) tail.splice(0, 2, { ...tail[1], o: tail[0].o, h: Math.max(tail[0].h, tail[1].h), l: Math.min(tail[0].l, tail[1].l), v: tail[0].v + tail[1].v });
    if (tail[0] && curve.length) { const o = curve[curve.length - 1].c; tail[0] = { ...tail[0], o, h: Math.max(tail[0].h, o), l: Math.min(tail[0].l, o) }; }   // 外盘第一根从内盘收盘价开，两段接上
    t.candles = curve.concat(tail);
  }

  // 已迁移（dex）的币：曲线 ticks 停在毕业那一刻，外盘价格要从 PancakeSwap 池子拿。
  // DexScreener 找流动性最大的池子 → GeckoTerminal 分钟 OHLCV（USD）÷ 计价币 USD = 计价币单价，与内盘 K 线同一单位。选中时每 20 秒刷新。
  async dexCandles(t) {
    const merge = () => { if (!t.dexBars?.length) return false; this.joinDex(t, t.dexBars); if (t.candles.length > 4000) t.candles.splice(0, t.candles.length - 4000); t.price = t.dexBars[t.dexBars.length - 1].c; const q = this.quoteUsd(t); if (q) t.mcapUsd = t.price * (t.maxSupply || 1e9) * q; return true; };
    if (t.dexAt && Date.now() - t.dexAt < 20_000) { merge(); return; } t.dexAt = Date.now();
    try {
      {
        const r = await cache.fetchJson('https://api.dexscreener.com/tokens/v1/bsc/' + t.address, 15);   // Redis 共用 15 秒（几个钱包后端同时看同一个币时只请求一次）
        const ps = (Array.isArray(r) ? r : []).filter((p) => String(p.baseToken?.address).toLowerCase() === t.address && +p.priceUsd).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        if (!ps[0]) return; t.dexPool = ps[0].pairAddress; t.dexPoolAt = Date.now();
        Object.assign(t, { pair: ps[0].pairAddress, dexLiqUsd: ps[0].liquidity?.usd || 0, dexMcapUsd: +ps[0].marketCap || +ps[0].fdv || 0, dexPriceUsd: +ps[0].priceUsd });
      }
      const q = this.quoteUsd(t); if (!q) return;
      const j = await cache.fetchJson(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${t.dexPool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${t.address}`, 15, { headers: { accept: 'application/json' } });
      let list = (j?.data?.attributes?.ohlcv_list || []).slice().sort((a, b) => a[0] - b[0]);
      // MySQL 缓存：分钟 K 线存下来，接口只给最近 1000 根，更早的从库里接上（重启后也在）
      if (list.length) {
        if (t._barsPool !== t.dexPool) { const old = await cache.loadBars(t.dexPool, 4000).catch(() => null); Object.assign(t, { _barsPool: t.dexPool, _barT: 0, _usdBars: old ? new Map(old.map((x) => [x[0], x])) : null }); }
        if (t._usdBars) {
          cache.saveBars(t.dexPool, list.filter((x) => x[0] >= t._barT)).catch(() => {}); t._barT = list.at(-1)[0];   // 只存新的（最后一根会变，所以含等于）
          for (const x of list) t._usdBars.set(x[0], x);
          list = [...t._usdBars.values()].sort((a, b) => a[0] - b[0]).slice(-4000); if (t._usdBars.size > 4500) t._usdBars = new Map(list.map((x) => [x[0], x]));
        }
      }
      if (!list.length) {   // GeckoTerminal 没收录这个池子：用 DexScreener 实时价按分钟攒 K 线
        const p = t.dexPriceUsd / q, m = Math.floor(Date.now() / 60_000) * 60; t.dexBars = t.dexBars || []; const l = t.dexBars[t.dexBars.length - 1];
        if (l && l.t === m) { l.h = Math.max(l.h, p); l.l = Math.min(l.l, p); l.c = p; } else t.dexBars.push({ t: m, o: l ? l.c : p, h: Math.max(p, l ? l.c : p), l: Math.min(p, l ? l.c : p), c: p, v: 0, dex: 1 });
        merge(); this.emit('detail', t.address); return;
      }
      t.dexBars = list.map(([ts, o, h, l, c, v]) => ({ t: ts, o: o / q, h: h / q, l: l / q, c: c / q, v: v / q, dex: 1 }));   // 内盘时期的 K 线保留在前面
      merge();
      this.emit('detail', t.address);
    } catch { /* 下次再试 */ }
  }

  // 选中代币时拉详情：Agent 曲线走 Reader + fsi，其它走 shrine
  async refresh(address) {
    const t = this.get(address); if (!t) return;
    if (t.source === 'gang' && (t.gangTrack === 'v2' || t.gangTrack === 'v3')) await this.gangV2Curve(t).catch(() => {});
    if (t.source === 'gang' && t.gangTrack === 'v3fair') await this.gangFairState(t).catch(() => {});
    try {
      if (t.market && t.source === 'agent-curve') {
        const [d, trades, ticks] = await Promise.all([this.curve.detail(t.market), fsi.fetchTrades(t.market, 100).catch(() => []), fsi.fetchTicks(t.market, 200).catch(() => [])]);
        Object.assign(t, { creator: d.creator, holders: d.holders, buys: d.buys, sells: d.sells, volume: d.volume, raised: d.pool, target: d.cap, progress: d.progress,
          remaining: d.remaining, totalShares: d.totalShares, maxWalletShares: d.maxWalletShares, buyTax: d.buyTaxBps / 100, sellTax: d.sellTaxBps / 100,
          feeBps: d.buyTaxBps + d.flapBuyFeeBps, stage: d.phase === 'graduated' ? 'dex' : 'curve' });   // launchedAt 是迁移时间，不是创建时间
        if (ticks.length) { t.candles = []; for (const k of ticks) this.pushCandle(t, k.ts, k.price, 0); t.price = ticks[ticks.length - 1].price; }
        for (const tr of [...trades].reverse()) { this.noteFirstBuy(t, tr); if (!t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) { tr.usd = tr.bnb * this.quoteUsd(t); t.trades.push(tr); } if (!ticks.length && tr.price) this.pushCandle(t, tr.ts, tr.price, tr.bnb); }
        for (const tr of trades) { const c = t.candles.find((x) => x.t === Math.floor(tr.ts / 1000)); if (c && ticks.length) c.v += tr.bnb; }
        t.trades.sort((a, b) => b.ts - a.ts); if (t.trades.length > 100) t.trades.length = 100;
        t.lastTradeAt = t.trades[0]?.ts || t.lastTradeAt;
        if (t.price) t.mcapUsd = t.price * (t.maxSupply || 1e9) * this.quoteUsd(t);
        if (t.stage === 'dex') await this.dexRefresh(t);
      } else if (t.source === 'flap-nft') {
        await this.flapNftTax(t).catch(() => {});
        await Promise.race([this.flapNftHistory(t, true).then(() => this.emit('detail', t.address)), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});   // 第一次补历史最多等 3 秒，补完再推一次详情
        if (t.stage === 'curve') await this.applyFlapNftState(t, await this.flapNft.state(t.address));
        else await this.dexRefresh(t);
      } else if (t.source === 'gang') {
        // 选中时拉一次较长的成交记录画 K 线（5 秒内不重复请求）
        // 已发射的不再拉：内盘不会有新成交，成交列表换成外盘的之后重拉会把同一批内盘成交重复记进 K 线成交量
        // V3 曲线盘：gang.fun 成交接口没有 V3 的成交，K 线 / 成交 / 成交量都从 pad 的链上事件重建（第一次最多等 4 秒，之后只补新区块）
        if (t.gangTrack === 'v3') await Promise.race([this.gangV3History(t).then((n) => { if (n) this.emit('detail', t.address); }), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
        else if (t.stage !== 'dex' && (!t.gangAt || Date.now() - t.gangAt > 5000)) { t.gangAt = Date.now(); await this.gang.trades(t.address, 200); }
        // 第一次选中：拉全部成交，从开盘起重建 K 线（也清掉改单位之前按 BNB 记的旧 K 线，全部是报价币单位）；10 分钟重建一次
        if (t.gangTrack !== 'v3' && (!t.gangFullAt || Date.now() - t.gangFullAt > 600_000)) {
          t.gangFullAt = Date.now();
          const rows = await this.gang.history(t.address).catch(() => null);
          if (rows?.length) { const k = this.qScale(t); t.candles = []; for (const r of rows) if (r.price > 0) this.pushCandle(t, r.ts, r.price * k, r.bnb * k); t._chgAt = 0; }
        }
        if (t.stage === 'dex') await this.dexRefresh(t);   // 已发射：接上外盘池子的成交
      } else if (t.source === 'four-agent') {
        // 已由链上事件实时更新，不再请求 shrine（经常 429）。有 MySQL 缓存时：用库里从创建起的全部成交重建 K 线和成交列表（重启后也完整），10 分钟一次，第一次最多等 3 秒
        if (cache.my && (!t.fourHistAt || Date.now() - t.fourHistAt > 600_000)) { t.fourHistAt = Date.now(); await Promise.race([this.fourHistory(t).then(() => this.emit('detail', t.address)), new Promise((r) => setTimeout(r, 3000))]).catch(() => {}); }
        if (t.stage === 'dex') await this.dexRefresh(t);
      } else {
        const b = await tokenInfo(t.address);
        if (!b.error) {
          Object.assign(t, { symbol: b.symbol || t.symbol, name: b.name || t.name, creator: b.creator || t.creator, antiSniper: b.antiSniper ?? t.antiSniper });
          if (num(b.progressPct) != null) t.progress = num(b.progressPct);
          if (num(b.marketCapFormatted)) t.mcapUsd = num(b.marketCapFormatted);
          if (b.buyTaxBps != null) t.buyTax = b.buyTaxBps / 100;
          const fee = b.currentBuyFeeBps ?? b.curveFeeBps; if (fee != null) t.feeBps = Number(fee);
          if (b.status) t.stage = /grad|dex|launched|migrat/i.test(b.status) ? 'dex' : 'curve';
        }
      }
      this.emit('detail', t.address);
    } catch (e) { t.lastError = e.message; }
  }

  // Flap Agent 曲线：每 90 秒用 Reader.marketDetail 补一遍持有人 / 买卖笔数（4 个并发），不然只有选中过的盘才有持有人数
  async flapHolders() {
    if (this.fhBusy) return; this.fhBusy = true;
    try {
      const list = [...this.tokens.values()].filter((t) => t.source === 'agent-curve' && t.market);
      for (let i = 0; i < list.length; i += 4) {
        await Promise.all(list.slice(i, i + 4).map(async (t) => { try { const d = await this.curve.detail(t.market); t.holders = d.holders; t.buys = d.buys; t.sells = d.sells; t.buyTax = d.buyTaxBps / 100; t.sellTax = d.sellTaxBps / 100; t.feeBps = d.buyTaxBps + d.flapBuyFeeBps; t.sellFeeBps = d.sellTaxBps + d.flapSellFeeBps; } catch { /* 下轮再试 */ } }));
      }
    } finally { this.fhBusy = false; }
  }

  // 后台给最新的几个 Agent 曲线市场补价格/市值，左栏 MC 才不是空的
  async warm() {
    const list = [...this.tokens.values()].filter((t) => t.source === 'agent-curve' && t.stage === 'curve').sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    for (const t of list) await this.refresh(t.address);
  }

  // 实时买入总费率（%）：Four 用 shrine currentBuyFeeBps（含防狙击税），Agent 曲线用 Reader 的税 + Flap 手续费
  async fetchBuyFeePct(address) {
    const t = this.get(address); if (!t) return null;
    if (t.source === 'agent-curve' && t.market) {
      if (t.feeBps == null) { try { const d = await this.curve.detail(t.market); t.feeBps = d.buyTaxBps + d.flapBuyFeeBps; } catch { /* */ } }
      return t.feeBps != null ? t.feeBps / 100 : null;
    }
    if (t.source === 'four-agent') return t.feeBps != null ? t.feeBps / 100 : null;
    const b = await tokenInfo(t.address).catch(() => ({ error: 1 }));
    if (b.error) return null;
    t.antiSniper = b.antiSniper; t.feeBps = Number(b.currentBuyFeeBps ?? b.curveFeeBps ?? 0);
    return t.feeBps / 100;
  }
  buyFeePct(t) { return t.feeBps != null ? t.feeBps / 100 : t.buyTax || 0; }
  sellFeePct(t) { return t.sellFeeBps != null ? t.sellFeeBps / 100 : t.source === 'four-agent' ? null : t.sellTax || 0; }
  costFor() { return Infinity; }

  summary(t) {
    const priceUsd = t.price * this.quoteUsd(t); const liqUsd = t.dexLiqUsd || (t.raised || 0) * this.quoteUsd(t);
    return {
      address: t.address, symbol: t.symbol, name: t.name, platform: t.platform, source: t.source, agentExclusive: !!t.agentExclusive, market: t.market,
      preset: t.source === 'feast' ? 'Feast（真池子）' : t.source === 'gang' ? 'Gang（Agent 专属）' : t.source === 'agent-curve' ? 'Flap Agent Curve' : t.source === 'flap-nft' ? (t.nftGate?.known ? 'Flap · Agent ID 门槛' : 'Flap · NFT 门槛') : t.platform === 'four' ? (t.agentExclusive ? 'Binance Agent ID Exclusive' : 'Four.meme') : 'Flap',
      presetId: t.presetId || '', quote: t.quote, quoteAddress: t.quoteAddress, creator: t.creator, firstBuyer: t.firstBuy?.trader || '', firstBuyerName: t.firstBuy ? this.names.peek(t.firstBuy.trader) : null, vault: t.market || '', createdAt: t.createdAt, officialTest: false,
      stage: t.stage, price: t.price, priceUsd, mcapUsd: t.dexMcapUsd ? t.dexMcapUsd : t.source === 'four-agent' ? (t.price || this.fourP0 || 0) * (t.maxSupply || 1e9) * this.quoteUsd(t) : t.mcapUsd || (priceUsd > 0 ? priceUsd * (t.maxSupply || 1e9) : 0),   /* 没有市值但有价格（报价币价格后到）：按现价 × 总量补上 */ mcapEst: t.source === 'four-agent' && !t.price && !!this.fourP0, liqUsd, quoteUsd: this.quoteUsd(t), raised: t.raised, target: t.target, progress: t.progress || 0,
      remaining: t.remaining, holders: t.holders, buys: t.buys, sells: t.sells, volume: t.volume, dexVol24: t.dexVol24 ?? null, dexBuys24: t.dexBuys24 ?? null, dexSells24: t.dexSells24 ?? null, dexCountMin: t.dexCountMin || 0, buyTax: t.buyTax, sellTax: t.sellTax,
      buyFeePct: t.source === 'four-agent' && t.feeBps == null ? null : this.buyFeePct(t), sellFeePct: this.sellFeePct(t), antiSniperPct: t.antiSniperPct || 0, antiSniper: !!t.antiSniper, lastTradeAt: t.lastTradeAt || 0, realToken: t.realToken !== false,
      chg: this.change(t),
      image: t.image || null, creatorName: t.creatorName || null, gangTrack: t.gangTrack || null, gangDiv: t.gangDiv || null, gangV3: t.gangV3 || null, gangFair: t.gangFair || null, flapTax: t.flapTax ? { ...t.flapTax, beneficiaryName: t.flapTax.beneficiary ? this.names.peek(t.flapTax.beneficiary) : null } : null, nftGate: t.source === 'flap-nft' && t.stage === 'curve' && t.nftGate && !t.nftGate.removed ? t.nftGate : null, description: t.description || '', website: t.website || '', twitter: t.twitter || '', telegram: t.telegram || '',
    };
  }

  // 涨幅（%）：现价对比 开盘 / 5 分钟 / 1 小时 / 24 小时前的价格，按 K 线历史算；历史够不到那个时间点、又不是那之后才开盘的，给 null
  // Gang V2 曲线状态（pad 合约 curves()）：开盘价 = virtualQuote / VT；剩余可售 = 毕业时卖出量 − 已卖出量。单位：报价币 / 个。20 秒缓存
// Gang 打新币（GangLaunchpad kindOf = 2）：没有曲线，固定价认购 1 万份，卖满就在 PancakeSwap V2 开池。
  // 进度 = 已售份数 / 10000，已筹 / 目标按每份价格算（报价币单位），价格 = 每份价格 / 每份代币数。launched 后切成外盘（stage = dex + pair），
  // K 线、成交、买卖都走已毕业币的外盘路径（dexCandles / dex 成交 / baw 兑换）。15 秒缓存
  async gangFairState(t) {
    const FAIR_PAD = '0x15cfd2dc8278fb87a1783ef42111618e20874365';   // gang.fun 官方 GangLaunchpad（/api/v3/config 的 pad，owner = gang 多签）
    if (t._fairAt && Date.now() - t._fairAt < 15_000) return;
    t._fairAt = Date.now();
    const I = (this._fairI ||= new ethers.Interface(['function sales(address) view returns (address creator, uint64 progressAt, uint16 capShares, uint16 holdBps, address quote, uint16 sold, bool launched, uint16 mintFeeBps, uint16 exitFeeBps, address gate, uint128 sharePrice, address pair, address refPool, uint16 markSold)', 'function TOKENS_PER_SHARE() view returns (uint256)']));
    const call = (fn, args = []) => this.provider.call({ to: FAIR_PAD, data: I.encodeFunctionData(fn, args) }).then((r) => I.decodeFunctionResult(fn, r));
    const [s, tps] = await Promise.all([call('sales', [t.address]), this._fairTps ? [this._fairTps] : call('TOKENS_PER_SHARE')]);
    this._fairTps = tps[0];
    if (s.creator === ethers.ZeroAddress) return;
    t._fair = { sold: Number(s.sold), capShares: Number(s.capShares), sharePrice: Number(ethers.formatEther(s.sharePrice)), tokensPerShare: Number(ethers.formatEther(this._fairTps)), launched: !!s.launched, pair: s.pair === ethers.ZeroAddress ? null : s.pair.toLowerCase(), mintFeeBps: Number(s.mintFeeBps) };
    this.applyFair(t);
  }
  applyFair(t) {
    const f = t._fair, was = t.stage;
    t.raised = Math.round(f.sold * f.sharePrice * 1e6) / 1e6; t.target = Math.round(10_000 * f.sharePrice * 1e6) / 1e6; t.remaining = null;
    t.gangFair = { sold: f.sold, sharesLeft: 10_000 - f.sold, capShares: f.capShares, minWalletsLeft: Math.ceil((10_000 - f.sold) / f.capShares), sharePrice: f.sharePrice, mintPrice: f.sharePrice / f.tokensPerShare, launched: f.launched, mintFeeBps: f.mintFeeBps };
    if (f.launched) {
      Object.assign(t, { stage: 'dex', progress: 100, pair: f.pair || t.pair });
      if (was !== 'dex') { t.migratedAt ||= Date.now(); this.emit('migrate', this.summary(t)); }
    } else {
      t.stage = 'curve'; t.progress = f.sold / 100;
      if (!(t.price > 0)) { t.price = f.sharePrice / f.tokensPerShare; const q = this.quoteUsd(t); if (q) t.mcapUsd = t.price * 1e9 * q; }   // 打新阶段价格固定
    }
  }

  async gangV2Curve(t) {
    if (t._v2At && Date.now() - t._v2At < 20_000) return;
    this._gv2 ||= new GangV2(this.provider, null);
    const { c } = await this._gv2.curve(t.address);
    const VT = 1066666666666666666666666667n, vq = BigInt(c.virtualQuote), grad = BigInt(c.gradAmt), sold = BigInt(c.sold);
    const soldAtGrad = VT - (vq * VT + vq + grad - 1n) / (vq + grad);
    // 报价币不一定是 18 位（XAUt 是 6 位）：开盘价、已筹、目标都按报价币自己的小数位换算
    const dec = t._qDec ??= await this._gv2.decimals(c.quote).catch(() => 18), real = BigInt(c.realQuote || 0);
    t.launchPrice = Number(ethers.formatUnits(vq, dec)) / Number(ethers.formatEther(VT));
    if (dec !== 18) { t.raised = Number(ethers.formatUnits(real, dec)); t.target = Number(ethers.formatUnits(grad, dec)); }
    // 恒定乘积：现价 = 报价币储备 / 代币储备。非 18 位报价币每次都用链上价；18 位的只在还没有成交价时补
    const q = vq + real, tokRes = (vq * VT) / q;
    if (!c.graduated && tokRes > 0n && (dec !== 18 || !(t.price > 0))) { t.price = Number(ethers.formatUnits(q, dec)) / Number(ethers.formatEther(tokRes)); const u = this.quoteUsd(t); if (u) t.mcapUsd = t.price * 1e9 * u; }
    if (c.v3) { t.gangV3 = { ...c.v3, trade: V3_TRADE }; t.gangDiv = { taxed: c.taxed && c.v3.dividendBps > 0, taxBps: Math.max(c.v3.buyTaxBps, c.v3.sellTaxBps), vault: null, stats: t.gangDiv?.stats || null }; }   // V3：毕业后外盘收税，分红比例 > 0 才分红
    else if (t.gangDiv?.taxed == null) t.gangDiv = { taxed: !!c.taxed, taxBps: c.taxed ? 100 : 0, vault: null, stats: null };   // 新盘接口还没收录时，按合约 curves().taxed 先判断分红
    t._v2Rem = c.graduated ? 0 : Math.max(0, Number(ethers.formatEther(soldAtGrad > sold ? soldAtGrad - sold : 0n)));
    t.remaining = t._v2Rem; t._v2At = Date.now(); t._chgAt = 0;
  }

  // 某个币从开盘到现在的全部成交（新→旧），给「实时成交」往下翻页和交易者抽屉用。来源：Gang = gang.fun 全部成交；
  // Four = 链上 TradeExecuted（从创建区块起）；Flap 曲线 = fsi 成交记录（最多 5000 笔）。每个币缓存 60 秒，最多缓存 20 个币、每个最多 20000 笔
  async allTrades(t) {
    this._all ||= new Map(); const c = this._all.get(t.address);
    if (c && Date.now() - c.at < 60_000) return c;
    let list = [], complete = true;
    if (t.source === 'gang' && t.gangTrack === 'v3') { await this.gangV3History(t); list = (t._v3Hist?.rows || []).map((x) => this.v3Row(t, x)); }
    else if (t.source === 'gang' && t.gangTrack !== 'v3fair') { const k = this.qScale(t); list = (await this.gang.history(t.address, 20000)).map((x) => (k === 1 ? x : { ...x, price: x.price * k, bnb: x.bnb * k })); }
    else if (t.source === 'four-agent') list = await this.four.tokenTrades(t.address);
    else if (t.source === 'flap-nft') list = (await this.flapNft.history(t.address, true).catch(() => this.flapNft.trades(t.address))).map((x) => ({ ts: x.ts, side: x.side, bnb: x.bnb, tokens: x.tokens, price: x.price, trader: x.trader, tx: x.tx }));   // 门槛盘：Portal 内盘成交（从创建起）
    else if (t.market) { list = await this.fsiHistory(t); complete = list.length < 9000; }
    list = [...new Map(list.map((x) => [`${x.tx}:${x.side}:${x.tokens}`, x])).values()].sort((a, b) => b.ts - a.ts).slice(0, 20000);
    for (const x of list) { x.name ||= this.names.peek(x.trader); x.usd = (x.bnb || 0) * this.quoteUsd(t); }
    const v = { at: Date.now(), list, complete };
    this._all.set(t.address, v); if (this._all.size > 20) this._all.delete(this._all.keys().next().value);
    return v;
  }
  async tradesPage(address, before, limit = 100) {
    const t = this.get(address); if (!t) return null;
    const { list, complete } = await this.allTrades(t);
    const i = before ? list.findIndex((x) => x.ts < before) : 0;
    const items = i < 0 ? [] : list.slice(i, i + limit);
    return { items, end: i < 0 || i + limit >= list.length, complete, total: list.length };
  }

  // 某个地址在这个币上的盈亏（详情页点成交里的地址 → 右侧抽屉）。成交来源：Gang 用 gang.fun 全部成交，Four 用链上 TradeExecuted，
  // Flap 曲线用 fsi 成交记录（最多各 1000 笔）。金额是报价币单位，另给换算成美元 / BNB 的系数。60 秒缓存
  async traderStats(address, trader) {
    const t = this.get(address); if (!t || !/^0x[0-9a-fA-F]{40}$/.test(trader || '')) return null;
    const key = `${t.address}:${trader.toLowerCase()}`; this._ts ||= new Map(); const c = this._ts.get(key); if (c && Date.now() - c.at < 60_000) return c.v;
    const me = trader.toLowerCase(); let list = [];
    try {
      if (t.source === 'four-agent') list = await this.four.traderTrades(t.address, trader);
      else list = (await this.allTrades(t)).list.filter((x) => String(x.trader).toLowerCase() === me);
    } catch (e) { list = []; }
    if (!list.length) list = t.trades.filter((x) => String(x.trader).toLowerCase() === me);
    list = [...new Map(list.map((x) => [`${x.tx}:${x.side}:${x.tokens}`, x])).values()].sort((a, b) => a.ts - b.ts);
    const buys = list.filter((x) => x.side === 'buy'), sells = list.filter((x) => x.side === 'sell');
    const sum = (a, k) => a.reduce((s2, x) => s2 + (Number(x[k]) || 0), 0);
    const bT = sum(buys, 'tokens'), bQ = sum(buys, 'bnb'), sT = sum(sells, 'tokens'), sQ = sum(sells, 'bnb');
    let hold = Math.max(0, bT - sT), holdSrc = 'trades';
    if (t.source !== 'agent-curve') { try { const i = new ethers.Interface(['function balanceOf(address) view returns (uint256)']); hold = Number(ethers.formatEther(i.decodeFunctionResult('balanceOf', await this.provider.call({ to: t.address, data: i.encodeFunctionData('balanceOf', [trader]) }))[0])); holdSrc = 'chain'; } catch { /* 读不到就用买卖差 */ } }
    const avgBuy = bT ? bQ / bT : null, avgSell = sT ? sQ / sT : null;
    const realized = avgBuy != null ? sQ - avgBuy * Math.min(sT, bT) : sQ, holdQ = hold * (t.price || 0), unreal = avgBuy != null ? holdQ - avgBuy * hold : holdQ;
    const qUsd = this.quoteUsd(t), v = { address: t.address, symbol: t.symbol, quote: t.quote || 'BNB', trader, name: this.names.peek(trader) || list.find((x) => x.name)?.name || null,
      qUsd, qBnb: this.bnbUsd ? qUsd / this.bnbUsd : 0, buys: buys.length, sells: sells.length, boughtTokens: bT, boughtQ: bQ, soldTokens: sT, soldQ: sQ, avgBuy, avgSell, hold, holdSrc, holdQ,
      realized, unrealized: unreal, total: realized + unreal, pct: bQ ? ((realized + unreal) / bQ) * 100 : null, firstBuy: buys[0]?.ts || null, price: t.price,
      trades: list.slice(-200).reverse(), complete: t.source !== 'agent-curve' || (this._all?.get(t.address)?.complete ?? true) };
    if (qUsd > 0) this._ts.set(key, { at: Date.now(), v }); return v;   // 报价币价格还没拿到时不缓存，免得美元一直显示 0
  }

  // 持有人（详情页底部「持有人」，HOLDERS_FEATURE）：这个币的全部成交按地址汇总（路由买卖已经记到真实发起人），按持仓从大到小排。
  // 持仓先按买卖差估算，再给前 60 名读链上 balanceOf（Agent 曲线盘没有链上代币，只能用买卖差）；两者对不上 = 有转入 / 转出，xfer 标出来。
  // 只统计本程序拿得到的成交：内盘（Flap / Four / Gang 曲线、门槛盘）从开盘起；已迁移的币外盘（DEX）成交可能不全。金额是报价币单位。60 秒缓存
  async holders(address) {
    const t = this.get(address); if (!t) return null;
    this._hd ||= new Map(); const c = this._hd.get(t.address); if (c && Date.now() - c.at < 60_000) return c.v;
    const { list, complete } = await this.allTrades(t);
    const m = new Map();
    for (const x of list) {
      const k = String(x.trader || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(k)) continue;
      let r = m.get(k); if (!r) m.set(k, (r = { trader: x.trader, name: null, buys: 0, sells: 0, bT: 0, bQ: 0, sT: 0, sQ: 0, first: 0, last: 0 }));
      if (x.side === 'buy') { r.buys++; r.bT += Number(x.tokens) || 0; r.bQ += Number(x.bnb) || 0; } else { r.sells++; r.sT += Number(x.tokens) || 0; r.sQ += Number(x.bnb) || 0; }
      r.name ||= x.name || null; if (!r.first || x.ts < r.first) r.first = x.ts; if (x.ts > r.last) r.last = x.ts;
    }
    const rows = [...m.values()]; for (const r of rows) { r.net = Math.max(0, r.bT - r.sT); r.hold = r.net; r.holdSrc = 'trades'; }
    rows.sort((a, b) => b.net - a.net);
    let checked = 0;
    if (t.source !== 'agent-curve') {
      const cand = rows.slice(0, 60).filter((r) => r.net > 0), i = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      for (let j = 0; j < cand.length; j += 10) await Promise.all(cand.slice(j, j + 10).map(async (r) => { try { r.hold = Number(ethers.formatEther(i.decodeFunctionResult('balanceOf', await this.provider.call({ to: t.address, data: i.encodeFunctionData('balanceOf', [r.trader]) }))[0])); r.holdSrc = 'chain'; checked++; } catch { /* 读不到就用买卖差 */ } }));
    }
    const supply = t.maxSupply || 1e9, price = t.price || 0, qUsd = this.quoteUsd(t), dust = supply * 1e-9;
    const out = rows.map((r) => {
      const avgBuy = r.bT ? r.bQ / r.bT : null, realized = avgBuy != null ? r.sQ - avgBuy * Math.min(r.sT, r.bT) : r.sQ, holdQ = r.hold * price, unrealized = avgBuy != null ? holdQ - avgBuy * r.hold : holdQ;   // 和交易者抽屉同一个算法
      return { trader: r.trader, name: this.names.peek(r.trader) || r.name, hold: r.hold, net: r.net, holdSrc: r.holdSrc, xfer: r.holdSrc === 'chain' && Math.abs(r.hold - r.net) > Math.max(1, 0.01 * Math.max(r.hold, r.net)),
        pctSupply: (r.hold / supply) * 100, buys: r.buys, sells: r.sells, boughtTokens: r.bT, boughtQ: r.bQ, soldTokens: r.sT, soldQ: r.sQ, avgBuy, buyMcUsd: avgBuy != null && qUsd ? avgBuy * supply * qUsd : null,
        holdQ, realized, unrealized, total: realized + unrealized, pct: r.bQ ? ((realized + unrealized) / r.bQ) * 100 : null, first: r.first, last: r.last };
    });
    const holders = out.filter((r) => r.hold > dust).sort((a, b) => b.hold - a.hold), exited = out.filter((r) => r.hold <= dust).sort((a, b) => b.total - a.total);
    const coverage = t.source === 'agent-curve' ? 'Agent 曲线盘没有链上代币余额，持仓全部按买卖差估算'
      : t.stage !== 'curve' ? '已迁移：只统计本程序拿到的成交（内盘从开盘起），外盘（DEX）买卖可能不全；前 60 名的持仓以链上余额为准' : '内盘成交从开盘起全部统计';
    const v = { address: t.address, symbol: t.symbol, quote: t.quote || 'BNB', qUsd, qBnb: this.bnbUsd ? qUsd / this.bnbUsd : 0, price, supply, stage: t.stage, source: t.source,
      complete, trades: list.length, traders: rows.length, holderCount: holders.length, exitedCount: exited.length, checked, coverage, holders: holders.slice(0, 300), exited: exited.slice(0, 200), at: Date.now() };
    if (qUsd > 0) { this._hd.set(t.address, { at: Date.now(), v }); if (this._hd.size > 20) this._hd.delete(this._hd.keys().next().value); }
    return v;
  }

  change(t) {
    const now = Date.now();
    if (t._chg && now - t._chgAt < 5000 && t._chgP === t.price) return t._chg;
    const cs = t.candles || [], p = t.price;
    const out = { launch: null, m5: null, h1: null, h24: null, base: {} };
    if (cs.length && p > 0) {
      const first = cs[0], createdSec = (t.createdAt || 0) / 1000;
      const fromLaunch = createdSec && first.t - createdSec < 300;          // K 线从开盘附近开始，才算「开盘以来」
      const pct = (base) => (base > 0 ? ((p - base) / base) * 100 : null);
      if (fromLaunch) { out.launch = pct(first.o); out.base.launch = { p: first.o, t: first.t }; }
      else if (t.launchPrice > 0) { out.launch = pct(t.launchPrice); out.base.launch = { p: t.launchPrice, t: Math.floor(createdSec) }; }   // K 线够不到开盘（Gang 只给最近成交）：用合约算的开盘价
      const at = (sec, key) => {                                             // 那个时间点的价格：之前最后一根 K 线的收盘价
        const tgt = now / 1000 - sec;
        if (createdSec && createdSec > tgt) return null;                     // 币龄比窗口短：不重复显示开盘以来的数
        if (tgt < first.t) return null;                                      // K 线历史够不到
        let lo = 0, hi = cs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cs[m].t <= tgt) lo = m; else hi = m - 1; }
        out.base[key] = { p: cs[lo].c, t: cs[lo].t }; return cs[lo].c;
      };
      out.m5 = pct(at(300, 'm5')); out.h1 = pct(at(3600, 'h1')); out.h24 = pct(at(86400, 'h24'));
    }
    t._chg = out; t._chgAt = now; t._chgP = p; return out;
  }

  list() { return [...this.tokens.values()].map((t) => this.summary(t)); }
  // 成交记录带上钱包域名（只读缓存，没有就是 null）
  named(rows) { return rows.map((r) => ({ ...r, name: r.name || this.names.peek(r.trader) })); }
  detail(a) { const t = this.get(a); if (!t) return null; return { ...this.summary(t), candles: compactCandles(t.candles, 1800), trades: this.named(t.trades.slice(0, 60)) }; }

  netStatus() {
    const l = this.feeds.status.launch;
    // 顶栏「链上订阅」：Flap / Four / Gang 三个 WebSocket 订阅都正常 = ok；部分正常 = partial；都断 = down。shrine 只是补充来源，不影响这个状态
    const subs = [this.flapChain.status, this.four.ws || {}, this.gangChain.status], upN = subs.filter((x) => x.connected).length;
    const wssState = upN === subs.length ? 'ok' : upN ? 'partial' : 'down';
    const chainSubs = { flap: { wss: this.flapChain.status.wss, connected: this.flapChain.status.connected, lastLogAt: this.flapChain.status.lastLogAt, trades: this.flapChain.status.trades },
      four: { wss: this.four.ws?.wss, connected: !!this.four.ws?.connected, lastLogAt: this.four.ws?.lastLogAt }, gang: { wss: this.gangChain.status.wss, connected: this.gangChain.status.connected, lastLogAt: this.gangChain.status.lastLogAt } };
    return { wss: null, wssState, chainSubs, rpc: this.rpcError ? null : this.rpcMs, rpcError: this.rpcError, rpcNode: { ...this.tradeProvider.info, read: nodeName(this.provider.lastUrl || this.provider.urls[0]), gangWs: this.gangChain.status.wss || null, fourWs: this.four.ws?.wss || null, four: nodeName(this.four.status?.rpcActive || this.four.status?.rpc), curve: nodeName(this.curve.status?.rpc) }, shrine: this.feeds.status, curve: this.curve.status, four: this.four.status, gang: this.gang.status, feast: this.feast.status, gangChain: { ...this.gangChain.status, recent: (this.gangLat || []).slice(0, 8) } };
  }
}
