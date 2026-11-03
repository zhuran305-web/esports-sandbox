/*
 * 采集兜底定时器（1.3.4 基础设施，部署到阿里云 FC，timer 每 30 分钟触发）
 * ------------------------------------------------------------
 * 背景：GitHub 对公开仓库的 schedule 严重节流——15 分钟 cron 实测每 4-7 小时才触发一轮
 * （两个 schedule workflow 同时停、workflow 状态 active、无 incident，见 2026-11-03 排查）。
 * 本函数兜底：每次先读 OSS meta.json 判断数据新鲜度，陈旧（> STALE_MINUTES）才 POST
 * workflow_dispatch 触发 update-matches，避免与 GitHub 自身 cron 重复触发。
 *
 * 环境变量（只有两项，且都不参与 URL 构造）：
 *   GITHUB_DISPATCH_TOKEN  fine-grained PAT（仅 Actions: write，只授权本仓库）——必填
 *   STALE_MINUTES          默认 35（数据超过该分钟数视为陈旧）
 *
 * 安全（SSRF 面为零）：请求目标全部硬编码——host 只能取 ALLOWED_HOSTS 白名单键，path 只能取
 * 本文件内的固定字面量；不接受任何 URL/仓库/工作流名的外部输入。仅 timer 触发，无公网入站地址。
 * 运行时 nodejs16（无全局 fetch，用 https 模块）；单次调用 < 2s。
 */
"use strict";

var https = require("https");

/* 请求目标白名单：键 → 固定 host。调用处只能传常量键，无法从外部注入地址 */
var ALLOWED_TARGETS = {
  ossMeta: { host: "esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com", path: "/meta.json" },
  ghDispatch: { host: "api.github.com", path: "/repos/zhuran305-web/esports-sandbox/actions/workflows/update-matches.yml/dispatches" }
};
var ALLOWED_HOSTS = { "esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com": true, "api.github.com": true };

var STALE_DEFAULT_MINUTES = 35;

function resolveTarget(key) {
  var t = ALLOWED_TARGETS[key];
  if (!t || !ALLOWED_HOSTS[t.host]) throw new Error("blocked target key");
  return t;
}

/* 底层请求：只接收白名单里的 host/path（双保险再校验一次 host） */
function httpsRequest(target, method, headers, body, timeoutMs) {
  var host = target && target.host;
  var reqPath = target && target.path;
  if (!host || !ALLOWED_HOSTS[host]) throw new Error("blocked host");
  if (typeof reqPath !== "string" || reqPath.charAt(0) !== "/" || /[\s]/.test(reqPath)) throw new Error("blocked path");
  return new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: host,
      port: 443,
      path: reqPath,
      method: method,
      headers: headers || {},
      timeout: timeoutMs || 8000
    }, function (res) {
      var data = "";
      res.on("data", function (c) { data += c; });
      res.on("end", function () { resolve({ status: res.statusCode, body: data }); });
    });
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function staleMinutes() {
  var n = Number(process.env.STALE_MINUTES);
  return isFinite(n) && n > 0 ? n : STALE_DEFAULT_MINUTES;
}

exports.handler = async function (event, context) {
  var token = String(process.env.GITHUB_DISPATCH_TOKEN || "");

  // 1) 数据新鲜度检查：未陈旧则跳过（GitHub 自身 cron 偶尔正常时避免双触发）
  var stale = true;
  var ageMinutes = null;
  try {
    var metaRes = await httpsRequest(resolveTarget("ossMeta"), "GET", { "User-Agent": "esports-sandbox-cron" }, null, 8000);
    if (metaRes.status === 200) {
      var meta = JSON.parse(metaRes.body);
      var updated = new Date(meta.updatedAt).getTime();
      if (!isNaN(updated)) {
        ageMinutes = (Date.now() - updated) / 60000;
        stale = !(ageMinutes >= 0 && ageMinutes < staleMinutes());
      }
    }
    console.log("[cron] meta HTTP " + metaRes.status + " · age=" + (ageMinutes === null ? "?" : ageMinutes.toFixed(1)) + "min · stale=" + stale);
  } catch (e) {
    console.log("[cron] meta 读取失败（" + (e && e.message) + "），按陈旧处理");
  }
  if (!stale) {
    return JSON.stringify({ skipped: true, ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes * 10) / 10 });
  }

  // 2) 触发采集 workflow（幂等：重复触发只是多跑一轮合并，数据采集本身可重入）
  if (!token) {
    console.log("[cron] 缺少 GITHUB_DISPATCH_TOKEN，跳过");
    return JSON.stringify({ error: "no_token" });
  }
  try {
    var res = await httpsRequest(resolveTarget("ghDispatch"), "POST", {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "esports-sandbox-cron",
      "Content-Type": "application/json"
    }, JSON.stringify({ ref: "main" }), 10000);
    console.log("[cron] workflow_dispatch HTTP " + res.status + (res.body ? " · " + String(res.body).slice(0, 160) : ""));
    return JSON.stringify({ dispatched: res.status === 204, status: res.status, ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes * 10) / 10 });
  } catch (e) {
    console.log("[cron] workflow_dispatch 失败：" + (e && e.message));
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
};
