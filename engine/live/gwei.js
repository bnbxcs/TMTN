// GWEI（gwe1.xyz）：单币 Agent 专属联合曲线，代币合约本身就是曲线（不是发射台）。只有持有币安 Agent ID 的钱包能买；
// 单笔最多 0.1 BNB、每个钱包最多持有总量 1%（21 万个）、买卖各收 0.1%；曲线攒到 100 BNB 自动迁移到 PancakeSwap V2（LP 打进 dead）。
// 行情：每 4 秒 eth_call 读储备 / 价格 / 已铸造量 + getLogs 读 Buy / Sell 事件；历史成交和持有人用 gwe1.xyz/data/holders.json 补（公共节点只留约 3000 块日志）。
// 下单：buy(minTokens) payable / sell(amount, minBnb)，卖出是合约直接销毁，不需要授权；同一个区块买了不能卖。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';

export const GWEI = '0xe0db0b90cb649d75dfa7f0956ea9fa524ec4025d';
export const GWEI_MAX_SUPPLY = 21_000_000;
const GRAD_BNB = 100, MAX_BUY_BNB = 0.1;
const HOLDERS_URL = 'https://gwe1.xyz/data/holders.json';
const iface = new ethers.Interface([
  'function buy(uint256 minTokens) payable returns (uint256)',
  'function sell(uint256 amount, uint256 minBnb) returns (uint256)',
  'function quoteBuy(uint256 bnbIn) view returns (uint256 tokens, uint256 used, uint256 refund)',
  'function quoteSell(uint256 amount) view returns (uint256)',
  'function price() view returns (uint256)',
  'function reserve() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function pair() view returns (address)',
  'function maxWallet() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Buy(address indexed buyer, uint256 bnbIn, uint256 tokensOut, uint256 fee, uint256 reserveAfter)',
  'event Sell(address indexed seller, uint256 tokensIn, uint256 bnbOut, uint256 fee, uint256 reserveAfter)',
]);
const T_BUY = iface.getEvent('Buy').topicHash, T_SELL = iface.getEvent('Sell').topicHash;
const f18 = (v) => Number(ethers.formatEther(v));
const minOut = (v, slippagePct) => (v * BigInt(10000 - Math.min(9900, Math.round(slippagePct * 100)))) / 10000n;

async function read(provider, fn, args = []) { return iface.decodeFunctionResult(fn, await provider.call({ to: GWEI, data: iface.encodeFunctionData(fn, args) })); }

// 行情：emit('token', 状态)、emit('trade', 成交, { live })
export class GweiFeed extends EventEmitter {
  constructor(provider) { super(); this.provider = provider; this.seen = new Set(); this.status = { lastBlock: 0, lastError: null, holdersAt: 0 }; }

  start() {
    const tick = () => this.poll().catch((e) => { this.status.lastError = e.shortMessage || e.message; });
    tick(); this.timer = setInterval(tick, 4000);
    const hist = () => this.history().catch((e) => { this.status.lastError = e.message; });
    hist(); this.histTimer = setInterval(hist, 60_000);
  }
  stop() { clearInterval(this.timer); clearInterval(this.histTimer); }

  async poll() {
    const [[reserve], [price], [supply], [graduated]] = await Promise.all(['reserve', 'price', 'totalSupply', 'graduated'].map((fn) => read(this.provider, fn)));
    const st = { address: GWEI, reserve: f18(reserve), price: f18(price), supply: f18(supply), graduated };
    if (graduated && !this.pair) this.pair = (await read(this.provider, 'pair'))[0];
    st.pair = this.pair || null;
    this.emit('token', st);
    // 新成交：从上次看到的区块往后查（第一次只看最近 200 块，更早的由 holders.json 补）
    const head = await this.provider.getBlockNumber();
    const from = this.status.lastBlock ? this.status.lastBlock + 1 : head - 200;
    if (from > head) return;
    const logs = await this.provider.getLogs({ address: GWEI, topics: [[T_BUY, T_SELL]], fromBlock: from, toBlock: head });
    for (const log of logs) {
      const id = `${log.transactionHash}:${log.index}`; if (this.seen.has(id)) continue; this.seen.add(id);
      const ev = iface.parseLog(log), buy = log.topics[0] === T_BUY;
      const bnb = f18(buy ? ev.args.bnbIn : ev.args.bnbOut), tokens = f18(buy ? ev.args.tokensOut : ev.args.tokensIn);
      this.emit('trade', { ts: Date.now(), side: buy ? 'buy' : 'sell', bnb, tokens, price: tokens ? bnb / tokens : 0, trader: ethers.getAddress(ev.args[0]), tx: log.transactionHash, reserveAfter: f18(ev.args.reserveAfter) }, { live: true });
    }
    this.status.lastBlock = head; this.status.lastError = null;
  }

  // gwe1.xyz 的索引器：从部署起的全部成交 + 持有人 + .ai 名字（complete=false 说明索引器漏过块）
  async history() {
    const j = await (await fetch(HOLDERS_URL)).json();
    this.status.holdersAt = Date.now();
    this.emit('holders', { holders: j.stats?.holders ?? null, complete: !!j.stats?.complete, names: (j.holders || []).filter((h) => h.handle).map((h) => [h.addr, `${h.handle}.ai`]) });
    for (const x of j.trades || []) {
      const id = `${x.tx}:${String(x.k || '').split(':')[1] ?? ''}`; if (this.seen.has(id)) continue; this.seen.add(id);
      this.emit('trade', { ts: x.ts * 1000, side: x.buy ? 'buy' : 'sell', bnb: x.bnb, tokens: x.tok, price: x.tok ? x.bnb / x.tok : 0, trader: ethers.getAddress(x.who), tx: x.tx, name: x.handle ? `${x.handle}.ai` : null }, { live: false });
    }
  }
}

export const gweiProgress = (reserveBnb) => Math.min(100, (reserveBnb / GRAD_BNB) * 100);

// 下单：send = Portal.send（baw contract-call preview + execute + 等上链）
export class GweiTrade {
  constructor(provider, send) { this.provider = provider; this.send = send; }

  async quoteBuy(amountBnb) {
    const [tokens, used, refund] = await read(this.provider, 'quoteBuy', [ethers.parseEther(String(amountBnb))]);
    return { tokens, used, refund, out: f18(tokens), feeBnb: f18(used) * 0.001, refundBnb: f18(refund) };
  }
  async quoteSell(amount) { const [bnb] = await read(this.provider, 'quoteSell', [amount]); return { bnb, out: f18(bnb), feeBnb: f18(bnb) / 0.999 * 0.001 }; }
  async balance(wallet) { return (await read(this.provider, 'balanceOf', [wallet]))[0]; }

  // 这个钱包还能买多少个（1% 上限减去已持有），单位：个
  async walletRoom(wallet) {
    const [[cap], [bal]] = await Promise.all([read(this.provider, 'maxWallet'), read(this.provider, 'balanceOf', [wallet])]);
    return f18(cap > bal ? cap - bal : 0n);
  }

  async buy({ wallet, amountBnb, slippage, step }) {
    if (Number(amountBnb) > MAX_BUY_BNB) throw new Error(`GWEI 单笔最多 ${MAX_BUY_BNB} BNB（合约限制）`);
    const value = ethers.parseEther(String(amountBnb));
    const q = await this.quoteBuy(amountBnb);
    if (q.tokens <= 0n) throw new Error('报价为 0：曲线可能已迁移');
    const room = await this.walletRoom(wallet);
    if (q.out > room) throw new Error(`超过单钱包 1% 上限：还能买 ${room.toFixed(0)} 个，这笔会买 ${q.out.toFixed(0)} 个`);
    step(`GWEI quoteBuy ${q.out.toFixed(0)} 个${q.refund > 0n ? `（这笔会迁移曲线，退回 ${q.refundBnb} BNB）` : ''}`, 0);
    const inputData = iface.encodeFunctionData('buy', [minOut(q.tokens, slippage)]);
    await this.simulate(wallet, inputData, value);
    const hash = await this.send({ wallet, to: GWEI, valueWei: value, inputData, label: 'GWEI buy', step });
    return { venue: 'GWEI 曲线 buy（BNB）', expected: q.out, txHash: hash, hashes: [hash] };
  }

  // 卖出：合约直接销毁，不用授权
  async sell({ wallet, pct, slippage, step }) {
    const bal = await this.balance(wallet);
    if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
    step(`卖出 ${f18(amt).toFixed(0)} 个（持有 ${f18(bal).toFixed(0)}）`, 0);
    const q = await this.quoteSell(amt);
    const inputData = iface.encodeFunctionData('sell', [amt, minOut(q.bnb, slippage)]);
    await this.simulate(wallet, inputData, 0n);
    const hash = await this.send({ wallet, to: GWEI, inputData, label: 'GWEI sell', step });
    return { venue: 'GWEI 曲线 sell（BNB）', expected: q.out, txHash: hash, hashes: [hash] };
  }

  // 发交易前先用 eth_call 跑一遍，回滚就直接报错，不浪费 gas（常见：不是 Agent ID 钱包、同一个区块买了又卖）
  async simulate(from, data, value) {
    try { await this.provider.call({ from, to: GWEI, data, value }); }
    catch (e) { throw new Error(`链上模拟失败：${e.reason || e.shortMessage || e.message}`); }
  }
}
