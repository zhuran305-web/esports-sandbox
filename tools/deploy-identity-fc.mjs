/*
 * 部署换票函数到阿里云 FC 3.0（杭州）：
 *   node tools/deploy-identity-fc.mjs           # 创建/更新 service+function+trigger
 *   node tools/deploy-identity-fc.mjs --url     # 只打印触发器公网地址
 * 凭据：.env 的 OSS_ACCESS_KEY_*（RAM 子账号需有 FC 写权限）+ USER_MINIPROGRAM_*（函数环境变量）
 * 凭据只进 FC 环境变量；zip 临时文件用后即删。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import FC from "@alicloud/fc-open20210406";
import OpenApi from "@alicloud/openapi-client";

const SERVICE = "esports-sandbox-identity";
const FUNCTION = "exchange";
const TRIGGER = "http";
const REGION = "cn-hangzhou";

const env = {};
fs.readFileSync(".env", "utf8").split(/\r?\n/).forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
});
for (const k of ["OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET", "USER_MINIPROGRAM_ID", "USER_MINIPROGRAM_SECRET"]) {
  if (!env[k]) {
    console.error(`[fc] .env 缺少 ${k}`);
    process.exit(1);
  }
}

const client = new FC.default(
  new OpenApi.Config({
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    endpoint: `fc.${REGION}.aliyuncs.com`,
  })
);

function makeZip() {
  const tmp = path.join(os.tmpdir(), `fc-identity-${Date.now()}.zip`);
  const src = path.resolve("fc-identity", "index.js");
  // Windows 下用 PowerShell 打 zip（单文件，避免引入 archiver 依赖）
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${src.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force"`, { stdio: "pipe" });
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf.toString("base64");
}

async function main() {
  if (process.argv.includes("--url")) {
    const t = await client.getTrigger(SERVICE, FUNCTION, TRIGGER);
    console.log(t.body.urlInternet || "(无公网地址)");
    return;
  }

  // service（幂等：已存在则忽略）
  try {
    await client.createService({ serviceName: SERVICE, description: "赛事沙盘·身份换票" });
    console.log(`[fc] service 已创建：${SERVICE}`);
  } catch (e) {
    if (!/AlreadyExist/i.test(String(e.code))) throw e;
    console.log(`[fc] service 已存在：${SERVICE}`);
  }

  // function（幂等：存在则更新代码与环境变量）
  const fnReq = {
    functionName: FUNCTION,
    runtime: "nodejs16",
    handler: "index.handler",
    memorySize: 128,
    timeout: 15,
    code: { zipFile: makeZip() },
    environmentVariables: {
      USER_MINIPROGRAM_ID: env.USER_MINIPROGRAM_ID,
      USER_MINIPROGRAM_SECRET: env.USER_MINIPROGRAM_SECRET,
    },
    description: "auth.login code -> OpenAPI 换票（无状态）",
  };
  try {
    await client.createFunction(SERVICE, fnReq);
    console.log(`[fc] function 已创建：${FUNCTION}（nodejs16 / 128MB）`);
  } catch (e) {
    if (!/AlreadyExist/i.test(String(e.code))) {
      // 运行时名不被接受时降级尝试 nodejs18
      if (fnReq.runtime === "nodejs16" && String(e.message).includes("runtime")) {
        fnReq.runtime = "nodejs18";
        await client.createFunction(SERVICE, fnReq);
        console.log(`[fc] function 已创建：${FUNCTION}（nodejs18）`);
      } else throw e;
    } else {
      delete fnReq.functionName;
      await client.updateFunction(SERVICE, FUNCTION, fnReq);
      console.log(`[fc] function 已更新：${FUNCTION}`);
    }
  }

  // http trigger（幂等）。注意：raw API 的 triggerConfig 是 JSON 字符串而非对象
  const triggerConfigJson = JSON.stringify({
    authType: "anonymous",
    methods: ["GET", "POST"],
    disableURLInternet: false,
  });
  try {
    await client.createTrigger(SERVICE, FUNCTION, {
      triggerName: TRIGGER,
      triggerType: "http",
      triggerConfig: triggerConfigJson,
    });
  } catch (e) {
    if (!/AlreadyExist/i.test(String(e.code))) throw e;
    console.log(`[fc] trigger 已存在：${TRIGGER}`);
  }
  const t = await client.getTrigger(SERVICE, FUNCTION, TRIGGER);
  const url = t.body.urlInternet;
  console.log(`[fc] 部署完成 · 公网地址：${url}`);
  console.log("[fc] 验证：curl " + url + " （应返回 invalid_request）");
  console.log("[fc] 下一步：把主机名 " + (url ? new URL(url).hostname : "?") + " 加入 network 权限申请");
}

main().catch((e) => {
  console.error("[fc] 部署失败：", e.code || "", e.message?.slice(0, 300));
  process.exit(1);
});
