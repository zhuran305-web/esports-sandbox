#!/usr/bin/env node
/*
 * 赛事结构抓取器（2026-11-10，PandaScore 结构化数据接入）
 * ------------------------------------------------------------
 * 用法：node tools/fetch-tournament-structures.mjs [--dry-run] [--force] [--max=12]
 *
 * 对 Pick'Em 相关赛事（窗口内 tier=s/a 或手工配置引用）按 **阶段级 tournament id（tid）**
 * 抓取三个官方端点（全部 "available to all customers"）：
 *   GET /tournaments/{tid}/rosters   → {rosters:[{name, players}]}   参赛名单（队）
 *   GET /tournaments/{tid}/standings → 积分表（开赛前返回 {"error":"Record not found"}，须容错）
 *   GET /tournaments/{tid}/brackets  → [{id, status, previous_matches:[{match_id,type}]}] 淘汰赛前驱链
 *
 * 产出 data/tournament-structures.json（Release 资产累积 + build-runtime/trim 切片进 runtime）：
 *   { v:1, updatedAt, structures: { "game|tournament|stage": {tid, participants, standings, bracket, at, finished} } }
 * 客户端消费 participants/standings（bracket 仅数据侧推导用，不下发）；键与 matches 的
 * (game, tournament 串, stage) 对齐——客户端/聚合器不需要 tid 即可查询。
 *
 * 凭据只走环境变量 PANDASCORE_TOKEN（CI=Secret；本地运行内联注入，不落任何文件）。
 * 确定性序列化：同内容 → 同字节（at 保留旧值），防 meta hash 无谓翻转。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var API = "https://api.pandascore.co";
var RATE_MS = 1200;          // 与 pandascore.mjs 同步的请求间隔
var FRESH_MS = 60 * 60000;   // 60 分钟内抓过且未完赛 → 跳过（每小时 CI 节奏防重复）
var MAX_STRUCTS = 256;       // 缓存 LRU 封顶（每条 1-4KB）
var MAX_PARTICIPANTS = 32;
var MAX_STANDINGS = 16;
var MAX_BRACKET = 64;

function arg(name, dft) {
  var i = process.argv.indexOf("--" + name);
  if (i >= 0) {
    var v = process.argv[i + 1];
    if (v && /^\d+$/.test(v)) return Number(v);
    return true;
  }
  return dft;
}
var DRY = arg("dry-run", false) === true;
var FORCE = arg("force", false) === true;
var MAX_RUN = arg("max", 12);

function log(msg) { console.log("[structures] " + msg); }

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")) || fallback; } catch (e) { return fallback; }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function apiGet(pathname, token) {
  // 404=该赛事无此数据（standings 赛前就是 Record not found）→ 返回 null 由调用方当空处理
  for (var attempt = 1; attempt <= 3; attempt++) {
    var res = await fetch(API + pathname, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
      signal: AbortSignal.timeout(25000)
    });
    if (res.status === 429) {
      if (attempt >= 3) { log("  429 放弃：" + pathname); return { skip: true }; }
      log("  429 退避 45s（第 " + attempt + " 次）");
      await sleep(45000);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) return { err: "HTTP " + res.status };
    var body = await res.json();
    return { body: body };
  }
  return { skip: true };
}

/* ---------- 响应规范化（按 2026-11-10 实测形态，容忍字段演进） ---------- */

function normParticipants(body) {
  var list = body && Array.isArray(body.rosters) ? body.rosters : (Array.isArray(body) ? body : null);
  if (!list) return [];
  var out = [];
  list.forEach(function (r) {
    var name = r && typeof r.name === "string" ? r.name.trim() : "";
    if (name && out.indexOf(name) < 0) out.push(name);
  });
  return out.sort(function (a, b) { return a < b ? -1 : 1; }).slice(0, MAX_PARTICIPANTS);
}

function normStandings(body) {
  // 形态未知（开赛前 404）：数组行里兼容多种字段路径；未知形态打印样本供 CI 日志核对
  var list = Array.isArray(body) ? body
    : body && Array.isArray(body.standings) ? body.standings : null;
  if (!list) {
    if (body && typeof body === "object" && !body.error) {
      log("  ! standings 未知形态样本: " + JSON.stringify(body).slice(0, 200));
    }
    return [];
  }
  var out = [];
  list.forEach(function (row) {
    if (!row || typeof row !== "object") return;
    var team = row.team && typeof row.team === "object" ? row.team : row;
    var name = typeof team.name === "string" && team.name ? team.name
      : typeof team.acronym === "string" ? team.acronym : "";
    var stats = row.stats && typeof row.stats === "object" ? row.stats : row;
    var w = Number(stats.wins !== undefined ? stats.wins : stats.w);
    var l = Number(stats.losses !== undefined ? stats.losses : stats.l);
    if (name && isFinite(w) && isFinite(l) && w >= 0 && l >= 0) {
      out.push({ t: name, w: Math.floor(w), l: Math.floor(l) });
    }
  });
  out.sort(function (a, b) { return (b.w - a.w) || (a.l - b.l) || (a.t < b.t ? -1 : 1); });
  return out.slice(0, MAX_STANDINGS);
}

function normBracket(body) {
  var list = Array.isArray(body) ? body : [];
  var out = [];
  list.forEach(function (m) {
    if (!m || !(m.id > 0)) return;
    var prev = (Array.isArray(m.previous_matches) ? m.previous_matches : []).map(function (p) {
      return { mid: p && p.match_id > 0 ? Math.floor(p.match_id) : 0, type: p && p.type === "loser" ? "loser" : "winner" };
    }).filter(function (p) { return p.mid > 0; });
    // 双方与胜者名（placement 结构推导要自足——不依赖我们自己的 match 数据是否齐）：
    // opponents=[{opponent:{id,name}}]，winner_id 指向其中之一；TBD 时为空串
    var ops = (Array.isArray(m.opponents) ? m.opponents : []).map(function (o) { return o && o.opponent ? o.opponent : {}; });
    var a = ops[0] && typeof ops[0].name === "string" ? ops[0].name : "";
    var b = ops[1] && typeof ops[1].name === "string" ? ops[1].name : "";
    var w = "";
    if (m.winner_id && a && b) {
      if (m.winner_id === ops[0].id) w = a;
      else if (m.winner_id === ops[1].id) w = b;
    }
    out.push({ mid: Math.floor(m.id), st: typeof m.status === "string" ? m.status : "", a: a, b: b, w: w, prev: prev });
  });
  out.sort(function (a, b) { return a.mid - b.mid; });
  return out.slice(0, MAX_BRACKET);
}

/* ---------- 主流程 ---------- */

async function main() {
  var token = process.env.PANDASCORE_TOKEN;
  if (!token) { log("未设置 PANDASCORE_TOKEN，跳过"); return; }

  var src = readJson(path.join(ROOT, "data", "matches.json"), null);
  if (!src || !Array.isArray(src.matches)) throw new Error("data/matches.json 不可用，先运行采集器");
  var cfg = readJson(path.join(ROOT, "data", "pickem-events.json"), { events: [] });
  var cache = readJson(path.join(ROOT, "data", "tournament-structures.json"), { v: 1, updatedAt: "", structures: {} });
  var structs = cache.structures || {};

  // 手工配置引用的 tournament 串（tier 不达 s/a 也要抓——placement/records 的播种与校验靠它）
  var manualTournaments = {};
  (cfg.events || []).forEach(function (e) { if (e && e.tournament) manualTournaments[e.tournament] = 1; });

  // 目标集：窗口内 (game|tournament|stage) 分组，任一场 tier=s/a 或命中手工配置；tid 取组内首个
  var groups = {};
  src.matches.forEach(function (m) {
    if (!m || !m.game || !m.tournament || !m.stage) return;
    var isSA = m.tier === "s" || m.tier === "a";
    if (!isSA && !manualTournaments[m.tournament]) return;
    var key = m.game + "|" + m.tournament + "|" + m.stage;
    if (!groups[key]) groups[key] = { tid: 0, allDone: true, count: 0, earliest: Infinity };
    var g = groups[key];
    if (!g.tid && m.tid > 0) g.tid = Math.floor(m.tid);
    g.count += 1;
    var t0 = new Date(m.startAt).getTime();
    if (isFinite(t0) && t0 < g.earliest) g.earliest = t0;
    var done = (m.result && m.result.winner) || m.canceled === true;
    if (!done) g.allDone = false;
  });

  var targets = Object.keys(groups).filter(function (k) { return groups[k].tid > 0; });
  // 已完赛且缓存里没有 bracket 数据的组无法判 finished——只要组内场次全完赛就标 finished 定格
  var now = Date.now();
  var pending = [];
  targets.forEach(function (k) {
    var g = groups[k];
    var old = structs[k];
    if (!FORCE) {
      if (old && old.finished) return;
      if (old && old.at && now - old.at < FRESH_MS) return;
      if (old && old.at && g.allDone && old.tid === g.tid) {
        // 组内全完赛但上次抓取时未必拿到终态 standings/bracket——完赛后强制再抓一次
        if (old.finished) return;
      }
    }
    if (old && old.tid !== g.tid) { /* tid 变了（罕见）照常重抓 */ }
    pending.push(k);
  });
  log("目标 " + targets.length + " 组，本轮待抓 " + pending.length + "（--max=" + MAX_RUN + "）");
  // 优先级：组内最早开赛时间升序——进行中/临场赛事（如当前公测 BLAST）优先于远期赛事，
  // --max 截断不会把要紧的组挤掉；未缓存组天然参与排序（远期未缓存组靠后续轮次收敛）
  pending.sort(function (a, b) { return (groups[a].earliest || Infinity) - (groups[b].earliest || Infinity); });
  pending = pending.slice(0, MAX_RUN);

  var fetched = 0, skipped404 = 0, errors = 0;
  for (var i = 0; i < pending.length; i++) {
    var key = pending[i];
    var g = groups[key];
    var parts = key.split("|");
    log("[" + (i + 1) + "/" + pending.length + "] " + key + " (tid " + g.tid + ")");
    var rostersRes = await apiGet("/tournaments/" + g.tid + "/rosters", token);
    await sleep(RATE_MS);
    var standingsRes = await apiGet("/tournaments/" + g.tid + "/standings", token);
    await sleep(RATE_MS);
    var bracketRes = await apiGet("/tournaments/" + g.tid + "/brackets", token);
    await sleep(RATE_MS);

    if (rostersRes && rostersRes.err || standingsRes && standingsRes.err || bracketRes && bracketRes.err) {
      errors++;
      log("  ! 抓取失败，本轮跳过该组");
      continue;
    }
    if (!rostersRes || rostersRes.skip) rostersRes = null;
    if (!standingsRes || standingsRes.skip) standingsRes = null;
    if (!bracketRes || bracketRes.skip) bracketRes = null;
    if (!rostersRes && !standingsRes && !bracketRes) { skipped404++; }

    var participants = rostersRes ? normParticipants(rostersRes.body) : (structs[key] ? structs[key].participants || [] : []);
    var standings = standingsRes ? normStandings(standingsRes.body) : (structs[key] ? structs[key].standings || [] : []);
    var bracket = bracketRes ? normBracket(bracketRes.body) : (structs[key] ? structs[key].bracket || [] : []);

    // finished 判定：组内已知场次全完赛/弃赛，且 bracket（若有）全部 finished
    var bracketDone = bracket.length === 0 || bracket.every(function (b) { return b.st === "finished"; });
    var isFinished = g.allDone && bracketDone;

    var next = {
      tid: g.tid,
      participants: participants,
      standings: standings,
      bracket: bracket,
      at: now,
      finished: isFinished
    };
    // 内容相同 → 保留旧 at（字节不变，meta hash 不翻）
    var old = structs[key];
    if (old && old.tid === next.tid &&
      JSON.stringify(old.participants) === JSON.stringify(next.participants) &&
      JSON.stringify(old.standings) === JSON.stringify(next.standings) &&
      JSON.stringify(old.bracket) === JSON.stringify(next.bracket) &&
      old.finished === next.finished) {
      next.at = old.at;
    } else {
      log("  变更：participants " + participants.length + " · standings " + standings.length + " · bracket " + bracket.length + " · finished=" + isFinished);
    }
    structs[key] = next;
    fetched++;
  }

  // LRU 淘汰：超封顶按 at 最旧移除（finished 条目内容定格，价值最低）
  var keys = Object.keys(structs);
  if (keys.length > MAX_STRUCTS) {
    keys.sort(function (a, b) { return (structs[a].at || 0) - (structs[b].at || 0); });
    keys.slice(0, keys.length - MAX_STRUCTS).forEach(function (k) { delete structs[k]; });
  }

  var out = { v: 1, updatedAt: new Date(now).toISOString(), structures: structs };
  // 确定性：structs 键序 = 首次写入序且条目按插入序更新，同内容 → 同字节（at 保留旧值）
  var body = JSON.stringify(out);
  if (!DRY) {
    writeFileSync(path.join(ROOT, "data", "tournament-structures.json"), body + "\n", "utf8");
  }
  log("完成：抓 " + fetched + " · 404 " + skipped404 + " · 失败 " + errors + " · 缓存 " + Object.keys(structs).length + " 条 · " + (body.length / 1024).toFixed(1) + " KiB" + (DRY ? "（dry-run 未写盘）" : ""));
}

main().catch(function (e) {
  console.error("[structures] 失败：" + (e && e.message ? e.message : e));
  process.exit(1);
});
