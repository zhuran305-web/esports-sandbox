#!/usr/bin/env node
/*
 * 把 runtime/meta.json + runtime/matches.json 发布到阿里云 OSS。
 * 零第三方依赖：自己实现 OSS V1 签名（HMAC-SHA1）。
 *
 * 用法（参数可组合，按 --create-bucket → --set-cors → --upload → --check 顺序执行）：
 *   OSS_BUCKET=esports-sandbox OSS_REGION=cn-hangzhou \
 *   OSS_ACCESS_KEY_ID=xxx OSS_ACCESS_KEY_SECRET=xxx \
 *     node tools/publish-runtime-oss.mjs --create-bucket --set-cors --upload --check
 *
 *   --dry-run   只打印计划与签名，不发请求
 *   --check     匿名校验公读、Content-Type、meta 的 count/hash 与本地一致
 *
 * 可选：OSS_ENDPOINT（显式端点，优先于 OSS_REGION）、OSS_PREFIX（对象前缀，默认空）。
 * 注意：域名要原样填进 network 权限申请，所以默认端点不要带自定义域名。
 */
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var RUNTIME_DIR = path.join(ROOT, "runtime");

// 从项目根 .env 读取凭据（已在 .gitignore），已存在的环境变量优先
function loadDotEnv() {
  var file = path.join(ROOT, ".env");
  if (!existsSync(file)) return;
  readFileSync(file, "utf8").split(/\r?\n/).forEach(function (line) {
    var match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) return;
    var value = match[2].trim();
    if ((value.charAt(0) === "\"" && value.charAt(value.length - 1) === "\"") ||
        (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  });
}

loadDotEnv();

var flags = new Set(process.argv.slice(2));
var DRY_RUN = flags.has("--dry-run");
var DO_CREATE = flags.has("--create-bucket");
var DO_CORS = flags.has("--set-cors");
var DO_UPLOAD = flags.has("--upload");
var DO_CHECK = flags.has("--check");

var BUCKET = (process.env.OSS_BUCKET || "").trim();
var REGION = (process.env.OSS_REGION || "").trim();
var KEY_ID = (process.env.OSS_ACCESS_KEY_ID || "").trim();
var KEY_SECRET = (process.env.OSS_ACCESS_KEY_SECRET || "").trim();
var PREFIX = (process.env.OSS_PREFIX || "").replace(/^\/+|\/+$/g, "");

function fail(message) {
  console.error("[oss] 错误：" + message);
  process.exit(1);
}

function usage() {
  console.log([
    "用法：node tools/publish-runtime-oss.mjs [--create-bucket] [--set-cors] [--upload] [--check] [--dry-run]",
    "必填环境变量：OSS_BUCKET + OSS_REGION（或 OSS_ENDPOINT），以及 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET",
    "可选：OSS_PREFIX（对象前缀）",
    "建议顺序：--create-bucket --set-cors --upload --check"
  ].join("\n"));
}

if (!DO_CREATE && !DO_CORS && !DO_UPLOAD && !DO_CHECK) {
  usage();
  process.exit(0);
}

function log(message) {
  console.log("[oss] " + message);
}

/* ---------- 端点与安全校验 ---------- */

function isPrivateIp(ip) {
  var type = net.isIP(ip);
  if (type === 4) {
    var parts = ip.split(".").map(Number);
    var a = parts[0];
    var b = parts[1];
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  if (type === 6) {
    var v6 = ip.toLowerCase();
    return v6 === "::" || v6 === "::1" ||
      v6.startsWith("fc") || v6.startsWith("fd") ||
      v6.startsWith("fe8") || v6.startsWith("fe9") ||
      v6.startsWith("fea") || v6.startsWith("feb") ||
      v6.startsWith("::ffff:127.") || v6.startsWith("::ffff:10.") ||
      v6.startsWith("::ffff:192.168.");
  }
  return false;
}

function assertPublicHost(host) {
  var h = String(host || "").toLowerCase();
  if (!h) fail("缺少主机名");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
      h.endsWith(".internal") || h.endsWith(".home.arpa")) {
    fail("拒绝本机/内网主机名：" + h);
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) fail("拒绝环回/私有/保留地址：" + h);
    return h;
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) {
    fail("域名格式不合法：" + h);
  }
  return h;
}

function resolveEndpoint() {
  if (process.env.OSS_ENDPOINT) {
    var raw = process.env.OSS_ENDPOINT.trim();
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      fail("OSS_ENDPOINT 不是合法 URL：" + raw);
    }
    if (parsed.protocol !== "https:") fail("OSS_ENDPOINT 必须是 https");
    if (parsed.port && parsed.port !== "443") fail("OSS_ENDPOINT 不允许自定义端口");
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      fail("OSS_ENDPOINT 不能带路径、查询或片段");
    }
    assertPublicHost(parsed.hostname);
    return parsed;
  }
  if (!BUCKET) fail("缺少 OSS_BUCKET");
  if (!REGION) fail("缺少 OSS_REGION（或改用 OSS_ENDPOINT）");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(BUCKET)) {
    fail("OSS_BUCKET 必须是 3–63 位小写字母/数字/连字符");
  }
  if (!/^[a-z0-9-]+$/.test(REGION)) fail("OSS_REGION 格式不合法：" + REGION);
  var host = BUCKET + ".oss-" + REGION + ".aliyuncs.com";
  assertPublicHost(host);
  return new URL("https://" + host);
}

/* ---------- OSS V1 签名 ---------- */

function canonicalOssHeaders(headers) {
  return Object.keys(headers)
    .filter(function (name) { return name.toLowerCase().indexOf("x-oss-") === 0; })
    .map(function (name) { return [name.toLowerCase(), String(headers[name]).trim()]; })
    .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; })
    .map(function (pair) { return pair[0] + ":" + pair[1] + "\n"; })
    .join("");
}

function signRequest(method, key, query, headers, date) {
  var stringToSign = [
    method,
    headers["Content-MD5"] || "",
    headers["Content-Type"] || "",
    date,
    canonicalOssHeaders(headers) + "/" + BUCKET + "/" + key + (query ? "?" + query : "")
  ].join("\n");
  var signature = createHmac("sha1", KEY_SECRET).update(stringToSign, "utf8").digest("base64");
  return "OSS " + KEY_ID + ":" + signature;
}

function objectUrl(key, query) {
  var url = new URL(endpoint.href);
  url.pathname = "/" + key;
  url.search = query ? "?" + query : "";
  return url;
}

async function ossRequest(method, key, options) {
  var opts = options || {};
  var query = opts.query || "";
  var headers = Object.assign({}, opts.headers || {});
  var date = new Date().toUTCString();
  headers.Date = date;

  if (DRY_RUN) {
    log("DRY " + method + " " + objectUrl(key, query).href);
    log("DRY 签名串末段：" + (canonicalOssHeaders(headers) + "/" + BUCKET + "/" + key + (query ? "?" + query : "")).replace(/\n/g, "\\n"));
    return { ok: true, status: 0, text: "" };
  }

  if (!KEY_ID || !KEY_SECRET) fail("缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET");
  headers.Authorization = signRequest(method, key, query, headers, date);

  var res = await fetch(objectUrl(key, query), {
    method: method,
    headers: headers,
    body: opts.body,
    redirect: "manual"
  });
  var text = await res.text();
  if (!res.ok) {
    var detail = text ? text.replace(/\s+/g, " ").slice(0, 500) : "";
    throw new Error(method + " " + key + " 失败：HTTP " + res.status + " " + detail);
  }
  return { ok: true, status: res.status, text: text };
}

/* ---------- 动作 ---------- */

var endpoint = resolveEndpoint();
var publicBase = endpoint.href.replace(/\/+$/, "") + "/" + (PREFIX ? PREFIX + "/" : "");

async function readRuntime() {
  var meta = JSON.parse(await readFile(path.join(RUNTIME_DIR, "meta.json"), "utf8"));
  var matchesRaw = await readFile(path.join(RUNTIME_DIR, "matches.json"), "utf8");
  var matches = JSON.parse(matchesRaw);
  if (!meta || typeof meta.hash !== "string" || !Array.isArray(matches.matches)) {
    fail("runtime/ 数据不完整，先运行 npm run runtime:build");
  }
  if (meta.count !== matches.matches.length) {
    fail("meta.count (" + meta.count + ") 与 matches 数量 (" + matches.matches.length + ") 不一致");
  }
  return { meta: meta, metaBody: JSON.stringify(meta, null, 2) + "\n", matchesBody: matchesRaw };
}

function md5Base64(text) {
  return createHash("md5").update(text, "utf8").digest("base64");
}

async function createBucket() {
  log("创建 bucket（公共读）：" + endpoint.hostname);
  try {
    await ossRequest("PUT", "", {
      headers: {
        "x-oss-acl": "public-read",
        "Content-Type": "application/xml"
      },
      body: ""
    });
  } catch (error) {
    // 已存在的 bucket 返回 409 BucketAlreadyExists；是自己的就直接继续
    if (String(error && error.message).indexOf("HTTP 409") === -1) throw error;
    log("bucket 已存在，跳过创建（后续上传会验证归属）");
    return;
  }
  log("bucket 已就绪");
}

async function setCors() {
  var xml = [
    "<CORSConfiguration>",
    "  <CORSRule>",
    "    <AllowedOrigin>*</AllowedOrigin>",
    "    <AllowedMethod>GET</AllowedMethod>",
    "    <AllowedMethod>HEAD</AllowedMethod>",
    "    <AllowedHeader>*</AllowedHeader>",
    "    <MaxAgeSeconds>600</MaxAgeSeconds>",
    "  </CORSRule>",
    "</CORSConfiguration>"
  ].join("\n");
  log("设置 CORS：GET/HEAD，Origin *");
  await ossRequest("PUT", "", {
    query: "cors",
    headers: { "Content-Type": "application/xml" },
    body: xml
  });
}

async function upload(runtime) {
  var files = [
    { name: "meta.json", body: runtime.metaBody },
    { name: "matches.json", body: runtime.matchesBody }
  ];
  for (var i = 0; i < files.length; i += 1) {
    var file = files[i];
    var key = (PREFIX ? PREFIX + "/" : "") + file.name;
    log("上传 " + key + "（" + (file.body.length / 1048576).toFixed(2) + " MiB）");
    await ossRequest("PUT", key, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-MD5": md5Base64(file.body),
        "Cache-Control": "public, max-age=60",
        "x-oss-object-acl": "public-read"
      },
      body: file.body
    });
  }
  log("上传完成，公共地址：" + publicBase);
}

async function check(runtime) {
  if (DRY_RUN) {
    log("DRY 校验 " + publicBase + "meta.json");
    return;
  }
  var res = await fetch(publicBase + "meta.json?probe=" + Date.now(), {
    headers: { "cache-control": "no-cache" }
  });
  if (!res.ok) fail("匿名读取 meta.json 失败：HTTP " + res.status + "（bucket 是否公共读？）");
  var type = res.headers.get("content-type") || "";
  var remote = await res.json();
  if (remote.hash !== runtime.meta.hash) fail("远端 hash 与本地不一致，可能缓存或上传未生效");
  if (remote.count !== runtime.meta.count) fail("远端 count 与本地不一致");
  log("匿名读取 OK · " + remote.count + " 场 · hash " + String(remote.hash).slice(0, 12) + " · content-type " + type);

  // HEAD 在 Node fetch 里拿不到 content-length，改用 1 字节 Range 读总大小
  var matchesProbe = await fetch(publicBase + "matches.json?probe=" + Date.now(), {
    headers: { Range: "bytes=0-0" }
  });
  if (!matchesProbe.ok) fail("匿名读取 matches.json 失败：HTTP " + matchesProbe.status);
  var contentRange = matchesProbe.headers.get("content-range") || "";
  var rangeMatch = /bytes\s+\d+-\d+\/(\d+)/.exec(contentRange);
  var totalBytes = rangeMatch
    ? Number(rangeMatch[1])
    : Number(matchesProbe.headers.get("content-length") || 0);
  if (totalBytes) {
    log("matches.json OK · " + (totalBytes / 1048576).toFixed(2) + " MiB");
  } else {
    log("matches.json OK · 未读到对象大小（服务端未返回 Content-Range/Length）");
  }

  var preflight = await fetch(publicBase + "meta.json", {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1:5177",
      "Access-Control-Request-Method": "GET"
    }
  });
  var allowOrigin = preflight.headers.get("access-control-allow-origin");
  log("CORS 预检：HTTP " + preflight.status + " · allow-origin=" + (allowOrigin || "(无)"));
  if (!allowOrigin) log("提示：浏览器调试台可能读不到，生产走 SDK network 不受影响");
}

async function main() {
  var runtime = null;
  if (DO_UPLOAD || DO_CHECK) runtime = await readRuntime();

  log("端点：" + endpoint.href + " · 公共基址：" + publicBase);
  if (DO_CREATE) await createBucket();
  if (DO_CORS) await setCors();
  if (DO_UPLOAD) await upload(runtime);
  if (DO_CHECK) await check(runtime);

  console.log("");
  console.log("下一步：把下面这行填进 network 权限申请（只填主机名，不带 https://）");
  console.log("  " + endpoint.hostname);
  console.log("批准后构建：");
  console.log("  VITE_RUNTIME_DATA_BASE=" + publicBase + " npm run build");
}

main().catch(function (error) {
  fail(error && error.message ? error.message : String(error));
});
