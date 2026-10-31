#!/usr/bin/env node
/*
 * 队伍主题色提取（1.2.11）：从队标图片自动提取双主色，供「主队主题皮肤」换肤。
 *
 * 缓存：{队名: {c: [hex, hex, 0|1], t: 最近见到时间戳}}
 *   - --oss 模式缓存存 OSS 对象 <PREFIX>team-colors.json（累积库，LRU 封顶 3000 队）
 *   - 本地始终镜像一份 data/team-colors.json，供 build-runtime-data / trim-embedded 切片
 *   - runtime 输出只带当前窗口切片（体积 ~35B/队），缓存对象本身可长到 ~165KB
 *
 * 用法：
 *   node tools/extract-team-colors.mjs           # 纯本地：读/写 data/team-colors.json
 *   node tools/extract-team-colors.mjs --oss     # 缓存走 OSS（CI/发布管线；需 .env 的 OSS_*）
 *   node tools/extract-team-colors.mjs --force   # 忽略缓存全部重提（调试）
 *
 * 失败语义：单个队标下载/提色失败 → 跳过（该队无色，客户端回退默认主题），下轮重试；
 * 整步抛错不阻塞数据构建（workflow 里单独一步，失败仅少颜色）。
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { collectTeamLogos } from "./lib.mjs";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var LOGO_BASE = "https://cdn-api.pandascore.co/images/team/image/";
var COLORS_KEY = "team-colors.json";
var CACHE_CAP = 3000;
var CONCURRENCY = 5;

function log(msg) { console.log("[colors] " + msg); }
function fail(msg) { console.error("[colors] " + msg); process.exit(1); }

/* ---------- 提色算法（纯函数，可被 test:cloud 直跑） ---------- */

function toHex(c) {
  return "#" + [c.r, c.g, c.b].map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"); }).join("");
}

/**
 * pixels：RGB 三通道 Buffer（sharp raw 输出，已 flatten 到白底）。
 * 桶量化 4bit/通道；滤低饱和/近白/近黑（队标底色），得分 = 像素数 × 平均饱和度；
 * 次色与主色的通道距离 ≥90，避免取到同色系邻近桶。
 * 消色差防线（1.2.12 修复）：黑白 logo 的 JPEG 色度噪边（饱和度 30-60、偏暖偏红）能穿过
 * 饱和度过滤且占满幸存像素——幸存占比 <4% 即判消色差。
 * 消色差去向（1.2.12 增强）：暗部主导（lum≤120 像素 ≥8%）→ 提炼石墨主题（暗部均值钳到
 * 亮度 28-72 带，白字可读）；白亮主导（flatten 后近乎全白/细线条）→ null 回退默认主题。
 */
export function pickPalette(pixels) {
  var total = pixels.length / 3;
  var buckets = {};
  var survived = 0;
  var darkN = 0, darkR = 0, darkG = 0, darkB = 0;
  for (var i = 0; i + 2 < pixels.length; i += 3) {
    var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum <= 120) { darkN += 1; darkR += r; darkG += g; darkB += b; } // 暗部统计（含黑字形/深灰）
    if (max - min < 28) continue; // 灰底/白底/黑底
    if (lum > 235 || lum < 20) continue;
    survived += 1;
    var key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    var e = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0, sat: 0 });
    e.n += 1; e.r += r; e.g += g; e.b += b; e.sat += (max - min);
  }
  if (!survived || survived < total * 0.04) {
    // 消色差：黑/深灰主导 → 石墨主题；白亮/细线条 → 回退默认
    if (!darkN || darkN < total * 0.08) return null;
    var m1 = darkR / darkN, m2 = darkG / darkN, m3 = darkB / darkN;
    var ml = 0.299 * m1 + 0.587 * m2 + 0.114 * m3;
    var k = ml > 72 ? 72 / ml : ml < 30 ? 30 / Math.max(ml, 1) : 1; // 钳进石墨带（下沿留取整余量），白字恒可读
    var g1 = { r: m1 * k, g: m2 * k, b: m3 * k };
    var g2 = { r: g1.r + (255 - g1.r) * 0.3, g: g1.g + (255 - g1.g) * 0.3, b: g1.b + (255 - g1.b) * 0.3 };
    return [toHex(g1), toHex(g2), 0]; // 深底恒配白字
  }
  var list = Object.keys(buckets).map(function (k) {
    var e = buckets[k];
    return { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, score: e.n * (e.sat / e.n) };
  }).sort(function (a, b) { return b.score - a.score; });
  if (!list.length) return null;
  var c1 = list[0];
  var c2 = c1;
  for (var j = 1; j < list.length; j++) {
    var d = Math.abs(list[j].r - c1.r) + Math.abs(list[j].g - c1.g) + Math.abs(list[j].b - c1.b);
    if (d >= 90) { c2 = list[j]; break; }
  }
  var lum1 = 0.299 * c1.r + 0.587 * c1.g + 0.114 * c1.b;
  return [toHex(c1), toHex(c2), lum1 > 150 ? 1 : 0]; // darkText：主色亮 → 配深色文字
}

/** LRU 封顶：超出按 t 最旧淘汰（team-colors 累积库防无限膨胀） */
export function capColors(cache, cap) {
  var keys = Object.keys(cache);
  var limit = cap || CACHE_CAP;
  if (keys.length <= limit) return cache;
  keys.sort(function (a, b) { return (cache[a].t || 0) - (cache[b].t || 0); });
  while (keys.length > limit) delete cache[keys.shift()];
  return cache;
}

async function extractFromLogo(url) {
  var res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  var buf = Buffer.from(await res.arrayBuffer());
  var raw = await sharp(buf).flatten({ background: "#ffffff" }).resize(32, 32, { fit: "inside" }).removeAlpha().raw().toBuffer();
  return pickPalette(raw);
}

/* ---------- OSS V1 签名（与 publish-runtime-oss.mjs 同族） ---------- */

var BUCKET = "", REGION = "", KEY_ID = "", KEY_SECRET = "", PREFIX = "";

function loadEnv() {
  try {
    var file = path.join(ROOT, ".env");
    if (!existsSync(file)) return;
    readFileSync(file, "utf8").split(/\r?\n/).forEach(function (line) {
      var match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
    });
  } catch (e) { /* .env 可缺 */ }
  BUCKET = (process.env.OSS_BUCKET || "").trim();
  REGION = (process.env.OSS_REGION || "cn-hangzhou").trim();
  KEY_ID = (process.env.OSS_ACCESS_KEY_ID || "").trim();
  KEY_SECRET = (process.env.OSS_ACCESS_KEY_SECRET || "").trim();
  PREFIX = (process.env.OSS_PREFIX || "").replace(/^\/+|\/+$/g, "");
}

function signRequest(method, key, headers, date) {
  var canon = Object.keys(headers)
    .filter(function (n) { return n.toLowerCase().indexOf("x-oss-") === 0; })
    .map(function (n) { return [n.toLowerCase(), String(headers[n]).trim()]; })
    .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; })
    .map(function (p) { return p[0] + ":" + p[1] + "\n"; })
    .join("");
  var stringToSign = [method, headers["Content-MD5"] || "", headers["Content-Type"] || "", date, canon + "/" + BUCKET + "/" + key].join("\n");
  return "OSS " + KEY_ID + ":" + createHmac("sha1", KEY_SECRET).update(stringToSign, "utf8").digest("base64");
}

async function ossGet(key) {
  if (!KEY_ID || !KEY_SECRET) fail("--oss 需要 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（.env）");
  var date = new Date().toUTCString();
  var headers = { Date: date };
  var res = await fetch("https://" + BUCKET + ".oss-" + REGION + ".aliyuncs.com/" + (PREFIX ? PREFIX + "/" : "") + key, {
    headers: Object.assign({ Authorization: signRequest("GET", key, headers, date) }, headers)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("OSS GET " + key + " HTTP " + res.status);
  return await res.text();
}

async function ossPut(key, body) {
  if (!KEY_ID || !KEY_SECRET) fail("--oss 需要 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（.env）");
  var date = new Date().toUTCString();
  var headers = { Date: date, "Content-Type": "application/json" };
  var res = await fetch("https://" + BUCKET + ".oss-" + REGION + ".aliyuncs.com/" + (PREFIX ? PREFIX + "/" : "") + key, {
    method: "PUT",
    headers: Object.assign({ Authorization: signRequest("PUT", key, headers, date) }, headers),
    body: body
  });
  if (!res.ok) throw new Error("OSS PUT " + key + " HTTP " + res.status);
}

/* ---------- 主流程 ---------- */

async function main() {
  var args = process.argv.slice(2);
  var useOss = args.indexOf("--oss") >= 0;
  var force = args.indexOf("--force") >= 0;
  loadEnv();

  var srcPath = path.join(ROOT, "data", "matches.json");
  if (!existsSync(srcPath)) fail("缺少 data/matches.json，先运行 npm run data:pull");
  var raw = JSON.parse(readFileSync(srcPath, "utf8"));
  var logos = collectTeamLogos(raw.matches); // {队名: 相对路径}——只含有图队伍
  if (!Object.keys(logos).length) fail("数据里没有任何队标路径");

  var localPath = path.join(ROOT, "data", "team-colors.json");
  var cache = {};
  if (useOss) {
    var remote = await ossGet(COLORS_KEY);
    if (remote) {
      try { cache = JSON.parse(remote) || {}; } catch (e) { cache = {}; log("OSS 缓存解析失败，从空开始"); }
    } else {
      log("OSS 无缓存对象，从空开始");
    }
  } else if (existsSync(localPath)) {
    try { cache = JSON.parse(readFileSync(localPath, "utf8")) || {}; } catch (e) { cache = {}; }
  }
  if (force) cache = {};

  var now = Date.now();
  Object.keys(cache).forEach(function (name) { if (cache[name] && cache[name].c) cache[name].t = now; }); // 刷新 seen（LRU 依据）

  // 待提取 = 有队标且缓存里没有的队
  var pending = Object.keys(logos).filter(function (name) { return !cache[name] || !cache[name].c; });
  log("队伍 " + Object.keys(logos).length + " 支 · 缓存已有 " + (Object.keys(logos).length - pending.length) + " · 待提取 " + pending.length);

  var done = 0, failed = 0, idx = 0;
  async function worker() {
    while (idx < pending.length) {
      var name = pending[idx++];
      var palette = null;
      try { palette = await extractFromLogo(LOGO_BASE + logos[name]); } catch (e) { palette = null; }
      if (palette) { cache[name] = { c: palette, t: now }; done += 1; } else { failed += 1; }
    }
  }
  var workers = [];
  for (var w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);

  capColors(cache, CACHE_CAP);
  writeFileSync(localPath, JSON.stringify(cache), "utf8");
  if (useOss) await ossPut(COLORS_KEY, JSON.stringify(cache));

  log("新提取 " + done + " · 失败跳过 " + failed + "（下轮重试） · 缓存总量 " + Object.keys(cache).length + " 队" +
    (useOss ? " · 已回写 OSS " + COLORS_KEY : " · 已写 " + path.relative(ROOT, localPath)));
}

var isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(function (e) {
    // 整步失败不阻塞数据构建：workflow 里失败仅意味着本轮少颜色
    fail((e && (e.message || e)) || String(e));
  });
}
