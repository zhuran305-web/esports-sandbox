#!/usr/bin/env node
/*
 * 选手头像打包（2026-11-10 PandaScore 深度接入）
 * ------------------------------------------------------------
 * 用法：node tools/pack-player-avatars.mjs [--force]
 *
 * 从 data/team-rosters.json 取窗口队伍（data/matches.json 里出现过的 game:name，与
 * build-runtime-data 的 rosters 切片同口径）选手的 img 相对路径 → 直接从 PandaScore CDN
 * 下载原图（不镜像 OSS——省 400MB+ 存储；CDN 下载不计 API 配额）→ 压 64px WebP →
 * public/players/<djb2(img)>.webp。客户端 playerAvatar 引用 "players/" + 同算法文件名
 * （复用 js/app.js logoPackName 的 djb2——改一处必改另一处）。
 *
 * 增量：目标存在跳过（--force 重压）；单张失败跳过（下轮重试，客户端首字母兜底）；
 * djb2 碰撞检测：同散列不同源 → 报错退出（32 位散列在万级资源下有生日碰撞，先撞先报）。
 * 由 package.json prebuild 调用（与 pack-team-logos 同链）。
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var OUT_ROOT = path.join(ROOT, "public", "players");
var CDN = "https://cdn-api.pandascore.co/images/player/image/";
var FORCE = process.argv.indexOf("--force") >= 0;
var CONCURRENCY = 8;
var SIZE = 64;

function log(msg) { console.log("[player-avatars] " + msg); }
function fail(msg) { console.error("[player-avatars] " + msg); process.exit(1); }

// djb2 8hex + .webp（与 js/app.js logoPackName、tools/pack-team-logos.mjs packName 同算法）
function packName(suffix) {
  var h = 5381;
  for (var i = 0; i < suffix.length; i++) { h = ((h << 5) + h + suffix.charCodeAt(i)) >>> 0; }
  return h.toString(16).padStart(8, "0") + ".webp";
}

async function main() {
  // 1) 目标集合：窗口队伍（matches.json 全量口径，与 runtime rosters 切片一致）的选手 img
  // 软失败：prebuild 链上的工具绝不阻塞构建（缺输入=本轮无新头像，客户端首字母兜底）
  var srcPath = path.join(ROOT, "data", "matches.json");
  if (!existsSync(srcPath)) { log("缺少 data/matches.json——跳过（构建不含选手头像）"); return; }
  var rostersPath = path.join(ROOT, "data", "team-rosters.json");
  if (!existsSync(rostersPath)) { log("缺少 data/team-rosters.json——跳过（构建不含选手头像，先运行 fetch-team-rosters）"); return; }
  var matches = (JSON.parse(readFileSync(srcPath, "utf8")).matches || []);
  var rosters = JSON.parse(readFileSync(rostersPath, "utf8")) || {};

  var wanted = {}; // img 路径 → 首个队伍键（碰撞检测用）
  var seenKeys = {};
  matches.forEach(function (m) {
    if (!m || !m.game) return;
    [m.teamA, m.teamB].forEach(function (t) {
      if (!t || !t.name) return;
      var key = m.game + ":" + t.name;
      if (seenKeys[key]) return;
      seenKeys[key] = 1;
      var e = rosters[key];
      if (!e || !Array.isArray(e.players)) return;
      e.players.forEach(function (p) {
        if (p && p.img && !wanted[p.img]) wanted[p.img] = key;
      });
    });
  });
  var imgs = Object.keys(wanted);
  log("窗口队伍 " + Object.keys(seenKeys).length + " 支 · 待打包选手头像 " + imgs.length + " 张");

  // 2) djb2 碰撞预检（打包前就拦，避免同名互相覆盖）
  var byHash = {};
  imgs.forEach(function (img) {
    var h = packName(img);
    if (byHash[h] && byHash[h] !== img) fail("djb2 碰撞：" + h + " 同时命中 " + byHash[h] + " 与 " + img + "——需换命名空间或加长散列");
    byHash[h] = img;
  });

  if (!existsSync(OUT_ROOT)) mkdirSync(OUT_ROOT, { recursive: true });

  // 3) 并发下载 + 压缩（增量：目标存在跳过）
  var queue = imgs.slice();
  var packed = 0, skipped = 0, failed = 0, bytes = 0;

  async function worker() {
    while (queue.length) {
      var img = queue.shift();
      if (!img) return;
      var target = path.join(OUT_ROOT, packName(img));
      try {
        if (!FORCE && existsSync(target)) { skipped++; continue; }
        var res = await fetch(CDN + img.split("/").map(encodeURIComponent).join("/"), { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        var buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100) throw new Error("原图体积异常 " + buf.length + "B");
        var webp = await sharp(buf).resize(SIZE, SIZE, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
        if (webp.length < 60) throw new Error("产物体积异常 " + webp.length + "B");
        writeFileSync(target, webp);
        packed++;
        bytes += webp.length;
      } catch (e) {
        failed++;
        log("  ! " + img + "：" + (e && e.message ? e.message : e));
      }
    }
  }
  var workers = [];
  for (var w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);

  var totalFiles = 0, totalBytes = 0;
  try {
    totalFiles = readdirSync(OUT_ROOT).length;
    readdirSync(OUT_ROOT).forEach(function (f) { totalBytes += statSync(path.join(OUT_ROOT, f)).size; });
  } catch (e) { /* 目录缺失 */ }

  log("完成：打包 " + packed + " · 跳过 " + skipped + " · 失败 " + failed +
    " · public/players/ 共 " + totalFiles + " 张 / " + (totalBytes / 1048576).toFixed(2) + " MiB" +
    (totalBytes > 8 * 1048576 ? "  ⚠ 超过 8MiB——考虑只打包 s/a 队伍或降 48px" : ""));
  if (failed > packed) process.exitCode = 1; // 多数失败才算异常
}

main().catch(function (e) {
  console.error("[player-avatars] 打包失败：" + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
