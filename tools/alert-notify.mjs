#!/usr/bin/env node
/* 告警通知（2026-11-08 建 / 11-09 加邮件通道）：采集失败 / OSS 停更的通知——停更 9h
 * 靠用户报障才发现的教训。用法：node tools/alert-notify.mjs --title "..." --body "..."
 *
 * 渠道（可并存，各自失败互不影响）：
 *   邮件：ALERT_EMAIL_TO（收发件人=QQ 邮箱地址）+ ALERT_SMTP_PASS（QQ 邮箱 16 位授权码）
 *         ——Gmail 在国内收不到的替代，QQ 邮箱直连可达；smtp.qq.com:465 隐式 TLS
 *   webhook：ALERT_WEBHOOK_URL（open.feishu.cn / oapi.dingtalk.com / sctapi.ftqq.com
 *         按 host 适配；其他 host 按通用 JSON POST）
 * 频控：查本 workflow 最近 55 分钟内的失败 run——有则跳过（concurrency 排队与重试的同批
 * 失败只发一条；跨小时故障每小时一条心跳，不会静默）。
 * 未配置任何渠道时静默退出（exit 0）——任何错误都不以非零退出（告警绝不拖垮 workflow）。 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : "";
}
const title = argOf("--title") || "采集告警";
const body = argOf("--body") || "";

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

/* —— SMTP 邮件通道（QQ 邮箱直发，2026-11-09）：Gmail 通知在国内收不到的替代——
 * QQ 邮箱「IMAP/SMTP 服务」开启后给 16 位授权码即可。零依赖裸 TLS SMTP 客户端
 * （node:tls + EHLO/AUTH LOGIN/DATA 状态机，端口 465 隐式 TLS）。
 * 凭据只从环境变量读取：ALERT_EMAIL_TO（收件=发件，即 QQ 邮箱地址）+ ALERT_SMTP_PASS（授权码）。 */
const emailTo = String(process.env.ALERT_EMAIL_TO || "").trim();
const smtpPass = String(process.env.ALERT_SMTP_PASS || "").trim();
const smtpHost = String(process.env.ALERT_SMTP_HOST || "smtp.qq.com").trim();
const smtpPort = Number(process.env.ALERT_SMTP_PORT || 465);
const smtpUser = String(process.env.ALERT_SMTP_USER || emailTo).trim();

function smtpSendMail(subject, text) {
  return import("node:tls").then(({ connect }) => new Promise((resolve, reject) => {
    const steps = [
      { expect: 220 }, // 服务器问候（TLS 握手完成后服务器先发 220，客户端才发 EHLO）
      { cmd: "EHLO esports-sandbox-alert", expect: 250 },
      { cmd: "AUTH LOGIN", expect: 334 },
      { cmd: Buffer.from(smtpUser).toString("base64"), expect: 334 },
      { cmd: Buffer.from(smtpPass).toString("base64"), expect: 235 },
      { cmd: "MAIL FROM:<" + smtpUser + ">", expect: 250 },
      { cmd: "RCPT TO:<" + emailTo + ">", expect: 250 },
      { cmd: "DATA", expect: 354 },
      { body: true, expect: 250 }, // 邮件正文（base64 无行首点，无需 dot-stuffing）
      { cmd: "QUIT", expect: 221 }
    ];
    let i = 0;
    let buf = "";
    const sock = connect({ host: smtpHost, port: smtpPort, servername: smtpHost });
    sock.setTimeout(20000);
    const done = (err, info) => { sock.destroy(); err ? reject(err) : resolve(info); };
    sock.on("error", (e) => done(e));
    sock.on("timeout", () => done(new Error("SMTP 超时")));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split(/\r\n/);
      const lastFull = lines[lines.length - 1] === "" ? lines[lines.length - 2] : lines[lines.length - 1];
      if (!/^\d{3} /.test(lastFull || "")) return; // 多行回复未完（"NNN-" 续行）
      const reply = buf;
      buf = "";
      const code = parseInt(reply.slice(0, 3), 10);
      const step = steps[i];
      if (!step) return done(null, { ok: true });
      if (code !== step.expect) return done(new Error("SMTP 第 " + (i + 1) + " 步期望 " + step.expect + " 收到 " + code + "：" + reply.slice(0, 140)));
      i++;
      if (i >= steps.length) return done(null, { ok: true });
      const next = steps[i];
      if (next.body) {
        const b64 = Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
        const msg = [
          "From: <" + smtpUser + ">",
          "To: <" + emailTo + ">",
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
  }));
}

/* —— 渠道装配：邮件与 webhook 可并存，各自失败互不影响 —— */
const channels = [];
if (emailTo && smtpPass) {
  channels.push({
    name: "邮件(" + emailTo + ")",
    run: async () => {
      const r = await smtpSendMail(title, (body || title).slice(0, 3000));
      return "[alert] SMTP 发送成功";
    }
  });
}
let url = String(process.env.ALERT_WEBHOOK_URL || "").trim();
if (url) {
  channels.push({
    name: "webhook",
    run: async () => {
      let payload;
      let contentType = "application/json";
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
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body: payload });
      const t = await res.text();
      return "[alert] webhook HTTP " + res.status + (t ? " · " + t.slice(0, 160) : "");
    }
  });
}

if (!channels.length) {
  console.log("[alert] 未配置告警渠道（ALERT_EMAIL_TO+ALERT_SMTP_PASS 或 ALERT_WEBHOOK_URL），跳过通知");
  process.exit(0);
}

let hadError = false;
for (const ch of channels) {
  try {
    console.log(await ch.run());
  } catch (e) {
    hadError = true;
    console.error("[alert] " + ch.name + " 发送失败（不阻塞 workflow）：" + String((e && e.message) || e).slice(0, 200));
  }
}
process.exit(0);
