<p align="center">
  <img src="public/logo.svg" width="120" alt="TMTN logo" />
</p>

<h1 align="center">TMTN · BSC Agent 内盘快速买卖终端</h1>

<p align="center"><b><i>TMTN = The Match, The Night</i></b></p>

<p align="center">当前版本 <b>v4.4</b> · 更新内容见 <a href="CHANGELOG.md">CHANGELOG.md</a></p>

> **English summary.** TMTN is a local, single-user trading terminal for BSC "agent-only" meme launchpads — **Flap Agent Bonding Curve**, **Four.meme (OpenFour, Agent-ID-exclusive template)** and **gang.fun (old pad + V2 pads)**. It runs a small Node.js server on `127.0.0.1` plus a browser UI. All signing goes through Binance's **Agentic Wallet CLI (`baw`)**, so **no private key is ever stored or handled locally**. Features include a GMGN-style trenches view, K-line charts, live trade feed, per-trader PnL drawer, one-click buy/sell panel, holdings with USD PnL, auto-claim and an optional MySQL + Redis history cache. **It trades real funds. It is unaudited. Use entirely at your own risk.**

---

## ⚠️ 风险声明（请务必先读）

- **这是会动用真实资金的软件。** 以实盘模式（`LIVE_TRADE=1`）运行时，你在页面上点的买卖会通过币安 Agentic 钱包真实上链，**无法撤回**。
- **不构成任何投资建议。** meme 代币波动极大、流动性差、可能归零或无法卖出；作者不对任何亏损负责。
- **代码未经审计**，可能存在 bug（价格换算、精度、授权、路由等）。请先用模拟盘和极小金额试用。
- **预先授权（较大固定额度）**：为了更快，卖出 / 报价币买入时会授权比本次需要更大的额度（不是无限额）。被授权合约如果出问题，可动用的代币会更多。可以在页面关闭，或在「授权管理」里随时撤销。
- 本项目与币安、Flap、four.meme、gang.fun 等平台**没有任何关联**，第三方接口随时可能变化或失效。

## 它是什么

一个跑在你自己电脑上的 BSC 内盘交易终端：

- 实时发现 **Flap Agent 曲线**、**Four（OpenFour / Agent ID 专属模板）**、**gang.fun（老盘 + V2 报价币盘）** 的新盘、即将发射、已迁移的代币；
- 用币安 **Agentic Wallet CLI（`baw`）** 下单：签名在币安那边完成，本地**不保存私钥**；
- 浏览器界面（`http://127.0.0.1:<PORT>`），单人使用。

## 功能

- **战壕**（GMGN 风格三列：新创建 / 即将发射 / 已迁移）：固定高度卡片、局部更新不闪；每列独立的预设筛选（市值、持有人、进度、税率、计价币、社交）、关键词、排序、提示音；屏蔽（代币 / 开发者）、收藏、快捷买入
- **详情页**：K 线（TradingView Lightweight Charts，默认显示全部历史、按币龄自动选周期）、紧凑指标、右侧「活动」成交流（倒序 / 正序、一直翻到开盘第一笔）、底部实时成交 / 全市场成交流 / 我的持仓 / 订单 / 日志
- **交易者盈亏抽屉**：点成交里的任意地址，看这个地址在这个币上的买卖、均价、已实现 / 未实现盈亏
- **一键买卖浮窗**：P1/P2/P3 预设金额与比例（可编辑）、回本按钮、持仓汇总；半透明、可拖动
- **持仓**：以美元为主的市值、成本、已卖出、盈亏（成本按每笔成交当时的 BNB 价格）；计价币余额一键换回 BNB；链上卖出报价核对异常数值
- **收藏**（分组、顶部收藏栏）、**屏蔽列表**（代币 / 开发者，存服务器）
- **税率显示与筛选**：代币税、平台费、防狙击税
- **自动领取**：Flap 曲线发射后自动 `Portal.claim`
- **卖出后自动换回 BNB**：BNCB / GANG / 币股计价的盘，卖出到账的报价币（只这一笔的链上余额差）自动换成 BNB
- **预先授权（较大固定额度）+ 授权管理**（查看链上额度、逐条撤销）
- **耗时记录**：每笔订单的各阶段耗时写入 `data/latency.jsonl`（点击到服务器、下单前检查、广播、上链…）

## 环境要求

- macOS / Linux，**Node.js 18+**（开发时用 v22），npm
- 币安 **Agentic Wallet CLI**（实盘需要）：

```bash
npm i -g @binance/agentic-wallet
baw auth signin            # 按提示在币安 App 里扫码 / 确认
baw wallet status          # 显示 CONNECTED 即可
```

> **必须先登录。** 实盘模式（`MODE=live`）下，程序每 10 秒用 `baw wallet status` 检查一次登录状态。未登录（或登录过期）时，页面会被一个关不掉的遮罩挡住，提示在终端运行 `baw auth signin`、在币安 App 中确认；所有动用资金的接口（下单、兑换、换回 BNB、领取、撤销授权、单币规则）都会返回 401「币安钱包未登录」。登录完成后遮罩自动消失。偶尔一次检查失败不算掉线，连续 2 次才会锁定。没装 baw 时遮罩会提示安装命令。模拟盘不受影响。

- 交易 Four 专属模板需要币安的技能脚本（提供 `agent-id-exclusive-token-launches.mjs`）：

```bash
npx skills add binance/binance-skills-hub --skill binance-agentic-wallet
```

- 钱包需要在币安 App 里领取 `.ai` Agent ID、打开开发者模式（Agent 专属盘要求），并留一点 BNB 付 gas。

## 运行

```bash
npm install
cp .env.example .env        # 按需修改；程序启动时会自动读取项目根目录的 .env

npm run sim:8787            # 模拟盘：本地生成的代币和成交，不连钱包、不发交易
npm run live:8788           # 实盘：真实行情 + baw 真实下单（只有你在页面上点的订单才会下）
```

然后打开 `http://127.0.0.1:8787` 或 `http://127.0.0.1:8788`。服务只监听本机。

### 多钱包同时下单（可选）

币安 Agentic Wallet 用网卡 MAC 识别设备，同一台电脑上登录两个账号会互相挤掉。所以钱包 1 照常跑在电脑上，钱包 2、3、4… 各跑一个 Docker 容器（固定虚拟 MAC、自己的登录目录、端口只开在 `127.0.0.1`），可以加任意多个：

```bash
scripts/add-wallet.sh 2 --address 0x钱包2的地址   # 建容器 tmtn-wallet2（127.0.0.1:8789），默认只报价
docker exec -it tmtn-wallet2 baw auth signin      # 用钱包 2 的币安账号扫码，核对配对码
scripts/add-wallet.sh --peers --write-env         # 写进 .env 的 WALLET_PEERS，然后重启钱包 1
```

完整步骤（前置检查、校验、扫错账号怎么办）见 **[docs/add-wallet.md](docs/add-wallet.md)**，可以直接交给你的 AI 助手照做。

页面右上角的钱包菜单里打开钱包 2 的「参与下单」后：买入时每个钱包各花输入的 BNB；卖出时每个钱包卖自己持仓的同样比例；两个钱包并行执行，结果分别提示。没登录 / 后端没启动的钱包自动跳过。持仓页可以看全部钱包合并，或者只看某一个钱包。

### 历史数据缓存（可选，MySQL + Redis）

配上之后，各盘从开盘起的成交、外盘分钟 K 线、BNB 小时价、钱包交易记录会存进 MySQL，重启或再次点开同一个币只补新的（Gang 大盘从翻 100 页变成 1 页，Four / Flap 门槛盘不再从创建区块重扫）。不配也照常运行，数据库连不上时自动走原来的路径。装好 Docker 后一条命令开启：`scripts/enable-cache.sh`，然后重启。详细说明见 **[docs/cache.md](docs/cache.md)**。

### 更新与回退版本

点页面右下角的版本号（有新版本时旁边亮 **NEW**）打开「版本管理」：看当前版本是不是最新、新版本的更新说明，「重新检查」「完整说明」，以及「一键回退历史版本」。更新和回退都要自己点，不会自动执行。

- 只替换程序代码，`data/`、`.env`、钱包登录、`node_modules` 都不动；依赖有变化时自动 `npm install`
- 每次切换前把当前代码打包备份到 `data/updates/`（保留最近 10 份），在同一个面板里可以一键恢复
- 本地改过代码时会先列出改过的文件，确认后才覆盖（仍会先备份）；用 `git clone` 安装的走 `git checkout <tag>`，本地未提交的改动先存进 `git stash`
- 完成后服务自动重启（同样的启动参数和环境变量，日志接着写原来的文件），页面自动刷新
- Docker 部署和 `npm run dev`（`node --watch`）下不能在线切换；`TMTN_UPDATE=0` 可以关掉这个功能。多钱包时其他钱包的后端要另外更新

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MODE` | `sim` | `sim` 模拟盘 / `live` 实盘行情 |
| `PORT` | `8787` | 端口 |
| `LIVE_TRADE` | `0` | `1` = 实盘真实下单（只接受手动点击的订单）；`0` = 只报价 / 预演 |
| `MAX_TRADE_BNB` | `0.5` | 单笔买入上限（BNB）的初始值，页面里改过后以 `data/live-settings.json` 为准；`0` = 不限 |
| `PREAPPROVE_AFTER_BUY` | `1` | 买入成交后后台按固定额度预先授权（卖出 = 余额 × 1.01，报价币 ≈ 2 倍单笔上限，不是无限额），第一次卖出不用等授权；还要页面「预先授权」开着。`0` = 只在需要时授权 |
| `NODEREAL_RPC` | （空） | 私有 RPC（例如 NodeReal，含 key，只放 `.env`）。填了就作为主节点：读链、查确认、扫 Four 事件（一次约 5 万块），并通过它的 WSS 订阅 Gang 新盘创建事件；公共节点自动备用 |
| `NODEREAL_KEYS` | （空） | 多个 NodeReal key，逗号分隔（如 `key1,key2`，只放 `.env`）。轮流使用，被限流 / 额度用完的 key 冷却 5 分钟；页面只显示「NodeReal #1 / #2」，不显示 key |
| `RPC_URL` | 有 `NODEREAL_RPC` 用它，否则 `https://bsc-dataseed.bnbchain.org` | 读链用的 BSC RPC |
| `RPC_URL_MAX_PER_MIN` | `150` | `RPC_URL` 是付费节点（如 Chainstack）时，行情 eth_call 溢出到它的每分钟上限（公共节点限流时才会用到），超了先用别的节点，免得把月额度吃光。交易不计、不受限 |
| `LOGS_RPC_URL` | 同 `RPC_URL`（公共节点 / NodeReal 除外） | 日志节点：所有 `eth_getLogs`（补查、历史回补、追踪回补、Four 扫描）优先发给它 |
| `LOGS_MAX_PER_MIN` | `150` | 日志节点每分钟最多处理多少次 getLogs，超了这一分钟回到公共节点 |
| `LOGS_SPAN` | `10000` | 日志节点一次 getLogs 的最大区块数（Chainstack 付费档 1 万块），更大的区间自动拆段 |
| `RPC_ARCHIVE` | `0` | 日志节点是归档节点（如 Chainstack Growth）时填 `1`：Gang V3 / stocks pad 盘的链上历史最多往前补 300 万块（约半个月），否则 30 万块 |
| `TRADE_RPC_URL` | 同 `RPC_URL`（公共节点 / NodeReal 除外） | 下单链路专用节点（可多个，逗号分隔），公共节点兜底 |
| `WSS_URL` | （空） | 链上订阅（新盘、成交推送）的备用 WebSocket 节点，可填多个（逗号分隔），排在 NodeReal 之后、PublicNode 之前；例如 Dwellir 免费档（只能订阅，不支持 eth_getLogs）。key 在页面和日志里打码 |
| `FOUR_LOG_RPC` | 有 `NODEREAL_RPC` 用它，否则 `https://bsc-rpc.publicnode.com` | 扫 Four 事件用的 RPC（getLogs） |
| `FOUR_LOG_STEP` | NodeReal `49000` / 公共节点 `5000` | 每次 getLogs 查多少块 |
| `FOUR_BACKFILL_BLOCKS` | `150000` | 启动时往回扫多少个区块的 Four 新盘 |
| `BAW_BIN` | `baw` | baw 可执行文件路径 |
| `BINANCE_CHAIN_ID` | `56` | 链 ID |
| `BAW_SLIPPAGE_UNIT` | `percent` | baw 滑点参数单位 |
| `WALLET_LABEL` | `币安 Agentic 钱包` | 页面上显示的钱包名 |
| `OPENFOUR_SCRIPT` | （自动查找） | Four 技能脚本路径 |
| `AUTH_SIMULATE_LOGGED_OUT` | `0` | 调试：假装未登录 |
| `DATA_DIR` | `data/` | 数据目录（多钱包时每个后端各用一个） |
| `WALLET_SLOT` / `WALLET_PEERS` | `1` / `[]` | 多钱包：本后端是第几个钱包 / 一起下单的其他钱包后端 |
| `WALLET_ADDRESS` | （空） | 本后端只允许这个钱包地址；baw 登录成别的账号时拒绝使用（防止拿错账号下单） |
| `MYSQL_URL` | （空） | 可选：历史数据缓存的 MySQL，如 `mysql://tmtn:密码@127.0.0.1:13306/tmtn`（只放 `.env`），见 [docs/cache.md](docs/cache.md) |
| `REDIS_URL` | （空） | 可选：接口短时缓存的 Redis，如 `redis://127.0.0.1:16379` |
| `FEEDS_PUBLIC` | `0` | `1` = 行情订阅只用公共节点（第二个钱包的后端用，省 NodeReal 额度） |
| `NAME_RPC` | publicnode / bnbchain（逗号分隔） | 解析 `.ai` 域名用的 RPC |
| `BSC_TESTNET_RPC` | `https://data-seed-prebsc-1-s1.bnbchain.org:8545` | 测试网 RPC（模拟 / 测试网钱包用） |
| `BSC_WSS` | `wss://bsc-rpc.publicnode.com` | 只给 `scripts/watch-four.js` 用的 WebSocket 节点 |
| `FOUR_MANAGER` | `0x5c95…762b` | 只给 `scripts/watch-four.js` 用：four.meme TokenManager2 合约 |

## 数据文件（`data/`，都在本地，**不要提交**）

| 文件 | 内容 |
|---|---|
| `live-settings.json` | 页面设置：单笔上限、自动领取、快捷买入金额、一键买卖预设、预先授权开关等 |
| `positions.json` | 本程序记录的持仓与成本 |
| `latency.jsonl` | 每笔订单的耗时记录 |
| `tokenRules.json` | 单币规则（发射后立刻领取）及执行记录（含交易哈希） |
| `approvals.json` | 本程序授过的额度（代币 → 合约） |
| `favorites.json` / `blocklist.json` | 收藏、屏蔽列表 |
| `names.json` | 地址 → `.ai` 域名缓存 |
| `fourTokens.json` / `flapCreated.json` | Four / Flap 代币登记（重启后恢复列表用） |
| `img/` | 代币头像缓存 |
| `testnet-wallet.json` | 模拟 / 测试网用的一次性钱包（**含私钥，仅测试网**） |

## 结构

```
server.js                 Express + WebSocket 服务、全部 API
engine/
  agent.js market.js trader.js chain.js   模拟盘引擎（自动买已移除）
  blocklist.js favorites.js               屏蔽、收藏
  live/
    config.js        环境变量、合约地址
    baw.js           调 baw CLI（预演、执行、市价单、余额、钱包锁、登录）
    liveMarket.js    实盘行情汇总：Flap / Four / Gang 代币、成交、K 线、涨幅、交易者统计
    agentCurve.js fsi.js shrine.js       Flap Agent 曲线数据（Reader、fsi、shrine）
    fourMeme.js openFour.js              Four：链上事件、OpenFour 技能脚本
    gangFun.js gangTrade.js gangV2Pads.js  gang.fun：接口、老盘、V2 盘
    gangChain.js     gang.fun 新盘：监听链上创建事件（WSS 订阅 + getLogs 补查），比接口轮询快
    flapChain.js     Flap Agent 曲线：订阅链上成交 / 新市场事件（代替第三方 shrine 推送）
    portal.js        Flap Portal 买 / 卖 / 领取、发交易并等回执
    liveTrader.js    下单流程、自动领取、单币规则、计价币换回 BNB、授权管理
    holdings.js      持仓与盈亏（钱包历史、历史 BNB 价格、链上卖出报价核对）
    approvals.js     预先授权策略
    latency.js       耗时记录
    meta.js names.js
public/              页面（index.html、app.js、style.css、vendor/lightweight-charts）
scripts/             只读的辅助脚本（耗时报表、测试网信息、监听 Four 新币）
```

## 让 AI / Agent 接入（教程）

这个终端本身就是一个本地 HTTP + WebSocket 服务，Claude Code、Codex 之类的 AI 助手可以直接帮你搭起来，也可以通过接口读行情、报价、（经你确认后）下单。

### 1. 让 AI 帮你搭起来

把下面这段交给你的 AI 助手执行（登录币安钱包那一步必须你本人在手机上确认）：

```bash
git clone <本仓库地址> tmtn && cd tmtn
npm install
cp .env.example .env            # 需要的话在 .env 里填 NODEREAL_RPC 等；key 只放这里
npm i -g @binance/agentic-wallet
baw auth signin                 # 终端会给出链接 / 二维码，由你本人在币安 App 里确认
npx skills add binance/binance-skills-hub --skill binance-agentic-wallet   # 交易 Four 专属模板需要
npm run sim:8787                # 先用模拟盘跑通：http://127.0.0.1:8787
npm run live:8788               # 确认没问题后再开实盘：http://127.0.0.1:8788
```

建议让 AI 先只用模拟盘或 `LIVE_TRADE=0`（只报价），确认它的操作逻辑没问题再开实盘。

### 2. 本地接口

地址都是 `http://127.0.0.1:<PORT>`，请求和返回都是 JSON。实盘（`MODE=live`）和模拟盘的接口一样，少数只有实盘可用（下面标了「实盘」）。

**行情与代币**

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/state` | — | 全量状态：`mode`、`bnbUsd`、`tokens`（所有代币摘要）、`wallets`、`positions`、`holdings`（持仓快照）、`orders`、`settings`、`config`、`net` 等 |
| GET | `/api/token/:addr` | — | 单个代币详情：摘要 + `candles`（K 线）+ 最近 `trades` |
| GET | `/api/lookup/:addr` | — | 按地址查一个币（不在列表里也会去链上查） |
| GET | `/api/trades/:addr` | `before`（毫秒时间戳）、`limit`（≤500） | 成交历史，往前翻页，一直到开盘第一笔；返回 `{ items, end, complete, total }` |
| GET | `/api/trader/:addr/:trader` | — | 某个地址在这个币上的买卖和盈亏（实盘） |
| GET | `/api/names` | `ver` | 地址 → `.ai` 域名映射 |

```bash
curl -s http://127.0.0.1:8788/api/state | jq '.tokens[0]'
# {"address":"0xf23e…e597","symbol":"INUPUNK","platform":"gang","stage":"curve","quote":"BNB",
#  "price":6.25e-9,"mcapUsd":4800,"progress":3.2,"buyFeePct":1,"sellFeePct":1,"holders":12, ...}

curl -s "http://127.0.0.1:8788/api/trades/0xf23e…e597?limit=1"
# {"items":[{"ts":1792948522000,"side":"sell","tokens":155421.05,"bnb":0.00096,"price":6.25e-9,
#   "trader":"0x09a8…","name":"6123.ai","tx":"0x08d7…","usd":0.71}],"end":false,"complete":true,"total":4}
```

**报价与下单**

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/preview` | `wallet`、`token`、`side`（`buy`/`sell`）、`amount`（买入是 BNB，卖出是百分比）、`slippage`（%） | 只报价 / 预演，不下单 |
| GET | `/api/cost-for-pct` | `wallet`、`token`、`pct`、`slippage` | 买到总量的 `pct`% 大约要多少 BNB |
| POST | `/api/order` | `{ wallets: ["baw"], token, side, amount, slippage }` | **下单**。`LIVE_TRADE=1` 时真实上链（受单笔上限、钱包锁等检查）；否则只预演 |
| POST | `/api/swap/quote` | `{ from, to, amount, slippage }` | BNB ⇄ 任意代币报价（实盘，baw 市价单）；BNB 用 `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` |
| POST | `/api/swap` | `{ from, to, amount 或 pct, slippage }` | **兑换**（实盘） |
| GET | `/api/token-info/:addr` | — | 读链上 ERC20 信息和你的余额（实盘） |
| GET | `/api/quote-balances` | — | 钱包里的报价币余额（BNCB、GANG…） |
| POST | `/api/quote-to-bnb/preview`、`/api/quote-to-bnb` | `{ token, slippage }` | 报价币全部换回 BNB 的报价 / **执行** |
| POST | `/api/claim` | `{ market }` | **领取** Flap 曲线发射后的代币 |

```bash
curl -s "http://127.0.0.1:8788/api/preview?wallet=baw&token=0xf23e…e597&side=buy&amount=0.01&slippage=20"
# {"route":"Gang 内盘 · buy（BNB，一笔完成）…","amountIn":0.01,"out":1581651.2,"minOut":1265320.9,"feeBnb":0.0001,"feePct":1}

curl -s -X POST http://127.0.0.1:8788/api/order -H 'content-type: application/json' \
  -d '{"wallets":["baw"],"token":"0xf23e…e597","side":"buy","amount":0.01,"slippage":20}'
# [{"id":"…","status":"filled"|"failed"|"pending"|"dry_run","tx":"0x…","reason":null,"steps":[…],"latencyMs":3120}]
```

**持仓、设置、列表**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/holdings`（`?refresh=1` 强制重读） | 持仓快照：每个币的数量、市值、成本、已卖出、盈亏（BNB / 美元） |
| POST | `/api/settings` | 改设置：`maxTradeBnb`、`autoClaim`、`sellToBnb`、`preApproveCap`、一键买卖预设等 |
| POST | `/api/config` | 改快捷买入金额等（`quickBuy`）；自动买入已移除，不能打开 |
| GET/POST | `/api/favorites` | 收藏；POST `{ op: "set"|"remove"|"addGroup"|"renameGroup"|"deleteGroup", … }` |
| GET/POST | `/api/blocklist` | 屏蔽；POST `{ kind: "token"|"dev", address, on, label }` |
| GET/POST | `/api/token-rules` | 单币规则（发射后立刻领取） |
| GET | `/api/approvals`；POST `/api/approvals/revoke` | 授权列表；撤销 `{ token, spender }`（会发一笔交易） |
| GET | `/api/latency-stats?days=1` | 下单耗时统计（按平台 / 方向，p50 / p90、各步骤平均） |
| POST | `/api/auth/check`、`/api/auth/login` | 查 / 发起币安钱包登录 |
| GET | `/api/img?u=<url>` | 代币头像代理（缓存到本地） |

**WebSocket**：连 `ws://127.0.0.1:<PORT>/ws`。

- 发送 `{"type":"sub","token":"0x…"}` 订阅一个币，会收到它的 `detail`（`full: true` 是全量，之后是增量 K 线和成交）。
- 服务器推送的消息类型：`tick`（定时全量：代币列表、钱包、持仓、网络状态）、`launch`（新盘）、`trade`（全市场成交）、`detail`、`order`（订单状态变化）、`holdings`（持仓快照）、`settings`、`config`、`favorites`、`blocklist`、`rules`、`log`、`record`。

### 3. 建议的 Agent 工作流

1. `GET /api/state` 或订阅 WebSocket 的 `tick` / `launch`，拿到新盘列表；
2. 按条件过滤：`buyFeePct` / `sellFeePct`（税率）、`mcapUsd`、`holders`、`progress`、`quote`、是否被屏蔽；
3. 对候选币调用 `/api/preview` 报价，看预计到手和最少到手；
4. **把报价交给人确认**，确认后才调用 `POST /api/order`；
5. 通过 WebSocket 的 `order` 消息跟踪结果（`pending` → `filled` / `failed`），`GET /api/holdings` 看盈亏。

### 4. 安全须知

- 服务**只监听 127.0.0.1**，而且**没有任何鉴权**：谁能访问这个端口，谁就能用你的钱包下单。**绝对不要**把它暴露到公网，也不要做端口转发 / 反向代理。
- 开发和调试时用模拟盘（`MODE=sim`）或 `LIVE_TRADE=0`（只报价）。
- 设好单笔上限（`MAX_TRADE_BNB` 或页面里的设置），AI 下的单也受它限制。
- 预先授权默认是关的，只有你自己在页面上打开才生效；AI 不应该替你打开。
- RPC key 等只放 `.env`，不要写进代码、日志或聊天。

## 用到的主要合约（BSC 主网）

| 用途 | 地址 |
|---|---|
| Flap Agent Curve Reader | `0x18Aa6C93f1887a243fdc348C9A77F5136555174a` |
| Flap Portal | `0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062` |
| Flap Factory | `0xC55820f24015bE7c4f18949D9e1363A3609B300e` |
| OpenFour Core（模板 `1778027615735`） | `0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3` |
| gang.fun 老盘 | `0x315Ba2e8952D06094CC636b2B84229FA32fb23A7` |
| gang.fun V2 pads | `0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E`、`0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb`、`0x60aee38576035E757deD30fF8db8A8DA476430C1` |
| WBNB / BNCB / GANG | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` / `0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f` / `0x0c6302401aa5325C2E36F170f52C00B1d220B405` |

数据源：BSC RPC（bnbchain / publicnode）、gang.fun API、fsi.taxed.fun、shrine.trade、DexScreener、GeckoTerminal、币安行情接口。

## 第三方组件

- [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)（Apache-2.0），本地副本在 `public/vendor/`，许可证见 `public/vendor/lightweight-charts.LICENSE`
- ethers、express、ws（见 `package.json`）

## 许可证

[MIT](LICENSE) © 2026 0xZhangCrypto1

作者：[𝕏 @0xZhangCrypto1](https://x.com/0xZhangCrypto1)

## Star History

<a href="https://star-history.com/#bnbxcs/TMTN&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=bnbxcs/TMTN&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=bnbxcs/TMTN&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=bnbxcs/TMTN&type=Date" />
 </picture>
</a>
