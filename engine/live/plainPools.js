// 普通盘（非 Agent 盘）进战壕三列：Flap 普通 Portal 盘、four.meme 普通内盘、genius.fun 内盘。
// 只做「看得到」：新创建 / 即将打满两列要内盘阶段的盘，已开盘列原来就收录所有迁移的盘（liveMarket.autoStart）。
// 尽量不占 RPC（Chainstack 额度）：
//   - Four：four.meme 公开接口 /public/token/ranking（NEW 每 5 秒、PROGRESS 每 10 秒，各 50 个），不读链；
//   - Flap：Portal 的 TokenCreated 本来就在 flapNft 的订阅里（白拿）；进度 / 价格用 Multicall3 一次批量读全部跟踪中的盘的 getTokenV8Safe（每 10 秒 1 次 eth_call）；
//   - genius.fun：实际同时跟踪上百个（PLAIN_MAX），工厂的创建事件跟 liveMarket 每分钟那次 getLogs 一起扫；曲线状态每 30 秒 Multicall3 批量读，持有人合并成按地址列表的增量 getLogs。
// 每个平台最多留 PLAIN_MAX 个（最新的 + 进度最高的），持有中 / 收藏的不清。来源：'four-plain' / 'flap-plain' / 'genius-plain'，
// 前端按 agentExclusive = false 认出普通盘。默认关闭、什么都不拉：页面上任意一列打开「显示普通盘」才 setOn(true) 开始拉，
// 全部关掉就停掉并清掉已收录的普通盘。PLAIN_POOLS=0 强制关闭（开关也打不开）。
// 下单：Flap 普通盘在打开 / 下单时升级成 flap-nft 普通盘（liveMarket.lookup，原有的 Portal 买卖路径）；Four 普通内盘、genius 内盘只看行情（viewOnly）
import { ethers } from 'ethers';
import { env } from './config.js';

export const PLAIN_POOLS = env('PLAIN_POOLS', '1') !== '0';   // 只是允许打开；实际开不开看页面开关（liveMarket.setPlainOn）
export const PLAIN_SOURCES = new Set(['four-plain', 'flap-plain', 'genius-plain']);
const PLAIN_MAX = Number(env('PLAIN_MAX', '120'));
const FOUR_API = 'https://four.meme/meme-api/v1/public/token/ranking';
const FOUR_IMG = 'https://static.four.meme';
const FOUR_DETAIL = 'https://four.meme/meme-api/v1/private/token/get/v2?address=';
const FOUR_TM2 = '0x5c952063c7fc8610FFDB798152D69F0B9550762b', TM2_T = ethers.zeroPadValue(FOUR_TM2, 32).toLowerCase();
const T_BUY4 = '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942', T_SELL4 = '0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19';   // TokenPurchase / TokenSale(address,address,uint256×6)
const T_XFER = ethers.id('Transfer(address,address,uint256)');
const FLAP_PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
// genius.fun 工厂发币事件：TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, …, uint256 graduationThreshold)（链上核对过 0x5562…25B2）
export const T_GENIUS_LAUNCH = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const GC = new ethers.Interface(['function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)', 'function realQuoteReserve() view returns (uint256)', 'function graduationThreshold() view returns (uint256)', 'function graduated() view returns (bool)',
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)', 'function logo() view returns (string)', 'function description() view returns (string)']);
const GENIUS_IMG = 'https://genius.fun/api/image?src=';
const GF = new ethers.Interface(['function getLaunchedToken(address) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  'function poolKeyFor(address) view returns ((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))', 'function poolIdFor(address) view returns (bytes32)']);
const T_GN_BUY = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455', T_GN_SELL = '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df';   // genius 曲线买 / 卖
const T_IFY_SWAP = '0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237';   // PancakeSwap Infinity CL PoolManager Swap
const f18 = (v) => Number(ethers.formatEther(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PlainPools {
  constructor(market) {
    this.m = market;
    this.status = { four: { ok: false, at: 0, err: null }, flap: { ok: false, at: 0, err: null, n: 0 }, genius: { n: 0 } };
    this.on = false; this.onP = { four: false, flap: false, genius: false };   // 按平台开（战壕分类「Flap 普通盘」等）
  }

  // 开关：开 = 启动各路轮询（只启动一次，之后每轮先看 this.on）；关 = 每轮直接跳过，并清掉已收录的普通盘（持有中 / 收藏 / 手动打开的留着）
  // plats = { four, flap, genius }：只开选中的平台（没传 = 跟 on 一样全开 / 全关）。关掉的平台清掉它的普通盘
  setOn(on, plats = null) {
    const p = plats || { four: on, flap: on, genius: on };
    for (const k of Object.keys(this.onP)) this.onP[k] = !!p[k] && PLAIN_POOLS;
    this.on = Object.values(this.onP).some(Boolean);
    if (this.on) this.start();
    const keep = this.m.keepSet?.() || new Set();
    for (const t of [...this.m.tokens.values()]) if (PLAIN_SOURCES.has(t.source) && !this.onP[t.source.split('-')[0]] && !t.pinned && !keep.has(t.address)) this.m.tokens.delete(t.address);
  }
  start() {
    if (!PLAIN_POOLS || this.started) return; this.started = true;
    this.m.flapNft.on('created', (c) => { if (this.onP.flap) setTimeout(() => this.onFlapCreated(c), 4000); });   // 门槛事件在同一笔交易里，等几秒确认不是门槛盘
    const four = async (type, ms) => { for (;;) { if (this.onP.four) await this.fourPoll(type).catch((e) => { this.status.four.err = String(e.message || e).slice(0, 120); }); await sleep(ms); } };
    four('NEW', 5000); setTimeout(() => four('PROGRESS', 10_000), 2500);
    setInterval(() => { if (this.onP.flap) this.flapPoll().catch((e) => { this.status.flap.err = String(e.shortMessage || e.message || e).slice(0, 120); }); }, 10_000).unref?.();
    setInterval(() => { if (this.onP.genius) this.geniusPoll().catch(() => {}); }, 30_000).unref?.();
    setInterval(() => { if (this.on) this.prune(); }, 60_000).unref?.();
  }

  list(src) { return [...this.m.tokens.values()].filter((t) => t.source === src); }
  // 新建一个普通盘（已经按别的来源收录的不动）
  add(address, src, fields) {
    const k = String(address).toLowerCase(), old = this.m.get(k);
    if (old && old.source !== src) return null;
    const t = this.m.base(k);
    if (!old) Object.assign(t, { source: src, agentExclusive: false, plain: true, holders: null, trades: [], candles: [] });
    Object.assign(t, fields);
    return t;
  }

  // ---- Four：four.meme 排行接口（NEW = 最新创建，PROGRESS = 进度最高），cap / price 都是报价币单位 ----
  async fourPoll(type) {
    const r = await fetch(FOUR_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, pageSize: 50 }), signal: AbortSignal.timeout(8000) });
    const j = await r.json(); if (j?.code !== 0 || !Array.isArray(j.data)) throw new Error(j?.msg || 'four.meme 返回错误');
    const now = Date.now();
    for (const x of j.data) {
      const a = String(x.tokenAddress || '').toLowerCase(); if (!ethers.isAddress(a) || x.status !== 'PUBLISH') continue;
      const prog = Math.min(100, (Number(x.progress) || 0) * 100);
      if (prog >= 100) continue;   // 已打满：迁移后由「已开盘」那一路（LiquidityAdded 扫描）收录
      const q = String(x.symbol || 'BNB').toUpperCase(), qa = q === 'BNB' ? WBNB : this.quoteAddr(q);
      const price = Number(x.price) || 0;
      const t = this.add(a, 'four-plain', {
        platform: 'four', symbol: x.shortName || x.name || '?', name: x.name || '', quote: q === 'WBNB' ? 'BNB' : q, quoteAddress: qa, creator: String(x.userAddress || '').toLowerCase(),
        createdAt: Number(x.createDate) || now, stage: 'curve', progress: prog, price, maxSupply: 1e9, holders: Number(x.hold) || 0,
        image: x.img ? (/^https?:/.test(x.img) ? x.img : FOUR_IMG + x.img) : null, viewOnly: true, plainSeen: now,
        volume: Number(x.volume) || 0,
      });
      if (!t) continue;
      const u = this.m.quoteUsd(t); t.mcapUsd = u ? (Number(x.cap) || price * 1e9) * u : 0;
    }
    this.status.four = { ok: true, at: now, err: null };
  }
  // 报价币代号 → 地址：路线表 / 列表里其它盘用过的同名报价币（four.meme 接口只给代号）
  quoteAddr(sym) {
    this.qSym ||= new Map(); const c = this.qSym.get(sym); if (c) return c;
    for (const t of this.m.tokens.values()) if (t.quoteAddress && String(t.quote).toUpperCase() === sym && !PLAIN_SOURCES.has(t.source)) { this.qSym.set(sym, String(t.quoteAddress).toLowerCase()); return this.qSym.get(sym); }
    return null;
  }

  // ---- Four 普通盘成交（打开时补）：TokenManager2 的 TokenPurchase / TokenSale 全是非 indexed，不能按币过滤，
  // 所以先读这个币自己的 Transfer（按地址过滤，很轻）找出 TokenManager2 参与的区块，再只读那些区块的 TM2 事件，挑出这个币的。
  // 事件：(token, account, price, amount, cost, fee, offers, funds)，price / cost / funds 是报价币单位（18 位），funds = 已筹
  async fourHistory(t) {
    if (t._fhBusy || Date.now() - (t._fhAt || 0) < 6000) return 0;
    t._fhBusy = true; t._fhAt = Date.now();
    try {
      const prov = this.m.provider, head = await prov.getBlockNumber();
      if (!t._fhTarget) {   // 目标（满多少报价币迁移）、持有人、社交：four.meme 详情接口，打开时读一次
        const j = await fetch(FOUR_DETAIL + t.address, { signal: AbortSignal.timeout(6000) }).then((r) => r.json()).catch(() => null), d = j?.code === 0 ? j.data : null;
        if (d) { t._fhTarget = Number(d.raisedAmount) || 0; t.target = t._fhTarget; if (d.tokenPrice?.holderCount) t.holders = d.tokenPrice.holderCount; if (d.twitterUrl) t.twitter = d.twitterUrl; if (d.webUrl && d.webUrl !== d.twitterUrl) t.website = d.webUrl; if (d.telegramUrl) t.telegram = d.telegramUrl; }
      }
      let from = t._fhTo ? t._fhTo + 1 : Math.max(0, head - Math.ceil((Date.now() - (t.createdAt || Date.now())) / 450) - 400);   // BSC 约 0.45 秒一块
      const blocks = new Set();
      for (let span = 20_000; from <= head;) {
        const to = Math.min(head, from + span - 1);
        let ls; try { ls = await prov.getLogs({ address: t.address, topics: [T_XFER], fromBlock: from, toBlock: to }); }
        catch (e) { if (span > 2000) { span = Math.floor(span / 2); continue; } throw e; }
        for (const l of ls) if (String(l.topics[1]).toLowerCase() === TM2_T || String(l.topics[2]).toLowerCase() === TM2_T) blocks.add(l.blockNumber);
        from = to + 1;
      }
      const ranges = []; for (const b of [...blocks].sort((x, y) => x - y)) { const r = ranges.at(-1); if (r && b - r[1] <= 20 && b - r[0] < 200) r[1] = b; else ranges.push([b, b]); }
      const got = [];
      const q = [...ranges]; await Promise.all(Array.from({ length: Math.min(4, q.length) }, async () => { while (q.length) { const [a, b] = q.shift(); for (const l of await prov.getLogs({ address: FOUR_TM2, topics: [[T_BUY4, T_SELL4]], fromBlock: a, toBlock: b })) { if (('0x' + l.data.slice(26, 66)).toLowerCase() === t.address) got.push(l); } } }));
      got.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
      const bt = new Map(); const tsOf = async (n) => { if (!bt.has(n)) bt.set(n, prov.getBlock(n).then((b) => b.timestamp * 1000).catch(() => Date.now())); return bt.get(n); };
      let n = 0;
      for (const l of got) {
        const [, account, price, amount, cost, fee, , funds] = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'], l.data);
        const buy = l.topics[0] === T_BUY4, c = f18(cost), fe = f18(fee);
        if (buy && c + fe > 0) t.feeBps = Math.round((fe / (c + fe)) * 10000);   // 买入费率（平台费 + 代币税），按最近一笔买入
        else if (!buy && c > 0) t.sellFeeBps = Math.round((fe / c) * 10000);
        const tr = { ts: await tsOf(l.blockNumber), side: buy ? 'buy' : 'sell', bnb: buy ? c + fe : c - fe, tokens: f18(amount), price: f18(price), trader: account.toLowerCase(), tx: l.transactionHash };
        if (t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) continue;
        if (buy) t.buys = (t.buys || 0) + 1; else t.sells = (t.sells || 0) + 1;
        t.raised = f18(funds); this.m.addTrade(t, tr); n++;
      }
      // 进度不按已筹 / 目标算：four.meme 的进度按卖出的代币数算，和接口（列表）保持一致
      t._fhTo = head; return n;
    } finally { t._fhBusy = false; }
  }

  // ---- Flap：Portal TokenCreated（flapNft 已经在订阅 / 补查）→ 不是门槛盘就按普通盘收录 ----
  onFlapCreated(c) {
    if (!this.onP.flap) return;
    const k = c.token; if (this.m.flapNft.reg?.tokens?.[k] || this.m.get(k)) return;
    if (c.ts && Date.now() - c.ts > 6 * 3600_000) return;   // 停机期间补到的老盘不收
    const t = this.add(k, 'flap-plain', { platform: 'flap', symbol: c.symbol || '?', name: c.name || '', createdAt: c.ts || Date.now(), stage: 'curve', progress: 0, maxSupply: 1e9, quote: 'BNB', plainSeen: Date.now() });
    if (t && c.uri) this.m.loadMeta(t, c.uri);
    if (t) this.flapPoll([t]).catch(() => {});
  }
  // 批量读 getTokenV8Safe（同 flapNft.state 的按字解析）：1 次 eth_call
  async flapPoll(only = null) {
    const list = only || this.list('flap-plain').filter((t) => t.stage === 'curve');
    if (!list.length) return;
    for (let i = 0; i < list.length; i += 150) {
      const part = list.slice(i, i + 150);
      const calls = part.map((t) => ({ target: FLAP_PORTAL, allowFailure: true, callData: '0x62fafcca' + ethers.zeroPadValue(t.address, 32).slice(2) }));
      const raw = await this.m.provider.call({ to: MULTICALL3, data: MC.encodeFunctionData('aggregate3', [calls]) });
      const res = MC.decodeFunctionResult('aggregate3', raw)[0];
      for (let j = 0; j < part.length; j++) {
        const t = part[j], r = res[j]; if (!r.success || r.returnData.length < 2 + 16 * 64) continue;
        const d = r.returnData, w = (n) => BigInt('0x' + d.slice(2 + n * 64, 2 + (n + 1) * 64));
        const st = { status: Number(w(0)), reserve: w(1), circulating: w(2), price: w(3), dexThresh: w(8), quote: ethers.getAddress('0x' + d.slice(2 + 9 * 64 + 24, 2 + 10 * 64)), nativeSwap: w(10) !== 0n, progress: Number(w(15)) / 1e16 };
        if (st.status === 4) { this.migrated(t, 'flap'); continue; }
        if (st.status !== 1) continue;
        await this.m.applyFlapNftState(t, st).catch(() => {});
      }
    }
    this.status.flap = { ok: true, at: Date.now(), err: null, n: list.length };
  }

  // ---- genius.fun 内盘 ----
  async onGeniusLaunch(l) {
    if (!this.onP.genius) return;
    const k = ('0x' + String(l.topics[1]).slice(26)).toLowerCase(), curve = ethers.getAddress('0x' + String(l.topics[2]).slice(26));
    if (this.m.get(k)) return;
    const pair0 = ('0x' + String(l.data).slice(26, 66)).toLowerCase(), pair = pair0 === ethers.ZeroAddress ? WBNB : pair0;   // pairToken = 0 是原生 BNB 计价
    const at = await this.m.provider.getBlock(l.blockNumber).then((b) => b.timestamp * 1000).catch(() => Date.now());
    if (Date.now() - at > 48 * 3600_000) return;
    const rd = (to, fn) => this.m.provider.call({ to, data: GC.encodeFunctionData(fn) }).then((r) => GC.decodeFunctionResult(fn, r)[0]).catch(() => null);
    const [name, symbol, sup] = await Promise.all([rd(k, 'name'), rd(k, 'symbol'), rd(k, 'totalSupply')]);
    const qs = pair === WBNB ? 'BNB' : (await this.m.quoteMeta(pair).catch(() => null))?.symbol || '?';
    const t = this.add(k, 'genius-plain', { platform: 'genius', launchPlat: 'genius', symbol: symbol || '?', name: name || '', quote: qs, quoteAddress: pair, creator: ('0x' + String(l.topics[3]).slice(26)).toLowerCase(),
      createdAt: at, stage: 'curve', progress: 0, maxSupply: sup ? f18(sup) : 1e9, viewOnly: true, _gnCurve: curve, _gnFacC: l.address, plainSeen: Date.now() });
    if (t) { await this.geniusState(t).catch(() => {}); await this.geniusLogo(t).catch(() => {}); await this.geniusHolders(t).catch(() => {}); }
  }
  async geniusState(t) {
    const c = t._gnCurve; if (!c) return;
    const rd = (fn) => this.m.provider.call({ to: c, data: GC.encodeFunctionData(fn) }).then((r) => GC.decodeFunctionResult(fn, r));
    const [[qr, tr], [real], [grad], [done]] = await Promise.all([rd('getReserves'), rd('realQuoteReserve'), t._gnGrad ? [t._gnGrad] : rd('graduationThreshold').then((r) => [(t._gnGrad = r[0])]), rd('graduated')]);
    if (done) return this.migrated(t, 'genius');
    const price = tr > 0n ? f18(qr) / f18(tr) : 0;
    Object.assign(t, { price, raised: f18(real), target: f18(grad), progress: grad > 0n ? Math.min(100, (f18(real) / f18(grad)) * 100) : 0 });
    const u = this.m.quoteUsd(t); if (u && price > 0) t.mcapUsd = price * (t.maxSupply || 1e9) * u;
  }
  // 每 30 秒：曲线状态用 Multicall3 批量读（120 个盘约 3 次 eth_call），持有人用一次 getBlockNumber + 按地址列表合并的增量 getLogs。
  // 以前每个盘各读 4 次 eth_call + getBlockNumber + getLogs，120 个盘每分钟上千次，把公共节点打到 429 / 403（2026-10-29）
  async geniusPoll() {
    const list = this.list('genius-plain').filter((t) => t.stage === 'curve' && t._gnCurve);
    if (!list.length) return;
    await this.geniusStates(list).catch(() => {});
    const live = list.filter((t) => t.stage === 'curve' && this.m.get(t.address) === t);
    const head = await this.m.provider.getBlockNumber().catch(() => this.m.block || 0);
    if (!head) return;
    for (const t of live.filter((x) => !x._gnHTo)) await this.geniusHolders(t, head).catch(() => {});   // 还没回补过的（重启后）逐个补一次
    await this.geniusHoldersBatch(live.filter((x) => x._gnHTo), head).catch(() => {});
    for (const t of this.m.tokens.values()) if ((t.launchPlat === 'genius' || t.platform === 'genius') && !t.image && !t._gnLogoTried) await this.geniusLogo(t).catch(() => {});   // 已开盘的 genius 币也补图标
  }
  // 图标：genius 代币合约自己有 logo()（ipfs://CID 或任意 https 图床地址，直接就是图片，不是元数据 JSON）和 description()，读一次。
  // 统一走 genius.fun 自己的图片代理（/api/image?src=…，返回 webp）：白名单只放行 genius.fun，不放行发币人填的各种图床。/api/img 照旧只收 PNG / JPEG / WebP / GIF
  async geniusLogo(t) {
    t._gnLogoTried = true;
    const rd = (fn) => this.m.provider.call({ to: t.address, data: GC.encodeFunctionData(fn) }).then((r) => GC.decodeFunctionResult(fn, r)[0]).catch(() => '');
    const [logo, desc] = await Promise.all([rd('logo'), rd('description')]);
    const src = String(logo || '').trim();
    if (/^(ipfs:\/\/|https:\/\/)\S{8,1500}$/i.test(src)) { t.image = GENIUS_IMG + encodeURIComponent(src); this.m.emit('image', t.image); }
    if (desc && !t.description) t.description = String(desc).slice(0, 500);
  }
  // 持有人：内盘期间按这个币自己的 Transfer 算余额（genius 盘很少，每个盘 30 秒一次增量 getLogs），曲线合约和零地址不算
  async geniusStates(list) {
    const fns = ['getReserves', 'realQuoteReserve', 'graduationThreshold', 'graduated'];
    const calls = list.flatMap((t) => fns.map((fn) => ({ target: t._gnCurve, allowFailure: true, callData: GC.encodeFunctionData(fn) })));
    const res = [];
    for (let i = 0; i < calls.length; i += 200) res.push(...MC.decodeFunctionResult('aggregate3', await this.m.provider.call({ to: MULTICALL3, data: MC.encodeFunctionData('aggregate3', [calls.slice(i, i + 200)]) }))[0]);
    list.forEach((t, j) => {
      const r = res.slice(j * 4, j * 4 + 4); if (r.length < 4 || !r.every((x) => x.success)) return;
      const d = (k) => GC.decodeFunctionResult(fns[k], r[k].returnData);
      try {
        const [qr, tr] = d(0), [real] = d(1), [grad] = d(2), [done] = d(3); t._gnGrad = grad;
        if (done) return this.migrated(t, 'genius');
        const price = tr > 0n ? f18(qr) / f18(tr) : 0;
        Object.assign(t, { price, raised: f18(real), target: f18(grad), progress: grad > 0n ? Math.min(100, (f18(real) / f18(grad)) * 100) : 0 });
        const u = this.m.quoteUsd(t); if (u && price > 0) t.mcapUsd = price * (t.maxSupply || 1e9) * u;
      } catch { /* 这个盘这次解析失败，下次再读 */ }
    });
  }
  geniusXfer(t, l) {
    const skip = [ethers.ZeroAddress.toLowerCase(), String(t._gnCurve || '').toLowerCase()];
    const a = ('0x' + l.topics[1].slice(26)).toLowerCase(), b = ('0x' + l.topics[2].slice(26)).toLowerCase(), v = BigInt(l.data);
    if (!skip.includes(a)) t._gnBal.set(a, (t._gnBal.get(a) || 0n) - v);
    if (!skip.includes(b)) t._gnBal.set(b, (t._gnBal.get(b) || 0n) + v);
  }
  // 已回补过的盘一起查增量：地址列表每 50 个一组，一次 getLogs；每个盘只认自己 _gnHTo 之后的日志
  async geniusHoldersBatch(list, head) {
    for (let i = 0; i < list.length; i += 50) {
      const part = list.slice(i, i + 50), from = Math.min(...part.map((t) => t._gnHTo + 1));
      if (from > head) continue;
      const by = new Map(part.map((t) => [t.address.toLowerCase(), t]));
      const ls = await this.m.provider.getLogs({ address: part.map((t) => t.address), topics: [T_XFER], fromBlock: Math.max(from, head - 20_000), toBlock: head });
      for (const l of ls) { const t = by.get(String(l.address).toLowerCase()); if (t && l.blockNumber > t._gnHTo) this.geniusXfer(t, l); }
      for (const t of part) { t._gnHTo = head; t.holders = [...t._gnBal.values()].filter((v) => v > 0n).length; }
    }
  }
  async geniusHolders(t, head0 = 0) {
    const prov = this.m.provider, head = head0 || await prov.getBlockNumber();
    let from = t._gnHTo ? t._gnHTo + 1 : Math.max(0, head - Math.ceil((Date.now() - (t.createdAt || Date.now())) / 450) - 400);
    t._gnBal ||= new Map();
    for (let span = 20_000; from <= head;) {
      const to = Math.min(head, from + span - 1);
      let ls; try { ls = await prov.getLogs({ address: t.address, topics: [T_XFER], fromBlock: from, toBlock: to }); }
      catch (e) { if (span > 2000) { span = Math.floor(span / 2); continue; } throw e; }
      for (const l of ls) this.geniusXfer(t, l);
      from = to + 1;
    }
    t._gnHTo = head; t.holders = [...t._gnBal.values()].filter((v) => v > 0n).length;
  }

  // ---- genius 成交 / K 线（打开时补）：内盘 = 曲线合约的 Buy / Sell 事件，毕业后 = PancakeSwap Infinity CL PoolManager 的 Swap（按 poolId 过滤）。
  // 都按地址 + topic 过滤的 getLogs，很轻；第一次补完记下区块，之后只补新块（6 秒最多一次）。时间按 0.45 秒一块估算，不逐块读区块时间。
  // 曲线事件（链上核对过 DEGE 0x6bec…6666）：Buy(indexed sender, indexed to, quoteIn, tokensOut, fee, ·)，Sell(indexed sender, indexed to, tokensIn, quoteOut, fee, ·)
  // Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)：金额是交易者的增减，币为正 = 买
  async geniusHistory(t) {
    const fac = t._gnFac || t._gnFacC;   // _gnFacC：内盘普通盘的工厂（不用 _gnFac，免得每分钟的 geniusPrice 去读还没建的池子）
    if (t._ghBusy || Date.now() - (t._ghAt || 0) < 6000 || !fac) return 0;
    t._ghBusy = true; t._ghAt = Date.now();
    try {
      const prov = this.m.provider, head = await prov.getBlockNumber(), now = Date.now(), blk = (ms) => head - Math.ceil((now - ms) / 450);
      const fc = (fn) => prov.call({ to: fac, data: GF.encodeFunctionData(fn, [t.address]) }).then((r) => GF.decodeFunctionResult(fn, r)[0]);
      if (!t._ghKey) {
        const lt = await fc('getLaunchedToken'); t._gnCurve ||= lt.curve;
        if (Number(lt.phase) === 2) { const [key, id] = await Promise.all([fc('poolKeyFor'), fc('poolIdFor')]); t._ghKey = { pm: key.poolManager, id, tok0: key.currency0.toLowerCase() === t.address }; }
        else t._ghKey = { curveOnly: true };
      }
      const logs = async (address, topics, from, to) => {
        const out = [];
        for (let span = 20_000; from <= to;) {
          const b = Math.min(to, from + span - 1);
          try { out.push(...await prov.getLogs({ address, topics, fromBlock: from, toBlock: b })); } catch (e) { if (span > 2000) { span = Math.floor(span / 2); continue; } throw e; }
          from = b + 1;
        }
        return out;
      };
      const rows = [];
      const grad = t.migratedAt > 0 ? blk(t.migratedAt) : head;
      // 内盘：只补一次（从毕业往前最多 24 小时，或从创建起）
      if (!t._ghCurveDone && t._gnCurve) {
        const from = Math.max(t._ghCurveTo ? t._ghCurveTo + 1 : 0, t.stage === 'curve' ? blk(t.createdAt || now) - 400 : grad - 192_000);
        const to = t.stage === 'curve' ? head : grad + 200;
        for (const l of await logs(t._gnCurve, [[T_GN_BUY, T_GN_SELL]], from, to)) {
          const w = (i) => BigInt('0x' + l.data.slice(2 + i * 64, 2 + (i + 1) * 64)), buy = l.topics[0] === T_GN_BUY;
          const q = f18(buy ? w(0) : w(1)), n = f18(buy ? w(1) : w(0)), fee = f18(w(2));
          if (n > 0) rows.push({ blk: l.blockNumber, li: l.index, side: buy ? 'buy' : 'sell', bnb: q, tokens: n, price: (buy ? q - fee : q + fee) / n, trader: ('0x' + l.topics[2].slice(26)).toLowerCase(), tx: l.transactionHash });
        }
        t._ghCurveTo = to; if (t.stage !== 'curve') t._ghCurveDone = true;
      }
      if (t._ghKey?.pm) {
        const from = t._ghTo ? t._ghTo + 1 : grad - 200;
        for (const l of await logs(t._ghKey.pm, [T_IFY_SWAP, t._ghKey.id], from, head)) {
          const [a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(['int128', 'int128'], l.data.slice(0, 2 + 128));
          const tokD = t._ghKey.tok0 ? a0 : a1, qD = t._ghKey.tok0 ? a1 : a0, n = Math.abs(f18(tokD)), q = Math.abs(f18(qD));
          if (n > 0) rows.push({ blk: l.blockNumber, li: l.index, side: tokD > 0n ? 'buy' : 'sell', bnb: q, tokens: n, price: q / n, trader: ('0x' + l.topics[2].slice(26)).toLowerCase(), tx: l.transactionHash, dex: true });
        }
        t._ghTo = head;
      }
      rows.sort((a, b) => a.blk - b.blk || a.li - b.li);
      let n = 0;
      for (const r of rows) {
        if (t.trades.some((x) => x.tx === r.tx && x.side === r.side)) continue;
        if (r.side === 'buy') t.buys = (t.buys || 0) + 1; else t.sells = (t.sells || 0) + 1;
        t.volume = (t.volume || 0) + r.bnb;
        this.m.addTrade(t, { ts: Math.min(now, now - (head - r.blk) * 450), side: r.side, bnb: r.bnb, tokens: r.tokens, price: r.price, trader: r.trader, tx: r.tx, blk: r.blk, li: r.li }); n++;
      }
      return n;
    } finally { t._ghBusy = false; }
  }

  // 迁移了：从内盘普通盘里拿掉，交给「已开盘」那一路收录（autoQ 会按外盘 / flap-nft 普通盘重建）
  migrated(t, plat) {
    if (!PLAIN_SOURCES.has(t.source)) return;
    this.m.tokens.delete(t.address);
    if (plat === 'genius') this.m.autoQ('genius', t.address, null, 0, null);
    else this.m.autoQ(plat, t.address, null);
  }

  // 每个平台最多留 PLAIN_MAX 个：进度最高的一半 + 其余按创建时间最新；30 分钟没在接口里出现的 Four 盘（数据不再更新）、创建 48 小时以上的 Flap / genius 盘清掉。持有中 / 收藏 / 手动打开的不清
  prune() {
    const keep = this.m.keepSet?.() || new Set(), now = Date.now();
    for (const src of PLAIN_SOURCES) {
      const list = this.list(src).filter((t) => !keep.has(t.address) && !t.pinned);
      const drop = new Set(list.filter((t) => (src === 'four-plain' ? now - (t.plainSeen || 0) > 30 * 60_000 : now - (t.createdAt || 0) > 48 * 3600_000)));   // Four 进度榜里有好几天前创建、快打满的盘，不按创建时间清
      const rest = list.filter((t) => !drop.has(t));
      if (rest.length > PLAIN_MAX) {
        const byProg = [...rest].sort((a, b) => (b.progress || 0) - (a.progress || 0)).slice(0, PLAIN_MAX >> 1);
        const kept = new Set(byProg); for (const t of [...rest].sort((a, b) => b.createdAt - a.createdAt)) { if (kept.size >= PLAIN_MAX) break; kept.add(t); }
        for (const t of rest) if (!kept.has(t)) drop.add(t);
      }
      for (const t of drop) this.m.tokens.delete(t.address);
    }
  }
}
