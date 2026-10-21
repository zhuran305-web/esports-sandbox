# 运行时数据托管到阿里云 OSS（network 权限探针）

## 为什么走这条路

`network` 是平台审批制，且平台会对申请域名做 **ICP 备案自动校验**。`*.github.io` 无法备案，
申请已被自动驳回（申请 ID `d50bcb64-e91e-4d4f-9722-c2875a928d53`）。国内对象存储的默认端点
（`<bucket>.oss-cn-<region>.aliyuncs.com`）父域已备案，是成本最低的探针：

- 不需要买域名，不需要走 1–3 周的备案流程；
- 存储与流量费用可忽略（数据 1.16 MiB，按用户数计流量）；
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

## 批准后发版

```bash
# 1. 拉最新数据并生成 runtime（可选，构建本身会内嵌 data/matches.json）
npm run data:pull
npm run runtime:build

# 2. 用远端基址构建（两处版本号同步升）
VITE_RUNTIME_DATA_BASE=https://<bucket>.oss-cn-hangzhou.aliyuncs.com/ npm run build

# 3. 确认产物真的带上了基址
grep -o "oss-cn-hangzhou.aliyuncs.com" dist/assets/*.js | head -1

# 4. 提审 / 发布（流程同以前）
npx hb-sdk remote deploy --release-note "运行时赛程拉取"
```

验收：设置页「数据更新」时间应变成 OSS 上 `meta.json` 的 `updatedAt`；断网时应回退缓存/内置数据，不白屏。

## 让数据自动更新（可选，但推荐）

在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加：

| Secret | 值 |
| --- | --- |
| `OSS_BUCKET` | bucket 名称 |
| `OSS_REGION` | 如 `cn-hangzhou` |
| `OSS_ACCESS_KEY_ID` | RAM 子账号 AK |
| `OSS_ACCESS_KEY_SECRET` | RAM 子账号 SK |
| `OSS_PREFIX` | 可选，对象前缀；不用就留空 |

`update-matches.yml` 已加好步骤：数据变化时自动上传并做匿名校验；没配密钥时自动跳过，
不影响原有采集与 Release 发布。配好后采集器每 5 分钟更新一次 OSS；小程序端**目前在每次启动时**
检查 meta（`js/app.js#refreshData` 只在 boot 调用，没有定时轮询），所以用户重新进入小程序就能看到新赛程与赛果。

> 注意：`runtime/matches.json` 约 1.19 MiB，每次 hash 变化客户端会整包下载。OSS 试用包的 2 GB 下行流量
> 约等于 1600 次整包下载；如果日活上来，优先做 gzip 或裁剪 runtime 窗口（只保留近 7 天 + 未来 21 天），
> 再考虑加定时轮询。

## 如果探针被拒

平台若只认「与开发者主体一致的自有域名」，对象存储默认端点会被拒。此时：

1. 买一个域名（阿里云/腾讯云均可），完成 ICP 备案（需要国内接入商，通常 1–3 周）；
2. OSS 绑定该自定义域名并开启 HTTPS；
3. 用自定义域名重新申请 network；
4. `VITE_RUNTIME_DATA_BASE` 换成自定义域名即可，客户端代码不用改。

在拿到权限之前，**不要**把 `VITE_RUNTIME_DATA_BASE` 写进发版构建——未获批时请求必然
`PERMISSION_DENIED`，只会白白多发一个版本。
