/*
 * 选手喜爱榜（1.3.20 实验功能；1.3.26 改造：自定义数量 + 可撤回）：按选手投币的纯函数模块。
 * 平台 3 榜已满不占新榜位——投票清单随每个用户自己的胜榜条目 extra.v 公开携带，
 * 读榜端聚合出「选手收到的金币/钻石币」排行（不提交聚合结果，规避打包编码乘位溢出坑）。
 *
 * 数据模型（app.js#state 两个账本）：
 *   state.pickemVotes   = [{ vid, id, n, t, coin, qty, at }]   —— 投出（append-only）
 *   state.pickemRefunds = [{ ref, id, coin, qty, at }]          —— 撤回（append-only，ref=被撤 vote 的 vid）
 *   vid/ref=唯一键、id=PandaScore 选手 id（禁用 roster 数组下标——applySnapshot 同键整体替换会漂移）、
 *   n/t=选手名/队名快照（聚合展示不依赖 roster 窗口）、coin="g"|"d"、qty=枚数（老数据无 qty 默认 1）。
 *   **账本只增不删**：撤回 = 追加 refund 记录，不删 vote——union 合并下删除会被其他设备复活。
 *
 * 防刷不变式（1.3.26，用户要求「撤回不得导致硬币总量变多」）：
 *   refund 以 ref 为合并去重键 → 按 (id,coin) 维度恒有 Σrefund.qty ≤ Σvote.qty：
 *   - 并发双撤同一票（两设备各生成一条同 ref 的 refund）→ 去重只算一条 → 不会出现负净额
 *     导致后续投币不扣钱的刷币路径；
 *   - 可投余额 = pickemCoins − (Σvote.qty − Σrefund.qty 钳 0) ≤ 生涯累计，撤回永不造币；
 *   - per-player 净投 = Σvote(id).qty − Σrefund(id).qty（钳 0），撤光 = 净额 0 = 自动下榜。
 *
 * 扣减与 pickemCoins 逐键 max 云合并的冲突绕行（2026-11-12 可行性结论）：
 *   pickemCoins 语义不变（生涯累计、max 合并、只增）；投票/撤回明细走本模块 union 合并
 *   （单调只增）；可用余额 = pickemCoins − 净投派生，任何一处都不直接扣减。
 *
 * extra.v 编码（[id, n, t, g, d] 元组，按选手聚合**净投**）：
 *   最坏 ≈578B（既有字段）+ 16 条 × ~110B < 1900B 预算（extra 平台硬顶 2048B）；
 *   trimExtraForBudget 兜底从尾部逐条丢弃（聚合端少计尾部队列，不崩）。
 */

export var VOTE_LEDGER_CAP = 40;    // 投出账本条数上限（写入门校验；union 不截断——丢条目=伪造退款）
export var REFUND_LEDGER_CAP = 80;  // 撤回账本条数上限（≤ vote 上限，撤回粒度=按选手一键全撤）
/* extra.v 携带的选手聚合条数上限，同时是「净持仓选手数」的硬上限（castPlayerVote 校验）——
 * 单常量保证不变式：净持仓>0 的选手数 ≤ 条数上限 → extra.v 完整携带全部净投，聚合榜零丢失。
 * 16 的依据：单届 Major 全对 = 🥇×12（Stage3 瑞士轮 10 + placement 亚/败者 2）+ 💎×1，跨届才可能触达；
 * 字节账：16 条最坏（全汉字名/队名）1249B + 其他字段最坏 578B = 1827B < 1900B 预算（20 条会爆 2048 硬顶）。
 * 撤光一个选手（净额 0 自动下榜）即可投新选手——16 上限不卡死改投。 */
export var VOTES_EXTRA_CAP = 16;
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

var seq = 0;
/** 账本条目唯一 id：时间戳 + 单调序号 + 随机段。非加密用途——唯一性键（union 合并去重），
 *  可预测无安全影响（伪造风险与 extra 公开性同级，设计已知情）；这里要求的是唯一性。 */
export function makeVoteId() {
  return Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);
}

function qtyOf(v) {
  var q = typeof v.qty === "number" && isFinite(v.qty) ? Math.round(v.qty) : 1;
  return Math.min(Math.max(q, 1), 1e6);
}

/* ---------- 投出账本归一：形状校验 + vid 去重（不丢有效条目——丢条目=伪造退款空间） ---------- */
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
      game: typeof v.game === "string" ? v.game.slice(0, 12) : "", // 游戏 key（1.3.27：防同俱乐部不同分部混淆）
      coin: v.coin,
      qty: qtyOf(v), // 老数据无 qty → 默认 1（1.3.25 及以前逐枚投的存量兼容）
      at: typeof v.at === "number" && isFinite(v.at) && v.at > 0 ? v.at : 0
    });
  }
  out.sort(function (a, b) { return a.at - b.at; });
  return out;
}

/** 投出账本云合并：union by vid（两设备并发投票都保留，与 gods/bankrupts 同族单调策略） */
export function mergeVotes(local, cloud) {
  local = normalizeVotes(local);
  var cloudList = normalizeVotes(cloud);
  var seen = {};
  local.forEach(function (v) { seen[v.vid] = 1; });
  cloudList.forEach(function (v) { if (!seen[v.vid]) local.push(v); });
  local.sort(function (a, b) { return a.at - b.at; });
  return local;
}

/* ---------- 撤回账本归一：ref 去重（防刷核心——并发双撤同一票只算一次） ---------- */
export function normalizeRefunds(raw) {
  var out = [];
  if (!Array.isArray(raw)) return out;
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var v = raw[i];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    if (typeof v.ref !== "string" || !v.ref) continue;
    if (typeof v.id !== "number" || !isFinite(v.id) || v.id <= 0 || v.id !== Math.round(v.id)) continue;
    if (!VOTE_COIN_KEYS[v.coin]) continue;
    if (seen[v.ref]) continue; // 同 ref（同一张被撤的票）只算一次——并发双撤去重
    seen[v.ref] = 1;
    out.push({
      ref: v.ref,
      id: v.id,
      coin: v.coin,
      qty: qtyOf(v),
      at: typeof v.at === "number" && isFinite(v.at) && v.at > 0 ? v.at : 0
    });
  }
  out.sort(function (a, b) { return a.at - b.at; });
  return out;
}

/** 撤回账本云合并：union by ref（并发双撤去重后单调只增） */
export function mergeRefunds(local, cloud) {
  local = normalizeRefunds(local);
  var cloudList = normalizeRefunds(cloud);
  var seen = {};
  local.forEach(function (r) { seen[r.ref] = 1; });
  cloudList.forEach(function (r) { if (!seen[r.ref]) local.push(r); });
  local.sort(function (a, b) { return a.at - b.at; });
  return local;
}

/* ---------- 净额派生（余额与榜面统一口径） ---------- */

/** 已投消耗（净额，按币）：Σvote.qty − Σrefund.qty，负数钳 0（脏数据防御——
 *  正常路径下 refund 按 ref 去重后恒 ≤ vote，钳 0 只兜脏数据） */
export function spentCoins(votes, refunds) {
  var out = { g: 0, d: 0 };
  (Array.isArray(votes) ? votes : []).forEach(function (v) {
    if (v && VOTE_COIN_KEYS[v.coin]) out[v.coin] += qtyOf(v);
  });
  (Array.isArray(refunds) ? refunds : []).forEach(function (r) {
    if (r && VOTE_COIN_KEYS[r.coin]) out[r.coin] -= qtyOf(r);
  });
  out.g = Math.max(0, out.g);
  out.d = Math.max(0, out.d);
  return out;
}

/** per-player 净投：{id: {g, d, n, t, game}}——净额钳 0；n/t/game 取最新一条 vote 快照（遍历按 at 升序） */
export function netByPlayer(votes, refunds) {
  var acc = {};
  (Array.isArray(votes) ? votes : []).forEach(function (v) {
    if (!v || !VOTE_COIN_KEYS[v.coin] || typeof v.id !== "number") return;
    var a = acc[v.id];
    if (!a) { a = acc[v.id] = { id: v.id, n: "", t: "", game: "", g: 0, d: 0 }; }
    if (v.n) a.n = v.n; // 升序遍历 → 后写覆盖 = 最新快照
    if (v.t) a.t = v.t;
    if (v.game) a.game = v.game;
    a[v.coin] += qtyOf(v);
  });
  (Array.isArray(refunds) ? refunds : []).forEach(function (r) {
    var a = r && acc[r.id];
    if (!a || !VOTE_COIN_KEYS[r.coin]) return;
    a[r.coin] -= qtyOf(r);
  });
  Object.keys(acc).forEach(function (k) {
    var a = acc[k];
    a.g = Math.max(0, a.g); // 净额钳 0：正常路径 refund≤vote 恒成立，钳 0 只兜脏数据
    a.d = Math.max(0, a.d);
  });
  return acc;
}

/** 可投余额 = 生涯累计（pickemCoins，max 合并）− 净投派生；负数钳 0（脏数据防御） */
export function availableCoins(earned, votes, refunds) {
  var spent = spentCoins(votes, refunds);
  var e = earned && typeof earned === "object" ? earned : {};
  function bal(k) {
    var base = typeof e[k] === "number" && isFinite(e[k]) ? e[k] : 0;
    return Math.max(0, base - spent[k]);
  }
  return { g: bal("g"), d: bal("d") };
}

/** 净持仓>0 的选手集合（{id:1}）——人数硬限校验用（≤ VOTES_EXTRA_CAP；
 *  撤光 = 净额 0 = 不再计数 → 可投新选手，16 上限不卡死改投） */
export function netHolders(votes, refunds) {
  var net = netByPlayer(votes, refunds);
  var seen = {};
  Object.keys(net).forEach(function (k) {
    if (net[k].g + net[k].d > 0) seen[net[k].id] = 1;
  });
  return seen;
}

/* ---------- extra.v 编解码 ---------- */

function votesSort(a, b) {
  return b.d - a.d || b.g - a.g || a.id - b.id; // 钻优先 → 金次之 → id 定序（确定性并列）
}

/** 净投按选手聚合 → 排序取前 VOTES_EXTRA_CAP 条 → [id, n, t, g, d, game] 元组数组
 *  （净额 0 自动不进榜；第 6 位 game=1.3.27 新增防同俱乐部不同分部混淆，老条目 5 位） */
export function encodeVotesExtra(votes, refunds) {
  var net = netByPlayer(votes, refunds);
  var rows = Object.keys(net).map(function (k) { return net[k]; })
    .filter(function (r) { return r.g + r.d > 0; }); // 净额 0（撤光）自动下榜
  rows.sort(votesSort);
  return rows.slice(0, VOTES_EXTRA_CAP).map(function (r) {
    return [r.id, String(r.n || "").slice(0, 12), String(r.t || "").slice(0, 16), r.g, r.d, String(r.game || "").slice(0, 12)];
  });
}

/** 读榜端防御解码：形状不对整条跳过（extra 可伪造，坏条目不能崩聚合）；
 *  元组 5 位=1.3.26 及以前存量（无 game），6 位=1.3.27+（带 game） */
export function decodeVotesExtra(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var it = raw[i];
    if (!Array.isArray(it) || it.length < 5) continue;
    var id = it[0], n = it[1], t = it[2], g = it[3], d = it[4];
    var game = it.length >= 6 && typeof it[5] === "string" ? it[5] : "";
    if (typeof id !== "number" || !isFinite(id) || id <= 0) continue;
    if (typeof n !== "string" || typeof t !== "string") continue;
    if (typeof g !== "number" || !isFinite(g) || g < 0) g = 0;
    if (typeof d !== "number" || !isFinite(d) || d < 0) d = 0;
    out.push({ id: id, n: String(n).slice(0, 12), t: String(t).slice(0, 16), game: String(game).slice(0, 12), g: Math.min(Math.round(g), 1e6), d: Math.min(Math.round(d), 1e6) });
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
 * entries: [{uid, extra}]（getVoteBoard 已归一）；extra.v 逐条累加（值为各用户的**净投**），
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
      if (!a) { a = acc[v.id] = { id: v.id, n: "", t: "", game: "", g: 0, d: 0, voters: 0 }; }
      if (v.n && !a.n) a.n = v.n;
      if (v.t && !a.t) a.t = v.t;
      if (v.game && !a.game) a.game = v.game; // 游戏 key（防同俱乐部不同分部混淆；老条目无此字段）
      a.g += v.g;
      a.d += v.d;
      a.voters += 1;
    });
  });
  var rows = Object.keys(acc).map(function (k) { return acc[k]; });
  rows.sort(votesSort);
  return rows;
}
