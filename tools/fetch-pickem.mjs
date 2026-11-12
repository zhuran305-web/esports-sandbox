#!/usr/bin/env node
/*
 * Pick'Em 赛事聚合器（1.3 实验功能）
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
 *     tier: "a"|""（1.3.6 硬币改版：A 级币级整体降一级；s/Major/未知=""按 S 级）,
 *     stages: [{
 *       id, type: "swiss"|"bracket", label, startsAt, endsAt,
 *       teams: [{ name, short, region, logo, w, l }],          // 瑞士轮含胜负；bracket 为参赛 8 队
 *       matches: [{ id, a, b, startAt, winner: "A"|"B"|"", score, round? }], // round 仅 bracket（0 起）
 *       rounds?: ["四分之一决赛", "半决赛", "决赛"],             // 仅 bracket
 *       degraded?: true,                                        // 场次数与 expectRounds 不符（bracket 只展示不可猜；
 *                                                               // placement 名单齐 8 队仍可名次竞猜，1.3.6）
 *       results?: { adv30: [队名], adv: [], out23: [], out13: [], out03: [] } // 仅 swiss，阶段全部结束后填写
 *     }]
 *   }]
 * }
 * 阶段类型：swiss（16 队 10 选，coinTier=swiss 序号 1铜/2银/3金）/ bracket（旧类型，兼容保留）/
 * series（逐场猜，round=按北京日期聚类的轮次；币级按赛事 tier：a→铜、其余→银，1.3.6 起不再按轮数）/
 * placement（淘汰赛名次竞猜：冠军钻、亚/季军金；A 级整体降一级：冠军金、亚/季军银）。
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

function buildSwissStage(cfg, matches, structure) {
  var buckets = Array.isArray(cfg.buckets) && cfg.buckets.length ? cfg.buckets : DEFAULT_SWISS_BUCKETS;
  var list = matches.slice().sort(function (a, b) { return ts(a.startAt) - ts(b.startAt); });
  var teams = {};
  var order = [];
  // round = 按北京时间日期聚类的轮次（0 起）——树状展示用（1.3.6）；计分不看它
  var lastDay = "", round = 0;
  var compact = list.map(function (m) {
    var a = compactTeam(m.teamA), b = compactTeam(m.teamB);
    [a, b].forEach(function (t) {
      if (!t) return;
      if (!teams[t.name]) { teams[t.name] = t; teams[t.name].w = 0; teams[t.name].l = 0; order.push(t.name); }
      else if (!teams[t.name].short && t.short) teams[t.name].short = t.short;
    });
    // 脏 startAt 防炸（同 buildSeriesStage——new Date(NaN).toISOString() 抛 RangeError）
    var startT = new Date(m.startAt).getTime();
    var day = !isNaN(startT) ? new Date(startT + 8 * 3600000).toISOString().slice(0, 10) : "";
    if (lastDay && day && day !== lastDay) round += 1;
    if (day) lastDay = day;
    var winner = m.result && (m.result.winner === "A" || m.result.winner === "B") ? m.result.winner : "";
    if (winner === "A" && a) teams[a.name].w += 1;
    if (winner === "A" && b) teams[b.name].l += 1;
    if (winner === "B" && b) teams[b.name].w += 1;
    if (winner === "B" && a) teams[a.name].l += 1;
    return { id: m.id, a: a ? a.name : "", b: b ? b.name : "", startAt: m.startAt, winner: winner, score: (m.result && m.result.score) || "", round: round, canceled: m.canceled === true || undefined };
  });
  var teamList = order.map(function (n) { return teams[n]; })
    .sort(function (x, y) { return (y.w - x.w) || (x.l - y.l) || (x.name < y.name ? -1 : 1); });
  var starts = list.length ? list[0].startAt : "";
  var ends = list.length ? list[list.length - 1].startAt : "";
  // 延迟截止（2026-11-12，PGL Major Stage 1 需求）：pickOpenRounds=N → 竞猜开放到「已完赛 N 轮」后，
  // 截止 = 届时最早一场未开赛比赛 -1h（Swiss 配对时序保证那就是第 N+1 轮首场：上一轮没打完
  // 官方不会命名下一轮对阵）。阈值未到不下发 pickDeadline（客户端保持可猜，宁开勿锁）；
  // 客户端有同构镜像（swissPickDeadline），数据侧延迟时本地兜底。
  var pickOpenRounds = typeof cfg.pickOpenRounds === "number" && cfg.pickOpenRounds >= 1 && cfg.pickOpenRounds <= 5 ? Math.round(cfg.pickOpenRounds) : 0;
  var pickDeadline;
  if (pickOpenRounds && Object.keys(teams).length >= 2) {
    var per = Math.max(1, Math.round(Object.keys(teams).length / 2));
    var finished = compact.filter(function (m) { return m.winner || m.canceled; }).length;
    if (finished >= per * pickOpenRounds) {
      var minStart = Infinity;
      compact.forEach(function (m) {
        if (m.winner || m.canceled || !m.a || !m.b) return;
        var t = new Date(m.startAt).getTime();
        if (!isNaN(t) && t < minStart) minStart = t;
      });
      if (minStart !== Infinity) pickDeadline = minStart - 3600000; // 开赛前 1 小时（与客户端 PICKEM_DEADLINE_MS 同值）
    }
  }
  return {
    id: cfg.id, type: "swiss", label: cfg.label || cfg.id,
    startsAt: starts, endsAt: ends,
    pickOpenRounds: pickOpenRounds || undefined,
    pickDeadline: pickDeadline,
    teams: teamList, matches: compact,
    // 官方小组积分切片（2026-11-10，Major 瑞士轮同结构受益）
    standings: structure && Array.isArray(structure.standings) && structure.standings.length ? structure.standings.slice(0, 16) : undefined,
    results: swissResults(teamList, compact, buckets)
  };
}

/** records（战绩桶，1.3.12）：双败/循环小组赛按「最终战绩落位」预测——桶结构来自配置
 *  （k=战绩串 "W:L"，cap=该战绩队伍数）。队伍从首轮对阵即可全知；结果推导=按每队实际 W:L
 *  落桶（弃赛不计入 W/L），桶结构对不上（赛制意外/数据残缺）时宁缺勿滥返回 null。
 *  2026-11-10 加固：官方 standings（fetch-tournament-structures 抓取）存在时——①与自采派生
 *  W:L 交叉验证（不一致告警，漏采/弃赛失真自动纠正）②官方值作为落桶主证据。 */
function recordsResults(teamList, buckets, matches, standings) {
  var allDone = matches.length > 0 && matches.every(function (m) {
    return m.winner === "A" || m.winner === "B" || m.canceled === true;
  });
  if (!allDone) return null;
  var byName = {};
  (Array.isArray(standings) ? standings : []).forEach(function (s) {
    if (s && typeof s.t === "string") byName[s.t] = s;
  });
  var drift = [];
  teamList.forEach(function (t) {
    var s = byName[t.name];
    if (s && (s.w !== t.w || s.l !== t.l)) drift.push(t.name + " 派生" + t.w + ":" + t.l + "/官方" + s.w + ":" + s.l);
  });
  if (drift.length) log("  ! records 官方 standings 与自采派生 W:L 不一致（以官方为准）：" + drift.join("；"));
  var byBucket = {};
  buckets.forEach(function (b) { byBucket[b.k] = []; });
  var unbucketed = [];
  teamList.forEach(function (t) {
    var s = byName[t.name];
    var k = (s ? s.w : t.w) + ":" + (s ? s.l : t.l);
    if (byBucket[k]) byBucket[k].push(t.name);
    else unbucketed.push(t.name + " " + k);
  });
  var filled = buckets.every(function (b) { return byBucket[b.k].length === b.cap; });
  if (!filled) {
    console.warn("[fetch-pickem] records 实际战绩与桶结构不符（宁缺勿滥不出结果）：" + unbucketed.join(", "));
    return null;
  }
  return byBucket;
}

/** placement 结构推导（2026-11-10，bracket 前驱链主证据）：final=未被任何后继引用且带两个
 *  winner-前驱的场——冠军/亚军=final 胜/败者；季军=final 两个 winner-前驱的败者（半决赛败者
 *  并列两队）。经典 [4,2,1] 与含季军赛 [2,2,1,1]（IEM 北京实测）统一成立——季军赛本身是
 *  loser-前驱结构，不参与推导（胜者也按并列口径算季军）。结构意外/未全完赛返回 null（宁缺勿滥），
 *  round 启发式保留为 bracket 缺失时的兜底。 */
function bracketPlacementResults(structure) {
  if (!structure || !Array.isArray(structure.bracket) || structure.bracket.length < 3) return null;
  var bracket = structure.bracket;
  if (!bracket.every(function (b) { return b.st === "finished"; })) return null;
  var byMid = {};
  bracket.forEach(function (b) { byMid[b.mid] = b; });
  var isPrev = {};
  bracket.forEach(function (b) { b.prev.forEach(function (p) { isPrev[p.mid] = 1; }); });
  var gf = bracket.filter(function (b) {
    return !isPrev[b.mid] && b.prev.length === 2 && b.prev.every(function (p) { return p.type === "winner"; });
  });
  if (gf.length !== 1) return null;
  var final = gf[0];
  if (!final.w || !final.a || !final.b) return null;
  var s1 = byMid[final.prev[0].mid];
  var s2 = byMid[final.prev[1].mid];
  if (!s1 || !s2 || !s1.w || !s2.w || !s1.a || !s1.b || !s2.a || !s2.b) return null;
  var t1 = s1.w === s1.a ? s1.b : s1.a;
  var t2 = s2.w === s2.a ? s2.b : s2.a;
  if (!t1 || !t2 || t1 === t2) return null;
  return { champion: final.w, runnerUp: final.w === final.a ? final.b : final.a, third: [t1, t2] };
}

function buildRecordsStage(cfg, matches, structure) {
  var buckets = Array.isArray(cfg.buckets) ? cfg.buckets.filter(function (b) {
    return b && typeof b.k === "string" && /^\d+:\d+$/.test(b.k) && typeof b.cap === "number" && b.cap >= 1 && b.cap <= 8;
  }).slice(0, 8) : [];
  if (!buckets.length) {
    console.warn("[fetch-pickem] records 阶段缺少有效 buckets 配置，跳过：" + (cfg.id || cfg.label || "?"));
    return null;
  }
  var list = matches.slice().sort(function (a, b) { return ts(a.startAt) - ts(b.startAt); });
  var teams = {};
  var order = [];
  var lastDay = "", round = 0;
  var compact = list.map(function (m) {
    var a = compactTeam(m.teamA), b = compactTeam(m.teamB);
    [a, b].forEach(function (t) {
      if (!t) return;
      if (!teams[t.name]) { teams[t.name] = t; teams[t.name].w = 0; teams[t.name].l = 0; order.push(t.name); }
      else if (!teams[t.name].short && t.short) teams[t.name].short = t.short;
    });
    var startT = new Date(m.startAt).getTime();
    var day = !isNaN(startT) ? new Date(startT + 8 * 3600000).toISOString().slice(0, 10) : "";
    if (lastDay && day && day !== lastDay) round += 1;
    if (day) lastDay = day;
    var winner = m.result && (m.result.winner === "A" || m.result.winner === "B") ? m.result.winner : "";
    if (winner === "A" && a) teams[a.name].w += 1;
    if (winner === "A" && b) teams[b.name].l += 1;
    if (winner === "B" && b) teams[b.name].w += 1;
    if (winner === "B" && a) teams[a.name].l += 1;
    return { id: m.id, a: a ? a.name : "", b: b ? b.name : "", startAt: m.startAt, winner: winner, score: (m.result && m.result.score) || "", round: round, canceled: m.canceled === true || undefined };
  });
  var teamList = order.map(function (n) { return teams[n]; })
    .sort(function (x, y) { return (y.w - x.w) || (x.l - y.l) || (x.name < y.name ? -1 : 1); });
  var stage = {
    id: cfg.id, type: "records", label: cfg.label || cfg.id,
    coinTier: typeof cfg.coinTier === "number" && cfg.coinTier >= 1 && cfg.coinTier <= 3 ? Math.round(cfg.coinTier) : 1,
    startsAt: list.length ? list[0].startAt : "", endsAt: list.length ? list[list.length - 1].startAt : "",
    teams: teamList, matches: compact,
    buckets: buckets.map(function (b) { return { k: b.k, label: typeof b.label === "string" && b.label ? b.label : b.k, cap: Math.round(b.cap) }; }),
    // 官方小组积分切片（2026-11-10）：桶体展示用（客户端 normalizeStage 白名单放行，缺省省略）
    standings: structure && Array.isArray(structure.standings) && structure.standings.length ? structure.standings.slice(0, 16) : undefined,
    results: recordsResults(teamList, buckets, compact, structure && structure.standings)
  };
  return stage;
}

/* bracket 旧类型构建器已删（2026-11-11 清理）：历史数据零使用（聚合缓存/内嵌/配置均无
 * type=bracket），新配置用 placement——normalizeStage 拒收即历史事件整体丢弃不崩溃。 */

function buildSeriesStage(cfg, matches) {
  // 系列赛（逐场猜）：任意赛制皆可（双败/联赛/瑞士轮转写）——已结束场次随 matches 带出（只展示不参与计分）。
  // round = 按北京时间日期聚类的小组轮次（0 起）：GSL 双败每轮集中在同一天，第 1/2/3 轮对应铜/银/金币
  var list = matches.slice().sort(function (a, b) { return ts(a.startAt) - ts(b.startAt); });
  var teams = {};
  var order = [];
  var lastDay = "", round = 0;
  var compact = list.map(function (m) {
    var a = compactTeam(m.teamA), b = compactTeam(m.teamB);
    [a, b].forEach(function (t) {
      if (!t) return;
      if (!teams[t.name]) { teams[t.name] = t; order.push(t.name); }
    });
    // 脏 startAt 防炸：new Date(NaN).toISOString() 会抛 RangeError——CI 一条脏数据会炸掉当轮采集
    var startT = new Date(m.startAt).getTime();
    var day = !isNaN(startT) ? new Date(startT + 8 * 3600000).toISOString().slice(0, 10) : "";
    if (lastDay && day && day !== lastDay) round += 1; // 跨天即下一轮（IEM 每轮集中在一天；跨天赛制后续再适配）
    if (day) lastDay = day;
    var winner = m.result && (m.result.winner === "A" || m.result.winner === "B") ? m.result.winner : "";
    return { id: m.id, a: a ? a.name : "", b: b ? b.name : "", startAt: m.startAt, winner: winner, score: (m.result && m.result.score) || "", round: round, canceled: m.canceled === true || undefined };
  });
  return {
    id: cfg.id, type: "series", label: cfg.label || cfg.id,
    startsAt: list.length ? list[0].startAt : "", endsAt: list.length ? list[list.length - 1].startAt : "",
    teams: order.map(function (n) { return teams[n]; }),
    matches: compact
  };
}

/* 小组完赛自动推导晋级名单（2026-11-11）：placement 阶段可声明 qualifyFrom——
 * [{ stage: "groupA", buckets: ["2:0","1:1"] }, …]：源 records 阶段全部完赛（胜/负/取消）
 * 且每个声明桶**恰好落满 cap** 时，按桶序取桶内队伍为晋级名单。
 * 分布不符（出现配置外战绩，如 4进3 组打出 2:1）/未完赛/与 expectTeams 对不上——一律不推导
 * （宁缺勿滥，与 recordsResults 同族守卫；桶 cap 校验天然拦截数据异常）。
 * 优先级：配置显式 qualifiedTeams（人工覆盖）> 官方 rosters participants > 本推导。 */
function deriveQualifiedFromGroups(cfg, builtStages) {
  var qf = Array.isArray(cfg.qualifyFrom) ? cfg.qualifyFrom.filter(function (q) {
    return q && typeof q.stage === "string" && Array.isArray(q.buckets) &&
      q.buckets.length > 0 && q.buckets.every(function (b) { return typeof b === "string" && /^\d+:\d+$/.test(b); });
  }) : [];
  if (!qf.length) return null;
  var names = [], seen = {}, ok = true;
  for (var i = 0; i < qf.length && ok; i++) {
    var q = qf[i];
    var st = builtStages ? builtStages[q.stage] : null;
    if (!st || st.type !== "records") { ok = false; break; }
    var ms = st.matches || [];
    var done = ms.length > 0 && ms.every(function (m) { return m.winner === "A" || m.winner === "B" || m.canceled === true; });
    if (!done) { ok = false; break; }
    var byKey = {}, caps = {};
    (st.buckets || []).forEach(function (b) { caps[b.k] = b.cap; });
    (st.teams || []).forEach(function (t) {
      var k = t.w + ":" + t.l;
      (byKey[k] = byKey[k] || []).push(t.name);
    });
    for (var j = 0; j < q.buckets.length && ok; j++) {
      var bk = q.buckets[j];
      var cap = caps[bk];
      var got = byKey[bk] || [];
      if (!cap || got.length !== cap) { ok = false; break; }
      got.forEach(function (n) { if (!seen[n]) { seen[n] = 1; names.push(n); } });
    }
  }
  if (!ok) return null;
  var expectN = typeof cfg.expectTeams === "number" && cfg.expectTeams >= 2 ? Math.round(cfg.expectTeams) : 0;
  if (expectN && names.length !== expectN) {
    log("! " + (cfg.id || "?") + "：qualifyFrom 推导 " + names.length + " 队 ≠ expectTeams " + expectN + "，不播种（宁缺勿滥）");
    return null;
  }
  if (names.length < 2) return null;
  return { names: names, source: "qualifyFrom(" + qf.map(function (q) { return q.stage; }).join("+") + ")" };
}

function buildPlacementStage(cfg, matches, structure, builtStages) {
  // 淘汰赛名次竞猜：猜冠军（钻石币）/亚军（金币）/季军（金币，半决赛败者并列两队）；
  // A 级赛事（event.tier="a"）币级整体降一级：冠军金币/亚季军银币（币级在客户端 settleRewards 按 tier 决定）。
  // 轮次结构复用 bracket 的 [4,2,1] 切块，可用 expectRounds 覆盖（6 队轮空制=[2,2,1]，IEM 北京实测）；
  // expectTeams 声明参赛名单规模（轮空制=全部队伍数，与「首轮场次×2」不同），客户端按它判名单齐不齐；
  // qualifiedTeams 显式名单——轮空队不打首轮，只有他们排上后续场次才会进数据，不播种则名单永远不齐、
  // 而截止线（最早一场-1h）早已过去，名次竞猜永远开不了。
  // 2026-11-10 自动播种：qualifiedTeams 缺省时用官方 rosters 的 participants（fetch-tournament-structures）——
  // 人工补名单机制降级为覆盖手段；expectTeams 同理缺省取 participants.length。
  // 全部完赛后推导 results：bracket 前驱链为主证据（bracketPlacementResults），round 启发式兜底。
  var expect = Array.isArray(cfg.expectRounds) && cfg.expectRounds.length ? cfg.expectRounds : DEFAULT_EXPECT_ROUNDS;
  var list = matches.slice().sort(function (a, b) { return ts(a.startAt) - ts(b.startAt); });
  var teams = {};
  var order = [];
  var seedNames = Array.isArray(cfg.qualifiedTeams) ? cfg.qualifiedTeams.filter(function (n) { return typeof n === "string" && n; }) : [];
  var seedSource = seedNames.length ? "配置显式名单" : "";
  if (!seedNames.length && structure && Array.isArray(structure.participants) && structure.participants.length) {
    // 官方名单规模守卫（2026-11-11）：rosters 可能在晋级确定前列出未定/全部队伍——与 expectTeams
    // 声明规模不一致时不播种（宁缺勿滥），落到 qualifyFrom 推导或留空
    var expectN0 = typeof cfg.expectTeams === "number" && cfg.expectTeams >= 2 ? Math.round(cfg.expectTeams) : 0;
    if (!expectN0 || structure.participants.length === expectN0) {
      seedNames = structure.participants.slice(0, 16);
      seedSource = "官方 rosters";
    } else {
      log("! " + (cfg.id || "?") + "：官方 rosters " + structure.participants.length + " 队 ≠ expectTeams " + expectN0 + "，不采用（宁缺勿滥）");
    }
  }
  if (!seedNames.length) {
    var derived = deriveQualifiedFromGroups(cfg, builtStages);
    if (derived) {
      seedNames = derived.names;
      seedSource = derived.source;
      log("  " + (cfg.id || "?") + "：" + seedSource + " 自动推导晋级名单 " + seedNames.length + " 队：" + seedNames.join(" / "));
    }
  }
  seedNames.forEach(function (n) {
    if (!teams[n]) { teams[n] = { name: n, short: "", region: "", logo: "" }; order.push(n); }
  });
  var degraded = list.length !== expect.reduce(function (s, n) { return s + n; }, 0);
  var roundLabelCfg = Array.isArray(cfg.roundLabels) ? cfg.roundLabels : null; // _doc 宣称可配，2026-11-10 起真实现
  var roundLabels = [];
  var roundOf = {};
  if (!degraded) {
    var idx = 0;
    expect.forEach(function (n, ri) {
      roundLabels.push((roundLabelCfg && roundLabelCfg[ri]) || ROUND_LABELS[n] || "第 " + (ri + 1) + " 轮");
      for (var i = 0; i < n; i++) roundOf[idx++] = ri;
    });
  }
  var compact = list.map(function (m, i) {
    var a = compactTeam(m.teamA), b = compactTeam(m.teamB);
    [a, b].forEach(function (t) {
      if (!t) return;
      if (!teams[t.name]) { teams[t.name] = t; order.push(t.name); }
      else {
        // 播种队被实际比赛补全缩写/地区
        if (!teams[t.name].short && t.short) teams[t.name].short = t.short;
        if (!teams[t.name].region && t.region) teams[t.name].region = t.region;
      }
    });
    var winner = m.result && (m.result.winner === "A" || m.result.winner === "B") ? m.result.winner : "";
    return { id: m.id, a: a ? a.name : "", b: b ? b.name : "", startAt: m.startAt, winner: winner, score: (m.result && m.result.score) || "", round: degraded ? 0 : (roundOf[i] || 0), canceled: m.canceled === true || undefined };
  });
  var results = null;
  var allDone = list.length > 0 && compact.every(function (m) { return m.winner === "A" || m.winner === "B" || m.canceled === true; });
  // bracket 前驱链推导（2026-11-10 主证据）：自足于官方结构数据，expectRounds 配错（IEM 季军赛
  // 同族）不再吞掉结果；expectRounds 降级为校验目标——与 bracket 实际场次不符打告警。
  // degraded 语义不变（只影响展示/开放性，名单齐豁免照旧）。
  var bracketRes = bracketPlacementResults(structure);
  if (bracketRes) {
    results = bracketRes;
    if (Array.isArray(cfg.expectRounds) && cfg.expectRounds.length) {
      var sumExp = cfg.expectRounds.reduce(function (s, n) { return s + n; }, 0);
      if (sumExp !== structure.bracket.length) {
        log("! " + (cfg.id || "?") + "：expectRounds 合计 " + sumExp + " 场 ≠ bracket 实际 " + structure.bracket.length + " 场（结果已按 bracket 推导；配置建议核对真实赛制）");
      }
    }
  } else if (!degraded && allDone) {
    var finalM = compact.filter(function (m) { return m.round === expect.length - 1; })[0];
    if (finalM) {
      var champion = finalM.winner === "A" ? finalM.a : finalM.b;
      var runnerUp = finalM.winner === "A" ? finalM.b : finalM.a;
      // 半决赛败者（季军并列两队）＝「决赛队的倒数第二场比赛的败者」——对两种结构都成立：
      // 经典 [4,2,1]：决赛队倒数第二场=半决赛，败者即季军；含季军赛的 [2,2,1,1]（IEM 北京
      // 实测：半决赛败者之间还打一场季军赛，决赛队不打季军赛）：决赛队倒数第二场仍是半决赛。
      // 季军赛本身不参与推导（胜者也按并列口径算季军——用户在季军赛排期前按「猜中任一半决赛
      // 败者即对」下的单）。compact 已按开始时间排序。
      var semiLoser = function (team) {
        var games = compact.filter(function (m) {
          return m.winner && (m.a === team || m.b === team);
        });
        if (games.length < 2) return null;
        var semi = games[games.length - 2];
        return semi.winner === "A" ? semi.b : semi.a;
      };
      var t1 = semiLoser(champion);
      var t2 = semiLoser(runnerUp);
      if (t1 && t2) results = { champion: champion, runnerUp: runnerUp, third: [t1, t2] };
    }
  }
  return {
    id: cfg.id, type: "placement", label: cfg.label || cfg.id,
    startsAt: list.length ? list[0].startAt : "", endsAt: list.length ? list[list.length - 1].startAt : "",
    teams: order.map(function (n) { return teams[n]; }),
    matches: compact,
    rounds: degraded ? [] : roundLabels,
    degraded: degraded,
    expectTeams: typeof cfg.expectTeams === "number" && cfg.expectTeams >= 2 ? Math.min(16, Math.round(cfg.expectTeams))
      : (structure && Array.isArray(structure.participants) && structure.participants.length >= 2 ? Math.min(16, structure.participants.length) : 0),
    results: results
  };
}

function buildEvent(cfg, allMatches, cachedEvent, structures) {
  var evMatches = allMatches.filter(function (m) {
    return m.game === cfg.game && m.tournament === cfg.tournament;
  });
  var stages = [];
  var builtById = {}; // 已构建阶段（qualifyFrom 推导晋级名单的源：按 id 取 records 阶段的完赛分布）
  var swissOrdinal = 0;
  (cfg.stages || []).forEach(function (scfg) {
    var sm = evMatches.filter(function (m) { return (scfg.stageNames || []).indexOf(m.stage) >= 0; });
    if (!sm.length) return; // 该阶段还没有任何数据（未排期/拼写对不上），宁缺勿滥
    // 官方结构数据（2026-11-10）：键与 matches 的 (game, tournament 串, stage) 对齐，
    // 逐 stageNames 尝试（配置可声明多个 stage 名）
    var structure = null;
    if (structures) {
      var names = Array.isArray(scfg.stageNames) ? scfg.stageNames : [];
      for (var ni = 0; ni < names.length; ni++) {
        if (structures[cfg.game + "|" + cfg.tournament + "|" + names[ni]]) {
          structure = structures[cfg.game + "|" + cfg.tournament + "|" + names[ni]];
          break;
        }
      }
    }
    if (scfg.type === "series") { var ss = buildSeriesStage(scfg, sm); if (ss) { stages.push(ss); builtById[ss.id] = ss; } }
    else if (scfg.type === "placement") { var ps = buildPlacementStage(scfg, sm, structure, builtById); if (ps) { stages.push(ps); builtById[ps.id] = ps; } }
    else if (scfg.type === "records") {
      var recStage = buildRecordsStage(scfg, sm, structure);
      if (recStage) { stages.push(recStage); builtById[recStage.id] = recStage; }
    }
    else {
      // 瑞士轮：coinTier 按 swiss 阶段序号（第 1 个=铜、第 2 个=银、第 3 个及以后=金）——major 三阶段对应
      swissOrdinal += 1;
      var stage = buildSwissStage(scfg, sm, structure);
      stage.coinTier = Math.min(swissOrdinal, 3);
      stages.push(stage);
    }
  });
  // 按配置顺序逐段合并：本轮重建出的阶段优先；缓存里对应阶段（早期比赛被 retention 清掉、本轮重建不出时）保留。
  // （旧逻辑对 done 事件整体跳过重建——小组赛先打完就把事件提前标成 done，之后排期出来的淘汰赛永远进不了
  //   聚合数据，作业页一直显示「已结束」且名次竞猜被冻结。1.3.7 修复：改为逐段合并 + 状态考虑未排期阶段。）
  var rebuiltById = {};
  stages.forEach(function (s) { rebuiltById[s.id] = s; });
  var mergedStages = [];
  var pendingConfigured = false; // 配置声明了但本轮与缓存都没有的阶段：说明还有比赛未排期，事件不算完结
  (cfg.stages || []).forEach(function (scfg) {
    if (rebuiltById[scfg.id]) { mergedStages.push(rebuiltById[scfg.id]); return; }
    var cs = cachedEvent && Array.isArray(cachedEvent.stages)
      ? cachedEvent.stages.filter(function (s) { return s.id === scfg.id; })[0] : null;
    if (cs) mergedStages.push(cs);
    else pendingConfigured = true;
  });
  // 防御：重建出但配置没有的阶段保留在尾部（不丢数据）
  stages.forEach(function (s) {
    if (!mergedStages.some(function (m) { return m.id === s.id; })) mergedStages.push(s);
  });
  if (!mergedStages.length) return null;
  var allDone = mergedStages.length > 0 && !pendingConfigured && mergedStages.every(function (s) {
    return s.matches.length > 0 && s.matches.every(function (m) { return m.winner === "A" || m.winner === "B"; });
  });
  var anyStarted = mergedStages.some(function (s) { return s.matches.some(function (m) { return m.winner || ts(m.startAt) <= Date.now(); }); });
  var lastStart = 0;
  mergedStages.forEach(function (s) { s.matches.forEach(function (m) { lastStart = Math.max(lastStart, ts(m.startAt)); }); });
  var matched = mergedStages.reduce(function (n, s) { return n + s.matches.length; }, 0);
  if (evMatches.length !== matched) {
    log("  ! " + cfg.id + "：赛事共 " + evMatches.length + " 场，仅 " + matched + " 场匹配到已配置阶段（stage 原文核对配置）");
  }
  return {
    id: cfg.id, game: cfg.game, name: cfg.name || cfg.id,
    tournament: cfg.tournament, // 自动收录去重键（客户端 pickemManualTournaments 收集）
    // 赛事等级（1.3.6 硬币改版）：全部场次 tier=a 才算 A 级（币级整体降一级）；s/Major/混合一律 "" 按 S 级
    tier: evMatches.length && evMatches.every(function (m) { return m.tier === "a"; }) ? "a" : "",
    status: allDone ? "done" : (anyStarted ? "active" : "upcoming"),
    endsAt: lastStart ? new Date(lastStart + 12 * 3600000).toISOString() : "",
    stages: mergedStages
  };
}

async function main() {
  var cfgPath = path.join(ROOT, "data", CONFIG_KEY);
  var cachePath = path.join(ROOT, "data", CACHE_KEY);
  var srcPath = path.join(ROOT, "data", "matches.json");
  var cfg = readJson(cfgPath, { events: [] });
  var cache = readJson(cachePath, { v: 1, events: [] });
  var src = readJson(srcPath, null);
  // 官方结构数据（2026-11-10）：fetch-tournament-structures 的产物（rosters/standings/brackets），
  // 仍属本地输入——本工具保持零网络
  var structsRaw = readJson(path.join(ROOT, "data", "tournament-structures.json"), { structures: {} });
  var structures = structsRaw && structsRaw.structures ? structsRaw.structures : {};
  if (!src || !Array.isArray(src.matches)) throw new Error("data/matches.json 不可用，先运行采集器");

  var events = {};
  (cache.events || []).forEach(function (e) { if (e && e.id) events[e.id] = e; });

  var built = 0;
  (cfg.events || []).forEach(function (c) {
    if (!c || !c.id || !c.game || !c.tournament || !Array.isArray(c.stages) || !c.stages.length) return;
    var cached = events[c.id];
    // 每轮都重建并按阶段合并（buildEvent）：done 事件整体跳过的旧逻辑会把「小组赛先打完 → 提前 done →
    // 之后排期出来的淘汰赛永远进不了聚合」冻结住（1.3.7 修复；retention 保护由逐段合并承担）
    var ev = buildEvent(c, src.matches, cached, structures);
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
