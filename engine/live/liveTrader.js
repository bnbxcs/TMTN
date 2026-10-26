// 实盘执行层：读币安 Agentic Wallet（baw）的地址和余额，用链上 Portal.quoteBuy / baw 报价和预演算出能成交多少。
// 默认不提交真实交易（订单状态 dry_run）。LIVE_TRADE=1 时，页面上手动点击的订单才会真实上链；自动买/自动卖始终只报价。
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PREAPPROVE, QUOTE_TOKENS } from './config.js';
import { setApprovalCtx, capFor, capLabel, sendApproval, listApprovals } from './approvals.js';
import { DRY_RUN, AUTH_SIMULATE_LOGGED_OUT, MAX_TRADE_BNB, LIVE_SETTINGS_FILE, BNB_NATIVE, BINANCE_CHAIN_ID, WALLET_LABEL, AUTO_TRANSFER_TO, AUTO_TRANSFER_FOUR } from './config.js';
const AT_FILE = new URL('../../data/autoTransfer.json', import.meta.url);
const RULE_FILE = new URL('../../data/tokenRules.json', import.meta.url);
import * as baw from './baw.js';
import { ethers } from 'ethers';
const POS_FILE = new URL('../../data/positions.json', import.meta.url);
import { Portal } from './portal.js';
import * as openFour from './openFour.js';
import { GangTrade } from './gangTrade.js';
import { GangV2 } from './gangV2Pads.js';   // 本会话实现（3 个 pad）；gangV2.js 是另一个会话的版本，这里没用
import { GweiTrade } from './gwei.js';
import * as latency from './latency.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LiveTrader extends EventEmitter {
  constructor(market) {
    super();
    this.market = market;
    this.portal = new Portal(market.provider);
    setApprovalCtx({ trader: this, market });
    this.gangTrade = new GangTrade(market.provider, (o) => this.portal.send(o));
    this.gangV2 = new GangV2(market.provider, (o) => this.portal.send(o));
    this.gweiTrade = new GweiTrade(market.provider, (o) => this.portal.send(o));
    this.wallets = [];
    this.positions = new Map();
    this.orders = [];
    this.quoteCache = new Map();
    this.settings = { gas: 'high', execPath: 'direct', multiRpc: false, autoClaim: loadSaved().autoClaim ?? true,
      // 领取后自动全部转到 AUTO_TRANSFER_TO：默认关，只能由本人在页面「设置」里打开（一次性同意），存 data/live-settings.json
      autoSendAfterClaim: !!AUTO_TRANSFER_TO && loadSaved().autoSendAfterClaim === true, sendTo: AUTO_TRANSFER_TO,
      autoSendFourMigrated: !!AUTO_TRANSFER_TO && loadSaved().autoSendFourMigrated === true,
      autoSendGangMigrated: !!AUTO_TRANSFER_TO && loadSaved().autoSendGangMigrated === true,
      qbPresets: loadSaved().qbPresets || null,
      sellToBnb: loadSaved().sellToBnb !== false,
      preApproveCap: loadSaved().preApproveCap !== false };   // 预先授权（较大固定额度，用户可在页面关闭）；关掉 = 只授权本次数量   // 卖出后自动把报价币（BNCB / GANG / 币股…）换回 BNB，默认开，可在交易设置里关   // 一键买卖面板的预设金额 / 比例（页面上编辑，存 live-settings.json）   // Gang 发射（毕业）后自动转出，同样只能本人打开   // Four 发射后自动转出（同样只能本人在页面打开）
    this.claimable = []; this.claimRetry = new Map(); this.claiming = new Set(); this.inflight = new Set();
    this.preapproving = new Set();
    this.on('order', (o) => { try { latency.record(o, { gasLevel: this.settings.gas, rpc: this.market.provider?._getConnection?.().url || null }); } catch {} });
    this.status = { connected: false, error: null, dryRun: DRY_RUN, maxTradeBnb: loadMaxTrade(), auth: { state: 'checking', agentId: null, address: null, checkedAt: 0, message: '' }, login: null };
  }

  async init() {
    try {
      const addrs = await baw.walletAddresses();
      const bsc = addrs.find((a) => String(a.binanceChainId) === String(BINANCE_CHAIN_ID));
      if (!bsc?.address) throw new Error('baw 未返回 BSC 地址，请先运行 baw auth signin');
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
    if (state === 'ok' || this.authFails >= 2) { a.state = state; a.message = message; }
    else if (a.state === 'ok') a.message = `检查失败一次，稍后再确认：${message}`;
    if (state !== 'ok' && this.authFails === 1) setTimeout(() => this.checkAuth(), 3_000);   // 第一次失败 3 秒后马上再确认
    if (a.state === 'ok' && !a.agentId) { try { const id = await baw.agentId(); a.agentId = id.claimed ? id.agentId : null; if (a.agentId) this.market.names?.set(this.wallets[0]?.address, a.agentId); } catch { /* 域名拿不到不影响登录状态 */ } }
    a.address = this.wallets[0]?.address || a.address;
    a.checkedAt = Date.now();
    return a;
  }

  // 页面上点「登录」：baw auth signin 拿登录链接和配对码，后台跑 auth verify 等用户在币安 App 里确认
  async startLogin() {
    const cur = this.status.login;
    if (cur?.state === 'waiting' && Date.now() < cur.expireAt) return cur;
    if (AUTH_SIMULATE_LOGGED_OUT) { this.status.login = { state: 'failed', message: '调试模拟未登录：不会真的发起登录' }; return this.status.login; }
    const d = await baw.authSignin();
    if (d.status === 'ALREADY_CONNECTED') { this.status.login = null; await this.checkAuth(); return { state: 'done' }; }
    const login = { state: 'waiting', urlForWeb: d.urlForWeb, pairingCode: d.pairingCode, qrCodeId: d.qrCodeId, expireAt: Number(d.expireAt) || Date.now() + 300_000, message: '' };
    this.status.login = login;
    baw.authVerify(d.qrCodeId)
      .then(async (r) => { login.state = r.status === 'SUCCESS' ? 'done' : 'failed'; login.message = r.status || ''; await this.checkAuth(); if (this.status.auth.state === 'ok') await this.init(); })
      .catch((e) => { login.state = 'failed'; login.message = e.message; });
    return login;
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
      const toks = [...this.market.tokens.values()];
      await Promise.all(toks.map(async (t) => {
        let amt = null;
        if (t.source === 'agent-curve' && t.market && t.stage === 'curve') {
          try { amt = Number(ethers.formatEther(await this.portal.sharesOf(t.market, w.address))); } catch { return; }
        } else if (w.tokens) amt = w.tokens[t.address] || 0;
        if (amt == null) return;
        const k = `${w.id}:${t.address}`;
        if (amt > 0) { const p = this.pos(w.id, t.address); p.amount = amt; if (!p.openedAt) p.openedAt = Date.now(); }
        else if (this.positions.has(k)) this.positions.get(k).amount = 0;
      }));
      const o = {}; for (const [k, p] of this.positions) if (p.amount > 0 || p.boughtBnb) o[k] = p;
      try { mkdirSync(new URL('.', POS_FILE), { recursive: true }); writeFileSync(POS_FILE, JSON.stringify(o)); } catch { /* ignore */ }
    } finally { this.syncing = false; }
    this.autoTransferCheck().catch((e) => console.error('autoTransfer:', e.message));
  }

  /* ---------- 单币规则：发射后立刻领取，再（经本人确认后）把全部代币转到指定地址 ----------
     只对规则里的币生效，全局 AUTO_TRANSFER_FOUR 不受影响。存在 data/tokenRules.json，重启后继续。
     transfer: 'confirm'（等本人在页面上确认）| 'armed'（已确认，领取后自动转）| 'off'；转账只有 armed 才会执行 */
  rules() { if (!this._rules) { try { this._rules = JSON.parse(readFileSync(RULE_FILE, 'utf8')); } catch { this._rules = {}; } } return this._rules; }
  rulesSave() { try { mkdirSync(new URL('.', RULE_FILE), { recursive: true }); writeFileSync(RULE_FILE, JSON.stringify(this._rules, null, 1)); } catch { /* ignore */ } this.emit('rules', this.rulesView()); }
  rulesView() { return Object.fromEntries(Object.entries(this.rules()).map(([k, r]) => [k, { ...r }])); }
  setRule(token, patch) {
    const k = String(token || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(k)) throw new Error('代币地址无效');
    if (patch === null) { delete this.rules()[k]; this.rulesSave(); return this.rulesView(); }
    if (patch.to && !/^0x[0-9a-fA-F]{40}$/.test(patch.to)) throw new Error('目标地址无效');
    const t = this.market.get(k); const r = this.rules()[k] || { token: k, createdAt: Date.now(), claim: true, transfer: 'confirm', state: {} };
    Object.assign(r, { symbol: t?.symbol || r.symbol, market: t?.market || r.market, platform: t?.platform || r.platform }, patch);
    if (patch.transfer === 'armed') r.armedAt = Date.now();
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
        // 2) 转账：只有本人确认过（armed）才执行；全部余额 → r.to
        const ready = !r.claim || st.claimedAt || t?.source !== 'agent-curve';
        if (!ready || r.transfer !== 'armed' || !r.to || st.transferTx) continue;
        if (Date.now() < (st.sendNext || 0)) continue;
        if (t?.source !== 'agent-curve' && t?.stage !== 'dex') continue;   // 非 Flap 的币：等发射（迁移）后再转
        const bal = Number((await baw.walletBalance({ tokenAddress: r.token }).catch(() => [])).find((x) => String(x.address || '').toLowerCase() === r.token)?.balance || 0);
        if (!(bal > 0)) { st.sendNext = Date.now() + 5_000; continue; }   // 领取刚上链，余额可能还没更新
        if ((await baw.walletLock().catch(() => 'UNKNOWN')) === 'LOCKED') { st.sendNext = Date.now() + 10_000; this.ruleLog(r, '钱包在等币安 App 确认，稍后再转'); this.rulesSave(); continue; }
        const short = r.to.slice(0, 6) + '…' + r.to.slice(-4);
        const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w.id, wallet: w.label, token: r.token, symbol: r.symbol || '?', platform: r.platform, side: 'transfer', amountIn: bal, to: r.to, status: 'pending', steps: [], auto: true, source: '规则：领取后转出', route: `全部 ${r.symbol} → ${short}` };
        this.orders.unshift(order); this.emit('order', order);
        st.sendTries = (st.sendTries || 0) + 1; this.ruleLog(r, `转出 ${bal} → ${r.to}（第 ${st.sendTries} 次）`);
        try {
          const d = await baw.sendMax({ tokenAddress: r.token, recipient: r.to });
          Object.assign(order, { status: 'filled', tx: d.txHash || d.hash || null, out: bal }); st.transferTx = order.tx || 'submitted'; st.transferAt = Date.now(); st.sent = bal; st.done = true;
          this.ruleLog(r, `转出成功 ${order.tx || ''}`);
        } catch (e) {
          Object.assign(order, { status: 'failed', reason: e.message }); st.lastError = e.message;
          st.sendNext = Date.now() + [5_000, 15_000, 60_000, 300_000, 900_000][Math.min(st.sendTries, 5) - 1]; this.ruleLog(r, `转出失败：${e.message}`);
        }
        this.rulesSave(); this.emit('order', order); this.emit('autoTransfer', { ...order, toShort: short }); this.refreshBalance();
      }
    } finally { this.ruleBusy = false; }
  }

  // Four 代币发射（curve→dex）后，把持仓全部转到 AUTO_TRANSFER_TO。done 记录在 data/autoTransfer.json，失败最多重试 3 次（退避 1/5/15 分钟）
  atState() { if (!this.at) { try { this.at = JSON.parse(readFileSync(AT_FILE, 'utf8')); } catch { this.at = {}; } } return this.at; }
  atSave() { try { mkdirSync(new URL('.', AT_FILE), { recursive: true }); writeFileSync(AT_FILE, JSON.stringify(this.at, null, 1)); } catch { /* ignore */ } }
  // Four 发射（内盘 → 外盘）后自动转出：页面「设置」里本人打开 autoSendFourMigrated（或环境变量 AUTO_TRANSFER_FOUR=1）才生效。
  // 只处理「打开后、看到从内盘变成已迁移」且当时钱包里有这个币的情况（迁移后才在外盘买的不转，启动后 3 分钟内的状态变化不算，避免把重启时补状态误当成发射）。
  // 认定后给这个币挂一条已确认的转出规则，由 ruleTick 负责转账：重试、等币安 App 确认、记录哈希、每个币只转一次
  async autoTransferCheck() {
    const w = this.wallets[0]; if (!w) return;
    // Four：autoSendFourMigrated（或环境变量 AUTO_TRANSFER_FOUR）；Gang（老盘和 V2 盘）：autoSendGangMigrated
    const onFor = AUTO_TRANSFER_TO ? { four: AUTO_TRANSFER_FOUR || this.settings.autoSendFourMigrated, gang: this.settings.autoSendGangMigrated } : { four: false, gang: false };   // 没设目标地址就不转
    this.fourStage ||= new Map(); this.startedAt ||= Date.now();
    for (const t of this.market.tokens.values()) {
      if (t.platform !== 'four' && t.platform !== 'gang') continue;
      const prev = this.fourStage.get(t.address); this.fourStage.set(t.address, t.stage);
      if (!onFor[t.platform] || prev !== 'curve' || t.stage !== 'dex' || Date.now() - this.startedAt < 180_000) continue;
      if (!((w.tokens?.[t.address] || 0) > 0) || this.rules()[t.address.toLowerCase()]) continue;
      this.setRule(t.address, { claim: false, to: AUTO_TRANSFER_TO, transfer: 'armed', auto: true, state: {} });
      this.ruleLog(this.rules()[t.address.toLowerCase()], `${t.platform === 'gang' ? 'Gang' : 'Four'} 已发射，按「${t.platform === 'gang' ? 'Gang' : 'Four'} 发射后自动转出」设置转出全部 ${t.symbol}`); this.rulesSave();
    }
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
  useGang(t) { return t.source === 'gang' && t.stage === 'curve' && t.gangTrack !== 'v2'; }
  // gang.fun V2 报价币盘：先把 BNB 换成报价币再买，卖出后换回 BNB（非原子）
  useGangV2(t) { return t.source === 'gang' && t.stage === 'curve' && t.gangTrack === 'v2'; }

  useOpenFour(t) { return t.source === 'four-agent' && t.stage === 'curve'; }

  // GWEI 曲线阶段直接调代币合约 buy / sell；迁移后走 baw market-order（PancakeSwap）
  useGwei(t) { return t.source === 'gwei' && t.stage === 'curve'; }

  usePortal(t, side) { return t.source === 'agent-curve' && t.market && t.stage === 'curve' && (side === 'buy' || !DRY_RUN); }

  route(t, side) {
    if (this.useGang(t)) return `Gang 内盘 · ${side === 'buy' ? 'buy' : 'sell'}（BNB，一笔完成）· baw contract-call（每个钱包最多买总量 1%）`;
    if (this.useGangV2(t)) return side === 'buy' ? `Gang V2 内盘 · BNB→${t.quote}→buy（非原子，2～3 笔交易）· 每个钱包最多 1%` : `Gang V2 内盘 · sell→${t.quote}→BNB（非原子，2～3 笔交易）`;
    if (this.useOpenFour(t)) return `Four Agent 专属内盘 · OpenFour Core.${side} · baw contract-call（每个钱包最多买总量 1%）`;
    if (this.useGwei(t)) return `GWEI 曲线 · ${side}（BNB，一笔完成，卖出不用授权）· baw contract-call（单笔最多 0.1 BNB，每个钱包最多总量 1%）`;
    if (this.usePortal(t, side) && side === 'sell') return `Flap Agent Curve · Portal.sell${t.quote === 'BNB' ? '' : ` → ${t.quote} → BNB`}`;
    if (this.usePortal(t, side)) return `Flap Agent Curve · ${t.quote === 'BNB' ? 'Portal.buy（BNB，原子）' : `BNB→${t.quote}→Portal.buyWithQuote（非原子）`}`;
    return `币安 Web3 DEX 聚合 · baw market-order ${side === 'buy' ? 'BNB→代币' : '代币→BNB'}${t.platform === 'four' ? '（可能打不到内盘）' : ''}`;
  }

  // 链上精确余额（字符串，按代币精度原样给出，不经过浮点数）。以前用 Number 转一次再写成 18 位小数，
  // 尾数会被舍入得比实际余额大一点点（例如 0.931044697706272163 变成 …184），卖 100% 时 baw 报「余额不足」
  async exactBal(w, token) {
    const i = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
    const call = async (fn, args) => i.decodeFunctionResult(fn, await this.market.provider.call({ to: token, data: i.encodeFunctionData(fn, args) }))[0];
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

  async preview({ walletId, token, side, amount, slippage }) {
    const t = this.market.get(token); if (!t) return null;
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
      } else if (side === 'buy' && t.source === 'agent-curve' && t.market && t.stage === 'curve') {
        // 非 BNB 底池：BNB→报价币用 baw 报价，再用 Portal.quoteBuy 算份额
        const { ethers } = await import('ethers');
        const sq = await baw.marketQuote({ fromTokenQty: trim(amount), fromToken: BNB_NATIVE, toToken: t.quoteAddress, slippage });
        const quoteOut = Number(sq?.toCoinAmount || 0);
        const q = await this.portal.quoteBuy(t.market, w.address, ethers.parseUnits(quoteOut.toFixed(12), 18));
        const out = +ethers.formatEther(q.shares);
        v = { ...base, amountIn: +amount, out, minOut: out * (1 - slippage / 100), quoteOut, feeQuote: +ethers.formatEther(q.fee), feePct: quoteOut ? (+ethers.formatEther(q.fee) / quoteOut) * 100 : null };
      } else if (this.useGangV2(t)) {
        const { ethers } = await import('ethers');
        if (side === 'buy') {
          const q = await this.gangV2.preview({ token: t.address, wallet: w.address, amountBnb: trim(amount) });
          v = { ...base, amountIn: +amount, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: +amount * 0.01, feePct: 1, note: q.refund > 0n ? '接近 1% 上限，多余的报价币会退回' : null };
        } else {
          const bal = await this.gangV2.balanceOf(t.address, w.address); const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
          if (amt <= 0n) return { ...base, note: '没有可卖出的余额' };
          const { c } = await this.gangV2.curve(t.address); const r = this.gangV2.sellQuote(c, amt);
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
      } else if (this.useGwei(t)) {
        if (side === 'buy') {
          const q = await this.gweiTrade.quoteBuy(trim(Math.min(0.1, Number(amount))));
          const room = await this.gweiTrade.walletRoom(w.address);
          v = { ...base, amountIn: +amount, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: q.feeBnb, feePct: 0.1,
            note: Number(amount) > 0.1 ? 'GWEI 单笔最多 0.1 BNB，按 0.1 报价' : q.out > room ? `超过单钱包 1% 上限，还能买 ${room.toFixed(0)} 个` : q.refund > 0n ? `这笔会迁移曲线，多余的 ${q.refundBnb} BNB 同笔退回` : null };
        } else {
          const bal = await this.gweiTrade.balance(w.address);
          const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
          if (amt <= 0n) return { ...base, note: '没有可卖出的余额' };
          const q = await this.gweiTrade.quoteSell(amt);
          v = { ...base, amountIn: Number(amt) / 1e18, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: q.feeBnb, feePct: 0.1, note: '同一个区块买了不能卖，刚买完等几秒' };
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
        const q = await baw.marketQuote({ fromTokenQty: trim(qty), fromToken: side === 'buy' ? BNB_NATIVE : token, toToken: side === 'buy' ? token : BNB_NATIVE, slippage });
        const out = Number(q?.toCoinAmount || 0);
        v = { ...base, amountIn: qty, out, minOut: out * (1 - slippage / 100), feeBnb: null, feePct: this.market.buyFeePct(t) };
      }
      this.quoteCache.set(key, { v, at: Date.now() });
      return v;
    } catch (e) { return { ...base, error: e.message }; }
  }

  async execute({ walletId, token, side, amount, slippage = 20, source = '手动', via = null, clientTs = null }) {
    const t = this.market.get(token);
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId, wallet: this.wallets[0]?.label || 'baw', token, symbol: t?.symbol || '?', platform: t?.platform,
      side, amount: Number(amount), slippage, source, via, status: 'pending', steps: [], dryRun: DRY_RUN || source !== '手动', clientTs };
    this.orders.unshift(order); if (this.orders.length > 300) this.orders.length = 300;
    this.emit('order', order);
    // 每一步记两个时间：ms = 这一步自己的耗时（各模块原来的口径），at = 从服务器收到订单起累计的时间（统一时间线）
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); if (x?.tx) { order.pendingTx = x.tx; order.stage = x.stage || 'broadcast'; } this.emit('order', order); };
    try {
      if (!t) throw new Error('代币不在列表中');
      const w = this.wallet(walletId);
      order.route = this.route(t, side); order.wallet = w.label;

      if (!order.dryRun) {
        // 同一个币有一单还没结束时不再下第二单；钱包被锁（在等 App 确认）时直接说明，不去碰运气
        if (this.inflight.has(t.address)) throw Object.assign(new Error('这个币有一笔订单还在处理中，请勿重复下单'), { code: 'BUSY' });
        if ((await this.lockStatus()) === 'LOCKED') throw new Error('钱包里有一笔交易在等你在币安 App 里确认或拒绝，处理完之前不能下新单（这次没有发出任何交易）');
        this.inflight.add(t.address); order.preMs = Date.now() - order.ts;   // 下单前检查（钱包锁、在途）耗时
        try { return await this.executeReal(order, t, w, step); } finally { this.inflight.delete(t.address); }
      }
      if (side === 'buy') {
        const amt = Number(amount); if (!(amt > 0)) throw new Error('金额无效');
        let r;
        if (side === 'buy' && t.source === 'agent-curve' && t.market && t.stage === 'curve') {
          r = await this.portal.previewBuy({ wallet: w.address, market: t.market, quoteAddress: t.quoteAddress, amountBnb: trim(amt), slippage, step });
        } else if (this.useGwei(t)) {
          const q = await this.gweiTrade.quoteBuy(trim(Math.min(0.1, amt))); step(`GWEI quoteBuy ${q.out.toFixed(0)} 个（只报价）`, 0);
          r = { venue: 'GWEI 曲线 buy（只报价）', expected: q.out };
        } else {
          r = await this.swap({ w, from: BNB_NATIVE, to: t.address, qty: amt, slippage, step });
        }
        return this.finish(order, r, null, { amountIn: amt, out: r.expected });
      }
      if (this.useGwei(t)) {
        const bal = await this.gweiTrade.balance(w.address); const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
        if (amt <= 0n) throw new Error('没有可卖出的余额');
        const q = await this.gweiTrade.quoteSell(amt); step(`GWEI quoteSell ${q.out} BNB（只报价）`, 0);
        return this.finish(order, { venue: 'GWEI 曲线 sell（只报价）', expected: q.out }, null, { amountIn: Number(amt) / 1e18, out: q.out });
      }
      const bal = await this.tokenBal(w, t.address);
      const qty = bal * Math.min(100, Number(amount)) / 100;
      step(`查询余额 ${trim(bal)}`, 0);
      if (!(qty > 0)) throw new Error('没有可卖出的余额');
      const r = await this.swap({ w, from: t.address, to: BNB_NATIVE, qty, slippage, step });
      return this.finish(order, r, null, { amountIn: qty, out: r.expected });
    } catch (e) {
      // 已经提交 / 广播但结果未知：标「待确认」并继续盯，不报失败，避免重复下单
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) {
        if (e.code === 'APP_CONFIRM') this.lockState = { v: 'LOCKED', at: Date.now() };
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: `已提交，正在确认，请勿重复下单：${e.message}`, latencyMs: Date.now() - order.ts });
        this.emit('order', order); this.followUp(order, e);
        return order;
      }
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
      this.emit('order', order);
      return order;
    }
  }

  // 计价币余额：钱包里作为别的盘报价币的 BNCB / GANG / NVDAB / WBNB 等（Flap、Gang V2 买卖中间换出来的），按 baw 实时余额列出
  quoteSet() { return new Set([...Object.values(QUOTE_TOKENS), ...Object.keys(this.market.qUsd || {})].map((a) => a.toLowerCase())); }
  async quoteBalances() {
    const rows = await baw.walletBalance(); const set = this.quoteSet(); const bnbUsd = this.market.bnbUsd || 0;
    return rows.filter((r) => r.address && set.has(String(r.address).toLowerCase()) && Number(r.balance) > 0).map((r) => {
      const usd = Number(r.value || 0) || Number(r.balance) * (this.market.qUsd?.[String(r.address).toLowerCase()] || 0);
      return { token: r.address, symbol: r.symbol, balance: r.balance, priceUsd: Number(r.price || 0) || null, valueUsd: usd, valueBnb: bnbUsd ? usd / bnbUsd : null, wbnb: String(r.address).toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase() };
    }).sort((a, b) => b.valueUsd - a.valueUsd);
  }

  async quoteBal(token) { const r = (await baw.walletBalance({ tokenAddress: token })).find((x) => String(x.address || '').toLowerCase() === token.toLowerCase()); return { balance: Number(r?.balance || 0), symbol: r?.symbol || '?' }; }

  // 换回 BNB 前的报价（按此刻余额）：WBNB 解包 1:1；其他走 baw market-order quote
  async quoteToBnbPreview(token, slippage = 1) {
    if (!this.quoteSet().has(String(token).toLowerCase())) throw new Error('不是计价币');
    const { balance, symbol } = await this.quoteBal(token); if (!(balance > 0)) throw new Error(`钱包里没有 ${symbol}`);
    if (token.toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase()) return { token, symbol, balance, out: balance, minOut: balance, route: 'WBNB.withdraw 解包（1:1，只付 gas）', slippage: 0 };
    const q = await baw.marketQuote({ fromTokenQty: trim(balance), fromToken: token, toToken: BNB_NATIVE, slippage });
    const out = Number(q?.toCoinAmount || 0); const mid = (this.market.qUsd?.[token.toLowerCase()] || 0) * balance / (this.market.bnbUsd || 1);
    return { token, symbol, balance, out, minOut: out * (1 - slippage / 100), route: 'baw market-order（币安聚合路由）', slippage, midBnb: mid || null };
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
      if (!this.quoteSet().has(String(token).toLowerCase())) throw new Error('不是计价币');
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
          const bal = await this.market.provider.call({ to: token, data: new ethers.Interface(['function balanceOf(address) view returns (uint256)']).encodeFunctionData('balanceOf', [w.address]) }).then((x) => BigInt(x));
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

  // 待确认订单的后续：有 txHash 就等回执（最多 10 分钟）；在等 App 确认的，等钱包解锁后再看结果
  async followUp(order, e) {
    const end = Date.now() + 10 * 60_000;
    const done = (status, reason, tx) => { Object.assign(order, { status, reason, tx: tx || order.tx, stage: null }); this.quoteCache.clear(); this.refreshBalance(); this.syncAt = 0; this.emit('order', order); };
    if (e.tx || order.pendingTx) {
      const tx = e.tx || order.pendingTx;
      while (Date.now() < end) { const rc = await this.market.provider.getTransactionReceipt(tx).catch(() => null); if (rc) return done(rc.status === 1 ? 'filled' : 'failed', rc.status === 1 ? '已上链确认' : `链上执行失败：${tx}`, tx); await sleep(3000); }
      return done('unknown', `10 分钟内没等到确认，请在钱包记录里查看：${tx}`, tx);
    }
    while (Date.now() < end) { if ((await baw.walletLock().catch(() => 'UNKNOWN')) !== 'LOCKED') break; await sleep(10_000); }
    done('unknown', e.code === 'APP_CONFIRM' ? '币安 App 里的确认已处理（同意或拒绝），结果请看持仓 / 钱包记录' : '结果未知，请在持仓 / 钱包记录里查看，不要直接重下');
  }

  // 真实下单（只由手动订单进入）。曲线阶段的 Flap Agent 盘走 Portal；其余走 baw market-order。
  async executeReal(order, t, w, step) {
    const { side, slippage } = order;
    const p = this.pos(w.id, t.address);
    let r;
    if (side === 'buy') {
      const amt = order.amount;
      if (!(amt > 0)) throw new Error('金额无效');
      if (this.status.auth.state !== 'ok') throw new Error('币安钱包未登录，请在终端运行 baw auth signin');
      const cap = this.status.maxTradeBnb;
      if (cap > 0 && amt > cap) throw new Error(`单笔上限 ${cap} BNB（可在交易设置里修改）`);
      // BNB 余额用后台每 20 秒刷新的缓存；超过 30 秒没刷新才当场查
      if (!this.balAt || Date.now() - this.balAt > 30_000) { const t0 = Date.now(); await this.refreshBalance(); step('检查 BNB 余额（baw）', Date.now() - t0); }
      if (w.bnb && amt > w.bnb) throw new Error(`BNB 余额不足（${w.bnb.toFixed(4)}）`);
      r = this.useGangV2(t) ? await this.gangV2.buy({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step })
        : this.useGang(t) ? await this.gangTrade.buy({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step })
        : this.useGwei(t) ? await this.gweiTrade.buy({ wallet: w.address, amountBnb: trim(amt), slippage, step })
        : this.useOpenFour(t) ? await this.openFourBuy({ w, t, amt, slippage, step })
        : this.usePortal(t, 'buy')
        ? await this.portal.buy({ wallet: w.address, market: t.market, quoteAddress: t.quoteAddress, quoteSym: t.quote, amountBnb: trim(amt), slippage, step })
        : await this.swapReal({ from: BNB_NATIVE, to: t.address, qty: amt, slippage, step, label: `BNB→${t.symbol}` });
      if (!p.openedAt) p.openedAt = Date.now();
      p.boughtBnb += amt; p.costBnb += amt; p.amount += r.expected || 0;
      Object.assign(order, { amountIn: amt, out: r.expected });
    } else {
      const pct = Math.min(100, order.amount);
      if (this.status.auth.state !== 'ok') throw new Error('币安钱包未登录，请在终端运行 baw auth signin');
      if (this.useGangV2(t)) {
        r = await this.gangV2.sell({ wallet: w.address, token: t.address, pct, slippage, step, toBnb: this.settings.sellToBnb });
      } else if (this.useGang(t)) {
        r = await this.gangTrade.sell({ wallet: w.address, token: t.address, pct, slippage, step });
      } else if (this.useGwei(t)) {
        r = await this.gweiTrade.sell({ wallet: w.address, pct, slippage, step });
      } else if (this.useOpenFour(t)) {
        r = await this.openFourSell({ w, t, pct, slippage, step });
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
        try { r = await this.swapReal({ from: t.address, to: BNB_NATIVE, qty, slippage, step, label: `${t.symbol}→BNB` }); }
        catch (e) { if (/insufficient|balance/i.test(e.message)) throw new Error(`钱包里的 ${t.symbol} 余额不足（实际 ${trim(bal)} 个）：${e.message}`); throw e; }
      }
      p.soldBnb += r.expected || 0; p.amount = Math.max(0, p.amount * (1 - pct / 100));
      Object.assign(order, { amountIn: pct, out: r.expected });
    }
    Object.assign(order, { status: 'filled', dryRun: false, venue: r.venue, tx: r.txHash, txs: r.hashes, reason: r.note || null, latencyMs: Date.now() - order.ts });
    this.quoteCache.clear(); this.refreshBalance();
    this.emit('order', order);
    if (PREAPPROVE && side === 'buy' && this.useOpenFour(t)) setTimeout(() => this.preApprove(t, w).catch(() => {}), 0);
    return order;
  }

  // 买入成交后后台预授权：把代币 max 授权给卖出要用的合约（OpenFour 内盘 = Core），卖出时就不用再等授权。
  // Flap Portal 卖的是曲线份额不需要授权；外盘走 baw market-order，由 baw 自己处理，所以这里只处理 OpenFour。
  async preApprove(t, w) {
    const key = t.address.toLowerCase();
    if (this.preapproving.has(key)) return;
    this.preapproving.add(key);
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w.id, wallet: w.label, token: t.address, symbol: t.symbol, platform: t.platform,
      side: 'approve', amount: 0, source: '预授权', via: 'preapprove', status: 'pending', steps: [], dryRun: false, route: 'OpenFour Core 预授权（max）' };
    const step = (name, ms) => { order.steps.push({ name, ms: Math.round(ms) }); };
    try {
      const t0 = Date.now();
      const i = await openFour.info(t.address, w.address);
      const core = i?.contracts?.core;
      if (!core) throw new Error('没拿到 Core 地址');
      const erc = new ethers.Contract(t.address, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], this.market.provider);
      const cur = await erc.allowance(w.address, core);
      step(`查询授权 ${cur > 0n ? '已有' : '0'}`, Date.now() - t0);
      if (cur >= ethers.MaxUint256 / 2n) { this.preapproving.delete(key); return; }   // 已足够，不发交易、不记录
      this.orders.unshift(order); this.emit('order', order);
      const hash = await this.portal.send({ wallet: w.address, to: t.address, inputData: erc.interface.encodeFunctionData('approve', [core, ethers.MaxUint256]), label: `授权 ${t.symbol}`, step });
      Object.assign(order, { status: 'filled', tx: hash, txs: [hash], venue: 'approve(Core, max)', latencyMs: Date.now() - order.ts });
    } catch (e) {
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
      if (!this.orders.includes(order)) this.orders.unshift(order);
    } finally { this.preapproving.delete(key); }
    this.emit('order', order);
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
      // 打开了「领取后自动转出」：给这个币挂上已确认的转出规则，由 ruleTick 负责转账（重试、钱包锁、记录哈希）
      if (AUTO_TRANSFER_TO && this.settings.autoSendAfterClaim && t?.address) {
        const k = t.address.toLowerCase(), ex = this.rules()[k];
        if (ex) { ex.to ||= AUTO_TRANSFER_TO; if (ex.transfer !== 'off') ex.transfer = 'armed'; ex.state ||= {}; ex.state.claimedAt ||= Date.now(); ex.state.claimTx ||= r.txHash; this.ruleLog(ex, '领取成功，按「领取后自动转出」设置转出'); this.rulesSave(); }
        else { this.setRule(k, { claim: true, to: AUTO_TRANSFER_TO, transfer: 'armed', auto: true, state: { claimedAt: Date.now(), claimTx: r.txHash } }); }
      }
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
    const q = openFour.checkQuote(await openFour.quoteBuy(t.address, w.address, trim(amt), Math.round(slippage * 100)));
    step(`OpenFour 报价 ${Number(q.estimate.tokenAmount).toFixed(0)} ${t.symbol}（至少 ${Number(q.minTokenOut).toFixed(0)}）`, Date.now() - t0);
    if (q.estimate.budgetNotFullyUsed) step('接近 1% 持仓上限，只花掉部分 BNB，多余的同笔退回', 0);
    if (q.approveTx) throw new Error('需要先授权报价币，本版只支持用 BNB 买');
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

  async swapReal({ from, to, qty, slippage, step, label }) {
    const t0 = Date.now();
    const sw = await baw.marketSwap({ fromTokenQty: typeof qty === 'string' ? qty : trim(qty), fromToken: from, toToken: to, slippage });   // 字符串 = 精确数量，原样传
    if (!sw.orderId) throw new Error(`${label} 没有返回 orderId`);
    step(`${label} 已提交 ${sw.orderId}`, Date.now() - t0);
    const o = await baw.pollOrder(sw.orderId);
    if (o?.status !== 'FINISHED') throw Object.assign(new Error(`${label} ${o?.status === 'FAILED' ? '失败' : '仍在处理，请稍后在钱包里查看'}（订单 ${sw.orderId}）`), o?.status === 'FAILED' ? {} : { code: 'UNCONFIRMED', tx: o?.txHash || null });   // 没失败也没完成 = 已提交、结果未知，按待确认跟踪
    const refund = Array.isArray(o.refund) && o.refund.length ? `；部分成交，退回 ${o.refund.map((x) => `${x.amount} ${x.symbol}`).join('、')}` : '';
    step(`${label} 完成${refund}`, Date.now() - t0);
    return { venue: 'baw market-order', expected: Number(o.toTokenActualQty || 0), txHash: o.txHash || null, hashes: [o.txHash].filter(Boolean), note: refund ? refund.slice(1) : null };
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
      const value = p.amount * (t.price || 0);
      if (p.amount > 0) p.peak = Math.max(p.peak, t.price || 0);
      out.push({ ...p, symbol: t.symbol, platform: t.platform, image: t.image || null, stage: t.stage, price: t.price, valueBnb: value, valueUsd: value * this.market.bnbUsd,
        pnlBnb: value + p.soldBnb - p.boughtBnb, pnlPct: p.costBnb > 0 && t.price ? ((value - p.costBnb) / p.costBnb) * 100 : 0,
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

const trim = (n) => Number(n).toFixed(18).replace(/\.?0+$/, '') || '0';
