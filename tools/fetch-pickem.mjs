#!/usr/bin/env node
/*
 * Pick'Em 赛事聚合器（1.4.0 实验功能）
 * ------------------------------------------------------------
 * 用法：node tools/fetch-pickem.mjs
 *
 * 读 data/pickem-events.json（手工登记的赛事配置）+ data/matches.json，
 * 把每个配置赛事的比赛聚合成「阶段」（瑞士轮/淘汰赛）+ 参赛队胜负记录，
 * 累积写入 data/pickem.json（CI 走 Release 资产累积，同 team-ids.json 先例；
 * 构建期 build-runtime-data / trim-embedded 把它整体切进 runtime 与内嵌数据）。
 *
 * ⚠ 为什么必须在采集时聚合、不能事后从 matches.json 重建：
 *   matches.json 有 45 天 retention，major 早期阶段会被清掉——只有这份累积文件能留住全程。
 *
 * 数据形状（单一来源，客户端 js/data-source.js#normalizePickem 按此校验）：
 * {
 *   v: 1, generatedAt,
 *   events: [{
 *     id, game, name, status: "upcoming"|"active"|"done", endsAt,
 *     stages: [{
 *       id, type: "swiss"|"bracket", label, startsAt, endsAt,
 *       teams: [{ name, short, region, logo, w, l }],          // 瑞士轮含胜负；bracket 为参赛 8 队
 *       matches: [{ id, a, b, startAt, winner: "A"|"B"|"", score, round? }], // round 仅 bracket（0 起）
 *       rounds?: ["四分之一决赛", "半决赛", "决赛"],             // 仅 bracket
 *       degraded?: true,                                        // bracket 场次数与 expectRounds 不符（只展示不可猜）
 *       results?: { adv30: [队名], adv: [], out23: [], out13: [], out03: [] } // 仅 swiss，阶段全部结束后填写
 *     }]
 *   }]
 * }
 *
 * 结算口径（客户端 scorePhase 用同一张表）：瑞士轮终局 3-0→adv30、3-1/3-2→adv、2-3→out23、1-3→out13、0-3→out03。
 * 已 done 的事件不再重建（matches 可能已被 retention 清掉，重建会丢数据），只随 30 天窗口淘汰。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var CACHE_KEY = "pickem.json";
var CONFIG_KEY = "pickem-events.json";
var KEEP_DONE_DAYS = 30; // 赛事全部结束后保留天数，过期从缓存清除

// 瑞士轮终局分桶（官方 Major 结构固定分布：3-0×2、3-1/3-2×6、2-3×3、1-3×3、0-3×2）。
// 用户只猜 adv30/adv/out03 三桶共 10 项（官方「0/10 选择」口径）；out23/out13 是
// 剩余队伍的自动落位，仅随 results 展示、不参与选择与计分（客户端 PICKEM_BUCKETS 只含三桶）。
var DEFAULT_SWISS_BUCKETS = [
  { k: "adv30", cap: 2 },
  { k: "adv", cap: 6 },
  { k: "out23", cap: 3 },
  { k: "out13", cap: 3 },
  { k: "out03", cap: 2 }
];
var DEFAULT_EXPECT_ROUNDS = [4, 2, 1]; // 8 强单败：四分之一 4 场 → 半决赛 2 场 → 决赛 1 场
var ROUND_LABELS = { 1: "决赛", 2: "半决赛", 4: "四分之一决赛", 8: "十六强赛" };

function log(msg) { console.log("[pickem] " + msg); }

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")) || fallback; } catch (e) { return fallback; }
}

function ts(iso) {
  var t = iso ? new Date(iso).getTime() : NaN;
  return isNaN(t) ? 0 : t;
}

function compactTeam(side) {
  if (!side || !side.name) return null;
  return { name: String(side.name), short: String(side.short || ""), region: String(side.region || ""), logo: String(side.logo || "") };
}

// 从阶段比赛统计瑞士轮战绩并按终局分桶（只有全部完赛才产出 results）
function swissResults(stageTeams, stageMatches, buckets) {
  var allDone = stageMatches.length > 0 && stageMatches.every(function (m) { return m.winner === "A" || m.winner === "B"; });
  if (!allDone) return null;
  var totalCap = buckets.reduce(function (s, b) { return s + b.cap; }, 0);
  if (stageTeams.length !== totalCap) return null; // 队数对不上五桶结构：不给结果，宁缺勿滥
  var byBucket = {};
  buckets.forEach(function (b) { byBucket[b.k] = []; });
  stageTeams.forEach(function (t) {
    var key = t.w === 3 && t.l === 0 ? "adv30"
      : t.w === 3 ? "adv"
        : t.l === 3 ? (t.w === 0 ? "out03" : t.w === 1 ? "out13" : "out23")
          : null; // 未打满三胜三负（数据不完整）不入桶
    if (key && byBucket[key]) byBucket[key].push(t.name);
  });
  var filled = buckets.every(function (b) { return byBucket[b.k].length === b.cap; });
  return filled ? byBucket : null;
}

function buildSwissStage(cfg, matches) {
  var buckets = Array.isArray(cfg.buckets) && cfg.buckets.length ? cfg.buckets : DEFAULT_SWISS_BUCKETS;
  var list = matches.slice().sort(function (a, b) { return ts(a.startAt) - ts(b.startAt); });
  var teams = {};
  var order = [];
  var compact = list.map(function (m) {
    var a = compactTeam(m.teamA), b = compactTeam(m.teamB);
    [a, b].forEach(function (t) {
      if (!t) return;
      if (!teams[t.name]) { teams[t.name] = t; teams[t.name].w = 0; teams[t.name].l = 0; order.push(t.name); }
      else if (!teams[t.name].short && t.short) teams[t.name].short = t.short;
    });
    var winner = m.result && (m.result.winner === "A" || m.result.winner === "B") ? m.result.winner : "";
    if (winner === "A" && a) teams[a.name].w += 1;
    if (winner === "A" && b) teams[b.name].l += 1;
    if (winner === "B" && b) teams[b.name].w += 1;
    if (winner === "B" && a) teams[a.name].l += 1;
    return { id: m.id, a: a ? a.name : "", b: b ? b.name : "", startAt: m.startAt, winner: winner, score: (m.result && m.result.score) || "" };
  });
  var teamList = order.map(function (n) { return teams[n]; })
    .sort(function (x, y) { return (y.w - x.w) || (x.l - y.l) || (x.name < y.name ? -1 : 1); });
  var starts = list.length ? list[0].startAt : "";
  var ends = list.length ? list[list.length - 1].startAt : "";
  return {
    id: cfg.id, type: "swiss", label: cfg.label || cfg.id,
    startsAt: starts, endsAt: ends,
    teams: teamList, matches: compact,
    results: swissResults(teamList, compact, buckets)
  };
}

function buildBracketStage(cfg, matches) {
  var expect = Array.isArray(cfg.expectRounds) && cfg.expectRounds.length ? cfg.expectRounds : DEFAULT_EXPECT_ROUNDS;
  var list = matches.slice().sort(function (a, b) { return ts(a.startAt) - ts(b.startAt); });
  var teams = {};
  var order = [];
  // 分轮：按开赛时间切块 [4,2,1]；场次对不上则降级（只展示不可猜）
  var degraded = list.length !== expect.reduce(function (s, n) { return s + n; }, 0);
  var roundLabels = [];
  var roundOf = {};
  if (!degraded) {
    var idx = 0;
    expect.forEach(function (n, ri) {
      roundLabels.push(ROUND_LABELS[n] || "第 " + (ri + 1) + " 轮");
      for (var i = 0; i < n; i++) roundOf[idx++] = ri;
    });
  }
  var compact = list.map(function (m, i) {
    var a = compactTeam(m.teamA), b = compactTeam(m.teamB);
    [a, b].forEach(function (t) {
      if (!t) return;
      if (!teams[t.name]) { teams[t.name] = t; teams[t.name].w = 0; teams[t.name].l = 0; order.push(t.name); }
    });
    var winner = m.result && (m.result.winner === "A" || m.result.winner === "B") ? m.result.winner : "";
    return { id: m.id, a: a ? a.name : "", b: b ? b.name : "", startAt: m.startAt, winner: winner, score: (m.result && m.result.score) || "", round: degraded ? 0 : (roundOf[i] || 0) };
  });
  return {
    id: cfg.id, type: "bracket", label: cfg.label || cfg.id,
    startsAt: list.length ? list[0].startAt : "", endsAt: list.length ? list[list.length - 1].startAt : "",
    teams: order.map(function (n) { return teams[n]; }),
    matches: compact,
    rounds: degraded ? [] : roundLabels,
    degraded: degraded
  };
}

function buildEvent(cfg, allMatches) {
  var evMatches = allMatches.filter(function (m) {
    return m.game === cfg.game && m.tournament === cfg.tournament;
  });
  var stages = [];
  (cfg.stages || []).forEach(function (scfg) {
    var sm = evMatches.filter(function (m) { return (scfg.stageNames || []).indexOf(m.stage) >= 0; });
    if (!sm.length) return; // 该阶段还没有任何数据（未排期/拼写对不上），宁缺勿滥
    stages.push(scfg.type === "bracket" ? buildBracketStage(scfg, sm) : buildSwissStage(scfg, sm));
  });
  if (!stages.length) return null;
  var anyMatch = stages.some(function (s) { return s.matches.length; });
  var allDone = stages.length && stages.every(function (s) {
    return s.matches.length > 0 && s.matches.every(function (m) { return m.winner === "A" || m.winner === "B"; });
  });
  var anyStarted = stages.some(function (s) { return s.matches.some(function (m) { return m.winner || ts(m.startAt) <= Date.now(); }); });
  var lastStart = 0;
  stages.forEach(function (s) { s.matches.forEach(function (m) { lastStart = Math.max(lastStart, ts(m.startAt)); }); });
  var matched = stages.reduce(function (n, s) { return n + s.matches.length; }, 0);
  if (evMatches.length !== matched) {
    log("  ! " + cfg.id + "：赛事共 " + evMatches.length + " 场，仅 " + matched + " 场匹配到已配置阶段（stage 原文核对配置）");
  }
  return {
    id: cfg.id, game: cfg.game, name: cfg.name || cfg.id,
    status: allDone ? "done" : (anyStarted ? "active" : "upcoming"),
    endsAt: lastStart ? new Date(lastStart + 12 * 3600000).toISOString() : "",
    stages: stages
  };
}

async function main() {
  var cfgPath = path.join(ROOT, "data", CONFIG_KEY);
  var cachePath = path.join(ROOT, "data", CACHE_KEY);
  var srcPath = path.join(ROOT, "data", "matches.json");
  var cfg = readJson(cfgPath, { events: [] });
  var cache = readJson(cachePath, { v: 1, events: [] });
  var src = readJson(srcPath, null);
  if (!src || !Array.isArray(src.matches)) throw new Error("data/matches.json 不可用，先运行采集器");

  var events = {};
  (cache.events || []).forEach(function (e) { if (e && e.id) events[e.id] = e; });

  var built = 0;
  (cfg.events || []).forEach(function (c) {
    if (!c || !c.id || !c.game || !c.tournament || !Array.isArray(c.stages) || !c.stages.length) return;
    var cached = events[c.id];
    // 已完结的事件不再重建（其早期比赛可能已被 retention 清掉，重建反而丢阶段）
    if (cached && cached.status === "done") return;
    var ev = buildEvent(c, src.matches);
    if (ev) { events[c.id] = ev; built++; }
    else if (!cached) log("  - " + c.id + "：暂无匹配比赛（未排期或 stage/tournament 原文对不上），跳过");
  });

  // 淘汰：完结超过 KEEP_DONE_DAYS 的事件移除（累积库不无限膨胀）
  var keep = [];
  Object.keys(events).forEach(function (id) {
    var e = events[id];
    if (e.status === "done" && e.endsAt && Date.now() - ts(e.endsAt) > KEEP_DONE_DAYS * 86400000) {
      log("  - " + id + "：完结超 " + KEEP_DONE_DAYS + " 天，清除");
      return;
    }
    keep.push(e);
  });
  keep.sort(function (a, b) { return ts(a.endsAt) - ts(b.endsAt); });

  var out = { v: 1, generatedAt: new Date().toISOString(), events: keep };
  var body = JSON.stringify(out, null, 2) + "\n";
  writeFileSync(cachePath, body, "utf8");
  var teams = keep.reduce(function (n, e) { return n + e.stages.reduce(function (x, s) { return x + s.teams.length; }, 0); }, 0);
  log("赛事 " + keep.length + " 个（本次重建 " + built + "）· 阶段队伍合计 " + teams + " · 已写入 data/" + CACHE_KEY);
}

main().catch(function (e) {
  console.error("[pickem] 聚合失败：" + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
