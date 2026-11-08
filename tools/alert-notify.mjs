#!/usr/bin/env node
/* 告警通知（2026-11-08）：采集失败 / OSS 停更的 webhook 通知——停更 9h 靠用户报障才发现的教训。
 * 用法：node tools/alert-notify.mjs --title "..." --body "..."
 *
 * 频控：查本 workflow 最近 55 分钟内的失败 run——有则跳过（concurrency 排队与重试的同批
 * 失败只发一条；跨小时故障每小时一条心跳，不会静默）。
 * 平台适配（按 webhook host）：open.feishu.cn（飞书群机器人）/ oapi.dingtalk.com（钉钉）
 * / sctapi.ftqq.com（Server酱）；其他 host 按通用 JSON POST。
 * 未配置 ALERT_WEBHOOK_URL 时静默退出（exit 0）——任何错误都不以非零退出（告警绝不拖垮 workflow）。 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : "";
}
const title = argOf("--title") || "采集告警";
const body = argOf("--body") || "";

const url = String(process.env.ALERT_WEBHOOK_URL || "").trim();
if (!url) {
  console.log("[alert] 未配置 ALERT_WEBHOOK_URL，跳过通知");
  process.exit(0);
}

/* —— 频控：本 workflow 最近 55 分钟内已有失败 run → 同批只发一条 —— */
try {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const wf = process.env.ALERT_WORKFLOW_FILE || "update-matches.yml";
  if (repo && runId && process.env.GH_TOKEN) {
    const out = execFileSync("gh", [
      "api",
      `repos/${repo}/actions/workflows/${wf}/runs?status=failure&per_page=10`,
      "--jq",
      `.workflow_runs[] | select(.id != ${Number(runId)}) | .created_at`
    ], { encoding: "utf8", timeout: 15000 });
    const windowMs = 55 * 60000;
    const recent = out.split("\n").filter(Boolean)
      .map((ts) => Date.now() - new Date(ts).getTime())
      .some((age) => age >= 0 && age < windowMs);
    if (recent) {
      console.log("[alert] 55 分钟内已有失败 run（同批排队/重试），跳过重复通知");
      process.exit(0);
    }
  }
} catch (e) {
  console.log("[alert] 频控查询失败（不阻塞告警）：" + String((e && e.message) || e).slice(0, 120));
}

/* —— 平台适配 —— */
let payload;
let contentType = "application/json";
try {
  const u = new URL(url);
  const text = title + (body ? "\n" + body : "");
  if (u.hostname === "open.feishu.cn") {
    payload = JSON.stringify({ msg_type: "text", content: { text } });
  } else if (u.hostname === "oapi.dingtalk.com") {
    payload = JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 1800) } });
  } else if (u.hostname === "sctapi.ftqq.com") {
    payload = new URLSearchParams({ title: title.slice(0, 200), desp: body.slice(0, 3000) }).toString();
    contentType = "application/x-www-form-urlencoded";
  } else {
    payload = JSON.stringify({ title, body });
  }
} catch (e) {
  console.error("[alert] ALERT_WEBHOOK_URL 解析失败：" + String((e && e.message) || e).slice(0, 120));
  process.exit(0);
}

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: payload
  });
  const text = await res.text();
  console.log("[alert] webhook HTTP " + res.status + (text ? " · " + text.slice(0, 160) : ""));
  process.exit(0);
} catch (e) {
  console.error("[alert] webhook 发送失败（不阻塞 workflow）：" + String((e && e.message) || e).slice(0, 200));
  process.exit(0);
}
