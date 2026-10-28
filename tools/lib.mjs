/*
 * 采集器公共库：规范化、去重合并、校验、写出
 * 不依赖第三方包，Node 18+ 可直接运行。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SOURCE_PRIORITY = { manual: 3, liquipedia: 2, pandascore: 1 };

export function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 24);
}

export function shortName(name) {
  var raw = String(name || "").trim();
  if (!raw) return "TBD";
  if (/\s/.test(raw)) {
    var initials = raw
      .split(/\s+/)
      .map(function (w) { return w[0] || ""; })
      .join("")
      .toUpperCase();
    if (initials.length >= 2 && initials.length <= 4) return initials;
  }
  return raw.replace(/\s+/g, "").slice(0, 4).toUpperCase();
}

export function normalizeTeam(team) {
  if (!team) return null;
  if (typeof team === "string") {
    return { name: team, short: shortName(team), region: "", logo: "" };
  }
  var name = String(team.name || "").trim();
  if (!name) return null;
  return {
    name: name,
    short: String(team.short || "").trim() || shortName(name),
    region: String(team.region || "").trim(),
    logo: String(team.logo || "").trim()
  };
}

// 队标单独存「队名 → 路径」映射，不内联进每场比赛：3780 场内联约 +300KiB，映射只要 ~47KiB
export function collectTeamLogos(matches) {
  var map = {};
  (matches || []).forEach(function (m) {
    ["teamA", "teamB"].forEach(function (side) {
      var t = m && m[side];
      if (t && t.name && t.logo) map[t.name] = t.logo;
    });
  });
  return map;
}

export function stripTeamLogos(matches) {
  return (matches || []).map(function (m) {
    if (!m) return m;
    var copy = Object.assign({}, m);
    ["teamA", "teamB"].forEach(function (side) {
      if (copy[side] && copy[side].logo) {
        var t = Object.assign({}, copy[side]);
        delete t.logo;
        copy[side] = t;
      }
    });
    return copy;
  });
}

export function normalizeMatch(raw, source) {
  if (!raw || !raw.game) return null;
  var start = new Date(raw.startAt);
  if (isNaN(start.getTime())) return null;

  var teamA = normalizeTeam(raw.teamA);
  var teamB = normalizeTeam(raw.teamB);
  if (!teamA || !teamB) return null;

  var result = null;
  if (raw.result && (raw.result.winner === "A" || raw.result.winner === "B")) {
    result = {
      winner: raw.result.winner,
      score: String(raw.result.score || "").trim() || (raw.result.winner === "A" ? "1:0" : "0:1")
    };
  }

  var format = String(raw.format || "").toUpperCase();
  if (!/^BO\d+$/.test(format)) {
    var bestof = Number(raw.bestof || raw.bestOf || 0);
    format = bestof > 0 ? "BO" + bestof : "BO3";
  }

  var now = Date.now();
  var status = result ? "finished" : raw.status === "locked" || start.getTime() <= now ? "locked" : "open";

  return {
    id: String(raw.id || "").trim(),
    game: String(raw.game).toLowerCase(),
    tournament: String(raw.tournament || "未知赛事").trim(),
    stage: String(raw.stage || "赛程").trim(),
    startAt: start.toISOString(),
    format: format,
    tier: raw.tier ? String(raw.tier).toLowerCase() : "",
    teamA: teamA,
    teamB: teamB,
    status: status,
    result: result,
    note: raw.note ? String(raw.note) : "",
    source: source || raw.source || "manual"
  };
}

export function matchKey(m) {
  var d = new Date(m.startAt);
  var day = isNaN(d.getTime()) ? "nodate" : d.toISOString().slice(0, 10);
  return [m.game, day, slug(m.teamA.short || m.teamA.name), slug(m.teamB.short || m.teamB.name)].join("|");
}

function makeId(m, used) {
  var d = new Date(m.startAt);
  var stamp = isNaN(d.getTime())
    ? "00000000"
    : d.toISOString().slice(0, 10).replace(/-/g, "");
  var base = ["auto", m.game, stamp, slug(m.teamA.short || m.teamA.name), slug(m.teamB.short || m.teamB.name)]
    .filter(Boolean)
    .join("-");
  var id = base;
  var n = 2;
  while (used.has(id)) {
    id = base + "-" + n++;
  }
  used.add(id);
  return id;
}

/*
 * 合并规则：
 * 1. 同一场比赛（游戏 + 日期 + 双方）视为同一条记录
 * 2. 有赛果的数据优先于无赛果的
 * 3. 来源优先级：manual > liquipedia > pandascore
 * 4. 已存在的 id 和 note 尽量保留，避免下注记录对不上
 * 5. 自动来源的旧赛果按 retentionDays 清理；手工数据始终保留
 */
export function mergeMatches(existing, incoming, options) {
  var opts = options || {};
  var retentionDays = Number(opts.retentionDays || 30);
  var cutoff = Date.now() - retentionDays * 86400000;
  var usedIds = new Set();

  existing.forEach(function (m) { if (m.id) usedIds.add(m.id); });

  var map = new Map();
  existing.forEach(function (m) {
    var n = normalizeMatch(m, m.source || "manual");
    if (n) map.set(matchKey(n), n);
  });

  var added = 0;
  var updated = 0;

  incoming.forEach(function (raw) {
    var m = normalizeMatch(raw, raw.source);
    if (!m) return;
    var key = matchKey(m);
    var cur = map.get(key);

    if (!cur) {
      m.id = makeId(m, usedIds);
      map.set(key, m);
      added++;
      return;
    }

    var curP = SOURCE_PRIORITY[cur.source] || 0;
    var newP = SOURCE_PRIORITY[m.source] || 0;
    var curHasResult = !!(cur.result && cur.result.winner);
    var newHasResult = !!(m.result && m.result.winner);

    var shouldTake =
      (newHasResult && !curHasResult) ||
      newP > curP ||
      (newP === curP && (newHasResult || !curHasResult));

    if (shouldTake) {
      var merged = Object.assign({}, cur, m);
      merged.id = cur.id || m.id || makeId(m, usedIds);
      merged.note = m.note || cur.note || "";
      merged.source = newP >= curP ? m.source : cur.source;
      // 手工条目没有队标：沿用已有条目的，避免覆盖时丢图
      ["teamA", "teamB"].forEach(function (side) {
        if (merged[side] && cur[side] && !merged[side].logo && cur[side].logo) {
          merged[side] = Object.assign({}, merged[side], { logo: cur[side].logo });
        }
      });
      map.set(key, merged);
      updated++;
    }
  });

  var kept = [];
  var pruned = 0;
  map.forEach(function (m) {
    var isManual = m.source === "manual";
    var start = new Date(m.startAt).getTime();
    var expired = m.status === "finished" && start < cutoff;
    if (!isManual && expired) {
      pruned++;
      return;
    }
    kept.push(m);
  });

  kept.sort(function (a, b) { return new Date(a.startAt) - new Date(b.startAt); });

  return { matches: kept, added: added, updated: updated, pruned: pruned };
}

export function validateMatches(matches) {
  var errors = [];
  var ids = new Set();
  matches.forEach(function (m, i) {
    if (!m.id) errors.push("第 " + (i + 1) + " 条缺少 id");
    else if (ids.has(m.id)) errors.push("重复 id: " + m.id);
    else ids.add(m.id);
    if (!m.game) errors.push(m.id + " 缺少 game");
    if (isNaN(new Date(m.startAt).getTime())) errors.push(m.id + " startAt 非法");
    if (!m.teamA || !m.teamB) errors.push(m.id + " 缺少队伍");
    if (m.status === "finished" && (!m.result || !m.result.winner)) {
      errors.push(m.id + " 标记为 finished 但没有赛果");
    }
  });
  return errors;
}

export async function readExisting(root) {
  try {
    var raw = JSON.parse(await readFile(path.join(root, "data/matches.json"), "utf8"));
    return Array.isArray(raw.matches) ? raw.matches : [];
  } catch (e) {
    return [];
  }
}

export async function writeOutputs(root, matches) {
  var existing = null;
  try {
    existing = JSON.parse(await readFile(path.join(root, "data/matches.json"), "utf8"));
  } catch (e) { /* 首次运行没有旧文件 */ }

  // 数据没变化时保留旧 updatedAt，避免定时任务产生无意义提交
  var sameAsBefore = existing && Array.isArray(existing.matches) &&
    JSON.stringify(existing.matches) === JSON.stringify(matches);
  var updatedAt = sameAsBefore && existing.updatedAt ? existing.updatedAt : new Date().toISOString();

  var data = { updatedAt: updatedAt, matches: matches };
  var json = JSON.stringify(data, null, 2) + "\n";
  await writeFile(path.join(root, "data/matches.json"), json, "utf8");
}

export function summarize(matches) {
  var byGame = {};
  var byStatus = { open: 0, locked: 0, finished: 0 };
  matches.forEach(function (m) {
    byGame[m.game] = (byGame[m.game] || 0) + 1;
    if (byStatus[m.status] !== undefined) byStatus[m.status]++;
  });
  return { total: matches.length, byGame: byGame, byStatus: byStatus };
}
