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
    // mid 保留在运行时包（2026-11-11 live.json 高频链路）：客户端按 mid 定位实时补丁目标
    // （PandaScore running 响应只有 mid，无法映射本地派生 id）；+4400×8B ≈ +35KB 可接受
    if (copy.tid !== undefined) delete copy.tid; // structures 抓取键，客户端按 game|tournament|stage 查结构
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
    // PandaScore tournament id（阶段级实体，fetch-tournament-structures 的抓取键）；
    // manual/liquipedia 为 undefined（JSON 自动省略）。客户端零引用——运行时切片剥离
    tid: Number(raw.tid) > 0 ? Math.floor(Number(raw.tid)) : undefined,
    // 实时三件套（2026-11-10 深度接入）：lv=官方 running 信号（statusOf 优先于时间估算）、
    // lsc=实时比分 "1:0"（仅 running）、gs=已完局串 "A1584,A1508"（胜方+秒，详情页局记分）。
    // 键恒存在（未发生=undefined）——mergeMatches 的 Object.assign 复制 own key，
    // running→finished 后旧实时数据被显式覆盖不残留；JSON.stringify 自动省略 undefined
    lv: raw.lv === true ? true : undefined,
    lsc: typeof raw.lsc === "string" && raw.lsc ? raw.lsc : undefined,
    gs: typeof raw.gs === "string" && raw.gs ? raw.gs : undefined,
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

/** 条目的 map 键（2026-11-08 三修）：带 mid 用 mid 键（与主客序无关——交换序重取天然同键，
 *  无键迁移问题）；无 mid（manual/旧数据）用 slug 键（行为不变）。 */
function entryMapKey(m) {
  return matchMidKey(m) || matchKey(m);
}

/*
 * 合并规则：
 * 1. 同一场比赛：带 mid 按 mid 键唯一认定（PandaScore match id 唯一且稳定）；无 mid 按 slug 键
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

  var map = new Map();        // mapKey → 条目（normalize 后对象；键=mid 键|slug 键，见 entryMapKey）
  var entryKeys = new Map();  // entry 对象 → 当前 slug 键（无 mid 条目交换序重取时迁移清理用）
  existing.forEach(function (m) {
    var n = normalizeMatch(m, m.source || "manual");
    if (n) {
      map.set(entryMapKey(n), n);
      entryKeys.set(n, matchKey(n));
    }
  });

  // 同场标识索引（2026-11-08 二次修正；三修=与 map 同一批对象）：
  // **PandaScore match id 才是稳定的同场标识**。前一版用 team pid 对拼——「同两队」被当成
  // 「同一场」：双败败者组再相遇、背靠背、双循环的同两队多场互相污染 + 重复 id，采集连败 26h。
  // 三修（11-08 晚，valorant 重复 id 事故）：midIndex 此前存的是 **normalize 前的 existing 原对象**，
  // 而 map/entryKeys 存 normalize 后对象——mid 命中拿到不在 map 里的孤儿 → entryKeys 查不到旧键
  // → 主客交换重取清不掉旧 slug 键 → fork 出同 id 孪生（validate 拒收，采集停更 9h）。
  // 索引必须从 map 值构建，与 map/entryKeys 同一批对象。
  var midIndex = new Map();
  var slugIndex = new Map(); // slug 键 → 条目（first-wins；仅供无 mid 来源比对/回退）
  map.forEach(function (n) {
    var mk = matchMidKey(n);
    if (mk && !midIndex.has(mk)) midIndex.set(mk, n);
    var sk = matchKey(n);
    if (!slugIndex.has(sk)) slugIndex.set(sk, n);
  });

  var added = 0;
  var updated = 0;

  incoming.forEach(function (raw) {
    var m = normalizeMatch(raw, raw.source);
    if (!m) return;
    var key = entryMapKey(m);
    var mk = matchMidKey(m);
    var sk = matchKey(m);
    var cur = null;
    if (mk && midIndex.has(mk)) {
      cur = midIndex.get(mk); // 同场标识最高优先：mid 键与主客序无关，命中即同场
    } else if (!mk) {
      cur = slugIndex.get(sk) || null; // 无 mid（manual/liquipedia/旧数据）：slug 键比对（行为不变）
    } else {
      // 带 mid 但索引未命中 = 新场次。唯一允许的回退：slug 命中「无 mid」条目
      // （manual 补录 → pandascore 升级同场）。带 mid 的条目绝不能按 slug 键合并——
      // 同两队同日多场（再相遇/背靠背/双循环）共享 slug 键，在此互相污染/覆盖（三修）。
      var cand = slugIndex.get(sk) || null;
      cur = cand && !matchMidKey(cand) ? cand : null;
    }

    if (!cur) {
      m.id = makeId(m, usedIds);
      map.set(key, m);
      entryKeys.set(m, sk);
      if (mk) midIndex.set(mk, m);
      if (!slugIndex.has(sk)) slugIndex.set(sk, m);
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
      // 同理：tid（manual 覆盖时不丢已有 tid——structures 抓取键）
      if (merged.tid === undefined && cur.tid !== undefined) merged.tid = cur.tid;
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
      // 键维护：条目带 mid 一律收编到 mid 键（与主客序无关，原地覆盖）；
      // 无 mid 条目按 slug 键入 map——交换序重取会换 slug 键，清旧键再挂新键，避免同轮残留。
      // manual 条目并入带 mid 的采集数据（升级）时同样收编——旧 slug 键槽位不清会在
      // 交换序重取时 fork（同 id 孪生，11-08 晚实测）
      var curMk = matchMidKey(cur);
      var mergedMk = matchMidKey(merged);
      var mergedSk = matchKey(merged);
      var oldKey = entryKeys.get(cur);
      if (oldKey) {
        if (mergedMk) {
          // 条目迁往 mid 键（含 manual 升级场景）：旧 slug 槽位一律清——同键守卫在这里
          // 不适用，否则升级后的条目同时挂在 slug 键与 mid 键下（同 id 孪生，11-08 晚实测）
          if (map.get(oldKey) === cur) map.delete(oldKey);
          if (slugIndex.get(oldKey) === cur) slugIndex.delete(oldKey);
        } else if (oldKey !== mergedSk) {
          if (map.get(oldKey) === cur) map.delete(oldKey);
          if (slugIndex.get(oldKey) === cur) slugIndex.delete(oldKey);
        }
      }
      if (mergedMk) {
        midIndex.set(mergedMk, merged);
        map.set(mergedMk, merged);
      } else {
        if (slugIndex.get(mergedSk) === cur || !slugIndex.has(mergedSk)) slugIndex.set(mergedSk, merged);
        map.set(mergedSk, merged);
      }
      if (!slugIndex.has(mergedSk)) slugIndex.set(mergedSk, merged);
      entryKeys.delete(cur);
      entryKeys.set(merged, mergedSk);
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
