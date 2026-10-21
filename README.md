# 赛事沙盘 · 电竞赛事预测模拟盘

一个纯前端的电竞赛事胜负预测小游戏，当前覆盖 CS2、Dota 2、英雄联盟、无尽对决、彩虹六号、王者荣耀、守望先锋、瓦罗兰特、星际争霸2、火箭联盟 10 个项目，面向小黑盒「小程序工坊」活动制作。
玩家用虚拟「沙粒」预测真实比赛胜负，猜对得沙粒、连对加成、沙粒不够时可以「采沙」。

> 沙粒为虚拟道具，无任何现实价值，不可充值、兑换、交易，不涉及真实货币。

## 功能

- **赛事列表**：自动分为「正在进行 / 可竞猜 / 已截止待赛果 / 刚刚结束」四组；首页只展示未来 14 天赛程和近 1 天自己猜过的赛果，完整一个月在赛程表里
- **游戏托盘**：点击游戏按钮，在按钮下方展开游戏选择浮层，按项目查看比赛与场次数量，游戏再多也无需横向滑动
- **状态托盘**：全部 / 进行中 / 可竞猜 / 已截止 / 待赛果 / 刚结束，六个状态带实时数量，点一下即可快速查看
- **赛事筛选**：游戏按钮旁边可选择「全部赛事 / 大型赛事（S/A 级）/ 具体赛事」，自动按赛事分级（PandaScore tier）和知名度排序，避免小赛事淹没大赛；切换游戏时赛事筛选自动联动
- **竞猜**：选择队伍 → 投入沙粒（立即扣除）→ 开赛前 1 小时停止竞猜与修改；沙粒为正时单场最多投入余额的 2 倍；归零或负债时只能选择 10 / 100 / 1000 / 负债额 四档定额投入
- **沙粒可为负**：投入时立即扣款，猜错不退；余额可以为负，负债不影响继续竞猜（可无限负债）；采沙可把不足 10,000 的余额（含负债）补足回 10,000
- **比赛状态**：开赛前 1 小时截止；开赛后按赛制预计时长显示「正在比赛」；超过预计时长仍无赛果显示「待赛果」
- **自动结算**：赛果录入后打开小程序自动结算
- **连对加成**：连续猜对第 2 场起 +10% / +20% / +30% / +50%（封顶）
- **采沙**：初始 10,000 沙粒。沙粒少于 10,000 时（含负债）采沙补足到 10,000；不少于 10,000 时无需采沙，不会额外增加。不清空预测，并记录已采沙次数
- **总盈亏**：「我的」页展示总盈亏及已结算投入 / 累计返还，让玩家清楚看到自己累计亏了多少
- **战绩卡**：猜对次数、猜错次数、单场最多赢、单场最多亏
- **双排行榜**：胜榜（先比猜对次数，再比赚的沙粒）/ 败榜（先比猜错次数，再比亏的沙粒），结算后自动提交成绩
- **分享卡片**：每条竞猜记录可生成一张图片卡（单场结果为主，累计总盈亏为次要信息），保存后可发帖/发群；分享面板可一键复制配套文案（含数据来源署名）
- **新手引导**：首次进入展示三屏引导（这是什么 / 沙粒怎么玩 / 合规声明），同意后进入，之后不再弹出
- **异常兜底**：本地存储不可用时降级为内存模式并提示；脏数据自动修正并写回；赛程数据加载失败时显示明确错误页而不是白屏
- **本地存储**：通过 `js/platform.js` 使用 `hbSDK.storage`（异步、按小程序隔离）；浏览器开发环境自动回退 `localStorage`，无需后端、无需账号、无密钥
- **设置页**：小黑盒账号信息（本地为模拟账号，发布后自动读取）、玩法说明子页面、赛程表子页面、赛事数据量、数据更新时间与来源、小程序版本、云服务模式
- **赛程表**：设置 → 赛事数据，展示过去 30 天与未来 30 天的完整赛程，纯表格视图、不可竞猜，支持游戏与赛事筛选（含大型赛事），并可用关键词搜索（游戏 / 赛事 / 队伍 / 日期等）

## 文件结构

```
index.html          页面结构（赛事 / 我的 / 排行 / 设置）
css/style.css       样式（移动端优先，深色电竞风）
js/app.js           全部逻辑（ES module 入口：渲染、竞猜、结算、采沙、分享）
js/cloud.js         云服务层（hb-sdk 云端排行榜 / 本地模拟回退）
js/platform.js      hb-sdk 适配层（握手、storage、user、network）
js/config.js        运行时数据源地址（VITE_RUNTIME_DATA_BASE）
js/data-source.js   运行时赛程拉取、校验与缓存
data/matches.json   赛事数据快照（Vite 直接导入；构建前由 Release 下载，不提交）
runtime/            运行时数据产物（meta.json + matches.json，不提交）
vite.config.js      Vite 配置（miniappManifest 插件）
public/             小程序图标与封面（构建必需）
package.json        小程序声明（heybox 字段）与脚本
data/manual-matches.json  手工补充或修正的赛事（优先级最高）
tools/fetch-matches.mjs   采集器入口
tools/pull-data.mjs       构建前从 GitHub Release 资产同步数据快照
tools/build-runtime-data.mjs  生成 runtime/meta.json 与 runtime/matches.json
tools/serve-runtime.mjs       本地运行时数据服务器（联调用）
tools/adapters/           数据源适配器（manual / liquipedia / pandascore）
tools/lib.mjs             规范化、去重合并、校验、写出
.github/workflows/update-matches.yml  每 5 分钟采集，仅变化时覆盖 Release 资产（不提交数据）
.github/workflows/backfill-matches.yml  每天回填前后各 30 天赛程
.github/workflows/publish-runtime-pages.yml  每 10 分钟把 runtime 数据发布到 GitHub Pages
```

## 排行榜与云服务

`js/cloud.js` 是唯一的云依赖点，`js/platform.js` 负责 hb-sdk 握手、存储与用户信息：

- 宿主内：使用 hb-sdk 云端排行榜（`cloud.leaderboard.submit / getList / getCurrentUserEntry`）与 `user.getInfo()`
- 浏览器开发环境：自动回退到 localStorage 模拟榜单与本地账号
- **胜榜** `sha_board_win`：score = 猜对次数 × 10⁹ + 猜对净赚沙粒
- **败榜** `sha_board_lose`：score = 猜错次数 × 10⁹ + 猜错净亏沙粒

二元标准编码成单数值，与平台 `order=desc` 榜单语义一致。榜单需要先创建（见下方 `npm run boards:create`），昵称会随成绩写入 `extra` 供其他玩家展示；登录态由宿主代管，无需自建服务器。

## 本地预览与构建

项目已迁移为 **Vite + hb-sdk** 结构，普通浏览器不能直接打开入口（Runtime Gate 会拦截生产构建）。

```bash
npm install
npm run dev        # hb-sdk dev：启动 Vite + 浏览器调试台（本地 mock 宿主）
npm run build      # hb-sdk build：产物输出到 dist/

# 可选：运行时赛程联调
npm run runtime:build   # 生成 runtime/meta.json + runtime/matches.json
npm run runtime:serve   # 本地 5180 端口提供运行时数据
VITE_RUNTIME_DATA_BASE=http://127.0.0.1:5180/ npm run dev
```

`npm run dev` 会在终端打印调试页地址（默认 5176/5177 端口），在调试台里可以像真实宿主一样使用 storage、用户信息和排行榜。生产构建时用 `VITE_RUNTIME_DATA_BASE=https://<bucket 域名>/ npm run build` 指向实际静态源；不设置则关闭运行时拉取，只使用内置数据。

发布：在 open.xiaoheihe.cn 小程序后台登录并绑定远程小程序后，按平台流程上传 `dist/` 产物；也可以用 `npx hb-sdk login` 缓存 CLI 登录态。

## 小程序声明与权限

`package.json#heybox` 里声明了名称、分类、图标、封面、平台和权限：

- `storage`：本地键值存储（沙粒、预测记录）
- `userInfo`：读取当前小黑盒账号昵称与头像
- `leaderboard`：云端排行榜读写
- `network`：运行时拉取赛程 JSON（需要平台审批，审批前只在 `hb-sdk dev` 本地生效）

`storage` / `userInfo` / `leaderboard` 声明即用；`network` 是审批制，生产环境必须先在开放平台申请域名，否则请求会返回 `PERMISSION_DENIED`，客户端会自动回退到内置/缓存数据。

排行榜需要在绑定远程小程序后创建一次：

```bash
npx hb-sdk login          # 首次需要登录
npm run boards:create     # 创建胜榜 sha_board_win / 败榜 sha_board_lose
```

浏览器开发环境（非宿主）会自动回退到本地模拟榜单与本地存储。

## 赛事数据采集

采集器不依赖任何 npm 包（Node 18+ 原生 fetch），在项目根目录运行：

```bash
node tools/fetch-matches.mjs                 # 采集并写入本地 data/matches.json（该文件不提交）
node tools/fetch-matches.mjs --dry-run       # 只采集合并，打印结果，不写文件
node tools/fetch-matches.mjs --only=manual   # 只合并手工数据（离线可用）
node tools/fetch-matches.mjs --days=14       # 采集未来 14 天赛程（默认 7 天）
node tools/fetch-matches.mjs --past-days=30 --past-pages=10 --upcoming-pages=10 --days=30
                                             # 回填前后各 30 天（赛程表用，按时间范围过滤+分页）
node tools/fetch-matches.mjs --retention=60  # 已结束比赛保留 60 天（默认 30 天）
```

也可以用 npm：`npm run fetch` / `npm run fetch:dry` / `npm run fetch:manual`。构建前同步最新快照用 `npm run data:pull`；`predev` / `prebuild` 会在文件缺失时自动调用。下载优先用 Node `fetch`，失败时自动回退 `curl`，适配 Node 直连 GitHub 超时的网络。

**数据源与凭据**（凭据只从环境变量读取，不写进任何文件）：

| 数据源 | 环境变量 | 覆盖范围 | 说明 |
| --- | --- | --- | --- |
| 手工 | 无 | 全部 | `data/manual-matches.json`，优先级最高，始终启用 |
| Liquipedia | `LIQUIPEDIA_API_KEY` | CS2、瓦罗兰特、LoL、Dota2、R6 | 免费注册，约 60 请求/小时，适配器已按 2.1 秒节流 |
| PandaScore | `PANDASCORE_TOKEN` | 当前有数据的 10 个：CS2、瓦罗兰特、LoL、Dota2、R6、王者荣耀（kog）、MLBB、Overwatch、Rocket League、星际 2 | 免费额度 1000 请求/小时，赛果延迟低 |

可选：`LIQUIPEDIA_CONTACT` 填邮箱或主页，Liquipedia 要求 User-Agent 带联系方式。

**合并规则**（`tools/lib.mjs`）：

1. 同一场比赛 = 游戏 + 日期 + 双方队名（大小写、空格、标点不敏感）
2. 有赛果的数据覆盖无赛果的；手工数据优先级最高
3. 已存在的 `id` 和 `note` 尽量保留，避免玩家下注记录对不上
4. 自动来源的旧赛果按保留期清理，手工数据始终保留
5. 写入前做 schema 校验，重复 id / 缺字段 / 非法时间会直接报错退出

**定时采集**：`.github/workflows/update-matches.yml` 每 5 分钟跑一次，先下载 Release 资产里的上一份 `matches.json`，采集合并后**只有内容变化才覆盖上传**，不产生数据提交。每轮至少 30 次请求（15 个游戏 × upcoming/past），含翻页通常约 33 次；12 轮/小时约 396 次，占 PandaScore 额度的 40%。另有 `backfill-matches.yml` 每天 UTC 03:00（北京 11:00）回填前后各 30 天赛程（`range[begin_at]` 时间范围过滤，过去最多 40 页、未来 10 页），供赛程表使用；两个任务共用 concurrency group，不会同时读写快照。当前 Release 快照 3039 场（约 1.7 MB，随赛程变化；构建产物约 1.5 MiB）。推荐用公开仓库（Actions 不计费）；GitHub 高峰期定时任务可能延迟，公开仓库连续 60 天无仓库活动会被暂停计划任务，`keepalive.yml` 每月提交一次时间戳保活。注意 Liquipedia 可能屏蔽数据中心 IP，失败时看日志，PandaScore 不受影响。

首次上线步骤：

1. 在 GitHub 新建**公开**仓库，把本项目推送上去
2. 仓库 Settings → Secrets and variables → Actions，添加 `PANDASCORE_TOKEN`（必填），按需添加 `LIQUIPEDIA_API_KEY`、`LIQUIPEDIA_CONTACT`
3. 打开 Actions 页面，手动运行一次 `Update match data` 验证；首次运行会创建 `data` Release 并上传 `matches.json`
4. 再手动运行一次 `Backfill match data`，把前后 30 天赛程补齐（之后每天自动回填）
5. 之后每 5 分钟检查一次，只有数据变化时才更新 Release 资产，仓库历史不会增长；`keepalive.yml` 每月写一次时间戳，避免定时任务因 60 天无活动被暂停
6. 本地构建前运行 `npm run data:pull`；直接 `npm run build` 时，`prebuild` 会在文件缺失时自动下载

## 手工补充赛事

自动采集覆盖不到的赛事，或需要人工修正时，编辑 `data/manual-matches.json`：

```json
{
  "matches": [
    {
      "game": "kpl",
      "tournament": "2026 KPL 秋季赛",
      "stage": "季后赛",
      "startAt": "2026-10-24T19:00:00+08:00",
      "format": "BO7",
      "teamA": { "name": "成都AG超玩会", "short": "AG", "region": "KPL" },
      "teamB": { "name": "重庆狼队", "short": "狼队", "region": "KPL" },
      "status": "open",
      "note": ""
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `game` | 游戏 id，需在 `js/app.js` 的 `GAMES` 注册表中存在 |
| `tournament` / `stage` | 赛事名称与阶段 |
| `startAt` | 开赛时间，ISO 格式带时区 |
| `format` | `BO1` / `BO3` / `BO5` / `BO7` 等 |
| `teamA` / `teamB` | `{ name, short, region }` |
| `status` | 可省略，采集器会按时间与赛果自动推导 |
| `result` | `{ winner: "A" 或 "B", score: "3:1" }`，补上即结算 |
| `tier` | 可选，赛事分级 `s` / `a` / `b` / `c` / `d`，用于「大型赛事」筛选；PandaScore 采集时自动写入 |
| `note` | 可选，卡片底部提示 |

手工数据是**增量与覆盖**，不是全量镜像：从文件里删掉某场不会自动删除快照里的记录（历史需要保留）；确实要删，请直接编辑本地 `data/matches.json` 后重跑一次采集，并重新上传快照。

要点：

- 预测会在开赛前 1 小时自动锁定（`startAt` 前 60 分钟），所以赛果没出来时无需改状态
- 补上 `result` 后，玩家下次打开小程序自动结算
- 同一场比赛只结算一次；已结算记录不会重复发奖
- 当前数据全部来自 PandaScore 或手工补录，示例对阵已清理；瓦罗兰特包含 2026 上海全球冠军赛的真实赛果。

## 新增赛事游戏

1. 在 `js/app.js` 的 `GAMES` 注册表里加一条（标题、角标文字、两种渐变色、深/浅色文字），并把游戏 id 加进 `GAME_ORDER`。
2. 在 `data/manual-matches.json`（或采集器输出）里添加该游戏的赛事，`game` 字段填注册表里的 id。
3. 刷新即可——筛选标签会自动出现，无需改 HTML 或 CSS。

完整的目标游戏注册表在 `js/app.js` 的 `GAMES` / `GAME_ORDER` 中维护；这里不重复列出。

数据里没有赛程的游戏不会出现在托盘里，等采集到赛程后会自动出现。
数据里没出现的游戏不会显示标签；未注册的游戏 id 会以灰色兜底样式显示。

## 上架说明：服务器、网络与存储

- **基础玩法不需要服务器**：赛事数据打包进产物，沙粒与预测记录存在宿主本地，无账号、无密钥、无后端成本。
- **项目已按官方方式打包**：`@heybox/hb-sdk` + Vite（`vite.config.js` 使用 `miniappManifest()`），产物在 `dist/`，不能作为普通网页直接运行。
- **网络请求**：本项目未使用 `network` 权限；赛事数据在构建前从 GitHub Release 同步并打包进产物，运行时不需要请求外部接口。
- **本地存储**：通过 `js/platform.js` 使用 `hbSDK.storage`（异步、按小程序隔离、最多 1000 个 key）；浏览器开发环境自动回退到 `localStorage`。
- **发布流程**：实名认证 → 在 <https://open.xiaoheihe.cn/zh_cn/user_miniprogram/list?scope=all> 上传 `dist/` → 审核 → 发布；查看需小黑盒 1.3.390+。

## 发布到小黑盒小程序工坊

1. `npm run build` 生成 `dist/`（含 manifest.json、图标、封面）。
2. 在开放平台后台上传产物、提交审核。
3. 审核通过后正式发布，回到活动页点「去发帖」写介绍帖并挂载小程序。
4. 绑定远程小程序后运行 `npm run boards:create` 创建两个云端榜单。

审核注意（已在本项目中处理）：

- 文案不使用「下注 / 押注 / 赔率 / 博彩」等措辞，统一使用「预测 / 投入 / 沙粒」。
- 没有赔率系统、没有充值、没有兑换、没有交易；采沙只补足到 10,000，玩法说明里显眼提示。
- 设置页与「我的」页包含完整合规声明与总盈亏展示。

## 采集链路现状

已实现：

- 采集器（Liquipedia / PandaScore / 手工）→ 合并去重 → 本地 `data/matches.json`
- GitHub Actions 每 5 分钟采集，先恢复 Release 快照，只有内容变化时才覆盖上传；数据不进入 Git 历史
- 构建前 `tools/pull-data.mjs` 下载快照，Vite 直接导入 `data/matches.json`

运行时拉取（可选，已实现）：

- `npm run runtime:build` 生成 `runtime/meta.json` 和 `runtime/matches.json`
- 客户端先拉 `meta.json`，`hash` 变化时才拉 `matches.json`；成功结果缓存到 `hbSDK.storage`，失败回退到缓存或内置数据
- 本地联调：`npm run runtime:serve` + `VITE_RUNTIME_DATA_BASE=http://127.0.0.1:5180/ npm run dev`
- **GitHub Pages 只能自测，不能作为小程序运行时源**：平台对 `network` 申请域名做 ICP 备案自动校验，`zhuran305-web.github.io` 无法备案，申请已被自动驳回（2026-10-21）。`publish-runtime-pages.yml` 保留作开发期镜像
- **当前方案（探针中）**：阿里云 OSS 默认端点 + `tools/publish-runtime-oss.mjs`（零依赖，建桶/设 CORS/上传/匿名校验一条命令），详细步骤见 [docs/runtime-oss.md](docs/runtime-oss.md)
- `update-matches.yml` 已接入 OSS 发布：配置 `OSS_BUCKET` / `OSS_REGION` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` 后自动同步，未配置时跳过
- 申请 `network` 权限时域名只填主机名（如 `<bucket>.oss-cn-hangzhou.aliyuncs.com`），1–20 个，不带协议/端口/路径/通配符；不支持申请小黑盒官方域名
- 运行时 URL 必须直连 HTTPS；Release 下载地址会 302，不能作为运行时源（SDK 不跟随重定向）

不建议抓取 HLTV / vlr.gg 等无官方 API 的站点：结构随时变化，且多数站点条款不允许。

## 后续扩展

- **跨设备同步**：`hbSDK.storage` 是本地持久化，不随账号同步；如需跨设备，可接入 `auth.login()` 与自有服务端
- **预测分布**：需要后端统计，当前版本不展示
- **好友/战队**：需要账号体系与后端，当前版本不做
