/*
 * 队标 OSS 镜像（hb-sdk 0.9.6 CSP 硬化的前置条件，2026-11-07）
 *
 * 背景：0.9.6 起新构建的正式产物 CSP img-src 仅允许「network 权限生效清单域名 + 平台基础
 * 资源」（实测白名单 = self/data:/blob:/hbmini-media:/hbmedia:/imgheybox.max-c.com）。
 * 队标来自 cdn-api.pandascore.co——境外域名无 ICP，network 权限申请过不了 ICP 校验，
 * 升级后发布的版本队标会全部 onerror 回退首字母。唯一解：把队标镜像到自有 OSS 桶
 * （network 权限已批准的域名，会进入 deploy 构建的图片生效清单），客户端 LOGO_BASE 切过去。
 *
 * 做法：从 data/matches.json 推导 队名→logo 路径映射（与 build-runtime-data 的
 * collectTeamLogos 同逻辑，直接复用），把每个 logo 下载后上传到 OSS 键 logos/<路径>。
 * 存量探测用匿名 HEAD（桶公共读），只上传缺失的键——幂等增量，CI 每轮只处理新队。
 * 遗留绝对 URL（前缀剥离修复前的存量，同域名同路径结构）剥出后缀后同样入镜像。
 *
 * 用法：
 *   node tools/mirror-team-logos.mjs [--limit N] [--dry-run] [--concurrency N]
 * 环境变量（读 .env 或进程环境）：
 *   OSS_BUCKET / OSS_REGION / OSS_ENDPOINT / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
 *   OSS_PREFIX（可选，对象前缀；与 publish-runtime-oss.mjs 同约定，自动补 /）
 * 退出码：配置错误非 0；单队下载/上传失败只计数不中断（下一轮自愈），整体退出 0。
 */
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { collectTeamLogos } from "./lib.mjs";

/* ---------- 参数与凭据 ---------- */

var flags = new Set(process.argv.slice(2));
function flagValue(name) {
  var i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
var LIMIT = parseInt(flagValue("--limit") || "0", 10) || 0;
var DRY_RUN = flags.has("--dry-run");
var CONCURRENCY = Math.min(Math.max(parseInt(flagValue("--concurrency") || "5", 10) || 5, 1), 20);
var HEAD_CONCURRENCY = 10;

function loadDotEnv() {
  try {
    var file = new URL("../.env", import.meta.url);
    readFileSync(file, "utf8").split(/\r?\n/).forEach(function (line) {
      var m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    });
  } catch (e) { /* 无 .env 时用进程环境 */ }
}
loadDotEnv();

var BUCKET = (process.env.OSS_BUCKET || "").trim();
var REGION = (process.env.OSS_REGION || "").trim();
var KEY_ID = (process.env.OSS_ACCESS_KEY_ID || "").trim();
var KEY_SECRET = (process.env.OSS_ACCESS_KEY_SECRET || "").trim();
var PREFIX = (process.env.OSS_PREFIX || "").trim().replace(/\/+$/, "");

function log(message) { console.log("[mirror] " + message); }
function fail(message) { console.error("[mirror] " + message); process.exit(1); }

/* ---------- 端点与安全（同 publish-runtime-oss.mjs：拒绝私网、固定域名白名单） ---------- */

function isPrivateIp(ip) {
  return /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|localhost)/i.test(ip);
}
function assertPublicHost(host) {
  if (!host || isPrivateIp(host)) fail("拒绝非公网主机：" + host);
}

if (!BUCKET) fail("缺少 OSS_BUCKET");
if (!REGION && !process.env.OSS_ENDPOINT) fail("缺少 OSS_REGION（或改用 OSS_ENDPOINT）");
var endpoint;
if (process.env.OSS_ENDPOINT) {
  endpoint = new URL(process.env.OSS_ENDPOINT.trim());
  if (endpoint.protocol !== "https:") fail("OSS_ENDPOINT 必须是 https");
  assertPublicHost(endpoint.hostname);
} else {
  var host = BUCKET + ".oss-" + REGION + ".aliyuncs.com";
  assertPublicHost(host);
  endpoint = new URL("https://" + host);
}

var CDN_BASE = "https://cdn-api.pandascore.co/images/team/image/";
var ABS_RE = /^https?:\/\/(?:cdn-api|cdn)\.pandascore\.co\/images\/(?:team|player)\/image\/(.+)$/i;
// 存量实测特殊字符只有 ( ) +（player 图存量 9 条、括号/加号文件名 3 条；无空格与 ?/#）
var SUFFIX_RE = /^[A-Za-z0-9_][A-Za-z0-9_./()+,!~'-]*$/;

/* ---------- logo 值归一化：相对路径原样；遗留绝对 URL（team/player 图）剥出后缀；外域拒绝 ----------
 * 返回 { suffix, source }：suffix = OSS logos/ 下的键后缀（与客户端 logoUrl 的重写规则保持一致），
 * source = 下载地址（相对路径拼 team/image 基址；遗留绝对 URL 按原 URL 下载）。 */

function logoSuffix(value) {
  var v = String(value || "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    var m = ABS_RE.exec(v);
    if (m) return { suffix: m[1], source: v }; // 遗留绝对 URL（含 player 图当队标的存量）
    return null; // 非 PandaScore 域名：不镜像（客户端原样加载，新构建下走首字兜底）
  }
  if (v.indexOf("..") >= 0 || !SUFFIX_RE.test(v)) return null; // 路径穿越/非法字符防御
  return { suffix: v, source: CDN_BASE + v };
}

/* ---------- OSS V1 签名（与 publish-runtime-oss.mjs 同款） ---------- */

function canonicalOssHeaders(headers) {
  return Object.keys(headers)
    .filter(function (name) { return name.toLowerCase().indexOf("x-oss-") === 0; })
    .map(function (name) { return [name.toLowerCase(), String(headers[name]).trim()]; })
    .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; })
    .map(function (pair) { return pair[0] + ":" + pair[1] + "\n"; })
    .join("");
}
function signRequest(method, key, headers, date) {
  var stringToSign = [
    method,
    headers["Content-MD5"] || "",
    headers["Content-Type"] || "",
    date,
    canonicalOssHeaders(headers) + "/" + BUCKET + "/" + (PREFIX ? PREFIX + "/" : "") + key
  ].join("\n");
  var signature = createHmac("sha1", KEY_SECRET).update(stringToSign, "utf8").digest("base64");
  return "OSS " + KEY_ID + ":" + signature;
}
// 请求路径按段 URL 编码（OSS 硬要求：键里的 + 必须写 %2B，否则签名按原始键算、
// 服务端解码后不一致 → SignatureDoesNotMatch；签名串始终用原始键，见 signRequest）
function ossPath(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}
function ossUrl(key) {
  return endpoint.href.replace(/\/+$/, "") + "/" + (PREFIX ? encodeURIComponent(PREFIX) + "/" : "") + ossPath(key);
}

function contentTypeOf(suffix) {
  var ext = (/\.(\w+)$/.exec(suffix) || [])[1] || "";
  var map = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };
  return map[ext.toLowerCase()] || "application/octet-stream";
}

/* ---------- 匿名探测与上传 ---------- */

// 公共读桶：HEAD 匿名可用（实测 200 带 Content-Length）；200/206=已存在，404=缺失，其他=未知
async function probeExists(key) {
  try {
    var res = await fetch(ossUrl(key), { method: "HEAD", signal: AbortSignal.timeout(10000) });
    if (res.status === 200 || res.status === 206) return "exists";
    if (res.status === 404) return "missing";
    return "unknown";
  } catch (e) {
    return "unknown";
  }
}

// 轻量校验：内容像图片（魔数）才上传，防止把 CDN 错误页/404 HTML 存成队标
function looksLikeImage(buf) {
  if (buf.length < 24) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.slice(0, 4).toString("ascii") === "GIF8") return true; // GIF
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return true; // WebP
  if (buf[0] === 0x3c || buf.slice(0, 5).toString("utf8").trim().charAt(0) === "<") return true; // SVG/XML
  return false;
}

async function downloadLogo(url) {
  var res = await fetch(url, {
    headers: { "User-Agent": "esports-sandbox-logo-mirror/1.0" },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    var info = "";
    try {
      var h = [];
      res.headers.forEach(function (v, k) { if (/server|cf-|x-|via|cache/i.test(k)) h.push(k + "=" + v); });
      info = " url=" + url + " headers[" + h.join(",") + "]";
    } catch (e) { /* 忽略 */ }
    throw new Error("HTTP " + res.status + info);
  }
  var type = (res.headers.get("content-type") || "").toLowerCase();
  if (type.indexOf("text/html") === 0) throw new Error("返回 HTML（疑似错误页）");
  var buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.length > 5 * 1024 * 1024) throw new Error("体积异常 " + buf.length + "B");
  if (!looksLikeImage(buf)) throw new Error("内容不像图片");
  return buf;
}

async function uploadLogo(key, buf, contentType) {
  if (DRY_RUN) { log("DRY PUT " + key + " (" + buf.length + "B)"); return; }
  if (!KEY_ID || !KEY_SECRET) fail("缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET");
  var headers = {
    "Content-Type": contentType,
    "Content-MD5": createHash("md5").update(buf).digest("base64"),
    "Content-Length": String(buf.length)
  };
  var date = new Date().toUTCString();
  headers.Date = date;
  headers.Authorization = signRequest("PUT", key, headers, date);
  var res = await fetch(ossUrl(key), { method: "PUT", headers: headers, body: buf });
  if (!res.ok) {
    var text = await res.text().catch(function () { return ""; });
    throw new Error("HTTP " + res.status + " " + text.replace(/\s+/g, " ").slice(0, 200));
  }
}

/* ---------- 并发执行器 ---------- */

async function runPool(items, concurrency, worker) {
  var index = 0, results = [];
  async function lane() {
    while (index < items.length) {
      var i = index++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

/* ---------- 主流程 ---------- */

var raw = JSON.parse(readFileSync(new URL("../data/matches.json", import.meta.url), "utf8"));
var teams = collectTeamLogos(raw.matches || []);
var names = Object.keys(teams).filter(function (n) { return teams[n]; });

var skipped = []; // 外域/非法路径（不镜像，客户端按原样或首字兜底）
var sourceOf = {}; // suffix -> 下载地址
names.forEach(function (n) {
  var r = logoSuffix(teams[n]);
  if (r) sourceOf[r.suffix] = r.source; else skipped.push(n + " -> " + String(teams[n]).slice(0, 80));
});
var suffixes = Object.keys(sourceOf);

log("队伍 " + names.length + " 支 · 去重后 logo " + suffixes.length + " 个 · 跳过（外域/非法）" + skipped.length + " 个");
if (skipped.length) log("跳过清单（前 5）：" + skipped.slice(0, 5).join(" | "));

// 第一波：匿名 HEAD 并发探测
log("探测 OSS 存量（并发 " + HEAD_CONCURRENCY + "）…");
var probes = await runPool(suffixes, HEAD_CONCURRENCY, function (suffix) {
  return probeExists((PREFIX ? PREFIX + "/" : "") + "logos/" + suffix).then(function (state) {
    return { suffix: suffix, state: state };
  });
});
var existed = 0, unknown = [], missing = [];
probes.forEach(function (p) {
  if (p.state === "exists") existed++;
  else if (p.state === "unknown") unknown.push(p.suffix);
  else missing.push(p.suffix);
});
log("已存在 " + existed + " · 缺失 " + missing.length + " · 探测未知 " + unknown.length + "（下轮重试）");
if (LIMIT > 0 && missing.length > LIMIT) {
  log("--limit " + LIMIT + "：本轮只处理前 " + LIMIT + " 个缺失");
  missing = missing.slice(0, LIMIT);
}
if (!missing.length) { log("无需上传，完成"); process.exit(0); }

// 第二波：下载 → 上传（单队失败跳过，下轮自愈）
var uploaded = 0, failed = [];
await runPool(missing, CONCURRENCY, function (suffix) {
  var key = "logos/" + suffix;
  return (async function () {
    var buf;
    try {
      buf = await downloadLogo(sourceOf[suffix]);
    } catch (e) {
      throw new Error("下载失败: " + String(e && e.message).slice(0, 120));
    }
    try {
      await uploadLogo(key, buf, contentTypeOf(suffix));
    } catch (e) {
      throw new Error("上传失败: " + String(e && e.message).slice(0, 120));
    }
    uploaded++;
  })().catch(function (e) {
    failed.push(suffix + "（" + String(e && e.message).slice(0, 140) + "）");
  });
});

log("完成：上传 " + uploaded + " / " + missing.length + "，失败 " + failed.length);
if (failed.length) log("失败清单（前 10）：" + failed.slice(0, 10).join(" | "));
process.exit(0);
