// Feast（feast.meme）内盘买卖。Feast 的币一开盘就在 PancakeSwap Infinity 的真池子里交易（没有曲线、没有毕业迁移），
// 计价币是 WBNB 或币股（AAPLB / NVDAB / QQQB …）。买和卖都是 Infinity Universal Router 的一笔 execute：
//   买：WRAP_ETH → [V3_SWAP_EXACT_IN WBNB→…→报价币，币股计价时] → INFI_SWAP[ SETTLE(报价币) · CL_SWAP_EXACT_IN_SINGLE(Feast 池, hookData) · TAKE_ALL(代币) ]
//   卖：INFI_SWAP[ CL_SWAP_EXACT_IN_SINGLE(代币→报价币, hookData) · SETTLE_ALL(代币) · TAKE(报价币→router) ] → [V3_SWAP_EXACT_IN 报价币→…→WBNB] → UNWRAP_WETH(调用者)
// 卖出前代币要先能被 Permit2 划走：token.approve(Permit2)（按授权策略，一次）+ Permit2.approve(token, router, 额度, 30 天)；之后每次卖出一笔交易。
// 报价：MixedQuoter.quoteMixedExactInput 用 eth_call 模拟（from = 钱包：开盘头几块每个钱包的上限按 tx.origin 算，只有从钱包地址模拟才知道这笔买不买得进）。
// 手续费：每笔 1%，由 hook 在报价币一侧收，合约写死。hookData 带引荐人地址时，这笔手续费里的引荐份额（发币人定 0–30%，默认 10%，即成交额的 0.1%）
// 记到该地址名下；钱包第一次带引荐人的成交会终身绑定（FeastReferrals.referrerOf），之后每笔都算给这个引荐人。FEAST_REFERRER 留空 = 不带。
// 编码和 feast.meme 站点的编码器逐字节一致（对照 feast-agent 仓 src/sdk/infinity.ts；scripts/feast.test.mjs 用站点编码器的 fixture 逐字节核对）。
import { ethers } from 'ethers';
import { capFor, capLabel, sendApproval } from './approvals.js';
import { FEAST_REFERRER } from './config.js';

export const FEAST = {
  router: '0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB',        // PancakeSwap Infinity Universal Router
  permit2: '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768',       // Permit2（卖出时 router 从这里划走代币）
  mixedQuoter: '0x2dCbF7B985c8C5C931818e4E107bAe8aaC8dAB7C',   // MixedQuoter（v3 跳 + Infinity CL 池一起报价，只用 eth_call）
  factory: '0x1003b54659F5e31A7391fEBE824A137e8CDa90da',       // FeastFactory：getCoin / poolKeyFor
  hook: '0xABFB955e4582f49dc741DCf5354fbB0edaD0A7c5',          // FeastHook：手续费、分成（池子 key 里的 hooks）
  referrals: '0x01bc8640af92f4E556cB38644bC3DA5f41f253a4',     // FeastReferrals：钱包 → 终身绑定的引荐人（referrerOf）
  poolManager: '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b',   // Infinity CL PoolManager
  wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  usdt: '0x55d398326f99059fF775485246999027B3197955',
};

// 币股计价的池子，BNB 要先经 PancakeSwap v3 换成币股（和 feast.meme 站点同一张路线表）：买 = WBNB→…→币股，卖 = 币股→…→WBNB
const STOCKS = [
  { symbol: 'AAPLB', address: '0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A', buy: [[FEAST.usdt, 100], ['0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A', 2500]], sell: [[FEAST.usdt, 2500], [FEAST.wbnb, 100]] },
  { symbol: 'BABAB', address: '0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec', buy: [[FEAST.usdt, 100], ['0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec', 2500]], sell: [[FEAST.usdt, 2500], [FEAST.wbnb, 100]] },
  { symbol: 'BNCB', address: '0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f', buy: [['0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f', 2500]], sell: [[FEAST.wbnb, 2500]] },
  { symbol: 'CRCLB', address: '0x80f3D493EBCe97e343c53D29a137942416B4ffC0', buy: [[FEAST.usdt, 100], ['0x80f3D493EBCe97e343c53D29a137942416B4ffC0', 2500]], sell: [[FEAST.usdt, 2500], [FEAST.wbnb, 100]] },
  { symbol: 'GOOGLB', address: '0x3F53De71c126BdaBAe20f9cD64848d317f6C3238', buy: [[FEAST.usdt, 100], ['0x3F53De71c126BdaBAe20f9cD64848d317f6C3238', 2500]], sell: [[FEAST.usdt, 2500], [FEAST.wbnb, 100]] },
  { symbol: 'NVDAB', address: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436', buy: [[FEAST.usdt, 100], ['0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436', 2500]], sell: [[FEAST.usdt, 2500], [FEAST.wbnb, 100]] },
  { symbol: 'QQQB', address: '0x205812CdBed920aFf76C6580abD681a46D11efc7', buy: [['0x205812CdBed920aFf76C6580abD681a46D11efc7', 500]], sell: [[FEAST.wbnb, 500]] },
  { symbol: 'SKHYB', address: '0xCA750eF65f295BBECd685Abf54e82CAf297BDB61', buy: [[FEAST.usdt, 100], ['0xCA750eF65f295BBECd685Abf54e82CAf297BDB61', 2500]], sell: [[FEAST.usdt, 2500], [FEAST.wbnb, 100]] },
  { symbol: 'SPCXB', address: '0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1', buy: [['0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1', 2500]], sell: [[FEAST.wbnb, 2500]] },
  { symbol: 'TSLAB', address: '0x5b1910eAaD6450E50f816082Aa078C41F10C292f', buy: [[FEAST.usdt, 100], ['0x5b1910eAaD6450E50f816082Aa078C41F10C292f', 2500]], sell: [[FEAST.usdt, 2500], [FEAST.wbnb, 100]] },
];
export const STOCK_ROUTES = Object.fromEntries(STOCKS.map((s) => [s.address.toLowerCase(), { symbol: s.symbol, buy: s.buy.map(([tokenOut, fee]) => ({ tokenOut, fee })), sell: s.sell.map(([tokenOut, fee]) => ({ tokenOut, fee })) }]));
// 报价币 → 路线：WBNB 池不用跳；币股池按上表；别的报价币本终端不认（报错，不下单）
export function hopsFor(quote, side) {
  const q = String(quote).toLowerCase();
  if (q === FEAST.wbnb.toLowerCase()) return [];
  const s = STOCK_ROUTES[q]; if (!s) throw new Error(`Feast 报价币 ${q.slice(0, 6)}…${q.slice(-4)} 不在路线表里，不下单`);
  return side === 'buy' ? s.buy : s.sell;
}

// ---------- 编码（Universal Router 的 commands / inputs，和站点逐字节一致） ----------
const coder = ethers.AbiCoder.defaultAbiCoder();
export const COMMAND = { V3_SWAP_EXACT_IN: 0x00, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, INFI_SWAP: 0x10 };
export const ACTION = { CL_SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f };
export const OPEN_DELTA = 0n;                      // 「有多少换多少」：输入量 0
export const CONTRACT_BALANCE = 1n << 255n;        // 「router 手里这个币的全部余额」
export const MSG_SENDER = '0x0000000000000000000000000000000000000001';   // 收款人 = 调 execute 的人
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'; // 收款人 = router 自己
export const MAX_UINT160 = (1n << 160n) - 1n;
const POOL_KEY = 'tuple(address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters)';
const b1 = (n) => ethers.toBeHex(n, 1);
const keyArr = (k) => [k.currency0, k.currency1, k.hooks, k.poolManager, k.fee, k.parameters];

export function encodeAction(a) {
  switch (a.action) {
    case 'CL_SWAP_EXACT_IN_SINGLE': return coder.encode([`tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`], [[keyArr(a.poolKey), a.zeroForOne, a.amountIn, a.amountOutMinimum, a.hookData]]);
    case 'SETTLE': return coder.encode(['address', 'uint256', 'bool'], [a.currency, a.amount, a.payerIsUser]);
    case 'SETTLE_ALL': return coder.encode(['address', 'uint256'], [a.currency, a.maxAmount]);
    case 'TAKE': return coder.encode(['address', 'address', 'uint256'], [a.currency, a.recipient, a.amount]);
    case 'TAKE_ALL': return coder.encode(['address', 'uint256'], [a.currency, a.minAmount]);
    default: throw new Error(`unknown action ${a.action}`);
  }
}
// INFI_SWAP 的 input：abi.encode(bytes actions, bytes[] params)
export const encodeActions = (actions) => coder.encode(['bytes', 'bytes[]'], [actions.length ? ethers.concat(actions.map((a) => b1(ACTION[a.action]))) : '0x', actions.map(encodeAction)]);
export function encodeCommandInput(c) {
  switch (c.command) {
    case 'V3_SWAP_EXACT_IN': return coder.encode(['address', 'uint256', 'uint256', 'bytes', 'bool'], [c.recipient, c.amountIn, c.amountOutMin, c.path, c.payerIsUser]);
    case 'WRAP_ETH': return coder.encode(['address', 'uint256'], [c.recipient, c.amount]);
    case 'UNWRAP_WETH': return coder.encode(['address', 'uint256'], [c.recipient, c.amountMin]);
    case 'INFI_SWAP': return encodeActions(c.actions);
    default: throw new Error(`unknown command ${c.command}`);
  }
}
const routerIface = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
// 整笔 calldata：execute(commands, inputs, deadline)
export const encodeExecute = (steps, deadline) => routerIface.encodeFunctionData('execute', [steps.length ? ethers.concat(steps.map((s) => b1(COMMAND[s.command]))) : '0x', steps.map(encodeCommandInput), deadline]);
// v3 路径：token ‖ fee(3 字节) ‖ token …
export const v3Path = (tokenIn, hops) => ethers.concat([tokenIn, ...hops.flatMap((h) => [ethers.toBeHex(h.fee, 3), h.tokenOut])]).toLowerCase();
// PoolIdLibrary.toId：六个字段 abi.encode 后的 keccak
export const poolIdOf = (k) => ethers.keccak256(coder.encode([POOL_KEY], [keyArr(k)]));
// hook 的引荐人字段：一个 32 字节的地址，没有就是空
export const hookDataFor = (referrer) => (!referrer || !ethers.isAddress(referrer) || BigInt(referrer) === 0n ? '0x' : coder.encode(['address'], [ethers.getAddress(referrer)]));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// 买：BNB 进、代币出（到调用者）。payIn = 'quote' 时直接用钱包里的报价币付（经 Permit2 划走），不 wrap、不跳、不带 value
export function buyCommands(plan) {
  const feastBuy = (settle) => [
    { action: 'SETTLE', currency: plan.quote, amount: settle.amount, payerIsUser: settle.payerIsUser },
    { action: 'CL_SWAP_EXACT_IN_SINGLE', poolKey: plan.poolKey, zeroForOne: same(plan.quote, plan.poolKey.currency0), amountIn: OPEN_DELTA, amountOutMinimum: plan.minOut, hookData: plan.hookData },
    { action: 'TAKE_ALL', currency: plan.coin, minAmount: plan.minOut },
  ];
  if (plan.payIn === 'quote') return [{ command: 'INFI_SWAP', actions: feastBuy({ amount: plan.amountIn, payerIsUser: true }) }];
  const steps = [{ command: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: plan.amountIn }];
  if (plan.hops.length) steps.push({ command: 'V3_SWAP_EXACT_IN', recipient: ADDRESS_THIS, amountIn: CONTRACT_BALANCE, amountOutMin: 0n, path: v3Path(plan.wrappedNative, plan.hops), payerIsUser: false });
  steps.push({ command: 'INFI_SWAP', actions: feastBuy({ amount: CONTRACT_BALANCE, payerIsUser: false }) });
  return steps;
}
// 卖：代币进（Permit2 划走）、BNB 出（到调用者）。最低到手按 BNB 算，所以在 UNWRAP_WETH 那一步检查
export function sellCommands(plan) {
  const swap = (amountOutMinimum) => ({ action: 'CL_SWAP_EXACT_IN_SINGLE', poolKey: plan.poolKey, zeroForOne: same(plan.coin, plan.poolKey.currency0), amountIn: plan.amountIn, amountOutMinimum, hookData: plan.hookData });
  if (plan.payIn === 'quote') return [{ command: 'INFI_SWAP', actions: [swap(plan.minOut), { action: 'SETTLE_ALL', currency: plan.coin, maxAmount: plan.amountIn }, { action: 'TAKE_ALL', currency: plan.quote, minAmount: plan.minOut }] }];
  const steps = [{ command: 'INFI_SWAP', actions: [swap(plan.hops.length ? 0n : plan.minOut), { action: 'SETTLE_ALL', currency: plan.coin, maxAmount: plan.amountIn }, { action: 'TAKE', currency: plan.quote, recipient: ADDRESS_THIS, amount: OPEN_DELTA }] }];
  if (plan.hops.length) steps.push({ command: 'V3_SWAP_EXACT_IN', recipient: ADDRESS_THIS, amountIn: CONTRACT_BALANCE, amountOutMin: 0n, path: v3Path(plan.quote, plan.hops), payerIsUser: false });
  steps.push({ command: 'UNWRAP_WETH', recipient: MSG_SENDER, amountMin: plan.minOut });
  return steps;
}

// ---------- 链上读、报价、下单 ----------
const factoryIface = new ethers.Interface([
  'function getCoin(address coin) view returns (tuple(address quote,address creator,bytes32 poolId,uint256 supply,bytes32 metadataHash))',
  `function poolKeyFor(address coin) view returns (${POOL_KEY})`,
]);
const referralsIface = new ethers.Interface(['function referrerOf(address wallet) view returns (address)']);
const quoterIface = new ethers.Interface(['function quoteMixedExactInput(address[] paths, bytes actions, bytes[] params, uint256 amountIn) returns (uint256 amountOut, uint256 gasEstimate)']);
const permit2Iface = new ethers.Interface(['function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)', 'function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
// 路径上会碰到的拒绝原因，模拟失败时解码成可读的
const errIface = new ethers.Interface(['error ExecutionFailed(uint256 commandIndex, bytes message)', 'error TransactionDeadlinePassed()', 'error InsufficientETH()', 'error InsufficientToken()', 'error V3TooLittleReceived()', 'error TooLittleReceived(uint256 minimumAmountReceived, uint256 amountReceived)', 'error AllowanceExpired(uint256 deadline)', 'error InsufficientAllowance(uint256 amount)', 'error NotEnoughLiquidity(bytes32 poolId)', 'error EnforcedPause()', 'error ContractLocked()']);
const MIXED_V3 = 0x03, MIXED_INFI_CL = 0x04;   // MixedQuoterActions.sol
const f18 = (v) => Number(ethers.formatEther(v));
const minOutOf = (v, slippagePct) => (v * BigInt(10000 - Math.min(9900, Math.round(slippagePct * 100)))) / 10000n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
export const readable = (e) => { try { const p = errIface.parseError(e.data || e.info?.error?.data || '0x'); if (p) return `${p.name}(${p.args.map(String).join(', ')})`; } catch { /* 不是已知错误 */ } return e.shortMessage || e.message; };

export class FeastTrade {
  constructor(provider, send, { referrer = FEAST_REFERRER } = {}) { this.provider = provider; this.send = send; this.referrer = referrer; this.cache = new Map(); }   // send = Portal.send（baw contract-call preview + execute + 等上链）

  async read(to, i, fn, args, from) { return i.decodeFunctionResult(fn, await this.provider.call({ to, data: i.encodeFunctionData(fn, args), ...(from ? { from } : {}) })); }
  hookData() { return hookDataFor(this.referrer); }

  // 这个币的池子：工厂给的 key 要能 hash 成登记的 poolId（不是 Feast 工厂发的币直接拒绝）。结果缓存
  async info(coin) {
    const k = String(coin).toLowerCase();
    if (this.cache.has(k)) return this.cache.get(k);
    const p = (async () => {
      const [[c], [key]] = await Promise.all([this.read(FEAST.factory, factoryIface, 'getCoin', [coin]), this.read(FEAST.factory, factoryIface, 'poolKeyFor', [coin])]);
      if (BigInt(c.quote) === 0n) throw new Error('不是 Feast 工厂发的币');
      const poolKey = { currency0: key.currency0, currency1: key.currency1, hooks: key.hooks, poolManager: key.poolManager, fee: Number(key.fee), parameters: key.parameters };
      if (poolIdOf(poolKey).toLowerCase() !== String(c.poolId).toLowerCase()) throw new Error('工厂给的池子 key 和登记的 poolId 对不上');
      const quote = c.quote, isBnb = same(quote, FEAST.wbnb);
      return { coin: ethers.getAddress(coin), quote, quoteSym: isBnb ? 'BNB' : STOCK_ROUTES[quote.toLowerCase()]?.symbol || '?', creator: c.creator, poolId: c.poolId, poolKey, coinIsCurrency0: same(key.currency0, coin), hopsBuy: hopsFor(quote, 'buy'), hopsSell: hopsFor(quote, 'sell') };
    })();
    this.cache.set(k, p); p.catch(() => this.cache.delete(k));
    return p;
  }

  // 这个钱包终身绑定的引荐人（第一次带引荐人的成交时记下），没有 = null
  async referrerOf(wallet) { const [r] = await this.read(FEAST.referrals, referralsIface, 'referrerOf', [wallet]); return BigInt(r) === 0n ? null : r; }
  async balance(token, wallet) { return (await this.read(token, erc20, 'balanceOf', [wallet]))[0]; }

  // MixedQuoter：报价是「模拟 + 回滚」，只能 eth_call；from 给钱包地址（开盘上限按 tx.origin 算）
  async mixed(from, paths, actions, params, amountIn) {
    const data = quoterIface.encodeFunctionData('quoteMixedExactInput', [paths, ethers.concat(actions.map(b1)), params, amountIn]);
    let ret; try { ret = await this.provider.call({ from, to: FEAST.mixedQuoter, data }); } catch (e) { throw new Error(`Feast 报价失败：${readable(e)}`); }
    return quoterIface.decodeFunctionResult('quoteMixedExactInput', ret)[0];
  }
  hopsQuote(from, tokenIn, hops, amountIn) { return this.mixed(from, [tokenIn, ...hops.map((h) => h.tokenOut)], hops.map(() => MIXED_V3), hops.map((h) => coder.encode(['uint24'], [h.fee])), amountIn); }
  feastQuote(from, poolKey, tokenIn, tokenOut, amountIn) { return this.mixed(from, [tokenIn, tokenOut], [MIXED_INFI_CL], [coder.encode([`tuple(${POOL_KEY} poolKey,bytes hookData)`], [[keyArr(poolKey), this.hookData()]])], amountIn); }

  // 买 amountBnb 个 BNB 能换到多少个币：先经 v3 跳换成报价币（币股池），再进 Feast 池。legQuote = 进池的报价币数量（手续费 1% 从这上面扣）
  async quoteBuy(token, wallet, amountBnb) {
    const i = await this.info(token), amountIn = ethers.parseEther(String(amountBnb));
    const legQuote = i.hopsBuy.length ? await this.hopsQuote(wallet, FEAST.wbnb, i.hopsBuy, amountIn) : amountIn;
    const out = await this.feastQuote(wallet, i.poolKey, i.quote, i.coin, legQuote);
    return { out, legQuote, outNum: f18(out), feeBnb: Number(amountBnb) * 0.01, info: i };
  }
  // 卖 tokensIn 个币能拿回多少 BNB（wei）
  async quoteSell(token, wallet, tokensIn) {
    const i = await this.info(token);
    const legQuote = await this.feastQuote(wallet, i.poolKey, i.coin, i.quote, tokensIn);
    const out = i.hopsSell.length ? await this.hopsQuote(wallet, i.quote, i.hopsSell, legQuote) : legQuote;
    return { out, legQuote, outNum: f18(out), info: i };
  }

  plan(i, side, amountIn, minOut) { return { wrappedNative: FEAST.wbnb, quote: i.quote, coin: i.coin, hops: side === 'buy' ? i.hopsBuy : i.hopsSell, poolKey: i.poolKey, amountIn, minOut, hookData: this.hookData() }; }

  // 买入：报价 → 链上模拟（从钱包地址 eth_call，回滚就不发）→ baw 执行 router.execute{value}，一笔原子
  async buy({ wallet, token, amountBnb, slippage, step }) {
    const q = await this.quoteBuy(token, wallet, amountBnb), i = q.info, value = ethers.parseEther(String(amountBnb));
    if (q.out <= 0n) throw new Error('报价为 0：可能还没开盘，或开盘头几块每个钱包的上限已满');
    step(`Feast 报价 ${q.outNum.toFixed(0)} 个（${i.quoteSym === 'BNB' ? 'BNB 池' : `BNB→${i.quoteSym} 再进池`}，手续费 1%${this.hookData() !== '0x' ? '，带引荐人' : ''}）`, 0);
    const inputData = encodeExecute(buyCommands(this.plan(i, 'buy', value, minOutOf(q.out, slippage))), deadline());
    await this.simulate(wallet, inputData, value);
    const hash = await this.send({ wallet, to: FEAST.router, valueWei: value, inputData, label: 'Feast buy', step });
    return { venue: `Feast 真池子 buy（BNB${i.quoteSym === 'BNB' ? '' : `→${i.quoteSym}`}，一笔完成）`, expected: q.outNum, txHash: hash, hashes: [hash] };
  }

  // 卖出：按比例算数量 → Permit2 两道授权（不够时）→ 报价 → 链上模拟 → baw 执行 router.execute，到手 BNB
  async sell({ wallet, token, pct, slippage, step }) {
    const i = await this.info(token), bal = await this.balance(token, wallet);
    if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
    step(`卖出 ${f18(amt).toFixed(0)} 个（持有 ${f18(bal).toFixed(0)}）`, 0);
    const hashes = [];
    // 1) token.approve(Permit2)：按授权策略授「较大固定额度」或本次数量
    const allowance = (await this.read(token, erc20, 'allowance', [wallet, FEAST.permit2]))[0];
    if (allowance < amt) { const cap = await capFor({ token, wallet, amount: amt, kind: 'sell' }); hashes.push(await sendApproval({ send: (o) => this.send(o), wallet, token, spender: FEAST.permit2, amount: amt, cap, label: `授权 Permit2（${capLabel('sell')}）`, kind: 'sell', step })); }
    else step('Permit2 的代币授权够用，跳过', 0);
    // 2) Permit2.approve(token, router, 额度, 30 天)：router 的额度在 Permit2 里单独记，有期限
    const [p2Amount, p2Exp] = await this.read(FEAST.permit2, permit2Iface, 'allowance', [wallet, token, FEAST.router]);
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(p2Amount) < amt || Number(p2Exp) < now + 3600) {
      let cap = await capFor({ token, wallet, amount: amt, kind: 'sell' }); if (cap > MAX_UINT160) cap = MAX_UINT160;
      hashes.push(await this.send({ wallet, to: FEAST.permit2, inputData: permit2Iface.encodeFunctionData('approve', [token, FEAST.router, cap, now + 30 * 24 * 3600]), label: 'Permit2 授权 router（30 天）', step }));
    } else step('Permit2 给 router 的额度够用，跳过', 0);
    const q = await this.quoteSell(token, wallet, amt);
    const inputData = encodeExecute(sellCommands(this.plan(i, 'sell', amt, minOutOf(q.out, slippage))), deadline());
    await this.simulate(wallet, inputData, 0n);
    hashes.push(await this.send({ wallet, to: FEAST.router, inputData, label: 'Feast sell', step }));
    return { venue: `Feast 真池子 sell（${i.quoteSym === 'BNB' ? '' : `${i.quoteSym}→`}BNB，一笔完成）`, expected: q.outNum, txHash: hashes.at(-1), hashes };
  }

  // 发交易前先用 eth_call 跑一遍，回滚就直接报错，不浪费 gas
  async simulate(from, data, value) {
    try { await this.provider.call({ from, to: FEAST.router, data, value }); }
    catch (e) { throw new Error(`链上模拟失败：${readable(e)}`); }
  }
}
