// gang.fun V2 盘（报价币盘：WBNB / GANG / NVDAB / BNCB / ZEC…）内盘买卖，支持 V2 0x1B8F…966E 以及同接口的 U / S 两个 pad：
//   buy(token, quoteIn, minTokensOut) / sell(token, tokensIn, minQuoteOut)，买卖都用报价币（ERC20），1% 平台费
// 依据：站上真实交易 0xa59ac6dd（buy）/ 0x6a272462（sell）解码；报价公式照官方 gang CLI 的 LaunchpadV2 曲线（_prepBuy / _quoteOut），
// 并用状态覆盖的 eth_call 核对过：帮派（U pad）、YAYA（V2）、GANGSTER（U pad）公式结果与合约返回完全一致。
// 买：BNB →（WBNB 盘用 deposit 包装，其他用 baw 市价单换）报价币 → 授权本次数量 → buy；卖：授权本次数量 → sell → 报价币换回 BNB。非原子，2～3 笔交易。
import { ethers } from 'ethers';
import * as baw from './baw.js';
import { capFor, capLabel, sendApproval } from './approvals.js';
import { BNB_NATIVE } from './config.js';
import { getRoute, setRoute, waitReceived } from './quoteRoutes.js';
import { V3_PADS, isV3Pad, v3PadAbi, normCurve, assertV3Trade, v3Pending } from './gangV3.js';   // Gang V3：曲线公式、buy / sell 和 V2 相同，curves() 多两个字段

export const V2_PADS = ['0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb', '0x60aee38576035E757deD30fF8db8A8DA476430C1'];
const trimBnb = (n) => Number(n).toFixed(18).replace(/\.?0+$/, '') || '0';
const USDT = '0x55d398326f99059fF775485246999027B3197955';   // BSC USDT（18 位小数）
const ONDO_RE = /one side must be a supported stablecoin|Unsupported token pair for Ondo/i;
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const pad = new ethers.Interface([
  'function buy(address token, uint256 quoteIn, uint256 minTokensOut) returns (uint256)',
  'function sell(address token, uint256 tokensIn, uint256 minQuoteOut) returns (uint256)',
  'function curves(address) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, bool taxed, address pair, address refPair)',
  'function walletRoom(address token, address buyer) view returns (uint256)',
]);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function deposit() payable', 'function withdraw(uint256)']);
const VT = 1066666666666666666666666667n, BPS = 10000n, FEE = 100n;   // LaunchpadV2 常量：虚拟代币储备、1% 平台费
const ceil = (a, b) => (b === 0n ? 0n : (a + b - 1n) / b);
const minOut = (v, slip) => (v * BigInt(10000 - Math.min(9900, Math.round(slip * 100)))) / 10000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWbnb = (a) => !a || a === ethers.ZeroAddress || a.toLowerCase() === WBNB.toLowerCase();

export class GangV2 {
  constructor(provider, send) { this.provider = provider; this.send = send; this.pads = new Map(); this.slots = new Map(); }

  async call(to, i, fn, args, from) { return i.decodeFunctionResult(fn, await this.provider.call({ to, from, data: i.encodeFunctionData(fn, args) })); }

  // 这个币在哪个 pad 上（creator ≠ 0 的那个），带曲线状态
  async curve(token) {
    const p = this.pads.get(token.toLowerCase());
    const tryPad = async (a) => {
      if (isV3Pad(a)) { const c = await this.call(a, v3PadAbi, 'curves', [token]).catch(() => null); return c && c.creator !== ethers.ZeroAddress ? normCurve(c) : null; }   // V3：c.v3 = 买卖税 / 分红比例
      const c = await this.call(a, pad, 'curves', [token]).catch(() => null); return c && c.creator !== ethers.ZeroAddress ? c : null;
    };
    if (p) { const c = await tryPad(p); if (c) return { pad: p, c }; }
    for (const a of [...V2_PADS, ...V3_PADS]) { const c = await tryPad(a); if (c) { this.pads.set(token.toLowerCase(), a); return { pad: a, c }; } }
    if (await v3Pending().then((r) => r.some(Boolean))) for (const a of V3_PADS) { const c = await tryPad(a); if (c) { this.pads.set(token.toLowerCase(), a); return { pad: a, c }; } }   // 刚核对完的新内盘
    // V3 内盘上的「打新」币（kindOf = 2）没有曲线：固定价认购，本工具不做
    for (const a of V3_PADS) { const k = await this.call(a, v3PadAbi, 'kindOf', [token]).then((x) => x[0]).catch(() => 0n); if (k === 2n) throw Object.assign(new Error('这是 Gang V3「打新」币（固定价认购，不是曲线），暂不支持在这里买卖，请到 gang.fun 操作'), { code: 'V3_FAIR' }); }
    throw new Error('不是 gang.fun V2 / V3 合约上的代币');
  }

  quoteToken(c) { return isWbnb(c.quote) ? WBNB : c.quote; }
  // 已毕业（迁移到 PancakeSwap）的盘内盘不能再买卖：直接报 MIGRATED，交给上层改走外盘（liveTrader.checkMigrated）
  notGraduated(c) { if (c.graduated) throw Object.assign(new Error('这个盘已发射到 PancakeSwap，内盘不能再买卖'), { code: 'MIGRATED', pair: c.pair }); return c; }

  // 买入报价（和合约 _prepBuy 一样的算法）：quoteIn 报价币 → 能拿到多少代币；到 1% 上限 / 毕业门槛时只花一部分，其余退回
  buyQuote(c, quoteIn, room) {
    const vq = BigInt(c.virtualQuote), sold = BigInt(c.sold), raised = BigInt(c.realQuote), grad = BigInt(c.gradAmt);
    const k = vq * VT, qR = vq + raised, tR = VT - sold;
    const out = (net) => tR - ceil(k, qR + net), inFor = (tok) => ceil(k, tR - tok) - qR;
    const refee = (gross, net) => { let sg = ceil(net * BPS, BPS - FEE); if (sg > gross) sg = gross; const fee = (sg * FEE) / BPS; return { fee, net: sg - fee, refund: gross - sg }; };
    let fee = (quoteIn * FEE) / BPS, net = quoteIn - fee, refund = 0n;
    const left = grad > raised ? grad - raised : 0n;
    if (net > left) ({ fee, net, refund } = refee(quoteIn, left));
    let tokens = out(net);
    if (room != null && tokens > room) { tokens = room; ({ fee, net, refund } = refee(quoteIn, inFor(room))); }
    return { tokens, fee, refund, spent: quoteIn - refund };
  }

  sellQuote(c, tokensIn) {
    const vq = BigInt(c.virtualQuote), sold = BigInt(c.sold), raised = BigInt(c.realQuote);
    const k = vq * VT, out = vq + raised - ceil(k, VT - sold + tokensIn), fee = (out * FEE) / BPS;
    return { out: out - fee, fee };
  }

  async room(token, wallet) { const { pad: p } = await this.curve(token); return (await this.call(p, pad, 'walletRoom', [token, wallet]))[0]; }
  async balanceOf(token, wallet) { return (await this.call(token, erc20, 'balanceOf', [wallet]))[0]; }
  async decimals(token) { return Number((await this.call(token, erc20, 'decimals', []).catch(() => [18n]))[0]); }

  // 有的报价币（Ondo 代币化股票，如 FXIon）币安只允许和稳定币直接兑换：BNB↔报价币要经过 USDT 两步。按币缓存判断结果
  async needsUsdt(q) {
    this.viaUsdt ||= new Map(); const k = String(q).toLowerCase();
    if (isWbnb(q) || k === USDT.toLowerCase()) return false;
    if (this.viaUsdt.has(k)) return this.viaUsdt.get(k);
    const saved = getRoute(k); if (saved?.buy) { const v = saved.buy === 'via_USDT'; this.viaUsdt.set(k, v); return v; }   // 路线表（data/quote-routes.json）
    try { await baw.marketQuote({ fromTokenQty: '0.01', fromToken: BNB_NATIVE, toToken: q }); this.viaUsdt.set(k, false); setRoute(k, { buy: 'direct', sell: 'direct' }); return false; }
    catch (e) { if (ONDO_RE.test(e.message)) { this.viaUsdt.set(k, true); setRoute(k, { buy: 'via_USDT', sell: 'via_USDT', note: '只能和稳定币直接兑换（Ondo 类）' }); return true; } return false; }   // 其他错误（网络等）不缓存
  }
  // 一笔 baw 兑换并等到完成；返回到账数量（按链上余额差）
  async swapWait({ wallet, from, to, qty, slippage, step, label }) {
    const t0 = Date.now(), before = to === BNB_NATIVE ? null : await this.balanceOf(to, wallet);
    const sw = await baw.marketSwap({ fromTokenQty: String(qty), fromToken: from, toToken: to, slippage });
    if (!sw.orderId) throw new Error(`${label} 没有返回 orderId`);
    step(`${label} 已提交 ${sw.orderId}`, Date.now() - t0);
    if (before == null) { const o = await baw.pollOrder(sw.orderId); if (o?.status !== 'FINISHED') throw new Error(`${label}${o?.status === 'FAILED' ? '失败' : '未完成'}（订单 ${sw.orderId}），后续步骤没有执行`); return { o, got: null }; }
    const r = await this.waitArrival({ orderId: sw.orderId, token: to, wallet, before, label });
    return { o: r.o, got: r.got };
  }

  // 等兑换到账：链上余额和 baw 订单状态同时看，余额先到就直接往下走。baw 每查一次订单要起一个进程（约 0.5 秒），
  // 订单状态常常比链上余额晚 1～3 秒；余额没动时照旧以订单 FAILED / 超时为准，后续步骤不执行
  async waitArrival({ orderId, token, wallet, before, label }) {
    let o = null, done = false;
    const ord = baw.pollOrder(orderId).then((r) => { o = r; done = true; return r; }, () => { done = true; return null; });
    for (const t0 = Date.now(); Date.now() - t0 < 60_000;) {
      const got = (await this.balanceOf(token, wallet).catch(() => before)) - before;
      if (got > 0n) return { o: o || { status: 'FINISHED', orderId, txHash: null }, got };
      if (done) break;
      await sleep(300);
    }
    await ord;
    if (o?.status !== 'FINISHED') throw new Error(`${label}${o?.status === 'FAILED' ? '失败' : '未完成'}（订单 ${orderId}），后续步骤没有执行`);
    let got = 0n; for (let i = 0; i < 34; i++) { got = (await this.balanceOf(token, wallet)) - before; if (got > 0n) break; await sleep(300); }   // 到账一般 1 秒内，300ms 查一次（最多约 10 秒）
    if (got <= 0n) throw new Error(`${label} 没有到账，停止后续步骤`);
    return { o, got };
  }

  // BNB 金额 → 大约能换到多少报价币（WBNB 1:1，其他用 baw 报价；Ondo 类经过 USDT 两步报价）
  async bnbToQuote(q, amountBnb) {
    if (isWbnb(q)) return ethers.parseEther(String(amountBnb));
    const dec = await this.decimals(q);
    if (await this.needsUsdt(q)) {
      const u = await baw.marketQuote({ fromTokenQty: String(amountBnb), fromToken: BNB_NATIVE, toToken: USDT });
      const r = await baw.marketQuote({ fromTokenQty: Number(u?.toCoinAmount || 0).toFixed(6), fromToken: USDT, toToken: q });
      return ethers.parseUnits(Number(r?.toCoinAmount || 0).toFixed(Math.min(12, dec)), dec);
    }
    const r = await baw.marketQuote({ fromTokenQty: String(amountBnb), fromToken: BNB_NATIVE, toToken: q });
    return ethers.parseUnits(Number(r?.toCoinAmount || 0).toFixed(Math.min(12, dec)), dec);
  }

  // 报价用：1 BNB 能换多少报价币，按币缓存 8 秒。「买总量 X%」要反复试算好几次，以前每次都调 baw 报价（USDT 中转还要两次），下单前就要等 4～8 秒；
  // 真实下单时的兑换照样按实时数量走，不用这个缓存
  // 超过 8 秒但不到 stale 的旧汇率先拿来用，同时后台刷新：隔一会儿再点「买 1%」时不用再冷等 baw 报价（以前约 4 秒）。
  // 汇率只用来估算该花多少 BNB，成交数量仍由链上报价 + 滑点保护决定
  async quoteRate(q, { stale = 60_000 } = {}) {
    this.rateCache ||= new Map(); this.rateJobs ||= new Map();
    const k = String(q).toLowerCase(), hit = this.rateCache.get(k), age = hit ? Date.now() - hit.at : Infinity;
    if (age < 8_000) return hit.rate;
    const refresh = () => this.rateJobs.get(k) || (() => {
      const job = (async () => { const dec = await this.decimals(q), one = await this.bnbToQuote(q, 0.1); const rate = Number(ethers.formatUnits(one, dec)) / 0.1; this.rateCache.set(k, { rate, at: Date.now(), dec }); return rate; })()
        .finally(() => this.rateJobs.delete(k));
      this.rateJobs.set(k, job); return job;
    })();
    if (age < stale) { refresh().catch(() => {}); return hit.rate; }
    return refresh();
  }

  async preview({ token, wallet, amountBnb }) {
    // 「买总量 X%」要连着试算好几次：曲线状态 / 剩余额度 / 小数位 2 秒内复用，不再每次重新读链（每次约 0.5 秒，6 次就是 3 秒）。真实下单不走这里
    this.pvCache ||= new Map(); const key = `${token}|${wallet}`.toLowerCase(); let s = this.pvCache.get(key);
    if (!s || Date.now() - s.at > 2_000) {
      const { c } = await this.curve(token); this.notGraduated(c); const q = this.quoteToken(c);
      const [dec, room] = await Promise.all([this.decimals(q), this.room(token, wallet).catch(() => null)]);
      s = { c, q, dec, room, at: Date.now() }; this.pvCache.set(key, s);
    }
    const { c, q, dec } = s;
    const quoteIn = isWbnb(q) ? ethers.parseEther(String(amountBnb)) : ethers.parseUnits((amountBnb * await this.quoteRate(q)).toFixed(Math.min(12, dec)), dec);
    const r = this.buyQuote(c, quoteIn, s.room);
    return { quote: q, quoteIn, ...r, out: Number(ethers.formatEther(r.tokens)), feePct: 1 };
  }

  // 找报价币 balance / allowance 的存储槽，用来做「假装有余额和授权」的 eth_call 模拟（不用真的持有报价币）
  async findSlots(token, owner, spender) {
    const key = token.toLowerCase(); if (this.slots.has(key)) return this.slots.get(key);
    const enc = ethers.AbiCoder.defaultAbiCoder(), big = ethers.toBeHex(10n ** 30n, 32); let bal = null, alw = null;
    for (let s = 0; s < 30 && (bal == null || alw == null); s++) {
      const bk = ethers.keccak256(enc.encode(['address', 'uint256'], [owner, s]));
      const ak = ethers.keccak256(enc.encode(['address', 'bytes32'], [spender, ethers.keccak256(enc.encode(['address', 'uint256'], [owner, s]))]));
      const ov = (k) => ({ [token]: { stateDiff: { [k]: big } } });
      if (bal == null) { const r = await this.provider.send('eth_call', [{ to: token, data: erc20.encodeFunctionData('balanceOf', [owner]) }, 'latest', ov(bk)]).catch(() => null); if (r && BigInt(r) === 10n ** 30n) bal = s; }
      if (alw == null) { const r = await this.provider.send('eth_call', [{ to: token, data: erc20.encodeFunctionData('allowance', [owner, spender]) }, 'latest', ov(ak)]).catch(() => null); if (r && BigInt(r) === 10n ** 30n) alw = s; }
    }
    const v = bal != null && alw != null ? { bal, alw } : null; this.slots.set(key, v); return v;
  }

  // 用状态覆盖模拟买入：假设钱包已经有 quoteIn 的报价币并且已授权，返回合约实际给出的代币数
  async simulateBuy({ token, wallet, quoteIn, minTokens }) {
    const { pad: p, c } = await this.curve(token); const q = this.quoteToken(c);
    const sl = await this.findSlots(q, wallet, p); if (!sl) return { ok: null, note: '找不到报价币的存储槽，无法覆盖模拟' };
    const enc = ethers.AbiCoder.defaultAbiCoder();
    const bk = ethers.keccak256(enc.encode(['address', 'uint256'], [wallet, sl.bal]));
    const ak = ethers.keccak256(enc.encode(['address', 'bytes32'], [p, ethers.keccak256(enc.encode(['address', 'uint256'], [wallet, sl.alw]))]));
    const val = ethers.toBeHex(quoteIn * 2n, 32);
    try {
      const r = await this.provider.send('eth_call', [{ from: wallet, to: p, data: pad.encodeFunctionData('buy', [token, quoteIn, minTokens]) }, 'latest', { [q]: { stateDiff: { [bk]: val, [ak]: val } } }]);
      return { ok: true, tokens: pad.decodeFunctionResult('buy', r)[0] };
    } catch (e) { return { ok: false, error: e.info?.error?.message || e.shortMessage || e.message }; }
  }

  async ensureAllowance({ wallet, token, spender, amount, label, step, kind = 'quote', symbol = '' }) {
    if ((await this.call(token, erc20, 'allowance', [wallet, spender]))[0] >= amount) { step('授权额度够用，跳过授权', 0); return null; }
    const cap = await capFor({ token, wallet, amount, kind });
    const h = await sendApproval({ send: (o) => this.send(o), wallet, token, spender, amount, cap, label: `${label.replace(/（本次数量）/, '')}（${capLabel(kind)}）`, symbol, kind, step });
    for (let i = 0; i < 20; i++) { if ((await this.call(token, erc20, 'allowance', [wallet, spender]))[0] >= amount) break; await sleep(1000); }
    return h;
  }

  // 真实买入：先拿报价币（已有足够的就直接用）→ 授权 → 报价 + 模拟 → buy
  // payQuote：BNB 不够、改用钱包里现有报价币直接付时的报价币数量（liveTrader.fundingPlan 算的），不再换 BNB
  async buy({ wallet, token, amountBnb, slippage, step, payQuote = null }) {
    const { pad: p, c } = await this.curve(token); this.notGraduated(c); if (c.v3) assertV3Trade();   // V3 默认只报价
    const q = this.quoteToken(c); const hashes = [];
    // 并行读（狙击要快）：小数位、报价币余额、授权额度、剩余额度一次读完；钱包里报价币够用时后面不再重读曲线
    const [dec, have0, alw0, room0] = await Promise.all([isWbnb(q) ? 18 : this.decimals(q), this.balanceOf(q, wallet), this.call(q, erc20, 'allowance', [wallet, p]).then((x) => x[0]).catch(() => 0n), this.call(p, pad, 'walletRoom', [token, wallet]).then((x) => x[0]).catch(() => null)]);
    const qSym = isWbnb(q) ? 'WBNB' : '报价币'; let fresh = true;
    // 只用来判断钱包里现有报价币够不够（够就直接用这么多）；不够时下面按实际到账数量买。用 30 秒内的汇率，省掉 1～2 次 baw 报价
    let need = isWbnb(q) ? ethers.parseEther(String(amountBnb)) : ethers.parseUnits((amountBnb * await this.quoteRate(q, { stale: 30_000 })).toFixed(Math.min(12, dec)), dec);
    const have = have0;
    if (payQuote != null) { const want = ethers.parseUnits(Number(payQuote).toFixed(Math.min(12, dec)), dec); need = want < have ? want : have; if (need <= 0n) throw new Error('钱包里没有这个盘的报价币'); }
    // 不超过这个钱包剩余额度（每个钱包最多 1%）要花的报价币，多留 2% 抵价格变动：「买 1%」直接给 0.1 BNB 时不会多换报价币；额度已满就不发任何交易
    if (room0 === 0n) throw new Error('已达单钱包上限 1%（没有发出交易）');
    if (room0 != null && payQuote == null) { const sp = this.buyQuote(c, need, room0).spent * 102n / 100n; if (sp > 0n && sp < need) { amountBnb = Number(amountBnb) * Number(sp) / Number(need); need = sp; } }
    if (have < need) {
      // 钱包里已有的报价币先用上，只把差额用 BNB 换；多换 3% 抵滑点，多的留在钱包
      const before = have; const t0 = Date.now(); fresh = false;
      const short = Number(amountBnb) * Number(need - have) / Number(need), shortBnb = trimBnb(Math.min(Number(amountBnb), isWbnb(q) ? short : short * 1.03));
      if (have > 0n) step(`钱包里有 ${ethers.formatUnits(have, dec)} ${qSym}，不够 ${ethers.formatUnits(need, dec)}，用 ${shortBnb} BNB 换差额`, 0);
      if (isWbnb(q)) hashes.push(await this.send({ wallet, to: WBNB, valueWei: ethers.parseEther(shortBnb), inputData: erc20.encodeFunctionData('deposit', []), label: 'BNB→WBNB 包装', step }));
      else if (await this.needsUsdt(q)) {   // Ondo 类报价币：BNB→USDT→报价币
        const a = await this.swapWait({ wallet, from: BNB_NATIVE, to: USDT, qty: shortBnb, slippage, step, label: 'BNB→USDT' }); if (a.o.txHash) hashes.push(a.o.txHash);
        const b = await this.swapWait({ wallet, from: USDT, to: q, qty: ethers.formatUnits(a.got, 18), slippage, step, label: 'USDT→报价币' }); if (b.o.txHash) hashes.push(b.o.txHash);
      } else {
        const sw = await baw.marketSwap({ fromTokenQty: shortBnb, fromToken: BNB_NATIVE, toToken: q, slippage });
        if (!sw.orderId) throw new Error('BNB→报价币兑换没有返回 orderId');
        step(`BNB→报价币 已提交 ${sw.orderId}`, Date.now() - t0);
        const { o } = await this.waitArrival({ orderId: sw.orderId, token: q, wallet, before, label: 'BNB→报价币兑换' });
        if (o.txHash) hashes.push(o.txHash);
      }
      let got = 0n; for (let i = 0; i < 34; i++) { got = (await this.balanceOf(q, wallet)) - before; if (got > 0n) break; await sleep(300); }
      if (got <= 0n) throw new Error('报价币没有到账，停止后续步骤');
      need = have + got; step(`收到 ${ethers.formatUnits(got, dec)} ${qSym}`, Date.now() - t0);
    } else step(`钱包里已有足够${qSym}，直接使用 ${ethers.formatUnits(need, dec)}`, 0);
    if (fresh && alw0 >= need) step('授权额度够用，跳过授权', 0);
    else { const ap = await this.ensureAllowance({ wallet, token: q, spender: p, amount: need, label: `授权${qSym}`, step, kind: 'quote', symbol: qSym }); if (ap) hashes.push(ap); fresh = false; }
    // 没有包装 / 换币 / 授权（几百毫秒内）就直接用开头读的曲线和额度；否则重读。数量偏差由滑点保护兜底，下面还有链上模拟
    const [{ c: c2 }, room] = fresh ? [{ c }, room0] : await Promise.all([this.curve(token), this.call(p, pad, 'walletRoom', [token, wallet]).then((x) => x[0]).catch(() => null)]);
    const r = this.buyQuote(c2, need, room);
    if (r.tokens <= 0n) throw new Error('报价为 0：可能已到每个钱包 1% 上限，或盘已毕业');
    const data = pad.encodeFunctionData('buy', [token, need, minOut(r.tokens, slippage)]);
    try { await this.provider.call({ from: wallet, to: p, data }); } catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}`); }
    hashes.push(await this.send({ wallet, to: p, inputData: data, label: c.v3 ? 'Gang V3 buy' : 'Gang V2 buy', step, waitConfirm: false }));
    return { venue: `Gang V2 · BNB→${qSym}→buy（非原子）`, expected: Number(ethers.formatEther(r.tokens)), txHash: hashes.at(-1), hashes };
  }

  // 真实卖出：授权代币（本次数量）→ sell → 收到的报价币换回 BNB（WBNB 直接解包）
  async sell({ wallet, token, pct, slippage, step, toBnb = true }) {
    const { pad: p, c } = await this.curve(token); this.notGraduated(c); if (c.v3) assertV3Trade(); const q = this.quoteToken(c); const hashes = [];
    const bal = await this.balanceOf(token, wallet); if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
    const ap = await this.ensureAllowance({ wallet, token, spender: p, amount: amt, label: '授权卖出', step, kind: 'sell' }); if (ap) hashes.push(ap);
    const { c: c2 } = await this.curve(token); const r = this.sellQuote(c2, amt);
    const data = pad.encodeFunctionData('sell', [token, amt, minOut(r.out, slippage)]);
    try { await this.provider.call({ from: wallet, to: p, data }); } catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}`); }
    const before = await this.balanceOf(q, wallet);
    try { hashes.push(await this.send({ wallet, to: p, inputData: data, label: c.v3 ? 'Gang V3 sell' : 'Gang V2 sell', step })); }
    catch (e) {
      // 卖出那笔要在币安 App 里确认（或已提交、结果未知）：报价币要等确认后才到账。交给上层 followUp 在确认后接着换回 BNB；
      // 以前这里直接抛出，换回 BNB 那一步就被跳过了，GANG / WBNB / BNCB 留在钱包里
      const fromBlock = toBnb ? await this.provider.getBlockNumber().then((b) => b - 2).catch(() => undefined) : null;
      if (toBnb && ['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) e.afterConfirm = async (log) => {
        const got = await waitReceived({ provider: this.provider, token: q, wallet, senders: [p], fromBlock });
        if (got <= 0n) return { note: '5 分钟内没收到报价币（可能在 App 里拒绝了），没有换回 BNB' };
        log(`收到报价币 ${ethers.formatUnits(got, await this.decimals(q))}，接着换回 BNB`, 0);
        return this.swapBack({ wallet, q, got, slippage, step: log, hashes: [] });
      };
      throw e;
    }
    let got = 0n; for (let i = 0; i < 34; i++) { got = (await this.balanceOf(q, wallet)) - before; if (got > 0n) break; await sleep(300); }
    if (!toBnb || got <= 0n) return { venue: 'Gang V2 sell', expected: null, txHash: hashes.at(-1), hashes, note: got > 0n ? `已卖出得到报价币 ${ethers.formatUnits(got, await this.decimals(q))}（「卖出后自动换回 BNB」已关闭，留在钱包）` : '已卖出，没读到报价币到账' };
    return this.swapBack({ wallet, q, got, slippage, step, hashes });
  }

  // 卖出到账的报价币换回 BNB：WBNB 直接解包；其他用 baw（Ondo 类经 USDT），失败最多再试 2 次
  async swapBack({ wallet, q, got, slippage, step, hashes }) {
    if (isWbnb(q)) { hashes.push(await this.send({ wallet, to: WBNB, inputData: erc20.encodeFunctionData('withdraw', [got]), label: 'WBNB→BNB 解包', step })); return { venue: 'Gang V2 sell → BNB', expected: Number(ethers.formatEther(got)), txHash: hashes.at(-1), hashes }; }
    const dec = await this.decimals(q);
    // 第二步：只换这次卖出实际到账的报价币（链上余额差，整数），失败最多再试 2 次
    let o = null, usdtGot = null;
    for (let k = 0; k < 3; k++) {
      try {
        if (await this.needsUsdt(q)) {   // Ondo 类：报价币→USDT→BNB
          if (usdtGot == null) { const a = await this.swapWait({ wallet, from: q, to: USDT, qty: ethers.formatUnits(got, dec), slippage, step, label: '报价币→USDT' }); if (a.o.txHash) hashes.push(a.o.txHash); usdtGot = a.got; }   // 只换一次，重试时只重试 USDT→BNB
          const t1 = Date.now(), sw = await baw.marketSwap({ fromTokenQty: ethers.formatUnits(usdtGot, 18), fromToken: USDT, toToken: BNB_NATIVE, slippage }); if (sw.orderId) step(`USDT→BNB 已提交 ${sw.orderId}`, Date.now() - t1); o = sw.orderId ? await baw.pollOrder(sw.orderId) : null; if (o?.status === 'FINISHED') step('USDT→BNB 完成', Date.now() - t1);
        } else { const t1 = Date.now(), sw = await baw.marketSwap({ fromTokenQty: ethers.formatUnits(got, dec), fromToken: q, toToken: BNB_NATIVE, slippage }); if (sw.orderId) step(`报价币→BNB 已提交 ${sw.orderId}`, Date.now() - t1); o = sw.orderId ? await baw.pollOrder(sw.orderId) : null; if (o?.status === 'FINISHED') step('报价币→BNB 完成', Date.now() - t1); }   // 换回 BNB 这笔也记时间点（只记录）
      } catch (e) { o = { status: 'FAILED', err: e.message }; }
      if (o?.status === 'FINISHED' || (o && o.status !== 'FAILED')) break;
      step(`报价币→BNB 第 ${k + 1} 次没成功${o?.err ? '：' + o.err.slice(0, 60) : ''}，重试`, 0); await sleep(2000 * (k + 1));
    }
    if (o?.txHash) hashes.push(o.txHash);
    if (o?.status !== 'FINISHED') return { venue: 'Gang V2 sell', expected: null, txHash: hashes.at(-1), hashes, note: `已卖出得到报价币 ${ethers.formatUnits(got, dec)}，换回 BNB ${o?.status === 'FAILED' ? '试了 3 次都失败，报价币留在钱包里（可在持仓页「计价币余额」里一键换回）' : '还在处理'}` };
    return { venue: 'Gang V2 sell → 报价币 → BNB', expected: Number(o.toTokenActualQty || 0), txHash: hashes.at(-1), hashes };
  }
}
