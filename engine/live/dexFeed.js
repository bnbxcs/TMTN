// 已发射（迁移）到 PancakeSwap 的币：直接读池子的 Swap 事件当外盘成交，和内盘 K 线接成一条完整的线。
// Flap / Four / Gang 毕业后在 PancakeSwap V2 或 V3 建「代币 / 报价币」池。以前外盘只用 GeckoTerminal 分钟 K 线，
// Gang 盘连这个都没接，详情页 K 线停在毕业那一刻，成交列表、成交量也没有外盘的部分。
//   池子：V2 的 getPair 和 V3 各档费率的 getPool 都查，报价币配的优先（其次 WBNB），同一种报价币里取池子里报价币最多的那个
//   链上：有归档节点（RPC_ARCHIVE=1，Chainstack）时第一次从迁移的区块读起（迁移约 1 天内），getLogs 一次 1 万块；
//         没有归档节点 / 不知道迁移时间时和以前一样从「最新区块 − 4500」读起。之后详情页每 3 秒刷新时从上次读到的区块接着读
//   更早的历史：GeckoTerminal 分钟 K 线（currency=token，直接是池子报价币单位），从迁移时间往后翻页补齐，10 分钟重拉一次
// 区块时间按每段首尾两个区块的时间戳插值（不逐块查），K 线够用。价格、金额都是池子报价币单位（不是币的报价币时由 liveMarket 换算）
import { ethers } from 'ethers';
import { cache } from './cache.js';

const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', V3_FEES = [100, 500, 2500, 10000];
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const SWAP = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'), SYNC = ethers.id('Sync(uint112,uint112)');
// PancakeSwap V3 的 Swap 比 Uniswap V3 多两个 protocolFees 字段；两种都认
const SWAP3 = [ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'), ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)')];
const SPAN = 4500;          // 公共节点 getLogs 每次最多 5000 个区块，且只保留最近约 5000 个区块的日志
const MAX_SWAPS = 20_000;
const ARCH_SPAN = 10_000, ARCH_GAP = 200_000;   // 有归档节点时：重启后库里的位置离最新最多约 1 天（20 万块）也能用它接上，一次查 1 万块；第一次回填最多也往回读这么多
const MIG_PAD = 900_000;    // 从迁移（或内盘最后一笔，取早的）前 15 分钟的区块读起：记下的迁移时间多半是发现迁移的时间，会晚十几分钟
const i = new ethers.Interface([
  'function getPair(address,address) view returns (address)', 'function getReserves() view returns (uint112,uint112,uint32)',
  'function getPool(address,address,uint24) view returns (address)', 'function balanceOf(address) view returns (uint256)',
  'function token0() view returns (address)', 'function decimals() view returns (uint8)',
]);
const abi = ethers.AbiCoder.defaultAbiCoder();
const isW = (a) => !a || a === ethers.ZeroAddress || String(a).toLowerCase() === WBNB;
const uid = (x) => `${x.tx}:${x.side}:${x.tokens}`;

export class DexFeed {
  // arch：可选的归档 / 日志节点（RPC_ARCHIVE=1 时传入）。有它时 getLogs 都先走它（公共节点经常限流），出错再退回公共节点
  constructor(provider, arch = null) { this.p = provider; this.arch = arch; this.bts = new Map(); }

  async call(to, fn, args = []) { return i.decodeFunctionResult(fn, await this.p.call({ to, data: i.encodeFunctionData(fn, args) })); }

  // 池子：和盘的报价币配的优先，其次和 WBNB 配的；V2 / V3 都查，只认有报价币的，取最深的
  async pairOf(t) {
    if (t.dexInfo) return t.dexInfo;
    if (t.dexInfoAt && Date.now() - t.dexInfoAt < 30_000) return null; t.dexInfoAt = Date.now();
    const tDec = await this.call(t.address, 'decimals').then((x) => Number(x[0])).catch(() => 18);
    for (const q of [...new Set([isW(t.quoteAddress) ? WBNB : String(t.quoteAddress).toLowerCase(), WBNB])]) {
      const pools = [];
      const v2 = (await this.call(FACTORY, 'getPair', [t.address, q]).catch(() => [ethers.ZeroAddress]))[0];
      if (v2 !== ethers.ZeroAddress) pools.push({ pair: v2, ver: 2 });
      for (const fee of V3_FEES) { const p = (await this.call(V3_FACTORY, 'getPool', [t.address, q, fee]).catch(() => [ethers.ZeroAddress]))[0]; if (p !== ethers.ZeroAddress) pools.push({ pair: p, ver: 3, fee }); }
      let best = null;
      for (const x of pools) {
        const depth = (await this.call(q, 'balanceOf', [x.pair]).catch(() => [0n]))[0];
        if (x.ver === 2) { const r = await this.call(x.pair, 'getReserves').catch(() => null); if (!r || !(r[0] > 0n && r[1] > 0n)) continue; }
        if (depth > 0n && (!best || depth > best.depth)) best = { ...x, depth };
      }
      if (!best) continue;
      const t0 = (await this.call(best.pair, 'token0'))[0].toLowerCase();
      const qDec = isW(q) ? 18 : await this.call(q, 'decimals').then((x) => Number(x[0])).catch(() => 18);
      return (t.dexInfo = { pair: best.pair.toLowerCase(), ver: best.ver, fee: best.fee || null, quote: q, tokenIs0: t0 === t.address.toLowerCase(), tDec, qDec });
    }
    return null;
  }

  async ts(n) { if (this.bts.has(n)) return this.bts.get(n); const b = await (this.arch || this.p).getBlock(n); if (!b) throw new Error('no block ' + n); const v = b.timestamp * 1000; if (this.bts.size > 2000) this.bts.clear(); this.bts.set(n, v); return v; }

  // 时间（毫秒）→ 区块号：按相邻两次取到的区块算出块速往回推，3~4 次就到几十块以内
  async blockAt(ms, latest) {
    let n = latest, at = await this.ts(n), rate = 450;
    for (let k = 0; k < 5; k++) {
      const d = Math.round((at - ms) / rate); if (Math.abs(d) < 40) break;
      const m = Math.max(1, Math.min(latest, n - d)), mt = await this.ts(m);
      if (m !== n) rate = Math.min(3000, Math.max(100, Math.abs(at - mt) / Math.abs(n - m)));
      n = m; at = mt;
    }
    return n;
  }

  // 第一次读外盘从哪个区块开始：有归档节点且知道迁移时间时从迁移前一点开始（最多往回约 1 天），否则最近 4500 块
  async startBlock(t, latest) {
    const curve = (t.candles || []).filter((c) => !c.dex).at(-1), at = Math.min(t.migratedAt > 0 ? t.migratedAt : Infinity, curve && t.migratedAt > 0 ? curve.t * 1000 : Infinity);
    if (this.arch && at < Infinity) {
      const b = await this.blockAt(at - MIG_PAD, latest).catch(() => null);
      if (b) return { from: Math.max(b, latest - ARCH_GAP), full: b >= latest - ARCH_GAP };
    }
    return { from: latest - SPAN + 1, full: false };
  }

  // GeckoTerminal 分钟 K 线（池子报价币单位），从最新往前翻页，翻到迁移时间或最多 6 页（约 4 天）为止
  async history(t, info) {
    if (t.dexHistAt && Date.now() - t.dexHistAt < 600_000) return false; t.dexHistAt = Date.now();
    const out = []; let before = '';
    for (let page = 0; page < 6; page++) {
      const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${info.pair}/ohlcv/minute?aggregate=1&limit=1000&currency=token&token=${t.address}${before}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })).json();
      const l = j?.data?.attributes?.ohlcv_list || []; if (String(j?.meta?.base?.address || '').toLowerCase() !== t.address.toLowerCase()) break;
      out.push(...l); if (l.length < 1000) break;
      const min = Math.min(...l.map((x) => x[0])); if (t.migratedAt && min * 1000 <= t.migratedAt) break; before = `&before_timestamp=${min}`;
    }
    if (!out.length) return false;
    const seen = new Set(); t.dexHist = out.filter((x) => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]).map(([ts, o, h, l, c, v]) => ({ t: ts, o, h, l, c, v, dex: 1 }));
    return true;
  }

  // V2：价格用这笔成交之后池子的现价（同一笔交易里紧挨着的 Sync 事件给的储备），和 GeckoTerminal / 市值口径一致；没有 Sync 时退回成交均价
  parse(log, info, ts, sync) {
    const [a0In, a1In, a0Out, a1Out] = abi.decode(['uint256', 'uint256', 'uint256', 'uint256'], log.data);
    const [tIn, tOut, qIn, qOut] = info.tokenIs0 ? [a0In, a0Out, a1In, a1Out] : [a1In, a1Out, a0In, a0Out];
    const buy = tOut > tIn, tok = Number(ethers.formatUnits(buy ? tOut - tIn : tIn - tOut, info.tDec)), q = Number(ethers.formatUnits(buy ? qIn - qOut : qOut - qIn, info.qDec));
    if (!(tok > 0) || !(q > 0)) return null;
    // 买入的收币地址就是买家（经路由也是）；卖出时 to 多半是路由（换成 BNB 再转给卖家），不当成交易者
    let price = q / tok;
    if (sync && sync.transactionHash === log.transactionHash) { const [r0, r1] = abi.decode(['uint112', 'uint112'], sync.data); const rt = Number(ethers.formatUnits(info.tokenIs0 ? r0 : r1, info.tDec)), rq = Number(ethers.formatUnits(info.tokenIs0 ? r1 : r0, info.qDec)); if (rt > 0 && rq > 0) price = rq / rt; }
    return { side: buy ? 'buy' : 'sell', tokens: tok, bnb: q, price, ts, tx: log.transactionHash, block: log.blockNumber, trader: buy ? '0x' + log.topics[2].slice(26) : null, dex: 1 };
  }

  // V3：amount 为正 = 进池子；价格用成交后的 sqrtPriceX96（token1 / token0），换成「报价币 / 代币」
  parse3(log, info, ts) {
    const [a0, a1, sp] = abi.decode(['int256', 'int256', 'uint160'], log.data);
    const [ta, qa] = info.tokenIs0 ? [a0, a1] : [a1, a0];
    const buy = ta < 0n, tok = Number(ethers.formatUnits(ta < 0n ? -ta : ta, info.tDec)), q = Number(ethers.formatUnits(qa < 0n ? -qa : qa, info.qDec));
    if (!(tok > 0) || !(q > 0)) return null;
    const r = (Number(sp) / 2 ** 96) ** 2, raw = info.tokenIs0 ? r : 1 / r, price = raw * 10 ** (info.tDec - info.qDec);
    return { side: buy ? 'buy' : 'sell', tokens: tok, bnb: q, price: price > 0 && Number.isFinite(price) ? price : q / tok, ts, tx: log.transactionHash, block: log.blockNumber, trader: buy ? '0x' + log.topics[2].slice(26) : null, dex: 1 };
  }

  // 读 [a, b] 一段的成交：有归档节点先走它，出错且是最近的区块再试公共节点
  async scan(info, a, b, latest) {
    const q = { address: info.pair, topics: [info.ver === 3 ? SWAP3 : [SWAP, SYNC]], fromBlock: a, toBlock: b };
    let logs;
    try { logs = await (this.arch || this.p).getLogs(q); }
    catch (e) { if (!this.arch || latest - a >= SPAN) throw e; logs = await this.p.getLogs(q); }
    const out = []; if (!logs.length) return out;
    const [ta, tb] = await Promise.all([this.ts(a), this.ts(b)]);
    let sync = null;
    for (const l of logs) {
      if (l.topics[0] === SYNC) { sync = l; continue; }
      const ts = Math.round(ta + ((tb - ta) * (l.blockNumber - a)) / Math.max(1, b - a));
      const r = info.ver === 3 ? this.parse3(l, info, ts) : this.parse(l, info, ts, sync); if (r) out.push(r);
    }
    return out;
  }

  // 补到最新区块。第一次从迁移的区块开始（见 startBlock）；同一个币同时只跑一个，出错后 30 秒内不再读（不刷爆节点）
  async sync(t) {
    if (t._dexBusy || (t._dexErrAt && Date.now() - t._dexErrAt < 30_000)) return false; t._dexBusy = true;
    try {
      const info = await this.pairOf(t); if (!info) return false;
      const [latest, dep] = await Promise.all([(this.arch || this.p).getBlockNumber(), info.ver === 3 ? this.call(info.quote, 'balanceOf', [info.pair]).then((x) => x[0]).catch(() => null) : this.call(info.pair, 'getReserves').then((r) => (info.tokenIs0 ? r[1] : r[0])).catch(() => null)]);
      if (dep != null) t.dexQuoteRes = Number(ethers.formatUnits(dep, info.qDec));   // 池子里的报价币，算底池用
      const span = this.arch ? ARCH_SPAN : SPAN;
      let added = 0;
      if (!t.dexSwaps) {
        const st = await this.startBlock(t, latest);
        t.dexSwaps = []; t.dexTo = st.from - 1; t.dexFull = st.full;
        // MySQL 缓存：以前读过的外盘成交（按池子存）和读到的区块。离最新不远（公共节点 4500 块内，有归档节点 20 万块内）就接着读，重启后不丢之前的外盘成交；
        // 断得太久接不上就清掉旧的，从头读。库里最早一笔晚于这次的起点（以前只从最近 4500 块读起）时，前面缺的那段单独补（dexGap）
        const c = await cache.loadTrades('dex', info.pair, MAX_SWAPS).catch(() => null);
        if (c?.cursor) {
          if (latest - c.cursor <= (this.arch ? ARCH_GAP : SPAN)) {
            t.dexSwaps = c.rows; t.dexTo = Math.min(latest, c.cursor); added += c.rows.length;
            const first = c.rows[0]?.block ?? t.dexTo + 1;
            if (st.from < first - 1 && st.from <= t.dexTo) t.dexGap = [st.from, Math.min(first - 1, t.dexTo)];
          } else await cache.clearTrades('dex', info.pair).catch(() => {});
        }
        t._dexDb = !!c;
      }
      if (await this.history(t, info).catch(() => false)) added++;
      try {
        // 先补库里缺的较早一段（从迁移起），读到的放在最前面
        while (t.dexGap && t.dexGap[0] <= t.dexGap[1]) {
          const [a, end] = t.dexGap, b = Math.min(a + span - 1, end);
          const rows = await this.scan(info, a, b, latest);
          if (rows.length) {
            const have = new Set(t.dexSwaps.map(uid)), nw = rows.filter((x) => !have.has(uid(x)));
            t.dexSwaps = nw.concat(t.dexSwaps); added += nw.length;
            if (t._dexDb && nw.length) cache.saveTrades('dex', info.pair, nw, t.dexTo, uid).catch(() => {});
          }
          t.dexGap[0] = b + 1;
        }
        t.dexGap = null;
        const fresh = [];
        while (t.dexTo < latest) {
          const a = t.dexTo + 1, b = Math.min(a + span - 1, latest);
          const rows = await this.scan(info, a, b, latest);
          for (const r of rows) { t.dexSwaps.push(r); fresh.push(r); added++; }
          t.dexTo = b;
          if (t._dexDb && (fresh.length || t.dexTo - (t._dexSaved || 0) >= 2000)) { cache.saveTrades('dex', info.pair, fresh.splice(0), t.dexTo, uid).catch(() => {}); t._dexSaved = t.dexTo; }   // 新成交和读到的区块存回库
        }
      } catch (e) { t._dexErrAt = Date.now(); if (!added) throw e; }   // 读到一半出错：已读到的先用上，下次从断的地方接着读
      finally { if (t.dexSwaps.length > MAX_SWAPS) t.dexSwaps.splice(0, t.dexSwaps.length - MAX_SWAPS); }
      return added > 0;
    } finally { t._dexBusy = false; }
  }
}

// 外盘 K 线：GeckoTerminal 历史分钟线（链上成交之前的部分）+ 链上成交按时间分桶（桶大小自动放大，外盘部分最多约 2000 根）
const BUCKETS = [1, 5, 15, 60, 300, 900, 3600, 14400];
export function dexBars(swaps, hist = []) {
  const first = swaps.length ? Math.floor(swaps[0].ts / 1000 / 60) * 60 : Infinity, older = hist.filter((c) => c.t < first);
  if (!swaps.length) return compactCandles(older, 2000);
  const span = (swaps.at(-1).ts - swaps[0].ts) / 1000, max = Math.max(200, 2000 - older.length);
  const b = BUCKETS.find((x) => span / x <= max) || BUCKETS.at(-1); const out = [];
  for (const s of swaps) {
    const k = Math.floor(s.ts / 1000 / b) * b, l = out[out.length - 1];
    if (l && l.t === k) { l.h = Math.max(l.h, s.price); l.l = Math.min(l.l, s.price); l.c = s.price; l.v += s.bnb; }
    else { const o = l ? l.c : s.price; out.push({ t: k, o, h: Math.max(o, s.price), l: Math.min(o, s.price), c: s.price, v: s.bnb, dex: 1 }); }
  }
  return compactCandles(older, 2000 - out.length).concat(out);
}

// 整条 K 线超过 max 根时按时间合并（以前直接只取最后 max 根，外盘成交一多内盘那段就看不到了）
export function compactCandles(cs, max) {
  if (cs.length <= max) return cs;
  const span = cs.at(-1).t - cs[0].t; const b = BUCKETS.find((x) => span / x <= max) || BUCKETS.at(-1); const out = [];
  for (const c of cs) {
    const k = Math.floor(c.t / b) * b, l = out[out.length - 1];
    if (l && l.t === k) { l.h = Math.max(l.h, c.h); l.l = Math.min(l.l, c.l); l.c = c.c; l.v += c.v; } else out.push({ ...c, t: k });
  }
  return out.slice(-max);
}
