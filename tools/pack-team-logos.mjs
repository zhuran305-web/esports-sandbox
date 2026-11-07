/*
 * 队标打包工具（2026-11-07，1.3.11 线上事故修复）
 *
 * 事故：0.9.6 deploy 构建的 CSP img-src 仅含平台基础域——服务端下发的 network_policy
 * entries 为空（未包含我们 network 权限批准的 OSS 域），LOGO_BASE 切 OSS 后全部队标
 * 被拦回退首字母简称。
 *
 * 修复：把 OSS 上的队标原图压成 96px WebP、**打包进产物**（public/logos/，vite 构建时
 * 原样拷进 dist）——同源资源走 img-src 'self' 天然放行，不依赖任何远程图片域名；
 * 顺带消除运行时远程加载（更快、离线可渲染）。文件名沿用原相对路径（客户端
 * LOGO_BASE + teams 映射路径不变），内容为 WebP 字节（浏览器按内容嗅探渲染）。
 *
 * 用法：node tools/pack-team-logos.mjs [--force]
 *   增量：目标文件已存在则跳过（新队自动补）；--force 全量重压（压参变更后用）。
 *   依赖 sharp（已装）+ .env 的 OSS 凭据；由 prebuild 钩子调用。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

function log(message) { console.log("[logo-pack] " + message); }
function fail(message) { console.error("[logo-pack] " + message); process.exit(1); }

/* ---------- .env 与 OSS 端点 ---------- */
try {
  readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/).forEach(function (line) {
    var m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch (e) { /* 无 .env 用进程环境 */ }

var BUCKET = (process.env.OSS_BUCKET || "").trim();
var REGION = (process.env.OSS_REGION || "").trim();
var KEY_ID = (process.env.OSS_ACCESS_KEY_ID || "").trim();
var KEY_SECRET = (process.env.OSS_ACCESS_KEY_SECRET || "").trim();
if (!BUCKET || !KEY_ID || !KEY_SECRET) fail("缺少 OSS 凭据（.env）");
var HOST = BUCKET + ".oss-" + REGION + ".aliyuncs.com";
var FORCE = process.argv.includes("--force");

function sign(method, key) {
  var date = new Date().toUTCString();
  var sts = [method, "", "", date, "/" + BUCKET + "/" + key].join("\n");
  return { Date: date, Authorization: "OSS " + KEY_ID + ":" + createHmac("sha1", KEY_SECRET).update(sts, "utf8").digest("base64") };
}

/* ---------- 1. 列出 OSS logos/ 前缀全部对象 ---------- */
async function listLogos() {
  var out = [];
  var marker = "";
  while (true) {
    // 普通 query 参数不进签名串（陷阱条目教训）；list 以 marker 翻页
    var url = "https://" + HOST + "/?prefix=" + encodeURIComponent("logos/") + (marker ? "&marker=" + encodeURIComponent(marker) : "");
    var res = await fetch(url, { headers: sign("GET", ""), signal: AbortSignal.timeout(20000) });
    if (!res.ok) fail("列举 OSS 失败 HTTP " + res.status);
    var xml = await res.text();
    var keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(function (m) { return m[1]; });
    out.push(...keys);
    var truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!truncated) break;
    marker = keys[keys.length - 1];
    if (!marker) break;
  }
  return out;
}

/* ---------- 2. 增量打包：扁平散列文件名（djb2 8hex，与 js/app.js logoPackName 同算法——
 * deploy 产物相对路径上限 39 字节，原 OSS 文件名超限 50 字节被预检拒）---------- */

// 注意：import.meta.url 在中文路径下是百分号编码的——必须用 fileURLToPath 解码
// （手写 pathname.replace 会把文件写进编码名的错误目录，2026-11-07 实测）
var OUT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "logos");

function packName(suffix) {
  var h = 5381;
  for (var i = 0; i < suffix.length; i++) { h = ((h << 5) + h + suffix.charCodeAt(i)) >>> 0; }
  return h.toString(16).padStart(8, "0") + ".webp";
}

async function packOne(key) {
  var suffix = key.replace(/^logos\//, "");
  var target = path.join(OUT_ROOT, packName(suffix));
  if (!FORCE && existsSync(target)) return "skip";
  var res = await fetch("https://" + HOST + "/" + key.split("/").map(encodeURIComponent).join("/"), { headers: sign("GET", key), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  var buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error("体积异常 " + buf.length + "B");
  var webp = await sharp(buf).resize(96, 96, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  writeFileSync(target, webp);
  return "packed";
}

var keys = await listLogos();
log("OSS logos/ 对象 " + keys.length + " 个");
mkdirSync(OUT_ROOT, { recursive: true });
var packed = 0, skipped = 0, failed = [];
var CONC = 8, index = 0;
async function lane() {
  while (index < keys.length) {
    var key = keys[index++];
    try {
      var r = await packOne(key);
      if (r === "packed") packed++; else skipped++;
    } catch (e) {
      failed.push(key + "（" + String(e && e.message).slice(0, 100) + "）");
    }
  }
}
await Promise.all(Array.from({ length: CONC }, lane));

/* ---------- 3. 体积统计 ---------- */
function dirSize(dir) {
  var total = 0, count = 0;
  try {
    readdirSync(dir).forEach(function (f) {
      var p = path.join(dir, f);
      var st = statSync(p);
      if (st.isDirectory()) { var sub = dirSize(p); total += sub.bytes; count += sub.count; }
      else { total += st.size; count += 1; }
    });
  } catch (e) { /* 目录不存在 */ }
  return { bytes: total, count: count };
}
var size = dirSize(OUT_ROOT);
log("完成：打包 " + packed + " · 跳过（已存在）" + skipped + " · 失败 " + failed.length);
if (failed.length) log("失败清单（前 5）：" + failed.slice(0, 5).join(" | "));
log("public/logos/ 体积：" + (size.bytes / 1048576).toFixed(2) + " MiB · " + size.count + " 文件");
if (!size.count) fail("没有产出任何打包文件——检查 OSS 凭据与 logos/ 前缀");
