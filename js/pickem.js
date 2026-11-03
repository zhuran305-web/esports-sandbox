/* Pick'Em 赛事竞猜（1.3.5 实验功能）：纯函数模块，零 DOM/存储/SDK 依赖，可被 tools/test-cloud-nick.mjs 直跑。
 *
 * 数据形状（单一来源 = tools/fetch-pickem.mjs 头注释）：
 *   event  = { id, game, name, status, endsAt, stages:[stage] }
 *   stage  = swiss { id, type:"swiss", label, coinTier(1铜/2银/3金), startsAt, endsAt,
 *                    teams:[{name,short,region,logo,w,l}], matches:[{id,a,b,startAt,winner,score}],
 *                    results:{adv30,adv,out23,out13,out03}|null }
 *          | series  { id, type:"series", label, ..., matches:[{id,a,b,startAt,winner,score,round}] }
 *                    （round=按本地日期聚类的小组轮次 0 起：IEM 双败第 1/2/3 轮 → 铜币/银币/金币）
 *          | placement { id, type:"placement", label, ..., matches:[{...,round}], rounds:[labels], degraded,
 *                    results:{champion, runnerUp, third:[队名,队名]}|null }   // 淘汰赛名次竞猜
 *          | bracket { ... 旧类型，兼容保留；淘汰赛应使用 placement }
 *   用户侧记录（state.pickem，键 = eventId + ":" + stageId）：
 *     swiss     rec = { type:"swiss", picks:{adv30:[],adv:[],out03:[]}, pickedAt, settled, settledAt, score, total, prize }
 *     series    rec = { type:"series", picks:{w:{matchId:"A"|"B"}}, ...同上 }
 *     placement rec = { type:"placement", picks:{champion:"队名",runnerUp:"队名",third:"队名"}, ...同上 }
 *   硬币（state.pickemCoins）：{ c 铜币, s 银币, g 金币, d 钻石币 }——纯荣誉货币：
 *     不可交易、不可压注、只在硬币排行榜（实验功能）展示。
 *
 * 奖励（1.3.5 硬币体系，替代旧沙粒奖励）：
 *   - swiss：每猜对 1 个队伍位置 = 1 枚「阶段币」（coinTier：第 1 阶段铜、第 2 银、第 3 金）
 *   - series：第 N 轮每猜对 1 场 = 1 枚对应币（轮 0=铜、1=银、2+=金；IEM 双败三轮与 major 三阶段对应）
 *   - placement（淘汰赛）：猜对冠军 = 1 枚钻石币；猜对亚军/季军 = 各 1 枚金币（季军=半决赛败者并列两队，猜中任意一支算对）
 *   - 无沙粒奖励、无全对加成。
 * 截止：阶段/场次开赛前 1 小时（镜像单场竞猜 statusOf 的 3600000 语义）。
 */

/* ---------- 用户侧选择桶（官方 10 选口径）：
   用户只猜 3:0 晋级 ×2、3:1/3:2 晋级 ×6、0:3 淘汰 ×2 共 10 项；
   1:3 / 2:3 淘汰共 6 队是剩余队伍的自动落位（阶段终局后由 results 展示，不参与选择与计分）。 */
export var PICKEM_BUCKETS = [
  { k: "adv30", label: "3:0 晋级", cap: 2, tone: "win" },
  { k: "adv", label: "3:1 / 3:2 晋级", cap: 6, tone: "win" },
  { k: "out03", label: "0:3 淘汰", cap: 2, tone: "lose" }
];

/* 自动落位桶（仅展示）：瑞士轮终局记录分布固定为 3-1×3、2-3×3（16 队单败瑞士轮结构保证） */
export var PICKEM_AUTO_BUCKETS = [
  { k: "out23", label: "2:3 淘汰", cap: 3, tone: "lose" },
  { k: "out13", label: "1:3 淘汰", cap: 3, tone: "lose" }
];

/* 瑞士轮参赛队数（结构常量：队数对上 16 才算赛程齐备，与可猜桶总容量 10 是两回事） */
export var PICKEM_SWISS_TEAMS = 16;

function bucketKeys() {
  return PICKEM_BUCKETS.map(function (b) { return b.k; });
}

export var PICKEM_DEADLINE_MS = 3600000;  // 开赛前 1 小时截止（与单场竞猜一致）

/* ---------- 硬币体系（1.3.5）：键 → 名称/图标。纯荣誉货币 ---------- */
export var PICKEM_COINS = {
  c: { key: "c", tier: 1, name: "铜币", icon: "🥉" },
  s: { key: "s", tier: 2, name: "银币", icon: "🥈" },
  g: { key: "g", tier: 3, name: "金币", icon: "🥇" },
  d: { key: "d", tier: 4, name: "钻石币", icon: "💎" }
};
var COIN_KEY_BY_TIER = { 1: "c", 2: "s", 3: "g" }; // 阶段/轮次币级 → 硬币键（4=钻石仅 placement 冠军）

function coinKeyForTier(tier) {
  return COIN_KEY_BY_TIER[tier] || "g"; // 第 3 轮以后（4+ 轮赛制）一律金币
}

function zeroCoins() { return { c: 0, s: 0, g: 0, d: 0 }; }

function normalizeCoins(raw) {
  var out = zeroCoins();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.keys(out).forEach(function (k) {
    var v = raw[k];
    if (typeof v === "number" && isFinite(v) && v > 0) out[k] = Math.min(Math.round(v), 1e6);
  });
  return out;
}

/** 硬币云合并：逐键取 max（币只增不减，同 gods/bankrupts 族） */
export function mergePickemCoins(local, cloud) {
  local = normalizeCoins(local);
  cloud = normalizeCoins(cloud);
  Object.keys(cloud).forEach(function (k) {
    if (cloud[k] > local[k]) local[k] = cloud[k];
  });
  return local;
}

/* ---------- 数据侧校验（fetch-pickem 产物 → 客户端内存） ---------- */

function validTeam(t) {
  return !!t && typeof t.name === "string" && t.name.length > 0;
}

function validMatch(m) {
  return !!m && typeof m.id === "string" && m.id.length > 0 &&
    typeof m.a === "string" && typeof m.b === "string" &&
    typeof m.startAt === "string" && !isNaN(new Date(m.startAt).getTime());
}

function normalizeStage(raw) {
  if (!raw || (raw.type !== "swiss" && raw.type !== "bracket" && raw.type !== "series" && raw.type !== "placement")) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  var teams = (Array.isArray(raw.teams) ? raw.teams : []).filter(validTeam).slice(0, 24).map(function (t) {
    return { name: t.name, short: typeof t.short === "string" ? t.short : "", region: typeof t.region === "string" ? t.region : "", logo: typeof t.logo === "string" ? t.logo : "", w: typeof t.w === "number" && isFinite(t.w) ? t.w : 0, l: typeof t.l === "number" && isFinite(t.l) ? t.l : 0 };
  });
  var matches = (Array.isArray(raw.matches) ? raw.matches : []).filter(validMatch).slice(0, 60).map(function (m) {
    return { id: m.id, a: m.a, b: m.b, startAt: m.startAt, winner: m.winner === "A" || m.winner === "B" ? m.winner : "", score: typeof m.score === "string" ? m.score : "", round: typeof m.round === "number" && isFinite(m.round) ? m.round : 0 };
  });
  var out = {
    id: raw.id, type: raw.type,
    label: typeof raw.label === "string" && raw.label ? raw.label : raw.id,
    coinTier: typeof raw.coinTier === "number" && raw.coinTier >= 1 && raw.coinTier <= 3 ? raw.coinTier : 1,
    startsAt: typeof raw.startsAt === "string" ? raw.startsAt : "",
    endsAt: typeof raw.endsAt === "string" ? raw.endsAt : "",
    teams: teams, matches: matches
  };
  if (raw.type === "swiss") {
    // results 五桶各为队名数组（阶段全部结束后由聚合器填写；形状不对一律当 null 待结算）
    var r = raw.results;
    if (r && typeof r === "object" && !Array.isArray(r)) {
      var clean = {};
      var ok = true;
      bucketKeys().forEach(function (k) {
        clean[k] = Array.isArray(r[k]) ? r[k].filter(function (n) { return typeof n === "string" && n; }) : [];
        if (!Array.isArray(r[k])) ok = false;
      });
      out.results = ok ? clean : null;
    }
  } else if (raw.type === "placement") {
    out.rounds = Array.isArray(raw.rounds) ? raw.rounds.filter(function (s) { return typeof s === "string"; }) : [];
    out.degraded = raw.degraded === true;
    var pr = raw.results;
    if (pr && typeof pr === "object" && !Array.isArray(pr) &&
        typeof pr.champion === "string" && pr.champion &&
        typeof pr.runnerUp === "string" && pr.runnerUp &&
        Array.isArray(pr.third)) {
      out.results = {
        champion: pr.champion,
        runnerUp: pr.runnerUp,
        third: pr.third.filter(function (n) { return typeof n === "string" && n; }).slice(0, 2)
      };
    }
  } else if (raw.type === "bracket") {
    out.rounds = Array.isArray(raw.rounds) ? raw.rounds.filter(function (s) { return typeof s === "string"; }) : [];
    out.degraded = raw.degraded === true;
  }
  // series（逐场猜）：无轮次标签/无降级概念——round 由聚合器按日期聚类
  return out;
}

/** 规范化聚合数据（内嵌/运行时两路共用）。脏事件整条丢弃（与 normalizeRosters 同策略） */
export function normalizePickemData(raw) {
  var src = raw && Array.isArray(raw.events) ? raw.events : [];
  var out = [];
  src.forEach(function (ev) {
    if (!ev || typeof ev.id !== "string" || !ev.id || !Array.isArray(ev.stages) || !ev.stages.length) return;
    if (out.length >= 8) return; // 累积库最多同时挂 8 个赛事，防异常膨胀
    var stages = [];
    ev.stages.forEach(function (s) {
      var st = normalizeStage(s);
      if (st) stages.push(st);
    });
    if (!stages.length) return;
    out.push({
      id: ev.id,
      game: typeof ev.game === "string" && ev.game ? ev.game : "cs2",
      name: typeof ev.name === "string" && ev.name ? ev.name : ev.id,
      status: ev.status === "done" || ev.status === "active" || ev.status === "upcoming" ? ev.status : "upcoming",
      endsAt: typeof ev.endsAt === "string" ? ev.endsAt : "",
      stages: stages
    });
  });
  return { v: 1, events: out };
}

/* ---------- 用户侧记录（state.pickem）校验 ---------- */

function normalizeSwissPicks(raw) {
  // 只校验形状不校验队名：loadState/云合并时拿不到阶段队伍表；
  // 队伍合法性在 UI/计分时按阶段数据现校验（对不上的队自然不得分）
  var out = {};
  bucketKeys().forEach(function (k) {
    out[k] = Array.isArray(raw && raw[k]) ? raw[k].filter(function (n) { return typeof n === "string" && n; }).slice(0, 8) : [];
  });
  return out;
}

function normalizeBracketPicks(raw) {
  var out = {};
  if (raw && typeof raw.w === "object" && raw.w && !Array.isArray(raw.w)) {
    Object.keys(raw.w).forEach(function (mid) {
      var v = raw.w[mid];
      if (typeof mid === "string" && mid && (v === "A" || v === "B")) out[mid] = v;
    });
  }
  return { w: out };
}

function normalizePlacementPicks(raw) {
  function name(v) { return typeof v === "string" ? v : ""; }
  return {
    champion: raw ? name(raw.champion) : "",
    runnerUp: raw ? name(raw.runnerUp) : "",
    third: raw ? name(raw.third) : ""
  };
}

/** 规范化 state.pickem（loadState/云合并入口）。形状不对的阶段记录整条丢弃；记录数封顶防膨胀 */
export function normalizePickemState(raw) {
  var out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(function (key) {
    if (out[key] || Object.keys(out).length >= 24) return;
    var rec = raw[key];
    if (!rec || typeof rec !== "object" ||
        (rec.type !== "swiss" && rec.type !== "bracket" && rec.type !== "series" && rec.type !== "placement")) return;
    var clean = {
      type: rec.type,
      picks: rec.type === "swiss" ? normalizeSwissPicks(rec.picks)
        : rec.type === "placement" ? normalizePlacementPicks(rec.picks)
          : normalizeBracketPicks(rec.picks),
      pickedAt: typeof rec.pickedAt === "number" && isFinite(rec.pickedAt) && rec.pickedAt > 0 ? Math.min(Math.round(rec.pickedAt), 1e13) : 0,
      settled: rec.settled === true,
      settledAt: typeof rec.settledAt === "number" && isFinite(rec.settledAt) && rec.settledAt > 0 ? Math.min(Math.round(rec.settledAt), 1e13) : 0,
      score: typeof rec.score === "number" && isFinite(rec.score) && rec.score >= 0 ? Math.round(rec.score) : 0,
      total: typeof rec.total === "number" && isFinite(rec.total) && rec.total >= 0 ? Math.round(rec.total) : 0,
      prize: 0 // 1.3.5 起沙粒奖励移除（字段保留做形状兼容，恒 0）
    };
    out[key] = clean;
  });
  return out;
}

/* ---------- 阶段状态机（镜像 statusOf：开赛前 1 小时截止） ---------- */

/** 阶段内全部比赛是否已完赛（results 可用 / 淘汰赛可判名次） */
export function stageAllDone(stage) {
  return !!stage && stage.matches.length > 0 && stage.matches.every(function (m) { return m.winner === "A" || m.winner === "B"; });
}

/** 淘汰赛/系列赛里当前可猜的场次：双方确定 + 未完赛 + 未到自己开赛前 1 小时 */
export function pickableSeriesMatches(stage, now) {
  now = now || Date.now();
  if (!stage || (stage.type !== "series" && stage.type !== "bracket")) return [];
  return stage.matches.filter(function (m) {
    if (!m.a || !m.b) return false;
    if (m.winner === "A" || m.winner === "B") return false;
    var start = new Date(m.startAt).getTime();
    return !isNaN(start) && now < start - PICKEM_DEADLINE_MS;
  });
}

/** 该阶段是否可参与竞猜（赛程齐备 + 未截止）。
 *  swiss：16 队齐 + 阶段级 1h 截止；series/bracket：逐场截止（有可猜场次即可）；
 *  placement：7 场全排定且双方确定 + 阶段级 1h 截止（整段竞猜，赛果齐前一次锁定）。 */
export function stageOpenForPicks(stage, now) {
  now = now || Date.now();
  if (!stage || stageAllDone(stage)) return false;
  if (stage.type === "swiss") {
    if (stage.teams.length !== PICKEM_SWISS_TEAMS) return false;
  } else if (stage.type === "placement") {
    if (stage.degraded) return false;
    if (!stage.matches.length) return false;
    var allSet = stage.matches.every(function (m) { return m.a && m.b; });
    if (!allSet) return false; // 对阵未全部确定（等上一轮）
  } else if (stage.type === "series") {
    return pickableSeriesMatches(stage, now).length > 0; // 逐场截止：阶段已开打也能猜剩余场次
  } else if (stage.degraded) {
    return false;
  }
  var start = new Date(stage.startsAt).getTime();
  if (isNaN(start)) return false;
  return now < start - PICKEM_DEADLINE_MS; // 开赛前 1 小时停止竞猜
}

/* ---------- 选择校验与计分 ---------- */

/** 瑞士轮选择是否完整合法：每桶恰好 cap 支、无重复、10 队全覆盖（允许不满时返回 false，由 UI 提示进度） */
export function swissPicksComplete(picks) {
  var seen = {};
  var full = PICKEM_BUCKETS.every(function (b) {
    var list = Array.isArray(picks[b.k]) ? picks[b.k] : [];
    if (list.length !== b.cap) return false;
    return list.every(function (n) {
      if (seen[n]) return false;
      seen[n] = 1;
      return true;
    });
  });
  return full && Object.keys(seen).length === PICKEM_BUCKETS.reduce(function (s, b) { return s + b.cap; }, 0);
}

/** placement 选择是否完整：三名次各 1 队且互不相同（允许不满由 UI 提示进度） */
export function placementPicksComplete(picks) {
  return !!(picks.champion && picks.runnerUp && picks.third &&
    picks.champion !== picks.runnerUp && picks.champion !== picks.third && picks.runnerUp !== picks.third);
}

/** 阶段计分。返回 { correct, total, perfect }；阶段未完赛（results 缺失/无完赛场次）返回 null。
 *  注意：奖励（硬币）走 settleRewards，本函数只管「猜对几个」。 */
export function scorePhase(stage, rec) {
  if (!stage || !rec) return null;
  if (stage.type === "swiss") {
    if (!stage.results) return null;
    var correct = 0, total = 0;
    PICKEM_BUCKETS.forEach(function (b) {
      var picked = (rec.picks && rec.picks[b.k]) || [];
      total += b.cap;
      // 逐桶集合比对：猜进 3:0 桶的队必须真以 3-0 晋级才算对（位置语义，非「晋级即可」）
      picked.forEach(function (name) {
        if ((stage.results[b.k] || []).indexOf(name) >= 0) correct += 1;
      });
    });
    return { correct: correct, total: total, perfect: correct === total };
  }
  if (stage.type === "placement") {
    if (!stage.results) return null;
    var p = rec.picks || {};
    var c = 0, t = 0;
    ["champion", "runnerUp", "third"].forEach(function (k) {
      if (!p[k]) return; // 没猜的名次不计对也不计入分母（与 series 同口径：只算猜过的）
      t += 1;
      if (k === "third") {
        if ((stage.results.third || []).indexOf(p[k]) >= 0) c += 1; // 半决赛败者并列两队，猜中任意一支算对
      } else if (p[k] === stage.results[k]) {
        c += 1;
      }
    });
    return { correct: c, total: t, perfect: c === t && t > 0 };
  }
  // series/bracket（逐场猜）：只算「用户猜过的、且已有结果的」场次——中途接入公平；
  // 没猜的场不计对也不计入分母
  var mine = rec.picks && rec.picks.w ? rec.picks.w : {};
  var scored = stage.matches.filter(function (m) {
    return (m.winner === "A" || m.winner === "B") && mine[m.id];
  });
  if (!scored.length) return null;
  var sc = 0;
  scored.forEach(function (m) { if (mine[m.id] === m.winner) sc += 1; });
  return { correct: sc, total: scored.length, perfect: false };
}

/* ---------- 硬币奖励（1.3.5）：按阶段/轮次币级发放 ---------- */

/** 结算应发硬币。返回 { coins:{c,s,g,d}, bySource:[{label,coin,icon,count}] }——阶段未完赛返回 null。
 *  币级：swiss=stage.coinTier（1铜/2银/3金）；series=match.round（0铜/1银/2+金）；placement=冠军钻、亚/季军金。 */
export function settleRewards(stage, rec) {
  if (!stage || !rec) return null;
  var coins = zeroCoins();
  var bySource = [];
  if (stage.type === "swiss") {
    var sc = scorePhase(stage, rec);
    if (!sc || !sc.correct) return sc ? { coins: coins, bySource: bySource } : null;
    var key = coinKeyForTier(stage.coinTier || 1);
    coins[key] += sc.correct;
    bySource.push({ label: stage.label, coin: PICKEM_COINS[key], count: sc.correct });
    return { coins: coins, bySource: bySource };
  }
  if (stage.type === "placement") {
    if (!stage.results) return null;
    var p = rec.picks || {};
    var c = 0, t = 0;
    if (p.champion) {
      t += 1;
      if (p.champion === stage.results.champion) { coins.d += 1; c += 1; bySource.push({ label: "猜中冠军", coin: PICKEM_COINS.d, count: 1 }); }
    }
    if (p.runnerUp) {
      t += 1;
      if (p.runnerUp === stage.results.runnerUp) { coins.g += 1; c += 1; bySource.push({ label: "猜中亚军", coin: PICKEM_COINS.g, count: 1 }); }
    }
    if (p.third) {
      t += 1;
      if ((stage.results.third || []).indexOf(p.third) >= 0) { coins.g += 1; c += 1; bySource.push({ label: "猜中季军", coin: PICKEM_COINS.g, count: 1 }); }
    }
    return { coins: coins, bySource: bySource, correct: c, total: t };
  }
  // series（逐场猜）：按每场的轮次币级发放；bracket 走同路径（旧类型兼容）
  var mine = rec.picks && rec.picks.w ? rec.picks.w : {};
  var perTier = {}; // tier → {label, count}
  stage.matches.forEach(function (m) {
    if ((m.winner !== "A" && m.winner !== "B") || !mine[m.id]) return;
    if (mine[m.id] !== m.winner) return;
    var tier = stage.type === "series" ? ((m.round || 0) + 1) : 1;
    if (tier > 3) tier = 3;
    var k = coinKeyForTier(tier);
    coins[k] += 1;
    if (!perTier[k]) perTier[k] = { tier: tier, count: 0 };
    perTier[k].count += 1;
  });
  Object.keys(perTier).forEach(function (k) {
    var info = perTier[k];
    var tierLabel = info.tier === 1 ? "第 1 轮" : info.tier === 2 ? "第 2 轮" : "第 3 轮及以后";
    bySource.push({ label: stage.label + " · " + tierLabel, coin: PICKEM_COINS[k], count: info.count });
  });
  return { coins: coins, bySource: bySource };
}

/* ---------- 云合并（仿 mergeCollection：记录级冲突消解） ---------- */

/** state.pickem 云合并：逐键取「 pickedAt 较新」的一方；settled 取 OR 且随已结算方带 score/total。
 *  一侧已结算另一侧未结算时，取已结算侧（结算结果不可逆，防止旧设备未结算记录覆盖已领奖状态）。 */
export function mergePickem(local, cloud) {
  local = normalizePickemState(local);
  cloud = normalizePickemState(cloud);
  Object.keys(cloud).forEach(function (key) {
    var c = cloud[key];
    var l = local[key];
    if (!l) { local[key] = c; return; }
    if (c.settled && !l.settled) { local[key] = c; return; }
    if (l.settled && !c.settled) return;
    if ((c.pickedAt || 0) > (l.pickedAt || 0)) local[key] = c;
  });
  return local;
}
