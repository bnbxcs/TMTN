// 代币元数据（图标 / 简介 / 社交链接）：Flap 读 Reader 的 meta（IPFS CID），Four 读 TokenCreated 里的 tokenMetaUri（static.four.meme）。
// 低并发、带缓存；遇到 429 整体暂停一会儿，不刷对方接口。
const IPFS = 'https://flap.mypinata.cloud/ipfs/';
const CONCURRENCY = 8;   // 重启后两百多个盘一起读元数据：3 个并发要排一两分钟，新盘的图标跟着慢
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把 CID / ipfs:// / 相对路径统一成可直接加载的 https 地址
export function ipfsUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^https?:\/\/(ipfs\.io|gateway\.pinata\.cloud|cloudflare-ipfs\.com|dweb\.link)\/ipfs\//i.test(s)) return IPFS + s.replace(/^https?:\/\/[^/]+\/ipfs\//i, '');   // 公共网关（ipfs.io 几乎总是 429）换成 Flap 自己的网关
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('ipfs://')) return IPFS + s.slice(7).replace(/^ipfs\//, '');
  if (s.startsWith('/')) return 'https://static.four.meme' + s;
  return IPFS + s;
}

// 允许读元数据 / 代理图片的域名（含子域名，只走 https）——服务端只连这些，别的一律不请求、页面显示文字占位。新图床加在这里，或 .env 里 IMG_HOSTS=a.com,b.com
// genius.fun：它自己的图片代理 genius.fun/api/image?src=…（genius 代币 logo() 是任意图床 / IPFS，统一经它转成 webp，不放行那些图床本身，2026-10-29）
// 2026-10-28 核对过实际在用的：Flap 元数据 / 图片 flap.mypinata.cloud，Four static.four.meme，Gang cdn.gang.fun（+ 字节云 IPFS），Agent ID space.id，shrine
// validation.alphapulsehq.top：第三方转存的 Flap 元数据 / 图片（部分 Agent ID 盘在用）。只在服务端经过这里：元数据按 JSON 解析、限大小、只取字段；
// 图片经 /api/img，按文件头只收 PNG / JPEG / WebP / GIF（SVG、HTML 一律不收）——所有图床都是这条规则
export const MEDIA_HOSTS = ['four.meme', 'genius.fun', 'space.id', 'mypinata.cloud', 'gang.fun', 'gangfun-ipfs.tos-ap-southeast-1.bytepluses.com', 'shrine.trade', 'ipfs.io', 'dweb.link', 'cloudflare-ipfs.com', 'validation.alphapulsehq.top', 'ipfs.filebase.io', 'gateway.pinata.cloud'];
// 明确屏蔽（就算 IMG_HOSTS 里加了也不连）
// 185.130.45.236 / *.trycloudflare.com：2026-10-28 两个针对本程序的 XSS 盘（名字是带 onerror 的 <img>，元数据也放在这两处）
export const BLOCKED_HOSTS = ['185.130.45.236', 'trycloudflare.com'];
const hostIn = (h, list) => list.some((x) => h === x || h.endsWith('.' + x));
const warned = new Set();
export function mediaHostOk(u) {
  let x; try { x = new URL(u); } catch { return false; }
  const h = x.hostname.toLowerCase(), extra = String(process.env.IMG_HOSTS || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  const hostOk = !hostIn(h, BLOCKED_HOSTS) && hostIn(h, [...MEDIA_HOSTS, ...extra]);
  if (!hostOk && h && !warned.has(h)) { warned.add(h); console.warn(`[meta] 不在图床白名单（或已屏蔽），不请求：${h}`); }   // 每个域名只记一次
  return hostOk && x.protocol === 'https:' && !x.username && !x.password && (!x.port || x.port === '443');
}

// 元数据的备用 IPFS 网关（按顺序试）：filebase 快（约 1 秒），pinata 公共网关慢（约 6 秒）但收录多
const IPFS_FALLBACK = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
export class MetaFetcher {
  // 429 只暂停那一个域名（pausedUntil 按 host 记）：以前任何一个网关 429 就把所有元数据请求停 60 秒，任务还占着并发位等，
  // 重启后几十个读不到的旧盘反复重试，新盘的图标排几分钟（七仔 0x5bae…7777 2026-10-28）。被暂停的域名直接算这次失败，由调用方按退避再来
  constructor() { this.cache = new Map(); this.queue = []; this.active = 0; this.pausedUntil = new Map(); }

  // url → 回调 { image, description, website, twitter, telegram }；同一个 url 只请求一次。front = 插到队首（新盘第一次请求，不排在旧盘重试后面）
  get(url, cb, { front = false } = {}) {
    if (!url || !mediaHostOk(url)) return;
    const hit = this.cache.get(url);
    if (hit && hit !== 'pending') return cb(hit);
    if (hit === 'pending') return;
    this.cache.set(url, 'pending');
    this.queue[front ? 'unshift' : 'push']({ url, cb });
    this.pump();
  }

  pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift(); this.active++;
      this.run(job).finally(() => { this.active--; this.pump(); });
    }
  }

  // IPFS 地址先用原网关，拿不到（403 没 pin / 404 / 429 / 超时）再换备用网关。Flap 的 pinata 网关只给 Flap 自己 pin 过的 CID：
  // 有些盘的元数据传在别处（AGENT铭文 0x91fc…7777 2026-10-28：flap.mypinata.cloud 403，filebase 200），以前就一直没图标、没创建者
  async run({ url, cb }) {
    const cid = /\/ipfs\/([^?#]+)/.exec(url)?.[1];
    const urls = [url, ...(cid ? IPFS_FALLBACK.map((g) => g + cid).filter((x) => x !== url) : [])];
    for (const u of urls) if (await this.runOne(u, url, cb)) return;
    this.cache.delete(url);   // 失败的下次再试
  }
  async runOne(url, key, cb) {
    let host = ''; try { host = new URL(url).host; } catch { /* 下面 fetch 会失败 */ }
    for (let k = 0; k < 3; k++) {
      if ((this.pausedUntil.get(host) || 0) > Date.now()) break;
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 429) { this.pausedUntil.set(host, Date.now() + 60_000); break; }
        if (!res.ok) return false;
        // 元数据只当 JSON 读，最多 64 KB（超了不要）；只取下面几个字段给页面，原文不往外传
        if (Number(res.headers.get('content-length') || 0) > 65_536) break;
        const raw = await res.text(); if (raw.length > 65_536) break;
        const j = JSON.parse(raw); if (!j || typeof j !== 'object') break;
        const links = j.links || {};
        const img = ipfsUrl(j.image || j.img), v = { image: img && mediaHostOk(img) ? img : null, description: j.description || '', website: j.website || links.website || '',
          twitter: j.twitter || links.twitter || '', telegram: j.telegram || links.telegram || '', metaCreator: /^0x(?!0{40})[0-9a-fA-F]{40}$/.test(j.creator || '') ? j.creator.toLowerCase() : null };   // Flap 元数据里的 creator = 发币交易的 from（核对过）
        this.cache.set(key, v); cb(v);
        return true;
      } catch { if (k < 2) await sleep(1000 * (k + 1)); }
    }
    return false;
  }
}
