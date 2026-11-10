#!/usr/bin/env node
/*
 * live.json 高频发布（2026-11-11 PandaScore 深度接入二期）
 * ------------------------------------------------------------
 * 用法：node tools/publish-live-oss.mjs [--dry-run]
 *
 * 独立小文件策略：进行中/刚完赛场次只占几 KB，但 runtime matches.json 1.99MiB 且
 * hash 变化触发全量下载——高频刷新必须拆独立 live.json（不进 meta hash、不碰整包）。
 * 本脚本由 refresh-live.yml（FC 每 10 分钟 dispatch）调用：
 *   1. GET /matches/running?per_page=100（全局端点，1 次拿全部游戏——实测 5 场/16.6KB）
 *      + GET /matches/past?per_page=12&sort=-end_at（最近完赛，驱动客户端 finished 迁移结算）
 *   2. 生成 live.json：{updatedAt, live:[{mid, lsc, gs}], finished:[{mid, result, endAt}]}
 *      （字段名与 lib.mjs 实时三件套对齐；确定性序列化，内容不变跳过 PUT）
 *   3. PUT 到 OSS live.json（公共读，Cache-Control max-age=60）
 * 单写者纪律：live.json 只由本脚本写——publish-runtime-oss 的 --check 不认识它，零冲突。
 * 数据侧 1.3.13/1.3.14/1.3.15 即受益；客户端消费（轻量轮询）随 1.3.16。
 *
 * 凭据：OSS_* 走 env（CI=Secrets；本地 .env 由 --oss 系脚本同款 loadEnv 读入）。
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var API = "https://api.pandascore.co";
var LIVE_KEY = "live.json";
var MAX_LIVE = 50;
var MAX_FINISHED = 12;
var DRY = process.argv.indexOf("--dry-run") >= 0;

var BUCKET = "", REGION = "cn-hangzhou", KEY_ID = "", KEY_SECRET = "", PREFIX = "";
function loadEnv() {
  try {
    var file = path.join(ROOT, ".env");
    if (existsSync(file)) {
      readFileSync(file, "utf8").split(/\r?\n/).forEach(function (line) {
        var m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
      });
    }
  } catch (e) { /* .env 可缺 */ }
  BUCKET = (process.env.OSS_BUCKET || "").trim();
  REGION = (process.env.OSS_REGION || "cn-hangzhou").trim();
  KEY_ID = (process.env.OSS_ACCESS_KEY_ID || "").trim();
  KEY_SECRET = (process.env.OSS_ACCESS_KEY_SECRET || "").trim();
  PREFIX = (process.env.OSS_PREFIX || "").replace(/^\/+|\/+$/g, "");
}

function log(msg) { console.log("[live] " + msg); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* OSS V1 签名（与 publish-runtime-oss.mjs:164-174 / fetch-team-rosters.mjs:53-62 同构——
   x-oss-* 头必须参与规范化，否则 PUT 带 acl 头时 403） */
function signRequest(method, key, date, headers) {
  var canon = Object.keys(headers)
    .filter(function (n) { return n.toLowerCase().indexOf("x-oss-") === 0; })
    .map(function (n) { return [n.toLowerCase(), String(headers[n]).trim()]; })
    .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; })
    .map(function (p) { return p[0] + ":" + p[1] + "\n"; })
    .join("");
  var stringToSign = [method, "", "application/json", date, canon + "/" + BUCKET + "/" + (PREFIX ? PREFIX + "/" : "") + key].join("\n");
  return "OSS " + KEY_ID + ":" + createHmac("sha1", KEY_SECRET).update(stringToSign, "utf8").digest("base64");
}

async function ossPut(key, body) {
  if (!KEY_ID || !KEY_SECRET) throw new Error("缺 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET");
  var date = new Date().toUTCString();
  var headers = {
    Date: date,
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=60",
    "x-oss-object-acl": "public-read"
  };
  var res = await fetch("https://" + BUCKET + ".oss-" + REGION + ".aliyuncs.com/" + (PREFIX ? PREFIX + "/" : "") + key, {
    method: "PUT",
    headers: Object.assign({ Authorization: signRequest("PUT", key, date, headers) }, headers),
    body: body
  });
  if (!res.ok) throw new Error("OSS PUT " + key + " HTTP " + res.status);
}

async function apiGet(pathname, token) {
  var res = await fetch(API + pathname, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + pathname);
  var body = await res.json();
  return Array.isArray(body) ? body : [];
}

/** 纯函数：PandaScore running/past 批次 → live.json 形状（导出供 test:cloud）。
 *  live: running 场次（mid/lsc/gs）；finished: 近期完赛（mid/result/endAt）——
 *  客户端 finished 迁移触发结算，1 小时整包延迟被压缩到 10 分钟。 */
export function buildLiveDoc(runningItems, pastItems) {
  function opponents(item) {
    var ops = (item.opponents || []).map(function (o) { return o && o.opponent ? o.opponent : {}; });
    return ops;
  }
  function liveScore(item, op1, op2) {
    var s1 = (item.results || []).filter(function (x) { return x.team_id === op1.id; })[0];
    var s2 = (item.results || []).filter(function (x) { return x.team_id === op2.id; })[0];
    if (s1 && s2 && typeof s1.score === "number" && typeof s2.score === "number") return s1.score + ":" + s2.score;
    return "";
  }
  function gameStr(item, op1, op2) {
    return (item.games || []).map(function (g) {
      if (g.status !== "finished" || !g.winner) return null;
      var w = g.winner.id === op1.id ? "A" : g.winner.id === op2.id ? "B" : null;
      if (!w) return null;
      return w + (typeof g.length === "number" && g.length > 0 ? Math.floor(g.length) : "");
    }).filter(Boolean).join(",");
  }
  var live = (runningItems || []).map(function (item) {
    var ops = opponents(item);
    var op1 = ops[0] || {}, op2 = ops[1] || {};
    if (!(item.id > 0)) return null;
    return {
      mid: Math.floor(item.id),
      lsc: liveScore(item, op1, op2) || undefined,
      gs: gameStr(item, op1, op2) || undefined
    };
  }).filter(Boolean).slice(0, MAX_LIVE);
  var finished = (pastItems || []).map(function (item) {
    var hasResult = item.winner_id && (item.results || []).length &&
      typeof (item.results || [])[0].score === "number";
    if (!hasResult || !(item.id > 0)) return null;
    var ops = opponents(item);
    var op1 = ops[0] || {}, op2 = ops[1] || {};
    var s1 = (item.results || []).filter(function (x) { return x.team_id === op1.id; })[0];
    var s2 = (item.results || []).filter(function (x) { return x.team_id === op2.id; })[0];
    var winner = item.winner_id === op1.id ? "A" : item.winner_id === op2.id ? "B" : "";
    if (!winner || typeof (s1 || {}).score !== "number" || typeof (s2 || {}).score !== "number") return null;
    return {
      mid: Math.floor(item.id),
      result: { winner: winner, score: s1.score + ":" + s2.score },
      endAt: item.end_at || undefined
    };
  }).filter(Boolean).slice(0, MAX_FINISHED);
  return { v: 1, updatedAt: "", live: live, finished: finished };
}

async function main() {
  loadEnv();
  var token = process.env.PANDASCORE_TOKEN;
  if (!token) { log("未设置 PANDASCORE_TOKEN，跳过"); return; }

  var running = await apiGet("/matches/running?per_page=100", token);
  await sleep(1200);
  var past = await apiGet("/matches/past?per_page=15&sort=-end_at", token);

  var doc = buildLiveDoc(running, past);
  doc.updatedAt = new Date().toISOString();
  var body = JSON.stringify(doc);

  // 内容不变跳过 PUT：先匿名 GET 线上比对（公共读），省 OSS 请求与客户端空轮询
  try {
    var anon = await fetch("https://" + BUCKET + ".oss-" + REGION + ".aliyuncs.com/" + (PREFIX ? PREFIX + "/" : "") + LIVE_KEY, { signal: AbortSignal.timeout(15000) });
    if (anon.ok && (await anon.text()) === body) {
      log("内容未变（live " + doc.live.length + " · finished " + doc.finished.length + "），跳过上传");
      return;
    }
  } catch (e) { /* 比对失败照常上传 */ }

  if (DRY) {
    log("dry-run：live " + doc.live.length + " · finished " + doc.finished.length + " · " + (body.length / 1024).toFixed(1) + "KB（未上传）");
    console.log(body.slice(0, 600));
    return;
  }
  await ossPut(LIVE_KEY, body);
  log("已上传 " + LIVE_KEY + "：live " + doc.live.length + " · finished " + doc.finished.length + " · " + (body.length / 1024).toFixed(1) + "KB");
}

var isMainGuard = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; // 直调才跑 main（test:cloud 导入零副作用）
if (isMainGuard) main().catch(function (e) {
  console.error("[live] 失败：" + (e && e.message ? e.message : e));
  process.exit(1);
});
