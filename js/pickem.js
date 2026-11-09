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
 *                    （degraded=部分对阵未排期：名单齐（8 队）仍可名次竞猜，结算仍需完整 7 场推导 results）
 *          | bracket { ... 旧类型，兼容保留；淘汰赛应使用 placement }
 *   用户侧记录（state.pickem，键 = eventId + ":" + stageId）：
 *     swiss     rec = { type:"swiss", picks:{adv30:[],adv:[],out03:[]}, pickedAt, settled, settledAt, score, total, prize }
 *     series    rec = { type:"series", picks:{w:{matchId:"A"|"B"}}, ...同上 }
 *     placement rec = { type:"placement", picks:{champion:"队名",runnerUp:"队名",third:"队名"}, ...同上 }
 *   硬币（state.pickemCoins）：{ c 铜币, s 银币, g 金币, d 钻石币 }——纯荣誉货币：
 *     不可交易、不可压注、只在硬币排行榜（实验功能）展示。
 *
 * 奖励（1.3.6 硬币改版：S/A 级按赛事等级定币级，Major 规则不变）：
 *   - swiss（Major 瑞士轮）：每猜对 1 个队伍位置 = 1 枚「阶段币」（coinTier：第 1 阶段铜、第 2 银、第 3 金）——不变
 *   - series（小组赛逐场）：每猜对 1 场 = 1 枚固定币级（赛事 tier=a → 铜币；其余 S 级/未知 → 银币）——不再按轮数
 *   - placement（淘汰赛）：猜对冠军 = 1 枚钻石币、亚军/季军 = 各 1 枚金币（季军=半决赛败者并列两队，猜中任意一支算对）；
 *     A 级赛事整体降一级：冠军=金币、亚军/季军=银币
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
  if (!raw || (raw.type !== "swiss" && raw.type !== "bracket" && raw.type !== "series" && raw.type !== "placement" && raw.type !== "records")) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  var teams = (Array.isArray(raw.teams) ? raw.teams : []).filter(validTeam).slice(0, 24).map(function (t) {
    return { name: t.name, short: typeof t.short === "string" ? t.short : "", region: typeof t.region === "string" ? t.region : "", logo: typeof t.logo === "string" ? t.logo : "", w: typeof t.w === "number" && isFinite(t.w) ? t.w : 0, l: typeof t.l === "number" && isFinite(t.l) ? t.l : 0 };
  });
  var matches = (Array.isArray(raw.matches) ? raw.matches : []).filter(validMatch).slice(0, 60).map(function (m) {
    return { id: m.id, a: m.a, b: m.b, startAt: m.startAt, winner: m.winner === "A" || m.winner === "B" ? m.winner : "", score: typeof m.score === "string" ? m.score : "", round: typeof m.round === "number" && isFinite(m.round) ? m.round : 0, canceled: m.canceled === true || undefined };
  });
  var out = {
    id: raw.id, type: raw.type,
    label: typeof raw.label === "string" && raw.label ? raw.label : raw.id,
    coinTier: typeof raw.coinTier === "number" && raw.coinTier >= 1 && raw.coinTier <= 3 ? raw.coinTier : 1,
    // auto 事件纯展示标记（2026-11-08）：series 阶段不可猜、仅展示赛程赛果；结构化类型不受影响
    displayOnly: raw.displayOnly === true && raw.type === "series" ? true : undefined,
    startsAt: typeof raw.startsAt === "string" ? raw.startsAt : "",
    endsAt: typeof raw.endsAt === "string" ? raw.endsAt : "",
    teams: teams, matches: matches
  };
  if (raw.type === "records") {
    // 战绩桶（1.3.12）：桶结构来自配置（k=最终战绩串如 "3:0"，cap=该战绩队伍数）；
    // 形状不对一律当无桶（stage 渲染为 wait，不崩溃）
    var bs = Array.isArray(raw.buckets) ? raw.buckets.filter(function (b) {
      return b && typeof b.k === "string" && /^\d+:\d+$/.test(b.k) &&
        typeof b.cap === "number" && b.cap >= 1 && b.cap <= 8;
    }).slice(0, 8).map(function (b) {
      return { k: b.k, label: typeof b.label === "string" && b.label ? b.label : b.k, cap: Math.round(b.cap) };
    }) : [];
    if (bs.length) out.buckets = bs;
    var rr = raw.results;
    if (bs.length && rr && typeof rr === "object" && !Array.isArray(rr)) {
      var rclean = {};
      var rok = true;
      bs.forEach(function (b) {
        rclean[b.k] = Array.isArray(rr[b.k]) ? rr[b.k].filter(function (n) { return typeof n === "string" && n; }) : [];
        if (!Array.isArray(rr[b.k])) rok = false;
      });
      out.results = rok ? rclean : null;
    }
  } else if (raw.type === "swiss") {
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
    // 名单规模声明（1.3.7：6 队轮空制等非 8 队淘汰赛用；0=未声明，按 PICKEM_PLACEMENT_TEAMS 默认）
    out.expectTeams = typeof raw.expectTeams === "number" && raw.expectTeams >= 2 && raw.expectTeams <= 16 ? Math.round(raw.expectTeams) : 0;
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
      tournament: typeof ev.tournament === "string" ? ev.tournament : "", // 手工配置的匹配串（自动收录去重用）
      tier: ev.tier === "a" ? "a" : "", // 赛事等级（1.3.6 硬币改版）：a=A 级（币级整体降一级）；s/Major/未知一律 "" 按 S 级处理
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

/** records picks 规范化：桶键=战绩串（"W:L"），桶结构随 stage 配置——这里只做形状清洗
 *  （键形校验 + 队名数组），容量/重复校验在 recordsPicksComplete（需 stage.buckets 上下文） */
function normalizeRecordsPicks(raw) {
  var out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(function (k) {
    if (!/^\d+:\d+$/.test(k)) return;
    if (!Array.isArray(raw[k])) return;
    var list = raw[k].filter(function (n) { return typeof n === "string" && n; }).slice(0, 8);
    if (list.length) out[k] = list;
  });
  return out;
}

/** 规范化 state.pickem（loadState/云合并入口）。形状不对的阶段记录整条丢弃；记录数封顶防膨胀。
 *  键迁移（1.3.6）：recKey 分隔符从 ":" 改 "##"（自动赛事 id "auto:XXX" 含冒号会撞拆分）——
 *  旧键（无 ##）按第一个冒号拆（手工 id 无冒号，安全）迁移。 */
export function normalizePickemState(raw) {
  var out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(function (origKey) {
    if (Object.keys(out).length >= 24) return;
    var key = origKey;
    if (key.indexOf("##") < 0 && key.indexOf(":") >= 0) {
      key = key.replace(":", "##"); // 旧格式迁移（只换第一个冒号；手工事件 id 无冒号）
      if (out[key]) key = origKey; // 迁移撞键（理论不发生）：保留原键防丢
    }
    var rec = raw[origKey];
    if (!rec || typeof rec !== "object" ||
        (rec.type !== "swiss" && rec.type !== "bracket" && rec.type !== "series" && rec.type !== "placement" && rec.type !== "records")) return;
    var clean = {
      type: rec.type,
      picks: rec.type === "swiss" ? normalizeSwissPicks(rec.picks)
        : rec.type === "placement" ? normalizePlacementPicks(rec.picks)
          : rec.type === "records" ? normalizeRecordsPicks(rec.picks)
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

/** 阶段内全部比赛是否已完赛（results 可用 / 淘汰赛可判名次）。
 *  弃赛/取消场次（canceled=true，无赛果）视为已解决：不再阻塞阶段完结与结算（1.3.7 应对轮空/弃赛）。 */
export function stageAllDone(stage) {
  return !!stage && stage.matches.length > 0 && stage.matches.every(function (m) {
    return m.winner === "A" || m.winner === "B" || m.canceled === true;
  });
}

/** 淘汰赛/系列赛里当前可猜的场次：双方确定 + 未完赛未取消 + 未到自己开赛前 1 小时。
 *  displayOnly（auto 事件纯展示，2026-11-08）恒空。 */
export function pickableSeriesMatches(stage, now) {
  now = now || Date.now();
  if (!stage || (stage.type !== "series" && stage.type !== "bracket")) return [];
  if (stage.displayOnly) return [];
  return stage.matches.filter(function (m) {
    if (!m.a || !m.b) return false;
    if (m.canceled) return false; // 已取消/弃赛场次不可猜
    if (m.winner === "A" || m.winner === "B") return false;
    var start = new Date(m.startAt).getTime();
    return !isNaN(start) && now < start - PICKEM_DEADLINE_MS;
  });
}

/** 标准单败淘汰赛的参赛队数（8 强 = 首轮 4 场全排定即名单齐）。名次竞猜与对阵无关，
 *  淘汰赛名单一确定（哪怕半决赛/决赛尚未排期）就应可预测——1.3.6 放宽 degraded 一票否决。 */
export var PICKEM_PLACEMENT_TEAMS = 8;

/** 该阶段是否可参与竞猜（赛程齐备 + 未截止）。
 *  swiss：16 队齐 + 阶段级 1h 截止；series/bracket：逐场截止（有可猜场次即可）；
 *  placement：参赛名单齐（标准 8 强；degraded=部分对阵未排期也允许，名次与对阵无关）+ 第一场开赛前 1h 截止。 */
export function stageOpenForPicks(stage, now) {
  now = now || Date.now();
  if (!stage || stageAllDone(stage)) return false;
  if (stage.type === "swiss") {
    if (stage.teams.length !== PICKEM_SWISS_TEAMS) return false;
  } else if (stage.type === "records") {
    // 战绩桶（1.3.12）：队伍从首轮对阵即可全知——队伍数 ≥ 桶容量即可选，与对阵结构无关
    var capTotal = recordBucketsCapTotal(stage);
    if (!capTotal || stage.teams.length < capTotal) return false;
  } else if (stage.type === "placement") {
    if (!stage.matches.length) return false;
    if (!stage.degraded) {
      var allSet = stage.matches.every(function (m) { return m.a && m.b; });
      if (!allSet) return false; // 对阵未全部确定（等上一轮）
    } else if (stage.teams.length < (stage.expectTeams || PICKEM_PLACEMENT_TEAMS)) {
      return false; // 名单未齐（首轮还没排完）——与对阵无关的名次竞猜无从选起；6 队轮空制等按配置规模判
    }
  } else if (stage.type === "series") {
    if (stage.displayOnly) return false; // auto 事件纯展示（2026-11-08）：结构化竞猜走手工配置路径
    return pickableSeriesMatches(stage, now).length > 0; // 逐场截止：阶段已开打也能猜剩余场次
  } else if (stage.degraded) {
    return false;
  }
  var start = new Date(stage.startsAt).getTime();
  if (isNaN(start)) return false;
  return now < start - PICKEM_DEADLINE_MS; // 开赛前 1 小时停止竞猜
}

/** records 阶段的桶清单（未配置/形状不对返回 null——调用方按无桶降级） */
export function recordBuckets(stage) {
  if (!stage || stage.type !== "records" || !Array.isArray(stage.buckets) || !stage.buckets.length) return null;
  return stage.buckets;
}
export function recordBucketsCapTotal(stage) {
  var bs = recordBuckets(stage);
  if (!bs) return 0;
  return bs.reduce(function (s, b) { return s + (b && b.cap > 0 ? b.cap : 0); }, 0);
}

/** records 选择是否完整合法：每桶恰好 cap 支、无重复、总数=桶容量（允许不满时 false，由 UI 提示进度） */
export function recordsPicksComplete(picks, buckets) {
  if (!buckets) return false;
  var seen = {};
  var full = buckets.every(function (b) {
    var list = Array.isArray(picks && picks[b.k]) ? picks[b.k] : [];
    if (list.length !== b.cap) return false;
    return list.every(function (n) {
      if (seen[n]) return false;
      seen[n] = 1;
      return true;
    });
  });
  return full && Object.keys(seen).length === buckets.reduce(function (s, b) { return s + b.cap; }, 0);
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
  if (stage.type === "records") {
    // 战绩桶（1.3.12）：桶结构随 stage.buckets——按最终 W:L 落桶，逐桶集合比对（同 swiss 位置语义）
    var buckets = recordBuckets(stage);
    if (!buckets || !stage.results) return null;
    var c2 = 0, t2 = 0;
    buckets.forEach(function (b) {
      var picked = (rec.picks && rec.picks[b.k]) || [];
      t2 += b.cap;
      picked.forEach(function (name) {
        if ((stage.results[b.k] || []).indexOf(name) >= 0) c2 += 1;
      });
    });
    return { correct: c2, total: t2, perfect: c2 === t2 };
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
 *  币级（1.3.6 改版，eventTier = 赛事 tier："a" | ""）：
 *  swiss=stage.coinTier（1铜/2银/3金，Major 不变）；series=按赛事等级（a→铜、其余→银），不再按轮数；
 *  placement=A 级冠军金/亚季军银，其余（Major/S/未知）冠军钻、亚/季军金。 */
export function settleRewards(stage, rec, eventTier) {
  if (!stage || !rec) return null;
  var coins = zeroCoins();
  var bySource = [];
  if (stage.type === "swiss" || stage.type === "records") {
    var sc = scorePhase(stage, rec);
    if (!sc || !sc.correct) return sc ? { coins: coins, bySource: bySource } : null;
    var key = coinKeyForTier(stage.coinTier || 1);
    coins[key] += sc.correct;
    bySource.push({ label: stage.label, coin: PICKEM_COINS[key], count: sc.correct });
    return { coins: coins, bySource: bySource };
  }
  if (stage.type === "placement") {
    if (!stage.results) return null;
    var isA = eventTier === "a"; // A 级整体降一级；Major/S 级不变（冠军钻、亚/季军金）
    var champCoin = isA ? PICKEM_COINS.g : PICKEM_COINS.d;
    var placeCoin = isA ? PICKEM_COINS.s : PICKEM_COINS.g;
    var p = rec.picks || {};
    var c = 0, t = 0;
    if (p.champion) {
      t += 1;
      if (p.champion === stage.results.champion) { coins[champCoin.key] += 1; c += 1; bySource.push({ label: "猜中冠军", coin: champCoin, count: 1 }); }
    }
    if (p.runnerUp) {
      t += 1;
      if (p.runnerUp === stage.results.runnerUp) { coins[placeCoin.key] += 1; c += 1; bySource.push({ label: "猜中亚军", coin: placeCoin, count: 1 }); }
    }
    if (p.third) {
      t += 1;
      if ((stage.results.third || []).indexOf(p.third) >= 0) { coins[placeCoin.key] += 1; c += 1; bySource.push({ label: "猜中季军", coin: placeCoin, count: 1 }); }
    }
    return { coins: coins, bySource: bySource, correct: c, total: t };
  }
  // series/bracket（逐场猜）：每猜对 1 场 = 1 枚赛事等级币（A 级铜币，其余银币），不再按轮数；
  // 只算「用户猜过的、且已有结果的」场次——中途接入公平。
  // displayOnly（auto 事件纯展示，2026-11-08）不再产生新选择，但历史已提交的选择照常结算
  var mine = rec.picks && rec.picks.w ? rec.picks.w : {};
  var k2 = eventTier === "a" ? "c" : "s";
  var n = 0;
  stage.matches.forEach(function (m) {
    if ((m.winner !== "A" && m.winner !== "B") || !mine[m.id]) return;
    if (mine[m.id] !== m.winner) return;
    coins[k2] += 1;
    n += 1;
  });
  if (n) bySource.push({ label: stage.label, coin: PICKEM_COINS[k2], count: n });
  return { coins: coins, bySource: bySource };
}

/* ---------- 自动收录（1.3.6）：所有 tier=s/a 赛事的 series 视图 ----------
   采集端聚合（pickem.json）只装手工配置的赛事（major/IEM 精细模式）；其余 S/A 赛事由客户端
   从 MATCHES 现算（45 天窗口内数据本来就全，避免 pickem.json 膨胀数百 KB）。手工配置优先去重。 */

/** 从 matches 现算自动赛事：按 tournament 归并 tier=s/a 比赛，按 stage 值分组为多个 series 阶段，
 *  round 按北京时间日期聚类（与聚合器同口径）。返回 normalizePickemData 形状的事件数组。 */

/** 淘汰赛阶段名识别（coin 升级用）：PandaScore 阶段名英文为主，手工配置中文阶段名兜底。
 *  关键词保守匹配——漏判只是维持小组赛币级（旧行为），误判会把小组赛升一级。 */
export function isPlayoffStageKey(key) {
  return /play[\s-]?off|knock\s?out|quarter|semi|final|ro\d+|round of|bracket|eliminat|淘汰/i.test(String(key || ""));
}
/** 自动收录 done 判定（1.3.14 防「过早 done」，1.3.7 聚合器同族教训）：
 *  全部已抓场次完赛 ≠ 赛事结束——小组赛打完、淘汰赛对阵尚未被数据源排期时（排期通常滞后
 *  0~2 天，长间断赛事可达一周+，实测 MPL Indonesia 间断 17 天后恢复），数据里看不到后续阶段，
 *  此时判 done 会让赛事带着未打的后续阶段从作业页提前消失。done 需要两条证据链任一成立：
 *  ① 数据里出现过淘汰赛阶段（isPlayoffStageKey 命中）——决赛都打了，赛事必然收场；
 *  ② 全部完赛且距最后一场开赛超过本宽限期——等不到后续排期，视为纯循环赛/已收场
 *     （代价=无淘汰赛的纯循环赛收官后多展示约 3 天）。 */
var PICKEM_AUTO_DONE_LAG_MS = 3 * 86400000;

/** 北京时间日期聚类（1.3.6 轮次口径，series/records 两路共用）：跨天 +1 轮、同日同轮、脏 startAt 归 0。
 *  脏 startAt（非法日期）防炸：new Date(NaN).toISOString() 会抛 RangeError——
 *  内嵌快照不经 normalizeMatches 过滤，一条脏数据不能崩掉整次 boot（夜间自查 R5 定案） */
function autoStageRounds(list) {
  var lastDay = "", round = 0;
  return list.map(function (m) {
    var startT = new Date(m.startAt).getTime();
    var day = !isNaN(startT) ? new Date(startT + 8 * 3600000).toISOString().slice(0, 10) : "";
    if (lastDay && day && day !== lastDay) round += 1;
    if (day) lastDay = day;
    return round;
  });
}

/** 自动收录的战绩桶模板（1.3.14：auto 赛事小组赛自动升级战绩桶竞猜，仿 BLAST records 模式）。
 *  桶结构=赛制推导，**要求证据充分**（与 tools/pickem-config-helper 同规则）：
 *  4 队×≥5 场 → 经典 GSL 双败（2:0/2:1/1:2/0:2 各 1，每队最多 3 场）；
 *  8 队×12 场 → 8 队双败（3:0/3:1/2:1/2:2 各 1 + 1:2/0:2 各 2）；
 *  其余形态返回 null → 保持 series 赛程展示——宁缺勿滥不硬套。
 *  ⚠ 4 队组的形态歧义（2026-11-09 BLAST 香港实测）：经典 GSL=5 场（2:0/2:1/1:2/0:2），
 *  BLAST Rivals 式「4 进 3」=4 场（每队只打两场 → 2:0×1/1:1×2/0:2×1）。数据侧两条路都
 *  只有首轮 2 场带真实队名（TBD 场次被采集器过滤），预测时点无法区分——套错桶会因分布
 *  不符永不结算（IEM 季军赛同级教训）。故 4 队组只在 ≥5 场时才套 GSL 桶；「4 进 3」形态
 *  走手工配置（type=records + 自定义 buckets），auto 路径不硬套。 */
function autoRecordsBuckets(list) {
  var seen = {};
  var n = 0;
  list.forEach(function (m) {
    [m.teamA, m.teamB].forEach(function (t) {
      if (t && t.name && !seen[t.name]) { seen[t.name] = 1; n += 1; }
    });
  });
  if (n === 4 && list.length >= 5) return [
    { k: "2:0", label: "2:0 出线", cap: 1 }, { k: "2:1", label: "2:1 出线", cap: 1 },
    { k: "1:2", label: "1:2 淘汰", cap: 1 }, { k: "0:2", label: "0:2 淘汰", cap: 1 }
  ];
  if (n === 8 && list.length === 12) return [
    { k: "3:0", label: "3:0", cap: 1 }, { k: "3:1", label: "3:1", cap: 1 },
    { k: "2:1", label: "2:1", cap: 1 }, { k: "2:2", label: "2:2", cap: 1 },
    { k: "1:2", label: "1:2 淘汰", cap: 2 }, { k: "0:2", label: "0:2 淘汰", cap: 2 }
  ];
  return null;
}

/** 战绩桶结果推导（与聚合器 recordsResults 同口径）：全部完赛（弃赛容忍）且实际 W:L 分布与
 *  桶容量逐一吻合才出结果——推断误判时宁缺勿滥返回 null（阶段不出结果、选择不结算）。 */
function autoRecordsResults(teamList, buckets, compact) {
  var allDone = compact.length > 0 && compact.every(function (m) {
    return m.winner === "A" || m.winner === "B" || m.canceled === true;
  });
  if (!allDone) return null;
  var byBucket = {};
  buckets.forEach(function (b) { byBucket[b.k] = []; });
  teamList.forEach(function (t) {
    var k = t.w + ":" + t.l;
    if (byBucket[k]) byBucket[k].push(t.name);
  });
  return buckets.every(function (b) { return byBucket[b.k].length === b.cap; }) ? byBucket : null;
}

/** 构建自动收录的 records 阶段：id 加 "|rec" 后缀与同源 series 阶段的 recKey 隔离——
 *  历史（1.3.12 时代）逐场选择仍挂在同源 series 阶段正常结算，渲染层按 srcStage 去重隐藏 series
 *  （records 桶体自带「对阵与赛果」展示，无重复观感）。coinTier 与 helper/聚合器一致：A 级铜、其余银。 */
function buildAutoRecordsStage(sk, list, rounds, buckets, eventIsA) {
  var teams = {};
  var order = [];
  var compact = list.map(function (m, i) {
    [m.teamA, m.teamB].forEach(function (t) {
      if (!t || !t.name) return;
      if (!teams[t.name]) {
        teams[t.name] = { name: t.name, short: t.short || "", region: t.region || "", logo: t.logo || "", w: 0, l: 0 };
        order.push(t.name);
      } else if (!teams[t.name].short && t.short) teams[t.name].short = t.short;
    });
    var winner = m.result && (m.result.winner === "A" || m.result.winner === "B") ? m.result.winner : "";
    if (winner) {
      var win = winner === "A" ? m.teamA : m.teamB;
      var lose = winner === "A" ? m.teamB : m.teamA;
      if (win && teams[win.name]) teams[win.name].w += 1;
      if (lose && teams[lose.name]) teams[lose.name].l += 1;
    }
    return { id: m.id, a: m.teamA.name, b: m.teamB.name, startAt: m.startAt, winner: winner, score: (m.result && m.result.score) || "", round: rounds[i], canceled: m.canceled === true || undefined };
  });
  var teamList = order.map(function (n) { return teams[n]; })
    .sort(function (x, y) { return (y.w - x.w) || (x.l - y.l) || (x.name < y.name ? -1 : 1); });
  return {
    id: sk + "|rec", type: "records", label: sk + " · 战绩竞猜",
    srcStage: sk,
    coinTier: eventIsA ? 1 : 2,
    startsAt: list[0].startAt, endsAt: list[list.length - 1].startAt,
    teams: teamList, matches: compact, buckets: buckets,
    results: autoRecordsResults(teamList, buckets, compact)
  };
}

export function buildAutoEvents(matches, excludeTournaments) {
  var excluded = {};
  (excludeTournaments || []).forEach(function (t) { excluded[t] = 1; });
  var byEvent = {};
  (matches || []).forEach(function (m) {
    if (!m || (m.tier !== "s" && m.tier !== "a")) return;
    if (!m.tournament || excluded[m.tournament]) return;
    if (!m.teamA || !m.teamA.name || !m.teamB || !m.teamB.name) return;
    var ev = byEvent[m.tournament];
    if (!ev) { ev = byEvent[m.tournament] = { game: m.game, stages: {} }; }
    if (m.game !== ev.game) return; // 同名跨游戏（罕见）：归首个游戏
    var sk = m.stage || "赛程";
    if (!ev.stages[sk]) ev.stages[sk] = [];
    ev.stages[sk].push(m);
  });
  var events = [];
  Object.keys(byEvent).forEach(function (tn) {
    var ev = byEvent[tn];
    var stageKeys = Object.keys(ev.stages);
    if (!stageKeys.length) return;
    var lastStart = 0, allDone = true, anyStarted = false;
    var sawPlayoffs = false; // 证据链①：数据里出现过淘汰赛阶段名
    var allA = true; // 赛事等级：全部场次 tier=a 才算 A 级（同赛事 tier 一致，防御混合）
    stageKeys.forEach(function (sk) {
      if (isPlayoffStageKey(sk)) sawPlayoffs = true;
      ev.stages[sk].forEach(function (m) { if (m.tier !== "a") allA = false; });
    });
    var stages = [];
    stageKeys.forEach(function (sk) {
      var list = ev.stages[sk].slice().sort(function (a, b) { return new Date(a.startAt) - new Date(b.startAt); });
      var rounds = autoStageRounds(list);
      // 淘汰赛阶段名先行排除（semifinals 等也是 4 队——绝不能套 GSL 桶），其余按形态推导战绩桶
      var recBuckets = isPlayoffStageKey(sk) ? null : autoRecordsBuckets(list);
      if (recBuckets) stages.push(buildAutoRecordsStage(sk, list, rounds, recBuckets, allA));
      var teamsSeen = {};
      var ms = list.map(function (m, i) {
        var startT = new Date(m.startAt).getTime();
        var winner = m.result && (m.result.winner === "A" || m.result.winner === "B") ? m.result.winner : "";
        if (winner || (!isNaN(startT) && startT <= Date.now())) anyStarted = true;
        if (!winner && m.canceled !== true) allDone = false;
        if (!isNaN(startT)) lastStart = Math.max(lastStart, startT);
        teamsSeen[m.teamA.name] = { name: m.teamA.name, short: m.teamA.short || "" };
        teamsSeen[m.teamB.name] = { name: m.teamB.name, short: m.teamB.short || "" };
        // canceled（1.3.8 弃赛）：auto 事件此前没透传，弃赛场会永远显示成未完成
        return { id: m.id, a: m.teamA.name, b: m.teamB.name, startAt: m.startAt, winner: winner, score: (m.result && m.result.score) || "", round: rounds[i], canceled: m.canceled === true || undefined };
      });
      stages.push({
        id: sk, type: "series", label: sk,
        coinTier: 1,
        // displayOnly（2026-11-08 用户拍板；1.3.14 收窄）：auto 事件的可猜形态=结构化竞猜——
        // 4 队/8 队双败小组已自动升级为 records 战绩桶；series 只承担①赛程展示（淘汰赛/形态
        // 未知阶段）②历史（1.3.12 时代）逐场选择的结算通道（有 records 孪生的组渲染层隐藏），新选择入口关闭
        displayOnly: true,
        startsAt: list[0].startAt, endsAt: list[list.length - 1].startAt,
        teams: Object.keys(teamsSeen).map(function (n) { return teamsSeen[n]; }),
        matches: ms
      });
    });
    if (!stages.length) return;
    events.push({
      id: "auto:" + tn, game: ev.game, name: tn,
      tier: allA ? "a" : "", // 1.3.6 硬币改版：A 级币级整体降一级
      status: allDone && (sawPlayoffs || Date.now() > lastStart + PICKEM_AUTO_DONE_LAG_MS)
        ? "done" : anyStarted ? "active" : "upcoming",
      endsAt: lastStart ? new Date(lastStart + 12 * 3600000).toISOString() : "",
      stages: stages, auto: true
    });
  });
  return events;
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
