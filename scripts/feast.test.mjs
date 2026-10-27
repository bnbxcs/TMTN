// Feast 适配器测试：`npm run test:feast`（node --test）。不连钱包、不发任何交易。
// 1) 编码：用 feast.meme 站点编码器的 fixture（scripts/fixtures/feast-infinity.json）逐字节核对买 / 卖 calldata；
// 2) 池子 id 的 hash、hookData、v3 路径、路线表、价格换算；
// 3) FEAST_LIVE=1 时再跑只读的主网检查（公共节点 eth_call：读工厂、MixedQuoter 报价、用余额覆盖模拟一笔买入的 calldata；读公开接口的币列表）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { FEAST, FeastTrade, STOCK_ROUTES, hopsFor, buyCommands, sellCommands, encodeExecute, poolIdOf, hookDataFor, v3Path, CONTRACT_BALANCE, MAX_UINT160 } from '../engine/live/feastTrade.js';
import { FeastApi, priceQuoteOf, ipfsUrl, imageUrlOk, quoteSymbolOf } from '../engine/live/feastApi.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/feast-infinity.json', import.meta.url), 'utf8'));
const planOf = (i) => ({ wrappedNative: i.wrappedNative, quote: i.quote, coin: i.coin, hops: i.hops, poolKey: i.poolKey, amountIn: BigInt(i.amountIn), minOut: BigInt(i.minOut), hookData: i.hookData, payIn: i.payIn });
// FEAST（平台币）的池子，和 /api/v1/pools 给的一致
const FEAST_COIN = '0x747dC14ec8B21bD9137dAc9148d61A084c18C2A2';
const FEAST_KEY = { currency0: FEAST_COIN, currency1: FEAST.wbnb, hooks: FEAST.hook, poolManager: FEAST.poolManager, fee: 100, parameters: '0x0000000000000000000000000000000000000000000000000000000000c80cc1' };

for (const [name, c] of Object.entries(fx.cases)) {
  test(`calldata matches the site encoder: ${name}`, () => {
    const plan = planOf(c.input);
    const steps = name.startsWith('buy') ? buyCommands(plan) : sellCommands(plan);
    assert.equal(encodeExecute(steps, BigInt(c.deadline)), c.data);
  });
}

test('the recorded FEAST buy (probe) encodes byte for byte', () => {
  const plan = { wrappedNative: FEAST.wbnb, quote: FEAST.wbnb, coin: FEAST_COIN, hops: [], poolKey: FEAST_KEY, amountIn: BigInt(fx.probe.input.amountIn), minOut: BigInt(fx.probe.input.minOut), hookData: fx.probe.input.hookData };
  assert.equal(encodeExecute(buyCommands(plan), BigInt(fx.probe.deadline)), fx.probe.data);
});

test('FEAST pool key hashes to its registered pool id', () => {
  assert.equal(poolIdOf(FEAST_KEY), fx.poolIds.feast);
});

test('a native buy carries value; command bytes are WRAP_ETH + INFI_SWAP for a WBNB pool, with a V3 hop for a stock pool', () => {
  const iface = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
  const plan = { wrappedNative: FEAST.wbnb, quote: FEAST.wbnb, coin: FEAST_COIN, hops: [], poolKey: FEAST_KEY, amountIn: 10n ** 15n, minOut: 1n, hookData: '0x' };
  const d = iface.decodeFunctionData('execute', encodeExecute(buyCommands(plan), 7n));
  assert.equal(d[0], '0x0b10'); assert.equal(d[2], 7n);
  const stock = { ...plan, quote: STOCK_ROUTES[Object.keys(STOCK_ROUTES)[0]] && Object.keys(STOCK_ROUTES)[0], hops: hopsFor(Object.keys(STOCK_ROUTES)[0], 'buy') };
  assert.equal(iface.decodeFunctionData('execute', encodeExecute(buyCommands(stock), 7n))[0], '0x0b0010');
  const sell = iface.decodeFunctionData('execute', encodeExecute(sellCommands({ ...stock, hops: hopsFor(Object.keys(STOCK_ROUTES)[0], 'sell') }), 7n));
  assert.equal(sell[0], '0x10000c');
});

test('hookData is one word naming the referrer, or nothing', () => {
  assert.equal(hookDataFor(null), '0x');
  assert.equal(hookDataFor(''), '0x');
  assert.equal(hookDataFor('0x0000000000000000000000000000000000000000'), '0x');
  assert.equal(hookDataFor('0x000000000000000000000000000000000000bEEF'), '0x000000000000000000000000000000000000000000000000000000000000beef');
});

test('v3 path walks the hops; routes exist for every stock, none for WBNB, refused for strangers', () => {
  const aaplb = '0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A';
  assert.equal(v3Path(FEAST.wbnb, hopsFor(aaplb, 'buy')), ('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' + '000064' + '55d398326f99059fF775485246999027B3197955' + '0009c4' + '431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A').toLowerCase());
  assert.deepEqual(hopsFor(FEAST.wbnb, 'buy'), []);
  for (const a of Object.keys(STOCK_ROUTES)) { assert.ok(hopsFor(a, 'buy').length >= 1); assert.equal(hopsFor(a, 'sell').at(-1).tokenOut.toLowerCase(), FEAST.wbnb.toLowerCase()); }
  assert.throws(() => hopsFor(FEAST.usdt, 'buy'), /不在路线表里/);
  assert.equal(CONTRACT_BALANCE, 1n << 255n); assert.equal(MAX_UINT160, 2n ** 160n - 1n);
});

const CID0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';                 // CIDv0, 46 chars
const CID1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';    // CIDv1, 59 chars

test('price from sqrtPriceX96 in either pool orientation; metadata and image URLs go through feast.meme', () => {
  const sqrt = 2n ** 96n * 2n;   // token1/token0 = 4
  assert.equal(priceQuoteOf(sqrt, true), 4);
  assert.equal(priceQuoteOf(sqrt, false), 0.25);
  assert.equal(priceQuoteOf('0', true), 0);
  assert.equal(ipfsUrl(`ipfs://${CID1}`), `https://feast.meme/api/ipfs/${CID1}`);
  assert.equal(ipfsUrl(CID0), `https://feast.meme/api/ipfs/${CID0}`);
  assert.equal(ipfsUrl(''), null);
});

test('metadata never makes the server fetch a URL of its own choosing: only CID-shaped values, only via feast.meme', async () => {
  // 不是 CID 形式的一律拒绝（绝对网址、内网地址、路径穿越、查询串、过短过长）
  for (const bad of ['https://evil.example/meta.json', 'http://127.0.0.1:8545/', 'ipfs://https://evil.example/x', `ipfs://${CID1}/../../admin`, `${CID1}?x=1`, `${CID0}#frag`, 'bafyabc', 'Q'.repeat(101), 'ipfs://', null, undefined, 42]) {
    assert.equal(ipfsUrl(bad), null, `should reject ${String(bad)}`);
  }
  // 图片网址还要过和头像代理一样的检查：https、无账号密码、默认端口、站点主机
  assert.equal(imageUrlOk(`https://feast.meme/api/ipfs/${CID0}`), true);
  for (const bad of [`http://feast.meme/api/ipfs/${CID0}`, `https://evil.example/api/ipfs/${CID0}`, `https://user:pw@feast.meme/api/ipfs/${CID0}`, `https://feast.meme:8443/api/ipfs/${CID0}`, 'https://feast.meme.evil.example/x', 'javascript:alert(1)', '']) {
    assert.equal(imageUrlOk(bad), false, `should reject ${bad}`);
  }
  // 端到端：loadMeta 对非 CID 的元数据指针不发请求；对合法 CID 返回的恶意 image / 链接字段不透传
  const calls = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: true, json: async () => ({ image: 'https://evil.example/a.png', description: 'x'.repeat(5000), website: 'javascript:alert(1)', twitter: '@someone', telegram: 'https://t.me/some_group' }) }; };
  try {
    const api = new FeastApi(); const got = [];
    api.on('meta', (a, m) => got.push([a, m]));
    assert.equal(api.loadMeta('0x' + '1'.repeat(40), 'https://evil.example/meta.json'), null);
    assert.equal(api.loadMeta('0x' + '1'.repeat(40), 'ipfs://http://169.254.169.254/latest/meta-data/'), null);
    assert.deepEqual(calls, []);
    await api.loadMeta('0x' + '2'.repeat(40), `ipfs://${CID1}`);
    assert.deepEqual(calls, [`https://feast.meme/api/ipfs/${CID1}`]);
    assert.equal(got.length, 1);
    assert.equal(got[0][1].image, null);                       // 绝对网址的图片不透传
    assert.equal(got[0][1].description.length, 2000);
    assert.equal(got[0][1].website, '');                       // javascript: 不透传
    assert.equal(got[0][1].twitter, '@someone');
    assert.equal(got[0][1].telegram, 'https://t.me/some_group');
  } finally { globalThis.fetch = realFetch; }
});

test('the quote symbol comes from the quote address; a <script> symbol from the API never reaches the page', () => {
  const api = new FeastApi();
  const coin = '0x' + 'c'.repeat(40), evil = '<script>alert(1)</script>';
  const pool = (quoteAddress, symbol) => ({ coin: { address: coin, name: 'x', symbol: 'X', metadataCid: CID1 }, poolId: '0x' + '0'.repeat(64), poolKey: { currency0: coin, currency1: quoteAddress }, quote: { address: quoteAddress, symbol }, market: { lastPriceSqrtX96: String(2n ** 96n) } });
  const unknown = '0x' + 'd'.repeat(40), stock = Object.keys(STOCK_ROUTES)[0];
  assert.equal(api.fromPool(pool(unknown, evil)).quoteSymbol, '?');
  assert.equal(api.fromPool(pool(FEAST.wbnb, evil)).quoteSymbol, 'BNB');
  assert.equal(api.fromPool(pool(stock, evil)).quoteSymbol, STOCK_ROUTES[stock].symbol);
  assert.equal(api.fromPool(pool(unknown, 'NEWSTOCK')).quoteSymbol, 'NEWSTOCK');       // 映射外的地址：只认 1–12 位字母数字
  assert.equal(api.fromPool(pool(unknown, 'BNB')).quoteSymbol, '?');                   // 映射外的地址不能冒充 BNB
  assert.equal(api.fromPool(pool(unknown, 'a'.repeat(13))).quoteSymbol, '?');
  assert.equal(quoteSymbolOf(unknown, 'x y'), '?');
  assert.equal(quoteSymbolOf(unknown, 'x"onmouseover="1'), '?');
  // 接口里的 quote.address 不是地址时以池子 key 为准；metadataCid 不是 CID 时丢弃
  const p = pool(unknown, evil); p.quote.address = 'javascript:1'; p.coin.metadataCid = 'https://evil.example/m.json';
  const it = api.fromPool(p);
  assert.equal(it.quoteAddress, unknown); assert.equal(it.quoteSymbol, '?'); assert.equal(it.metadataCid, null);
});

test('a creator that is not an address is dropped; the info box and the block links never render it raw', () => {
  const api = new FeastApi();
  const coin = '0x' + 'c'.repeat(40), evil = '<img src=x onerror=alert(1)>';
  const pool = (creator) => ({ coin: { address: coin, name: 'x', symbol: 'X', metadataCid: CID1 }, creator, poolId: '0x' + '0'.repeat(64), poolKey: { currency0: coin, currency1: FEAST.wbnb }, quote: { address: FEAST.wbnb, symbol: 'WBNB' }, market: { lastPriceSqrtX96: String(2n ** 96n) } });
  assert.equal(api.fromPool(pool(evil)).creator, null);
  assert.equal(api.fromPool(pool('0x' + 'e'.repeat(40) + '"><b>')).creator, null);
  assert.equal(api.fromPool(pool(undefined)).creator, null);
  assert.equal(api.fromPool(pool('0x' + 'AbCdEf'.repeat(6) + 'AbCd')).creator, '0x' + 'abcdef'.repeat(6) + 'abcd');
  // 页面这一层也转义：从 public/app.js 原样取出 esc / short / lcA / box / blockLinks，喂一个没经过 fromPool 的恶意 creator
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const grab = (re) => { const m = app.match(re); assert.ok(m, `public/app.js: ${re}`); return m[0]; };
  const src = [grab(/^const esc = .*$/m), grab(/^const short = .*$/m), grab(/^const lcA = .*$/m), grab(/^ {2}const box = \(k, v\) => .*$/m).trim(), grab(/^function blockLinks\(t\) \{[\s\S]*?\n\}$/m)].join('\n');
  const render = (blk) => new Function('S', `${src}\nreturn { box, blockLinks };`)({ blk });
  const none = render({ tokens: {}, devs: {} }), all = render({ tokens: { [evil]: {} }, devs: { [evil]: {} } });
  const t = { address: evil, creator: evil, creatorName: evil };
  for (const html of [none.box('创建者', evil), none.blockLinks(t), all.blockLinks(t)]) {
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), html);
  }
  assert.ok(all.blockLinks(t).includes('data-unblockdev="&lt;img'));
});

// ---------- 只读的主网检查（FEAST_LIVE=1 才跑；公共节点，不发交易） ----------
const live = process.env.FEAST_LIVE === '1';
const RPC = process.env.RPC_URL || 'https://bsc-rpc.publicnode.com';
const probeWallet = ethers.Wallet.createRandom().address;   // 随机地址：只用来做 from，模拟时用余额覆盖

test('mainnet read-only: factory, quoter and a simulated buy, no transaction', { skip: !live && 'set FEAST_LIVE=1' }, async () => {
  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const ft = new FeastTrade(provider, () => { throw new Error('tests never send'); }, { referrer: '' });
  const info = await ft.info(FEAST_COIN);
  assert.equal(info.quoteSym, 'BNB'); assert.equal(info.poolId.toLowerCase(), fx.poolIds.feast); assert.equal(info.coinIsCurrency0, true);
  await assert.rejects(ft.info(FEAST.usdt), /不是 Feast 工厂发的币/);
  const amount = ethers.parseEther('0.001');
  const q = await ft.quoteBuy(FEAST_COIN, probeWallet, '0.001');
  assert.ok(q.out > 0n, 'a buy of 0.001 BNB quotes some FEAST');
  const qs = await ft.quoteSell(FEAST_COIN, probeWallet, q.out);
  assert.ok(qs.out > 0n && qs.out < amount, 'selling it back returns less than 0.001 BNB (two 1% fees and impact)');
  // 同一笔买入的 calldata，用余额覆盖从随机地址 eth_call：router.execute 不回滚即通过
  const data = encodeExecute(buyCommands(ft.plan(info, 'buy', amount, (q.out * 95n) / 100n)), BigInt(Math.floor(Date.now() / 1000) + 600));
  const ret = await provider.send('eth_call', [{ from: probeWallet, to: FEAST.router, data, value: ethers.toQuantity(amount) }, 'latest', { [probeWallet]: { balance: ethers.toQuantity(ethers.parseEther('1')) } }]);
  assert.equal(ret, '0x');
  // 带引荐人的报价和 calldata 同样能过模拟（引荐人只影响手续费怎么分，不影响成交）
  const ref = new FeastTrade(provider, () => { throw new Error('tests never send'); }, { referrer: '0x000000000000000000000000000000000000bEEF' });
  const qr = await ref.quoteBuy(FEAST_COIN, probeWallet, '0.001');
  assert.ok(qr.out > 0n);
  const dataRef = encodeExecute(buyCommands(ref.plan(info, 'buy', amount, (qr.out * 95n) / 100n)), BigInt(Math.floor(Date.now() / 1000) + 600));
  assert.ok(dataRef.includes('000000000000000000000000000000000000beef'));
  assert.equal(await provider.send('eth_call', [{ from: probeWallet, to: FEAST.router, data: dataRef, value: ethers.toQuantity(amount) }, 'latest', { [probeWallet]: { balance: ethers.toQuantity(ethers.parseEther('1')) } }]), '0x');
  assert.equal(await ft.referrerOf(probeWallet), null);
});

test('mainnet read-only: the public coin list has FEAST with a key that hashes to its pool id', { skip: !live && 'set FEAST_LIVE=1' }, async () => {
  const j = await (await fetch('https://feast.meme/api/v1/pools?limit=200', { signal: AbortSignal.timeout(20_000) })).json();
  const p = (j.pools || []).find((x) => String(x.coin?.address).toLowerCase() === FEAST_COIN.toLowerCase());
  assert.ok(p, 'FEAST is listed');
  assert.equal(poolIdOf(p.poolKey).toLowerCase(), p.poolId.toLowerCase());
  assert.ok(priceQuoteOf(p.market.lastPriceSqrtX96, String(p.poolKey.currency0).toLowerCase() === FEAST_COIN.toLowerCase()) > 0);
});
