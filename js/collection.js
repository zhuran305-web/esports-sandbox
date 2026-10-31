/* 战队图鉴与跟队连击（纯函数模块：无 DOM/存储/SDK 依赖，可被 tools/test-cloud-nick.mjs 直跑单测）
 *
 * 条目结构：collection[game + ":" + 队名] = { b, w, l, s, bs, ls }
 *   b   押过场次数（下注即 +1，含未结算；全撤不回退——「押过」是历史事实）
 *   w/l 已结算胜负（只统计押该队的场次；胜率分母 = w + l）
 *   s   当前跟队连击（只记「跟」不记「赢」：连续押中该队的场次，漏看/押对手/改投即断）
 *   bs  最佳跟队连击（荣誉留档，云端合并取 max）
 *   ls  连击锚点 = 最近一次续连击场次的 startAt 时间戳；兼作图鉴 LRU 淘汰序
 *
 * 语义口径（2026-10-31 拍板）：
 *   - 连击按「战队比赛顺序」计，不按自然日（队伍休赛不断签）
 *   - 同名战队跨游戏分键（lol:T1 与 val:T1 是两条）；数据层无战队 id，接受同游戏重名噪声
 *   - 断签不豁免：没开小程序错过 = 断（bs 留档）
 *   - 结算不碰连击；转生不清图鉴；清除本地数据后靠战绩云同步拉回（与胜负战绩同路径）
 */

/* 条目上限：≈45B/条，150 条 ≈7KB，给 cloud.storage 15KB 预算留空间 */
export var COLLECTION_MAX = 150;

/* 连击可验证窗口：已结束比赛 retention 45 天，间隔超出后数据里查不到间隔场次，保守断签 */
var VERIFY_WINDOW_MS = 40 * 86400000;

function nonNeg(v) {
  // 上限取 1e13（≈公元 2286 年）：ls 存毫秒时间戳（现值 ~1.7e12），不能按计数字段钳到 1e12
  return typeof v === "number" && isFinite(v) && v > 0 ? Math.min(Math.round(v), 1e13) : 0;
}

/** 校验并规范化一个 collection（loadState/合并入口）；非法字段一律回退 0 */
export function normalizeCollection(raw) {
  var out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(function (k) {
    var v = raw[k];
    if (!v || typeof v !== "object") return;
    out[k] = { b: nonNeg(v.b), w: nonNeg(v.w), l: nonNeg(v.l), s: nonNeg(v.s), bs: nonNeg(v.bs), ls: nonNeg(v.ls) };
  });
  return out;
}

/** 从比赛 + pick 解析被押队伍：{ key, name, game }；数据异常返回 null */
export function pickedTeamOf(match, pick) {
  if (!match || !match.game || (pick !== "A" && pick !== "B")) return null;
  var team = pick === "A" ? match.teamA : match.teamB;
  if (!team || !team.name) return null;
  return { key: match.game + ":" + team.name, name: team.name, game: match.game };
}

/** 该队在某一场的侧位（"A"/"B"）；不是本场参战方返回 "" */
export function teamSideIn(match, name) {
  if (!match || !name) return "";
  if (match.teamA && match.teamA.name === name) return "A";
  if (match.teamB && match.teamB.name === name) return "B";
  return "";
}

function startTs(m) {
  var t = new Date(m.startAt).getTime();
  return isFinite(t) ? t : 0;
}

function entryOf(coll, key) {
  if (!coll[key]) coll[key] = { b: 0, w: 0, l: 0, s: 0, bs: 0, ls: 0 };
  return coll[key];
}

/**
 * 下注钩子（新投入或改选时调用；加注未改选不要调用——b 按场次计不按次数计）。
 * prevPick 非空且 ≠ pick 视为改选：旧队 b-1 且连击清零（bs/ls 留档），新队正常收录。
 * matchesAll：当前数据快照（查间隔场次用）；predictionForFn(id)：查某场预测（连击核对用）。
 * 连击检测：查当前数据里两场之间该队的其他比赛，逐场核对「押了且押的是它」——
 *   全押对 → s+1；漏看/押对手/已全撤 → 断 s=1；间隔超出可验证窗口 → 保守断。
 */
export function onBet(coll, match, pick, prevPick, matchesAll, predictionForFn) {
  coll = normalizeCollection(coll);
  var picked = pickedTeamOf(match, pick);
  if (!picked) return coll;
  if (prevPick && prevPick !== pick) {
    var old = pickedTeamOf(match, prevPick);
    if (old && coll[old.key]) {
      coll[old.key].b = Math.max(0, coll[old.key].b - 1);
      coll[old.key].s = 0; // 改投对面：跟队中断
    }
  }
  var e = entryOf(coll, picked.key);
  e.b += 1;
  var ms = startTs(match);
  var broken = !(e.s > 0 && e.ls > 0);
  if (!broken) {
    if (ms - e.ls > VERIFY_WINDOW_MS) {
      broken = true;
    } else {
      var list = (matchesAll || []).filter(function (x) {
        if (!x || !x.id || x.game !== match.game) return false;
        if (teamSideIn(x, picked.name) === "") return false;
        var t = startTs(x);
        return t > e.ls && t < ms;
      });
      for (var i = 0; i < list.length; i++) {
        var bet = predictionForFn ? predictionForFn(list[i].id) : null;
        if (!bet || bet.pick !== teamSideIn(list[i], picked.name)) { broken = true; break; }
      }
    }
  }
  e.s = broken ? 1 : e.s + 1;
  if (e.s > e.bs) e.bs = e.s;
  e.ls = ms;
  return capCollection(coll);
}

/** 结算钩子：押该队的已结算场次计胜负。功能上线前下的旧注没有收录记录，b 回补到 w+l。 */
export function onSettle(coll, match, pick, won) {
  coll = normalizeCollection(coll);
  var picked = pickedTeamOf(match, pick);
  if (!picked) return coll;
  var e = entryOf(coll, picked.key);
  if (won) e.w += 1; else e.l += 1;
  if (e.b < e.w + e.l) e.b = e.w + e.l;
  return coll;
}

/** 云合并：b/w/l/bs 取 max（单调计数）；s/ls 作为一对取 ls 较新一方（连击连续性归最近活动的设备） */
export function mergeCollection(local, cloud) {
  local = normalizeCollection(local);
  cloud = normalizeCollection(cloud);
  Object.keys(cloud).forEach(function (k) {
    var a = local[k], b = cloud[k];
    if (!a) { local[k] = b; return; }
    var newer = a.ls >= b.ls ? a : b;
    local[k] = {
      b: Math.max(a.b, b.b),
      w: Math.max(a.w, b.w),
      l: Math.max(a.l, b.l),
      bs: Math.max(a.bs, b.bs),
      s: newer.s,
      ls: newer.ls
    };
  });
  return capCollection(local);
}

/** 图鉴上限：超出按 ls 最旧淘汰（ls=0 的旧版补录条目最先淘汰） */
export function capCollection(coll, max) {
  var keys = Object.keys(coll);
  var cap = max || COLLECTION_MAX;
  if (keys.length <= cap) return coll;
  keys.sort(function (x, y) { return (coll[x].ls || 0) - (coll[y].ls || 0); });
  while (keys.length > cap) delete coll[keys.shift()];
  return coll;
}

/** 汇总：我的页图鉴区/分享卡/对比链接共用。list 按 ls 新→旧；top 按当前连击取 3；rate = 押该队胜率(%)，无结算为 null */
export function collectionSummary(coll) {
  var c = normalizeCollection(coll);
  var list = Object.keys(c).map(function (k) {
    var e = c[k];
    var sep = k.indexOf(":");
    var settledN = e.w + e.l;
    return {
      key: k,
      game: sep > 0 ? k.slice(0, sep) : "",
      name: sep > 0 ? k.slice(sep + 1) : k,
      b: e.b, w: e.w, l: e.l, s: e.s, bs: e.bs, ls: e.ls,
      rate: settledN ? Math.round((e.w / settledN) * 100) : null
    };
  });
  list.sort(function (x, y) { return (y.ls || 0) - (x.ls || 0); });
  var top = list.slice()
    .sort(function (x, y) { return (y.s - x.s) || (y.bs - x.bs) || ((y.ls || 0) - (x.ls || 0)); })
    .slice(0, 3)
    .filter(function (t) { return t.s > 0 || t.bs > 0; });
  var bestStreak = 0;
  Object.keys(c).forEach(function (k) { if (c[k].bs > bestStreak) bestStreak = c[k].bs; });
  return { teams: list.length, bestStreak: bestStreak, top: top, list: list };
}
