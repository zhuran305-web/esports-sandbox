/*
 * 运行时数据源。留空表示关闭运行时拉取，只使用构建时内置数据。
 * 联调：VITE_RUNTIME_DATA_BASE=http://127.0.0.1:5180/ npm run dev
 * 生产：VITE_RUNTIME_DATA_BASE=https://<bucket 域名>/ npm run build
 */
export var RUNTIME_DATA_BASE =
  (import.meta.env && import.meta.env.VITE_RUNTIME_DATA_BASE) || "";
