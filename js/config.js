/*
 * 运行时数据源。留空表示关闭运行时拉取，只使用构建时内置数据。
 * 联调：VITE_RUNTIME_DATA_BASE=http://127.0.0.1:5180/ npm run dev
 * 生产：VITE_RUNTIME_DATA_BASE=https://<bucket 域名>/ npm run build
 */
export var RUNTIME_DATA_BASE =
  (import.meta.env && import.meta.env.VITE_RUNTIME_DATA_BASE) || "";

/*
 * 身份换票端点。走 OSS Mirror 回源透传到换票函数（GET，code 走 query）：
 *   https://<已批准的 OSS 域名>/api/exchange?code=<auth.login 一次性授权码>
 * ——请求域名与赛程数据同源，无需额外 network 域名审批；回源不落缓存（源站 no-store）。
 * 回源规则见 tools/set-oss-mirror.mjs 注释与接手说明（OSS 控制台配置）。
 */
export var IDENTITY_EXCHANGE_URL =
  (import.meta.env && import.meta.env.VITE_IDENTITY_EXCHANGE_URL) ||
  "https://esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com/api/exchange";

