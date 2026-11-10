#!/usr/bin/env node
/*
 * 战队选手阵容抓取（1.3.2）
 * ------------------------------------------------------------
 * 用法：
 *   node tools/fetch-team-rosters.mjs            本地缓存模式：读/写 data/team-rosters.json
 *   node tools/fetch-team-rosters.mjs --oss      OSS 累积缓存模式（CI）：读写 <PREFIX>team-rosters.json
 *   node tools/fetch-team-rosters.mjs --window   只处理 data/matches.json 里出现过的队伍（默认全量 team-ids）
 *   node tools/fetch-team-rosters.mjs --force    全量重抓（忽略缓存）
 *
 * 数据源：PandaScore GET /teams/{id}（需要 PANDASCORE_TOKEN），team 对象内嵌 players[]。
 * 提取：每队前 5 名 active 选手 { n: 职业ID, r: 位置（仅 LoL/Dota2/OW 有值）, l: 国籍 ISO 码,
 *       id: PandaScore player id, img: 头像相对路径（pack-player-avatars 打包 64px WebP）,
 *       fn/ln: 真实姓名 }——2026-11-10 深度接入扩展；age/birthday 是付费档字段，不采集。
 * 缓存：{ "game:name": { pid, players: [...], at } }，LRU 1500 队；同 pid 命中缓存直接跳过
 *       （--force 重抓；旧 schema 条目——首名选手无 id——也会增量重抓补新字段）。
 * 产物：data/team-rosters.json（本地镜像）+ OSS team-rosters.json（--oss 时）；
 *       build-runtime-data.mjs / trim-embedded.mjs 会按窗口队伍切片进 runtime 与内嵌数据。
 * 限速：350ms/次（每日回填一轮，几百次请求在 1000/h 配额内）；单队失败跳过、不阻塞。
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var IDS_KEY = "team-ids.json";
var CACHE_KEY = "team-rosters.json";
var ROSTER_CAP = 5;      // 每队最多收录人数（首发 + 替补里取前 5）
var CACHE_CAP = 1500;    // 缓存 LRU 上限（与队色管线一致量级）
var RATE_MS = 350;

function log(msg) { console.log("[rosters] " + msg); }
function fail(msg) { console.error("[rosters] " + msg); process.exit(1); }

var BUCKET = "", REGION = "", KEY_ID = "", KEY_SECRET = "", PREFIX = "";

function loadEnv() {
  try {
    var file = path.join(ROOT, ".env");
    if (existsSync(file)) {
      readFileSync(file, "utf8").split(/\r?\n/).forEach(function (line) {
        var match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
      });
    }
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
  if (!KEY_ID || !KEY_SECRET) fail("--oss 需要 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET");
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
  if (!KEY_ID || !KEY_SECRET) fail("--oss 需要 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET");
  var date = new Date().toUTCString();
  var headers = { Date: date, "Content-Type": "application/json" };
  var res = await fetch("https://" + BUCKET + ".oss-" + REGION + ".aliyuncs.com/" + (PREFIX ? PREFIX + "/" : "") + key, {
    method: "PUT",
    headers: Object.assign({ Authorization: signRequest("PUT", key, headers, date) }, headers),
    body: body
  });
  if (!res.ok) throw new Error("OSS PUT " + key + " HTTP " + res.status);
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* 抽取花名册：前 5 名 active 选手，压缩键名（n/r/l/id/img/fn/ln）控制体积。
 * 2026-11-10 深度接入扩展：id=PandaScore player id（选手卡身份键）、img=头像相对路径
 * （剥 CDN 前缀，pack-player-avatars 按 djb2 打包 64px WebP，客户端 players/<djb2>.webp 引用）、
 * fn/ln=真实姓名（官方免费字段；部分选手缺失，客户端按有无降级）。 */
var PLAYER_IMG_PREFIXES = [
  "https://cdn-api.pandascore.co/images/player/image/",
  "https://cdn.pandascore.co/images/player/image/"
];
function playerImgPath(url) {
  var u = String(url || "").trim();
  if (!u) return "";
  for (var i = 0; i < PLAYER_IMG_PREFIXES.length; i++) {
    if (u.indexOf(PLAYER_IMG_PREFIXES[i]) === 0) return u.slice(PLAYER_IMG_PREFIXES[i].length);
  }
  return "";
}
function extractPlayers(team) {
  var list = Array.isArray(team.players) ? team.players : [];
  return list
    .filter(function (p) { return p && p.name && p.active !== false; })
    .slice(0, ROSTER_CAP)
    .map(function (p) {
      var img = playerImgPath(p.image_url);
      return {
        n: String(p.name).slice(0, 24),
        r: p.role ? String(p.role).slice(0, 16) : "",
        l: p.nationality ? String(p.nationality).slice(0, 2).toLowerCase() : "",
        id: p.id > 0 ? Math.floor(p.id) : undefined,
        img: img || undefined,
        fn: p.first_name ? String(p.first_name).slice(0, 32) : undefined,
        ln: p.last_name ? String(p.last_name).slice(0, 32) : undefined
      };
    });
}

async function fetchTeam(pid, token) {
  // 429 退避：撞小时配额时等 45s 再试（回填当轮采集已耗掉大半配额时常见）；最多退避 2 次
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = await fetch("https://api.pandascore.co/teams/" + pid, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    if (res.status === 404) return null; // 队伍已被数据源下架：缓存里也清掉
    if (res.status !== 429) {
      if (!res.ok) throw new Error("PandaScore HTTP " + res.status);
      return await res.json();
    }
    if (attempt < 2) await sleep(45000);
  }
  throw new Error("PandaScore HTTP 429（退避 2 次后仍限流）");
}

async function main() {
  var args = process.argv.slice(2);
  var useOss = args.indexOf("--oss") >= 0;
  var windowOnly = args.indexOf("--window") >= 0;
  var force = args.indexOf("--force") >= 0;
  loadEnv();

  var idsPath = path.join(ROOT, "data", IDS_KEY);
  if (!existsSync(idsPath)) fail("缺少 data/team-ids.json——先运行一次采集器（fetch-matches 会累积）");
  var teamIds = JSON.parse(readFileSync(idsPath, "utf8")) || {};
  if (!Object.keys(teamIds).length) fail("data/team-ids.json 为空");

  // --window：只处理 matches.json（45 天窗口）里出现过的队伍
  var windowSet = null;
  if (windowOnly) {
    var srcPath = path.join(ROOT, "data", "matches.json");
    if (!existsSync(srcPath)) fail("--window 需要 data/matches.json");
    var raw = JSON.parse(readFileSync(srcPath, "utf8"));
    windowSet = new Set();
    (raw.matches || []).forEach(function (m) {
      if (m.teamA && m.teamA.name) windowSet.add(m.game + ":" + m.teamA.name);
      if (m.teamB && m.teamB.name) windowSet.add(m.game + ":" + m.teamB.name);
    });
    log("窗口队伍 " + windowSet.size + " 支（matches.json " + (raw.matches || []).length + " 场）");
  }

  var token = process.env.PANDASCORE_TOKEN;
  if (!token) fail("未设置 PANDASCORE_TOKEN");

  // 缓存：--oss 走 OSS 累积库，否则本地文件
  var localPath = path.join(ROOT, "data", CACHE_KEY);
  var cache = {};
  if (useOss) {
    var remote = await ossGet(CACHE_KEY);
    if (remote) {
      try { cache = JSON.parse(remote) || {}; } catch (e) { cache = {}; log("OSS 缓存解析失败，从空开始"); }
    } else {
      log("OSS 无缓存对象，从空开始");
    }
  } else if (existsSync(localPath)) {
    try { cache = JSON.parse(readFileSync(localPath, "utf8")) || {}; } catch (e) { cache = {}; }
  }

  var targets = Object.keys(teamIds).filter(function (k) { return !windowSet || windowSet.has(k); });
  var pending = targets.filter(function (k) {
    if (force) return true;
    var c = cache[k];
    if (!c || c.pid !== teamIds[k]) return true;
    // 2026-11-10 字段扩展（id/img/fn/ln）：旧 schema 缓存（有选手但首名无 id）视为待更新，
    // 由每日回填增量补齐；无阵容的空缓存保持命中（避免每轮重抓）
    if (c.players && c.players.length && !(c.players[0].id > 0)) return true;
    return false;
  });
  log("队伍 id " + targets.length + " 支（--window " + (windowSet ? "开" : "关") + "）· 缓存命中 " +
    (targets.length - pending.length) + " · 待抓 " + pending.length);

  var ok = 0, empty = 0, failed = 0, removed = 0;
  for (var i = 0; i < pending.length; i++) {
    var key = pending[i];
    var pid = teamIds[key];
    try {
      var team = await fetchTeam(pid, token);
      if (!team) {
        delete cache[key];
        removed++;
        log("  - " + key + "：数据源已下架，清除缓存");
      } else {
        var players = extractPlayers(team);
        if (!players.length) empty++;
        cache[key] = { pid: pid, players: players, at: Date.now() };
        ok++;
      }
    } catch (e) {
      failed++;
      log("  ! " + key + "：" + (e && e.message ? e.message : String(e)));
    }
    await sleep(RATE_MS);
  }

  // LRU 封顶：按 at 最旧淘汰
  var keys = Object.keys(cache);
  if (keys.length > CACHE_CAP) {
    keys.sort(function (a, b) { return (cache[a].at || 0) - (cache[b].at || 0); });
    keys.slice(0, keys.length - CACHE_CAP).forEach(function (k) { delete cache[k]; });
    log("缓存超限，淘汰最旧 " + (keys.length - CACHE_CAP) + " 队");
  }

  var body = JSON.stringify(cache, null, 2) + "\n";
  writeFileSync(localPath, body, "utf8");
  if (useOss) {
    await ossPut(CACHE_KEY, body);
    log("已回写 OSS " + CACHE_KEY);
  }
  log("本地镜像已写入 data/" + CACHE_KEY);

  var withPlayers = keys.filter(function (k) { return cache[k].players && cache[k].players.length; }).length;
  log("完成：抓到 " + ok + " 队（其中无选手数据 " + empty + " 队）· 失败 " + failed + " · 下架清除 " + removed +
    " · 缓存 " + keys.length + " 队（有阵容 " + withPlayers + " 队）");
  if (failed > ok) process.exitCode = 1; // 多数失败才算异常，零星失败由下轮重试
}

main().catch(function (e) {
  console.error("[rosters] 抓取失败：" + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
