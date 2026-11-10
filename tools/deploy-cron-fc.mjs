/*
 * 部署采集兜底定时器到阿里云 FC 3.0（杭州）：
 *   node tools/deploy-cron-fc.mjs           # 创建/更新 service+function+timer trigger
 *   node tools/deploy-cron-fc.mjs --test    # 只手动 invoke 一次并打印结果（验证 dispatch）
 * 凭据：.env 的 OSS_ACCESS_KEY_*（RAM 子账号需有 FC 写权限）+ GITHUB_DISPATCH_TOKEN
 *   （fine-grained PAT：仅 Actions: write，只授权 zhuran305-web/esports-sandbox）
 *   PAT 只进 FC 环境变量；zip 临时文件用后即删。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import FC from "@alicloud/fc-open20210406";
import OpenApi from "@alicloud/openapi-client";

const SERVICE = "esports-sandbox-cron";
const FUNCTION = "dispatch";
const TRIGGER = "every30";
const TRIGGER_LIVE = "every10"; // live.json 高频刷新（2026-11-11）：每 10 分钟 dispatch refresh-live.yml
const REGION = "cn-hangzhou";
const CRON_EXPRESSION = "0 5 * * * *"; // FC 6 段 cron：每小时第 5 分钟（秒 分 时 日 月 周）——错开 GitHub 整点轮，月增 ~3.6 元
const CRON_LIVE_EXPRESSION = "0 */10 * * * *"; // 每 10 分钟整——live 比分高频链路（refresh-live.yml）

const env = {};
fs.readFileSync(".env", "utf8").split(/\r?\n/).forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
});
for (const k of ["OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"]) {
  if (!env[k]) {
    console.error(`[fc-cron] .env 缺少 ${k}`);
    process.exit(1);
  }
}

const client = new FC.default(
  new OpenApi.Config({
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    endpoint: `fc.${REGION}.aliyuncs.com`,
    // 默认 3s 读超时：函数冷启动 + OSS meta + GitHub dispatch 可能超过，调大到 25s
    readTimeout: 25000,
    connectTimeout: 10000,
  })
);

function makeZip() {
  const tmp = path.join(os.tmpdir(), `fc-cron-${Date.now()}.zip`);
  const src = path.resolve("fc-cron", "index.js");
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${src.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force"`, { stdio: "pipe" });
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf.toString("base64");
}

async function testInvoke() {
  // payload 即 handler 收到的 event——--trigger=every10 验证 live 分支（缺省=hourly 主流程）
  const payloadArg = process.argv.find((a) => a.startsWith("--trigger="));
  const payload = payloadArg ? { triggerName: payloadArg.split("=")[1] } : {};
  console.log("[fc-cron] invoke payload:", JSON.stringify(payload));
  const res = await client.invokeFunction(SERVICE, FUNCTION, JSON.stringify(payload));
  console.log("[fc-cron] invoke 结果：", JSON.stringify(res.body).slice(0, 500));
}

async function main() {
  if (process.argv.includes("--test")) {
    await testInvoke();
    return;
  }

  if (!env.GITHUB_DISPATCH_TOKEN) {
    console.error("[fc-cron] .env 缺少 GITHUB_DISPATCH_TOKEN（fine-grained PAT，仅 Actions: write）");
    process.exit(1);
  }

  // service（幂等）
  try {
    await client.createService({ serviceName: SERVICE, description: "赛事沙盘·采集兜底定时器" });
    console.log(`[fc-cron] service 已创建：${SERVICE}`);
  } catch (e) {
    if (!/AlreadyExist/i.test(String(e.code))) throw e;
    console.log(`[fc-cron] service 已存在：${SERVICE}`);
  }

  // function（幂等：存在则更新代码与环境变量）
  const fnReq = {
    functionName: FUNCTION,
    runtime: "nodejs16",
    handler: "index.handler",
    memorySize: 128,
    timeout: 20,
    code: { zipFile: makeZip() },
    environmentVariables: {
      GITHUB_DISPATCH_TOKEN: env.GITHUB_DISPATCH_TOKEN,
      STALE_MINUTES: env.STALE_MINUTES || "35",
      // 告警 webhook（2026-11-08 防复发）：可选项，.env 配置后 FC 兜底具备 dispatch 失败/持续陈旧告警
      ALERT_WEBHOOK_URL: env.ALERT_WEBHOOK_URL || "",
      ALERT_STALE_MINUTES: env.ALERT_STALE_MINUTES || "100",
      // 邮件告警（11-09 加，QQ 邮箱直发）：可选项，与 webhook 通道并存
      ALERT_EMAIL_TO: env.ALERT_EMAIL_TO || "",
      ALERT_SMTP_PASS: env.ALERT_SMTP_PASS || "",
      ALERT_SMTP_HOST: env.ALERT_SMTP_HOST || "smtp.qq.com",
      ALERT_SMTP_PORT: env.ALERT_SMTP_PORT || "465",
    },
    description: "每 30 分钟检查 OSS 数据陈旧度，陈旧则 workflow_dispatch 触发采集（目标硬编码）",
  };
  try {
    await client.createFunction(SERVICE, fnReq);
    console.log(`[fc-cron] function 已创建：${FUNCTION}（nodejs16 / 128MB）`);
  } catch (e) {
    if (!/AlreadyExist/i.test(String(e.code))) {
      if (fnReq.runtime === "nodejs16" && String(e.message).includes("runtime")) {
        fnReq.runtime = "nodejs18";
        await client.createFunction(SERVICE, fnReq);
        console.log(`[fc-cron] function 已创建：${FUNCTION}（nodejs18）`);
      } else throw e;
    } else {
      delete fnReq.functionName;
      await client.updateFunction(SERVICE, FUNCTION, fnReq);
      console.log(`[fc-cron] function 已更新：${FUNCTION}`);
    }
  }

  // timer trigger（幂等）。注意：raw API 的 triggerConfig 是 JSON 字符串而非对象
  const triggerConfigJson = JSON.stringify({
    cronExpression: CRON_EXPRESSION,
    enable: true,
    payload: "",
  });
  try {
    await client.createTrigger(SERVICE, FUNCTION, {
      triggerName: TRIGGER,
      triggerType: "timer",
      triggerConfig: triggerConfigJson,
    });
    console.log(`[fc-cron] timer trigger 已创建：${TRIGGER}（${CRON_EXPRESSION}）`);
  } catch (e) {
    if (!/AlreadyExist/i.test(String(e.code))) throw e;
    await client.updateTrigger(SERVICE, FUNCTION, TRIGGER, {
      triggerConfig: triggerConfigJson,
    });
    console.log(`[fc-cron] timer trigger 已存在并更新：${TRIGGER}`);
  }

  // 第二触发器（2026-11-11 live.json 高频链路）：每 10 分钟 dispatch refresh-live.yml。
  // handler 按 event.triggerName 分支（every10 → 直接 dispatch refresh-live，跳过 meta 陈旧检查）
  const liveTriggerConfigJson = JSON.stringify({
    cronExpression: CRON_LIVE_EXPRESSION,
    enable: true,
    payload: "",
  });
  try {
    await client.createTrigger(SERVICE, FUNCTION, {
      triggerName: TRIGGER_LIVE,
      triggerType: "timer",
      triggerConfig: liveTriggerConfigJson,
    });
    console.log(`[fc-cron] timer trigger 已创建：${TRIGGER_LIVE}（${CRON_LIVE_EXPRESSION}）`);
  } catch (e) {
    if (!/AlreadyExist/i.test(String(e.code))) throw e;
    await client.updateTrigger(SERVICE, FUNCTION, TRIGGER_LIVE, {
      triggerConfig: liveTriggerConfigJson,
    });
    console.log(`[fc-cron] timer trigger 已存在并更新：${TRIGGER_LIVE}`);
  }

  console.log("[fc-cron] 部署完成 · 每小时第 5 分钟采集兜底（陈旧 >35 分钟才触发）+ 每 10 分钟 live 刷新（refresh-live.yml）");
  console.log("[fc-cron] 立即验证：node tools/deploy-cron-fc.mjs --test [--trigger=every10]");
}

main().catch((e) => {
  console.error("[fc-cron] 部署失败：", e.code || "", e.message?.slice(0, 300));
  process.exit(1);
});
