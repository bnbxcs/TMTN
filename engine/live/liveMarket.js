// 实盘行情适配器：把 Flap Agent Curve Reader + fsi、four.meme Agentic Wallet 专属内盘（链上事件）+ shrine 统一成和模拟盘一样的接口（list / get / detail / 事件）。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { RPC_URL, RPC_LIST, TRADE_RPC_URLS, TRADE_FALLBACK_RPC, BNB_PRICE_URL, RPC_ARCHIVE, dataFile, env } from './config.js';
import { FailoverProvider, nodeName, PUBLIC_RPC } from './rpc.js';
import { AgentCurve } from './agentCurve.js';
import { FourMeme, AGENT_ID_TEMPLATE } from './fourMeme.js';
import { MetaFetcher, ipfsUrl } from './meta.js';
import { GangFun } from './gangFun.js';
import { GangChain, QUOTE_DEC } from './gangChain.js';
import { FlapChain } from './flapChain.js';
import { FlapNft, FLAP_PORTAL } from './flapNft.js';
const T_FLAP_DEX = '0x6e4f47630b8745b8cacbd44f42a8a33e7eea7cc08ef22fc7630f4f385784ff7d';   // Portal LaunchedToDEX(address token, address pool, uint256 amount, uint256 eth)
import { GangPadChain } from './gangPadChain.js';
import { GangV2, CHAIN_HIST_PADS } from './gangV2Pads.js';
import { V3_TRADE, V3_PADS } from './gangV3.js';
import { GangExtras } from './gangExtras.js';
import { fairList } from './gangFair.js';
import { DexFeed, dexBars, compactCandles } from './dexFeed.js';
import { NameCache } from './names.js';
import { ShrineFeeds, tokenInfo } from './shrine.js';
import * as fsi from './fsi.js';
import { cache } from './cache.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getRoute, MIN_LIQ_USD } from './quoteRoutes.js';
import { watchToken } from './routeGuard.js';
import { PlainPools, PLAIN_POOLS, PLAIN_SOURCES, T_GENIUS_LAUNCH } from './plainPools.js';
const FOUR_REG = dataFile('fourTokens.json');
const FLAP_REG = dataFile('flapCreated.json');
// 发射（迁移 / 毕业 / 打新开盘）时间登记表：{ 代币地址: 毫秒 }。「已开盘」列按它倒序，重启后直接用，不再重查
// v2：{ 地址: [毫秒, 来源] }，只存查到真实来源的时间。旧的 launched-at.json 里混着「重启后补扫到迁移事件时记的现在」（一批 Flap 币都记成 18:13），
// 只当临时值显示，launchSweep 会按真实来源重新查一遍
const LAUNCH_FILE = dataFile('launched-at-v2.json'), LAUNCH_OLD = dataFile('launched-at.json');
// 「已开盘」收录所有迁移的 Flap / Four 盘（不论是不是 Agent 盘）：Flap = Portal 的 LaunchedToDEX（flapNft 已经在订阅），
// Four 普通盘 = TokenManager2 的 LiquidityAdded（每分钟 getLogs 补查）。限量：每个平台最多留最近 AUTO_MAX 个、48 小时；市值低于 AUTO_DUST_USD 的不留；
// Four 普通盘还要 DexScreener 上最深池子流动性 ≥ MIN_LIQ_USD（lookupDex）。AUTO_LAUNCHED=0 关掉。Four 普通盘记在 data/auto-launched.json，重启后补回
const AUTO_LAUNCHED = env('AUTO_LAUNCHED', '1') !== '0';
const AUTO_FILE = dataFile('auto-launched.json');
const PLAIN_FILE = dataFile('plain-pools.json');   // 普通盘开关（默认关）
const AUTO_KEEP_MS = 48 * 3600_000, AUTO_MAX = Number(env('AUTO_LAUNCHED_MAX', '150')), AUTO_DUST_USD = Number(env('AUTO_LAUNCHED_MIN_MC', '3000'));
const FOUR_TM2 = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
const T_FOUR_LIQ = '0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0';   // LiquidityAdded(address base, uint256 offers, address quote, uint256 funds)，都在 data 里
// genius.fun（genius.fun/docs/integrate、/contracts/manifest.json）：工厂发 PoolGraduated(address indexed token, …) = 毕业建好 PancakeSwap Infinity CL 池（锁仓），之后外盘交易。
// 当前工厂 m4.2 + 旧工厂 m4.1 都扫。DexScreener 收录了就按外盘代币收录；没收录的按链上读：getLaunchedToken / poolIdFor + CLPoolManager.getSlot0 算价格
const GENIUS_FACTORIES = ['0x37eE8AeE29C5efd3C1A7edA6dF3F510779928a37', '0x78EAE9537C0ef90DFe9B7ae964682Fe8138afe31'];
const T_GENIUS_GRAD = '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259';   // PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)
const GENIUS_I = new ethers.Interface(['function getLaunchedToken(address) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  'function poolKeyFor(address) view returns ((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))', 'function poolIdFor(address) view returns (bytes32)',
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)']);
const BOOT = Date.now();
const GANG_TOKEN = '0x0c6302401aa5325c2e36f170f52c00b1d220b405';   // GANG 市值（底栏）：随报价币价格一起从 DexScreener 拿，不额外读 RPC

const MAX = 1000;                      // Flap Agent 曲线市场、持有中 / 收藏的币不参与淘汰，超出时淘汰最老的盘
const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const m = String(v).replace(/[$,\s]/g, '').match(/^(-?[\d.]+)([KMB])?$/i); if (!m) return Number(v) || null; return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1); };
const sec2ms = (v) => { const x = Number(v); return !x ? Date.now() : x < 1e12 ? x * 1000 : x; };
const isAgentish = (l) => l.agentExclusive === true || l.agent === true || l.isAgent === true || (Array.isArray(l.tags) && l.tags.some((t) => /agent/i.test(t)));

// 报价币美元价兜底：gang.fun 对 FXIon 等 Ondo 币给 quoteUsd=0、DexScreener 偶尔失败 / 限流时，直接读路线表里最深池子（只读 slot0 / getReserves）
// 池子另一边是稳定币按 $1，是 WBNB 按 BNB 价；别的配对币不算（返回 0）
const STABLE = new Set(['USDT', 'USDC', 'USD1', 'U', 'BUSD', 'FDUSD']);
const POOL_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)', 'function getReserves() view returns (uint112,uint112,uint32)'];
const DEC_ABI = ['function decimals() view returns (uint8)'];
// Gang V3 税收接收地址：GangLaunchpad.taxConfigOf(token).recipient，创建时定死、之后不能改，所以每个币只读一次并存盘（重启也不重读）
const TAX_CFG = new ethers.Interface(['function taxConfigOf(address token) view returns (uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address recipient)']);
const TAX_TO_FILE = dataFile('gang-tax-recipients.json');
// Flap 税币不变的部分（税率、分配比例、受益人、分红币）存盘：每个币只完整读一次，重启也不重读
const FLAP_TAX_FILE = dataFile('flap-tax-fixed.json');
const FLAP_FIXED_KEYS = ['buyBps', 'sellBps', 'processor', 'mktBps', 'deflBps', 'lpBps', 'divBps', 'beneficiary', 'divToken', 'divContract', 'divSym', 'divMin'];
// DexScreener 没收录的 PancakeSwap Infinity CL 池（计价币的主池在这里）：直接读 CLPoolManager.getSlot0(poolId)。stable = 池子另一边的稳定币是 currency0 还是 currency1（两边都按 18 位小数）
// xOPAI：USDT/xOPAI 费率 0.067%，DexScreener 只有一个 $0.07 的 V2 池，按它算价格偏高约 13%（2026-10-28 核对）
const CL_POOL_MANAGER = '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b';
const INFINITY_POOLS = { '0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6': { id: '0x50e12feaf029b39e3ead3a56942a212e550b2e4face238e936bd4a6b8d76ff80', stable: 0 } };
// 普通（无门槛）Flap Portal 盘的计价币：每分钟查价时顺便从 DexScreener 找出以它计价的 Flap 盘（dexId flapsh），按「Flap · 普通盘」收录进列表，不用手动搜索地址
// MRVLB（Marvell 币股 0x16cd…2c76，主池 PancakeSwap V3 MRVLB/USDT 约 $84k）：2026-10-28 一批「漫威」梗币以它计价，Portal 没开原生 BNB 自动换（nativeSwap=0）→ 买卖走币安聚合
const FLAP_PLAIN_QUOTES = new Set(['0x16cd4fe7e8880ecc3ba222795229e20489fc2c76']);
// 成交排序：同一秒（BSC 一秒两三个块）的几笔按区块号、块内日志序号排，不再按到达 / 库里的 tx 哈希顺序乱排。blk / li 只有链上事件来的成交有（Gang 内盘），其他来源没有就保持原顺序
const chainCmp = (a, b) => ((a.blk || 0) - (b.blk || 0)) || ((a.li || 0) - (b.li || 0));
const newFirst = (a, b) => (b.ts - a.ts) || -chainCmp(a, b), oldFirst = (a, b) => (a.ts - b.ts) || chainCmp(a, b);
async function infinityPriceUsd(provider, addr) {
  const p = INFINITY_POOLS[String(addr).toLowerCase()]; if (!p) return 0;
  const m = new ethers.Contract(CL_POOL_MANAGER, ['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)'], provider);
  const sq = Number((await m.getSlot0(p.id))[0]) / 2 ** 96, p1per0 = sq * sq;
  if (!(p1per0 > 0) || !isFinite(p1per0)) return 0;
  return p.stable === 0 ? 1 / p1per0 : p1per0;
}
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
    this.tradeProvider = new FailoverProvider([...TRADE_RPC_URLS, ...RPC_LIST, ...TRADE_FALLBACK_RPC], '交易');   // 交易专用节点在前，公共节点兜底
    this.curve = new AgentCurve(this.provider);
    this.four = new FourMeme();
    this.gang = new GangFun();
    this.dexFeed = new DexFeed(new ethers.JsonRpcProvider(PUBLIC_RPC, 56, { staticNetwork: true }), RPC_ARCHIVE ? this.provider : null);   // 已发射币的外盘成交（PancakeSwap V2 池子的 Swap 事件）
    this.gangChain = new GangChain(this.provider);   // 链上创建事件，比接口轮询快
    this.gangChain.on('token', (it) => this.onGangChainToken(it));
    this.flapChain = new FlapChain(this.provider);   // Flap 成交 / 新市场：链上订阅（代替 shrine 推送）
    this.flapChain.on('trade', (tr) => this.onFlapChainTrade(tr));
    this.gangPads = new GangPadChain(this.provider);   // Gang V2 全部成交（链上），以前只有最活跃的几个盘有成交（接口轮询）
    this.gangPads.on('trade', (tr) => this.onGangTrade(tr, true));
    // Flap 普通 Portal 的 Agent ID 门槛盘（NFT-gated）：只有这类 Portal 盘会进列表（普通 Flap Portal 盘本终端不跟踪）
    this.flapNft = new FlapNft(this.provider);
    this.flapNft.on('gated', (g, o) => this.upsertFlapNft(g, o).catch(() => {}));
    if (AUTO_LAUNCHED) { this.flapNft.on('dexUnknown', (k, b) => this.autoQ('flap', k, b)); setTimeout(() => this.autoStart().catch(() => {}), 8000); }   // 已开盘普通盘（迁移后的 Flap / Four / genius）不受普通盘开关管：量少、扫描便宜，一直收录
    // 发币交易里 Portal 的 TokenCreated 带着名字 / 代号 / 图标：到了就补上，不等 name() / symbol() 读链
    this.flapNft.on('meta', (g) => { const t = this.get(g.token); if (t?.source !== 'flap-nft' || !g.meta) return; Object.assign(t, { symbol: t.symbol === '?' ? g.meta.symbol || '?' : t.symbol, name: t.name || g.meta.name || '' }); this.loadMeta(t, t.metaUrl || ipfsUrl(g.meta.uri)); this.emit('detail', t.address); });
    this.flapNft.on('ungated', (g) => { const t = this.get(g.token); if (t?.nftGate) { t.nftGate = { ...t.nftGate, removed: true }; this.emit('detail', t.address); } });
    this.flapNft.on('trade', (tr) => { const t = this.get(tr.token); if (t) { t._nftEvery = 6000; t._nftAt = 0; } this.onFlapNftTrade(tr); });   // 有成交：下一轮马上读状态
    this.flapNft.on('dex', (g) => { const t = this.get(g.token); if (t && t.stage === 'curve') { t.stage = 'dex'; t.progress = 100; this.emit('migrate', this.summary(t)); } });
    this.flapChain.on('created', () => { try { this.curve.tick?.(); } catch { /* 下一轮 Reader 轮询也会扫到 */ } });
    this.plain = new PlainPools(this);   // 普通盘（非 Agent）：Four / Flap / genius 内盘进战壕，见 plainPools.js
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
    // 列表满 1000 时 gang.fun 接口每 5 秒给的老盘（比最近淘汰的还老）不再收录：以前每次轮询都是「加进来 → 马上被淘汰 → 下次再加」，
    // 一轮一百多个币反复进出（每个都要排序淘汰、读一次报价币 decimals），白白占 CPU 和每分钟几百次 eth_call。链上新盘 / 搜索不受影响
    this.gang.on('token', (it, { isNew }) => { if (!isNew && this.tokens.size >= MAX && !this.tokens.has(this.key(it.address)) && (Number(it.createdAt) || 0) * 1000 <= (this._evictFloor || 0)) return; this.upsertGang(it, isNew); });
    setInterval(() => { for (const t of this.tokens.values()) if (t.source === 'gang' && t.gangTrack === 'v3fair' && t.stage === 'curve') this.gangFairState(t).catch(() => {}); }, 15_000).unref?.();   // 打新盘：进度 / 是否已发射从 pad 读
    this.gang.on('trade', (tr, { live }) => this.onGangTrade(tr, live));
    this.feeds.on('launch', (l) => this.upsertShrine(l));
    this.feeds.on('trade', (m) => this.onStreamTrade(m));
    this.feeds.on('graduated', (m) => { const t = this.get(m.token); if (t) { t.stage = 'dex'; this.emit('migrate', this.summary(t)); } });
    this.curve.start();
    this.four.start();
    this.fourRestore();
    setTimeout(() => this.fourDexCheck(), 20_000); this.fourDexTimer = setInterval(() => this.fourDexCheck(), 60_000);
    setTimeout(() => this.dexSweep(), 25_000); setInterval(() => this.dexSweep(), 60_000).unref?.();   // 没在看的已迁移币：外盘现价 / 市值
    setTimeout(() => this.launchSweep(), 5000); setInterval(() => this.launchSweep(), 15_000).unref?.();   // 已开盘的币：补发射时间（登记表 → 接口 / 链上 / DexScreener），没有 MC 的顺便补外盘市值
    this.gx = new GangExtras(this.provider); this.gx.start(); setInterval(() => this.gx.sweep(this.tokens.values()), 3000).unref?.();   // gang.fun 回购（税收接收人是回购合约）/ 押金（GangBond），只识别展示，买卖照常
    setInterval(() => this.taxToSweep(), 3000).unref?.();   // 列表里已有的 Gang V3 币：后台补读税收接收地址（每个币只读一次）
    this.loadFairSales(); setInterval(() => this.loadFairSales(), 30_000).unref?.();   // 打新盘：gang.fun 普通代币接口不列，重启后链上订阅也不会补以前的，从打新列表接口补
    this.gang.start(); this.gangChain.start(); this.flapChain.start(); this.gangPads.start(); this.setPlainOn(this.plainPref(), false); this.flapNft.start();
    this.feeds.start();
    // 顶栏 RPC 胶囊显示的是交易节点：行情读取的节点全在限流时改问交易节点（Chainstack，每 3 秒最多 1 次），交易节点也不通才算「断开」
    const blk = async () => { const t0 = Date.now(); try { this.block = await this.provider.getBlockNumber(); this.rpcMs = Date.now() - t0; this.rpcError = null; this.readError = null; } catch (e) { this.readError = e.shortMessage || e.message;
      try { const t1 = Date.now(); this.block = await this.tradeProvider.getBlockNumber(); this.rpcMs = Date.now() - t1; this.rpcError = null; } catch (e2) { this.rpcError = e2.shortMessage || e2.message; } } };
    const px = async () => { try { const j = await (await fetch(BNB_PRICE_URL)).json(); if (+j.price) this.bnbUsd = +j.price; } catch { /* 保留上次 */ } };
    const qpx = async () => { const qs = new Set([GANG_TOKEN]); for (const t of this.tokens.values()) if (t.quoteAddress && t.quote && !['BNB','WBNB','USDT','USDC','USD1'].includes(String(t.quote).toUpperCase())) qs.add(String(t.quoteAddress).toLowerCase());
      for (const a of FLAP_PLAIN_QUOTES) qs.add(a);
      for (const a of qs) { if (INFINITY_POOLS[a]) { try { const v = await infinityPriceUsd(this.provider, a); if (v > 0) { this.qUsd[a] = v; continue; } } catch { /* 读不到就照旧走 DexScreener */ } }
        try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + a, { signal: AbortSignal.timeout(6000) })).json(); const ps = (j.pairs || []).filter((x) => x.chainId === 'bsc' && x.baseToken?.address?.toLowerCase() === a && +x.priceUsd).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0)); if (FLAP_PLAIN_QUOTES.has(a) && this.plain.onP.flap) this.flapPlainScan(a, j.pairs).catch(() => {}); if (ps[0]) { this.qUsd[a] = +ps[0].priceUsd; if (a === GANG_TOKEN) this.gangMcap = +ps[0].marketCap || +ps[0].fdv || +ps[0].priceUsd * 1e9; } } catch { /* 保留上次 */ }
        if (!(this.qUsd[a] > 0)) { try { const v = await poolPriceUsd(this.provider, a, this.bnbUsd); if (v > 0) this.qUsd[a] = v; } catch { /* 下次再试 */ } } } };   // DexScreener 没给出价格：读链上池子兜底
    this.qpx = qpx; blk(); px(); setTimeout(qpx, 3000);
    this.timers = [setInterval(blk, 3000), setInterval(px, 30_000), setInterval(qpx, 60_000), setInterval(() => this.warm(), 8000), setInterval(() => this.flapHolders(), 90_000), setInterval(() => this.flapNftTick(), 6000)];
    setTimeout(() => this.flapHolders(), 15_000);
  }

  stop() { this.timers?.forEach(clearInterval); }

  key(a) { return String(a || '').toLowerCase(); }
  // 发射时间不再记「看到迁移的那一刻」：重启后补扫链上事件（Flap Portal 的 LaunchedToDEX 等）时看到的是几小时前的迁移，记成现在就排错了。
  // 看到迁移只记一个临时值 _migSeenAt（列表先按它排），马上让 launchSweep 按真实来源查：Flap = LaunchedToDEX 区块时间，Agent 曲线 = launchedAt，打新 = lastMintAt，其它 = DexScreener pairCreatedAt；
  // 查了 5 次都查不到才把临时值当真
  migNow() { return 0; }
  emit(ev, ...a) {
    if (ev === 'migrate' && a[0]?.address) { const t = this.get(a[0].address); if (t && !(t.migratedAt > 0)) { t._migSeenAt ||= Date.now(); t._launchTry = 0; t._launchTryAt = 0; a[0].migratedAt = t._migSeenAt; } }
    return super.emit(ev, ...a);
  }
  saveLaunch(t, ms = t.migratedAt, src = '') {
    const m = (this._launch ||= (() => { try { return JSON.parse(readFileSync(LAUNCH_FILE, 'utf8')); } catch { return {}; } })());
    if (!(ms > 0) || m[t.address]?.[0] === ms) { if (ms > 0) t.migratedAt = ms; return; }
    t.migratedAt = ms; m[t.address] = [ms, src];
    clearTimeout(this._launchSave); this._launchSave = setTimeout(() => { try { writeFileSync(LAUNCH_FILE, JSON.stringify(m)); } catch { /* 下次再存 */ } }, 5000);
  }
  // 每 15 秒：已开盘但不知道发射时间的币，先查登记表；还没有的按来源补（每个币 10 分钟最多查一次，最多 3 次）：
  // Flap Agent 曲线 = Reader.marketDetail().launchedAt（链上迁移时间）；Gang 打新 = gang.fun 打新列表的 lastMintAt（卖满那一笔即开盘）；
  // 其它（Flap / Four / Gang V2·V3 / 打新没在列表里的）= DexScreener 外盘池子的 pairCreatedAt（优先已知池子，其次和报价币配的 PancakeSwap 池，再其次最早的池子）。
  // 都查不到时前端用创建时间排。没有市值的（重启后的老打新盘 MC 显示 —）顺便用同一次 DexScreener 结果补上外盘市值 / 流动性
  async launchSweep() {
    if (this._launchRun) return; this._launchRun = true;
    try {
      const m = (this._launch ||= (() => { try { return JSON.parse(readFileSync(LAUNCH_FILE, 'utf8')); } catch { return {}; } })());
      const old = (this._launchOld ||= (() => { try { return JSON.parse(readFileSync(LAUNCH_OLD, 'utf8')); } catch { return {}; } })());
      const ds = [], now = Date.now();
      for (const t of this.tokens.values()) {
        if (t.stage !== 'dex') continue;
        if (t.migratedAt > 0) { if (!m[t.address]) this.saveLaunch(t, t.migratedAt, 'api'); }   // 接口给的毕业时间（Gang graduatedAt 等）
        else if (m[t.address]?.[0] > 0) t.migratedAt = m[t.address][0];
        else if (old[t.address] > 0) t._migSeenAt ||= old[t.address];   // 旧登记表：只当临时值
        if (!(t.migratedAt > 0) && (t._launchTry || 0) >= 5 && t._migSeenAt > 0) this.saveLaunch(t, t._migSeenAt, 'seen');
        const needAt = !(t.migratedAt > 0) && (t._launchTry || 0) < 5 && now - (t._launchTryAt || 0) > 120_000;
        const needMc = !t.dexMcapUsd && !(t.mcapUsd > 0) && !(t.price > 0) && now - (t._dsMcAt || 0) > 120_000;
        if (!needAt && !needMc) continue;
        if (needAt) { t._launchTry = (t._launchTry || 0) + 1; t._launchTryAt = now; }
        if (needAt && t.source === 'agent-curve' && t.market) {
          const d = await this.curve.detail(t.market).catch(() => null);
          if (d?.launchedAt > 0) { this.saveLaunch(t, d.launchedAt, 'curve'); if (!needMc) continue; }
        }
        const g = needAt && t.source === 'flap-nft' && this.flapNft.reg?.tokens?.[t.address];
        if (g?.dexBlock) {   // Flap Portal LaunchedToDEX 所在区块的时间
          const b = await this.provider.getBlock(g.dexBlock).catch(() => null);
          if (b?.timestamp) { this.saveLaunch(t, b.timestamp * 1000, 'flap-dex'); if (!needMc) continue; }
        }
        if (needMc) t._dsMcAt = now;
        ds.push(t);
      }
      if (ds.some((t) => t.source === 'gang' && t.gangTrack === 'v3fair' && !(t.migratedAt > 0))) {
        const l = await fairList('launched').catch(() => []);
        for (const x of l) { const t = this.get(x.token), at = Number(x.lastMintAt) || 0; if (t && !(t.migratedAt > 0) && at > 0) this.saveLaunch(t, at < 1e12 ? at * 1000 : at, 'fair'); }
      }
      for (let i = 0; i < ds.length; i += 30) {
        const chunk = ds.slice(i, i + 30);
        const r = await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + chunk.map((t) => t.address).join(','), { signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => null);
        if (!Array.isArray(r)) continue;
        for (const t of chunk) {
          const ps = r.filter((p) => String(p.baseToken?.address || '').toLowerCase() === t.address);
          if (!ps.length) continue;
          if (!(t.migratedAt > 0)) {
            const qa = String(t.quoteAddress || '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c').toLowerCase(), at = (l) => l.map((p) => +p.pairCreatedAt || 0).filter((x) => x > 0).sort((a, b) => a - b)[0];
            const ms = at(ps.filter((p) => t.pair && String(p.pairAddress).toLowerCase() === String(t.pair).toLowerCase()))
              || at(ps.filter((p) => /pancake/i.test(p.dexId || '') && String(p.quoteToken?.address || '').toLowerCase() === qa)) || at(ps);
            if (ms) this.saveLaunch(t, ms, 'dexscreener');
          }
          if (!t.dexMcapUsd && !(t.mcapUsd > 0) && !(t.price > 0)) {
            const b = ps.sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
            if (+b.marketCap || +b.fdv) Object.assign(t, { dexMcapUsd: +b.marketCap || +b.fdv, dexLiqUsd: b.liquidity?.usd || t.dexLiqUsd || 0 });
          }
        }
      }
    } finally { this._launchRun = false; }
  }
  autoQ(plat, k, block, tries = 0, fac = null) {
    const q = (this._autoQ ||= []), ex = this.get(k), pl = ex && PLAIN_SOURCES.has(ex.source);
    if ((ex && !pl && !tries) || q.length >= 200 || q.some((x) => x.k === k)) return;
    if (pl) this.tokens.delete(k);   // 内盘普通盘迁移了：去掉，按已开盘重新收录
    q.push({ plat, k, block, tries, fac }); this.autoRun();
  }
  async autoRun() {
    if (this._autoRun) return; this._autoRun = true;
    try { while (this._autoQ.length) { await this.autoOne(this._autoQ.shift()).catch(() => {}); await new Promise((ok) => setTimeout(ok, 1500)); } }
    finally { this._autoRun = false; }
  }
  async autoOne({ plat, k, block, tries, fac }) {
    const at = block ? await this.provider.getBlock(block).then((b) => b.timestamp * 1000).catch(() => 0) : 0;
    if (plat === 'genius') return this.geniusAdd(k, fac, at, tries, block);
    if (plat === 'flap') {
      if (!(await this.flapNft.check(k, { plain: true, auto: true }).catch(() => null))) return;
      const t = this.get(k); if (t && at) this.saveLaunch(t, at);
      return;
    }
    // Four 普通盘：DexScreener 刚迁移时可能还没收录，2 分钟后再试，最多 3 次
    const rows = await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + k, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null);
    const t = this.get(k) || await this.lookupDex(k, rows).catch(() => null);
    if (!t) { if (tries < 3) setTimeout(() => this.autoQ(plat, k, block, tries + 1), 120_000).unref?.(); return; }
    if (t.source !== 'dex') return;   // 已经按别的来源收录了（Agent 盘等）
    Object.assign(t, { launchPlat: 'four', autoLaunched: true, pinned: false });
    const ms = at || t.createdAt; this.saveLaunch(t, ms);
    const r = (this._autoReg ||= (() => { try { return JSON.parse(readFileSync(AUTO_FILE, 'utf8')); } catch { return {}; } })());
    r[k] = { plat: 'four', at: ms }; try { writeFileSync(AUTO_FILE, JSON.stringify(r)); } catch { /* 下次再存 */ }
  }
  // genius.fun 已毕业的币：DexScreener 有池子（流动性 ≥ MIN_LIQ_USD）就按外盘代币收录，否则从链上建：名字 / 代号 / 总量 / 报价币 + Infinity 池现价
  async geniusAdd(k, fac, at, tries = 0, block = null) {
    const gc = (to, fn, args = []) => this.provider.call({ to, data: GENIUS_I.encodeFunctionData(fn, args) }).then((r) => GENIUS_I.decodeFunctionResult(fn, r));
    let t = this.get(k);
    if (!t) { const rows = await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + k, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null); t = await this.lookupDex(k, rows).catch(() => null); }
    if (!t) {
      const lt = await gc(fac, 'getLaunchedToken', [k]).then((r) => r[0]).catch(() => null);
      if (!lt?.exists || Number(lt.phase) !== 2) { if (tries < 3) setTimeout(() => this.autoQ('genius', k, block, tries + 1, fac), 120_000).unref?.(); return; }   // 2 = PoolCreated
      const pair0 = lt.pairToken.toLowerCase(), wb = pair0 === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' || pair0 === ethers.ZeroAddress, pair = wb ? '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' : pair0;   // pairToken = 0 是原生 BNB 计价
      const [name, symbol, sup, qs] = await Promise.all([gc(k, 'name').then((r) => r[0]).catch(() => ''), gc(k, 'symbol').then((r) => r[0]).catch(() => '?'), gc(k, 'totalSupply').then((r) => Number(ethers.formatEther(r[0]))).catch(() => 1e9),
        wb ? 'BNB' : this.quoteMeta(pair).then((m) => m.symbol || '?').catch(() => '?')]);   // quoteMeta：读到才缓存，读失败下一分钟 gscan 再补
      t = this.base(k);
      Object.assign(t, { source: 'dex', platform: 'dex', symbol: symbol || '?', name, quote: qs, quoteAddress: pair, creator: lt.deployer.toLowerCase(), createdAt: at || Date.now(), stage: 'dex', progress: 100,
        maxSupply: sup || 1e9, dexDex: 'PancakeSwap Infinity', _gnFac: fac });
      await this.geniusPrice(t).catch(() => {});
    }
    if (t.source !== 'dex') return;
    Object.assign(t, { launchPlat: 'genius', autoLaunched: true, pinned: false }); if (fac) t._gnFac ||= fac;   // DexScreener 收录的也记下工厂，K 线从链上补
    if (!t.image) this.plain.geniusLogo(t).then(() => this.emit('detail', t.address)).catch(() => {});   // 图标：代币合约 logo()，经 genius.fun 图片代理（不受普通盘开关管）
    const ms = at || t.migratedAt || t.createdAt; this.saveLaunch(t, ms);
    const r = (this._autoReg ||= (() => { try { return JSON.parse(readFileSync(AUTO_FILE, 'utf8')); } catch { return {}; } })());
    r[k] = { plat: 'genius', at: ms, fac }; try { writeFileSync(AUTO_FILE, JSON.stringify(r)); } catch { /* 下次再存 */ }
  }
  // 现价（报价币 / 个）= Infinity CL 池 sqrtPrice²，币是 currency0 就直接用，否则取倒数（两边都按 18 位）
  async geniusPrice(t) {
    const gc = (to, fn, args = []) => this.provider.call({ to, data: GENIUS_I.encodeFunctionData(fn, args) }).then((r) => GENIUS_I.decodeFunctionResult(fn, r));
    if (!t._gnPool) { const [[id], [key]] = await Promise.all([gc(t._gnFac, 'poolIdFor', [t.address]), gc(t._gnFac, 'poolKeyFor', [t.address])]); t._gnPool = { id, tok0: key.currency0.toLowerCase() === t.address, pm: key.poolManager }; }
    const sq = Number((await gc(t._gnPool.pm, 'getSlot0', [t._gnPool.id]))[0]) / 2 ** 96, p = sq * sq;
    if (!(p > 0) || !isFinite(p)) return;
    t.price = t._gnPool.tok0 ? p : 1 / p;
    const u = this.quoteUsd(t); if (u) t.mcapUsd = t.price * (t.maxSupply || 1e9) * u;
  }
  // 普通盘总开关（默认关闭、不拉数据）：页面上任意一列打开「显示普通盘」时 POST /api/plain-pools 打开，记在 data/plain-pools.json。
  // 只管内盘阶段的普通盘（plainPools 的 Four / Flap / genius 轮询）+ MRVLB 这类报价币的 Flap 普通盘扫描；已开盘普通盘（autoStart）一直收录，量少
  plainPref() { try { const j = JSON.parse(readFileSync(PLAIN_FILE, 'utf8')); return { on: !!j.on, plats: j.plats || null }; } catch { return { on: false, plats: null }; } }
  // plats = { four, flap, genius }：页面分类里新创建 / 即将打满选了哪些平台的普通盘
  setPlainOn(on, save = true, plats = null) {
    if (on && typeof on === 'object') ({ on, plats } = on);   // 启动时传 plainPref() 的结果
    on = !!on; const p = plats && typeof plats === 'object' ? { four: !!plats.four, flap: !!plats.flap, genius: !!plats.genius } : null;
    this.plain.setOn(on, p);
    if (save) { try { writeFileSync(PLAIN_FILE, JSON.stringify({ on, plats: p, at: Date.now() })); } catch { /* 只在内存里 */ } }
    return { on: this.plain.on, plats: this.plain.onP };
  }
  // 启动：补回 48 小时内收录过的 Four 普通盘，Four 迁移事件从约 4 小时前扫起，之后每分钟补查；每 5 分钟清理一次超量 / 过期 / 小市值的
  async autoStart() {
    const r = (this._autoReg ||= (() => { try { return JSON.parse(readFileSync(AUTO_FILE, 'utf8')); } catch { return {}; } })());
    for (const [k, v] of Object.entries(r)) if (!(Date.now() - v.at < AUTO_KEEP_MS)) delete r[k];
    try { writeFileSync(AUTO_FILE, JSON.stringify(r)); } catch { /* ignore */ }
    const ks = Object.keys(r).filter((k) => !this.get(k));
    for (let i = 0; i < ks.length; i += 30) {
      const chunk = ks.slice(i, i + 30);
      const rows = await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + chunk.join(','), { signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => null);
      for (const k of chunk) {
        if (r[k].plat === 'genius') { await this.geniusAdd(k, r[k].fac, r[k].at, 3).catch(() => {}); continue; }
        const t = await this.lookupDex(k, rows).catch(() => null); if (t?.source === 'dex') { Object.assign(t, { launchPlat: 'four', autoLaunched: true, pinned: false }); this.saveLaunch(t, r[k].at); }
      }
    }
    const scan = async () => {
      try {
        const prov = this.four.provider, head = await prov.getBlockNumber();
        let from = this._fourLiqFrom || head - 20_000;
        while (from <= head) {
          const to = Math.min(head, from + 4999);
          for (const l of await prov.getLogs({ address: FOUR_TM2, topics: [T_FOUR_LIQ], fromBlock: from, toBlock: to })) {
            const k = ('0x' + String(l.data).slice(26, 66)).toLowerCase(); if (ethers.isAddress(k)) this.autoQ('four', k, l.blockNumber);
          }
          from = to + 1; this._fourLiqFrom = from;
        }
      } catch { /* 下一分钟接着从 _fourLiqFrom 扫 */ }
    };
    const gscan = async () => {
      try {
        const prov = this.four.provider, head = await prov.getBlockNumber();
        let from = this._gnFrom || head - 20_000;
        while (from <= head) {
          const to = Math.min(head, from + 4999);
          for (const l of await prov.getLogs({ address: GENIUS_FACTORIES, topics: [[T_GENIUS_GRAD, T_GENIUS_LAUNCH]], fromBlock: from, toBlock: to })) {   // 发币事件同一次 getLogs 带上（内盘普通盘，plainPools）
            if (l.topics[0] === T_GENIUS_LAUNCH) { if (this.plain.onP.genius) await this.plain.onGeniusLaunch(l).catch(() => {}); continue; }
            const k = ('0x' + String(l.topics[1]).slice(26)).toLowerCase(); if (ethers.isAddress(k)) this.autoQ('genius', k, l.blockNumber, 0, l.address);
          }
          from = to + 1; this._gnFrom = from;
        }
      } catch { /* 下一分钟接着扫 */ }
      for (const t of this.tokens.values()) if (t._gnFac) await this.geniusPrice(t).catch(() => {});   // 链上建的 genius 币每分钟刷新一次现价
      for (const t of this.tokens.values()) if (t.launchPlat === 'genius') {   // 之前没读到的计价币代号 / 图标，每分钟补一次
        if (t.quote === '?' && t.quoteAddress) { const m = await this.quoteMeta(t.quoteAddress).catch(() => null); if (m?.symbol) t.quote = m.symbol; }
        if (!t.image && (!t._gnLogoAt || Date.now() - t._gnLogoAt > 10 * 60_000)) { t._gnLogoAt = Date.now(); await this.plain.geniusLogo(t).catch(() => {}); }
      }
    };
    // Flap 已开盘普通盘回补：Portal 的 LaunchedToDEX 平时靠 flapNft 订阅（dexUnknown），停机期间迁移的、以及登记表被清过的，启动时从 48 小时前补一遍（约 80 个 / 48 小时，getLogs 每段 5000 块）
    const fscan = async () => {
      try {
        const prov = this.four.provider, head = await prov.getBlockNumber(), reg = this.flapNft.reg;
        let from = Math.max(reg.autoDexTo || 0, head - Math.ceil(AUTO_KEEP_MS / 450));
        while (from <= head) {
          const to = Math.min(head, from + 4999);
          for (const l of await prov.getLogs({ address: FLAP_PORTAL, topics: [T_FLAP_DEX], fromBlock: from, toBlock: to })) {
            const k = ('0x' + String(l.data).slice(26, 66)).toLowerCase(); if (ethers.isAddress(k) && !reg.tokens?.[k]) this.autoQ('flap', k, l.blockNumber);
          }
          from = to + 1; reg.autoDexTo = to;
        }
        this.flapNft.save();
      } catch { /* 下次启动接着补 */ }
    };
    fscan();
    scan(); setInterval(scan, 60_000).unref?.();
    gscan(); setInterval(gscan, 60_000).unref?.();
    setInterval(() => this.autoPrune(), 300_000).unref?.();
  }
  autoPrune() {
    const keep = this.keepSet?.() || new Set(), now = Date.now(), by = { flap: [], four: [] };
    for (const t of this.tokens.values()) if (t.autoLaunched && !keep.has(t.address)) (by[t.launchPlat || 'flap'] ||= []).push(t);
    for (const list of Object.values(by)) {
      list.sort((a, b) => (b.migratedAt || b.createdAt || 0) - (a.migratedAt || a.createdAt || 0));
      list.forEach((t, i) => {
        const at = t.migratedAt || t.createdAt || 0, mc = this.summary(t).mcapUsd || 0;
        if (!(i >= AUTO_MAX || now - at > AUTO_KEEP_MS || (mc > 0 && mc < AUTO_DUST_USD && now - at > 30 * 60_000))) return;
        this.tokens.delete(t.address);
        if (t.source === 'flap-nft' && this.flapNft.reg.tokens[t.address]?.auto) delete this.flapNft.reg.tokens[t.address];
        if (this._autoReg?.[t.address]) delete this._autoReg[t.address];
      });
    }
    this.flapNft.save(); if (this._autoReg) { try { writeFileSync(AUTO_FILE, JSON.stringify(this._autoReg)); } catch { /* ignore */ } }
  }
  get(a) { return a ? this.tokens.get(this.key(a)) : null; }

  base(address) {
    const k = this.key(address);
    if (!this.tokens.has(k)) {
      this.tokens.set(k, { address: k, symbol: '?', name: '', platform: 'flap', quote: 'BNB', createdAt: Date.now(), stage: 'curve', price: 0, mcapUsd: 0, raised: 0, target: 0, progress: 0,
        remaining: 0, holders: null, buys: 0, sells: 0,   // holders：null = 还不知道，页面显示「—」
 volume: 0, buyTax: 0, sellTax: 0, feeBps: null, trades: [], candles: [], creator: '', market: null });
      let np = 0; for (const x of this.tokens.values()) if (PLAIN_SOURCES.has(x.source)) np++;
      if (this.tokens.size - np > MAX) {   // 普通盘自己限量（plainPools.prune），不占这 1000 个名额
        const keep = this.keepSet?.() || new Set();   // 持有中、收藏的币（server.js 设置），永远不淘汰
        const old = [...this.tokens.values()].filter((t) => !t.pinned && !keep.has(t.address) && t.source !== 'agent-curve' && t.source !== 'flap-nft' && !(t.source === 'four-agent' && t.stage === 'dex')).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (old) { this.tokens.delete(old.address); this._evictFloor = Math.max(this._evictFloor || 0, old.createdAt || 0); }   // 比这还老的盘不值得再收录（见 gang.on('token')）
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

  // 已迁移的币（Four 以外，Four 由 fourDexCheck 管）：卡片 / 列表的市值以前只在选中时（applyDex / dexCandles）更新，没选中的一直停在迁移那一刻
  // （BATCOIN 卡片 $40.84K，详情 $272K）。每 60 秒 DexScreener 批量查一次，按最深的外盘池子（不含 flapsh / fourmeme 内盘对）更新现价和市值。
  // 市值 = 现价 × 总量 × 报价币美元价，和详情头部、K 线同一口径（不用 DexScreener 的 marketCap，它有时按流通量算）。正在看的币（15 秒内 refresh 过）链上读得更准，跳过
  async dexSweep() {
    if (this._dexSweepRun) return; this._dexSweepRun = true;
    try {
      const list = [...this.tokens.values()].filter((t) => t.stage === 'dex' && t.source !== 'four-agent' && !(Date.now() - (t._viewAt || 0) < 15_000));
      for (let i = 0; i < list.length; i += 30) {
        const chunk = list.slice(i, i + 30);
        const r = await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + chunk.map((t) => t.address).join(','), { signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => null);
        if (!Array.isArray(r)) continue;
        for (const t of chunk) {
          const p = r.filter((x) => String(x.baseToken?.address || '').toLowerCase() === t.address && +x.priceUsd && !['flapsh', 'fourmeme'].includes(x.dexId))
            .sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
          const q = this.quoteUsd(t); if (!p || !q || Date.now() - (t._viewAt || 0) < 15_000) continue;
          t.price = +p.priceUsd / q; t.mcapUsd = t.dexMcapUsd = t.price * (t.maxSupply || 1e9) * q;
          if (p.liquidity?.usd) t.dexLiqUsd = p.liquidity.usd;
        }
        await new Promise((ok) => setTimeout(ok, 1200));
      }
    } finally { this._dexSweepRun = false; }
  }

  // 以 FLAP_PLAIN_QUOTES 计价的普通 Flap 盘：DexScreener 的 flapsh 交易对另一边就是梗币（…7777）；新的逐个问 Portal（flapNft.check plain），是内盘 / 已迁移的就收录
  async flapPlainScan(a, pairs) {
    if (this.plainBusy) return; this.plainBusy = true;
    try {
      for (const x of pairs || []) {
        if (x.chainId !== 'bsc' || x.dexId !== 'flapsh') continue;
        const m = (x.baseToken?.address?.toLowerCase() === a ? x.quoteToken : x.baseToken)?.address?.toLowerCase();
        if (!m || !ethers.isAddress(m) || this.tokens.has(m) || this.flapNft.reg?.tokens?.[m]) continue;
        await this.flapNft.check(m, { plain: true, at: +x.pairCreatedAt || undefined }).catch(() => null);
      }
    } finally { this.plainBusy = false; }
  }
  // Flap Portal 门槛盘：名字 / 代号 / 图标（metaURI 是 IPFS CID）+ 门槛 NFT 信息 + 内盘状态
  async upsertFlapNft(g, { restore } = {}) {
    const k = g.token, existed = this.tokens.has(k);
    if (existed && this.get(k).source !== 'flap-nft' && this.get(k).source !== 'flap-plain') return;
   // flap-plain = 战壕里的 Flap 普通盘，打开 / 下单时升级成这里的普通盘
    // 先同步登记进列表（门槛 + 来源），名字 / 状态 / NFT 信息随后补上：搜索、钱包 2 收到订单时不用等这些读取
    const t = this.base(k);
    if (g.meta) Object.assign(t, { symbol: t.symbol === '?' ? g.meta.symbol || '?' : t.symbol, name: t.name || g.meta.name || '' });   // 发币事件 / 上次读到的名字先用上：节点限流、刚发币节点读不到时也不显示「?」
    Object.assign(t, { source: 'flap-nft', platform: 'flap', agentExclusive: g.nft === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f', quote: t.quote || 'BNB', createdAt: g.at || g.seenAt, maxSupply: 1e9,
      nftGate: { capPct: 2, ...t.nftGate, nft: g.nft, removed: !!g.removed, plain: !!g.plain, known: g.nft === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' } });
    if (g.auto) t.autoLaunched = true;
    {
      const [st, info] = await Promise.all([this.flapNftMeta(t).catch(() => {}), this.flapNft.state(k).catch(() => null), g.plain ? null : this.flapNft.nftInfo(g.nft).catch(() => null)]).then((r) => r.slice(1));
      if (!g.at && g.block) { try { g.at = (await this.provider.getBlock(g.block)).timestamp * 1000; this.flapNft.save(); } catch { /* 用发现时间 */ } }
      Object.assign(t, { createdAt: g.at || g.seenAt });
      if (info) Object.assign(t.nftGate, { name: info.name, symbol: info.symbol, image: info.image, known: info.known });
      if (st) await this.applyFlapNftState(t, st);
      (g.auto ? Promise.resolve() : this.flapNftHistory(t)).then(() => {   // 自动收录的已开盘普通盘不补内盘成交（太多），只读外盘价
        if (t.stage === 'dex') return this.dexRefresh(t).then(() => this.emit('detail', t.address)); }).catch(() => {});   // 内盘成交从创建起补齐；已迁移的顺便读一次外盘价，列表里市值不再是「—」
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
    this.loadMeta(t, ipfsUrl(meta) || ipfsUrl(g?.meta?.uri));
    if (g && (name || symbol || meta)) { const m = { ...g.meta, ...(name && { name }), ...(symbol && { symbol }), ...(meta && { uri: ipfsUrl(meta) }) }; if (JSON.stringify(m) !== JSON.stringify(g.meta || {})) { g.meta = m; this.flapNft.save(); } }
  }
  // 计价币代号 / 小数位：读链上，读到就按地址缓存（所有盘共用）；读失败（节点限流）不缓存，下次再读。以前只在计价币地址第一次出现时读一次，失败就一直显示「?」（Marvel Dog / MRVLB 2026-10-28）
  async quoteMeta(addr) {
    const k = String(addr).toLowerCase(); this.qMeta ||= new Map(); const c = this.qMeta.get(k); if (c) return c;
    const i = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
    const rd = (fn) => this.provider.call({ to: addr, data: i.encodeFunctionData(fn) }).then((r) => i.decodeFunctionResult(fn, r)[0]).catch(() => null);
    const [symbol, dec] = await Promise.all([rd('symbol'), rd('decimals')]);
    const m = { symbol: symbol || getRoute(k)?.symbol || null, decimals: dec == null ? null : Number(dec) };
    if (m.symbol && m.decimals != null) this.qMeta.set(k, m);
    return m;
  }
  async applyFlapNftState(t, st) {
    if (st.quote !== ethers.ZeroAddress) {
      if (t.quoteAddress?.toLowerCase() !== st.quote.toLowerCase()) Object.assign(t, { quoteAddress: st.quote, quote: '?', quoteDec: null, flapNativeSwap: st.nativeSwap });
      if (t.quote === '?' || t.quoteDec == null) { const m = await this.quoteMeta(st.quote); if (m.symbol) t.quote = m.symbol; if (m.decimals != null) t.quoteDec = m.decimals; }
    }
    if (!t.quoteKnown) { t.quoteKnown = true; this.revalueTrades(t); }   // 计价币确定了：之前进来的成交按它重算美元
    // Portal 的储备、价格是报价币最小单位：按报价币小数位换算（目前见到的计价币都是 18 位，qs = 1）
    const qs = 10 ** (18 - (t.quoteDec ?? 18));
    const price = Number(ethers.formatEther(st.price)) * qs;
    t.raised = Number(ethers.formatEther(st.reserve)) * qs; t.progress = st.status === 4 ? 100 : Math.min(100, st.progress);
    t.target = t.progress > 0 && t.progress < 100 ? t.raised / (t.progress / 100) : t.target;
    t.remaining = Math.max(0, Number(ethers.formatEther(st.dexThresh)) - Number(ethers.formatEther(st.circulating)));
    // 有链上成交以后 K 线只按成交画（成交时间、成交后价格）；还没补到成交时才用轮询价格兜底。已迁移的内盘价格读出来是 0，不覆盖
    if (price > 0 && price !== t.price) { t.price = price; if (!t.nftHistAt && !t.nftKeys?.size) this.pushCandle(t, Date.now(), price, 0); }
    if (st.status !== 4 && t.price > 0) t.mcapUsd = t.price * 1e9 * this.quoteUsd(t);
    if (st.status === 4 && t.stage === 'curve') { t.stage = 'dex'; t.progress = 100; this.emit('migrate', this.summary(t)); }
    else if (st.status === 1 && !t.migrated) t.stage = 'curve';
  }
  // 税率 / 受益人 / 分红：不变的部分只读一次并存盘（flap-tax-fixed.json）；之后 5 分钟只刷新三个累计金额（累计分红、营销金额会变）
  async flapNftTax(t, force = false) {
    if (!force && t.flapTax && Date.now() - t.flapTax.at < 300_000) return;
    const m = (this._flapFixed ||= (() => { try { return JSON.parse(readFileSync(FLAP_TAX_FILE, 'utf8')); } catch { return {}; } })());
    const v = await this.flapNft.taxInfo(t.address, m[t.address] || null); t.flapTax = v;
    if (!m[t.address] && v.processor) {   // 读全了才存（divSym 读失败是 '?'，下次重启再读）
      m[t.address] = Object.fromEntries(FLAP_FIXED_KEYS.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
      if (v.divSym === '?') delete m[t.address];
      clearTimeout(this._flapFixedSave); this._flapFixedSave = setTimeout(() => { try { writeFileSync(FLAP_TAX_FILE, JSON.stringify(m)); } catch { /* 下次重启重读 */ } }, 5000);
    }
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
        // 状态没变的盘逐步放慢（6 秒 → 12 → 24 → 最多 60 秒），一变或链上推送来一笔成交就回到 6 秒。以前几十个没人买的内盘每 6 秒都读一遍
        if (t.stage === 'curve' && Date.now() - (t._nftAt || 0) >= (t._nftEvery || 6000) - 500) try {
          const st = await this.flapNft.state(t.address), h = `${st.status}|${st.reserve}|${st.circulating}`;
          t._nftAt = Date.now(); t._nftEvery = h === t._nftH ? Math.min(60_000, (t._nftEvery || 6000) * 2) : 6000; t._nftH = h;
          await this.applyFlapNftState(t, st); await this.flapNftTax(t);
        } catch { /* 下一轮 */ }
        // 名字没读到就重试（已迁移的也要：以前只重试内盘，迁移盘读失败一次就一直显示「?」）
        // 刚发币时节点常读不到：5 秒、10 秒、20 秒后重试，之后每 30 秒；名字有了、只差图标 / 简介的，单独重试元数据（不再读链）
        if (!t.name || t.symbol === '?' || !t.metaUrl) { if (Date.now() - (t.metaTryAt || 0) > Math.min(30_000, 5000 * 2 ** (t.nameTries || 0))) { t.nameTries = (t.nameTries || 0) + 1; await this.flapNftMeta(t).catch(() => {}); } }
        else if (!t.metaOk) this.loadMeta(t, t.metaUrl);
      }
    } finally { this.nftBusy = false; }
  }

  // 图标 / 简介 / 社交链接，异步补上；列表每 0.5 秒推送一次，到了就显示
  // 以前设了 metaUrl 就不再请求：IPFS 网关 429 / 刚发币元数据还没传开时失败一次，图标就一直是「?」（2026-10-28 门槛盘 201 个里只有 28 个有图）。
  // 现在没拿到结果的同一个 url：前 40 次每 3 秒重试一次（约 2 分钟，自己定时，不等调用方），之后按 15 秒、30 秒、1 分钟…最多 10 分钟；拿到一次就不再请求
  metaWait(t) { const n = t.metaTries || 0; return n < 40 ? 3000 : Math.min(600_000, 15_000 * 2 ** (n - 40)); }
  loadMeta(t, url) {
    if (!url) return;
    if (t.metaUrl === url && (t.metaOk || Date.now() - (t.metaAt || 0) < this.metaWait(t) - 100)) return;
    if (t.metaUrl !== url) Object.assign(t, { metaUrl: url, metaOk: false, metaTries: 0 }); else t.metaTries = (t.metaTries || 0) + 1;
    t.metaAt = Date.now();
    this.meta.get(url, ({ metaCreator, ...m }) => { Object.assign(t, m); t.metaOk = true; if (!t.creator && metaCreator) t.creator = metaCreator; this.emit('detail', t.address); if (m.image) this.emit('image', m.image); }, { front: !t.metaTries });
    if ((t.metaTries || 0) < 40) setTimeout(() => { if (!t.metaOk && t.metaUrl === url) this.loadMeta(t, url); }, 3000).unref?.();   // 创建者：链上没给的（Flap Portal 盘）用元数据里的
  }

  // 搜索粘贴地址：已在列表直接返回；否则查 Four 链上，查到就加进列表；都不是内盘时按普通外盘代币收录（lookupDex）
  async lookup(address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    let t = this.get(address);
    if (t?.source === 'flap-plain') { await this.flapNft.check(address, { plain: true, at: t.createdAt }).catch(() => null); t = this.get(address); }   // 普通盘升级成可交易的 flap-nft 普通盘
    else if (t?.source === 'four-plain' && !t._ofTried) { t._ofTried = true; await this.four.lookup(address).catch(() => null); t = this.get(address); if (t?.source === 'four-agent') t.viewOnly = false; }   // OpenFour 非 Agent 模板的盘能下单
    const ds = t ? null : cache.fetchJson('https://api.dexscreener.com/tokens/v1/bsc/' + address.toLowerCase(), 15).catch(() => null);   // 和链上查找同时发出，外盘代币不用多等
    if (!t && await this.four.lookup(address)) t = this.get(address);
    if (!t) t = await this.lookupGangV2(address).catch(() => null);
    if (!t && await this.flapNft.check(address, { plain: true }).catch(() => null)) t = this.get(address);
    if (!t) t = await this.lookupFair(address).catch(() => null);
    if (!t) t = await this.lookupDex(address, await ds).catch(() => null);
    if (!t) return null;
    t.pinned = true;               // 手动打开的盘不被自动淘汰
    return this.summary(t);
  }

  // 普通外盘代币（GENIUS、EWYB 这类不在任何内盘平台的币）：DexScreener 最深的池子流动性 ≥ QUOTE_MIN_LIQ_USD（默认 $2 万）才收录，
  // 计价 = 那个池子的另一边。K 线 / 现价走 dexCandles（DexScreener + GeckoTerminal，不读链），买卖走币安聚合（不直连 PancakeSwap V2，见 liveTrader.dexTrade）
  async lookupDex(address, rows) {
    const a = address.toLowerCase();
    const ps = (Array.isArray(rows) ? rows : []).filter((p) => String(p.baseToken?.address).toLowerCase() === a && +p.priceUsd && !String(p.pairAddress).includes(':') && !['fourmeme', 'flapsh'].includes(p.dexId))
      .sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0));
    const p = ps[0]; if (!p || !((p.liquidity?.usd || 0) >= MIN_LIQ_USD)) return null;
    const qa = String(p.quoteToken?.address || '').toLowerCase(), wb = qa === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    if (!wb && !['USDT', 'USDC', 'USD1'].includes(String(p.quoteToken?.symbol).toUpperCase()) && +p.priceNative > 0) this.qUsd[qa] ||= +p.priceUsd / +p.priceNative;   // 计价币美元价先用这个池子推出来，qpx 之后会刷新
    if (this.get(a)) return this.get(a);
    const t = this.base(a), sup = +p.fdv && +p.priceUsd ? +p.fdv / +p.priceUsd : 1e9;
    Object.assign(t, { source: 'dex', platform: 'dex', symbol: p.baseToken.symbol || '?', name: p.baseToken.name || '', quote: wb ? 'BNB' : p.quoteToken.symbol, quoteAddress: qa,
      createdAt: p.pairCreatedAt || Date.now(), stage: 'dex', progress: 100, maxSupply: sup, image: p.info?.imageUrl || null, pinned: true,
      pair: p.pairAddress, dexPool: p.pairAddress, dexLiqUsd: p.liquidity.usd, dexMcapUsd: +p.marketCap || +p.fdv || 0, dexPriceUsd: +p.priceUsd, dexDex: `${p.dexId}${p.labels?.length ? ' ' + p.labels.join('/') : ''}`,
      website: p.info?.websites?.[0]?.url || '', twitter: p.info?.socials?.find((x) => x.type === 'twitter')?.url || '', telegram: p.info?.socials?.find((x) => x.type === 'telegram')?.url || '' });
    const q = this.quoteUsd(t); if (q) t.price = +p.priceUsd / q;
    return t;
  }

  // Gang V2 新盘：本后端的订阅还没看到、但主后端已经发来狙击订单时（钱包 2 等），直接读链上曲线把它加进列表
  async lookupGangV2(address) {
    this._gv2 ||= new GangV2(this.provider, null);
    const { pad, c } = await this._gv2.curve(address);
    const a = address.toLowerCase(), erc = new ethers.Contract(address, ['function name() view returns (string)', 'function symbol() view returns (string)'], this.provider);
    // gang.fun /api/tokens/<CA>（约 0.15 秒）：创建时间、持有人、成交笔数；接口没收录就用现在的时间
    const [name, symbol, info] = await Promise.all([erc.name().catch(() => ''), erc.symbol().catch(() => '?'), fetch('https://gang.fun/api/tokens/' + a, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
    const q = String(c.quote).toLowerCase(), wb = q === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' || c.quote === ethers.ZeroAddress, quoteSymbol = wb ? 'BNB' : await this.gangChain.symbolOf(q);
    // 已筹 / 目标 / 进度从链上曲线读（以前收录时都是 0，页面显示 0/15、0.00%）
    const dec = wb ? 18 : await this._gv2.decimals(q).catch(() => 18), raised = Number(ethers.formatUnits(BigInt(c.realQuote || 0), dec)), grad = Number(ethers.formatUnits(BigInt(c.gradAmt || 0), dec));
    if (this.get(address)) return this.get(address);   // 读链期间订阅已经收录
    if (!c.v3 && !this.gang.v2.has(a)) this.gang.v2.set(a, { quoteUsd: Number(info?.quoteUsd) || 0 });   // V2 盘的成交接口走 /stocks
    this.upsertGang({ address: a, name: name || info?.name || '', symbol: symbol || info?.symbol || '?', creator: String(c.creator).toLowerCase(), createdAt: Number(info?.createdAt) || Math.floor(Date.now() / 1000),
      graduated: !!c.graduated, raisedQuote: raised, progressPct: c.graduated ? 100 : grad > 0 ? Math.min(100, (raised / grad) * 100) : 0, gradAmtQuote: grad || undefined, holders: info?.holders ?? null, trades: info?.trades, lastTradeAt: info?.lastTradeAt,
      quoteSymbol, quoteAddress: q, track: c.v3 ? 'v3' : 'v2', taxed: !!c.taxed }, false);
    const t = this.get(address); if (t && CHAIN_HIST_PADS.has(String(pad).toLowerCase())) t._gangPad = String(pad).toLowerCase();
    return t;
  }

  // Gang V3 曲线盘 + 打新盘：以前只靠链上 Created 事件收录，重启后之前创建的都没了。启动时和每 30 秒从 gang.fun 列表补齐：
  // V3 = /api/v3/tokens（没毕业的 + 24 小时内毕业的），打新 = /api/fair/sales 的认购中 + 24 小时内开盘的（进度等从 pad 读，见 gangFairState）
  async loadFairSales() {
    const day = Date.now() / 1000 - 86_400;
    try {
      const j = await fetch('https://gang.fun/api/v3/tokens?limit=100', { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
      for (const x of j?.items || []) {
        // 已经由链上 Created 事件收录的 V3 盘：事件里已筹 / 进度是 0，gang.fun 的 V2 列表又不收 V3，以前就一直显示 0/15。这里按接口刷新已筹 / 目标 / 进度，没有图标的补上
        const ex = x?.address && this.get(x.address);
        if (ex && ex.source === 'gang' && ex.gangTrack === 'v1') { ex.gangTrack = 'v3'; this.gangV2Curve(ex).catch(() => {}); }   // 在 V3 列表里却被标成老盘的（链上收录时 track 丢了）：改回 V3，战壕和买卖才走对
        if (ex && ex.source === 'gang' && /^v3/.test(ex.gangTrack || '') && x.graduated && ex.stage === 'curve') {   // V3 盘发射时链上没有事件推给我们：按接口状态移到「已发射」，以前要重启才过去
          Object.assign(ex, { stage: 'dex', progress: 100, pair: x.pair || ex.pair || null }); ex.migratedAt ||= x.graduatedAt ? x.graduatedAt * 1000 : this.migNow() || undefined; this.emit('migrate', this.summary(ex));
        }
        if (ex && ex.source === 'gang' && ex.gangTrack === 'v3' && !x.graduated) {   // 已经读到链上曲线的（_chainCurve）已筹 / 进度以链上为准，只补图标
          const dec = Number(x.quoteDecimals) || 18, raised = Number(ethers.formatUnits(BigInt(x.realQuote || 0), dec)), grad = Number(ethers.formatUnits(BigInt(x.gradAmt || 0), dec));
          if (!ex._chainCurve && (raised > 0 || Number(x.progressPct) > 0)) Object.assign(ex, { raised, progress: Number(x.progressPct) || (grad > 0 ? Math.min(100, (raised / grad) * 100) : ex.progress), ...(grad > 0 && { target: grad }) });
          if (x.hasLogo && x.logoUrl && !/^https?:/i.test(ex.image || '')) ex.image = x.logoUrl;
        }
        if (!x?.address || ex || (x.graduated && !(x.graduatedAt > day))) continue;
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
        graduated: x.status === 'launched', graduatedAt: x.status === 'launched' && x.lastMintAt > 0 ? (x.lastMintAt < 1e12 ? x.lastMintAt : x.lastMintAt / 1000) : null, raisedQuote: 0, progressPct: 0, quoteSymbol: 'BNB', quoteAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', track: 'v3fair' }, false);   // 打新卖满那一笔就开盘：lastMintAt = 发射时间
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
    const raised = Number(it.raisedQuote ?? it.raisedBnb) || 0, pct = Number(it.progressPct) || 0, chainCurve = t._chainCurve;
    Object.assign(t, {
      source: 'gang', platform: 'gang', agentExclusive: true, symbol: it.symbol, name: it.name, quote: it.quoteSymbol || 'BNB', quoteAddress: it.quoteAddress || null, creator: it.creator,
      creatorName: it.creatorHandle || null, feeBps: 100, sellFeeBps: 100, stage: it.graduated ? 'dex' : 'curve', migratedAt: it.graduatedAt ? it.graduatedAt * 1000 : t.migratedAt, raised: t._qDec && t._qDec !== 18 ? t.raised : raised, progress: pct, target: t._qDec && t._qDec !== 18 ? t.target : it.gradAmtQuote || (pct > 0 ? Math.round((raised / (pct / 100)) * 10) / 10 : (t.target || 15)),   /* 非 18 位报价币（XAUt）接口按 18 位给，数会小 1e12 倍，用链上读的 */ gangTrack: /^v3/.test(t.gangTrack || '') ? t.gangTrack : it.track || 'v1' /* 链上认出的 V3 不被接口的 v2 覆盖 */, remaining: t._v2Rem ?? null,   // 剩余可售：V2 从合约读，读到之前 / 老盘未知 = null（页面显示「—」）
     
      price: (t._qDec && t._qDec !== 18 ? 0 : Number(it.priceQuote ?? it.priceBnb)) || t.price, mcapUsd: (t._qDec && t._qDec !== 18 ? 0 : Number(it.fdvUsd)) || t.mcapUsd || 0,   // 币股等报价币盘接口常不给 fdvUsd，别把成交算出的市值覆盖成 0
      holders: it.holders ?? null, pair: it.pair || t.pair || null, tradeCount: it.trades ?? t.tradeCount ?? 0,   // 2026-10-27 起这几项被上一行的注释吞掉没有赋值
    });
    if (chainCurve) Object.assign(t, chainCurve);   // 接口数据不全的 pad（CHAIN_HIST_PADS）：已筹 / 目标 / 进度用 gangV2Curve 读的链上值，不被接口的旧数覆盖
    if (t.gangTrack === 'v3fair' && t._fair) this.applyFair(t);   // 打新币：接口 / 链上事件按内盘给的 0/15、curve 不对，用 pad 读到的覆盖
    else if (t.gangTrack === 'v3fair' && !t._fairAt) this.gangFairState(t).catch(() => {});   // 新打新盘（链上 Created 事件刚进来）：马上读一次 pad，不等 15 秒轮询
    if (!existed) t.createdAt = it.createdAt * 1000;
    if (it.lastTradeAt) t.lastTradeAt = Math.max(t.lastTradeAt || 0, it.lastTradeAt * 1000);
    if (it.creatorHandle) this.names.set(it.creator, it.creatorHandle);
    if (it.logo) t.image = it.logo;
    if (it.taxed != null) t.gangDiv = { taxed: !!it.taxed, taxBps: it.taxBps ?? (it.taxed ? 100 : 0), vault: it.dividendVault || t.gangDiv?.vault || null, stats: it.dividends || t.gangDiv?.stats || null };   // 分红币 / 不分红（见 gangFun.fromV2）
    // V2 报价币（GANG / ZEC / 币股…）的美元价用 gang.fun 给的，quoteUsd() 换美元要用
    if (it.quoteAddress && it.quoteUsd && !(this.qUsd[it.quoteAddress.toLowerCase()] > 0)) this.qUsd[it.quoteAddress.toLowerCase()] = it.quoteUsd;
    // 成交量统一按报价币计、从开盘起累计（和 Four / Flap / V3 一个口径）：V2 的全部成交在选中时从 gang.fun 拉（refresh → gang.history），之后实时累加；
    // 还没拉过的先用接口的 24 小时美元成交量 ÷ 报价币美元价当占位，页面标成「24h」。以前接口给的是 24 小时 BNB 计的量，却按报价币显示
    if (!t._volFull) {
      const q = this.quoteUsd(t);
      if (it.volume24hUsd != null && q > 0) { t.volume = it.volume24hUsd / q; t.volumeH24 = true; }
      else if (it.volume24hBnb != null && (!t.quoteAddress || ['BNB', 'WBNB'].includes(String(t.quote).toUpperCase()))) { t.volume = Number(it.volume24hBnb) || 0; t.volumeH24 = true; }
    }
    if (isNew && !existed) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - t.createdAt) });   // 链上已经先发现过的，接口再看到时不重复提示
    // 最近有成交的几个 + 当前选中的，定时拉成交。一次轮询会连着 upsert 几百个币，排序只做一次（1 秒内合并）
    clearTimeout(this._hotT); this._hotT = setTimeout(() => { this._hotT = null; this.gang.setHot([...this.tokens.values()].filter((x) => x.source === 'gang' && x.lastTradeAt).sort((a, b) => b.lastTradeAt - a.lastTradeAt).slice(0, 5).map((x) => x.address)); }, 1000);
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
    const ex = this.get(it.address);
    if (ex) { ex._srcPad ||= it.srcPad; ex._srcTopic ||= it.srcTopic; watchToken(ex, 'Gang 链上新盘（接口已先收录）'); return; }
    this.gang.seen.set(it.address, -1);
    this.upsertGang(it, true);
    const t = this.get(it.address);
    if (t) { t._srcPad = it.srcPad; t._srcTopic = it.srcTopic; watchToken(t, 'Gang 链上新盘'); }   // 路由自检：盘型和发出创建事件的合约对不上就报警
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
    const qs = 10 ** (18 - (t.quoteDec ?? 18)), bnb = tr.bnb * qs, price = tr.price * qs;   // 成交金额 / 价格按报价币小数位换算（18 位时不变）
    t.volume += bnb;
    if (t.holdersKnown && tr.trader) {
      const v = (t.bal.get(tr.trader) || 0) + (tr.side === 'buy' ? tr.tokens : -tr.tokens);
      if (v > 1e-6) t.bal.set(tr.trader, v); else t.bal.delete(tr.trader);
      t.holders = t.bal.size;
    }
    return { ts: tr.ts, side: tr.side, bnb, tokens: tr.tokens, price, trader: tr.trader, tx: tr.tx };
  }
  onFlapNftTrade(tr) {
    const t = this.get(tr.token); if (!t || t.source !== 'flap-nft') return;
    const trade = this.ingestFlapNft(t, tr); if (!trade) return;
    if (t.stage === 'curve' && tr.ts >= (t.lastTradeAt || 0)) { const q = this.tradeUsd(t); if (q && trade.price > 0) t.mcapUsd = trade.price * 1e9 * q; }
    this.addTrade(t, trade);
    if (Date.now() - tr.ts < 60_000) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, mcapUsd: t.mcapUsd });
  }
  // 从创建起的全部内盘成交重建：买卖笔数、成交量、持有人（净买入 > 0 的地址）、K 线（换掉轮询价格画的点，外盘部分留着）、最近 100 笔
  async flapNftHistory(t, urgent = false) {
    if (t.nftHistAt && Date.now() - t.nftHistAt < 30_000) return;
    const list = await this.flapNft.history(t.address, urgent);
    Object.assign(t, { nftKeys: new Set(), buys: 0, sells: 0, volume: 0, holdersKnown: true, bal: new Map(), holders: 0, nftHistAt: Date.now() });
    t.candles = (t.candles || []).filter((c) => c.dex); t.trades = (t.trades || []).filter((x) => x.dex);
    const q = this.tradeUsd(t), keep = [];
    for (const tr of list) { const x = this.ingestFlapNft(t, tr); if (!x) continue; this.noteFirstBuy(t, x); if (x.price) this.pushCandle(t, x.ts, x.price, x.bnb); keep.push(x); }
    for (const x of keep.slice(-100)) { x.usd = q > 0 ? x.bnb * q : null; x.mcapUsd = x.price * 1e9 * q; x.name = this.names.peek(x.trader); }
    t.trades = [...keep.slice(-100), ...t.trades].sort(newFirst).slice(0, 100);
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
    for (const x of list) { if (x.side === 'buy') buys++; else sells++; vol += x.bnb || 0; if (x.price) this.pushCandle(t, x.ts, x.price, x.bnb || 0); this.noteDev(t, x); }
    Object.assign(t, { buys: Math.max(t.buys || 0, buys), sells: Math.max(t.sells || 0, sells), volume: Math.max(t.volume || 0, vol) });
    const seen = new Set(t.trades.map((x) => `${x.tx}:${x.side}`));
    for (const x of list.slice(-100)) if (!seen.has(`${x.tx}:${x.side}`)) t.trades.push({ ts: x.ts, side: x.side, bnb: x.bnb, tokens: x.tokens, price: x.price, trader: x.trader, tx: x.tx, usd: x.bnb * q, mcapUsd: x.price * (t.maxSupply || 1e9) * q, name: this.names.peek(x.trader) });
    t.trades.sort(newFirst); if (t.trades.length > 100) t.trades.length = 100;
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
    if (t.gangTrack === 'v3' || t._volFull) t.volume = (t.volume || 0) + tr.bnb * this.qScale(t);   // 内盘成交量：开盘起的从历史算（V3 链上 gangV3History / V2 gang.history），之后的实时累加
    // 链上事件和 gang.fun 接口都把报价币金额按 18 位小数给；BEM（8 位）、XAUt（6 位）这类要乘回 10^(18-dec)
    const k = this.qScale(t);
    const trade = { ts: tr.ts, side: tr.side, bnb: tr.bnb * k, tokens: tr.tokens, price: tr.price * k, trader: tr.trader, tx: tr.tx, name: tr.name, blk: tr.blk, li: tr.li };
    this.addTrade(t, trade);
    // V3 内盘：每笔实时成交后 1 秒内重读一次链上曲线（已筹 / 进度 / 底池 / 剩余），不等 20 秒节流和接口轮询
    if (live && t.gangTrack === 'v3' && t.stage === 'curve' && !t._curveQ) t._curveQ = setTimeout(() => { t._curveQ = null; t._v2At = 0; this.gangV2Curve(t).catch(() => {}); }, 800);
    if ((k !== 1 || t.gangTrack === 'v3') && trade.price > 0 && trade.ts >= (t.lastTradeAt || 0) - 1) { const u = this.quoteUsd(t); if (u) t.mcapUsd = t.price * 1e9 * u; }   // 接口的 fdvUsd 也按 18 位算错了，用成交价重算；V3 不在接口轮询里，市值只能靠成交价更新（GANGBALL 0xb1f2… 2026-10-29 一直停在开盘时的 $3.5K，被「即将打满」市值下限筛掉）
    if (live) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: trade.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });   // Gang V2 的金额是报价币（GANG / BNCB…），按报价币价格换美元
  }

  // Gang V3 曲线盘从开盘起的全部成交（pad 的链上 Buy / Sell，真实出块时间）→ 重建内盘 K 线、买卖笔数、成交量，最近 100 笔换成带真实时间的。
  // 第一次从创建前一点的区块查起，之后只补新区块（15 秒内不重复查）。返回新增的笔数
  async gangV3History(t) {
    const h = t._v3Hist ||= { rows: [], block: 0, at: 0 };
    if (h.busy) return h.busy;
    if (Date.now() - h.at < 15_000) return 0;
    const uid = (x) => `${x.tx}:${x.side}:${x.tokens}`; let n = 0;
    h.busy = (async () => {
      if (!h.db) {   // MySQL 缓存：先读出以前查过的链上成交和查到的区块，只补那之后的（往回多查 15 块防重组），重启后不再从开盘重扫。库暂时连不上就下次再试
        const c = await cache.loadTrades('gang-pad', t.address).catch(() => null);
        // 2026-10-28 之前存的行没有区块 / 块内序号，同一秒的几笔顺序是乱的（DriftMaple 0x56e5…2fb96 开盘 7 笔倒过来）：一天内的新盘丢掉旧缓存，从链上重扫一遍并整份覆盖存回
        const cc = (t.createdAt > 1e12 ? t.createdAt : t.createdAt * 1000) || 0;
        if (t.gangTrack === 'v3' && c?.rows.some((x) => x.blk == null) && Date.now() - cc < 86_400_000) { c.rows = []; c.cursor = null; }
        if (c) {
          h.db = true; const had = h.block;
          if (c.cursor) { const ids = new Set(h.rows.map(uid)); for (const x of c.rows) if (!ids.has(uid(x))) { h.rows.push(x); n++; } h.rows.sort(oldFirst); h.block = Math.max(h.block, c.cursor - 15); }
          // 缓存里的成交马上上图：后面读 curve / 区块号 / getLogs 被限流时会直接抛错，等不到 finally（GANGBALL 2026-10-29 缓存 1140 笔却一直没 K 线）
          if (n) { this.applyV3History(t); this.emit('detail', t.address); }
          h.cur = c.cursor && c.cursor >= had ? c.cursor : 0;   // 0 = 内存里有库里没有的，下次整份存一遍
        }
      }
      this._gv2 ||= new GangV2(this.provider, null);
      const { pad } = await this._gv2.curve(t.address);
      const head = await this.provider.getBlockNumber();
      if (!h.block) {   // 按平均出块时间从创建时间倒推起始区块，多往前 600 块
        const [a, b] = await Promise.all([this.provider.getBlock(head), this.provider.getBlock(head - 10_000)]);
        let c = t._histFrom || t.createdAt || (a.timestamp - 86_400) * 1000; if (c > 1e14) c /= 1000;   // _histFrom：接口已给到的最后一笔（gangSeedHist），链上只补之后的   // 接口给毫秒时 createdAt 会被多乘一次 1000
        const bt = (a.timestamp - b.timestamp) / 10_000 || 0.45, age = Math.max(0, a.timestamp - Math.floor(c / 1000));
        h.block = Math.max(1, head - (RPC_ARCHIVE ? 3_000_000 : 300_000), head - Math.ceil(age / bt) - 600) - 1;   // RPC_ARCHIVE：归档节点，最多往前 300 万块（约半个月）；否则公共节点只给最近约 30 万块（约 1.5 天）的日志，再早报 archive 错误、每 45 秒卡在同一块重试；更早的成交靠接口（gangSeedHist）
      }
      // 每 2000 块（归档节点 1 万块）记一次进度：中途被限流 / 出错，下次从断点接着查，不从头重来；出错 60 秒后再试
      const seen = new Set(h.rows.map(uid)), fresh = [];
      try {
        while (h.block < head) {
          const to = Math.min(head, h.block + (RPC_ARCHIVE ? 10_000 : 2000));
          for (const x of await this.gangPads.history(t.address, pad, h.block + 1, to)) { const id = uid(x); if (!seen.has(id)) { seen.add(id); h.rows.push(x); fresh.push(x); n++; } }
          h.block = to;
        }
      } finally {
        // 出错没查完：已经有成交的 60 秒后再试；一笔都还没有的（刚重启 / 刚打开的盘）15 秒就再试，免得活动栏长时间只有实时进来的几笔
        h.at = Date.now() + (h.block < head && h.rows.length ? 45_000 : 0); h.synced = h.block >= head; if (fresh.length) this.applyV3History(t);
        // 新成交和查到的区块存回库（没有新成交时每 2000 块记一次位置）
        if (h.db && h.block && (fresh.length || !h.cur || h.block - h.cur >= 2000)) { const all = !h.cur; h.cur = h.block; cache.saveTrades('gang-pad', t.address, all ? h.rows : fresh, h.block, uid).then((ok) => { if (!ok) h.cur = 0; }).catch(() => { h.cur = 0; }); }
      }
      return n;
    })().catch((e) => {   // 查链上成交失败要能在日志里看到（以前静默吞掉，活动栏只剩自己的几笔也查不出原因）；同一个币 1 分钟最多记一次
      if (!(h.errAt > Date.now() - 60_000)) { h.errAt = Date.now(); console.log(`[Gang V3] ${t.symbol || t.address} 链上成交补查失败（查到区块 ${h.block || '-'}，${h.rows.length} 笔）：${e.shortMessage || e.message}`); }
      throw e;
    }).finally(() => { h.busy = null; });
    return h.busy;
  }
  // 接口成交不全的 pad（CHAIN_HIST_PADS）上的 V2 盘：和 V3 一样用 gangV3History 从链上 Buy / Sell 重建 K 线和成交；
  // 接口已有的旧成交先放进去（链上节点查不到太久以前的日志），链上从接口最后一笔之后查起
  async gangSeedHist(t) {
    if (t._v3Hist) return;
    const rows = await this.gang.history(t.address).catch(() => []);
    if (t._v3Hist) return;
    t._v3Hist = { rows: rows.map((x) => ({ ts: x.ts, side: x.side, bnb: x.bnb, tokens: x.tokens, price: x.price, trader: x.trader, tx: x.tx })), block: 0, at: 0 };
    t._histFrom = rows.at(-1)?.ts || null;
  }
  v3Row(t, x) { const k = this.qScale(t); return { ts: x.ts, side: x.side, bnb: x.bnb * k, tokens: x.tokens, price: x.price * k, trader: x.trader, tx: x.tx, blk: x.blk, li: x.li }; }
  applyV3History(t) {
    const rows = (t._v3Hist?.rows || []).map((x) => this.v3Row(t, x)); if (!rows.length) return;
    const last = rows.at(-1), tx = new Set(rows.map((x) => `${x.tx}:${x.side}`));
    // 历史之后才到的实时成交（还没进历史的）补在后面，K 线不会少最新一两笔
    const live = (t.trades || []).filter((x) => !tx.has(`${x.tx}:${x.side}`) && x.ts > last.ts && !x.dex);
    t.candles = (t.candles || []).filter((c) => c.dex);
    let buys = 0, sells = 0, vol = 0;
    for (const x of [...rows, ...live.slice().reverse()]) { if (x.side === 'buy') buys++; else sells++; vol += x.bnb || 0; if (x.price > 0) this.pushCandle(t, x.ts, x.price, x.bnb || 0); }
    Object.assign(t, { buys, sells, volume: vol, _volFull: true, volumeH24: false });
    t.seenTx ||= new Set(); for (const x of rows) t.seenTx.add(`${x.tx}:${x.side}:${x.tokens}`);
    const q = this.quoteUsd(t), old = new Map((t.trades || []).map((x) => [`${x.tx}:${x.side}`, x]));
    const keep = rows.slice(-100).map((x) => { const o = old.get(`${x.tx}:${x.side}`); return { ...x, name: o?.name || this.names.peek(x.trader), usd: x.bnb * q, mcapUsd: x.price * 1e9 * q }; });
    t.trades = [...keep, ...(t.trades || []).filter((x) => !tx.has(`${x.tx}:${x.side}`))].sort(newFirst).slice(0, 100);
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
    // Flap Portal 门槛盘 / 普通盘：来源、计价币、进度都读链上。以前 shrine 的新盘推送会把来源改成 shrine，之后 flapNftTick 不再刷新（进度 0/0），下单也不走 Portal（灭建国 0x42be…7777 2026-10-28）
    if (this.get(l.token)?.source === 'flap-nft') return;
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

  // shrine 全市场成交流：已迁移的币、非 BNB 计价的币它给的单位不一致（同一个池子有的条价格 / 金额是美元，有的是报价币；marketCap 有时是报价币个数），
  // 写进来会把现价、市值、K 线搞乱（BATCOIN 0xd145…7777 BTCB 盘 K 线出现 $21.98B 的影线、市值 2.9）。这两类用链上成交（dexFeed / Portal 事件）和 dexSweep，不收 shrine 的
  onStreamTrade(m) {
    const t = this.get(m.token); if (!t) return;
    if (t.stage === 'dex' || String(t.quote || 'BNB').toUpperCase() !== 'BNB') return;
    const price = num(m.priceFormatted) ?? (num(m.price) ? num(m.price) / 1e18 : null);
    const bnb = num(m.quoteAmountFormatted) || 0;
    const trade = { ts: sec2ms(m.timestamp), side: m.type, bnb, tokens: num(m.tokenAmountFormatted) || 0, price: price || t.price, trader: m.trader, tx: m.txHash };
    this.addTrade(t, trade);
    if (num(m.marketCap)) t.mcapUsd = num(m.marketCap);
    this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });
  }

  // 记下这个币最早的一笔买入（trades 只留 100 条，所以单独存）
  noteFirstBuy(t, tr) { if (tr?.side === 'buy' && tr.trader && (!t.firstBuy || oldFirst(tr, t.firstBuy) < 0)) t.firstBuy = { ts: tr.ts, trader: tr.trader, blk: tr.blk, li: tr.li }; this.noteDev(t, tr); }   // 同一秒的几笔按区块 / 块内序号比，谁先上链谁是首买
  // 发币人自己的买卖（K 线上标 DB / DS）：成交列表只留最近 100 笔，dev 早期的买入、后来的卖出常被挤掉，单独记一份（按 tx + 方向去重，最多 200 笔）
  noteDev(t, tr) {
    if (!t.creator || !tr?.trader || !tr.tx || String(tr.trader).toLowerCase() !== String(t.creator).toLowerCase()) return;
    t.devTrades ||= []; if (t.devTrades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    t.devTrades.push({ ts: tr.ts, side: tr.side, bnb: tr.bnb, tokens: tr.tokens, tx: tr.tx }); t.devTrades.sort(newFirst); if (t.devTrades.length > 200) t.devTrades.length = 200;
  }

  // 成交美元用的报价币价格。Flap Portal 盘在第一次读到 Portal 状态之前不知道计价币（base() 默认写的是 BNB）：这时返回 0，成交先不定美元（页面按现价换算），
  // 读到以后 revalueTrades 重算。以前按 BNB 价估，BNCB 计价盘的首笔买入 14 BNCB 显示成 $10,738（AIvirus 0x6442…7777 2026-10-28）
  tradeUsd(t) { return t.source === 'flap-nft' && !t.quoteKnown ? 0 : this.quoteUsd(t); }
  revalueTrades(t) {
    const q = this.tradeUsd(t), v = (x) => { x.usd = q > 0 ? x.bnb * q : null; };
    for (const x of t.trades || []) v(x);
    for (const x of this.flow) if (x.address === t.address) v(x);
  }
  addTrade(t, tr) {
    if (tr.tx && t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    this.noteFirstBuy(t, tr);
    { const q = this.tradeUsd(t); tr.usd = q > 0 ? tr.bnb * q : null; } tr.mcapUsd = t.mcapUsd; tr.name = this.names.peek(tr.trader);
    t.trades.unshift(tr); t.trades.sort(newFirst); if (t.trades.length > 100) t.trades.length = 100;
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
  // 池子的报价币不是币的报价币（如 BNCB 盘只找到 WBNB 池）：外盘价格 / 金额乘这个数换成币的报价币单位，和内盘 K 线同一单位（以前直接混用，接口处是巨大的影线）。0 = 报价币价格还没拿到
  dexScale(t) {
    const pq = t.dexInfo?.quote, own = String(t.quoteAddress || '').toLowerCase();
    if (!pq || pq === own || !own || own === ethers.ZeroAddress || own === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') return 1;
    const b = this.quoteUsd(t); return this.bnbUsd > 0 && b > 0 ? this.bnbUsd / b : 0;
  }
  applyDex(t) {
    const k = this.dexScale(t); if (!k) return;   // 换算不了就等下一轮，不先画错单位的
    const s = k === 1 ? t.dexSwaps || [] : (t.dexSwaps || []).map((x) => ({ ...x, price: x.price * k, bnb: x.bnb * k }));
    const hist = k === 1 ? t.dexHist || [] : (t.dexHist || []).map((c) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k, v: c.v * k }));
    const bars = dexBars(s, hist); if (!bars.length) return;
    const q = this.quoteUsd(t); this.joinDex(t, bars);
    const last = s[s.length - 1]; t.price = last ? last.price : bars[bars.length - 1].c; if (last) t.lastTradeAt = Math.max(t.lastTradeAt || 0, last.ts);
    if (q) { t.mcapUsd = t.dexMcapUsd = t.price * (t.maxSupply || 1e9) * q; if (t.dexQuoteRes) t.dexLiqUsd = t.dexQuoteRes * k * 2 * q; }
    const day = Date.now() - 86_400_000; let v = 0, nb = 0, ns = 0;
    for (let k = s.length - 1; k >= 0 && s[k].ts >= day; k--) { v += s[k].bnb; if (s[k].side === 'buy') nb++; else ns++; }
    const from = s.length ? s[0].ts / 1000 : Infinity; for (const c of hist) if (c.t * 1000 >= day && c.t < Math.floor(from / 60) * 60) v += c.v;   // 链上读不到的更早部分用 GeckoTerminal 分钟线的成交量
    Object.assign(t, { dexVol24: v, dexBuys24: nb, dexSells24: ns, dexCountMin: s.length ? Math.max(1, Math.round((Date.now() - Math.max(day, s[0].ts)) / 60_000)) : 0 });   // 买卖笔数只有链上读到的这段（约 1 小时）
    if (t.creator) for (const x of s) this.noteDev(t, x);
    const recent = s.slice(-100).reverse().map((x) => ({ ...x, usd: x.bnb * q, mcapUsd: x.price * (t.maxSupply || 1e9) * q, name: x.trader ? this.names.peek(x.trader) : null }));
    t.trades = [...recent, ...t.trades.filter((x) => !x.dex)].sort(newFirst).slice(0, 100);
  }
  // 内盘 K 线 + 外盘 K 线接成一条：内盘的全部保留（只换掉上次接上的外盘部分）
  joinDex(t, bars) {
    // 内盘只认迁移之前的：迁移以后还记成内盘的 K 线（实时成交、轮询价格补的点）会把「内盘结束」推到现在，整段外盘被压成接口处的一根巨大影线，中间看着像断了。
    // 截止时间 = 迁移时间 + 2 分钟和外盘第一根 K 线 + 1 分钟里早的那个（记下的迁移时间常是发现迁移的时间，会晚几十分钟）
    const cut = Math.min(t.migratedAt > 0 ? t.migratedAt / 1000 + 120 : Infinity, bars.length ? bars[0].t + 60 : Infinity);
    const curve = (t.candles || []).filter((c) => !c.dex && c.t <= cut), end = curve.length ? curve[curve.length - 1].t : -Infinity;
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
    const t = this.get(address); if (!t) return; t._viewAt = Date.now();
    if (t.source === 'gang' && (t.gangTrack === 'v2' || t.gangTrack === 'v3')) await this.gangV2Curve(t).catch(() => {});
    if (t.source === 'gang' && t.gangTrack === 'v3fair') await this.gangFairState(t).catch(() => {});
    try {
      if (t.market && t.source === 'agent-curve') {
        const [d, trades, ticks] = await Promise.all([this.curve.detail(t.market), fsi.fetchTrades(t.market, 100).catch(() => []), fsi.fetchTicks(t.market, 200).catch(() => [])]);
        Object.assign(t, { creator: d.creator, holders: d.holders, buys: d.buys, sells: d.sells, volume: d.volume, raised: d.pool, target: d.cap, progress: d.progress,
          remaining: d.remaining, totalShares: d.totalShares, maxWalletShares: d.maxWalletShares, buyTax: d.buyTaxBps / 100, sellTax: d.sellTaxBps / 100,
          feeBps: d.buyTaxBps + d.flapBuyFeeBps, stage: d.phase === 'graduated' ? 'dex' : 'curve' });   // launchedAt 是迁移时间，不是创建时间
        if (d.phase === 'graduated' && d.launchedAt > 0 && !(t.migratedAt > 0)) this.saveLaunch(t, d.launchedAt);
        if (ticks.length) { t.candles = []; for (const k of ticks) this.pushCandle(t, k.ts, k.price, 0); t.price = ticks[ticks.length - 1].price; }
        for (const tr of [...trades].reverse()) { this.noteFirstBuy(t, tr); if (!t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) { tr.usd = tr.bnb * this.quoteUsd(t); t.trades.push(tr); } if (!ticks.length && tr.price) this.pushCandle(t, tr.ts, tr.price, tr.bnb); }
        for (const tr of trades) { const c = t.candles.find((x) => x.t === Math.floor(tr.ts / 1000)); if (c && ticks.length) c.v += tr.bnb; }
        t.trades.sort(newFirst); if (t.trades.length > 100) t.trades.length = 100;
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
        const ch = t.gangTrack !== 'v3' && t._gangPad && t.stage !== 'dex';   // 接口成交不全的 pad 上的 V2 盘，见 gangSeedHist
        if (ch) await this.gangSeedHist(t);
        if (t.gangTrack === 'v3' || ch) await Promise.race([this.gangV3History(t).then((n) => { if (n) this.emit('detail', t.address); }), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
        else if (t.stage !== 'dex' && (!t.gangAt || Date.now() - t.gangAt > 5000)) { t.gangAt = Date.now(); await this.gang.trades(t.address, 200); }
        // 第一次选中：拉全部成交，从开盘起重建 K 线（也清掉改单位之前按 BNB 记的旧 K 线，全部是报价币单位）；10 分钟重建一次
        if (t.gangTrack !== 'v3' && !ch && (!t.gangFullAt || Date.now() - t.gangFullAt > 600_000)) {
          t.gangFullAt = Date.now();
          const rows = await this.gang.history(t.address).catch(() => null);
          if (rows?.length) { const k = this.qScale(t); t.candles = []; let vol = 0; for (const r of rows) { vol += (r.bnb || 0) * k; if (r.price > 0) this.pushCandle(t, r.ts, r.price * k, r.bnb * k); } t.volume = vol; t._volFull = true; t.volumeH24 = false; t._chgAt = 0; }   // 成交量 = 开盘起全部成交（报价币）
        }
        if (t.stage === 'dex') await this.dexRefresh(t);   // 已发射：接上外盘池子的成交
      } else if (PLAIN_SOURCES.has(t.source)) {
        if (t.source === 'flap-plain') { await this.lookup(t.address).catch(() => null); const n = this.get(t.address); if (n?.source === 'flap-nft') return this.refresh(n.address); }
        if (t.source === 'genius-plain') { await this.plain.geniusState(t).catch(() => {}); await Promise.race([this.plain.geniusHistory(t).then((n) => { if (n) this.emit('detail', t.address); }), new Promise((r) => setTimeout(r, 4000))]).catch(() => {}); }
        if (t.source === 'four-plain') {
          await this.lookup(t.address).catch(() => null); if (this.get(t.address)?.source === 'four-agent') return this.refresh(t.address);
          await Promise.race([this.plain.fourHistory(t).then((n) => { if (n) this.emit('detail', t.address); }), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});   // 成交 / K 线：链上补，第一次最多等 4 秒
        }
      } else if (t.source === 'dex' && t.launchPlat === 'genius' && t._gnFac) {
        await Promise.race([this.plain.geniusHistory(t).then((n) => { if (n) this.emit('detail', t.address); }), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});   // genius 已开盘：内盘曲线 + Infinity 池成交（DexScreener 多半没收录）
      } else if (t.source === 'dex') {
        await this.dexCandles(t);   // 普通外盘代币：只有外盘 K 线（不读链上 Swap 日志，最深的池子不一定是 PancakeSwap V2）
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
  // Gang V3 发射后：外盘按合约 curves() 的 buyTaxBps / sellTaxBps 收税（内盘那 1% 是平台费，发射后不适用）
  buyFeePct(t) { return t.gangV3 && t.stage === 'dex' ? t.gangV3.buyTaxBps / 100 : t.feeBps != null ? t.feeBps / 100 : t.buyTax || 0; }
  sellFeePct(t) { return t.gangV3 && t.stage === 'dex' ? t.gangV3.sellTaxBps / 100 : t.sellFeeBps != null ? t.sellFeeBps / 100 : t.source === 'four-agent' ? null : t.sellTax || 0; }
  costFor() { return Infinity; }

  summary(t) {
    const priceUsd = t.price * this.quoteUsd(t); const liqUsd = t.dexLiqUsd || (t.raised || 0) * this.quoteUsd(t);
    return {
      address: t.address, symbol: t.symbol, name: t.name, platform: t.platform, source: t.source, agentExclusive: !!t.agentExclusive, market: t.market,
      preset: t.source === 'gang' ? 'Gang（Agent 专属）' : t.source === 'agent-curve' ? 'Flap Agent Curve' : t.source === 'dex' ? `外盘代币 · ${t.dexDex || 'DEX'}` : t.source === 'flap-nft' ? (t.nftGate?.plain ? 'Flap · 普通盘' : t.nftGate?.known ? 'Flap · Agent ID 门槛' : 'Flap · NFT 门槛') : t.source === 'four-plain' ? 'Four.meme · 普通盘' : t.source === 'flap-plain' ? 'Flap · 普通盘' : t.source === 'genius-plain' ? 'genius.fun · 内盘' : t.platform === 'four' ? (t.agentExclusive ? 'Binance Agent ID Exclusive' : 'Four.meme') : 'Flap',
      presetId: t.presetId || '', quote: t.quote, quoteAddress: t.quoteAddress, creator: t.creator, creatorDomain: t.creator ? this.names.peek(t.creator) : null, firstBuyer: t.firstBuy?.trader || '', firstBuyerName: t.firstBuy ? this.names.peek(t.firstBuy.trader) : null, vault: t.market || '', createdAt: t.createdAt, migratedAt: t.stage === 'dex' && (t.migratedAt > 0 || t._migSeenAt > 0) ? t.migratedAt || t._migSeenAt : null, launchPlat: t.launchPlat || undefined, viewOnly: t.viewOnly || undefined, officialTest: false,
      stage: t.stage, price: t.price, priceUsd, mcapUsd: t.dexMcapUsd ? t.dexMcapUsd : t.source === 'four-agent' ? (t.price || this.fourP0 || 0) * (t.maxSupply || 1e9) * this.quoteUsd(t) : t.mcapUsd || (priceUsd > 0 ? priceUsd * (t.maxSupply || 1e9) : 0),   /* 没有市值但有价格（报价币价格后到）：按现价 × 总量补上 */ mcapEst: t.source === 'four-agent' && !t.price && !!this.fourP0, liqUsd, quoteUsd: this.quoteUsd(t), raised: t.raised, target: t.target, progress: t.progress || 0,
      remaining: t.remaining, holders: t.holders, buys: t.buys, sells: t.sells, volume: t.volume, volumeH24: !!t.volumeH24, dexVol24: t.dexVol24 ?? null, dexBuys24: t.dexBuys24 ?? null, dexSells24: t.dexSells24 ?? null, dexCountMin: t.dexCountMin || 0, buyTax: t.buyTax, sellTax: t.sellTax,
      buyFeePct: (t.source === 'four-agent' || t.source === 'four-plain') && t.feeBps == null ? null : this.buyFeePct(t), sellFeePct: t.source === 'four-plain' && t.feeBps == null ? null : this.sellFeePct(t),   /* 普通 Four 盘：打开后按链上成交倒推费率，之前按未知 */ antiSniperPct: t.antiSniperPct || 0, antiSniper: !!t.antiSniper, lastTradeAt: t.lastTradeAt || 0, realToken: t.realToken !== false,
      chg: this.change(t),
      image: t.image || null, creatorName: t.creatorName || null, gangTrack: t.gangTrack || null, gangDiv: t.gangDiv || null, gangV3: t.gangV3 || null, taxTo: t.taxTo || undefined, taxToCreator: this.taxToCreator(t) || undefined, gangBuyback: this.gx?.buyback(t) || undefined, gangBond: this.gx?.bond(t.address) || undefined, gangFair: t.gangFair || null, flapTax: t.flapTax ? { ...t.flapTax, beneficiaryName: t.flapTax.beneficiary ? this.names.peek(t.flapTax.beneficiary) : null } : null, nftGate: t.source === 'flap-nft' && t.stage === 'curve' && t.nftGate && !t.nftGate.removed ? t.nftGate : null, description: t.description || '', website: t.website || '', twitter: t.twitter || '', telegram: t.telegram || '',
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
      if (was !== 'dex') { t.migratedAt ||= this.migNow() || undefined; this.emit('migrate', this.summary(t)); }
    } else {
      t.stage = 'curve'; t.progress = f.sold / 100;
      if (!(t.price > 0)) { t.price = f.sharePrice / f.tokensPerShare; const q = this.quoteUsd(t); if (q) t.mcapUsd = t.price * 1e9 * q; }   // 打新阶段价格固定
    }
  }

  // 读一次 Gang V3 税收接收地址（不等结果，不影响曲线刷新）；读失败 5 分钟后再试
  gangTaxTo(t, pad) {
    const m = (this._taxTo ||= (() => { try { return JSON.parse(readFileSync(TAX_TO_FILE, 'utf8')); } catch { return {}; } })());
    if (this.applyTaxCfg(t, m[t.address])) return;
    if (!pad || t._taxToAt > Date.now() - 60_000) return;
    t._taxToAt = Date.now();
    this.provider.call({ to: pad, data: TAX_CFG.encodeFunctionData('taxConfigOf', [t.address]) }).then((r) => {
      const x = TAX_CFG.decodeFunctionResult('taxConfigOf', r), a = String(x.recipient).toLowerCase();
      m[t.address] = `${a === ethers.ZeroAddress ? '' : a},${x.buyTaxBps},${x.sellTaxBps},${x.dividendBps}`; this.applyTaxCfg(t, m[t.address]);   // 0 地址 = 不收税，也记下不再读
      clearTimeout(this._taxToSave); this._taxToSave = setTimeout(() => { try { writeFileSync(TAX_TO_FILE, JSON.stringify(m)); } catch { /* 下次重启重读 */ } }, 5000);
    }).catch(() => {});
  }
  // 存盘格式 "接收地址,买税,卖税,分红"（万分比）；旧格式（只有地址）没有税率，当作没读过重读
  applyTaxCfg(t, v) {
    if (typeof v !== 'string' || !v.includes(',')) return false;
    const [to, b, s, d] = v.split(','); t.taxTo = to || null; t.taxCfg = { b: +b, s: +s, d: +d }; return true;
  }
  // 每 3 秒给最多 6 个还没读过的 Gang V3 币读接收地址，新币优先（新创建列要及时出红色「分红 !」）
  taxToSweep() {
    const m = this._taxTo; const todo = [];
    for (const t of this.tokens.values()) {
      if (t.source !== 'gang' || t.gangTrack !== 'v3' || t.taxTo !== undefined || t._taxToAt > Date.now() - 60_000) continue;
      if (m && this.applyTaxCfg(t, m[t.address])) continue;
      todo.push(t);
    }
    for (const t of todo.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, 6)) this.gangTaxTo(t, this._gv2?.pads?.get(t.address) || V3_PADS[0]);
  }
  // 税收接收地址就是发币人自己：Gang V3 = recipient 是创建者且这部分不是全给分红；Flap = 营销受益人是创建者且营销比例 > 0
  taxToCreator(t) {
    const c = String(t.creator || '').toLowerCase(); if (!c) return false;
    const v = t.taxCfg; if (v && t.taxTo) return t.taxTo === c && (v.b > 0 || v.s > 0) && v.d < 10000;
    const f = t.flapTax; if (f?.beneficiary) return f.beneficiary === c && f.mktBps > 0 && (f.buyBps > 0 || f.sellBps > 0);
    return false;
  }

  async gangV2Curve(t) {
    if (t._v2At && Date.now() - t._v2At < 20_000) return;
    this._gv2 ||= new GangV2(this.provider, null);
    const { pad, c } = await this._gv2.curve(t.address);
    if (c.v3) this.gangTaxTo(t, pad);
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
    // 接口数据不全的 pad：已筹 / 目标 / 进度以链上为准（upsertGang 不再用接口的覆盖）。
    // V3 盘也一样：接口每 30 秒才轮询一次，刚开盘那半分钟里进度一直 0.00%、底池「—」，已经有好几笔买入了（DriftMaple 0x56e5…2fb96 2026-10-28）
    if (CHAIN_HIST_PADS.has(String(pad).toLowerCase()) || c.v3) {
      if (!c.v3) t._gangPad = String(pad).toLowerCase();
      const raised = Number(ethers.formatUnits(real, dec)), target = Number(ethers.formatUnits(grad, dec));
      t._chainCurve = { raised, target, progress: c.graduated ? 100 : target > 0 ? Math.min(100, (raised / target) * 100) : 0 }; Object.assign(t, t._chainCurve);
    }
    t._v2Rem = c.graduated ? 0 : Math.max(0, Number(ethers.formatEther(soldAtGrad > sold ? soldAtGrad - sold : 0n)));
    t.remaining = t._v2Rem; t._v2At = Date.now(); t._chgAt = 0;
    if (c.graduated && t.stage === 'curve') { Object.assign(t, { stage: 'dex', progress: 100 }); t.migratedAt ||= this.migNow() || undefined; this.emit('migrate', this.summary(t)); }   // 合约里已发射：移到「已发射」
  }

  // 某个币从开盘到现在的全部成交（新→旧），给「实时成交」往下翻页和交易者抽屉用。来源：Gang = gang.fun 全部成交；
  // Four = 链上 TradeExecuted（从创建区块起）；Flap 曲线 = fsi 成交记录（最多 5000 笔）。每个币缓存 60 秒，最多缓存 20 个币、每个最多 20000 笔
  async allTrades(t) {
    this._all ||= new Map(); const c = this._all.get(t.address);
    if (c && Date.now() - c.at < 60_000) return c;
    let list = [], complete = true, pending = false;
    // V3 / 链上补的 pad 盘：链上成交还没补到最新区块（刚重启、节点出错、限流中）时标 pending，不缓存，前端过几秒再要。
    // 以前这时返回空列表 + 已到底，活动栏只剩实时进来的几笔（往往只有自己的），还显示「已到开盘第一笔」（BUILDER 0xe252…4b2f 2026-10-28）
    if (t.source === 'gang' && (t.gangTrack === 'v3' || (t._gangPad && t.stage !== 'dex'))) { if (t.gangTrack !== 'v3') await this.gangSeedHist(t); await this.gangV3History(t).catch(() => {}); list = (t._v3Hist?.rows || []).map((x) => this.v3Row(t, x)); pending = !t._v3Hist?.synced; }
    else if (t.source === 'gang' && t.gangTrack !== 'v3fair') { const k = this.qScale(t); list = (await this.gang.history(t.address, 20000)).map((x) => (k === 1 ? x : { ...x, price: x.price * k, bnb: x.bnb * k })); }
    else if (t.source === 'four-agent') list = await this.four.tokenTrades(t.address);
    else if (t.source === 'flap-nft') list = (await this.flapNft.history(t.address, true).catch(() => this.flapNft.trades(t.address))).map((x) => ({ ts: x.ts, side: x.side, bnb: x.bnb, tokens: x.tokens, price: x.price, trader: x.trader, tx: x.tx }));   // 门槛盘：Portal 内盘成交（从创建起）
    else if (t.market) { list = await this.fsiHistory(t); complete = list.length < 9000; }
    list = [...new Map(list.map((x) => [`${x.tx}:${x.side}:${x.tokens}`, x])).values()].sort(newFirst).slice(0, 20000);
    for (const x of list) { x.name ||= this.names.peek(x.trader); x.usd = (x.bnb || 0) * this.quoteUsd(t); }
    const v = { at: Date.now(), list, complete, pending };
    if (pending) return v;
    this._all.set(t.address, v); if (this._all.size > 20) this._all.delete(this._all.keys().next().value);
    return v;
  }
  async tradesPage(address, before, limit = 100) {
    const t = this.get(address); if (!t) return null;
    const { list, complete, pending } = await this.allTrades(t);
    if (pending) return { items: [], end: false, complete: false, pending: true, total: list.length };   // 还在补链上历史：先不给，前端稍后重试
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
    list = [...new Map(list.map((x) => [`${x.tx}:${x.side}:${x.tokens}`, x])).values()].sort(oldFirst);
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
    if (qUsd > 0) { this._ts.set(key, { at: Date.now(), v }); if (this._ts.size > 200) this._ts.delete(this._ts.keys().next().value); } return v;   // 报价币价格还没拿到时不缓存，免得美元一直显示 0；最多留 200 个（以前只增不减）
  }

  // 持有人（详情页底部「持有人」，HOLDERS_FEATURE）：这个币的全部成交按地址汇总（路由买卖已经记到真实发起人），按持仓从大到小排。
  // 持仓先按买卖差估算，再给前 60 名读链上 balanceOf（Agent 曲线盘没有链上代币，只能用买卖差）；两者对不上 = 有转入 / 转出，xfer 标出来。
  // 只统计本程序拿得到的成交：内盘（Flap / Four / Gang 曲线、门槛盘）从开盘起；已迁移的币外盘（DEX）成交可能不全。金额是报价币单位。60 秒缓存
  // 链上持有人：从创建起扫这个币的全部 Transfer 事件，按地址累加出余额（和 GMGN / BscScan 的持有人一致，不依赖本程序拿没拿到成交）。
  // 起点按创建时间估区块（往前多留 5%）；扫完发现铸造量不够总量 = 起点晚了，再往前补，最多回到约 40 天前。之后只补新区块（离链头留 3 块防重组）。
  // 一个币第一次扫约 15 次 getLogs（5 万块一段，节点嫌多就减半）；日志太多（> 40 万条）就停，complete=false
  chainHolders(t) {
    this._ch ||= new Map(); const k = t.address; let c = this._ch.get(k);
    if (!c) { c = { bal: new Map(), from: 0, to: 0, minted: 0n, logs: 0, complete: true, p: null }; this._ch.set(k, c); if (this._ch.size > 30) this._ch.delete(this._ch.keys().next().value); }
    return (c.p ||= this.chainHoldersRun(t, c).catch((e) => { this._ch.delete(k); throw e; }).finally(() => { c.p = null; }));   // 扫到一半出错：整份作废，下次重扫（不然余额会重复累加）
  }
  async chainHoldersRun(t, c) {
    const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', ZERO = '0x' + '0'.repeat(40);
    const scan = async (a, b) => {
      for (let span = 50_000; a <= b;) {
        const e = Math.min(b, a + span - 1); let ls;
        try { ls = await this.provider.getLogs({ address: t.address, topics: [T], fromBlock: a, toBlock: e }); }
        catch (er) { if (span > 1000) { span = Math.floor(span / 2); continue; } throw er; }
        for (const l of ls) {
          if (l.topics.length < 3) continue; const f = '0x' + l.topics[1].slice(26).toLowerCase(), to = '0x' + l.topics[2].slice(26).toLowerCase(), v = BigInt(l.data === '0x' ? 0 : l.data);
          if (f === ZERO) c.minted += v; else c.bal.set(f, (c.bal.get(f) || 0n) - v);
          if (to !== ZERO) c.bal.set(to, (c.bal.get(to) || 0n) + v);
        }
        c.logs += ls.length; if (c.logs > 400_000) { c.complete = false; return false; }
        a = e + 1;
      }
      return true;
    };
    const head = (await this.provider.getBlockNumber()) - 3;
    if (!c.to) {
      const [hb, ob] = await Promise.all([this.provider.getBlock(head), this.provider.getBlock(head - 100_000)]);
      const bt = Math.max(0.2, (hb.timestamp - ob.timestamp) / 100_000), born = (t.createdAt || Date.now()) / 1000;
      c.from = Math.max(1, head - Math.ceil(((hb.timestamp - born) / bt) * 1.05) - 2000); c.to = c.from - 1;
      const sup = await this.provider.call({ to: t.address, data: '0x18160ddd' }).then((r) => BigInt(r)).catch(() => 0n);
      if (!(await scan(c.from, head))) { c.to = head; return c; } c.to = head;
      for (let i = 0, step = 400_000; sup && c.minted * 1000n < sup * 999n && i < 20 && c.from > 1; i++) {   // 铸造的还不到总量：起点晚了，往前补
        const a = Math.max(1, c.from - step); if (!(await scan(a, c.from - 1))) { c.from = a; break; } c.from = a;
      }
    } else if (head > c.to) { await scan(c.to + 1, head); c.to = head; }
    c.at = Date.now(); return c;
  }

  async holders(address) {
    const t = this.get(address); if (!t) return null;
    this._hd ||= new Map(); const c = this._hd.get(t.address); if (c && Date.now() - c.at < 60_000) return c.v;
    let { list, complete } = await this.allTrades(t);
    if (t.stage !== 'curve' && t.trades?.length) list = [...new Map([...list, ...t.trades].map((x) => [`${x.tx}:${x.side}:${x.tokens}`, x])).values()];   // 已迁移：外盘成交程序只有实时进来的那些，并进来
    const ch = t.source !== 'agent-curve' ? await this.chainHolders(t).catch(() => null) : null;
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
    if (ch?.bal.size) {   // 链上余额为准：所有余额 > 0 的地址都列出来（没在成交里出现的 = 转入的 / 外盘成交没拿到的），成交里有但链上为 0 的算已清仓
      const byK = new Map(rows.map((r) => [r.trader.toLowerCase(), r]));
      for (const [a, v] of ch.bal) if (v > 0n && !byK.has(a)) { const r = { trader: a, name: null, buys: 0, sells: 0, bT: 0, bQ: 0, sT: 0, sQ: 0, first: 0, last: 0, net: 0 }; rows.push(r); byK.set(a, r); }
      for (const r of rows) { const v = ch.bal.get(r.trader.toLowerCase()) || 0n; r.hold = Number(ethers.formatEther(v > 0n ? v : 0n)); r.holdSrc = 'chain'; }
      checked = rows.filter((r) => r.hold > 0).length;
    } else if (t.source !== 'agent-curve') {
      const cand = rows.slice(0, 60).filter((r) => r.net > 0), i = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      for (let j = 0; j < cand.length; j += 10) await Promise.all(cand.slice(j, j + 10).map(async (r) => { try { r.hold = Number(ethers.formatEther(i.decodeFunctionResult('balanceOf', await this.provider.call({ to: t.address, data: i.encodeFunctionData('balanceOf', [r.trader]) }))[0])); r.holdSrc = 'chain'; checked++; } catch { /* 读不到就用买卖差 */ } }));
    }
    const supply = t.maxSupply || 1e9, price = t.price || 0, qUsd = this.quoteUsd(t), dust = supply * 1e-9;
    const out = rows.map((r) => {
      const avgBuy = r.bT ? r.bQ / r.bT : null, realized = avgBuy != null ? r.sQ - avgBuy * Math.min(r.sT, r.bT) : r.sQ, holdQ = r.hold * price, unrealized = avgBuy != null ? holdQ - avgBuy * r.hold : holdQ;   // 和交易者抽屉同一个算法
      return { trader: r.trader, name: this.names.peek(r.trader) || r.name, hold: r.hold, net: r.net, holdSrc: r.holdSrc, xfer: r.holdSrc === 'chain' && (r.buys || r.sells) > 0 && Math.abs(r.hold - r.net) > Math.max(1, 0.01 * Math.max(r.hold, r.net)), pool: !!t.pair && r.trader.toLowerCase() === String(t.pair).toLowerCase(),
        pctSupply: (r.hold / supply) * 100, buys: r.buys, sells: r.sells, boughtTokens: r.bT, boughtQ: r.bQ, soldTokens: r.sT, soldQ: r.sQ, avgBuy, buyMcUsd: avgBuy != null && qUsd ? avgBuy * supply * qUsd : null,
        holdQ, realized, unrealized, total: realized + unrealized, pct: r.bQ ? ((realized + unrealized) / r.bQ) * 100 : null, first: r.first, last: r.last };
    });
    const holders = out.filter((r) => r.hold > dust).sort((a, b) => b.hold - a.hold), exited = out.filter((r) => r.hold <= dust && (r.buys || r.sells)).sort((a, b) => b.total - a.total);
    const coverage = t.source === 'agent-curve' ? 'Agent 曲线盘没有链上代币余额，持仓全部按买卖差估算'
      : ch?.bal.size ? `持仓按链上 Transfer 汇总（${ch.complete ? '从创建起全部' : '转账太多，只汇总了一部分'}，${ch.logs} 条转账）；买卖${t.stage !== 'curve' ? '只统计本程序拿到的成交（外盘 DEX 买卖可能不全）' : '按内盘成交'}`
      : t.stage !== 'curve' ? '已迁移：只统计本程序拿到的成交（内盘从开盘起），外盘（DEX）买卖可能不全；前 60 名的持仓以链上余额为准' : '内盘成交从开盘起全部统计';
    const v = { address: t.address, symbol: t.symbol, quote: t.quote || 'BNB', qUsd, qBnb: this.bnbUsd ? qUsd / this.bnbUsd : 0, price, supply, stage: t.stage, source: t.source,
      complete, trades: list.length, traders: rows.length, holderCount: holders.length, exitedCount: exited.length, checked, chain: !!ch?.bal.size, coverage, holders: holders.slice(0, 300), exited: exited.slice(0, 200), at: Date.now() };
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
  detail(a) {
    const t = this.get(a); if (!t) return null;
    if (t.creator) for (const x of t.trades) this.noteDev(t, x);   // 发币人是后来才知道的：最近成交里已有的 dev 成交补进来
    return { ...this.summary(t), candles: compactCandles(t.candles, 1800), trades: this.named(t.trades.slice(0, 60)), devTrades: t.devTrades || [] };
  }

  netStatus() {
    const l = this.feeds.status.launch;
    // 顶栏「链上订阅」：Flap / Four / Gang 三个 WebSocket 订阅都正常 = ok；部分正常 = partial；都断 = down。shrine 只是补充来源，不影响这个状态
    const subs = [this.flapChain.status, this.four.ws || {}, this.gangChain.status], upN = subs.filter((x) => x.connected).length;
    const wssState = upN === subs.length ? 'ok' : upN ? 'partial' : 'down';
    const chainSubs = { flap: { wss: this.flapChain.status.wss, connected: this.flapChain.status.connected, lastLogAt: this.flapChain.status.lastLogAt, trades: this.flapChain.status.trades },
      four: { wss: this.four.ws?.wss, connected: !!this.four.ws?.connected, lastLogAt: this.four.ws?.lastLogAt }, gang: { wss: this.gangChain.status.wss, connected: this.gangChain.status.connected, lastLogAt: this.gangChain.status.lastLogAt } };
    return { wss: null, wssState, chainSubs, rpc: this.rpcError ? null : this.rpcMs, rpcError: this.rpcError, readError: this.readError || null, rpcNode: { ...this.tradeProvider.info, read: nodeName(this.provider.lastUrl || this.provider.urls[0]), gangWs: this.gangChain.status.wss || null, fourWs: this.four.ws?.wss || null, four: nodeName(this.four.status?.rpcActive || this.four.status?.rpc), curve: nodeName(this.curve.status?.rpc) }, shrine: this.feeds.status, curve: this.curve.status, four: this.four.status, gang: this.gang.status, gangChain: { ...this.gangChain.status, recent: (this.gangLat || []).slice(0, 8) } };
  }
}
