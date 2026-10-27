// Feast（feast.meme，BSC 上的 meme 发射台：币一开盘就在 PancakeSwap Infinity 真池子里交易，计价币 WBNB 或币股，无曲线、无毕业迁移）行情：只读它的公开接口。
// /api/v1/pools 给全部币（池子 key、计价币、创建者、最近价、24h 量、开盘上限），游标翻页，每 10 秒拉一次；
// /api/v1/snapshot 给最近 24 小时有成交的币的 BNB 价、分时涨跌、买卖笔数、持有人、市值，和 pools 合并（没成交的币只有 pools 的字段）。
// 名称 / 头像 / 简介在 IPFS：元数据 JSON 经 feast.meme/api/ipfs/<cid> 读（每个 cid 只读一次），图片也走同一路径（server.js 的头像代理已允许 feast.meme）。
// 下单在 feastTrade.js。成交流 / K 线这版没接（站点有 /api/v1/events 和 /api/v1/ohlcv，下一版再接）。
import { EventEmitter } from 'node:events';
import { FEAST_API, FEAST_SITE } from './config.js';
import { FEAST, STOCK_ROUTES } from './feastTrade.js';

const LIST_MS = 10_000;
const Q192 = 1n << 192n, E18 = 10n ** 18n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
// 池子的 sqrtPriceX96 → 每个币值多少报价币（两种币序都算；所有币都是 18 位小数）
export const priceQuoteOf = (sqrtPriceX96, coinIsCurrency0) => {
  const s = BigInt(sqrtPriceX96 || 0); if (s === 0n) return 0;
  return Number(coinIsCurrency0 ? (s * s * E18) / Q192 : (Q192 * E18) / (s * s)) / 1e18;
};
const ts = (v) => { const n = Date.parse(v || ''); return Number.isFinite(n) ? Math.floor(n / 1000) : null; };
// 元数据里的字段只当 CID 用：去掉 ipfs:// 前缀后必须是合法 CID 形式（CIDv0 base58 46 位 / CIDv1 base32），一律拼到 FEAST_SITE/api/ipfs/<cid>。
// 绝对网址（http / https）、路径、带参数的一律拒绝：币的元数据不能决定服务端去请求什么网址（SSRF）
const CID_RE = /^[a-zA-Z0-9]{46,100}$/;
export const cidOf = (v) => { const s = String(v || '').trim().replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, ''); return CID_RE.test(s) ? s : null; };
export const ipfsUrl = (v) => { const cid = cidOf(v); return cid ? `${FEAST_SITE}/api/ipfs/${cid}` : null; };
// 图片网址再过一道和 server.js 头像代理（imgHostOk）一样的检查：只认 https、无账号密码、默认端口、主机只能是站点主机
const IMG_HOSTS = (() => { try { return [new URL(FEAST_SITE).hostname.toLowerCase()]; } catch { return ['feast.meme']; } })();
export const imageUrlOk = (u) => { try { const x = new URL(String(u || '')); return x.protocol === 'https:' && !x.username && !x.password && (!x.port || x.port === '443') && IMG_HOSTS.some((h) => x.hostname === h || x.hostname.endsWith('.' + h)); } catch { return false; } };
// 报价币符号从地址的固定映射得出（WBNB → BNB、路线表里的币股）；映射外的地址只在接口给的符号是 1–12 位字母数字时照用，否则 '?'：
// 符号是页面上拼进 HTML 的字符串，接口里的任意文本不能原样进页面（存储型 XSS）
const QUOTE_SYMBOLS = { [FEAST.wbnb.toLowerCase()]: 'BNB', ...Object.fromEntries(Object.entries(STOCK_ROUTES).map(([a, s]) => [a, s.symbol])) };
const SYMBOL_RE = /^[A-Za-z0-9]{1,12}$/;
export const quoteSymbolOf = (address, apiSymbol) => {
  const known = QUOTE_SYMBOLS[String(address || '').toLowerCase()]; if (known) return known;
  const s = String(apiSymbol || '').trim(); return SYMBOL_RE.test(s) && s.toUpperCase() !== 'BNB' && s.toUpperCase() !== 'WBNB' ? s : '?';
};
// 元数据里的网址 / 账号只透传不带引号、空白、尖括号和非 http(s) 协议的短字符串（页面把它们放进 href）
const linkOf = (v) => { const s = String(v || '').trim(); return s.length <= 200 && !/[\s"'<>\\]/.test(s) && !/^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(s) ? s : ''; };

export class FeastApi extends EventEmitter {
  constructor() {
    super();
    this.seen = new Set();
    this.metaSeen = new Set();
    this.status = { connected: false, total: 0, lastError: null, lastPollMs: 0, pausedUntil: 0 };
  }

  start() { this.loopList(); }

  async get(path) {
    const wait = this.status.pausedUntil - Date.now(); if (wait > 0) await sleep(wait);
    const res = await fetch(FEAST_API + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) { this.status.pausedUntil = Date.now() + 60_000; throw new Error('feast.meme 限流（429），暂停 1 分钟'); }
    if (!res.ok) throw new Error(`feast.meme HTTP ${res.status}`);
    return res.json();
  }

  // 全部池子：按 nextCursor 翻页（最多 20 页）
  async pools() {
    const out = []; let cursor = null;
    for (let i = 0; i < 20; i++) {
      const j = await this.get(`/pools?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      out.push(...(j.pools || []));
      if (!j.nextCursor || j.nextCursor === cursor) break; cursor = j.nextCursor;
    }
    return out;
  }

  async loopList() {
    let first = true;
    for (;;) {
      const t0 = Date.now();
      try {
        const [pools, snap] = await Promise.all([this.pools(), this.get('/snapshot').catch(() => null)]);
        const bySnap = new Map((snap?.coins || []).map((c) => [String(c.address).toLowerCase(), c]));
        for (const p of pools) {
          const it = this.fromPool(p, bySnap.get(String(p.coin?.address).toLowerCase()));
          if (!it) continue;
          const isNew = !first && !this.seen.has(it.address);
          this.emit('token', it, { isNew });
          this.seen.add(it.address);
          this.loadMeta(it.address, it.metadataCid);
        }
        this.status.total = pools.length; this.status.connected = true; this.status.lastError = null; first = false;
      } catch (e) { this.status.connected = false; this.status.lastError = e.message; }
      this.status.lastPollMs = Date.now() - t0;
      await sleep(LIST_MS);
    }
  }

  // pools 的一条 + snapshot 的一条（可能没有）→ 统一字段。价格 / 金额用报价币单位（和全站约定一致），BNB 价只在 snapshot 给了时带上
  fromPool(p, s) {
    const address = String(p.coin?.address || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(address) || !p.poolKey) return null;
    const key = p.poolKey, coinIs0 = String(key.currency0).toLowerCase() === address;
    // 创建者只认合法地址（不是地址 = null）：它会进详情页 / 屏蔽按钮的 HTML（存储型 XSS）
    // 报价币地址以池子 key 为准（接口的 quote.address 只在是合法地址时采用）；符号只从地址推（见 quoteSymbolOf）
    const quoteAddress = String(ADDR_RE.test(String(p.quote?.address || '')) ? p.quote.address : (coinIs0 ? key.currency1 : key.currency0)).toLowerCase();
    const quoteSym = quoteSymbolOf(quoteAddress, p.quote?.symbol);
    const priceQuote = p.market?.lastPriceSqrtX96 ? priceQuoteOf(p.market.lastPriceSqrtX96, coinIs0) : Number(s?.priceQuote) || 0;
    const isBnb = quoteAddress === FEAST.wbnb.toLowerCase();
    return {
      address, name: p.coin.name || '', symbol: p.coin.symbol || '?', creator: ADDR_RE.test(String(p.creator || '')) ? String(p.creator).toLowerCase() : null, createdAt: ts(p.createdAt) || Math.floor(Date.now() / 1000),
      poolId: p.poolId, poolKey: key, quoteAddress, quoteSymbol: quoteSym, isStock: !!p.quote?.isStock,
      hookFeeBps: p.hookFeeBps ?? 100, feeSplitBps: p.feeSplitBps || null, opening: p.opening || null, metadataCid: cidOf(p.coin.metadataCid),
      priceQuote, priceBnb: s?.priceBnb ?? (isBnb ? priceQuote : null),
      volume24hBnb: s?.volume24hBnb ?? (isBnb ? Number(p.market?.volume24h || 0) / 1e18 : 0), trades24h: s?.trades24h ?? p.market?.trades24h ?? 0,
      holders: s?.holders ?? p.market?.holders ?? null, lastTradeAt: ts(s?.lastTradeAt || p.market?.lastTradeAt), mcapBnb: s?.meta?.marketCapBnb ?? null, windows: s?.windows || null,
    };
  }

  // 元数据 JSON：{ name, symbol, description, image: 'ipfs://<cid>' }，每个 cid 只读一次；失败不重试（下一次轮询还会再来）。
  // 只请求 FEAST_SITE/api/ipfs/<合法 cid>：不是 CID 形式的一律不请求；图片也只认 CID 拼出的站点网址，再过一道 imageUrlOk
  loadMeta(address, cid) {
    const url = ipfsUrl(cid);
    if (!url || this.metaSeen.has(cid)) return null;
    this.metaSeen.add(cid);
    return (async () => {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) { this.metaSeen.delete(cid); return; }
        const j = await res.json();
        const image = ipfsUrl(j?.image);
        this.emit('meta', address, { image: image && imageUrlOk(image) ? image : null, description: String(j?.description || '').slice(0, 2000), website: linkOf(j?.website), twitter: linkOf(j?.twitter), telegram: linkOf(j?.telegram) });
      } catch { this.metaSeen.delete(cid); }
    })();
  }
}
