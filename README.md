# 赛事沙盘 · 电竞赛事预测模拟盘

纯前端的电竞赛事胜负预测小程序（小黑盒「小程序工坊」），覆盖 CS2、Dota 2、英雄联盟、无尽对决、彩虹六号、王者荣耀、守望先锋、瓦罗兰特、星际争霸2、火箭联盟等 10 个项目。玩家用虚拟「沙粒」预测真实比赛胜负。

> 沙粒为虚拟道具，无任何现实价值，不可充值、兑换、交易，不涉及真实货币。

## 功能

- **赛程**：自动分组（正在比赛/可竞猜/已截止/待赛果/刚结束）；首页展示未来 14 天+近 1 天自己猜过的赛果，完整 ±30 天在赛程表（主页「赛程表」按钮直达）；**每 5 分钟自动轮询**赛果（对齐采集器节奏），回前台即刷新，挂着不动也会自动结算
- **筛选**：游戏托盘（按钮下方展开）+ 赛事筛选（全部/大型赛事 S/A 级/具体）+ 六态状态托盘，游戏切换联动
- **竞猜**：开赛前 1 小时截止；沙粒为正单场最多投入余额 2 倍；归零/负债只能 10/100/1000/负债额四档；投入后可**加注/撤回**（三态）；负债可继续竞猜；采沙把不足 10,000 的余额（含负债）补足
- **结算**：赛果录入后自动结算+toast+震动；连对第 2 场起 +10/20/30/50%（封顶）加成
- **身份与昵称**：全平台统一的**纯隔离身份架构**——打开即自动绑定小黑盒隔离身份（app_user_id，经榜单通道）；点「**同步黑盒资料**」（设置页/新手引导最后一步）授权后显示真实小黑盒昵称头像，并同步到排行榜
- **双排行榜**：胜榜（猜对次数+净赚）/ 败榜（猜错次数+净亏），平台云端榜单；只展示有竞猜记录的玩家（0 战绩的注册条目不显示，名次仍连续）；无昵称条目显示「盒友·ID后4位」；「我」高亮
- **战绩云同步**：`cloud.storage` 跨设备同步沙粒与预测（LWW+冲突自动恢复；部分鸿蒙客户端暂不支持，自动降级）
- **分享**：canvas 战绩卡图片、转发到社区（预置赛事话题）、复制文案、**复制链接深链**（好友打开直达对应比赛并高亮）
- **设置**：主题（跟随系统/深/浅）、展示昵称、清除本地数据；**关于小程序**二级页（数据来源/版本/环境诊断/云服务/云同步状态）
- **兜底**：存储降级、脏数据修正、数据加载失败明确错误页、白屏自救（宿主 reload 优先）

## 架构一览

```
页面（Vite + @heybox/hb-sdk）
 ├─ 赛程数据：内置 4+16 天窗口快照 → 运行时每 5 分钟轮询 OSS（meta 探测，hash 变才拉整包）
 ├─ 身份：榜单通道 app_user_id（boot 自动注册）+ 授权换票（auth.login → OSS/api/exchange/<code> → 镜像回源 FC → OpenAPI）
 ├─ 排行榜：平台 cloud.leaderboard（score=次数×1e9+沙粒数，昵称在 extra.nick）
 └─ 跨设备战绩：cloud.storage key state_v1（LWW）

采集（GitHub Actions，数据不进 Git）
 └─ PandaScore 每 5 分钟 → Release 资产 + OSS 同步（漂移自愈）；每日回填 ±30 天
```

## 文件结构

```
index.html / css/style.css     页面与样式
js/app.js                      主逻辑（渲染/竞猜/结算/排行/分享/轮询/换票触发）
js/cloud.js                    云服务层（榜单/云同步/身份注册）
js/platform.js                 hb-sdk 适配层（握手/storage/network/分享/授权/事件包装）
js/config.js                   运行时数据基址 + 换票端点
js/data-source.js              运行时拉取与缓存
fc-identity/index.js           换票函数（部署到阿里云 FC；凭据只在 FC 环境变量）
data/manual-matches.json       手工赛程（提交）；matches.json / matches-embedded.json 生成不提交
tools/                         采集器、数据同步、OSS 发布、换票函数部署、榜单冒烟测试等脚本
.github/workflows/             update-matches / backfill / keepalive / publish-runtime-pages
docs/接手说明.md               半小时接手指南（含发版全流程）
```

## 本地开发与发布

```bash
npm install
npm run dev                          # 调试台（默认 5176/5177）
npm run test:cloud                   # 榜单/昵称冒烟测试（stub SDK，发版前必跑）
VITE_RUNTIME_DATA_BASE=https://esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com/ npm run build

# 提审/发布（deploy 会自己重建，环境变量必须跟着命令走）
VITE_RUNTIME_DATA_BASE=<基址> npx hb-sdk remote deploy --release-note "..."
npx hb-sdk remote release <版本> --yes
```

普通浏览器不能直接打开产物（Runtime Gate）；验收一律用官方调试宿主。远端详情与排障经验见 `docs/接手说明.md` 与开发记录。

## 小程序声明与权限（package.json#heybox）

- platforms `android/ios/ohos/windows/macos`；category `game`；`bindAppIds` 5 个（英雄联盟/无畏契约/星际2/CS2/彩虹六号：攻势——PC 游戏工作区发现，只收小黑盒自有库条目）
- 权限：`share` / `storage` / `userInfo` / `leaderboard` / `cloud_storage` / `clipboard` 声明即用；`network` 审批制（已批，域名=OSS 桶域名）

## 赛事数据采集

采集器零依赖（Node 18+ 原生 fetch）：`npm run fetch`（`--dry-run` / `--only=manual` / `--days` / `--retention`）。数据源：PandaScore（主，`PANDASCORE_TOKEN`）+ 手工（`data/manual-matches.json`，优先级最高、永不清理）。合并规则：游戏+日期+双方去重、有赛果覆盖无赛果、保留已有 id/note、schema 校验。

GitHub Actions 每 5 分钟采集（变化才覆盖 Release 资产并同步 OSS；另有无条件 OSS 漂移比对自愈），每日 UTC 03:00 回填 ±30 天；仓库 60 天无活动由 keepalive 保活；push 不触发 CI。

手工补赛编辑 `data/manual-matches.json`（`game` 须在 `js/app.js` 的 `GAMES` 注册表；补 `result` 即触发结算）；新增游戏=注册表加条目+数据里有赛程即可自动出现。

## 合规红线（每次提审守住）

- 文案统一「预测/投入/沙粒」，不用「下注/押注/赔率/博彩」；无赔率、无充值、无兑换、无交易；采沙只补足到 10,000
- 上架规则明令禁止「具备博彩性质的竞猜」——沙粒不可购买、不可兑现、无付费入口是安全线，提审材料持续强调
