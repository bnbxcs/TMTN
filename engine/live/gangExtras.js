// gang.fun 回购 / 押金（2026-10-29）：识别 gang 的回购模式和押金承诺，战壕里显示标签、可以筛选
// 依据：官方公开仓库 github.com/gangfun/gang-launchpad（src/gang/GangBuybackSplitter.sol、GangBond.sol，docs/MAINNET-BUYBACK-SPLITTER-2026-10-28.md、MAINNET-GANG-BOND-2026-10-29.md）
// 两个都只是 GangLaunchpad（V3 曲线 / 打新）上的附加合约，买卖路径不变，这里只识别和展示：
// - 回购：V3 税币的税收接收地址（taxConfigOf(token).recipient）是 dev 的 GangBuybackSplitter 克隆。dev 那份税按 buybackBps 在外盘回购打进 0xdead，
//   其余给 dev。比例 dev 随时可调高，调低要提前 3 天（pendingCut），所以比例 10 分钟重读一次。是不是官方克隆看 GangHandlerAdmin.moduleOf(recipient) 是不是官方工厂
// - 押金：GangBond（Agent 押金承诺）。dev 用报价币押一笔，承诺创建地址至少持有 holdAmount 枚到期（上外盘后 duration 天，7–90 天）；
//   持仓低于承诺任何人可举报：1% 给举报人，其余在外盘分块回购销毁。守约到期退回。合约的所有事件第一个 indexed 参数都是 token，按合约地址订日志即可
import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from './config.js';
import { QUOTE_DEC } from './gangChain.js';

export const GANG_BOND = '0xe92dc940cb23dc328639a7334e69f9ccdf3a14e4';   // 2026-10-29 重新部署的版本；旧的 0xf26f…c817 弃用（网站、keeper 都不看）
const BOND_FROM = 130407146;   // 部署区块
const HANDLER_ADMIN = '0xf56af7a7a004b9bb3515480a1409bc1dad8fe985';
const FACTORIES = { '0x6bcd79206da85aa0643db2164ab887b468618546': 1, '0x93467cb38b9cb7f6ef3b67d2226eb8b77ca58f2f': 2, '0xf1d5ca816d72e6f130f42662d11b238312a7f1cd': 3 };
const ZERO = ethers.ZeroAddress;
const I = new ethers.Interface([
  'function bondOf(address token) view returns ((address creator, uint64 postedAt, uint32 round, address quote, uint8 state, uint64 deadline, uint64 duration, uint64 requestAt, uint128 amount, uint128 holdAmount, uint128 burnLeft))',
  'function isViolated(address token) view returns (bool)',
  'function moduleOf(address module) view returns (address)',
  'function buybackBps() view returns (uint16)',
  'function pendingCut() view returns (bool live, uint16 bps, uint64 at)',
  'function token() view returns (address)',
  'function dev() view returns (address)',
]);
const BOND_FILE = dataFile('gang-bonds.json');
const BB_FILE = dataFile('gang-buyback.json');
const load = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export class GangExtras {
  constructor(provider) {
    this.provider = provider;
    const b = load(BOND_FILE, {}); this.bonds = b.bonds || {}; this.bondFrom = b.from || BOND_FROM;
    this.bb = load(BB_FILE, {});   // 接收地址 → { v: 工厂版本, bps, token, cut, at } ；不是回购合约的记 { v: 0 }（模块在发币前就登记，之后不会变成模块）
    this._bbAt = new Map();
  }
  call(to, fn, args = []) { return this.provider.call({ to, data: I.encodeFunctionData(fn, args) }).then((r) => I.decodeFunctionResult(fn, r)); }
  saveBonds() { clearTimeout(this._bs); this._bs = setTimeout(() => { try { writeFileSync(BOND_FILE, JSON.stringify({ from: this.bondFrom, bonds: this.bonds })); } catch { /* 下次重启从头扫 */ } }, 3000); }
  saveBb() { clearTimeout(this._bbs); this._bbs = setTimeout(() => { try { writeFileSync(BB_FILE, JSON.stringify(this.bb)); } catch { /* 重启重读 */ } }, 3000); }

  // 押金：每 30 秒扫一次 GangBond 的新日志，有事件的币重读 bondOf；进行中的押金每 5 分钟重读一次是否违约（持仓变化不出押金事件）
  start() {
    const tick = async () => {
      try {
        const head = await this.provider.getBlockNumber(), touched = new Set();
        if (head >= this.bondFrom) {
          for (const l of await this.provider.getLogs({ address: GANG_BOND, fromBlock: this.bondFrom, toBlock: head })) if (l.topics[1]) touched.add(('0x' + l.topics[1].slice(26)).toLowerCase());
          this.bondFrom = head + 1;
        }
        const stale = Date.now() - 5 * 60_000;
        for (const [k, v] of Object.entries(this.bonds)) if (v.state === 1 && !(v.at > stale)) touched.add(k);
        for (const k of touched) await this.readBond(k).catch(() => {});
        this.saveBonds();
      } catch { /* 下次从 bondFrom 接着扫 */ }
    };
    setTimeout(tick, 8000); setInterval(tick, 30_000).unref?.();
  }
  async readBond(token) {
    const [[b], [bad]] = await Promise.all([this.call(GANG_BOND, 'bondOf', [token]), this.call(GANG_BOND, 'isViolated', [token]).catch(() => [false])]);
    const state = Number(b.state); if (!state) { delete this.bonds[token]; return; }
    const q = String(b.quote).toLowerCase(), dec = QUOTE_DEC[q] || 18;
    this.bonds[token] = { state, quote: q, amount: Number(ethers.formatUnits(b.amount, dec)), hold: Number(ethers.formatEther(b.holdAmount)), burnLeft: Number(ethers.formatUnits(b.burnLeft, dec)),
      postedAt: Number(b.postedAt) * 1000, deadline: Number(b.deadline) * 1000, duration: Number(b.duration), round: Number(b.round), creator: String(b.creator).toLowerCase(), violated: !!bad, at: Date.now() };
  }
  bond(token) { const b = this.bonds[String(token).toLowerCase()]; return b ? { ...b } : null; }

  // 回购：t.taxTo 是别人（不是发币人、不是 0）的 V3 税币才查。回购比例 10 分钟重读一次
  buyback(t) {
    const r = t.taxTo, x = r && this.bb[r];
    if (!x?.v || (x.token && x.token !== t.address)) return null;   // 同一个回购合约只为它绑定的那个币回购，别的币把税打给它只是多给钱
    return { bps: x.bps, ver: x.v, splitter: r, cut: x.cut || null };
  }
  sweep(tokens) {
    let n = 0;
    for (const t of tokens) {
      if (n >= 6) break;
      const r = t.taxTo; if (t.source !== 'gang' || !r || r === String(t.creator || '').toLowerCase()) continue;
      const x = this.bb[r]; if (x && (!x.v || x.at > Date.now() - 10 * 60_000)) continue;
      if (this._bbAt.get(r) > Date.now() - 60_000) continue;
      this._bbAt.set(r, Date.now()); n++;
      this.readBuyback(r, t).catch(() => {});
    }
  }
  async readBuyback(r, t) {
    const old = this.bb[r];
    if (!old) {
      const [f] = await this.call(HANDLER_ADMIN, 'moduleOf', [r]);
      const v = FACTORIES[String(f).toLowerCase()] || 0;
      if (!v) { this.bb[r] = { v: 0 }; return this.saveBb(); }
      this.bb[r] = { v, bps: 0, token: null, at: 0 };
    }
    const x = this.bb[r];
    const [[bps], [tok], [dev], cut] = await Promise.all([this.call(r, 'buybackBps'), this.call(r, 'token'), this.call(r, 'dev'), this.call(r, 'pendingCut').catch(() => null)]);
    const tk = String(tok).toLowerCase();
    if (tk === ZERO && String(dev).toLowerCase() !== String(t.creator || '').toLowerCase()) { this.bb[r] = { v: 0 }; return this.saveBb(); }   // 还没绑定、也不是这个 dev 的
    Object.assign(x, { bps: Number(bps), token: tk === ZERO ? null : tk, cut: cut?.live ? { bps: Number(cut.bps), at: Number(cut.at) * 1000 } : null, at: Date.now() });
    this.saveBb();
  }
}
