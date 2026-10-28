// 刚发射（迁移）到外盘的币：直接走 PancakeSwap V2 路由买卖。
// Flap / Four / Gang 毕业后都在 PancakeSwap V2 建「代币 / 报价币」池（链上核对过 AGI、bibi、Gangstar、HEYI、CZ：factory 都是 0xcA14…0c73）。
// 币安 DEX 聚合（baw market-order）刚迁移时常常还没收录新池子，报价 / 下单失败，这段时间就用这里：
//   卖：授权代币给路由 → 代币→报价币（BNB 盘直接换成 BNB）→ 报价币换回 BNB（沿用 gangV2.swapBack，Ondo 类经 USDT）
//   买：BNB 盘直接 BNB→代币；报价币盘先用钱包里的报价币，不够用 baw 换差额 → 授权 → 报价币→代币
import { ethers } from 'ethers';
import { BNB_NATIVE } from './config.js';
import { waitReceived } from './quoteRoutes.js';

export const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const router = new ethers.Interface([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
const factory = new ethers.Interface(['function getPair(address,address) view returns (address)']);
const pairI = new ethers.Interface(['function getReserves() view returns (uint112,uint112,uint32)']);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const isW = (a) => !a || a === ethers.ZeroAddress || String(a).toLowerCase() === WBNB.toLowerCase();
// 预期数量先扣掉代币税（Flap 盘有 1～3% 买卖税，getAmountsOut 不算税），再按滑点给最少到手数
const minOut = (v, slip, taxPct = 0) => (v * BigInt(Math.round((1 - Math.min(99, taxPct) / 100) * 10000)) / 10000n * BigInt(10000 - Math.min(9900, Math.round(slip * 100)))) / 10000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 300);

export class DexDirect {
  // g：GangV2 实例，借用它的授权、baw 兑换等待、报价币换回 BNB、汇率缓存
  constructor(provider, send, g) { this.provider = provider; this.send = send; this.g = g; this.pools = new Map(); }

  async call(to, i, fn, args) { return i.decodeFunctionResult(fn, await this.provider.call({ to, data: i.encodeFunctionData(fn, args) })); }
  async balanceOf(token, wallet) { return (await this.call(token, erc20, 'balanceOf', [wallet]))[0]; }

  // 代币在 PancakeSwap V2 上的池子：先找和盘的报价币的，再找和 WBNB 的；没有储备的不算。找到的记 10 分钟，没找到的只记 5 秒（刚迁移时池子随时会出现）
  async pool(token, quoteAddress) {
    const k = String(token).toLowerCase(), hit = this.pools.get(k);
    if (hit && Date.now() - hit.at < (hit.v ? 600_000 : 5_000)) return hit.v;
    let v = null;
    for (const q of [...new Set([isW(quoteAddress) ? WBNB : quoteAddress, WBNB])]) {
      const pair = (await this.call(FACTORY, factory, 'getPair', [token, q]))[0];
      if (pair === ethers.ZeroAddress) continue;
      const [r0, r1] = await this.call(pair, pairI, 'getReserves', []);
      if (r0 > 0n && r1 > 0n) { v = { pair, quote: isW(q) ? WBNB : q, isBnb: isW(q) }; break; }
    }
    this.pools.set(k, { v, at: Date.now() }); return v;
  }

  async decimals(token) { return isW(token) ? 18 : this.g.decimals(token); }

  // 只报价：买 = amount BNB 能拿到多少代币；卖 = amount 个代币（字符串，按代币精度）大约换回多少 BNB。taxPct 为代币买 / 卖税
  async quote({ token, quoteAddress, side, amount, taxPct = 0 }) {
    const p = await this.pool(token, quoteAddress); if (!p) return null;
    const tDec = await this.decimals(token);
    if (side === 'buy') {
      let inQ;
      if (p.isBnb) inQ = ethers.parseEther(String(amount));
      else { const dec = await this.decimals(p.quote); inQ = ethers.parseUnits((Number(amount) * await this.g.quoteRate(p.quote)).toFixed(Math.min(12, dec)), dec); }
      const out = (await this.call(PANCAKE_V2_ROUTER, router, 'getAmountsOut', [inQ, [p.quote, token]]))[0].at(-1);
      return { pool: p, out: Number(ethers.formatUnits(out, tDec)) * (1 - taxPct / 100) };
    }
    const amt = ethers.parseUnits(String(amount), tDec);
    const outQ = (await this.call(PANCAKE_V2_ROUTER, router, 'getAmountsOut', [amt, [token, p.quote]]))[0].at(-1);
    const q = Number(ethers.formatUnits(outQ, await this.decimals(p.quote))) * (1 - taxPct / 100);
    // 报价币换 BNB 的汇率拿不到（Ondo 币股休市等）时只给报价币数量
    return { pool: p, out: p.isBnb ? q : await this.g.quoteRate(p.quote).then((r) => q / r).catch(() => null), outQuote: p.isBnb ? null : q };
  }

  async sell({ wallet, token, quoteAddress, pct, slippage, step, toBnb = true, taxPct = 0 }) {
    const p = await this.pool(token, quoteAddress); if (!p) throw new Error('PancakeSwap V2 上没有找到这个币的池子');
    const bal = await this.balanceOf(token, wallet); if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n; const hashes = [];
    const ap = await this.g.ensureAllowance({ wallet, token, spender: PANCAKE_V2_ROUTER, amount: amt, label: '授权卖出（PancakeSwap）', step, kind: 'sell' }); if (ap) hashes.push(ap);
    const out = (await this.call(PANCAKE_V2_ROUTER, router, 'getAmountsOut', [amt, [token, p.quote]]))[0].at(-1), min = minOut(out, slippage, taxPct);
    if (p.isBnb) {
      const data = router.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', [amt, min, [token, WBNB], wallet, deadline()]);
      try { await this.provider.call({ from: wallet, to: PANCAKE_V2_ROUTER, data }); } catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}`); }
      hashes.push(await this.send({ wallet, to: PANCAKE_V2_ROUTER, inputData: data, label: 'PancakeSwap 卖出', step }));
      return { venue: 'PancakeSwap V2 直连 · 代币→BNB', expected: Number(ethers.formatEther(out)) * (1 - taxPct / 100), txHash: hashes.at(-1), hashes };
    }
    const data = router.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens', [amt, min, [token, p.quote], wallet, deadline()]);
    try { await this.provider.call({ from: wallet, to: PANCAKE_V2_ROUTER, data }); } catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}`); }
    const before = await this.balanceOf(p.quote, wallet);
    try { hashes.push(await this.send({ wallet, to: PANCAKE_V2_ROUTER, inputData: data, label: 'PancakeSwap 卖出（→报价币）', step })); }
    catch (e) {
      // 要在 App 里确认 / 结果未知：确认后按 Transfer 日志（来自池子）等报价币到账，再换回 BNB（和 Gang V2 卖出同一做法）
      const fromBlock = toBnb ? await this.provider.getBlockNumber().then((b) => b - 2).catch(() => undefined) : null;
      if (toBnb && ['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) e.afterConfirm = async (log) => {
        const got = await waitReceived({ provider: this.provider, token: p.quote, wallet, senders: [p.pair], fromBlock });
        if (got <= 0n) return { note: '5 分钟内没收到报价币（可能在 App 里拒绝了），没有换回 BNB' };
        log(`收到报价币 ${ethers.formatUnits(got, await this.decimals(p.quote))}，接着换回 BNB`, 0);
        return this.g.swapBack({ wallet, q: p.quote, got, slippage, step: log, hashes: [] });
      };
      throw e;
    }
    let got = 0n; for (let i = 0; i < 34; i++) { got = (await this.balanceOf(p.quote, wallet)) - before; if (got > 0n) break; await sleep(300); }
    if (!toBnb || got <= 0n) return { venue: 'PancakeSwap V2 直连 · 代币→报价币', expected: null, txHash: hashes.at(-1), hashes, note: got > 0n ? `已卖出得到报价币 ${ethers.formatUnits(got, await this.decimals(p.quote))}（「卖出后自动换回 BNB」已关闭，留在钱包）` : '已卖出，没读到报价币到账' };
    const r = await this.g.swapBack({ wallet, q: p.quote, got, slippage, step, hashes });
    return { ...r, venue: 'PancakeSwap V2 直连 · 代币→报价币→BNB' };
  }

  async buy({ wallet, token, quoteAddress, amountBnb, slippage, step, taxPct = 0 }) {
    const p = await this.pool(token, quoteAddress); if (!p) throw new Error('PancakeSwap V2 上没有找到这个币的池子');
    const tDec = await this.decimals(token), hashes = [];
    if (p.isBnb) {
      const value = ethers.parseEther(String(amountBnb));
      const out = (await this.call(PANCAKE_V2_ROUTER, router, 'getAmountsOut', [value, [WBNB, token]]))[0].at(-1);
      const data = router.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [minOut(out, slippage, taxPct), [WBNB, token], wallet, deadline()]);
      try { await this.provider.call({ from: wallet, to: PANCAKE_V2_ROUTER, value, data }); } catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}`); }
      hashes.push(await this.send({ wallet, to: PANCAKE_V2_ROUTER, valueWei: value, inputData: data, label: 'PancakeSwap 买入', step, waitConfirm: false }));
      return { venue: 'PancakeSwap V2 直连 · BNB→代币', expected: Number(ethers.formatUnits(out, tDec)) * (1 - taxPct / 100), txHash: hashes.at(-1), hashes };
    }
    // 报价币盘：钱包里已有的报价币先用，差额用 BNB 换（多换 3% 抵滑点，多的留在钱包）
    const q = p.quote, dec = await this.decimals(q), have = await this.balanceOf(q, wallet);
    let need = ethers.parseUnits((Number(amountBnb) * await this.g.quoteRate(q, { stale: 30_000 })).toFixed(Math.min(12, dec)), dec);
    if (have < need) {
      const shortBnb = (Number(amountBnb) * Number(need - have) / Number(need) * 1.03).toFixed(18).replace(/\.?0+$/, '');
      if (have > 0n) step(`钱包里有 ${ethers.formatUnits(have, dec)} 报价币，不够，用 ${shortBnb} BNB 换差额`, 0);
      if (await this.g.needsUsdt(q)) {
        const a = await this.g.swapWait({ wallet, from: BNB_NATIVE, to: '0x55d398326f99059fF775485246999027B3197955', qty: shortBnb, slippage, step, label: 'BNB→USDT' }); if (a.o.txHash) hashes.push(a.o.txHash);
        const b = await this.g.swapWait({ wallet, from: '0x55d398326f99059fF775485246999027B3197955', to: q, qty: ethers.formatUnits(a.got, 18), slippage, step, label: 'USDT→报价币' }); if (b.o.txHash) hashes.push(b.o.txHash);
      } else { const a = await this.g.swapWait({ wallet, from: BNB_NATIVE, to: q, qty: shortBnb, slippage, step, label: 'BNB→报价币' }); if (a.o.txHash) hashes.push(a.o.txHash); }
      const now = await this.balanceOf(q, wallet); need = now < need ? now : need;
      if (need <= 0n) throw new Error('报价币没有到账，停止后续步骤');
    } else step(`钱包里已有足够报价币，直接使用 ${ethers.formatUnits(need, dec)}`, 0);
    const ap = await this.g.ensureAllowance({ wallet, token: q, spender: PANCAKE_V2_ROUTER, amount: need, label: '授权报价币（PancakeSwap）', step, kind: 'quote' }); if (ap) hashes.push(ap);
    const out = (await this.call(PANCAKE_V2_ROUTER, router, 'getAmountsOut', [need, [q, token]]))[0].at(-1);
    const data = router.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens', [need, minOut(out, slippage, taxPct), [q, token], wallet, deadline()]);
    try { await this.provider.call({ from: wallet, to: PANCAKE_V2_ROUTER, data }); } catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}`); }
    hashes.push(await this.send({ wallet, to: PANCAKE_V2_ROUTER, inputData: data, label: 'PancakeSwap 买入', step, waitConfirm: false }));
    return { venue: 'PancakeSwap V2 直连 · BNB→报价币→代币（非原子）', expected: Number(ethers.formatUnits(out, tDec)) * (1 - taxPct / 100), txHash: hashes.at(-1), hashes };
  }
}
