// gang.fun V2 盘的链上成交：订阅三个 V2 pad 的买 / 卖事件（按真实交易和 gang.fun 接口核对过，2026-10）。
// 买 0x6e59ac1e：topics = [token, trader]，data = (报价币净额, 分红税, 平台费, 买到的代币, 已筹)
// 卖 0x00055e00：topics = [token, trader]，data = (卖出的代币, ?, 平台费, 到手报价币, ?)
// 量不大（全站约每天几百笔）。订阅用 NodeReal（多 key）→ publicnode wss，每 60 秒 getLogs 补查。只读。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { NODEREAL_WSS, RPC_ARCHIVE } from './config.js';
import { WsLogs, PUBLIC_WSS } from './rpc.js';
import { V3_PADS, v3Events } from './gangV3.js';

const PADS = ['0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb', '0x60aee38576035E757deD30fF8db8A8DA476430C1', '0x245a42cE8337DECe0f1C04f8430C90C8D98b88e4'];   // 和 gangV2Pads.V2_PADS 一致（0x245a = stocks pad）
const T_BUY = '0x6e59ac1e0b7a4b5c385ffff3601e05644c2ed9d875089895ed1b88e9cf8c632a';
const T_SELL = '0x00055e00ae56ca9d108326c7fd1ab1e6380614100b19bf3e4d1411240a726d86';
// Gang V3 内盘的 Buy / Sell 事件 topic 和字段顺序都和 V2 一样（tax 恒为 0），发现 V3 内盘后加进地址列表、重连订阅
const FILTER = { address: [...PADS, ...V3_PADS], topics: [[T_BUY, T_SELL]] };
const f18 = (w) => Number(ethers.formatEther(BigInt('0x' + w)));

export class GangPadChain extends EventEmitter {
  constructor(provider) { super(); this.provider = provider; this.seen = new Set(); this.status = { connected: false, wss: null, lastBlock: 0, trades: 0, pollError: null }; }
  async start() {
    try { this.status.lastBlock = await this.provider.getBlockNumber(); } catch (e) { this.status.pollError = e.shortMessage || e.message; }
    this.sub = new WsLogs({ label: 'gang成交', urls: [...NODEREAL_WSS, PUBLIC_WSS], filters: [FILTER], onLog: (l) => this.handle(l, true), status: this.status }).start();
    this.pollLoop();
    v3Events.on('pad', (a) => { if (!FILTER.address.some((x) => x.toLowerCase() === a)) { FILTER.address.push(a); if (this.sub) { this.sub.drop(this.sub.ws); this.sub.connect(0); } } });
  }
  async pollLoop() {
    for (;;) {
      await new Promise((r) => setTimeout(r, this.sub?.live ? 60_000 : 3_000));
      try {
        const head = await this.provider.getBlockNumber();
        for (let from = Math.max(this.status.lastBlock + 1, head - 20_000); from <= head;) { const to = Math.min(head, from + 1999); for (const l of await this.provider.getLogs({ ...FILTER, fromBlock: from, toBlock: to })) this.handle(l, false); this.status.lastBlock = to; from = to + 1; }
        this.status.pollError = null;
      } catch (e) { this.status.pollError = e.shortMessage || e.message; }
    }
  }
  handle(log, live) {
    const id = `${log.transactionHash}:${log.index}`; if (this.seen.has(id)) return; this.seen.add(id);
    if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
    this.status.lastBlock = Math.max(this.status.lastBlock, log.blockNumber || 0);
    const tr = this.parse(log, Date.now()); if (!tr) return;
    this.status.trades++;
    this.emit('trade', { ...tr, live });
  }
  parse(log, ts) {
    const w = log.data.slice(2).match(/.{64}/g) || []; if (w.length < 4) return null;
    const buy = log.topics[0] === T_BUY;
    const quote = buy ? f18(w[0]) + f18(w[1]) + f18(w[2]) : f18(w[3]), tokens = buy ? f18(w[3]) : f18(w[0]);
    if (!(tokens > 0)) return null;
    return { token: ('0x' + log.topics[1].slice(26)).toLowerCase(), trader: ('0x' + log.topics[2].slice(26)).toLowerCase(), side: buy ? 'buy' : 'sell', bnb: quote, tokens, price: quote / tokens, tx: log.transactionHash, ts, blk: log.blockNumber, li: log.index };   // blk / li：同一秒的几笔按上链顺序排
  }
  // 一个币在某个 pad 上 [fromBlock, toBlock] 的全部买卖（按出块时间，升序）。给 Gang V3 盘从开盘起重建 K 线用：gang.fun 成交接口没有 V3 盘的成交，
  // 以前重启后 K 线只从重启那一刻开始，之前的成交（包括自己的买卖标）全挤在第一根上。只读
  async history(token, pad, fromBlock, toBlock) {
    const logs = [], topic = ethers.zeroPadValue(token.toLowerCase(), 32);
    for (let from = fromBlock; from <= toBlock;) { const to = Math.min(toBlock, from + (RPC_ARCHIVE ? 9999 : 1999)); logs.push(...await this.provider.getLogs({ address: pad, topics: [[T_BUY, T_SELL], topic], fromBlock: from, toBlock: to })); from = to + 1; }
    const bt = this.blockTs ||= new Map(), need = [...new Set(logs.map((l) => l.blockNumber))].filter((b) => !bt.has(b));
    for (let i = 0; i < need.length; i += 8) await Promise.all(need.slice(i, i + 8).map((b) => this.provider.getBlock(b).then((x) => { if (x) bt.set(b, x.timestamp * 1000); })));
    if (bt.size > 50_000) this.blockTs = new Map([...bt].slice(-20_000));
    return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index).map((l) => bt.has(l.blockNumber) && this.parse(l, bt.get(l.blockNumber))).filter(Boolean);
  }
}
