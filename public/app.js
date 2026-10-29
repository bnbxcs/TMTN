// ID AGENT · Curve Terminal 前端（无构建、原生 JS）
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const SUBS = '₀₁₂₃₄₅₆₇₈₉';

/* 持仓快照：放最前面，启动过程中（还没执行到持仓页代码）也能读 */
const HOLD = { data: null, open: new Set(), plats: new Set(['flap', 'four', 'gang']) };
/* 追踪 / 跟单页的状态（放最前面，启动过程中收到推送也能用） */
const SNP = { v: null, log: [], err: null };   // Gang 新盘狙击（服务器 /api/snipe）
const TRK = { tab: 'feed', cptab: 'active', targets: [], groups: ['默认'], feed: [], tasks: [], paused: false, log: [], loaded: false, fGroup: '', fMin: 0, sound: false };
const S = {
  tokens: new Map(), selected: null, detail: null, platform: 'four', listTab: 'curve', chips: new Set(),
  side: 'buy', amtMode: 'bnb', slippage: 35, selWallets: new Set(['big']), activeWallet: 'big',
  interval: 1, metric: 'mcap', bottomTab: 'pos', orders: [], logs: [], records: [],
  wallets: [], positions: [], config: null, settings: {}, usage: {}, net: {}, block: 0, bnbUsd: 744, snipeCurve: [],
  hover: null, newTokens: new Set(), settingsPlat: 'four', mode: 'sim', baw: null,
  blk: { tokens: {}, devs: {} },
  rules: {},   // 单币规则：发射后领取 / 转出
  fav: (() => { try { return JSON.parse(localStorage.getItem('fav') || 'null') || { groups: ['默认'], items: {} }; } catch { return { groups: ['默认'], items: {} }; } })(),   // 收藏（服务器为准，本地先显示）   // 屏蔽列表（S.block 是区块高度）
};
const LIVE = () => S.mode === 'live';
const REAL = () => LIVE() && S.baw?.dryRun === false;   // LIVE_TRADE=1：手动订单会真实上链
// 多钱包（同时下单）：S.walletsInfo = 主后端 /api/wallets 给的每个钱包（slot、标签、地址、BNB、登录状态、是否参与下单、登录命令）
const MW = () => LIVE() && (S.walletsInfo || []).length > 1;
const onWallets = () => (S.walletsInfo || []).filter((w) => w.on);
const AUTH_OK = () => !LIVE() || (MW() ? onWallets().some((w) => w.auth === 'ok') : S.baw?.auth?.state === 'ok');

/* ---------- 格式化 ---------- */
function sub(x, sig = 4) {
  if (!isFinite(x)) return '—';
  if (x === 0) return '0';
  if (Math.abs(x) >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (x >= 0.001) return x.toFixed(Math.max(4, sig + 1));
  const zeros = -Math.floor(Math.log10(x)) - 1;
  const digits = String(Math.round(x * 10 ** (zeros + sig))).slice(0, sig);
  return '0.0' + String(zeros).split('').map((d) => SUBS[d]).join('') + digits;
}
const K = (n, d = 2) => { const a = Math.abs(n); return a >= 1e9 ? (n / 1e9).toFixed(d) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(d) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(d) + 'K' : n.toFixed(d); };
const usd = (n) => (!n || !isFinite(n) ? '—' : Math.abs(n) < 0.01 ? '$' + sub(n) : '$' + K(n));
const bnb = (n, d = 4) => (n == null || !isFinite(n) ? '—' : n !== 0 && Math.abs(n) < 0.0001 ? sub(n) : n.toFixed(d));
const short = (a, h = 6, t = 4) => (a ? a.slice(0, h) + '…' + a.slice(-t) : '');
// 相对时间旁边悬停显示的精确时间：本地时区，精确到秒，例如 2026/10/27 01:37:12
const fullTime = (ts) => { if (!ts) return ''; const d = new Date(ts), p = (n) => String(n).padStart(2, '0'); return isNaN(d) ? '' : `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const age = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const hms = (ts) => new Date(ts).toTimeString().slice(0, 8);
const pctS = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
// 转义链上 / 第三方文字（代币名、代号、域名等）：有人会把 <img onerror=…> 之类的代码写进代币名，必须转义后才能放进 HTML，单引号也要转
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 有图标就显示图片，加载失败时删掉图片、露出下面的文字占位
// 钱包列：有域名显示域名，鼠标悬停看完整地址，点击打开 bscscan
const NAMES = {}; let namesVer = -1;
const nameOf = (r) => r.name || NAMES[String(r.trader || '').toLowerCase()] || null;
setInterval(async () => { try { const j = await api(`/api/names?ver=${namesVer}`); if (j.names) { Object.assign(NAMES, j.names); namesVer = j.ver; } } catch { /* ignore */ } }, 3000);
// 钱包颜色（全站统一走 whoHtml）：自己的钱包（按地址比）绿色 + 「我·N」；备注 / 追踪过的钱包黄色，显示备注名；其他钱包（包括 .ai / .bnb 域名）一律白色
const myAddr = () => String(S.baw?.auth?.address || (LIVE() ? S.wallets[0]?.address : '') || '').toLowerCase();
// 自己的所有钱包（多钱包时钱包 1、2…都算「我」）：地址 → 第几个钱包
function myWallets() {
  const m = new Map(); const add = (a, slot) => { if (a) m.set(String(a).toLowerCase(), slot); };
  add(myAddr(), 1); for (const w of S.walletsInfo || []) add(w.address, w.slot);
  return m;
}
const isMe = (a) => !!a && myWallets().has(String(a).toLowerCase());
const meTag = (a) => { const slot = myWallets().get(String(a || '').toLowerCase()); return `<i class="me-tag" title="${MW() ? '我的钱包 ' + slot : '我的钱包'}">我${MW() && slot ? '·' + slot : ''}</i>`; };
// 备注过的钱包 = 追踪列表里填了备注名的地址（比如「鸡腿 AI」「发呆」），或在「查域名」里直接备注过的地址（REMARKS）；只追踪、没填备注的仍算没备注
const REMARKS = {};
const loadRemarks = () => api('/api/remarks').then((o) => { for (const k of Object.keys(REMARKS)) delete REMARKS[k]; Object.assign(REMARKS, o || {}); }).catch(() => {});
setTimeout(loadRemarks, 0);
const noteOf = (addr) => (addr && typeof trkRemark === 'function' && trkRemark(addr)) || '';
const whoHtml = (addr, name0, a = 6, b = 4) => {
  const t = noteOf(addr), name = t || name0;
  if (isMe(addr)) return `<b class="me">${esc(name || short(addr, a, b))}</b>${meTag(addr)}`;
  if (t) return `<b class="y wn-noted">${esc(name || short(addr, a, b))}</b>`;
  return name ? `<b class="wn">${esc(name)}</b>` : `<span class="mono wn">${short(addr, a, b)}</span>`;
};
// 首买 / Dev 等地址的显示名（备注由 whoHtml 优先处理）：.ai / .bnb 域名 > 平台给的名字（推特名等）> 短地址
const domOf = (addr, ...alt) => (addr && NAMES[String(addr).toLowerCase()]) || alt.find(Boolean) || null;
// 点名字 = 打开「查域名 / 写备注」弹窗（没域名的地址也能备注）；捕获阶段拦下，不再触发卡片的打开 / 买入
const wnoteHtml = (addr, name, a = 4, b = 4) => addr ? `<span class="wnote" data-wnote="${esc(addr)}" title="${esc(addr)} · 点击写备注 / 查域名">${whoHtml(addr, name, a, b)}</span>` : '';
document.addEventListener('click', (e) => { const el = e.target.closest('[data-wnote]'); if (!el) return; e.preventDefault(); e.stopPropagation(); walletLookup(el.dataset.wnote); }, true);
// 地址 / 域名：点击在新标签打开 GMGN 的地址页（点行的其他地方仍打开盈亏抽屉）
const gmgnWho = (addr, name, a = 6, b = 4) => /^0x[0-9a-fA-F]{40}$/.test(addr || '') ? `<a class="gm-addr" data-gmgn href="https://gmgn.ai/bsc/address/${esc(addr)}" target="_blank" rel="noopener noreferrer" title="在 GMGN 查看 ${esc(addr)}">${whoHtml(addr, name, a, b)}</a>` : whoHtml(addr, name, a, b);
document.addEventListener('click', (e) => { if (e.target.closest('a[data-gmgn]')) e.stopPropagation(); }, true);   /* 只打开链接，不再触发行点击 */
// 搜索历史的头像打不开就隐藏（页面开了 CSP，不能再用 onerror="…" 这种内联写法）
document.addEventListener('error', (e) => { if (e.target?.classList?.contains('sh-av')) e.target.style.visibility = 'hidden'; }, true);
const traderHtml = (r, a = 6, b = 4) => !r.trader || !LIVE() ? short(r.trader, a, b)
  : gmgnWho(r.trader, nameOf(r), a, b);
// 头像：先在后台预加载，确认能打开才显示图片，否则一直用文字头像
// （列表每秒重画，直接放 <img> 的话加载失败的会一直闪空白方块）
const imgState = new Map();   // 原始地址 → 'ok' | 'bad' | 'loading'
const proxied = (src) => (/^https?:/i.test(src) ? '/api/img?u=' + encodeURIComponent(src) : src);
// 追踪栏 / 追踪页不走 scheduleRender：头像加载完后合并成一次重画，否则先画出来的卡片一直是文字占位
let imgTrkT = 0;
function imgRerenderTrk() { if (imgTrkT) return; imgTrkT = setTimeout(() => { imgTrkT = 0; try { if (typeof TP !== 'undefined' && TP.open && !document.querySelector('#trkPanel input.trk-ed')) renderTrkPanel(); if (S.view === 'track' && TRK.tab === 'feed' && !document.querySelector('#track input.trk-ed')) renderTrkFeed(); } catch { /* 还没初始化 */ } }, 300); }
const imgTries = new Map();
function probeImg(src) {
  imgState.set(src, 'loading');
  const i = new Image(); i.referrerPolicy = 'no-referrer';
  i.onload = () => { imgState.set(src, i.naturalWidth ? 'ok' : 'bad'); lastList = 0; scheduleRender(); imgRerenderTrk(); };
  // 失败的 3 秒后再试（前 40 次，约 2 分钟；之后 60 秒一次）。以前一次失败就一直是文字占位，要刷新页面
  i.onerror = () => { imgState.set(src, 'bad'); const n = (imgTries.get(src) || 0) + 1; imgTries.set(src, n); setTimeout(() => { imgState.delete(src); scheduleRender(); }, n <= 40 ? 3000 : 60_000); };
  i.src = proxied(src);
}
const logoImg = (t) => {
  const src = t.image || S.tokens.get(t.address)?.image; if (!src) return '';
  const st = imgState.get(src); if (!st) probeImg(src);
  return st === 'ok' ? `<img src="${esc(proxied(src))}" alt="" decoding="async" referrerpolicy="no-referrer">` : '';
};
// 代号还没读到（服务端占位「?」）：显示名字，名字也没有就显示短合约地址；头像用代号 / 名字首字，都没有就留空，不显示「?」
const symOk = (t) => !!t.symbol && t.symbol !== '?';
const symTxt = (t) => (symOk(t) ? t.symbol : t.name || short(t.address) || '?');
const logoHtml = (t, cls = '') => t.platform === 'four' ? `<div class="logo ${cls}">.ai${logoImg(t)}</div>` : `<div class="logo flap ${cls}">${esc(String(symOk(t) ? t.symbol : t.name || '').slice(0, 2).toUpperCase())}${logoImg(t)}</div>`;
// 底池数量：≥1 保留 2 位小数，<1 最多 4 位，去掉末尾的 0（666.5000177780021 → 666.5）
// 数量统一用紧凑写法：≥1000 用 K/M/B（两位小数），1～1000 两位小数，<1 最多 4 位；完整数字放在 title 里
const amt = (v) => { v = Number(v) || 0; if (!v) return '0'; if (Math.abs(v) >= 1000) return K(v, 2).replace(/\.?0+([KMB])$/, '$1'); if (v < 0.0001) return '<0.0001'; return (v >= 1 ? v.toFixed(2) : v.toFixed(4)).replace(/\.?0+$/, ''); };
const pool = (t) => `<span title="${esc(`${Number(t.raised) || 0} / ${Number(t.target) || 0} ${t.quote || 'BNB'}`)}">${amt(t.raised)}/${amt(t.target)}${t.quote && t.quote !== 'BNB' ? ' ' + esc(t.quote) : ''}</span>`;
// 买 / 卖总费率（代币税 + 平台费 + 防狙击税），≥5% 标红；不知道显示「—」
const pctTxt = (v) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(v >= 10 ? 0 : 1) + '%');
const taxHi = (t) => (t.buyFeePct || 0) >= 5 || (t.sellFeePct || 0) >= 5;
// 税收接收地址就是发币人自己（Gang V3 recipient / Flap 营销受益人 = 创建者）：外盘收的税（扣掉平台和分红部分）直接打给发币人
const creatorTaxTip = (t) => `税收接收地址就是发币人自己${t.taxTo || t.flapTax?.beneficiary ? '（' + (t.taxTo || t.flapTax.beneficiary) + '）' : ''}：收的税扣掉平台和分红部分后，直接打给发币人`;
const creatorTaxChip = (t, cls = 'tag') => (t.taxToCreator ? `<i class="${cls} tax2c" title="${esc(creatorTaxTip(t))}">税归发币人</i>` : '');
const taxChip = (t, cls = 'tag') => `<i class="${cls} tax ${taxHi(t) ? 'hi' : ''}" title="买入 / 卖出总费率（代币税 + 平台费${t.antiSniperPct ? ' + 防狙击税 ' + t.antiSniperPct.toFixed(1) + '%' : ''}）">税 ${pctTxt(t.buyFeePct)}/${pctTxt(t.sellFeePct)}${t.antiSniperPct >= 0.1 ? ' 🛡' : ''}</i>`;
// Gang V2 分红：税币（taxed）内盘 + 外盘买卖 1% 税，一半按持仓分给持有 ≥1 万枚的地址（报价币发放）；普通币内盘 1% 平台费、毕业后 0 税、不分红。还不知道（老盘 / 其他平台）不显示
const divTip = (t) => {
  const d = t.gangDiv; if (!d) return ''; if (d.flap) return flapTaxTip(t); const st = d.stats || {}, q = st.quoteSymbol || t.quote || '报价币', pct = ((d.taxBps || 100) / 100).toFixed(d.taxBps % 100 ? 1 : 0);
  if (!d.taxed) return `不分红（普通币 LaunchToken）\n内盘买卖 1% 平台费：80% 回购销毁 GANG / 20% 进平台金库\n毕业后 0 税，持有人没有分红`;
  const n = (v) => amt(Number(v) || 0), u = (v) => (Number(v) > 0 ? `（${usd(Number(v))}）` : '');
  return `分红币（税币 TaxLaunchToken）\n内盘 + 外盘买卖各 ${pct}% 税：50% 分给持有人，另 50% 中 80% 回购销毁 GANG / 20% 进平台金库\n分红币种：${q}；持仓超过 1 万枚才参与，按持仓比例分（keeper 定期结算，到分红金库领取）`
    + (d.vault ? `\n分红金库：${d.vault}` : '')
    + (d.stats ? `\n累计已分 ${n(st.total)} ${q}${u(st.totalUsd)} · 近 7 天 ${n(st.d7)} ${q}${u(st.d7Usd)}\n每持 1 万枚累计 ${n(st.per10k)} ${q} · 参与分红持仓 ${K(Number(st.totalShares) || 0)} 枚${Number(st.apr) > 0 ? `\n年化估算 ${(st.apr * 100).toFixed(0)}%（近 7 天折算，不代表未来）` : ''}` : '');
};
// Gang V3（GangLaunchpad）：曲线和 V2 一样，毕业后外盘收买卖税；默认只报价
const v3Tip = (t) => { const v = t.gangV3; return v ? `Gang V3 税收币：内盘只收 1% 手续费；毕业后外盘买税 ${v.buyTaxBps / 100}% / 卖税 ${v.sellTaxBps / 100}%，其中分红 ${v.dividendBps / 100}%${v.trade ? '' : '。真实买卖未开启（只报价）'}` : 'Gang V3'; };
const gangKind = (t) => (t.gangTrack === 'v3' ? `<i class="tag gangy v3" title="${esc(v3Tip(t))}">V3${t.gangV3 && !t.gangV3.trade ? ' · 只报价' : ''}</i>` : t.gangTrack === 'v3fair' ? (t.stage === 'dex' ? '<i class="tag gangy v3" title="Gang 打新币：1 万份已认购满，已在 PancakeSwap V2 开池；买卖走外盘">打新 · 已发射</i>' : `<i class="tag gangy v3" title="Gang 打新：固定价认购，满 1 万份在 PancakeSwap 开池；认购中不能在这里买卖">V3 打新${t.gangFair ? ` · 还差 ≥${t.gangFair.minWalletsLeft} 地址` : ''}</i>`) : t.gangTrack === 'v2' && t.stage === 'curve' ? '<i class="tag gangy">Gang V2</i>' : '<i class="tag gangy">Gang 内盘</i>');
// 战壕卡片：Gang 盘标出是哪一版（老盘 V1 / V2 / V3 / V3 打新），角标也写成 G1 / G2 / G3
// 打新币（认购中）：还差多少个地址才能打满（剩余份数 ÷ 每地址上限，向上取整；和 gang.fun 页面同一算法）
const fairLeft = (t) => (t.gangFair && !t.gangFair.launched ? ` · 还差 ≥${t.gangFair.minWalletsLeft} 地址` : '');
const gangVer = (t) => ({ v3: 'V3', v3fair: 'V3 打新', v2: 'V2' }[t.gangTrack] || 'V1');
const gangVerChip = (t) => (t.platform !== 'gang' ? '' : `<i class="chip gv ${/^v3/.test(t.gangTrack || '') ? 'v3' : ''}" title="${esc(t.gangTrack === 'v3' ? v3Tip(t) : 'gang.fun ' + gangVer(t))}">Gang ${gangVer(t)}</i>`);
const gangV = (t) => (/^v3/.test(t.gangTrack || '') ? 'v3' : t.gangTrack === 'v2' ? 'v2' : 'v1');   // 战壕筛选用：V3（含打新）/ V2 / V1 老盘
const gangBadge = (t) => (/^v3/.test(t.gangTrack || '') ? 'G3' : t.gangTrack === 'v2' ? 'G2' : 'G1');
// Flap 税币（门槛盘）：买 / 卖税、税收怎么分（营销给受益人 / 分红 / 回流 / 销毁）、分红币、累计
const bpsTxt = (b) => `${+(b / 100).toFixed(2)}%`;
const flapSplit = (x) => [['营销', x.mktBps], ['分红', x.divBps], ['回流', x.lpBps], ['销毁', x.deflBps]].filter(([, b]) => b > 0).map(([n, b]) => `${n} ${bpsTxt(b)}`).join(' · ') || '—';
const flapTaxTip = (t) => {
  const x = t.flapTax; if (!x) return '';
  return `Flap 税币：买税 ${bpsTxt(x.buyBps)} / 卖税 ${bpsTxt(x.sellBps)}（内盘和外盘都收）\n税收分配：${flapSplit(x)}`
    + (x.beneficiary ? `\n受益人（营销收款）：${x.beneficiary}${x.sentMkt > 0 ? `，累计 ${amt(x.sentMkt)} BNB` : ''}` : '')
    + (x.divBps > 0 ? `\n分红币种：${x.divSym || '?'}${x.divMin ? `；持有 ≥ ${K(x.divMin)} 枚参与` : ''}${x.sentDiv > 0 ? `；累计已分 ${amt(x.sentDiv)} ${x.divSym === 'BNB' ? 'BNB' : ''}` : ''}` : '\n不分红')
    + `\n数据：链上 taxProcessor（${x.processor}）`;
};
const flapTaxStat = (t) => {
  const x = t.flapTax; if (!x) return '';
  const ben = x.beneficiary ? `<a href="https://bscscan.com/address/${esc(x.beneficiary)}" target="_blank" rel="noopener" title="${esc(x.beneficiary)}">${whoHtml(x.beneficiary, x.beneficiaryName || NAMES[x.beneficiary])}</a>` : '<span class="muted">无</span>';
  return `<div title="${esc(flapTaxTip(t))}"><span>税收分配</span><b style="font-family:var(--sans)">${esc(flapSplit(x))}</b></div>
      <div title="${esc(flapTaxTip(t))}"><span>分红</span><b class="${x.divBps > 0 ? 'g' : 'muted'}" style="font-family:var(--sans)">${x.divBps > 0 ? `${bpsTxt(x.divBps)} · ${esc(x.divSym || '?')}${x.sentDiv > 0 ? ' · 累计 ' + amt(x.sentDiv) : ''}` : '不分红'}</b></div>
      <div><span title="营销那部分税收打给这个地址">受益人</span><b style="font-family:var(--sans)">${ben}${creatorTaxChip(t)}</b></div>
      <div><span>Flap</span><b style="font-family:var(--sans)"><a href="https://flap.sh/bnb/${esc(t.address)}" target="_blank" rel="noopener">详情页</a> · <a href="https://flap.sh/bnb/${esc(t.address)}/taxinfo?lang=zh" target="_blank" rel="noopener">税务</a></b></div>`;
};
// Flap Agent ID 门槛盘（NFT-gated）：内盘时只有持有门槛 NFT 的钱包能买卖，迁移后后端不再给 nftGate，标签自动消失
const nftTip = (t) => `内盘门槛：钱包要持有 ${t.nftGate.name || 'NFT'}（${t.nftGate.nft}）里至少 1 个才能在内盘买卖，每个地址最多买总量 2%；迁移到外盘后谁都能买。没有这个 NFT 的钱包下单会自动跳过`;
const nftChip = (t, cls = 'tag') => (t.nftGate ? `<i class="${cls} nftg" title="${esc(nftTip(t))}">🔒 ${t.nftGate.known ? 'Agent ID' : 'NFT'} 门槛</i>` : '');
const NFTW = {};   // 门槛 NFT → 各钱包持有数（/api/token 返回；WebSocket 推的详情不带，按 NFT 集合记住）
const nftPanel = (t) => {
  const g = t.nftGate; if (!g) return '';
  const ws = g.wallets || NFTW[g.nft] || [], ok = ws.filter((w) => w.n > 0);
  const who = ws.length ? ws.map((w) => `<span class="${w.n > 0 ? 'g' : w.n === 0 ? 'r' : 'muted'}" title="${esc(w.address)}">${esc(w.label)} ${w.n > 0 ? `✓ 持有 ${w.n}` : w.n === 0 ? '✗ 没有（下单会跳过）' : '读取失败'}</span>`).join(' · ') : '<span class="muted">读取钱包中…</span>';
  return `<div class="nftg-box" title="${esc(nftTip(t))}">${g.image ? `<img src="${esc(proxied(g.image))}" alt="" loading="lazy"/>` : '<div class="nftg-ph">NFT</div>'}
    <div class="nftg-m"><b>🔒 ${esc(g.known ? 'Binance Agent ID 门槛' : 'NFT 门槛')}</b> <span class="muted">${esc(g.name)}${g.symbol ? ' (' + esc(g.symbol) + ')' : ''}</span>
      <div class="nftg-l"><span class="mono">${short(g.nft, 6, 4)}</span> <span class="copy" data-copy="${esc(g.nft)}">⧉</span> <a href="https://bscscan.com/token/${esc(g.nft)}" target="_blank" rel="noopener">BscScan</a> <a href="https://opensea.io/assets/bsc/${esc(g.nft)}" target="_blank" rel="noopener">OpenSea</a> <a href="https://element.market/assets/bsc/${esc(g.nft)}" target="_blank" rel="noopener">Element</a> <span class="muted">· 每个地址最多 ${g.capPct || 2}%</span></div>
      <div class="nftg-w">${who}${ws.length && !ok.length ? ' <b class="r">· 没有钱包能买</b>' : ''}</div></div></div>`;
};
// dev 吃税（税收接收地址就是发币人自己）：分红标签变红并加「!」
// gang.fun 回购 / 押金（2026-10-29）：回购 = V3 税币的税收接收人是 dev 的回购合约；押金 = GangBond 押金承诺。数据来自链上，照样过 esc
const bbTip = (t) => { const b = t.gangBuyback; return `gang.fun 回购模式：税收接收人是 dev 的回购合约 ${b.splitter}\n外盘税里给 dev 的那份，${bpsTxt(b.bps)} 在外盘买回后打进 0xdead 销毁，其余给 dev\n比例 dev 随时可以调高，调低要提前 3 天公示` + (b.cut ? `\n⚠ dev 已申请调低到 ${bpsTxt(b.cut.bps)}，${fullTime(b.cut.at)} 起可生效` : ''); };
const bbChip = (t, cls = 'tag') => (t.gangBuyback ? `<i class="${cls} bb" title="${esc(bbTip(t))}">回购 ${esc(bpsTxt(t.gangBuyback.bps))}</i>` : '');
const bondNum = (v) => (v >= 1e3 ? K(v).replace(/\.?0+(?=[KMB])/, '') : String(+Number(v).toPrecision(3)));   // 1.18M / 20M / 0.5，不用逗号长数字
const BOND_ST = { 1: '进行中', 2: '已罚没（违约，押金在外盘回购销毁）', 3: '守约到期，已退回 dev', 4: '一直没上外盘，已退回 dev' };
const bondTip = (t) => {
  const b = t.gangBond, q = t.quote || 'BNB';
  return `gang.fun 押金承诺（GangBond）：${BOND_ST[b.state] || '状态 ' + b.state}${b.state === 1 && b.violated ? '\n⚠ 现在 dev 持仓低于承诺，已经可以被举报罚没' : ''}\n押金 ${bondNum(b.amount)} ${q}\ndev 承诺创建地址至少持有 ${bondNum(b.hold)} 枚（${bondNum((b.hold / 1e9) * 100)}%）`
    + `\n持有期：${b.deadline ? '到 ' + fullTime(b.deadline) : `上外盘后开始计时，${Math.round(b.duration / 86400)} 天`}\n违约任何人可举报：1% 给举报人，其余在外盘分块回购销毁；守约到期押金退回${b.burnLeft > 0 ? `\n还剩 ${bondNum(b.burnLeft)} ${q} 等待回购销毁` : ''}\n押于 ${fullTime(b.postedAt)}`;
};
const bondChip = (t, cls = 'tag') => {
  const b = t.gangBond; if (!b) return '';
  const bad = b.state === 2 || (b.state === 1 && b.violated), off = b.state === 3 || b.state === 4;
  const txt = b.state === 2 ? '押金已罚没' : off ? '押金已退' : `押金 ${bondNum(b.amount)} ${t.quote || 'BNB'}${b.violated ? ' !' : ''}`;
  return `<i class="${cls} bond${bad ? ' bad' : off ? ' off' : ''}" title="${esc(bondTip(t))}">${esc(txt)}</i>`;
};
const divChip = (t, cls = 'tag') => (t.taxToCreator ? `<i class="${cls} div dev" title="${esc('⚠ ' + creatorTaxTip(t) + (t.gangDiv ? '\n\n' + divTip(t) : ''))}">${t.gangDiv?.taxed === false ? '不分红' : '分红'} !</i>`
  : t.gangDiv?.taxed == null ? '' : `<i class="${cls} div ${t.gangDiv.taxed ? 'on' : 'off'}" title="${esc(divTip(t))}">${t.gangDiv.taxed ? '分红' : '不分红'}</i>`);
// 买入再卖出的预计损耗（不含价格变动）：买入费 + 卖出费（按买入后剩下的部分）+ 约 0.00017 BNB gas
const roundTrip = (t, amount) => { const b = t.buyFeePct, s = t.sellFeePct; if (b == null || s == null || !(amount > 0)) return null; const left = amount * (1 - b / 100); const cost = amount * b / 100 + left * s / 100 + 0.00017; return { cost, pct: (cost / amount) * 100 }; };
// 涨幅：绿涨红跌，算不出来显示「—」
// 涨幅的说明：基准价和时间
const chgTip = (t, k) => { const b = t.chg?.base?.[k]; const what = { launch: '现价相对第一笔成交价', m5: '现价相对 5 分钟前的价格', h1: '现价相对 1 小时前的价格', h24: '现价相对 24 小时前的价格' }[k]; return b ? `${what}（基准 ${sub(b.p)} ${t.quote || 'BNB'}，${new Date(b.t * 1000).toLocaleString('zh-CN', { hour12: false })}）` : `${what}：币龄不够或历史数据不足`; };
const chgTxt = (v) => (v == null || !isFinite(v) ? '<span class="muted">—</span>' : `<span class="${v >= 0 ? 'g' : 'r'}">${v >= 0 ? '+' : ''}${Math.abs(v) >= 1000 ? K(v, 1) : v.toFixed(1)}%</span>`);
const tagsHtml = (t) => {
  const st = t.stage === 'curve' ? '<i class="tag b">内盘</i>' : t.stage === 'dex' ? '<i class="tag g">已迁移</i>' : '<i class="tag gray">已撤池</i>';
  const kind = t.platform === 'four' ? (t.agentExclusive !== false ? '<i class="tag r">Agent 专属</i>' : '<i class="tag r">Four 内盘</i>')
    : t.platform === 'gang' ? gangKind(t)
    : t.platform === 'genius' || t.launchPlat === 'genius' ? `<i class="tag p">genius.fun${t.stage === 'dex' ? ' · Infinity 池' : ' 内盘'}</i>`
    : t.launchPlat === 'four' ? '<i class="tag r">Four 普通盘</i>'
    : t.source === 'dex' ? '<i class="tag p">外盘代币</i>'
    : t.source === 'flap-plain' || t.nftGate?.plain || /普通盘/.test(t.preset || '') ? '<i class="tag p">Flap 普通盘</i>'
    : (t.source && t.source !== 'agent-curve' ? '<i class="tag p">Flap 内盘</i>' : '<i class="tag p">Agent 曲线</i>');
  return st + kind + `<i class="tag y">${esc(t.quote)} 池</i>` + nftChip(t) + taxChip(t) + divChip(t) + bbChip(t) + bondChip(t) + (t.chg?.h1 != null ? `<i class="tag chg" title="1 小时涨幅">1h ${chgTxt(t.chg.h1)}</i>` : '');
};
const wallet = (id) => S.wallets.find((w) => w.id === id) || {};
const eligible = (w, t) => LIVE() ? { ok: true, why: '以合约为准' } : !t || t.platform !== 'four' ? { ok: true } : t.officialTest ? { ok: false, why: '未在白名单' } : !w.agentId ? { ok: false, why: '未绑定 Agent ID' } : !w.whitelisted ? { ok: false, why: '未在白名单' } : { ok: true };

/* ---------- 网络 ---------- */
const api = async (url, body) => {
  if (url === '/api/order' && body && !body.clientTs) body = { ...body, clientTs: Date.now() };   // 记录点击到服务器收到的耗时（data/latency.jsonl）
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const txt = await r.text(); let j;
  try { j = JSON.parse(txt); } catch { throw new Error(r.status === 404 ? '后端还没有这个接口：改了代码后还没重启，请重启 TMTN 再试' : `后端返回的不是 JSON（HTTP ${r.status}）`); }   // 没有这个路由时 express 回的是 HTML 404 页
  if (!r.ok) throw new Error(j.error || r.statusText); return j;
};
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => S.selected && ws.send(JSON.stringify({ type: 'sub', token: S.selected }));
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
}
function onMsg({ type, data, full }) {
  switch (type) {
    case 'tick':
      Object.assign(S, { mode: data.mode, baw: data.baw, block: data.block, bnbUsd: data.bnbUsd, gangMcap: data.gangMcap, net: data.net, wallets: data.wallets, usage: data.usage, positions: data.positions, claimable: data.claimable || [] });
      if (data.tokens) S.tokens = new Map(data.tokens.map((t) => [t.address, t]));   // 每 30 秒一次全量
      else { for (const t of data.tokDelta || []) S.tokens.set(t.address, t); for (const a of data.tokGone || []) S.tokens.delete(a); }   // 平时只推变了的币
      if (!S.selected) pickDefault();
      scheduleRender();
      break;
    case 'tokens': S.tokens = new Map(data.map((t) => [t.address, t])); scheduleRender(); break;   // 连上 WebSocket 时的全量
    case 'detail':
      if (data.address !== S.selected) break;
      if (full || !S.detail) { S.detail = data; autoInterval(); }
      else {
        const c = S.detail.candles;
        for (const k of data.candles) {
          let i = c.length - 1; while (i >= 0 && c[i].t > k.t) i--;
          if (i >= 0 && c[i].t === k.t) c[i] = k; else c.splice(i + 1, 0, k);
        }
        if (c.length > 4000) c.splice(0, c.length - 4000);
        S.detail = { ...data, candles: c };
      }
      drawChart(); renderHead();
      break;
    case 'launch':
      { const known = S.tokens.has(data.address); S.tokens.set(data.address, data); S.newTokens.add(data.address); setTimeout(() => S.newTokens.delete(data.address), 2000);
        if (!known && S.view === 'pulse') { lastPulse = 0; scheduleRender(); }   // 新币立刻上战壕，不等每秒一次的重画（平均省 0.5 秒）
        // 顶栏🔊的新币提示：在战壕页由各列自己的声音负责；其他页面只对当前平台页签的新币响
        if (!known && data.stage !== 'dex' && Date.now() - (data.createdAt || 0) < 120_000 && S.view !== 'pulse' && listWants(data) && !isBlocked(data)) newTokenChime(); }
      if (listWants(data) && !isBlocked(data)) { if (S.config?.notify && document.hidden && Notification?.permission === 'granted') new Notification(`新内盘 ${data.symbol}`); }
      break;
    case 'trackReload': { if (TRK.loaded || TP.open) loadTrack().then(renderTrkPanel); break; }
    case 'track': { if (!TRK.feed.some((x) => x.id === data.id)) { TRK.feed.unshift(data); if (TRK.feed.length > 500) TRK.feed.length = 500; if (trkPass(data)) trkTone(data); if (S.view === 'track') renderTrack(); renderTrkPanel(); } break; }
    case 'trackTargets': { TRK.targets = data.targets || []; TRK.groups = data.groups || TRK.groups; if (S.view === 'track') renderTrack(); renderTrkPanel(); scheduleRender(); renderBottom(); break; }
    case 'copyTasks': { TRK.tasks = data.tasks || []; TRK.paused = !!data.paused; renderTrkKill(); if (S.view === 'track') renderTrack(); break; }
    case 'snipeState': { SNP.v = data; renderSnpPill(); if (S.view === 'snipe') renderSnipe(); break; }
    case 'snipeLog': { SNP.log.unshift(data); if (SNP.log.length > 300) SNP.log.length = 300; snpNotice(data); if (S.view === 'snipe') renderSnipe(); break; }
    case 'copyLog': { TRK.log.unshift(data); if (TRK.log.length > 300) TRK.log.length = 300; if (S.view === 'track' && TRK.tab === 'copy') renderTrack(); break; }
    case 'wallets': { S.walletsInfo = data; renderAuth(); scheduleRender(); renderQB(); break; }
    case 'order': {
      if (['filled', 'failed', 'unknown'].includes(data.status)) window.dispatchEvent(new Event('order-done'));
      const i = S.orders.findIndex((o) => o.id === data.id); i >= 0 ? (S.orders[i] = data) : S.orders.unshift(data);
      if (data.side === 'transfer' || data.side === 'approve') { if (['orders', 'fills'].includes(S.bottomTab)) scheduleBottom(); break; }
      if (data.status === 'pending' && data.stage === 'broadcast' && data.pendingTx && data.symbol && data.pendingTx !== data._popTx) { data._popTx = data.pendingTx; topPop(data); }
      // 已提交但结果未知 / 最终未知：灰蓝色提示，不算失败
      if ((data.status === 'pending' && data.stage === 'unknown') || data.status === 'unknown') { if (S._unk?.[data.id] !== data.status) { (S._unk ||= {})[data.id] = data.status; $('#topPop')?.classList.remove('show'); note(`${data.symbol}：${data.reason}`, 'info'); } if (['orders', 'fills'].includes(S.bottomTab)) scheduleBottom(); break; }
      if (data.status !== 'pending' && data.symbol) { toast(data); topPop(data); if (data.status === 'filled') beep(data.side === 'buy' ? 1200 : 600, 0.08); }
      if (['orders', 'fills'].includes(S.bottomTab)) scheduleBottom();
      break;
    }
    case 'log': S.logs.unshift(data); if (S.logs.length > 300) S.logs.length = 300; if (S.bottomTab === 'logs') scheduleBottom(); break;
    case 'record': S.records.unshift(data); if (!$('#settingsModal').classList.contains('hidden')) renderRecords(); break;
    case 'config': S.config = data; renderControls(); break;
    case 'blocklist': S.blk = data; afterBlock(); break;
    case 'favorites': setFav(data); break;
    case 'holdings': setHoldSnap(data); break;
    case 'rules': S.rules = data || {}; scheduleRender(); if (S.view === 'hold') renderHold(); break;
    case 'settings': S.settings = data; renderControls(); break;
    case 'routeAlert': routeAlert(data); break;
  }
}

/* ---------- 声音 ---------- */
let actx;
// 新内盘提示音：两声上扬「叮咚」，1.5 秒内最多响一次；受顶栏 🔊 开关控制
let chimeAt = 0;
function newTokenChime() {
  if (!S.config?.sound || Date.now() - chimeAt < 1500) return; chimeAt = Date.now();
  try {
    actx ||= new AudioContext(); if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime;
    [[988, 0], [1480, 0.11]].forEach(([f, dt]) => { const o = actx.createOscillator(), g = actx.createGain(); o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.18);
      o.connect(g).connect(actx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.2); });
  } catch { /* 浏览器未授权音频 */ }
}
// 浏览器自动播放限制：第一次点击 / 按键时解锁音频
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { try { actx ||= new AudioContext(); if (actx.state === 'suspended') actx.resume(); } catch { /* ignore */ } }, { capture: true, passive: true }));
function beep(f, d) {
  if (!S.config?.sound) return;
  try { actx ||= new AudioContext(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.04; o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + d); } catch { /* 浏览器未授权音频 */ }
}

/* ---------- 渲染调度 ---------- */
let rq = false, bq = false, lastList = 0;
function scheduleRender() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; renderAll(); }); }
function scheduleBottom() { if (bq) return; bq = true; setTimeout(() => { bq = false; renderBottom(); }, 200); }
function renderAll() {
  renderTop();
  if (S.view === 'pulse' && Date.now() - lastPulse > 1000) { renderPulse(); lastPulse = Date.now(); }
  if (Date.now() - lastList > 900) { renderList(); lastList = Date.now(); }
  renderStatus(); renderHead(); renderRight();
  if (['pos', 'allpos', 'assets'].includes(S.bottomTab)) renderBottom();
}

function parseRoute() {
  if (/^#\/?pulse/.test(location.hash)) return { pulse: true, p: null, t: null, ca: null };
  if (/^#\/?hold/.test(location.hash)) return { hold: true, p: null, t: null, ca: null };
  if (/^#\/?track/.test(location.hash)) return { track: true, p: null, t: null, ca: null };
  if (/^#\/?snipe/.test(location.hash)) return { snipe: true, p: null, t: null, ca: null };
  const [p, t, ca] = location.hash.replace(/^#\/?/, '').split('/');
  return { p: ['four', 'flap', 'gang'].includes(p) ? p : null, t: ['curve', 'soon', 'dex', 'mine'].includes(t) ? t : null, ca: /^0x[0-9a-fA-F]{40}$/.test(ca || '') ? ca.toLowerCase() : null };
}
// 左侧面板等选择记到 localStorage，Cmd+R 后恢复；URL hash 优先
function savePrefs() { try { localStorage.setItem('ui', JSON.stringify({ platform: S.platform, listTab: S.listTab, chips: [...S.chips], view: S.view, bottomTab: S.bottomTab, interval: S.interval, metric: S.metric, amtMode: S.amtMode, selected: S.selected, amount: $('#amount')?.value || '' })); } catch { /* ignore */ } }
function loadPrefs() {
  let p = {}; try { p = JSON.parse(localStorage.getItem('ui') || '{}') || {}; } catch { /* ignore */ }
  if (['four', 'flap', 'gang'].includes(p.platform)) S.platform = p.platform;
  if (['curve', 'soon', 'dex', 'mine'].includes(p.listTab)) S.listTab = p.listTab;
  if (Array.isArray(p.chips)) S.chips = new Set(p.chips);
  if (p.bottomTab && !['trades', 'flow', 'callouts'].includes(p.bottomTab)) S.bottomTab = p.bottomTab; if (+p.interval) S.interval = +p.interval; if (p.metric) S.metric = p.metric;
  try { const iv = +localStorage.getItem('klineIv'); if (IVS.includes(iv)) { S.interval = iv; S.ivPinned = true; } } catch { /* ignore */ }   // 手动点过的周期：刷新/换币都沿用，不再自动挑
  if (['bnb', 'pct'].includes(p.amtMode)) S.amtMode = p.amtMode;
  return p;
}
function applyActive() {
  const on = (sel, key, v) => $$(sel + ' button').forEach((b) => b.classList.toggle('active', b.dataset[key] === String(v)));
  on('#platTabs', 'p', S.platform); on('#listTabs', 't', S.listTab); on('#bottomTabs', 'b', S.bottomTab); on('#intervals', 'i', S.interval); on('#metric', 'm', S.metric); on('#amtMode', 'a', S.amtMode);
  $$('#chips button').forEach((b) => b.classList.toggle('active', S.chips.has(b.dataset.c)));
}
window.addEventListener('beforeunload', savePrefs); setInterval(savePrefs, 1500);
function syncUrl() {
  savePrefs();
  if (S.view === 'pulse') { if (location.hash !== '#/pulse') history.replaceState(null, '', '#/pulse'); return; }
  if (S.view === 'hold') { if (location.hash !== '#/hold') history.replaceState(null, '', '#/hold'); return; }
  if (S.view === 'track') { if (location.hash !== '#/track') history.replaceState(null, '', '#/track'); return; }
  if (S.view === 'snipe') { if (location.hash !== '#/snipe') history.replaceState(null, '', '#/snipe'); return; }
  const h = `#/${S.platform}/${S.listTab}${S.selected ? '/' + S.selected : ''}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}
function applyRoute() {
  const r = parseRoute();
  setView(r.pulse ? 'pulse' : r.hold ? 'hold' : r.track ? 'track' : r.snipe ? 'snipe' : 'trade', true);
  if (r.p) { S.platform = r.p; $$('#platTabs button').forEach((b) => b.classList.toggle('active', b.dataset.p === r.p)); }
  if (r.t) { S.listTab = r.t; $$('#listTabs button').forEach((b) => b.classList.toggle('active', b.dataset.t === r.t)); }
  return r;
}
window.addEventListener('hashchange', () => { const r = applyRoute(); lastList = 0; scheduleRender(); if (r.ca && r.ca !== S.selected?.toLowerCase()) select(r.ca); renderQB(); });
function pickDefault() {
  const rc = parseRoute().ca || (S.prefSel && S.tokens.has(S.prefSel) ? S.prefSel : null); S.prefSel = null; if (rc && !S.selected) { const hit = [...S.tokens.keys()].find((k) => k.toLowerCase() === rc); return select(hit || rc); }
  const list = filtered();
  const t = list.find((x) => x.symbol === 'Test4') || list[0];
  if (t) select(t.address);
}
// 兜底：hash 里有合约地址但没选中（初始化出错 / 列表还没到），每秒补选一次
setInterval(() => { const ca = parseRoute().ca; if (S.view !== 'pulse' && ca && S.selected?.toLowerCase() !== ca && S.tokens.size) { const hit = [...S.tokens.keys()].find((k) => k.toLowerCase() === ca); select(hit || ca); } else if (S.view !== 'pulse' && !S.selected && S.tokens.size) pickDefault(); }, 1000);

// 自动选周期：选中一个币后的前 15 秒（历史 K 线到齐前后），挑能画出 ≥60 根蜡烛的最大周期；稀疏的币就用 15s / 1m，不会全是细线。用户手动点过周期就不再自动改
const IVS = [1, 5, 15, 60, 300, 900, 3600];
function autoInterval() {
  if (S.ivPinned || !S.detail?.candles?.length || S.ivManual === S.selected || Date.now() > (S.ivAutoUntil || 0)) return;
  const cs = S.detail.candles; const count = (iv) => new Set(cs.map((c) => Math.floor(c.t / iv))).size;
  const iv = [...IVS].reverse().find((x) => count(x) >= 60) || IVS[0];
  if (iv !== S.interval) { S.interval = iv; $$('#intervals button').forEach((x) => x.classList.toggle('active', +x.dataset.i === iv)); resetView(); }
}
function select(addr) {
  const st0 = S.tokens.get(addr); if (st0?.platform) S.platform = st0.platform === 'four' || st0.platform === 'gang' ? st0.platform : 'flap';   // 平台跟着选中的币走（网址、设置、模拟白名单用）
  S.selected = addr; S.detail = null; S.hover = null; resetView(); syncUrl(); S.ivAutoUntil = Date.now() + 15_000;
  renderQB();   // 一键买卖浮窗和详情页同一帧出现（预设、位置都在本地，余额 / 持仓之后再补）
  ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'sub', token: addr }));
  api(`/api/token/${addr}`).then((d) => { if (d?.nftGate?.wallets) NFTW[d.nftGate.nft] = d.nftGate.wallets; if (S.selected === addr) { S.detail = d; autoInterval(); drawChart(); renderHead(); renderBottom(); } }).catch(() => {});
  lastList = 0; scheduleRender(); refreshQuote();
}

/* ---------- 顶栏 ---------- */
// 顶栏的币安钱包登录徽章 + 未登录时的锁定弹窗（只在实盘模式）
function renderAuth() {
  watchAuthDrop();
  const pill = $('#authPill'), modal = $('#loginModal'), a = S.baw?.auth;
  if (!LIVE() || !a) { pill.classList.add('hidden'); modal.classList.add('hidden'); return; }
  pill.classList.remove('hidden', 'bad', 'warn');
  if (MW()) {   // 多钱包：只要有一个「参与下单」的钱包已登录就能用；没登录的在顶栏黄色提示、下单时跳过
    const on = onWallets(), bad = on.filter((w) => w.auth !== 'ok');
    if (AUTH_OK()) {
      modal.classList.add('hidden');
      if (bad.length) { pill.classList.add('warn'); pill.querySelector('span').textContent = `${on.length - bad.length}/${on.length} 个钱包已登录 · ${bad.map((w) => w.label).join('、')} ${bad.some((w) => w.auth === 'offline') ? '连不上' : '未登录'}（下单跳过）`; pill.title = bad.map((w) => `${w.label}：在终端运行 ${w.signin}`).join('\n'); }
      else {
        const all = S.walletsInfo || [], off = all.filter((w) => !w.on);
        pill.querySelector('span').textContent = off.length ? `${on.length}/${all.length} 个钱包参与下单` : `${on.length} 个钱包已登录`;
        pill.title = all.map((w) => `${w.label} ${w.agentId || ''} ${w.address || ''}：${w.auth === 'ok' ? '已登录' : '未登录'}${w.on ? '，参与下单' : '，不参与下单'}`).join('\n');
      }
      return;
    }
    // 所有钱包都关了「参与下单」（不是没登录）：提示原因，已登录的钱包给一个「参与下单」按钮直接打开
    const noneOn = !on.length && (S.walletsInfo || []).some((w) => w.auth === 'ok');
    if (noneOn) {   // 有钱包已登录、只是都关了「参与下单」：不弹遮罩，只在顶栏黄色提示（点下单时也会提示）
      modal.classList.add('hidden'); pill.classList.add('warn');
      pill.querySelector('span').textContent = '没有钱包参与下单 · 点顶栏钱包菜单打开';
      pill.title = (S.walletsInfo || []).map((w) => `${w.label} ${w.agentId || ''}：${w.auth === 'ok' ? '已登录' : '未登录'}，不参与下单`).join('\n');
      return;
    }
    pill.classList.add('bad'); pill.querySelector('span').textContent = noneOn ? '没有钱包参与下单' : '币安钱包都未登录';
    modal.classList.remove('hidden'); loadNetCheck();
    const k = 'mw|' + (S.walletsInfo || []).map((w) => w.slot + w.auth + (w.on ? 1 : 0)).join(','); if (modal.dataset.k === k) return; modal.dataset.k = k;
    const cmd = (c) => `<div class="ag-cmd"><code>${esc(c)}</code><button class="ui-copy" data-agcopy="${esc(c)}">复制</button></div>`;
    $('#loginLead').innerHTML = noneOn ? '所有钱包的<b class="r">「参与下单」都关掉了</b>，所以没有钱包可以下单。点下面钱包旁边的「参与下单」打开（顶栏钱包菜单 / 下单区的钱包按钮也能开关）。' : '参与下单的币安钱包<b class="r">都没有登录</b>（或登录已过期）。至少登录一个才能使用。';
    $('#loginBody').innerHTML = `<div class="ag-ws">${(S.walletsInfo || []).map((w) => `<div class="ag-w ${w.auth === 'ok' ? 'ok' : 'bad'}"><b>${w.auth === 'ok' ? '✓' : '✗'} ${esc(w.label)}</b><span>${w.auth === 'ok' ? '已登录' + (w.address ? ' ' + short(w.address, 6, 4) : '') : w.auth === 'wrong_account' ? '登录的账号不对' : w.auth === 'offline' ? '后端没有运行' : '未登录'}${w.on ? '' : '（不参与下单）'}</span>${w.auth !== 'ok' ? wLoginBtn(w) + cmd(w.signin) : !w.on ? `<button class="ui-copy" data-mwonbtn="${w.slot}">参与下单</button>` : ''}</div>`).join('')}</div>`
      + '<li>在终端运行对应钱包的登录命令，打开终端里给出的链接，<b>用这个钱包自己的币安账号</b>在 App 中确认（核对配对码）</li><li>回到这里点「我已登录，重新检测」（每 10 秒也会自动检测）</li>';
    $('#loginNote').textContent = '';
    return;
  }
  if (a.state === 'ok') { pill.querySelector('span').textContent = '币安钱包已登录'; pill.title = `${a.agentId || ''} ${a.address || ''}`.trim(); modal.classList.add('hidden'); return; }
  pill.classList.add(a.state === 'checking' ? 'warn' : 'bad');
  pill.querySelector('span').textContent = a.state === 'checking' ? '检查登录中…' : '币安钱包未登录';
  pill.title = a.message || '';
  if (a.state === 'checking') return;   // 还在检查（或只失败了一次）时不挡住页面
  // 未登录：整页遮罩，关不掉；登录检测通过后自动消失。登录命令要在终端里自己运行，页面不代为执行
  modal.classList.remove('hidden'); loadNetCheck();
  const k = [a.state, a.message].join('|');
  if (modal.dataset.k === k) return; modal.dataset.k = k;
  const cmd = (c) => `<div class="ag-cmd"><code>${esc(c)}</code><button class="ui-copy" data-agcopy="${esc(c)}">复制</button></div>`;
  $('#loginLead').innerHTML = a.state === 'missing' ? '没有找到币安 Agentic Wallet 命令行工具（baw）。先安装，再登录。' : '检测到币安钱包<b class="r">未登录</b>（或登录已过期）。登录前所有功能都不能使用。';
  $('#loginBody').innerHTML = (a.state === 'missing' ? `<li>在终端安装 baw：${cmd('npm i -g @binance/agentic-wallet')}</li>` : '')
    + `<li>在终端运行：${cmd('baw auth signin')}</li><li>打开终端里给出的链接 / 二维码，在<b>币安 App</b> 中确认登录</li><li>回到这里点「我已登录，重新检测」（每 10 秒也会自动检测）</li>`;
  $('#loginNote').textContent = a.state === 'error' ? `检测出错：${a.message || ''}` : a.message || '';
}
async function startLogin() {
  const btn = $('#loginGo'); btn.disabled = true; btn.textContent = '正在获取登录二维码…';
  try { const r = await api('/api/auth/login', {}); if (r && S.baw) S.baw.login = r; if (r?.state === 'waiting' && r.urlForWeb) window.open(r.urlForWeb, '_blank', 'noopener'); }
  catch (e) { if (S.baw) S.baw.login = { state: 'failed', message: e.message }; }
  btn.disabled = false; btn.textContent = '登录'; $('#loginModal').dataset.k = ''; renderAuth();
}
$('#loginGo')?.addEventListener('click', startLogin);
// ---------- 按钱包登录（页面上点「登录」）+ 掉线提醒 ----------
// 只有未登录 / 账号不对的钱包显示「登录」（已登录的不显示，免得把正在用的会话换掉；后端没启动的也不显示）
const W_LOGIN_OK = (w) => w && w.reachable !== false && !['ok', 'checking', 'offline'].includes(w.auth);
function wLoginBtn(w, tag = 'button') { return W_LOGIN_OK(w) ? `<${tag} class="wl-btn" data-wlogin="${w.slot}" title="在页面上登录这个钱包（显示登录链接和配对码）">登录</${tag}>` : ''; }
const walletList = () => (MW() ? S.walletsInfo || [] : S.baw?.auth ? [{ slot: 1, label: '币安钱包', agentId: S.baw.auth.agentId, address: S.baw.auth.address, auth: S.baw.auth.state, login: S.baw.login }] : []);
// 记住每个钱包上次登录时的 .ai 名和地址，掉线后也能提示「用哪个账号扫」
function wRemember(w) { if (w.auth !== 'ok') return; try { const k = 'tmtnW' + w.slot, v = JSON.stringify({ agentId: w.agentId || null, address: w.address || null }); if (localStorage[k] !== v) localStorage[k] = v; } catch { /* ignore */ } }
function wExpect(w) { let m = {}; try { m = JSON.parse(localStorage['tmtnW' + w.slot] || '{}'); } catch { /* ignore */ } const address = w.expect || w.address || m.address || null; return { agentId: w.agentId || m.agentId || null, address }; }
const WL = { slot: null, id: null, poll: 0 };
async function openWalletLogin(slot) {
  const w = walletList().find((x) => x.slot === slot); if (!w) return;
  WL.slot = slot; WL.id = null; showWalletLoginDlg({ state: 'starting' });
  try { const r = await api(MW() ? '/api/wallets/login' : '/api/auth/login', MW() ? { slot } : {}); WL.id = r?.id || null; showWalletLoginDlg(r || { state: 'failed', message: '没有返回登录信息' }); }
  catch (e) { showWalletLoginDlg({ state: 'failed', message: e.message }); }
  clearInterval(WL.poll); WL.poll = setInterval(pollWalletLogin, 2000);
}
async function pollWalletLogin() {
  if (WL.slot == null) return clearInterval(WL.poll);
  try { if (MW()) S.walletsInfo = await api('/api/wallets'); else { const st = await api('/api/state'); S.baw = st.baw || S.baw; } } catch { return; }
  const w = walletList().find((x) => x.slot === WL.slot); const l = w?.login;
  if (w?.auth === 'ok' && (!l || l.state === 'done' || l.state === 'waiting')) { closeWalletLoginDlg(); note(`${w.agentId || w.label} 已登录`); renderAuth(); scheduleRender(); return; }
  if (l && (!WL.id || l.id === WL.id)) showWalletLoginDlg(l);
  renderAuth();
}
function closeWalletLoginDlg() { WL.slot = null; clearInterval(WL.poll); $('#wLoginDlg')?.remove(); }
function showWalletLoginDlg(l) {
  const w = walletList().find((x) => x.slot === WL.slot) || { slot: WL.slot, label: '钱包 ' + WL.slot }, ex = wExpect(w);
  let el = $('#wLoginDlg'); if (!el) { el = document.createElement('div'); el.id = 'wLoginDlg'; el.className = 'wl-back'; document.body.appendChild(el); }
  const left = l.expireAt ? Math.max(0, Math.round((l.expireAt - Date.now()) / 1000)) : null;
  const body = l.state === 'starting' ? '<div class="wl-msg">正在获取登录链接…</div>'
    : l.state === 'waiting' ? `<div class="wl-step">1. 打开登录链接（会显示二维码）：<a class="wl-link" href="${esc(l.urlForWeb || '#')}" target="_blank" rel="noopener">打开登录页面 ↗</a></div>
      <div class="wl-step">2. 用<b class="y">下面这个账号</b>的币安 App 扫码，核对配对码：<div class="wl-code mono">${esc(l.pairingCode || '—')}</div></div>
      <div class="wl-msg dim">等待在 App 里确认…${left != null ? `（还剩 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}）` : ''}　登录后会自动核对地址，扫错账号会被拒绝并自动登出。</div>`
    : l.state === 'wrong' ? `<div class="wl-msg r"><b>扫错账号，已拒绝并登出。</b><br>${esc(l.message || '')}</div>`
    : l.state === 'done' ? '<div class="wl-msg g">登录成功，正在刷新状态…</div>'
    : `<div class="wl-msg r">${{ expired: '已超时', cancelled: '已取消', failed: '登录失败' }[l.state] || l.state}${l.message ? '：' + esc(l.message) : ''}</div>`;
  el.innerHTML = `<div class="wl-box"><div class="wl-h"><b>登录 ${esc(w.label || '钱包 ' + w.slot)}</b><span class="spacer"></span><button class="wl-x" data-wlclose title="关闭">✕</button></div>
    <div class="wl-acct">请用这个账号扫码：<b class="y">${esc(ex.agentId || w.label)}</b> <span class="mono">${ex.address ? short(ex.address, 6, 4) : '（地址未知）'}</span></div>
    ${body}
    <div class="wl-acts">${l.state === 'waiting' ? '<button data-wlcancel>取消登录</button>' : ''}${['wrong', 'expired', 'cancelled', 'failed'].includes(l.state) ? `<button class="go" data-wlogin="${w.slot}">重新登录</button>` : ''}<button data-wlclose>关闭</button></div></div>`;
}
document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-wlogin]'); if (go) { e.preventDefault(); e.stopPropagation(); $('#wDropDlg')?.remove(); return openWalletLogin(Number(go.dataset.wlogin)); }
  if (e.target.closest('[data-wlclose]')) { e.preventDefault(); closeWalletLoginDlg(); $('#wDropDlg')?.remove(); return; }
  if (e.target.closest('[data-wlcancel]')) { e.preventDefault(); const slot = WL.slot; try { const r = await api(MW() ? '/api/wallets/login' : '/api/auth/login-cancel', MW() ? { slot, cancel: true } : {}); if (r) showWalletLoginDlg(r); } catch (err) { toast({ status: 'failed', symbol: '登录', reason: err.message }); } }
}, true);
// 掉线提醒：某个钱包从「已登录」变成未登录 / 账号不对 / 后端连不上，连续 2 次检测都这样才提醒（后端也是连续 2 次失败才改状态）
const WD = { prev: new Map(), bad: new Map(), shown: new Set() };
function watchAuthDrop() {
  const key = MW() ? S.walletsInfo : S.baw?.auth?.checkedAt; if (!key || key === WD.lastKey) return; WD.lastKey = key;   // 同一次状态更新只算一次（renderAuth 会被调用很多次）
  for (const w of walletList()) {
    wRemember(w);
    if (w.auth === 'ok') { WD.prev.set(w.slot, 'ok'); WD.bad.set(w.slot, 0); WD.shown.delete(w.slot); continue; }
    if (w.auth === 'checking') continue;
    if (WD.prev.get(w.slot) !== 'ok') continue;   // 只提醒「本来登录着、后来掉了」的
    const n = (WD.bad.get(w.slot) || 0) + 1; WD.bad.set(w.slot, n);
    if (n >= 2 && !WD.shown.has(w.slot)) { WD.shown.add(w.slot); WD.prev.set(w.slot, w.auth); alertWalletDrop(w); }
  }
}
function alertWalletDrop(w) {
  const ex = wExpect(w), why = w.auth === 'offline' ? '后端连不上' : w.auth === 'wrong_account' ? '登录的账号不对' : '登录已掉线';
  try { beep(880, 0.12); setTimeout(() => beep(660, 0.12), 180); setTimeout(() => beep(880, 0.12), 360); } catch { /* 没有声音 */ }
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(`TMTN：${w.label} ${why}`, { body: `${ex.agentId || ''} ${ex.address ? short(ex.address, 6, 4) : ''}　下单会跳过这个钱包，请重新登录`, tag: 'tmtn-wallet-' + w.slot }); } catch { /* 不支持 */ }
  let el = $('#wDropDlg'); if (!el) { el = document.createElement('div'); el.id = 'wDropDlg'; el.className = 'wl-back'; document.body.appendChild(el); }
  el.innerHTML = `<div class="wl-box"><div class="wl-h"><b class="r">⚠ ${esc(w.label)} ${why}</b><span class="spacer"></span><button class="wl-x" data-wlclose>✕</button></div>
    <div class="wl-acct">${esc(ex.agentId || w.label)} <span class="mono">${ex.address ? short(ex.address, 6, 4) : ''}</span>　${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</div>
    <div class="wl-msg">在重新登录前，下单会跳过这个钱包。${w.authMessage ? `<div class="dim">${esc(w.authMessage)}</div>` : ''}</div>
    <div class="wl-acts">${W_LOGIN_OK(w) ? `<button class="go" data-wlogin="${w.slot}">登录</button>` : '<span class="dim">后端没有运行，需要先启动它</span>'}<button data-wlclose>知道了</button></div></div>`;
}
// 浏览器通知要用户授权：第一次在页面上点击时顺便请求
document.addEventListener('pointerdown', function askNotify(e) { if (e.target.closest?.('[data-cacopy],[data-ctick],[data-copy],[data-xsearch],[data-agcopy],[data-dcopy],[data-trd-copy],.ui-copy')) return; document.removeEventListener('pointerdown', askNotify, true); try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ } }, true);
   // 页面上不再提供登录按钮（登录命令在终端运行）
$('#loginModal').addEventListener('click', async (e) => { const b = e.target.closest('[data-agcopy]'); if (!b) return; try { await copyOrThrow(b.dataset.agcopy); b.textContent = '已复制'; } catch { b.textContent = '请手动复制'; } setTimeout(() => (b.textContent = '复制'), 1500); });
// 登录遮罩下的网络检测：每个钱包一组（币安接口 / BSC 节点 / 本机代理），正常 / 高延迟 / 失败 + 毫秒。遮罩显示时最多 10 秒测一次，「重新检测」时马上测
const NETC = { at: 0 };
async function loadNetCheck(force = false) {
  if (NETC.busy || (!force && Date.now() - NETC.at < 10_000)) return renderNetCheck(); NETC.busy = true;   // 没到时间：用上次的结果重画（遮罩刚出现时） NETC.at = Date.now(); renderNetCheck();
  try {
    const r = await fetch('/api/netcheck'), j = /json/.test(r.headers.get('content-type') || '') ? await r.json().catch(() => null) : null;
    if (!r.ok || !Array.isArray(j)) throw new Error(j?.error || (r.ok || r.status === 404 ? '检测接口不可用（服务未重启？）' : `HTTP ${r.status}`));   // 旧后端没有这个接口时会返回首页 HTML
    NETC.data = j; NETC.err = null;
  } catch (e) { NETC.err = e.message; }
  NETC.busy = false; NETC.at = Date.now(); renderNetCheck();
}
function renderNetCheck() {
  if ($('#loginModal').classList.contains('hidden')) return;
  let el = $('#loginNet'); if (!el) { el = document.createElement('div'); el.id = 'loginNet'; el.style.cssText = 'text-align:left;margin:10px 0;font-size:12px'; $('#loginBody').after(el); }
  const st = { ok: ['g', '正常'], slow: ['y', '高延迟'], fail: ['r', '失败'] };
  el.innerHTML = `<div><b>网络检测</b> <span class="muted">${NETC.busy ? '检测中…' : NETC.at ? new Date(NETC.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span></div>
    ${NETC.err ? `<div class="r">检测失败：${esc(NETC.err)}</div>` : ''}
    ${(NETC.data || []).map((w) => `<div style="margin-top:4px"><b>${esc(w.label)}</b>${(w.items || []).map((i) => `<div class="kv"><span>${esc(i.name)}</span><b class="sans" title="${esc(i.reason || i.detail || '')}"><span class="${st[i.state]?.[0] || ''}">${st[i.state]?.[1] || esc(i.state)} · ${i.ms}ms${i.reason ? ' · ' + esc(i.reason) : ''}</span></b></div>`).join('')}</div>`).join('')}
    <div class="muted" style="margin-top:4px">如果网络检测失败，先修好网络 / 代理，不需要重新登录。</div>`;
}
// 「我已登录，重新检测」：点了马上有反馈（转圈 + 禁用），检测完逐个钱包显示结果；能用了就淡出遮罩并提示
$('#loginRecheck').addEventListener('click', async () => {
  const b = $('#loginRecheck'); if (b.disabled) return;
  b.disabled = true; b.classList.add('busy'); b.innerHTML = '<i class="spin"></i>检测中…'; loadNetCheck(true);
  try {
    const r = await api('/api/auth/check', {}); if (r && S.baw) S.baw.auth = r;
    if (LIVE()) { try { S.walletsInfo = await api('/api/wallets'); } catch { /* 单钱包 */ } }
  } catch (e) { $('#loginNote').textContent = '检测失败：' + e.message; }
  b.disabled = false; b.classList.remove('busy'); b.textContent = '我已登录，重新检测';
  const res = (MW() ? S.walletsInfo : [{ label: '币安钱包', auth: S.baw?.auth?.state, signin: 'baw auth signin' }]).map((w) => `${w.auth === 'ok' ? '✓' : '✗'} ${w.label}${w.auth === 'ok' ? ' 已登录' : w.auth === 'wrong_account' ? ' 登录的账号不对' : ' 未登录'}`).join('　');
  $('#loginModal').dataset.k = '';
  if (AUTH_OK()) { const m = $('#loginModal'); m.classList.add('fade-out'); setTimeout(() => { m.classList.remove('fade-out'); renderAuth(); }, 350); note('已登录，欢迎回来'); }
  else { renderAuth(); const n = $('#loginNote'); n.textContent = '检测结果：' + res; n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash'); }
});

// 顶栏状态胶囊：圆点和文字同色。ok 绿（显示毫秒）/ partial 黄（部分可用）/ retry 黄「重连中」/ down 红「断开」
function pillState(el, st, ms, tip) {
  const pill = el.closest('.pill'), dot = pill.querySelector('.dot'), cls = st === 'ok' ? 'g' : st === 'down' ? 'r' : 'y';
  el.className = `mono ${cls}`; dot.className = `dot ${cls}`;
  el.textContent = st === 'down' ? '断开' : st === 'retry' ? '重连中' : (ms != null ? ms + 'ms' : st === 'ok' ? '已连接' : '') + (st === 'partial' ? (ms != null ? ' · ' : '') + '部分' : '');
  if (tip != null) pill.title = tip;
}
// 右下角网络状态：圆点 + 稳定 / 一般 / 较差 + 链上 RPC 延迟 + 页面 FPS；悬停看后端、RPC、WSS 的分项
const NB = { ping: null, fps: 0, frames: 0, t0: performance.now() };
(function fpsLoop(t) { NB.frames++; if (t - NB.t0 >= 1000) { NB.fps = Math.round(NB.frames * 1000 / (t - NB.t0)); NB.frames = 0; NB.t0 = t; netBadge(); } requestAnimationFrame(fpsLoop); })(performance.now());
async function pingBackend() { const t = performance.now(); try { await fetch('/api/cache-status', { cache: 'no-store' }); NB.ping = Math.round(performance.now() - t); } catch { NB.ping = null; } }
setInterval(() => { if (!document.hidden) pingBackend(); }, 5000); pingBackend();
function netBadge() {
  const el = document.getElementById('netBadge'); if (!el) return;
  const rpc = S.net?.rpc, down = rpc == null || NB.ping == null;
  const ms = down ? null : Math.max(rpc, NB.ping);
  const [cls, txt] = down ? ['r', '断开'] : ms < 150 ? ['g', '稳定'] : ms < 400 ? ['y', '一般'] : ['r', '较差'];
  el.className = `pill mono net-badge ${cls}`;
  el.innerHTML = `<i class="dot ${cls}"></i><span>${txt}</span><b>${ms != null ? ms : '—'} MS</b><i class="nb-sep"></i><b>${NB.fps} FPS</b>`;
  el.title = `网络延迟（取最慢的一项）\n浏览器 → 后端：${NB.ping != null ? NB.ping + 'ms' : '超时'}\n后端 → 链上 RPC：${rpc != null ? rpc + 'ms' : '断开'}\n链上订阅 WSS：${S.net?.wss != null ? S.net.wss + 'ms' : '断开'}\n页面刷新：${NB.fps} FPS\n\n< 150ms 稳定 · < 400ms 一般 · 更慢为较差`;
}
function ago2(ts) { return !ts ? '—' : Math.round((Date.now() - ts) / 1000) + ' 秒前'; }   // 用函数声明：启动时可能在这行执行前就被调用
function wssTip() {
  const sh = S.net.shrine; if (!LIVE() || !sh) return '';
  const one = (k, n) => { const x = sh[k] || {}; return `${n}：${x.connected ? '已连接' : '断开'}${x.connected ? '' : x.retryAt ? `（${Math.max(0, Math.round((x.retryAt - Date.now()) / 1000))} 秒后重连）` : ''}，最后消息 ${ago2(x.lastEventAt)}${x.lastError && !x.connected ? `，错误：${x.lastError}` : ''}`; };
  const c = S.net.chainSubs || {}, sub = (k, n) => { const x = c[k] || {}; return `${n}：${x.connected ? '已连接' : '断开'}${x.wss ? `（${x.wss}）` : ''}，最后消息 ${ago2(x.lastLogAt)}`; };
  const shr = (k, n) => { const x = sh[k] || {}; return `${n}：${x.connected ? '已连接' : x.busy ? '被同 IP 其他程序占用（shrine 每个 IP 只允许一个订阅），5 分钟后再试' : '断开' + (x.lastError ? '：' + x.lastError : '')}`; };
  return `链上实时订阅（WebSocket）\n${sub('flap', 'Flap 成交 / 新市场')}\n${sub('four', 'Four 新盘 / 成交')}\n${sub('gang', 'Gang 新盘')}\n\n补充来源 shrine.trade（可选，断开不影响）\n${shr('launch', '新盘频道')}\n${shr('stream', '成交频道')}`;
}
function renderTop() {
  renderAuth();
  pillState($('#wssMs'), LIVE() ? S.net.wssState || (S.net.wss == null ? 'down' : 'ok') : (S.net.wss == null ? 'down' : 'ok'), S.net.wss, wssTip());
  pillState($('#rpcMs'), S.net.rpc == null ? 'down' : LIVE() && S.net.rpcNode?.fallback ? 'partial' : 'ok', S.net.rpc);
  netBadge();

  $('#wssName').textContent = LIVE() ? '链上订阅' : 'GetBlock';
  const rn = S.net.rpcNode;
  if (LIVE() && rn) {
    $('#rpcName').innerHTML = rn.fallback ? `<span class="y">备用: ${esc(rn.active)}</span>` : esc(rn.active);
    $('#rpcName').closest('.pill').title = `交易 / 查确认：${rn.active}${rn.fallback ? `（NodeReal 不可用，暂用备用节点${rn.primaryErr ? '：' + rn.primaryErr : ''}）` : ''}${(rn.keys || []).length > 1 ? '\nNodeReal key：' + rn.keys.map((k) => `${k.name}${k.cooling ? '（冷却中）' : ' 正常'}`).join('，') : ''}\n行情 / 持仓读取：${rn.read || '—'}${S.net.readError ? `（公共节点限流中：${S.net.readError}）` : ''}\n新盘订阅：Four ${rn.fourWs || '—'}，Gang ${rn.gangWs || '—'}\nFlap 曲线数据：${rn.curve || '—'}`;
  } else $('#rpcName').textContent = LIVE() ? '…' : '48 Club';
  const mb = $('#modeBadge');
  mb.textContent = REAL() ? '实盘 · 真实下单' : LIVE() ? '实盘行情 · 只报价' : '模拟盘';
  mb.classList.toggle('sim-badge', !LIVE());
  // 8788 本应是实盘：如果这里跑成了模拟盘（启动时漏了 MODE=live），顶上挂红色提示，避免把模拟盘当实盘
  document.body.classList.toggle('sim-warn', !LIVE() && location.port === '8788');
  mb.title = REAL() ? `手动买卖会通过 baw 真实上链，单笔上限 ${S.baw.maxTradeBnb || '不限'} BNB；自动买/自动卖只报价` : LIVE() ? '真实链上行情；下单只做报价/预演，不会上链' : '所有交易都在本地模拟，不连接真实钱包';
  $('#blockNo').textContent = '#' + S.block.toLocaleString('en-US');
  $('#bnbPx').textContent = 'BNB $' + S.bnbUsd.toFixed(2);
  $('#gangMc').textContent = 'GANG 市值 ' + (S.gangMcap > 0 ? usd(S.gangMcap) : '—');
  const w = wallet(S.activeWallet);
  // 多钱包：顶栏只放一个紧凑的胶囊 —— 叠在一起的小头像 + 主钱包 .ai 名（+N）+ 参与下单钱包的 BNB 合计 + 状态点；地址都放在下拉菜单里
  const sel = $('#walletSel'); sel.classList.toggle('mw', MW());
  if (MW()) {
    let box = $('#wsMw'); if (!box) { box = document.createElement('span'); box.id = 'wsMw'; box.className = 'ws-mw'; sel.insertBefore(box, sel.querySelector('.caret')); }
    const all = S.walletsInfo, on = onWallets(), ok = on.filter((x) => x.auth === 'ok'), first = on[0] || all[0], tot = on.reduce((a, x) => a + (x.bnb || 0), 0);
    box.innerHTML = `<span class="ws-stack">${(on.length ? on : [first]).map((x) => `<i class="ws-av" style="background:${wsColor(x.slot)}"></i>`).join('')}</span><b class="ws-name">${esc(first?.agentId || first?.label || '钱包')}</b>${on.length > 1 ? `<span class="ws-more">+${on.length - 1}</span>` : ''}<span class="mono ws-bal">${tot.toFixed(tot >= 10 ? 2 : 3)} BNB</span><i class="dot ${ok.length === on.length && on.length ? 'g' : ok.length ? 'y' : 'r'}"></i>`;
    sel.title = all.map((x) => `${x.label} ${x.agentId || ''}：${x.auth === 'ok' ? '已登录' : '未登录'}，${x.on ? '参与下单' : '不参与'}，${x.bnb != null ? x.bnb.toFixed(4) + ' BNB' : '—'}`).join('\n');
    const hm = $('#wsHandle'); if (hm) hm.style.display = 'none';   // 多钱包：名字在胶囊里
    return;
  }
  if (!w.id && LIVE()) { $('#wsLabel').textContent = 'baw'; $('#wsAddr').textContent = '未连接'; $('#wsBal').textContent = S.baw?.error ? '点此查看' : ''; }
  if (w.id) {
    $('#wsLabel').textContent = w.label; $('#wsAvatar').style.background = w.color;
    $('#wsAddr').textContent = short(w.address, 6, 4); $('#wsBal').textContent = w.bnb.toFixed(4) + ' BNB';
  }
  // 顶栏 .ai 手柄：用后端给的钱包 Agent ID（以前写死在 index.html 里），没有就不显示
  const hs = $('#wsHandle'); if (hs) { const me = (S.walletsInfo || []).find((x) => x.self) || (S.walletsInfo || [])[0]; const name = LIVE() ? (me?.agentId || S.baw?.auth?.agentId || '') : ''; hs.textContent = name; hs.style.display = name ? '' : 'none'; }
}

const wsColor = (slot) => ['linear-gradient(135deg,#f0b90b,#3fb950)', 'linear-gradient(135deg,#a855f7,#ec4899)', 'linear-gradient(135deg,#38bdf8,#6366f1)', 'linear-gradient(135deg,#f97316,#ef4444)'][(slot - 1) % 4];
function renderWalletMenu() {
  if (MW()) {   // 多钱包：每个钱包一行，「参与下单」开关 + 登录状态 + BNB；没登录的显示登录命令
    $('#walletMenu').innerHTML = S.walletsInfo.map((w) => `<div class="mw-row ${w.on ? '' : 'off'}">
      <i class="ws-av big" style="background:${wsColor(w.slot)}"></i>
      <div class="mw-id"><b>${esc(w.agentId || w.label)}</b><span class="mono muted">${esc(w.label)} · ${w.address ? short(w.address, 6, 4) : '—'}${w.address ? ` <button class="mw-copy" data-agcopy="${esc(w.address)}" title="复制地址">⧉</button>` : ''}</span></div>
      <span class="mono mw-bal">${w.bnb != null ? w.bnb.toFixed(4) : '—'}<small> BNB</small></span>
      <span class="mw-st ${w.auth === 'ok' ? 'g' : w.auth === 'checking' ? 'y' : 'r'}"><i class="dot ${w.auth === 'ok' ? 'g' : w.auth === 'checking' ? 'y' : 'r'}"></i>${w.auth === 'ok' ? '已登录' : w.auth === 'checking' ? '检查中' : w.auth === 'offline' ? '后端未启动' : w.auth === 'wrong_account' ? '账号不对' : '未登录'}</span>
      <label class="tgl mw-tg" title="参与下单"><input type="checkbox" data-mwon="${w.slot}" ${w.on ? 'checked' : ''}/><i></i></label></div>
      ${w.auth !== 'ok' && w.auth !== 'checking' ? `<div class="note mw-cmd">${wLoginBtn(w)}${w.auth === 'wrong_account' ? ' <span class="r">登录的账号不对</span>' : ''}<span class="dim"> 或终端：</span><code>${esc(w.signin)}</code> <button class="ui-copy" data-agcopy="${esc(w.signin)}">复制</button></div>` : ''}`).join('')
      + `<div class="mw-head-note">右侧开关 =「参与下单」</div>`
      + `<div class="note" style="padding:6px 8px">开了「参与下单」的钱包同时下单：买入每个钱包各花输入的 BNB；卖出每个钱包卖自己持仓的同样比例。没登录的钱包自动跳过。</div>`;
    return;
  }
  $('#walletMenu').innerHTML = S.wallets.map((w) => `<div class="wi" data-w="${w.id}"><i class="wav" style="background:${w.color}"></i><b>${w.label}</b><span class="mono muted">${short(w.address)}</span><span class="spacer"></span><span class="mono">${w.bnb.toFixed(4)}</span></div>`).join('')
    + (LIVE() ? `<div class="note" style="padding:6px 8px">币安 Agentic Wallet（baw）。${S.baw?.connected ? (REAL() ? `已连接，手动买卖会真实上链（单笔上限 ${S.baw.maxTradeBnb || '不限'} BNB）。` : '已连接，只读余额和报价。') : esc(S.baw?.error || '未连接')}</div>`
      : '<div class="note" style="padding:6px 8px">模拟钱包。私钥不存在于本程序中，所有成交仅在本地撮合。</div>');
}

/* ---------- 左栏 ---------- */
// 左栏不再分平台页签：三个平台合在一个列表里，平台在筛选窗口的「平台」里选（和战壕一样）。
// 左栏的 内盘中 / 即将发射 / 已迁移 和战壕的三列一一对应，用同一套筛选（tcMatch：平台、市值、持有人、进度、报价币、社交、税率、关键词），结果和战壕一致
const LIST_COL = { curve: 'new', soon: 'soon', dex: 'dex' };
function filtered() {
  const col = LIST_COL[S.listTab];
  const mine = new Set(S.positions.filter((p) => p.amount > 0).map((p) => p.token));
  return [...S.tokens.values()].filter((t) => {
    if (S.listTab !== 'mine' && isBlocked(t)) return false;   // 屏蔽的币不进列表（「我的」里持有的照常显示）
    if (S.listTab === 'curve' && t.stage === 'dex') return false;
    if (S.listTab === 'soon' && !(t.stage === 'curve' && t.progress > 0)) return false;
    if (S.listTab === 'dex' && t.stage !== 'dex') return false;
    if (S.listTab === 'mine' && !mine.has(t.address)) return false;
    if (S.chips.has('bnb') && t.quote !== 'BNB') return false;
    if (S.chips.has('other') && t.quote === 'BNB') return false;
    if (S.chips.has('traded') && !(t.buys + t.sells)) return false;
    if (S.chips.has('h1') && Date.now() - t.createdAt > 3600_000) return false;
    if (col) { try { if (!tcMatch(col, t)) return false; } catch { /* 战壕设置还没初始化 */ } }
    return true;
  }).sort((a, b) => (S.listTab === 'soon' ? (trSort() === 'mc' ? (b.mcapUsd || 0) - (a.mcapUsd || 0) : b.progress - a.progress) : b.createdAt - a.createdAt || (a.address < b.address ? -1 : 1)));
}
// 新币提示音 / 通知：按「新创建」列的筛选（含平台）判断是不是左栏会显示的币
function listWants(t) { try { return tcMatch('new', t); } catch { return true; } }
function trSort() { try { return TR.cols.soon.sort; } catch { return 'pct'; } }
// 左栏漏斗：打开对应战壕列的筛选窗口；有条件生效时高亮
function renderListFunnel() {
  const b = $('#listFunnel'); if (!b) return; const k = LIST_COL[S.listTab];
  let on = false, tip = '「我的」不筛选';
  try { if (k) { on = tcActive(k) || !!TR.cols[k].q; tip = `${tcFilterSummary(k)}${TR.cols[k].q ? '，关键词 ' + TR.cols[k].q : ''}（和战壕「${TCOLS[k]}」列同一套，任一边改了两边都变）`; } } catch { /* ignore */ }
  b.classList.toggle('act', on); b.disabled = !k; b.title = tip;
}

function renderList() {
  // 和战壕同一套卡片（tcCard）：固定高度、按地址局部更新，不整列重画；点卡片在当前页打开详情
  const list = filtered().slice(0, 80); renderListFunnel();
  const body = $('#tokenList'); body.classList.add('tl-trench');
  if (!list.length) { body.innerHTML = '<div class="empty">暂无代币</div>'; }
  else {
    body.querySelector(':scope > .empty')?.remove();
    let anchor = null, anchorTop = 0;
    if (body.scrollTop > 4) for (const c of body.children) { if (c.dataset.pa && c.offsetTop + c.offsetHeight > body.scrollTop) { anchor = c.dataset.pa; anchorTop = c.offsetTop - body.scrollTop; break; } }
    const old = new Map([...body.children].filter((x) => x.dataset.pa).map((x) => [x.dataset.pa, x]));
    let prev = null;
    for (const t of list) {
      const html = tlCard(t);
      let el = old.get(t.address);
      if (!el) { const d = document.createElement('div'); d.innerHTML = html; el = d.firstElementChild; el._h = html; }
      else if (el._h !== html) { const d = document.createElement('div'); d.innerHTML = html; patchCard(el, d.firstElementChild); el._h = html; }
      old.delete(t.address);
      const want = prev ? prev.nextSibling : body.firstChild;
      if (el !== want) body.insertBefore(el, want);
      prev = el;
    }
    for (const el of old.values()) el.remove();
    if (anchor) { const x = body.querySelector(`:scope > [data-pa="${anchor}"]`); if (x) body.scrollTop = x.offsetTop - anchorTop; }
  }
  $('#agentCnt').textContent = [...S.tokens.values()].filter((t) => t.stage === 'curve').length;   // 三个平台合计的内盘数
}

function renderStatus() {
  const w = wallet(S.activeWallet); const t = S.tokens.get(S.selected);
  const el = eligible(w, t);
  const nc = { flap: 0, four: 0, gang: 0 }; for (const x of S.tokens.values()) if (x.stage === 'curve') nc[platOf(x)]++;
  const n = nc.flap + nc.four + nc.gang, tp = t?.platform || S.platform;
  const ago = (Date.now() - (S.net.detectAt || 0)) / 1000;
  $('#agentStatus').innerHTML = `
    <div class="l1"><span class="muted" title="Flap ${nc.flap} · Four ${nc.four} · Gang ${nc.gang}（内盘中）">全部 <b class="mono" style="color:var(--text)">${n}</b> · Flap ${nc.flap} · Four ${nc.four} · Gang ${nc.gang}</span>
      ${LIVE() ? `<span class="muted">${S.baw?.connected ? '<b class="g">baw 已连接</b>' : '<b class="r">baw 未连接</b>'} · 白名单以合约为准</span>` : tp === 'four' ? `<b class="${w.agentId ? 'g' : 'r'}">Agent ID ${w.agentId ? '✓' : '✗'}</b><b class="${el.ok ? 'g' : 'r'}">${el.ok ? '已在白名单' : el.why}</b>` : '<b class="g">无需白名单</b>'}</div>
    ${LIVE() ? `<div class="l2" style="color:var(--muted)">Reader ${S.net.curve?.connected ? `<span class="g">✓ ${S.net.curve.total} 个市场</span>` : `<span class="r">✗ ${esc(S.net.curve?.lastError || '连接中')}</span>`} · Four ${S.net.four?.connected ? `<span class="g">✓ ${S.net.four.total}</span>` : `<span class="r">${S.net.four?.lastError ? '✗' : '回补中…'}</span>`} · Gang ${S.net.gang?.connected ? `<span class="g">✓ ${S.net.gang.total}</span>` : `<span class="r">${S.net.gang?.lastError ? '✗' : '连接中…'}</span>`} · shrine ${S.net.shrine?.launch?.connected ? '<span class="g">✓</span>' : '<span class="r">✗</span>'} · baw ${S.baw?.connected ? '<span class="g">✓</span>' : '<span class="r">✗</span>'}</div>` : ''}
    <div class="l2"><span class="spin">⟳</span> 链上检测中 · ${ago < 5 ? '刚刚' : Math.floor(ago) + 's 前'} · ${S.net.detect || 0}ms</div>`;
}

/* ---------- 中栏：头部 ---------- */
// 交易页顶部：我的余额 / 盈亏（与战壕卡片同一套数据：价格 × 数量 × 计价币 USD）
// 持仓行（和「持仓」页同一份数据：市值、成本都折成 BNB，报价币盘按汇率换算）。交易页每 15 秒最多拉一次
// 持仓快照：服务器每 5 秒推一次（下单后马上推），本地也存一份，刷新页面后立刻有数，不用等接口
// 已清仓的币：没价格（price 0）时后端给的余额 / 盈亏是 null，页面显示「—」。数量是 0 余额就是 0，盈亏 = 已卖出 − 成本（已实现）
function fixClosed(d) {
  if (!d) return d;
  const fix = (r) => { if (r.amount > 0 || r.unsynced || (r.valueBnb != null && r.pnlUsd != null)) return 0; const old = r.pnlUsd || 0;
    r.valueBnb = 0; r.valueUsd = 0; r.pnlBnb = (r.soldBnb || 0) - (r.costBnb || 0); r.pnlUsd = (r.soldUsd || 0) - (r.costUsd || 0);
    r.pnlPct = r.costUsd > 0 ? (r.pnlUsd / r.costUsd) * 100 : null; return r.pnlUsd - old; };
  const add = (T, dv) => { if (T && dv) T.pnlUsd = (T.pnlUsd || 0) + dv; };
  // 数量是 0、却只有买入没有卖出：多半是钱包余额（baw）还没收录这个新币，不是清仓了。这一行的成本不计入合并行和合计（否则成本算两个钱包、数量只算一个），盈亏不显示
  const KS = ['costUsd', 'costBnb', 'pnlUsd', 'pnlBnb'], sub = (T, r) => { if (T) for (const f of KS) if (r[f] != null) T[f] = (T[f] || 0) - r[f]; };
  for (const w of d.wallets?.length ? d.wallets : [{ rows: d.rows || [] }]) for (const r of w.rows || []) {   // 单钱包时直接处理 d.rows
    if (r.amount > 0 || r.soldBnb > 0 || (r.trades || []).some((x) => x.side === 'sell') || !(r.costBnb > 0) || r.unsynced) continue;   // 有卖出记录（哪怕记成 0 BNB，如卖成 WBNB）就是真清仓
    const m = (d.rows || []).find((x) => String(x.token).toLowerCase() === String(r.token).toLowerCase());
    if (m && m !== r) { sub(m, r); m.pnlPct = m.costUsd > 0 && m.pnlUsd != null ? (m.pnlUsd / m.costUsd) * 100 : null; m.warn = m.warn || `${w.label || '有个钱包'}的余额还没同步，成本暂不计入`; }
    sub(w.totals, r); sub(d.totals, r);
    Object.assign(r, { unsynced: true, pnlUsd: null, pnlBnb: null, pnlPct: null, warn: '只有买入没有卖出、余额却是 0：可能是钱包余额还没同步这个币，也可能卖出 / 转出没记到钱包历史里，盈亏暂不显示' });
  }
  let dt = 0; for (const w of d.wallets || []) { let dw = 0; for (const r of w.rows || []) dw += fix(r); add(w.totals, dw); dt += dw; }
  for (const r of d.rows || []) { const dv = fix(r); if (!d.wallets?.length) dt += dv; }   // 合并行的成本 / 已卖出是各钱包相加的，直接重算；合计按各钱包的差额补
  add(d.totals, dt); return d;
}
function setHoldSnap(d) { if (!d) return; HOLD.data = fixClosed(d); HOLD.at = Date.now(); try { localStorage.setItem('holdSnap', JSON.stringify(d)); } catch { /* 太大或无痕模式就算了 */ } scheduleRender(); if (S.view === 'hold') renderHold(); if (favMode === 'hold' && favOn()) renderHoldStrip(); renderQB(); if (S.selected && S.tokens.has(S.selected)) renderMyPos(S.tokens.get(S.selected)); if (S.bottomTab === 'pos' || S.bottomTab === 'allpos') renderBottom(); }
function holdRow(t) {
  if (!HOLD.data) { try { HOLD.data = fixClosed(JSON.parse(localStorage.getItem('holdSnap') || 'null')); HOLD.stale = true; } catch { /* ignore */ } }
  return HOLD.data?.rows?.find((r) => r.token.toLowerCase() === String(t.address).toLowerCase()) || null;
}
function holdStats(t) {
  const hp = S.positions?.find((p) => p.token === t.address);
  const r = holdRow(t);
  const q = t.quote || 'BNB', qu = t.quoteUsd || (q === 'BNB' ? S.bnbUsd : 0);
  const pnlHtml = (pnl, pct, extra = '', pu = pnl * S.bnbUsd) => `<b class="${pu >= 0 ? 'g' : 'r'}">${pu >= 0 ? '+' : '−'}$${Math.abs(pu).toFixed(2)}<small>${pct != null ? ` ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}${extra}</small></b>`;   // 只显示美元盈亏和百分比
  const amount = r?.amount ?? hp?.amount ?? 0;
  if (!(amount > 0)) {
    const real = r && r.costBnb > 0 ? r.soldBnb - r.costBnb : null;
    return `<div><span>我的余额</span><b class="muted">0</b></div><div><span>盈亏</span>${real != null ? pnlHtml(real, (real / r.costBnb) * 100, ' · 已实现', r.soldUsd - r.costUsd) : '<b class="muted">—</b>'}</div>`;
  }
  const v = amount * (t.price || 0), vu = v * qu;
  const valTxt = q === 'BNB' || q === 'WBNB' ? `${bnb(v)} BNB` : `${K(v)} ${esc(q)}${r?.valueBnb != null ? ' ≈ ' + bnb(r.valueBnb) + ' BNB' : ''}`;
  // 盈亏 = 市值(BNB) + 已卖回(BNB) − 成本(BNB，含 gas)；数值没通过链上卖出报价核对时不显示
  const pnl = r?.pnlBnb != null ? pnlHtml(r.pnlBnb, r.pnlPct, '', r.pnlUsd) : `<b class="muted" title="${esc(r?.warn || '持仓成本还在读取')}">—</b>`;
  // 紧凑：数量 + BNB 价值；完整（报价币数量、美元）放在悬停提示里
  const short = r?.valueBnb != null ? bnb(r.valueBnb) + ' BNB' : q === 'BNB' || q === 'WBNB' ? bnb(v) + ' BNB' : K(v) + ' ' + esc(q);
  return `<div class="hold-st" title="我的余额 ${K(amount)} ≈ ${valTxt.replace(/<[^>]+>/g, '')}${vu ? ' / $' + K(vu) : ''}"><span>余额</span><b>${K(amount)}<small> ≈ ${short}</small></b></div><div class="hold-st"><span>盈亏</span>${pnl}</div>`;
}
function renderHead() {
  const t = S.detail ? { ...S.tokens.get(S.selected), ...S.detail } : S.tokens.get(S.selected);
  if (!t) { $('#tokenHead').innerHTML = '<div class="empty">选择左侧代币</div>'; return; }
  { const qb = $('#qBuy2'); if (qb) qb.innerHTML = `⚡ 买入 ${qPct(t)}% <kbd>空格+W</kbd>`; }
  const w = wallet(S.activeWallet); const el = eligible(w, t);
  $('#tokenHead').innerHTML = `
    <div class="th-row">
      ${logoHtml(t, 'lg')}
      <div class="th-main">
        <div class="th-title">${favStar(t.address)}<b class="ctick" data-ctick="${esc(symOk(t) ? t.symbol : t.address)}" title="点击复制代号">${esc(symTxt(t))}</b>${t.name && t.name !== symTxt(t) ? `<span class="muted">${esc(t.name)}</span>` : ''}${tagsHtml(t)}</div>
        <div class="th-sub"><span>代币 <span class="mono">${short(t.address, 8, 6)}</span> <span class="copy" data-copy="${t.address}">⧉</span></span><span>创建者 ${wnoteHtml(t.creator, domOf(t.creator, t.creatorDomain, t.creatorName), 6, 4)}</span>${t.firstBuyer ? `<span>首买 <a href="https://bscscan.com/address/${esc(t.firstBuyer)}" target="_blank" rel="noopener" title="${esc(t.firstBuyer)}">${whoHtml(t.firstBuyer, t.firstBuyerName || NAMES[t.firstBuyer.toLowerCase()])}</a></span>` : ''}</div>
        <div class="th-sub"><span>预设 ${esc(t.preset || '')}</span><span title="${fullTime(t.createdAt)}">${age(t.createdAt)} 前创建</span></div>
      </div>
      <div class="links"><button class="ca-big ${caOk(t.address) ? 'ok' : ''}" data-cacopy="${t.address}" title="复制合约地址：${t.address}"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="8" y="8" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V4H4v12h4" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>${caOk(t.address) ? '已复制 ✓' : '复制CA'}</span></button>${xsBtn(t.address, 'xs-head')}<a href="#" data-ext="four">${t.platform === 'four' ? 'Four' : t.platform === 'gang' ? 'Gang' : t.platform === 'dex' ? 'DexScreener' : 'Flap'}</a><a href="#" data-ext="bsc">BscScan</a><a href="#" data-ext="gmgn">GMGN</a>${blockLinks(t)}</div>${ruleBanner(t.address)}
      <div class="th-price"><div class="p">$${sub(t.priceUsd)}</div><div class="s">每枚 · ${sub(t.price)} ${esc(t.quote || 'BNB')}</div></div>
    </div>
    <div class="stats">
      <div><span>市值</span><b>${usd(t.mcapUsd)}</b></div>
      ${holdStats(t)}
      <div><span title="内盘进度">进度</span><b>${t.progress.toFixed(2)}%</b><div class="bar"><i style="width:${t.progress}%"></i></div></div>
      <div><span>已筹/目标</span><b style="white-space:nowrap">${pool(t)}</b></div>
      <div><span title="底池（美元）">底池</span><b>${usd(t.liqUsd || 0)}</b></div>
      ${t.stage === 'dex' && t.dexVol24 != null ? `<div><span title="外盘（PancakeSwap）最近 ${t.dexCountMin} 分钟买入 / 卖出笔数（链上只读得到最近约 1 小时）">外盘成交${t.dexCountMin >= 60 ? '' : ` ${t.dexCountMin}分`}</span><b><span class="g">${t.dexBuys24}</span>/<span class="r">${t.dexSells24}</span></b></div>
      <div><span title="外盘（PancakeSwap）最近 24 小时成交量">24h 成交量</span><b>${t.dexVol24 >= 1e4 ? K(t.dexVol24) : bnb(t.dexVol24, 3)} ${esc(t.quote || 'BNB')}</b></div>
      <div><span title="内盘已卖完，已发射到 PancakeSwap">可售</span><b>已发射</b></div>` : `<div><span title="买入 / 卖出笔数">成交</span><b><span class="g">${t.buys}</span>/<span class="r">${t.sells}</span></b></div>
      <div><span title="${t.volumeH24 ? '最近 24 小时成交量（gang.fun 接口，还没拉全部成交）' : '内盘成交量（开盘起累计）'}">成交量${t.volumeH24 ? ' 24h' : ''}</span><b>${bnb(t.volume, 3)} ${esc(t.quote || 'BNB')}</b></div>
      <div><span title="内盘剩余可售">可售</span><b>${t.remaining == null ? '—' : K(t.remaining)}</b></div>`}
      ${!(t.buyTax > 0 || t.sellTax > 0) ? '' : `<div><span title="代币税：只算代币自己设置的税，不含平台费">代币税</span><b><span class="${t.buyTax >= 5 ? 'r' : ''}">${pctTxt(t.buyTax)}</span> / <span class="${t.sellTax >= 5 ? 'r' : ''}">${pctTxt(t.sellTax)}</span></b></div>`}
      ${el.ok ? '' : `<div><span>资格</span><b class="${el.ok ? 'g' : 'r'}" style="font-family:var(--sans)">${el.ok ? '可交易' : el.why}</b></div>`}
      <div><span title="总费率 买/卖：代币税 + 平台费 + 防狙击税，和标题里的「税」标签是同一个数">总费率</span><b class="${taxHi(t) ? 'r' : 'g'}">${pctTxt(t.buyFeePct)} / ${pctTxt(t.sellFeePct)}${t.antiSniperPct >= 0.1 ? ` <span class="y" title="最近一笔买入含防狙击税">🛡${t.antiSniperPct.toFixed(1)}%</span>` : ''}</b></div>
      ${t.gangV3 && t.taxTo ? `<div title="${esc(t.taxToCreator ? creatorTaxTip(t) : 'Gang V3 毕业后外盘收的税，扣掉平台和分红部分打给这个地址（创建时定死）')}"><span>税收接收</span><b style="font-family:var(--sans)"><a href="https://bscscan.com/address/${esc(t.taxTo)}" target="_blank" rel="noopener">${whoHtml(t.taxTo, NAMES[t.taxTo])}</a>${creatorTaxChip(t)}</b></div>` : ''}
      ${flapTaxStat(t)}${t.gangDiv?.taxed == null || t.flapTax ? '' : `<div title="${esc(divTip(t))}"><span>分红</span><b class="${t.gangDiv.taxed ? 'g' : 'muted'}" style="font-family:var(--sans)">${t.gangDiv.taxed ? `是 · ${esc(t.gangDiv.stats?.quoteSymbol || t.quote || '')}${Number(t.gangDiv.stats?.totalUsd) > 0 ? ' · 累计 ' + usd(t.gangDiv.stats.totalUsd) : ''}` : '不分红'}</b></div>`}
      <div><span title="涨幅（开盘以来）：${esc(chgTip(t, 'launch'))}">涨幅</span><b title="${esc(chgTip(t, 'launch'))}">${chgTxt(t.chg?.launch)}</b><small class="chg-row"> <span title="${esc(chgTip(t, 'm5'))}">5m ${chgTxt(t.chg?.m5)}</span> · <span title="${esc(chgTip(t, 'h1'))}">1h ${chgTxt(t.chg?.h1)}</span>${t.chg?.h24 != null ? ` · <span title="${esc(chgTip(t, 'h24'))}">24h ${chgTxt(t.chg.h24)}</span>` : ''}</small></div>
      <div><span>持有人</span><b>${t.holders ?? '—'}</b></div>
      
      <div><span>最新</span><b title="${fullTime(t.lastTradeAt)}">${t.lastTradeAt ? age(t.lastTradeAt) + ' 前' : '—'}</b></div>
    </div>`;
}

/* ---------- K 线 ---------- */
// K 线用 TradingView Lightweight Charts（Apache-2.0，public/vendor/ 里的本地副本）：拖动、滚轮/捏合缩放、十字光标都由库处理
function aggregate() {
  const src = S.detail?.candles || []; const iv = S.interval; const out = [];
  const qu = S.detail?.quoteUsd || S.bnbUsd; const f = S.metric === 'mcap' ? 1e9 * qu : qu;
  for (const c of src) {
    const b = Math.floor(c.t / iv) * iv; const l = out[out.length - 1];
    if (l && l.t === b) { l.h = Math.max(l.h, c.h * f); l.l = Math.min(l.l, c.l * f); l.c = c.c * f; l.v += c.v; }
    else out.push({ t: b, o: c.o * f, h: c.h * f, l: c.l * f, c: c.c * f, v: c.v });
  }
  return out;
}
// 价格轴下方留给成交量的空白会画出负数刻度（$-4K…），价格 / 市值不会是负数，不显示
function fmtAxis(v) { if (v < 0) return ''; return S.metric === 'mcap' ? '$' + K(v, Math.abs(v) >= 1e3 ? 2 : 4) : '$' + sub(v, 4); }
const LWC = window.LightweightCharts;
const chartEl = $('.chart-wrap');
const tz = -new Date().getTimezoneOffset() * 60;   // 库按 UTC 显示时间，这里换成本地时间
const chart = LWC.createChart(chartEl, {
  autoSize: true,
  layout: { background: { color: 'transparent' }, textColor: '#7d8794', fontSize: 11, fontFamily: getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace' },
  grid: { vertLines: { color: '#151b22' }, horzLines: { color: '#151b22' } },
  crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: '#3a4350', labelBackgroundColor: '#2b3139' }, horzLine: { color: '#3a4350', labelBackgroundColor: '#2b3139' } },
  rightPriceScale: { borderColor: '#1e2329', scaleMargins: { top: 0.08, bottom: 0.26 } },
  timeScale: { borderColor: '#1e2329', timeVisible: true, secondsVisible: true, rightOffset: 3, barSpacing: 6, minBarSpacing: 0.5 },
  localization: { priceFormatter: fmtAxis },
});
const candles = chart.addCandlestickSeries({ upColor: '#1ecb81', downColor: '#f6465d', borderVisible: false, wickUpColor: '#1ecb81', wickDownColor: '#f6465d',
  priceFormat: { type: 'custom', formatter: fmtAxis, minMove: 1e-12 }, priceLineColor: '#1ecb81', priceLineStyle: LWC.LineStyle.Dashed,
  // 价格轴上滚轮调 K 线高度：在自动范围的基础上按 Y.zoom 放大/缩小（>1 = 范围变大、蜡烛变矮）
  autoscaleInfoProvider: (orig) => {
    const r = orig(); if (!r?.priceRange || Y.zoom === 1) return r;
    const { minValue, maxValue } = r.priceRange; const mid = (minValue + maxValue) / 2, half = Math.max((maxValue - minValue) / 2, Math.abs(mid) * 1e-6) * Y.zoom;
    return { ...r, priceRange: { minValue: mid - half, maxValue: mid + half } };
  } });
const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
const bar = (d) => ({ time: d.t + tz, open: d.o, high: d.h, low: d.l, close: d.c });
const volBar = (d) => ({ time: d.t + tz, value: d.v, color: d.c >= d.o ? CT.vu : CT.vd });
// 只在换代币 / 换周期 / 换市值-价格时 setData；其余只 update 最新一两根
const CH = { key: '', len: 0, lastT: 0, markers: '' };
const Y = { zoom: 1 };
function resetView() { CH.key = ''; Y.zoom = 1; }
// 主题（theme.js / theme.css）：K 线颜色读 --chart-* 变量，没设就是经典配色；切主题时重画
const CT = { up: '#1ecb81', down: '#f6465d', vu: 'rgba(30,203,129,.45)', vd: 'rgba(246,70,93,.45)' };
function applyChartTheme() {
  const cs = getComputedStyle(document.documentElement), v = (k, d) => cs.getPropertyValue('--chart-' + k).trim() || d;
  Object.assign(CT, { up: v('up', '#1ecb81'), down: v('down', '#f6465d'), vu: v('vol-up', 'rgba(30,203,129,.45)'), vd: v('vol-down', 'rgba(246,70,93,.45)') });
  const cross = { color: v('cross', '#3a4350'), labelBackgroundColor: v('label', '#2b3139') }, grid = { color: v('grid', '#151b22') }, border = v('border', '#1e2329');
  chart.applyOptions({ layout: { textColor: v('text', '#7d8794'), fontFamily: cs.getPropertyValue('--mono') || 'monospace' }, grid: { vertLines: grid, horzLines: grid }, crosshair: { vertLine: cross, horzLine: cross }, rightPriceScale: { borderColor: border }, timeScale: { borderColor: border } });
  candles.applyOptions({ upColor: CT.up, downColor: CT.down, wickUpColor: CT.up, wickDownColor: CT.down, priceLineColor: CT.up });
}
applyChartTheme();
window.addEventListener('tmtn-theme', () => { applyChartTheme(); CH.key = ''; CH.markers = ''; try { drawChart(); } catch { /* 还没选币 */ } });
// 鼠标在右侧价格轴上滚轮：拉伸 / 压缩 K 线高度（不动时间轴）；双击价格轴恢复自动
const overPriceAxis = (e) => { const r = chartEl.getBoundingClientRect(); return e.clientX >= r.right - chart.priceScale('right').width() && e.clientY <= r.bottom - chart.timeScale().height(); };
function applyYZoom() { chart.priceScale('right').applyOptions({ autoScale: true }); candles.applyOptions({ autoscaleInfoProvider: candles.options().autoscaleInfoProvider }); }
chartEl.addEventListener('wheel', (e) => {
  if (!overPriceAxis(e)) return;
  e.preventDefault(); e.stopPropagation();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1); if (!dy) return;
  const step = e.deltaMode !== 0 || Math.abs(dy) >= 50 ? 1.1 : Math.exp(Math.abs(dy) * 0.004);
  Y.zoom = Math.max(0.05, Math.min(50, dy > 0 ? Y.zoom * step : Y.zoom / step));   // 向下滚 = 蜡烛变矮，向上滚 = 拉高
  applyYZoom();
}, { capture: true, passive: false });
chartEl.addEventListener('dblclick', (e) => { if (overPriceAxis(e)) { Y.zoom = 1; applyYZoom(); } }, true);
function ohlc(d) {
  if (!d) { $('#ohlc').innerHTML = ''; return; }
  const ch = ((d.c - d.o) / d.o) * 100;
  $('#ohlc').innerHTML = `O <b>${fmtAxis(d.o)}</b> H <b>${fmtAxis(d.h)}</b> L <b>${fmtAxis(d.l)}</b> C <b class="${ch >= 0 ? 'g' : 'r'}">${fmtAxis(d.c)}</b> <span class="${ch >= 0 ? 'g' : 'r'}">${ch.toFixed(2)}%</span>`;
}
// 默认缩放：显示全部 K 线。每根宽度 = 图宽 ÷ 根数，限制在 0.5～7px：很少的几根不会被拉得很粗（保持细、靠右），太多的显示到最小宽度为止。
// 只在换币 / 换周期 / 历史重建时调用；实时更新用 update()，不会打乱用户拖动或缩放后的视图
function fitAll(n) {
  const ts = chart.timeScale(); const w = Math.max(100, chartEl.clientWidth - (chart.priceScale('right').width() || 60));
  const sp = Math.max(0.5, Math.min(7, (w - 24) / Math.max(1, n + 3)));
  ts.applyOptions({ barSpacing: sp, rightOffset: 3 }); ts.scrollToRealTime();
}
function drawChart() {
  const all = aggregate();
  const key = [S.selected, S.interval, S.metric].join('|');
  // 中间插进了 K 线（外盘成交补齐后接在内盘后面）：上次画的最后一根不在原来的位置了，只 update 末尾会漏掉中间那段，
  // 图上停在旧的最后一根（BATCOIN 价格线停在 $40.84K，OHLC 已是 $272K）。这种情况整条重画
  const moved = CH.len > 0 && all.length >= CH.len && all[CH.len - 1]?.t !== CH.lastT;
  if (key !== CH.key || all.length < CH.len || moved || (all.length && all[0].t !== CH.firstT)) {
    if (key !== CH.key && Y.zoom !== 1) { Y.zoom = 1; applyYZoom(); }
    candles.setData(all.map(bar)); volume.setData(all.map(volBar));
    // 新币 / 换周期 / 历史重建后：K 线少就铺满整个宽度，多就对齐到最新（右边留一点空）
    if (key !== CH.key || (all.length && all[0].t !== CH.firstT)) fitAll(all.length);
    CH.key = key; CH.markers = null;   // 换币 / 换周期一定重画标记（以前没有自己成交的币会留着上一个币的买卖标记）
  } else {
    for (const d of all.slice(Math.max(0, CH.len - 1))) { if (d.t >= CH.lastT) { candles.update(bar(d)); volume.update(volBar(d)); } }
  }
  CH.len = all.length; CH.firstT = all[0]?.t; CH.lastT = all[all.length - 1]?.t || 0;
  if (!CH.hovering) ohlc(all[all.length - 1]);
  // 自己的买卖标在 K 线上
  // 只标已上链、成交人是我钱包的成交：最近成交列表里 trader = 我，加上钱包历史（持仓数据，较早的也在）；按 tx 去重
  const seen = new Set(); const mine = [];
  for (const t of [...(S.detail?.trades || []).filter((x) => isMe(x.trader)), ...((S.detail && HOLD.data?.rows?.find((r) => r.token.toLowerCase() === S.detail.address.toLowerCase())?.trades) || [])]) {
    const k = String(t.tx || '').toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); mine.push(t);
  }
  // 发币人（dev）的买卖：后端单独记的 devTrades + 最近成交里成交人 = 创建者的，按 tx 去重。和 GMGN 一样标 DB（dev 买，绿）/ DS（dev 卖，红）
  const dev = [], cr = String(S.detail?.creator || '').toLowerCase(), dseen = new Set();
  if (cr) for (const t of [...(S.detail?.devTrades || []), ...(S.detail?.trades || []).filter((x) => String(x.trader || '').toLowerCase() === cr)]) {
    const k = String(t.tx || '').toLowerCase() + t.side; if (!t.tx || dseen.has(k)) continue; dseen.add(k); dev.push(t);
  }
  const mk = S.selected + ':' + mine.map((t) => t.tx + t.side).join(',') + '|' + dev.map((t) => t.tx + t.side).join(',');
  if (mk !== CH.markers) {
    CH.markers = mk;
    // 早于第一根 K 线的成交（K 线历史不全时）不标：库会把它们全挤到第一根上
    const t0 = all.length ? all[0].t : Infinity, bt = (t) => Math.floor(t.ts / 1000 / S.interval) * S.interval;
    const mm = mine.filter((t) => bt(t) >= t0).map((t) => ({ time: bt(t) + tz, position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: t.side === 'buy' ? CT.up : CT.down, shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown', text: t.side === 'buy' ? '买' : '卖' }));
    // 同一根 K 线上 dev 卖了好几笔只标一个 DS（买同理），文字带笔数，不然一串标记叠在一起看不清
    const per = new Map();
    for (const t of dev) { if (bt(t) < t0) continue; const k = bt(t) + t.side; const o = per.get(k); if (o) o.n++; else per.set(k, { time: bt(t) + tz, side: t.side, n: 1 }); }
    const dm = [...per.values()].map((d) => ({ time: d.time, position: d.side === 'buy' ? 'belowBar' : 'aboveBar', color: d.side === 'buy' ? CT.up : CT.down, shape: 'circle', size: 1.4,
      text: (d.side === 'buy' ? 'DB' : 'DS') + (d.n > 1 ? '×' + d.n : '') }));
    candles.setMarkers([...mm, ...dm].sort((a, b) => a.time - b.time));
  }
}
chart.subscribeCrosshairMove((p) => {
  const d = p?.time != null ? p.seriesData.get(candles) : null;
  CH.hovering = !!d;
  if (d) ohlc({ o: d.open, h: d.high, l: d.low, c: d.close }); else ohlc(aggregate().at(-1));
});
// 往回看历史时显示「回到最新」；双击或点按钮回到最新
chart.timeScale().subscribeVisibleLogicalRangeChange(() => $('#toLatest').classList.toggle('hidden', chart.timeScale().scrollPosition() > -2));
chartEl.addEventListener('dblclick', () => chart.timeScale().scrollToRealTime());
$('#toLatest').addEventListener('click', () => chart.timeScale().scrollToRealTime());

/* ---------- 底部表格 ---------- */
const qAmt = (v, q) => `${!(v > 0) ? '0' : q === 'BNB' || v < 1000 ? bnb(v, 4) : K(v)} ${esc(q)}`;   // 报价币金额：BNB 保留小数，大数（GANG 等）用 K / M
const usdAmt = (v) => (v == null || !isFinite(v) ? '—' : '$' + (v < 0.1 ? v.toFixed(4) : v.toFixed(2)));
const txLink = (tx) => (!tx ? '—' : LIVE() ? `<a href="https://bscscan.com/tx/${tx}" target="_blank" rel="noopener">${short(tx, 8, 6)} ↗</a>` : `${short(tx, 8, 6)} ↗`);
// 「所有持仓」标签：按钱包拆开的持仓行（只要还持有的）。其他钱包按本后端（8788）的价格重新估值，和这里看到的行情一致
function allPosRows() {
  if (!HOLD.data) { try { HOLD.data = fixClosed(JSON.parse(localStorage.getItem('holdSnap') || 'null')); } catch { /* ignore */ } }   // 刚打开页面：先用上次的快照
  const d = HOLD.data; if (!d) return [];
  const ws = d.wallets?.length ? d.wallets : [{ slot: 0, label: '', rows: d.rows || [] }];
  const own = new Map((ws[0].rows || []).map((r) => [String(r.token).toLowerCase(), r])), bu = d.bnbUsd || S.bnbUsd || 0;
  const out = [];
  ws.forEach((w, i) => { for (const r0 of w.rows || []) {
    if (!(r0.amount > 0)) continue;
    const r = { ...r0, slot: w.slot, wlabel: w.label };
    if (i > 0 && r0.valueBnb != null) {   // 对方的数值通过了它自己的校验才重算；拿不到本后端价格就保持原样
      const o = own.get(String(r0.token).toLowerCase()), t = S.tokens.get(r0.token);
      const px = o?.priceBnb > 0 ? o.priceBnb : t?.price > 0 && r0.quoteRate > 0 ? t.price * r0.quoteRate : null;
      if (px) { r.valueBnb = r0.amount * px; r.valueUsd = r.valueBnb * bu; if (r0.pnlBnb != null) r.pnlBnb = r.valueBnb + (r0.soldBnb || 0) - (r0.costBnb || 0); if (r0.pnlUsd != null) r.pnlUsd = r.valueUsd + (r0.soldUsd || 0) - (r0.costUsd || 0); if (r.pnlUsd != null && r0.costUsd > 0) r.pnlPct = (r.pnlUsd / r0.costUsd) * 100; }
    }
    out.push(r);
  } });
  return out.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
}
$('#bottomBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-asell]'); if (!b) return; e.preventDefault(); e.stopPropagation();
  const [slot, w, tk, pct] = b.dataset.asell.split(':'), multi = (HOLD.data?.wallets?.length || 0) > 1;
  const lbl = multi ? HOLD.data.wallets.find((x) => x.slot === +slot)?.label : null;
  if (multi && !S.orderSlots) return note('后端还是旧版本，不能只卖一个钱包：重启后端后再点（现在点会让所有钱包一起卖）', 'info');
  submitOrder({ token: tk, side: 'sell', wallets: [w], amountFor: () => +pct, ...(multi && +slot ? { slots: [+slot], label: lbl } : {}) });
});
// 「我的持仓」的成交列表：标出是哪个钱包的；市值 = 成交单价（美元，按当时 BNB 价）× 总量
function posTradesHtml(hr, t) {
  const ws = HOLD.data?.wallets?.length > 1 ? HOLD.data.wallets : null, lc = String(hr.token).toLowerCase();
  const list = ws ? ws.flatMap((w) => (w.rows || []).filter((r) => String(r.token).toLowerCase() === lc).flatMap((r) => (r.trades || []).map((x) => ({ ...x, wl: w.label })))).sort((a, b) => b.ts - a.ts) : hr.trades || [];
  if (!list.length) return '';
  const supply = t?.maxSupply || (hr.amount > 0 && hr.supplyPct > 0 ? (hr.amount * 100) / hr.supplyPct : 1e9);
  const mc = (x) => (x.tokens > 0 && x.bnb > 0 ? ((x.usd ?? x.bnb * S.bnbUsd) / x.tokens) * supply : null);
  return `<table class="ttable"><tr><th>时间</th><th class="l">方向</th><th>数量</th><th title="按成交当时的 BNB/USDT 价格换算；悬停看 BNB">金额 (USDT)</th><th title="成交时的市值：成交单价 × 总量">市值</th>${ws ? '<th class="l">钱包</th>' : ''}<th class="l">交易</th></tr>${list.map((x) => `<tr><td class="dim">${new Date(x.ts).toLocaleString('zh-CN', { hour12: false })}</td><td class="l ${x.side === 'buy' ? 'g' : 'r'}">${x.side === 'buy' ? '买入' : '卖出'}</td><td>${K(x.tokens)}</td><td title="${bnb(x.bnb, 5)} BNB">${usdAmt(x.usd ?? (S.bnbUsd ? x.bnb * S.bnbUsd : null))}</td><td>${mc(x) != null ? usd(mc(x)) : '—'}</td>${ws ? `<td class="l"><b class="me">${esc(x.wl || '')}</b></td>` : ''}<td class="l">${txLink(x.tx)}</td></tr>`).join('')}</table>`;
}
function renderBottom() {
  const b = $('#bottomBody'); const t = S.tokens.get(S.selected);
  const mineSet = new Set(S.wallets.map((w) => 'user:' + w.id));
  let html = '', cnt = '';
  switch (S.bottomTab) {
    case 'pos': {
      // 详情页的「我的持仓」只看当前这个币（和持仓页同一份数据：均价、市值、盈亏都折成 BNB / 美元）
      const sel = S.selected?.toLowerCase(), hr = HOLD.data?.rows?.find((x) => x.token.toLowerCase() === sel);
      if (sel && t) {
        cnt = hr?.amount > 0 ? '持有中' : '';
        html = !hr ? `<div class="empty">没有持有 ${esc(t.symbol)}${LIVE() ? '' : '（模拟盘）'}</div>` : `<div class="mypos">
          <div><span>持有</span><b>${K(hr.amount)}</b><small>${hr.supplyPct != null ? hr.supplyPct.toFixed(3) + '% 总量' : ''}</small></div>
          <div title="${hr.avgBuyBnb ? sub(hr.avgBuyBnb) + ' BNB' : ''}${hr.avgBuyQuote && hr.quote !== 'BNB' ? ' / ' + sub(hr.avgBuyQuote) + ' ' + esc(hr.quote) : ''}"><span>买入均价</span><b>${hr.avgBuyUsd ? '$' + sub(hr.avgBuyUsd) : '—'}</b></div>
          <div title="${hr.priceBnb ? sub(hr.priceBnb) + ' BNB' : ''}"><span>现价</span><b>${t.priceUsd ? '$' + sub(t.priceUsd) : '—'}</b></div>
          <div title="我持有的这部分按现价值多少（不是代币市值）${hr.valueBnb != null ? '\n' + bnb(hr.valueBnb) + ' BNB' : ''}"><span>余额</span><b>${hr.valueUsd != null ? '$' + (hr.valueUsd).toFixed(2) : '—'}</b></div>
          <div title="${bnb(hr.costBnb)} BNB\n${usdTip(hr)}"><span>成本</span><b>$${(hr.costUsd || 0).toFixed(2)}</b></div>
          <div title="${bnb(hr.soldBnb)} BNB\n${usdTip(hr)}"><span>已卖出</span><b>$${(hr.soldUsd || 0).toFixed(2)}</b></div>
          <div title="${usdTip(hr)}"><span>盈亏</span><b class="${hr.pnlUsd == null ? 'muted' : hr.pnlUsd >= 0 ? 'g' : 'r'}">${usdSigned(hr.pnlUsd)}</b><small>${hr.pnlPct != null ? (hr.pnlPct >= 0 ? '+' : '') + hr.pnlPct.toFixed(1) + '%' : ''}</small></div>
          ${hr.amount > 0 ? `<div class="acts"><button class="qb" data-hsell="${hr.walletId}:${hr.token}:50">卖 50%</button> <button class="qb" style="color:var(--r)" data-hsell="${hr.walletId}:${hr.token}:100">清仓</button></div>` : ''}
        </div>${posTradesHtml(hr, t)}`;
        holdRow(t); break;
      }
      const rows = S.positions; cnt = rows.filter((p) => p.amount > 0).length + ' 个持仓';
      // 已迁移、还没领取的 Flap 曲线份额
      const cl = LIVE() && S.claimable?.length ? `<div class="note" style="margin:6px 0"><b class="y">可领取</b>（Flap 曲线已迁移，份额要领成代币）：${S.claimable.map((c) => `<span class="side" style="margin-right:12px">${logoHtml({ ...c, address: c.token, platform: 'flap' }, 'xs')}${esc(c.symbol)} ${K(c.shares)} 份 <button class="qb" style="display:inline" data-claim="${c.market}">领取</button></span>`).join('')}</div>` : '';
      html = cl + (rows.length ? `<table><tr><th>代币</th><th class="l">钱包</th><th>持有</th><th>价值 (BNB)</th><th>成本</th><th>累计买入/卖回</th><th>盈亏</th><th>浮盈%</th><th class="l">状态</th><th>操作</th></tr>
        ${rows.map((p) => `<tr><td><span class="side">${logoHtml({ ...p, address: p.token }, 'xs')}<a href="#" data-a="${p.token}">${esc(p.symbol)}</a></span></td><td class="l">${esc(p.wallet)}</td><td>${K(p.amount)}</td><td>${bnb(p.valueBnb)}</td><td>${bnb(p.costBnb)}</td><td>${bnb(p.boughtBnb)} / ${bnb(p.soldBnb)}</td>
        <td class="${p.pnlBnb >= 0 ? 'g' : 'r'}">${p.pnlBnb >= 0 ? '+' : ''}${bnb(p.pnlBnb)}</td><td class="${p.pnlPct >= 0 ? 'g' : 'r'}">${p.amount > 0 ? pctS(p.pnlPct) : '已清仓'}</td><td class="l">${p.stage === 'curve' ? '内盘' : p.stage === 'dex' ? '已迁移' : '已撤池'}</td>
        <td>${p.amount > 0 ? `<button class="qb" style="display:inline;color:var(--r);border-color:rgba(246,70,93,.4);background:var(--r-bg)" data-sell="${p.walletId}:${p.token}:50">卖50%</button> <button class="qb" style="display:inline;color:var(--r);border-color:rgba(246,70,93,.4);background:var(--r-bg)" data-sell="${p.walletId}:${p.token}:100">清仓</button>` : ''}</td></tr>`).join('')}</table>` : (cl ? '' : '<div class="empty">暂无持仓</div>'));
      break;
    }
    case 'holders': { const v = holdersHtml(t); html = v.html; cnt = v.cnt; break; }   // HOLDERS_FEATURE
    case 'allpos': {
      // 所有持仓：每个钱包各自一行（同一个币两个钱包都有就两行），点卖出只卖那一个钱包的
      const rows = allPosRows(), shown = rows.filter((r) => r.valueBnb == null || r.valueBnb >= 0.0005), hid = rows.length - shown.length;
      const multi = (HOLD.data?.wallets?.length || 0) > 1, sel = S.selected?.toLowerCase();
      const T = shown.reduce((a, r) => ({ v: a.v + (r.valueUsd || 0), vb: a.vb + (r.valueBnb || 0), c: a.c + (r.costUsd || 0), p: a.p + (r.pnlUsd || 0) }), { v: 0, vb: 0, c: 0, p: 0 });
      cnt = shown.length + ' 个持仓' + (hid ? `（另有 ${hid} 个小额未显示）` : '');
      const stg = (r) => (r.stage === 'claim' ? '<span class="y">可领取</span>' : r.stage === 'curve' ? '内盘' : r.stage === 'dex' ? '<span class="g">已迁移</span>' : '已撤池');
      const sellBtn = (r, pct, txt) => `<button class="qb" style="display:inline;color:var(--r);border-color:rgba(246,70,93,.4);background:var(--r-bg)" data-asell="${r.slot || 0}:${r.walletId}:${r.token}:${pct}">${txt}</button>`;
      html = !HOLD.data ? '<div class="empty">持仓读取中…</div>' : shown.length ? `<table><tr><th class="l">代币</th>${multi ? '<th class="l">钱包</th>' : ''}<th class="l">平台 / 状态</th><th>数量</th><th title="按本程序（8788）的现价估值">余额</th><th>成本</th><th>已卖出</th><th>盈亏</th><th>操作</th></tr>
        <tr class="dim"><td class="l"><b>合计</b></td>${multi ? '<td></td>' : ''}<td></td><td></td><td><b>$${T.v.toFixed(2)}</b><div class="hsub">${bnb(T.vb)} BNB</div></td><td>$${T.c.toFixed(2)}</td><td></td><td>${sgn(T.p, (v) => '$' + v.toFixed(2))}${T.c > 0 ? ' <span class="hsub">' + sgn((T.p / T.c) * 100, (v) => v.toFixed(1) + '%') + '</span>' : ''}</td><td></td></tr>
        ${shown.map((r) => `<tr class="${r.token.toLowerCase() === sel ? 'mine' : ''}"><td class="l"><span class="side" data-a="${r.token}" style="cursor:pointer" title="打开这个币">${logoHtml({ ...r, address: r.token }, 'xs')}<b>${esc(r.symbol)}</b></span></td>${multi ? `<td class="l"><b class="me">${esc(r.wlabel || '')}</b></td>` : ''}
        <td class="l"><i class="pbadge">${r.platform === 'four' ? 'Four' : r.platform === 'gang' ? 'Gang' : r.platform === 'dex' ? 'DEX' : 'Flap'}</i> ${stg(r)}</td><td>${K(r.amount)}<div class="hsub">${r.supplyPct != null ? r.supplyPct.toFixed(3) + '%' : ''}</div></td>
        <td>${r.valueBnb != null ? `<b>$${(r.valueUsd || 0).toFixed(2)}</b><div class="hsub">${bnb(r.valueBnb)} BNB</div>` : `<span class="y" title="${esc(r.warn || '')}">— ⚠</span>`}</td>
        <td title="${usdTip(r)}">$${(r.costUsd || 0).toFixed(2)}<div class="hsub">${bnb(r.costBnb)} BNB</div></td><td title="${usdTip(r)}">$${(r.soldUsd || 0).toFixed(2)}</td>
        <td title="${usdTip(r)}">${r.pnlUsd == null ? `<span class="muted" title="${esc(r.warn || '')}">—</span>` : sgn(r.pnlUsd, (v) => '$' + v.toFixed(2))}${r.pnlPct != null ? ' <span class="hsub">' + sgn(r.pnlPct, (v) => v.toFixed(1) + '%') + '</span>' : ''}</td>
        <td>${r.isQuote ? sellBtn(r, 100, '换回 BNB') : sellBtn(r, 50, '卖50%') + ' ' + sellBtn(r, 100, '清仓')}</td></tr>`).join('')}</table>` : `<div class="empty">${HOLD.err ? esc(HOLD.err) : '暂无持仓'}</div>`;
      break;
    }
    case 'orders': case 'fills': {
      const rows = S.bottomTab === 'fills' ? S.orders.filter((o) => o.status === 'filled') : S.orders; cnt = rows.length + ' 笔';
      html = rows.length ? `<table><tr><th>时间</th><th class="l">来源</th><th class="l">钱包</th><th class="l">代币</th><th class="l">方向</th><th>输入</th><th>输出</th><th>耗时</th><th class="l">状态 / 执行步骤</th>${S.bottomTab === 'fills' || REAL() ? '<th class="l">交易</th>' : ''}</tr>
        ${rows.slice(0, 150).map((o) => `<tr><td class="dim">${hms(o.ts)}</td><td class="l">${o.source}</td><td class="l"><b class="me">${esc(o.wallet)}</b></td><td class="l"><a href="#" data-a="${o.token}">${esc(o.symbol)}</a></td>
        <td class="l ${o.side === 'buy' || o.side === 'claim' ? 'g' : 'r'}">${o.side === 'claim' ? '领取' : o.side === 'buy' ? '买入' : '卖出'}</td><td>${o.side === 'claim' ? '—' : o.side === 'buy' ? bnb(o.amountIn ?? o.amount) + ' BNB' : (o.amountIn && !LIVE() ? K(o.amountIn) : o.amount + '%')}</td>
        <td>${o.out == null ? '—' : o.side === 'buy' ? K(o.out) : bnb(o.out) + ' BNB'}</td><td>${o.latencyMs != null ? o.latencyMs + 'ms' : '…'}</td>
        <td class="l"><span class="${o.status === 'filled' ? 'g' : o.noBalance ? 'muted' : o.status === 'failed' ? 'r' : 'y'}">${o.status === 'filled' ? '成交' : o.status === 'failed' ? esc(o.reason) : o.status === 'dry_run' ? '已报价（未上链）' : o.status === 'unknown' || o.stage === 'unknown' ? '待确认：' + esc(o.reason || '') : '提交中'}</span>
        <div class="steps">${(o.steps || []).map((s) => `${esc(s.name)} ${s.ms}ms`).join(' → ')}</div></td>${S.bottomTab === 'fills' || REAL() ? `<td class="l">${txLink(o.tx)}</td>` : ''}</tr>`).join('')}</table>` : '<div class="empty">暂无订单</div>';
      break;
    }
    case 'assets': {
      cnt = S.wallets.length + ' 个钱包';
      html = `<table><tr><th>钱包</th><th class="l">地址</th><th>BNB</th><th>USD</th><th>持仓价值</th><th class="l">Binance Agent ID</th><th class="l">Four 白名单</th><th>Nonce</th><th>操作</th></tr>
        ${S.wallets.map((w) => { const pv = S.positions.filter((p) => p.walletId === w.id).reduce((a, p) => a + p.valueBnb, 0);
          return `<tr><td><span class="side"><i class="wav" style="background:${w.color};width:14px;height:14px"></i>${w.label}</span></td><td class="l addr">${w.address}</td><td>${w.bnb.toFixed(5)}</td><td>$${(w.bnb * S.bnbUsd).toFixed(2)}</td><td>${bnb(pv)} BNB</td>
          <td class="l ${w.agentId ? 'g' : 'r'}">${w.agentId ? '已绑定 ✓' : '未绑定'}</td><td class="l ${w.whitelisted ? 'g' : 'r'}">${w.whitelisted ? '已在白名单' : '非白名单'}</td><td>${w.nonce}</td>
          <td>${LIVE() ? '—' : `<button class="qb" style="display:inline" data-faucet="${w.id}">+5 测试 BNB</button>`}</td></tr>`; }).join('') || `<tr><td colspan="9" class="l">${esc(S.baw?.error || '没有钱包')}</td></tr>`}</table>`;
      break;
    }
    case 'logs': {
      cnt = S.logs.length + ' 条';
      html = S.logs.map((l) => `<div class="log-line ${l.level}"><span class="t">${hms(l.ts)}</span><span>${esc(l.msg)}</span></div>`).join('') || '<div class="empty">暂无事件</div>';
      break;
    }
  }
  if (b._html !== html) { const keep = b.scrollTop; b.innerHTML = html; b.scrollTop = keep; b._html = html; }   // 内容没变就不重建（每次 tick 都会调到这里）
  $('#bottomCnt').textContent = cnt;
}

/* ---------- 右栏 ---------- */
function renderRight() {
  const t = S.tokens.get(S.selected);
  const buy = S.side === 'buy';
  $('#amtLabel').textContent = buy ? '买入金额' : '卖出比例';
  $('#amtMode').classList.toggle('hidden', !buy);
  $('#wLabel').textContent = buy ? '买入钱包' : '卖出钱包';
  const unit = buy ? (S.amtMode === 'bnb' ? 'BNB' : '%') : '%';
  $('#amtUnit').textContent = unit;
  const aw = wallet([...S.selWallets][0] || S.activeWallet);
  const held = S.positions.filter((p) => p.token === S.selected && S.selWallets.has(p.walletId)).reduce((a, p) => a + p.amount, 0);
  $('#avail').textContent = buy ? `${(aw.bnb ?? 0).toFixed(4)} BNB` : `${K(held)} ${t?.symbol || ''}`;
  const presets = buy && S.amtMode === 'bnb' ? [0.01, 0.05, 0.1, 0.2, 0.5] : buy ? [0.5, 1, 2, 3, 5] : [10, 25, 50, 75, 100];
  const ph = presets.join();
  if ($('#presets').dataset.k !== ph) { $('#presets').dataset.k = ph; $('#presets').innerHTML = presets.map((p) => `<button data-p="${p}">${p}${unit === '%' ? '%' : ''}</button>`).join(''); }
  // 多钱包：列出所有钱包（.ai 名、BNB、登录状态），勾选 = 参与下单（和钱包菜单同一个开关）；未登录 / 后端没启动的标灰
  if (MW()) {
    $('#wchips').innerHTML = S.walletsInfo.map((w) => { const ok = w.auth === 'ok', bad = !ok && w.auth !== 'checking';
      return `<button class="wchip mw-chip ${w.on ? 'on' : ''} ${bad ? 'bad' : ''}" data-mwchip="${w.slot}" title="${esc(w.label)} ${w.address || ''}\n${ok ? '已登录' : w.auth === 'offline' ? '后端没有运行' : w.auth === 'checking' ? '检查中' : '未登录：' + (w.signin || '')}\n点击切换「参与下单」"><i class="wav" style="background:${wsColor(w.slot)}"></i>${esc(w.agentId || w.label)}<span class="mono">${w.bnb != null ? w.bnb.toFixed(3) : '—'}</span>${bad ? `<span class="r" style="font-size:10px">${w.auth === 'offline' ? '离线' : '未登录'}</span>${wLoginBtn(w, 'i')}` : ''}${w.on ? '<i class="mw-ck">✓</i>' : ''}</button>`; }).join('');
  } else
  $('#wchips').innerHTML = S.wallets.map((w) => { const el = eligible(w, t); return `<button class="wchip ${S.selWallets.has(w.id) ? 'on' : ''}" data-w="${w.id}" title="${el.ok ? '' : el.why}"><i class="wav" style="background:${w.color}"></i>${w.label}<span class="mono">${w.bnb.toFixed(w.bnb < 10 ? 3 : 2)}</span>${el.ok ? '' : '<span class="r" style="font-size:10px">非白名单</span>'}</button>`; }).join('');
  const n = S.selWallets.size;
  $('#wHint').textContent = S.wallets.length > 1 ? `已选 ${n} 个 · ${buy ? '每个钱包各买一份' : '每个钱包各卖同比例'}` : (LIVE() ? '币安 Agentic Wallet' : '单钱包');
  const btn = $('#submit');
  btn.className = 'big-btn ' + (buy ? '' : 'sell');
  btn.textContent = !t ? '选择代币' : REAL() ? `${buy ? '买入' : '卖出'} ${t.symbol}（真实上链）` : LIVE() ? `${buy ? '报价买入' : '报价卖出'} ${t.symbol}（只报价，不上链）` : n > 1 ? (buy ? `买入 ${t.symbol} · ${n} 个钱包各一份` : `卖出 ${t.symbol} · ${n} 个钱包`) : `${buy ? '买入' : '卖出'} ${t.symbol}`;
  const gangOnly = false;   // Gang V2 报价币盘也能下单了（BNB→报价币→buy，非原子）
  btn.disabled = !t || !n || t.stage === 'rugged' || (REAL() && !AUTH_OK()) || gangOnly || !!t.viewOnly;   // viewOnly：只看行情的普通盘
  if (REAL() && !AUTH_OK() && t) btn.textContent = MW() && !onWallets().length ? '没有钱包参与下单，不能下单' : '币安钱包未登录，不能下单';
  else if (REAL() && t && MW()) {   // 多钱包：按钮上写明几个钱包一起下单；买入时写总金额
    const k = onWallets().filter((w) => w.auth === 'ok').length, a = buy && S.amtMode !== 'pct' ? parseFloat($('#amount')?.value) : NaN;
    if (k > 1) btn.textContent += buy && a > 0 ? ` · ${a} BNB ×${k} = ${+(a * k).toFixed(6)} BNB` : ` · ${k} 个钱包`;
  }
  if (t?.viewOnly) btn.textContent = '普通盘只看行情（暂不支持下单）';
  $('#fastMode').checked = !!S.fast; $('#autoClaim').checked = S.settings.autoClaim !== false; $('#sellToBnb').checked = S.settings.sellToBnb !== false; $('#preApproveCap').checked = S.settings.preApproveCap !== false;
  renderMyPos(t); renderInfo(t);
}

function renderMyPos(t) {
  if (!t) { $('#myPos').innerHTML = ''; return; }
  const ps = S.positions.filter((p) => p.token === t.address);
  const sum = (k) => ps.reduce((a, p) => a + (p[k] || 0), 0);
  const hr = LIVE() ? holdRow(t) : null;   /* 实盘：和一键买卖、我的持仓用同一份持仓快照（报价币已按 BNB 价换算成美元） */
  const plat = t.platform === 'four' ? 'Four · Agent ID 专属' : t.platform === 'gang' ? (/^v3/.test(t.gangTrack || '') ? `Gang ${t.gangTrack === 'v3fair' ? (t.stage === 'dex' ? '打新 · 已发射（外盘）' : 'V3 打新') : 'V3'} · 计价 ${esc(t.quote || '')}` : t.gangTrack === 'v2' ? `Gang V2 · 计价 ${esc(t.quote || '')}` : 'Gang · Agent ID 专属') : t.platform === 'dex' ? `外盘代币 · 计价 ${esc(t.quote || '')}` : 'Flap · Agent 曲线';
  const tag = LIVE() ? `${plat} · 资格以合约为准` : t.platform === 'four' ? `Four：${eligible(wallet(S.activeWallet), t).ok ? '钱包已在白名单' : '钱包不在白名单'}` : `${plat}`;
  const usd = (v) => (v == null ? '—' : '$' + v.toFixed(2)), sgn = (v) => (v == null ? '—' : `<b class="${v >= 0 ? 'g' : 'r'}">${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}</b>`);
  let amt, rows;
  if (hr) {
    amt = hr.amount || 0;
    const pnl = hr.valueUsd != null ? hr.valueUsd - (hr.costUsd || 0) + (hr.soldUsd || 0) : null;
    rows = `<div class="kv"><span>持仓价值（估）</span><b>${usd(hr.valueUsd)}${hr.valueBnb != null ? ` <small class="muted">≈ ${bnb(hr.valueBnb)} BNB</small>` : ''}</b></div>
    <div class="kv"><span>盈亏</span>${hr.costUsd || hr.soldUsd ? sgn(pnl) : '<b>—</b>'}</div>
    <div class="kv"><span>累计买入 / 卖出</span><b>${usd(hr.costUsd || 0)} / ${usd(hr.soldUsd || 0)}</b></div>`;
  } else if (LIVE()) {
    amt = 0; rows = '<div class="kv"><span>持仓</span><b class="muted">持仓快照里没有这个币</b></div>';
  } else {
    amt = sum('amount'); const val = sum('valueBnb'), buyB = sum('boughtBnb'), sold = sum('soldBnb'), pnl = val + sold - buyB;
    rows = `<div class="kv"><span>持仓价值（估）</span><b>${bnb(val)} BNB ≈ $${(val * S.bnbUsd).toFixed(2)}</b></div>
    <div class="kv"><span>盈亏</span><b class="${pnl >= 0 ? 'g' : 'r'}">${buyB ? (pnl >= 0 ? '+' : '') + bnb(pnl) + ' BNB' : '—'}</b></div>
    <div class="kv"><span>累计买入 / 卖回</span><b>${bnb(buyB)} / ${bnb(sold)} BNB</b></div>`;
  }
  $('#myPos').innerHTML = `<h4>我的仓位<span>${tag}</span></h4>
    <div class="kv"><span>持有代币</span><b>${K(amt)} ${esc(t.symbol)}</b></div>
    ${rows}
    ${amt > 0 ? `<div class="sellbtns">${[25, 50, 75, 100].map((p) => `<button data-qsell="${p}">卖 ${p}%</button>`).join('')}</div>` : ''}`;
}

function renderInfo(t) {
  if (!t) { $('#tokenInfo').innerHTML = ''; return; }
  const el = eligible(wallet(S.activeWallet), t);
  const box = (k, v) => `<div class="addrbox"><span>${k}</span><b data-copy="${v}" title="点击复制">${v}</b></div>`;
  $('#tokenInfo').innerHTML = `<h4>${t.platform === 'four' ? 'Binance Agent 专属代币信息' : t.platform === 'gang' ? (/^v3/.test(t.gangTrack || '') ? 'Gang V3 代币信息' : t.gangTrack === 'v2' ? 'Gang V2 代币信息' : 'Gang 代币信息') : t.platform === 'dex' ? '外盘代币信息' : 'Flap Agent 曲线代币信息'}</h4>
    ${box('代币', t.address)}${t.vault ? box(LIVE() ? 'Market' : 'Vault', t.vault) : ''}${t.creator ? box('创建者', t.creator) : ''}
    <div class="kv"><span>平台</span><b class="sans">${t.platform === 'four' ? 'OpenFour（four.meme）' : t.platform === 'gang' ? (/^v3/.test(t.gangTrack || '') ? `gang.fun V3（GangLaunchpad，报价币 ${esc(t.quote)}）${t.gangV3 ? ' · ' + esc(v3Tip(t)) : ''}` : t.gangTrack === 'v2' ? `gang.fun V2（报价币 ${esc(t.quote)}，买卖要先换币，非原子）` : 'gang.fun（Agent ID 专属，合约 0x315B…23A7）') : t.platform === 'dex' ? `普通外盘代币（最深池 ${esc(t.preset.replace(/^外盘代币 · /, ''))}，币安聚合买卖）` : 'Flap（flap.sh）'}</b></div>
    <div class="kv"><span>预设</span><b class="sans">${esc(t.preset || '')} <span class="muted mono">${t.presetId}</span></b></div>
    <div class="kv"><span>计价资产</span><b>${esc(t.quote)}${t.quote !== 'BNB' ? '（Core 同笔兑换）' : ''}</b></div>
    <div class="kv"><span>状态</span><b class="sans ${t.stage === 'curve' ? 'b' : t.stage === 'dex' ? 'g' : 'r'}">${t.stage === 'curve' ? `内盘 ${t.progress.toFixed(2)}%` : t.platform === 'dex' ? `外盘 · 流动性 $${Math.round(t.liqUsd || 0).toLocaleString()}` : t.stage === 'dex' ? '已迁移 PancakeSwap' : '已撤池'}</b></div>
    <div class="kv"><span>交易资格</span><b class="sans ${el.ok ? 'g' : 'r'}">${el.ok ? '你的钱包可交易' : '你的钱包' + el.why}</b></div>
    ${LIVE() ? `<div class="kv"><span>已筹 / 上限</span><b>${amt(t.raised)} / ${amt(t.target)} ${esc(t.quote)}</b></div>`
      : `<div class="kv"><span>总量 / 内盘出售</span><b>1.00B / 800M</b></div><div class="kv"><span>每钱包上限</span><b>${t.platform === 'four' || t.platform === 'gang' ? '总量 1%（10M）' : '不限'}</b></div>`}`;
}

let qTimer;
function refreshQuote() {
  clearTimeout(qTimer);
  qTimer = setTimeout(async () => {
    const t = S.tokens.get(S.selected); if (!t) return;
    const wid = [...S.selWallets][0] || S.activeWallet;
    if (S.side === 'buy' && S.amtMode === 'pct') {
      const v = parseFloat($('#amount').value);
      try { const c = v > 0 ? await api(`/api/cost-for-pct?wallet=${wid}&token=${t.address}&pct=${v}&slippage=${S.slippage}`) : { bnb: 0 }; S.pctBnb = c.bnb || 0; S.pctNote = c.note || (c.capReached ? c.error : ''); } catch { S.pctBnb = 0; S.pctNote = ''; }
    }
    const amount = orderAmount(wid);
    try {
      const q = await api(`/api/preview?wallet=${wid}&token=${t.address}&side=${S.side}&amount=${amount || 0}&slippage=${S.slippage}`);
      $('#route').textContent = '✦ ' + q.route; $('#route').title = q.route;
      S.fund = S.side === 'buy' ? q.fund || null : null; S.fundFor = t.address;   // BNB 不够时后端算好的付款方式（用哪个计价币）
      const sym = S.side === 'buy' ? t.symbol : 'BNB';
      const f = (v) => (S.side === 'buy' ? K(v) : bnb(v, 6));
      $('#quote').innerHTML = q.out != null ? `
        ${S.side === 'buy' && S.amtMode === 'pct' ? `<div><span>需花费</span><b>${bnb(amount, 6)} BNB${S.pctNote ? ` <span style="color:#8fb3d9">ⓘ ${esc(S.pctNote)}</span>` : ''}</b></div>` : ''}<div><span>预计获得</span><b>${f(q.out)} ${esc(sym)}</b></div><div><span>最少获得</span><b>${f(q.minOut)} ${esc(sym)}</b></div>
        <div><span>手续费</span><b>${bnb(q.feeBnb, 6)} BNB</b></div><div><span>税率 买/卖</span><b class="${taxHi(t) ? 'r' : ''}">${pctTxt(t.buyFeePct)} / ${pctTxt(t.sellFeePct)}</b></div>${S.side === 'buy' ? (() => { const rt = roundTrip(t, S.amtMode === 'pct' ? S.pctBnb : amount); return rt ? `<div><span>买入再卖出预计损耗</span><b class="${rt.pct >= 5 ? 'r' : ''}">${bnb(rt.cost, 5)} BNB（${rt.pct.toFixed(1)}%）</b></div>` : ''; })() : ''}`
        : '<div><span>预计获得</span><b>—</b></div><div><span>最少获得</span><b>—</b></div><div><span>手续费</span><b>—</b></div><div><span>—</span><b>—</b></div>';
      if (S.fund) $('#quote').insertAdjacentHTML('afterbegin', `<div><span>付款</span><b style="color:${S.fund.mode === 'none' ? '#f6465d' : '#f0b90b'};white-space:normal">${esc(S.fund.note)}</b></div>`);
    } catch { /* ignore */ }
  }, 150);
}
setInterval(refreshQuote, 1500);

function orderAmount(wid) {
  const v = parseFloat($('#amount').value);
  if (!(v > 0)) return 0;
  if (S.side === 'sell') return Math.min(100, v);
  return S.amtMode === 'bnb' ? v : (S.pctBnb || 0);
}

async function submitOrder({ token = S.selected, side = S.side, wallets = [...S.selWallets], amountFor = orderAmount, slots = null, label = null } = {}) {
  const t = S.tokens.get(token); if (!t) return;
  if (MW() && !onWallets().length) return toast({ status: 'failed', symbol: t.symbol, reason: '没有钱包参与下单：在顶栏钱包菜单或下单区的钱包按钮里打开「参与下单」' });
  if (side === 'buy' && S.amtMode === 'pct' && amountFor === orderAmount) {   // 下单前按最新报价重新换算，避免用到旧的金额
    const v = parseFloat($('#amount').value);
    let c = { bnb: 0 };
    try { c = v > 0 ? await api(`/api/cost-for-pct?wallet=${wallets[0] || S.activeWallet}&token=${token}&pct=${v}&slippage=${S.slippage}`) : c; } catch { /* 下面按 0 处理 */ }
    S.pctBnb = c.bnb || 0;
    if (!S.pctBnb && c.capReached) return note(`${t.symbol}：${c.error}，没有下单`, 'info');
    if (c.note) note(`${t.symbol}：${c.note}`, 'info');
  }
  // 多钱包 + 按总量 % 买：每个钱包各买 X%，由各自后端报价算 BNB
  const pctMW = side === 'buy' && S.amtMode === 'pct' && amountFor === orderAmount && MW() ? parseFloat($('#amount').value) || 0 : 0;
  const items = wallets.map((w) => ({ w, amount: amountFor(w) })).filter((x) => x.amount > 0);
  if (!items.length) return toast({ status: 'failed', reason: side === 'buy' ? '请输入买入金额' : '请输入卖出比例', symbol: t.symbol });
  const go = async () => {
    const btn = $('#submit'); btn.classList.add('busy');
    topPop({ status: 'pending', side, symbol: t.symbol, amountIn: side === 'buy' ? items[0].amount : items[0].amount });
    try { await Promise.all(items.map((x) => api('/api/order', { wallets: [x.w], token, side, amount: x.amount, slippage: S.slippage, symbol: t.symbol, ...(pctMW > 0 ? { pctSupply: pctMW } : {}), ...(slots ? { slots } : {}) }))); }
    catch (e) { toast({ status: 'failed', reason: e.message, symbol: t.symbol }); topPop({ status: 'failed', side, reason: e.message, symbol: t.symbol }); }
    btn.classList.remove('busy');
  };
  if (S.fast) return go();
  $('#confirmBody').innerHTML = `
    <div class="kv"><span>代币</span><b>${esc(t.symbol)}</b></div>
    <div class="kv"><span>方向</span><b class="${side === 'buy' ? 'g' : 'r'}">${side === 'buy' ? '买入' : '卖出'}</b></div>
    ${items.map((x) => `<div class="kv"><span>${label || wallet(x.w).label}</span><b>${side === 'buy' ? x.amount + ' BNB' : x.amount + '%'}</b></div>`).join('')}
    <div class="kv"><span>滑点</span><b>${S.slippage}%</b></div>
    <div class="kv"><span>税率 买/卖</span><b class="${taxHi(t) ? 'r' : ''}">${pctTxt(t.buyFeePct)} / ${pctTxt(t.sellFeePct)}</b></div>
    ${taxHi(t) && side === 'buy' ? (() => { const rt = roundTrip(t, items[0]?.amount); return `<div class="note" style="color:#f6465d">⚠ 当前税率 买 ${pctTxt(t.buyFeePct)} / 卖 ${pctTxt(t.sellFeePct)}${rt ? `，买入再卖出预计损耗约 ${rt.pct.toFixed(1)}%（${bnb(rt.cost, 5)} BNB，不含价格变动）` : ''}</div>`; })() : ''}
    ${REAL() ? `<div class="note" style="color:var(--red,#f6465d)">真实交易：会用你的币安 Agentic 钱包上链，花费真实 BNB，可能亏损，无法撤回。单笔上限 ${S.baw.maxTradeBnb || '不限'} BNB。${S.tokens.get(token)?.quote && S.tokens.get(token).quote !== 'BNB' && side === 'buy' ? `路径：BNB→${esc(S.tokens.get(token).quote)}→Portal.buyWithQuote，会有 2～4 笔交易。` : ''}</div>` : ''}
    ${side === 'buy' && S.fund && S.fundFor === token ? `<div class="note" style="color:${S.fund.mode === 'none' ? '#f6465d' : '#f0b90b'}">${S.fund.mode === 'none' ? '⚠ ' : '💱 '}${esc(S.fund.note)}</div>` : ''}
    <div class="note">打开「极速模式（免确认）」可跳过此确认，点击即直接提交链上请求。</div>
    <button class="big-btn ${side === 'buy' ? '' : 'sell'}" id="confirmGo">确认${side === 'buy' ? '买入' : '卖出'}</button>`;
  $('#confirmModal').classList.remove('hidden');
  $('#confirmGo').onclick = () => { $('#confirmModal').classList.add('hidden'); go(); };
}

// 普通提示（不是订单结果）
// 普通提示：kind='ok' 绿色，'info' 灰蓝色（自动调整金额之类，不是失败）
function note(text, kind = 'ok') { const el = document.createElement('div'); el.className = 'toast' + (kind === 'info' ? ' info' : ''); el.innerHTML = kind === 'info' ? `<span style="color:#8fb3d9">ⓘ ${esc(text)}</span>` : `<b class="g">${esc(text)}</b>`; $('#toasts').prepend(el); setTimeout(() => el.remove(), 5000); }

// 把链上 / baw 的英文报错翻成中文
const ERR_ZH = [
  [/wallet cap|max.*per wallet|exceeds? .*cap/i, '已达到单个钱包的持仓上限，不能再买了'],
  [/slippage is not enough/i, '价格变动超过滑点，没有成交（门槛盘也可能是这个钱包已买满每地址 2% 上限，再买换不出币）'],   // 聚合器原话，以前被下一条的「not enough」当成余额不足
  [/insufficient funds|insufficient balance|not enough (bnb|balance|funds|gas)/i, '余额不足'],
  [/slippage|too little received|min(imum)? ?out|INSUFFICIENT_OUTPUT/i, '价格变动超过滑点容忍度，请调大滑点后重试'],
  [/not whitelisted|whitelist/i, '钱包不在白名单'],
  [/deadline|expired/i, '交易超时过期'],
  [/balance is insufficient|insufficient balance|insufficient funds|exceeds balance|余额不足/i, '余额不足：要卖 / 要花的数量比钱包里的多（可能是刚卖过、余额还没刷新，或者 gas 用的 BNB 不够），这次没有成交'],
  [/min(imum)?\s*(order|amount|trade)|too small|below (the )?min|dust/i, '金额太小，低于最小下单额'],
  [/liquidity|no route|route not found|cannot find (a )?route/i, '找不到兑换路径或流动性不足'],
  [/slippage|price impact|INSUFFICIENT_OUTPUT/i, '价格变动超过滑点，没有成交（可以调大滑点再试）'],
  [/risk|rejected by risk|abnormal|AutoReject/i, '被币安风控拒绝（钱包设置为自动拒绝异常交易时会这样）'],
  [/daily limit|quota|exceed(ed)? (the )?limit/i, '超过币安钱包的每日额度'],
  [/nonce/i, '交易序号冲突，请稍后重试'],
  [/user rejected|denied|cancel/i, '已取消'],
  [/already in progress|same address on this network/i, '钱包里有一笔交易还在等待（多半要在币安 App 里确认或拒绝），处理完再下单，这次没有发出交易'],
  [/timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed|network/i, '网络超时，请重试'],
  [/rate limit|429|too many requests/i, '请求太频繁，请稍后重试'],
  [/403|forbidden/i, '节点拒绝了请求'],
  [/not (signed|logged) in|unauthori[sz]ed|401|session/i, '币安钱包未登录或登录已过期'],
  [/trading (not|isn't) (open|started)|not started|paused/i, '还没开盘或交易已暂停'],
  [/migrat|graduat|curve (is )?(full|completed|closed)/i, '内盘已满或已迁移'],
  [/gas/i, 'Gas 不足或估算失败'],
];
// 已知的合约自定义错误码（4 字节）→ 中文
const ERR_CODE_ZH = { '0x8698bf37': '内盘合约里没有这个币（UnknownToken），多半是终端把盘认错了版本、发到了别的 Gang 合约，没有成交' };
function zhErr(msg) {
  const s = String(msg || ''); if (!s || /[\u4e00-\u9fa5]/.test(s) && !/[A-Za-z]{6,}/.test(s.replace(/BNB|baw|Four|Flap|Agent|Portal|PancakeSwap/g, ''))) return s;
  const sim = /simulation failed|execution reverted|revert/i.test(s);
  for (const [re, zh] of ERR_ZH) if (re.test(s)) return (sim ? '交易预演失败：' : '') + zh;
  const m = s.match(/reverted:?\s*([^"\n(]+)/i), why = m?.[1].trim(), code = s.match(/data="(0x[0-9a-f]{8})/i)?.[1];   // 自定义错误没有原因文字，只有 4 字节错误码
  if (sim) return '交易预演失败，合约拒绝' + (why ? `（${why}）` : ERR_CODE_ZH[code] ? `：${ERR_CODE_ZH[code]}` : code ? `（未知合约错误 ${code}）` : '');
  return '下单失败：' + s.slice(0, 120);
}

// 顶部居中的买卖弹窗：提交时显示「提交中」，结果回来后变成成交 / 失败。
// 每行开头是钱包名；多钱包一起下单时每个钱包一行（同一次点击的结果合在一个弹窗里）。卖出时钱包里没有这个币 = 灰色「无余额」，不算失败
let popTimer; const POP = new Map();
function topPop(o) {
  let el = $('#topPop'); if (!el) { el = document.createElement('div'); el.id = 'topPop'; document.body.appendChild(el); }
  if (!o.wallet) POP.clear(); else POP.delete('_');   // 没有钱包名 = 页面刚提交（新的一次点击）；钱包结果回来后去掉「提交中」那行
  const now = Date.now(); for (const [k, v] of POP) if (v.o.status !== 'pending' && now - v.at > 10_000) POP.delete(k);
  POP.set(o.wallet ? `${o.wallet}|${o.token || ''}` : '_', { o, at: now });   // 按钱包名：本钱包的订单推送时没有 walletSlot、接口返回时有，以前会算成两行（同一个失败显示两遍）
  const row = (o) => {
    const buy = o.side === 'buy', act = buy ? '买入' : '卖出';
    const amt = o.amountIn != null ? (buy ? `${bnb(o.amountIn)} BNB` : `${o.amountIn}%`) : '';
    const cls = o.noBalance ? 'nobal' : o.status === 'pending' ? 'pend' : o.status === 'filled' ? (buy ? 'buy' : 'sell') : o.status === 'dry_run' ? 'dry' : 'err';
    const bc = o.status === 'pending' && o.stage === 'broadcast' && o.pendingTx;
    const title = o.noBalance ? '无余额' : bc ? (/授权/.test(o.steps?.at(-1)?.name || '') ? '授权已发出，等待上链…' : '已发出，等待上链…') : o.status === 'pending' ? `${act}已提交，处理中…` : o.status === 'filled' ? `${act}成功` : o.status === 'dry_run' ? `${act}已报价（未上链）` : `${act}失败`;
    const detail = o.noBalance ? '' : o.status === 'failed' ? esc(zhErr(o.reason)) : o.status === 'filled'
      ? (buy ? `${amt} → ${K(o.out || 0)} ${esc(o.symbol)}` : `${amt} → ${o.out != null ? bnb(o.out) + ' BNB' : '?'}`) : amt;
    return { cls, html: `<div class="tp-r ${cls}"><b>${o.wallet ? esc(o.wallet) + ' · ' : ''}${title}</b><span>${esc(o.symbol || '')}</span>${detail ? `<span class="mono">${detail}</span>` : ''}${o.tx ? txLink(o.tx) : bc ? txLink(o.pendingTx) : ''}</div>` };
  };
  const rows = [...POP.values()].map((v) => row(v.o)), cs = rows.map((r) => r.cls);
  el.className = 'toppop show ' + (cs.includes('err') ? 'err' : cs.includes('pend') ? 'pend' : cs.find((c) => c !== 'nobal') || 'nobal');
  el.innerHTML = rows.map((r) => r.html).join('');
  clearTimeout(popTimer);
  if (![...POP.values()].some((v) => v.o.status === 'pending')) popTimer = setTimeout(() => { el.classList.remove('show'); POP.clear(); }, cs.includes('err') ? 6000 : 4000);
}

// 路由自检报警（engine/live/routeGuard.js）：某个币的盘型 / pad 和链上来源对不上，买卖可能发到错误的合约。页面顶部红条，点 × 关掉
function routeAlert(a) {
  let box = $('#routeAlert');
  if (!box) {
    box = document.createElement('div'); box.id = 'routeAlert';
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:200;background:#b3261e;color:#fff;font-size:13px;line-height:1.5;padding:6px 40px 6px 12px;box-shadow:0 2px 8px rgba(0,0,0,.4);max-height:40vh;overflow:auto';
    const x = document.createElement('button'); x.textContent = '×'; x.title = '关闭';
    x.style.cssText = 'position:absolute;top:4px;right:8px;background:none;border:0;color:#fff;font-size:18px;cursor:pointer';
    x.addEventListener('click', () => box.remove());
    const list = document.createElement('div'); list.className = 'ra-list';
    box.append(x, list); document.body.append(box);
  }
  const row = document.createElement('div');
  row.innerHTML = `<b>⚠ 路由自检报警</b> · ${esc(a.where || '')} · <b>${esc(a.symbol || '?')}</b> <span class="mono">${esc(a.token || '')}</span> · ${esc((a.problems || []).join('；'))} · <span>修好前别买这个币</span>`;
  const list = box.querySelector('.ra-list'); list.prepend(row);
  while (list.children.length > 5) list.lastChild.remove();
}

function toast(o) {
  const el = document.createElement('div');
  const ok = o.status === 'filled';
  el.className = 'toast ' + (ok ? '' : o.status === 'dry_run' ? 'dry' : o.noBalance ? 'nobal' : 'err');
  const wn = o.wallet ? esc(o.wallet) + ' · ' : '';
  el.innerHTML = o.noBalance ? `<b class="muted">${wn}无余额</b> · ${esc(o.symbol || '')}<div class="muted">这个钱包没有持有，已跳过（没有发出交易）</div>`
    : o.status === 'dry_run'
    ? `<b class="y">已报价（未上链）</b> · ${esc(o.symbol)} · ${esc(o.wallet || '')} · <span class="mono">${o.latencyMs}ms</span><div class="mono muted">${o.side === 'buy' ? `${bnb(o.amountIn)} BNB → ${o.out != null ? K(o.out) : '?'}` : `${K(o.amountIn || 0)} → ${o.out != null ? bnb(o.out) : '?'} BNB`}</div><div class="muted">${esc(o.route || '')}</div><div class="steps">${o.steps.map((s) => `${esc(s.name)} ${s.ms}ms`).join(' → ')}</div>`
    : ok
    ? o.side === 'claim' ? `<b class="g">领取成功</b> · ${esc(o.symbol)} · ${K(o.out || 0)} 个代币${o.tx ? `<div>${txLink(o.tx)}</div>` : ''}`
    : `<b class="${o.side === 'buy' ? 'g' : 'r'}">${wn}${o.side === 'buy' ? '买入' : '卖出'}成交</b> · ${esc(o.symbol)} · <span class="mono">${o.latencyMs}ms</span><div class="mono muted">${o.side === 'buy' ? `${bnb(o.amountIn)} BNB → ${K(o.out || 0)}` : LIVE() ? `${o.amountIn}% → ${o.out != null ? bnb(o.out) + ' BNB' : '?'}` : `${K(o.amountIn)} → ${bnb(o.out)} BNB`}</div>${o.tx ? `<div>${txLink(o.tx)}</div>` : ''}${o.reason ? `<div class="y">${esc(o.reason)}</div>` : ''}<div class="steps">${o.steps.map((s) => `${esc(s.name)} ${s.ms}ms`).join(' → ')}</div>`
    : `<b class="r">${wn}${o.side === 'buy' ? '买入失败' : o.side === 'sell' ? '卖出失败' : '失败'}</b> · ${esc(o.symbol || '')}<div class="muted">${esc(zhErr(o.reason))}</div>`;
  $('#toasts').prepend(el);
  setTimeout(() => el.remove(), REAL() ? 15000 : ok ? 5000 : 4000);
  while ($('#toasts').children.length > 3) $('#toasts').lastChild.remove();
}

/* ---------- 控件状态 ---------- */
function renderControls() {
  const c = S.config; if (!c) return;
  $('#btnSound').classList.toggle('off', !c.sound); $('#btnSound').title = `声音：${c.sound ? '开' : '关'}。出新币「叮咚」、成交提示音（战壕各列的小喇叭单独控制）`;
  $('#btnBell').classList.toggle('off', !c.notify); $('#btnBell').title = `新币通知：${c.notify ? '开' : '关'}。页面在后台时，当前平台出新币弹系统通知`;
  if (document.activeElement !== $('#quickBuy')) $('#quickBuy').value = c.quickBuy;
  const gas = { normal: '普通', high: 'HIGH', turbo: '极速' }[S.settings.gas] || 'HIGH';
  const autos = ['four', 'flap'].filter((p) => c[p].enabled).map((p) => (p === 'four' ? 'Four' : 'Flap'));
  $('#settingsSummary').textContent = LIVE() ? `${REAL() ? '实盘 · 手动真实下单' : '实盘行情 · 只报价'} · 自动买只报价 · 🎯 自动买 ${c.paused ? '已暂停' : autos.join('/') || '关'}` : `${S.settings.execPath === 'ai' ? 'AI 思考后提交' : '直接提交'} · ${S.settings.multiRpc ? '多 RPC 加速' : '单 RPC'} · 外盘 ${gas} · 🎯 自动买 ${c.paused ? '已暂停' : autos.join('/') || '关'}`;
}

/* ---------- 交易设置弹窗 ---------- */
function renderSettings() {
  const c = S.config; const p = S.settingsPlat; const pc = c[p]; const u = S.usage[p] || { spent: 0, budget: 0, lastHour: 0, hourlyMax: 0 };
  const four = p === 'four';
  const notWl = pc.wallets.map(wallet).filter((w) => four && !(w.agentId && w.whitelisted));
  const f = (label, key, val, step = 'any') => `<label class="field"><span>${label}</span><input type="number" step="${step}" data-cfg="${p}.${key}" value="${val}" /></label>`;
  const tgl = (key, on, label = '开启') => `<label class="tgl"><input type="checkbox" data-cfgb="${key}" ${on ? 'checked' : ''}/><i></i>${label}</label>`;
  const curve = S.snipeCurve.length ? S.snipeCurve : [[0, 50.3], [0.5, 33.8], [1, 20.6], [1.5, 13.8], [2, 9.9], [2.5, 5.7], [3, 1.96]];
  $('#settingsBody').innerHTML = `
  <div class="note" style="margin-bottom:8px">自动买入已移除：程序不会再自动下任何买单，只有你手动点的买入才会下单。</div>

  ${LIVE() ? '' : `<div class="box">
    <div class="box-h">⛽ Gas 与加速</div>
    <div class="note">交易本质就是一个链上请求，Agent 慢都慢在提交前的流程。这里预先构建好交易模板、本地缓存 nonce，命中后只做「填参数 → 签名 → 多节点同时广播」。</div>
    <div><div class="note" style="margin-bottom:6px">Gas 档位（外盘 / 内盘通用）</div>
      <div class="seg" id="setGas">${[['normal', '普通 0.1 gwei'], ['high', 'HIGH 1 gwei'], ['turbo', '极速 3 gwei']].map(([k, l]) => `<button data-gas="${k}" class="${S.settings.gas === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <label class="tgl"><input type="checkbox" data-set="multiRpc" ${S.settings.multiRpc ? 'checked' : ''}/><i></i>多 RPC 并发广播（48 Club + GetBlock + bsc.publicnode.com）</label>
    <div><div class="note" style="margin-bottom:6px">执行路径</div>
      <div class="seg" id="setExec"><button data-exec="direct" class="${S.settings.execPath !== 'ai' ? 'active' : ''}">直接提交（跳过 AI 思考）</button><button data-exec="ai" class="${S.settings.execPath === 'ai' ? 'active' : ''}">AI 思考 → 确认 → 执行（对照）</button></div></div>
  </div>`}

  <div class="box">
    <div class="box-h">📤 自动卖出<span class="spacer"></span>${tgl('exit.enabled', c.exit.enabled)}</div>
    <div class="fgrid">
      <label class="field"><span>止盈 %</span><input type="number" data-cfg="exit.takeProfitPct" value="${c.exit.takeProfitPct}" /></label>
      <label class="field"><span>止盈时卖出 %</span><input type="number" data-cfg="exit.takeProfitSellPct" value="${c.exit.takeProfitSellPct}" /></label>
      <label class="field"><span>止损 %</span><input type="number" data-cfg="exit.stopLossPct" value="${c.exit.stopLossPct}" /></label>
      <label class="field"><span>止盈后移动止损回撤 %</span><input type="number" data-cfg="exit.trailingPct" value="${c.exit.trailingPct}" /></label>
      <label class="field"><span>最长持仓（分钟，0 = 不限）</span><input type="number" data-cfg="exit.maxHoldMin" value="${c.exit.maxHoldMin}" /></label>
    </div>
  </div>

  ${LIVE() ? `<div class="box">
    <div class="box-h">🔌 实盘行情连接</div>
    <div class="kv"><span>Flap Agent Curve Reader</span><b class="sans ${S.net.curve?.connected ? 'g' : 'r'}">${S.net.curve?.connected ? `已连接 · ${S.net.curve.total} 个市场 · 轮询 ${S.net.curve.lastPollMs}ms` : esc(S.net.curve?.lastError || '连接中')}</b></div>
    <div class="kv"><span>shrine 新盘推送 / 成交流</span><b class="sans">${S.net.shrine?.launch?.connected ? '<span class="g">新盘 ✓</span>' : '<span class="r">新盘 ✗</span>'} · ${S.net.shrine?.stream?.connected ? '<span class="g">成交 ✓</span>' : '<span class="r">成交 ✗</span>'}</b></div>
    <div class="kv"><span>BSC RPC</span><b class="sans ${S.net.rpcError ? 'r' : 'g'}">${S.net.rpcError ? esc(S.net.rpcError) : `#${S.block.toLocaleString('en-US')} · ${S.net.rpc}ms`}</b></div>
    <div class="kv"><span>币安 Agentic Wallet（baw）</span><b class="sans ${S.baw?.connected ? 'g' : 'r'}">${S.baw?.connected ? '已连接（只读）' : esc(S.baw?.error || '未连接')}</b></div>
    ${REAL() ? `<div class="kv"><span>实盘单笔上限 (BNB)</span><b class="sans"><input type="number" min="0" step="0.01" id="maxTradeBnb" value="${S.baw.maxTradeBnb || ''}" placeholder="不限" style="width:90px"/></b></div>
    <div class="note">每笔手动买入最多花这么多 BNB，填 0 或留空表示不限。改完立即生效，重启后也保留。</div>
    <div class="warn-box">手动买卖会通过 baw 真实上链；自动买 / 自动卖命中后只记录报价，不会下单。</div>`
    : '<div class="warn-box">当前是只报价模式：下单只做报价和预演，不会提交链上交易。</div>'}
  </div>` : `<div class="box">
    <div class="box-h">🧪 模拟钱包状态</div>
    ${S.wallets.map((w) => `<div class="inline" style="gap:14px"><span class="side" style="display:flex;gap:6px;align-items:center;width:70px"><i class="wav" style="background:${w.color};width:14px;height:14px"></i><b>${w.label}</b></span>
      <label class="tgl"><input type="checkbox" data-wflag="${w.id}:agentId" ${w.agentId ? 'checked' : ''}/><i></i>Agent ID</label>
      <label class="tgl"><input type="checkbox" data-wflag="${w.id}:whitelisted" ${w.whitelisted ? 'checked' : ''}/><i></i>白名单</label>
      <span class="spacer"></span><button class="optbtn" data-faucet="${w.id}">+5 BNB</button></div>`).join('')}
    <div class="note">推文提到：Four 前几个测试币（Test ~ Test4）只有官方测试地址在白名单，普通钱包都打不了，可以无视；开盘后所有 .ai 地址都会加入白名单。</div>
    <button class="optbtn" id="fakeLaunch" style="align-self:flex-start">＋ 立即发射一个 Four 新币（测试狙击）</button>
  </div>`}`;
  renderRecords();
}
function renderRecords() {
  const el = $('#records'); if (!el) return;
  const rs = S.records.filter((r) => r.platform === S.settingsPlat);
  el.innerHTML = rs.length ? rs.slice(0, 40).map((r) => `<div><span class="dim mono">${hms(r.ts)}</span> <span class="${r.status === 'buy' ? 'g' : r.status === 'fail' ? 'r' : ''}">${esc(r.symbol)}</span> ${esc(r.msg)}</div>`).join('') : '暂无记录';
}
const setPath = (obj, path, v) => { const ks = path.split('.'); const root = {}; let o = root; ks.slice(0, -1).forEach((k) => (o = o[k] = {})); o[ks[ks.length - 1]] = v; return root; };
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
async function patchCfg(path, v) { S.config = await api('/api/config', setPath({}, path, v)); renderControls(); }

/* ---------- 事件绑定 ---------- */
// 点代币名复制代号（详情页标题、战壕卡片）。捕获阶段处理并阻止冒泡，免得点卡片名字顺带打开详情 / 买入
// 先在点击当下同步用 textarea + execCommand 复制（不依赖页面焦点 / 剪贴板权限，第一次点也稳），失败再试 navigator.clipboard
async function copyText(v) {
  const prev = document.activeElement, ta = document.createElement('textarea'); ta.value = v; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); try { prev?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  if (ok) return true;
  try { await navigator.clipboard.writeText(v); return true; } catch { return false; }
}
async function copyOrThrow(v) { if (!(await copyText(v))) throw new Error('copy failed'); }
// 详情页头部 / 战壕卡片 / 一键买卖浮窗里的复制按钮会被频繁整块重画：按下和松开之间按钮换了新元素，click 就丢了（「点第一下没反应」）。
// 所以这几个在按下（pointerdown）时就复制，随后的 click 吞掉，免得点卡片名字顺带打开详情 / 买入
const COPY_SEL = '[data-cacopy],[data-ctick],[data-copy]';
document.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0) return; const el = e.target.closest(COPY_SEL); if (!el) return;
  e.stopPropagation(); e.preventDefault();
  const d = el.dataset;
  if (d.ctick != null) { const v = d.ctick; return (await copyText(v)) ? note(`已复制 ${v}`) : note(`复制失败，请手动选中 ${v}`, 'info'); }
  if (d.copy != null) { return (await copyText(d.copy)) ? note(`已复制 ${short(d.copy)}`) : note('复制失败，请手动选中地址', 'info'); }
  caCopy(d.cacopy);
}, true);
document.addEventListener('click', (e) => { if (e.target.closest(COPY_SEL)) { e.stopPropagation(); e.preventDefault(); } }, true);
// CA 旁的 🔍：在新标签页打开 X（推特）按 CA 搜索的「最新」结果。和复制按钮一样在按下时处理，不进详情、不触发买入
const xsUrl = (a) => `https://x.com/search?q=${encodeURIComponent(a)}&f=live`;
function xsBtn(a, cls = '') { return a ? `<button class="xs-btn ${cls}" data-xsearch="${esc(a)}" title="在 X 搜索这个 CA：${esc(a)}"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>` : ''; }
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; const el = e.target.closest('[data-xsearch]'); if (!el) return;
  e.stopPropagation(); e.preventDefault(); window.open(xsUrl(el.dataset.xsearch), '_blank', 'noopener');
}, true);
document.addEventListener('click', (e) => { if (e.target.closest('[data-xsearch]')) { e.stopPropagation(); e.preventDefault(); } }, true);
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-qp],[data-mwchip],[data-qb],[data-a],[data-p],[data-s],[data-a2],[data-w],[data-copy],[data-sell],[data-qsell],[data-faucet],[data-ext],[data-close],[data-sp],[data-setw],[data-fee],[data-mode],[data-q],[data-gas],[data-exec],#fakeLaunch');
  if (!el) return;
  const d = el.dataset;
  if (d.qp) { e.stopPropagation(); e.preventDefault(); return pulseBuy1(d.qp); }
  if (d.qb) { e.stopPropagation(); const amt = S.config?.quickBuy || 0.1; S.fast = S.fast; return submitQuick(d.qb, amt); }
  if (el.closest('#walletMenu') && d.w) { S.activeWallet = d.w; $('#walletMenu').classList.add('hidden'); return scheduleRender(); }
  if (el.closest('#wchips') && d.mwchip) {   // 多钱包：切换「参与下单」（服务器上的同一个开关）
    const slot = Number(d.mwchip), w = S.walletsInfo.find((x) => x.slot === slot); el.classList.add('busy');
    api('/api/wallets', { slot, on: !w?.on }).then((v) => { S.walletsInfo = v; note(`${w?.agentId || w?.label || '钱包'} ${!w?.on ? '参与下单' : '不参与下单'}`); renderAuth(); scheduleRender(); renderRight(); renderQB(); }).catch((err) => toast({ status: 'failed', symbol: '钱包', reason: err.message })).finally(() => el.classList.remove('busy'));
    return;
  }
  if (el.closest('#wchips') && d.w) { S.selWallets.has(d.w) ? S.selWallets.delete(d.w) : S.selWallets.add(d.w); renderRight(); return refreshQuote(); }
  if (d.a && !el.closest('#amtMode')) { e.preventDefault(); return select(d.a); }
  if (el.closest('#presets') && d.p) { $('#amount').value = d.p; return refreshQuote(); }
  if (el.closest('#sideTabs')) { S.side = d.s; $$('#sideTabs button').forEach((b) => b.classList.toggle('active', b === el)); $('#amount').value = ''; renderRight(); return refreshQuote(); }
  if (d.copy) { navigator.clipboard?.writeText(d.copy); return toast({ status: 'filled', side: 'buy', symbol: '已复制', wallet: short(d.copy), latencyMs: 0, amountIn: 0, out: 0, steps: [] }); }
  if (d.claim) { e.stopPropagation(); el.disabled = true; el.textContent = '领取中…'; try { await api('/api/claim', { market: d.claim }); } catch (err) { toast({ status: 'failed', symbol: '领取', reason: err.message }); } return; }
  if (d.sell) { const [w, tk, pct] = d.sell.split(':'); return api('/api/order', { wallets: [w], token: tk, side: 'sell', amount: +pct, slippage: S.slippage }); }
  if (d.qsell) { return submitOrder({ side: 'sell', amountFor: () => +d.qsell, wallets: LIVE() ? [S.activeWallet] : S.wallets.map((w) => w.id).filter((w) => S.positions.some((p) => p.walletId === w && p.token === S.selected && p.amount > 0)) }); }
  if (d.faucet) { S.wallets = await api(`/api/wallet/${d.faucet}`, { faucet: 5 }); scheduleRender(); return; }
  if (d.ext) {
    e.preventDefault();
    if (!LIVE()) return toast({ status: 'failed', symbol: '模拟盘', reason: '模拟代币没有真实链上页面' });
    const t = S.tokens.get(S.selected); if (!t) return;
    const url = { four: t.platform === 'four' ? `https://four.meme/token/${t.address}` : t.platform === 'gang' ? `https://gang.fun/token/${t.address.toLowerCase()}` /* Gang（老盘和 V2）：直接打开这个币在 gang.fun 的页面 */ : t.platform === 'dex' ? `https://dexscreener.com/bsc/${t.address}` : t.source === 'flap-nft' ? `https://flap.sh/bnb/${t.address}/taxinfo?lang=zh` /* 门槛盘：直接打开 Flap 税收详情 */ : 'https://flap.sh/apps/agent-bonding-curve?lang=zh' /* Flap：打开 Agent Bonding Curve 页面 */, bsc: `https://bscscan.com/token/${t.address}`, gmgn: `https://gmgn.ai/bsc/token/${t.address}` }[d.ext];
    return window.open(url, '_blank', 'noopener');
  }
  if (d.close !== undefined) return el.closest('.modal').classList.add('hidden');
  if (d.sp) { S.settingsPlat = d.sp; return renderSettings(); }
  if (d.setw) { const ws_ = new Set(S.config[S.settingsPlat].wallets); ws_.has(d.setw) ? ws_.delete(d.setw) : ws_.add(d.setw); await patchCfg(`${S.settingsPlat}.wallets`, [...ws_]); return renderSettings(); }
  if (d.fee) { await patchCfg('four.antiSnipe.maxFeePct', +d.fee); return renderSettings(); }
  if (d.mode) { await patchCfg(`${S.settingsPlat}.mode`, d.mode); return renderSettings(); }
  if (d.q) { await patchCfg(`${S.settingsPlat}.quote`, d.q); return renderSettings(); }
  if (d.gas) { S.settings = await api('/api/settings', { gas: d.gas }); renderControls(); return renderSettings(); }
  if (d.exec) { S.settings = await api('/api/settings', { execPath: d.exec }); renderControls(); return renderSettings(); }
  if (el.id === 'fakeLaunch') { await api('/api/launch', { platform: 'four' }); return toast({ status: 'filled', side: 'buy', symbol: '已发射新币', wallet: '看事件日志', latencyMs: 0, amountIn: 0, out: 0, steps: [] }); }
});

// 战壕卡片「⚡ 买 1%」：按该卡片的代币反推 1% 筹码需要的 BNB（已扣掉当前持仓和单钱包上限），再真实下单
const pBusy = new Set();
// 快捷买入比例：Flap 先 2%，失败（且没广播/成交）再自动试一次 1%；Four / Gang 只买 1%
function qPct(t) { return t?.platform === 'flap' ? 2 : 1; }
const notSent = (o) => o && !o.tx && !(o.txs || []).length && !(o.steps || []).some((x) => /已广播|已提交|已上链/.test(x.name || ''));
async function pulseBuy1(token) {
  const t = S.tokens.get(token); if (!t || pBusy.has(token)) return;
  const ws = [...S.selWallets]; if (!ws.length) return topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: '没有选钱包' });
  pBusy.add(token);
  if (MW()) {   // 多钱包：「买 X%」= 每个钱包各买总量的 X%，每个钱包自己报价算 BNB（持仓上限、余额不足的钱包会单独提示并跳过）
    try {
      const pct = qPct(t); topPop({ status: 'pending', side: 'buy', symbol: t.symbol });
      const r = [].concat(await api('/api/order', { wallets: ws, token: t.address, side: 'buy', amount: 0, pctSupply: pct, slippage: S.slippage, via: 'quick' }));
      if (r.length && r.every((o) => o?.status === 'failed')) topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: (() => { const u = [...new Set(r.map((o) => o.reason).filter(Boolean))]; return u.length > 1 ? r.filter((o) => o.reason).map((o) => `${o.wallet || ''}：${o.reason}`).join('；') : u[0] || ''; })() });   // 两个钱包同一个原因只显示一次
    } catch (e) { topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: e.message }); }
    finally { pBusy.delete(token); }
    return;
  }
  try {
    const pcts = qPct(t) === 2 ? [2, 1] : [1];
    for (let n = 0; n < pcts.length; n++) {
      const pct = pcts[n], last = n === pcts.length - 1;
      topPop({ status: 'pending', side: 'buy', symbol: t.symbol });
      const c = await api(`/api/cost-for-pct?wallet=${ws[0]}&token=${t.address}&pct=${pct}&slippage=${S.slippage}`);
      if (!(c.bnb > 0)) {
        if (c.capReached) { $('#topPop')?.classList.remove('show'); note(`${t.symbol}：${c.error}，没有下单`, 'info'); return; }
        if (!last) { note(`${t.symbol}：买 ${pct}% 报价失败（${zhErr(c.error || '拿不到报价')}），改买 1%`, 'info'); continue; }
        return topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: c.error || '拿不到报价' });
      }
      if (c.note) note(`${t.symbol}：${c.note}`, 'info');
      topPop({ status: 'pending', side: 'buy', symbol: t.symbol, amountIn: c.bnb });
      let r, err;
      try { r = [].concat(await api('/api/order', { wallets: ws, token: t.address, side: 'buy', amount: c.bnb, slippage: S.slippage, via: 'quick' })); } catch (e) { err = e.message; }
      const f = err ? { reason: err } : r.find((o) => o?.status === 'failed');
      if (!f) return;
      // 只有第一次在广播前就失败（没有 tx、没有已广播步骤）、且是单钱包下单时才改 1% 重试，避免重复买入
      const safe = !err && ws.length === 1 && r.every((o) => o?.status === 'failed' && notSent(o));
      if (!last && safe) { note(`${t.symbol}：买 ${pct}% 失败（${zhErr(f.reason)}），自动改买 1%`, 'info'); continue; }
      return topPop({ ...f, status: 'failed', side: 'buy', symbol: t.symbol });
    }
  } catch (e) { topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: e.message }); }
  finally { pBusy.delete(token); }
}

async function submitQuick(token, amt) {
  const t = S.tokens.get(token); if (!t) return;
  const ws_ = [...S.selWallets];
  topPop({ status: 'pending', side: 'buy', symbol: t.symbol, amountIn: amt });
  try { await Promise.all(ws_.map((w) => api('/api/order', { wallets: [w], token, side: 'buy', amount: amt, slippage: S.slippage, via: 'quick' }))); }
  catch (e) { toast({ status: 'failed', reason: e.message, symbol: t.symbol }); }
}

document.addEventListener('change', async (e) => {
  const el = e.target; const d = el.dataset;
  if (d.cfg) await patchCfg(d.cfg, Number(el.value));
  else if (d.cfgs) await patchCfg(d.cfgs, el.value);
  else if (d.cfgb) { await patchCfg(d.cfgb, el.checked); renderSettings(); }
  else if (el.id === 'maxTradeBnb') { try { await api('/api/settings', { maxTradeBnb: el.value }); const st = await api('/api/state'); S.baw = st.baw; note(`已保存：实盘单笔上限 ${S.baw.maxTradeBnb || '不限'} BNB`); } catch (err) { toast({ status: 'failed', symbol: '设置', reason: err.message }); } }
  else if (d.set) { S.settings = await api('/api/settings', { [d.set]: el.checked }); renderControls(); }
  else if (d.wflag) { const [w, k] = d.wflag.split(':'); S.wallets = await api(`/api/wallet/${w}`, { [k]: el.checked }); renderSettings(); scheduleRender(); }
});

$('#amount').addEventListener('input', refreshQuote);
$('#submit').addEventListener('click', () => submitOrder());
$('#fastMode').addEventListener('change', (e) => { S.fast = e.target.checked; try { localStorage.fast = S.fast ? '1' : ''; } catch { /* */ } });
$('#sellToBnb').addEventListener('change', async (e) => { try { S.settings = await api('/api/settings', { sellToBnb: e.target.checked }); note(e.target.checked ? '已打开：卖出后自动换回 BNB' : '已关闭：卖出后报价币留在钱包'); } catch (err) { e.target.checked = !e.target.checked; toast({ status: 'failed', symbol: '设置', reason: err.message }); } });
$('#preApproveCap').addEventListener('change', async (e) => { try { S.settings = await api('/api/settings', { preApproveCap: e.target.checked }); note(e.target.checked ? '已打开：需要授权时授较大固定额度' : '已关闭：每次只授权本次数量'); } catch (err) { e.target.checked = !e.target.checked; toast({ status: 'failed', symbol: '设置', reason: err.message }); } });
// 授权管理：本程序授过的额度，逐条可撤销（approve 0，你点了才发）
async function openApprovals() {
  const wrap = document.createElement('div'); wrap.className = 'ui-dlg-back';
  wrap.innerHTML = `<div class="ui-dlg" style="width:min(560px,100%)"><div class="ui-h">🔑 授权管理</div><div class="ui-b" id="apBody"><div class="empty">正在读取链上授权额度…</div></div><div class="ui-f"><button class="ui-btn" data-apclose>关闭</button></div></div>`;
  document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => { document.removeEventListener('keydown', key, true); wrap.remove(); };
  const key = (e) => { if (e.key === 'Escape' && document.querySelectorAll('.ui-dlg-back').length === 1) close(); }; document.addEventListener('keydown', key, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  const render = async () => {
    let rows = []; try { rows = await api('/api/approvals'); } catch (e) { $('#apBody').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; return; }
    $('#apBody').innerHTML = rows.length ? `<table class="ttable"><tr><th class="l">代币</th><th class="l">授权给</th><th>当前额度</th><th>持有</th><th></th></tr>${rows.map((r) => `<tr><td class="l"><b>${esc(r.symbol || short(r.token))}</b><div class="hsub mono">${short(r.token, 6, 4)}</div></td><td class="l mono">${short(r.spender, 6, 4)}<div class="hsub">${r.kind === 'sell' ? '卖出用' : '报价币'}</div></td><td class="mono">${r.active ? K(+r.allowance) : '<span class="muted">0（已撤销 / 已用完）</span>'}</td><td class="mono">${K(+r.balance)}</td><td>${r.active ? `<button class="qb" style="color:var(--r)" data-aprevoke="${r.token}:${r.spender}">撤销</button>` : ''}</td></tr>`).join('')}</table><p class="ui-note">撤销 = 把这个额度改成 0，会发一笔链上交易（要一点 gas）。以后再卖出这个币时会重新授权。</p>`
      : '<div class="empty">本程序还没有授过额度。</div>';
  };
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-apclose]')) return close();
    const b = e.target.closest('[data-aprevoke]'); if (!b) return;
    const [token, spender] = b.dataset.aprevoke.split(':');
    if (!(await ui.confirm({ title: '撤销这个授权？', body: `<p>把 ${esc(short(token, 6, 4))} 对合约 ${esc(short(spender, 6, 4))} 的授权额度改成 0。</p>`, confirmText: '撤销', danger: true, after: '<p class="ui-note">会发一笔链上交易，要一点 gas。</p>' }))) return;
    b.disabled = true; b.textContent = '撤销中…';
    try { const o = await api('/api/approvals/revoke', { token, spender }); if (o.status === 'failed') toast(o); else note('已撤销授权'); } catch (err) { toast({ status: 'failed', symbol: '撤销授权', reason: err.message }); }
    render();
  });
  render();
}
$('#openApprovals').addEventListener('click', openApprovals);
$('#autoClaim').addEventListener('change', async (e) => { S.settings = await api('/api/settings', { autoClaim: e.target.checked }); });
$('#slip').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  let v = b.dataset.v;
  if (v === 'custom') { const x = await ui.prompt({ title: '自定义滑点', label: '滑点', value: S.slippage, suffix: '%' }); if (!x || !(+x > 0)) return; v = Math.min(99, +x); }
  S.slippage = +v; $$('#slip button').forEach((x) => x.classList.toggle('active', x === b)); $('#slipShow').textContent = S.slippage + '%'; refreshQuote();
});
$('#amtMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.amtMode = b.dataset.a; $$('#amtMode button').forEach((x) => x.classList.toggle('active', x === b)); S.pctBnb = 0; $('#amount').value = S.amtMode === 'pct' ? '2' : ''; renderRight(); refreshQuote(); });
$('#listTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.listTab = b.dataset.t; $$('#listTabs button').forEach((x) => x.classList.toggle('active', x === b)); syncUrl(); lastList = 0; scheduleRender(); });
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.id === 'listFunnel') { const k = LIST_COL[S.listTab]; if (k) tfModal(k); return; } const c = b.dataset.c; S.chips.has(c) ? S.chips.delete(c) : S.chips.add(c); b.classList.toggle('active'); lastList = 0; scheduleRender(); });
$('#intervals').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.interval = +b.dataset.i; S.ivManual = S.selected; S.ivPinned = true; try { localStorage.setItem('klineIv', String(S.interval)); } catch { /* ignore */ } savePrefs(); $$('#intervals button').forEach((x) => x.classList.toggle('active', x === b)); resetView(); drawChart(); });
$('#metric').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.metric = b.dataset.m; $$('#metric button').forEach((x) => x.classList.toggle('active', x === b)); savePrefs(); drawChart(); });
$('#bottomTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.bottomTab = b.dataset.b; $$('#bottomTabs button').forEach((x) => x.classList.toggle('active', x === b)); renderBottom(); });
$('#openSettings').addEventListener('click', openSettings);
function openSettings() { S.settingsPlat = S.platform; renderSettings(); $('#settingsModal').classList.remove('hidden'); }
$('#btnSound').addEventListener('click', () => patchCfg('sound', !S.config.sound));
$('#btnBell').addEventListener('click', () => { if (!S.config.notify && window.Notification) Notification.requestPermission(); patchCfg('notify', !S.config.notify); });
$('#quickBuy').addEventListener('change', (e) => { const v = +e.target.value; if (v > 0) patchCfg('quickBuy', v); lastList = 0; });
$('#loginBody').addEventListener('click', async (e) => { const b = e.target.closest('[data-mwonbtn]'); if (!b) return; b.disabled = true; try { S.walletsInfo = await api('/api/wallets', { slot: Number(b.dataset.mwonbtn), on: true }); renderAuth(); scheduleRender(); renderRight(); renderQB(); } catch (err) { b.disabled = false; toast({ status: 'failed', symbol: '钱包', reason: err.message }); } });   // 登录遮罩里的「参与下单」按钮
$('#walletMenu').addEventListener('change', async (e) => { const c = e.target.closest('[data-mwon]'); if (!c) return; try { S.walletsInfo = await api('/api/wallets', { slot: Number(c.dataset.mwon), on: c.checked }); renderWalletMenu(); renderAuth(); scheduleRender(); renderQB(); } catch (err) { toast({ status: 'failed', symbol: '钱包', reason: err.message }); } });
$('#walletMenu').addEventListener('click', async (e) => { const b = e.target.closest('[data-agcopy]'); if (!b) return; e.stopPropagation(); try { await copyOrThrow(b.dataset.agcopy); b.textContent = '已复制'; } catch { b.textContent = '请手动复制'; } });
$('#walletSel').addEventListener('click', (e) => { if (e.target.closest('#walletMenu')) return; renderWalletMenu(); $('#walletMenu').classList.toggle('hidden'); });
/* ---------- 弹层统一「点外部关闭 + Esc」 ---------- */
// 下拉 / 小面板：在 popEl 和它的按钮以外按下鼠标就关；在对话框里点（确认框、授权管理等）不算外部。登记：window.tmtnPop(el, [按钮], close, isOpen?)
// 遮罩型弹窗：按下和松开都在遮罩上才关（在输入框里拖选文字拖到外面不会误关）
const POPS = [];
const popOpen = (p) => (p.isOpen ? p.isOpen() : p.el.isConnected && !p.el.classList.contains('hidden'));
window.tmtnPop = (el, anchors, close, isOpen) => { if (el) POPS.push({ el, anchors: anchors.filter(Boolean), close, isOpen }); };
const DLG_SEL = '.ui-dlg-back,.modal:not(.hidden),.tr-drawer-back,.tfm-bg,.wl-back';
let downOn = null;
window.addEventListener('pointerdown', (e) => {
  downOn = e.target; const t = e.target; if (!(t instanceof Element)) return;
  if (t.closest(DLG_SEL)) return;
  POPS.forEach((p) => { if (popOpen(p) && !p.el.contains(t) && !p.anchors.some((a) => a.contains(t))) p.close(); });
}, true);
const backClick = (el, close) => el.addEventListener('click', (e) => { if (e.target === el && downOn === el) close(); });
$$('.modal').forEach((m) => backClick(m, () => m.classList.add('hidden')));
document.addEventListener('click', (e) => { const b = e.target; if (!b.classList?.contains('wl-back') || downOn !== b) return; if (b.id === 'wLoginDlg') closeWalletLoginDlg(); else b.remove(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('.ui-dlg-back')) return;   // 有确认框时 Esc 先给确认框
  const wl = [...document.querySelectorAll('.wl-back')].pop(); if (wl) { e.preventDefault(); return wl.id === 'wLoginDlg' ? closeWalletLoginDlg() : wl.remove(); }
  POPS.forEach((p) => { if (popOpen(p)) p.close(); });
});
window.tmtnPop($('#walletMenu'), [$('#walletSel')], () => $('#walletMenu').classList.add('hidden'));

// 搜索：粘贴地址直接打开 / 名称符号模糊搜索
const sIn = $('#search');
// 搜索：代号 / 名称 / 地址；点击或回车打开，↑↓ 选择；粘贴的地址不在列表里时让服务端去链上查
let searchIdx = 0;
function renderSearch() {
  const q = sIn.value.trim().toLowerCase(); const box = $('#searchResults');
  if (!q) return renderHist();
  const isAddr = /^0x[0-9a-f]{40}$/.test(q), isDom = /^[a-z0-9][a-z0-9_-]*\.(ai|bnb)$/.test(q);
  const hits = [...S.tokens.values()].filter((t) => t.address.toLowerCase().startsWith(q) || t.symbol.toLowerCase().includes(q) || String(t.name || '').toLowerCase().includes(q)).slice(0, 12);
  const rows = hits.map((t) => ['a', t]); if (isAddr && !hits.length) rows.push(['lookup']); if (isAddr || isDom) rows.push(['wlook']);   // 钱包地址 / 域名：查 .ai 域名 + 备注
  searchIdx = Math.min(searchIdx, Math.max(0, rows.length - 1));
  const wl = isAddr ? (noteOf(q) || NAMES[q] || '') : '';
  box.innerHTML = rows.length ? rows.map(([k, t], i) => { const on = i === searchIdx ? 'on' : '';
    return k === 'a' ? `<div data-a="${t.address}" class="${on}">${logoHtml(t, 'xs')}<b>${esc(symOk(t) ? t.symbol : t.name || '—')}</b><span class="mono muted">${short(t.address)}</span><span class="spacer"></span>${isBlocked(t) ? '<span class="blk-tag">已屏蔽</span><button class="qb" data-unblock="' + t.address + '">取消屏蔽</button>' : ''}<span class="mono">${usd(t.mcapUsd)}</span></div>`
      : k === 'lookup' ? `<div data-lookup="${esc(q)}" class="${on}">在链上查找代币 <span class="mono">${short(q)}</span> …</div>`
      : `<div data-wlook="${esc(q)}" class="${on}">🔎 ${isAddr ? `查这个钱包的 .ai 域名 / 写备注${wl ? ` <span class="spacer"></span>${whoHtml(q, NAMES[q])}` : ''}` : `查 <b>${esc(q)}</b> 的地址 / 写备注`}</div>`; }).join('')
    : '<div class="muted">没有匹配</div>';
  box.classList.remove('hidden');
}
async function openFromSearch(addr) {
  $('#searchResults').classList.add('hidden'); sIn.value = ''; sIn.blur();
  let t = S.tokens.get(addr) || S.tokens.get(addr.toLowerCase());
  if (!t) {
    // 不在列表里：先查是不是内盘（服务器最多 1.5 秒）；不是就去 GMGN 看。新标签要在点击 / 回车的这一刻先开好，否则会被浏览器拦截
    const isAddr = /^0x[0-9a-fA-F]{40}$/.test(addr), w = isAddr ? window.open('about:blank', '_blank') : null;
    try { t = await api(`/api/lookup/${addr}`); S.tokens.set(t.address, t); w?.close(); }
    catch {
      if (!isAddr) return toast({ status: 'failed', symbol: short(addr), reason: '未找到该代币' });
      const url = `https://gmgn.ai/bsc/token/${addr.toLowerCase()}`;
      if (w) { w.opener = null; w.location.href = url; } else window.open(url, '_blank', 'noopener');
      return note('不是本终端跟踪的内盘，已在 GMGN 打开', 'info');
    }
  }
  histAdd(t);
  // 在战壕 / 持仓页搜索时先切回交易页，否则选中了也看不到
  if (S.view !== 'trade') setView('trade');
  // 代币在另一个平台页签时先切过去
  lastList = 0;
  select(t.address);
  setTimeout(() => document.querySelector(`#tokenList [data-a="${t.address}"], .tcard[data-a="${t.address}"]`)?.scrollIntoView({ block: 'nearest' }), 300);
}
sIn.addEventListener('input', () => { searchIdx = 0; renderSearch(); });
// 用 mousedown 选中：不等输入框失焦关下拉，按久一点也不会丢
$('#searchResults').addEventListener('mousedown', (e) => {
  if (histClick(e)) return;
  if (e.target.closest('[data-unblock]')) return;   // 取消屏蔽按钮：交给 click 处理，不打开代币
  const el = e.target.closest('[data-a],[data-lookup],[data-wlook]'); if (!el) return;
  e.preventDefault(); e.stopPropagation(); pickSearch(el);
});
function pickSearch(el) { if (!el.dataset.wlook) return openFromSearch(el.dataset.a || el.dataset.lookup); $('#searchResults').classList.add('hidden'); sIn.value = ''; sIn.blur(); walletLookup(el.dataset.wlook); }
$('#searchResults').addEventListener('click', (e) => { if (e.target.closest('[data-unblock]')) return; if (e.target.closest('[data-a],[data-lookup],[data-wlook]')) { e.preventDefault(); e.stopPropagation(); } }, true);
sIn.addEventListener('keydown', (e) => {
  const items = $$('#searchResults [data-a],#searchResults [data-lookup],#searchResults [data-wlook]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); searchIdx = (searchIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); renderSearch(); return; }
  if (e.key === 'Enter') { const q = sIn.value.trim(); const f = items[searchIdx] || items[0]; if (f) pickSearch(f); else if (/^0x[0-9a-fA-F]{40}$/.test(q)) openFromSearch(q.toLowerCase()); }
  if (e.key === 'Escape') sIn.blur();
});
sIn.addEventListener('blur', () => setTimeout(() => $('#searchResults').classList.add('hidden'), 200));
/* ---------- 快捷买卖：空格+W 买入 2%（超限自动改 1%），空格+F 清仓 ---------- */
const qBusy = { buy: false, sell: false };
async function quickOrder(side, pct) {
  const t = S.tokens.get(S.selected); if (!t || qBusy[side]) return;
  const ws = [...S.selWallets]; if (!ws.length) return toast({ status: 'failed', symbol: t.symbol, reason: '没有选钱包' });
  qBusy[side] = true; (side === 'buy' ? $('#qBuy2') : $('#qClear')).disabled = true;
  try {
    if (side === 'sell') {
      topPop({ status: 'pending', side: 'sell', symbol: t.symbol, amountIn: 100 });
      const r = await api('/api/order', { wallets: ws, token: t.address, side: 'sell', amount: 100, slippage: S.slippage, via: 'quick' });
      const f = [].concat(r).find((o) => o?.status === 'failed' && !o.noBalance); if (f) topPop({ ...f, side: 'sell', symbol: t.symbol });
      return;
    }
    if (side === 'buy') { await pulseBuy1(t.address); return; }   // 按平台选比例（Flap 2%→1%，Four/Gang 1%）
    // 服务端已经按「单钱包上限 → 单笔上限 → 余额」把金额压好，只下一单；调整了就给一条灰色提示，不算失败
    const c = await api(`/api/cost-for-pct?wallet=${ws[0]}&token=${t.address}&pct=${pct}&slippage=${S.slippage}`);
    if (!(c.bnb > 0)) { if (c.capReached) note(`${t.symbol}：${c.error}，没有下单`, 'info'); else topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: c.error || '拿不到报价' }); return; }
    if (c.note) note(`${t.symbol}：${c.note}`, 'info');
    topPop({ status: 'pending', side: 'buy', symbol: t.symbol, amountIn: c.bnb });
    let r, err;
    try { r = [].concat(await api('/api/order', { wallets: ws, token: t.address, side: 'buy', amount: c.bnb, slippage: S.slippage, via: 'quick' })); } catch (e) { err = e.message; }
    const f = err ? { reason: err } : r.find((o) => o?.status === 'failed');
    if (f) topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: f.reason });
  } catch (e) { topPop({ status: 'failed', side, symbol: t.symbol, reason: e.message }); }
  finally { qBusy[side] = false; (side === 'buy' ? $('#qBuy2') : $('#qClear')).disabled = false; }
}
$('#qBuy2').addEventListener('click', () => quickOrder('buy', 2));
$('#qClear').addEventListener('click', () => quickOrder('sell', 100));
let spaceDown = false, spaceUsed = false;
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) { spaceDown = true; spaceUsed = false; } return; }
  if (spaceDown && !e.repeat && (e.code === 'KeyW' || e.code === 'KeyF')) { e.preventDefault(); spaceUsed = true; return quickOrder(e.code === 'KeyW' ? 'buy' : 'sell', e.code === 'KeyW' ? 2 : 100); }
}, true);
document.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
window.addEventListener('blur', () => { spaceDown = false; });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (spaceDown) return;
  if (e.key === '/') { e.preventDefault(); sIn.focus(); }
  if (e.key === 'b' || e.key === 'B') $('#sideTabs [data-s="buy"]').click();
  if (e.key === 's' || e.key === 'S') $('#sideTabs [data-s="sell"]').click();
  if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.add('hidden'));
});


/* ---------- 屏蔽（GMGN 式，全局，存在服务器） ---------- */
// 屏蔽代币或开发者：战壕、左侧列表不显示，不响提示音、不弹通知、不自动买；搜索还能找到（标「已屏蔽」），持仓照常显示
const lcA = (a) => String(a || '').toLowerCase();
// 名字 / 代号像 HTML 注入的直接当屏蔽（和服务端 engine/blocklist.js looksLikeHtml 同一条规则）
const looksLikeHtml = (s) => /<\s*[a-z!\/]/i.test(String(s || '')) && /\bon[a-z]+\s*=|script|javascript:|import\s*\(/i.test(String(s || ''));
function isBlocked(t) { return !!(t && (S.blk.tokens[lcA(t.address)] || (t.creator && S.blk.devs[lcA(t.creator)]) || looksLikeHtml(t.symbol) || looksLikeHtml(t.name))); }
const blockCount = () => Object.keys(S.blk.tokens).length + Object.keys(S.blk.devs).length;
function blockLinks(t) {
  const tok = S.blk.tokens[lcA(t.address)], dev = t.creator && S.blk.devs[lcA(t.creator)];
  return (tok ? `<a href="#" data-unblock="${t.address}" class="blk-on" title="已屏蔽这个币，点击取消屏蔽">已屏蔽</a>` : `<a href="#" data-block="${t.address}" title="屏蔽这个币：不再出现在战壕和列表里">⊘</a>`)
    + (t.creator ? (dev ? `<a href="#" data-unblockdev="${esc(t.creator)}" class="blk-on" title="这个开发者已屏蔽，点击取消">开发者已屏蔽</a>` : `<a href="#" data-blockdev="${esc(t.creator)}" data-lbl="${esc(t.creatorName || short(t.creator, 6, 4))}" title="屏蔽该开发者：他发的所有币都不显示">⊘ 开发者</a>`) : '');
}
async function setBlock(kind, address, on, label, undo = true) {
  // 先在页面上立刻生效（不等服务器），保存失败再恢复
  const m = kind === 'dev' ? S.blk.devs : S.blk.tokens, a = lcA(address), prev = m[a];
  if (on) m[a] = { label, at: Date.now() }; else delete m[a];
  afterBlock();
  try { S.blk = await api('/api/blocklist', { kind, address, on, label }); }
  catch (e) { if (prev) m[a] = prev; else delete m[a]; afterBlock(); return toast({ status: 'failed', symbol: '屏蔽', reason: e.message }); }
  afterBlock();
  const what = `${kind === 'dev' ? '开发者 ' : ''}${label}`;
  if (on && undo) undoNote(`已屏蔽 ${what}`, () => setBlock(kind, address, false, label, false)); else if (!on && undo) note(`已取消屏蔽 ${what}`);
}
function afterBlock() {
  // 立刻把页面上已屏蔽的卡片拿掉（左侧列表、战壕），不等下一次重画
  document.querySelectorAll('#tokenList > .tcard[data-a], #tokenList > [data-pa], .tcb > [data-pa]').forEach((el) => { const t = S.tokens.get(el.dataset.a || el.dataset.pa); if (t && isBlocked(t) && !(S.listTab === 'mine' && el.closest('#tokenList'))) el.remove(); });
  lastList = 0; renderList(); lastList = Date.now(); scheduleRender(); if (S.view === 'pulse') { renderTrenchHeads(); renderPulse(); } if (!$('#blockModal').classList.contains('hidden')) renderBlockMgr(); if (!$('#searchResults').classList.contains('hidden')) renderSearch(); }
// 带「撤销」的提示，5 秒后消失
function undoNote(text, undo) {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<b class="g">${esc(text)}</b> <button class="qb undo">撤销</button>`;
  el.querySelector('.undo').onclick = () => { el.remove(); undo(); };
  $('#toasts').prepend(el); setTimeout(() => el.remove(), 5000);
}
function renderBlockMgr() {
  const row = (kind, a, v) => { const t = kind === 'token' ? [...S.tokens.values()].find((x) => lcA(x.address) === a) : null;
    return `<div class="kv"><span>${kind === 'dev' ? '开发者' : '代币'} <b>${esc(t?.symbol || v.label || '')}</b> <span class="mono muted">${short(a, 6, 4)}</span></span><button class="qb" data-${kind === 'dev' ? 'unblockdev' : 'unblock'}="${a}">取消屏蔽</button></div>`; };
  const tk = Object.entries(S.blk.tokens).sort((a, b) => b[1].at - a[1].at), dv = Object.entries(S.blk.devs).sort((a, b) => b[1].at - a[1].at);
  $('#blockTitle').textContent = `已屏蔽 (${tk.length + dv.length})`;
  $('#blockBody').innerHTML = tk.length + dv.length ? tk.map(([a, v]) => row('token', a, v)).join('') + dv.map(([a, v]) => row('dev', a, v)).join('')
    : '<div class="muted">还没有屏蔽任何代币或开发者。在战壕卡片、左侧列表（鼠标移上去）、代币详情顶部点 ⊘ 屏蔽。</div>';
}
// 以前战壕「隐藏」存在本浏览器里，合并进全局屏蔽列表（只做一次）
async function migrateHidden() {
  const old = TR.hidden || []; if (!old.length) return;
  for (const a of old) { const t = S.tokens.get(a); try { S.blk = await api('/api/blocklist', { kind: 'token', address: a, on: true, label: t?.symbol || '' }); } catch { /* 地址无效就跳过 */ } }
  TR.hidden = []; trSave(); afterBlock();
}
// 捕获阶段处理，阻止冒泡：点 ⊘ 不会顺带打开代币 / 买入
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-block],[data-unblock],[data-blockdev],[data-unblockdev],[data-bmgr]'); if (!el) return;
  e.preventDefault(); e.stopPropagation(); const d = el.dataset;
  const sym = (a) => S.tokens.get(a)?.symbol || [...S.tokens.values()].find((x) => lcA(x.address) === lcA(a))?.symbol || short(a, 6, 4);
  if (d.bmgr != null) { renderBlockMgr(); $('#blockModal').classList.remove('hidden'); }
  else if (d.block) setBlock('token', d.block, true, sym(d.block));
  else if (d.unblock) setBlock('token', d.unblock, false, sym(d.unblock));
  else if (d.blockdev) setBlock('dev', d.blockdev, true, d.lbl || short(d.blockdev, 6, 4));
  else if (d.unblockdev) setBlock('dev', d.unblockdev, false, S.blk.devs[lcA(d.unblockdev)]?.label || short(d.unblockdev, 6, 4));
}, true);


/* ---------- 弹窗（替代浏览器自带的 confirm / prompt，和页面同一套深色样式） ---------- */
// await ui.confirm({ title, body, address, confirmText, danger }) → true / false；await ui.prompt({ title, label, value, suffix }) → 字符串或 null
// Esc / 点背景 = 取消，Enter = 确认
const ui = (() => {
  let open = null;
  const show = (html, onKey) => new Promise((resolve) => {
    open?.close(false);
    const wrap = document.createElement('div'); wrap.className = 'ui-dlg-back';
    wrap.innerHTML = `<div class="ui-dlg" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('in'));
    const close = (v) => { if (!wrap.isConnected) return; document.removeEventListener('keydown', key, true); wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 150); open = null; resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(onKey('cancel')); } else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(onKey('ok')); } };
    document.addEventListener('keydown', key, true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(onKey('cancel')); });
    wrap.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ui]'); if (!b) return;
      if (b.dataset.ui === 'copy') { try { await copyOrThrow(b.dataset.v); b.textContent = '已复制'; } catch { b.textContent = '复制失败'; } return; }
      close(onKey(b.dataset.ui));
    });
    open = { close }; setTimeout(() => (wrap.querySelector('input') || wrap.querySelector('[data-ui="ok"]'))?.focus(), 30);
  });
  const addr = (a) => a ? `<div class="ui-addr"><span class="mono">${esc(a)}</span><button class="ui-copy" data-ui="copy" data-v="${esc(a)}">复制</button></div>` : '';
  return {
    confirm: ({ title, body = '', address = '', after = '', confirmText = '确认', cancelText = '取消', danger = false }) => show(
      `<div class="ui-h">${esc(title)}</div><div class="ui-b">${body}${addr(address)}${after}</div>
       <div class="ui-f"><button class="ui-btn" data-ui="cancel">${esc(cancelText)}</button><button class="ui-btn ${danger ? 'danger' : 'ok'}" data-ui="ok">${esc(confirmText)}</button></div>`,
      (k) => k === 'ok'),
    prompt: ({ title, label = '', value = '', suffix = '' }) => {
      let input; const p = show(`<div class="ui-h">${esc(title)}</div><div class="ui-b"><label class="ui-in">${esc(label)}<input class="mono" value="${esc(String(value))}" inputmode="decimal" />${esc(suffix)}</label></div>
       <div class="ui-f"><button class="ui-btn" data-ui="cancel">取消</button><button class="ui-btn ok" data-ui="ok">确定</button></div>`,
        (k) => (k === 'ok' ? (input = document.querySelector('.ui-dlg input'))?.value ?? null : null));
      return p;
    },
    // 带输入框的对话框：确认时返回 { 输入框 name: 值（勾选框为 true/false） }，取消返回 null
    form: ({ title, body = '', address = '', confirmText = '确定' }) => show(
      `<div class="ui-h">${esc(title)}</div><div class="ui-b">${body}${addr(address)}</div>
       <div class="ui-f"><button class="ui-btn" data-ui="cancel">取消</button><button class="ui-btn ok" data-ui="ok">${esc(confirmText)}</button></div>`,
      (k) => { if (k !== 'ok') return null; const o = {}; document.querySelectorAll('.ui-dlg [name]').forEach((el) => { o[el.name] = el.type === 'checkbox' ? el.checked : el.value; }); return o; }),
  };
})();

/* ---------- 单币规则（发射后立刻领取） ---------- */
function ruleBanner(addr) {
  const r = S.rules[String(addr || '').toLowerCase()]; if (!r) return '';
  const st = r.state || {};
  const claimTxt = st.claimedAt ? `已领取${st.claimTx ? ` <a href="https://bscscan.com/tx/${esc(st.claimTx)}" target="_blank" rel="noopener">↗</a>` : ''}` : r.claim ? '发射后立刻领取（每 2 秒检查）' : '';
  const last = (r.log || []).at(-1);
  return `<div class="rule-bar"><b>⚙ 规则</b> ${claimTxt}${last ? `<span class="hsub" title="${esc((r.log || []).map((x) => new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + x.msg).join('\n'))}"> · ${esc(last.msg)}</span>` : ''}${st.done ? '' : ` <button class="qb" data-rule-cancel="${r.token}">取消规则</button>`}</div>`;
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-rule-cancel]'); if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const k = el.dataset.ruleCancel, r = S.rules[k]; if (!r) return;
  try {
    if (!(await ui.confirm({ title: `取消 ${r.symbol} 的规则？`, body: '<p>不再自动领取这个币。</p>', confirmText: '取消规则', cancelText: '保留' }))) return;
    S.rules = await api('/api/token-rules', { token: k, remove: true }); note(`已取消 ${r.symbol} 的规则`);
  } catch (err) { toast({ status: 'failed', symbol: '规则', reason: err.message }); }
  scheduleRender(); if (S.view === 'hold') renderHold();
}, true);

// 左上角 Logo：在当前页进入战壕（推一条历史记录，后退能回到原来的页面）
const goPulse = () => { if (S.view === 'pulse') return; location.hash = '#/pulse'; };
$('#brand').addEventListener('click', goPulse);
$('#brand').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goPulse(); } });



/* ---------- 收藏（参考 GMGN）：标题左边的 ★ 选分组；顶部 ⭐ 打开收藏栏，按分组筛选，实时显示市值和涨跌 ---------- */
const isFav = (a) => !!S.fav.items[String(a || '').toLowerCase()];
const favStar = (a) => `<button class="fav-star ${isFav(a) ? 'on' : ''}" data-fav="${a}" title="${isFav(a) ? '已收藏：' + esc(S.fav.items[String(a).toLowerCase()].group) + '（点击改分组 / 取消）' : '收藏'}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="currentColor"/></svg></button>`;
let favGroup = (() => { try { return localStorage.getItem('favGroup') || '全部'; } catch { return '全部'; } })();
function setFav(v) { S.fav = v || { groups: ['默认'], items: {} }; try { localStorage.setItem('fav', JSON.stringify(S.fav)); } catch { /* ignore */ } renderFavBar(); scheduleRender(); if (S.view === 'pulse') { lastPulse = 0; renderPulse(); } }
async function favOp(body) { try { setFav(await api('/api/favorites', body)); } catch (e) { toast({ status: 'failed', symbol: '收藏', reason: e.message }); } }
function favOn() { try { return localStorage.getItem('favBar') !== '0'; } catch { return true; } }
// 顶部栏两种内容：★ 收藏 / 📈 持仓（两个钱包合并，和「持仓」页同一份快照）
let favMode = (() => { try { return localStorage.getItem('favMode') === 'hold' ? 'hold' : 'fav'; } catch { return 'fav'; } })();
const favModesHtml = () => `<span class="fav-mode"><button class="${favMode === 'fav' ? 'on' : ''}" data-favmode="fav" title="收藏"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="currentColor"/></svg></button><button class="${favMode === 'hold' ? 'on' : ''}" data-favmode="hold" title="持仓"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 3v18h18M7 15l4-4 3 3 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span>`;
// 未实现盈亏 = 现在余额价值 − 剩余数量 × 买入均价（均价 = 链上实际花的 BNB ÷ 买到的数量）。按钱包分别算再相加：合并行的均价只是第一个钱包的
function holdUnreal(r) {
  if (!(r.amount > 0) || r.unsynced || r.valueUsd == null) return null;
  const bu = r.avgBuyUsd > 0 ? r.avgBuyUsd * r.amount : !(r.soldBnb > 0) && r.costUsd > 0 ? r.costUsd : null;
  const bb = r.avgBuyBnb > 0 ? r.avgBuyBnb * r.amount : !(r.soldBnb > 0) && r.costBnb > 0 ? r.costBnb : null;
  return bu > 0 ? { usd: r.valueUsd - bu, bnb: bb > 0 && r.valueBnb != null ? r.valueBnb - bb : null, basisUsd: bu, basisBnb: bb } : null;
}
function holdChips() {
  const d = HOLD.data; if (!d) return [];
  const parts = d.wallets?.length ? d.wallets : [{ label: '', rows: d.rows || [] }], by = new Map();
  for (const w of parts) for (const r of w.rows || []) {
    if (!(r.amount > 0) || r.unsynced) continue;
    const k = String(r.token).toLowerCase(); let c = by.get(k);
    if (!c) by.set(k, (c = { token: r.token, symbol: r.symbol, name: r.name, image: r.image, platform: r.platform, amount: 0, supplyPct: 0, valueUsd: 0, valueBnb: 0, noVal: false, uUsd: 0, uBnb: 0, basisUsd: 0, noU: false, ws: [] }));
    c.amount += r.amount; c.supplyPct += r.supplyPct || 0;
    if (r.valueUsd == null) c.noVal = true; else { c.valueUsd += r.valueUsd; c.valueBnb += r.valueBnb || 0; }
    const u = holdUnreal(r); if (!u) c.noU = true; else { c.uUsd += u.usd; c.uBnb += u.bnb || 0; c.basisUsd += u.basisUsd; }
    if (w.label) c.ws.push(w.label);
  }
  return [...by.values()].filter((c) => c.noVal || c.valueBnb >= 0.0005).sort((a, b) => b.valueUsd - a.valueUsd);   // 小额（< 0.0005 BNB）不显示，和「隐藏小额」一样
}
let favHoldHtml = '';
function renderHoldStrip() {
  if (!HOLD.data) { try { HOLD.data = fixClosed(JSON.parse(localStorage.getItem('holdSnap') || 'null')); HOLD.stale = true; } catch { /* ignore */ } }
  const list = holdChips();
  const html = list.length ? list.map((c) => {
    const t = S.tokens.get(c.token) || [...S.tokens.values()].find((x) => x.address.toLowerCase() === c.token.toLowerCase());
    const mc = t?.mcapUsd || (!c.noVal && c.supplyPct > 0 ? c.valueUsd / (c.supplyPct / 100) : null);
    const pct = !c.noU && c.basisUsd > 0 ? (c.uUsd / c.basisUsd) * 100 : null;
    const pnl = c.noU || c.noVal ? '<span class="mono muted">—</span>' : `<span class="mono ${c.uUsd >= 0 ? 'g' : 'r'}" title="未实现盈亏 ${c.uBnb >= 0 ? '+' : '−'}${bnb(Math.abs(c.uBnb), 5)} BNB">${c.uUsd >= 0 ? '+' : '−'}$${Math.abs(c.uUsd).toFixed(2)}${pct != null ? ` ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}</span>`;
    const tip = `${esc(t?.name || c.name || c.symbol || '')} · 持仓价值 ${c.noVal ? '—' : '$' + c.valueUsd.toFixed(2) + '（' + bnb(c.valueBnb, 5) + ' BNB）'}${t?.priceUsd ? ' · 单价 $' + sub(t.priceUsd) : ''}${c.ws.length ? ' · ' + esc(c.ws.join(' + ')) : ''} · 未实现盈亏 = 余额价值 − 剩余数量 × 买入均价（链上实付 BNB）`;
    return `<span class="fav-chip hold-chip" data-holdopen="${esc(c.token)}" title="${tip}">${logoHtml(t || { ...c, address: c.token }, 'xs')}<b>${esc(t?.symbol || c.symbol || short(c.token))}</b><span class="mono">${mc ? usd(mc) : '—'}</span>${pnl}</span>`;
  }).join('') : `<span class="fav-empty">${HOLD.data ? '暂无持仓' : '持仓加载中…'}</span>`;
  if (html !== favHoldHtml || !$('#favStrip').firstChild) { favHoldHtml = html; $('#favStrip').innerHTML = html; }
}
function renderFavBar() {
  document.body.classList.toggle('fav-on', favOn()); $('#favToggle').classList.toggle('on', favOn());
  if (!favOn()) return;
  if (favMode === 'hold') { const fg = $('#favGroups'); if (fg.dataset.m !== 'hold') { fg.innerHTML = favModesHtml(); fg.dataset.m = 'hold'; } return renderHoldStrip(); }
  favHoldHtml = ''; $('#favGroups').dataset.m = 'fav';
  const gs = ['全部', ...S.fav.groups]; if (!gs.includes(favGroup)) favGroup = '全部';
  $('#favGroups').innerHTML = favModesHtml() + gs.map((g) => `<button class="${g === favGroup ? 'on' : ''}" data-favg="${esc(g)}">${esc(g)}</button>`).join('') + '<button data-favmgr title="管理分组">⚙</button>';
  const list = Object.entries(S.fav.items).filter(([, v]) => favGroup === '全部' || v.group === favGroup).sort((a, b) => b[1].at - a[1].at);
  $('#favStrip').innerHTML = list.length ? list.map(([a, v]) => {
    const t = S.tokens.get(a) || [...S.tokens.values()].find((x) => x.address.toLowerCase() === a);
    const ch = t?.chg?.h24 ?? t?.chg?.h1 ?? t?.chg?.launch;
    return `<span class="fav-chip" data-favopen="${a}" title="${esc(t?.name || v.symbol)} · ${esc(v.group)}">${t ? logoHtml(t, 'xs') : ''}<b>${esc(t?.symbol || v.symbol || short(a))}</b><span class="mono">${t ? usd(t.mcapUsd) : '—'}</span>${ch != null ? `<span class="mono ${ch >= 0 ? 'g' : 'r'}">${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</span>` : ''}</span>`;
  }).join('') : `<span class="fav-empty">${favGroup === '全部' ? '还没有收藏：点代币名字左边的 ★' : '这个分组还没有收藏'}</span>`;
}
setInterval(() => { if (favOn() && (favMode === 'hold' || Object.keys(S.fav.items).length)) renderFavBar(); }, 3000);
function favMenu(btn, a) {
  $('.fav-menu')?.remove(); const t = S.tokens.get(a); const cur = S.fav.items[a.toLowerCase()];
  const m = document.createElement('div'); m.className = 'fav-menu';
  m.innerHTML = `<div class="t">收藏到分组</div>${S.fav.groups.map((g) => `<button class="${cur?.group === g ? 'on' : ''}" data-fg="${esc(g)}">${cur?.group === g ? '✓' : '　'} ${esc(g)}</button>`).join('')}
    <button data-fnew>＋ 新建分组</button>${cur ? '<div class="sep"></div><button class="rm" data-frm>取消收藏</button>' : ''}`;
  document.body.appendChild(m); const r = btn.getBoundingClientRect(); m.style.left = Math.min(r.left, innerWidth - 200) + 'px'; m.style.top = r.bottom + 6 + 'px';
  const close = () => { m.remove(); document.removeEventListener('mousedown', out, true); };
  const out = (e) => { if (!m.contains(e.target)) close(); }; setTimeout(() => document.addEventListener('mousedown', out, true), 0);
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.fg) { close(); return favOp({ op: 'set', address: a, group: b.dataset.fg, symbol: t?.symbol, platform: t?.platform }); }
    if (b.dataset.frm != null) { close(); return favOp({ op: 'remove', address: a }); }
    if (b.dataset.fnew != null) { close(); const g = await ui.prompt({ title: '新建分组', label: '名称', value: '' }); if (!g?.trim()) return; await favOp({ op: 'addGroup', group: g.trim() }); return favOp({ op: 'set', address: a, group: g.trim(), symbol: t?.symbol, platform: t?.platform }); }
  });
}
async function favManage() {
  const custom = S.fav.groups.filter((g) => g !== '默认'); if (!custom.length) { const g = await ui.prompt({ title: '新建分组', label: '名称', value: '' }); if (g?.trim()) favOp({ op: 'addGroup', group: g.trim() }); return; }
  const g = await ui.prompt({ title: '管理分组', label: `要改的分组（${custom.join(' / ')}）`, value: custom[0] }); if (!g || !custom.includes(g.trim())) return;
  const to = await ui.prompt({ title: `分组「${g.trim()}」`, label: '新名称（留空 = 删除这个分组，里面的币移到「默认」）', value: g.trim() }); if (to == null) return;
  if (!to.trim()) { if (await ui.confirm({ title: `删除分组「${g.trim()}」？`, body: '<p>里面的收藏会移到「默认」。</p>', confirmText: '删除', danger: true })) favOp({ op: 'deleteGroup', group: g.trim() }); }
  else if (to.trim() !== g.trim()) favOp({ op: 'renameGroup', group: g.trim(), to: to.trim() });
}
document.addEventListener('click', (e) => {
  const st = e.target.closest('[data-fav]'); if (st) { e.preventDefault(); e.stopPropagation(); const a = st.dataset.fav; const t = S.tokens.get(a);
    if (!isFav(a)) favOp({ op: 'set', address: a, group: '默认', symbol: t?.symbol, platform: t?.platform }).then(() => favMenu(st, a)); else favMenu(st, a); return; }
  const q = e.target.closest('[data-favq]'); if (q) { e.preventDefault(); e.stopPropagation(); const a = q.dataset.favq, t = S.tokens.get(a); return isFav(a) ? favOp({ op: 'remove', address: a }) : favOp({ op: 'set', address: a, group: '默认', symbol: t?.symbol, platform: t?.platform }); }
  const fm = e.target.closest('[data-favmode]'); if (fm) { favMode = fm.dataset.favmode === 'hold' ? 'hold' : 'fav'; try { localStorage.setItem('favMode', favMode); } catch { /* ignore */ } if (favMode === 'hold' && !HOLD.data && typeof loadHold === 'function') loadHold(); return renderFavBar(); }
  const ho = e.target.closest('[data-holdopen]'); if (ho) { const a = ho.dataset.holdopen.toLowerCase(); const t = S.tokens.get(ho.dataset.holdopen) || [...S.tokens.values()].find((x) => x.address.toLowerCase() === a); if (t) return openToken(t); setView('trade'); return select(ho.dataset.holdopen); }
  const g = e.target.closest('[data-favg]'); if (g) { favGroup = g.dataset.favg; try { localStorage.setItem('favGroup', favGroup); } catch { /* ignore */ } return renderFavBar(); }
  if (e.target.closest('[data-favmgr]')) return favManage();
  const c = e.target.closest('[data-favopen]'); if (c) { const a = c.dataset.favopen; const t = S.tokens.get(a) || [...S.tokens.values()].find((x) => x.address.toLowerCase() === a);
    if (t) return openToken(t); location.hash = `#/${S.fav.items[a]?.platform || S.platform}/curve/${a}`; }
}, true);
$('#favToggle').addEventListener('click', () => { try { localStorage.setItem('favBar', favOn() ? '0' : '1'); } catch { /* ignore */ } renderFavBar(); window.dispatchEvent(new Event('resize')); });


/* ---------- 一键买卖浮窗（GMGN 那种）：只在交易详情页显示，战壕不显示；可拖动，预设可编辑，点按钮 = 你手动下单（走同一套下单流程和检查） ---------- */
const QB_DEF = { buy: [[0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5], [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5], [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5]], sell: [[10, 25, 50, 100, 5, 15, 35, 70], [10, 25, 50, 100, 5, 15, 35, 70], [10, 25, 50, 100, 5, 15, 35, 70]] };
const QBP = (() => { let x = {}; try { x = JSON.parse(localStorage.getItem('qbPanel') || '{}'); } catch { /* ignore */ } return { open: x.open !== false, x: x.x ?? null, y: x.y ?? null, w: x.w ?? null, h: x.h ?? null, pb: x.pb || 0, ps: x.ps || 0, edit: false, adv: false }; })();
const qbSave = () => { try { localStorage.setItem('qbPanel', JSON.stringify({ open: QBP.open, x: QBP.x, y: QBP.y, w: QBP.w, h: QBP.h, pb: QBP.pb, ps: QBP.ps })); } catch { /* ignore */ } };
const qbOpen = () => QBP.open;
const qbPresets = () => { const p = S.settings?.qbPresets; if (p) { try { localStorage.setItem('qbPresets', JSON.stringify(p)); } catch { /* ignore */ } return p; } try { return JSON.parse(localStorage.getItem('qbPresets') || 'null') || QB_DEF; } catch { return QB_DEF; } };
function renderQB() {
  let el = $('#qbPanel');
  const show = QBP.open && S.view === 'trade' && !!S.selected && LIVE();
  $('#qbToggleBtm')?.classList.toggle('qb-on', QBP.open);   // 底部标签栏右边的「⚡ 一键买卖」开关
  if (!show) { el?.classList.add('hidden'); return; }
  if (!el) {
    el = document.createElement('div'); el.id = 'qbPanel'; el.className = 'qbp'; document.body.appendChild(el); qbBind(el);
    if (QBP.w) el.style.width = QBP.w + 'px'; if (QBP.h) el.style.height = QBP.h + 'px';
    // 右下角拖动改大小（长方形 / 正方形都行），松手后记住宽高；按钮按宽度自动排列、按高度变高
    let rt = 0; new ResizeObserver(() => { if (!el.style.width && !el.style.height) return; clearTimeout(rt); rt = setTimeout(() => { if (el.classList.contains('hidden')) return; QBP.w = Math.round(el.offsetWidth); QBP.h = el.style.height ? Math.round(el.offsetHeight) : null; qbSave(); }, 300); }).observe(el);
  }
  el.classList.remove('hidden');
  if (QBP.x != null) { el.style.left = Math.max(0, Math.min(innerWidth - Math.min(el.offsetWidth || 300, innerWidth), QBP.x)) + 'px'; el.style.top = Math.max(46, Math.min(innerHeight - 120, QBP.y)) + 'px'; el.style.right = 'auto'; }
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // 正在改预设时不重画
  const t = S.tokens.get(S.selected) || { address: S.selected, symbol: '…' };
  const P = qbPresets(), hr = S.tokens.has(S.selected) ? holdRow(t) : null, w = wallet(S.activeWallet) || S.wallets[0];
  // 多钱包：买入显示所有「参与下单」钱包的 BNB 合计（和顶栏钱包胶囊同一个数），卖出显示这些钱包持仓的合计；悬停看每个钱包
  const mwOn = MW() ? onWallets() : null;
  const buyBnb = mwOn ? mwOn.reduce((a, x) => a + (x.bnb || 0), 0) : w?.bnb;
  const buyTip = mwOn ? (mwOn.length ? mwOn.map((x) => `${x.agentId || x.label}：${x.bnb != null ? x.bnb.toFixed(4) : '—'} BNB${x.auth === 'ok' ? '' : '（未登录，下单时跳过）'}`).join('\n') + (mwOn.length > 1 ? `\n合计 ${buyBnb.toFixed(4)} BNB（买入时每个钱包各花按钮上的金额）` : '') : '没有钱包开启「参与下单」') : '';
  let sellAmt = hr?.amount || 0, sellUsd = hr?.valueUsd, sellTip = '';
  if (mwOn && hr?.byWallet?.length) {
    const onSet = new Set(mwOn.map((x) => x.slot)), mine = hr.byWallet.filter((b) => onSet.has(b.slot));
    sellAmt = mine.reduce((a, b) => a + (b.amount || 0), 0); sellUsd = mine.some((b) => b.valueUsd != null) ? mine.reduce((a, b) => a + (b.valueUsd || 0), 0) : null;
    sellTip = hr.byWallet.map((b) => `${(S.walletsInfo || []).find((x) => x.slot === b.slot)?.agentId || b.label}：${K(b.amount || 0)}${b.valueUsd != null ? ' · $' + b.valueUsd.toFixed(2) : ''}${onSet.has(b.slot) ? '' : '（不参与下单，不会卖）'}`).join('\n') + '\n卖出时每个参与下单的钱包卖自己持仓的同样比例';
  }
  const btns = (side, list) => list.map((v, i) => QBP.edit ? `<input class="qbp-in mono" data-qbi="${side}:${i}" value="${v}" inputmode="decimal" />` : `<button class="qbp-b ${side}" data-qbgo="${side}:${v}">${side === 'buy' ? v : v + '%'}</button>`).join('');
  const tabs = (side, cur) => [0, 1, 2].map((i) => `<button class="${cur === i ? 'on' : ''}" data-qbtab="${side}:${i}">P${i + 1}</button>`).join('');
  const sgnU = (v) => (v == null ? '—' : `<b class="${v >= 0 ? 'g' : 'r'}">${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}</b>`);
  el.innerHTML = `<div class="qbp-h" data-qbdrag><span class="muted">${esc(t.symbol)}</span><span class="spacer"></span>${xsBtn(t.address, 'xs-qb')}<button class="qbp-x" data-qbedit title="${QBP.edit ? '完成（保存预设）' : '编辑预设'}">${QBP.edit ? '✅' : '⚙'}</button><button class="qbp-x" data-qbclose title="关闭">×</button></div>
    <div class="qbp-sec"><div class="qbp-row"><b class="g">买入</b><span class="qbp-tabs">${tabs('buy', QBP.pb)}</span><span class="spacer"></span><span class="muted mono" title="${esc(buyTip)}">${buyBnb != null ? bnb(buyBnb || 0, 4) : '—'} BNB${mwOn?.length > 1 ? ` <small>×${mwOn.length}</small>` : ''}</span></div>
      <div class="qbp-grid">${btns('buy', P.buy[QBP.pb])}</div>
      <div class="qbp-adv"><button data-qbadv>${QBP.adv ? '▾' : '▸'} 高级</button>${QBP.adv ? `<span>滑点 <b class="mono">${S.slippage}%</b>（在右侧下单区修改）</span><span>${S.fast ? '<b class="y">极速模式：点击直接下单</b>' : '每次会弹确认'}</span><span>单笔上限 ${S.baw?.maxTradeBnb || '不限'} BNB</span>` : ''}</div></div>
    <div class="qbp-sec"><div class="qbp-row"><b class="r">卖出</b><span class="qbp-tabs">${tabs('sell', QBP.ps)}</span><span class="spacer"></span><span class="muted mono" title="${esc(sellTip)}">${sellAmt > 0 ? `${K(sellAmt)} · ${sellUsd != null ? '$' + sellUsd.toFixed(2) : '—'}` : hr?.amount > 0 ? '参与下单的钱包没有持仓' : '没有持仓'}</span></div>
      <div class="qbp-grid">${btns('sell', P.sell[QBP.ps])}</div>
      ${hr?.amount > 0 && hr.costBnb > 0 && hr.valueBnb > hr.costBnb ? `<button class="qbp-b sell wide" data-qbgo="sell:${Math.min(100, (hr.costBnb / hr.valueBnb) * 100).toFixed(1)}" title="卖出刚好收回成本的比例（按现价估算）">回本（卖 ${Math.min(100, (hr.costBnb / hr.valueBnb) * 100).toFixed(1)}%）</button>` : ''}</div>
    <div class="qbp-f"><div><span>余额</span><b>${hr?.valueUsd != null ? '$' + hr.valueUsd.toFixed(2) : '—'}</b></div><div><span>总买入</span><b>${hr ? '$' + (hr.costUsd || 0).toFixed(2) : '—'}</b></div><div><span>总卖出</span><b>${hr ? '$' + (hr.soldUsd || 0).toFixed(2) : '—'}</b></div><div><span>未实现</span>${hr && hr.valueUsd != null && hr.amount > 0 ? sgnU(hr.valueUsd - (hr.costUsd || 0) + (hr.soldUsd || 0)) : '—'}</div></div>`;
  el.insertAdjacentHTML('beforeend', '<i class="qbp-rs nw" data-qbrs="nw"></i><i class="qbp-rs ne" data-qbrs="ne"></i><i class="qbp-rs sw" data-qbrs="sw"></i><i class="qbp-rs se" data-qbrs="se"></i>');   // 四个角拖动改大小
}
function qbBind(el) {
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return; const d = b.dataset;
    if (d.qbclose != null) { QBP.open = false; qbSave(); renderQB(); renderHead(); return; }
    if (d.qbedit != null) {
      if (QBP.edit) {   // 保存
        const P = JSON.parse(JSON.stringify(qbPresets()));
        for (const i of el.querySelectorAll('[data-qbi]')) { const [side, k] = i.dataset.qbi.split(':'); const v = Number(i.value); if (!(v > 0) || (side === 'sell' && v > 100)) return toast({ status: 'failed', symbol: '预设', reason: `数值无效：${i.value}` }); P[side][side === 'buy' ? QBP.pb : QBP.ps][+k] = v; }
        try { S.settings = await api('/api/settings', { qbPresets: P }); note('一键买卖预设已保存'); } catch (err) { return toast({ status: 'failed', symbol: '预设', reason: err.message }); }
      }
      QBP.edit = !QBP.edit; return renderQB();
    }
    if (d.qbtab) { const [side, i] = d.qbtab.split(':'); if (side === 'buy') QBP.pb = +i; else QBP.ps = +i; qbSave(); return renderQB(); }
    if (d.qbadv != null) { QBP.adv = !QBP.adv; return renderQB(); }
    if (d.qbgo) {   // 你点的按钮：走正常的手动下单（单笔上限、钱包锁、待确认、提示都照常；非极速模式会先弹确认）
      const [side, v] = d.qbgo.split(':'); const amt = +v; if (!S.selected || !(amt > 0)) return;
      return submitOrder({ token: S.selected, side, wallets: [S.activeWallet], amountFor: () => amt });
    }
  });
  // 四个角拖动改大小（拖哪个角，对角不动），宽高和位置都记住
  el.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-qbrs]'); if (!h) return;
    e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId); el.classList.add('dragging');
    const c = h.dataset.qbrs, r = el.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, MW = 230, MH = 150;
    const mv = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let l = r.left, t = r.top, w = r.width, hh = r.height;
      if (c.includes('e')) w = Math.max(MW, Math.min(innerWidth - l, r.width + dx)); else { w = Math.max(MW, Math.min(r.right, r.width - dx)); l = r.right - w; }
      if (c.includes('s')) hh = Math.max(MH, Math.min(innerHeight - t, r.height + dy)); else { hh = Math.max(MH, Math.min(r.bottom - 46, r.height - dy)); t = r.bottom - hh; }
      Object.assign(el.style, { left: l + 'px', top: t + 'px', right: 'auto', width: w + 'px', height: hh + 'px' });
      Object.assign(QBP, { x: l, y: t, w: Math.round(w), h: Math.round(hh) });
    };
    const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); qbSave(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
  // 拖动标题栏移动，位置记住
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-qbdrag]') || e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top; el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const mv = (ev) => { QBP.x = ev.clientX - ox; QBP.y = ev.clientY - oy; el.style.left = Math.max(0, Math.min(innerWidth - Math.min(el.offsetWidth, innerWidth), QBP.x)) + 'px'; el.style.top = Math.max(46, Math.min(innerHeight - 120, QBP.y)) + 'px'; el.style.right = 'auto'; };
    const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); qbSave(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-qbtoggle]')) { e.preventDefault(); e.stopPropagation(); QBP.open = !QBP.open; qbSave(); renderQB(); renderHead(); } }, true);
setInterval(renderQB, 2000);


// 大的「复制CA」按钮（详情页顶部、一键买卖浮窗）：点一下复制完整合约地址，按钮显示「已复制 ✓」1.5 秒（状态记在内存里，页面重画也不丢）
const caCopied = { a: '', until: 0 };
const caOk = (a) => caCopied.a === String(a).toLowerCase() && Date.now() < caCopied.until;
async function caCopy(a) {
  const ok = await copyText(a);
  if (!ok) { note('复制失败，请手动选中地址', 'info'); return; }
  Object.assign(caCopied, { a: a.toLowerCase(), until: Date.now() + 1500 });
  document.querySelectorAll(`[data-cacopy="${a}"]`).forEach((x) => { x.classList.add('ok'); x.querySelector('span').textContent = '已复制 ✓'; });
  setTimeout(() => { document.querySelectorAll(`[data-cacopy="${a}"]`).forEach((x) => { x.classList.remove('ok'); x.querySelector('span').textContent = '复制CA'; }); }, 1550);
}


/* ---------- 持仓页「兑换」：BNB ⇄ 任意代币（BNCB / NVDAB / BTCB…），先报价，你确认后才兑换 ---------- */
const BNB_ADDR = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SW_PRESET = [
  ['BNCB', '0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f'], ['NVDAB', '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436'], ['BTCB', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c'],
  ['GANG', '0x0c6302401aa5325C2E36F170f52C00B1d220B405'], ['ZEC', '0x1Ba42e5193dfA8B03D15dd1B86a3113bbBEF8Eeb'], ['USDT', '0x55d398326f99059fF775485246999027B3197955'],
];
const SW = (() => { let x = {}; try { x = JSON.parse(localStorage.getItem('swapUI') || '{}'); } catch { /* ignore */ } return { dir: x.dir || 'buy', token: x.token || SW_PRESET[0][1], recent: x.recent || [], info: null, q: null, busy: false, err: null, amt: '' }; })();
const swSave = () => { try { localStorage.setItem('swapUI', JSON.stringify({ dir: SW.dir, token: SW.token, recent: SW.recent.slice(0, 8) })); } catch { /* ignore */ } };
async function swLoadInfo() {
  SW.info = null; SW.q = null; SW.err = null; renderSwap();
  try { SW.info = await api(`/api/token-info/${SW.token}`); } catch (e) { SW.err = e.message; }
  renderSwap();
}
function renderSwap() {
  const box = $('#holdSwap'); if (!box || S.view !== 'hold' || !LIVE()) { if (box) box.innerHTML = ''; return; }
  const i = SW.info, buy = SW.dir === 'buy', w = wallet(S.activeWallet) || S.wallets[0];
  const fromSym = buy ? 'BNB' : (i?.symbol || '…'), toSym = buy ? (i?.symbol || '…') : 'BNB';
  const bal = buy ? (w?.bnb ?? 0) : Number(i?.balance || 0);
  const chips = [...SW_PRESET, ...SW.recent.filter((r) => !SW_PRESET.some((p) => p[1].toLowerCase() === r[1].toLowerCase()))];
  const focused = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (focused && box.dataset.ready) { $('#swQ').innerHTML = swQuoteHtml(toSym); return; }
  box.dataset.ready = '1';
  box.innerHTML = `<div class="sw-h"><b>兑换</b><span class="seg sm"><button class="${buy ? 'active' : ''}" data-swdir="buy">BNB → 代币</button><button class="${buy ? '' : 'active'}" data-swdir="sell">代币 → BNB</button></span><span class="hsub">用 baw 市价单（币安聚合路由），先报价，确认后才兑换</span></div>
    <div class="sw-chips">${chips.map(([n, a]) => `<button class="${a.toLowerCase() === SW.token.toLowerCase() ? 'on' : ''}" data-swtok="${a}">${esc(n)}</button>`).join('')}
      <input class="mono" id="swCa" placeholder="或粘贴代币合约地址 0x…" value="${SW_PRESET.some((p) => p[1] === SW.token) || SW.recent.some((r) => r[1] === SW.token) ? '' : esc(SW.token)}" /></div>
    <div class="sw-tok">${i ? `${i.image ? `<img src="${esc(proxied(i.image))}" alt="" referrerpolicy="no-referrer" />` : ''}<b>${esc(i.symbol)}</b><span class="hsub">${esc(i.name || '')} · <span class="mono">${short(i.address, 6, 4)}</span> · 持有 ${swN(+i.balance)}</span>` : SW.err ? `<span class="r">${esc(SW.err)}</span>` : '<span class="hsub">读取代币信息…</span>'}</div>
    <div class="sw-row"><label class="sw-in"><span>${fromSym}</span><input class="mono" id="swAmt" inputmode="decimal" placeholder="数量" value="${esc(SW.amt)}" /></label>
      ${[25, 50, 100].map((p) => `<button class="qb" data-swpct="${p}">${p === 100 ? 'MAX' : p + '%'}</button>`).join('')}<span class="hsub">余额 ${buy ? bnb(bal, 4) + ' BNB' : K(bal) + ' ' + esc(fromSym)}</span></div>
    <div class="sw-row"><button class="qb" data-swquote>报价</button><span id="swQ">${swQuoteHtml(toSym)}</span><span class="spacer"></span><button class="sw-go ${buy ? 'buy' : 'sell'}" data-swgo ${SW.busy ? 'disabled' : ''}>${SW.busy ? '兑换中…' : `兑换 ${fromSym} → ${toSym}`}</button></div>`;
}
const swN = (v) => (v == null ? '—' : v >= 1000 ? K(v) : v >= 1 ? (+v).toFixed(4) : sub(v));
function swQuoteHtml(toSym) { const q = SW.q; if (!q) return '<span class="hsub">点「报价」看预计到手</span>'; if (q.err) return `<span class="r">${esc(q.err)}</span>`; return `预计 <b class="mono">${swN(q.out)} ${esc(toSym)}</b> · 最少 <span class="mono">${swN(q.minOut)}</span>（滑点 ${q.slippage}%）· <span class="hsub">${esc(q.route)}</span>`; }
function swPayload() {
  const buy = SW.dir === 'buy', i = SW.info; const amt = String(SW.amt || '').trim();
  return { from: buy ? BNB_ADDR : i.address, to: buy ? i.address : BNB_ADDR, amount: amt, slippage: 2 };   // 主流代币兑换用 2% 滑点（内盘那种 35% 太松）
}
document.addEventListener('input', (e) => { if (e.target.id === 'swAmt') { SW.amt = e.target.value; SW.q = null; $('#swQ').innerHTML = swQuoteHtml(''); } });
document.addEventListener('change', (e) => { if (e.target.id === 'swCa') { const v = e.target.value.trim(); if (/^0x[0-9a-fA-F]{40}$/.test(v)) { SW.token = v; swSave(); swLoadInfo(); } else if (v) note('合约地址格式不对（0x + 40 位）', 'info'); } });
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-swdir],[data-swtok],[data-swpct],[data-swquote],[data-swgo]'); if (!el || !el.closest('#holdSwap')) return;
  const d = el.dataset;
  if (d.swdir) { SW.dir = d.swdir; SW.q = null; SW.amt = ''; swSave(); return renderSwap(); }
  if (d.swtok) { SW.token = d.swtok; SW.amt = ''; swSave(); return swLoadInfo(); }
  if (d.swpct) { const buy = SW.dir === 'buy', w = wallet(S.activeWallet) || S.wallets[0]; const p = +d.swpct;
    if (buy) { const max = Math.max(0, (w?.bnb || 0) - 0.003); SW.amt = String(+(max * p / 100).toFixed(6)); }   // BNB 留 0.003 付 gas
    else SW.amt = p >= 100 ? 'MAX' : String(+(Number(SW.info?.balance || 0) * p / 100).toFixed(6));
    SW.pct = buy ? null : p; SW.q = null; return renderSwap(); }
  if (!SW.info) return note('先选一个代币', 'info');
  if (d.swquote != null) {
    const pl = swPayload(); if (pl.amount === 'MAX') pl.amount = SW.info.balance;
    if (!(Number(pl.amount) > 0)) return note('请输入数量', 'info');
    $('#swQ').innerHTML = '<span class="hsub">报价中…</span>';
    try { SW.q = await api('/api/swap/quote', pl); } catch (err) { SW.q = { err: zhErr(err.message) }; }
    return renderSwap();
  }
  if (d.swgo != null) {
    const pl = swPayload(); const buy = SW.dir === 'buy';
    if (!buy && (pl.amount === 'MAX' || SW.pct >= 100)) { pl.pct = 100; } else if (!(Number(pl.amount) > 0)) return note('请输入数量', 'info');
    if (!S.fast) {
      let q = SW.q; if (!q || q.err) { try { q = await api('/api/swap/quote', { ...pl, amount: pl.pct ? SW.info.balance : pl.amount }); } catch (err) { q = { err: zhErr(err.message) }; } }
      const ok = await ui.confirm({ title: `确认兑换 ${buy ? 'BNB → ' + SW.info.symbol : SW.info.symbol + ' → BNB'}`, danger: true, confirmText: '确认兑换',
        body: `<p>付出：<b class="mono">${pl.pct ? '全部 ' + swN(+SW.info.balance) : pl.amount} ${buy ? 'BNB' : esc(SW.info.symbol)}</b></p><p>预计到手：<b class="mono">${q?.err ? esc(q.err) : swN(q.out) + ' ' + (buy ? esc(SW.info.symbol) : 'BNB')}</b>${q?.minOut ? `（最少 ${swN(q.minOut)}）` : ''}</p>`,
        address: SW.info.address, after: `<p class="ui-note">真实交易，用币安 Agentic 钱包上链，无法撤回。单笔上限 ${S.baw?.maxTradeBnb || '不限'} BNB。</p>` });
      if (!ok) return;
    }
    if (!SW.recent.some((r) => r[1].toLowerCase() === SW.info.address.toLowerCase()) && !SW_PRESET.some((p) => p[1].toLowerCase() === SW.info.address.toLowerCase())) { SW.recent.unshift([SW.info.symbol, SW.info.address]); swSave(); }
    SW.busy = true; renderSwap(); topPop({ status: 'pending', side: buy ? 'buy' : 'sell', symbol: SW.info.symbol, amountIn: buy ? +pl.amount : 100 });
    try { const o = await api('/api/swap', { ...pl, clientTs: Date.now() }); if (o.status === 'failed') toast(o); else if (o.status === 'filled') { note(`兑换完成：${o.route} 到手 ${K(o.out || 0)}`); } }
    catch (err) { toast({ status: 'failed', symbol: '兑换', reason: err.message }); }
    SW.busy = false; SW.q = null; setTimeout(() => { swLoadInfo(); loadHold(true); }, 1500);
  }
});

/* ---------- 成交往下翻页（K 线右边的「活动」用） ---------- */
const OLDER = {};   // token → { items, end, complete, loading, err }
function olderTrades() { const k = S.selected || ''; return (OLDER[k] ||= { items: [], end: false, complete: true, loading: false, err: null }); }
async function loadOlderTrades() {
  const k = S.selected, o = olderTrades(); if (!k || !LIVE() || o.loading || o.end || o.pending) return;
  const all = [...(S.detail?.trades || []), ...o.items]; const before = all.length ? Math.min(...all.map((x) => x.ts)) : 0;
  o.loading = true; o.err = null; renderAct();
  try {
    const r = await api(`/api/trades/${k}?before=${before}&limit=150`);
    // 后端还在补这个盘的链上成交（刚重启 / 节点出错）：不算到底，3 秒后再要，不再停在「已到开盘第一笔」
    if (r.pending) { o.pending = true; setTimeout(() => { o.pending = false; if (S.selected === k && !o.end) loadOlderTrades(); }, 3000); }
    else { o.pending = false; o.items.push(...r.items); o.end = r.end; o.complete = r.complete; }
  }
  catch (e) { o.err = e.message; }
  o.loading = false; if (S.selected === k) renderAct();
}


/* ---------- 详情页底部「持有人」（HOLDERS_FEATURE）：按持仓排名，总买入 / 总卖出 / 利润 / 买入市值；点一行打开交易者抽屉看每一笔买卖 ---------- */
const HOLDERS = {};   // token → { at, data, loading, err, exited }
function holdersState() { const k = S.selected || ''; return (HOLDERS[k] ||= { at: 0, data: null, loading: false, err: null, exited: false }); }
async function loadHolders(force) {
  const k = S.selected, o = holdersState(); if (!k || !LIVE() || o.loading || (!force && Date.now() - o.at < 30_000)) return;
  o.loading = true; o.err = null; if (force) renderBottom();
  try { o.data = await api(`/api/holders/${k}`); } catch (e) { o.err = e.message; }
  o.at = Date.now(); o.loading = false; if (S.selected === k && S.bottomTab === 'holders') renderBottom();
}
function holdersHtml(t) {
  if (!LIVE()) return { html: '<div class="empty">持有人只在实盘模式可用</div>', cnt: '' };
  if (!t) return { html: '<div class="empty">先选一个币</div>', cnt: '' };
  const o = holdersState(); loadHolders(); const d = o.data;
  if (!d) return { html: `<div class="empty">${o.err ? '读取失败：' + esc(o.err) : '正在汇总这个币的全部成交和链上持仓（第一次要十几秒）…'}</div>`, cnt: '' };
  const U = (q) => q * d.qUsd, pm = (v) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2);
  const money = (qv, n) => `<b>$${U(qv).toFixed(2)}</b>${n != null ? `<div class="hsub">${n} 笔</div>` : ''}`;
  const rows = o.exited ? d.exited : d.holders;
  const head = `<div class="note" style="margin:4px 0 6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="muted">${esc(d.coverage)}。统计 ${d.trades} 笔成交、${d.traders} 个地址${d.complete ? '' : '（成交太多，只统计了最近一部分）'}；${d.chain ? `持仓：${d.checked} 个地址全部按链上余额` : `持仓：前 ${d.checked} 名读链上余额，其余按买卖差估算`}，<span class="y">⚠</span> = 有转入 / 转出（买卖差和链上余额对不上，成本、利润只按买卖算）</span><span class="spacer"></span>
    <button class="qb" style="display:inline" data-hexited>${o.exited ? `看持有中（${d.holderCount}）` : `看已清仓（${d.exitedCount}）`}</button> <button class="qb" style="display:inline" data-hrefresh>${o.loading ? '刷新中…' : '刷新'}</button></div>`;
  const html = head + (rows.length ? `<table class="ttable"><tr><th>#</th><th class="l">钱包</th><th title="当前持有数量 / 占总量">持有</th><th title="买入按实际付出（含平台费）；美元按报价币现价换算">总买入</th><th title="卖出按到手金额">总卖出</th><th title="已实现 + 未实现（按现价），不含 gas">利润</th><th title="买入均价 × 总量 × 报价币现价">买入市值</th><th>最近交易</th></tr>
    ${rows.map((r, i) => `<tr class="${isMe(r.trader) ? 'mine' : ''} trow" data-trader="${esc(r.trader)}" title="点击查看这个地址在 ${esc(t.symbol)} 上的每一笔买卖"><td class="dim">${i + 1}</td><td class="l addr"><span class="tr-who">${gmgnWho(r.trader, r.name || NAMES[r.trader.toLowerCase()])}</span>${r.pool ? ' <i class="chip q" title="DEX 池子地址">池子</i>' : ''}</td>
    <td><b>${K(r.hold)}</b>${r.xfer ? ` <span class="y" title="链上余额 ${K(r.hold)}，买卖差 ${K(r.net)}：有转入 / 转出">⚠</span>` : ''}<div class="hsub">${r.pctSupply.toFixed(r.pctSupply < 0.1 ? 3 : 2)}%${r.holdSrc === 'chain' ? '' : ' · 估算'}</div></td>
    <td>${money(r.boughtQ, r.buys)}</td><td>${money(r.soldQ, r.sells)}</td>
    <td title="已实现 ${pm(U(r.realized))} / 未实现 ${pm(U(r.unrealized))}"><b>${sgn(U(r.total), (v) => '$' + v.toFixed(2))}</b></td>
    <td>${r.buyMcUsd ? usd(r.buyMcUsd) : '—'}</td><td class="dim">${r.last ? relT(r.last) : '—'}</td></tr>`).join('')}</table>` : `<div class="empty">${o.exited ? '没有已清仓的地址' : '没有持有人'}</div>`);
  return { html, cnt: o.exited ? `${d.exitedCount} 个已清仓` : `${d.holderCount} 个持有人` };
}
$('#bottomBody').addEventListener('click', (e) => {
  if (e.target.closest('[data-hexited]')) { const o = holdersState(); o.exited = !o.exited; $('#bottomBody').scrollTop = 0; renderBottom(); }
  else if (e.target.closest('[data-hrefresh]')) loadHolders(true);
});
/* ---------- 详情页「活动」右侧的「喊单」栏：社区评论 / callout（/api/callouts：GMGN 官方 OpenAPI 喊单 + four.meme 评论）
   栏展开、页面可见时每 15 秒自动拉一次（服务端每个币缓存 45 秒，GMGN 全链流 45 秒最多拉一次，不会多耗额度）；收起后不再请求。
   列表按 id 逐条建 DOM（textContent，不拼第三方 HTML），新喊单插到最上面并短暂高亮，滚动位置不跳；「多久前」每 2 秒更新 ---------- */
const CALLOUTS = {};   // token → { at, data, loading, err }
const CO_NAME = { four: 'four.meme', gmgn: 'GMGN', debot: 'debot', fomo: 'FOMO', pumpfun: 'pump' };
const CO_CHIPS = [['all', '全部'], ['gmgn', 'GMGN'], ['four', 'four.meme']];   // 没接入的平台（debot / FOMO / pump）不显示
let coFilter = 'all';
function calloutsState() { const k = S.selected || ''; return (CALLOUTS[k] ||= { at: 0, data: null, loading: false, err: null }); }
async function loadCallouts() {
  const k = S.selected, o = calloutsState(); if (!k || o.loading || document.hidden || Date.now() - o.at < 15_000) return;
  o.loading = true; o.err = null;
  try { o.data = await api(`/api/callouts?ca=${encodeURIComponent(k)}`); } catch (e) { o.err = e.message; }
  o.at = Date.now(); o.loading = false; if (S.selected === k) renderCo();
}
const coNorm = (v) => String(v || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function coEl(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
// 没头像：按名字算一个固定颜色的圆形首字母头像（同一个人每次颜色一样）
function coAv0(author) {
  const a = String(author || '?'), ch = [...a.replace(/^0x(?=[0-9a-f]{40}$)/i, '')][0] || '?';
  let h = 0; for (const c of a) h = (h * 31 + c.codePointAt(0)) >>> 0;
  const e = coEl('span', 'co-av co-av0', ch.toUpperCase()); e.style.background = `hsl(${h % 360} 45% 42%)`; return e;
}
function coRow(x) {
  const row = coEl('div', 'co-item'); row.dataset.id = x.id;
  if (/^https?:\/\//i.test(x.avatar || '')) { const im = coEl('img', 'co-av'); im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.addEventListener('error', () => im.replaceWith(coAv0(x.author)), { once: true }); im.src = proxied(x.avatar); row.append(im); }   // 拿不到图换回首字母头像
  else row.append(coAv0(x.author));
  const body = coEl('div', 'co-body'), meta = coEl('div', 'co-meta'), a = String(x.author || '');
  const name = coEl('b', '', /^0x[0-9a-fA-F]{40}$/.test(a) ? a.slice(0, 6) + '…' + a.slice(-4) : a); name.title = a; meta.append(name);
  if (x.kol) meta.append(coEl('i', 'pbadge co-kol', 'KOL'));
  meta.append(coEl('i', 'pbadge co-src', CO_NAME[x.platform] || x.platform));
  const tm = coEl('span', 'co-tm dim', x.ts ? relT(x.ts) : ''); tm.dataset.ts = x.ts || 0; if (x.ts) tm.title = fullTime(x.ts); meta.append(tm);
  const txt = String(x.text || ''); body.append(meta, coEl('div', 'co-text', txt.length > 600 ? txt.slice(0, 600) + '…' : txt));
  if (x.translation && coNorm(x.translation) !== coNorm(txt)) body.append(coEl('div', 'co-tr', String(x.translation).slice(0, 600)));   // 译文和原文只差大小写 / 标点（og → OG）就不显示
  row.append(body); return row;
}
let coOpen = (() => { try { const v = localStorage.getItem('coOpen'); return v == null ? innerWidth > 1250 : v === '1'; } catch { return innerWidth > 1250; } })();   // 窄屏默认收起
function renderCo() {
  const box = $('#coBox'); if (!box) return;
  box.classList.toggle('collapsed', !coOpen);
  const o = S.selected ? calloutsState() : null, d = o?.data, all = d?.items || [];
  $('#coStripCnt').textContent = all.length ? String(all.length) : '';
  if (!coOpen || S.view !== 'trade') return;
  loadCallouts();
  const src = d?.sources || {}, items = all.filter((x) => coFilter === 'all' || x.platform === coFilter);
  const chips = d ? CO_CHIPS.map(([k, label]) => { const s2 = src[k];
    const tip = k === 'all' ? '全部平台' : s2 ? (s2.ok ? `${s2.count} 条${s2.note ? '（' + s2.note + '）' : ''}` : s2.error || '读取失败') : '';
    return `<button class="co-chip${coFilter === k ? ' on' : ''}" data-cof="${k}" title="${esc(tip)}">${esc(label)}${s2 && !s2.ok ? ' ⚠' : ''}</button>`; }).join('') : '';
  const c = $('#coChips'); if (c._html !== chips) { c.innerHTML = chips; c._html = chips; }
  $('#coCnt').textContent = d ? `${items.length} 条` : '';
  const b = $('#coBody'), key = (S.selected || '') + '|' + coFilter;
  if (b._key !== key) { b.textContent = ''; b._key = key; b._ids = new Set(); b._first = true; b.scrollTop = 0; }
  if (!items.length) {
    const msg = !d ? (o?.err ? '读取失败：' + o.err : S.selected ? '正在读取喊单…' : '先选一个币') : '暂无喊单' + (coFilter !== 'all' && src[coFilter]?.note ? '（' + src[coFilter].note + '）' : src.gmgn?.note ? '（GMGN ' + src.gmgn.note + '）' : '');
    if (b._empty !== msg) { b.textContent = ''; b._ids = new Set(); b.append(coEl('div', 'empty', msg)); b._empty = msg; }
    return;
  }
  if (b._empty != null) { b.textContent = ''; b._empty = null; }
  const fresh = items.filter((x) => !b._ids.has(x.id));
  if (fresh.length) {
    const h0 = b.scrollHeight, top0 = b.scrollTop;
    b.querySelector(':scope > .empty')?.remove();
    for (const x of fresh) {   // items 是新 → 旧；按它的顺序找到下一个已存在的行，插到它前面
      const el = coRow(x), i = items.indexOf(x), next = items.slice(i + 1).find((y) => b._ids.has(y.id));
      const ref = next ? b.querySelector(`:scope > [data-id="${CSS.escape(next.id)}"]`) : null;
      b.insertBefore(el, ref); b._ids.add(x.id);
      if (!b._first) { el.classList.add('co-new'); setTimeout(() => el.classList.remove('co-new'), 2500); }
    }
    if (top0 > 0) b.scrollTop = top0 + (b.scrollHeight - h0);   // 用户往下翻着的时候，新内容插在上面不把正在看的推走
    b._first = false;
  }
  b.querySelectorAll('.co-tm').forEach((e) => { const ts = +e.dataset.ts; if (ts) e.textContent = relT(ts); });
}
function setCoOpen(on) { coOpen = on; try { localStorage.setItem('coOpen', on ? '1' : '0'); } catch { /* 无痕模式 */ } renderCo(); }
$('#coBox').addEventListener('click', (e) => {
  const f = e.target.closest('[data-cof]'); if (f) { coFilter = f.dataset.cof; renderCo(); }
  else if (e.target.closest('#coClose')) setCoOpen(false);
  else if (e.target.closest('#coOpen')) setCoOpen(true);
});
setInterval(() => { if (!document.hidden) renderCo(); }, 2000);   // 更新「多久前」+ 到点自动拉新（15 秒）；收起 / 不在详情页时不请求
renderCo();

/* ---------- K 线右边的「活动」：和实时成交同一份数据；点「时间」切换倒序 / 正序（记住），点行打开交易者抽屉 ---------- */
let actAsc = (() => { try { return localStorage.getItem('actAsc') === '1'; } catch { return false; } })();
// 每笔成交当时的市值 = 这笔的成交价（报价币）× 总量 × 报价币美元价；拿不到成交价才用记录里的市值
const tradeMc = (r, t) => (r.price > 0 && t ? r.price * (t.maxSupply || 1e9) * (t.quoteUsd || (String(t.quote || 'BNB').toUpperCase() === 'BNB' ? S.bnbUsd : 0)) : 0) || r.mcapUsd || 0;
const relT = (ts) => { const s2 = Math.max(0, (Date.now() - ts) / 1000); return s2 < 60 ? Math.floor(s2) + 's' : s2 < 3600 ? Math.floor(s2 / 60) + 'm' : s2 < 86400 ? Math.floor(s2 / 3600) + 'h' : Math.floor(s2 / 86400) + 'd'; };
function actRows() {
  const OT = olderTrades(); const seen = new Set();
  return [...(S.detail?.trades || []), ...OT.items].filter((r) => { const k = `${r.tx}:${r.side}:${r.tokens}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => { const d = (a.ts - b.ts) || ((a.blk || 0) - (b.blk || 0)) || ((a.li || 0) - (b.li || 0)); return actAsc ? d : -d; });   // 同一秒的几笔按区块 / 块内序号（Gang 内盘链上成交带 blk / li）
}
function renderAct() {
  const body = $('#actBody'); if (!body || S.view !== 'trade') return;
  const t = S.tokens.get(S.selected); const OT = olderTrades(); const rows = actRows();
  $('#actSort').textContent = `时间 ${actAsc ? '↑' : '↓'}`; $('#actSort').title = actAsc ? '正序（最早在上），点击切换为倒序' : '倒序（最新在上），点击切换为正序';
  $('#actCnt').textContent = rows.length ? `${rows.length} 笔${OT.end ? '（全部）' : ''}` : '';
  const qu = t?.quoteUsd || S.bnbUsd;
  // 正序时如果还没加载到开盘第一笔，先自动往前加载（最多加载到全部）
  if (actAsc && !OT.end && !OT.loading && LIVE()) loadOlderTrades();
  const prevTop = body.scrollTop, prevH = body.scrollHeight, atBottom = prevH - prevTop - body.clientHeight < 30;
  body.innerHTML = rows.slice(0, 1500).map((r) => `<div class="act-r ${isMe(r.trader) ? 'mine' : ''}" data-trader="${esc(r.trader || '')}" title="${fullTime(r.ts)} · ${r.side === 'buy' ? '买入' : '卖出'} ${K(r.tokens)} 个">
    <span class="act-amt ${r.side === 'buy' ? 'g' : 'r'}"><i class="sd ${r.side}"></i>$${(r.usd ?? (r.bnb || 0) * qu).toFixed(2)}</span><span class="mc">${usd(tradeMc(r, t))}</span><span>${LIVE() && r.trader ? gmgnWho(r.trader, nameOf(r), 4, 4) : esc(short(r.trader || '', 4, 4))}</span><span class="tm">${relT(r.ts)}</span></div>`).join('')
    + (LIVE() ? `<div class="act-foot" id="actFoot">${OT.end ? '— 已到开盘第一笔 —' : OT.loading || OT.pending ? '正在补全链上成交…' : (actAsc ? '正在补全更早的成交…' : '往下滚动加载更早的成交')}</div>` : '');
  if (actAsc) { if (atBottom) body.scrollTop = body.scrollHeight; else body.scrollTop = prevTop; }   // 正序：在底部时跟着新成交往下，否则保持不动
  else body.scrollTop = prevTop;
}
$('#actSort').addEventListener('click', () => { actAsc = !actAsc; try { localStorage.setItem('actAsc', actAsc ? '1' : '0'); } catch { /* ignore */ } $('#actBody').scrollTop = 0; renderAct(); });
$('#actBody').addEventListener('scroll', (e) => { const b = e.currentTarget; if (!actAsc && b.scrollHeight - b.scrollTop - b.clientHeight < 80) loadOlderTrades(); }, { passive: true });
$('#actBody').addEventListener('click', (e) => {
  if (e.target.closest('#actFoot')) return loadOlderTrades();
  const row = e.target.closest('.act-r[data-trader]'); if (!row || !row.dataset.trader || row.dataset.trader.startsWith('user:')) return;
  e.preventDefault(); openTrader(row.dataset.trader);
});
setInterval(() => { if (S.view === 'trade') renderAct(); }, 1000);

/* ---------- 交易者抽屉：点「活动」/「持有人」里的一行 / 地址，右侧滑出这个地址在当前币上的盈亏（GMGN 那种） ---------- */
function openTrader(addr) {
  const t = S.tokens.get(S.selected); if (!t || !/^0x[0-9a-fA-F]{40}$/.test(addr || '')) return;
  $('.tr-drawer-back')?.remove();
  const back = document.createElement('div'); back.className = 'tr-drawer-back';
  back.innerHTML = `<aside class="tr-drawer" role="dialog" aria-modal="true"><div class="trd-h"><div class="trd-who">${gmgnWho(addr, NAMES[addr.toLowerCase()])}</div><button class="x" data-trd-close>×</button></div>
    <div class="trd-b"><div class="empty">正在读取 ${esc(short(addr, 6, 4))} 在 ${esc(t.symbol)} 上的成交…</div></div></aside>`;
  document.body.appendChild(back); requestAnimationFrame(() => back.classList.add('in'));
  const close = () => { document.removeEventListener('keydown', key, true); back.classList.remove('in'); setTimeout(() => back.remove(), 200); };
  const key = (e) => { if (e.key === 'Escape' && document.querySelectorAll('.ui-dlg-back').length === 0) { e.preventDefault(); close(); } };
  document.addEventListener('keydown', key, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.addEventListener('click', async (e) => {
    if (e.target.closest('[data-trd-close]')) return close();
    const cp = e.target.closest('[data-trd-copy]'); if (cp) { try { await copyOrThrow(addr); cp.textContent = '已复制'; } catch { cp.textContent = '复制失败'; } }
  });
  api(`/api/trader/${t.address}/${addr}`).then((d) => { if (back.isConnected) back.querySelector('.trd-b').innerHTML = traderHtmlFull(d, t); }).catch((e) => { if (back.isConnected) back.querySelector('.trd-b').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; });
}
function traderHtmlFull(d, t) {
  const U = (q) => q * d.qUsd, B = (q) => q * d.qBnb, q = esc(d.quote);
  const money = (qv, signed) => { const u = U(qv), b = B(qv); const s2 = signed ? (u >= 0 ? '+' : '−') : ''; return `<b class="${signed ? (u >= 0 ? 'g' : 'r') : ''}">${s2}$${Math.abs(u).toFixed(2)}</b><small>${s2}${bnb(Math.abs(b), 4)} BNB · ${s2}${K(Math.abs(qv))} ${q}</small>`; };
  const px = (v) => (v == null ? '—' : `$${sub(v * d.qUsd)}`);
  const cell = (k, v, tip = '') => `<div title="${esc(tip)}"><span>${k}</span>${v}</div>`;
  return `<div class="trd-addr"><span class="mono">${esc(d.trader)}</span><button class="ui-copy" data-trd-copy>复制</button></div>
    <div class="trd-links"><a href="https://bscscan.com/address/${esc(d.trader)}" target="_blank" rel="noopener">BscScan ↗</a><a href="https://gmgn.ai/bsc/address/${esc(d.trader)}" target="_blank" rel="noopener">GMGN ↗</a>${isMe(d.trader) ? '<i class="me-tag">我</i>' : ''}</div>
    <div class="trd-pnl">${cell('总盈亏', money(d.total, true) + (d.pct != null ? `<small class="${d.pct >= 0 ? 'g' : 'r'}">${d.pct >= 0 ? '+' : ''}${d.pct.toFixed(1)}%</small>` : ''), '已实现 + 未实现（按现价）。买入按实际付出（含平台费），卖出按到手金额；不含 gas。美元 / BNB 按报价币现价换算')}</div>
    <div class="trd-grid">
      ${cell('已实现', money(d.realized, true), '卖出收入 − 卖出部分按买入均价算的成本')}${cell('未实现', money(d.unrealized, true), '当前持有 × 现价 − 持有部分按买入均价算的成本')}
      ${cell(`买入 ${d.buys} 笔`, money(d.boughtQ) + `<small>${K(d.boughtTokens)} 个</small>`)}${cell(`卖出 ${d.sells} 笔`, money(d.soldQ) + `<small>${K(d.soldTokens)} 个</small>`)}
      ${cell('买入均价', `<b>${px(d.avgBuy)}</b><small>${d.avgBuy != null ? sub(d.avgBuy) + ' ' + q : ''}</small>`)}${cell('卖出均价', `<b>${px(d.avgSell)}</b><small>${d.avgSell != null ? sub(d.avgSell) + ' ' + q : ''}</small>`)}
      ${cell('当前持有', `<b>${K(d.hold)}</b><small>${d.holdSrc === 'chain' ? '链上余额' : '按买卖差估算'}</small>`)}${cell('持有价值', money(d.holdQ))}
      ${cell('首次买入', `<b>${d.firstBuy ? new Date(d.firstBuy).toLocaleString('zh-CN', { hour12: false }) : '—'}</b>`)}
    </div>
    ${d.complete ? '' : '<p class="ui-note">成交很多，只统计了最近 1000 笔。</p>'}
    <div class="trd-t"><b>${esc(t.symbol)} 成交（${d.trades.length}）</b></div>
    <table class="ttable"><tr><th>时间</th><th class="l">方向</th><th>数量</th><th>价格</th><th title="买入按实际付出（含 1% 平台费），卖出按到手金额；美元按报价币现价换算">金额</th><th class="l">交易</th></tr>
      ${d.trades.map((x) => `<tr><td class="dim">${new Date(x.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td><td class="l ${x.side === 'buy' ? 'g' : 'r'}">${x.side === 'buy' ? '买入' : '卖出'}</td><td>${K(x.tokens)}</td><td>${x.tokens ? px(x.bnb / x.tokens) : '—'}</td><td>$${U(x.bnb).toFixed(2)}<div class="hsub">${K(x.bnb)} ${q}</div></td><td class="l">${x.tx ? `<a href="https://bscscan.com/tx/${x.tx}" target="_blank" rel="noopener">${x.tx.slice(0, 6)}↗</a>` : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">没有成交</td></tr>'}
    </table>${trdActs(d.trader)}`;
}
document.addEventListener('click', (e) => {
  const row = e.target.closest('#bottomBody tr.trow[data-trader]'); if (!row || e.target.closest('a')) return;
  if (row.dataset.trader.startsWith('user:')) return;   // 模拟盘钱包
  e.preventDefault(); openTrader(row.dataset.trader);
});

/* ---------- 启动 ---------- */
(async function boot() {
  try { S.fast = localStorage.fast === '1'; } catch { S.fast = false; }
  const st = await api('/api/state');
  if (st.holdings) setHoldSnap(st.holdings);
  (st.routeAlerts || []).filter((a) => Date.now() - a.at < 3_600_000).reverse().forEach(routeAlert);
  S.orderSlots = !!st.orderSlots;   // 后端支持「只在指定钱包下单」
  Object.assign(S, { mode: st.mode, baw: st.baw, block: st.block, bnbUsd: st.bnbUsd, gangMcap: st.gangMcap, net: st.net, wallets: st.wallets, settings: st.settings, config: st.config, usage: st.usage, positions: st.positions, orders: st.orders, logs: st.logs, records: st.records, snipeCurve: st.snipeCurve });
  S.tokens = new Map(st.tokens.map((t) => [t.address, t]));
  S.selWallets = new Set(S.wallets.map((w) => w.id)); S.activeWallet = S.wallets[0]?.id || S.activeWallet;
  if (LIVE()) S.platform = 'flap';
  const prefs = loadPrefs(); S.prefSel = prefs.selected || null;
  const r0 = applyRoute(); if (!location.hash && prefs.view === 'pulse') setView('pulse', true);
  applyActive(); if (prefs.amount && !r0.ca) { const am = $('#amount'); if (am) am.value = prefs.amount; }
  renderControls(); pickDefault(); connect(); renderBottom();
  if (LIVE()) api('/api/token-rules').then((r) => { S.rules = r || {}; scheduleRender(); }).catch(() => {});
  renderFavBar(); api('/api/favorites').then(setFav).catch(() => {});
  if (LIVE()) api('/api/wallets').then((v) => { S.walletsInfo = v; renderAuth(); scheduleRender(); }).catch(() => {});   // 多钱包状态（之后每 10 秒通过 WS 推送）
  api('/api/blocklist').then(async (b) => { S.blk = b; afterBlock(); await migrateHidden(); }).catch(() => {});
  if (LIVE()) api('/api/track').then((x) => { if (!TRK.targets.length && x?.targets) { TRK.targets = x.targets; scheduleRender(); renderBottom(); } }).catch(() => {});   // 先拿追踪列表，备注过的钱包在成交列表里显示黄色
  setInterval(() => { if (S.bottomTab === 'logs') return; renderBottom(); }, 2000);
})();

/* ---------- K 线 / 成交区 上下拖动 ---------- */
(() => {
  const sp = $('#vsplit'), bot = document.querySelector('.panel.bottom'); if (!sp || !bot) return;
  const saved = +localStorage.getItem('bottomH'); if (saved > 0) bot.style.height = saved + 'px';
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault(); const y0 = e.clientY, h0 = bot.offsetHeight; sp.classList.add('drag'); document.body.style.cursor = 'row-resize';
    const max = () => (bot.parentElement?.clientHeight || window.innerHeight) - 160;
    const mv = (ev) => { const h = Math.max(120, Math.min(max(), h0 + (y0 - ev.clientY))); bot.style.height = h + 'px'; window.dispatchEvent(new Event('resize')); };
    const up = () => { sp.classList.remove('drag'); document.body.style.cursor = ''; localStorage.setItem('bottomH', bot.offsetHeight); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
})();

try { applyRoute(); } catch {}

/* ---------- 左栏宽度：拖动中间的分隔条调整（320～640px），记在本机浏览器里，双击恢复 400px ---------- */
(() => {
  const layout = document.querySelector('main.layout'), bar = $('#splitter'); if (!layout || !bar) return;
  const DEF = 400, MIN = 320, MAX = 640;
  const set = (w) => { w = Math.round(Math.max(MIN, Math.min(MAX, w))); layout.style.setProperty('--leftW', w + 'px'); return w; };
  let saved = null; try { saved = Number(localStorage.getItem('leftW')); } catch { /* 无痕模式等 */ }
  if (saved) set(saved);
  let start = null;
  bar.addEventListener('pointerdown', (e) => { start = { x: e.clientX, w: layout.querySelector('.panel.left').getBoundingClientRect().width }; bar.setPointerCapture(e.pointerId); bar.classList.add('drag'); });
  bar.addEventListener('pointermove', (e) => { if (start) set(start.w + e.clientX - start.x); });
  bar.addEventListener('pointerup', () => { if (!start) return; start = null; bar.classList.remove('drag'); try { localStorage.setItem('leftW', parseInt(getComputedStyle(layout).getPropertyValue('--leftW'))); } catch { /* ignore */ } });
  bar.addEventListener('dblclick', () => { set(DEF); try { localStorage.removeItem('leftW'); } catch { /* ignore */ } });
})();

/* ---------- 头像放大预览：鼠标在头像上停 150ms 显示大图，跟着头像位置，始终在屏幕内 ---------- */
(() => {
  const peek = document.createElement('div'); peek.className = 'logo-peek hidden'; document.body.appendChild(peek);
  let key = null, timer = 0, hideTimer = 0;
  const tokenOf = (logo) => { const h = logo.closest('[data-a],[data-pa],[data-sel]'); return S.tokens.get(h?.dataset.a || h?.dataset.pa) || (h?.dataset.a ? null : S.tokens.get(S.selected)); };
  const place = (logo) => {
    const r = logo.getBoundingClientRect(), w = peek.offsetWidth, h = peek.offsetHeight;
    let x = r.right + 12, y = r.top + r.height / 2 - h / 2;
    if (x + w > innerWidth - 8) x = r.left - w - 12;
    peek.style.left = Math.max(8, x) + 'px'; peek.style.top = Math.max(8, Math.min(innerHeight - h - 8, y)) + 'px';
  };
  const show = (logo) => {
    const t = tokenOf(logo); const img = logo.querySelector('img');
    peek.innerHTML = `<div class="pk-img ${t?.platform === 'four' ? 'four' : ''}">${img ? `<img src="${esc(img.getAttribute('src'))}" alt="">` : esc(String(t?.symbol || logo.textContent || '?').slice(0, 2).toUpperCase())}</div>`
      + (t ? `<div class="pk-name">${esc(t.symbol)}${t.name && t.name !== t.symbol ? `<span>${esc(t.name)}</span>` : ''}</div>` : '');
    peek.classList.remove('hidden'); place(logo);
  };
  // 用事件委托：列表每秒重画，换成同一个代币的新元素时不重新计时、不闪
  document.addEventListener('pointerover', (e) => {
    const logo = e.target.closest?.('.logo');
    if (!logo || logo.closest('.logo-peek')) { clearTimeout(timer); clearTimeout(hideTimer); hideTimer = setTimeout(() => { key = null; peek.classList.add('hidden'); }, 60); return; }
    clearTimeout(hideTimer);
    const k = (tokenOf(logo)?.address || '') + '|' + logo.className;
    if (k === key && !peek.classList.contains('hidden')) { place(logo); return; }
    key = k; clearTimeout(timer); timer = setTimeout(() => show(logo), 150);
  });
  document.addEventListener('pointerleave', () => { clearTimeout(timer); key = null; peek.classList.add('hidden'); });
  window.addEventListener('scroll', () => peek.classList.add('hidden'), true);
})();

/* ---------- 持仓：链上数量 + 钱包历史算成本；每 15 秒刷新 ---------- */
try { const v = JSON.parse(localStorage.getItem('holdPlats') || 'null'); if (Array.isArray(v) && v.length) HOLD.plats = new Set(v); } catch { /* ignore */ }
async function loadHold(refresh = false) {
  try { HOLD.data = fixClosed(await api('/api/holdings' + (refresh ? '?refresh=1' : ''))); } catch (e) { HOLD.err = e.message; }
  renderHold(); loadQuoteBal(refresh);
}
// 计价币余额（BNCB / GANG / NVDAB / WBNB 等）：Flap、Gang V2 买卖中间换出来没换回 BNB 的部分。每个币一个「全部换回 BNB」
async function loadQuoteBal(force = true) {
  if (!LIVE()) return;
  if (!force && Date.now() - (HOLD.quoteAt || 0) < 30_000) return renderQuoteBal(); HOLD.quoteAt = Date.now();   // baw 余额是 CLI 调用，定时刷新时 30 秒最多一次
  const slot = HOLD.wslot || 0;   // 跟着持仓页选的钱包：全部钱包 = 所有「参与下单」的钱包（每行带钱包名）；某个钱包 = 只看它的
  try { const v = await api('/api/quote-balances?slot=' + slot); if (slot !== (HOLD.wslot || 0)) return; HOLD.quote = v; HOLD.quoteSlot = slot; HOLD.quoteErr = null; } catch (e) { if (slot !== (HOLD.wslot || 0)) return; HOLD.quoteErr = e.message; }
  renderQuoteBal();
}
function renderQuoteBal() {
  const box = $('#holdQuote'); if (!box || S.view !== 'hold') return;
  const sel = HOLD.wslot || 0, q = (HOLD.quote || []).filter((r) => !(r.valueUsd != null && r.valueUsd < 0.5) && (!sel || r.slot === sel));   // 价值不到 $0.5 的零头不显示（只是不显示，余额和换回逻辑不变）；切到某个钱包时先按已有数据筛，新数据回来再刷新
  const multi = !sel && (HOLD.data?.wallets || []).length > 1;
  if (!q.length && !HOLD.quoteErr) { box.innerHTML = ''; return; }
  const busy = (a) => S.orders?.some((o) => o.status === 'pending' && String(o.token).toLowerCase() === a.toLowerCase());
  box.innerHTML = `<div class="hq-h"><b>计价币余额</b><span class="hsub">Flap / Gang V2 买卖时中间换出来、还没换回 BNB 的币。按钮按点击那一刻的余额全部换回</span><span class="spacer" style="flex:1"></span><button class="qb" data-q2ball title="${(HOLD.data?.wallets || []).length > 1 && !HOLD.wslot ? '所有「参与下单」的钱包' : '当前选中的钱包'}：每个计价币先报价，确认后才发交易">一键全部兑换成 BNB</button></div>
    ${HOLD.quoteErr ? `<div class="hsub r">读取失败：${esc(HOLD.quoteErr)}</div>` : ''}
    <table><tr>${multi ? '<th class="l">钱包</th>' : ''}<th class="l">币</th><th>余额</th><th>单价</th><th>价值 (BNB)</th><th>价值 (USD)</th><th class="l">操作</th></tr>
    ${q.map((r) => `<tr>${multi ? `<td class="l">${esc(r.label || '')}</td>` : ''}<td class="l"><b>${esc(r.symbol)}</b> <span class="hsub mono">${short(r.token, 6, 4)}</span></td><td class="mono">${esc(r.balance)}</td><td>${r.priceUsd ? usd(r.priceUsd) : '—'}</td>
      <td>${r.valueBnb != null ? bnb(r.valueBnb, 5) : '—'}</td><td>${usd(r.valueUsd || 0)}</td>
      <td class="l acts">${busy(r.token) ? '<span class="hsub">处理中…</span>' : `<button class="qb" data-q2b="${r.token}" data-q2bslot="${r.slot || ''}">${r.wbnb ? '解包成 BNB' : '全部换回 BNB'}</button>`}</td></tr>`).join('')}</table>`;
}
async function quoteToBnb(token, slot) {   // slot：这一行属于哪个钱包（其他钱包由主后端转给它自己的后端，登录由那边检查）
  const own = !slot || slot === (HOLD.data?.wallets || [])[0]?.slot;
  if (own && (!S.baw?.auth || S.baw.auth.state !== 'ok')) { renderAuth(); return note('币安钱包未登录，请先登录', 'info'); }
  note('正在按当前余额报价…', 'info');
  let p; try { p = await api('/api/quote-to-bnb/preview', { token, slot, slippage: 1 }); } catch (e) { return toast({ status: 'failed', symbol: '换回 BNB', reason: e.message }); }
  const go = async () => {
    topPop({ status: 'pending', side: 'sell', symbol: p.symbol, amountIn: 100 });
    try { const o = await api('/api/quote-to-bnb', { token, slot, slippage: p.slippage }); if (o.status === 'failed') toast(o); }
    catch (e) { toast({ status: 'failed', symbol: p.symbol, reason: e.message }); }
    setTimeout(() => loadQuoteBal(true), 3000); setTimeout(() => loadHold(true), 8000);
  };
  const diff = p.midBnb ? ((p.out - p.midBnb) / p.midBnb) * 100 : null;
  $('#confirmBody').innerHTML = `
    ${slot && (HOLD.data?.wallets || []).length > 1 ? `<div class="kv"><span>钱包</span><b class="sans">${esc((HOLD.data.wallets.find((w) => w.slot === slot) || {}).label || `钱包 ${slot}`)}</b></div>` : ''}
    <div class="kv"><span>换出</span><b>${esc(String(p.balance))} ${esc(p.symbol)}（全部）</b></div>
    <div class="kv"><span>预计到手</span><b class="g">${bnb(p.out, 6)} BNB</b></div>
    <div class="kv"><span>最少到手</span><b>${bnb(p.minOut, 6)} BNB${p.slippage ? `（滑点 ${p.slippage}%）` : ''}</b></div>
    ${diff != null ? `<div class="kv"><span>对比 DEX 参考价</span><b class="${diff < -2 ? 'r' : ''}">${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%（报价已含路由手续费）</b></div>` : ''}
    <div class="kv"><span>路径</span><b>${esc(p.route)}</b></div>
    <div class="note" style="color:#f6465d">真实交易：用你的币安 Agentic 钱包上链，无法撤回。实际成交以链上为准；如果币安 App 弹出确认，请在 App 里处理。</div>
    <button class="big-btn sell" id="confirmGo">确认换回 BNB</button>`;
  $('#confirmModal').classList.remove('hidden');
  $('#confirmGo').onclick = () => { $('#confirmModal').classList.add('hidden'); go(); };
}
// 一键全部兑换成 BNB：全部钱包模式 = 所有「参与下单」的钱包，选了某个钱包 = 只那一个。先给每个钱包 × 计价币报价（不发交易），确认框列出来；确认后各钱包同时换、同一钱包按顺序
async function quoteSweepAll() {
  note('正在按每个钱包当前余额报价…', 'info');
  let plan; try { plan = await api('/api/quote-to-bnb/plan', { slot: HOLD.wslot || 0, slippage: 1 }); } catch (e) { return toast({ status: 'failed', symbol: '一键换回 BNB', reason: e.message }); }
  const ok = (w) => !w.error && w.auth === 'ok', todo = plan.filter((w) => ok(w) && w.items.length);
  const total = todo.reduce((a, w) => a + w.items.reduce((x, i) => x + (i.out || 0), 0), 0);
  const qn = (v) => esc(String(+Number(v).toPrecision(6)));
  const why = (w) => (w.error ? `<span class="r">${esc(w.error)}</span>` : !ok(w) ? '<span class="r">币安钱包未登录，跳过</span>' : '<span class="hsub">没有要换的计价币</span>');
  $('#confirmBody').innerHTML = `
    ${plan.map((w) => `<div class="kv"><span><b>${esc(w.label)}</b></span><b>${ok(w) && w.items.length ? `${w.items.length} 个币` : why(w)}</b></div>
      ${ok(w) ? w.items.map((i) => `<div class="kv"><span>${qn(i.balance)} ${esc(i.symbol)}<br><span class="hsub">${esc(i.route)}</span></span><b class="g" style="flex:none">≈ ${bnb(i.out, 6)} BNB</b></div>`).join('') : ''}
      ${(w.skipped || []).map((i) => `<div class="kv"><span class="hsub">${qn(i.balance)} ${esc(i.symbol)}</span><span class="hsub">跳过：${esc(i.reason)}</span></div>`).join('')}`).join('<hr style="border:0;border-top:1px solid var(--line,#2b3139);margin:6px 0">')}
    ${todo.length ? `<div class="kv"><span>合计预计到手</span><b class="g">${bnb(total, 6)} BNB</b></div>
    <div class="note" style="color:#f6465d">真实交易：每个币一笔（Ondo 类经 USDT 两笔），用各自的币安 Agentic 钱包上链，无法撤回。按点击时的余额全部换，滑点 1%；如果币安 App 弹出确认，请在 App 里处理。</div>
    <button class="big-btn sell" id="confirmGo">确认全部换回 BNB</button>` : '<div class="note">没有可以换的计价币（零头和没有路线的已跳过）。</div>'}`;
  $('#confirmModal').classList.remove('hidden');
  if (!todo.length) return;
  $('#confirmGo').onclick = async () => {
    $('#confirmModal').classList.add('hidden');
    topPop({ status: 'pending', side: 'sell', symbol: '计价币全部换回 BNB' });
    let res; try { res = await api('/api/quote-to-bnb/sweep', { plan: todo.map((w) => ({ slot: w.slot, tokens: w.items.map((i) => i.token) })), slippage: 1 }); }
    catch (e) { POP.clear(); topPop({ status: 'failed', side: 'sell', symbol: '计价币全部换回 BNB', reason: e.message }); return; }
    // 一个弹窗：每个钱包 × 币一行（钱包名开头）；没有要换的钱包灰色「无余额」
    POP.clear();
    for (const w of plan) {
      const r = res.find((x) => x.slot === w.slot), base = { wallet: w.label, walletSlot: w.slot, side: 'sell' };
      if (!r) { if (ok(w)) topPop({ ...base, token: '', status: 'failed', noBalance: true, symbol: '计价币' }); else topPop({ ...base, token: '', status: 'failed', symbol: '计价币', reason: w.error || '币安钱包未登录' }); continue; }
      if (r.error) topPop({ ...base, token: '', status: 'failed', symbol: '计价币', reason: r.error });
      for (const o of r.orders) topPop({ ...base, token: o.token, status: o.status, stage: o.stage, symbol: `${o.symbol || '?'} → BNB`, out: o.out, tx: o.tx, reason: o.reason });
    }
    setTimeout(() => loadQuoteBal(true), 3000); setTimeout(() => loadHold(true), 8000);
  };
}
// 带正负号的数：格式化用绝对值，避免小数格式化函数遇到负数出 NaN
const sgn = (v, f) => (v == null || !isFinite(v) ? '—' : `<span class="${v >= 0 ? 'g' : 'r'}">${v >= 0 ? '+' : '−'}${f(Math.abs(v))}</span>`);
const usdSigned = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`);
const usdTip = (r) => (r.usdBasis === 'trade' ? '美元按每笔成交当时的 BNB/USDT 价格（币安小时 K 线）；余额按现价' : '这个币没有钱包历史，美元按现在的 BNB 价格估算');
const ago = (ts) => { if (!ts) return '—'; const s = (Date.now() - ts) / 1000; return s < 3600 ? Math.round(s / 60) + ' 分钟' : s < 86400 ? (s / 3600).toFixed(1) + ' 小时' : (s / 86400).toFixed(1) + ' 天'; };
function renderHold() {
  if (S.view === 'hold' && LIVE() && !$('#holdSwap').dataset.ready) swLoadInfo();
  const d0 = HOLD.data; if (!d0 || S.view !== 'hold') return;
  // 多钱包：全部（合并） / 某一个钱包
  const ws = d0.wallets || [], wsel = ws.find((w) => w.slot === HOLD.wslot);
  const d = wsel ? { ...d0, rows: wsel.rows || [], totals: wsel.totals || {}, bnb: wsel.bnb } : d0;
  let wf = $('#holdWallets'); if (!wf && ws.length > 1) { wf = document.createElement('div'); wf.id = 'holdWallets'; wf.className = 'hold-wf'; $('#holdTot').before(wf); wf.addEventListener('click', (e) => { const b = e.target.closest('[data-hw]'); if (!b) return; HOLD.wslot = Number(b.dataset.hw) || 0; renderHold(); renderQuoteBal(); loadQuoteBal(true); }); }
  if (wf) wf.innerHTML = ws.length > 1 ? [{ slot: 0, label: '全部钱包' }, ...ws].map((w) => `<button class="${(HOLD.wslot || 0) === w.slot ? 'on' : ''}" data-hw="${w.slot}">${esc(w.label)}</button>`).join('') : '';
  const dust = $('#holdDust').checked;
  $$('#holdPlats [data-hp]').forEach((c) => c.classList.toggle('off', !HOLD.plats.has(c.dataset.hp)));
  const rows = d.rows.filter((r) => HOLD.plats.has(r.platform === 'four' || r.platform === 'gang' ? r.platform : 'flap') && (!dust || (r.amount > 0 && r.valueBnb >= 0.0005) || r.stage === 'claim'));
  const T = d.totals || {};
  // 「持仓中」按页面上实际显示的行数算；被「隐藏小额」藏起来的单独说明
  const openRows = d.rows.filter((r) => r.amount > 0), shownOpen = rows.filter((r) => r.amount > 0).length, hiddenOpen = openRows.length - shownOpen;
  const tip = '美元：余额按现在的 BNB 价；成本和卖出按每笔成交当时（所在小时）的 BNB/USDT 价格。所以美元盈亏 ≠ BNB 盈亏 × 现价，差额来自 BNB 本身涨跌';
  $('#holdTot').innerHTML = `<div><span>持仓余额</span><b>$${(T.valueUsd ?? (T.valueBnb || 0) * d.bnbUsd).toFixed(2)}</b> <span>${bnb(T.valueBnb || 0)} BNB</span></div>
    <div title="${tip}"><span>累计买入成本</span><b>$${(T.costUsd || 0).toFixed(2)}</b> <span>${bnb(T.costBnb || 0)} BNB</span></div><div title="${tip}"><span>累计卖出</span><b>$${(T.soldUsd || 0).toFixed(2)}</b> <span>${bnb(T.soldBnb || 0)} BNB</span></div>
    <div title="${tip}"><span>总盈亏（含已卖出）</span><b>${sgn(T.pnlUsd || 0, (v) => '$' + v.toFixed(2))}</b> <span>${T.costUsd > 0 ? sgn(((T.pnlUsd || 0) / T.costUsd) * 100, (v) => v.toFixed(1) + '%') : ''}</span></div>
    <div><span>BNB 余额</span><b>${bnb(d.bnb || 0)}</b></div><div><span>更新于</span><b style="font-size:14px">${new Date(d.updatedAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false })}</b></div><div><span>持仓中</span><b>${shownOpen} 个</b>${hiddenOpen ? ` <a href="#" class="hsub" data-hshow>（另有 ${hiddenOpen} 个小额已隐藏 · 显示）</a>` : ''}</div>`;
  const stageTxt = (r) => (r.stage === 'claim' ? '<span class="tag y">可领取</span>' : r.stage === 'curve' ? '<span class="tag">内盘</span>' : '<span class="tag g">已迁移</span>');
  const canTrade = (r) => r.amount > 0;
  $('#holdBody').innerHTML = rows.length ? `<table><tr><th class="l">代币</th><th class="l">状态</th><th>数量</th><th>占总量</th><th title="平均买入价（美元；悬停看报价币 / BNB 单价）">买入均价</th><th title="我持有的这部分按现价值多少（不是代币市值）">余额</th><th>成本</th><th>已卖出</th><th>盈亏</th><th>卖出费率</th><th>首次买入</th><th class="l">操作</th></tr>
    ${rows.map((r) => `<tr class="hrow" data-hold="${r.token}"><td class="l"><span class="side" data-a="${r.token}">${logoHtml({ ...r, address: r.token })}<span><b>${esc(r.symbol)}</b>${xsBtn(r.token, 'xs-hold')} <i class="pbadge" style="margin-left:4px">${r.platform === 'four' ? 'Four' : r.platform === 'gang' ? 'Gang' : 'Flap'}</i>${r.isQuote ? '<i class="pbadge" style="margin-left:4px;color:#f0b90b" title="这个币也是其他盘的报价币：Gang V2 / Flap 买卖时换出来、没换回 BNB 的部分会留在这里">计价币</i>' : ''}<div class="hsub">${esc(r.name || '')}${r.source === 'app' ? ' · 成本按本程序订单' : ''}</div></span></span></td>
      <td class="l">${stageTxt(r)}</td><td>${K(r.amount)}</td><td>${r.supplyPct != null ? r.supplyPct.toFixed(3) + '%' : '—'}</td><td title="${r.avgBuyQuote && r.quote !== 'BNB' ? sub(r.avgBuyQuote) + ' ' + esc(r.quote) : r.avgBuyBnb ? sub(r.avgBuyBnb) + ' BNB' : ''}">${r.avgBuyUsd ? '$' + sub(r.avgBuyUsd) : '—'}</td>
      <td>${r.valueBnb != null ? `<span title="${bnb(r.valueBnb)} BNB${r.quote !== 'BNB' && r.price ? ` · ${K(r.amount * r.price)} ${esc(r.quote)}` : ''}">$${(r.valueUsd || 0).toFixed(2)}</span>` : `<span class="y" title="${esc(r.warn || '')}">— ⚠</span>`}</td><td title="${usdTip(r)}">$${(r.costUsd || 0).toFixed(2)}</td><td title="${usdTip(r)}">${r.soldBnb ? '$' + (r.soldUsd || 0).toFixed(2) : '$0'}</td>
      <td title="${usdTip(r)}">${r.pnlUsd == null ? `<span class="muted" title="${esc(r.warn || '')}">—</span>` : sgn(r.pnlUsd, (v) => '$' + v.toFixed(2))}${r.pnlPct != null ? ' <span class="hsub">' + sgn(r.pnlPct, (v) => v.toFixed(1) + '%') + '</span>' : ''}</td><td class="${(S.tokens.get(r.token)?.sellFeePct || 0) >= 5 ? 'r' : ''}">${pctTxt(S.tokens.get(r.token)?.sellFeePct)}</td><td>${ago(r.firstAt)}</td>
      <td class="l acts">${r.stage === 'claim' ? `<button class="qb" data-claim="${r.claimMarket}">领取</button>` : ''}${canTrade(r) ? (r.isQuote ? `<button class="qb" data-hsell="${r.walletId}:${r.token}:100" title="全部换回 BNB">换回 BNB</button>` : [25, 50, 100].map((p) => `<button class="qb" style="color:var(--r)" data-hsell="${r.walletId}:${r.token}:${p}">${p === 100 ? '清仓' : '卖' + p + '%'}</button>`).join('')) : ''}</td></tr>
      ${HOLD.open.has(r.token) ? `<tr class="hist"><td colspan="12">${r.trades.length ? r.trades.map((x) => `<div class="hsub"><span class="${x.side === 'buy' ? 'g' : 'r'}">${x.side === 'buy' ? '买入' : '卖出'}</span> ${new Date(x.ts).toLocaleString('zh-CN', { hour12: false })} · ${K(x.tokens)} 个 · ${bnb(x.bnb)} BNB · ${txLink(x.tx)}</div>`).join('') : '<span class="hsub">钱包历史里没有这笔持仓的买卖记录（Flap 曲线份额只记录本程序下的单）</span>'}</td></tr>` : ''}`).join('')}</table>`
    : `<div class="empty">${HOLD.err ? esc(HOLD.err) : '暂无持仓'}</div>`;
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('#holdPlats [data-hp]');
  if (chip) { const p = chip.dataset.hp; if (HOLD.plats.has(p)) { if (HOLD.plats.size > 1) HOLD.plats.delete(p); } else HOLD.plats.add(p); try { localStorage.setItem('holdPlats', JSON.stringify([...HOLD.plats])); } catch { /* ignore */ } return renderHold(); }
  if (e.target.closest('[data-hshow]')) { e.preventDefault(); $('#holdDust').checked = false; return renderHold(); }
  const q2a = e.target.closest('[data-q2ball]'); if (q2a) { e.stopPropagation(); q2a.disabled = true; quoteSweepAll().finally(() => { q2a.disabled = false; }); return; }
  const q2b = e.target.closest('[data-q2b]'); if (q2b) { e.stopPropagation(); q2b.disabled = true; quoteToBnb(q2b.dataset.q2b, Number(q2b.dataset.q2bslot) || 0).finally(() => { q2b.disabled = false; }); return; }
  const sell = e.target.closest('[data-hsell]');
  if (sell) { e.stopPropagation(); const [w, tk, pct] = sell.dataset.hsell.split(':'); return submitOrder({ token: tk, side: 'sell', wallets: [w], amountFor: () => +pct }); }
  if (e.target.closest('[data-claim],.logo')) return;
  const a = e.target.closest('[data-a]'); if (a && a.closest('#hold')) { e.stopPropagation(); const t = S.tokens.get(a.dataset.a) || [...S.tokens.values()].find((x) => x.address.toLowerCase() === a.dataset.a.toLowerCase()); if (t) return openToken(t); setView('trade'); return select(a.dataset.a); }
  const row = e.target.closest('tr.hrow'); if (row) { const k = row.dataset.hold; HOLD.open.has(k) ? HOLD.open.delete(k) : HOLD.open.add(k); renderHold(); }
}, true);
$('#holdDust').addEventListener('change', renderHold);
$('#holdRefresh').addEventListener('click', () => loadHold(true));
setInterval(() => { if (S.view === 'hold') loadHold(); }, 12_000);
// 订单结束后持仓页也跟着刷新（服务端会在 3 / 5 / 20 秒重读链上余额）
for (const ms of [4000, 8000, 22000]) window.addEventListener('order-done', () => setTimeout(() => { if (S.view === 'hold') loadHold(); }, ms));

/* ---------- 战壕：三列（新创建 / 即将打满 / 已开盘），每列自己的搜索、快捷买入金额、P1-P3 预设、声音、隐藏、筛选 ---------- */
const PLATS = ['flap', 'four', 'gang', 'genius'];
const platOf = (t) => { const p = t.launchPlat || t.platform; return p === 'four' || p === 'gang' || p === 'genius' ? p : 'flap'; };   // launchPlat：自动收录的 Four 普通盘（后端按外盘代币交易）也算 Four
// 普通盘 = 不是 Agent 盘（Gang 全是 Agent 盘）：Four / Flap / genius 的普通内盘、自动收录的已开盘普通盘。筛选里「显示普通盘」可以关掉
const isPlainPool = (t) => !t.agentExclusive && platOf(t) !== 'gang';
// 战壕分类：平台 × Agent / 普通盘，Gang 按版本。筛选里按分类选；新创建 / 即将打满里选了某个平台的「普通盘」，服务端才拉那个平台的内盘普通盘
const CATS = [['flap-plain', 'Flap 普通盘'], ['flap-agent', 'Flap Agent'], ['four-plain', 'Four 普通盘'], ['four-agent', 'Four Agent'], ['gang-v1', 'Gang V1'], ['gang-v2', 'Gang V2'], ['gang-v3', 'Gang V3'], ['genius-plain', 'Genius 普通盘']];
const CAT_KEYS = CATS.map((c) => c[0]), CAT_NAME = Object.fromEntries(CATS);
const catOf = (t) => { const p = platOf(t); return p === 'gang' ? 'gang-' + gangV(t) : p === 'genius' ? 'genius-plain' : p + (isPlainPool(t) ? '-plain' : '-agent'); };
const defCats = (k) => (k === 'dex' ? [...CAT_KEYS] : CAT_KEYS.filter((c) => !c.endsWith('-plain')));   // 内盘两列默认不要普通盘（不拉数据），已开盘全要
// 旧预设（平台 + Gang 版本 + 显示普通盘）换算成分类
const catsFromOld = (f) => CAT_KEYS.filter((c) => { const [p, v] = c.split('-'); if (!(f.plats || PLATS).includes(p)) return false; if (p === 'gang') return !f.gangVers?.length || f.gangVers.includes(v); return v === 'agent' || f.plain === true; });
const TCOLS = { new: '新创建', soon: '即将打满', dex: '已开盘' };
const defPreset = (k) => ({ amt: 0, slip: 35, f: { plats: [...PLATS], minMc: '', maxMc: '', minHolders: '', minProg: '', minAge: '', maxAge: '', quote: '', social: false, maxTax: '', hideUnknownTax: false, hideTax2c: false, gx: [], gangVers: [], plain: k === 'dex', cats: defCats(k) } });   // plain：显示普通盘，默认关（关着服务端也不拉普通盘数据）
const TR = (() => {
  let s = null; try { s = JSON.parse(localStorage.getItem('trench') || 'null'); } catch { /* ignore */ }
  const st = s && s.cols ? s : { cols: {}, hidden: [] };
  for (const k of Object.keys(TCOLS)) st.cols[k] = { preset: 1, presets: { 1: defPreset(k), 2: defPreset(k), 3: defPreset(k) }, q: '', sound: false, sort: 'pct', showHidden: false, ...(st.cols[k] || {}) };
  // 新增 genius.fun 平台：旧存档里原本三个平台全选的预设，自动把 genius 也选上（只选了部分平台的不动）
  if (!st.platGenius) { for (const k of Object.keys(TCOLS)) for (const p of Object.values(st.cols[k].presets || {})) if (p?.f?.plats && ['flap', 'four', 'gang'].every((x) => p.f.plats.includes(x)) && !p.f.plats.includes('genius')) p.f.plats.push('genius'); st.platGenius = true; try { localStorage.setItem('trench', JSON.stringify(st)); } catch { /* ignore */ } }
  // 普通盘改成默认关：之前存档里默认打开的，统一关掉一次（要看再在筛选里打开）
  // 已开盘列的普通盘（迁移后的 Flap / Four / genius）服务端一直收录，默认显示；新创建 / 即将打满仍默认关
  if (!st.catsV1) { for (const k of Object.keys(TCOLS)) for (const p of Object.values(st.cols[k].presets || {})) if (p?.f && !Array.isArray(p.f.cats)) p.f.cats = catsFromOld({ ...p.f, plain: k === 'dex' ? true : p.f.plain }); st.catsV1 = true; st.plainDex = true; st.plainOff = true; try { localStorage.setItem('trench', JSON.stringify(st)); } catch { /* ignore */ } }
  if (!st.plainDex) { for (const p of Object.values(st.cols.dex?.presets || {})) if (p?.f) p.f.plain = true; st.plainDex = true; st.plainOff = true; try { localStorage.setItem('trench', JSON.stringify(st)); } catch { /* ignore */ } }
  if (!st.plainOff) { for (const k of Object.keys(TCOLS)) for (const p of Object.values(st.cols[k].presets || {})) if (p?.f) p.f.plain = false; st.plainOff = true; try { localStorage.setItem('trench', JSON.stringify(st)); } catch { /* ignore */ } }
  // 市值筛选改成以 K（千美元）为单位：旧存档里是美元，除以 1000 换算一次
  if (!st.mcUnitK) {
    const toK = (v) => { const x = Number(v); return v === '' || v == null || !isFinite(x) ? v : String(+(x / 1000).toFixed(6)); };
    for (const k of Object.keys(TCOLS)) for (const p of Object.values(st.cols[k].presets || {})) if (p?.f) { p.f.minMc = toK(p.f.minMc); p.f.maxMc = toK(p.f.maxMc); }
    st.mcUnitK = true; try { localStorage.setItem('trench', JSON.stringify(st)); } catch { /* ignore */ }
  }
  return st;
})();
const trSave = () => { try { localStorage.setItem('trench', JSON.stringify(TR)); } catch { /* ignore */ } plainSync(); };
// 普通盘开关同步到服务端：任意一列当前预设打开了「显示普通盘」才让服务端拉普通盘数据，全部关掉就停
let plainSent = null;
function plainSync() {
  // 新创建 / 即将打满当前预设里选了哪些平台的「普通盘」，服务端只拉这些平台的内盘普通盘（已开盘列不用拉，一直收录）
  const want = {}; for (const p of ['flap', 'four', 'genius']) want[p] = ['new', 'soon'].some((k) => (TR.cols[k].presets[TR.cols[k].preset]?.f?.cats || []).includes(p + '-plain'));
  const key = JSON.stringify(want); if (key === plainSent) return; plainSent = key;
  fetch('/api/plain-pools', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: Object.values(want).some(Boolean), plats: want }) }).catch(() => { plainSent = null; });
}
setTimeout(plainSync, 1500);
const P = (k) => TR.cols[k].presets[TR.cols[k].preset];
// 市值输入以 K（千美元）为单位：「5」「5k」= $5K，「1.2m」= $1.2M，全角数字也认；返回美元，解析不了当作不限
const mcK = (v) => { if (v === '' || v == null) return null; const s = String(v).replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim().toLowerCase(); const x = parseFloat(s.replace(/[^\d.]/g, '')); return isFinite(x) ? x * (/m/.test(s) ? 1e6 : 1e3) : null; };
// 税率输入宽松解析：「10%」「１０」「 5 」都认；解析不了当作不限
const taxNum = (v) => { if (v === '' || v == null) return null; const x = parseFloat(String(v).replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^\d.]/g, '')); return isFinite(x) ? x : null; };
// 税率条件是全局的：三列 × P1-P3 都用同一个，切预设也不会「突然失效」
// hideTax2c（隐藏税归发币人）也算税率条件，三列一起生效；不传 = 不改
const setTaxAll = (maxTax, hideUnknownTax, hideTax2c) => { for (const c of Object.keys(TCOLS)) for (const p of Object.values(TR.cols[c].presets)) Object.assign(p.f, { maxTax: maxTax ?? '', hideUnknownTax: !!hideUnknownTax }, hideTax2c == null ? {} : { hideTax2c: !!hideTax2c }); };
const tcPaused = new Set();
// 卡片下单状态（点击后立刻显示，几秒后清掉）：busy 下单中 / ok 已提交 / pend 待确认 / err 失败
const tcState = new Map();
const TC_ST = { busy: '<i class="spin"></i>下单中…', ok: '✓ 已提交', pend: '… 待确认', err: '✗ 失败' };
// 会下单的钱包数（参与下单且已登录）：服务端每个钱包各买一份，不是平分
const tcNW = () => (MW() ? onWallets().filter((w) => w.auth === 'ok').length : 1);
const tcBuyLabel = (t, k) => `⚡ ${P(k).amt > 0 ? P(k).amt + ' BNB' : `买 ${qPct(t)}%`}${tcNW() > 1 ? ' ×' + tcNW() : ''}`;
// 快捷买入的悬停说明：多钱包时写明「每个钱包」买多少、合计大约多少 BNB（按现价估算，没算价格冲击）
function tcBuyTip(t, k) {
  const n = tcNW(), amt = P(k).amt;
  if (amt > 0) return n > 1 ? `每个钱包 ${amt} BNB · ${n} 个钱包 = ${+(amt * n).toFixed(6)} BNB 合计` : `买入 ${amt} BNB`;
  const pct = qPct(t), per = t?.priceUsd && S.bnbUsd ? (1e9 * pct / 100) * t.priceUsd / S.bnbUsd : null;
  return n > 1 ? `每个钱包买总量的 ${pct}% · ${n} 个钱包${per ? ` ≈ ${(per * n).toFixed(4)} BNB 合计（每个约 ${per.toFixed(4)}，按现价估算）` : ''}` : `买总量的 ${pct}%${per ? `（约 ${per.toFixed(4)} BNB）` : ''}`;
}                 // 鼠标停在某列里时暂停这一列的更新
const tcSeen = { new: new Set(), soon: new Set(), dex: new Set() };
const tcKnown = new Set(); let tcPrimed = false; const tcSoundAt = {};
// 列提示音单独控制（只看这一列的开关，不受顶栏🔊影响）
function colTone(f) { try { actx ||= new AudioContext(); if (actx.state === 'suspended') actx.resume(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.05; o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.07); } catch { /* 未授权音频 */ } }
var lastPulse = 0;
// 发射时间：迁移 / 毕业 / 打新开盘的时间（后端登记并持久化），不知道时退回创建时间
const launchAt = (t) => t.migratedAt || t.createdAt || 0;

function setView(v, fromRoute) {
  S.view = v;
  $('#pulse')?.classList.toggle('hidden', v !== 'pulse');
  $('#hold')?.classList.toggle('hidden', v !== 'hold');
  $('#track')?.classList.toggle('hidden', v !== 'track'); $('#snipe')?.classList.toggle('hidden', v !== 'snipe');
  document.querySelector('main.layout')?.classList.toggle('hidden', v === 'pulse' || v === 'hold' || v === 'track' || v === 'snipe');
  $$('#viewSw button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (!fromRoute) syncUrl();
  renderQB?.();
  if (v === 'hold') { loadHold(); renderHoldGang(); }
  if (v === 'track') loadTrack();
  if (v === 'snipe') { SNP.formAt = 0; loadSnipe(); }
  if (v === 'pulse') { lastPulse = 0; renderPulse(); requestAnimationFrame(() => $$('.tcb').forEach((b) => { if (pulseScroll[b.id] != null) b.scrollTop = pulseScroll[b.id]; })); }
  else if (v === 'hold' && pulseScroll.hold != null) { requestAnimationFrame(() => { const h = $('#hold'); if (h) h.scrollTop = pulseScroll.hold; }); }
  if (v === 'pulse') {} else { window.dispatchEvent(new Event('resize')); lastList = 0; scheduleRender(); }
}

// 列头：搜索 / BNB 快捷金额 / P1-P3 / 声音 / 隐藏 / 筛选（即将打满多一个 % / MC 排序）
function tcHead(k) {
  const c = TR.cols[k], p = P(k), f = p.f;
  const active = tcActive(k);
  return `<div class="tch"><b>${TCOLS[k]}</b><span class="cnt" id="tcn-${k}">0</span><i class="tc-pause" id="tcp-${k}" title="鼠标在列里，暂停刷新">❚❚</i>
    <span class="tch-r">
      <label class="tc-search"><svg viewBox="0 0 16 16" width="12" height="12"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6"/></svg><input data-tq="${k}" value="${esc(c.q)}" placeholder="关键词1, ..."/></label>
      <label class="tc-amt" title="每个钱包各买入的 BNB 数量（多钱包时每个钱包都买这么多，不是平分）；0 = 每个钱包按 1% 筹码买"><i class="bnbcoin"></i><input data-ta="${k}" type="number" min="0" step="0.01" value="${p.amt || 0}"/></label>
      <span class="tc-pre">${[1, 2, 3].map((n) => `<button data-tp="${k}:${n}" class="${c.preset === n ? 'on' : ''}">P${n}</button>`).join('')}</span>
      ${k === 'soon' ? `<span class="tc-pre tc-sort"><button data-ts="${k}:pct" class="${c.sort === 'pct' ? 'on' : ''}">%</button><button data-ts="${k}:mc" class="${c.sort === 'mc' ? 'on' : ''}">MC</button></span>` : ''}
      <button class="tc-ic ${c.sound ? 'on' : ''}" data-tsound="${k}" title="新币提示音">${c.sound ? '🔊' : '🔈'}</button>
      <button class="tc-ic" data-bmgr title="已屏蔽 ${blockCount()} 个：点击查看 / 取消屏蔽（卡片上的 ⊘ 屏蔽）">⊘${blockCount() ? `<small>${blockCount()}</small>` : ''}</button>
      <button class="tc-ic tc-funnel ${active ? 'act' : ''}" data-tf="${k}" title="${esc(tcFilterSummary(k))}"><svg viewBox="0 0 16 16" width="15" height="15" style="pointer-events:none"><path d="M2 3h12l-4.6 5.4v4.4l-2.8 1.4V8.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></button>
    </span></div>`;
}
function tcActive(k) { const f = P(k).f; return !!(String(f.cats || '') !== String(defCats(k)) || f.minMc || f.maxMc || f.minHolders || f.minProg || f.minAge || f.maxAge || f.quote || f.social || f.maxTax !== '' && f.maxTax != null || f.hideUnknownTax || f.hideTax2c || f.gx?.length); }
// 漏斗按钮的提示文字：当前预设下生效的筛选条件
function tcFilterSummary(k) {
  const f = P(k).f, x = [];
  if (String(f.cats || '') !== String(CAT_KEYS)) x.push('分类 ' + (f.cats || []).map((c) => CAT_NAME[c]).join('/'));
  if (f.maxTax !== '' && f.maxTax != null) x.push(`税率 ≤ ${f.maxTax}%`);
  if (f.hideUnknownTax) x.push('隐藏税率未知');
  if (f.hideTax2c) x.push('隐藏 dev 吃税');
  if (f.gx?.length) x.push('只看 ' + f.gx.map((g) => (g === 'bb' ? '回购' : '有押金')).join('/'));
  if (f.minMc || f.maxMc) x.push(`市值 ${f.minMc || 0}K~${f.maxMc || '∞'}K`);
  if (f.minAge || f.maxAge) x.push(`创建 ${f.minAge || 0}~${f.maxAge || '∞'} 分钟`);
  if (f.minHolders) x.push(`持有人 ≥ ${f.minHolders}`);
  if (f.minProg) x.push(`进度 ≥ ${f.minProg}%`);
  if (f.quote) x.push('报价币 ' + f.quote);
  if (f.social) x.push('有社交链接');
  return `筛选（P${TR.cols[k].preset}）：${x.length ? x.join('，') : '无'}`;
}
function tcFilterPop(k) {
  const f = P(k).f;
  return `<div class="tc-pop" data-tpop="${k}">
    <div class="tp-row"><span>平台</span>${PLATS.map((p) => `<label><input type="checkbox" data-tfp="${k}:${p}" ${f.plats.includes(p) ? 'checked' : ''}/>${{ flap: 'Flap', four: 'Four', gang: 'Gang', genius: 'Genius' }[p]}</label>`).join('')}<label title="普通盘 = 不是 Agent 专属的盘（Four / Flap / genius 的普通内盘和已开盘的普通盘）"><input type="checkbox" data-tfn="${k}" ${f.plain === true ? 'checked' : ''}/>显示普通盘</label></div>
    <div class="tp-row"><span>市值（K$）</span><input data-tff="${k}:minMc" value="${f.minMc}" placeholder="最低，如 5"/><input data-tff="${k}:maxMc" value="${f.maxMc}" placeholder="最高，如 50"/></div>
    <div class="tp-row"><span>持有人 ≥</span><input data-tff="${k}:minHolders" value="${f.minHolders}"/><span>进度 ≥ %</span><input data-tff="${k}:minProg" value="${f.minProg}"/></div>
    <div class="tp-row"><span>报价币</span><input data-tff="${k}:quote" value="${esc(f.quote)}" placeholder="BNB, BNCB…"/><label><input type="checkbox" data-tfs="${k}" ${f.social ? 'checked' : ''}/>有社交链接</label></div>
    <div class="tp-row"><span>最高税率 %</span><input data-tff="${k}:maxTax" value="${f.maxTax ?? ''}" placeholder="如 5"/><label><input type="checkbox" data-tfu="${k}" ${f.hideUnknownTax ? 'checked' : ''}/>税率未知也隐藏</label><label><input type="checkbox" data-tfc="${k}" ${f.hideTax2c ? 'checked' : ''}/>隐藏 dev 吃税</label><button class="qb" data-tfall="${k}" title="把这一列的税率条件复制到三列">应用到全部列</button></div>
    <div class="tp-row"><button class="qb" data-tfreset="${k}">重置</button><span class="muted">P${TR.cols[k].preset} 预设，自动保存</span></div></div>`;
}

function tcMatch(k, t) {
  const c = TR.cols[k], f = P(k).f;
  if (!(f.cats || defCats(k)).includes(catOf(t))) return false;   // 分类：平台 × Agent / 普通盘，Gang 按版本
  if (isBlocked(t)) return false;
  const n = (v) => (v === '' || v == null ? null : Number(v));
  const mcMin = mcK(f.minMc), mcMax = mcK(f.maxMc);
  if (mcMin != null && !((t.mcapUsd || 0) >= mcMin)) return false;
  if (mcMax != null && !((t.mcapUsd || 0) <= mcMax)) return false;
  if (n(f.minHolders) != null && !((t.holders || 0) >= n(f.minHolders))) return false;
  if (n(f.minProg) != null && !((t.progress || 0) >= n(f.minProg))) return false;
  // 创建时间（分钟）：从创建到现在过了多久，最少 ~ 最多
  if (n(f.minAge) != null || n(f.maxAge) != null) {
    const age = (Date.now() - (t.createdAt || 0)) / 60_000;
    if (n(f.minAge) != null && !(age >= n(f.minAge))) return false;
    if (n(f.maxAge) != null && !(age <= n(f.maxAge))) return false;
  }
  if (f.quote && !f.quote.toUpperCase().split(/[,，\s]+/).filter(Boolean).includes(String(t.quote || '').toUpperCase())) return false;
  if (f.social && !(t.website || t.twitter || t.telegram)) return false;
  // 税率：买或卖任一边超过上限就隐藏；不知道税率的默认照常显示
  // 用的就是卡片上显示的那两个数（buyFeePct / sellFeePct）。任何一边已知且超过上限就隐藏；两边都不知道才算「税率未知」
  const mt = taxNum(f.maxTax);
  if (mt != null || f.hideUnknownTax) {
    const known = [t.buyFeePct, t.sellFeePct].filter((v) => v != null && v !== '').map(Number).filter((v) => isFinite(v));
    if (!known.length) { if (f.hideUnknownTax) return false; }
    else if (mt != null && Math.max(...known) > mt + 1e-9) return false;
  }
  if (f.hideTax2c && t.taxToCreator) return false;   // 税收接收地址就是发币人自己
  if (f.gx?.length && !f.gx.some((g) => (g === 'bb' ? t.gangBuyback : t.gangBond?.state === 1))) return false;   // 只看 gang 回购 / 有押金（两个都选 = 有其一）
  const kw = c.q.toLowerCase().split(/[,，]+/).map((x) => x.trim()).filter(Boolean);
  if (kw.length && !kw.some((w) => `${t.symbol} ${t.name} ${t.address}`.toLowerCase().includes(w))) return false;
  return true;
}

function tcCard(t, k) {
  const plat = platOf(t), curve = t.stage === 'curve', prog = Math.min(100, Number(t.progress) || 0);
  const gangOnly = !!t.viewOnly;   // 只看行情的普通盘（普通 Four 内盘 / genius 内盘）：本终端不能下单
  const st = tcState.get(t.address);
  const devName = domOf(t.creator, t.creatorDomain, t.creatorName);
  const fee = t.buyFeePct != null ? t.buyFeePct : t.buyTax;
  const soc = [t.website && ['🌐', t.website], t.twitter && ['𝕏', t.twitter], t.telegram && ['✈', t.telegram]].filter(Boolean)
    .map(([i, u]) => `<a class="soc" href="${esc(/^https?:/.test(u) ? u : 'https://' + u)}" target="_blank" rel="noopener" data-ext-link>${i}</a>`).join('');
  // 我的持仓（所有钱包合计，和持仓页同一份数据；还没同步到就用本钱包的订单记录）
  const hr = holdRow(t), myAmt = hr?.amount > 0 ? hr.amount : (S.positions || []).filter((p) => p.token === t.address && p.amount > 0).reduce((a, p) => a + p.amount, 0);
  const hp = myAmt > 0 ? { amount: myAmt, pct: hr?.amount > 0 ? hr.supplyPct : null } : null;
  const route = curve ? `${esc(t.quote || 'BNB')} | ${amtFmt(t.raised)}/${amtFmt(t.target)} → ${prog.toFixed(1)}%${fairLeft(t)}` : `${esc(t.quote || 'BNB')} | ${t.gangFair ? '打新已发射 · 外盘' : '已迁移 DEX'}`;
  return `<div class="tcard ${plat} ${hp ? 'held' : ''} " data-pa="${t.address}">
    <div class="tc-l"><div class="tc-img">${logoHtml(t, 'tl')}<i class="tc-badge ${plat}">${{ flap: 'F', four: '4', gang: gangBadge(t), genius: 'GN' }[plat]}</i></div>
      <div class="tc-prog"><i style="width:${curve ? prog : 100}%"></i></div><div class="tc-dev ${isMe(t.creator) ? 'me' : ''}">${wnoteHtml(t.creator, devName)}</div></div>
    <div class="tc-m">
      <div class="tc-n"><b class="ctick" data-ctick="${esc(symOk(t) ? t.symbol : t.address)}" title="点击复制代号">${esc(symTxt(t))}</b>${t.name && t.name !== symTxt(t) ? `<span>${esc(t.name)}</span>` : ''}<button class="tc-fav ${isFav(t.address) ? 'on' : ''}" data-favq="${t.address}" title="${isFav(t.address) ? '取消收藏' : '收藏'}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="currentColor"/></svg></button><button class="tc-hide" data-block="${t.address}" title="屏蔽"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6.5 17.5l11-11" stroke="currentColor" stroke-width="2"/></svg></button>${xsBtn(t.address, 'tc-xs')}</div>
      <div class="tc-chips">${nftChip(t, 'chip')}${taxChip(t, 'chip')}${divChip(t, 'chip')}${bbChip(t, 'chip')}${bondChip(t, 'chip')}${gangVerChip(t)}<i class="chip q">◎ ${esc(t.quote || 'BNB')}</i>${t.agentExclusive ? '<i class="chip ag">Agent 专属</i>' : ''}</div>
      <div class="tc-meta">${k === 'dex' && t.migratedAt ? `<span class="g" title="发射于 ${fullTime(t.migratedAt)} · 创建于 ${fullTime(t.createdAt)}">${age(t.migratedAt)}</span>` : `<span class="g" title="创建于 ${fullTime(t.createdAt)}">${age(t.createdAt)}</span>`}${t.chg?.h1 != null ? `<span title="1 小时涨幅">1h ${chgTxt(t.chg.h1)}</span>` : ''}${soc}<span title="持有人 / 交易笔数">👥 ${t.holders ?? '—'}/${(t.buys || 0) + (t.sells || 0)}</span></div>
      <div class="tc-route ${curve ? '' : 'dex'}">${route}</div>
      <div class="tc-who">${t.firstBuyer ? `<span class="g">👑</span> 首买 ${wnoteHtml(t.firstBuyer, domOf(t.firstBuyer, t.firstBuyerName))}` : ''}${hp ? `<span class="y" title="我的钱包持有（不是首买地址）">我持有 ${K(hp.amount)}${hp.pct != null ? ` · ${hp.pct.toFixed(2)}%` : ''}</span>` : ''}</div>
    </div>
    ${gangOnly ? `<div class="tc-r off" title="普通 Four 内盘 / genius 内盘：本终端暂不支持下单，只看行情"><div class="tc-mc"><span>MC</span> <b>${t.mcapEst ? '≈' : ''}${usd(t.mcapUsd)}</b></div><span class="tc-buy">仅行情</span></div>`
      : `<div class="tc-r buyable ${st ? 'st-' + st : ''}" data-tqb="${t.address}:${k}" title="${esc(tcBuyTip(t, k))}"><div class="tc-mc" title="${t.mcapEst ? '还没有成交，按同模板开盘价估算的市值' : '市值'}"><span>MC</span> <b class="${curve ? '' : 'cy'}">${t.mcapEst ? '≈' : ''}${usd(t.mcapUsd)}</b></div>
        <span class="tc-buy">${TC_ST[st] || tcBuyLabel(t, k)}</span></div>`}</div>`;
}
const amtFmt = (v) => amt(v);
// 交易页左栏的紧凑卡片（和战壕同一套颜色、直角、图标，但三行排版、约 80px 高）
// 第 1 行：头像 | 代号 名字 … MC | ★ ⊘；第 2 行：税 / 计价 / Agent 标签 + 时长 · 1h · 持有人；第 3 行：进度细条 + 已筹/目标 · % + ⚡买
function tlCard(t) {
  const plat = platOf(t), curve = t.stage === 'curve', prog = Math.min(100, Number(t.progress) || 0), k = curve ? 'new' : 'dex', st = tcState.get(t.address);
  const dev = t.creatorName || (t.creator ? short(t.creator, 6, 4) : '');
  const route = curve ? `${amtFmt(t.raised)}/${amtFmt(t.target)} ${esc(t.quote || 'BNB')} · ${prog.toFixed(1)}%${fairLeft(t)}` : `${t.gangFair ? '打新已发射 · 外盘' : '已迁移 DEX'} · ${esc(t.quote || 'BNB')}`;
  return `<div class="tlc ${plat} ${t.address === S.selected ? 'sel' : ''}" data-pa="${t.address}" title="${esc(t.name || symTxt(t))}${dev ? ' · Dev ' + esc(dev) : ''}">
    <div class="tlc-img">${logoHtml(t, 'tl')}<i class="tc-badge ${plat}">${{ flap: 'F', four: '4', gang: gangBadge(t), genius: 'GN' }[plat]}</i></div>
    <div class="tlc-m">
      <div class="tlc-r1"><b class="ctick" data-ctick="${esc(symOk(t) ? t.symbol : t.address)}" title="点击复制代号">${esc(symTxt(t))}</b>${t.name && t.name !== symTxt(t) ? `<span class="tlc-nm">${esc(t.name)}</span>` : ''}
        <span class="tlc-mc" title="${t.mcapEst ? '还没有成交，按同模板开盘价估算' : '市值'}">${t.mcapEst ? '≈' : ''}${usd(t.mcapUsd)}</span>
        <button class="tlc-ic tc-fav ${isFav(t.address) ? 'on' : ''}" data-favq="${t.address}" title="${isFav(t.address) ? '取消收藏' : '收藏'}"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="currentColor"/></svg></button><button class="tlc-ic tc-hide" data-block="${t.address}" title="屏蔽"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6.5 17.5l11-11" stroke="currentColor" stroke-width="2"/></svg></button>${xsBtn(t.address, 'tlc-ic tc-xs')}</div>
      <div class="tlc-r2">${nftChip(t, 'chip')}${taxChip(t, 'chip')}${divChip(t, 'chip')}${bbChip(t, 'chip')}${bondChip(t, 'chip')}${gangVerChip(t)}<i class="chip q">${esc(t.quote || 'BNB')}</i>${t.agentExclusive ? '<i class="chip ag">Agent</i>' : ''}<span class="g" title="创建于 ${fullTime(t.createdAt)}">${age(t.createdAt)}</span>${t.chg?.h1 != null ? `<span>1h ${chgTxt(t.chg.h1)}</span>` : ''}<span title="持有人 / 交易笔数">👥 ${t.holders ?? '—'}/${(t.buys || 0) + (t.sells || 0)}</span></div>
      <div class="tlc-r3"><div class="tlc-bar ${curve ? '' : 'dex'}"><i style="width:${curve ? prog : 100}%"></i></div><span class="tlc-rt">${route}</span>
        ${t.viewOnly ? '<span class="tlc-buy" title="普通 Four 内盘 / genius 内盘：本终端暂不支持下单">仅行情</span>' : `<span class="tlc-buy ${st ? 'st-' + st : ''}" data-tqb="${t.address}:${k}" title="${esc(tcBuyTip(t, k))}（金额在战壕对应列设置）">${TC_ST[st] || '⚡' + tcBuyLabel(t, k).replace(/^[⚡\s]*/, '')}</span>`}</div>
    </div></div>`;
}


// 每列按 key 增量更新：卡片内容没变就不动 DOM，顺序变了才移动节点，不整列重画
function renderPulse() {
  const every = [...S.tokens.values()].filter((t) => (t.stage === 'curve' || t.stage === 'dex') );
  // 第一次渲染先把现有的币都记成「见过」，之后才响
  if (!tcPrimed && every.length) { every.forEach((t) => tcKnown.add(t.address)); tcPrimed = true; }
  queueMicrotask(() => every.forEach((t) => tcKnown.add(t.address)));   // 这次出现的都记成见过（被筛掉的也算，之后进列表不响）
  const lists = {
    new: every.filter((t) => t.stage === 'curve' && tcMatch('new', t)).sort((a, b) => b.createdAt - a.createdAt || (a.address < b.address ? -1 : 1)),   // 同一时间的按地址排，顺序稳定
    soon: every.filter((t) => t.stage === 'curve' && t.progress > 0 && tcMatch('soon', t)).sort((a, b) => (TR.cols.soon.sort === 'mc' ? (b.mcapUsd || 0) - (a.mcapUsd || 0) : b.progress - a.progress)),
    dex: every.filter((t) => t.stage === 'dex' && tcMatch('dex', t)).sort((a, b) => launchAt(b) - launchAt(a) || (a.address < b.address ? -1 : 1)),   // 按发射（迁移）时间，最新在上；不知道发射时间的按创建时间
  };
  for (const [k, list] of Object.entries(lists)) {
    const body = $('#tcb-' + k); if (!body) continue;
    $('#tcn-' + k).textContent = list.length;
    $('#tcp-' + k).classList.toggle('on', tcPaused.has(k));
    if (tcPaused.has(k)) { body.querySelectorAll(':scope > [data-pa]').forEach((el) => { if (isBlocked(S.tokens.get(el.dataset.pa))) el.remove(); }); continue; }   // 鼠标停在列上时列表暂停刷新，但刚屏蔽的币要立刻拿掉
    const show = list.slice(0, 60);
    // 列提示音：只对「打开页面后第一次出现、开盘不到 2 分钟、通过这一列筛选」的币响；重排、换筛选、重新进入列表都不响；每列 3 秒最多一次
    const fresh = show.filter((t) => !tcKnown.has(t.address) && Date.now() - (t.createdAt || 0) < 120_000);
    if (fresh.length && TR.cols[k].sound && Date.now() - (tcSoundAt[k] || 0) > 3000) { tcSoundAt[k] = Date.now(); colTone(k === 'dex' ? 660 : 990); (window.__tcSoundLog ||= []).push({ at: new Date().toLocaleTimeString(), col: k, tokens: fresh.map((t) => t.symbol) }); }
    show.forEach((t) => tcSeen[k].add(t.address));
    const old = new Map([...body.children].filter((x) => x.dataset.pa).map((x) => [x.dataset.pa, x]));
    // 往下翻着看的时候，新币插到最上面不要把正在看的卡片挤走：记下第一张可见卡片的位置，更新后把它放回原处
    let anchor = null, anchorTop = 0;
    if (body.scrollTop > 4) for (const c of body.children) { if (c.dataset.pa && c.offsetTop + c.offsetHeight > body.scrollTop) { anchor = c.dataset.pa; anchorTop = c.offsetTop - body.scrollTop; break; } }
    let prev = null;
    for (const t of show) {
      const html = tcCard(t, k);
      let el = old.get(t.address);
      if (!el) { const d = document.createElement('div'); d.innerHTML = html; el = d.firstElementChild; el._h = html; if (fresh.some((x) => x.address === t.address)) el.classList.add('new'); /* 只有真正的新盘（打开页面后第一次出现、开盘不到 2 分钟）闪一下；旧币重新进列表、补数据都不闪 */ }
      else if (el._h !== html) { const d = document.createElement('div'); d.innerHTML = html; const n = d.firstElementChild; patchCard(el, n); el._h = html; }   // 只改变化的部分，头像等不重建
      old.delete(t.address);
      const want = prev ? prev.nextSibling : body.firstChild;
      if (el !== want) body.insertBefore(el, want);
      prev = el;
    }
    for (const el of old.values()) el.remove();
    body.querySelector(':scope > .empty')?.remove();
    if (anchor) { const a = body.querySelector(`:scope > [data-pa="${anchor}"]`); if (a) body.scrollTop = a.offsetTop - anchorTop; }
    if (!show.length) body.innerHTML = '<div class="empty">暂无代币</div>';
  }
}
// 卡片局部更新：结构一样就逐个子节点比较，只替换内容变了的部分（头像图片节点不动，避免闪烁和高度跳动）
function patchCard(el, n) {
  for (const { name, value } of [...n.attributes]) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  for (const { name } of [...el.attributes]) if (!n.hasAttribute(name)) el.removeAttribute(name);
  const a = [...el.children], b = [...n.children];
  if (a.length !== b.length) { el.innerHTML = n.innerHTML; return; }
  a.forEach((x, i) => { if (x.outerHTML === b[i].outerHTML) return;
    // 头像：只有图片地址真的变了才换，否则不动（避免重新加载、闪一下）
    if (x.classList?.contains('logo') || x.classList?.contains('tc-img') || x.classList?.contains('tlc-img')) { const si = x.querySelector('img')?.getAttribute('src') ?? x.getAttribute('src'), ni = b[i].querySelector('img')?.getAttribute('src') ?? b[i].getAttribute('src'); if (si === ni && x.textContent === b[i].textContent) { const bx = x.querySelector('.tc-badge'), by = b[i].querySelector('.tc-badge'); if (bx && by && bx.outerHTML !== by.outerHTML) bx.replaceWith(by); return; } } if (x.tagName === b[i].tagName && x.children.length && x.children.length === b[i].children.length && !x.matches('img')) patchCard(x, b[i]); else x.replaceWith(b[i]); });
}
function renderTrenchHeads() { for (const k of Object.keys(TCOLS)) { const h = $('#tch-' + k); if (h) h.innerHTML = tcHead(k); } }

// 持仓页左侧的 Gang 新币战壕：和交易页左栏选 Gang 时一样（状态框 + 紧凑卡片 tlCard），只列 Gang 内盘中的币，最新在上；鼠标停在列里暂停刷新；可收起（记在本地）
var HG = { open: (() => { try { return localStorage.holdGang !== '0'; } catch { return true; } })(), paused: false };
function renderHoldGang() {
  if (!HG) return;   // 启动时路由先进持仓页，这里还没初始化
  const box = $('#holdGang'), body = $('#hgBody'); if (!box || !body) return;
  box.classList.toggle('hidden', !HG.open); $('#hgOpen')?.classList.toggle('hidden', HG.open); $('#hold')?.classList.toggle('hg-on', HG.open);
  if (!HG.open || S.view !== 'hold') return;
  const list = [...S.tokens.values()].filter((t) => t.platform === 'gang' && t.stage === 'curve' && !isBlocked(t)).sort((a, b) => b.createdAt - a.createdAt || (a.address < b.address ? -1 : 1));
  $('#hgCnt').textContent = list.length;
  const ago = (Date.now() - (S.net.detectAt || 0)) / 1000;
  const st = `<div class="l1"><span class="muted">Gang <b class="mono" style="color:var(--text)">${list.length}</b></span>${LIVE() ? `<span class="muted">${S.baw?.connected ? '<b class="g">baw 已连接</b>' : '<b class="r">baw 未连接</b>'} · 白名单以合约为准</span>` : ''}</div>
    ${LIVE() ? `<div class="l2" style="color:var(--muted)">Gang ${S.net.gang?.connected ? `<span class="g">✓ ${S.net.gang.total}</span>` : `<span class="r">${S.net.gang?.lastError ? '✗' : '连接中…'}</span>`} · 链上订阅 ${S.net.gangChain?.connected ? '<span class="g">✓</span>' : '<span class="r">✗</span>'} · baw ${S.baw?.connected ? '<span class="g">✓</span>' : '<span class="r">✗</span>'}</div>` : ''}
    <div class="l2"><span class="spin">⟳</span> 链上检测中 · ${ago < 5 ? '刚刚' : Math.floor(ago) + 's 前'} · ${S.net.detect || 0}ms</div>`;
  if ($('#hgSt')._h !== st) { $('#hgSt').innerHTML = st; $('#hgSt')._h = st; }
  if (HG.paused) { body.querySelectorAll(':scope > [data-pa]').forEach((el) => { if (isBlocked(S.tokens.get(el.dataset.pa))) el.remove(); }); return; }
  const show = list.slice(0, 80);
  const old = new Map([...body.children].filter((x) => x.dataset.pa).map((x) => [x.dataset.pa, x]));
  let prev = null;
  for (const t of show) {
    const html = tlCard(t);
    let el = old.get(t.address);
    if (!el) { const d = document.createElement('div'); d.innerHTML = html; el = d.firstElementChild; el._h = html; }
    else if (el._h !== html) { const d = document.createElement('div'); d.innerHTML = html; patchCard(el, d.firstElementChild); el._h = html; }
    old.delete(t.address);
    const want = prev ? prev.nextSibling : body.firstChild;
    if (el !== want) body.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
  body.querySelector(':scope > .empty')?.remove();
  if (!show.length) body.innerHTML = '<div class="empty">暂无 Gang 内盘新币</div>';
}
const setHoldGang = (on) => { HG.open = on; try { localStorage.holdGang = on ? '1' : '0'; } catch { /* ignore */ } renderHoldGang(); };
$('#hgClose')?.addEventListener('click', (e) => { e.stopPropagation(); setHoldGang(false); });
$('#hgOpen')?.addEventListener('click', () => setHoldGang(true));
$('#hgBody')?.addEventListener('mouseenter', () => { HG.paused = true; });
$('#hgBody')?.addEventListener('mouseleave', () => { HG.paused = false; renderHoldGang(); });
setInterval(() => { if (S.view === 'hold') renderHoldGang(); }, 1000);

// ⚡：金额 > 0 买这一列设置的 BNB；金额 = 0 按 1% 筹码买（沿用原来的「买 1%」逻辑）
async function trenchBuy(addr, k) {
  const amt = P(k).amt; if (!(amt > 0)) return pulseBuy1(addr);
  const t = S.tokens.get(addr); if (!t || pBusy.has(addr)) return;
  const ws = [...S.selWallets]; if (!ws.length) return topPop({ status: 'failed', side: 'buy', symbol: t.symbol, reason: '没有选钱包' });
  pBusy.add(addr);
  try {
    topPop({ status: 'pending', side: 'buy', symbol: t.symbol, amountIn: amt });
    let r, err;
    try { r = [].concat(await api('/api/order', { wallets: ws, token: addr, side: 'buy', amount: amt, slippage: P(k).slip || S.slippage, via: 'quick' })); } catch (e) { err = e.message; }
    const f = err ? { reason: err } : r.find((o) => o?.status === 'failed');
    if (f) topPop({ ...f, status: 'failed', side: 'buy', symbol: t.symbol });
  } finally { pBusy.delete(addr); }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tp],[data-ts],[data-tsound],[data-thide],[data-tf],[data-thid],[data-tqb],[data-tfreset],[data-tfall],[data-ext-link]');
  if (!el || (!el.closest('#pulse') && el.dataset.tqb === undefined)) return;   // 左栏紧凑卡片的 ⚡ 也走这里
  if (el.dataset.extLink !== undefined) return e.stopPropagation();
  e.stopPropagation(); e.preventDefault();
  const d = el.dataset;
  if (d.tp) { const [k, n] = d.tp.split(':'); TR.cols[k].preset = +n; }
  else if (d.ts) { const [k, v] = d.ts.split(':'); TR.cols[k].sort = v; }
  else if (d.tsound) { TR.cols[d.tsound].sound = !TR.cols[d.tsound].sound; if (TR.cols[d.tsound].sound) colTone(990); }
  else if (d.tf) { tfModal(d.tf); return; }
  else if (d.tfall) { const src = P(d.tfall).f; setTaxAll(src.maxTax, src.hideUnknownTax, src.hideTax2c); note(`税率条件已应用到三列（P1-P3 都生效）${src.maxTax !== '' ? `：最高 ${src.maxTax}%` : ''}`, 'info'); }
  else if (d.tfreset) { P(d.tfreset).f = defPreset(d.tfreset).f; $('#tcf-' + d.tfreset).innerHTML = tcFilterPop(d.tfreset); }
  else if (d.tqb) {
    // 整个右侧框都是买入按钮：点下立刻显示「下单中」，结果按这次点击之后该币的最新买单判断
    const [a, k] = d.tqb.split(':'); if (tcState.get(a) === 'busy') return;
    const t0 = Date.now(), tok = S.tokens.get(a);
    const setSt = (s) => {
      if (s) tcState.set(a, s); else tcState.delete(a);
      $$(`[data-tqb^="${a}:"]`).forEach((x) => { x.classList.remove('st-busy', 'st-ok', 'st-err', 'st-pend'); if (s) x.classList.add('st-' + s); (x.querySelector('.tc-buy') || x).innerHTML = TC_ST[s] || (tok ? tcBuyLabel(tok, k) : '⚡'); });
    };
    setSt('busy');
    Promise.resolve(trenchBuy(a, k)).catch(() => null).then(() => {
      const o = S.orders.find((x) => x.token === a && x.ts >= t0 - 1000 && x.side === 'buy');
      setSt(!o ? null : o.status === 'failed' ? 'err' : o.status === 'filled' ? 'ok' : 'pend');
    }).finally(() => setTimeout(() => { tcState.delete(a); lastPulse = 0; renderPulse(); }, 2500));
    return;
  }
  trSave(); renderTrenchHeads(); lastPulse = 0; renderPulse(); lastList = 0; scheduleRender();
}, true);
document.addEventListener('input', (e) => {
  const d = e.target.dataset; if (!e.target.closest?.('#pulse')) return;
  if (d.tq) TR.cols[d.tq].q = e.target.value;
  else if (d.ta) P(d.ta).amt = Math.max(0, Number(e.target.value) || 0);
  else if (d.tff) { const [k, f] = d.tff.split(':'); P(k).f[f] = e.target.value.trim(); if (f === 'maxTax') setTaxAll(P(k).f.maxTax, P(k).f.hideUnknownTax); }
  else if (d.tfp) { const [k, p] = d.tfp.split(':'); const s = new Set(P(k).f.plats); e.target.checked ? s.add(p) : s.size > 1 ? s.delete(p) : (e.target.checked = true); P(k).f.plats = PLATS.filter((x) => s.has(x)); }
  else if (d.tfs) P(d.tfs).f.social = e.target.checked;
  else if (d.tfn) P(d.tfn).f.plain = e.target.checked;
  else if (d.tfu) setTaxAll(P(d.tfu).f.maxTax, e.target.checked);
  else if (d.tfc) setTaxAll(P(d.tfc).f.maxTax, P(d.tfc).f.hideUnknownTax, e.target.checked);
  else return;
  trSave(); lastPulse = 0; renderPulse(); lastList = 0; scheduleRender();
  if (d.tff || d.tfp || d.tfs || d.tfu || d.tfc || d.tfn) { const k = (d.tff || d.tfp || d.tfs || d.tfu || d.tfc || d.tfn).split(':')[0]; $('#tcb-' + k) && ($(`#tch-${k} .tc-funnel`).classList.toggle('act', true)); }
});
for (const k of Object.keys(TCOLS)) {
  const col = $('#tc-' + k); if (!col) continue;
  col.querySelector('.tcb').addEventListener('mouseenter', () => { tcPaused.add(k); renderPulse(); });
  col.querySelector('.tcb').addEventListener('mouseleave', () => { tcPaused.delete(k); lastPulse = 0; renderPulse(); });
}
renderTrenchHeads();

document.addEventListener('click', (e) => {
  const b = e.target.closest('#viewSw button'); if (b) return setView(b.dataset.view);
  if (e.target.closest('[data-qb],[data-qp],[data-tqb]')) return;   // 点买入区不打开详情
  if (e.target.closest('a[href^="http"]')) return;   // 社交 / 外部链接照常新标签打开
  const c = e.target.closest('[data-pa]'); if (!c) return;
  const t = S.tokens.get(c.dataset.pa); if (!t) return;
  openToken(t);
});
// 在当前标签页打开代币详情（不新开窗口）：用 hash 路由推一条历史记录，浏览器「后退」回到战壕 / 持仓；离开战壕前记下各列滚动位置，回来时恢复
const pulseScroll = {};
function openToken(t) {
  if (S.view === 'pulse') $$('.tcb').forEach((b) => { pulseScroll[b.id] = b.scrollTop; });
  if (S.view === 'hold') pulseScroll.hold = $('#hold')?.scrollTop || 0;
  // 左栏当前标签（即将发射 / 我的 等）能显示这个币就保持不变，不跳回「内盘中」
  const fits = S.listTab === 'mine' || ({ curve: t.stage !== 'dex', soon: t.stage === 'curve' && t.progress > 0, dex: t.stage === 'dex' }[S.listTab]);
  location.hash = `#/${t.platform}/${fits ? S.listTab : t.stage === 'dex' ? 'dex' : 'curve'}/${t.address}`;
}
setInterval(() => { if (S.view === 'pulse' && Date.now() - lastPulse > 1000) { renderPulse(); lastPulse = Date.now(); } }, 1000);
/* 鼠标侧键（后退/前进）返回战壕 */
['mousedown', 'mouseup', 'auxclick'].forEach((ev) => window.addEventListener(ev, (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault(); e.stopPropagation();
  if (ev === 'mouseup' && S.view !== 'pulse') setView('pulse');
}, true));



// ===== 战壕筛选弹窗（数据仍存 TR.cols[k].presets[preset].f，逻辑不变，只换 UI）=====
function tfModal(k) {
  document.getElementById('tfModal')?.remove();
  const f0 = P(k).f;
  const dr = { ...defPreset(k).f, ...JSON.parse(JSON.stringify(f0)) };
  const quotes = [...new Set([...S.tokens.values()].map((t) => String(t.quote || '').toUpperCase()).filter(Boolean))].sort();
  const PN = { flap: 'Flap', four: 'Four', gang: 'Gang', genius: 'Genius' };
  const m = document.createElement('div'); m.id = 'tfModal'; m.className = 'tfm-bg';
  const qset = () => new Set(String(dr.quote || '').toUpperCase().split(/[,，\s]+/).filter(Boolean));
  const draw = () => {
    const qs = qset();
    m.innerHTML = `<div class="tfm">
      <div class="tfm-h"><b>筛选 · ${TCOLS[k]} · P${TR.cols[k].preset}</b><button class="tfm-x" data-x>×</button></div>
      <div class="tfm-b">
        <div class="tfm-s"><div class="tfm-t"><span>分类</span><span><button class="tfm-all" data-gv3only title="只留 Gang V3（含 V3 打新）">只看 Gang V3</button> <button class="tfm-all" data-pall>全选</button></span></div>
          <div class="tfm-chips">${CATS.map(([c, l]) => `<button class="tfm-c pf-${c.split('-')[0]}${dr.cats.includes(c) ? ' on' : ''}" data-cat="${c}" title="${c.endsWith('-plain') ? (k === 'dex' ? '迁移后的普通盘（非 Agent）' : '内盘阶段的普通盘（非 Agent）：选上后服务端才开始拉这个平台的普通盘数据') : c.startsWith('gang-v3') ? 'Gang V3（含打新）' : ''}">${l}</button>`).join('')}</div></div>
        <div class="tfm-s"><div class="tfm-t"><span>Gang 回购 / 押金</span><span class="muted">不选 = 不限；选了只看有的（两个都选 = 有其一）</span></div>
          <div class="tfm-chips">${[['bb', '回购', '税收接收人是 dev 的回购合约：dev 那份税按比例回购销毁'], ['bond', '有押金', 'dev 付了押金承诺持仓（进行中的押金）']].map(([g, l, tip]) => `<button class="tfm-c pf-gang${(dr.gx || []).includes(g) ? ' on' : ''}" data-gx="${g}" title="${tip}">${l}</button>`).join('')}</div></div>
        <div class="tfm-s"><div class="tfm-t"><span>报价代币</span><span class="muted">不选 = 全部</span></div>
          <div class="tfm-chips">${quotes.map((q) => `<button class="tfm-c${qs.has(q) ? ' on' : ''}" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>
        <div class="tfm-s"><div class="tfm-t"><span>市值（K$）</span><span class="muted">填 5 = $5K</span></div><div class="tfm-row"><input data-f="minMc" value="${esc(dr.minMc)}" placeholder="最低，如 5"/><span>~</span><input data-f="maxMc" value="${esc(dr.maxMc)}" placeholder="最高，如 50"/></div></div>
        <div class="tfm-s"><div class="tfm-t"><span>创建时间（分钟）</span><span class="muted">创建到现在过了多久</span></div><div class="tfm-row"><input data-f="minAge" value="${esc(dr.minAge ?? '')}" placeholder="最少，如 0"/><span>~</span><input data-f="maxAge" value="${esc(dr.maxAge ?? '')}" placeholder="最多，如 5"/></div></div>
        <div class="tfm-s tfm-2"><div><div class="tfm-t"><span>持有人 ≥</span></div><input data-f="minHolders" value="${esc(dr.minHolders)}" placeholder="不限"/></div>
          <div><div class="tfm-t"><span>进度 ≥ %</span></div><input data-f="minProg" value="${esc(dr.minProg)}" placeholder="不限"/></div></div>
        <div class="tfm-s"><label class="tfm-chk"><input type="checkbox" data-soc ${dr.social ? 'checked' : ''}/> 有社交链接</label></div>
        <div class="tfm-s tfm-2"><div><div class="tfm-t"><span>最高税率 %</span><span class="muted">买或卖超过就隐藏（等于不算超过）</span></div><input data-f="maxTax" value="${esc(dr.maxTax ?? '')}" placeholder="不限，如 5"/>
            <div class="tfm-chips tfm-taxq">${[['', '不限'], ['1', '≤1%'], ['3', '≤3%'], ['5', '≤5%'], ['9.9', '去掉 10%+']].map(([v, l]) => `<button class="tfm-c${String(taxNum(dr.maxTax) ?? '') === v ? ' on' : ''}" data-taxq="${v}">${l}</button>`).join('')}</div></div>
          <div><div class="tfm-t"><span>&nbsp;</span></div><label class="tfm-chk"><input type="checkbox" data-unk ${dr.hideUnknownTax ? 'checked' : ''}/> 税率未知也隐藏</label><label class="tfm-chk" title="税收接收地址就是发币人自己的币不显示"><input type="checkbox" data-t2c ${dr.hideTax2c ? 'checked' : ''}/> 隐藏 dev 吃税（税归发币人）</label></div></div>
      </div>
      <div class="tfm-f"><button class="tfm-reset" data-reset>重置</button><button class="tfm-reset" data-alltax title="把这里的税率条件用到三列（当前预设）">税率应用到全部列</button><button class="tfm-ok" data-ok>应用</button></div></div>`;
  };
  const close = () => { m.remove(); document.removeEventListener('keydown', esc_); lastList = 0; scheduleRender(); };   // 左栏用同一套筛选，一起刷新
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  m.addEventListener('input', (e) => { const x = e.target.dataset; if (x.f) dr[x.f] = e.target.value.trim(); if (x.soc != null) dr.social = e.target.checked; if (x.unk != null) dr.hideUnknownTax = e.target.checked; if (x.t2c != null) dr.hideTax2c = e.target.checked; });
  m.addEventListener('click', (e) => {
    if (e.target === m) return close();
    const b = e.target.closest('button'); if (!b) return; const x = b.dataset;
    if (x.x != null) return close();
    if (x.cat) { const st = new Set(dr.cats); st.has(x.cat) ? (st.size > 1 && st.delete(x.cat)) : st.add(x.cat); dr.cats = CAT_KEYS.filter((c) => st.has(c)); }
    else if (x.pall != null) dr.cats = [...CAT_KEYS];
    else if (x.gv3only != null) dr.cats = ['gang-v3'];
    else if (x.gx) { const st = new Set(dr.gx || []); st.has(x.gx) ? st.delete(x.gx) : st.add(x.gx); dr.gx = ['bb', 'bond'].filter((g) => st.has(g)); }
    else if (x.q) { const st = qset(); st.has(x.q) ? st.delete(x.q) : st.add(x.q); dr.quote = [...st].join(','); }
    else if (x.taxq != null) dr.maxTax = x.taxq;
    else if (x.reset != null) Object.assign(dr, defPreset(k).f);
    else if (x.alltax != null) { setTaxAll(dr.maxTax, dr.hideUnknownTax, dr.hideTax2c); P(k).f = dr; trSave(); renderTrenchHeads(); lastPulse = 0; renderPulse(); note(`税率条件已应用到三列（P1-P3 都生效）${dr.maxTax ? `：最高 ${dr.maxTax}%` : ''}${dr.hideUnknownTax ? '，未知也隐藏' : ''}`, 'info'); return close(); }
    else if (x.ok != null) {
      // 税率条件改了就同时用到三列（只在一列设的话另外两列照常显示，容易以为没生效）
      { const v = taxNum(dr.maxTax); dr.maxTax = v == null ? '' : String(v); }
      const taxChanged = String(dr.maxTax ?? '') !== String(P(k).f.maxTax ?? '') || !!dr.hideUnknownTax !== !!P(k).f.hideUnknownTax || !!dr.hideTax2c !== !!P(k).f.hideTax2c;
      P(k).f = dr;
      if (taxChanged) { setTaxAll(dr.maxTax, dr.hideUnknownTax, dr.hideTax2c); note(`税率条件已同时用到三列（P1-P3 都生效）${dr.maxTax ? `：最高 ${dr.maxTax}%` : '：不限'}${dr.hideUnknownTax ? '，未知也隐藏' : ''}${dr.hideTax2c ? '，隐藏 dev 吃税' : ''}`, 'info'); }
      trSave(); renderTrenchHeads(); lastPulse = 0; renderPulse(); return close();
    }
    else return;
    draw();
  });
  document.addEventListener('keydown', esc_);
  draw(); document.body.appendChild(m);
}

/* ---------- 搜索历史：从搜索打开过的币，存 localStorage 'searchHist'（去重，最新在前，最多 20 个） ---------- */
const histGet = () => { try { return JSON.parse(localStorage.getItem('searchHist') || '[]'); } catch { return []; } };
const histSet = (a) => localStorage.setItem('searchHist', JSON.stringify(a.slice(0, 20)));
function histAdd(t) {
  const a = String(t.address).toLowerCase();
  histSet([{ address: t.address, symbol: t.symbol, name: t.name || '', logo: t.image || t.logo || null, platform: t.platform || '', ts: Date.now() }, ...histGet().filter((x) => String(x.address).toLowerCase() !== a)]);
}
const HIST_PLAT = { four: ['Four', '#f0b90b'], flap: ['Flap', '#a78bfa'], gang: ['Gang', '#f6465d'] };
const histAgo = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`; };
function renderHist() {
  const box = $('#searchResults'); const h = histGet();
  if (!h.length || document.activeElement !== sIn) return box.classList.add('hidden');
  searchIdx = Math.min(searchIdx, h.length - 1);
  box.innerHTML = `<div class="sh-head"><span>搜索历史</span><span class="spacer"></span><a data-hclr>清空</a></div>` + h.map((x, i) => {
    const t = S.tokens.get(x.address) || S.tokens.get(String(x.address).toLowerCase()); const img = t?.image || x.logo; const [pl, pc] = HIST_PLAT[x.platform] || [x.platform || '?', '#888'];
    return `<div data-a="${esc(x.address)}" class="sh-row${i === searchIdx ? ' on' : ''}">${img ? `<img class="sh-av" src="${esc(proxied(img))}" alt="" referrerpolicy="no-referrer">` : `<span class="sh-av">${esc(String(x.symbol || '?').slice(0, 1))}</span>`}<b>${esc(x.symbol || '?')}</b><span class="muted sh-nm">${esc(x.name || '')}</span><span class="mono muted">${short(x.address)}</span><i class="sh-pl" style="color:${pc};border-color:${pc}">${esc(pl)}</i><span class="spacer"></span><span class="muted sh-ts">${histAgo(x.ts)}</span><a class="sh-del" data-hdel="${esc(x.address)}" title="删除">×</a></div>`;
  }).join('');
  box.classList.remove('hidden');
}
function histClick(e) {
  const d = e.target.closest('[data-hdel]'), c = e.target.closest('[data-hclr]');
  if (!d && !c) return false;
  e.preventDefault(); e.stopPropagation();
  histSet(c ? [] : histGet().filter((x) => x.address !== d.dataset.hdel)); renderHist(); return true;
}
sIn.addEventListener('focus', () => { if (!sIn.value.trim()) { searchIdx = 0; renderHist(); } });

/* ---------- 打赏作者 ---------- */
const DONATE_ADDR = '0xcD4750b7b09dc39d20F8bC1E92456615Da7B6688';
function openDonate() {
  if (document.querySelector('.donate-dlg')) return;
  const wrap = document.createElement('div'); wrap.className = 'ui-dlg-back';
  wrap.innerHTML = `<div class="ui-dlg donate-dlg" role="dialog" aria-modal="true"><div class="ui-h">☕ 打赏作者</div>
    <div class="ui-b"><div class="donate-qr"><img src="donate-qr.png?v=1" width="200" height="200" alt="打赏地址二维码" /></div>
      <div class="ui-addr"><span class="mono donate-addr" data-dcopy title="点击复制">${DONATE_ADDR}</span><button class="ui-copy" data-dcopy>复制</button></div>
      <div class="ui-note" style="text-align:center">BSC / BEP20 · 支持 BNB 及 BEP20 代币</div></div>
    <div class="ui-f"><button class="ui-btn" data-dclose>关闭</button></div></div>`;
  document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => { document.removeEventListener('keydown', key, true); wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 150); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-dclose]')) return close();
    if (e.target.closest('[data-dcopy]')) { let ok = false; try { await copyOrThrow(DONATE_ADDR); ok = true; } catch { /* 剪贴板接口不可用时退回旧办法 */ }
      if (!ok) { const ta = document.createElement('textarea'); ta.value = DONATE_ADDR; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove(); }
      note(ok ? '已复制' : '复制失败，请手动选择地址', ok ? 'ok' : 'info'); }
  });
}
$('#donateBtn')?.addEventListener('click', openDonate);

/* ---------- 追踪 + 跟单 ---------- */
// 追踪：关注的地址在内盘上的买卖（链上订阅筛出来，服务器推送）。跟单：每个任务跟一个目标，新建一律「暂停 + 模拟」，要本人打开
const ACT_CLS = { 建仓: 'g', 加仓: 'g', 减仓: 'r', 清仓: 'r' };
const trkAgo = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? Math.floor(s) + '秒' : s < 3600 ? Math.floor(s / 60) + '分' : s < 86400 ? Math.floor(s / 3600) + '时' : Math.floor(s / 86400) + '天'; };
// 最小金额（BNB）：追踪抽屉和追踪页共用，记在浏览器里；没有 BNB 金额的成交（非 BNB 计价）不按金额过滤
// 最小金额按美元算（老版本存的是 BNB：trkMin，第一次按默认 BNB 价折成美元）
try { TRK.fMin = localStorage.trkMinUsd != null ? Number(localStorage.trkMinUsd) || 0 : Math.round((Number(localStorage.trkMin) || 0) * S.bnbUsd); } catch { /* ignore */ }
// 追踪动态的美元金额：事件自带 usd 就用，否则 BNB 金额 × 现价（报价币已在服务器折成 BNB）
const trkUsd = (e) => (e.usd > 0 ? e.usd : e.bnb > 0 && S.bnbUsd ? e.bnb * S.bnbUsd : 0);
const trkUsdS = (v) => '$' + (v >= 1000 ? K(v) : v.toFixed(v < 1 ? 3 : 2));
function trkMinPass(e) { const u = trkUsd(e); return !(TRK.fMin > 0) || !(u > 0) || u >= TRK.fMin; }
function setTrkMin(v) { TRK.fMin = Math.max(0, Number(v) || 0); try { localStorage.trkMinUsd = String(TRK.fMin); } catch { /* ignore */ } for (const id of ['trkFMin', 'trkpMin']) { const el = $('#' + id); if (el && document.activeElement !== el) el.value = TRK.fMin || ''; } if (S.view === 'track') renderTrack(); renderTrkPanel(); }
function trkPass(e) { const tg = TRK.targets.find((x) => x.address === e.target); return (!TRK.fGroup || (tg?.group || '默认') === TRK.fGroup) && trkMinPass(e); }
// 追踪地址的显示名：备注名 > 域名 > 短地址（备注存服务器的追踪数据里，和钱包无关）
function trkT(addr) { return TRK.targets.find((x) => x.address === String(addr || '').toLowerCase()) || null; }
function trkRemark(addr) { const t = trkT(addr); return (t ? (t.remark || (t.name && t.name !== t.domain ? t.name : '')) : '') || REMARKS[String(addr || '').toLowerCase()] || ''; }
function trkName(addr) { const t = trkT(addr); return trkRemark(addr) || t?.domain || NAMES[String(addr || '').toLowerCase()] || short(addr, 6, 4); }
function trkSub(addr) { const t = trkT(addr), dom = t?.domain || NAMES[String(addr || '').toLowerCase()]; return trkRemark(addr) ? (dom || short(addr, 6, 4)) : dom ? short(addr, 6, 4) : ''; }
async function trkSaveRemark(addr, v) { const t = trkT(addr); v = String(v || '').trim().slice(0, 40); await saveRemark(addr, v); if (!t) return; await api('/api/track/targets', { address: addr, remark: v, name: v || t?.domain || '', domain: t?.domain || null, group: t?.group }); await loadTrack(); renderTrkPanel(); }
// 备注：总是写进 data/remarks.json（没追踪也能备注）；追踪中的地址由 trkSaveRemark 同时改追踪列表
async function saveRemark(addr, v) { Object.assign(REMARKS, await api('/api/remarks', { address: addr, remark: String(v || '').trim().slice(0, 40) })); if (!String(v || '').trim()) delete REMARKS[String(addr).toLowerCase()]; scheduleRender(); }
// 查域名：粘贴钱包地址（或 .ai / .bnb 域名）→ 显示它的 .ai 域名、SPACE ID 域名，可以直接写备注 / 顺手追踪
async function walletLookup(q) {
  q = String(q || '').trim().toLowerCase(); if (!q) return;
  let addr = q, r;
  try {
    if (!/^0x[0-9a-f]{40}$/.test(q)) addr = (await api(`/api/track/resolve?name=${encodeURIComponent(q)}`)).address;
    r = await api(`/api/names/lookup?address=${addr}`);
  } catch (err) { return toast({ status: 'failed', symbol: '查域名', reason: err.message }); }
  if (r.name) NAMES[addr] = r.name;
  await trkEnsure();
  const tracked = TRK.targets.some((x) => x.address === addr), old = trkRemark(addr);
  const row = (k, v, failed) => `<div class="wl-row"><span class="muted">${k}</span>${v ? `<b class="wl-dom">${esc(v)}</b><button class="ui-copy" data-ui="copy" data-v="${esc(v)}">复制</button>` : `<span class="dim">${failed ? '查询失败，稍后再试' : '没有'}</span>`}</div>`;
  const body = `${row('.ai 域名', r.ai, r.aiFailed)}${row('SPACE ID', r.sid && r.sid !== r.ai ? r.sid : '', r.sidFailed)}
    ${isMe(addr) ? '<p class="g">这是你自己的钱包</p>' : ''}
    <label class="ui-in wl-in">备注<input name="remark" value="${esc(old)}" maxlength="40" placeholder="留空 = 显示域名 / 地址" /></label>
    ${LIVE() && !tracked && !isMe(addr) ? '<label class="wl-ck"><input type="checkbox" name="track" /> 同时追踪这个地址</label>' : tracked ? '<p class="ui-note">已在追踪列表里，备注会同步到追踪</p>' : ''}
    <p class="ui-note"><a href="https://gmgn.ai/bsc/address/${esc(addr)}" target="_blank" rel="noopener noreferrer">在 GMGN 查看 ↗</a></p>`;
  const v = await ui.form({ title: r.ai || r.sid || '钱包查询', body, address: addr, confirmText: '保存备注' }); if (!v) return;
  const rm = String(v.remark || '').trim();
  try {
    if (rm !== old) await trkSaveRemark(addr, rm);
    if (v.track) { await api('/api/track/targets', { address: addr, domain: r.ai || r.sid || null, name: rm || r.ai || r.sid || '', remark: rm }); await loadTrack(); }
    note(v.track ? `已追踪 ${rm || r.ai || short(addr, 6, 4)}` : rm !== old ? (rm ? '备注已保存' : '已清除备注') : '没有改动', 'info');
    $$('.trd-acts').forEach((x) => { x.outerHTML = trdActs(addr); }); if (S.view === 'track') renderTrack();
  } catch (err) { toast({ status: 'failed', symbol: '备注', reason: err.message }); }
}
// 就地编辑：点 ✎ 把名字换成输入框，回车保存、Esc 取消；清空 = 恢复显示域名 / 地址
function trkEditInline(btn) {
  const addr = btn.dataset.trkedit, host = btn.closest('[data-trkname]') || btn.parentElement; if (!addr || host.querySelector('input.trk-ed')) return;
  const old = trkRemark(addr), inp = document.createElement('input'); inp.className = 'trk-ed'; inp.value = old; inp.placeholder = '备注名（留空 = 显示域名 / 地址）'; inp.maxLength = 40;
  const saved = host.innerHTML; host.innerHTML = ''; host.appendChild(inp); inp.focus(); inp.select();
  let done = false; const finish = async (save) => { if (done) return; done = true; if (save && inp.value.trim() !== old) { try { await trkSaveRemark(addr, inp.value); note(inp.value.trim() ? '备注已保存' : '已清除备注'); } catch (e) { toast({ status: 'failed', symbol: '备注', reason: e.message }); host.innerHTML = saved; } } else host.innerHTML = saved; if (S.view === 'track') renderTrack(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } e.stopPropagation(); });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (e) => e.stopPropagation(), true);
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-trkedit]'); if (!b) return; e.preventDefault(); e.stopPropagation(); trkEditInline(b); }, true);
async function loadTrack() {
  try { const [a, b] = await Promise.all([api('/api/track'), api('/api/copy')]); Object.assign(TRK, { targets: a.targets || [], groups: a.groups || ['默认'], feed: a.feed || [], tasks: b.tasks || [], paused: !!b.paused, log: b.log || [], loaded: true }); }
  catch (e) { TRK.err = e.message; }
  try { TRK.sound = localStorage.trkSound !== '0'; } catch { /* ignore */ }
  renderTrkSound(); renderTrkKill(); renderTrack();
}
function renderTrkKill() {
  const b = $('#trkKill'); if (b) { b.classList.toggle('on', TRK.paused); b.textContent = TRK.paused ? '已全部暂停（点击恢复）' : '全部暂停'; }
  // 顶栏：有跟单任务在跑（或已全部暂停）时显示一个小胶囊，点了跳到跟单页
  const running = TRK.tasks.filter((t) => t.status === 'running'), real = running.filter((t) => !t.params?.dryRun);
  let pill = $('#copyPill');
  if (!running.length && !TRK.paused) { pill?.remove(); return; }
  if (!pill) { pill = document.createElement('button'); pill.id = 'copyPill'; pill.className = 'pill copy-pill'; pill.addEventListener('click', () => { TRK.tab = 'copy'; setView('track'); }); $('#favToggle')?.before(pill); }
  pill.classList.toggle('paused', TRK.paused); pill.classList.toggle('real', !TRK.paused && real.length > 0);
  pill.textContent = TRK.paused ? '跟单：全部暂停' : `跟单 ${running.length} 个运行中${real.length ? `（${real.length} 个真实下单）` : '（模拟）'}`;
}
function renderTrack() {
  if (S.view !== 'track') return;
  $$('#track [data-trtab]').forEach((b) => b.classList.toggle('on', b.dataset.trtab === TRK.tab));
  $('#trkFeedView').classList.toggle('hidden', TRK.tab !== 'feed'); $('#trkCopyView').classList.toggle('hidden', TRK.tab !== 'copy');
  $('#trkSound').checked = TRK.sound;
  if (TRK.err && !TRK.loaded) { $('#trkFeed').innerHTML = `<div class="empty">${esc(TRK.err)}</div>`; return; }
  if (TRK.tab === 'feed') renderTrkFeed(); else renderTrkCopy();
}
function renderTrkFeed() {
  $('#trkGroups').innerHTML = TRK.groups.map((g) => `<option value="${esc(g)}">`).join('');
  const fg = $('#trkFGroup'); const cur = TRK.fGroup; fg.innerHTML = '<option value="">全部分组</option>' + TRK.groups.map((g) => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
  $('#trkList').innerHTML = TRK.targets.length ? TRK.targets.map((t) => `<div class="trk-t"><i class="ws-av" style="background:${wsColor((parseInt(t.address.slice(-2), 16) % 4) + 1)}"></i>
    <div class="trk-t-id"><span class="trk-nm" data-trkname><b class="${trkRemark(t.address) ? 'y' : 'wn'}">${esc(trkName(t.address))}</b><button class="trk-pen" data-trkedit="${t.address}" title="编辑备注名">✎</button></span><span class="mono muted">${esc(trkSub(t.address) || short(t.address, 6, 4))} · ${esc(t.group || '默认')}</span></div>
    <button class="trk-mini" data-trknew="${t.address}" title="给这个目标新建跟单任务（新建是暂停 + 模拟）">跟单</button><button class="trk-x" data-trkdel="${t.address}" title="不再追踪">×</button></div>`).join('')
    : '<div class="empty">还没有追踪的地址。上面填 .ai / .bnb 域名或 0x 地址添加</div>';
  const rows = TRK.feed.filter(trkPass);
  $('#trkCount').textContent = `${rows.length} 条`;
  $('#trkFeed').innerHTML = rows.length ? `<table class="trk-tbl"><tr><th class="l">时间</th><th class="l">目标</th><th class="l">动作</th><th>金额</th><th class="l">代币</th><th>币龄</th><th>市值</th></tr>
    ${rows.map((e) => `<tr data-a="${e.token}"><td class="l dim" title="${fullTime(e.ts)}">${trkAgo(e.ts)}前</td>
      <td class="l"><a href="#" class="${trkRemark(e.target) ? 'y' : 'wn'}" data-trkwho="${e.target}:${e.token}" title="${esc(trkSub(e.target) || e.target)}">${esc(trkName(e.target))}</a></td>
      <td class="l"><b class="${ACT_CLS[e.action] || ''}">${e.action}</b>${e.pct != null && e.side === 'sell' ? ` <span class="dim">${e.pct.toFixed(0)}%</span>` : ''}</td>
      <td><b>${trkUsd(e) ? trkUsdS(trkUsd(e)) : '—'}</b>${e.bnb ? `<div class="hsub">${bnb(e.bnb, 4)} BNB</div>` : ''}${e.quote !== 'BNB' ? `<div class="hsub">${K(e.quoteAmt)} ${esc(e.quote)}</div>` : ''}</td>
      <td class="l"><span class="side">${logoHtml({ address: e.token, symbol: e.symbol, image: e.image, platform: e.platform }, 'xs')}<b>${esc(e.symbol)}</b>${e.quote !== 'BNB' ? ` <i class="tag">${esc(e.quote)}</i>` : ''}</span></td>
      <td class="dim" title="${e.createdAt ? '创建于 ' + fullTime(e.createdAt) : ''}">${e.createdAt ? trkAgo(e.createdAt) : '—'}</td><td>${usd(e.mcapUsd)}</td></tr>`).join('')}</table>`
    : '<div class="empty">还没有动态。追踪的地址在 Flap / Four / Gang V2 内盘上买卖时会出现在这里</div>';
}
const tkFmt = (v) => (v ? bnb(v, 4) : '0');
function renderTrkCopy() {
  $$('#track [data-cptab]').forEach((b) => b.classList.toggle('on', b.dataset.cptab === TRK.cptab));
  const list = TRK.tasks.filter((t) => (TRK.cptab === 'active' ? t.status !== 'closed' : t.status === 'closed'));
  const wl = (slots) => (slots || []).map((n) => esc(S.walletsInfo?.find((w) => w.slot === n)?.agentId || `钱包 ${n}`)).join(' + ');
  $('#trkTasks').innerHTML = list.length ? `<table class="trk-tbl"><tr><th class="l">钱包</th><th class="l">任务</th><th>总买入</th><th>总卖出</th><th>买 / 卖</th><th>已实现利润</th><th>最近交易</th><th class="l">状态</th><th class="l">操作</th></tr>
    ${list.map((t) => { const p = t.params || {}, st = t.status === 'running' ? (TRK.paused ? '<b class="y">运行中（被全部暂停）</b>' : `<b class="g">运行中</b>`) : t.status === 'paused' ? '<b class="muted">已暂停</b>' : '<span class="muted">已关闭</span>';
      return `<tr><td class="l">${wl(p.wallets)}</td><td class="l"><b title="${esc(t.target)}">${esc(trkRemark(t.target) || t.name)}</b><div class="hsub">${short(t.target, 6, 4)} · ${p.mode === 'ratio' ? `跟 ${p.ratioPct}%` : `每次 ${p.amountBnb} BNB`}${p.onlyFirst ? ' · 只跟建仓' : ''}${p.followSell ? ' · 跟卖' : ''} · ${p.maxCopies > 0 ? `已跟 ${p.dryRun ? (t.stats?.simCopies || 0) : (t.stats?.copies || 0)}/${p.maxCopies} 次${p.dryRun ? '（模拟）' : ''}` : '次数不限'}</div>${t.closeReason ? `<div class="hsub y">${esc(t.closeReason)}</div>` : ''}</td>
        <td>${tkFmt(t.stats?.buyBnb)}</td><td>${tkFmt(t.stats?.sellBnb)}</td><td>${t.stats?.buys || 0} / ${t.stats?.sells || 0}${t.stats?.sims ? `<div class="hsub">模拟 ${t.stats.sims} 次</div>` : ''}</td>
        <td class="${(t.stats?.realized || 0) >= 0 ? 'g' : 'r'}">${t.stats?.realized ? (t.stats.realized > 0 ? '+' : '') + bnb(t.stats.realized, 4) : '0'}</td><td class="dim" title="${fullTime(t.stats?.lastAt)}">${t.stats?.lastAt ? trkAgo(t.stats.lastAt) + '前' : '—'}</td>
        <td class="l">${st}<div class="hsub">${p.dryRun ? '<b class="y">模拟</b>（不下单）' : '<b class="r">真实下单</b>'}</div></td>
        <td class="l trk-acts">${t.status === 'closed' ? `<button data-cpact="delete:${t.id}">删除</button>` : `${t.status === 'running' ? `<button data-cpact="pause:${t.id}">暂停</button>` : `<button class="go" data-cpact="start:${t.id}">启动</button>`}<button data-cpact="edit:${t.id}">参数</button><button data-cpact="close:${t.id}">关闭</button>`}</td></tr>`; }).join('')}</table>`
    : `<div class="empty">${TRK.cptab === 'active' ? '还没有跟单任务。点「新建跟单」，或在追踪动态里点目标旁的「跟单」' : '没有已关闭的任务'}</div>`;
  $('#trkLog').innerHTML = TRK.log.length ? TRK.log.slice(0, 200).map((r) => `<div class="trk-lr ${r.kind}"><span class="dim">${new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span><b>${esc((r.target && trkRemark(r.target)) || r.taskName || '')}</b><span>${esc(r.symbol || '')} ${esc(r.action || '')}</span><span class="trk-k">${{ order: '下单', sim: '模拟', skip: '跳过', fail: '失败', error: '出错', stop: '停止' }[r.kind] || r.kind}</span><span class="trk-r">${esc(r.reason || '')}</span></div>`).join('') : '<div class="empty">还没有记录</div>';
}
/* ---------- Gang 新盘狙击 ---------- */
// gang.fun 出新盘时用选中的钱包各买总量 N%。默认关闭 + 模拟；上限都在服务器端强制；急停 = 立刻关闭
async function loadSnipe() {
  try { const v = await api('/api/snipe'); SNP.log = v.log || []; delete v.log; SNP.v = v; SNP.err = null; } catch (e) { SNP.err = e.message; }
  renderSnpPill(); if (S.view === 'snipe') { SNP.formAt = 0; renderSnipe(); }
}
const snpWl = (slots) => (slots || []).map((n) => esc(S.walletsInfo?.find((w) => w.slot === n)?.agentId || `钱包 ${n}`)).join(' + ');
function renderSnpPill() {
  const v = SNP.v; let pill = $('#snpPill');
  if (!v?.enabled) { pill?.remove(); return; }
  if (!pill) { pill = document.createElement('button'); pill.id = 'snpPill'; pill.className = 'pill copy-pill'; pill.addEventListener('click', () => setView('snipe')); $('#favToggle')?.before(pill); }
  pill.classList.toggle('real', !v.params.dryRun); pill.textContent = `Gang 狙击运行中（${v.params.dryRun ? '模拟' : '真实下单'}）`;
}
// 狙击触发时的提示：真实下单的成交 / 失败停留久一点并响一声；模拟只弹一条短提示；跳过不提示
function snpNotice(r) {
  if (!['order', 'fail', 'sim', 'error'].includes(r.kind)) return;
  if (r.kind === 'sim') return note(`Gang 狙击（模拟）${r.symbol || ''}：每个钱包 ${r.amount} BNB`, 'info');
  const el = document.createElement('div'); el.className = 'toast ' + (r.kind === 'order' ? '' : 'err');
  el.innerHTML = `<b class="${r.kind === 'order' ? 'g' : 'r'}">Gang 狙击${r.kind === 'order' ? '已下单' : '失败'}</b> · ${esc(r.symbol || '')}<div class="muted">${esc(r.reason || '')}</div>${(r.results || []).filter((x) => x.tx).map((x) => `<div>${esc(x.wallet || '')} ${txLink(x.tx)}</div>`).join('')}`;
  $('#toasts').prepend(el); setTimeout(() => el.remove(), 20000); beep(r.kind === 'order' ? 1200 : 400, 0.12);
}
function renderSnipe() {
  const v = SNP.v;
  if (!v) { $('#snpHead').innerHTML = `<div class="empty">${esc(SNP.err || '加载中…')}</div>`; $('#snpForm').innerHTML = ''; $('#snpLog').innerHTML = ''; return; }
  const p = v.params, nW = p.wallets.length || 1, td = v.today || { bnb: 0, tokens: 0 };
  const st = !v.enabled ? '<b class="muted">已关闭</b>' : p.dryRun ? '<b class="y">运行中 · 模拟（不下单）</b>' : '<b class="r">运行中 · 真实下单</b>';
  const recent = (v.recent || []).slice(0, 8);
  $('#snpHead').innerHTML = `<div class="snp-top"><div class="snp-st">${st}<div class="hsub">新盘出现时：${snpWl(p.wallets)} 各买总量 ${p.pct}%（每个钱包最多 ${p.maxBnbPerBuy} BNB）· 只狙 ${esc(p.quotes.includes('*') ? '全部报价币' : p.quotes.join(' / ') + ' 盘')} · 出块后 ${p.maxDelaySec} 秒内</div></div>
    <span class="spacer"></span>${v.enabled ? `<button class="trk-kill on" data-snp="off">急停（立刻关闭）</button>` : `<button class="trk-new snp-real" data-snp="on:real">开启（真实买入）</button><button class="trk-new" data-snp="on:sim">开启（模拟）</button>`}</div>
    ${!p.dryRun && !v.liveTrade ? '<div class="ui-note y">这个后端没有开 LIVE_TRADE=1，真实模式下单也只会报价。</div>' : ''}
    <div class="snp-cards"><div class="snp-card"><span class="muted">今天已用</span><b>${bnb(td.bnb, 4)} / ${p.dailyCapBnb} BNB</b></div><div class="snp-card"><span class="muted">今天已狙</span><b>${td.tokens} / ${p.maxTokensPerDay || '不限'} 个</b></div>
      <div class="snp-card"><span class="muted">累计</span><b>${v.stats.orders} 笔下单 · ${bnb(v.stats.bnb, 4)} BNB</b><span class="hsub">模拟 ${v.stats.sims} 次 · 失败 ${v.stats.fails} 笔</span></div></div>
    <div class="snp-cost"><b>买 ${p.pct}% 要多少 BNB（BNB 盘，虚拟储备 5 BNB）</b><table class="trk-tbl"><tr><th class="l">发现时已被买走</th>${v.typical.map((x) => `<th>${x.soldPct}%</th>`).join('')}</tr>
      <tr><td class="l">每个钱包</td>${v.typical.map((x) => `<td>${x.bnb}</td>`).join('')}</tr><tr><td class="l">${nW} 个钱包合计（含 ${p.buffer}% 缓冲）</td>${v.typical.map((x) => `<td>${(x.bnb * nW * (1 + p.buffer / 100)).toFixed(4)}</td>`).join('')}</tr></table>
      <div class="hsub">多付的缓冲合约会退回，以 WBNB 留在钱包（下次狙击直接用，也可在持仓页「计价币余额」换回 BNB）。每个钱包第一次狙击还要多一笔 WBNB 授权；之后钱包里有预备的 WBNB 时只发 buy 一笔，没有就是包装 + buy 两笔（慢约 3 秒）。</div>
      ${recent.length ? `<div class="snp-recent"><span class="muted">最近发现的新盘：</span>${recent.map((r) => `<span title="${fullTime(r.ts)}">${esc(r.symbol || '?')} <i class="tag">${esc(r.quote || '')}</i> ${r.costBnb} BNB${r.soldPct ? `（已卖 ${r.soldPct}%）` : ''}</span>`).join('')}</div>` : ''}</div>`;
  const pos = v.positions || [];
  $('#snpPos').innerHTML = pos.length ? `<table class="trk-tbl"><tr><th class="l">代币</th><th class="l">狙入</th><th>投入</th><th>现价 / 买入价</th><th class="l">已卖档位</th><th class="l">钱包</th><th class="l"></th></tr>${pos.map((x) => `<tr><td class="l"><a href="#" data-snpgo="${x.token}"><b>${esc(x.symbol || '?')}</b></a> <i class="tag">${esc(x.quote || '')}</i>${x.dryRun ? ' <b class="y">模拟</b>' : ''}</td><td class="l dim" title="${fullTime(x.ts)}">${trkAgo(x.ts)}前</td><td>${bnb(x.bnb, 4)}</td><td class="${x.mult >= 1 ? 'g' : 'r'}"><b>${x.mult != null ? x.mult.toFixed(2) + '×' : '—'}</b></td><td class="l">${(x.tiersDone || []).map((m) => m + '×').join('、') || '—'}</td><td class="l">${snpWl(x.wallets)}</td><td class="l"><button class="trk-mini" data-snp="forget:${x.token}" title="不再自动卖出这个币（不卖出，已买的留着）">停止盯</button></td></tr>`).join('')}</table>`
    : `<div class="empty">还没有狙到的币。${p.autoSell ? `狙到后会按「${p.tiers.map((t) => `${t.mult} 倍卖 ${t.pct}%`).join('，') || '未设置档位'}」${p.stopLossPct ? `、跌 ${p.stopLossPct}% 止损` : ''}自动卖出` : '自动卖出已关闭'}</div>`;
  // 参数表单只在第一次 / 保存后重画，推送更新时不打断正在输入的内容
  if (!SNP.formAt || !$('#snpForm').innerHTML) {
    SNP.formAt = Date.now();
    // 钱包列表还没加载到时，至少列出参数里已选的钱包，避免保存时把它们丢掉
    const ws = [...(S.walletsInfo || [])]; for (const n of p.wallets) if (!ws.some((w) => w.slot === n)) ws.push({ slot: n, label: `钱包 ${n}` });
    const num = (k, label, step = '0.01', hint = '') => `<label class="cp-f"><span>${label}</span><input type="number" step="${step}" min="0" data-sp="${k}" value="${p[k]}"/>${hint ? `<i>${hint}</i>` : ''}</label>`;
    const chk = (k, label, hint = '') => `<label class="cp-c"><input type="checkbox" data-sp="${k}" ${p[k] ? 'checked' : ''}/> ${label}${hint ? `<i>${hint}</i>` : ''}</label>`;
    $('#snpForm').innerHTML = `<div class="cp-grp"><b>金额与上限（服务器端强制，每个钱包单笔最高 ${v.hardMax} BNB，另外还受交易设置的单笔上限）</b>
      ${num('pct', '每个钱包买总量的 %', '0.1', 'Gang V2 合约限制每个钱包最多 1%')}${num('maxBnbPerBuy', '每个钱包单笔最多（BNB）', '0.001')}${num('dailyCapBnb', '每天合计最多（BNB，所有钱包加起来）')}${num('maxTokensPerDay', '每天最多狙几个币', '1', '0 = 不限')}
      ${chk('partial', '超过单笔上限时按上限买一部分', '关掉 = 直接跳过')}${num('buffer', '金额缓冲 %', '1', '多付的合约会退回')}</div>
      <div class="cp-grp"><b>条件</b>${num('maxDelaySec', '出块后最多几秒', '1', '发现得比这晚就不买')}${num('maxSoldPct', '发现时已被买走最多 %', '1', '超过说明已经被别人抢了')}${num('slippage', '滑点 %', '1')}${num('wbnbFloat', '每个钱包预备 WBNB（BNB）', '0.01', '真实狙击开着时自动把 BNB 包装成 WBNB 备着，低于一半就补；BNB 盘只发 buy 一笔，快约 3 秒。0 = 不预备')}
        <label class="cp-f"><span>报价币</span><input data-sp="quotes" value="${esc(p.quotes.join(','))}"/><i>逗号分隔，如 BNB,XAUT（黄金盘）；* = 全部。非 BNB 盘：钱包里有够用的这个报价币时直接用（只发 buy），没有就先用 baw 把 BNB 换成它，慢几秒</i></label>
        <div class="cp-row">用哪些钱包（每个钱包各买一份）：${ws.map((w) => `<label class="cp-c" title="${esc(w.label)} ${w.address || ''}"><input type="checkbox" data-spw="${w.slot}" ${p.wallets.includes(w.slot) ? 'checked' : ''}/> ${esc(w.agentId || w.label)} <i class="${w.auth === 'ok' || !w.auth ? 'g' : 'r'}">${w.auth === 'ok' || !w.auth ? '已登录' : '未登录'}</i></label>`).join('')}</div>
        <div class="cp-row">屏蔽列表里的代币 / 开发者不会被狙。</div></div>
      <div class="cp-grp"><b>自动卖出（狙到的币每 3 秒按曲线现价对比买入均价；「急停」只停买入，自动卖出照常，要停就关这里）</b>${chk('autoSell', '开启自动卖出')}<span></span>
        ${[0, 1, 2].map((i) => `<label class="cp-f"><span>档位 ${i + 1}：涨到几倍 → 卖出当时持仓的 %</span><span class="snp-tier"><input type="number" step="0.1" min="0" data-tier="${i}:mult" value="${p.tiers[i]?.mult ?? ''}" placeholder="倍数"/>× <input type="number" step="1" min="0" max="100" data-tier="${i}:pct" value="${p.tiers[i]?.pct ?? ''}" placeholder="%"/>%</span>${i === 0 ? '<i>默认 2 倍卖 50% = 出本；留空 = 不用这一档</i>' : ''}</label>`).join('')}
        ${num('stopLossPct', '止损：跌到买入价的百分之多少以下全卖', '1', '填跌幅，如 50 = 跌一半全卖；0 = 不止损')}${num('sellSlippage', '卖出滑点 %', '1')}${num('holdHours', '最多盯多少小时', '1')}</div>
      <div class="cp-grp"><b>运行方式</b>${chk('dryRun', '模拟（只记录会买多少，不真的下单）', '建议先模拟一段时间再关掉')}<span></span><div><button class="ui-btn ok" data-snp="save">保存参数</button> <span class="cp-err r" id="snpErr"></span></div></div>`;
  }
  $('#snpLog').innerHTML = SNP.log.length ? SNP.log.slice(0, 200).map((r) => `<div class="trk-lr ${r.kind}"><span class="dim">${new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span><b>${esc(r.symbol || '')}</b><span>${esc(r.quote || '')}${r.cost ? ` · 1% ≈ ${bnb(r.cost, 4)}` : ''}</span><span class="trk-k">${{ order: '下单', sim: '模拟', skip: '跳过', fail: '失败', error: '出错', prep: '预备' }[r.kind] || r.kind}</span><span class="trk-r">${esc(r.reason || '')}${r.totalMs ? ` · 出块到完成 ${(r.totalMs / 1000).toFixed(1)} 秒` : ''}</span></div>`).join('') : '<div class="empty">还没有记录。开启后，gang.fun 每出一个新盘都会在这里记一条</div>';
}
$('#snipe').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-snp]'); if (!b) return;
  const act = b.dataset.snp, v = SNP.v; if (!v) return;
  try {
    if (act.startsWith('forget:')) { if (!(await ui.confirm({ title: '不再自动卖出这个币？', body: '只是不再盯着它，已买的币留在钱包里，不会卖出。', confirmText: '停止盯' }))) return; SNP.v = await api('/api/snipe', { forget: act.slice(7) }); }
    else if (act === 'off') { SNP.v = await api('/api/snipe', { enabled: false }); note('Gang 狙击已关闭'); }
    else if (act.startsWith('on:')) {
      const p = { ...v.params, dryRun: act === 'on:sim' }, nW = p.wallets.length || 1;   // 按哪个按钮就用哪种方式开启（不用先去参数里改「模拟」）
      if (!(await ui.confirm({ title: `开启 Gang 狙击（${p.dryRun ? '模拟' : '真实下单'}）？`, body: p.dryRun ? '<p>这是<b class="y">模拟</b>：每个新盘只记录会买多少，不会下单。</p>' : `<p class="r"><b>真实下单：</b>gang.fun 每出一个符合条件的新盘，${nW} 个钱包（${snpWl(p.wallets)}）会立刻各买总量 ${p.pct}%：每个钱包每次最多 ${p.maxBnbPerBuy} BNB，每天合计最多 ${p.dailyCapBnb} BNB、最多 ${p.maxTokensPerDay || '不限'} 个币。会花真实的 BNB，新盘很可能归零。随时可以点「急停」。</p>`, confirmText: '开启', danger: !p.dryRun }))) return;
      SNP.v = await api('/api/snipe', { params: { dryRun: p.dryRun }, enabled: true }); SNP.formAt = 0; note(`Gang 狙击已开启（${p.dryRun ? '模拟' : '真实下单'}）`);
    } else if (act === 'save') {
      const f = $('#snpForm'), q = {}; f.querySelectorAll('[data-sp]').forEach((i) => { q[i.dataset.sp] = i.type === 'checkbox' ? i.checked : i.dataset.sp === 'quotes' ? i.value.split(/[,，\s]+/).filter(Boolean) : Number(i.value); });
      q.wallets = [...f.querySelectorAll('[data-spw]:checked')].map((i) => Number(i.dataset.spw));
      q.tiers = [0, 1, 2].map((i) => ({ mult: Number(f.querySelector(`[data-tier="${i}:mult"]`).value), pct: Number(f.querySelector(`[data-tier="${i}:pct"]`).value) })).filter((x) => x.mult > 0 && x.pct > 0);
      if (!q.wallets.length) return ($('#snpErr').textContent = '至少选一个钱包');
      if (v.enabled && v.params.dryRun && !q.dryRun && !(await ui.confirm({ title: '切换到真实下单？', body: `<p class="r">狙击正在运行，保存后下一个新盘就会用真实 BNB 买入（每个钱包最多 ${q.maxBnbPerBuy} BNB，每天合计最多 ${q.dailyCapBnb} BNB）。</p>`, confirmText: '保存并真实下单', danger: true }))) return;
      SNP.v = await api('/api/snipe', { params: q }); SNP.formAt = 0; note('狙击参数已保存');
    }
    renderSnpPill(); renderSnipe();
  } catch (err) { const el = $('#snpErr'); if (el) el.textContent = err.message; else toast({ status: 'failed', symbol: '狙击', reason: err.message }); }
});
document.addEventListener('click', (e) => { const a = e.target.closest('[data-snpgo]'); if (!a) return; e.preventDefault(); const t = a.dataset.snpgo; setView('trade'); if (S.tokens.has(t)) select(t); else api(`/api/lookup/${t}`).then(() => setTimeout(() => select(t), 500)).catch(() => {}); });
setTimeout(() => { if (LIVE()) api('/api/snipe').then((v) => { SNP.log = v.log || []; delete v.log; SNP.v = v; renderSnpPill(); }).catch(() => {}); }, 4000);   // 顶栏狙击状态

// 新建 / 修改跟单参数的对话框
function copyDialog(task, presetTarget) {
  const p = { maxCopies: 1, mode: 'fixed', amountBnb: 0.01, ratioPct: 10, maxPerTrade: 0.05, maxPerToken: 0.05, dailyCap: 0.2, maxOpen: 5, onlyFirst: true, minTargetBnb: 0, maxTargetBnb: 0, maxMcUsd: 0, platforms: ['flap', 'four', 'gang'], maxDelaySec: 15, slippage: 20, wallets: [1], followSell: false, dryRun: true, ...(task?.params || {}) };
  const ws = (S.walletsInfo?.length ? S.walletsInfo : [{ slot: 1, label: '钱包 1' }]);
  const num = (k, label, step = '0.01', hint = '') => `<label class="cp-f"><span>${label}</span><input type="number" step="${step}" min="0" data-cp="${k}" value="${p[k]}"/>${hint ? `<i>${hint}</i>` : ''}</label>`;
  const chk = (k, label, hint = '') => `<label class="cp-c"><input type="checkbox" data-cp="${k}" ${p[k] ? 'checked' : ''}/> ${label}${hint ? `<i>${hint}</i>` : ''}</label>`;
  const wrap = document.createElement('div'); wrap.className = 'ui-dlg-back';
  wrap.innerHTML = `<div class="ui-dlg cp-dlg" role="dialog" aria-modal="true"><div class="ui-h">${task ? '修改跟单参数' : '新建跟单'}</div><div class="ui-b">
    ${task ? `<div class="cp-tgt"><b>${esc(task.name)}</b> <span class="mono muted">${short(task.target, 6, 4)}</span></div>` : `<label class="cp-f wide"><span>跟谁</span><select data-cp="target">${TRK.targets.map((t) => `<option value="${t.address}" ${t.address === presetTarget ? 'selected' : ''}>${esc(t.name || t.domain || short(t.address, 6, 4))} · ${short(t.address, 6, 4)}</option>`).join('')}</select><i>先在追踪动态里添加目标</i></label>`}
    <div class="cp-grp"><b>金额</b>
      <label class="cp-f"><span>方式</span><select data-cp="mode"><option value="fixed" ${p.mode === 'fixed' ? 'selected' : ''}>固定金额</option><option value="ratio" ${p.mode === 'ratio' ? 'selected' : ''}>按对方买入的比例</option></select></label>
      ${num('amountBnb', '每次买入（BNB）', '0.001', '固定金额时用；每个钱包各买这么多')}${num('ratioPct', '跟对方的 %', '1', '比例方式：对方买 1 BNB、填 10 = 买 0.1')}
      ${num('maxCopies', '最多跟单几次', '1', '跟买成功这么多次后自动停止、进「历史」；0 = 不限。模拟和真实分开计数')}${num('maxPerTrade', '单笔上限（BNB）', '0.001', '最高 0.5，另外还受交易设置的单笔上限')}${num('maxPerToken', '每个币最多（BNB）')}${num('dailyCap', '每天合计最多（BNB）')}${num('maxOpen', '最多同时持有几个币', '1')}</div>
    <div class="cp-grp"><b>条件</b>${chk('onlyFirst', '只跟建仓（对方第一次买这个币）', '关掉则加仓也跟')}
      ${num('minTargetBnb', '对方买入至少（BNB）', '0.01', '0 = 不限')}${num('maxTargetBnb', '对方买入最多（BNB）', '0.01', '0 = 不限')}${num('maxMcUsd', '市值最高（美元）', '1000', '0 = 不限')}${num('maxDelaySec', '最多晚几秒', '1', '发现得比这晚就不跟')}${num('slippage', '滑点 %', '1')}
      <div class="cp-row">平台：${['flap', 'four', 'gang'].map((x) => `<label class="cp-c"><input type="checkbox" data-cpplat="${x}" ${p.platforms.includes(x) ? 'checked' : ''}/> ${x === 'flap' ? 'Flap' : x === 'four' ? 'Four' : 'Gang'}</label>`).join('')}</div>
      <div class="cp-row">用哪些钱包下单（可多选，每个钱包各买一份）：${ws.map((w) => `<label class="cp-c" title="${esc(w.label)} ${w.address || ''}"><input type="checkbox" data-cpw="${w.slot}" ${p.wallets.includes(w.slot) ? 'checked' : ''}/> ${esc(w.agentId || w.label)} <i class="${w.auth === 'ok' || !w.auth ? 'g' : 'r'}">${w.auth === 'ok' || !w.auth ? '已登录' : '未登录'}</i></label>`).join('')}</div>
      ${chk('followSell', '跟卖：对方卖出时，我们卖出同样比例（默认关）')}</div>
    <div class="cp-grp"><b>运行方式</b>${chk('dryRun', '模拟（只记录会买多少，不真的下单）', '建议先模拟一段时间再关掉')}<div class="ui-note">${task ? '' : '新建的任务是「已暂停」状态，要在列表里点「启动」才会开始。'}</div></div>
    <div class="cp-err r" id="cpErr"></div></div>
    <div class="ui-f"><button class="ui-btn" data-cpx>取消</button><button class="ui-btn ok" data-cpok>${task ? '保存' : '新建（暂停状态）'}</button></div></div>`;
  document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => { wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 150); };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cpx]')) return close();
    if (!e.target.closest('[data-cpok]')) return;
    const q = {}; wrap.querySelectorAll('[data-cp]').forEach((i) => { q[i.dataset.cp] = i.type === 'checkbox' ? i.checked : i.tagName === 'SELECT' ? i.value : Number(i.value); });
    q.platforms = [...wrap.querySelectorAll('[data-cpplat]:checked')].map((i) => i.dataset.cpplat); q.wallets = [...wrap.querySelectorAll('[data-cpw]:checked')].map((i) => Number(i.dataset.cpw));
    if (!q.wallets.length) return ($('#cpErr').textContent = '至少选一个钱包');
    if (!q.platforms.length) return ($('#cpErr').textContent = '至少选一个平台');
    const target = q.target; delete q.target;
    try { if (task) await api('/api/copy/tasks', { id: task.id, params: q }); else { if (!target) return ($('#cpErr').textContent = '先在追踪动态里添加要跟的目标'); await api('/api/copy/tasks', { target, params: q }); } close(); note(task ? '参数已保存' : '跟单任务已新建（已暂停，点「启动」开始）'); TRK.tab = 'copy'; loadTrack(); }
    catch (err) { $('#cpErr').textContent = err.message; }
  });
}
$('#track').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-trtab],[data-cptab],[data-trkdel],[data-trknew],[data-cpact],[data-trkwho],#trkAddBtn,#trkNewTask,#trkKill')?.dataset; if (!d) return;
  const el = e.target.closest('[data-trtab],[data-cptab],[data-trkdel],[data-trknew],[data-cpact],[data-trkwho],#trkAddBtn,#trkNewTask,#trkKill');
  if (d.trtab) { TRK.tab = d.trtab; return renderTrack(); }
  if (d.cptab) { TRK.cptab = d.cptab; return renderTrack(); }
  if (d.trkdel) { if (!await ui.confirm({ title: '不再追踪这个地址？', body: '它的跟单任务不会自动删除，可以在跟单里关闭。', confirmText: '不再追踪' })) return; await api('/api/track/targets', { address: d.trkdel, remove: true }).catch((err) => toast({ status: 'failed', symbol: '追踪', reason: err.message })); return loadTrack(); }
  if (d.trknew) return copyDialog(null, d.trknew);
  if (d.trkwho) { e.preventDefault(); const [who, tok] = d.trkwho.split(':'); if (S.tokens.has(tok)) { setView('trade'); select(tok); setTimeout(() => openTrader(who), 400); } else window.open(`https://gmgn.ai/bsc/address/${who}`, '_blank', 'noopener'); return; }
  if (el.id === 'trkNewTask') return TRK.targets.length ? copyDialog(null) : note('先在「追踪动态」里添加要跟的地址', 'info');
  if (el.id === 'trkKill') { try { const v = await api('/api/copy/pause-all', { paused: !TRK.paused }); TRK.paused = !!v.paused; TRK.tasks = v.tasks || TRK.tasks; renderTrkKill(); renderTrack(); note(TRK.paused ? '所有跟单已暂停' : '已恢复：运行中的任务继续'); } catch (err) { toast({ status: 'failed', symbol: '跟单', reason: err.message }); } return; }
  if (el.id === 'trkAddBtn') {
    const raw = $('#trkAddr').value.trim(), msg = $('#trkMsg'); if (!raw) return;
    msg.className = 'trk-msg'; msg.textContent = '正在解析…';
    try {
      const r = await api(`/api/track/resolve?name=${encodeURIComponent(raw)}`);
      await api('/api/track/targets', { address: r.address, domain: /\.[a-z]+$/i.test(raw) && !raw.startsWith('0x') ? raw.toLowerCase() : null, name: $('#trkName').value.trim() || (raw.startsWith('0x') ? '' : raw.toLowerCase()), remark: $('#trkName').value.trim(), group: $('#trkGroup').value.trim() || '默认' });
      msg.className = 'trk-msg g'; msg.textContent = `已添加 ${raw} → ${short(r.address, 6, 4)}`; $('#trkAddr').value = ''; $('#trkName').value = ''; loadTrack();
    } catch (err) { msg.className = 'trk-msg r'; msg.textContent = err.message; }
    return;
  }
  if (d.cpact) {
    const [act, id] = d.cpact.split(':'), t = TRK.tasks.find((x) => x.id === id); if (!t) return;
    if (act === 'edit') return copyDialog(t);
    if (act === 'start' && !(await ui.confirm({ title: `启动跟单「${t.name}」？`, body: t.params?.dryRun ? '<p>这是<b class="y">模拟</b>任务：只记录会买多少，不会下单。</p>' : `<p class="r"><b>真实下单：</b>对方买入时会用 ${(t.params.wallets || []).length} 个钱包（${(t.params.wallets || []).map((n) => esc(S.walletsInfo?.find((w) => w.slot === n)?.agentId || '钱包 ' + n)).join('、')}）自动买入：每次每个钱包最多 ${t.params.maxPerTrade} BNB，每天合计最多 ${t.params.dailyCap} BNB，${t.params.maxCopies > 0 ? `最多跟 ${t.params.maxCopies} 次（已跟 ${t.stats?.copies || 0} 次），跟满自动停止` : '<b>次数不限</b>'}。会花真实的 BNB，可能亏损。</p>`, confirmText: '启动', danger: !t.params?.dryRun }))) return;
    if (act === 'delete') { if (!(await ui.confirm({ title: `删除跟单「${t.name}」？`, body: '只删除这个任务和它的统计，跟单记录里的历史条目保留。', confirmText: '删除', danger: true }))) return; try { await api('/api/copy/tasks', { id, delete: true }); loadTrack(); } catch (err) { toast({ status: 'failed', symbol: '跟单', reason: err.message }); } return; }
    if (act === 'close' && !(await ui.confirm({ title: `关闭跟单「${t.name}」？`, body: '关闭后不再跟单（已买的币不会自动卖出），会移到「历史」。', confirmText: '关闭' }))) return;
    try { await api('/api/copy/tasks', { id, status: act === 'start' ? 'running' : act === 'pause' ? 'paused' : 'closed' }); loadTrack(); } catch (err) { toast({ status: 'failed', symbol: '跟单', reason: err.message }); }
  }
});
$('#track').addEventListener('change', (e) => {
  if (e.target.id === 'trkFGroup') { TRK.fGroup = e.target.value; renderTrack(); }
  if (e.target.id === 'trkFMin') setTrkMin(e.target.value);
  if (e.target.id === 'trkSound') setTrkSound(e.target.checked);
});
$('#trkLookBtn')?.addEventListener('click', () => { const q = $('#trkAddr').value.trim(); if (!q) return note('先在左边填 0x 地址或 .ai / .bnb 域名', 'info'); walletLookup(q); });
$('#trkAddr')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#trkAddBtn').click(); });
setInterval(() => { if (S.view === 'track' && TRK.tab === 'feed') renderTrkFeed(); }, 15_000);   // 「多久前」刷新
setTimeout(() => { if (LIVE()) api('/api/copy').then((b) => { TRK.tasks = b.tasks || []; TRK.paused = !!b.paused; renderTrkKill(); }).catch(() => {}); }, 4000);   // 顶栏跟单状态

// 交易者盈亏抽屉底部：「追踪」「跟单」两个按钮（自己的钱包不显示）
function trdActs(addr) {
  if (!LIVE() || !addr || isMe(addr)) return '';
  const on = TRK.targets.some((x) => x.address === String(addr).toLowerCase());
  return `<div class="trd-acts"><button class="trd-track ${on ? 'on' : ''}" data-trdtrack="${esc(addr)}">${on ? '✓ 已追踪（点击取消）' : '＋ 追踪'}</button><button class="trd-remark" data-trdremark="${esc(addr)}" title="编辑备注名（不追踪也能备注）">✎ ${esc(trkRemark(addr) || '备注')}</button><button class="trd-copy" data-trdcopy="${esc(addr)}">跟单</button></div>`;
}
async function trkEnsure() { if (!TRK.loaded) await loadTrack().catch(() => {}); }
document.addEventListener('click', async (e) => {
  const rb = e.target.closest('[data-trdremark]');
  if (rb) { e.preventDefault(); e.stopPropagation(); const addr = rb.dataset.trdremark; const v = await ui.prompt({ title: '备注名', label: '留空 = 显示域名 / 地址', value: trkRemark(addr) }); if (v === null) return; try { await trkSaveRemark(addr, v); $$('.trd-acts').forEach((x) => { x.outerHTML = trdActs(addr); }); note(String(v).trim() ? '备注已保存' : '已清除备注'); } catch (err) { toast({ status: 'failed', symbol: '备注', reason: err.message }); } return; }
  const tb = e.target.closest('[data-trdtrack]'), cb = e.target.closest('[data-trdcopy]'); if (!tb && !cb) return;
  e.preventDefault(); e.stopPropagation(); await trkEnsure();
  const addr = String((tb || cb).dataset.trdtrack || (tb || cb).dataset.trdcopy).toLowerCase(), dom = NAMES[addr] || null;
  const tracked = TRK.targets.some((x) => x.address === addr);
  try {
    if (tb) {
      if (tracked) { await api('/api/track/targets', { address: addr, remove: true }); note('已取消追踪'); }
      else {
        const v = await ui.prompt({ title: `追踪 ${dom || short(addr, 6, 4)}`, label: '备注名（可选，留空 = 显示域名 / 地址）', value: REMARKS[addr] || '' });
        if (v === null) return;   // 取消
        await api('/api/track/targets', { address: addr, domain: dom, name: String(v).trim() || dom || '', remark: String(v).trim() }); note(`已追踪 ${String(v).trim() || dom || short(addr, 6, 4)}`);
      }
      await loadTrack();
      $$('.trd-acts').forEach((x) => { x.outerHTML = trdActs(addr); });
      return;
    }
    if (!tracked) { await api('/api/track/targets', { address: addr, domain: dom, name: dom || '' }); await loadTrack(); }   // 跟单要先在追踪列表里
    copyDialog(null, addr);
  } catch (err) { toast({ status: 'failed', symbol: '追踪', reason: err.message }); }
}, true);

/* ---------- 左侧「钱包追踪」面板 + 底部工具栏 ---------- */
// 复用追踪页的数据（/api/track + 推送），不额外查链。开关状态和宽度记在浏览器里
const TP = { open: false, w: 340 };
let tpLocal = null; try { tpLocal = localStorage.trkPanel ?? null; TP.open = tpLocal === '1'; TP.w = Math.min(640, Math.max(260, Number(localStorage.trkPanelW) || 340)); } catch { /* ignore */ }
// 服务器上也存一份（data/ui-prefs.json）：换了地址（localhost / 127.0.0.1）或浏览器数据被清掉时，用服务器上的状态恢复
function tpSaveServer() { api('/api/ui-prefs', { trkPanel: TP.open, trkPanelW: TP.w }).catch(() => {}); }
function renderTrkPanel() {
  const panel = $('#trkPanel'), btn = $('#bbTrack'); if (!panel) return;
  panel.classList.toggle('hidden', !TP.open); btn?.classList.toggle('on', TP.open); document.documentElement.style.setProperty('--trkpW', TP.w + 'px');
  if (document.body.classList.contains('trkp-on') !== TP.open) { document.body.classList.toggle('trkp-on', TP.open); window.dispatchEvent(new Event('resize')); }   // 一栏：主内容右移让出宽度（K 线等跟着重新排版）
  $('#bbTrackN').textContent = TRK.targets.length || '';
  if (!TP.open) return;
  const rows = TRK.feed.filter(trkMinPass);
  $('#trkpCount').textContent = TRK.targets.length;
  $('#trkpList').innerHTML = !TRK.targets.length ? '<div class="trkp-empty">还没有追踪的地址。<br>可以在交易者盈亏抽屉里点「追踪」，或者到追踪页添加 .ai / .bnb 域名、0x 地址。<br><button data-tpgo>去添加</button></div>'
    : !rows.length && TRK.feed.length ? `<div class="trkp-empty">没有 ≥ $${TRK.fMin} 的成交（最小金额过滤）</div>`
    : !rows.length ? '<div class="trkp-empty">追踪的地址在 Flap / Four / Gang V2 内盘上买卖时，会实时出现在这里。</div>'
    : rows.map((e) => `<div class="trkp-e" data-a="${e.token}" title="点击进入 ${esc(e.symbol)} 详情"><div class="trkp-r1"><b class="trkp-act ${ACT_CLS[e.action] || ''}">${e.action}</b><span class="trkp-nm" data-trkname><span class="trkp-who ${trkRemark(e.target) ? 'y' : 'wn'}" data-tpwho="${e.target}:${e.token}" title="${esc(trkSub(e.target) || '')} ${e.target}（点击看它在这个币上的盈亏）">${esc(trkName(e.target))}</span><button class="trk-pen" data-trkedit="${e.target}" title="编辑备注名">✎</button><button class="trk-pen trkp-mute ${TRK.mute.has(e.target) ? 'on' : ''}" data-trkmute="${e.target}" title="${TRK.mute.has(e.target) ? '这个钱包已静音，点击恢复提示音' : '这个钱包不响提示音'}">${TRK.mute.has(e.target) ? '🔕' : '🔔'}</button></span><span class="spacer"></span><span class="trkp-amt ${e.side === 'buy' ? 'g' : 'r'}" title="${e.bnb ? bnb(e.bnb, 4) + ' BNB' : ''}${e.quote !== 'BNB' ? ' · ' + K(e.quoteAmt) + ' ' + esc(e.quote) : ''}">${trkUsd(e) ? trkUsdS(trkUsd(e)) : `${K(e.quoteAmt)}<small class="dim"> ${esc(e.quote)}</small>`}</span></div>
      <div class="trkp-r2"><span class="trkp-tok" data-a="${e.token}">${logoHtml({ address: e.token, symbol: e.symbol, image: e.image, platform: e.platform }, 'xs')}<b>${esc(e.symbol)}</b></span><span class="dim">MC ${usd(e.mcapUsd)}</span><span class="spacer"></span><span class="dim" title="${fullTime(e.ts)}">${trkAgo(e.ts)}</span></div></div>`).join('');
}
// 提示音：追踪的地址一有新成交就响，买入「上扬两声」、卖出「下沉两声」。不受顶栏总声音开关管（这里单独开关），单个钱包可静音（行上的 🔔）
// 防刷屏：两声之间至少 0.6 秒，10 秒内最多 6 声；连发时只响第一声
try { TRK.sound = localStorage.trkSound !== '0'; } catch { /* ignore */ }   // 默认开
try { TRK.mute = new Set(JSON.parse(localStorage.trkMute || '[]')); } catch { TRK.mute = new Set(); }
const trkSnd = { last: 0, hits: [] };
function trkTone(e) {
  if (!TRK.sound || TRK.mute.has(e.target) || (e.ts && Date.now() - e.ts > 60_000)) return;   // 晚到超过 1 分钟的不响
  const now = Date.now(); trkSnd.hits = trkSnd.hits.filter((t) => now - t < 10_000);
  if (now - trkSnd.last < 600 || trkSnd.hits.length >= 6) return; trkSnd.last = now; trkSnd.hits.push(now);
  trkPlay(e.side === 'buy');
}
function trkPlay(buy) {
  try {
    actx ||= new AudioContext(); if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime;
    (buy ? [[880, 0], [1320, 0.09]] : [[660, 0], [440, 0.11]]).forEach(([f, dt]) => { const o = actx.createOscillator(), g = actx.createGain(); o.type = buy ? 'sine' : 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(buy ? 0.1 : 0.04, t0 + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.14);
      o.connect(g).connect(actx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.16); });
  } catch { /* 浏览器未授权音频 */ }
}
function setTrkSound(on) { TRK.sound = on; try { localStorage.trkSound = on ? '1' : '0'; } catch { /* ignore */ } if (on) trkPlay(true); renderTrkSound(); }
function renderTrkSound() {
  const b = $('#trkpSound'); if (b) { b.textContent = TRK.sound ? '🔔' : '🔕'; b.classList.toggle('on', TRK.sound); b.title = `提示音：${TRK.sound ? '开' : '关'}（追踪的地址买入 / 卖出时响，买卖音不同；单个钱包可在行上点 🔔 静音）`; }
  const c = $('#trkSound'); if (c) c.checked = TRK.sound;
}
function trkToggleMute(addr) { if (TRK.mute.has(addr)) TRK.mute.delete(addr); else TRK.mute.add(addr); try { localStorage.trkMute = JSON.stringify([...TRK.mute]); } catch { /* ignore */ } note(TRK.mute.has(addr) ? `已静音 ${trkName(addr)}` : `已取消静音 ${trkName(addr)}`); renderTrkPanel(); }
$('#trkpSound')?.addEventListener('click', () => setTrkSound(!TRK.sound));
renderTrkSound();
function setTrkPanel(on) { TP.open = on; try { localStorage.trkPanel = on ? '1' : '0'; } catch { /* ignore */ } tpSaveServer(); if (on && !TRK.loaded) loadTrack().then(renderTrkPanel); renderTrkPanel(); }
$('#bbTrack')?.addEventListener('click', () => setTrkPanel(!TP.open));
$('#trkpClose')?.addEventListener('click', () => setTrkPanel(false));
$('#trkpMin')?.addEventListener('input', (e) => setTrkMin(e.target.value));
for (const id of ['trkFMin', 'trkpMin']) { const el = $('#' + id); if (el) el.value = TRK.fMin || ''; }
$('#trkpGo')?.addEventListener('click', () => { TRK.tab = 'feed'; setView('track'); });
$('#trkPanel')?.addEventListener('click', (e) => {
  const mu = e.target.closest('[data-trkmute]'); if (mu) { e.preventDefault(); e.stopPropagation(); return trkToggleMute(mu.dataset.trkmute); }
  if (e.target.closest('input, [data-trkedit]')) return;   // 编辑备注时点输入框不跳转
  if (e.target.closest('[data-tpgo]')) { TRK.tab = 'feed'; return setView('track'); }
  const w = e.target.closest('[data-tpwho]'); if (w) { const [who, tok] = w.dataset.tpwho.split(':'); if (S.tokens.has(tok)) { if (S.view !== 'trade') setView('trade'); select(tok); setTimeout(() => openTrader(who), 400); } else window.open(`https://gmgn.ai/bsc/address/${who}`, '_blank', 'noopener'); return; }
  const t = e.target.closest('[data-a]'); if (t) { e.preventDefault(); e.stopPropagation(); trkOpenTok(t.dataset.a); }
}, true);
// 追踪动态：点整行（除了目标名字 / ✎ / 按钮）都进代币详情；不在列表里的币去 GMGN
function trkOpenTok(a) { if (S.tokens.has(a)) { if (S.view !== 'trade') setView('trade'); select(a); } else window.open(`https://gmgn.ai/bsc/token/${a}`, '_blank', 'noopener'); }
$('#trkFeed')?.addEventListener('click', (e) => {
  if (e.target.closest('input, button, [data-trkwho], [data-trkedit]')) return;
  const r = e.target.closest('tr[data-a]'); if (!r) return; e.preventDefault(); e.stopPropagation(); trkOpenTok(r.dataset.a);
}, true);
$('#trkpDrag')?.addEventListener('mousedown', (e) => {
  e.preventDefault(); const x0 = e.clientX, w0 = TP.w;
  const mv = (ev) => { TP.w = Math.min(640, Math.max(260, w0 + ev.clientX - x0)); document.documentElement.style.setProperty('--trkpW', TP.w + 'px'); };
  const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); try { localStorage.trkPanelW = TP.w; } catch { /* ignore */ } tpSaveServer(); };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
});
// 打开 / 关闭状态一加载就恢复（以前要等 2.5 秒后、追踪数据读完才显示，刷新后看起来像「栏不见了」）；数据随后再填
renderTrkPanel();
if (tpLocal === null) api('/api/ui-prefs').then((p) => { if (p && typeof p.trkPanel === 'boolean') { TP.open = p.trkPanel; if (p.trkPanelW) TP.w = Math.min(640, Math.max(260, Number(p.trkPanelW) || 340)); try { localStorage.trkPanel = TP.open ? '1' : '0'; } catch { /* ignore */ } renderTrkPanel(); } }).catch(() => {});
loadTrack().then(renderTrkPanel).catch(() => {});
setInterval(() => { if (TP.open) renderTrkPanel(); }, 15_000);

// 追踪历史往回翻：追踪页和左侧栏滚到底时，按时间加载更早的记录（服务器从 data/track-feed.jsonl 读）
async function trkMore() {
  if (TRK.moreBusy || TRK.feedEnd || !TRK.feed.length) return; TRK.moreBusy = true;
  try {
    const last = TRK.feed[TRK.feed.length - 1], r = await api(`/api/track/feed?before=${last.ts}&limit=150`), seen = new Set(TRK.feed.map((x) => x.id));
    for (const x of r.items || []) if (!seen.has(x.id)) TRK.feed.push(x);
    if (!r.more || !(r.items || []).length) TRK.feedEnd = true;
    renderTrkPanel(); if (S.view === 'track') renderTrack();
  } catch { /* 下次滚动再试 */ }
  TRK.moreBusy = false;
}
const trkNearEnd = (el) => el && el.scrollTop + el.clientHeight > el.scrollHeight - 120;
document.addEventListener('scroll', (e) => { const t = e.target; if (!(t instanceof Element)) return; if ((t.id === 'trkpList' || t.id === 'track') && trkNearEnd(t)) trkMore(); }, true);
