// gang.fun 老盘（BNB 计价，53 个）内盘买卖。合约 0x315B…23A7，接口和官方 gang CLI 里的「Soft」pad 一样：
//   buy(token, minTokensOut) payable / sell(token, tokensIn, minBnbOut) / quoteBuy / quoteSell
// 依据：站上真实买卖交易的函数选择器 0xcce7ec13（buy）/ 0x6a272462（sell），以及从钱包地址 eth_call 模拟买入成功。
// V2 盘（/api/stocks，报价币是 WBNB / GANG / 币股，合约 0x1B8F…966E）要先换报价币再授权，还没接，只看行情。
import { ethers } from 'ethers';
import { capFor, capLabel, sendApproval } from './approvals.js';

export const GANG_PAD = '0x315Ba2e8952D06094CC636b2B84229FA32fb23A7';
const iface = new ethers.Interface([
  'function buy(address token, uint256 minTokensOut) payable returns (uint256)',
  'function sell(address token, uint256 tokensIn, uint256 minBnbOut) returns (uint256)',
  'function quoteBuy(address token, address buyer, uint256 bnbGross) view returns (uint256 tokensOut, uint256 bnbIn, uint256 fee, uint256 refund)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 bnbToUser, uint256 fee)',
  'function walletRoom(address token, address buyer) view returns (uint256)',
]);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const minOut = (v, slippagePct) => (v * BigInt(10000 - Math.min(9900, Math.round(slippagePct * 100)))) / 10000n;
const f18 = (v) => Number(ethers.formatEther(v));

export class GangTrade {
  constructor(provider, send) { this.provider = provider; this.send = send; }   // send = Portal.send（baw contract-call preview + execute + 等上链）

  async read(to, i, fn, args) { return i.decodeFunctionResult(fn, await this.provider.call({ to, data: i.encodeFunctionData(fn, args) })); }

  async quoteBuy(token, wallet, amountBnb) {
    const wei = ethers.parseEther(String(amountBnb));
    const key = `${String(token).toLowerCase()}|${String(wallet).toLowerCase()}|buy|${wei.toString()}`;
    const hit = (this._qCache ||= new Map()).get(key);
    if (hit && Date.now() - hit.at < 1200) return hit.v != null ? hit.v : hit.p;
    const p = this.read(GANG_PAD, iface, 'quoteBuy', [token, wallet, wei]).then(([tokensOut, bnbIn, fee, refund]) => ({ tokensOut, bnbIn, fee, refund, out: f18(tokensOut), feeBnb: f18(fee), refundBnb: f18(refund) }));
    this._qCache.set(key, { at: Date.now(), p });
    try { const v = await p; this._qCache.set(key, { at: Date.now(), v }); return v; }
    catch (e) { this._qCache.delete(key); throw e; }
  }

  async quoteSell(token, tokensIn) {
    const [bnbToUser, fee] = await this.read(GANG_PAD, iface, 'quoteSell', [token, tokensIn]);
    return { bnbToUser, fee, out: f18(bnbToUser), feeBnb: f18(fee) };
  }

  // 这个钱包还能买多少个（1% 上限减去已持有），单位：个
  async walletRoom(token, wallet) { return f18((await this.read(GANG_PAD, iface, 'walletRoom', [token, wallet]))[0]); }

  async balance(token, wallet) { return (await this.read(token, erc20, 'balanceOf', [wallet]))[0]; }

  // 买入：quoteBuy → 链上模拟 → baw 执行 buy{value}（一笔，原子）。到 1% 上限时合约只按剩余额度成交，多余的 BNB 同笔退回
  async buy({ wallet, token, amountBnb, slippage, step }) {
    const value = ethers.parseEther(String(amountBnb));
    const q = await this.quoteBuy(token, wallet, amountBnb);
    if (q.tokensOut <= 0n) throw new Error('报价为 0：可能已到每个钱包 1% 上限，或盘已毕业');
    step(`Gang quoteBuy ${q.out.toFixed(0)} 个${q.refund > 0n ? `（到 1% 上限，退回 ${q.refundBnb} BNB）` : ''}`, 0);
    const inputData = iface.encodeFunctionData('buy', [token, minOut(q.tokensOut, slippage)]);
    await this.simulate(wallet, inputData, value);
    const hash = await this.send({ wallet, to: GANG_PAD, valueWei: value, inputData, label: 'Gang buy', step, waitConfirm: false });
    return { venue: 'Gang 内盘 buy（BNB）', expected: q.out, txHash: hash, hashes: [hash] };
  }

  // 卖出：按比例算数量 → 授权只授本次数量（不够时）→ 授权上链后重新报价 → sell
  async sell({ wallet, token, pct, slippage, step }) {
    const bal = await this.balance(token, wallet);
    if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
    step(`卖出 ${f18(amt).toFixed(0)} 个（持有 ${f18(bal).toFixed(0)}）`, 0);
    const hashes = [];
    const allowance = (await this.read(token, erc20, 'allowance', [wallet, GANG_PAD]))[0];
    if (allowance < amt) { const cap = await capFor({ token, wallet, amount: amt, kind: 'sell' }); hashes.push(await sendApproval({ send: (o) => this.send(o), wallet, token, spender: GANG_PAD, amount: amt, cap, label: `授权卖出（${capLabel('sell')}）`, kind: 'sell', step })); }
    else step('授权额度够用，跳过授权', 0);
    const q = await this.quoteSell(token, amt);
    const inputData = iface.encodeFunctionData('sell', [token, amt, minOut(q.bnbToUser, slippage)]);
    await this.simulate(wallet, inputData, 0n);
    hashes.push(await this.send({ wallet, to: GANG_PAD, inputData, label: 'Gang sell', step, waitConfirm: false }));
    return { venue: 'Gang 内盘 sell（BNB）', expected: q.out, txHash: hashes.at(-1), hashes };
  }

  // 发交易前先用 eth_call 跑一遍，回滚就直接报错，不浪费 gas
  async simulate(from, data, value) {
    try { await this.provider.call({ from, to: GANG_PAD, data, value }); }
    catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}${e.data ? `（${e.data.slice(0, 10)}）` : ''}`); }
  }
}
