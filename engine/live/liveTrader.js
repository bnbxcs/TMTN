// 实盘执行层：读币安 Agentic Wallet（baw）的地址和余额，用链上 Portal.quoteBuy / baw 报价和预演算出能成交多少。
// 默认不提交真实交易（订单状态 dry_run）。LIVE_TRADE=1 时，页面上手动点击的订单、以及本人启动的「真实下单」跟单任务（source 形如「跟单 任务名」）和 Gang 新盘狙击（狙击 Gang）才会真实上链；自动买/自动卖始终只报价。
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { PREAPPROVE_AFTER_BUY, QUOTE_TOKENS, dataFile, EXPECT_WALLET } from './config.js';
import { setApprovalCtx, capFor, capLabel, sendApproval, listApprovals } from './approvals.js';
import { DRY_RUN, AUTH_SIMULATE_LOGGED_OUT, MAX_TRADE_BNB, LIVE_SETTINGS_FILE, BNB_NATIVE, BINANCE_CHAIN_ID, WALLET_LABEL } from './config.js';
const RULE_FILE = dataFile('tokenRules.json');
import * as baw from './baw.js';
import { ethers } from 'ethers';
const POS_FILE = dataFile('positions.json');
import { Portal } from './portal.js';
import * as openFour from './openFour.js';
import { GangTrade, GANG_PAD } from './gangTrade.js';
import { GangV2 } from './gangV2Pads.js';
import { V3_TRADE } from './gangV3.js';
import { fairBuy, fairSell } from './gangFair.js';
import { FlapNft, FLAP_PORTAL } from './flapNft.js';
import { DexDirect } from './dexDirect.js';   // 本会话实现（3 个 pad）；gangV2.js 是另一个会话的版本，这里没用
import * as latency from './latency.js';
import { setQuoteLookup, USDT, ONDO_RE, viaUsdt, markViaUsdt, assertLiquid, isQuoteToken, routeTokens, dexPrice } from './quoteRoutes.js';
import { preTrade, watchToken } from './routeGuard.js';
// 一键全部换回 BNB：价值低于这个美元数的零头跳过（不值 gas）。QUOTE_SWEEP_MIN_USD 可调
const SWEEP_MIN_USD = Number(process.env.QUOTE_SWEEP_MIN_USD || 1);
const NOT_SWEEP = new Set(['USDT', 'USDC', 'USD1', 'U', 'BUSD', 'FDUSD', 'BTCB', 'ETH', 'SOL', 'BNB']);   // 路线表里的这些不算计价币余额（BNB 那行是 WBNB，本来就在计价币里）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LiveTrader extends EventEmitter {
  constructor(market) {
    super();
    this.market = market;
    // 订单日志：每笔订单到达结果（成交 / 失败 / 未知）时追加一行到 data/orders.jsonl（含每一步，比如「收到报价币…接着换回 BNB」），
    // 同时在控制台（live.log）打一行。页面上的订单记录只在内存里，重启就没了
    this.logged = new Map();
    this.on('order', (o) => {
      if (o.dryRun || !['filled', 'failed', 'unknown'].includes(o.status)) return;   // 只记真实订单
      const key = `${o.status}|${o.reason || ''}`; if (this.logged.get(o.id) === key) return; this.logged.set(o.id, key);
      if (this.logged.size > 2000) this.logged = new Map([...this.logged].slice(-1000));
      const row = { at: new Date().toISOString(), id: o.id, wallet: o.wallet, symbol: o.symbol, token: o.token, side: o.side, amount: o.amount, source: o.source, status: o.status, route: o.route, venue: o.venue, out: o.out, tx: o.tx, txs: o.txs, reason: o.reason, steps: (o.steps || []).map((x) => x.name) };
      try { appendFileSync(dataFile('orders.jsonl'), JSON.stringify(row) + '\n'); } catch { /* 写不了就只打控制台 */ }
      console.log(`[订单] ${o.wallet || ''} ${o.side === 'buy' ? '买' : '卖'} ${o.symbol} ${o.status}${o.out != null ? ` 得 ${o.out}` : ''}${o.reason ? ' · ' + String(o.reason).slice(0, 160) : ''}`);
    });
    this.portal = new Portal(market.tradeProvider || market.provider, market.provider);   // 交易走 NodeReal 优先；领取前的模拟（定时扫描）走公共节点
    setApprovalCtx({ trader: this, market });
    setQuoteLookup((a) => this.quoteSet().has(String(a).toLowerCase()));   // 计价币兑换前的流动性检查只针对计价币（见 quoteRoutes.js）
    this.gangTrade = new GangTrade(market.tradeProvider || market.provider, (o) => this.portal.send(o));
    this.gangV2 = new GangV2(market.tradeProvider || market.provider, (o) => this.portal.send(o));
    this.flapNft = new FlapNft(market.tradeProvider || market.provider, (o) => this.portal.send(o));   // Flap Portal Agent ID 门槛盘（登记表和行情共用 market.flapNft）
    this.flapNft.reg = market.flapNft?.reg || this.flapNft.reg;
    this.dex = new DexDirect(market.tradeProvider || market.provider, (o) => this.portal.send(o), this.gangV2);   // 刚发射、币安聚合还没收录新池子时直连 PancakeSwap V2
    this.wallets = [];
    this.positions = new Map();
    this.orders = [];
    this.quoteCache = new Map();
    this.settings = { gas: 'high', execPath: 'direct', multiRpc: false, autoClaim: loadSaved().autoClaim ?? true,
      qbPresets: loadSaved().qbPresets || null,
      sellToBnb: loadSaved().sellToBnb !== false,
      preApproveCap: loadSaved().preApproveCap !== false, walletOn: loadSaved().walletOn || {} };   /* 多钱包「参与下单」开关，重启后保留 */   // 预先授权（较大固定额度，用户可在页面关闭）；关掉 = 只授权本次数量   // 卖出后自动把报价币（BNCB / GANG / 币股…）换回 BNB，默认开，可在交易设置里关   // 一键买卖面板的预设金额 / 比例（页面上编辑，存 live-settings.json）
    this.claimable = []; this.claimRetry = new Map(); this.claiming = new Set(); this.inflight = new Set(); this.tokenQ = new Map(); this.dupAt = new Map();
    this.preapproving = new Map();   // 钱包:代币 → 后台预先授权的 Promise（卖出时先等它）
    this.on('order', (o) => { try { latency.record(o, { gasLevel: this.settings.gas, rpc: this.market.provider?._getConnection?.().url || null }); } catch {} });
    this.status = { connected: false, error: null, dryRun: DRY_RUN, maxTradeBnb: loadMaxTrade(), auth: { state: 'checking', agentId: null, address: null, checkedAt: 0, message: '' }, login: null };
  }

  async init() {
    try {
      const addrs = await baw.walletAddresses();
      const bsc = addrs.find((a) => String(a.binanceChainId) === String(BINANCE_CHAIN_ID));
      if (!bsc?.address) throw new Error('baw 未返回 BSC 地址，请先运行 baw auth signin');
      if (EXPECT_WALLET && bsc.address.toLowerCase() !== EXPECT_WALLET) { this.wallets = []; this.status.auth.state = 'wrong_account'; this.status.auth.message = `baw 登录的是 ${bsc.address.slice(0, 6)}…${bsc.address.slice(-4)}，不是这个后端的钱包 ${EXPECT_WALLET.slice(0, 6)}…${EXPECT_WALLET.slice(-4)}。请用正确的币安账号重新登录`; throw new Error(this.status.auth.message); }
      this.wallets = [{ id: 'baw', label: WALLET_LABEL, color: 'linear-gradient(135deg,#f0b90b,#3fb950)', address: bsc.address, bnb: 0, agentId: true, whitelisted: true, nonce: '—' }];
      this.status.connected = true; this.status.error = null;
      await this.refreshBalance();
      clearInterval(this.balTimer); this.balTimer = setInterval(() => this.refreshBalance(), 20_000);
    } catch (e) { this.status.connected = false; this.status.error = e.message; }
    await this.checkAuth();
    clearInterval(this.authTimer); this.authTimer = setInterval(() => this.checkAuth(), 10_000);   // 每 10 秒检查一次登录状态（baw wallet status，约 0.3 秒）
    clearInterval(this.lockTimer); this.lockTimer = setInterval(() => this.lockStatus(true).catch(() => {}), 5_000);   // 钱包锁状态后台每 5 秒刷新，下单时直接用
    clearInterval(this.claimTimer); this.claimTimer = setInterval(() => this.scanClaims(), 60_000); setTimeout(() => this.scanClaims(), 20_000);
    clearInterval(this.ruleTimer); this.ruleTimer = setInterval(() => this.ruleTick().catch((e) => console.error('tokenRule:', e.message)), 2_000);
  }

  // 顶栏显示的 baw 登录状态：baw wallet status（CONNECTED 才算已登录）+ wallet agent-id（.ai 域名）
  // 登录状态：baw wallet status（CONNECTED 才算已登录）+ wallet agent-id（.ai 域名）。
  // 偶尔一次超时 / 网络错误不算掉线：连续 2 次不正常才改成未登录（页面才会挡住）；一次正常马上恢复
  async checkAuth() {
    const a = this.status.auth;
    let state, message = '';
    try {
      const st = await baw.walletStatus();
      state = st === 'CONNECTED' && !AUTH_SIMULATE_LOGGED_OUT ? 'ok' : 'logged_out'; message = state === 'ok' ? '' : `baw 状态：${AUTH_SIMULATE_LOGGED_OUT ? 'UNCONNECTED（调试模拟）' : st}`;
    } catch (e) {
      state = /找不到 baw/.test(e.message) ? 'missing' : /sign|auth|login|登录|401|unauthor/i.test(e.message) ? 'logged_out' : 'error';
      message = e.message;
    }
    if (state === 'ok') this.authFails = 0; else this.authFails = (this.authFails || 0) + 1;
    if (state === 'ok' && a.state === 'wrong_account' && !this.wallets?.length) { /* 账号不对：保持锁定，直到用正确账号登录（下面会重新初始化核对地址） */ }
    else if (state === 'ok' || this.authFails >= 2) { a.state = state; a.message = message; }
    else if (a.state === 'ok') a.message = `检查失败一次，稍后再确认：${message}`;
    if (state !== 'ok' && this.authFails === 1) setTimeout(() => this.checkAuth(), 3_000);   // 第一次失败 3 秒后马上再确认
    // 在终端重新登录后：钱包地址还没读到（启动时是未登录）就重新初始化一次，否则余额 / 持仓 / 下单都没有钱包
    if ((a.state === 'ok' || (state === 'ok' && a.state === 'wrong_account')) && !this.wallets?.length && !this.reIniting) { this.reIniting = true; this.init().catch(() => {}).finally(() => { this.reIniting = false; }); }
    if (a.state === 'ok' && !a.agentId) { try { const id = await baw.agentId(); a.agentId = id.claimed ? id.agentId : null; if (a.agentId) this.market.names?.set(this.wallets[0]?.address, a.agentId); } catch { /* 域名拿不到不影响登录状态 */ } }
    a.address = this.wallets[0]?.address || a.address;
    a.checkedAt = Date.now();
    return a;
  }

  // 页面上点「登录」：baw auth signin 拿登录链接和配对码，后台跑 auth verify 等用户在币安 App 里确认。
  // 只允许未登录时发起（已登录再发起会换掉会话）；同一时间只跑一个；5 分钟没确认就结束；可以取消。
  // 登录完成后核对地址：和这个后端锁定的钱包地址（WALLET_ADDRESS）不一致 → 马上登出这个错的会话、标记「扫错账号」。
  async startLogin() {
    const cur = this.status.login;
    if (cur?.state === 'waiting' && Date.now() < cur.expireAt) return cur;
    if (this.status.auth.state === 'ok') throw new Error('这个钱包已经登录，不需要再登录');
    if (AUTH_SIMULATE_LOGGED_OUT) { this.status.login = { state: 'failed', message: '调试模拟未登录：不会真的发起登录' }; return this.status.login; }
    if (this.status.auth.state === 'wrong_account') { try { await baw.authSignout(); } catch { /* 本来就没有会话 */ } }   // 现在登录的是错的账号：先清掉再登录
    const d = await baw.authSignin();
    if (d.status === 'ALREADY_CONNECTED') { this.status.login = null; await this.checkAuth(); return { state: 'done' }; }
    const login = { id: Date.now(), state: 'waiting', urlForWeb: d.urlForWeb, pairingCode: d.pairingCode, qrCodeId: d.qrCodeId, expireAt: Math.min(Number(d.expireAt) || Infinity, Date.now() + 300_000), message: '', expect: EXPECT_WALLET || null };
    this.status.login = login;
    clearTimeout(this.loginTimer); this.loginTimer = setTimeout(() => { if (login.state === 'waiting') { login.state = 'expired'; login.message = '5 分钟内没有在币安 App 里确认，已结束'; try { this.loginChild?.kill(); } catch { /* 已结束 */ } } }, Math.max(1000, login.expireAt - Date.now()));
    baw.authVerify(d.qrCodeId, (c) => { this.loginChild = c; })
      .then(async (r) => {
        if (login.state !== 'waiting') return;   // 已取消 / 已超时
        if (r.status !== 'SUCCESS') { login.state = 'failed'; login.message = r.status || ''; return; }
        await this.afterLogin(login);
      })
      .catch((e) => { if (login.state === 'waiting') { login.state = 'failed'; login.message = e.message; } })
      .finally(() => { this.loginChild = null; clearTimeout(this.loginTimer); });
    return login;
  }
  // 登录成功后：读地址核对。不对就登出（不保存为可用），对了才刷新状态、重新初始化
  async afterLogin(login) {
    let addr = null; try { const addrs = await baw.walletAddresses(); addr = addrs.find((a) => String(a.binanceChainId) === String(BINANCE_CHAIN_ID))?.address || null; } catch (e) { login.state = 'failed'; login.message = `读取地址失败：${e.message}`; return; }
    if (EXPECT_WALLET && (!addr || addr.toLowerCase() !== EXPECT_WALLET)) {
      try { await baw.authSignout(); } catch (e) { console.error('signout after wrong account:', e.message); }
      this.wallets = []; this.status.connected = false;
      this.status.auth.state = 'wrong_account'; this.status.auth.message = `扫错账号：登录的是 ${addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '未知地址'}，这个钱包应该是 ${EXPECT_WALLET.slice(0, 6)}…${EXPECT_WALLET.slice(-4)}，已自动登出`;
      login.state = 'wrong'; login.message = this.status.auth.message; login.address = addr; return;
    }
    login.state = 'done'; login.address = addr;
    await this.checkAuth();   // 已登录且还没有钱包时，checkAuth 会自己重新初始化一次（不再重复调用 init）
  }
  cancelLogin() {
    const cur = this.status.login; if (!cur || cur.state !== 'waiting') return cur || null;
    cur.state = 'cancelled'; cur.message = '已取消'; clearTimeout(this.loginTimer);
    try { this.loginChild?.kill(); } catch { /* 已结束 */ }
    return cur;
  }

  // 钱包锁状态缓存：下单时用后台缓存（5 秒刷新一次），超过 30 秒没刷新就当场查；自己的订单进入「等 App 确认」时立刻标成已锁
  async lockStatus(force = false) {
    const c = this.lockState;
    if (!force && c && Date.now() - c.at < 30_000) return c.v;
    const v = await baw.walletLock().catch(() => 'UNKNOWN'); this.lockState = { v, at: Date.now() }; return v;
  }

  async refreshBalance() {
    const w = this.wallets[0]; if (!w) return;
    try {
      const rows = await baw.walletBalance();
      const bnb = rows.find((r) => String(r.address || '').toLowerCase() === BNB_NATIVE.toLowerCase()) || rows.find((r) => String(r.symbol).toUpperCase() === 'BNB');
      w.bnb = Number(bnb?.balance || 0);
      w.tokens = Object.fromEntries(rows.filter((r) => r.address).map((r) => [String(r.address).toLowerCase(), Number(r.balance || 0)])); this.balAt = Date.now();
    } catch (e) { this.status.error = e.message; }
    this.syncHoldings().catch(() => {});
  }

  // 「我的」持仓以链上为准：Flap 曲线读 sharesOf，其余读 baw 钱包余额；成本记录存 data/positions.json
  async syncHoldings() {
    const w = this.wallets[0]; if (!w || this.syncing || Date.now() - (this.syncAt || 0) < 55_000) return; this.syncing = true; this.syncAt = Date.now();
    try {
      if (!this.posLoaded) { this.posLoaded = true; try { for (const [k, p] of Object.entries(JSON.parse(readFileSync(POS_FILE, 'utf8')))) if (!this.positions.has(k)) this.positions.set(k, p); } catch { /* 没有文件 */ } }
      // 持有中、行情列表里却没有的币：重启时列表先满 1000 个、持仓还没从文件读回来，它被当成老盘淘汰了，之后也不会再收录（GANGBALL 0x45f8… 2026-10-29 持仓栏少了它）。按搜索的办法上链查一次收回来
      for (const p of [...this.positions.values()]) if (p.walletId === w.id && p.amount > 0 && p.token && !this.market.get(p.token)) await this.market.lookup?.(p.token).catch(() => null);
      const toks = [...this.market.tokens.values()];
      await Promise.all(toks.map(async (t) => {
        let amt = null;
        if (t.source === 'agent-curve' && t.market && this.onCurve(t)) {
          try { amt = Number(ethers.formatEther(await this.portal.sharesOf(t.market, w.address))); } catch { return; }
        } else if (w.tokens) amt = w.tokens[t.address] || 0;
        if (amt == null) return;
        const k = `${w.id}:${t.address}`;
        // baw 余额列表还没收录刚发的币（Gang 新盘常见）时会是 0：本地记着还有持仓的，先读链上 balanceOf 再决定清零，免得刚买的被清掉
        const p0 = this.positions.get(k);
        // baw 余额滞后的另一种：刚卖完，baw 还报卖出前的数量（2026-10-28 咯咯帮：卖完 100% 后又被写回 3.11M）。和本地记录差 1% 以上就也以链上为准
        const stale = amt > 0 && p0 && Math.abs(amt - (p0.amount || 0)) > Math.max(amt, p0.amount || 0) * 0.01;
        if (stale || (!(amt > 0) && p0 && (p0.amount > 0 || (p0.boughtBnb > 0 && !p0.chainZero)))) {   // chainZero：链上确认过是 0 的（已清仓）不再重复读
          try { const e = new ethers.Contract(t.address, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], this.market.provider); const b = await e.balanceOf(w.address); amt = b > 0n ? Number(ethers.formatUnits(b, await e.decimals().catch(() => 18n))) : 0; } catch { return; }   // 读链失败就保持原样
          p0.chainZero = !(amt > 0);
        }
        if (amt > 0) { const p = this.pos(w.id, t.address); p.amount = amt; if (!p.openedAt) p.openedAt = Date.now(); }
        else if (this.positions.has(k)) this.positions.get(k).amount = 0;
      }));
      const o = {}; for (const [k, p] of this.positions) if (p.amount > 0 || p.boughtBnb) o[k] = p;
      try { mkdirSync(new URL('.', POS_FILE), { recursive: true }); writeFileSync(POS_FILE, JSON.stringify(o)); } catch { /* ignore */ }
    } finally { this.syncing = false; }
  }

  /* ---------- 单币规则：发射后立刻领取（存在 data/tokenRules.json，重启后继续） ---------- */
  rules() { if (!this._rules) { try { this._rules = JSON.parse(readFileSync(RULE_FILE, 'utf8')); } catch { this._rules = {}; } } return this._rules; }
  rulesSave() { try { mkdirSync(new URL('.', RULE_FILE), { recursive: true }); writeFileSync(RULE_FILE, JSON.stringify(this._rules, null, 1)); } catch { /* ignore */ } this.emit('rules', this.rulesView()); }
  rulesView() { return Object.fromEntries(Object.entries(this.rules()).map(([k, r]) => [k, { ...r }])); }
  setRule(token, patch) {
    const k = String(token || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(k)) throw new Error('代币地址无效');
    if (patch === null) { delete this.rules()[k]; this.rulesSave(); return this.rulesView(); }
    const t = this.market.get(k); const r = this.rules()[k] || { token: k, createdAt: Date.now(), claim: true, state: {} };
    Object.assign(r, { symbol: t?.symbol || r.symbol, market: t?.market || r.market, platform: t?.platform || r.platform }, patch);
    this.rules()[k] = r; this.rulesSave(); return this.rulesView();
  }
  // 授权管理：列出本程序授过的（代币, 合约）以及链上当前额度；撤销 = approve 0，只在本人点击时调用
  async allowancesView() {
    const w = this.wallets[0]; const out = [];
    const i = new ethers.Interface(['function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
    const call = async (to, fn, args) => i.decodeFunctionResult(fn, await this.market.provider.call({ to, data: i.encodeFunctionData(fn, args) }))[0];
    for (const [token, sp] of Object.entries(listApprovals())) for (const [spender, v] of Object.entries(sp)) {
      try {
        const [al, dec, bal] = await Promise.all([call(token, 'allowance', [w.address, spender]), call(token, 'decimals', []).catch(() => 18n), call(token, 'balanceOf', [w.address]).catch(() => 0n)]);
        out.push({ token, spender, symbol: v.symbol || this.market.get(token)?.symbol || '', kind: v.kind, at: v.at, allowance: ethers.formatUnits(al, Number(dec)), balance: ethers.formatUnits(bal, Number(dec)), active: al > 0n });
      } catch { /* 读不到就跳过 */ }
    }
    return out.sort((a, b) => b.at - a.at);
  }
  async revokeApproval(token, spender) {
    const w = this.wallets[0];
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(spender)) throw new Error('地址无效');
    if (this.status.auth.state !== 'ok') throw new Error('币安钱包未登录');
    if ((await this.lockStatus(true)) === 'LOCKED') throw new Error('钱包在等币安 App 确认，处理完再撤销');
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w.id, wallet: w.label, token, symbol: this.market.get(token)?.symbol || '授权', side: 'approve', amount: 0, source: '手动', via: 'revoke', status: 'pending', steps: [], route: `撤销授权 → ${spender.slice(0, 6)}…${spender.slice(-4)}` };
    this.orders.unshift(order); this.emit('order', order);
    const step = (name, ms) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); this.emit('order', order); };
    try { const h = await this.portal.send({ wallet: w.address, to: token, inputData: new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [spender, 0n]), label: '撤销授权', step }); Object.assign(order, { status: 'filled', tx: h, latencyMs: Date.now() - order.ts }); }
    catch (e) { if (e.code === 'APP_CONFIRM') this.lockState = { v: 'LOCKED', at: Date.now() }; Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts }); }
    this.emit('order', order); return order;
  }

  // 持仓页「兑换」：BNB ⇄ 任意代币（baw market-order），只在本人点击时执行；走和普通下单一样的检查
  async tokenInfo(addr) {
    const w = this.wallets[0]; const a = ethers.getAddress(addr);
    if (a.toLowerCase() === BNB_NATIVE.toLowerCase()) return { address: BNB_NATIVE, symbol: 'BNB', name: 'BNB', decimals: 18, balance: String(w?.bnb ?? 0) };
    const i = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
    const call = async (fn, args = []) => i.decodeFunctionResult(fn, await this.market.provider.call({ to: a, data: i.encodeFunctionData(fn, args) }))[0];
    let symbol, name, dec;
    try { [symbol, name, dec] = await Promise.all([call('symbol'), call('name').catch(() => ''), call('decimals')]); } catch { throw new Error('这个地址不是 ERC20 代币（读不到 symbol / decimals）'); }
    const bal = w ? await call('balanceOf', [w.address]).catch(() => 0n) : 0n;
    const t = this.market.get(a);
    return { address: a, symbol, name, decimals: Number(dec), balance: ethers.formatUnits(bal, Number(dec)), image: t?.image || null, priceUsd: t?.priceUsd || this.market.qUsd?.[a.toLowerCase()] || null };
  }
  async swapQuote({ from, to, amount, slippage = 1 }) {
    const q = await baw.marketQuote({ fromTokenQty: String(amount), fromToken: from, toToken: to, slippage });
    const out = Number(q?.toCoinAmount || 0);
    return { out, minOut: out * (1 - slippage / 100), fromSymbol: q?.fromCoinSymbol, toSymbol: q?.toCoinSymbol, route: 'baw market-order（币安聚合路由）', slippage };
  }
  async swapManual({ from, to, amount, pct = null, slippage = 1, clientTs = null }) {
    const w = this.wallets[0]; const fromBnb = from.toLowerCase() === BNB_NATIVE.toLowerCase();
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w?.id, wallet: w?.label || 'baw', token: fromBnb ? to : from, symbol: '?', platform: 'swap', side: fromBnb ? 'buy' : 'sell', amount: Number(amount) || pct || 0, slippage, source: '手动', via: '持仓兑换', status: 'pending', steps: [], dryRun: DRY_RUN, clientTs };
    this.orders.unshift(order); if (this.orders.length > 300) this.orders.length = 300; this.emit('order', order);
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); this.emit('order', order); };
    const key = order.token.toLowerCase();
    try {
      if (!w) throw new Error('没有钱包');
      if (DRY_RUN) throw new Error('当前是只报价模式（LIVE_TRADE=0），不会兑换');
      if (this.status.auth.state !== 'ok') throw new Error('币安钱包未登录，请先登录');
      if (this.inflight.has(key)) throw Object.assign(new Error('这个币有一笔订单还在处理中，请勿重复下单'), { code: 'BUSY' });
      if ((await this.lockStatus()) === 'LOCKED') throw new Error('钱包里有一笔交易在等你在币安 App 里确认或拒绝，处理完之前不能下新单（这次没有发出任何交易）');
      order.preMs = Date.now() - order.ts; this.inflight.add(key);
      try {
        const [fi, ti] = await Promise.all([this.tokenInfo(from), this.tokenInfo(to)]);
        order.symbol = fromBnb ? ti.symbol : fi.symbol; order.route = `${fi.symbol}→${ti.symbol}`;
        let qty;
        if (fromBnb) {
          qty = Number(amount); if (!(qty > 0)) throw new Error('金额无效');
          const cap = this.status.maxTradeBnb; if (cap > 0 && qty > cap) throw new Error(`单笔上限 ${cap} BNB（可在交易设置里修改）`);
          if (!this.balAt || Date.now() - this.balAt > 30_000) await this.refreshBalance();
          if (w.bnb && qty > w.bnb) throw new Error(`BNB 余额不足（${w.bnb.toFixed(4)}）`);
          qty = trim(qty);
        } else {
          // 卖出代币：从链上精确余额按整数算，向下取整；100% 用精确余额原样下单
          const ex = await this.exactBal(w, from);
          if (pct != null) qty = pct >= 100 ? ex.str : ethers.formatUnits((ex.raw * BigInt(Math.round(pct * 100))) / 10000n, ex.dec);
          else { const want = ethers.parseUnits(String(amount), ex.dec); qty = ethers.formatUnits(want > ex.raw ? ex.raw : want, ex.dec); }
          if (!(Number(qty) > 0)) throw new Error(`钱包里没有 ${fi.symbol}`);
        }
        step(`兑换 ${qty} ${fi.symbol} → ${ti.symbol}`, 0);
        const r = await this.swapReal({ from, to, qty, slippage, step, label: `${fi.symbol}→${ti.symbol}` });
        Object.assign(order, { status: 'filled', venue: r.venue, tx: r.txHash, txs: r.hashes, reason: r.note || null, amountIn: Number(qty), out: r.expected, latencyMs: Date.now() - order.ts });
      } finally { this.inflight.delete(key); }
      this.quoteCache.clear(); this.refreshBalance(); this.syncAt = 0; this.emit('order', order); return order;
    } catch (e) {
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) {
        if (e.code === 'APP_CONFIRM') this.lockState = { v: 'LOCKED', at: Date.now() };
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: `已提交，正在确认，请勿重复下单：${e.message}`, latencyMs: Date.now() - order.ts });
        this.emit('order', order); this.followUp(order, e); return order;
      }
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts }); this.emit('order', order); return order;
    }
  }

  ruleLog(r, msg) { r.log = [...(r.log || []), { at: Date.now(), msg }].slice(-30); console.log(`[tokenRule] ${r.symbol} ${msg}`); }
  async ruleTick() {
    if (this.ruleBusy) return; const w = this.wallets[0]; if (!w) return;
    const list = Object.values(this.rules()); if (!list.length) return;
    this.ruleBusy = true;
    try {
      for (const r of list) {
        const st = r.state ||= {}; if (st.done) continue;
        const t = this.market.get(r.token);
        // 1) 领取：Flap 曲线毕业后 Portal.claim 能模拟成功（之前会回滚）就立刻领取
        if (r.claim && !st.claimedAt && r.market && t?.source === 'agent-curve') {
          if (Date.now() < (st.claimNext || 0) || this.claiming.has(r.market)) continue;
          let amt = 0n; try { amt = await this.portal.previewClaim(r.market, w.address); } catch { /* 还没毕业：模拟会回滚 */ }
          if (amt <= 0n) {
            st.checkedAt = Date.now();
            // 已经被全局「自动领取」先领走了：毕业了、份额为 0、钱包里有代币 → 算领取完成
            if (t.stage === 'dex' && (w.tokens?.[r.token] || 0) > 0) { st.claimedAt = Date.now(); this.ruleLog(r, '已由自动领取完成'); this.rulesSave(); }
            continue;
          }
          if (DRY_RUN || this.status.auth.state !== 'ok') { st.claimNext = Date.now() + 10_000; this.ruleLog(r, DRY_RUN ? '可以领取，但当前是只报价模式' : '可以领取，但币安钱包未登录'); this.rulesSave(); continue; }
          this.ruleLog(r, `已毕业，可领取 ${(Number(amt) / 1e18).toFixed(0)}，开始领取`); this.rulesSave();
          const o = await this.claimOne(r.market, '规则：发射后立刻领取');
          if (o.status === 'filled') { st.claimedAt = Date.now(); st.claimTx = o.tx; st.claimed = o.out; this.ruleLog(r, `领取成功 ${o.tx}`); }
          else { st.claimTries = (st.claimTries || 0) + 1; st.claimNext = Date.now() + [5_000, 15_000, 60_000, 300_000][Math.min(st.claimTries, 4) - 1]; this.ruleLog(r, `领取未完成：${o.reason || o.status}`); }
          this.rulesSave(); continue;
        }
        // 2) 领取完成（或规则不需要领取）就结束这条规则
        if (!r.claim || st.claimedAt) { st.done = true; this.rulesSave(); }
      }
    } finally { this.ruleBusy = false; }
  }

  wallet(id) { const w = this.wallets.find((x) => x.id === id) || this.wallets[0]; if (!w) throw new Error(this.status.error || 'baw 钱包未连接'); return w; }
  eligibility() { return { ok: true }; }       // 白名单以合约为准：不满足时 Portal / 聚合器预演会直接失败
  capLeft() { return Infinity; }
  pos(wid, token) {
    const k = `${wid}:${token}`;
    if (!this.positions.has(k)) this.positions.set(k, { walletId: wid, token, amount: 0, costBnb: 0, boughtBnb: 0, soldBnb: 0, peak: 0, openedAt: 0 });
    return this.positions.get(k);
  }

  // four.meme Agentic Wallet 专属盘在内盘阶段只能走 OpenFour Core（baw contract-call）；迁移后走 market-order
  // gang.fun 老盘（BNB 计价，合约 0x315B…）内盘：直接 buy/sell；V2 报价币盘还不支持
  // onCurve：行情说在内盘，且下单时没在链上发现已发射（checkMigrated 设的 t.migrated；行情接口常比链上晚几十秒）
  onCurve(t) { return t.stage === 'curve' && !t.migrated; }
  useGang(t) { return t.source === 'gang' && this.onCurve(t) && !['v2', 'v3', 'v3fair'].includes(t.gangTrack); }
  // gang.fun V2 报价币盘：先把 BNB 换成报价币再买，卖出后换回 BNB（非原子）
  // V3（GangLaunchpad）曲线和 V2 同一套 buy / sell，也走这里（gangV2Pads 认 V3 内盘；真实买卖要 GANG_V3_TRADE=1）
  useGangV2(t) { return t.source === 'gang' && this.onCurve(t) && ['v2', 'v3'].includes(t.gangTrack); }
  // 打新币还在认购阶段（没开池）：买 = GangRouter.fairMintBNB 认购，卖 = pad.withdraw 按打新价退出（gangFair.js）；发射后 stage = dex，走外盘
  fairMinting(t) { return t.source === 'gang' && t.gangTrack === 'v3fair' && this.onCurve(t); }

  useOpenFour(t) { return t.source === 'four-agent' && this.onCurve(t); }
  // Flap 普通 Portal 的 Agent ID 门槛盘：内盘时直接调 Portal.swapExactInput（tx.origin 必须持有门槛 NFT；币安聚合不保证打到内盘）
  // 非 BNB 计价、Portal 又没开「原生 BNB 自动换报价币」（getTokenV8Safe 第 10 个字 = 0）的盘，BNB 进 Portal 必回滚（错误码 0x6a855977，土豆 / xOPAI 2026-10-28 核对过），
  // 改走币安聚合（它先把 BNB 换成报价币再进 Portal，钱包 2 这样成交过）
  useFlapNft(t) { return t.source === 'flap-nft' && this.onCurve(t) && t.flapNativeSwap !== false; }
  // 下单前的门槛检查：钱包没有门槛 NFT → 返回「跳过」原因（不发交易）；能交易 / 不是门槛盘 → null
  async nftBlock(t, w) { return this.useFlapNft(t) && w?.address ? this.flapNft.block(t.address, w.address).catch(() => null) : null; }

  usePortal(t, side) { return t.source === 'agent-curve' && t.market && this.onCurve(t) && (side === 'buy' || !DRY_RUN); }

  route(t, side) {
    if (this.useGang(t)) return `Gang 内盘 · ${side === 'buy' ? 'buy' : 'sell'}（BNB，一笔完成）· baw contract-call（每个钱包最多买总量 1%）`;
    if (this.fairMinting(t)) return side === 'buy' ? 'Gang 打新认购 · GangRouter.fairMintBNB（固定价，每地址有上限，多余 BNB 退回）· baw contract-call' : 'Gang 打新退出 · pad.withdraw（按打新价，扣撤出费，收 WBNB）· baw contract-call';
    if (this.useGangV2(t) && t.gangTrack !== 'v2') return `Gang V3 内盘 · ${side === 'buy' ? `BNB→${t.quote}→buy` : `sell→${t.quote}→BNB`}（和 V2 同一套，非原子）${V3_TRADE ? '' : ' · 只报价（GANG_V3_TRADE 未开启）'}`;
    if (this.useGangV2(t)) return side === 'buy' ? `Gang V2 内盘 · BNB→${t.quote}→buy（非原子，2～3 笔交易）· 每个钱包最多 1%` : `Gang V2 内盘 · sell→${t.quote}→BNB（非原子，2～3 笔交易）`;
    if (this.useFlapNft(t)) return `Flap 内盘（${t.nftGate?.plain ? '普通盘' : t.nftGate?.removed ? '门槛已取消' : `${t.nftGate?.name || 'NFT'} 门槛`}）· Portal.swapExactInput ${side === 'buy' ? 'BNB→代币' : '代币→BNB'}${t.quote && t.quote !== 'BNB' ? `（Portal 内部 BNB⇄${t.quote}）` : ''} · baw contract-call${t.nftGate?.plain ? '' : '（每个地址最多买总量 2%）'}`;
    if (this.useOpenFour(t)) return `Four Agent 专属内盘 · OpenFour Core.${side} · baw contract-call（每个钱包最多买总量 1%）`;
    if (this.usePortal(t, side) && side === 'sell') return `Flap Agent Curve · Portal.sell${t.quote === 'BNB' ? '' : ` → ${t.quote} → BNB`}`;
    if (this.usePortal(t, side)) return `Flap Agent Curve · ${t.quote === 'BNB' ? 'Portal.buy（BNB，原子）' : `BNB→${t.quote}→Portal.buyWithQuote（非原子）`}`;
    if (t.source === 'dex') return `币安 Web3 DEX 聚合 · baw market-order ${side === 'buy' ? 'BNB→代币' : '代币→BNB'}（普通外盘代币，聚合自己选池子）`;
    return `币安 Web3 DEX 聚合 · baw market-order ${side === 'buy' ? 'BNB→代币' : '代币→BNB'}${t.platform === 'four' && this.onCurve(t) ? '（可能打不到内盘）' : ''}（聚合没收录新池子时直连 PancakeSwap V2）`;
  }

  // 链上确认是否已发射（迁移）到 PancakeSwap：Gang V2 看曲线的 graduated；其他平台看 PancakeSwap V2 上有没有带储备的池子。
  // 只在内盘报价 / 下单失败后调用。确认了就记 t.migrated 并把状态改成外盘，后面的报价、下单直接走外盘
  async checkMigrated(t) {
    const yes = t.source === 'gang' && (t.gangTrack === 'v2' || t.gangTrack === 'v3') ? !!(await this.gangV2.curve(t.address)).c.graduated
      : t.source === 'flap-nft' ? (await this.flapNft.state(t.address)).status === 4 : !!(await this.dex.pool(t.address, t.quoteAddress));
    if (yes && !t.migrated) { t.migrated = true; t.stage = 'dex'; t.progress = 100; this.quoteCache.clear(); this.market.emit('migrate', this.market.summary(t)); }
    return yes;
  }

  // 外盘买卖：先走币安 DEX 聚合（baw market-order）；聚合没成交（刚迁移还没收录新池子、报不出价，或订单失败）就直连 PancakeSwap V2。
  // 已提交但结果未知（要在 App 确认 / 未确认）的不再重下
  async dexTrade({ t, w, side, qty, pct, slippage, step }) {
    try {
      return side === 'buy' ? await this.swapReal({ from: BNB_NATIVE, to: t.address, qty, slippage, step, label: `BNB→${t.symbol}` })
        : await this.swapReal({ from: t.address, to: BNB_NATIVE, qty, slippage, step, label: `${t.symbol}→BNB` });
    } catch (e) {
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code) || /insufficient|余额不足|仍在处理/i.test(e.message)) throw e;
      if (t.source === 'dex') throw e;   // 普通外盘代币：最深的池子不一定是 PancakeSwap V2（GENIUS 的 V2 池只有不到 $1），不直连
      if (!(await this.dex.pool(t.address, t.quoteAddress).catch(() => null))) throw e;
      step(`币安聚合没成交（${String(e.message).slice(0, 80)}），改为直连 PancakeSwap V2`, 0);
      return side === 'buy' ? this.dex.buy({ wallet: w.address, token: t.address, quoteAddress: t.quoteAddress, amountBnb: trim(qty), slippage, step, taxPct: t.buyTax || 0 })
        : this.dex.sell({ wallet: w.address, token: t.address, quoteAddress: t.quoteAddress, pct, slippage, step, toBnb: this.settings.sellToBnb, taxPct: t.sellTax || 0 });
    }
  }

  // 链上精确余额（字符串，按代币精度原样给出，不经过浮点数）。以前用 Number 转一次再写成 18 位小数，
  // 尾数会被舍入得比实际余额大一点点（例如 0.931044697706272163 变成 …184），卖 100% 时 baw 报「余额不足」
  async exactBal(w, token) {
    const i = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
    const call = async (fn, args) => i.decodeFunctionResult(fn, await (this.market.tradeProvider || this.market.provider).call({ to: token, data: i.encodeFunctionData(fn, args) }))[0];
    const [raw, dec] = await Promise.all([call('balanceOf', [w.address]), call('decimals', []).catch(() => 18n)]);
    return { raw, dec: Number(dec), str: ethers.formatUnits(raw, Number(dec)) };
  }

  async tokenBal(w, token) {
    const k = `bal:${w.id}:${token}`; const c = this.quoteCache.get(k);
    if (c && Date.now() - c.at < 8000) return c.v;
    const rows = await baw.walletBalance({ tokenAddress: token });
    const v = Number((rows.find((r) => String(r.address || '').toLowerCase() === token) || rows[0])?.balance || 0);
    this.quoteCache.set(k, { v, at: Date.now() }); return v;
  }

  async preview({ walletId, token, side, amount, slippage }, again = false) {
    const t = this.market.get(token); if (!t) return null;
    watchToken(t, '报价');
    const base = { route: this.route(t, side) };
    if (!(Number(amount) > 0) || !this.wallets.length) return base;
    const key = [walletId, token, side, amount, slippage].join('|'); const c = this.quoteCache.get(key);
    if (c && Date.now() - c.at < 4000) return c.v;
    try {
      const w = this.wallet(walletId);
      let v;
      if (side === 'buy' && this.usePortal(t, side) && t.quote === 'BNB') {
        const { ethers } = await import('ethers');
        const q = await this.portal.quoteBuy(t.market, w.address, ethers.parseEther(String(amount)));
        const out = +ethers.formatEther(q.shares);
        v = { ...base, amountIn: +amount, out, minOut: out * (1 - slippage / 100), feeBnb: +ethers.formatEther(q.fee), feePct: (+ethers.formatEther(q.fee) / amount) * 100 };
      } else if (side === 'buy' && t.source === 'agent-curve' && t.market && this.onCurve(t)) {
        // 非 BNB 底池：BNB→报价币用 baw 报价，再用 Portal.quoteBuy 算份额
        const { ethers } = await import('ethers');
        const sq = await baw.marketQuote({ fromTokenQty: trim(amount), fromToken: BNB_NATIVE, toToken: t.quoteAddress, slippage });
        const quoteOut = Number(sq?.toCoinAmount || 0);
        const q = await this.portal.quoteBuy(t.market, w.address, ethers.parseUnits(quoteOut.toFixed(12), 18));
        const out = +ethers.formatEther(q.shares);
        v = { ...base, amountIn: +amount, out, minOut: out * (1 - slippage / 100), quoteOut, feeQuote: +ethers.formatEther(q.fee), feePct: quoteOut ? (+ethers.formatEther(q.fee) / quoteOut) * 100 : null };
      } else if (this.useFlapNft(t)) {
        const nb = await this.nftBlock(t, w);
        if (side === 'buy') {
          const q = await this.flapNft.quoteBuy(t.address, w.address, trim(amount)); const out = +ethers.formatEther(q.out);
          const qa = await this.flapNft.quota(t.address, w.address).catch(() => null);
          v = { ...base, amountIn: +amount, out, minOut: out * (1 - slippage / 100), feeBnb: null, feePct: this.market.buyFeePct(t), note: nb || (qa?.capped && qa.remaining === 0n ? '已到每个地址 2% 上限' : null), nftBlocked: !!nb };
        } else {
          const bal = await this.flapNft.balance(t.address, w.address); const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
          if (amt <= 0n) return { ...base, note: '没有可卖出的余额' };
          const out = +ethers.formatEther(await this.flapNft.quoteSell(t.address, w.address, amt));
          v = { ...base, amountIn: +ethers.formatEther(amt), out, minOut: out * (1 - slippage / 100), feeBnb: null, feePct: null, note: nb, nftBlocked: !!nb };
        }
      } else if (this.useGangV2(t)) {
        const { ethers } = await import('ethers');
        if (side === 'buy') {
          const q = await this.gangV2.preview({ token: t.address, wallet: w.address, amountBnb: trim(amount) });
          v = { ...base, amountIn: +amount, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: +amount * 0.01, feePct: 1, note: q.refund > 0n ? '接近 1% 上限，多余的报价币会退回' : null };
        } else {
          const bal = await this.gangV2.balanceOf(t.address, w.address); const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
          if (amt <= 0n) return { ...base, note: '没有可卖出的余额' };
          const { c } = await this.gangV2.curve(t.address); this.gangV2.notGraduated(c); const r = this.gangV2.sellQuote(c, amt);
          v = { ...base, amountIn: Number(ethers.formatEther(amt)), out: Number(ethers.formatEther(r.out)), minOut: Number(ethers.formatEther(r.out)) * (1 - slippage / 100), feeBnb: null, feePct: 1, note: `卖出得到 ${t.quote}，再换回 BNB` };
        }
      } else if (this.useGang(t)) {
        if (side === 'buy') {
          const q = await this.gangTrade.quoteBuy(t.address, w.address, trim(amount));
          v = { ...base, amountIn: +amount, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: q.feeBnb, feePct: (q.feeBnb / amount) * 100,
            note: q.refund > 0n ? `接近 1% 上限，只花 ${(Number(amount) - q.refundBnb).toFixed(4)} BNB，多余的同笔退回` : q.tokensOut === 0n ? '已到 1% 上限' : null };
        } else {
          const bal = await this.gangTrade.balance(t.address, w.address);
          const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
          if (amt <= 0n) return { ...base, note: '没有可卖出的余额' };
          const q = await this.gangTrade.quoteSell(t.address, amt);
          v = { ...base, amountIn: Number(amt) / 1e18, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: q.feeBnb, feePct: null };
        }
      } else if (this.useOpenFour(t)) {
        // 官方脚本报价（含 1% 持仓上限、链上模拟）
        const bps = Math.round(slippage * 100);
        if (side === 'buy') {
          const q = await openFour.quoteBuy(t.address, w.address, trim(amount), bps);
          const out = Number(q.estimate.tokenAmount), fee = Number(q.estimate.totalFee);
          v = { ...base, amountIn: +amount, out, minOut: Number(q.minTokenOut), feeBnb: fee, feePct: (fee / amount) * 100,
            note: q.estimate.budgetNotFullyUsed ? '已到 1% 持仓上限附近，只会花掉部分 BNB，多余的同笔退回' : q.simulation?.ok === false ? `预演失败：${q.simulation.error?.reason || ''}` : null };
        } else {
          const bal = await this.tokenBal(w, token); const qty = bal * Number(amount) / 100;
          if (!(qty > 0)) return { ...base, note: '没有可卖出的余额' };
          const q = await openFour.quoteSell(t.address, w.address, Number(amount) >= 100 ? 'all' : trim(qty), bps);
          v = { ...base, amountIn: qty, out: Number(q.estimate.userReceives), minOut: Number(q.minReceive), feeBnb: Number(q.estimate.totalFee), feePct: null };
        }
      } else {
        const qty = side === 'buy' ? Number(amount) : (await this.tokenBal(w, token)) * Number(amount) / 100;
        if (!(qty > 0)) return { ...base, note: '没有可卖出的余额' };
        let q = null, err = null;
        try { q = await baw.marketQuote({ fromTokenQty: trim(qty), fromToken: side === 'buy' ? BNB_NATIVE : token, toToken: side === 'buy' ? token : BNB_NATIVE, slippage }); } catch (e) { err = e; }
        let out = Number(q?.toCoinAmount || 0), route = base.route;
        if (!(out > 0) && t.source === 'dex') { if (err) throw err; }   // 普通外盘代币不用 PancakeSwap V2 报价兜底（同 dexTrade）
        else if (!(out > 0)) {   // 币安聚合报不出价（刚迁移、还没收录新池子）：用 PancakeSwap V2 链上报价，下单时也会直连
          const sellQty = side === 'sell' ? await this.exactBal(w, t.address).then((x) => ethers.formatUnits((x.raw * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n, x.dec)).catch(() => trim(qty)) : null;
          const d = await this.dex.quote({ token: t.address, quoteAddress: t.quoteAddress, side, amount: side === 'buy' ? qty : sellQty, taxPct: (side === 'buy' ? t.buyTax : t.sellTax) || 0 }).catch(() => null);
          if (!d) { if (err) throw err; } else { out = d.out; route = `PancakeSwap V2 直连 · ${side === 'buy' ? (d.pool.isBnb ? 'BNB→代币' : 'BNB→报价币→代币') : (d.pool.isBnb ? '代币→BNB' : '代币→报价币→BNB')}（币安聚合还没收录这个池子）`; }
        }
        v = { ...base, route, amountIn: qty, out, minOut: out * (1 - slippage / 100), feeBnb: null, feePct: this.market.buyFeePct(t) };
      }
      if (side === 'buy' && !DRY_RUN) {   // BNB 不够时报价就说明会用哪个币付款
        const f = await this.fundingPlan(w, t, Number(amount)).catch(() => null); if (f) v = { ...v, fund: { mode: f.mode, symbol: f.symbol || null, qty: f.qty || null, note: f.note } }; }
      this.quoteCache.set(key, { v, at: Date.now() });
      return v;
    } catch (e) {
      // 内盘报价失败：可能刚发射到外盘、行情还没跟上。链上确认后按外盘重新报价一次
      if (!again && (e.code === 'MIGRATED' || t.stage === 'curve') && await this.checkMigrated(t).catch(() => false)) return this.preview({ walletId, token, side, amount, slippage }, true);
      return { ...base, error: e.message };
    }
  }

  async execute({ walletId, token, side, amount, slippage = 20, source = '手动', via = null, clientTs = null, symbol = null }) {
    const t = this.market.get(token);
    // 代号：本后端还没读到（钱包 2 刚收录的盘常这样）就用主后端传来的，再没有就当场读链上 symbol()，读到后更新这笔订单
    const sym = t?.symbol && t.symbol !== '?' ? t.symbol : symbol || '?';
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId, wallet: this.wallets[0]?.label || 'baw', token, symbol: sym, platform: t?.platform,
      side, amount: Number(amount), slippage, source, via, status: 'pending', steps: [], dryRun: DRY_RUN || !isRealSource(source), clientTs };
    this.orders.unshift(order); if (this.orders.length > 300) this.orders.length = 300;
    this.emit('order', order);
    if (sym === '?' && /^0x[0-9a-fA-F]{40}$/.test(String(token))) this.market.provider.call({ to: token, data: '0x95d89b41' }).then((r) => {
      const v = ethers.AbiCoder.defaultAbiCoder().decode(['string'], r)[0]; if (!v) return;
      if (order.symbol === '?') { order.symbol = v; this.emit('order', order); }
      if (t && (!t.symbol || t.symbol === '?')) t.symbol = v;
    }).catch(() => {});
    // 每一步记两个时间：ms = 这一步自己的耗时（各模块原来的口径），at = 从服务器收到订单起累计的时间（统一时间线）
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); if (x?.tx) { order.pendingTx = x.tx; order.stage = x.stage || 'broadcast'; } this.emit('order', order); };
    try {
      if (!t) throw new Error('代币不在列表中');
      const w = this.wallet(walletId);
      order.route = this.route(t, side); order.wallet = w.label;
      // Agent ID 门槛盘：这个钱包没有门槛 NFT 就跳过（狙击 / 跟单 / 一键买都一样，不算失败、不发交易）。和钱包锁检查同时查，省一次往返
      // 战壕 ⚡ 快捷买入不等任何检查：不查 NFT 门槛，钱包锁只用 30 秒内的缓存（过期就后台刷新，不等）（快捷买入要最快）
      const quick = via === 'quick' && side === 'buy';
      if (quick && !order.dryRun && !(this.lockState && Date.now() - this.lockState.at < 30_000)) this.lockStatus().catch(() => {});
      const [nb, lock] = quick ? [null, order.dryRun ? null : this.lockState && Date.now() - this.lockState.at < 30_000 ? this.lockState.v : null]
        : await Promise.all([this.nftBlock(t, w), order.dryRun ? null : this.lockStatus()]);
      if (nb) { Object.assign(order, { status: 'failed', skipped: true, reason: nb, latencyMs: Date.now() - order.ts }); this.emit('order', order); return order; }

      if (!order.dryRun) {
        // 只拦真正的重复下单（同币、同方向、同金额 / 比例，前一单还没结束且在 5 秒内）；
        // 其他同币订单（比如先卖 25% 再卖 50%）排队等前一单结束（确认或失败）再执行，避免同一钱包并发发交易，也不报错
        const tk = t.address.toLowerCase(), dupKey = `${tk}|${side}|${Number(amount)}`, prevDup = this.dupAt.get(dupKey);
        if (prevDup === 'wait') throw Object.assign(new Error('同一笔订单在等币安 App 里确认授权，确认后会自动接着卖出，不用再点'), { code: 'BUSY' });
        if (prevDup && Date.now() - prevDup < 5_000) throw Object.assign(new Error('同一笔订单（同币、同方向、同比例）刚提交过还在处理中，这次没有重复下单'), { code: 'BUSY' });
        if (lock === 'LOCKED') throw new Error('钱包里有一笔交易在等你在币安 App 里确认或拒绝，处理完之前不能下新单（这次没有发出任何交易）');
        const prev = this.tokenQ.get(tk), at = Date.now(); this.dupAt.set(dupKey, at);
        let release; const mine = new Promise((r) => { release = r; }); this.tokenQ.set(tk, mine);
        try {
          if (prev) { await prev; step('等前一笔同币订单结束', Date.now() - at); }
          while (this.inflight.has(t.address) || this.inflight.has(tk)) await new Promise((r) => setTimeout(r, 200));   // 持仓兑换 / 计价币换回在跑同一个币
          this.inflight.add(t.address); order.preMs = Date.now() - order.ts;   // 下单前检查（钱包锁、在途）耗时
          return await this.executeReal(order, t, w, step);
        } finally {
          this.inflight.delete(t.address); release();
          if (this.tokenQ.get(tk) === mine) this.tokenQ.delete(tk);
          if (this.dupAt.get(dupKey) === at) this.dupAt.delete(dupKey);
        }
      }
      if (side === 'buy') {
        const amt = Number(amount); if (!(amt > 0)) throw new Error('金额无效');
        let r;
        if (this.useFlapNft(t)) {
          r = await this.flapNft.previewBuy({ wallet: w.address, token: t.address, amountBnb: trim(amt), step });
        } else if (side === 'buy' && t.source === 'agent-curve' && t.market && this.onCurve(t)) {
          r = await this.portal.previewBuy({ wallet: w.address, market: t.market, quoteAddress: t.quoteAddress, amountBnb: trim(amt), slippage, step });
        } else {
          r = await this.swap({ w, from: BNB_NATIVE, to: t.address, qty: amt, slippage, step });
        }
        return this.finish(order, r, null, { amountIn: amt, out: r.expected });
      }
      const bal = await this.tokenBal(w, t.address);
      const qty = bal * Math.min(100, Number(amount)) / 100;
      step(`查询余额 ${trim(bal)}`, 0);
      if (!(qty > 0)) throw new Error('没有可卖出的余额');
      if (this.useFlapNft(t)) {   // 只报价：Portal.quoteExactInput（from = 钱包）
        const ex = await this.exactBal(w, t.address); const raw = (ex.raw * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
        const out = +ethers.formatEther(await this.flapNft.quoteSell(t.address, w.address, raw));
        return this.finish(order, { dryRun: true, venue: 'Flap Portal.swapExactInput（Agent ID 门槛，未上链）', expected: out }, null, { amountIn: qty, out });
      }
      const r = await this.swap({ w, from: t.address, to: BNB_NATIVE, qty, slippage, step });
      return this.finish(order, r, null, { amountIn: qty, out: r.expected });
    } catch (e) {
      // 已经提交 / 广播但结果未知：标「待确认」并继续盯，不报失败，避免重复下单
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) {
        if (e.code === 'APP_CONFIRM') this.lockState = { v: 'LOCKED', at: Date.now() };
        // 卖出前的授权要在币安 App 里确认（或已发出还没确认）：以前确认后这笔就结束了（「App 里的确认已处理」），要再点一次卖出。
        // 现在确认后查链上额度，够了就在同一笔订单里接着卖出；额度没变（App 里拒绝了）就不卖
        const ap = side === 'sell' && t && !e.afterConfirm ? e.approval : null;
        if (ap) { e.afterLabel = '授权确认后接着卖出…'; e.afterConfirm = () => this.sellAfterApproval(order, e, t, walletId, step); }
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: ap ? `卖出要先授权，请在币安 App 里确认授权，确认后会自动接着卖出（不用再点）：${e.message}` : `已提交，正在确认，请勿重复下单：${e.message}`, latencyMs: Date.now() - order.ts });
        this.emit('order', order);
        const fu = this.followUp(order, e);
        if (ap) { const dk = `${t.address.toLowerCase()}|${side}|${Number(amount)}`; this.dupAt.set(dk, 'wait'); fu.finally(() => { if (this.dupAt.get(dk) === 'wait') this.dupAt.delete(dk); }); }
        return order;
      }
      // 卖出时这个钱包没有这个币：灰色「无余额」提示，不算失败（多钱包一起卖时常见：另一个钱包没买到）
      if (side === 'sell' && /没有可卖出的余额|（实际 0 个）/.test(e.message)) {
        Object.assign(order, { status: 'failed', skipped: true, noBalance: true, reason: '无余额：这个钱包链上没有这个币（可能之前已经卖完），已跳过（没有发出交易）', latencyMs: Date.now() - order.ts });
        const p0 = t && this.positions.get(`${(this.wallets.find((x) => x.id === walletId) || this.wallets[0])?.id}:${t.address}`); if (p0 && p0.amount > 0) { p0.amount = 0; p0.chainZero = true; }   // 卖出路径刚读过链上余额是 0：持仓行马上清掉，不等 baw 余额更新
      }
      else Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
      this.emit('order', order);
      return order;
    }
  }

  // 计价币余额：钱包里作为别的盘报价币的 BNCB / GANG / NVDAB / WBNB 等（Flap、Gang V2 买卖中间换出来的），按 baw 实时余额列出
  quoteSet() { return new Set([...Object.values(QUOTE_TOKENS), ...Object.keys(this.market.qUsd || {})].map((a) => a.toLowerCase())); }
  // 计价币余额框 / 一键换回 BNB 用的范围：上面的计价币 + 路线表里记过的币（重启后行情还没见过的报价币也在），但不含稳定币和 BTC / ETH / SOL（那些不是中间换出来的，不能被一键换掉）
  sweepSet() { const s = this.quoteSet(); for (const r of routeTokens()) if (!NOT_SWEEP.has(String(r.symbol || '').toUpperCase())) s.add(r.token); return s; }
  // 链上余额（公共 RPC 并发读 balanceOf，15 秒缓存）：baw 的余额列表时有时无（钱包 1 的 FXIon 会突然不在列表里），以链上为准
  async chainQuoteBals(addr, tokens) {
    const k = `qbal:${addr}`, c = this.quoteCache.get(k); if (c && Date.now() - c.at < 15_000) return c.v;
    const I = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']), prov = this.market.provider || this.market.tradeProvider;
    const call = async (to, fn, args = []) => I.decodeFunctionResult(fn, await prov.call({ to, data: I.encodeFunctionData(fn, args) }))[0];
    const meta = (this.tokMeta ||= new Map()), v = new Map();
    await Promise.all([...tokens].map(async (t) => {
      try {
        const raw = await call(t, 'balanceOf', [addr]);
        if (!meta.has(t)) meta.set(t, { dec: Number(await call(t, 'decimals').catch(() => 18n)), symbol: await call(t, 'symbol').catch(() => null) });
        v.set(t, { raw, ...meta.get(t), str: ethers.formatUnits(raw, meta.get(t).dec) });
      } catch { /* 读不到的币就按 baw 的 */ }
    }));
    this.quoteCache.set(k, { at: Date.now(), v }); return v;
  }
  async quoteBalances() {
    const w = this.wallets[0] || (EXPECT_WALLET ? { address: EXPECT_WALLET } : null), set = this.sweepSet(), bnbUsd = this.market.bnbUsd || 0, lc = (a) => String(a || '').toLowerCase();   // 未登录时用配置里的钱包地址读链上余额（读余额不需要登录）
    const [rows, chain] = await Promise.all([baw.walletBalance().catch((e) => { if (!w?.address) throw e; return []; }), w?.address ? this.chainQuoteBals(w.address, set).catch(() => new Map()) : new Map()]);
    const by = new Map(rows.filter((r) => r.address && set.has(lc(r.address))).map((r) => [lc(r.address), r]));
    const route = new Map(routeTokens().map((r) => [r.token, r.symbol]));
    for (const [t, c] of chain) {   // 链上有读数的以链上为准；价格用 baw 的，没有就用行情里的报价币价格
      if (!(c.raw > 0n)) { by.delete(t); continue; }
      const r = by.get(t), price = Number(r?.price || 0) || this.market.qUsd?.[t] || this.qPrice?.get(t) || await dexPrice(t) || 0;
      if (price) (this.qPrice ||= new Map()).set(t, price);   // 记住最近的价格：baw 下次漏掉这个币时还能算价值
      by.set(t, { address: r?.address || ethers.getAddress(t), symbol: r?.symbol || c.symbol || route.get(t) || '?', balance: c.str, price, value: Number(c.str) * price });
    }
    return [...by.values()].filter((r) => Number(r.balance) > 0).map((r) => {
      const usd = Number(r.value || 0) || Number(r.balance) * (this.market.qUsd?.[lc(r.address)] || 0);
      return { token: r.address, symbol: r.symbol, balance: r.balance, priceUsd: Number(r.price || 0) || null, valueUsd: usd, valueBnb: bnbUsd ? usd / bnbUsd : null, wbnb: lc(r.address) === QUOTE_TOKENS.WBNB.toLowerCase() };
    }).sort((a, b) => b.valueUsd - a.valueUsd);
  }

  // BNB 不够时用钱包里的计价币付款。只做规划，不发交易：
  // 这个盘的报价币本身就够（Gang V2 / Flap 报价币盘）→ 直接用它买，省掉 BNB→报价币那一步；
  // 否则挑价值最高、够用的计价币（BNCB / GANG / USDT / FXIon …）先换出差额 BNB 再按原来的路线买
  async fundingPlan(w, t, amt) {
    if (!(amt > 0)) return null;
    const bnb = w.bnb || 0;
    // 计价币盘（Gang V2 / Flap 非 BNB 盘）：先看钱包里有没有这个盘的报价币（BNCB 盘优先用钱包里的 BNCB，不够再用 BNB 换）。
    // 实际怎么付由 gangV2Pads.buy / portal.buy 决定（够就直接用，不够只换差额），这里只算出来给报价和确认框显示
    const qa = t.quoteAddress && (this.useGangV2(t) || (this.usePortal(t, 'buy') && String(t.quoteAddress).toLowerCase() !== QUOTE_TOKENS.WBNB.toLowerCase())) ? t.quoteAddress : null;
    if (qa) {
      const [raw, rate, dec] = await Promise.all([this.gangV2.balanceOf(qa, w.address), this.gangV2.quoteRate(qa, { stale: 30_000 }), this.gangV2.decimals(qa)]).catch(() => [0n, 0, 18]);
      const n = Number(ethers.formatUnits(raw, dec)), sym = t.quote || '报价币';
      if (n > 0 && rate > 0) {
        const vb = n / rate;
        if (vb >= amt) return { mode: 'direct', token: qa, symbol: sym, qty: amt * rate, bnb, note: `直接用钱包里现有的约 ${fmtQ(amt * rate)} ${sym} 付款（共有 ${fmtQ(n)}），不用 BNB 换` };
        if (bnb >= (amt - vb) * 1.05 + FUND_GAS) return { mode: 'mixed', token: qa, symbol: sym, qty: n, bnb, note: `先用钱包里现有的 ${fmtQ(n)} ${sym}（约 ${vb.toFixed(4)} BNB），差额约 ${(amt - vb).toFixed(4)} BNB 换成 ${sym}` };
      }
    }
    if (bnb >= amt + FUND_GAS) return null;
    const bnbUsd = this.market.bnbUsd || 0; if (!bnbUsd) return null;
    const set = this.quoteSet(); set.add(USDT.toLowerCase());
    const held = (await baw.walletBalance()).filter((r) => r.address && set.has(String(r.address).toLowerCase()) && Number(r.balance) > 0).map((r) => {
      const k = String(r.address).toLowerCase(), usd = Number(r.value || 0) || Number(r.balance) * (this.market.qUsd?.[k] || 0);
      return { token: r.address, symbol: r.symbol, balance: Number(r.balance), valueBnb: usd / bnbUsd, wbnb: k === QUOTE_TOKENS.WBNB.toLowerCase() };
    }).filter((x) => x.valueBnb > 0);
    const q = (this.useGangV2(t) || this.usePortal(t, 'buy')) && t.quoteAddress ? String(t.quoteAddress).toLowerCase() : null;
    const own = q && held.find((x) => x.token.toLowerCase() === q);
    if (own && !own.wbnb && own.valueBnb >= amt * 1.02) return { mode: 'direct', token: own.token, symbol: own.symbol, qty: own.balance * amt / own.valueBnb, bnb: w.bnb || 0, note: `BNB 不够（${(w.bnb || 0).toFixed(4)}），直接用钱包里约 ${fmtQ(own.balance * amt / own.valueBnb)} ${own.symbol} 付款` };
    const need = (amt + FUND_GAS - (w.bnb || 0)) * 1.05;   // 多换 5%：兑换滑点 + 手续费
    const pick = held.filter((x) => !x.wbnb && x.valueBnb >= need).sort((a, b) => b.valueBnb - a.valueBnb)[0];
    if (!pick) return { mode: 'none', bnb: w.bnb || 0, note: `BNB 余额不足（${(w.bnb || 0).toFixed(4)}），钱包里也没有够换 ${need.toFixed(4)} BNB 的计价币` };
    const qty = Math.floor(pick.balance * need / pick.valueBnb * 1e8) / 1e8;
    return { mode: 'swap', token: pick.token, symbol: pick.symbol, qty, needBnb: need, bnb: w.bnb || 0, note: `BNB 不够（${(w.bnb || 0).toFixed(4)}），先用约 ${fmtQ(qty)} ${pick.symbol} 换出 ${need.toFixed(4)} BNB 再买（多 1～2 笔交易）` };
  }

  async quoteBal(token) {   // 余额以链上为准（baw 列表会漏币）；名字用 baw 的，没有就用链上 symbol()
    const w = this.wallets[0], [r, ex] = await Promise.all([baw.walletBalance({ tokenAddress: token }).then((l) => l.find((x) => String(x.address || '').toLowerCase() === token.toLowerCase())).catch(() => null), w?.address ? this.exactBal(w, token).catch(() => null) : null]);
    const sym = r?.symbol || this.tokMeta?.get(token.toLowerCase())?.symbol || routeTokens().find((x) => x.token === token.toLowerCase())?.symbol || '?';
    return { balance: ex ? Number(ex.str) : Number(r?.balance || 0), symbol: sym };
  }

  // 换回 BNB 前的报价（按此刻余额）：WBNB 解包 1:1；其他走 baw market-order quote
  async quoteToBnbPreview(token, slippage = 1) {
    if (!this.sweepSet().has(String(token).toLowerCase())) throw new Error('不是计价币');
    const { balance, symbol } = await this.quoteBal(token); if (!(balance > 0)) throw new Error(`钱包里没有 ${symbol}`);
    if (token.toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase()) return { token, symbol, balance, out: balance, minOut: balance, route: 'WBNB.withdraw 解包（1:1，只付 gas）', slippage: 0 };
    const two = async () => {   // Ondo 类：报价两步，代币→USDT→BNB
      const a = await baw.marketQuote({ fromTokenQty: trim(balance), fromToken: token, toToken: USDT, slippage });
      return baw.marketQuote({ fromTokenQty: trim(Number(a?.toCoinAmount || 0)), fromToken: USDT, toToken: BNB_NATIVE, slippage });
    };
    let q, via = viaUsdt(token);
    if (via) q = await two();
    else try { q = await baw.marketQuote({ fromTokenQty: trim(balance), fromToken: token, toToken: BNB_NATIVE, slippage }); }
    catch (e) { if (!ONDO_RE.test(e.message)) throw e; markViaUsdt(token); via = true; q = await two(); }
    const out = Number(q?.toCoinAmount || 0); const mid = (this.market.qUsd?.[token.toLowerCase()] || 0) * balance / (this.market.bnbUsd || 1);
    return { token, symbol, balance, out, minOut: out * (1 - slippage / 100), route: via ? `baw market-order：${symbol}→USDT→BNB（Ondo 类只能和稳定币直接换，两笔）` : 'baw market-order（币安聚合路由）', slippage, midBnb: mid || null };
  }

  // 一键把某个计价币全部换回 BNB：点击这一刻读余额；登录、钱包锁、同币在途检查和普通订单一样；已提交但结果未知按「待确认」跟踪
  async quoteToBnb({ token, slippage = 1 }) {
    const w = this.wallets[0];
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w?.id, wallet: w?.label || 'baw', token, symbol: '?', platform: 'quote',
      side: 'sell', amount: 100, slippage, source: '手动', via: '计价币换回 BNB', status: 'pending', steps: [], dryRun: false };
    this.orders.unshift(order); if (this.orders.length > 300) this.orders.length = 300;
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms) }); if (x?.tx) { order.pendingTx = x.tx; order.stage = x.stage || 'broadcast'; } this.emit('order', order); };
    try {
      if (!w) throw new Error('没有钱包');
      if (!this.sweepSet().has(String(token).toLowerCase())) throw new Error('不是计价币');
      if (DRY_RUN) throw new Error('当前是 DRY_RUN 模式，不会发出交易');
      if (this.status.auth.state !== 'ok') throw new Error('币安钱包未登录，请先登录');
      if (this.inflight.has(token)) throw Object.assign(new Error('这个币有一笔订单还在处理中，请勿重复下单'), { code: 'BUSY' });
      if ((await baw.walletLock().catch(() => 'UNKNOWN')) === 'LOCKED') throw new Error('钱包里有一笔交易在等你在币安 App 里确认或拒绝，处理完之前不能下新单（这次没有发出任何交易）');
      this.inflight.add(token);
      try {
        const { symbol } = await this.quoteBal(token); const ex = await this.exactBal(w, token); const balance = Number(ex.str); order.symbol = symbol; order.route = `${symbol}→BNB`;
        if (!(balance > 0)) throw new Error(`钱包里没有 ${symbol}`);
        step(`当前余额 ${ex.str} ${symbol}（链上精确值）`, 0);
        let r;
        if (token.toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase()) {
          const bal = await (this.market.tradeProvider || this.market.provider).call({ to: token, data: new ethers.Interface(['function balanceOf(address) view returns (uint256)']).encodeFunctionData('balanceOf', [w.address]) }).then((x) => BigInt(x));
          const hash = await this.portal.send({ wallet: w.address, to: token, inputData: new ethers.Interface(['function withdraw(uint256)']).encodeFunctionData('withdraw', [bal]), label: 'WBNB→BNB 解包', step });
          r = { venue: 'WBNB.withdraw', expected: Number(ethers.formatEther(bal)), txHash: hash, hashes: [hash] };
        } else r = await this.swapReal({ from: token, to: BNB_NATIVE, qty: ex.str, slippage, step, label: `${symbol}→BNB` });
        Object.assign(order, { status: 'filled', venue: r.venue, tx: r.txHash, txs: r.hashes, reason: r.note || null, amountIn: balance, out: r.expected, latencyMs: Date.now() - order.ts });
      } finally { this.inflight.delete(token); }
      this.quoteCache.clear(); this.refreshBalance(); this.syncAt = 0;
      this.emit('order', order);
      return order;
    } catch (e) {
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) {
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: `已提交，正在确认，请勿重复下单：${e.message}`, latencyMs: Date.now() - order.ts });
        this.emit('order', order); this.followUp(order, e); return order;
      }
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
      this.emit('order', order); return order;
    }
  }

  // 一键全部换回 BNB 的计划（只报价，不发交易）：本钱包每个计价币按此刻余额报价；零头、流动性不够、没有路线的列进 skipped 并写原因
  async quoteSweepPlan(slippage = 1) {
    const bnbUsd = this.market.bnbUsd || 0, items = [], skipped = [];
    for (const r of await this.quoteBalances()) {
      const base = { token: r.token, symbol: r.symbol, balance: r.balance, valueUsd: r.valueUsd, wbnb: r.wbnb };
      if (r.valueUsd > 0 && r.valueUsd < SWEEP_MIN_USD) {   // 没有价格（valueUsd 0）的不在这里跳过，下面按报价再判断
        skipped.push({ ...base, reason: `价值不到 $${SWEEP_MIN_USD}（不值 gas）` }); continue; }
      try {
        if (!r.wbnb && isQuoteToken(r.token)) await assertLiquid(r.token, r.symbol);
        const p = await this.quoteToBnbPreview(r.token, slippage);
        if (!(p.out > 0)) { skipped.push({ ...base, reason: '报价为 0（没有可用路线）' }); continue; }
        if (bnbUsd && p.out * bnbUsd < SWEEP_MIN_USD) { skipped.push({ ...base, reason: `报价只有 ${p.out.toFixed(6)} BNB（不到 $${SWEEP_MIN_USD}，不值 gas）` }); continue; }
        items.push({ ...base, balance: p.balance, out: p.out, minOut: p.minOut, route: p.route, slippage: p.slippage });
      } catch (e) { skipped.push({ ...base, reason: e.message }); }
    }
    return { items, skipped, minUsd: SWEEP_MIN_USD, auth: this.status.auth.state };
  }
  // 按计划逐个执行（同一个钱包按顺序：baw 每个钱包一次只处理一笔，钱包锁 / 在 App 里待确认时后面的会冲突）。每个币仍走 quoteToBnb（点击时读余额、同币在途检查）
  async quoteSweep({ tokens = [], slippage = 1 }) {
    const set = this.sweepSet(), out = [];
    for (const token of [...new Set(tokens.map(String))].filter((t) => set.has(t.toLowerCase()))) {
      const prev = out.at(-1);
      if (prev?.status === 'pending') { out.push({ token, symbol: '?', side: 'sell', status: 'failed', reason: '上一笔还在等确认（可能要在币安 App 里确认），这个币没有执行，请稍后再点' }); continue; }
      out.push(await this.quoteToBnb({ token, slippage }));
    }
    return out;
  }

  // 授权确认后接着卖出（同一笔订单）：先等链上额度够（最多约 30 秒），再按当时余额 / 比例重新走一遍卖出
  async sellAfterApproval(order, e, t, walletId, step) {
    const a = e.approval, prov = this.market.tradeProvider || this.market.provider;
    const I = new ethers.Interface(['function allowance(address,address) view returns (uint256)']);
    let ok = false;
    for (let i = 0; i < 15 && !ok; i++) {
      try { ok = BigInt(await prov.call({ to: a.token, data: I.encodeFunctionData('allowance', [a.wallet, a.spender]) })) >= a.amount; } catch { /* 下一次 */ }
      if (!ok) await sleep(2000);
    }
    if (!ok) return { done: true, status: 'failed', reason: '授权没有生效（可能在币安 App 里拒绝了），没有卖出' };
    step('授权已生效，接着卖出', 0);
    Object.assign(order, { status: 'pending', stage: null, reason: '授权已确认，正在卖出…' }); this.emit('order', order);
    try { await this.executeReal(order, t, this.wallet(walletId), step); return { handedOff: true }; }
    catch (x) {
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(x.code)) {   // 卖出那笔也要在 App 里确认：照常继续跟踪
        if (x.code === 'APP_CONFIRM') this.lockState = { v: 'LOCKED', at: Date.now() };
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: `已提交，正在确认，请勿重复下单：${x.message}`, latencyMs: Date.now() - order.ts }); this.emit('order', order);
        this.followUp(order, x); return { handedOff: true };
      }
      return { done: true, status: 'failed', reason: `授权已确认，但卖出失败：${x.message}` };
    }
  }

  // 待确认订单的后续：有 txHash 就等回执（最多 10 分钟）；在等 App 确认的，等钱包解锁后再看结果
  async followUp(order, e) {
    order.steps?.push({ name: e.code === 'APP_CONFIRM' ? '转入后台等待：币安 App 确认' : e.tx ? '转入后台等待：上链确认' : '转入后台等待：结果未知', ms: 0, at: Date.now() - order.ts });   // 只记时间点（「下单耗时」页面用来区分 App 确认等待）
    const end = Date.now() + 10 * 60_000;
    const fin = (status, reason, tx) => { Object.assign(order, { status, reason, tx: tx || order.tx, stage: null, doneMs: Date.now() - order.ts });   /* doneMs：后台等待完成的时刻（下单耗时页用） */ this.quoteCache.clear(); this.refreshBalance(); this.syncAt = 0; this.emit('order', order); };
    // 卖出那笔确认后，接着把到账的报价币换回 BNB（e.afterConfirm 由 Gang V2 / Portal 卖出挂上）
    const done = async (status, reason, tx) => {
      if (!e.afterConfirm || status === 'failed') return fin(status, reason, tx);
      Object.assign(order, { reason: `${reason}；${e.afterLabel || '正在把报价币换回 BNB…'}` }); this.emit('order', order);
      const log = (name, ms = 0) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); this.emit('order', order); };
      try {
        const r = await e.afterConfirm(log);
        if (r?.handedOff) return;   // 授权后接着卖出：那一笔自己会更新订单
        if (r?.done) return fin(r.status, r.reason, tx);
        if (r.hashes?.length) order.txs = [...(order.txs || []), ...r.hashes];
        if (r.expected) { order.out = r.expected; return fin('filled', `已卖出并换回 ${trim(r.expected)} BNB${r.note ? '；' + r.note : ''}`, tx); }
        return fin(status, `${reason}；${r.note || '没有换回 BNB'}`, tx);
      } catch (x) { return fin(status, `${reason}；换回 BNB 失败：${x.message}，报价币留在钱包（可在持仓页「计价币余额」里一键换回）`, tx); }
    };
    // 只认这一步自己的 txHash：order.pendingTx 可能是前面授权那笔（已上链），拿它判断会把还在等 App 确认的卖出误标成「已成交」
    if (e.tx) {
      const tx = e.tx;
      while (Date.now() < end) { const rc = await (this.market.tradeProvider || this.market.provider).getTransactionReceipt(tx).catch(() => null); if (rc) return done(rc.status === 1 ? 'filled' : 'failed', rc.status === 1 ? '已上链确认' : `链上执行失败：${tx}`, tx); await sleep(3000); }
      return done('unknown', `10 分钟内没等到确认，请在钱包记录里查看：${tx}`, tx);
    }
    while (Date.now() < end) { if ((await baw.walletLock().catch(() => 'UNKNOWN')) !== 'LOCKED') break; await sleep(10_000); }
    return done('unknown', e.code === 'APP_CONFIRM' ? '币安 App 里的确认已处理（同意或拒绝），结果请看持仓 / 钱包记录' : '结果未知，请在持仓 / 钱包记录里查看，不要直接重下');
  }

  // 真实下单（只由手动订单进入）。曲线阶段的 Flap Agent 盘走 Portal；其余走 baw market-order。
  // 内盘下单失败时看看是不是刚发射到外盘（行情还没跟上）：链上确认后改走外盘重下一次。
  // 只在内盘那条路没有发出过买卖交易时重下（授权不算）；已提交 / 结果未知的不重下
  async executeReal(order, t, w, step) {
    const curve = this.onCurve(t), n0 = order.steps.length;
    try { return await this.executeRoute(order, t, w, step); }
    catch (e) {
      if (!curve || ['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) throw e;
      if (e.code !== 'MIGRATED' && order.steps.slice(n0).some((s) => /已提交|已广播|已上链/.test(s.name) && !/授权/.test(s.name))) throw e;
      if (!(await this.checkMigrated(t).catch(() => false))) throw e;
      step(`这个盘已发射到 PancakeSwap（内盘：${String(e.message).slice(0, 60)}），改走外盘`, 0);
      order.route = this.route(t, order.side);
      return this.executeRoute(order, t, w, step);
    }
  }

  async executeRoute(order, t, w, step) {
    const { side, slippage } = order;
    preTrade(t, side);   // 路由自检：盘型和链上来源对不上（会发到错误的合约）就拦下，不发交易
    const p = this.pos(w.id, t.address);
    let r;
    if (side === 'buy') {
      const amt = order.amount;
      if (!(amt > 0)) throw new Error('金额无效');
      if (this.status.auth.state !== 'ok') throw new Error('币安钱包未登录，请在终端运行 baw auth signin');
      const cap = this.status.maxTradeBnb;
      if (cap > 0 && amt > cap) throw new Error(`单笔上限 ${cap} BNB（可在交易设置里修改）`);
      // BNB 余额用后台每 20 秒刷新的缓存；超过 30 秒没刷新才当场查
      if (!this.balAt || Date.now() - this.balAt > 30_000) { if (order.via === 'quick' && this.balAt) this.refreshBalance(); else { const t0 = Date.now(); await this.refreshBalance(); step('检查 BNB 余额（baw）', Date.now() - t0); } }   // 快捷买入：有过余额就不等刷新
      let payQuote = null;
      // Gang V2 的 WBNB 盘：钱包里已有够用的 WBNB 就直接用（只发 buy 一笔，狙击要快），BNB 只要够 gas
      const wbnbReady = this.useGangV2(t) && String(t.quoteAddress || '').toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase() && (w.tokens?.[QUOTE_TOKENS.WBNB.toLowerCase()] || 0) >= amt && (w.bnb || 0) >= 0.0005;
      if (!wbnbReady && (w.bnb || 0) < amt + FUND_GAS) {
        const f = await this.fundingPlan(w, t, amt);
        if (!f || f.mode === 'none') throw new Error(f?.note || `BNB 余额不足（${(w.bnb || 0).toFixed(4)}）`);
        if ((w.bnb || 0) < 0.0005) throw new Error(`BNB 只剩 ${(w.bnb || 0).toFixed(5)}，不够付 gas，没法用 ${f.symbol} 付款`);
        order.fund = { mode: f.mode, symbol: f.symbol, token: f.token, qty: f.qty }; step(f.note, 0);
        if (f.mode === 'direct') payQuote = f.qty;
        else if (f.mode === 'mixed') { /* 买入时先用钱包里的报价币，差额用 BNB 换（gangV2Pads.buy / portal.buy 里做） */ }
        else {
          await this.swapReal({ from: f.token, to: BNB_NATIVE, qty: trim(f.qty), slippage: 2, step, label: `${f.symbol}→BNB（补足买入 BNB）` });
          await this.refreshBalance();
          if ((w.bnb || 0) < amt) throw new Error(`已用 ${f.symbol} 换出 BNB，但余额 ${(w.bnb || 0).toFixed(4)} 仍不够 ${amt}，没有买入（换出的 BNB 留在钱包）`);
        }
      }
      r = this.fairMinting(t) ? await fairBuy({ provider: this.market.provider, contractCall: baw.contractCall, wallet: w.address, token: t.address, amountBnb: trim(amt), step }).catch((e) => { if (/开盘/.test(e.message)) { t._fairAt = 0; this.market.gangFairState?.(t).catch(() => {}); } throw e; })   // 刚打满开盘、行情还没切：马上刷新，下一次就走外盘
        : this.useGangV2(t) ? await this.gangV2.buy({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step, payQuote })
        : this.useGang(t) ? await this.gangTrade.buy({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step })
        : this.useOpenFour(t) ? await this.openFourBuy({ w, t, amt, slippage, step })
        : this.useFlapNft(t) ? await this.flapNft.buy({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step, fast: order.via === 'quick', bnbQuote: !t.quoteAddress })   /* 成本按实际花的 BNB（多给的会退回）：BNB 盘读 Portal 事件，报价币盘按余额差 */
        : this.usePortal(t, 'buy')
        ? await this.portal.buy({ wallet: w.address, market: t.market, quoteAddress: t.quoteAddress, quoteSym: t.quote, amountBnb: trim(amt), slippage, step, payQuote, quoteRate: t.quoteAddress ? await this.gangV2.quoteRate(t.quoteAddress, { stale: 30_000 }).catch(() => null) : null })
        : await this.dexTrade({ t, w, side: 'buy', qty: amt, slippage, step });
      if (!p.openedAt) p.openedAt = Date.now();
      const spent = r.spent ?? amt;   // 打新认购：按份数取整 / 夹到上限，实际花的可能比金额少
      p.boughtBnb += spent; p.costBnb += spent; p.amount += r.expected || 0; delete p.chainZero;
      Object.assign(order, { amountIn: spent, out: r.expected });
    } else {
      const pct = Math.min(100, order.amount);
      if (this.status.auth.state !== 'ok') throw new Error('币安钱包未登录，请在终端运行 baw auth signin');
      // 买入后的后台预先授权还没上链：先等它（最多 20 秒），免得再发一笔授权
      const pw = this.preapproving.get(`${w.address}:${t.address}`.toLowerCase());
      if (pw) { const t0 = Date.now(); await Promise.race([pw, sleep(20_000)]); step('等后台预先授权上链', Date.now() - t0); }
      if (this.fairMinting(t)) {
        r = await fairSell({ provider: this.market.provider, contractCall: baw.contractCall, wallet: w.address, token: t.address, pct, step });
      } else if (this.useGangV2(t)) {
        r = await this.gangV2.sell({ wallet: w.address, token: t.address, pct, slippage, step, toBnb: this.settings.sellToBnb });
      } else if (this.useGang(t)) {
        r = await this.gangTrade.sell({ wallet: w.address, token: t.address, pct, slippage, step });
      } else if (this.useOpenFour(t)) {
        r = await this.openFourSell({ w, t, pct, slippage, step });
      } else if (this.useFlapNft(t)) {
        r = await this.flapNft.sell({ wallet: w.address, token: t.address, pct, slippage, step });
      } else if (this.usePortal(t, 'sell')) {
        r = await this.portal.sell({ wallet: w.address, market: t.market, quoteAddress: t.quoteAddress, quoteSym: t.quote, pct, slippage, step, toBnb: this.settings.sellToBnb });
      } else {
        // 按下单这一刻的真实余额算；全卖时留 0.1% 余量（转账税 / 小数位舍入会让「卖 100%」报余额不足）
        this.quoteCache.delete(`bal:${w.id}:${t.address}`);
        const bal = await this.tokenBal(w, t.address);
        // 卖 100%：用链上精确余额原样下单；按比例：从实时余额算，向下取整到代币精度
        const ex = await this.exactBal(w, t.address).catch(() => null);
        const qty = ex ? (pct >= 100 ? ex.str : ethers.formatUnits((ex.raw * BigInt(Math.round(pct * 100))) / 10000n, ex.dec)) : bal * Math.min(pct, 99.9) / 100;
        step(`查询余额 ${trim(bal)}`, 0);
        if (!(qty > 0)) throw new Error(`钱包里没有 ${t.symbol}（实际 0 个）`);
        try { r = await this.dexTrade({ t, w, side: 'sell', qty, pct, slippage, step }); }
        catch (e) { if (/insufficient|balance/i.test(e.message)) throw new Error(`钱包里的 ${t.symbol} 余额不足（实际 ${trim(bal)} 个）：${e.message}`); throw e; }
      }
      p.soldBnb += r.expected || 0; p.amount = Math.max(0, p.amount * (1 - pct / 100));
      Object.assign(order, { amountIn: pct, out: r.expected });
    }
    Object.assign(order, { status: 'filled', dryRun: false, venue: r.venue, tx: r.txHash, txs: r.hashes, reason: r.note || null, latencyMs: Date.now() - order.ts });
    this.quoteCache.clear(); this.refreshBalance();
    this.emit('order', order);
    if (side === 'buy') this.prewarmApprovals(t, w);
    return order;
  }

  // 买入成交后后台「预先授权」（预先授权默认全部打开）。只在设置里「预先授权」开着时做，额度仍是固定额度、不是无限额：
  // - 卖出：把这次买到的代币授权给卖出要用的合约，额度 = 当前余额 × 1.01（Gang V2/V3 pad、Gang V1 pad、Flap 门槛盘 Portal、OpenFour Core）
  // - 报价币（Gang V2/V3 盘）：剩余额度不到固定额度一半时补到约 2 倍单笔上限
  // 这样第一次卖出 / 下一次买入都不用再等授权。Flap 普通 Portal 卖的是曲线份额、外盘走 baw，都不需要授权。失败只记一笔失败的授权记录，不影响买单。
  async sellSpender(t, w) {
    if (this.useGangV2(t)) return (await this.gangV2.curve(t.address)).pad;
    if (this.useGang(t)) return GANG_PAD;
    if (this.useFlapNft(t)) return FLAP_PORTAL;
    if (this.useOpenFour(t)) return (await openFour.info(t.address, w.address))?.contracts?.core || null;
    return null;
  }
  prewarmApprovals(t, w) {
    if (!PREAPPROVE_AFTER_BUY || this.settings.preApproveCap === false || !w?.address) return;
    const key = `${w.address}:${t.address}`.toLowerCase();
    if (this.preapproving.has(key)) return;
    const job = this.prewarmJob(t, w).catch(() => {}).finally(() => this.preapproving.delete(key));
    this.preapproving.set(key, job);
  }
  async prewarmJob(t, w) {
    const erc = new ethers.Interface(['function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
    const prov = this.market.tradeProvider || this.market.provider;
    const read = async (to, fn, args) => erc.decodeFunctionResult(fn, await prov.call({ to, data: erc.encodeFunctionData(fn, args) }))[0];
    const spender = await this.sellSpender(t, w).catch(() => null);
    const jobs = [];
    if (spender) {
      let bal = 0n; for (let i = 0; i < 10 && bal <= 0n; i++) { bal = await read(t.address, 'balanceOf', [w.address]).catch(() => 0n); if (bal <= 0n) await sleep(500); }
      if (bal > 0n && (await read(t.address, 'allowance', [w.address, spender]).catch(() => 0n)) < bal) jobs.push({ token: t.address, spender, symbol: t.symbol, kind: 'sell', amount: bal });
    }
    if (this.useGangV2(t)) {
      const { pad, c } = await this.gangV2.curve(t.address); const q = this.gangV2.quoteToken(c);
      const cap = await capFor({ token: q, wallet: w.address, amount: 1n, kind: 'quote' });
      if (cap > 1n && (await read(q, 'allowance', [w.address, pad]).catch(() => 0n)) < cap / 2n) jobs.push({ token: q, spender: pad, symbol: t.quote || '报价币', kind: 'quote', amount: cap });
    }
    for (const j of jobs) {
      if (this.settings.preApproveCap === false) return;
      const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w.id, wallet: w.label, token: j.token, symbol: j.symbol, platform: t.platform,
        side: 'approve', amount: 0, source: '预先授权', via: 'preapprove', status: 'pending', steps: [], dryRun: false, route: `买入后预先授权${j.kind === 'sell' ? '卖出' : '报价币'}（${capLabel(j.kind)}）` };
      const step = (name, ms) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); this.emit('order', order); };
      this.orders.unshift(order); this.emit('order', order);
      try {
        const cap = await capFor({ token: j.token, wallet: w.address, amount: j.amount, kind: j.kind });
        const hash = await sendApproval({ send: (o) => this.portal.send(o), wallet: w.address, token: j.token, spender: j.spender, amount: j.amount, cap, label: `预先授权 ${j.symbol}（${capLabel(j.kind)}）`, symbol: j.symbol, kind: j.kind, step });
        Object.assign(order, { status: 'filled', tx: hash, txs: [hash], venue: `approve（${capLabel(j.kind)}）`, latencyMs: Date.now() - order.ts });
      } catch (e) { Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts }); }
      this.emit('order', order);
    }
  }

  // 「发射后自动领取」：Flap Agent 曲线迁移后，份额要调用 Portal.claim(market) 领成代币（Four 的代币本来就在钱包里，不用领）。
  // 每分钟查一次已迁移市场的份额；开着自动领取且已登录、实盘下单开着时，每个市场只领一次，失败按 1→2→4…最多 30 分钟退避重试。
  async scanClaims() {
    const w = this.wallets[0]; if (!w) return;
    const list = [];
    for (const t of this.market.list().filter((x) => x.source === 'agent-curve' && x.market && x.stage === 'dex')) {
      try { const sh = await this.portal.sharesOf(t.market, w.address); if (sh > 0n) list.push({ token: t.address, market: t.market, symbol: t.symbol, shares: Number(sh) / 1e18 }); } catch { /* 单个市场读失败跳过 */ }
    }
    this.claimable = list;
    if (DRY_RUN || !this.settings.autoClaim || this.status.auth.state !== 'ok') return;
    for (const c of list) {
      const r = this.claimRetry.get(c.market);
      if (this.claiming.has(c.market) || (r && Date.now() < r.next)) continue;
      this.claimOne(c.market, '自动领取');
    }
  }

  async claimOne(market, source = '手动领取') {
    const t = this.market.list().find((x) => x.market === market);
    const w = this.wallets[0];
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w?.id, wallet: w?.label || 'baw', token: t?.address, symbol: t?.symbol || '?', platform: 'flap',
      side: 'claim', amount: 0, source, status: 'pending', steps: [], dryRun: DRY_RUN, route: 'Flap Agent Curve · Portal.claim（迁移后领取代币）' };
    this.orders.unshift(order); this.emit('order', order);
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms) }); if (x?.tx) { order.pendingTx = x.tx; order.stage = x.stage || 'broadcast'; } this.emit('order', order); };
    this.claiming.add(market);
    try {
      if (DRY_RUN) throw new Error('只报价模式不会领取');
      if (this.status.auth.state !== 'ok') throw new Error('币安钱包未登录，请在终端运行 baw auth signin');
      const r = await this.portal.claim({ wallet: w.address, market, step });
      Object.assign(order, { status: 'filled', venue: r.venue, out: r.expected, tx: r.txHash, txs: r.hashes, latencyMs: Date.now() - order.ts });
      this.claimRetry.delete(market); this.claimable = this.claimable.filter((c) => c.market !== market);
    } catch (e) {
      const prev = this.claimRetry.get(market)?.wait || 30_000; const wait = Math.min(prev * 2, 30 * 60_000);
      this.claimRetry.set(market, { wait, next: Date.now() + wait });
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
    } finally { this.claiming.delete(market); }
    this.emit('order', order);
    return order;
  }

  // 内盘买入：info 确认还在内盘 → quote-buy 生成 Core 交易 → baw contract-call preview + execute → 等上链
  async openFourBuy({ w, t, amt, slippage, step }) {
    let t0 = Date.now();
    const i = await openFour.info(t.address, w.address);
    if (i.route !== 'contract-call') throw new Error(`这个盘现在不能走内盘买入（route=${i.route}，${i.curve?.phase?.name || ''}）`);
    // 计价币盘（非 WBNB）：钱包里的计价币够这笔就直接用它付，不够就用 BNB 付、Core 在同一笔里换（Gang / Flap / Four 同一个逻辑）
    const bps = Math.round(slippage * 100), qa = i.quote?.address && !i.quote.isWrappedNative ? i.quote.address : null;
    let pay = null;
    if (qa) {
      const [raw, rate] = await Promise.all([this.gangV2.balanceOf(qa, w.address), this.gangV2.quoteRate(qa, { stale: 30_000 })]).catch(() => [0n, 0]);
      const dec = Number(i.quote.decimals ?? 18), have = Number(ethers.formatUnits(raw, dec)), need = amt * rate;
      if (rate > 0 && need > 0 && have >= need) pay = { qty: need.toFixed(Math.min(8, dec)), sym: i.quote.symbol || '计价币' };
    }
    const quote = () => openFour.quoteBuy(t.address, w.address, pay ? pay.qty : trim(amt), bps, pay ? qa : null);
    let q = await quote();
    if (pay) step(`直接用钱包里的 ${pay.qty} ${pay.sym} 付款，不用 BNB`, 0);
    if (q.approveTx) {   // 用计价币付要先授权给 Core（按设置：预先授权较大固定额度，或只授权本次数量），授权上链后重新报价
      const ai = new ethers.Interface(['function approve(address,uint256)']); const [spender, amt0] = ai.decodeFunctionData('approve', q.approveTx.inputData);
      const cap = await capFor({ token: qa, wallet: w.address, amount: amt0, kind: 'quote' });
      await sendApproval({ send: (o) => this.portal.send(o), wallet: w.address, token: qa, spender, amount: amt0, cap, label: `授权 ${pay.sym}（${capLabel('quote')}）`, symbol: pay.sym, kind: 'quote', step });
      q = await quote(); if (q.approveTx) throw new Error(`授权 ${pay.sym} 后额度仍不够，没有买入`);
    }
    openFour.checkQuote(q);
    step(`OpenFour 报价 ${Number(q.estimate.tokenAmount).toFixed(0)} ${t.symbol}（至少 ${Number(q.minTokenOut).toFixed(0)}）`, Date.now() - t0);
    if (q.estimate.budgetNotFullyUsed) step(`接近 1% 持仓上限，只花掉部分${pay ? ` ${pay.sym}` : ' BNB'}，多余的${pay ? '留在钱包' : '同笔退回'}`, 0);
    const hash = await this.portal.send({ wallet: w.address, to: q.tx.to, valueWei: q.tx.value, inputData: q.tx.inputData, label: 'OpenFour Core.buy', step });
    return { venue: 'OpenFour Core.buy（内盘）', expected: Number(q.estimate.tokenAmount), txHash: hash, hashes: [hash] };
  }

  // 内盘卖出：quote-sell；需要时先授权（只授权本次卖出数量），授权上链后重新报价再卖
  async openFourSell({ w, t, pct, slippage, step }) {
    const bps = Math.round(slippage * 100);
    const bal = await this.tokenBal(w, t.address);
    step(`查询余额 ${trim(bal)}`, 0);
    if (!(bal > 0)) throw new Error('没有可卖出的余额');
    const amount = pct >= 100 ? 'all' : trim(bal * pct / 100);
    let q = openFour.checkQuote(await openFour.quoteSell(t.address, w.address, amount, bps));
    const hashes = [];
    if (q.approveTx) {
      // 技能脚本给的是「授权本次数量」；按设置改成较大固定额度（全部余额 × 1.01），授权对象不变
      const ai = new ethers.Interface(['function approve(address,uint256)']); let spender = null, amt0 = 0n;
      try { [spender, amt0] = ai.decodeFunctionData('approve', q.approveTx.inputData); } catch { /* 解析不了就按脚本原样 */ }
      if (spender && q.approveTx.to.toLowerCase() === t.address.toLowerCase()) {
        const cap = await capFor({ token: t.address, wallet: w.address, amount: amt0, kind: 'sell' });
        hashes.push(await sendApproval({ send: (o) => this.portal.send(o), wallet: w.address, token: t.address, spender, amount: amt0, cap, label: `授权 ${t.symbol}（${capLabel('sell')}）`, symbol: t.symbol, kind: 'sell', step }));
      } else hashes.push(await this.portal.send({ wallet: w.address, to: q.approveTx.to, valueWei: q.approveTx.value || '0', inputData: q.approveTx.inputData, label: `授权 ${t.symbol}`, step }));
      q = openFour.checkQuote(await openFour.quoteSell(t.address, w.address, amount, bps));
    }
    step(`OpenFour 报价 → ${Number(q.estimate.userReceives).toFixed(6)} BNB（至少 ${Number(q.minReceive).toFixed(6)}）`, 0);
    hashes.push(await this.portal.send({ wallet: w.address, to: q.tx.to, valueWei: q.tx.value || '0', inputData: q.tx.inputData, label: 'OpenFour Core.sell', step }));
    return { venue: 'OpenFour Core.sell（内盘）', expected: Number(q.estimate.userReceives), txHash: hashes.at(-1), hashes };
  }

  // BNB ↔ Ondo 类代币（只能和稳定币直接换）自动拆成经 USDT 两步；路线表里没记录的，第一次报错时记下来并改走 USDT（报错时还没提交订单）
  async swapReal({ from, to, qty, slippage, step, label }) {
    const isBnb = (a) => String(a).toLowerCase() === BNB_NATIVE.toLowerCase();
    const other = isBnb(from) ? to : isBnb(to) ? from : null;
    if (other && viaUsdt(other)) return this.swapViaUsdt({ from, to, qty, slippage, step, label });
    try { return await this.swapOnce({ from, to, qty, slippage, step, label }); }
    catch (e) {
      if (!other || !ONDO_RE.test(e.message)) throw e;
      markViaUsdt(other); step(`${label} 只能和稳定币直接兑换（Ondo 类），改走 USDT 两步`, 0);
      return this.swapViaUsdt({ from, to, qty, slippage, step, label });
    }
  }
  async swapViaUsdt({ from, to, qty, slippage, step, label }) {
    const a = await this.swapOnce({ from, to: USDT, qty, slippage, step, label: `${label}（第 1 步 →USDT）` });
    if (!(a.raw > 0)) throw new Error(`${label} 第 1 步没有拿到 USDT，没有继续`);
    let b;
    try { b = await this.swapOnce({ from: USDT, to, qty: String(a.raw), slippage, step, label: `${label}（第 2 步 USDT→）` }); }
    catch (e) { e.message = `${e.message}；第 1 步已换出 ${a.raw} USDT 留在钱包`; throw e; }
    return { venue: 'baw market-order（经 USDT 两步）', expected: b.expected, txHash: b.txHash, hashes: [...a.hashes, ...b.hashes], note: [a.note, b.note].filter(Boolean).join('；') || null };
  }
  async swapOnce({ from, to, qty, slippage, step, label }) {
    const t0 = Date.now();
    const sw = await baw.marketSwap({ fromTokenQty: typeof qty === 'string' ? qty : trim(qty), fromToken: from, toToken: to, slippage });   // 字符串 = 精确数量，原样传
    if (!sw.orderId) throw new Error(`${label} 没有返回 orderId`);
    step(`${label} 已提交 ${sw.orderId}`, Date.now() - t0);
    const o = await baw.pollOrder(sw.orderId);
    if (o?.status !== 'FINISHED') throw Object.assign(new Error(`${label} ${o?.status === 'FAILED' ? '失败' : '仍在处理，请稍后在钱包里查看'}（订单 ${sw.orderId}）`), o?.status === 'FAILED' ? {} : { code: 'UNCONFIRMED', tx: o?.txHash || null });   // 没失败也没完成 = 已提交、结果未知，按待确认跟踪
    const refund = Array.isArray(o.refund) && o.refund.length ? `；部分成交，退回 ${o.refund.map((x) => `${x.amount} ${x.symbol}`).join('、')}` : '';
    step(`${label} 完成${refund}`, Date.now() - t0);
    return { venue: 'baw market-order', expected: Number(o.toTokenActualQty || 0), raw: o.toTokenActualQty || 0, txHash: o.txHash || null, hashes: [o.txHash].filter(Boolean), note: refund ? refund.slice(1) : null };
  }

  async swap({ from, to, qty, slippage, step }) {
    const t0 = Date.now();
    const q = await baw.marketQuote({ fromTokenQty: trim(qty), fromToken: from, toToken: to, slippage });
    step(`baw 报价 → ${q?.toCoinAmount ?? '?'} ${q?.toCoinSymbol || ''}`, Date.now() - t0);
    return { dryRun: true, expected: Number(q?.toCoinAmount || 0), venue: 'baw-dex 报价' };
  }

  finish(order, r, apply, extra) {
    Object.assign(order, { status: 'dry_run', reason: '只报价/预演，没有上链', ...extra });
    order.venue = r.venue; order.latencyMs = Date.now() - order.ts;
    this.emit('order', order);
    return order;
  }

  positionsView() {
    const out = [];
    for (const p of this.positions.values()) {
      if (p.amount <= 0 && !p.boughtBnb) continue;
      const t = this.market.get(p.token); if (!t) continue;
      // t.price 以报价币计（GANG、BNCB…），折成 BNB 再算价值和盈亏，否则 GANG 盘会把 GANG 数量当 BNB（和 holdings.js 同一换算）
      const bnbUsd = this.market.bnbUsd, isBnbQuote = !t.quote || ['BNB', 'WBNB'].includes(String(t.quote).toUpperCase());
      const rate = isBnbQuote ? 1 : (bnbUsd ? (this.market.quoteUsd?.(t) || 0) / bnbUsd : 0);
      const value = p.amount * (t.price || 0) * rate;
      if (p.amount > 0) p.peak = Math.max(p.peak, t.price || 0);
      out.push({ ...p, symbol: t.symbol, platform: t.platform, image: t.image || null, stage: t.stage, price: t.price, valueBnb: value, valueUsd: value * bnbUsd,
        pnlBnb: value + p.soldBnb - p.boughtBnb, pnlPct: p.costBnb > 0 && t.price && rate ? ((value - p.costBnb) / p.costBnb) * 100 : 0,
        drawdownPct: p.peak ? ((t.price - p.peak) / p.peak) * 100 : 0, wallet: this.wallets.find((w) => w.id === p.walletId)?.label || 'baw' });
    }
    return out.sort((a, b) => b.openedAt - a.openedAt);
  }

  walletsView() { return this.wallets.map(({ tokens, ...w }) => w); }
}

// 实盘设置（单笔上限、自动领取）存在 data/live-settings.json，重启后仍然有效；没存过就用默认值
function loadSaved() { try { return JSON.parse(readFileSync(LIVE_SETTINGS_FILE, 'utf8')); } catch { return {}; } }
function saveSetting(k, v) {
  mkdirSync(new URL('.', LIVE_SETTINGS_FILE), { recursive: true });
  writeFileSync(LIVE_SETTINGS_FILE, JSON.stringify({ ...loadSaved(), [k]: v }, null, 2));
}
function loadMaxTrade() { const v = loadSaved().maxTradeBnb; return v != null && Number(v) >= 0 ? Number(v) : MAX_TRADE_BNB; }
LiveTrader.prototype.saveSetting = function (k, v) { saveSetting(k, v); };
LiveTrader.prototype.loadSaved = function () { return loadSaved(); };
LiveTrader.prototype.setMaxTrade = function (v) {
  const n = v === '' || v == null ? 0 : Number(v);
  if (!(n >= 0) || !Number.isFinite(n)) throw new Error('单笔上限必须是 ≥ 0 的数字（0 = 不限）');
  this.status.maxTradeBnb = n;
  saveSetting('maxTradeBnb', n);
  return n;
};

const FUND_GAS = 0.002;   // 用计价币补 BNB 时给 gas 留的 BNB
const fmtQ = (n) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
const trim = (n) => Number(n).toFixed(18).replace(/\.?0+$/, '') || '0';
// 会真实上链的订单来源：页面手动点击（手动），以及本人在页面上关掉「模拟」并启动的跟单任务（跟单 任务名）。
// 以前只认「手动」，跟单任务传来的「跟单 xxx」被当成自动订单，真实模式的跟单永远只报价、从不下单，也不计次数
// 2026-10-27 起还有本人在页面上打开、并关掉「模拟」的 Gang 新盘狙击（狙击 Gang，engine/live/sniper.js）
// 2026-10-29 起还有本人在代币详情里打开的「迁移清仓」规则（engine/migSell.js，主后端转给钱包 2 时来源不变）
// 另外可以在环境变量 TMTN_EXTRA_SOURCES（逗号分隔，写在 .env 里）放行其他来源：本机脚本带访问令牌调 /api/order 时用。默认为空
const EXTRA_SOURCES = new Set(String(process.env.TMTN_EXTRA_SOURCES || '').split(',').map((x) => x.trim()).filter(Boolean));
const isRealSource = (s) => s === '手动' || /^跟单 /.test(String(s || '')) || s === '狙击 Gang' || s === '迁移清仓' || EXTRA_SOURCES.has(String(s || ''));
