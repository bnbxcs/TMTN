// Flap Agent Curve Portal：quoteBuy 计算份额，并用 baw contract-call preview 预演 buy(market,minShares)。
// LIVE_TRADE=1 时 buy / sell 才会通过 baw contract-call execute 真实上链；非 BNB 底池走 BNB→报价币（baw market-order）→ approve → buyWithQuote。
import { ethers } from 'ethers';
import { PORTAL, FACTORY, ZERO, BNB_NATIVE } from './config.js';
import * as baw from './baw.js';
import { USDT, ONDO_RE, viaUsdt, markViaUsdt, waitReceived } from './quoteRoutes.js';
import { capFor, capLabel, sendApproval } from './approvals.js';

const PORTAL_ABI = [
  'function buy(address market, uint256 minShares) payable',
  'function buyWithQuote(address market, uint256 quoteAmount, uint256 minShares)',
  'function quoteBuy(address market, address wallet, uint256 grossWei) view returns (uint256 gross, uint256 fee, uint256 extra, uint256 shares)',
  'function sell(address market, uint256 grossQuoteOut, uint256 maxShares, uint256 minNetOut) returns (uint256, uint256)',
  'function sellAll(address market, uint256 minNetOut) returns (uint256)',
  'function claim(address market) returns (uint256)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const pIface = new ethers.Interface(PORTAL_ABI);
const eIface = new ethers.Interface(ERC20_ABI);
const mIface = new ethers.Interface(['function sharesOf(address) view returns (uint256)']);

export const isBnbQuote = (a) => !a || a === ZERO || a.toLowerCase() === BNB_NATIVE.toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Portal {
  constructor(provider, readProvider = provider) {
    this.provider = provider; this.read = readProvider;   // read：定时扫描用的只读调用（领取前模拟、份额），走公共节点
    this.portal = new ethers.Contract(PORTAL, PORTAL_ABI, provider);
    this.factory = new ethers.Contract(FACTORY, ['function marketOfToken(address token) view returns (address)'], provider);
    this._qBuy = new Map();   // 短 TTL 报价缓存：同 market+wallet+amount 共用（含 in-flight），不跳过滑点
  }

  async marketOf(token) { try { const m = await this.factory.marketOfToken(token); return m && m !== ZERO ? m : null; } catch { return null; } }

  async quoteBuy(market, wallet, amountWei) {
    const key = `${String(market).toLowerCase()}|${String(wallet || ZERO).toLowerCase()}|${amountWei.toString()}`;
    const hit = this._qBuy.get(key);
    if (hit && Date.now() - hit.at < 1200) return hit.v != null ? hit.v : hit.p;
    const p = this.portal.quoteBuy(market, wallet || ZERO, amountWei).then((r) => ({ gross: r[0], fee: r[1], extra: r[2], shares: r[3] }));
    this._qBuy.set(key, { at: Date.now(), p });
    try { const v = await p; this._qBuy.set(key, { at: Date.now(), v }); return v; }
    catch (e) { this._qBuy.delete(key); throw e; }
  }

  minShares(shares, slippagePct) { const bps = BigInt(Math.min(9999, Math.round(slippagePct * 100))); return (shares * (10000n - bps)) / 10000n; }

  async sharesOf(market, wallet) {
    return mIface.decodeFunctionResult('sharesOf', await this.read.call({ to: market, data: mIface.encodeFunctionData('sharesOf', [wallet]) }))[0];
  }

  // 迁移（发射）后把曲线份额领成真正的代币：Portal.claim(market)，返回领到的代币数量
  async previewClaim(market, wallet) {
    const r = await this.read.call({ from: wallet, to: PORTAL, data: pIface.encodeFunctionData('claim', [market]) });
    return pIface.decodeFunctionResult('claim', r)[0];
  }
  async claim({ wallet, market, step }) {
    const amount = await this.previewClaim(market, wallet);
    step(`可领取 ${(+ethers.formatEther(amount)).toFixed(0)} 个代币`, 0);
    const hash = await this.send({ wallet, to: PORTAL, inputData: pIface.encodeFunctionData('claim', [market]), label: 'Portal.claim', step });
    return { venue: 'Portal.claim', expected: +ethers.formatEther(amount), txHash: hash, hashes: [hash] };
  }

  // BNB 报价市场：链上报价 + baw 预演；非 BNB 报价市场只做链上报价说明
  async previewBuy({ wallet, market, quoteAddress, amountBnb, slippage, step }) {
    if (!isBnbQuote(quoteAddress)) { step('非 BNB 报价市场：真实下单时先 BNB→报价币，再 buyWithQuote；这里只展示行情', 0); return { dryRun: true, venue: 'Portal.buyWithQuote（未预演）', expected: null }; }
    const value = ethers.parseEther(String(amountBnb));
    let t = Date.now();
    const q = await this.quoteBuy(market, wallet, value);
    step(`Portal.quoteBuy ${(+ethers.formatEther(q.shares)).toFixed(0)} 份`, Date.now() - t);
    t = Date.now();
    const r = await baw.contractPreview({ from: wallet, to: PORTAL, valueWei: value.toString(), inputData: pIface.encodeFunctionData('buy', [market, this.minShares(q.shares, slippage)]) });
    step(`baw 预演 ${r.simulation ?? ''}${r.risks ? ` · ${r.risks} 条风险提示` : ''}`, Date.now() - t);
    return { venue: 'Portal.buy（BNB，原子）', expected: +ethers.formatEther(q.shares), feeBnb: +ethers.formatEther(q.fee), ...r };
  }

  // 发一笔合约调用；PENDING_CONFIRMATION 时提示去币安 App 确认。
  // waitConfirm=true（默认）：同步等回执（授权 / 包装等中间步需要）。false：拿到 hash 即抛 UNCONFIRMED，由 liveTrader.followUp 异步续跑「已上链」
  async send({ wallet, to, valueWei = '0', inputData, label, step, waitConfirm = true }) {
    const t = Date.now();
    const r = await baw.contractCall({ from: wallet, to, valueWei: String(valueWei), inputData });
    if (r.riskTitles?.length) step(`风险提示：${r.riskTitles.join('；')}`, 0);
    if (r.status === 'PENDING_CONFIRMATION') throw Object.assign(new Error(`${label} 需要在币安 App 里确认（${r.message || 'Please confirm in the Binance App'}），确认或拒绝之前钱包会被锁住`), { code: 'APP_CONFIRM' });
    if (!r.txHash) throw new Error(`${label} 没有返回 txHash（状态 ${r.status || '未知'}）`);
    step(`${label} 已广播 ${r.txHash.slice(0, 10)}…`, Date.now() - t, { tx: r.txHash, stage: 'broadcast' });
    if (!waitConfirm) throw Object.assign(new Error(`${label} 已广播，后台确认中：${r.txHash}`), { code: 'UNCONFIRMED', tx: r.txHash });
    let rc = null;   // 每 150ms 查一次回执（BSC 出块约 0.75 秒；ethers 默认 4s 轮询太慢）
    for (const end = Date.now() + 180_000; Date.now() < end; await sleep(150)) { rc = await this.provider.getTransactionReceipt(r.txHash).catch(() => null); if (rc) break; }
    // 已经广播但 3 分钟没等到回执：不是失败，交给上层继续盯
    if (!rc) throw Object.assign(new Error(`${label} 已广播，3 分钟内还没确认：${r.txHash}`), { code: 'UNCONFIRMED', tx: r.txHash });
    if (rc.status !== 1) throw new Error(`${label} 链上执行失败：${r.txHash}`);
    step(`${label} 已上链`, Date.now() - t);
    return r.txHash;
  }

  async ensureAllowance({ wallet, token, spender, amount, sym, step }) {
    const c = new ethers.Contract(token, ERC20_ABI, this.provider);
    if ((await c.allowance(wallet, spender)) >= amount) { step(`${sym} 授权额度够用，跳过授权`, 0); return; }
    // 按设置授「较大固定额度」（约 2 倍单笔上限的价值，不是无限额）或只授本次数量；够用的话以后就不用再授权
    const cap = await capFor({ token, wallet, amount, kind: 'quote' });
    await sendApproval({ send: (o) => this.send(o), wallet, token, spender, amount, cap, label: `授权 ${sym}（${capLabel('quote')}）`, symbol: sym, kind: 'quote', step });
    for (let i = 0; i < 20; i++) { if ((await c.allowance(wallet, spender)) >= amount) return; await sleep(1000); }
    throw new Error(`授权 ${sym} 没有在链上生效`);
  }

  async received(qc, wallet, before) {
    let got = 0n;
    for (let i = 0; i < 10; i++) { got = (await qc.balanceOf(wallet)) - before; if (got > 0n) break; await sleep(1000); }
    return got;
  }

  // 真实买入。BNB 底池：Portal.buy（原子）。其他底池：BNB→报价币 → approve → buyWithQuote（多笔交易，非原子）
  // payQuote：BNB 不够、改用钱包里现有报价币直接付时的报价币数量（liveTrader.fundingPlan 算的），跳过 BNB→报价币
  // quoteRate：1 BNB ≈ 多少报价币（liveTrader 传入）。钱包里已有的报价币先用上，够就不换；不够只用 BNB 换差额
  async buy({ wallet, market, quoteAddress, quoteSym, amountBnb, slippage, step, payQuote = null, quoteRate = null }) {
    const hashes = [];
    if (isBnbQuote(quoteAddress)) {
      const value = ethers.parseEther(String(amountBnb));
      const q = await this.quoteBuy(market, wallet, value);
      step(`Portal.quoteBuy ${(+ethers.formatEther(q.shares)).toFixed(0)} 份`, 0);
      hashes.push(await this.send({ wallet, to: PORTAL, valueWei: value, inputData: pIface.encodeFunctionData('buy', [market, this.minShares(q.shares, slippage)]), label: 'Portal.buy', step, waitConfirm: false }));
      return { venue: 'Portal.buy（BNB，原子）', expected: +ethers.formatEther(q.shares), txHash: hashes.at(-1), hashes };
    }
    const qc = new ethers.Contract(quoteAddress, ERC20_ABI, this.provider);
    const dec = Number(await qc.decimals().catch(() => 18));
    let got;
    if (payQuote != null) {
      const have = await qc.balanceOf(wallet), want = ethers.parseUnits(Number(payQuote).toFixed(Math.min(12, dec)), dec);
      got = want < have ? want : have; if (got <= 0n) throw new Error(`钱包里没有 ${quoteSym}`);
      step(`直接用钱包里的 ${ethers.formatUnits(got, dec)} ${quoteSym}`, 0);
    } else {
      const before = await qc.balanceOf(wallet);
      const need = quoteRate > 0 ? ethers.parseUnits((Number(amountBnb) * quoteRate).toFixed(Math.min(12, dec)), dec) : 0n;
      if (need > 0n && before >= need) { got = need; step(`钱包里已有足够 ${quoteSym}，直接使用 ${ethers.formatUnits(need, dec)}`, 0); }
      else {
      const short = need > 0n && before > 0n ? Math.min(Number(amountBnb), Number(amountBnb) * Number(need - before) / Number(need) * 1.03) : Number(amountBnb);
      const qty = short.toFixed(18).replace(/\.?0+$/, '');
      if (short < Number(amountBnb)) step(`钱包里有 ${ethers.formatUnits(before, dec)} ${quoteSym}，不够 ${ethers.formatUnits(need, dec)}，用 ${qty} BNB 换差额`, 0);
      const t = Date.now();
      const sw = await baw.marketSwap({ fromTokenQty: qty, fromToken: BNB_NATIVE, toToken: quoteAddress, slippage });
      if (!sw.orderId) throw new Error(`BNB→${quoteSym} 兑换没有返回 orderId`);
      step(`BNB→${quoteSym} 已提交 ${sw.orderId}`, Date.now() - t);
      const o = await baw.pollOrder(sw.orderId);
      if (o?.status !== 'FINISHED') throw new Error(`BNB→${quoteSym} 兑换${o?.status === 'FAILED' ? '失败' : '未完成（仍在处理，请在钱包里查看）'}，订单 ${sw.orderId}`);
      if (o.txHash) hashes.push(o.txHash);
      got = await this.received(qc, wallet, before);
      if (got <= 0n) throw new Error(`BNB→${quoteSym} 已完成，但余额没有增加，停止后续步骤`);
      step(`收到 ${ethers.formatUnits(got, dec)} ${quoteSym}`, Date.now() - t);
      if (short < Number(amountBnb)) got += before;   // 加上钱包里原有的那部分
      }
    }
    for (const spender of [PORTAL, market]) await this.ensureAllowance({ wallet, token: quoteAddress, spender, amount: got, sym: quoteSym, step });
    const q = await this.quoteBuy(market, wallet, got);
    step(`Portal.quoteBuy ${(+ethers.formatEther(q.shares)).toFixed(0)} 份`, 0);
    hashes.push(await this.send({ wallet, to: PORTAL, inputData: pIface.encodeFunctionData('buyWithQuote', [market, got, this.minShares(q.shares, slippage)]), label: 'Portal.buyWithQuote', step, waitConfirm: false }));
    return { venue: payQuote != null ? `钱包 ${quoteSym}→Portal.buyWithQuote` : `BNB→${quoteSym}→Portal.buyWithQuote（非原子）`, expected: +ethers.formatEther(q.shares), quoteSpent: +ethers.formatUnits(got, dec), txHash: hashes.at(-1), hashes };
  }

  // 真实卖出曲线份额，得到报价币；非 BNB 底池再用 baw 把报价币换回 BNB
  async sell({ wallet, market, quoteAddress, quoteSym, pct, slippage, step, toBnb = true }) {
    const shares = await this.sharesOf(market, wallet);
    if (shares <= 0n) throw new Error('曲线份额为 0，没有可卖的');
    step(`持有 ${(+ethers.formatEther(shares)).toFixed(0)} 份`, 0);
    const p = Math.max(1, Math.min(100, Number(pct) || 100));
    const allOut = pIface.decodeFunctionResult('sellAll', await this.provider.call({ from: wallet, to: PORTAL, data: pIface.encodeFunctionData('sellAll', [market, 0n]) }))[0];
    let inputData; let expected;
    if (p >= 100) { expected = allOut; inputData = pIface.encodeFunctionData('sellAll', [market, this.minShares(allOut, slippage)]); }
    else {
      const gross = (allOut * BigInt(Math.round(p * 100))) / 10000n;
      const sim = pIface.decodeFunctionResult('sell', await this.provider.call({ from: wallet, to: PORTAL, data: pIface.encodeFunctionData('sell', [market, gross, shares, 0n]) }));
      expected = sim[1]; inputData = pIface.encodeFunctionData('sell', [market, gross, shares, this.minShares(sim[1], slippage)]);
    }
    const bnbQuote = isBnbQuote(quoteAddress);
    const qc = bnbQuote ? null : new ethers.Contract(quoteAddress, ERC20_ABI, this.provider);
    const dec = bnbQuote ? 18 : Number(await qc.decimals().catch(() => 18));
    const before = bnbQuote ? 0n : await qc.balanceOf(wallet);
    let hashes;
    try { hashes = [await this.send({ wallet, to: PORTAL, inputData, label: p >= 100 ? 'Portal.sellAll' : `Portal.sell ${p}%`, step, waitConfirm: false })]; }
    catch (e) {
      // 卖出那笔要在币安 App 里确认（或结果未知）：报价币确认后才到账，交给上层 followUp 确认后接着换回 BNB（以前这一步被跳过，报价币留在钱包）
      const fromBlock = !bnbQuote && toBnb ? await this.provider.getBlockNumber().then((b) => b - 2).catch(() => undefined) : null;
      if (!bnbQuote && toBnb && ['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) e.afterConfirm = async (log) => {
        const got = await waitReceived({ provider: this.provider, token: quoteAddress, wallet, senders: [PORTAL, market], fromBlock });
        if (got <= 0n) return { note: `5 分钟内没收到 ${quoteSym}（可能在 App 里拒绝了），没有换回 BNB` };
        log(`收到 ${ethers.formatUnits(got, dec)} ${quoteSym}，接着换回 BNB`, 0);
        return this.swapBack({ wallet, quoteAddress, quoteSym, dec, got, slippage, step: log, hashes: [] });
      };
      throw e;
    }
    if (bnbQuote) return { venue: 'Portal.sell（BNB）', expected: +ethers.formatEther(expected), txHash: hashes[0], hashes };
    const got = await this.received(qc, wallet, before);
    if (got <= 0n) return { venue: `Portal.sell → ${quoteSym}`, expected: null, txHash: hashes[0], hashes, note: `已卖出，但没读到 ${quoteSym} 到账，没有换回 BNB` };
    if (!toBnb) return { venue: `Portal.sell → ${quoteSym}`, expected: null, txHash: hashes[0], hashes, note: `已卖出得到 ${ethers.formatUnits(got, dec)} ${quoteSym}（「卖出后自动换回 BNB」已关闭，留在钱包）` };
    return this.swapBack({ wallet, quoteAddress, quoteSym, dec, got, slippage, step, hashes });
  }

  // 卖出到账的报价币换回 BNB（只换这次到账的数量）
  async swapBack({ wallet, quoteAddress, quoteSym, dec, got, slippage, step, hashes }) {
    const t = Date.now();
    // 第二步：只换这次卖出实际到账的那部分（链上余额差，整数），失败最多再试 2 次
    let o = null, sw = {}, usdtGot = null;
    for (let k = 0; k < 3; k++) {
      try {
        if (viaUsdt(quoteAddress)) {   // Ondo 类报价币（NVDAB / FXIon …）只能和稳定币直接换：报价币→USDT→BNB；USDT 那步只换一次，重试只重试 USDT→BNB
          if (usdtGot == null) { const a = await baw.marketSwap({ fromTokenQty: ethers.formatUnits(got, dec), fromToken: quoteAddress, toToken: USDT, slippage }); const oa = a.orderId ? await baw.pollOrder(a.orderId) : null;
            if (oa && oa.status !== 'FINISHED' && oa.status !== 'FAILED') { o = oa; sw = a; break; }   // 已提交、结果未知：不重试，免得重复卖
            if (oa?.status !== 'FINISHED') throw new Error(`${quoteSym}→USDT ${oa?.status === 'FAILED' ? '失败' : '未完成'}（订单 ${a.orderId || '无'}）`); if (oa.txHash) hashes.push(oa.txHash); usdtGot = String(oa.toTokenActualQty); step(`${quoteSym}→USDT 完成 ${usdtGot}`, Date.now() - t); }
          sw = await baw.marketSwap({ fromTokenQty: usdtGot, fromToken: USDT, toToken: BNB_NATIVE, slippage });
        } else sw = await baw.marketSwap({ fromTokenQty: ethers.formatUnits(got, dec), fromToken: quoteAddress, toToken: BNB_NATIVE, slippage });
        o = sw.orderId ? await baw.pollOrder(sw.orderId) : null;
      } catch (e) { if (ONDO_RE.test(e.message) && !viaUsdt(quoteAddress)) { markViaUsdt(quoteAddress); k--; step(`${quoteSym} 只能和稳定币直接兑换（Ondo 类），改走 USDT`, Date.now() - t); continue; } o = { status: 'FAILED', err: e.message }; }
      if (o?.status === 'FINISHED' || (o && o.status !== 'FAILED')) break;
      step(`${quoteSym}→BNB 第 ${k + 1} 次没成功${o?.err ? '：' + o.err.slice(0, 60) : ''}，重试`, Date.now() - t); await new Promise((r) => setTimeout(r, 2000 * (k + 1)));
    }
    if (o?.txHash) hashes.push(o.txHash);
    if (o?.status !== 'FINISHED') return { venue: `Portal.sell → ${quoteSym}`, expected: null, txHash: hashes[0], hashes, note: `已卖出得到 ${ethers.formatUnits(got, dec)} ${quoteSym}，换回 BNB ${o?.status === 'FAILED' ? '失败' : '未完成'}（订单 ${sw.orderId || '无'}）${usdtGot != null ? `；已换出 ${usdtGot} USDT 留在钱包` : ''}` };
    step(`${quoteSym}→BNB 完成`, Date.now() - t);
    return { venue: `Portal.sell → ${quoteSym} → BNB`, expected: Number(o.toTokenActualQty || 0), txHash: hashes.at(-1), hashes };
  }
}
