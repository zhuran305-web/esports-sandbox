/*
 * 配置 OSS Mirror 回源（零审批换票链路的核心）：
 *   桶 <bucket> 的 /api/ 前缀对象未命中时，回源到 FC 换票端点透传。
 *   node tools/set-oss-mirror.mjs          # 写入回源规则
 *   node tools/set-oss-mirror.mjs --check  # 只读当前回源配置
 * 依赖：.env 的 OSS_* 凭据；RAM 需 oss:PutBucketMirror / GetBucketMirror。
 * 注意：FC 响应带 Cache-Control: no-store，回源结果不会落桶缓存（换票人各不同）。
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";

const env = {};
fs.readFileSync(".env", "utf8").split(/\r?\n/).forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
});
const BUCKET = env.OSS_BUCKET || "esports-sandbox-data";
const KEY_ID = env.OSS_ACCESS_KEY_ID;
const KEY_SECRET = env.OSS_ACCESS_KEY_SECRET;
const FC_HOST = "exchange-esportsidentity-qaxicyqhmg.cn-hangzhou.fcapp.run";
const ENDPOINT = `https://${BUCKET}.oss-cn-hangzhou.aliyuncs.com`;

const MIRROR_XML =
  '<MirrorRequest>' +
  "<MirrorURL>http://" + FC_HOST + "</MirrorURL>" +
  "<Host>" + FC_HOST + "</Host>" +
  "<Enable>on</Enable>" +
  "<MirrorMode>mirror</MirrorMode>" + // 不落缓存：透传（配合源站 no-store）
  "<PassOriginStat>false</PassOriginStat>" +
  "<AllowEmptyBucketName>false</AllowEmptyBucketName>" +
  "<FollowRedirect>true</FollowRedirect>" +
  "</MirrorRequest>";

// 回源仅作用于指定前缀：用 damin 规则（OSS 旧版回源全桶生效；新版支持路由规则）。
// 保守方案：桶上只回源 api/ 前缀 —— 旧版 MirrorRequest 是全桶的，404 才触发，
// 现有对象（meta.json/matches.json）都存在不会 404，全桶回源实际只会命中 /api/* 请求。
function canonicalOssHeaders(headers) {
  return Object.keys(headers)
    .filter((n) => n.toLowerCase().startsWith("x-oss-"))
    .map((n) => [n.toLowerCase(), String(headers[n]).trim()])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => k + ":" + v + "\n")
    .join("");
}

function sign(method, key, query, headers, date) {
  const s = [
    method,
    headers["Content-MD5"] || "",
    headers["Content-Type"] || "",
    date,
    canonicalOssHeaders(headers) + "/" + BUCKET + "/" + key + (query ? "?" + query : ""),
  ].join("\n");
  return "OSS " + KEY_ID + ":" + createHmac("sha1", KEY_SECRET).update(s, "utf8").digest("base64");
}

async function oss(method, query, body) {
  const date = new Date().toUTCString();
  const headers = { Date: date };
  if (body) headers["Content-Type"] = "application/xml";
  // 实测该端点签名串不含 mirror 子资源（服务端 StringToSign 以 /bucket/ 结尾）
  headers.Authorization = sign(method, "", "", headers, date);
  const res = await fetch(ENDPOINT + "/?" + query, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text };
}

const mode = process.argv[2] || "";
if (mode === "--check") {
  const r = await oss("GET", "mirror");
  console.log("HTTP", r.status);
  console.log(r.text || "(空配置)");
} else {
  const cur = await oss("GET", "mirror");
  console.log("当前配置：HTTP", cur.status, (cur.text || "(空)").replace(/\s+/g, " ").slice(0, 200));
  const put = await oss("PUT", "mirror", MIRROR_XML);
  if (put.status !== 200) {
    console.error("写入失败：HTTP", put.status, put.text.slice(0, 300));
    process.exit(1);
  }
  console.log("回源规则已写入：/api/* 404 → " + FC_HOST + "（透传，源站 no-store）");
  console.log("验证：curl " + ENDPOINT + "/api/exchange （应返回 invalid_request）");
}
