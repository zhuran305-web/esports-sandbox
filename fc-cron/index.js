/*
 * 采集兜底定时器（1.3.4 基础设施，部署到阿里云 FC，timer 每 30 分钟触发）
 * ------------------------------------------------------------
 * 背景：GitHub 对公开仓库的 schedule 严重节流——15 分钟 cron 实测每 4-7 小时才触发一轮
 * （两个 schedule workflow 同时停、workflow 状态 active、无 incident，见 2026-11-03 排查）。
 * 本函数兜底：每次先读 OSS meta.json 判断数据新鲜度，陈旧（> STALE_MINUTES）才 POST
 * workflow_dispatch 触发 update-matches，避免与 GitHub 自身 cron 重复触发。
 * （timer 节奏 2026-11-03 定档每小时第 5 分钟：FC 每小时最低消费 0.01 元，2 小时档兜底
 *   最坏延迟 ~2.5 小时影响赛果敏感期；每小时档月增 ~3.6 元、最坏延迟 ~1.5 小时，
 *   且错开 GitHub 整点轮——GitHub 正常时数据 5 分钟新鲜，自然 skip。）
 *
 * 环境变量（只有两项，且都不参与 URL 构造）：
 *   GITHUB_DISPATCH_TOKEN  fine-grained PAT（仅 Actions: write，只授权本仓库）——必填
 *   STALE_MINUTES          默认 35（数据超过该分钟数视为陈旧）
 *   ALERT_WEBHOOK_URL      可选：飞书/钉钉/Server酱 webhook——采集链路故障时通知（2026-11-08
 *                          防复发：9h 停更靠用户报障才发现）。host 限告警白名单，保持零 SSRF 面
 *   ALERT_STALE_MINUTES    默认 100（≈连续 2 轮兜底未恢复，发心跳告警）
 *
 * 告警触发：①workflow_dispatch 失败/异常→立即告警（GitHub 不可达时 workflow 自身无法告警，
 * 本函数是唯一能发通知的通道）；②数据陈旧 ≥ALERT_STALE_MINUTES→每小时一条心跳（FC 每小时
 * 一轮 timer，天然限频）。workflow 侧另有 run 失败告警（tools/alert-notify.mjs，55min 频控），
 * 两者互补：run 失败靠 workflow 通道，GitHub 全链路故障靠本函数通道。
 *
 * 安全（SSRF 面为零）：请求目标全部硬编码——host 只能取 ALLOWED_HOSTS / 告警白名单键，path 只能取
 * 本文件内的固定字面量或告警 webhook 的 path（host 必须命中白名单）；不接受任何其他外部输入。
 * 仅 timer 触发，无公网入站地址。运行时 nodejs16（无全局 fetch，用 https 模块）；单次调用 < 2s。
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

/* 告警 webhook 白名单：host 必须命中才允许请求（保持「请求目标可枚举」的安全性质） */
var ALERT_HOSTS = { "open.feishu.cn": 1, "oapi.dingtalk.com": 1, "sctapi.ftqq.com": 1 };
var ALERT_STALE_DEFAULT_MINUTES = 100; // ≈连续 2 轮兜底未恢复

function alertStaleMinutes() {
  var n = Number(process.env.ALERT_STALE_MINUTES);
  return isFinite(n) && n > 0 ? n : ALERT_STALE_DEFAULT_MINUTES;
}

/* 解析告警 webhook（env）：host 限白名单、强制 https、path 校验——不合法一律返回 null（静默不发） */
function alertTarget() {
  var url = String(process.env.ALERT_WEBHOOK_URL || "").trim();
  if (!url) return null;
  var u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== "https:" || !ALERT_HOSTS[u.hostname]) return null;
  var p = u.pathname || "/";
  if (p.charAt(0) !== "/" || /\s/.test(p) || p.length > 512) return null;
  return { host: u.hostname, path: p, platform: u.hostname };
}

/* 按平台构造 payload：飞书/钉钉 text JSON，Server酱 form（title/desp） */
function alertPayload(target, title, body) {
  var text = title + (body ? "\n" + body : "");
  if (target.platform === "open.feishu.cn") {
    return { body: JSON.stringify({ msg_type: "text", content: { text: text } }), contentType: "application/json" };
  }
  if (target.platform === "oapi.dingtalk.com") {
    return { body: JSON.stringify({ msgtype: "text", text: { content: String(text).slice(0, 1800) } }), contentType: "application/json" };
  }
  return { body: "title=" + encodeURIComponent(title.slice(0, 200)) + "&desp=" + encodeURIComponent(String(body).slice(0, 3000)), contentType: "application/x-www-form-urlencoded" };
}

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
  var at = alertTarget();
  var alertIf = async function (title, body) {
    if (!at) { console.log("[cron] 告警未配置（ALERT_WEBHOOK_URL），跳过：" + title); return; }
    var p = alertPayload(at, title, body);
    try {
      var res = await httpsRequest(at, "POST", { "Content-Type": p.contentType, "User-Agent": "esports-sandbox-cron" }, p.body, 8000);
      console.log("[cron] 告警已发 HTTP " + res.status);
    } catch (e) {
      console.log("[cron] 告警发送失败：" + ((e && e.message) || e));
    }
  };
  try {
    var res = await httpsRequest(resolveTarget("ghDispatch"), "POST", {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "esports-sandbox-cron",
      "Content-Type": "application/json"
    }, JSON.stringify({ ref: "main" }), 10000);
    console.log("[cron] workflow_dispatch HTTP " + res.status + (res.body ? " · " + String(res.body).slice(0, 160) : ""));
    if (res.status !== 204) {
      // dispatch 失败：GitHub API 异常——workflow 侧 run 失败告警发不出来（run 没跑成），这里是唯一通道
      await alertIf("【赛事沙盘】采集兜底 dispatch 失败",
        "workflow_dispatch HTTP " + res.status + " · 数据已陈旧 " + (ageMinutes === null ? "?" : Math.round(ageMinutes)) + " 分钟。GitHub API 异常或 token 失效，请检查。");
    } else if (ageMinutes !== null && ageMinutes >= alertStaleMinutes()) {
      // 心跳：已成功触发采集但数据持续陈旧——可能 run 连续失败或发布链路停更
      await alertIf("【赛事沙盘】数据持续陈旧",
        "OSS 数据已 " + Math.round(ageMinutes) + " 分钟未更新（兜底触发正常，可能采集 run 连续失败或发布链路停更）。");
    }
    return JSON.stringify({ dispatched: res.status === 204, status: res.status, ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes * 10) / 10 });
  } catch (e) {
    var msg = String((e && e.message) || e);
    console.log("[cron] workflow_dispatch 失败：" + msg);
    await alertIf("【赛事沙盘】采集兜底 dispatch 异常", "workflow_dispatch 异常：" + msg + "（GitHub 不可达？）。workflow 侧告警通道此时不可用，本条为唯一通知。");
    return JSON.stringify({ error: msg });
  }
};
