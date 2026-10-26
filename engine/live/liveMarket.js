// 实盘行情适配器：把 Flap Agent Curve Reader + fsi、four.meme Agentic Wallet 专属内盘（链上事件）+ shrine 统一成和模拟盘一样的接口（list / get / detail / 事件）。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { RPC_URL, RPC_LIST, BNB_PRICE_URL } from './config.js';
import { FailoverProvider, nodeName } from './rpc.js';
import { AgentCurve } from './agentCurve.js';
import { FourMeme, AGENT_ID_TEMPLATE } from './fourMeme.js';
import { MetaFetcher, ipfsUrl } from './meta.js';
import { GangFun } from './gangFun.js';
import { GangChain } from './gangChain.js';
import { GangV2 } from './gangV2Pads.js';
import { GweiFeed, GWEI, GWEI_MAX_SUPPLY, gweiProgress } from './gwei.js';
import { NameCache } from './names.js';
import { ShrineFeeds, tokenInfo } from './shrine.js';
import * as fsi from './fsi.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const FOUR_REG = new URL('../../data/fourTokens.json', import.meta.url);
const FLAP_REG = new URL('../../data/flapCreated.json', import.meta.url);
const BOOT = Date.now();

const MAX = 1000;                      // Flap Agent 曲线市场、持有中 / 收藏的币不参与淘汰，超出时淘汰最老的盘
const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const m = String(v).replace(/[$,\s]/g, '').match(/^(-?[\d.]+)([KMB])?$/i); if (!m) return Number(v) || null; return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1); };
const sec2ms = (v) => { const x = Number(v); return !x ? Date.now() : x < 1e12 ? x * 1000 : x; };
const isAgentish = (l) => l.agentExclusive === true || l.agent === true || l.isAgent === true || (Array.isArray(l.tags) && l.tags.some((t) => /agent/i.test(t)));

export class LiveMarket extends EventEmitter {
  quoteUsd(t) { const q = String(t?.quote || 'BNB').toUpperCase(); if (q === 'BNB' || q === 'WBNB') return this.bnbUsd; if (['USDT','USDC','USD1'].includes(q)) return 1; return this.qUsd[String(t.quoteAddress || '').toLowerCase()] || 0; }
  constructor() {
    super();
    this.provider = new FailoverProvider(RPC_LIST);   // 主节点（NodeReal，如果配置了）+ 公共节点自动备用
    this.curve = new AgentCurve(this.provider);
    this.four = new FourMeme();
    this.gang = new GangFun();
    this.gangChain = new GangChain(this.provider);   // 链上创建事件，比接口轮询快
    this.gangChain.on('token', (it) => this.onGangChainToken(it));
    this.gwei = new GweiFeed(this.provider);
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
    this.gang.on('trade', (tr, { live }) => this.onGangTrade(tr, live));
    this.feeds.on('launch', (l) => this.upsertShrine(l));
    this.feeds.on('trade', (m) => this.onStreamTrade(m));
    this.feeds.on('graduated', (m) => { const t = this.get(m.token); if (t) { t.stage = 'dex'; this.emit('migrate', this.summary(t)); } });
    this.curve.start();
    this.four.start();
    this.fourRestore();
    setTimeout(() => this.fourDexCheck(), 20_000); this.fourDexTimer = setInterval(() => this.fourDexCheck(), 60_000);
    this.gang.start(); this.gangChain.start();
    this.gwei.on('token', (st) => this.upsertGwei(st));
    this.gwei.on('trade', (tr, { live }) => this.onGweiTrade(tr, live));
    this.gwei.on('holders', (h) => { this.gweiHolders = h.holders; const t = this.get(GWEI); if (t) t.holders = h.holders; for (const [a, n] of h.names) this.names.set(a, n); });
    this.gwei.start();
    this.feeds.start();
    const blk = async () => { const t0 = Date.now(); try { this.block = await this.provider.getBlockNumber(); this.rpcMs = Date.now() - t0; this.rpcError = null; } catch (e) { this.rpcError = e.shortMessage || e.message; } };
    const px = async () => { try { const j = await (await fetch(BNB_PRICE_URL)).json(); if (+j.price) this.bnbUsd = +j.price; } catch { /* 保留上次 */ } };
    const qpx = async () => { const qs = new Set(); for (const t of this.tokens.values()) if (t.quoteAddress && t.quote && !['BNB','WBNB','USDT','USDC','USD1'].includes(String(t.quote).toUpperCase())) qs.add(String(t.quoteAddress).toLowerCase());
      for (const a of qs) { try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + a)).json(); const ps = (j.pairs || []).filter((x) => x.chainId === 'bsc' && x.baseToken?.address?.toLowerCase() === a && +x.priceUsd).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0)); if (ps[0]) this.qUsd[a] = +ps[0].priceUsd; } catch { /* 保留上次 */ } } };
    this.qpx = qpx; blk(); px(); setTimeout(qpx, 3000);
    this.timers = [setInterval(blk, 3000), setInterval(px, 30_000), setInterval(qpx, 60_000), setInterval(() => this.warm(), 8000), setInterval(() => this.flapHolders(), 90_000)];
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
        const old = [...this.tokens.values()].filter((t) => !t.pinned && !keep.has(t.address) && t.source !== 'agent-curve' && t.source !== 'gwei' && !(t.source === 'four-agent' && t.stage === 'dex')).sort((a, b) => a.createdAt - b.createdAt)[0];
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
    if (!t) return null;
    t.pinned = true;               // 手动打开的盘不被自动淘汰
    return this.summary(t);
  }

  // gang.fun：接口给的列表（已筹 / 进度 / 价格 / FDV / 持有人）；毕业门槛按 已筹 ÷ 进度 推算
  upsertGang(it, isNew) {
    const existed = this.tokens.has(this.key(it.address));
    const t = this.base(it.address);
    const raised = Number(it.raisedQuote ?? it.raisedBnb) || 0, pct = Number(it.progressPct) || 0;
    Object.assign(t, {
      source: 'gang', platform: 'gang', agentExclusive: true, symbol: it.symbol, name: it.name, quote: it.quoteSymbol || 'BNB', quoteAddress: it.quoteAddress || null, creator: it.creator,
      creatorName: it.creatorHandle || null, feeBps: 100, sellFeeBps: 100, stage: it.graduated ? 'dex' : 'curve', raised, progress: pct, target: it.gradAmtQuote || (pct > 0 ? Math.round((raised / (pct / 100)) * 10) / 10 : (t.target || 15)), gangTrack: it.track || 'v1', remaining: t._v2Rem ?? null,   // 剩余可售：V2 从合约读，读到之前 / 老盘未知 = null（页面显示「—」）
     
      price: Number(it.priceQuote ?? it.priceBnb) || t.price, mcapUsd: Number(it.fdvUsd) || 0, holders: it.holders ?? null, volume: Number(it.volume24hBnb) || 0, pair: it.pair || null, tradeCount: it.trades || 0,
    });
    if (!existed) t.createdAt = it.createdAt * 1000;
    if (it.lastTradeAt) t.lastTradeAt = Math.max(t.lastTradeAt || 0, it.lastTradeAt * 1000);
    if (it.creatorHandle) this.names.set(it.creator, it.creatorHandle);
    if (it.logo) t.image = it.logo;
    // V2 报价币（GANG / ZEC / 币股…）的美元价用 gang.fun 给的，quoteUsd() 换美元要用
    if (it.quoteAddress && it.quoteUsd && !(this.qUsd[it.quoteAddress.toLowerCase()] > 0)) this.qUsd[it.quoteAddress.toLowerCase()] = it.quoteUsd;
    if (isNew && !existed) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - t.createdAt) });   // 链上已经先发现过的，接口再看到时不重复提示
    // 最近有成交的几个 + 当前选中的，定时拉成交
    const hot = [...this.tokens.values()].filter((x) => x.source === 'gang' && x.lastTradeAt).sort((a, b) => b.lastTradeAt - a.lastTradeAt).slice(0, 5).map((x) => x.address);
    this.gang.setHot(hot);
  }

  // 链上发现的 Gang 新盘：先上列表（名称、符号、创建者、计价币都来自事件），市值 / 头像等等接口轮询补上
  onGangChainToken(it) {
    const lat = it.seenAt - it.createdAt * 1000;
    (this.gangLat ||= []).unshift({ symbol: it.symbol, address: it.address, block: it.block, createdAt: it.createdAt * 1000, seenAt: it.seenAt, latencyMs: lat, viaApiFirst: this.tokens.has(this.key(it.address)) }); this.gangLat.length = Math.min(this.gangLat.length, 20);
    console.log(`[Gang 链上] 新盘 ${it.symbol}（${it.track === 'v2' ? 'V2 · ' + it.quoteSymbol : '老盘 · BNB'}）区块 ${it.block}，出块后 ${lat}ms 发现${this.tokens.has(this.key(it.address)) ? '（接口已先收录）' : ''}`);
    if (this.tokens.has(this.key(it.address))) return;
    this.gang.seen.set(it.address, -1);
    this.upsertGang(it, true);
    const t = this.get(it.address);
    if (t && it.track === 'v2') this.gangV2Curve(t).then(() => { if (!(t.price > 0) && t.launchPrice > 0) { t.price = t.launchPrice; const q = this.quoteUsd(t); if (q && !(t.mcapUsd > 0)) t.mcapUsd = t.price * 1e9 * q; } }).catch(() => {});
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
    const trade = { ts: tr.ts, side: tr.side, bnb: tr.bnb, tokens: tr.tokens, price: tr.price, trader: tr.trader, tx: tr.tx, name: tr.name };
    this.addTrade(t, trade);
    if (live) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: tr.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });   // Gang V2 的金额是报价币（GANG / BNCB…），按报价币价格换美元
  }

  // GWEI：只有一个币，状态每 4 秒从合约读一次；总量固定 2100 万，市值 = 现价 × 2100 万
  upsertGwei(st) {
    const existed = this.tokens.has(GWEI);
    const t = this.base(GWEI);
    Object.assign(t, {
      source: 'gwei', platform: 'gwei', agentExclusive: true, symbol: 'GWEI', name: 'GWEI', quote: 'BNB', quoteAddress: null, maxSupply: GWEI_MAX_SUPPLY,
      stage: st.graduated ? 'dex' : 'curve', raised: st.reserve, target: 100, progress: st.graduated ? 100 : gweiProgress(st.reserve), remaining: GWEI_MAX_SUPPLY - st.supply,
      price: st.price, mcapUsd: st.price * GWEI_MAX_SUPPLY * this.quoteUsd(t), feeBps: 10, sellFeeBps: 10, pair: st.pair, website: 'https://gwe1.xyz/', pinned: true,
    });
    if (!existed) { t.createdAt = Date.parse('2026-10-24T16:08:35Z') /* 部署区块 129543215 */; t.holders = this.gweiHolders ?? null; this.emit('detail', t.address); }
  }

  onGweiTrade(tr, live) {
    const t = this.get(GWEI); if (!t) return;
    if (tr.tx && t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    if (tr.name) this.names.set(tr.trader, tr.name);
    if (tr.side === 'buy') t.buys++; else t.sells++;
    t.volume += tr.bnb;
    const trade = { ts: tr.ts, side: tr.side, bnb: tr.bnb, tokens: tr.tokens, price: tr.price, trader: tr.trader, tx: tr.tx, name: tr.name };
    this.addTrade(t, trade);
    if (live) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: tr.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });
  }

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

  // 已迁移（dex）的币：曲线 ticks 停在毕业那一刻，外盘价格要从 PancakeSwap 池子拿。
  // DexScreener 找流动性最大的池子 → GeckoTerminal 分钟 OHLCV（USD）÷ 计价币 USD = 计价币单价，与内盘 K 线同一单位。选中时每 20 秒刷新。
  async dexCandles(t) {
    const merge = () => { if (!t.dexBars?.length) return false; const first = t.dexBars[0].t; t.candles = (t.candles || []).filter((c) => c.t < first && !c.dex).concat(t.dexBars); if (t.candles.length > 4000) t.candles.splice(0, t.candles.length - 4000); t.price = t.dexBars[t.dexBars.length - 1].c; const q = this.quoteUsd(t); if (q) t.mcapUsd = t.price * (t.maxSupply || 1e9) * q; return true; };
    if (t.dexAt && Date.now() - t.dexAt < 20_000) { merge(); return; } t.dexAt = Date.now();
    try {
      {
        const r = await (await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + t.address)).json();
        const ps = (Array.isArray(r) ? r : []).filter((p) => String(p.baseToken?.address).toLowerCase() === t.address && +p.priceUsd).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        if (!ps[0]) return; t.dexPool = ps[0].pairAddress; t.dexPoolAt = Date.now();
        Object.assign(t, { pair: ps[0].pairAddress, dexLiqUsd: ps[0].liquidity?.usd || 0, dexMcapUsd: +ps[0].marketCap || +ps[0].fdv || 0, dexPriceUsd: +ps[0].priceUsd });
      }
      const q = this.quoteUsd(t); if (!q) return;
      const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${t.dexPool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${t.address}`, { headers: { accept: 'application/json' } })).json();
      const list = (j?.data?.attributes?.ohlcv_list || []).slice().sort((a, b) => a[0] - b[0]);
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
    if (t.source === 'gang' && t.gangTrack === 'v2') await this.gangV2Curve(t).catch(() => {});
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
        if (t.stage === 'dex') await this.dexCandles(t);
      } else if (t.source === 'gang') {
        // 选中时拉一次较长的成交记录画 K 线（5 秒内不重复请求）
        if (!t.gangAt || Date.now() - t.gangAt > 5000) { t.gangAt = Date.now(); await this.gang.trades(t.address, 200); }
        // 第一次选中：拉全部成交，从开盘起重建 K 线（也清掉改单位之前按 BNB 记的旧 K 线，全部是报价币单位）；10 分钟重建一次
        if (!t.gangFullAt || Date.now() - t.gangFullAt > 600_000) {
          t.gangFullAt = Date.now();
          const rows = await this.gang.history(t.address).catch(() => null);
          if (rows?.length) { t.candles = []; for (const r of rows) if (r.price > 0) this.pushCandle(t, r.ts, r.price, r.bnb); t._chgAt = 0; }
        }
      } else if (t.source === 'four-agent' || t.source === 'gwei') {
        // 已由链上事件实时更新，不再请求 shrine（经常 429）
        if (t.stage === 'dex') await this.dexCandles(t);
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
      preset: t.source === 'gang' ? 'Gang（Agent 专属）' : t.source === 'gwei' ? 'GWEI（Agent 专属曲线）' : t.source === 'agent-curve' ? 'Flap Agent Curve' : t.platform === 'four' ? (t.agentExclusive ? 'Binance Agent ID Exclusive' : 'Four.meme') : 'Flap',
      presetId: t.presetId || '', quote: t.quote, quoteAddress: t.quoteAddress, creator: t.creator, firstBuyer: t.firstBuy?.trader || '', firstBuyerName: t.firstBuy ? this.names.peek(t.firstBuy.trader) : null, vault: t.market || '', createdAt: t.createdAt, officialTest: false,
      stage: t.stage, price: t.price, priceUsd, mcapUsd: t.dexMcapUsd ? t.dexMcapUsd : t.source === 'four-agent' ? (t.price || this.fourP0 || 0) * (t.maxSupply || 1e9) * this.quoteUsd(t) : t.mcapUsd, mcapEst: t.source === 'four-agent' && !t.price && !!this.fourP0, liqUsd, quoteUsd: this.quoteUsd(t), raised: t.raised, target: t.target, progress: t.progress || 0,
      remaining: t.remaining, holders: t.holders, buys: t.buys, sells: t.sells, volume: t.volume, buyTax: t.buyTax, sellTax: t.sellTax,
      buyFeePct: t.source === 'four-agent' && t.feeBps == null ? null : this.buyFeePct(t), sellFeePct: this.sellFeePct(t), antiSniperPct: t.antiSniperPct || 0, antiSniper: !!t.antiSniper, lastTradeAt: t.lastTradeAt || 0, realToken: t.realToken !== false,
      chg: this.change(t),
      image: t.image || null, creatorName: t.creatorName || null, gangTrack: t.gangTrack || null, ...(t.source === 'gwei' ? { maxSupply: t.maxSupply } : {}), description: t.description || '', website: t.website || '', twitter: t.twitter || '', telegram: t.telegram || '',
    };
  }

  // 涨幅（%）：现价对比 开盘 / 5 分钟 / 1 小时 / 24 小时前的价格，按 K 线历史算；历史够不到那个时间点、又不是那之后才开盘的，给 null
  // Gang V2 曲线状态（pad 合约 curves()）：开盘价 = virtualQuote / VT；剩余可售 = 毕业时卖出量 − 已卖出量。单位：报价币 / 个。20 秒缓存
  async gangV2Curve(t) {
    if (t._v2At && Date.now() - t._v2At < 20_000) return;
    this._gv2 ||= new GangV2(this.provider, null);
    const { c } = await this._gv2.curve(t.address);
    const VT = 1066666666666666666666666667n, vq = BigInt(c.virtualQuote), grad = BigInt(c.gradAmt), sold = BigInt(c.sold);
    const soldAtGrad = VT - (vq * VT + vq + grad - 1n) / (vq + grad);
    t.launchPrice = Number(ethers.formatEther(vq)) / Number(ethers.formatEther(VT));
    t._v2Rem = c.graduated ? 0 : Math.max(0, Number(ethers.formatEther(soldAtGrad > sold ? soldAtGrad - sold : 0n)));
    t.remaining = t._v2Rem; t._v2At = Date.now(); t._chgAt = 0;
  }

  // 某个币从开盘到现在的全部成交（新→旧），给「实时成交」往下翻页和交易者抽屉用。来源：Gang = gang.fun 全部成交；
  // Four = 链上 TradeExecuted（从创建区块起）；Flap 曲线 = fsi 成交记录（最多 5000 笔）。每个币缓存 60 秒，最多缓存 20 个币、每个最多 20000 笔
  async allTrades(t) {
    this._all ||= new Map(); const c = this._all.get(t.address);
    if (c && Date.now() - c.at < 60_000) return c;
    let list = [], complete = true;
    if (t.source === 'gang') list = await this.gang.history(t.address, 20000);
    else if (t.source === 'four-agent') list = await this.four.tokenTrades(t.address);
    else if (t.source === 'gwei') list = t.trades.map((x) => ({ ...x }));   // 全部成交已经在内存里（gwe1.xyz 索引器 + 链上事件）
    else if (t.market) { list = await fsi.fetchTrades(t.market, 5000); complete = list.length < 9000; }
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
  detail(a) { const t = this.get(a); if (!t) return null; return { ...this.summary(t), candles: t.candles.slice(-1800), trades: this.named(t.trades.slice(0, 60)) }; }

  netStatus() {
    const l = this.feeds.status.launch;
    return { wss: l.connected ? l.rttMs ?? 0 : null, rpc: this.rpcError ? null : this.rpcMs, rpcError: this.rpcError, rpcNode: { ...this.provider.info, four: nodeName(this.four.status?.rpcActive || this.four.status?.rpc), curve: nodeName(this.curve.status?.rpc) }, shrine: this.feeds.status, curve: this.curve.status, four: this.four.status, gang: this.gang.status, gangChain: { ...this.gangChain.status, recent: (this.gangLat || []).slice(0, 8) } };
  }
}
