# 运行时数据托管到阿里云 OSS（已上线）

> **状态（2026-10-22）**：已完成。network 申请 `15efcd80-c5ec-4908-8cb5-20c1b5e4c1d1`
> 获批（意见「飞书群审批通过网络权限」），bucket `esports-sandbox-data`（杭州、公共读），
> 公共基址 `https://esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com/`；`1.1.0` 已发布，
> `remote info` 显示 `network: 线上快照=enabled`。下文保留为完整操作记录与排障参考。

## 为什么走这条路

`network` 是平台审批制，且平台会对申请域名做 **ICP 备案自动校验**。`*.github.io` 无法备案，
申请已被自动驳回（申请 ID `d50bcb64-e91e-4d4f-9722-c2875a928d53`）。国内对象存储的默认端点
（`<bucket>.oss-cn-<region>.aliyuncs.com`）父域已备案，是成本最低的探针：

- 不需要买域名，不需要走 1–3 周的备案流程；
- 存储与流量费用可忽略（数据 1.24 MiB，按用户数计流量）；
- 如果平台认父域备案，几十分钟就能拿到权限；不认再走自有域名备案，损失很小。

## 你需要手动做的三件事

试用已开通后，只剩下面三步。凭据**不要贴进对话或命令行历史**，写到本地 `.env`（已在 `.gitignore`）。

1. **创建 Bucket**（控制台 → 对象存储 OSS → Bucket 列表 → 创建 Bucket）：
   - 地域选离用户近的大陆地域，例如 `华东1（杭州）`，记下地域 ID `cn-hangzhou`；
   - 读写权限选 **公共读**（脚本也会尝试设置，但控制台更直观）；
   - 记下 Bucket 名称（全局唯一，小写）。
2. **创建 RAM 子账号**（控制台 → 访问控制 RAM → 用户 → 创建用户，勾选「使用永久 AccessKey 访问」）：
   - 只授予这个 Bucket 的读写权限（不要用主账号 AccessKey）；
   - 保存 AccessKey ID / Secret。
3. 在项目根新建 `.env`（不要提交）：

```bash
OSS_BUCKET=<你的bucket>
OSS_REGION=cn-hangzhou
OSS_ACCESS_KEY_ID=<AK>
OSS_ACCESS_KEY_SECRET=<SK>
```

然后跑：

```bash
npm run runtime:publish -- --create-bucket --set-cors --upload --check
```

脚本会依次：建桶（公共读）→ 设 CORS → 上传 `meta.json` / `matches.json` → 匿名读取校验
（比对 count/hash、Content-Type、CORS 预检）。看到 `匿名读取 OK · 3248 场` 就说明公读和内容都正常。

想先看计划不联网：`npm run runtime:publish -- --upload --check --dry-run`（不读凭据也能跑）。

常见失败：

- `AccessDenied` / `PublicAccessBlocked`：账号或 Bucket 开了「阻止公共访问」，到 Bucket → 权限管理里关闭后再跑；
- `BucketAlreadyExists`：名字被别人占用，换一个（全局唯一）；
- `InvalidAccessKeyId` / `SignatureDoesNotMatch`：AK/SK 填错，或 `.env` 里混入了空格/引号；
- `SecondLevelDomainForbidden`：用了 `oss-cn-hangzhou.aliyuncs.com` 这类不带 bucket 的域名，检查 `OSS_BUCKET`。

## 申请 network 权限

用脚本最后打印的主机名（**只填主机名，不带 `https://`、路径、通配符**）：

```bash
npx hb-sdk remote permission apply network \
  --reason "拉取赛事赛程与赛果数据（公共只读 JSON，约 1.2 MiB，启动时检查更新）" \
  --domains "<bucket>.oss-cn-hangzhou.aliyuncs.com"
npx hb-sdk remote permission list
```

- 申请是绑定小程序而不是版本，已绑定该小程序即可调试；
- 待审期间改域名不生效；如果被拒，换域名重新提交即可；
- 批准后仍需 `package.json#heybox.permissions.network` 保持声明（现在已经声明）。

## 发版（批准后每次都要带基址）

```bash
# 1. 拉最新数据并同步 OSS（npm run data:pull 在 github.com 被墙时会失败，改用 gh）
gh release download data --repo zhuran305-web/esports-sandbox --pattern matches.json --dir data --clobber
npm run runtime:build
npm run runtime:publish -- --upload --check     # 期望「匿名读取 OK · N 场」

# 2. 两处版本号同步升（package.json + js/app.js 的 APP_VERSION）

# 3. 用远端基址构建
VITE_RUNTIME_DATA_BASE=https://esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com/ npm run build

# 4. 确认产物真的带上了基址
grep -o "esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com" dist/assets/*.js | head -1

# 5. 提审 —— deploy 会自己重新构建，所以命令同样要带变量；过审后发布
VITE_RUNTIME_DATA_BASE=https://esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com/ \
  npx hb-sdk remote deploy --release-note "..."
npx hb-sdk remote release <version> --yes
```

**第 5 步最容易漏**：`remote deploy` 内部先 `npm run build` 再上传，环境变量不跟着命令走就会打出不带基址的包。

验收：`remote info` 的 `network` 行显示 `线上快照=enabled`；设置页「数据更新」时间变成 OSS 上 `meta.json` 的 `updatedAt`；断网时回退缓存/内置数据，不白屏。

**审核期间**用 `remote preview` 打开新版本会弹宿主原生 `SERVER_API_REQUIRED`（effective network 未生效），发布后消失——不是代码问题。

## 让数据自动更新（可选，但推荐）

在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加：

| Secret | 值 |
| --- | --- |
| `OSS_BUCKET` | bucket 名称 |
| `OSS_REGION` | 如 `cn-hangzhou` |
| `OSS_ACCESS_KEY_ID` | RAM 子账号 AK |
| `OSS_ACCESS_KEY_SECRET` | RAM 子账号 SK |
| `OSS_PREFIX` | 可选，对象前缀；不用就留空 |

`update-matches.yml` 已加好步骤：数据变化时自动上传并做匿名校验；**每轮还无条件比对线上
meta.json 的 hash，不一致即同步**（2026-10-25 停更事故的自愈机制——变化检测以 Release 为基准，
OSS 一旦脱节会被「无变化」卡死，只能靠无条件比对拉回）。配好后采集器每 5 分钟更新一次 OSS；
小程序端每 5 分钟轮询 meta（hash 变才拉整包）、回前台即刷新（1.1.16 起）。

> 注意：`runtime/matches.json` 约 1.19 MiB，每次 hash 变化客户端会整包下载。OSS 试用包的 2 GB 下行流量
> 约等于 1600 次整包下载；如果日活上来，优先做 gzip 或裁剪 runtime 窗口（只保留近 7 天 + 未来 21 天），
> 再考虑加定时轮询。

## 如果以后需要换域名（探针曾被拒时的备选）

当前方案没有用到这条分支，保留备查：如果对象存储默认端点被拒，再买域名 + ICP 备案 + 自定义域名。

平台若只认「与开发者主体一致的自有域名」，对象存储默认端点会被拒。此时：

1. 买一个域名（阿里云/腾讯云均可），完成 ICP 备案（需要国内接入商，通常 1–3 周）；
2. OSS 绑定该自定义域名并开启 HTTPS；
3. 用自定义域名重新申请 network；
4. `VITE_RUNTIME_DATA_BASE` 换成自定义域名即可，客户端代码不用改。

在拿到权限之前，**不要**把 `VITE_RUNTIME_DATA_BASE` 写进发版构建——未获批时请求必然
`PERMISSION_DENIED`，只会白白多发一个版本。

## 已上线记录（2026-10-22）

- network 申请 `15efcd80-c5ec-4908-8cb5-20c1b5e4c1d1` → `approved`（「飞书群审批通过网络权限」）
- `1.1.0` 发布，线上 `https://activity.xiaoheihe.cn/u/w3at1r/w6zGbZ9OQW/index.html`，
  `remote info`：`network: 本地声明=是 线上版本声明=是 平台批准=已批准 线上快照=enabled`
- 线上 `assets/index-*.js` 已确认含 `esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com`
- OSS 数据：`meta.json` + `matches.json`（3375 场 / 1.24 MiB）；`update-matches.yml` 在数据变化时自动同步
