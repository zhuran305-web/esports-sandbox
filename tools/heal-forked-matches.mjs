/*
 * 孪生条目治愈脚本（2026-11-07，一次性修复 + 可重复运行幂等）
 *
 * 背景：mergeMatches 的 matchKey 用「队简称有序拼接」派生。PandaScore 重取同一fixture 时
 * 会交换主客顺序、也会编辑队名/简称（DC→DEN、SINQ→SINQU、NAOC→NCP）——键一变，同一场比赛
 * 裂成两条：旧条目永久收不到赛果（status 冻结在 locked），新条目正常更新。
 * 实测存量 74 组孪生（41 组卡死 + 33 组双完成）。lib.mjs 已改用 pid 主键防再裂；本脚本
 * 治愈存量：给「同 fixture 的卡死孪生」补写真实赛果——**不删除任何条目**（卡死条目上可能有
 * 用户竞猜/对决记录，删除会让投入永远无法结算；补赛果让双方都能正确结算，重复行由 45 天
 * retention 自然消化）。
 *
 * 判定口径（保守）：同 game + 同 UTC 日 + 队名集合（无序）相同 + 开赛时间差 ≤60 分钟 +
 * id 不同。同队同日真打两场（败者组/决赛重置）间隔远大于 60 分钟，不会误伤。
 *
 * 用法：node tools/heal-forked-matches.mjs [--dry-run]
 * 修复后需同步三处：runtime:build + runtime:publish（OSS）+ Release 基线回传
 * （CI 每轮从 Release 恢复基线，不回传会被下轮采集覆盖回去——流程 W 第 4 步同款）。
 */
import { readFileSync, writeFileSync } from "node:fs";

var DRY = process.argv.includes("--dry-run");
function log(message) { console.log("[heal] " + message); }

var file = new URL("../data/matches.json", import.meta.url);
var data = JSON.parse(readFileSync(file, "utf8"));
var matches = data.matches || [];

function nameSet(m) {
  return [m.teamA && m.teamA.name, m.teamB && m.teamB.name]
    .map(function (n) { return String(n || "").trim(); })
    .sort()
    .join("§");
}

// 分组：game + UTC 日 + 无序队名集合
var groups = new Map();
matches.forEach(function (m) {
  if (!m || !m.teamA || !m.teamB) return;
  var d = new Date(m.startAt);
  if (isNaN(d.getTime())) return;
  var k = m.game + "|" + d.toISOString().slice(0, 10) + "|" + nameSet(m);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(m);
});

// 组内按 Δt≤60min 聚成孪生簇
function twinsIn(arr) {
  var clusters = [];
  arr.forEach(function (m) {
    var c = clusters.find(function (list) {
      return list.some(function (x) { return Math.abs(Date.parse(x.startAt) - Date.parse(m.startAt)) <= 60 * 60 * 1000; });
    });
    if (c) c.push(m); else clusters.push([m]);
  });
  return clusters.filter(function (list) { return list.length > 1; });
}

var healed = 0, alreadyOk = 0, futureForks = 0, conflicts = 0, skippedNoId = 0;
var healedIds = [];

groups.forEach(function (arr) {
  twinsIn(arr).forEach(function (cluster) {
    if (cluster.some(function (m) { return !m.id; })) { skippedNoId++; return; }
    // 结果对齐校验：各完赛成员的 winner 按队名对齐后必须一致，矛盾则放弃（不猜）。
    // 比分串要按「胜方:负方」归一后再比（主客顺序不同时 1:2 与 2:1 是同一场）；
    // 有 winner 无 score 的成员是治愈对象不是 source，不参与比分一致性检查
    var aligned = cluster.map(function (m) {
      if (!(m.result && m.result.winner)) return null;
      // winner 以「队名集合中字典序较小的队」为参照归一，避免主客口径不同
      var names = nameSet(m).split("§");
      var refName = names[0];
      var winnerName = m.result.winner === "A" ? m.teamA.name : m.teamB.name;
      var hasScore = !!String(m.result.score || "").trim() && m.result.score.indexOf(":") > 0;
      var sp = String(m.result.score || "").split(":");
      var wScore = m.result.winner === "A" ? sp[0] : sp[1];
      var lScore = m.result.winner === "A" ? sp[1] : sp[0];
      return { m: m, refWinnerIsRef: winnerName === refName, hasScore: hasScore, normalized: wScore + ":" + lScore };
    }).filter(Boolean);
    var refs = new Set(aligned.map(function (a) { return a.refWinnerIsRef ? "ref" : "other"; }));
    var sources = aligned.filter(function (a) { return a.hasScore; });
    var scores = new Set(sources.map(function (a) { return a.normalized; }));
    if (refs.size > 1 || (sources.length > 1 && scores.size > 1)) {
      conflicts++;
      log("⚠ 结果矛盾，跳过：" + cluster.map(function (m) { return m.id; }).join(" <=> "));
      return;
    }
    if (!sources.length) { futureForks++; return; } // 无可比对来源（未来场次先fork：等赛果落地后下轮自愈）
    var source = sources[0];
    var refName = nameSet(source.m).split("§")[0];

    cluster.forEach(function (target) {
      if (target.canceled) { alreadyOk++; return; } // 真取消不补赛果
      var needsWinner = !(target.result && target.result.winner);
      var needsScore = !needsWinner && !String((target.result && target.result.score) || "").trim();
      if (!needsWinner && !needsScore) { alreadyOk++; return; }
      var winnerName = source.refWinnerIsRef ? refName : nameSet(source.m).split("§")[1];
      var targetWinner = needsWinner ? (target.teamA.name === winnerName ? "A" : "B") : target.result.winner;
      // 比分对齐：target 与 source 的胜方字母同位（A/A 或 B/B）→ 同序原样；否则交换
      var scoreParts = String(source.m.result.score || "").split(":");
      var sameLetterPos = targetWinner === source.m.result.winner;
      var targetScore = sameLetterPos
        ? source.m.result.score
        : (scoreParts.length === 2 ? scoreParts[1] + ":" + scoreParts[0] : source.m.result.score);
      if (DRY) {
        log("DRY " + target.id + " ← " + source.m.id + " winner=" + targetWinner + " score=" + targetScore);
      } else if (needsWinner) {
        target.result = { winner: targetWinner, score: targetScore };
        target.status = "finished";
        if (!target.endAt && source.m.endAt) target.endAt = source.m.endAt;
        ["teamA", "teamB"].forEach(function (side) {
          if (target[side] && source.m[side] && !target[side].logo && source.m[side].logo) {
            target[side].logo = source.m[side].logo;
          }
          if (target[side] && source.m[side] && !target[side].region && source.m[side].region) {
            target[side].region = source.m[side].region;
          }
        });
      } else {
        target.result.score = targetScore; // 仅补比分（上轮 winner 已落）
      }
      healed++;
      healedIds.push(target.id + " ← " + source.m.id);
    });
  });
});

log("统计：补赛果 " + healed + " · 本已完赛 " + alreadyOk + " · 未赛先裂（等自愈）" + futureForks +
  " · 结果矛盾跳过 " + conflicts + " · 缺 id 跳过 " + skippedNoId);
if (healedIds.length) log("清单（前 10）：" + healedIds.slice(0, 10).join(" | "));

if (!DRY && healed > 0) {
  data.updatedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  log("已写回 data/matches.json（updatedAt=" + data.updatedAt + "）");
} else if (DRY) {
  log("dry-run，未写盘");
} else {
  log("无需修复");
}
