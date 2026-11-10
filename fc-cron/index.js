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
 *   ALERT_EMAIL_TO         可选：QQ 邮箱地址（收发件同址）——邮件告警通道（11-09 加，Gmail
 *                          在国内收不到的替代）
 *   ALERT_SMTP_PASS        可选：QQ 邮箱 SMTP 16 位授权码（与 ALERT_EMAIL_TO 配对使用）
 *   ALERT_SMTP_HOST/PORT   可选：恒 smtp.qq.com:465（白名单内，改白名单须改代码）
 *
 * 告警触发：①workflow_dispatch 失败/异常→立即告警（GitHub 不可达时 workflow 自身无法告警，
 * 本函数是唯一能发通知的通道）；②数据陈旧 ≥ALERT_STALE_MINUTES→每小时一条心跳（FC 每小时
 * 一轮 timer，天然限频；**发前经 run 健康复核：最近 10 条里有成功 run 且 ≤120min → 内容静默期，
 * 跳过**——2026-11-10 修复：复核此前取 runs[0]，恰是本轮刚 dispatch 的 queued run，静默期必误报）。
 * dispatch 幂等闸：15 分钟内已有 run 则跳过（消灭同小时 2-3 条重复 run/取消噪音）。
 * workflow 侧另有 run 失败告警（tools/alert-notify.mjs，55min 频控），
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
  ghDispatch: { host: "api.github.com", path: "/repos/zhuran305-web/esports-sandbox/actions/workflows/update-matches.yml/dispatches" },
  ghRuns: { host: "api.github.com", path: "/repos/zhuran305-web/esports-sandbox/actions/workflows/update-matches.yml/runs?per_page=10" },
  // live.json 高频链路（2026-11-11）：every10 触发器分支 dispatch 的独立 workflow（单写 live.json，零互扰）
  ghDispatchLive: { host: "api.github.com", path: "/repos/zhuran305-web/esports-sandbox/actions/workflows/refresh-live.yml/dispatches" }
};
var ALLOWED_HOSTS = { "esports-sandbox-data.oss-cn-hangzhou.aliyuncs.com": true, "api.github.com": true };

var STALE_DEFAULT_MINUTES = 35;

/* 告警 webhook 白名单：host 必须命中才允许请求（保持「请求目标可枚举」的安全性质） */
var ALERT_HOSTS = { "open.feishu.cn": 1, "oapi.dingtalk.com": 1, "sctapi.ftqq.com": 1 };
var ALERT_STALE_DEFAULT_MINUTES = 100; // ≈连续 2 轮兜底未恢复

/* SMTP 邮件告警通道（2026-11-09，QQ 邮箱直发——Gmail 在国内收不到的替代）：
 * host 白名单保持「目标可枚举」；端口恒 465 隐式 TLS；凭据只从 env 读 */
var ALERT_SMTP_HOSTS = { "smtp.qq.com": 1 };

function smtpConfig() {
  var to = String(process.env.ALERT_EMAIL_TO || "").trim();
  var pass = String(process.env.ALERT_SMTP_PASS || "").trim();
  var host = String(process.env.ALERT_SMTP_HOST || "smtp.qq.com").trim();
  var port = Number(process.env.ALERT_SMTP_PORT || 465);
  if (!to || !pass || !ALERT_SMTP_HOSTS[host] || port !== 465) return null;
  return { to: to, pass: pass, host: host, port: port };
}

function smtpSendMail(cfg, subject, body) {
  var tls = require("tls");
  return new Promise(function (resolve, reject) {
    var steps = [
      { expect: 220 }, // 服务器问候
      { cmd: "EHLO esports-sandbox-cron", expect: 250 },
      { cmd: "AUTH LOGIN", expect: 334 },
      { cmd: Buffer.from(cfg.to).toString("base64"), expect: 334 },
      { cmd: Buffer.from(cfg.pass).toString("base64"), expect: 235 },
      { cmd: "MAIL FROM:<" + cfg.to + ">", expect: 250 },
      { cmd: "RCPT TO:<" + cfg.to + ">", expect: 250 },
      { cmd: "DATA", expect: 354 },
      { body: true, expect: 250 },
      { cmd: "QUIT", expect: 221 }
    ];
    var i = 0;
    var buf = "";
    var sock = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
    sock.setTimeout(15000);
    var done = function (err) { sock.destroy(); err ? reject(err) : resolve(); };
    sock.on("error", done);
    sock.on("timeout", function () { done(new Error("SMTP 超时")); });
    sock.on("data", function (d) {
      buf += d.toString("utf8");
      var lines = buf.split(/\r\n/);
      var lastFull = lines[lines.length - 1] === "" ? lines[lines.length - 2] : lines[lines.length - 1];
      if (!/^\d{3} /.test(lastFull || "")) return; // 多行回复未完
      var reply = buf;
      buf = "";
      var code = parseInt(reply.slice(0, 3), 10);
      var step = steps[i];
      if (!step) return done(null);
      if (code !== step.expect) return done(new Error("SMTP 第 " + (i + 1) + " 步期望 " + step.expect + " 收到 " + code + "：" + reply.slice(0, 140)));
      i++;
      if (i >= steps.length) return done(null);
      var next = steps[i];
      if (next.body) {
        var b64 = Buffer.from(titleBody(body, subject), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
        var msg = [
          "From: <" + cfg.to + ">",
          "To: <" + cfg.to + ">",
          "Subject: =?UTF-8?B?" + Buffer.from(subject, "utf8").toString("base64") + "?=",
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          b64
        ].join("\r\n");
        sock.write(msg + "\r\n.\r\n");
      } else {
        sock.write(next.cmd + "\r\n");
      }
    });
  });
}

function titleBody(body, title) {
  return title + (body ? "\n" + body : "");
}

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

/** 最近一批 update-matches run 里「最新的一条成功 run」是否新鲜（≤120 分钟）——陈旧告警的健康复核。
 *  为什么不能取 workflow_runs[0]（2026-11-10 误报修复）：本函数在**本轮 dispatch 之后**调用，
 *  runs[0] 恰是自己刚创建的 queued/in_progress run（或同小时被 concurrency 取消的重复排队实例），
 *  status!==completed → 恒判不健康——数据内容静默 ≥100 分钟时每小时误发「数据持续陈旧」。
 *  改为在最近 10 条里找最新成功 run：只要有一轮成功且 ≤120 分钟，管线就是健康的（内容静默属正常）。
 *  任何异常（403/网络/超时）仍返回 false → 走告警路径（fail-open，宁可误报不漏报）。 */
async function latestRunHealthy(token) {
  try {
    var res = await httpsRequest(resolveTarget("ghRuns"), "GET", {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "esports-sandbox-cron"
    }, null, 10000);
    if (res.status !== 200) {
      console.log("[cron] run 健康复核 HTTP " + res.status + "（按不健康处理）");
      return false;
    }
    var j = JSON.parse(res.body);
    var runs = (j && j.workflow_runs) || [];
    if (!runs.length) return false;
    // runs 按 created_at 倒序；找最新的一条 completed+success，检查其年龄
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      if (run.status !== "completed" || run.conclusion !== "success") continue;
      var ageMin = (Date.now() - new Date(run.created_at).getTime()) / 60000;
      var ok = ageMin >= 0 && ageMin < 120;
      console.log("[cron] run 健康复核：最新成功 run 距今 " + Math.round(ageMin) + " 分钟（跳过 " + i + " 条未完成/未成功）→ " + (ok ? "健康" : "不健康"));
      return ok;
    }
    console.log("[cron] run 健康复核：最近 " + runs.length + " 条内无成功 run → 不健康");
    return false;
  } catch (e) {
    console.log("[cron] run 健康复核失败（按不健康处理）：" + ((e && e.message) || e));
    return false;
  }
}

/** dispatch 幂等闸（2026-11-10）：最近一条 run（无论状态）创建于 15 分钟内 → 本轮不重复 dispatch。
 *  背景：FC 每小时实测创建 2-3 条同小时重复 run（平台重试/POST 超时但实际已创建），
 *  concurrency 只能取消排队者——重复 run 既浪费配额，又喂出上面的假「不健康」复核。 */
async function recentRunExists(token, minutes) {
  try {
    var res = await httpsRequest(resolveTarget("ghRuns"), "GET", {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "esports-sandbox-cron"
    }, null, 10000);
    if (res.status !== 200) {
      console.log("[cron] 幂等闸复核 HTTP " + res.status + "（保守：视为无近期 run，照常 dispatch）");
      return false;
    }
    var j = JSON.parse(res.body);
    var run = j && j.workflow_runs && j.workflow_runs[0];
    if (!run) return false;
    var ageMin = (Date.now() - new Date(run.created_at).getTime()) / 60000;
    var exists = ageMin >= 0 && ageMin < minutes;
    console.log("[cron] 幂等闸：最近 run 距今 " + Math.round(ageMin) + " 分钟（" + run.status + "/" + (run.conclusion || "-") + "）→ " + (exists ? "有近期 run，跳过 dispatch" : "无近期 run，照常 dispatch"));
    return exists;
  } catch (e) {
    console.log("[cron] 幂等闸复核失败（保守：照常 dispatch）：" + ((e && e.message) || e));
    return false;
  }
}

exports.handler = async function (event, context) {
  var token = String(process.env.GITHUB_DISPATCH_TOKEN || "");

  // triggerName 分支（2026-11-11 live.json 高频链路）：FC timer 事件带 {triggerName,triggerTime}。
  // every10（live 刷新）走短路路径——不查 meta 陈旧度、不走 hourly 的幂等闸/健康复核
  //（live dispatch 是无状态独立 workflow，10 分钟节奏与 hourly 的闸互不相干）；解析失败回落 hourly 主流程
  var triggerName = "";
  try {
    var ev = typeof event === "string" ? JSON.parse(event) : event;
    triggerName = ev && ev.triggerName ? String(ev.triggerName) : "";
  } catch (e) { triggerName = ""; }
  if (triggerName === "every10") {
    console.log("[cron] live 刷新分支（triggerName=every10）→ dispatch refresh-live.yml");
    try {
      var liveRes = await httpsRequest(resolveTarget("ghDispatchLive"), "POST", {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "esports-sandbox-cron",
        "Content-Type": "application/json"
      }, JSON.stringify({ ref: "main" }), 10000);
      console.log("[cron] refresh-live dispatch HTTP " + liveRes.status);
      // dispatch 失败只记日志不在此告警：alertIf 定义在 handler 后段（此处不可用），
      // 且 refresh-live.yml 自带 failure 告警步骤（下一轮 10 分钟后自然重试）
      return JSON.stringify({ dispatched: liveRes.status === 204, live: true, status: liveRes.status });
    } catch (e) {
      var liveMsg = String((e && e.message) || e);
      console.log("[cron] refresh-live dispatch 失败（下轮 10 分钟后重试）：" + liveMsg);
      return JSON.stringify({ error: "live_dispatch_failed", detail: liveMsg });
    }
  }
  // 非 every10（hourly 主触发器/手动 --test）：走既有陈旧检查 + 采集兜底流程

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
  // 2.5) dispatch 幂等闸（2026-11-10）：15 分钟内已有 run → 本轮不再 dispatch（消灭同小时重复 run
  // 与 concurrency 取消噪音；复核失败按保守放行——宁可多抓一轮，不可漏抓）
  if (await recentRunExists(token, 15)) {
    return JSON.stringify({ skipped: true, reason: "recent_run", ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes * 10) / 10 });
  }
  var at = alertTarget();
  var scfg = smtpConfig();
  var alertIf = async function (title, body) {
    var sent = false;
    if (scfg) {
      try {
        await smtpSendMail(scfg, title, body);
        console.log("[cron] 告警邮件已发 → " + scfg.to);
        sent = true;
      } catch (e) {
        console.log("[cron] 告警邮件失败：" + ((e && e.message) || e));
      }
    }
    if (at) {
      var p = alertPayload(at, title, body);
      try {
        var res = await httpsRequest(at, "POST", { "Content-Type": p.contentType, "User-Agent": "esports-sandbox-cron" }, p.body, 8000);
        console.log("[cron] 告警已发 HTTP " + res.status);
        sent = true;
      } catch (e) {
        console.log("[cron] 告警发送失败：" + ((e && e.message) || e));
      }
    }
    if (!sent) console.log("[cron] 告警未配置（ALERT_EMAIL_TO/ALERT_SMTP_PASS 或 ALERT_WEBHOOK_URL），跳过：" + title);
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
      // 陈旧告警前的健康复核（2026-11-09 假警报教训）：数据时间戳=最后「内容变更」时刻
      // （lib.mjs 设计：内容无变化保留旧时间戳）——赛事空窗期数据不变化属正常。
      // 先查最近一轮 run：成功且新鲜 → 管线健康、数据只是没变 → 不发告警；
      // run 失败/缺失/查询失败 → 按故障告警（fail-open，宁可误报不漏报）
      var healthy = await latestRunHealthy(token);
      if (healthy) {
        console.log("[cron] 数据陈旧 " + Math.round(ageMinutes) + " 分钟，但最近 run 成功（内容静默期），跳过告警");
      } else {
        await alertIf("【赛事沙盘】数据持续陈旧",
          "OSS 数据已 " + Math.round(ageMinutes) + " 分钟未更新，且最近一轮采集 run 非成功状态（可能 run 连续失败、调度停摆或发布链路停更）。");
      }
    }
    return JSON.stringify({ dispatched: res.status === 204, status: res.status, ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes * 10) / 10 });
  } catch (e) {
    var msg = String((e && e.message) || e);
    console.log("[cron] workflow_dispatch 失败：" + msg);
    await alertIf("【赛事沙盘】采集兜底 dispatch 异常", "workflow_dispatch 异常：" + msg + "（GitHub 不可达？）。workflow 侧告警通道此时不可用，本条为唯一通知。");
    return JSON.stringify({ error: msg });
  }
};
