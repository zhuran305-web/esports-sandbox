/* 成就殿堂（1.2.10）：纯函数模块，零 DOM/存储/SDK 依赖，可被 tools/test-cloud-nick.mjs 直跑。
 *
 * 结构：ACHV_DEFS 每条 { id, g 组名, icon, name 成就名, desc, title 称号名, hidden, test(s) }
 *   s = 统计快照（app.js 的 buildAchvSnapshot 构建，字段全是现成本地数据的现算值）；
 *   test 返回 true 即满足解锁条件，调用方（checkAchievements）负责用 state.achv 锁存——
 *   解锁即永久（清除本地数据后随战绩云同步拉回）。
 * 称号：装备的成就 id 写 state.title → 榜单 extra.title（存 id 不存文案，跨端用本表还原；
 *   未知 id 不渲染徽章 = 天然灰度）。extra 新字段的提交门控见 cloud.js#submitBoardWithNick。
 */

export var ACHV_DEFS = [
  /* ---------- 竞猜 ---------- */
  { id: "first_bet", g: "竞猜", icon: "🌱", name: "初来乍到", desc: "完成第一笔竞猜", title: "新沙粒", hidden: false,
    test: function (s) { return s.bets >= 1; } },
  { id: "first_win", g: "竞猜", icon: "🎯", name: "初胜", desc: "第一次猜对", title: "开门红", hidden: false,
    test: function (s) { return s.wins >= 1; } },
  { id: "bets_10", g: "竞猜", icon: "📝", name: "小试牛刀", desc: "累计竞猜 10 场", title: "练手期", hidden: false,
    test: function (s) { return s.bets >= 10; } },
  { id: "bets_100", g: "竞猜", icon: "📒", name: "百场老登", desc: "累计竞猜 100 场", title: "老登", hidden: false,
    test: function (s) { return s.bets >= 100; } },
  { id: "bets_1000", g: "竞猜", icon: "🏺", name: "千场传说", desc: "累计竞猜 1000 场", title: "千场传说", hidden: false,
    test: function (s) { return s.bets >= 1000; } },
  { id: "win_10", g: "竞猜", icon: "🔥", name: "小有名气", desc: "累计猜对 10 场", title: "十胜将", hidden: false,
    test: function (s) { return s.wins >= 10; } },
  { id: "win_100", g: "竞猜", icon: "⚔", name: "百胜将军", desc: "累计猜对 100 场", title: "百胜将军", hidden: false,
    test: function (s) { return s.wins >= 100; } },
  { id: "streak_3", g: "竞猜", icon: "✨", name: "三连击", desc: "连续猜对 3 场", title: "三连", hidden: false,
    test: function (s) { return s.bestWinStreak >= 3; } },
  { id: "streak_5", g: "竞猜", icon: "🌟", name: "五连击", desc: "连续猜对 5 场", title: "五连", hidden: false,
    test: function (s) { return s.bestWinStreak >= 5; } },
  { id: "streak_10", g: "竞猜", icon: "💫", name: "十连胜", desc: "连续猜对 10 场", title: "十连传说", hidden: false,
    test: function (s) { return s.bestWinStreak >= 10; } },

  /* ---------- 风雨（负债与重仓） ---------- */
  { id: "debt_first", g: "风雨", icon: "🌧", name: "负债行者", desc: "沙粒首次为负", title: "负债行者", hidden: false,
    test: function (s) { return s.bankroll < 0; } },
  { id: "debt_50k", g: "风雨", icon: "🕳", name: "深渊回望", desc: "负债一度达到 5 万", title: "深渊归人", hidden: false,
    test: function (s) { return s.minBankroll <= -50000; } },
  { id: "debt_recover", g: "风雨", icon: "🌄", name: "绝地重生", desc: "从负债 5 万爬回正数", title: "绝地重生", hidden: false,
    test: function (s) { return s.minBankroll <= -50000 && s.bankroll >= 0; } },
  { id: "stake_50k", g: "风雨", icon: "💎", name: "千金一掷", desc: "单场投入 5 万沙粒", title: "豪客", hidden: false,
    test: function (s) { return s.maxStake >= 50000; } },

  /* ---------- 图鉴 ---------- */
  { id: "codex_1", g: "图鉴", icon: "🔖", name: "初识", desc: "押过第一支队伍", title: "识途", hidden: false,
    test: function (s) { return s.codexTeams >= 1; } },
  { id: "codex_10", g: "图鉴", icon: "📚", name: "收藏家", desc: "图鉴收录 10 支队伍", title: "收藏家", hidden: false,
    test: function (s) { return s.codexTeams >= 10; } },
  { id: "codex_30", g: "图鉴", icon: "🗺", name: "图鉴大师", desc: "图鉴收录 30 支队伍", title: "图鉴大师", hidden: false,
    test: function (s) { return s.codexTeams >= 30; } },
  { id: "codex_80", g: "图鉴", icon: "🧭", name: "图鉴学者", desc: "图鉴收录 80 支队伍", title: "图鉴学者", hidden: false,
    test: function (s) { return s.codexTeams >= 80; } },
  { id: "codex_150", g: "图鉴", icon: "👑", name: "全图鉴", desc: "图鉴收录 150 支队伍（上限）", title: "全图鉴", hidden: false,
    test: function (s) { return s.codexTeams >= 150; } },
  { id: "follow_5", g: "图鉴", icon: "🤝", name: "忠实粉丝", desc: "跟队连击达到 5", title: "忠实粉丝", hidden: false,
    test: function (s) { return s.codexFollowBest >= 5; } },
  { id: "follow_10", g: "图鉴", icon: "🧱", name: "铁杆粉丝", desc: "跟队连击达到 10", title: "铁杆", hidden: false,
    test: function (s) { return s.codexFollowBest >= 10; } },
  { id: "follow_20", g: "图鉴", icon: "🛡", name: "信仰", desc: "跟队连击达到 20", title: "信仰", hidden: false,
    test: function (s) { return s.codexFollowBest >= 20; } },

  /* ---------- 对决 ---------- */
  { id: "duel_first", g: "对决", icon: "✉", name: "初次约战", desc: "发出或参与第一场对决", title: "约战人", hidden: false,
    test: function (s) { return s.duelsTotal >= 1; } },
  { id: "duel_win_1", g: "对决", icon: "🥊", name: "开胡", desc: "赢下第一场对决", title: "开胡", hidden: false,
    test: function (s) { return s.duelsWon >= 1; } },
  { id: "duel_win_10", g: "对决", icon: "🏅", name: "擂台好手", desc: "对决 10 胜", title: "擂台好手", hidden: false,
    test: function (s) { return s.duelsWon >= 10; } },
  { id: "duel_20", g: "对决", icon: "🏛", name: "擂台常客", desc: "参与 20 场对决", title: "擂台常客", hidden: false,
    test: function (s) { return s.duelsTotal >= 20; } },

  /* ---------- 转生 ---------- */
  { id: "god_1", g: "转生", icon: "⛩", name: "封神", desc: "完成第一次封神仪式", title: "封神", hidden: false,
    test: function (s) { return s.gods >= 1; } },
  { id: "god_3", g: "转生", icon: "🎆", name: "三冠加身", desc: "封神 3 次", title: "三冠魔神", hidden: false,
    test: function (s) { return s.gods >= 3; } },
  { id: "bankrupt_1", g: "转生", icon: "💀", name: "破产者", desc: "完成第一次破产仪式", title: "破产者", hidden: false,
    test: function (s) { return s.bankrupts >= 1; } },
  { id: "bankrupt_3", g: "转生", icon: "🌀", name: "屡败屡战", desc: "破产 3 次", title: "屡败屡战", hidden: false,
    test: function (s) { return s.bankrupts >= 3; } },
  { id: "temple_5", g: "转生", icon: "🕯", name: "殿里常客", desc: "封神与破产合计 5 次", title: "殿里常客", hidden: false,
    test: function (s) { return s.gods + s.bankrupts >= 5; } },

  /* ---------- 隐藏 ---------- */
  { id: "loss_10", g: "隐藏", icon: "🎭", name: "反向预言家", desc: "连续猜错 10 场（这也是一种天赋）", title: "反向预言家", hidden: true,
    test: function (s) { return s.lossStreakBest >= 10; } },
  { id: "night_owl", g: "隐藏", icon: "🦉", name: "夜猫子", desc: "凌晨 2-5 点下注 5 场", title: "夜猫子", hidden: true,
    test: function (s) { return s.nightBets >= 5; } }
];

/** 校验并规范化 achv 映射（loadState/云合并入口）；时间戳上限同 collection 的 1e13 */
export function normalizeAchv(raw) {
  var out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.keys(raw).forEach(function (k) {
    var v = raw[k];
    if (typeof v === "number" && isFinite(v) && v > 0) out[k] = Math.min(Math.round(v), 1e13);
  });
  return out;
}

/** 云合并：逐键取 max（时间戳单调，同 gods/bankrupts 族） */
export function mergeAchv(local, cloud) {
  local = normalizeAchv(local);
  cloud = normalizeAchv(cloud);
  Object.keys(cloud).forEach(function (k) {
    if (!local[k] || cloud[k] > local[k]) local[k] = cloud[k];
  });
  return local;
}

/** 返回快照 s 下「尚未解锁且条件满足」的成就 id 列表（调用方负责锁存） */
export function evalAchievements(s, unlocked) {
  var out = [];
  if (!s) return out;
  ACHV_DEFS.forEach(function (d) {
    if (unlocked && unlocked[d.id]) return;
    var ok = false;
    try { ok = !!d.test(s); } catch (e) { ok = false; }
    if (ok) out.push(d.id);
  });
  return out;
}

export function achvById(id) {
  for (var i = 0; i < ACHV_DEFS.length; i++) {
    if (ACHV_DEFS[i].id === id) return ACHV_DEFS[i];
  }
  return null;
}

/** 称号名；未知 id（旧客户端收到新版本称号）返回 "" 不渲染徽章 */
export function achvTitle(id) {
  var d = achvById(id);
  return d ? d.title : "";
}
