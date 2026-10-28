// 迁移即清仓：盯一个币，它从内盘迁移（毕业）到外盘的那一刻，按设定从选中的钱包各卖出 N%（默认 80%，剩下的留作 moonbag）。
// 规则只能本人用 scripts/mig-sell.mjs 打开（新建时默认关闭）；随时可暂停 / 取消；存在 data/mig-sell.json，重启后继续盯。
// 判断迁移：行情的 migrate 事件 + 每 1.5 秒链上确认一次（trader.checkMigrated：Gang 看曲线 graduated，Flap 看 Portal 状态，其他看 PancakeSwap V2 池子）。
// 卖出走和页面手动卖出一样的 placeOrder（每个钱包卖自己持仓的 N%，钱包 2 转给它自己的后端），来源「迁移清仓」。
// 失败最多再试 3 次（3 / 8 / 20 秒后）；已提交但结果未知的不重下，避免重复卖。
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

export const MIG_SOURCE = '迁移清仓';
const RETRY_MS = [3_000, 8_000, 20_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MigSell extends EventEmitter {
  // placeOrder：server.js 的下单入口；slotsAll：能选的钱包 [{ slot, label }]；live：是否实盘
  constructor({ market, trader, placeOrder, dataFile, slotsAll, live }) {
    super();
    Object.assign(this, { market, trader, placeOrder, slotsAll, live });
    this.file = dataFile('mig-sell.json'); this.logFile = dataFile('mig-sell-log.jsonl');
    try { this.rules = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.rules = {}; }
    this.firing = new Set(); this.checkAt = new Map();
    // 重启时正在卖的规则：结果不明，不自动重下，标成待人工查看
    for (const r of Object.values(this.rules)) if (r.state?.phase === 'selling') { r.state.phase = 'done'; this.log(r, '服务重启时这条规则正在卖出，结果请在订单记录 / 持仓里确认（不会自动重下）'); }
    market.on('migrate', (s) => { const r = this.rules[String(s?.address || '').toLowerCase()]; if (r) this.maybeFire(r, '行情：已迁移'); });
    this.timer = setInterval(() => this.tick().catch((e) => console.error('迁移清仓:', e.message)), 1_500);
  }

  save() { try { mkdirSync(new URL('.', this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(this.rules, null, 1)); } catch { /* ignore */ } this.emit('state', this.view()); }
  view() { return Object.fromEntries(Object.entries(this.rules).map(([k, r]) => [k, { ...r, migrated: this.migrated(this.market.get(k)) }])); }
  log(r, msg, extra) {
    r.log = [...(r.log || []), { at: Date.now(), msg }].slice(-40);
    console.log(`[迁移清仓] ${r.symbol || r.token} ${msg}`);
    try { appendFileSync(this.logFile, JSON.stringify({ at: new Date().toISOString(), token: r.token, symbol: r.symbol, msg, ...extra }) + '\n'); } catch { /* ignore */ }
  }
  migrated(t) { return !!t && (t.stage === 'dex' || t.migrated === true); }

  // patch：{ armed, pct, slippage, slots }；null = 取消（删掉规则）
  set(token, patch) {
    const k = String(token || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(k)) throw new Error('代币地址无效');
    if (patch === null) { const r = this.rules[k]; if (r && this.firing.has(k)) throw new Error('正在卖出，等这一轮结束再取消'); delete this.rules[k]; this.save(); return this.view(); }
    const t = this.market.get(k);
    const r = this.rules[k] || { token: k, createdAt: Date.now(), armed: false, pct: 80, slippage: 20, slots: this.slotsAll.map((w) => w.slot), state: { phase: 'watching' }, log: [] };
    const isNew = !this.rules[k];
    if (patch.pct !== undefined) { const v = Number(patch.pct); if (!(v > 0 && v <= 100)) throw new Error('卖出比例要在 1–100 之间'); r.pct = v; }
    if (patch.slippage !== undefined) { const v = Number(patch.slippage); if (!(v > 0 && v <= 90)) throw new Error('滑点要在 0–90 之间'); r.slippage = v; }
    if (patch.slots !== undefined) { const ok = new Set(this.slotsAll.map((w) => w.slot)); const s = [...new Set((patch.slots || []).map(Number))].filter((x) => ok.has(x)); if (!s.length) throw new Error('至少选一个钱包'); r.slots = s; }
    if (isNew) this.log(r, `新建规则（默认关闭）${t ? `· ${t.platform || ''} · ${this.migrated(t) ? '已在外盘' : '内盘中'}` : '· 行情里还没有这个币'}`);
    if (patch.rearm) { if (this.firing.has(k)) throw new Error('正在卖出'); r.state = { phase: 'watching' }; this.log(r, '已重置，重新盯迁移'); }
    if (patch.armed !== undefined) {
      const on = patch.armed === true;
      if (on && r.state?.phase === 'done') throw new Error('这条规则已经执行过，要再用请先「重置」');
      if (on !== r.armed) this.log(r, on ? `已开启：迁移后从 ${r.slots.map((s) => this.label(s)).join('、')} 各卖出 ${r.pct}%，滑点 ${r.slippage}%` : '已暂停（迁移时不会卖出）');
      r.armed = on;
    }
    Object.assign(r, { symbol: t?.symbol && t.symbol !== '?' ? t.symbol : r.symbol || '?', platform: t?.platform || r.platform || '', source: t?.source || r.source || '', quote: t?.quote || r.quote || '' });
    this.rules[k] = r; this.save();
    // 打开时已经迁移了：不自动卖，提示本人自己决定（避免误开就把币卖掉）
    if (r.armed && this.migrated(t) && r.state.phase === 'watching') { r.armed = false; this.log(r, '这个币已经在外盘了，规则不会触发；要卖请手动卖出'); this.save(); }
    return this.view();
  }
  label(slot) { return this.slotsAll.find((w) => w.slot === slot)?.label || `钱包 ${slot}`; }

  async tick() {
    for (const r of Object.values(this.rules)) {
      if (!r.armed || r.state?.phase !== 'watching') continue;
      let t = this.market.get(r.token);
      if (!t && this.live) { if (Date.now() - (this.checkAt.get(r.token) || 0) < 30_000) continue; this.checkAt.set(r.token, Date.now()); await this.market.lookup?.(r.token).catch(() => null); t = this.market.get(r.token); if (!t) continue; }
      if (!t) continue;
      if (t.symbol && t.symbol !== '?' && r.symbol !== t.symbol) r.symbol = t.symbol;
      if (this.migrated(t)) { this.maybeFire(r, '行情：已迁移'); continue; }
      // 行情（gang.fun / Flap 轮询）比链上慢几十秒：直接问链上
      if (this.live && this.trader.checkMigrated) {
        if (Date.now() - (this.checkAt.get(r.token) || 0) < 1_500) continue; this.checkAt.set(r.token, Date.now());
        if (await this.trader.checkMigrated(t).catch(() => false)) this.maybeFire(r, '链上确认已迁移');
      }
    }
  }

  // 本模式下只有本机测试用：假装已迁移，立刻执行（模拟盘才允许）
  testFire(token) { if (this.live) throw new Error('只有模拟盘能测试触发'); const r = this.rules[String(token).toLowerCase()]; if (!r) throw new Error('没有这条规则'); if (!r.armed) throw new Error('规则没开启'); this.maybeFire(r, '模拟盘测试触发'); return this.view(); }

  maybeFire(r, why) {
    if (!r.armed || r.state?.phase !== 'watching' || this.firing.has(r.token)) return;
    this.firing.add(r.token);
    r.state = { phase: 'selling', firedAt: Date.now(), why, wallets: {} };
    this.log(r, `${why}，开始从 ${r.slots.map((s) => this.label(s)).join('、')} 各卖出 ${r.pct}%`); this.save();
    Promise.all(r.slots.map((s) => this.sellSlot(r, s).catch((e) => { r.state.wallets[s] = { status: 'failed', reason: e.message }; this.log(r, `${this.label(s)}：出错 ${e.message}`); })))
      .finally(() => {
        const ws = Object.values(r.state.wallets), ok = ws.filter((x) => x.status === 'filled').length;
        r.state.phase = 'done'; r.state.doneAt = Date.now(); r.armed = false;
        this.log(r, `执行结束：${ok}/${r.slots.length} 个钱包卖出成功${ws.some((x) => x.status === 'pending') ? '，有结果待确认' : ''}`, { wallets: r.state.wallets });
        this.firing.delete(r.token); this.save();
      });
  }

  async sellSlot(r, slot) {
    const name = this.label(slot), st = (r.state.wallets[slot] = { status: 'running', tries: 0 });
    for (let i = 0; i <= RETRY_MS.length; i++) {
      st.tries = i + 1; this.save();
      let o;
      try { o = [].concat(await this.placeOrder({ wallets: [this.live ? 'baw' : 'big'], token: r.token, side: 'sell', amount: r.pct, slippage: r.slippage, slots: [slot], source: MIG_SOURCE, symbol: r.symbol }))[0]; }
      catch (e) { o = { status: 'failed', reason: e.message }; }
      if (!o) { Object.assign(st, { status: 'skipped', reason: '这个钱包不可用' }); this.log(r, `${name}：不可用，跳过`); return; }
      const reason = String(o.reason || '');
      if (o.status === 'filled') { Object.assign(st, { status: 'filled', tx: o.tx || null, out: o.out ?? null, orderId: o.id }); this.log(r, `${name}：卖出成功${o.out != null ? `，得 ${o.out}` : ''}${o.tx ? ` ${o.tx}` : ''}`); return; }
      if (o.status === 'dry_run') { Object.assign(st, { status: 'dry_run', reason }); this.log(r, `${name}：只报价没有上链（${reason || '当前不是真实下单模式'}）`); return; }
      if (o.status !== 'failed') { Object.assign(st, { status: 'pending', reason, orderId: o.id }); this.log(r, `${name}：已提交，结果待确认（${reason.slice(0, 120) || o.status}），不重下`); return; }
      if (/钱包里没有|没有可卖出|实际 0 个|没有持仓|未登录|登录/.test(reason)) { Object.assign(st, { status: 'failed', reason }); this.log(r, `${name}：${reason.slice(0, 160)}`); return; }
      if (i === RETRY_MS.length) { Object.assign(st, { status: 'failed', reason }); this.log(r, `${name}：第 ${i + 1} 次仍失败，放弃（${reason.slice(0, 160)}）`); return; }
      this.log(r, `${name}：第 ${i + 1} 次失败（${reason.slice(0, 160)}），${RETRY_MS[i] / 1000} 秒后重试`);
      await sleep(RETRY_MS[i]);
    }
  }
}
