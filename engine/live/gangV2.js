// gang.fun V2 盘（/api/stocks，报价币 WBNB / GANG / 币股等）内盘买卖。合约 V2 Launchpad 0x1B8F…966E：
//   buy(token, quoteIn, minTokensOut)  —— 不收 BNB，从钱包 transferFrom 报价币（BNB 盘也是 WBNB），所以要先授权报价币
//   sell(token, tokensIn, minQuoteOut) —— 从钱包 transferFrom 代币，卖得的是报价币（BNB 盘给 WBNB）
// 依据：站上真实成交的 calldata（0xa59ac6dd / 0x6a272462，value=0）、回执日志（WBNB 转给卖家，1% 进 Bucket），
// 以及 eth_call + 状态覆盖模拟：按 curves(token) 的恒定乘积算出的买入数量与合约返回一致。
// 曲线：K = virtualQuote × VIRTUAL_TOKEN；手续费 1%（PROTOCOL_FEE_BPS=100）从报价币里扣。每个钱包最多买总量 1%（walletRoom）。
import { ethers } from 'ethers';
import * as baw from './baw.js';
import { BNB_NATIVE } from './config.js';

export const GANG_V2 = '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E';
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const iface = new ethers.Interface([
  'function buy(address token, uint256 quoteIn, uint256 minTokensOut) returns (uint256)',
  'function sell(address token, uint256 tokensIn, uint256 minQuoteOut) returns (uint256)',
  'function curves(address) view returns (address creator, address quote, uint256 realQuote, uint256 sold, uint256 gradAmt, uint256 virtualQuote, uint256 a, uint256 b, uint256 c, uint256 d)',
  'function VIRTUAL_TOKEN() view returns (uint256)',
  'function CURVE_SUPPLY() view returns (uint256)',
  'function walletRoom(address token, address buyer) view returns (uint256)',
]);
const erc = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function deposit() payable', 'function withdraw(uint256)']);
const minOut = (v, s) => (v * BigInt(10000 - Math.min(9900, Math.round(s * 100)))) / 10000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
const FEE = 100n, BPS = 10000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isWbnb = (a) => String(a || '').toLowerCase() === WBNB.toLowerCase();

export class GangV2 {
  // 第二个参数可以是 Portal 实例，也可以是 send 函数（liveTrader 传的是 (o) => portal.send(o)）
  constructor(provider, portalOrSend) {
    this.provider = provider; this.vt = null;
    const send = typeof portalOrSend === 'function' ? portalOrSend : (o) => portalOrSend.send(o);
    this.portal = { send, ensureAllowance: (o) => this.ensureAllowance(send, o) };
  }
  async ensureAllowance(send, { wallet, token, spender, amount, sym, step }) {
    if ((await this.read(token, erc, 'allowance', [wallet, spender]))[0] >= amount) return;
    await send({ wallet, to: token, inputData: erc.encodeFunctionData('approve', [spender, ethers.MaxUint256]), label: `授权 ${sym}`, step });
    for (let i = 0; i < 20; i++) { if ((await this.read(token, erc, 'allowance', [wallet, spender]))[0] >= amount) return; await sleep(1000); }
    throw new Error(`授权 ${sym} 没有在链上生效`);
  }
  // ---- 给 liveTrader 预览用的接口 ----
  async balanceOf(token, wallet) { return this.balance(token, wallet); }
  sellQuote(c, tokensIn) { const gross = (c.vQ + c.real) - ceilDiv(c.K, c.vt - c.sold + tokensIn); const fee = (gross * FEE) / BPS; return { out: gross - fee, fee }; }
  // BNB 金额 → 能买多少个（报价币不是 WBNB 时先用 baw 报价 BNB→报价币）
  async preview({ token, wallet, amountBnb }) {
    const c = await this.curve(token);
    let qIn;
    if (isWbnb(c.quote)) qIn = ethers.parseEther(String(amountBnb));
    else {
      const sq = await baw.marketQuote({ fromTokenQty: String(amountBnb), fromToken: BNB_NATIVE, toToken: c.quote, slippage: 1 });
      qIn = ethers.parseUnits(Number(sq?.toCoinAmount || 0).toFixed(12), await this.decimals(c.quote));
    }
    const q = await this.quoteBuy(token, wallet, qIn);
    return { out: +ethers.formatEther(q.tokensOut), tokensOut: q.tokensOut, refund: q.capped ? qIn - q.spend : 0n, capped: q.capped, quoteIn: qIn };
  }
  async read(to, i, fn, args) { return i.decodeFunctionResult(fn, await this.provider.call({ to, data: i.encodeFunctionData(fn, args) })); }
  async curve(token) {
    if (!this.vt) [this.vt] = await this.read(GANG_V2, iface, 'VIRTUAL_TOKEN', []);
    const c = await this.read(GANG_V2, iface, 'curves', [token]);
    if (c.quote === ethers.ZeroAddress) throw new Error('V2 合约里没有这个盘');
    const r = { quote: c.quote, real: c.realQuote, sold: c.sold, vQ: c.virtualQuote, K: c.virtualQuote * this.vt, vt: this.vt }; r.c = r; return r;
  }
  async room(token, wallet) { return (await this.read(GANG_V2, iface, 'walletRoom', [token, wallet]))[0]; }
  async balance(token, wallet) { return (await this.read(token, erc, 'balanceOf', [wallet]))[0]; }
  async sym(token) { return isWbnb(token) ? 'WBNB' : (await this.read(token, erc, 'symbol', []).catch(() => ['报价币']))[0]; }
  async decimals(token) { return isWbnb(token) ? 18 : Number((await this.read(token, erc, 'decimals', []).catch(() => [18]))[0]); }

  // 报价：花 quoteIn（含 1% 手续费）能买多少；超过 1% 上限时只按剩余额度算，并给出实际要花的报价币
  async quoteBuy(token, wallet, quoteIn) {
    const c = await this.curve(token);
    const out = (x) => { const net = x - (x * FEE) / BPS; return (c.vt - c.sold) - ceilDiv(c.K, c.vQ + c.real + net); };
    let spend = quoteIn, tokensOut = out(quoteIn);
    const room = wallet ? await this.room(token, wallet) : ethers.MaxUint256;
    let capped = false;
    if (tokensOut > room) {
      capped = true;
      if (room <= 0n) return { tokensOut: 0n, spend: 0n, room, capped, quote: c.quote };
      const net = c.K / (c.vt - c.sold - room) - (c.vQ + c.real);
      spend = (net * BPS) / (BPS - FEE);
      while (spend > 0n && out(spend) > room) spend -= spend / 1000000n + 1n;   // 不超过上限（超了合约会回滚）
      tokensOut = out(spend);
    }
    return { tokensOut, spend, fee: (spend * FEE) / BPS, room, capped, quote: c.quote };
  }
  async quoteSell(token, tokensIn) {
    const c = await this.curve(token);
    const gross = (c.vQ + c.real) - ceilDiv(c.K, c.vt - c.sold + tokensIn);
    const fee = (gross * FEE) / BPS;
    return { out: gross - fee, fee, quote: c.quote };
  }

  // 发交易前先 eth_call 跑一遍真实状态（报价币余额、授权都已就位），回滚就停，并以模拟结果作为最少成交的基准
  async simulate(from, data) {
    try { return BigInt((await this.provider.call({ from, to: GANG_V2, data })).slice(0, 66)); }
    catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}${e.data ? `（${String(e.data).slice(0, 10)}）` : ''}`); }
  }

  async received(token, wallet, before) {
    let got = 0n;
    for (let i = 0; i < 10; i++) { got = (await this.balance(token, wallet)) - before; if (got > 0n) break; await sleep(1000); }
    return got;
  }

  // 买入：BNB → 报价币（WBNB 盘直接 deposit 包装；其他报价币走 baw market-order）→ 授权报价币（max，一次）→ 模拟 → buy
  async buy({ wallet, token, quoteSym = '报价币', amountBnb, slippage, step }) {
    const hashes = [];
    const c = await this.curve(token);
    const qa = c.quote, wb = isWbnb(qa), dec = await this.decimals(qa);
    if (quoteSym === '报价币') quoteSym = await this.sym(qa);
    const value = ethers.parseEther(String(amountBnb));
    // 先用 BNB 金额估一下是否已到上限，免得白换报价币
    if (wb) { const pre = await this.quoteBuy(token, wallet, value); if (pre.tokensOut <= 0n) throw new Error('已达到单个钱包的持仓上限'); }
    else if ((await this.room(token, wallet)) <= 0n) throw new Error('已达到单个钱包的持仓上限');
    const before = await this.balance(qa, wallet);
    let got;
    if (wb) {
      hashes.push(await this.portal.send({ wallet, to: WBNB, valueWei: value, inputData: erc.encodeFunctionData('deposit', []), label: 'BNB→WBNB 包装', step }));
      got = await this.received(qa, wallet, before);
    } else {
      const t = Date.now();
      const sw = await baw.marketSwap({ fromTokenQty: String(amountBnb), fromToken: BNB_NATIVE, toToken: qa, slippage });
      if (!sw.orderId) throw new Error(`BNB→${quoteSym} 兑换没有返回 orderId`);
      step(`BNB→${quoteSym} 已提交 ${sw.orderId}`, Date.now() - t);
      const o = await baw.pollOrder(sw.orderId);
      if (o?.status !== 'FINISHED') throw new Error(`BNB→${quoteSym} 兑换${o?.status === 'FAILED' ? '失败' : '未完成（仍在处理，请在钱包里查看）'}，订单 ${sw.orderId}`);
      if (o.txHash) hashes.push(o.txHash);
      got = await this.received(qa, wallet, before);
    }
    if (got <= 0n) throw new Error(`${quoteSym} 没有到账，停止后续步骤`);
    step(`收到 ${ethers.formatUnits(got, dec)} ${quoteSym}`, 0);
    await this.portal.ensureAllowance({ wallet, token: qa, spender: GANG_V2, amount: got, sym: quoteSym, step });
    const q = await this.quoteBuy(token, wallet, got);
    if (q.tokensOut <= 0n) throw new Error(`已达到单个钱包的持仓上限（${quoteSym} 已留在钱包里）`);
    const spend = q.spend;
    const simOut = await this.simulate(wallet, iface.encodeFunctionData('buy', [token, spend, 0n]));
    step(`V2 报价 ${(+ethers.formatEther(simOut)).toFixed(0)} 个${q.capped ? `（到 1% 上限，只花 ${ethers.formatUnits(spend, dec)} ${quoteSym}，剩余留在钱包）` : ''}`, 0);
    hashes.push(await this.portal.send({ wallet, to: GANG_V2, inputData: iface.encodeFunctionData('buy', [token, spend, minOut(simOut, slippage)]), label: 'Gang V2 buy', step, waitConfirm: false }));
    // 后台预授权：代币 max 授权给 V2 合约，卖出时少等一笔（失败不影响买单）
    setTimeout(() => this.portal.ensureAllowance({ wallet, token, spender: GANG_V2, amount: ethers.MaxUint256 / 2n, sym: '代币（预授权）', step: () => {} }).catch(() => {}), 0);
    return { venue: `Gang V2 内盘 buy（BNB→${quoteSym}，非原子）`, expected: +ethers.formatEther(simOut), txHash: hashes.at(-1), hashes };
  }

  // 卖出：授权代币（max，一次）→ 模拟 → sell 得报价币 → WBNB 直接 withdraw 成 BNB；其他报价币用 baw 换回 BNB
  async sell({ wallet, token, quoteSym = '报价币', pct, slippage, step }) {
    const bal = await this.balance(token, wallet);
    if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
    step(`卖出 ${(+ethers.formatEther(amt)).toFixed(0)} 个（持有 ${(+ethers.formatEther(bal)).toFixed(0)}）`, 0);
    const hashes = [];
    const c = await this.curve(token); const qa = c.quote, wb = isWbnb(qa), dec = await this.decimals(qa);
    if (quoteSym === '报价币') quoteSym = await this.sym(qa);
    await this.portal.ensureAllowance({ wallet, token, spender: GANG_V2, amount: amt, sym: '代币', step });
    const simOut = await this.simulate(wallet, iface.encodeFunctionData('sell', [token, amt, 0n]));
    const before = await this.balance(qa, wallet);
    hashes.push(await this.portal.send({ wallet, to: GANG_V2, inputData: iface.encodeFunctionData('sell', [token, amt, minOut(simOut, slippage)]), label: 'Gang V2 sell', step }));
    const got = await this.received(qa, wallet, before);
    if (got <= 0n) return { venue: `Gang V2 sell → ${quoteSym}`, expected: null, txHash: hashes[0], hashes, note: `已卖出，但没读到 ${quoteSym} 到账，没有换回 BNB` };
    if (wb) {
      hashes.push(await this.portal.send({ wallet, to: WBNB, inputData: erc.encodeFunctionData('withdraw', [got]), label: 'WBNB→BNB 解包', step }));
      return { venue: 'Gang V2 sell → WBNB → BNB', expected: +ethers.formatEther(got), txHash: hashes.at(-1), hashes };
    }
    const t = Date.now();
    const sw = await baw.marketSwap({ fromTokenQty: ethers.formatUnits(got, dec), fromToken: qa, toToken: BNB_NATIVE, slippage });
    const o = sw.orderId ? await baw.pollOrder(sw.orderId) : null;
    if (o?.txHash) hashes.push(o.txHash);
    if (o?.status !== 'FINISHED') return { venue: `Gang V2 sell → ${quoteSym}`, expected: null, txHash: hashes[0], hashes, note: `已卖出得到 ${ethers.formatUnits(got, dec)} ${quoteSym}，换回 BNB ${o?.status === 'FAILED' ? '失败' : '未完成'}（订单 ${sw.orderId || '无'}）` };
    step(`${quoteSym}→BNB 完成`, Date.now() - t);
    return { venue: `Gang V2 sell → ${quoteSym} → BNB`, expected: Number(o.toTokenActualQty || 0), txHash: hashes.at(-1), hashes };
  }

  // 买入后台预授权：代币 max 授权给 V2 合约，卖出时少等一笔
  async approveData(token) { return erc.encodeFunctionData('approve', [GANG_V2, ethers.MaxUint256]); }
  async allowance(token, wallet) { return (await this.read(token, erc, 'allowance', [wallet, GANG_V2]))[0]; }
  // 预演用（不发交易）：返回 buy/sell calldata 供 baw contract-call preview
  buyData(token, quoteIn, min) { return iface.encodeFunctionData('buy', [token, quoteIn, min]); }
  sellData(token, amt, min) { return iface.encodeFunctionData('sell', [token, amt, min]); }
}
