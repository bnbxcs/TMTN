// 地址 → 域名映射：优先币安 Agent ID（.ai，链上 handleOf），其次 SPACE ID 主域名（.bnb 等）。
// 查到的永久写入本地 data/names.json，重启不丢；查不到的 10 分钟后重查；查询出错不记为"没有"，稍后重试。
import fs from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from './config.js';
const FILE = dataFile('names.json');
const RPCS = (process.env.NAME_RPC || 'https://bsc-rpc.publicnode.com,https://bsc.publicnode.com,https://bsc-dataseed.bnbchain.org').split(',');
const AGENT_ID = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const regs = RPCS.map((u) => new ethers.Contract(AGENT_ID, ['function handleOf(address) view returns (string)'],
  new ethers.JsonRpcProvider(u, 56, { staticNetwork: true })));
// 排队的地址合并成一次 Multicall3 查 .ai（最多 50 个一批），不再一个地址一次 eth_call
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
const HI = new ethers.Interface(['function handleOf(address) view returns (string)']);
const BATCH = 50;
const API = 'https://nameapi.space.id/getName?chainid=56&address=';
const NEG_TTL = 10 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NameCache {
  constructor() {
    this.map = new Map(); this.queue = []; this.queued = new Set(); this.running = 0; this.stats = { asked: 0, found: 0 }; this.ver = 0; this.rr = 0;
    try { for (const [k, name] of Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) this.map.set(k, { name, at: Date.now() }); } catch { /* 第一次没有文件 */ }
  }
  key(a) { return String(a || '').toLowerCase(); }
  save() { clearTimeout(this.saveT); this.saveT = setTimeout(() => { const o = {}; for (const [k, v] of this.map) if (v.name) o[k] = v.name; try { fs.mkdirSync(new URL('.', FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o, null, 1)); } catch { /* ignore */ } }, 1000); }
  set(address, name) { if (address && name) { this.map.set(this.key(address), { name, at: Date.now() }); this.ver++; this.save(); } }
  all() { const o = {}; for (const [k, v] of this.map) if (v.name) o[k] = v.name; return o; }

  peek(address) {
    const k = this.key(address); if (!/^0x[0-9a-f]{40}$/.test(k)) return null;
    const v = this.map.get(k);
    if (v && (v.name || Date.now() - v.at < NEG_TTL)) return v.name || null;
    if (!this.queued.has(k)) { this.queued.add(k); this.queue.push(k); this.kick(); }
    return null;
  }

  async lookup(k) {
    let err = null;
    for (let i = 0; i < regs.length; i++) {
      try { const h = await regs[(this.rr++) % regs.length].handleOf(k); if (h) return h + '.ai'; err = null; break; } catch (e) { err = e; }
    }
    try { const j = await (await fetch(API + k, { signal: AbortSignal.timeout(8_000) })).json(); if (j?.data?.name) return j.data.name; } catch (e) { err = err || e; }
    if (err) throw err;   // 链上没查成功：不当成"没有域名"
    return null;
  }

  // 页面「查域名」：.ai（币安 Agent ID）和 SPACE ID 主域名都现查一遍（不排队），查到的写进缓存
  async lookupBoth(address) {
    const k = this.key(address); let ai = null, sid = null, aiErr = null, sidErr = null;
    for (let i = 0; i < regs.length; i++) {
      try { const h = await regs[(this.rr++) % regs.length].handleOf(k); ai = h ? h + '.ai' : null; aiErr = null; break; } catch (e) { aiErr = e; }
    }
    try { const j = await (await fetch(API + k, { signal: AbortSignal.timeout(8_000) })).json(); sid = j?.data?.name || null; } catch (e) { sidErr = e; }
    if (aiErr && sidErr) throw aiErr;
    const name = ai || sid; if (name) { this.map.set(k, { name, at: Date.now() }); this.ver++; this.save(); }
    return { ai, sid, name, aiFailed: !!aiErr, sidFailed: !!sidErr };
  }

  // 一批地址的 .ai：一次 aggregate3；节点出错就换下一个节点，都失败才抛错
  async handlesOf(keys) {
    const data = MC.encodeFunctionData('aggregate3', [keys.map((k) => ({ target: AGENT_ID, allowFailure: true, callData: HI.encodeFunctionData('handleOf', [k]) }))]);
    let err = null;
    for (let i = 0; i < regs.length; i++) {
      try {
        const raw = await regs[(this.rr++) % regs.length].runner.call({ to: MULTICALL3, data });
        return MC.decodeFunctionResult('aggregate3', raw)[0].map((r) => { if (!r.success) return null; try { return HI.decodeFunctionResult('handleOf', r.returnData)[0] || null; } catch { return null; } });
      } catch (e) { err = e; }
    }
    throw err;
  }

  kick() { if (!this.running && this.queue.length) this.worker(); }
  async worker() {
    this.running++;
    while (this.queue.length) {
      if (this.queue.length > 1000) this.queue.splice(0, this.queue.length - 1000).forEach((x) => this.queued.delete(x));
      const keys = this.queue.splice(-BATCH);   // 新排进来的先查（卡片上刚出现的首买 / Dev）
      let hs;
      try { hs = await this.handlesOf(keys); }
      catch { setTimeout(() => { for (const k of keys) { this.queued.delete(k); this.peek(k); } }, 5000); await sleep(200); continue; }
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]; let name = hs[i] ? hs[i] + '.ai' : null;
        if (!name) {   // 没有 .ai 再问 SPACE ID 主域名（HTTP 接口，不走节点）；接口出错不记为「没有」，5 秒后重排
          try { const j = await (await fetch(API + k, { signal: AbortSignal.timeout(8_000) })).json(); name = j?.data?.name || null; }
          catch { this.queued.delete(k); setTimeout(() => this.peek(k), 5000); continue; }
          await sleep(60);
        }
        this.map.set(k, { name, at: Date.now() }); this.stats.asked++; this.queued.delete(k);
        if (name) { this.stats.found++; this.ver++; this.save(); }
      }
      await sleep(150);
    }
    this.running--;
  }
}
