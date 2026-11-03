/* Pick'Em 赛事竞猜（1.4.0 实验功能）：纯函数模块，零 DOM/存储/SDK 依赖，可被 tools/test-cloud-nick.mjs 直跑。
 *
 * 数据形状（单一来源 = tools/fetch-pickem.mjs 头注释）：
 *   event  = { id, game, name, status, endsAt, stages:[stage] }
 *   stage  = swiss { id, type:"swiss", label, startsAt, endsAt, teams:[{name,short,region,logo,w,l}],
 *                    matches:[{id,a,b,startAt,winner,score}], results:{adv30,adv,out23,out13,out03}|null }
 *          | bracket { id, type:"bracket", ..., matches:[{...,round}], rounds:[labels], degraded }
 *   用户侧记录（state.pickem，键 = eventId + ":" + stageId）：
 *     swiss   rec = { type:"swiss", picks:{adv30:[队名],adv:[],out03:[]}, pickedAt,
 *                     settled, settledAt, score, total, prize }
 *     bracket rec = { type:"bracket", picks:{w:{matchId:"A"|"B"}}, pickedAt, settled, settledAt, score, total, prize }
 *
 * 结算口径（官方 Major Pick'Em 的 10 选）：瑞士轮猜 3:0 晋级×2 / 3:1·3:2 晋级×6 / 0:3 淘汰×2，
 * 逐桶集合比对——猜进「3:0 桶」的队必须真以 3-0 晋级才算对（位置语义）；
 * 1:3/2:3 淘汰的 6 队是剩余队自动落位，不参与选择与计分（results 里仅供展示）。
 * 淘汰赛逐场比对胜者。奖励：每猜对 +PICKEM_PER_PICK，单阶段全对额外 +PICKEM_PERFECT_BONUS。
 * 截止：阶段/场次开赛前 1 小时（镜像单场竞猜 statusOf 的 3600000 语义）。
 */

/* ---------- 用户侧选择桶（官方 10 选口径，对照完美世界 Major 竞猜截图「进行 0/10 选择」）：
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

export var PICKEM_PER_PICK = 2000;        // 每猜对 1 项的沙粒奖励
export var PICKEM_PERFECT_BONUS = 20000;  // 单阶段全对加成
export var PICKEM_DEADLINE_MS = 3600000;  // 开赛前 1 小时截止（与单场竞猜一致）

/* 挑战币（官方挑战币机制的镜像）：铜=提交过、银=1 阶段全对、金=2、钻=3+ */
export var PICKEM_COINS = [
  { tier: 0, icon: "", name: "" },
  { tier: 1, icon: "🥉", name: "铜币" },
  { tier: 2, icon: "🥈", name: "银币" },
  { tier: 3, icon: "🥇", name: "金币" },
  { tier: 4, icon: "💎", name: "钻石币" }
];

function bucketKeys() {
  return PICKEM_BUCKETS.map(function (b) { return b.k; });
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
  if (!raw || (raw.type !== "swiss" && raw.type !== "bracket" && raw.type !== "series")) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  var teams = (Array.isArray(raw.teams) ? raw.teams : []).filter(validTeam).slice(0, 24).map(function (t) {
    return { name: t.name, short: typeof t.short === "string" ? t.short : "", region: typeof t.region === "string" ? t.region : "", logo: typeof t.logo === "string" ? t.logo : "", w: typeof t.w === "number" && isFinite(t.w) ? t.w : 0, l: typeof t.l === "number" && isFinite(t.l) ? t.l : 0 };
  });
  var matches = (Array.isArray(raw.matches) ? raw.matches : []).filter(validMatch).slice(0, 40).map(function (m) {
    return { id: m.id, a: m.a, b: m.b, startAt: m.startAt, winner: m.winner === "A" || m.winner === "B" ? m.winner : "", score: typeof m.score === "string" ? m.score : "", round: typeof m.round === "number" && isFinite(m.round) ? m.round : 0 };
  });
  var out = {
    id: raw.id, type: raw.type,
    label: typeof raw.label === "string" && raw.label ? raw.label : raw.id,
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
  } else if (raw.type === "bracket") {
    out.rounds = Array.isArray(raw.rounds) ? raw.rounds.filter(function (s) { return typeof s === "string"; }) : [];
    out.degraded = raw.degraded === true;
  }
  // series（逐场猜，1.3.4）：无轮次/无降级概念——任何赛制（双败/联赛/瑞士轮转写）都能逐场猜
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

/** 规范化 state.pickem（loadState/云合并入口）。形状不对的阶段记录整条丢弃；记录数封顶防膨胀 */
export function normalizePickemState(raw) {
  var out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(function (key) {
    if (out[key] || Object.keys(out).length >= 24) return;
    var rec = raw[key];
    if (!rec || typeof rec !== "object" || (rec.type !== "swiss" && rec.type !== "bracket" && rec.type !== "series")) return;
    var clean = {
      type: rec.type,
      picks: rec.type === "swiss" ? normalizeSwissPicks(rec.picks) : normalizeBracketPicks(rec.picks),
      pickedAt: typeof rec.pickedAt === "number" && isFinite(rec.pickedAt) && rec.pickedAt > 0 ? Math.min(Math.round(rec.pickedAt), 1e13) : 0,
      settled: rec.settled === true,
      settledAt: typeof rec.settledAt === "number" && isFinite(rec.settledAt) && rec.settledAt > 0 ? Math.min(Math.round(rec.settledAt), 1e13) : 0,
      score: typeof rec.score === "number" && isFinite(rec.score) && rec.score >= 0 ? Math.round(rec.score) : 0,
      total: typeof rec.total === "number" && isFinite(rec.total) && rec.total >= 0 ? Math.round(rec.total) : 0,
      prize: typeof rec.prize === "number" && isFinite(rec.prize) && rec.prize >= 0 ? Math.round(rec.prize) : 0
    };
    out[key] = clean;
  });
  return out;
}

/* ---------- 阶段状态机（镜像 statusOf：开赛前 1 小时截止） ---------- */

/** 阶段内全部比赛是否已完赛（results 可用 / bracket 可判分） */
export function stageAllDone(stage) {
  return !!stage && stage.matches.length > 0 && stage.matches.every(function (m) { return m.winner === "A" || m.winner === "B"; });
}

/** 该阶段是否可参与竞猜（赛程齐备 + 未截止）。瑞士轮=队数对上 16；淘汰赛=未降级且有可猜场次；系列赛=有可猜场次 */
export function stageOpenForPicks(stage, now) {
  now = now || Date.now();
  if (!stage || stageAllDone(stage)) return false;
  if (stage.type === "series") {
    return pickableSeriesMatches(stage, now).length > 0; // 逐场截止：阶段已开打也能猜剩余场次
  }
  if (stage.type === "swiss") {
    if (stage.teams.length !== PICKEM_SWISS_TEAMS) return false;
  } else {
    if (stage.degraded) return false;
    if (!pickableBracketMatches(stage).length) return false;
  }
  var start = new Date(stage.startsAt).getTime();
  if (isNaN(start)) return false;
  return now < start - PICKEM_DEADLINE_MS; // 开赛前 1 小时停止竞猜
}

/** 淘汰赛里当前可猜的场次：双方确定 + 未完赛 + 未到自己开赛前 1 小时 */
export function pickableBracketMatches(stage, now) {
  now = now || Date.now();
  if (!stage || stage.type !== "bracket" || stage.degraded) return [];
  return stage.matches.filter(function (m) {
    if (!m.a || !m.b) return false; // 对阵未定（等上一轮）
    if (m.winner === "A" || m.winner === "B") return false;
    var start = new Date(m.startAt).getTime();
    return !isNaN(start) && now < start - PICKEM_DEADLINE_MS;
  });
}

/** 系列赛（1.3.4）当前可猜的场次：双方确定 + 未完赛 + 未到自己开赛前 1 小时。任何赛制通用 */
export function pickableSeriesMatches(stage, now) {
  now = now || Date.now();
  if (!stage || stage.type !== "series") return [];
  return stage.matches.filter(function (m) {
    if (!m.a || !m.b) return false;
    if (m.winner === "A" || m.winner === "B") return false;
    var start = new Date(m.startAt).getTime();
    return !isNaN(start) && now < start - PICKEM_DEADLINE_MS;
  });
}

/* ---------- 选择校验与计分 ---------- */

/** 瑞士轮选择是否完整合法：每桶恰好 cap 支、无重复、16 队全覆盖（允许不满时返回 false，由 UI 提示进度） */
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

/** 阶段计分。返回 { correct, total, perfect, prize }；阶段未完赛（results 缺失）返回 null */
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
    var perfect = correct === total;
    return { correct: correct, total: total, perfect: perfect, prize: correct * PICKEM_PER_PICK + (perfect ? PICKEM_PERFECT_BONUS : 0) };
  }
  // series（逐场猜，1.3.4）：只算「用户猜过的、且已有结果的」场次——中途接入公平
  // （赛事已开打时用户没机会猜的场次不计入分母）；逐场竞猜不发全对加成（防「只猜一场就全对」套利），
  // 每猜对 1 场 +PICKEM_PER_PICK
  if (stage.type === "series") {
    var mine = rec.picks && rec.picks.w ? rec.picks.w : {};
    var scored = stage.matches.filter(function (m) {
      return (m.winner === "A" || m.winner === "B") && mine[m.id];
    });
    if (!scored.length) return null;
    var sc = 0;
    scored.forEach(function (m) { if (mine[m.id] === m.winner) sc += 1; });
    return { correct: sc, total: scored.length, perfect: false, prize: sc * PICKEM_PER_PICK };
  }
  // bracket：逐场比对胜者（阶段从开赛前就整段可猜，全部有结果场次计入分母）
  var done = stage.matches.filter(function (m) { return m.winner === "A" || m.winner === "B"; });
  if (!done.length) return null;
  var bc = 0, bt = 0;
  stage.matches.forEach(function (m) {
    if (m.winner !== "A" && m.winner !== "B") return;
    bt += 1;
    var my = rec.picks && rec.picks.w ? rec.picks.w[m.id] : "";
    if (my && my === m.winner) bc += 1;
  });
  var bperfect = bt > 0 && bc === bt;
  return { correct: bc, total: bt, perfect: bperfect, prize: bc * PICKEM_PER_PICK + (bperfect ? PICKEM_PERFECT_BONUS : 0) };
}

/* ---------- 挑战币与统计 ---------- */

/** 挑战币等级：0 未参与 / 1 铜 / 2 银 / 3 金 / 4 钻（全对阶段数 1/2/3+） */
export function pickemCoinOf(pickemState) {
  var recs = normalizePickemState(pickemState);
  var submitted = false, perfect = 0;
  Object.keys(recs).forEach(function (key) {
    var rec = recs[key];
    var hasPicks = rec.type === "swiss"
      ? bucketKeys().some(function (k) { return (rec.picks[k] || []).length > 0; })
      : Object.keys(rec.picks.w || {}).length > 0;
    if (hasPicks) submitted = true;
    if (rec.settled && rec.type === "swiss" && rec.total > 0 && rec.score === rec.total) perfect += 1; // 挑战币只认瑞士轮 10 选全对（series/bracket 全对不发币）
  });
  var tier = perfect >= 3 ? 4 : perfect > 0 ? perfect + 1 : (submitted ? 1 : 0);
  return { tier: tier, coin: PICKEM_COINS[tier], submitted: submitted, perfect: perfect };
}

/* ---------- 云合并（仿 mergeCollection：记录级冲突消解） ---------- */

/** state.pickem 云合并：逐键取「 pickedAt 较新」的一方；settled 取 OR 且随已结算方带 score/total/prize。
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
