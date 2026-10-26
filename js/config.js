/*
 * 运行时数据源。留空表示关闭运行时拉取，只使用构建时内置数据。
 * 联调：VITE_RUNTIME_DATA_BASE=http://127.0.0.1:5180/ npm run dev
 * 生产：VITE_RUNTIME_DATA_BASE=https://<bucket 域名>/ npm run build
 */
export var RUNTIME_DATA_BASE =
  (import.meta.env && import.meta.env.VITE_RUNTIME_DATA_BASE) || "";

/*
 * 身份换票端点（2026-10-26 起直连优先）。官方口径：network 权限批准后访问第三方
 * HTTPS 域名无需再次申请，故默认直连 FC 换票函数：
 *   https://exchange-esportsidentity-qaxicyqhmg.cn-hangzhou.fcapp.run/api/exchange/<一次性code>
 * 旧客户端若仍拦截第三方域名（PERMISSION_DENIED）或直连失败，app.js 自动降级到
 * OSS Mirror 回源路径（IDENTITY_EXCHANGE_FALLBACK，规则见 tools/set-oss-mirror.mjs
 * 与接手说明；code 放路径以防回源缓存串号）。
 */
export var IDENTITY_EXCHANGE_URL =
  (import.meta.env && import.meta.env.VITE_IDENTITY_EXCHANGE_URL) ||
  "https://exchange-esportsidentity-qaxicyqhmg.cn-hangzhou.fcapp.run/api/exchange";

/* 回源兜底：复用已批准 OSS 域名，经 Mirror 透传同一 FC 函数 */
export var IDENTITY_EXCHANGE_FALLBACK =
  (import.meta.env && import.meta.env.VITE_IDENTITY_EXCHANGE_FALLBACK) ||
  "https://esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com/api/exchange";

