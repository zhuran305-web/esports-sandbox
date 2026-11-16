/*
 * 运行时数据源（生产桶基址为公开常量，与换票端点同款「env || 硬编码」兜底）。
 * 1.3.24 事故修复：`hb-sdk remote deploy` 会自己重新构建（CLI 说明「构建并提交」）——
 * 调用方漏带 VITE_RUNTIME_DATA_BASE 时旧写法产出空基址，1.3.20~1.3.23 四个线上版本
 * 因此全部处于「未启用在线更新」离线态（用户鸿蒙机 toast 实测抓到；天禄队标/阵容消失
 * 只是其表象之一）。硬编码兜底后任何构建路径（deploy 重建/联调）都不会再丢基址；
 * 联调仍可用 env 覆盖（VITE_RUNTIME_DATA_BASE=http://127.0.0.1:5180/）。
 */
export var RUNTIME_DATA_BASE =
  (import.meta.env && import.meta.env.VITE_RUNTIME_DATA_BASE) ||
  "https://esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com/";

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

