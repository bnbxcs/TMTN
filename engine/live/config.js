// 实盘配置。合约地址 / 数据源来自参考版 agent-curve-terminal（Flap Agent Curve + shrine + fsi + 币安 Agentic Wallet）。
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setNodeRealSlots } from './rpc.js';
// 启动时读项目根目录的 .env（KEY=VALUE，# 开头是注释）；已经在环境变量里的不覆盖。.env 在 .gitignore 里，放私有的 RPC key 等
try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* 没有 .env 就算了 */ }
// ethers 发 HTTP 请求用的是 Node 自带的 https 模块（没传 agent = globalAgent）：默认不限并发、每个请求都新开一条 TLS 连接。改成长连接复用 +
// 每个节点同时最多 RPC_MAX_SOCKETS 条（默认 24），突发几千个请求时排队发，不再一下开上千条连接把家用路由器撑爆（2026-10-29）。放在 .env 读完之后
https.globalAgent = new https.Agent({ keepAlive: true, maxSockets: Math.max(4, Number(process.env.RPC_MAX_SOCKETS) || 24), timeout: 15_000 });
// Windows 上用记事本 / PowerShell 复制 .env 时，UTF-8 中文可能被当成 GBK 又存一遍（「币安」变「甯佸畨」）。
// 能按 GBK 编回字节、而且这些字节正好是合法 UTF-8 的，就还原；正常中文几乎不可能满足这个条件
let gbkMap = null;
export function fixMojibake(s) {
  if (typeof s !== 'string' || !/[\u4e00-\u9fff]/.test(s)) return s;
  try {
    if (!gbkMap) { gbkMap = new Map(); const dec = new TextDecoder('gbk'); for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) { const ch = dec.decode(new Uint8Array([a, b])); if (ch.length === 1 && ch !== '\ufffd' && !gbkMap.has(ch)) gbkMap.set(ch, [a, b]); } }
    const bytes = [];
    for (const ch of s) { const c = ch.codePointAt(0); if (c < 0x80) bytes.push(c); else { const g = gbkMap.get(ch); if (!g) return s; bytes.push(...g); } }
    const out = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return out !== s && /[\u4e00-\u9fff]/.test(out) ? out : s;
  } catch { return s; }
}
export const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);   // 空值当没填

export const MODE = env('MODE', 'sim').toLowerCase();               // sim | live
// 默认只报价/预演。LIVE_TRADE=1 才会通过 baw 真实下单，且只接受页面上手动点击的订单（自动买/自动卖仍只报价）。
export const LIVE_TRADE = env('LIVE_TRADE', '0') === '1';
export const DRY_RUN = !LIVE_TRADE;
// 调试用：AUTH_SIMULATE_LOGGED_OUT=1 时把登录状态当成未登录（测试登录弹窗，不会真的登出）
export const AUTH_SIMULATE_LOGGED_OUT = env('AUTH_SIMULATE_LOGGED_OUT', '0') === '1';
// 单笔真实买入上限（BNB）的初始值；页面「交易设置」里改过之后以 data/live-settings.json 为准。0 = 不限
export const MAX_TRADE_BNB = Number(env('MAX_TRADE_BNB', '0.5'));
// 数据目录：默认项目里的 data/。第二个钱包的后端用 DATA_DIR 指向自己的目录（设置、持仓、规则、授权记录、耗时记录都分开）
export const DATA_DIR = env('DATA_DIR', '') ? pathResolve(String(env('DATA_DIR', '')).replace(/^~(?=\/)/, homedir())) : fileURLToPath(new URL('../../data/', import.meta.url));
export const dataFile = (name) => pathToFileURL(pathJoin(DATA_DIR, name));
// 多钱包：本后端是第几个钱包（WALLET_SLOT），以及要一起下单的其他钱包后端（WALLET_PEERS，JSON 数组：[{ slot, label, url, bawDir }]）
export const WALLET_SLOT = Number(env('WALLET_SLOT', '1'));
export const WALLET_PEERS = (() => { try { return (JSON.parse(env('WALLET_PEERS', '[]')) || []).map((p) => (p && p.label ? { ...p, label: fixMojibake(p.label) } : p)); } catch { return []; } })();
export const BAW_DIR = env('BINANCE_BAW_DIR', '');
// 本后端只允许用这个钱包地址（可选）。baw 登录成别的账号时拒绝使用，防止拿错账号下单
export const EXPECT_WALLET = env('WALLET_ADDRESS', '').toLowerCase();   // baw 的登录信息目录（空 = 默认 ~/.baw）
// 只用公共节点跑行情订阅（第二个钱包的后端用，省 NodeReal 额度；交易链路照样用 NodeReal）
export const FEEDS_PUBLIC = env('FEEDS_PUBLIC', '0') === '1';
export const LIVE_SETTINGS_FILE = dataFile('live-settings.json');
// 私有节点 NodeReal（含 key，只放 .env）：NODEREAL_RPC 填一个完整地址，或 NODEREAL_KEYS 填多个 key（逗号分隔），多个 key 会轮流用、被限流时自动换
const NR_KEYS = env('NODEREAL_KEYS', '').split(',').map((k) => k.trim()).filter(Boolean);
export const NODEREAL_URLS = [env('NODEREAL_RPC', ''), ...NR_KEYS.map((k) => `https://bsc-mainnet.nodereal.io/v1/${k}`)].filter((u, i, a) => u && a.indexOf(u) === i);
export const NODEREAL_RPC = NODEREAL_URLS[0] || '';
export const NODEREAL_WSS = env('FEEDS_PUBLIC', '0') === '1' ? [] : NODEREAL_URLS.map((u) => u.replace(/^https:/, 'wss:').replace('/v1/', '/ws/v1/'));
setNodeRealSlots(NODEREAL_URLS);
// 读链 / 查确认 / 余额：有 NodeReal 就用它当主节点（多个 key 轮流），公共节点做备用（见 rpc.js）
export const RPC_URL = env('RPC_URL', NODEREAL_RPC || 'https://bsc-dataseed.bnbchain.org');
export const RPC_LIST = [...NODEREAL_URLS, RPC_URL, 'https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'].filter((u, i, a) => u && a.indexOf(u) === i);
// 交易专用节点：.env / 环境变量 TRADE_RPC_URL（可填多个，逗号分隔）只给下单链路用，行情读取不会用它，后台读链再多也挤不到交易。
// 再加几个公共节点兜底（和行情读取用的两个公共节点分开计限流），交易时某个节点 429 就换下一个
// TRADE_RPC_URL 不填时：RPC_URL 是自己的付费节点（不是公共节点 / NodeReal）就拿它当交易主节点
const OWN_RPC = /^https?:\/\//.test(env('RPC_URL', '')) && !/publicnode|dataseed|bnbchain|nodereal|48\.club/i.test(env('RPC_URL', '')) ? env('RPC_URL', '') : '';
export const TRADE_RPC_URLS = env('TRADE_RPC_URL', OWN_RPC).split(',').map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x));
// 日志 / 归档节点是归档节点（Chainstack Growth 及以上的 archive 节点）时在 .env 写 RPC_ARCHIVE=1：Gang V3 / stocks pad 盘的链上历史不再限制只补最近 30 万块（约 1.5 天），一次查 1 万块
export const RPC_ARCHIVE = env('RPC_ARCHIVE', '0') === '1';
export const TRADE_FALLBACK_RPC = ['https://bsc-dataseed1.bnbchain.org', 'https://bsc-dataseed2.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io', 'https://rpc-bsc.48.club'];
export const BAW_BIN = env('BAW_BIN', 'baw');
export const BINANCE_CHAIN_ID = Number(env('BINANCE_CHAIN_ID', 56));
export const BAW_SLIPPAGE_UNIT = env('BAW_SLIPPAGE_UNIT', 'percent'); // percent: 传 20 表示 20%；fraction: 传 0.2
export const WALLET_LABEL = fixMojibake(env('WALLET_LABEL', '币安 Agentic 钱包'));

export const BNB_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const EXPLORER = 'https://bscscan.com';

// Flap Agent Curve
export const READER = '0x18Aa6C93f1887a243fdc348C9A77F5136555174a';
export const PORTAL = '0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062';
export const FACTORY = '0xC55820f24015bE7c4f18949D9e1363A3609B300e';

export const QUOTE_TOKENS = {
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  BNCB: '0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f',
  NVDAB: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436',
  QQQB: '0x205812CdBed920aFf76C6580abD681a46D11efc7',
  SPCXB: '0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1',
};
export const QUOTE_BY_ADDRESS = Object.fromEntries(Object.entries(QUOTE_TOKENS).map(([k, v]) => [v.toLowerCase(), k]));

export const SHRINE_API = 'https://api.shrine.trade/bnb';
export const SHRINE_WS = 'wss://api.shrine.trade/bnb/api/launches/ws?protocols=FLAP,FOURMEME';
export const SHRINE_STREAM = 'wss://api.shrine.trade/bnb/api/stream/ws?protocols=FLAP,FOURMEME&actions=buy,sell,create';
export const FSI_BASE = 'https://fsi.taxed.fun/fsi/v1';
export const BNB_PRICE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT';

// Four 代币迁移（发射）后自动把整仓转到指定钱包
// 买入成交后在后台按固定额度（卖出 = 余额 × 1.01，报价币 ≈ 2 倍单笔上限，不是无限额）预先授权，第一次卖出不用再等授权。
// 还要页面上「预先授权」开着才会做（默认开）。设成 0 = 只在卖出 / 买入需要时才授权
export const PREAPPROVE_AFTER_BUY = env('PREAPPROVE_AFTER_BUY', '1') === '1';
// WBNB 盘卖出后：钱包 BNB ≥ 这个数就把卖得的 WBNB 留着（下次买 WBNB 盘不用先包装），不到才后台解包成 BNB；设 0 = 一直留 WBNB，很大 = 一直解包
export const KEEP_WBNB_MIN_BNB = Number(env('KEEP_WBNB_MIN_BNB', '0.2'));
