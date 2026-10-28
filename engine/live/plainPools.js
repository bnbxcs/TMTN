// 普通盘（非 Agent 盘）进战壕三列：Flap 普通 Portal 盘、four.meme 普通内盘、genius.fun 内盘。
// 只做「看得到」：新创建 / 即将打满两列要内盘阶段的盘，已开盘列原来就收录所有迁移的盘（liveMarket.autoStart）。
// 尽量不占 RPC（Chainstack 额度）：
//   - Four：four.meme 公开接口 /public/token/ranking（NEW 每 5 秒、PROGRESS 每 10 秒，各 50 个），不读链；
//   - Flap：Portal 的 TokenCreated 本来就在 flapNft 的订阅里（白拿）；进度 / 价格用 Multicall3 一次批量读全部跟踪中的盘的 getTokenV8Safe（每 10 秒 1 次 eth_call）；
//   - genius.fun：一天十几个，工厂的创建事件跟 liveMarket 每分钟那次 getLogs 一起扫，曲线状态每 30 秒读一次（每个盘 1 次 eth_call）。
// 每个平台最多留 PLAIN_MAX 个（最新的 + 进度最高的），持有中 / 收藏的不清。来源：'four-plain' / 'flap-plain' / 'genius-plain'，
// 前端按 agentExclusive = false 认出普通盘，可以在筛选里「显示普通盘」关掉。PLAIN_POOLS=0 整个关闭。
// 下单：Flap 普通盘在打开 / 下单时升级成 flap-nft 普通盘（liveMarket.lookup，原有的 Portal 买卖路径）；Four 普通内盘、genius 内盘只看行情（viewOnly）
import { ethers } from 'ethers';
import { env } from './config.js';

export const PLAIN_POOLS = env('PLAIN_POOLS', '1') !== '0';
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
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)']);
const f18 = (v) => Number(ethers.formatEther(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PlainPools {
  constructor(market) {
    this.m = market;
    this.status = { four: { ok: false, at: 0, err: null }, flap: { ok: false, at: 0, err: null, n: 0 }, genius: { n: 0 } };
  }

  start() {
    if (!PLAIN_POOLS) return;
    this.m.flapNft.on('created', (c) => setTimeout(() => this.onFlapCreated(c), 4000));   // 门槛事件在同一笔交易里，等几秒确认不是门槛盘
    const four = async (type, ms) => { for (;;) { await this.fourPoll(type).catch((e) => { this.status.four.err = String(e.message || e).slice(0, 120); }); await sleep(ms); } };
    four('NEW', 5000); setTimeout(() => four('PROGRESS', 10_000), 2500);
    setInterval(() => this.flapPoll().catch((e) => { this.status.flap.err = String(e.shortMessage || e.message || e).slice(0, 120); }), 10_000).unref?.();
    setInterval(() => this.geniusPoll().catch(() => {}), 30_000).unref?.();
    setInterval(() => this.prune(), 60_000).unref?.();
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
    const k = ('0x' + String(l.topics[1]).slice(26)).toLowerCase(), curve = ethers.getAddress('0x' + String(l.topics[2]).slice(26));
    if (this.m.get(k)) return;
    const pair = ('0x' + String(l.data).slice(26, 66)).toLowerCase();
    const at = await this.m.provider.getBlock(l.blockNumber).then((b) => b.timestamp * 1000).catch(() => Date.now());
    if (Date.now() - at > 48 * 3600_000) return;
    const rd = (to, fn) => this.m.provider.call({ to, data: GC.encodeFunctionData(fn) }).then((r) => GC.decodeFunctionResult(fn, r)[0]).catch(() => null);
    const [name, symbol, sup] = await Promise.all([rd(k, 'name'), rd(k, 'symbol'), rd(k, 'totalSupply')]);
    const qs = pair === WBNB ? 'BNB' : (await this.m.quoteMeta(pair).catch(() => null))?.symbol || '?';
    const t = this.add(k, 'genius-plain', { platform: 'genius', launchPlat: 'genius', symbol: symbol || '?', name: name || '', quote: qs, quoteAddress: pair, creator: ('0x' + String(l.topics[3]).slice(26)).toLowerCase(),
      createdAt: at, stage: 'curve', progress: 0, maxSupply: sup ? f18(sup) : 1e9, viewOnly: true, _gnCurve: curve, plainSeen: Date.now() });
    if (t) await this.geniusState(t).catch(() => {});
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
  async geniusPoll() { for (const t of this.list('genius-plain')) if (t.stage === 'curve') await this.geniusState(t).catch(() => {}); }

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
