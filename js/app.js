import matchesData from "../data/matches.json";
import { Cloud, Account } from "./cloud.js";
import { initPlatform, storageGet, storageSet } from "./platform.js";
import { isRuntimeEnabled, loadCachedSnapshot, fetchRemoteSnapshot } from "./data-source.js";

(function () {
  "use strict";

  /* ============================== 配置 ============================== */
  var DATA = matchesData;
  var MATCHES = (DATA.matches || []).slice();
  var DATA_UPDATED_AT = DATA.updatedAt || "";
  var STORAGE_KEY = "esports_sandbox_v2";
  var ONBOARD_KEY = "esports_sandbox_onboarded";
  var APP_VERSION = "1.0.0";
  var START_BALANCE = 10000;
  var MIN_STAKE = 10;
  var STAKE_FIXED = [10, 100, 1000];
  var LEVERAGE = 2; // 正数沙粒最多投入余额的 2 倍
  var BONUS_TABLE = [0, 0.1, 0.2, 0.3, 0.5];
  var PALETTE = [
    ["#ff9a52", "#c94b00"],
    ["#5b95ff", "#1c4fd8"],
    ["#a878ff", "#5d2bd8"],
    ["#3ddba4", "#0e8f63"],
    ["#ff6b97", "#c21e56"],
    ["#ffd166", "#c98b00"],
    ["#55d6e6", "#0a8a99"],
    ["#9fb0c4", "#52627a"]
  ];

  // 游戏注册表：新增赛事游戏时在这里补一条，再把赛程写入 data/matches.json（或 data/manual-matches.json）
  var GAMES = {
    cs2: { label: "CS2", chip: "CS2", c1: "#ffc08a", c2: "#ff8a3d", dark: true },
    valorant: { label: "瓦罗兰特", chip: "VAL", c1: "#ff9aa2", c2: "#ff4655", dark: true },
    lol: { label: "英雄联盟", chip: "LOL", c1: "#f5d98a", c2: "#c9a227", dark: true },
    dota2: { label: "Dota 2", chip: "DOTA", c1: "#ff9d8f", c2: "#c0392b", dark: true },
    kpl: { label: "王者荣耀", chip: "KPL", c1: "#a8c8ff", c2: "#3d6bff", dark: false },
    aov: { label: "传说对决", chip: "AOV", c1: "#b8d4ff", c2: "#3d6bff", dark: false },
    pubg: { label: "PUBG", chip: "PUBG", c1: "#ffe08a", c2: "#b8860b", dark: true },
    pubgm: { label: "和平精英", chip: "PEL", c1: "#ffe6a8", c2: "#e6a800", dark: true },
    apex: { label: "Apex 英雄", chip: "APEX", c1: "#ff9d8a", c2: "#c62828", dark: true },
    fortnite: { label: "堡垒之夜", chip: "FN", c1: "#c9b6ff", c2: "#6c4ce0", dark: false },
    r6: { label: "彩虹六号", chip: "R6", c1: "#d7dfe9", c2: "#5c6b82", dark: true },
    sf: { label: "街霸6", chip: "SF6", c1: "#9ad8ff", c2: "#2f6bff", dark: false },
    ff: { label: "饿狼传说", chip: "FF", c1: "#ffc08a", c2: "#c0392b", dark: true },
    cf: { label: "穿越火线", chip: "CF", c1: "#ffd08a", c2: "#d97706", dark: true },
    identityv: { label: "第五人格", chip: "IVL", c1: "#c9b6ff", c2: "#7c5cff", dark: false },
    mlbb: { label: "无尽对决", chip: "MLBB", c1: "#9fe0ff", c2: "#1f8fd6", dark: false },
    ow: { label: "守望先锋", chip: "OW", c1: "#ffd08a", c2: "#f99e1a", dark: true },
    rl: { label: "火箭联盟", chip: "RL", c1: "#9ad8ff", c2: "#2f6bff", dark: false },
    fifa: { label: "EA Sports FC", chip: "FC", c1: "#b8f5c8", c2: "#1fa855", dark: true },
    codmw: { label: "使命召唤", chip: "COD", c1: "#d7dfe9", c2: "#5c6b82", dark: true },
    "starcraft-2": { label: "星际争霸2", chip: "SC2", c1: "#c9b6ff", c2: "#6c4ce0", dark: false },
    "starcraft-brood-war": { label: "星际母巢之战", chip: "SC1", c1: "#e0cfae", c2: "#8a6d3b", dark: true },
    "lol-wild-rift": { label: "英雄联盟手游", chip: "WR", c1: "#f5d98a", c2: "#c9a227", dark: true }
  };
  var GAME_ORDER = [
    "cs2", "valorant", "lol", "dota2", "kpl", "aov", "pubg", "pubgm",
    "apex", "fortnite", "r6", "sf", "ff", "cf", "identityv",
    "mlbb", "ow", "rl", "fifa", "codmw", "starcraft-2", "starcraft-brood-war", "lol-wild-rift"
  ];

  /* ============================== 状态 ============================== */
  var state = { bankroll: START_BALANCE, predictions: [], digs: 0 };
  var currentGame = "all";
  var currentTournament = "__all__";
  var currentStatus = "all";
  var schedGame = "all";
  var schedTournament = "__all__";
  var schedQuery = "";
  var searchTimer = null;
  var SCHEDULE_WINDOW_DAYS = 30;
  var HOME_PAST_DAYS = 1;
  var HOME_FUTURE_DAYS = 14;
  var TIER_RANK = { s: 0, a: 1, b: 2, c: 3, d: 4 };
  var sheetMatchId = null;
  var sheetPick = "A";
  var toastTimer = null;

  /* ============================== 工具 ============================== */
  function $(sel) { return document.querySelector(sel); }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString("zh-CN");
  }

  async function loadState() {
    var base = { bankroll: START_BALANCE, predictions: [], digs: 0 };
    try {
      var raw = await storageGet(STORAGE_KEY);
      if (!raw) return base;
      var parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== "object") return base;
      return {
        bankroll: typeof parsed.bankroll === "number" && isFinite(parsed.bankroll) ? parsed.bankroll : START_BALANCE,
        predictions: Array.isArray(parsed.predictions) ? parsed.predictions : [],
        digs: typeof parsed.digs === "number" ? parsed.digs : 0
      };
    } catch (e) {
      return base;
    }
  }

  function saveState() {
    storageSet(STORAGE_KEY, state);
  }

  function matchById(id) {
    for (var i = 0; i < MATCHES.length; i++) {
      if (MATCHES[i].id === id) return MATCHES[i];
    }
    return null;
  }

  function matchStart(id) {
    var m = matchById(id);
    return m ? new Date(m.startAt).getTime() : 0;
  }

  function predictionFor(id) {
    for (var i = 0; i < state.predictions.length; i++) {
      if (state.predictions[i].matchId === id) return state.predictions[i];
    }
    return null;
  }

  function matchDurationMs(m) {
    var bo = parseInt(String(m.format || "BO3").replace(/\D/g, ""), 10) || 3;
    var hours = bo <= 1 ? 1 : bo === 2 ? 1.5 : bo === 3 ? 2.5 : bo === 4 ? 3.5 : bo === 5 ? 4 : 5.5;
    return hours * 3600000;
  }

  function statusOf(m) {
    if (m.result && (m.result.winner === "A" || m.result.winner === "B")) {
      return "finished";
    }
    var now = Date.now();
    var start = new Date(m.startAt).getTime();
    if (now < start - 3600000) return "open";      // 开赛前 1 小时停止竞猜
    if (now < start) return "locked";               // 已截止，尚未开赛
    if (now < start + matchDurationMs(m)) return "live"; // 预计比赛进行中
    return "awaiting";                              // 已超过预计时长，等待赛果
  }

  function settledInOrder() {
    return state.predictions
      .filter(function (p) { return p.settled; })
      .sort(function (a, b) { return matchStart(a.matchId) - matchStart(b.matchId); });
  }

  function currentStreak() {
    var list = settledInOrder();
    var streak = 0;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].won) streak++;
      else break;
    }
    return streak;
  }

  function bestStreak() {
    var list = settledInOrder();
    var best = 0, run = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].won) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    return best;
  }

  function bonusRateForNextWin() {
    return BONUS_TABLE[Math.min(currentStreak(), BONUS_TABLE.length - 1)];
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    var now = new Date();
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return "今天 " + hh + ":" + mm;
    var tmr = new Date(now.getTime() + 86400000);
    if (d.toDateString() === tmr.toDateString()) return "明天 " + hh + ":" + mm;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hh + ":" + mm;
  }

  function avatarStyle(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    var pair = PALETTE[h % PALETTE.length];
    return "background:linear-gradient(145deg," + pair[0] + "," + pair[1] + ")";
  }

  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2400);
  }

  /* ============================== 结算 ============================== */
  function settlePending() {
    var pending = state.predictions.filter(function (p) { return !p.settled; });
    if (!pending.length) return [];

    pending.sort(function (a, b) { return matchStart(a.matchId) - matchStart(b.matchId); });

    var events = [];
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i];
      var m = matchById(p.matchId);
      if (!m || statusOf(m) !== "finished") continue;

      var won = m.result.winner === p.pick;
      // 猜对：返还 2 倍投入（净赚 1 倍）+ 连对加成；猜错：从余额中扣除投入（可能变为负债）
      var streakBefore = currentStreak();
      var bonus = won ? BONUS_TABLE[Math.min(streakBefore, BONUS_TABLE.length - 1)] : 0;
      var payout = won ? Math.round(p.stake * (2 + bonus)) : 0;

      if (won) state.bankroll += payout;
      p.settled = true;
      p.won = won;
      p.payout = won ? payout : 0;
      p.profit = won ? payout - p.stake : -p.stake;
      p.settledAt = Date.now();
      events.push({ match: m, pred: p, bonus: bonus });
    }

    if (events.length) saveState();
    return events;
  }

  /* ============================== 渲染：赛事 ============================== */
  function gameMeta(id) {
    return GAMES[id] || {
      label: String(id || "其他").toUpperCase(),
      chip: String(id || "?").slice(0, 4).toUpperCase(),
      c1: "#cfd8e3",
      c2: "#8b97ab",
      dark: true
    };
  }

  function gameList() {
    var seen = {};
    var list = [];
    MATCHES.forEach(function (m) {
      if (!seen[m.game]) {
        seen[m.game] = 1;
        list.push(m.game);
      }
    });
    list.sort(function (a, b) {
      var ia = GAME_ORDER.indexOf(a);
      var ib = GAME_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return list;
  }

  function isMajor(m) {
    var tier = String(m.tier || "").toLowerCase();
    if (tier === "s" || tier === "a") return true;
    var name = String(m.tournament || "");
    return /major|worlds|world championship|全球总决赛|总决赛|champions|iem|blast|esl pro league|msi|lpl|lck|lec|lcs|vct|kpl|pel|six invitational|algs|the international/i.test(name);
  }

  function inHomeWindow(m) {
    var t = new Date(m.startAt).getTime();
    var now = Date.now();
    return t >= now - HOME_PAST_DAYS * 86400000 && t <= now + HOME_FUTURE_DAYS * 86400000;
  }

  function matchesFiltered() {
    var dayAgo = Date.now() - 86400000;
    return MATCHES.filter(function (m) {
      if (!inHomeWindow(m)) return false;
      if (currentGame !== "all" && m.game !== currentGame) return false;
      if (currentTournament !== "__all__") {
        if (currentTournament === "__major__") {
          if (!isMajor(m)) return false;
        } else if (m.tournament !== currentTournament) {
          return false;
        }
      }
      var st = statusOf(m);
      if (st === "finished" && (!predictionFor(m.id) || new Date(m.startAt).getTime() < dayAgo)) {
        return false;
      }
      if (currentStatus !== "all" && st !== currentStatus) return false;
      return true;
    });
  }

  function statusCounts() {
    var dayAgo = Date.now() - 86400000;
    var counts = { all: 0, live: 0, open: 0, locked: 0, awaiting: 0, finished: 0 };
    MATCHES.forEach(function (m) {
      if (!inHomeWindow(m)) return;
      if (currentGame !== "all" && m.game !== currentGame) return;
      if (currentTournament !== "__all__") {
        if (currentTournament === "__major__") {
          if (!isMajor(m)) return;
        } else if (m.tournament !== currentTournament) {
          return;
        }
      }
      var st = statusOf(m);
      if (st === "finished" && (!predictionFor(m.id) || new Date(m.startAt).getTime() < dayAgo)) return;
      counts[st]++;
      counts.all++;
    });
    return counts;
  }

  function renderStatusTray() {
    var c = statusCounts();
    var defs = [
      ["all", "全部", "", c.all],
      ["live", "进行中", "live", c.live],
      ["open", "可竞猜", "open", c.open],
      ["locked", "已截止", "locked", c.locked],
      ["awaiting", "待赛果", "awaiting", c.awaiting],
      ["finished", "刚结束", "finished", c.finished]
    ];
    $("#statusTray").innerHTML = defs.map(function (d) {
      var active = currentStatus === d[0];
      return '<button type="button" class="status-tile' + (active ? " is-active" : "") +
        '" data-status="' + d[0] + '" role="tab" aria-selected="' + active + '">' +
        '<span class="status-tile-label">' + (d[2] ? '<i class="dot ' + d[2] + '"></i>' : "") + d[1] + "</span>" +
        "<b>" + d[3] + "</b></button>";
    }).join("");
  }

  function renderGameSelect() {
    var games = gameList();
    if (currentGame !== "all" && games.indexOf(currentGame) === -1) currentGame = "all";

    var windowMatches = MATCHES.filter(inHomeWindow);
    var allCount = windowMatches.length;
    var filteredCount = matchesFiltered().length;
    var meta = currentGame === "all"
      ? { label: "全部游戏", c2: "#ff8a3d" }
      : gameMeta(currentGame);

    $("#gameSelectCurrent").textContent = meta.label;
    $("#gameSelectDot").style.setProperty("--dot", meta.c2);
    $("#gameSelectCount").textContent = filteredCount + " 场";
    $("#gamePopoverMeta").textContent =
      "近 " + HOME_PAST_DAYS + " 天 · 未来 " + HOME_FUTURE_DAYS + " 天 · " + allCount + " 场";

    var html = gameTileHTML("all", "全部游戏", allCount, null);
    games.forEach(function (id) {
      var g = gameMeta(id);
      var count = windowMatches.filter(function (m) { return m.game === id; }).length;
      html += gameTileHTML(id, g.label, count, g);
    });
    $("#gameGrid").innerHTML = html;
  }

  function tournamentBase() {
    return MATCHES.filter(function (m) {
      return inHomeWindow(m) && (currentGame === "all" || m.game === currentGame);
    });
  }

  function buildTournamentStats(base) {
    var map = {};
    base.forEach(function (m) {
      var name = m.tournament || "未知赛事";
      if (!map[name]) map[name] = { name: name, count: 0, tier: "", major: false };
      map[name].count++;
      var tier = String(m.tier || "").toLowerCase();
      if (TIER_RANK[tier] !== undefined && (!map[name].tier || TIER_RANK[tier] < TIER_RANK[map[name].tier])) {
        map[name].tier = tier;
      }
      if (isMajor(m)) map[name].major = true;
    });
    return Object.keys(map)
      .map(function (k) { return map[k]; })
      .sort(function (a, b) {
        if (a.major !== b.major) return a.major ? -1 : 1;
        var ra = TIER_RANK[a.tier] === undefined ? 9 : TIER_RANK[a.tier];
        var rb = TIER_RANK[b.tier] === undefined ? 9 : TIER_RANK[b.tier];
        if (ra !== rb) return ra - rb;
        return b.count - a.count;
      });
  }

  function tournamentStats() {
    return buildTournamentStats(tournamentBase());
  }

  function renderTournamentSelect() {
    var base = tournamentBase();
    var list = tournamentStats();
    var majorCount = base.filter(isMajor).length;

    // 当前选择失效时回退到全部赛事
    if (currentTournament === "__major__" && majorCount === 0) currentTournament = "__all__";
    if (currentTournament !== "__all__" && currentTournament !== "__major__") {
      var exists = list.some(function (t) { return t.name === currentTournament; });
      if (!exists) currentTournament = "__all__";
    }

    $("#tournamentSelectCurrent").textContent =
      currentTournament === "__all__" ? "全部赛事"
        : currentTournament === "__major__" ? "大型赛事"
          : currentTournament;
    $("#tournamentPopoverMeta").textContent = base.length + " 场 · " + list.length + " 项赛事";

    var html = tournamentRowHTML("__all__", "全部赛事", base.length, "", true, currentTournament);
    if (majorCount > 0) {
      html += tournamentRowHTML("__major__", "大型赛事（S/A 级）", majorCount, "", true, currentTournament);
    }
    list.forEach(function (t) {
      html += tournamentRowHTML(t.name, t.name, t.count, t.tier, false, currentTournament);
    });
    $("#tournamentList").innerHTML = html;
  }

  function tournamentRowHTML(value, label, count, tier, special, selectedValue) {
    var selected = selectedValue === value;
    return '<button type="button" class="tournament-row' + (special ? " special" : "") +
      (selected ? " is-selected" : "") + '" data-tournament="' + esc(value) + '">' +
      (tier ? '<span class="tier-badge tier-' + esc(tier) + '">' + esc(tier.toUpperCase()) + "</span>" : "") +
      '<span class="tournament-name">' + esc(label) + "</span>" +
      '<span class="tournament-count">' + count + " 场</span></button>";
  }

  function renderSelectors() {
    // 先校验游戏，再校验赛事，最后渲染计数，避免切游戏时出现 0 场
    var games = gameList();
    if (currentGame !== "all" && games.indexOf(currentGame) === -1) currentGame = "all";
    renderTournamentSelect();
    renderGameSelect();
    renderStatusTray();
  }

  /* ============================== 赛程表 ============================== */
  function scheduleBase() {
    var now = Date.now();
    var from = now - SCHEDULE_WINDOW_DAYS * 86400000;
    var to = now + SCHEDULE_WINDOW_DAYS * 86400000;
    return MATCHES.filter(function (m) {
      var t = new Date(m.startAt).getTime();
      return t >= from && t <= to && (schedGame === "all" || m.game === schedGame);
    });
  }

  function scheduleMatches() {
    var q = schedQuery.trim().toLowerCase();
    return scheduleBase().filter(function (m) {
      if (schedTournament === "__all__") return matchQuery(m, q);
      if (schedTournament === "__major__") return isMajor(m) && matchQuery(m, q);
      return m.tournament === schedTournament && matchQuery(m, q);
    });
  }

  // 按游戏 / 赛事 / 阶段 / 队伍 / 日期 / 备注 检索
  function matchQuery(m, q) {
    if (!q) return true;
    var g = gameMeta(m.game);
    var d = new Date(m.startAt);
    var hay = [
      g.label, g.chip, m.game,
      m.tournament, m.stage, m.format,
      m.teamA.name, m.teamA.short, m.teamA.region,
      m.teamB.name, m.teamB.short, m.teamB.region,
      m.note || ""
    ].join(" ").toLowerCase();
    var dateStr = [
      (d.getMonth() + 1) + "月" + d.getDate() + "日",
      (d.getMonth() + 1) + "/" + d.getDate(),
      m.startAt.slice(0, 10),
      ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()]
    ].join(" ").toLowerCase();
    return hay.indexOf(q) !== -1 || dateStr.indexOf(q) !== -1;
  }

  function fmtClock(iso) {
    var d = new Date(iso);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function fmtMonthDay(iso) {
    var d = new Date(iso);
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function fmtDateLabel(iso) {
    var d = new Date(iso);
    var now = new Date();
    var prefix = "";
    if (d.toDateString() === now.toDateString()) {
      prefix = "今天 · ";
    } else {
      var tmr = new Date(now.getTime() + 86400000);
      var yes = new Date(now.getTime() - 86400000);
      if (d.toDateString() === tmr.toDateString()) prefix = "明天 · ";
      else if (d.toDateString() === yes.toDateString()) prefix = "昨天 · ";
    }
    var week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return prefix + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + week;
  }

  function schedGameTileHTML(id, label, count, g) {
    var selected = schedGame === id;
    var avatar = g
      ? '<span class="game-tile-avatar" style="background:linear-gradient(135deg,' + g.c1 + "," + g.c2 +
        ");color:" + (g.dark ? "#1a0e04" : "#0b1220") + '">' + esc(g.chip) + "</span>"
      : '<span class="game-tile-avatar" style="background:linear-gradient(135deg,#ffd08a,#ff8a3d)">ALL</span>';
    return '<button type="button" class="game-tile' + (selected ? " is-selected" : "") +
      '" data-sched-game="' + esc(id) + '">' + avatar +
      '<span class="game-tile-main"><span class="game-tile-name">' + esc(label) + "</span>" +
      '<span class="game-tile-count">' + count + " 场</span></span>" +
      '<span class="game-tile-check" aria-hidden="true"></span></button>';
  }

  function renderScheduleSelectors() {
    var games = gameList();
    if (schedGame !== "all" && games.indexOf(schedGame) === -1) schedGame = "all";

    var base = scheduleBase();
    var list = buildTournamentStats(base);
    var majorCount = base.filter(isMajor).length;

    if (schedTournament === "__major__" && majorCount === 0) schedTournament = "__all__";
    if (schedTournament !== "__all__" && schedTournament !== "__major__") {
      var exists = list.some(function (t) { return t.name === schedTournament; });
      if (!exists) schedTournament = "__all__";
    }

    var meta = schedGame === "all" ? { label: "全部游戏", c2: "#ff8a3d" } : gameMeta(schedGame);
    $("#schedGameCurrent").textContent = meta.label;
    $("#schedGameDot").style.setProperty("--dot", meta.c2);
    $("#schedGameMeta").textContent = base.length + " 场 · " + games.length + " 个项目";

    var now = Date.now();
    var from = now - SCHEDULE_WINDOW_DAYS * 86400000;
    var to = now + SCHEDULE_WINDOW_DAYS * 86400000;
    var html = schedGameTileHTML("all", "全部游戏", base.length, null);
    games.forEach(function (id) {
      var g = gameMeta(id);
      var count = MATCHES.filter(function (m) {
        var t = new Date(m.startAt).getTime();
        return m.game === id && t >= from && t <= to;
      }).length;
      html += schedGameTileHTML(id, g.label, count, g);
    });
    $("#schedGameGrid").innerHTML = html;

    $("#schedTournamentCurrent").textContent =
      schedTournament === "__all__" ? "全部赛事"
        : schedTournament === "__major__" ? "大型赛事"
          : schedTournament;
    $("#schedTournamentMeta").textContent = base.length + " 场 · " + list.length + " 项赛事";

    var thtml = tournamentRowHTML("__all__", "全部赛事", base.length, "", true, schedTournament);
    if (majorCount > 0) {
      thtml += tournamentRowHTML("__major__", "大型赛事（S/A 级）", majorCount, "", true, schedTournament);
    }
    list.forEach(function (t) {
      thtml += tournamentRowHTML(t.name, t.name, t.count, t.tier, false, schedTournament);
    });
    $("#schedTournamentList").innerHTML = thtml;
  }

  function scheduleRowHTML(m) {
    var st = statusOf(m);
    var winner = st === "finished" ? m.result.winner : null;

    function teamSpan(side) {
      var team = side === "A" ? m.teamA : m.teamB;
      var cls = winner ? (winner === side ? "winner" : "loser") : "";
      return '<span class="' + cls + '">' + esc(team.short) + "</span>";
    }

    var right = st === "finished"
      ? '<span class="schedule-score">' + esc(m.result.score) + "</span>"
      : st === "live"
        ? '<span class="status-chip live">正在比赛</span>'
        : st === "locked"
          ? '<span class="status-chip locked">已截止</span>'
          : st === "awaiting"
            ? '<span class="status-chip awaiting">待赛果</span>'
            : '<span class="status-chip open">未开始</span>';

    return '<div class="schedule-row">' +
      '<span class="schedule-time"><b>' + esc(fmtMonthDay(m.startAt)) + "</b>" + esc(fmtClock(m.startAt)) + "</span>" +
      '<span class="schedule-main">' +
        '<span class="schedule-teams">' + teamSpan("A") + '<span class="vs">vs</span>' + teamSpan("B") + "</span>" +
        '<span class="schedule-sub">' + esc(gameMeta(m.game).label) + " · " + esc(m.tournament) + " · " + esc(m.stage) + "</span>" +
      "</span>" +
      '<span class="schedule-right">' + right + "</span>" +
    "</div>";
  }

  function renderSchedule() {
    renderScheduleSelectors();
    var list = scheduleMatches().slice().sort(function (a, b) {
      return new Date(a.startAt) - new Date(b.startAt);
    });
    $("#schedCount").textContent = list.length + " 场";
    var q = schedQuery.trim();
    $("#scheduleSummary").textContent = q
      ? "搜索「" + q + "」· 匹配 " + list.length + " 场"
      : "过去 " + SCHEDULE_WINDOW_DAYS + " 天 · 未来 " + SCHEDULE_WINDOW_DAYS + " 天 · 共 " + list.length + " 场";

    if (!list.length) {
      $("#scheduleList").innerHTML = q
        ? '<div class="empty-state"><strong>没有匹配的赛程</strong>换个关键词，或清空搜索试试</div>'
        : '<div class="empty-state"><strong>这个筛选下没有赛程</strong>换个游戏或赛事试试</div>';
      return;
    }

    var html = "";
    var currentKey = "";
    list.forEach(function (m) {
      var key = new Date(m.startAt).toDateString();
      if (key !== currentKey) {
        if (currentKey) html += "</div>";
        html += '<div class="schedule-date">' + esc(fmtDateLabel(m.startAt)) + '</div><div class="schedule-table">';
        currentKey = key;
      }
      html += scheduleRowHTML(m);
    });
    if (currentKey) html += "</div>";
    $("#scheduleList").innerHTML = html;
  }

  function openSchedGame() {
    renderScheduleSelectors();
    closeSchedTournament();
    $("#schedGamePopover").hidden = false;
    $("#schedGameBtn").setAttribute("aria-expanded", "true");
  }

  function closeSchedGame() {
    $("#schedGamePopover").hidden = true;
    $("#schedGameBtn").setAttribute("aria-expanded", "false");
  }

  function openSchedTournament() {
    renderScheduleSelectors();
    closeSchedGame();
    $("#schedTournamentPopover").hidden = false;
    $("#schedTournamentBtn").setAttribute("aria-expanded", "true");
  }

  function closeSchedTournament() {
    $("#schedTournamentPopover").hidden = true;
    $("#schedTournamentBtn").setAttribute("aria-expanded", "false");
  }

  function gameTileHTML(id, label, count, g) {
    var selected = currentGame === id;
    var avatar = g
      ? '<span class="game-tile-avatar" style="background:linear-gradient(135deg,' + g.c1 + "," + g.c2 +
        ");color:" + (g.dark ? "#1a0e04" : "#0b1220") + '">' + esc(g.chip) + "</span>"
      : '<span class="game-tile-avatar" style="background:linear-gradient(135deg,#ffd08a,#ff8a3d)">ALL</span>';

    return '<button type="button" class="game-tile' + (selected ? " is-selected" : "") +
      '" data-game="' + esc(id) + '">' + avatar +
      '<span class="game-tile-main"><span class="game-tile-name">' + esc(label) + "</span>" +
      '<span class="game-tile-count">' + count + " 场</span></span>" +
      '<span class="game-tile-check" aria-hidden="true"></span></button>';
  }

  function openGameSheet() {
    renderGameSelect();
    closeTournamentSheet();
    $("#gamePopover").hidden = false;
    $("#gameSelectBtn").setAttribute("aria-expanded", "true");
  }

  function closeGameSheet() {
    $("#gamePopover").hidden = true;
    $("#gameSelectBtn").setAttribute("aria-expanded", "false");
  }

  function openTournamentSheet() {
    renderTournamentSelect();
    closeGameSheet();
    $("#tournamentPopover").hidden = false;
    $("#tournamentSelectBtn").setAttribute("aria-expanded", "true");
  }

  function closeTournamentSheet() {
    $("#tournamentPopover").hidden = true;
    $("#tournamentSelectBtn").setAttribute("aria-expanded", "false");
  }

  function renderBalance() {
    var display = state.bankroll < 0
      ? "-" + fmtNum(Math.abs(state.bankroll))
      : fmtNum(state.bankroll);
    $("#balanceValue").textContent = display;
    $("#profileBalance").textContent = display;
    $("#sandValue").textContent = display;
    $("#digCount").textContent = state.digs;
    $("#profileDigCount").textContent = state.digs;

    // 负债时余额标红提示
    var pill = $("#balancePill");
    if (pill) pill.classList.toggle("in-debt", state.bankroll < 0);
  }

  function renderMatches() {
    var listEl = $("#matchList");
    var filtered = matchesFiltered();

    var groups = { open: [], locked: [], live: [], awaiting: [], finished: [] };
    filtered.forEach(function (m) { groups[statusOf(m)].push(m); });

    function byTime(a, b) { return new Date(a.startAt) - new Date(b.startAt); }
    function majorThenTime(a, b) {
      var ma = isMajor(a) ? 1 : 0;
      var mb = isMajor(b) ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return new Date(a.startAt) - new Date(b.startAt);
    }

    groups.live.sort(byTime);
    groups.open.sort(majorThenTime);
    groups.locked.sort(majorThenTime);
    groups.awaiting.sort(byTime);
    groups.finished.sort(function (a, b) { return new Date(b.startAt) - new Date(a.startAt); });

    if (state.bankroll <= 0) {
      $("#openCount").textContent = "沙粒归零或负债 · 可使用定额竞猜";
    } else if (state.bankroll < MIN_STAKE) {
      $("#openCount").textContent = "沙粒不足 " + MIN_STAKE + "，可点上方「采沙」";
    } else {
      var n = filtered.length;
      var notice;
      if (currentStatus === "live") notice = n + " 场正在进行";
      else if (currentStatus === "open") notice = n + " 场可竞猜";
      else if (currentStatus === "locked") notice = n + " 场已截止";
      else if (currentStatus === "awaiting") notice = n + " 场待赛果";
      else if (currentStatus === "finished") notice = n + " 场刚刚结束";
      else notice = groups.open.length
        ? "当前有 " + groups.open.length + " 场赛事可竞猜"
        : "暂无待竞猜赛事，可先看看赛程表";
      $("#openCount").textContent = notice;
    }

    var html = "";
    function groupHTML(label, list) {
      if (!list.length) return "";
      return '<div class="group-label">' + label + "</div>" + list.map(matchCardHTML).join("");
    }

    html += groupHTML("正在进行", groups.live);
    html += groupHTML("可竞猜", groups.open);
    html += groupHTML("已截止 · 待赛果", groups.locked.concat(groups.awaiting));
    html += groupHTML("刚刚结束", groups.finished);

    if (!html) {
      html = '<div class="empty-state"><strong>这里还没有赛事</strong>切换其他游戏分类看看，或等待赛程更新</div>';
    }

    listEl.innerHTML = html;
  }

  function matchCardHTML(m) {
    var st = statusOf(m);
    var pred = predictionFor(m.id);
    var gm = gameMeta(m.game);

    var rows = "";
    ["A", "B"].forEach(function (side) {
      var team = side === "A" ? m.teamA : m.teamB;
      var isWinner = st === "finished" && m.result.winner === side;
      var isLoser = st === "finished" && m.result.winner !== side;
      var isPicked = pred && pred.pick === side;

      var cls = ["team-row"];
      if (st === "open") cls.push("is-pickable");
      if (isPicked) cls.push("is-picked");
      if (isLoser) cls.push("is-loser");
      if (isWinner) cls.push("is-winner");

      var sub = esc(team.region || "") +
        (isWinner ? ' <span class="win-tag">胜</span>' : "");

      var right = "";
      if (st === "finished") {
        var scoreParts = String(m.result.score || "").split(":");
        right = '<span class="team-score">' + esc((scoreParts[side === "A" ? 0 : 1] || "").trim() || "-") + "</span>";
      } else if (st === "open") {
        right = '<span class="chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>';
      }

      var inner =
        '<span class="avatar" style="' + avatarStyle(team.name) + '">' + esc(team.short) + "</span>" +
        '<span class="team-main"><span class="team-name">' + esc(team.name) + '</span><span class="team-sub">' + sub + "</span></span>" +
        right;

      if (st === "open") {
        rows += '<button type="button" class="' + cls.join(" ") + '" data-match="' + esc(m.id) + '" data-pick="' + side + '">' + inner + "</button>";
      } else {
        rows += '<div class="' + cls.join(" ") + '">' + inner + "</div>";
      }
    });

    var statusText = st === "open" ? "可竞猜"
      : st === "locked" ? "已截止"
        : st === "live" ? "正在比赛"
          : st === "awaiting" ? "待赛果"
            : "已结算";
    var bottom = '<span class="status-chip ' + st + '">' + statusText + "</span>";
    bottom += "<span>" + esc(m.stage) + " · " + esc(m.format) + "</span>";

    if (pred) {
      var pickName = pred.pick === "A" ? m.teamA.name : m.teamB.name;
      var pickCls = "my-pick";
      var pickText = "已预测 " + esc(pickName) + " · " + fmtNum(pred.stake) + "沙粒";
      if (pred.settled) {
        pickCls += pred.won ? " won" : " lost";
        pickText += " · " + (pred.won ? "+" : "") + fmtNum(pred.profit) + "沙粒";
      }
      bottom += '<span class="' + pickCls + '">' + pickText + "</span>";
    }

    if (m.note) bottom += '<span class="match-note">' + esc(m.note) + "</span>";

    return (
      '<article class="match-card is-' + st + '">' +
        '<div class="card-top">' +
          '<span class="game-chip" style="background:linear-gradient(135deg,' + gm.c1 + "," + gm.c2 + ");color:" + (gm.dark ? "#1a0e04" : "#0b1220") + '">' + esc(gm.chip) + "</span>" +
          '<span class="tournament">' + esc(m.tournament) + "</span>" +
          '<span class="match-time' + (st === "locked" ? " live" : "") + '">' + esc(fmtTime(m.startAt)) + "</span>" +
        "</div>" +
        '<div class="team-rows">' + rows + "</div>" +
        '<div class="card-bottom">' + bottom + "</div>" +
      "</article>"
    );
  }

  /* ============================== 战绩统计 ============================== */
  function recordStats() {
    var settled = settledInOrder();
    var stats = {
      wins: 0, losses: 0,
      winProfit: 0, loseAmount: 0,
      bestWin: null, worstLoss: null
    };
    settled.forEach(function (p) {
      if (p.won) {
        stats.wins++;
        stats.winProfit += p.profit;
        if (!stats.bestWin || p.profit > stats.bestWin.profit) stats.bestWin = p;
      } else {
        stats.losses++;
        stats.loseAmount += Math.abs(p.profit);
        if (!stats.worstLoss || p.profit < stats.worstLoss.profit) stats.worstLoss = p;
      }
    });
    return stats;
  }

  async function syncBoards() {
    var s = recordStats();
    try {
      await Cloud.submitStats({
        wins: s.wins,
        winProfit: s.winProfit,
        losses: s.losses,
        loseAmount: s.loseAmount
      });
    } catch (e) { /* 未登录或网络异常时静默失败 */ }
  }

  /* ============================== 渲染：我的 ============================== */
  function renderProfile() {
    var settled = settledInOrder();
    var wins = settled.filter(function (p) { return p.won; }).length;
    var hitRate = settled.length ? Math.round((wins / settled.length) * 100) + "%" : "--";
    var profit = settled.reduce(function (sum, p) { return sum + (p.profit || 0); }, 0);
    var staked = settled.reduce(function (sum, p) { return sum + p.stake; }, 0);
    var payout = settled.reduce(function (sum, p) { return sum + (p.payout || 0); }, 0);
    var stats = recordStats();

    $("#statSettled").textContent = settled.length;
    $("#statHit").textContent = hitRate;
    $("#statStreak").textContent = currentStreak();
    $("#statBest").textContent = bestStreak();

    $("#recWins").textContent = stats.wins;
    $("#recLosses").textContent = stats.losses;
    $("#recBestWin").textContent = stats.bestWin ? "+" + fmtNum(stats.bestWin.profit) : "--";
    $("#recWorstLoss").textContent = stats.worstLoss ? "-" + fmtNum(Math.abs(stats.worstLoss.profit)) : "--";

    $("#pnlBreakdown").textContent = "已结算投入 " + fmtNum(staked) + " · 累计返还 " + fmtNum(payout);

    var profitEl = $("#statProfit");
    profitEl.textContent = (profit > 0 ? "+" : "") + fmtNum(profit);
    profitEl.classList.toggle("negative", profit < 0);
    $("#pnlNote").textContent = profit < 0
      ? "已累计亏损 " + fmtNum(Math.abs(profit)) + " 沙粒 · 沙盘可以重来，现实不行"
      : "正数为累计盈利，负数为累计亏损 · 理性娱乐";

    var listEl = $("#historyList");
    $("#historyCount").textContent = settled.length + " 条";

    if (!settled.length) {
      listEl.innerHTML = '<div class="empty-state"><strong>还没有已结算的预测</strong>去「赛事」页挑一场比赛试试手气</div>';
      return;
    }

    var html = settled
      .slice()
      .sort(function (a, b) { return (b.settledAt || 0) - (a.settledAt || 0); })
      .map(function (p) {
        var m = matchById(p.matchId);
        if (!m) return "";
        var pickName = p.pick === "A" ? m.teamA.name : m.teamB.name;
        return (
          '<div class="history-item">' +
            '<span class="history-badge ' + (p.won ? "won" : "lost") + '">' + (p.won ? "W" : "L") + "</span>" +
            '<span class="history-main">' +
              '<span class="history-title">' + esc(m.teamA.short) + " vs " + esc(m.teamB.short) + " · " + esc(m.result.score) + "</span>" +
              '<span class="history-sub">' + esc(m.tournament) + " · 预测 " + esc(pickName) + " · 投入 " + fmtNum(p.stake) + "沙粒</span>" +
            "</span>" +
            '<span class="history-amount ' + (p.won ? "won" : "lost") + '">' +
              (p.profit > 0 ? "+" : "") + fmtNum(p.profit) + "沙粒" +
            "</span>" +
            '<button type="button" class="history-share" data-share="' + esc(p.matchId) + '" aria-label="分享这场竞猜">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/></svg>' +
            "</button>" +
          "</div>"
        );
      })
      .join("");

    listEl.innerHTML = html || '<div class="empty-state"><strong>还没有已结算的预测</strong>去「赛事」页挑一场比赛试试手气</div>';
  }

  function renderAll() {
    renderBalance();
    renderMatches();
    renderProfile();
  }

  /* ============================== 竞猜面板 ============================== */
  function isDebt(bankroll) {
    return bankroll <= 0;
  }

  // 负债/归零时的定额档位：10 / 100 / 1000 / 负债额
  function fixedStakes(bankroll) {
    var debt = Math.max(0, Math.ceil(Math.abs(Math.min(0, bankroll))));
    var list = STAKE_FIXED.slice();
    if (debt > 0 && list.indexOf(debt) === -1) list.push(debt);
    list.sort(function (a, b) { return a - b; });
    return { stakes: list, debt: debt };
  }

  // 正数时最大投入 = 余额 × 2（杠杆）
  function maxStake(bankroll) {
    return Math.max(0, Math.floor(bankroll * LEVERAGE));
  }

  function openSheet(matchId, pick) {
    var m = matchById(matchId);
    if (!m || statusOf(m) !== "open") return;

    sheetMatchId = matchId;
    var existing = predictionFor(matchId);
    sheetPick = pick || (existing ? existing.pick : "A");

    $("#sheetMatchMeta").textContent =
      m.tournament + " · " + m.stage + " · " + m.format + " · " + fmtTime(m.startAt);
    $("#pickNameA").textContent = m.teamA.name;
    $("#pickNameB").textContent = m.teamB.name;
    $("#pickAvatarA").textContent = m.teamA.short;
    $("#pickAvatarB").textContent = m.teamB.short;
    $("#pickAvatarA").setAttribute("style", avatarStyle(m.teamA.name));
    $("#pickAvatarB").setAttribute("style", avatarStyle(m.teamB.name));

    $("#sheetBalance").textContent = fmtNum(state.bankroll);
    if (state.bankroll < 0) $("#sheetBalance").textContent = "-" + fmtNum(Math.abs(state.bankroll));

    var input = $("#stakeInput");
    var fixedBox = $("#stakeFixed");
    var chips = $("#stakeChips");

    if (isDebt(state.bankroll)) {
      // 负债：定额投入
      fixedBox.hidden = false;
      chips.style.display = "none";
      $("#stakeRow").classList.add("is-readonly");
      input.readOnly = true;
      var fixed = fixedStakes(state.bankroll);
      $("#fixedChips").innerHTML = fixed.stakes.map(function (v) {
        var label = v === fixed.debt && fixed.debt > 0 ? "负债额" : fmtNum(v);
        return '<button type="button" data-amount="' + v + '">' + label + "</button>";
      }).join("");
      input.value = existing ? existing.stake : (fixed.stakes[0] || 10);
      updateFixedSelection();
    } else {
      // 正数：自由输入，上限为余额 2 倍
      fixedBox.hidden = true;
      chips.style.display = "";
      $("#stakeRow").classList.remove("is-readonly");
      input.readOnly = false;
      var available = state.bankroll + (existing ? existing.stake : 0);
      var cap = maxStake(available);
      var def = Math.min(100, cap);
      if (def < MIN_STAKE) def = Math.max(cap, 0);
      input.value = existing ? existing.stake : def;
    }

    $("#confirmPrediction").textContent = existing ? "确认修改" : "确认预测";
    updatePickUI();
    updatePreview();

    $("#sheetBackdrop").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function updateFixedSelection() {
    var val = parseInt($("#stakeInput").value, 10);
    document.querySelectorAll("#fixedChips button").forEach(function (b) {
      b.classList.toggle("is-active", parseInt(b.dataset.amount, 10) === val);
    });
  }

  function closeSheet() {
    $("#sheetBackdrop").hidden = true;
    document.body.style.overflow = "";
    sheetMatchId = null;
  }

  function updatePickUI() {
    document.querySelectorAll("#pickGrid .pick-card").forEach(function (card) {
      card.classList.toggle("is-selected", card.dataset.pick === sheetPick);
    });
  }

  function updatePreview() {
    var stake = parseInt($("#stakeInput").value, 10);
    if (!isFinite(stake) || stake <= 0) {
      $("#payoutPreview").innerHTML = "猜对预计返还 <b>--</b> 沙粒";
      return;
    }
    var bonus = bonusRateForNextWin();
    var payout = Math.round(stake * (2 + bonus));
    var bonusText = bonus > 0
      ? ' <span class="bonus">（含连对加成 +' + Math.round(bonus * 100) + "%）</span>"
      : "";
    $("#payoutPreview").innerHTML = "猜对预计返还 <b>" + fmtNum(payout) + "</b> 沙粒" + bonusText;
  }

  function placePrediction() {
    var m = matchById(sheetMatchId);
    if (!m) return;
    if (statusOf(m) !== "open") {
      toast("竞猜已在开赛前 1 小时截止");
      closeSheet();
      renderAll();
      return;
    }

    var stake = parseInt($("#stakeInput").value, 10);
    if (!isFinite(stake) || stake <= 0) {
      toast("请输入有效的投入沙粒");
      return;
    }

    var existing = predictionFor(m.id);
    var available = state.bankroll + (existing ? existing.stake : 0);

    if (isDebt(state.bankroll)) {
      // 负债/归零：只允许定额档位
      var fixed = fixedStakes(state.bankroll);
      if (fixed.stakes.indexOf(stake) === -1) {
        toast("负债状态下只能使用定额投入");
        return;
      }
    } else {
      // 正数：上限为可用沙粒的 2 倍
      var max = maxStake(available);
      if (stake > max) {
        toast("最多可投入 " + fmtNum(max) + " 沙粒（当前沙粒 2 倍）");
        return;
      }
      var minAllowed = Math.min(MIN_STAKE, max);
      if (stake < minAllowed) {
        toast("最低投入 " + fmtNum(minAllowed) + " 沙粒");
        return;
      }
    }

    // 修改预测：先退还旧投入，再扣除新投入；投入时立即扣款，允许变为负债
    if (existing) state.bankroll += existing.stake;
    state.bankroll -= stake;
    state.predictions = state.predictions.filter(function (p) { return p.matchId !== m.id; });

    state.predictions.push({
      matchId: m.id,
      pick: sheetPick,
      stake: stake,
      placedAt: Date.now(),
      settled: false
    });

    saveState();
    closeSheet();
    renderAll();
    toast((existing ? "预测已修改" : "预测成功") + " · 投入 " + fmtNum(stake) + " 沙粒");
  }

  /* ============================== 排行榜 ============================== */
  var currentBoard = "win";

  function boardHint(board) {
    return board === "win"
      ? "比谁猜对的次数多，猜对次数相同比赚的沙粒多"
      : "比谁猜错的次数多，猜错次数相同比亏的沙粒多";
  }

  async function renderBoard() {
    var hint = $("#boardHint");
    var listEl = $("#boardList");

    document.querySelectorAll("#boardTabs .board-tab").forEach(function (t) {
      var active = t.dataset.board === currentBoard;
      t.classList.toggle("is-active", active);
      t.classList.toggle(active ? (currentBoard === "win" ? "win-active" : "lose-active") : "x", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    hint.textContent = boardHint(currentBoard);

    var board = { entries: [] };
    var my = null;
    try {
      board = await Cloud.getBoard(currentBoard, 50);
      my = await Cloud.getMyEntry(currentBoard);
    } catch (e) {
      // 未登录或网络异常时展示空榜
    }
    var entries = board.entries;

    // 我的成绩卡
    if (my) {
      $("#boardMyRank").textContent = "#" + my.rank;
      $("#boardMyLabel").textContent = currentBoard === "win" ? "猜对次数排名" : "猜错次数排名";
      $("#boardMyScore").textContent = my.first + " 场";
      $("#boardMyBest").textContent = (currentBoard === "win" ? "赚 " : "亏 ") + fmtNum(my.second) + " 沙粒";
    } else {
      $("#boardMyRank").textContent = "--";
      $("#boardMyLabel").textContent = currentBoard === "win" ? "还没有上榜成绩" : "还没有上榜成绩";
      $("#boardMyScore").textContent = currentBoard === "win" ? "去猜对一场" : "猜错也会上榜";
      $("#boardMyBest").textContent = "--";
    }

    if (!entries.length) {
      listEl.innerHTML = '<div class="empty-state"><strong>榜单还是空的</strong>结算一场竞猜后这里就会出现名字</div>';
      return;
    }

    var isWin = currentBoard === "win";
    listEl.innerHTML = entries.map(function (e) {
      return (
        '<div class="board-row' + (e.isMe ? " is-me" : "") + '">' +
          '<span class="board-rank">' + (e.rank <= 3 ? ["🥇", "🥈", "🥉"][e.rank - 1] : e.rank) + "</span>" +
          '<span class="board-nick">' + esc(e.nick) + (e.isMe ? '<span class="me-tag">我</span>' : "") + "</span>" +
          '<span class="board-detail">' +
            '<span class="board-first ' + (isWin ? "won" : "lost") + '">' + e.first + " 场</span>" +
            '<span class="board-second">' + (isWin ? "赚 " : "亏 ") + fmtNum(e.second) + " 沙粒</span>" +
          "</span>" +
        "</div>"
      );
    }).join("");
  }

  /* ============================== 分享卡片 ============================== */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawShareCard(pred) {
    var m = matchById(pred.matchId);
    if (!m) return;
    var canvas = $("#shareCanvas");
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var won = pred.won;
    var accent = won ? "#35d39a" : "#ff5d6c";
    var stats = recordStats();
    var profit = settledInOrder().reduce(function (s, p) { return s + (p.profit || 0); }, 0);
    var pickTeam = pred.pick === "A" ? m.teamA : m.teamB;
    var winTeam = m.result.winner === "A" ? m.teamA : m.teamB;

    // 背景
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#141a26");
    bg.addColorStop(1, "#0a0d13");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // 顶部光晕
    var glow = ctx.createRadialGradient(W - 120, 80, 20, W - 120, 80, 420);
    glow.addColorStop(0, won ? "rgba(53,211,154,.22)" : "rgba(255,93,108,.2)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // 品牌行
    ctx.fillStyle = "#6c788d";
    ctx.font = "600 26px -apple-system, 'PingFang SC', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("赛事沙盘 · 竞猜战绩", 60, 96);
    ctx.textAlign = "right";
    ctx.fillText(fmtTime(m.startAt), W - 60, 96);

    // 大结果
    ctx.textAlign = "center";
    ctx.fillStyle = accent;
    ctx.font = "800 96px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(won ? "预测正确" : "预测失败", W / 2, 236);

    // 对阵卡
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,.03)";
    roundRect(ctx, 60, 300, W - 120, 190, 24);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.07)";
    ctx.lineWidth = 2;
    roundRect(ctx, 60, 300, W - 120, 190, 24);
    ctx.stroke();

    ctx.font = "700 30px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillStyle = "#e9eef7";
    ctx.fillText(m.teamA.name, 100, 372);
    ctx.fillText(m.teamB.name, 100, 442);
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 24px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(m.tournament + " · " + m.stage, 100, 404);
    ctx.textAlign = "right";
    ctx.font = "800 56px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillStyle = m.result.winner === "A" ? "#e9eef7" : "#6c788d";
    ctx.fillText(String(m.result.score).split(":")[0], W - 100, 386);
    ctx.fillStyle = m.result.winner === "B" ? "#e9eef7" : "#6c788d";
    ctx.fillText(String(m.result.score).split(":")[1], W - 100, 452);
    ctx.textAlign = "center";
    ctx.fillStyle = "#6c788d";
    ctx.font = "700 22px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("VS", W / 2, 416);

    // 我的预测
    ctx.textAlign = "left";
    ctx.fillStyle = "#9aa6ba";
    ctx.font = "500 26px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("我的预测", 60, 560);
    ctx.fillStyle = accent;
    ctx.font = "800 34px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(pickTeam.name + (won ? " ✓" : " ✗"), 60, 606);
    ctx.textAlign = "right";
    ctx.font = "500 26px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillStyle = "#9aa6ba";
    ctx.fillText("投入 " + fmtNum(pred.stake) + " 沙粒", W - 60, 560);
    ctx.font = "800 34px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillStyle = won ? "#35d39a" : "#ff5d6c";
    ctx.fillText((pred.profit > 0 ? "+" : "") + fmtNum(pred.profit) + " 沙粒", W - 60, 606);

    // 总盈亏（次要位置）
    ctx.fillStyle = "rgba(255,255,255,.03)";
    roundRect(ctx, 60, 660, W - 120, 130, 24);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 24px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("累计总盈亏", 100, 718);
    ctx.textAlign = "right";
    ctx.font = "800 40px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillStyle = profit >= 0 ? "#35d39a" : "#ff5d6c";
    ctx.fillText((profit > 0 ? "+" : "") + fmtNum(profit) + " 沙粒", W - 100, 728);

    // 战绩小字
    ctx.textAlign = "center";
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 24px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(
      "累计猜对 " + stats.wins + " 场 · 猜错 " + stats.losses + " 场",
      W / 2, 836
    );

    // 底部
    ctx.fillStyle = "#4a5568";
    ctx.font = "600 26px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("赛事沙盘 · 沙粒为虚拟道具，仅娱乐预测", W / 2, H - 90);
  }

  function openShare(pred) {
    drawShareCard(pred);
    $("#shareBackdrop").hidden = false;
  }

  function closeShare() {
    $("#shareBackdrop").hidden = true;
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }

  /* ============================== 异常兜底 ============================== */
  function validateLoadedState() {
    // 老版本 / 脏数据兼容：字段缺失或类型错误时修正
    if (typeof state.bankroll !== "number" || !isFinite(state.bankroll)) state.bankroll = START_BALANCE;
    if (!Array.isArray(state.predictions)) state.predictions = [];
    if (typeof state.digs !== "number" || !isFinite(state.digs) || state.digs < 0) state.digs = 0;
    if (state.bankroll > 1e12) state.bankroll = START_BALANCE; // 异常大值视为脏数据

    var seen = {};
    state.predictions = state.predictions.filter(function (p) {
      if (!p || typeof p.matchId !== "string") return false;
      if (seen[p.matchId]) return false; // 同一场只保留一条
      seen[p.matchId] = 1;
      if (typeof p.stake !== "number" || !(p.stake > 0)) return false;
      if (p.pick !== "A" && p.pick !== "B") return false;
      if (typeof p.placedAt !== "number") p.placedAt = Date.now();
      if (typeof p.settled !== "boolean") p.settled = !!p.settled;
      return !!matchById(p.matchId); // 赛事已不存在的记录剔除
    });
  }

  /* ============================== 新手引导与发帖素材 ============================== */
  var onboardStep = 1;

  function showOnboard() {
    onboardStep = 1;
    updateOnboard();
    $("#onboardBackdrop").hidden = false;
  }

  function updateOnboard() {
    document.querySelectorAll(".onboard-step").forEach(function (s) {
      s.classList.toggle("is-active", Number(s.dataset.step) === onboardStep);
    });
    document.querySelectorAll("#onboardDots span").forEach(function (d, i) {
      d.classList.toggle("is-active", i === onboardStep - 1);
    });
    $("#onboardSkip").textContent = onboardStep === 3 ? "不同意" : "跳过";
    $("#onboardNext").textContent = onboardStep === 3 ? "开始使用" : "下一步";
  }

  function closeOnboard(accepted) {
    if (!accepted) {
      onboardStep = 3;
      updateOnboard();
      toast("需要同意规则后才能使用沙盘");
      return;
    }
    try { storageSet(ONBOARD_KEY, "1"); } catch (e) { /* 忽略 */ }
    $("#onboardBackdrop").hidden = true;
  }

  function bindOnboard() {
    $("#onboardNext").addEventListener("click", function () {
      if (onboardStep < 3) {
        onboardStep++;
        updateOnboard();
      } else {
        closeOnboard(true);
      }
    });
    $("#onboardSkip").addEventListener("click", function () {
      if (onboardStep < 3) {
        onboardStep = 3;
        updateOnboard();
      } else {
        closeOnboard(false);
      }
    });
  }

  function maybeShowOnboard() {
    storageGet(ONBOARD_KEY).then(function (seen) {
      if (String(seen) !== "1") showOnboard();
    });
  }

  function buildPostText() {
    var s = recordStats();
    var profit = settledInOrder().reduce(function (sum, p) { return sum + (p.profit || 0); }, 0);
    function nameOf(p) {
      var m = matchById(p.matchId);
      return m ? m.teamA.short + " vs " + m.teamB.short : "";
    }
    return [
      "【赛事沙盘】我的竞猜战绩",
      "",
      "累计预测 " + s.wins + " 胜 " + s.losses + " 负，总盈亏 " + (profit >= 0 ? "+" : "") + fmtNum(profit) + " 沙粒",
      "最高连对 " + bestStreak() + " 场",
      "最大单场收益：" + (s.bestWin ? "+" + fmtNum(s.bestWin.profit) + "（" + nameOf(s.bestWin) + "）" : "暂无"),
      "最大单场亏损：" + (s.worstLoss ? fmtNum(s.worstLoss.profit) + "（" + nameOf(s.worstLoss) + "）" : "暂无"),
      "",
      "沙粒是虚拟道具，无现实价值，仅娱乐预测。",
      "数据来源：PandaScore / Liquipedia",
      "",
      "#赛事沙盘 #电竞赛事预测"
    ].join("\n");
  }

  /* ============================== 采沙 ============================== */
  function digSand() {
    var before = state.bankroll;
    // 只在不足 10000 时补足到 10000（负债也算不足），不额外增加
    if (before >= START_BALANCE) {
      toast("沙粒已不少于 " + fmtNum(START_BALANCE) + "，无需采沙");
      return;
    }
    var grant = START_BALANCE - before;
    state.bankroll = START_BALANCE;
    state.digs += 1;
    saveState();
    renderAll();
    toast("采沙成功 · 补足 " + fmtNum(grant) + " 沙粒（第 " + state.digs + " 次）");
  }

  /* ============================== 设置页 ============================== */
  function renderSettings() {
    var matches = MATCHES;
    var games = {};
    matches.forEach(function (m) { games[m.game] = 1; });

    $("#settingsDataInfo").textContent = matches.length + " 场 · " + Object.keys(games).length + " 个项目";

    var updated = DATA_UPDATED_AT ? new Date(DATA_UPDATED_AT) : null;
    $("#settingsUpdatedAt").textContent =
      updated && !isNaN(updated.getTime())
        ? (updated.getMonth() + 1) + "月" + updated.getDate() + "日 " +
          String(updated.getHours()).padStart(2, "0") + ":" + String(updated.getMinutes()).padStart(2, "0")
        : "--";

    $("#settingsVersion").textContent = "v" + APP_VERSION;
    $("#settingsCloudMode").textContent = Cloud.isMock() ? "本地模拟" : "小黑盒云端";

    var sourceNames = { pandascore: "PandaScore", liquipedia: "Liquipedia", manual: "官方/手工" };
    var sources = {};
    matches.forEach(function (m) { if (m.source) sources[m.source] = 1; });
    $("#settingsSource").textContent = Object.keys(sources).map(function (s) {
      return sourceNames[s] || s;
    }).join(" / ") || "—";

    Account.getProfile()
        .then(function (p) {
          $("#accountName").textContent = p.nick || "盒友";
          $("#accountId").textContent = "ID: " + (p.uid || "--");
          $("#accountAvatar").textContent = p.avatarText || "盒";
          $("#accountBadge").textContent = p.mode === "local" ? "本地模式" : "已登录";
          $("#accountHint").textContent = p.mode === "local"
            ? "本地体验账号 · 发布后将自动读取小黑盒账号，无需注册或登录"
            : "已通过小黑盒账号登录";
        })
        .catch(function () {
          $("#accountBadge").textContent = "未登录";
        });
  }

  /* ============================== 导航 ============================== */
  function switchView(name) {
    var isSubPage = name === "rules" || name === "schedule";
    ["matches", "profile", "board", "settings", "rules", "schedule"].forEach(function (v) {
      $("#view-" + v).hidden = v !== name;
    });
    var tabName = isSubPage ? "settings" : name;
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("is-active", t.dataset.view === tabName);
    });
    if (name === "profile") renderProfile();
    if (name === "board") { syncBoards(); renderBoard(); }
    if (name === "settings" || isSubPage) renderSettings();
    if (name === "schedule") renderSchedule();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ============================== 事件绑定 ============================== */
  function bindEvents() {
    $("#matchList").addEventListener("click", function (e) {
      var row = e.target.closest(".team-row[data-match]");
      if (!row) return;
      openSheet(row.dataset.match, row.dataset.pick);
    });

    $("#historyList").addEventListener("click", function (e) {
      var btn = e.target.closest(".history-share[data-share]");
      if (!btn) return;
      var pred = predictionFor(btn.dataset.share);
      if (pred && pred.settled) openShare(pred);
    });

    $("#shareCancel").addEventListener("click", closeShare);
    $("#shareBackdrop").addEventListener("click", function (e) {
      if (e.target === $("#shareBackdrop")) closeShare();
    });
    $("#shareSave").addEventListener("click", function () {
      try {
        var link = document.createElement("a");
        link.download = "赛事沙盘战绩.png";
        link.href = $("#shareCanvas").toDataURL("image/png");
        link.click();
        toast("图片已生成，可选择保存位置");
      } catch (err) {
        toast("当前环境不支持保存，可长按/右键图片保存");
      }
    });

    $("#shareCopyText").addEventListener("click", function () {
      var text = buildPostText();
      function done() { toast("文案已复制，去发帖页粘贴即可"); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else {
        fallbackCopy(text);
        done();
      }
    });

    $("#boardTabs").addEventListener("click", function (e) {
      var tab = e.target.closest(".board-tab");
      if (!tab) return;
      currentBoard = tab.dataset.board;
      renderBoard();
    });

    $("#scheduleSearch").addEventListener("input", function () {
      var input = this;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        schedQuery = input.value;
        $("#scheduleSearchClear").hidden = !schedQuery;
        renderSchedule();
      }, 250);
    });

    $("#scheduleSearchClear").addEventListener("click", function () {
      $("#scheduleSearch").value = "";
      schedQuery = "";
      $("#scheduleSearchClear").hidden = true;
      renderSchedule();
      $("#scheduleSearch").focus();
    });

    $("#statusTray").addEventListener("click", function (e) {
      var tile = e.target.closest(".status-tile");
      if (!tile) return;
      currentStatus = tile.dataset.status;
      renderStatusTray();
      renderMatches();
    });

    $("#gameSelectBtn").addEventListener("click", function () {
      if ($("#gamePopover").hidden) openGameSheet();
      else closeGameSheet();
    });

    $("#gameGrid").addEventListener("click", function (e) {
      var tile = e.target.closest(".game-tile");
      if (!tile) return;
      currentGame = tile.dataset.game;
      closeGameSheet();
      renderSelectors();
      renderMatches();
    });

    $("#tournamentSelectBtn").addEventListener("click", function () {
      if ($("#tournamentPopover").hidden) openTournamentSheet();
      else closeTournamentSheet();
    });

    $("#tournamentList").addEventListener("click", function (e) {
      var row = e.target.closest(".tournament-row");
      if (!row) return;
      currentTournament = row.dataset.tournament;
      closeTournamentSheet();
      renderSelectors();
      renderMatches();
    });

    // 点击浮层外部关闭
    document.addEventListener("click", function (e) {
      var anyOpen = !$("#gamePopover").hidden || !$("#tournamentPopover").hidden ||
        !$("#schedGamePopover").hidden || !$("#schedTournamentPopover").hidden;
      if (!anyOpen) return;
      if (e.target.closest(".selectors")) return;
      closeGameSheet();
      closeTournamentSheet();
      closeSchedGame();
      closeSchedTournament();
    });

    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () { switchView(btn.dataset.view); });
    });

    $("#goRulesFromMatches").addEventListener("click", function () { switchView("rules"); });

    $("#openRulesBtn").addEventListener("click", function () { switchView("rules"); });
    $("#rulesBackBtn").addEventListener("click", function () { switchView("settings"); });

    $("#openScheduleBtn").addEventListener("click", function () { switchView("schedule"); });
    $("#scheduleBackBtn").addEventListener("click", function () { switchView("settings"); });

    $("#schedGameBtn").addEventListener("click", function () {
      if ($("#schedGamePopover").hidden) openSchedGame();
      else closeSchedGame();
    });
    $("#schedGameGrid").addEventListener("click", function (e) {
      var tile = e.target.closest(".game-tile[data-sched-game]");
      if (!tile) return;
      schedGame = tile.dataset.schedGame;
      closeSchedGame();
      renderSchedule();
    });

    $("#schedTournamentBtn").addEventListener("click", function () {
      if ($("#schedTournamentPopover").hidden) openSchedTournament();
      else closeSchedTournament();
    });
    $("#schedTournamentList").addEventListener("click", function (e) {
      var row = e.target.closest(".tournament-row");
      if (!row) return;
      schedTournament = row.dataset.tournament;
      closeSchedTournament();
      renderSchedule();
    });

    $("#sheetClose").addEventListener("click", closeSheet);
    $("#sheetBackdrop").addEventListener("click", function (e) {
      if (e.target === $("#sheetBackdrop")) closeSheet();
    });

    document.querySelectorAll("#pickGrid .pick-card").forEach(function (card) {
      card.addEventListener("click", function () {
        sheetPick = card.dataset.pick;
        updatePickUI();
      });
    });

    $("#stakeInput").addEventListener("input", updatePreview);

    $("#stakeInput").addEventListener("change", function () {
      // 正数时超过 2 倍杠杆自动钳制
      if (isDebt(state.bankroll)) { updatePreview(); return; }
      var input = this;
      var existing = predictionFor(sheetMatchId);
      var available = state.bankroll + (existing ? existing.stake : 0);
      var max = maxStake(available);
      var val = parseInt(input.value, 10);
      if (isFinite(val) && val > max) {
        input.value = max;
        toast("已按上限 " + fmtNum(max) + " 沙粒投入（当前沙粒 2 倍）");
      }
      updatePreview();
    });

    $("#fixedChips").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-amount]");
      if (!btn) return;
      $("#stakeInput").value = btn.dataset.amount;
      updateFixedSelection();
      updatePreview();
    });

    $("#stakeChips").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-amount]");
      if (!btn) return;
      var amount = btn.dataset.amount;
      var existing = predictionFor(sheetMatchId);
      var available = state.bankroll + (existing ? existing.stake : 0);
      var max = Math.floor(maxStake(available));
      var value;
      if (amount === "all") value = Math.floor(available);
      else if (amount === "double") value = max;
      else value = parseInt(amount, 10);
      if (value > max) value = max;
      var minAllowed = Math.min(MIN_STAKE, max);
      if (value < minAllowed) value = minAllowed;
      $("#stakeInput").value = value;
      updatePreview();
    });

    $("#confirmPrediction").addEventListener("click", placePrediction);
    $("#digBtn").addEventListener("click", digSand);
    $("#digBtnProfile").addEventListener("click", digSand);

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!$("#gamePopover").hidden) closeGameSheet();
      else if (!$("#tournamentPopover").hidden) closeTournamentSheet();
      else if (!$("#schedGamePopover").hidden) closeSchedGame();
      else if (!$("#schedTournamentPopover").hidden) closeSchedTournament();
      else if (!$("#sheetBackdrop").hidden) closeSheet();
    });
  }

  /* ============================== 运行时数据 ============================== */
  function applySnapshot(matches, meta) {
    if (!matches || !matches.length) return;

    var map = {};
    MATCHES.forEach(function (m) {
      if (m && m.id) map[m.id] = m;
    });
    matches.forEach(function (m) {
      if (m && m.id) map[m.id] = m;
    });

    MATCHES = Object.keys(map).map(function (k) { return map[k]; });
    MATCHES.sort(function (a, b) {
      return new Date(a.startAt) - new Date(b.startAt);
    });
    if (meta && meta.updatedAt) DATA_UPDATED_AT = meta.updatedAt;

    var events = settlePending();
    renderSelectors();
    renderAll();
    renderSettings();
    if (!$("#view-schedule").hidden) renderSchedule();
    if (!$("#view-board").hidden) renderBoard();

    if (events.length) {
      syncBoards();
      var total = events.reduce(function (s, e) { return s + e.pred.profit; }, 0);
      var wins = events.filter(function (e) { return e.pred.won; }).length;
      toast("已结算 " + events.length + " 场 · 命中 " + wins + " 场 · " +
        (total >= 0 ? "+" : "") + fmtNum(total) + " 沙粒");
    }
  }

  var refreshing = false;

  async function refreshData() {
    if (refreshing || !isRuntimeEnabled()) return;
    refreshing = true;
    try {
      var cached = await loadCachedSnapshot();
      if (cached && cached.meta && cached.meta.updatedAt &&
          cached.meta.updatedAt !== DATA_UPDATED_AT) {
        applySnapshot(cached.matches, cached.meta);
      }

      var remote = await fetchRemoteSnapshot();
      if (remote && remote.meta && remote.meta.updatedAt &&
          remote.meta.updatedAt !== DATA_UPDATED_AT) {
        applySnapshot(remote.matches, remote.meta);
      }
    } catch (e) {
      /* 静默回退到内置/缓存数据 */
    } finally {
      refreshing = false;
    }
  }

  /* ============================== 启动 ============================== */
  async function boot() {
    await initPlatform();
    state = await loadState();
    validateLoadedState();
    saveState(); // 把修正后的状态写回，防止脏数据长期残留
    var events = settlePending();
    bindEvents();
    bindOnboard();

    // 数据文件加载失败：给出明确提示，避免白屏
    if (!MATCHES.length) {
      renderBalance();
      $("#openCount").textContent = "赛程数据加载失败，请稍后重试";
      $("#matchList").innerHTML =
        '<div class="empty-state"><strong>赛程数据加载失败</strong>请检查网络后刷新页面，或稍后再试</div>';
      renderSettings();
      maybeShowOnboard();
      refreshData();
      return;
    }

    renderSelectors();
    renderAll();
    renderSettings();
    maybeShowOnboard();
    refreshData();

    if (events.length) {
      syncBoards();
      var total = events.reduce(function (s, e) { return s + e.pred.profit; }, 0);
      var wins = events.filter(function (e) { return e.pred.won; }).length;
      setTimeout(function () {
        toast("已结算 " + events.length + " 场 · 命中 " + wins + " 场 · " +
          (total >= 0 ? "+" : "") + fmtNum(total) + " 沙粒");
      }, 500);
    }

    // 每分钟刷新一次状态（到点自动截止、赛果更新后自动结算）
    setInterval(function () {
      var settledNow = settlePending();
      renderSelectors();
      renderAll();
      if (!$("#view-schedule").hidden) renderSchedule();
      if (settledNow.length) {
        syncBoards();
        var total = settledNow.reduce(function (s, e) { return s + e.pred.profit; }, 0);
        toast("已结算 " + settledNow.length + " 场预测 · " + (total >= 0 ? "+" : "") + fmtNum(total) + " 沙粒");
      }
    }, 60000);
  }

  boot();
})();
