#!/usr/bin/env node
/*
 * incidents 对账工具（2026-11-10 PandaScore 深度接入）
 * ------------------------------------------------------------
 * 用法：node tools/fetch-incidents.mjs [--dry-run]
 *
 * 官方 `GET /incidents?type=match&since=<modified_at>` 增量变更流（免费，All plans；
 * 官方语义：每个对象只保留「最新一条」事件，不保留历史——实测返回
 * {id, type:"match", change_type:"creation"|"update"|"deletion", modified_at, object:{id, status,...}}）。
 *
 * 定位=对账与触发信号，不改采集主链路（全量窗口重采仍是唯一权威来源）。三件事：
 *   ① 建立并推进游标 data/incidents-cursor.json（Release 资产，照 team-ids.json 先例）
 *   ② 与 data/matches.json 对账：
 *      - creation：begin_at 在数据窗口内但本地无此 mid → 「疑似漏抓新增」警告
 *      - deletion：本地仍持有该 mid → 「官方已删除」警告（**不删数据**——账本完整性纪律）
 *      - update：仅计数（全量重采每轮覆盖，无需定向处理）
 *   ③ API 失败 → exit 1（CI 步骤红，接告警链路）
 * 首轮（无游标）：只建游标不发警告（无基线，避免误报）。
 *
 * 凭据只走环境变量 PANDASCORE_TOKEN。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var API = "https://api.pandascore.co";
var MAX_PAGES = 6; // 单轮翻页上限（per_page=100 × 6 = 600 条/轮，静默期远用不满）

function log(msg) { console.log("[incidents] " + msg); }

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")) || fallback; } catch (e) { return fallback; }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function apiGet(pathname, token) {
  for (var attempt = 1; attempt <= 3; attempt++) {
    var res = await fetch(API + pathname, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
      signal: AbortSignal.timeout(25000)
    });
    if (res.status === 429) {
      if (attempt >= 3) throw new Error("429 连续 3 次");
      log("429 退避 45s（第 " + attempt + " 次）");
      await sleep(45000);
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    var body = await res.json();
    return Array.isArray(body) ? body : [];
  }
  throw new Error("unreachable");
}

/** 纯函数：从 incidents 批次归集对账结果。
 *  items: [{change_type, modified_at, object:{id, begin_at?}}]
 *  matches: 本地 data/matches.json 的 matches（用 mid 比对）
 *  window: {fromMs, toMs}（数据窗口，creation 漏抓判定用）
 *  返回 {createdMissed:[{mid,beginAt}], deleted:[{mid,match}], updated:count, maxModified} */
export function classifyIncidents(items, matches, window) {
  var byMid = {};
  (matches || []).forEach(function (m) {
    if (m && m.mid > 0 && !byMid[m.mid]) byMid[m.mid] = m;
  });
  var out = { createdMissed: [], deleted: [], updated: 0, maxModified: "" };
  (items || []).forEach(function (it) {
    if (!it || !it.object || !(it.object.id > 0)) return;
    if (it.modified_at && it.modified_at > out.maxModified) out.maxModified = it.modified_at;
    var mid = Math.floor(it.object.id);
    if (it.change_type === "creation") {
      var b = it.object.begin_at ? new Date(it.object.begin_at).getTime() : NaN;
      if (isFinite(b) && b >= window.fromMs && b <= window.toMs && !byMid[mid]) {
        out.createdMissed.push({ mid: mid, beginAt: it.object.begin_at });
      }
    } else if (it.change_type === "deletion") {
      if (byMid[mid]) out.deleted.push({ mid: mid, match: byMid[mid] });
    } else {
      out.updated += 1;
    }
  });
  return out;
}

/** 纯函数：游标推进（取批次内最大 modified_at 与旧游标的较大者——乱序/空批次都不回退；
 *  ISO 串字典序即时间序）。无任何值返回空串。 */
export function nextCursor(items, prev) {
  var max = "";
  (items || []).forEach(function (it) {
    if (it && typeof it.modified_at === "string" && it.modified_at > max) max = it.modified_at;
  });
  var prevS = prev || "";
  return max > prevS ? max : prevS;
}

async function main() {
  var token = process.env.PANDASCORE_TOKEN;
  if (!token) { log("未设置 PANDASCORE_TOKEN，跳过"); return; }
  var dry = process.argv.indexOf("--dry-run") >= 0;

  var cursorPath = path.join(ROOT, "data", "incidents-cursor.json");
  var cur = readJson(cursorPath, { v: 1, since: "" });
  var src = readJson(path.join(ROOT, "data", "matches.json"), null);
  if (!src || !Array.isArray(src.matches)) throw new Error("data/matches.json 不可用，先运行采集器");

  // 数据窗口（与采集器口径一致：过去 3 天 + 未来 10 天，宽一点防边界漏判）
  var now = Date.now();
  var window = { fromMs: now - 4 * 86400000, toMs: now + 11 * 86400000 };

  var firstRun = !cur.since;
  var all = [];
  var base = "/incidents?type=match&per_page=100";
  if (!firstRun) base += "&since=" + encodeURIComponent(cur.since);
  for (var p = 1; p <= MAX_PAGES; p++) {
    var items = await apiGet(base + "&page=" + p, token);
    all = all.concat(items);
    log("page " + p + ": " + items.length + " 条（累计 " + all.length + "）");
    if (items.length < 100) break;
    await sleep(1200);
  }

  if (firstRun) {
    // 首轮只建游标不发对账警告（无基线避免误报）；批次为空时游标起点=现在（保证下轮进入增量模式）
    var since0 = nextCursor(all, "") || new Date(now).toISOString();
    log("首轮：只建游标（" + since0 + "），不发对账警告");
    if (!dry) writeFileSync(cursorPath, JSON.stringify({ v: 1, since: since0, updatedAt: new Date(now).toISOString() }) + "\n", "utf8");
    return;
  }

  // 只处理严格晚于游标的事件（官方 since 语义按文档；防御重复计入）
  var sinceMs = new Date(cur.since).getTime();
  var fresh = all.filter(function (it) {
    if (!it || typeof it.modified_at !== "string") return false;
    var t = new Date(it.modified_at).getTime();
    return isFinite(t) && (!isFinite(sinceMs) || t > sinceMs);
  });
  log("自游标 " + cur.since + " 以来 " + fresh.length + " 条事件");

  var r = classifyIncidents(fresh, src.matches, window);
  log("对账：update " + r.updated + " · creation 漏抓疑似 " + r.createdMissed.length + " · deletion 仍持有 " + r.deleted.length);
  r.createdMissed.forEach(function (x) {
    console.warn("[incidents] ! 疑似漏抓新增：mid=" + x.mid + " beginAt=" + x.beginAt + "（窗口内本地无此 mid——全量重采应自愈，连续多轮出现才需排查）");
  });
  r.deleted.forEach(function (x) {
    console.warn("[incidents] ! 官方已删除但本地仍持有：mid=" + x.mid + " · " + x.match.tournament + " " + x.match.teamA.name + " vs " + x.match.teamB.name + "（不自动删——账本完整性优先）");
  });

  var since = nextCursor(fresh, cur.since);
  if (!dry) writeFileSync(cursorPath, JSON.stringify({ v: 1, since: since, updatedAt: new Date(now).toISOString() }) + "\n", "utf8");
  log("游标推进 → " + since + (dry ? "（dry-run 未写盘）" : ""));
}

main().catch(function (e) {
  console.error("[incidents] 失败：" + (e && e.message ? e.message : e));
  process.exit(1);
});
