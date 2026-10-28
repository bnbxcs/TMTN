// 代币「喊单」（社区评论 / callout）：详情页「喊单」标签按需拉取，不在后台轮询所有币。
// 来源：
//  - four.meme 代币评论（公开接口，免登录）：CA → tokenId（永久缓存）→ /v1/private/token/comment
//  - GMGN 官方 OpenAPI（.env GMGN_API_KEY）：没有「按代币查喊单」的接口，只有全链 BSC 喊单流 POST /v1/callout/global（每页 ≤50 条，约 10 分钟）。
//    （按 call_token 等参数过滤实测无效，官方 CLI 也是只读、不能发喊单）→ 后台每 45 秒拉一次（startGmgnCollector），存盘 data/gmgn-callouts.jsonl
//    （滚动 7 天、最多 150000 条（约 1.4 万条 / 天），重启接着用；停机留下的空档启动时往回补，最多 400 页 ≈ 1~2 天），再按 call_token 过滤 → 能看到开始收集以后的喊单。
//  - debot（第三方非公开接口，未获准调用）、flap / gang（没有按代币的评论）暂不支持，返回 sources[x].error 说明。
// 每个 CA 缓存 45 秒、同一 CA 并发请求合并、单源 8 秒超时、最多缓存 300 个 CA（LRU），某个源失败只标记该源，不影响其他源。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { env, dataFile } from './config.js';

const TTL = 45_000, TIMEOUT = 8_000, MAX_CAS = 300, MAX_TEXT = 2000;
const FOUR = 'https://four.meme/meme-api/v1';
export const CALLOUT_SOURCES = ['four', 'gmgn', 'debot', 'fomo', 'pumpfun'];
const UNSUPPORTED = { debot: 'debot 接口未接入', fomo: '暂未接入', pumpfun: '暂未接入' };

const cache = new Map();      // ca → { at, data }（Map 的插入顺序当 LRU）
const inflight = new Map();   // ca → Promise
const fourIds = new Map();    // ca → tokenId（数字）| { none: until }（不是 four.meme 的币，10 分钟后再查）

const getJson = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
const str = (v, n) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, n);
const norm = (v) => String(v || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const httpUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) && u.length < 1000 ? u : '');

async function fourTokenId(ca) {
  const c = fourIds.get(ca);
  if (typeof c === 'number') return c;
  if (c && c.none > Date.now()) return null;
  const j = await getJson(`${FOUR}/private/token/get/v2?address=${ca}`);
  const id = Number(j?.data?.id);
  if (j?.code === 0 && Number.isSafeInteger(id) && id > 0) { fourIds.set(ca, id); return id; }
  fourIds.set(ca, { none: Date.now() + 600_000 });
  if (fourIds.size > 5000) fourIds.clear();
  return null;
}
async function fetchFour(ca) {
  const id = await fourTokenId(ca);
  if (!id) return { items: [], note: '不是 four.meme 的币' };
  const j = await getJson(`${FOUR}/private/token/comment?tokenId=${id}&pageIndex=1&pageSize=30`);
  if (j?.code !== 0) throw new Error(str(j?.msg, 100) || 'four.meme 返回错误');
  const items = (Array.isArray(j.data) ? j.data : []).map((x) => ({
    platform: 'four', id: 'four:' + str(x.id, 40),
    author: str(x.userName, 80) || '匿名', avatar: httpUrl(x.avatarPath),
    text: str(x.comment, MAX_TEXT), translation: '', ts: Number(x.createDate) || 0,
  })).filter((x) => x.text);
  return { items };
}

// ---------- GMGN 全链喊单流（共享缓冲区） ----------
const GMGN_HOST = 'https://openapi.gmgn.ai';
const GMGN_KEEP_MS = 7 * 86400_000, GMGN_KEEP_N = 150000, GMGN_MAX_PAGES = 6, GMGN_GAP_PAGES = 400, GMGN_EVERY = 45_000;   // 官方限流 20 次 / 窗口，45 秒一次（追历史最多 6 页）远低于此
const GMGN_FILE = dataFile('gmgn-callouts.jsonl');
const gm = { buf: [], seen: new Set(), at: 0, p: null, until: 0, err: '', fileN: 0, fileSize: 0, idx: null };   // buf：新 → 旧；fileN：存盘文件的行数
async function gmgnPage(pageToken) {
  const key = env('GMGN_API_KEY', ''); if (!key) throw new Error('没配 GMGN_API_KEY');
  const q = new URLSearchParams({ timestamp: String(Math.floor(Date.now() / 1000)), client_id: crypto.randomUUID() });
  const r = await fetch(`${GMGN_HOST}/v1/callout/global?${q}`, { method: 'POST', headers: { 'X-APIKEY': key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ chains: ['bsc'], limit: 50, ...(pageToken ? { page_token: pageToken } : {}) }), signal: AbortSignal.timeout(TIMEOUT) });
  const j = await r.json().catch(() => null);
  if (r.status === 429 || /RATE_LIMIT/.test(String(j?.code ?? '') + String(j?.msg ?? j?.message ?? ''))) {   // 限流：按 X-RateLimit-Reset / reset_at 暂停
    const reset = Number(j?.reset_at || r.headers.get('x-ratelimit-reset')) * 1000;
    gm.until = reset > Date.now() ? Math.min(reset, Date.now() + 600_000) : Date.now() + 60_000;
    throw new Error('GMGN 限流');
  }
  if (!r.ok || j?.code !== 0) throw new Error(str(j?.msg || j?.message, 100) || 'HTTP ' + r.status);
  return { list: Array.isArray(j.data?.list) ? j.data.list : [], next: typeof j.data?.next_page_token === 'string' ? j.data.next_page_token : '' };
}
async function gmgnRefresh() {
  const fresh = [], cut = Date.now() - GMGN_KEEP_MS; let token = '', hitOld = false, err = null;
  // 平时翻到见过的那条就停（一般 1 页）；本地有存档但中间有空档（停机）时一直往回补到接上，最多 GMGN_GAP_PAGES 页、每页隔 1.5 秒；
  // 完全没存档时只拿 4 页（约 40 分钟）。翻页中途出错（限流 / 超时）已拿到的照样存
  const maxPages = gm.buf.length ? GMGN_GAP_PAGES : 4;
  try {
    for (let i = 0; i < maxPages && !hitOld; i++) {
      if (i >= GMGN_MAX_PAGES) await new Promise((r) => setTimeout(r, 1500));
      const { list, next } = await gmgnPage(token);
      for (const x of list) { const id = str(x?.ulid, 40); if (!id) continue; if (gm.seen.has(id)) { hitOld = true; continue; } fresh.push(x); }
      if (!next || !list.length || list.some((x) => Number(x?.create_time) < cut)) break;
      token = next;
    }
  } catch (e) { err = e; }
  const add = fresh.map(gmgnItem);
  gm.buf = [...add, ...gm.buf].filter((x) => x.ts >= cut).sort((a, b) => b.ts - a.ts).slice(0, GMGN_KEEP_N); gm.idx = null;   // 按时间新 → 旧，超量丢最旧的
  gm.seen = new Set(gm.buf.map((x) => x.id.slice(5)));
  gmgnPersist(add);
  if (err) throw err;
  gm.at = Date.now(); gm.err = '';
}
// 外部补历史（一次性往回翻页的脚本用）：原始条目 → 去重、并入、存盘，返回新增条数
export function gmgnIngest(list) {
  const cut = Date.now() - GMGN_KEEP_MS;
  const add = (Array.isArray(list) ? list : []).filter((x) => { const id = str(x?.ulid, 40); return id && !gm.seen.has(id) && Number(x.create_time) >= cut && gm.seen.add(id); }).map(gmgnItem);
  if (!add.length) return 0;
  gm.buf = [...add, ...gm.buf].sort((a, b) => b.ts - a.ts).slice(0, GMGN_KEEP_N); gm.idx = null;
  gmgnPersist(add); return add.length;
}
// 存盘：新喊单追加一行一条；文件里过期 / 超量的行多于 2000 条时整份重写
function gmgnPersist(add) {
  try {
    if (add.length) { fs.appendFileSync(GMGN_FILE, add.map((x) => JSON.stringify(x)).join('\n') + '\n'); gm.fileN += add.length; }
    if (gm.fileN > gm.buf.length + 2000) { const tmp = new URL(GMGN_FILE.href + '.tmp'); fs.writeFileSync(tmp, gm.buf.map((x) => JSON.stringify(x)).join('\n') + (gm.buf.length ? '\n' : '')); fs.renameSync(tmp, GMGN_FILE); gm.fileN = gm.buf.length; }
  } catch (e) { console.warn('[callouts] GMGN 喊单存盘失败', e.message); }
  gm.fileSize = fileSize();
}
const fileSize = () => { try { return fs.statSync(GMGN_FILE).size; } catch { return 0; } };
// 按代币的索引（buf 一变就作废，下次查询时重建）
function gmgnByToken(ca) {
  if (!gm.idx) { gm.idx = new Map(); for (const x of gm.buf) { let a = gm.idx.get(x.token); if (!a) gm.idx.set(x.token, (a = [])); a.push(x); } }
  return gm.idx.get(ca) || [];
}
// 也用于别的进程（补历史脚本）往文件里追加后重新读
function gmgnLoad() {
  let lines = []; try { lines = fs.readFileSync(GMGN_FILE, 'utf8').split('\n'); } catch { return; }   // 第一次没有文件
  const cut = Date.now() - GMGN_KEEP_MS, byId = new Map();
  for (const l of lines) { if (!l) continue; let x; try { x = JSON.parse(l); } catch { continue; } if (x && typeof x.id === 'string' && x.platform === 'gmgn' && Number(x.ts) >= cut) byId.set(x.id, x); }
  gm.buf = [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, GMGN_KEEP_N); gm.idx = null;
  gm.seen = new Set(gm.buf.map((x) => x.id.slice(5))); gm.fileN = lines.filter(Boolean).length; gm.fileSize = fileSize();
}
// 后台收集（server.js 启动时调用，只在主钱包后端跑一份）；.env GMGN_COLLECT=0 关掉，回到「打开喊单栏才拉」
let gmTimer = null;
export function startGmgnCollector() {
  if (gmTimer || !env('GMGN_API_KEY', '') || String(env('GMGN_COLLECT', '1')) === '0') return;
  const tick = () => {
    if (!gm.p && fileSize() !== gm.fileSize) gmgnLoad();   // 文件被别的进程追加过（补历史）：重新读，不用重启就能看到
    if (gm.p || Date.now() < gm.until) return; gm.p = gmgnRefresh().catch((e) => { gm.err = str(e?.name === 'TimeoutError' ? '超时' : e?.message, 120); }).finally(() => { gm.p = null; }); };
  gmTimer = setInterval(tick, GMGN_EVERY); gmTimer.unref?.(); tick();
  console.log(`[callouts] GMGN 喊单后台收集已开（每 ${GMGN_EVERY / 1000} 秒，本地已有 ${gm.buf.length} 条）`);
}
// GMGN 头像（gmgn.ai/defi/images/twitter/…）有 Cloudflare，服务端、浏览器直连都拿不到 → 按推特号另取：
//  1) api.fxtwitter.com/<号>（公开、免登录、无日额度）→ pbs.twimg.com 原图地址；推特默认头像（default_profile_images）当作没有
//  2) fxtwitter 连不上才退回 unavatar.io（免费版每 IP 每天 25 次）
// 只给 GMGN 自己有头像地址的人查（没头像的多是 GMGN 自动起的匿名名 HonestUnauditedGolem 之类，没有真推特号）。
// 查到的地址永久记在 data/x-avatars.json（重启不丢，同一个号不再查）；查不到只在内存里记 30 分钟
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const XAV_FILE = dataFile('x-avatars.json');
let xav = {}; try { xav = JSON.parse(fs.readFileSync(XAV_FILE, 'utf8')) || {}; } catch { /* 第一次没有文件 */ }
const xavMiss = new Map(), xavInflight = new Map();
let xavSaveT = 0;
const xavSave = () => { if (xavSaveT) return; xavSaveT = setTimeout(() => { xavSaveT = 0; try { fs.writeFileSync(XAV_FILE, JSON.stringify(xav)); } catch (e) { console.warn('[callouts] 头像索引保存失败', e.message); } }, 2000); };
const unavatar = (h) => `https://unavatar.io/x/${h}?fallback=false`;   // fallback=false：查不到返回 404（不给默认图）
async function xAvatar(h) {
  const k = h.toLowerCase();
  if (xav[k]) return xav[k];
  if ((xavMiss.get(k) || 0) > Date.now()) return '';
  let p = xavInflight.get(k);
  if (!p) {
    p = (async () => {
      let r; try { r = await fetch(`https://api.fxtwitter.com/${h}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }); } catch { return unavatar(h); }   // fxtwitter 连不上：退回 unavatar（不记索引）
      const j = await r.json().catch(() => null);
      const u = String(j?.user?.avatar_url || '');
      if (r.ok && /^https:\/\/pbs\.twimg\.com\/profile_images\/\d+\/[\w-]+_normal\.(jpe?g|png|webp)$/i.test(u)) { xav[k] = u.replace('_normal.', '_200x200.'); xavSave(); return xav[k]; }   // 48px 的 _normal 太糊，取 200px
      if (r.status >= 500 || r.status === 429) return unavatar(h);
      xavMiss.set(k, Date.now() + 1800_000); if (xavMiss.size > 5000) xavMiss.clear();   // 号不存在 / 默认头像 / 地址格式不认识
      return '';
    })().finally(() => xavInflight.delete(k));
    xavInflight.set(k, p);
  }
  return p;
}
function gmgnItem(x) {
  const th = x.call_thesis || {}, tr = th.translation_content || {};
  const text = str(th.source_content, MAX_TEXT), zh = str(tr.zh_hans, MAX_TEXT);
  const av = httpUrl(x.profile_image_url || x.wallet_avatar);
  return {
    platform: 'gmgn', id: 'gmgn:' + str(x.ulid, 40), token: str(x.call_token, 60).toLowerCase(),
    author: str(x.display_name || x.twitter_name || x.username, 80) || str(x.call_wallet, 42) || '匿名',
    avatar: /^https:\/\/(www\.)?gmgn\.ai\//i.test(av) ? '' : av, xh: av && HANDLE_RE.test(str(x.twitter_username, 20)) ? str(x.twitter_username, 15) : '',   // xh：要另查头像的推特号（见 xAvatar）
    text, translation: zh && norm(zh) !== norm(text) ? zh : '', ts: Number(x.create_time) || 0,   // 译文只和原文差大小写 / 标点（og → OG）就不要
    kol: !!x.is_kol, mc: Number(x.call_mc) || 0,
  };
}
async function fetchGmgn(ca) {
  if (!env('GMGN_API_KEY', '')) return { items: [], note: '没配 GMGN_API_KEY' };
  if (Date.now() - gm.at > (gmTimer ? 2 * GMGN_EVERY : TTL) && Date.now() >= gm.until) {   // 后台在收集时只在它卡住时补一次
    if (!gm.p) gm.p = gmgnRefresh().catch((e) => { gm.err = str(e?.name === 'TimeoutError' ? '超时' : e?.message, 120); }).finally(() => { gm.p = null; });
    if (!gm.buf.length) await gm.p;   // 有存档就先用存档回（往回补空档可能要几分钟）
  }
  if (gm.err && !gm.buf.length) throw new Error(gm.err);
  const oldest = gm.buf.length ? gm.buf[gm.buf.length - 1].ts : 0, od = new Date(oldest || Date.now()), p2 = (n) => String(n).padStart(2, '0');
  const since = `${p2(od.getMonth() + 1)}-${p2(od.getDate())} ${p2(od.getHours())}:${p2(od.getMinutes())}`;   // 本机时间
  const items = gmgnByToken(ca);
  const hs = [...new Set(items.filter((x) => !x.avatar && x.xh).map((x) => x.xh))].slice(0, 40), got = {};
  await Promise.all(hs.map(async (h) => { got[h] = await xAvatar(h).catch(() => ''); }));
  return { items: items.map(({ token, xh, ...x }) => (!x.avatar && xh && got[xh] ? { ...x, avatar: got[xh] } : x)), note: `已收集 ${since} 起的全链喊单${gm.err ? '（刷新失败：' + gm.err + '）' : ''}` };
}

async function load(ca) {
  const sources = {}, items = [];
  const runs = { four: fetchFour, gmgn: fetchGmgn };
  await Promise.all(Object.entries(runs).map(async ([k, fn]) => {
    try { const r = await fn(ca); items.push(...r.items); sources[k] = { ok: true, count: r.items.length, ...(r.note ? { note: r.note } : {}) }; }
    catch (e) { sources[k] = { ok: false, error: str(e?.name === 'TimeoutError' ? '超时' : e?.message, 120) }; }
  }));
  for (const [k, msg] of Object.entries(UNSUPPORTED)) sources[k] = { ok: false, unsupported: true, error: msg };
  items.sort((a, b) => b.ts - a.ts);
  return { ca, at: Date.now(), items, sources };
}

export async function getCallouts(ca, source = 'all') {
  ca = String(ca || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca)) throw Object.assign(new Error('CA 格式不对'), { status: 400 });
  if (source !== 'all' && !CALLOUT_SOURCES.includes(source)) throw Object.assign(new Error('source 不支持'), { status: 400 });
  let c = cache.get(ca);
  if (!c || Date.now() - c.at > TTL) {
    let p = inflight.get(ca);
    if (!p) { p = load(ca).finally(() => inflight.delete(ca)); inflight.set(ca, p); }
    c = { at: Date.now(), data: await p };
  }
  cache.delete(ca); cache.set(ca, c);
  while (cache.size > MAX_CAS) cache.delete(cache.keys().next().value);
  const d = c.data;
  return source === 'all' ? d : { ...d, items: d.items.filter((x) => x.platform === source) };
}

gmgnLoad();   // 启动时读回存盘的 GMGN 喊单
