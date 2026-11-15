/*
 * 选手喜爱榜（1.3.20 实验功能）：按选手投币的纯函数模块。
 * 平台 3 榜已满不占新榜位——投票清单随每个用户自己的胜榜条目 extra.v 公开携带，
 * 读榜端聚合出「选手收到的金币/钻石币」排行（不提交聚合结果，规避打包编码乘位溢出坑）。
 *
 * 数据模型（app.js#state.pickemVotes，逐条 = 一次投币动作）：
 *   { vid, id, n, t, coin, at }
 *   vid=唯一投票 id（union 合并键）、id=PandaScore 选手 id（禁用 roster 数组下标——
 *   applySnapshot 同键整体替换会漂移）、n/t=选手名/队名快照（聚合展示不依赖 roster 窗口）、
 *   coin="g"|"d"、at=时间戳。append-only：投出不可撤回（每条消耗 1 枚对应硬币）。
 *
 * 扣减与 pickemCoins 逐键 max 云合并的冲突绕行（2026-11-12 可行性结论）：
 *   pickemCoins 语义不变（生涯累计、max 合并、只增）；投出明细走本模块 union by vid
 *   合并（单调只增）；可用余额 = pickemCoins − spentVotes 派生，任何一处都不直接扣减。
 *
 * extra.v 编码（[id, n, t, g, d] 元组，按选手聚合我方投票）：
 *   最坏 ≈578B（既有字段）+ 8 条 × ~110B < 1900B 预算（extra 平台硬顶 2048B）；
 *   trimExtraForBudget 兜底从尾部逐条丢弃（聚合端少计尾部队列，不崩）。
 */

export var VOTE_LEDGER_CAP = 40;    // 投票明细条数上限（=生涯金/钻总枚数量级，实际不可达；兜 Sync 16KB 体积）
export var VOTES_EXTRA_CAP = 8;     // extra.v 携带的选手聚合条数上限（按 d/g 取最靠前的）
export var EXTRA_BYTE_BUDGET = 1900; // extra JSON 字节预算（平台硬顶 2048，留缓冲）

var VOTE_COIN_KEYS = { g: 1, d: 1 }; // 仅金/钻石币可投（用户拍板：铜/银不参与）

/* ---------- UTF-8 字节估算（与 duel-extra.mjs 口径一致；emoji 4B、汉字 3B） ---------- */
export function utf8Len(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } // 代理对合占 4B
    else n += 3;
  }
  return n;
}

var voteSeq = 0;
/** 投票唯一 id：时间戳 + 单调序号 + 随机段。非加密用途——vid 是 union 合并的去重键，
 *  可预测无安全影响（投票伪造风险与 extra 公开性同级，设计已知情）；这里要求的是唯一性。 */
export function makeVoteId() {
  return Date.now().toString(36) + (voteSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------- 账本归一：形状校验 + vid 去重（不丢有效条目——丢条目=伪造退款） ---------- */
export function normalizeVotes(raw) {
  var out = [];
  if (!Array.isArray(raw)) return out;
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var v = raw[i];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    if (typeof v.vid !== "string" || !v.vid) continue;
    if (typeof v.id !== "number" || !isFinite(v.id) || v.id <= 0 || v.id !== Math.round(v.id)) continue;
    if (!VOTE_COIN_KEYS[v.coin]) continue;
    if (seen[v.vid]) continue;
    seen[v.vid] = 1;
    out.push({
      vid: v.vid,
      id: v.id,
      n: typeof v.n === "string" ? v.n.slice(0, 12) : "",
      t: typeof v.t === "string" ? v.t.slice(0, 16) : "",
      coin: v.coin,
      at: typeof v.at === "number" && isFinite(v.at) && v.at > 0 ? v.at : 0
    });
  }
  out.sort(function (a, b) { return a.at - b.at; });
  return out;
}

/** 云合并：union by vid（单调只增；两设备并发投票都保留，与 gods/bankrupts 同族单调策略） */
export function mergeVotes(local, cloud) {
  local = normalizeVotes(local);
  var cloudList = normalizeVotes(cloud);
  var seen = {};
  local.forEach(function (v) { seen[v.vid] = 1; });
  cloudList.forEach(function (v) { if (!seen[v.vid]) local.push(v); });
  local.sort(function (a, b) { return a.at - b.at; });
  return local;
}

/** 已投消耗：每条投币动作 = 1 枚对应币 */
export function spentCoins(votes) {
  var out = { g: 0, d: 0 };
  (Array.isArray(votes) ? votes : []).forEach(function (v) {
    if (v && VOTE_COIN_KEYS[v.coin]) out[v.coin] += 1;
  });
  return out;
}

/** 可投余额 = 生涯累计（pickemCoins，max 合并）− 已投派生；负数钳 0（脏数据防御） */
export function availableCoins(earned, votes) {
  var spent = spentCoins(votes);
  var e = earned && typeof earned === "object" ? earned : {};
  function bal(k) {
    var base = typeof e[k] === "number" && isFinite(e[k]) ? e[k] : 0;
    return Math.max(0, base - spent[k]);
  }
  return { g: bal("g"), d: bal("d") };
}

/* ---------- extra.v 编解码 ---------- */

function votesSort(a, b) {
  return b.d - a.d || b.g - a.g || a.id - b.id; // 钻优先 → 金次之 → id 定序（确定性并列）
}

/** 我方投票按选手聚合 → 排序取前 VOTES_EXTRA_CAP 条 → [id, n, t, g, d] 元组数组 */
export function encodeVotesExtra(votes) {
  var acc = {};
  (Array.isArray(votes) ? votes : []).forEach(function (v) {
    if (!v || !VOTE_COIN_KEYS[v.coin] || typeof v.id !== "number") return;
    var a = acc[v.id];
    if (!a) { a = acc[v.id] = { id: v.id, n: "", t: "", g: 0, d: 0 }; }
    if (v.n && !a.n) a.n = v.n;
    if (v.t && !a.t) a.t = v.t;
    a[v.coin] += 1;
  });
  var rows = Object.keys(acc).map(function (k) { return acc[k]; });
  rows.sort(votesSort);
  return rows.slice(0, VOTES_EXTRA_CAP).map(function (r) {
    return [r.id, String(r.n || "").slice(0, 12), String(r.t || "").slice(0, 16), r.g, r.d];
  });
}

/** 读榜端防御解码：形状不对整条跳过（extra 可伪造，坏条目不能崩聚合） */
export function decodeVotesExtra(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var it = raw[i];
    if (!Array.isArray(it) || it.length < 5) continue;
    var id = it[0], n = it[1], t = it[2], g = it[3], d = it[4];
    if (typeof id !== "number" || !isFinite(id) || id <= 0) continue;
    if (typeof n !== "string" || typeof t !== "string") continue;
    if (typeof g !== "number" || !isFinite(g) || g < 0) g = 0;
    if (typeof d !== "number" || !isFinite(d) || d < 0) d = 0;
    out.push({ id: id, n: String(n).slice(0, 12), t: String(t).slice(0, 16), g: Math.min(Math.round(g), 1e6), d: Math.min(Math.round(d), 1e6) });
  }
  return out;
}

/** 提交门控比较：两份 extra.v 是否等价（元组数组 JSON 同构比较；undefined 视为空） */
export function votesExtraEqual(a, b) {
  return JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(Array.isArray(b) ? b : []);
}

/** extra 字节守卫：超预算时从 extra.v 尾部逐条丢弃（其余字段是展示必需，不动） */
export function trimExtraForBudget(extra, budget) {
  var cap = typeof budget === "number" && budget > 0 ? budget : EXTRA_BYTE_BUDGET;
  if (!extra || typeof extra !== "object") return extra;
  while (Array.isArray(extra.v) && extra.v.length && utf8Len(JSON.stringify(extra)) > cap) {
    extra.v.pop();
  }
  return extra;
}

/* ---------- 全榜聚合（读榜端） ---------- */

/**
 * 胜榜条目列表 → 选手收币排行。
 * entries: [{uid, extra}]（getVoteBoard 已归一）；extra.v 逐条累加，
 * n/t 取首次遇到的非空快照（同一选手多用户投票时队名可能不同——旧快照仍可读）。
 * 返回 [{id, n, t, g, d, voters}] 按 d desc→g desc→id asc。
 */
export function aggregateBoardVotes(entries) {
  var acc = {};
  (Array.isArray(entries) ? entries : []).forEach(function (e) {
    if (!e) return;
    var votes = decodeVotesExtra(e.extra && e.extra.v);
    votes.forEach(function (v) {
      var a = acc[v.id];
      if (!a) { a = acc[v.id] = { id: v.id, n: "", t: "", g: 0, d: 0, voters: 0 }; }
      if (v.n && !a.n) a.n = v.n;
      if (v.t && !a.t) a.t = v.t;
      a.g += v.g;
      a.d += v.d;
      a.voters += 1;
    });
  });
  var rows = Object.keys(acc).map(function (k) { return acc[k]; });
  rows.sort(votesSort);
  return rows;
}
