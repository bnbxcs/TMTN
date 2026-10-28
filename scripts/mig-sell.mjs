#!/usr/bin/env node
// 迁移清仓：命令行开关（规则本身在 8788 后端里跑，见 engine/migSell.js；重启后保留）
//   node scripts/mig-sell.mjs                      看所有规则和最近日志
//   node scripts/mig-sell.mjs add <代币> [比例%] [滑点%]   新建 / 改参数（默认 80%、滑点 20%、钱包 1+2；新建是关闭的）
//   node scripts/mig-sell.mjs on <代币>            开启（迁移时真实卖出，只执行一次）
//   node scripts/mig-sell.mjs off <代币>           暂停
//   node scripts/mig-sell.mjs reset <代币>         执行过后重置，要再开启才会盯
//   node scripts/mig-sell.mjs rm <代币>            删除规则
// 端口用 PORT（默认 8788）；访问令牌读 TMTN_API_TOKEN 或项目 .env / data/api-token
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const PORT = process.env.PORT || 8788;
const token = process.env.TMTN_API_TOKEN
  || (() => { try { return readFileSync(new URL('.env', root), 'utf8').match(/^TMTN_API_TOKEN=(.+)$/m)?.[1].trim(); } catch { return null; } })()
  || (() => { try { return readFileSync(new URL('data/api-token', root), 'utf8').trim(); } catch { return null; } })();
const call = async (body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/mig-sell`, { method: body ? 'POST' : 'GET', headers: { 'x-tmtn-token': token || '', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}（后端还没有这个接口？改了代码要先重启）` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j;
};
const time = (at) => new Date(at).toLocaleString('zh-CN', { hour12: false });
const show = (rules) => {
  const list = Object.values(rules); if (!list.length) return console.log('没有规则');
  for (const r of list) {
    const ph = r.state?.phase === 'selling' ? '卖出中' : r.state?.phase === 'done' ? '已执行' : r.armed ? '● 已开启，盯迁移中' : '○ 关闭';
    console.log(`\n${r.symbol} ${r.token}\n  ${ph} · 钱包 ${r.slots.join('+')} 各卖 ${r.pct}% · 滑点 ${r.slippage}% · ${r.migrated ? '已在外盘' : '内盘中'}`);
    for (const [s, x] of Object.entries(r.state?.wallets || {})) console.log(`  钱包 ${s}：${x.status}${x.tx ? ' ' + x.tx : ''}${x.reason ? ' · ' + x.reason : ''}`);
    for (const l of (r.log || []).slice(-8)) console.log(`  ${time(l.at)}  ${l.msg}`);
  }
};
const [cmd, addr, a, b] = process.argv.slice(2);
try {
  if (!cmd || cmd === 'status') show((await call()).rules);
  else if (cmd === 'add') show(await call({ token: addr, patch: { pct: Number(a || 80), slippage: Number(b || 20), slots: (await call()).wallets.map((w) => w.slot) } }));
  else if (cmd === 'on') show(await call({ token: addr, patch: { armed: true } }));
  else if (cmd === 'off') show(await call({ token: addr, patch: { armed: false } }));
  else if (cmd === 'reset') show(await call({ token: addr, patch: { rearm: true } }));
  else if (cmd === 'rm') show(await call({ token: addr, remove: true }));
  else console.log('用法见脚本开头注释');
} catch (e) { console.error('失败：' + e.message); process.exit(1); }
