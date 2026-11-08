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
  var pid = Number(team.pid);
  return {
    name: name,
    short: String(team.short || "").trim() || shortName(name),
    region: String(team.region || "").trim(),
    logo: String(team.logo || "").trim(),
    // PandaScore opponent.id：队伍级稳定标识（team-ids 管线/选手管线引用）。
    // 注意：同两队可有多场交锋——pid 对拼不能当「同场键」（11-08 事故，见 matchMidKey）；
    // 无 pid 的来源（manual/liquipedia/旧数据）为 undefined，JSON.stringify 自动省略
    pid: pid > 0 ? Math.floor(pid) : undefined
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
  // 运行时/内嵌快照的字段瘦身（1.3.10 优化）：剥内联队标 + 剔除客户端未使用字段——
  // bestof（客户端只用 format 字符串，grep 零引用）、空 note（4437/4438 为空，有值保留供详情页备注）。
  // 源数据 data/matches.json 不受影响（采集/合并/图鉴 45 天战绩仍用全量字段）。
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
    if (copy.bestof !== undefined) delete copy.bestof;
    if (copy.mid !== undefined) delete copy.mid; // 客户端零引用（仅服务端合并用），省运行时包
    if (!copy.note) delete copy.note;
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

  // 实际结束时间（PandaScore end_at；缺失/非法存空串）
  var endAt = "";
  if (raw.endAt) {
    var end = new Date(raw.endAt);
    if (!isNaN(end.getTime())) endAt = end.toISOString();
  }

  return {
    id: String(raw.id || "").trim(),
    game: String(raw.game).toLowerCase(),
    tournament: String(raw.tournament || "未知赛事").trim(),
    stage: String(raw.stage || "赛程").trim(),
    startAt: start.toISOString(),
    endAt: endAt,
    format: format,
    tier: raw.tier ? String(raw.tier).toLowerCase() : "",
    teamA: teamA,
    teamB: teamB,
    status: status,
    result: result,
    // 弃赛/取消标记（1.3.7 引入）：merge 往返经 normalizeMatch 时必须保留，
    // 否则一次重新采集就会把 canceled 标志洗掉（阶段完结判定回退）
    canceled: raw.canceled === true ? true : undefined,
    // PandaScore match id（2026-11-08）：mergeMatches 的同场主键（matchMidKey）——
    // 唯一且稳定，跨「主客交换/队名编辑/同队多场」；manual/liquipedia 为 undefined（JSON 自动省略）
    mid: Number(raw.mid) > 0 ? Math.floor(Number(raw.mid)) : undefined,
    note: raw.note ? String(raw.note) : "",
    source: source || raw.source || "manual"
  };
}

export function matchKey(m) {
  var d = new Date(m.startAt);
  var day = isNaN(d.getTime()) ? "nodate" : d.toISOString().slice(0, 10);
  return [m.game, day, slug(m.teamA.short || m.teamA.name), slug(m.teamB.short || m.teamB.name)].join("|");
}

// 同场标识（2026-11-08 二次修正）：**PandaScore match id 是唯一稳定的同场键**。
// 前一版用 team pid 对拼（game|pid|min:max）——「同两队」被当成「同一场」：双败败者组
// 再相遇、背靠背、双循环的同两队多场比赛互相污染 + 产生重复 id，采集连败 26h。
// mid 由 pandascore 适配器透传 item.id；manual/liquipedia 无 mid 走 slug 键。
export function matchMidKey(m) {
  if (!m) return null;
  var mid = Number(m.mid);
  if (!(mid > 0)) return null;
  return m.game + "|mid:" + Math.floor(mid);
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
  var entryKeys = new Map(); // entry 对象 → 当前 slug 键（mid 命中跨键合并时清理旧键）
  existing.forEach(function (m) {
    var n = normalizeMatch(m, m.source || "manual");
    if (n) {
      map.set(matchKey(n), n);
      entryKeys.set(n, matchKey(n));
    }
  });

  // 同场标识索引（2026-11-08 二次修正）：**PandaScore match id 才是稳定的同场标识**。
  // 前一版用 team pid 对拼（game|pid|min:max）——「同两队」被当成「同一场」：双败败者组
  // 再相遇、背靠背、双循环的同两队多场比赛互相污染 + 产生重复 id，采集连败 26h。
  // 无 mid 的来源（manual/liquipedia/旧数据）仍走 slug 键（行为不变）。
  var midIndex = new Map();
  existing.forEach(function (m) {
    var mk = matchMidKey(m);
    if (mk && !midIndex.has(mk)) midIndex.set(mk, m);
  });

  var added = 0;
  var updated = 0;

  incoming.forEach(function (raw) {
    var m = normalizeMatch(raw, raw.source);
    if (!m) return;
    var key = matchKey(m);
    var mk = matchMidKey(m);
    var cur = null;
    if (mk && midIndex.has(mk)) {
      cur = midIndex.get(mk); // 同场标识最高优先：PandaScore match id 唯一且稳定
    } else {
      cur = map.get(key) || null;
    }

    if (!cur) {
      m.id = makeId(m, usedIds);
      map.set(key, m);
      entryKeys.set(m, key);
      if (mk) midIndex.set(mk, m);
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
      merged.endAt = m.endAt || cur.endAt || ""; // 新采集缺失时不丢旧值
      merged.source = newP >= curP ? m.source : cur.source;
      // 同理：mid（manual 覆盖时不丢已有 mid，否则后续 pandascore 重取会退回 slug 键合并）
      if (merged.mid === undefined && cur.mid !== undefined) merged.mid = cur.mid;
      // 手工条目没有队标：沿用已有条目的，避免覆盖时丢图
      ["teamA", "teamB"].forEach(function (side) {
        if (merged[side] && cur[side] && !merged[side].logo && cur[side].logo) {
          merged[side] = Object.assign({}, merged[side], { logo: cur[side].logo });
        }
        // 同理：赛区（location 偶发缺失时不被空串覆盖）
        if (merged[side] && cur[side] && !merged[side].region && cur[side].region) {
          merged[side] = Object.assign({}, merged[side], { region: cur[side].region });
        }
        // 同理：pid（manual 覆盖时不丢已有 pid，否则后续 pandascore 重取会退回 slug 键合并）
        if (merged[side] && cur[side] && merged[side].pid === undefined && cur[side].pid !== undefined) {
          merged[side] = Object.assign({}, merged[side], { pid: cur[side].pid });
        }
      });
      // 经 mid 命中时 cur 可能挂在旧 slug 键下（主客交换过）：清旧键再挂新键，避免同轮残留
      var oldKey = entryKeys.get(cur);
      if (oldKey && oldKey !== key && map.get(oldKey) === cur) map.delete(oldKey);
      map.set(key, merged);
      entryKeys.delete(cur);
      entryKeys.set(merged, key);
      if (mk) midIndex.set(mk, merged);
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
