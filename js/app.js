import matchesData from "../data/matches-embedded.json";
import { Cloud, Sync } from "./cloud.js";
import { IDENTITY_EXCHANGE_URL, IDENTITY_EXCHANGE_FALLBACK } from "./config.js";
import { initPlatform, whenPlatformReady, setupViewport, setNavigationBarStyle, storageGet, storageSet, isHarmonyOS, closeMiniProgram, getRuntimeMode, getDiagnostics, onHostEvent, vibrate, setClipboard, reloadPage, uiShowLoading, uiHideLoading, showShareMenu, copyShareLink, getLaunchExtra, authLogin, networkGetJson } from "./platform.js";
import { isRuntimeEnabled, loadCachedSnapshot, fetchRemoteSnapshot } from "./data-source.js";

(function () {
  "use strict";

  /* ============================== 配置 ============================== */
  var DATA = matchesData;
  var MATCHES = (DATA.matches || []).slice();
  // 队标：数据里只存相对路径（队名 → 路径），换自建 OSS 镜像时只改这一行
  var TEAM_LOGOS = DATA.teams || {};
  var LOGO_BASE = "https://cdn-api.pandascore.co/images/team/image/";
  var matchIndex = new Map();
  rebuildMatchIndex();
  var DATA_UPDATED_AT = DATA.updatedAt || "";
  var STORAGE_KEY = "esports_sandbox_v2";
  var ONBOARD_KEY = "esports_sandbox_onboarded";
  var THEME_KEY = "esports_sandbox_theme";
  /* 清除本地数据会重置的键（storage 空串=读取端回退默认：引导重现/昵称清空/缓存重建） */
  var CLEAR_KEYS = [
    STORAGE_KEY, ONBOARD_KEY, THEME_KEY,
    "esports_sandbox_nick",
    "esports_sandbox_hbprofile",
    "esports_sandbox_remote_v1",
    "esports_sandbox_net_block",
    "esports_sandbox_mock_cloud_v2",
    "esports_sandbox_duels_v1",
    "esports_sandbox_duel_invite",
    "esports_sandbox_duel_locks",
    "esports_sandbox_duel_sent"
  ];
  var APP_VERSION = "1.2.3";
  // 轻量诊断通道：全局错误写 html dataset（调试台主 world 可读），长期保留、无 UI 影响
  window.addEventListener("error", function (e) {
    try { document.documentElement.dataset.jsErr = ((e.message || "") + " @" + String(e.filename || "").slice(-14) + ":" + e.lineno).slice(0, 220); } catch (x) { /* 忽略 */ }
  });
  window.addEventListener("unhandledrejection", function (e) {
    try { document.documentElement.dataset.promiseErr = String((e.reason && (e.reason.stack || e.reason.message)) || e.reason).slice(0, 220); } catch (x) { /* 忽略 */ }
  });
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
  var state = { bankroll: START_BALANCE, predictions: [], digs: 0, gods: 0, bankrupts: 0, godOffered: false, bankruptOffered: false, lastCeremonyAt: 0 };
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
  var sheetMode = "place"; // place | add | withdraw
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

  /* ============================== 主题 ============================== */
  var themePref = "system";
  var themeMedia = null;

  function systemPrefersLight() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches); } catch (e) { return false; }
  }

  function resolvedTheme(pref) {
    if (pref === "light" || pref === "dark") return pref;
    return systemPrefersLight() ? "light" : "dark";
  }

  function applyTheme(pref) {
    themePref = pref;
    var theme = resolvedTheme(pref);
    document.documentElement.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f2f5fa" : "#0b0e14");
    var value = $("#themeValue");
    if (value) value.textContent = pref === "system" ? "跟随系统" : pref === "light" ? "浅色" : "深色";
    document.querySelectorAll("#themeOptions button").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.themeOpt === pref);
    });
    setNavigationBarStyle(theme);
  }

  async function initTheme() {
    var stored = null;
    try { stored = await storageGet(THEME_KEY); } catch (e) { /* ignore */ }
    if (stored === null || stored === undefined) {
      try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
    }
    if (stored !== "light" && stored !== "dark" && stored !== "system") stored = "system";
    applyTheme(stored);

    try {
      themeMedia = window.matchMedia("(prefers-color-scheme: light)");
      var onChange = function () { if (themePref === "system") applyTheme("system"); };
      if (themeMedia.addEventListener) themeMedia.addEventListener("change", onChange);
      else if (themeMedia.addListener) themeMedia.addListener(onChange);
    } catch (e) { /* ignore */ }

    var options = $("#themeOptions");
    if (options) {
      options.addEventListener("click", function (e) {
        var btn = e.target.closest("button[data-theme-opt]");
        if (!btn) return;
        var pref = btn.dataset.themeOpt;
        applyTheme(pref);
        try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* ignore */ }
        storageSet(THEME_KEY, pref);
      });
    }
  }

  /* ============================== 页面生命周期 ============================== */
  var OVERLAY_SELECTORS = [
    "#sheetBackdrop", "#shareBackdrop", "#onboardBackdrop", "#confirmBackdrop", "#templeCeremony", "#cardFullscreen",
    "#gamePopover", "#tournamentPopover", "#schedGamePopover", "#schedTournamentPopover", "#duelDialogBackdrop", "#duelHelpBackdrop"
  ];

  function closeAllOverlays() {
    OVERLAY_SELECTORS.forEach(function (sel) {
      var el = $(sel);
      if (el) el.hidden = true;
    });
    document.body.style.overflow = "";
  }

  function initPageLifecycle() {
    window.addEventListener("pagehide", closeAllOverlays);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") closeAllOverlays();
    });
    window.addEventListener("pageshow", function (e) {
      if (!e.persisted) return;
      closeAllOverlays();
      // 从宿主返回时若页面是空的（白屏），强制重新加载（优先宿主 reload 原语）
      if (!document.body.innerText.trim()) {
        reloadPage();
        return;
      }
      renderAll();
    });
  }

  async function loadState() {
    var base = { bankroll: START_BALANCE, predictions: [], digs: 0, updatedAt: 0, gods: 0, bankrupts: 0, godOffered: false, bankruptOffered: false, lastCeremonyAt: 0 };
    try {
      var raw = await storageGet(STORAGE_KEY);
      if (!raw) return base;
      var parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== "object") return base;
      return {
        bankroll: typeof parsed.bankroll === "number" && isFinite(parsed.bankroll) ? parsed.bankroll : START_BALANCE,
        predictions: Array.isArray(parsed.predictions) ? parsed.predictions : [],
        digs: typeof parsed.digs === "number" ? parsed.digs : 0,
        gods: typeof parsed.gods === "number" && parsed.gods >= 0 ? parsed.gods : 0,
        bankrupts: typeof parsed.bankrupts === "number" && parsed.bankrupts >= 0 ? parsed.bankrupts : 0,
        godOffered: parsed.godOffered === true,
        bankruptOffered: parsed.bankruptOffered === true,
        lastCeremonyAt: typeof parsed.lastCeremonyAt === "number" && parsed.lastCeremonyAt >= 0 ? parsed.lastCeremonyAt : 0,
        updatedAt: typeof parsed.updatedAt === "number" && isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
      };
    } catch (e) {
      return base;
    }
  }

  /* 战绩内容快照：只在内容真正变化时写存储/推云端，避免启动时把本地时间戳刷成最新 */
  var persistedSnapshot = "";

  function stateSnapshot() {
    return JSON.stringify([state.bankroll, state.digs, state.predictions, state.gods, state.bankrupts, state.godOffered, state.bankruptOffered, state.lastCeremonyAt]);
  }

  function saveState() {
    var snap = stateSnapshot();
    if (snap === persistedSnapshot) return;
    persistedSnapshot = snap;
    state.updatedAt = Date.now();
    storageSet(STORAGE_KEY, state);
    scheduleCloudSync();
  }

  /* ============================== 战绩云同步 ============================== */
  /* LWW：本地变化防抖推送；启动时云端较新则拉回。详见 js/cloud.js 的 Sync。 */
  var cloudSyncTimer = 0;

  function scheduleCloudSync() {
    if (!Sync.canWrite()) return;
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(function () {
      cloudSyncTimer = 0;
      Sync.write(state, state.updatedAt || 0).then(function (res) {
        // 写入冲突且云端较新：让位并拉回（write 内部已按官方契约先读云端恢复凭证）
        if (res && res.conflict && res.cloud) applyCloudRecord(res.cloud);
      });
    }, 2500);
  }

  /** 应用一条云端记录：仅在比本地新时覆盖并重渲染。
   *  封神/破产计数单调递增，冲突合并取 max（防旧设备晚推送把次数刷回去）；
   *  庆祝页已弹标记取 OR；仪式时间取 max。其余字段按 LWW。 */
  function applyCloudRecord(rec) {
    if (!rec || !(rec.updatedAt > (state.updatedAt || 0))) return;
    var s = rec.state;
    var localGods = state.gods || 0, localBankrupts = state.bankrupts || 0;
    state = {
      bankroll: typeof s.bankroll === "number" && isFinite(s.bankroll) ? s.bankroll : START_BALANCE,
      predictions: Array.isArray(s.predictions) ? s.predictions : [],
      digs: typeof s.digs === "number" && isFinite(s.digs) ? s.digs : 0,
      gods: Math.max(localGods, typeof s.gods === "number" && s.gods > 0 ? s.gods : 0),
      bankrupts: Math.max(localBankrupts, typeof s.bankrupts === "number" && s.bankrupts > 0 ? s.bankrupts : 0),
      godOffered: state.godOffered === true || s.godOffered === true,
      bankruptOffered: state.bankruptOffered === true || s.bankruptOffered === true,
      lastCeremonyAt: Math.max(state.lastCeremonyAt || 0, typeof s.lastCeremonyAt === "number" ? s.lastCeremonyAt : 0),
      updatedAt: rec.updatedAt
    };
    validateLoadedState();
    persistedSnapshot = stateSnapshot();
    storageSet(STORAGE_KEY, state);
    var events = settlePending();
    renderBalance();
    renderAll();
    if (!$("#view-profile").hidden) renderProfile();
    if (!$("#view-board").hidden) renderBoard();
    toast("已从云端同步战绩");
    if (events.length) syncBoards();
  }

  function maybeRestoreFromCloud() {
    Sync.read().then(function (rec) {
      applyCloudRecord(rec);
    }).catch(function (e) { /* 读取失败保持本地 */ });
  }

  function rebuildMatchIndex() {
    matchIndex = new Map();
    MATCHES.forEach(function (m) {
      if (m && m.id) matchIndex.set(m.id, m);
    });
  }

  function matchById(id) {
    return matchIndex.get(id) || null;
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

  // 徽标最多 4 个字符：数据源给的缩写可能很长（如 PHTM.Ac、Nemiga）
  function avatarText(team) {
    var raw = String((team && (team.short || team.name)) || "").trim();
    if (!raw) return "?";
    var cleaned = raw.replace(/[^\p{L}\p{N}]+/gu, "");
    var first = raw.split(/[.\s_-]+/)[0].replace(/[^\p{L}\p{N}]+/gu, "");
    if (first.length >= 3 && first.length <= 4) return first.toUpperCase();
    if (cleaned.length <= 4) return cleaned.toUpperCase();
    return cleaned.slice(0, 4).toUpperCase();
  }

  function logoUrl(team) {
    if (!team) return "";
    var path = TEAM_LOGOS[team.name] || team.logo || "";
    if (!path) return "";
    return /^https?:\/\//i.test(path) ? path : LOGO_BASE + path;
  }

  // 有队标就画图（失败自动降级成文字徽标，见全局 error 监听），没有就沿用首字母色块
  function avatarHTML(team) {
    var url = logoUrl(team);
    if (!url) {
      return '<span class="avatar" style="' + avatarStyle(team.name) + '">' + esc(avatarText(team)) + "</span>";
    }
    return '<span class="avatar has-logo">' +
      '<img class="avatar-img" src="' + esc(url) + '" alt="" loading="lazy" decoding="async">' +
      '<span class="avatar-fallback">' + esc(avatarText(team)) + "</span></span>";
  }

  // 队标加载失败（403/断网/队名对不上）→ 去掉图片，露出文字徽标
  document.addEventListener("error", function (e) {
    var el = e.target;
    if (el && el.tagName === "IMG" && el.classList.contains("avatar-img") && el.parentNode) {
      el.parentNode.classList.add("no-logo");
    }
  }, true);

  function paintAvatar(el, team) {
    if (!el) return;
    var url = logoUrl(team);
    el.classList.remove("no-logo");
    if (!url) {
      el.classList.remove("has-logo");
      el.setAttribute("style", avatarStyle(team.name));
      el.textContent = avatarText(team);
      return;
    }
    el.classList.add("has-logo");
    el.removeAttribute("style");
    el.innerHTML = '<img class="avatar-img" src="' + esc(url) + '" alt="" loading="lazy" decoding="async">' +
      '<span class="avatar-fallback">' + esc(avatarText(team)) + "</span>";
  }

  // 人物头像（榜单/对决/对比页）：有头像叠图（加载失败由全局 error 监听回退首字），无头像首字色块
  function personAvatar(nick, avatar) {
    var letter = String(nick || "盒").slice(0, 1) || "盒";
    if (!avatar) return '<span class="person-avatar">' + esc(letter) + "</span>";
    return '<span class="person-avatar has-photo">' +
      '<img class="avatar-img" src="' + esc(avatar) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' +
      '<span class="avatar-fallback">' + esc(letter) + "</span></span>";
  }

  // 已截止比赛显示绝对日期，并提示距离开赛还有多久
  function fmtLockedTime(m) {
    var d = new Date(m.startAt);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hh + ":" + mm;
  }

  function startHint(m) {
    var diff = new Date(m.startAt).getTime() - Date.now();
    if (diff <= 0) return "";
    var mins = Math.max(1, Math.round(diff / 60000));
    return mins + " 分钟后开赛";
  }

  function matchTimeHTML(m, st) {
    if (st === "locked") {
      var hint = startHint(m);
      return '<span class="match-time live"><em>' + esc(fmtLockedTime(m)) + "</em>" +
        (hint ? "<small>" + esc(hint) + "</small>" : "") + "</span>";
    }
    return '<span class="match-time">' + esc(fmtTime(m.startAt)) + "</span>";
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

  // 大型赛事（S/A 级）：tier 有值就以 tier 为准（PandaScore 的 VCT/BLAST/LCS 等品牌
  // 覆盖多等级赛事，名字白名单会把 B/C/D 一起算进来）；tier 为空（手工数据）才退回名字。
  function isMajor(m) {
    var tier = String(m.tier || "").toLowerCase();
    if (tier) return tier === "s" || tier === "a";
    var name = String(m.tournament || "");
    return /major|worlds|world championship|全球总决赛|总决赛|champions|iem|blast|esl pro league|msi|lpl|lck|lec|lcs|vct|kpl|pel|six invitational|algs|the international/i.test(name);
  }

  function inHomeWindow(m) {
    var t = new Date(m.startAt).getTime();
    var now = Date.now();
    return t >= now - HOME_PAST_DAYS * 86400000 && t <= now + HOME_FUTURE_DAYS * 86400000;
  }

  function matchesFiltered(statusMap) {
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
      if (statusMap) statusMap.set(m, st);
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

    // 一次遍历统计各游戏场次，避免 23 次全量 filter + 重复日期解析
    var gameCounts = {};
    base.forEach(function (m) {
      gameCounts[m.game] = (gameCounts[m.game] || 0) + 1;
    });
    var html = schedGameTileHTML("all", "全部游戏", base.length, null);
    games.forEach(function (id) {
      var g = gameMeta(id);
      html += schedGameTileHTML(id, g.label, gameCounts[id] || 0, g);
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

    return '<div class="schedule-row" data-match="' + esc(m.id) + '">' +
      '<span class="schedule-time"><b>' + esc(fmtMonthDay(m.startAt)) + "</b>" + esc(fmtClock(m.startAt)) + "</span>" +
      '<span class="schedule-main">' +
        '<span class="schedule-teams">' + teamSpan("A") + '<span class="vs">vs</span>' + teamSpan("B") + "</span>" +
        '<span class="schedule-sub">' + esc(gameMeta(m.game).label) + " · " + esc(m.tournament) + " · " + esc(m.stage) + "</span>" +
      "</span>" +
      '<span class="schedule-right">' + right + "</span>" +
    "</div>";
  }

  var schedRender = null;

  function schedFlushGroup(st) {
    if (!st.rows.length) return;
    $("#scheduleList").insertAdjacentHTML(
      "beforeend",
      '<div class="schedule-date">' + esc(st.currentLabel) +
        '</div><div class="schedule-table">' + st.rows.join("") + "</div>"
    );
    st.rows = [];
  }

  function schedSchedule(st) {
    if (!st || st !== schedRender || st.done || st.scheduled) return;
    st.scheduled = true;
    var fired = false;
    function run() {
      if (fired) return;
      fired = true;
      schedAppendBatch(st);
    }
    // rAF 在后台/宿主切页时可能被暂停，定时器兜底保证循环能继续
    st.frame = requestAnimationFrame(run);
    st.timer = setTimeout(run, 16);
  }

  function schedAppendBatch(st) {
    if (!st || st !== schedRender || st.done) return;
    if (st.frame) { cancelAnimationFrame(st.frame); st.frame = 0; }
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    st.scheduled = false;
    var end = Math.min(st.index + 120, st.list.length);
    for (; st.index < end; st.index += 1) {
      var m = st.list[st.index];
      var dayKey = new Date(m.startAt).toDateString();
      if (dayKey !== st.currentKey) {
        schedFlushGroup(st);
        st.currentKey = dayKey;
        st.currentLabel = fmtDateLabel(m.startAt);
      }
      st.rows.push(scheduleRowHTML(m));
    }
    if (st.index >= st.list.length) {
      schedFlushGroup(st);
      st.done = true;
      return;
    }
    schedSchedule(st);
  }

  function renderSchedule() {
    var q = schedQuery.trim();
    var key = DATA_UPDATED_AT + "|" + schedGame + "|" + schedTournament + "|" + q;

    // 同一筛选：已完成直接复用；未完成同步补一批再继续，避免停在半截
    if (schedRender && schedRender.key === key) {
      if (!schedRender.done) schedAppendBatch(schedRender);
      return;
    }

    renderScheduleSelectors();
    var list = scheduleMatches().slice().sort(function (a, b) {
      return new Date(a.startAt) - new Date(b.startAt);
    });
    $("#schedCount").textContent = list.length + " 场";
    $("#scheduleSummary").textContent = q
      ? "搜索「" + q + "」· 匹配 " + list.length + " 场"
      : "过去 " + SCHEDULE_WINDOW_DAYS + " 天 · 未来 " + SCHEDULE_WINDOW_DAYS + " 天 · 共 " + list.length + " 场";

    if (!list.length) {
      schedRender = null;
      $("#scheduleList").innerHTML = q
        ? '<div class="empty-state"><strong>没有匹配的赛程</strong>换个关键词，或清空搜索试试</div>'
        : '<div class="empty-state"><strong>这个筛选下没有赛程</strong>换个游戏或赛事试试</div>';
      return;
    }

    schedRender = {
      key: key,
      list: list,
      index: 0,
      currentKey: "",
      currentLabel: "",
      rows: [],
      done: false,
      scheduled: false
    };
    $("#scheduleList").innerHTML = "";
    // 首批同步渲染，切换后立刻有内容；其余分帧追加
    schedAppendBatch(schedRender);
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

  var matchesDirty = false;

  function renderMatches() {
    var listEl = $("#matchList");
    var statusMap = new Map();
    var filtered = matchesFiltered(statusMap);

    var groups = { open: [], locked: [], live: [], awaiting: [], finished: [] };
    filtered.forEach(function (m) { groups[statusMap.get(m)].push(m); });

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
      return '<div class="group-label">' + label + "</div>" +
        list.map(function (m) { return matchCardHTML(m, statusMap.get(m)); }).join("");
    }

    html += groupHTML("正在进行", groups.live);
    html += groupHTML("可竞猜", groups.open);
    html += groupHTML("已截止", groups.locked);
    html += groupHTML("待赛果", groups.awaiting);
    html += groupHTML("刚刚结束", groups.finished);

    if (!html) {
      html = '<div class="empty-state"><strong>这里还没有赛事</strong>切换其他游戏分类看看，或等待赛程更新</div>';
    }

    listEl.innerHTML = html;
    matchesDirty = false;
  }

  function matchCardHTML(m, st) {
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
        avatarHTML(team) +
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
          matchTimeHTML(m, st) +
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

  async function syncBoards(overrideNick, honorQuote) {
    var s = recordStats();
    try {
      // 昵称链：调用方显式指定（如刚同步的黑盒昵称）→ 黑盒资料缓存 → 自选展示昵称
      var nick = overrideNick;
      var avatar = "";
      if (!nick) {
        var hb = await loadHbProfile().catch(function () { return null; });
        nick = (hb && hb.nick) || "";
        avatar = (hb && hb.avatar) || "";
      }
      if (!nick) nick = await loadNick();
      myNickCache = String(nick || "").slice(0, 12);
      if (avatar) myAvatarCache = avatar;
      await Cloud.submitStats({
        wins: s.wins,
        winProfit: s.winProfit,
        losses: s.losses,
        loseAmount: s.loseAmount
      }, nick, avatar);
      // 魔神殿：有封神/破产记录才提交（0/0 用户不上榜）；honorQuote = 转生仪式感言
      if (state.gods > 0 || state.bankrupts > 0) {
        await Cloud.submitHonor(state.gods, state.bankrupts, nick, honorQuote);
      }
    } catch (e) { /* 未登录或网络异常时静默失败 */ }
  }

  /* ============================== 转生体系：封神 / 破产 ============================== */
  /* 资格锚定「当前余额」而非累计数（累计永不下降，否则可无限刷次数）：
   * 余额 ≥ 10 亿（Cloud.CAP，与榜单封顶同源）可封神、≤ -10 亿可破产。
   * 仪式前置：无未结算竞猜（投入已扣，防止重置后巨注结算回流）。
   * 仪式效果：对应次数 +1、余额重置 10,000；累计战绩与历史永不重置。 */
  var ceremonyType = "";
  var bootDone = false; // 启动完成前不弹庆祝页（新手引导优先）

  function honorQualified() {
    if (state.bankroll >= Cloud.CAP) return "god";
    if (state.bankroll <= -Cloud.CAP) return "bankrupt";
    return "";
  }

  function canCeremony() {
    return !state.predictions.some(function (p) { return !p.settled; });
  }

  /** 达标后自动弹一次全屏庆祝页（每轮一次，拒绝后可在魔神殿再次举行） */
  function checkHonorPopup() {
    if (!bootDone) return;
    var type = honorQualified();
    if (!type) return;
    if (type === "god" && state.godOffered) return;
    if (type === "bankrupt" && state.bankruptOffered) return;
    if (!$("#onboardBackdrop").hidden) return; // 新手引导进行中不抢屏
    if (type === "god") state.godOffered = true; else state.bankruptOffered = true;
    saveState();
    showCeremony(type);
  }

  function showCeremony(type) {
    // 误弹保险丝：弹出瞬间再验一次资格（防模块混合/竞态把不达标状态弹出来）
    if (type === "god" && !(state.bankroll >= Cloud.CAP)) return;
    if (type === "bankrupt" && !(state.bankroll <= -Cloud.CAP)) return;
    ceremonyType = type;
    var god = type === "god";
    var panel = $("#cerPanel");
    panel.setAttribute("data-type", type);
    $("#cerBadge").textContent = god ? "👑" : "💀";
    $("#cerTitle").textContent = god ? "封 神" : "破 产";
    $("#cerDesc").innerHTML = god
      ? '你手握 <b>10 亿沙粒</b>，沙盘为你封神。<br>接受册封，名字将永载封神榜。'
      : '你负债 <b>10 亿沙粒</b>，光荣登上赌狗榜。<br>宣布破产，一笔勾销重新来过。';
    $("#cerFactHonor").textContent = god ? "封神次数 +1，载入封神榜" : "破产次数 +1，载入赌狗榜";
    $("#cerCta").textContent = god ? "立即封神" : "宣布破产";
    $("#cerCta").className = "cer-cta" + (god ? "" : " danger");
    updateCeremonyGate();
    $("#templeCeremony").hidden = false;
  }

  function updateCeremonyGate() {
    var ok = canCeremony();
    $("#cerCta").disabled = !ok;
    $("#cerGate").textContent = ok ? "" : "仍有未结算竞猜，先等赛果或撤回后再举行仪式";
  }

  function closeCeremony() {
    $("#templeCeremony").hidden = true;
    ceremonyType = "";
  }

  function performCeremony() {
    if (!ceremonyType) return;
    if (!canCeremony()) { toast("仍有未结算竞猜，先等赛果或撤回后再举行仪式"); return; }
    var god = ceremonyType === "god";
    var quote = ($("#cerQuote").value || "").trim().slice(0, 24); // 感言随（封神,破产）次数提交，次数变化必过 only-if-better
    $("#cerQuote").value = "";
    if (god) state.gods += 1; else state.bankrupts += 1;
    state.bankroll = START_BALANCE;
    state.lastCeremonyAt = Date.now();
    if (god) state.godOffered = false; else state.bankruptOffered = false;
    saveState();
    closeCeremony();
    renderAll();
    renderProfile();
    syncBoards(undefined, quote);
    vibrate("medium");
    toast((god ? "封神！" : "已宣布破产：") + "沙粒重置 10,000" + (quote ? "，感言已载入魔神殿" : ""));
  }

  /* ============================== 渲染：我的 ============================== */
  // 战绩摘要（对比页/晒战绩链接共用）：累计口径与榜单提交一致
  function recordSummary() {
    var settled = settledInOrder();
    var wins = 0, profit = 0;
    settled.forEach(function (p) {
      profit += p.profit || 0;
      if (p.won) wins++;
    });
    return {
      settled: settled.length,
      wins: wins,
      losses: settled.length - wins,
      profit: profit,
      hitRate: settled.length ? Math.round((wins / settled.length) * 100) + "%" : "--"
    };
  }

  function renderProfile() {
    var settled = settledInOrder();
    var wins = 0, profit = 0, staked = 0, payout = 0;
    var bestWin = null, worstLoss = null;
    var run = 0, best = 0;
    for (var i = 0; i < settled.length; i++) {
      var p = settled[i];
      profit += p.profit || 0;
      staked += p.stake;
      payout += p.payout || 0;
      if (p.won) {
        wins += 1;
        if (!bestWin || p.profit > bestWin.profit) bestWin = p;
        run += 1;
        if (run > best) best = run;
      } else {
        if (!worstLoss || p.profit < worstLoss.profit) worstLoss = p;
        run = 0;
      }
    }
    var streak = 0;
    for (var j = settled.length - 1; j >= 0; j--) {
      if (settled[j].won) streak += 1;
      else break;
    }
    var hitRate = settled.length ? Math.round((wins / settled.length) * 100) + "%" : "--";

    $("#statSettled").textContent = settled.length;
    $("#statHit").textContent = hitRate;
    $("#statStreak").textContent = streak;
    $("#statBest").textContent = best;

    $("#recWins").textContent = wins;
    $("#recLosses").textContent = settled.length - wins;
    $("#recBestWin").textContent = bestWin ? "+" + fmtNum(bestWin.profit) : "--";
    $("#recWorstLoss").textContent = worstLoss ? "-" + fmtNum(Math.abs(worstLoss.profit)) : "--";

    // 转生荣誉与本轮盈亏（上次封神/破产以来的已结算净变化，历史区保持累计）
    $("#profileGods").textContent = state.gods || 0;
    $("#profileBankrupts").textContent = state.bankrupts || 0;
    var ds = duelStats();
    $("#duelEntrySub").textContent = DUELS.length
      ? ds.won + " 胜 " + ds.lost + " 负" + (ds.drawn ? " " + ds.drawn + " 平" : "") +
        " · 对手 " + ds.opponents + " 人"
      : "还没有对决 · 竞猜面板可发起约战";
    var epoch = 0;
    var since = state.lastCeremonyAt || 0;
    for (var k = 0; k < settled.length; k++) {
      if ((settled[k].settledAt || 0) > since) epoch += settled[k].profit || 0;
    }
    $("#profileEpoch").textContent = (epoch > 0 ? "+" : "") + fmtNum(epoch);

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
    // 只重建当前可见的视图；切回赛事/我的时由 switchView 补渲染
    if (!$("#view-matches").hidden) renderMatches();
    else matchesDirty = true;
    if (!$("#view-profile").hidden) renderProfile();
    renderDuelBanner(); // 邀请横幅独立于筛选，数据/状态变化后跟着收敛
    updateScrollRail();
    checkHonorPopup(); // 余额变化后检测是否触发封神/破产庆祝页（标记防重复）
  }

  /* ============================== 滚动指示 ============================== */
  var scrollRailTimer = 0;
  var scrollRailRaf = 0;

  function scrollMetrics() {
    var scroller = document.scrollingElement || document.documentElement;
    return {
      top: scroller.scrollTop,
      max: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      view: scroller.clientHeight
    };
  }

  function updateScrollRail() {
    var rail = $("#scrollRail");
    var thumb = $("#scrollThumb");
    if (!rail || !thumb) return;
    var m = scrollMetrics();
    var railH = rail.clientHeight;
    if (m.max <= 4 || railH <= 0) {
      rail.classList.remove("is-visible");
      return;
    }
    var h = Math.max(30, Math.round(railH * (m.view / (m.max + m.view))));
    var y = Math.round((m.top / m.max) * Math.max(0, railH - h));
    thumb.style.height = h + "px";
    thumb.style.transform = "translateY(" + y + "px)";
  }

  function showScrollRail() {
    var rail = $("#scrollRail");
    if (!rail || scrollRailRaf) return;
    scrollRailRaf = requestAnimationFrame(function () {
      scrollRailRaf = 0;
      updateScrollRail();
      rail.classList.add("is-visible");
      clearTimeout(scrollRailTimer);
      scrollRailTimer = setTimeout(function () { rail.classList.remove("is-visible"); }, 900);
    });
  }

  function initScrollRail() {
    window.addEventListener("scroll", showScrollRail, { passive: true });
    window.addEventListener("resize", updateScrollRail, { passive: true });
    updateScrollRail();
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
    return { stakes: list, debt: debt, reason: "debt" };
  }

  // 正数时最大总投入 = 余额 × 2（杠杆）
  function maxStake(bankroll) {
    return Math.max(0, Math.floor(bankroll * LEVERAGE));
  }

  // 当前操作模式的投入限制；fixed 非空表示只能选定额档位
  function stakeLimits(mode, existing) {
    var bankroll = state.bankroll;
    if (mode === "withdraw") {
      return { min: 1, max: existing ? existing.stake : 0, fixed: null };
    }
    if (isDebt(bankroll)) {
      return { min: MIN_STAKE, max: Infinity, fixed: fixedStakes(bankroll) };
    }
    if (mode === "add") {
      var maxAdd = Math.max(0, maxStake(bankroll) - (existing ? existing.stake : 0));
      if (maxAdd >= MIN_STAKE) {
        return { min: MIN_STAKE, max: maxAdd, fixed: null };
      }
      // 自由加注额度用完：仍保留定额加注，保证任何余额下都能加注
      return { min: MIN_STAKE, max: Infinity, fixed: { stakes: STAKE_FIXED.slice(), debt: 0, reason: "cap" } };
    }
    return { min: MIN_STAKE, max: maxStake(bankroll), fixed: null };
  }

  function renderStakeMode() {
    document.querySelectorAll("#stakeMode button").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.mode === sheetMode);
    });
  }

  function renderStakeChips(mode) {
    var box = $("#stakeChips");
    if (mode === "withdraw") {
      box.innerHTML =
        [100, 500, 1000].map(function (v) {
          return '<button type="button" data-amount="' + v + '">' + fmtNum(v) + "</button>";
        }).join("") +
        '<button type="button" data-amount="withdrawAll">全部撤回</button>';
      return;
    }
    if (mode === "add") {
      box.innerHTML =
        [100, 500, 1000].map(function (v) {
          return '<button type="button" data-amount="' + v + '">' + fmtNum(v) + "</button>";
        }).join("") +
        '<button type="button" data-amount="max">加满</button>';
      return;
    }
    box.innerHTML =
      '<button type="button" data-amount="100">100</button>' +
      '<button type="button" data-amount="500">500</button>' +
      '<button type="button" data-amount="1000">1000</button>' +
      '<button type="button" data-amount="all">全部</button>' +
      '<button type="button" data-amount="double">2倍</button>';
  }

  function renderStakeUI(existing) {
    var limits = stakeLimits(sheetMode, existing);
    var input = $("#stakeInput");
    var fixedBox = $("#stakeFixed");
    var chips = $("#stakeChips");
    var confirm = $("#confirmPrediction");
    var labelText = sheetMode === "withdraw" ? "撤回沙粒" : sheetMode === "add" ? "加注沙粒" : "投入沙粒";

    $("#stakeLabel").textContent = labelText;
    input.setAttribute("aria-label", labelText);
    confirm.textContent = sheetMode === "withdraw" ? "确认撤回" : sheetMode === "add" ? "确认加注" : "确认预测";
    confirm.disabled = false;

    // 约战按钮：对决按真实投入进行，先有预测才能约战
    var duelBtn = $("#duelBtn");
    duelBtn.disabled = !existing;
    duelBtn.title = existing ? "把这场竞猜发给好友，同场比胜负（发出后该场投入锁定）" : "先下注才能约战";

    fixedBox.hidden = !limits.fixed;
    chips.style.display = limits.fixed ? "none" : "";
    $("#stakeRow").classList.toggle("is-readonly", !!limits.fixed);
    input.readOnly = !!limits.fixed;
    input.min = String(limits.min);

    if (limits.fixed) {
      $("#stakeFixedTip").textContent = sheetMode === "add"
        ? (limits.fixed.reason === "cap"
          ? "自由加注额度已用完（总投入已达当前沙粒的 2 倍），可用定额加注"
          : "负债/归零时只能使用定额加注")
        : "负债状态下只能使用定额投入";
      $("#fixedChips").innerHTML = limits.fixed.stakes.map(function (v) {
        var label = v === limits.fixed.debt && limits.fixed.debt > 0 ? "负债额" : fmtNum(v);
        return '<button type="button" data-amount="' + v + '">' + label + "</button>";
      }).join("");
      input.value = limits.fixed.stakes[0] || MIN_STAKE;
      updateFixedSelection();
      return;
    }

    renderStakeChips(sheetMode);
    var minAllowed = Math.min(limits.min, limits.max);
    var def = Math.min(100, limits.max);
    if (def < minAllowed) def = minAllowed;
    input.value = def;
  }

  function openSheet(matchId, pick) {
    var m = matchById(matchId);
    if (!m || statusOf(m) !== "open") return;
    if (isDuelLocked(matchId)) {
      openDuelRelock(matchId); // 锁定场次进不了面板，但给「再复制约战链接」的入口
      return;
    }

    sheetMatchId = matchId;
    var existing = predictionFor(matchId);
    sheetPick = pick || (existing ? existing.pick : "A");
    sheetMode = existing ? "add" : "place";

    $("#sheetMatchMeta").textContent =
      m.tournament + " · " + m.stage + " · " + m.format + " · " + fmtTime(m.startAt);
    $("#pickNameA").textContent = m.teamA.name;
    $("#pickNameB").textContent = m.teamB.name;
    paintAvatar($("#pickAvatarA"), m.teamA);
    paintAvatar($("#pickAvatarB"), m.teamB);

    $("#sheetBalance").textContent = fmtNum(state.bankroll);
    if (state.bankroll < 0) $("#sheetBalance").textContent = "-" + fmtNum(Math.abs(state.bankroll));

    $("#stakeExisting").hidden = !existing;
    if (existing) $("#existingStake").textContent = fmtNum(existing.stake);
    $("#stakeMode").hidden = !existing;
    renderStakeMode();
    renderStakeUI(existing);

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
    var existing = predictionFor(sheetMatchId);
    var limits = stakeLimits(sheetMode, existing);
    var amount = parseInt($("#stakeInput").value, 10);

    if (!isFinite(amount) || amount <= 0) {
      $("#payoutPreview").innerHTML = "请输入有效沙粒";
      return;
    }

    var bonus = bonusRateForNextWin();
    if (sheetMode === "withdraw") {
      if (!existing) {
        $("#payoutPreview").textContent = "当前没有可撤回的投入";
        return;
      }
      var withdraw = Math.min(amount, existing.stake);
      var remaining = existing.stake - withdraw;
      $("#payoutPreview").innerHTML = (remaining > 0
        ? "撤回后剩余投入 <b>" + fmtNum(remaining) + "</b> 沙粒"
        : "全部撤回") + " · 可退回 <b>" + fmtNum(withdraw) + "</b> 沙粒";
      return;
    }

    var total = sheetMode === "add" && existing ? existing.stake + amount : amount;
    var payout = Math.round(total * (2 + bonus));
    var bonusText = bonus > 0
      ? ' <span class="bonus">（含连对加成 +' + Math.round(bonus * 100) + "%）</span>"
      : "";
    var prefix = sheetMode === "add" && existing
      ? "加注后总投入 <b>" + fmtNum(total) + "</b> 沙粒 · "
      : "";
    $("#payoutPreview").innerHTML = prefix + "猜对预计返还 <b>" + fmtNum(payout) + "</b> 沙粒" + bonusText;
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

    var amount = parseInt($("#stakeInput").value, 10);
    var existing = predictionFor(m.id);
    var limits = stakeLimits(sheetMode, existing);

    if (sheetMode === "withdraw") {
      if (!existing) { toast("当前没有可撤回的投入"); return; }
      if (!isFinite(amount) || amount < 1) { toast("请输入有效的撤回沙粒"); return; }
      var refund = Math.min(amount, existing.stake);
      state.bankroll += refund;
      existing.stake -= refund;
      if (existing.stake <= 0) {
        state.predictions = state.predictions.filter(function (p) { return p.matchId !== m.id; });
        toast("已撤回全部投入 · 退回 " + fmtNum(refund) + " 沙粒");
      } else {
        existing.pick = sheetPick;
        existing.updatedAt = Date.now();
        toast("已撤回 " + fmtNum(refund) + " 沙粒 · 剩余投入 " + fmtNum(existing.stake) + " 沙粒");
      }
      saveState();
      closeSheet();
      renderAll();
      return;
    }

    if (sheetMode === "add") {
      if (!existing) { toast("当前没有可加注的预测"); return; }
      if (!isFinite(amount) || amount < MIN_STAKE) { toast("请输入有效的加注沙粒"); return; }
      if (limits.fixed) {
        if (limits.fixed.stakes.indexOf(amount) === -1) { toast("负债/归零时只能使用定额加注"); return; }
      } else if (amount > limits.max) {
        toast("最多可加注 " + fmtNum(limits.max) + " 沙粒（总投入不超过当前沙粒 2 倍）");
        return;
      }
      state.bankroll -= amount;
      existing.stake += amount;
      existing.pick = sheetPick;
      existing.updatedAt = Date.now();
      saveState();
      closeSheet();
      renderAll();
      toast("已加注 " + fmtNum(amount) + " 沙粒 · 总投入 " + fmtNum(existing.stake) + " 沙粒");
      attachDuelInvite(m.id); // 应战成立提示放在加注提示之后，让用户看到最重要的那条
      vibrate("light");
      return;
    }

    // 投入：本场还没有预测
    if (existing) { toast("本场已有预测，请使用加注或撤回"); return; }
    if (!isFinite(amount) || amount <= 0) { toast("请输入有效的投入沙粒"); return; }
    if (limits.fixed) {
      if (limits.fixed.stakes.indexOf(amount) === -1) { toast("负债状态下只能使用定额投入"); return; }
    } else {
      var minAllowed = Math.min(limits.min, limits.max);
      if (amount > limits.max) { toast("最多可投入 " + fmtNum(limits.max) + " 沙粒（当前沙粒 2 倍）"); return; }
      if (amount < minAllowed) { toast("最低投入 " + fmtNum(minAllowed) + " 沙粒"); return; }
    }
    state.bankroll -= amount;
    state.predictions.push({
      matchId: m.id,
      pick: sheetPick,
      stake: amount,
      placedAt: Date.now(),
      settled: false
    });
    saveState();
    closeSheet();
    renderAll();
    toast("预测成功 · 投入 " + fmtNum(amount) + " 沙粒");
    attachDuelInvite(m.id); // 应战成立提示放在预测成功之后
    vibrate("light");
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
    // realMy 取到隔离身份后回填 isMe（首次 getList 时身份可能尚未就绪，鸿蒙上依赖榜单通道）
    var uidNow = Cloud.getMyUid();
    if (uidNow) {
      entries.forEach(function (e) { e.isMe = e.uid === uidNow; });
    }
    // 0 分注册条目（registerIdentity 为保证身份可读而建）不上榜展示；
    // 按分排序 0 分必沉底，过滤后可见名次仍从 1 开始连续
    entries = entries.filter(function (e) { return e.first > 0; });
    // 转生者功成身退：魔神殿在册（封神/破产>0）的用户从胜败榜隐藏，
    // 新一轮分数超过历史峰值时 only-if-better 自然接受、重新上榜
    var honored = {};
    try {
      var templePage = await Cloud.getTemple(200);
      templePage.entries.forEach(function (e) {
        if (e.gods > 0 || e.bankrupts > 0) honored[e.uid] = 1;
      });
    } catch (te) { /* 拉取失败不过滤，下次再试 */ }
    entries = entries.filter(function (e) { return !honored[e.uid]; });

    // 我的成绩卡
    if (my && honored[my.uid]) {
      $("#boardMyRank").textContent = "--";
      $("#boardMyLabel").textContent = "已功成身退";
      $("#boardMyScore").textContent = "魔神殿见";
      $("#boardMyBest").textContent = "--";
    } else if (my && my.first > 0) {
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
      // 无自选昵称的条目用「盒友·ID后四位」区分（榜单条目按隔离身份唯一）
      var nick = e.nick && e.nick !== "盒友" ? e.nick : "盒友·" + String(e.uid || "").slice(-4);
      return (
        '<div class="board-row' + (e.isMe ? " is-me" : "") + '">' +
          '<span class="board-rank">' + (e.rank <= 3 ? ["🥇", "🥈", "🥉"][e.rank - 1] : e.rank) + "</span>" +
          personAvatar(nick, e.avatar) +
          '<span class="board-nick">' + esc(nick) + (e.isMe ? '<span class="me-tag">我</span>' : "") + "</span>" +
          '<span class="board-detail">' +
            '<span class="board-first ' + (isWin ? "won" : "lost") + '">' + e.first + " 场</span>" +
            '<span class="board-second">' + (isWin ? "赚 " : "亏 ") + fmtNum(e.second) + " 沙粒</span>" +
          "</span>" +
        "</div>"
      );
    }).join("");
  }

  /* ============================== 渲染：魔神殿 ============================== */
  var templeTab = "god";

  async function renderTemple() {
    var godTab = templeTab === "god";
    document.querySelectorAll("#templeTabs .temple-tab").forEach(function (t) {
      var on = t.dataset.temple === templeTab;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("#templeHint").textContent = godTab
      ? "手握 10 亿沙粒即可封神：沙粒重置 10,000，名字永载封神榜"
      : "负债 10 亿沙粒即达破产：负债清零重开，次数载入赌狗榜";

    // 我的荣誉 + 距离阈值进度（资格锚定当前余额）
    var my = null, entries = [];
    try {
      var results = await Promise.all([Cloud.getTemple(200), Cloud.getMyTemple()]);
      entries = results[0].entries || [];
      my = results[1];
    } catch (e) { /* 空榜 */ }
    $("#templeMyGods").textContent = state.gods || 0;
    $("#templeMyBankrupts").textContent = state.bankrupts || 0;
    var toGod = Cloud.CAP - state.bankroll;
    var toBankrupt = state.bankroll + Cloud.CAP;
    var pct, label;
    if (toGod <= toBankrupt) {
      pct = state.bankroll / Cloud.CAP;
      label = toGod <= 0 ? "已达标 · 可封神" : "距封神还差 <b>" + fmtNum(toGod) + "</b> 沙粒";
    } else {
      pct = -state.bankroll / Cloud.CAP;
      label = toBankrupt <= 0 ? "已达标 · 可宣布破产" : "距破产还差 <b>" + fmtNum(toBankrupt) + "</b> 沙粒";
    }
    $("#templeMyBar").style.width = (Math.max(0, Math.min(1, pct)) * 100).toFixed(2) + "%";
    $("#templeMyDist").innerHTML = label;

    // 仪式入口：达标才出现；未结算竞猜时点击会被拦下并提示
    var q = honorQualified();
    var btn = $("#templeCeremonyBtn");
    if (q) {
      btn.hidden = false;
      btn.textContent = q === "god" ? "立即封神" : "宣布破产";
      btn.className = "temple-cta" + (q === "bankrupt" ? " danger" : "");
    } else {
      btn.hidden = true;
    }

    // 榜单：封神榜按封神次数（服务端字典序天然如此）；赌狗榜按破产次数重排
    if (godTab) entries = entries.filter(function (e) { return e.gods > 0; });
    else {
      entries = entries.filter(function (e) { return e.bankrupts > 0; });
      entries.sort(function (a, b) { return b.bankrupts - a.bankrupts; });
    }

    var listEl = $("#templeList");
    if (!entries.length) {
      listEl.innerHTML = godTab
        ? '<div class="empty-state"><strong>封神榜还空着</strong>首位手握 10 亿沙粒的赌神将在这里留名</div>'
        : '<div class="empty-state"><strong>赌狗榜还空着</strong>首位负债 10 亿的勇士将在这里留名</div>';
      return;
    }
    listEl.innerHTML = entries.map(function (e, i) {
      var main = godTab
        ? '<b style="color:#ffd166">封神 ' + e.gods + " 次</b>"
        : '<b style="color:#9db4ff">破产 ' + e.bankrupts + " 次</b>";
      var sub = godTab
        ? (e.bankrupts > 0 ? "破产 " + e.bankrupts + " 次" : "从未破产")
        : (e.gods > 0 ? "封神 " + e.gods + " 次" : "从未封神");
      if (e.quote) sub += ' · <span class="temple-quote">「' + esc(e.quote) + "」</span>";
      return (
        '<div class="board-row' + (e.isMe ? " is-me" : "") + '">' +
          '<span class="board-rank">' + (i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1) + "</span>" +
          personAvatar(e.nick, e.avatar) +
          '<span class="board-nick">' + esc(e.nick) + (e.isMe ? '<span class="me-tag">我</span>' : "") + "</span>" +
          '<span class="board-detail">' + main + '<span class="board-second">' + sub + "</span></span>" +
        "</div>"
      );
    }).join("");
  }

  // 战绩对比页：对方数据来自分享链接（打开时刻快照），我方实时计算
  async function renderVersus() {
    if (!versusData) {
      $("#versusHead").innerHTML = "";
      $("#versusGrid").innerHTML = "";
      return;
    }
    $("#versusSub").textContent = versusData.n + " 发来战绩挑战 · 数据为各自打开时刻";
    var my = recordSummary();
    var nick = await duelNick();
    var map = await ensureDuelAvatars();
    $("#versusHead").innerHTML =
      '<div class="versus-side">' + personAvatar(nick, myAvatarCache) +
        "<b>" + esc(nick) + "</b><span>我</span></div>" +
      '<div class="versus-vs">VS</div>' +
      '<div class="versus-side">' + personAvatar(versusData.n, map[versusData.n]) +
        "<b>" + esc(versusData.n) + "</b><span>TA</span></div>";
    var rows = [
      { label: "已结算", mine: my.settled, theirs: versusData.w + versusData.l, better: "more" },
      { label: "猜对", mine: my.wins, theirs: versusData.w, better: "more" },
      { label: "总盈亏", mine: my.profit, theirs: versusData.p, better: "more" },
      { label: "封神", mine: state.gods || 0, theirs: versusData.g, better: "more" },
      { label: "破产", mine: state.bankrupts || 0, theirs: versusData.b, better: "less" }
    ];
    $("#versusGrid").innerHTML = rows.map(function (r) {
      var mineWin = false, theirsWin = false;
      if (r.better === "more") { mineWin = r.mine > r.theirs; theirsWin = r.theirs > r.mine; }
      else if (r.better === "less") { mineWin = r.mine < r.theirs; theirsWin = r.theirs < r.mine; }
      var fmt = function (v) {
        return r.label === "总盈亏" ? (v > 0 ? "+" : "") + fmtNum(v) + " 沙粒" : fmtNum(v);
      };
      return '<div class="versus-row">' +
        '<span class="versus-val mine' + (mineWin ? " win" : "") + '">' + fmt(r.mine) + "</span>" +
        '<span class="versus-label">' + r.label + "</span>" +
        '<span class="versus-val theirs' + (theirsWin ? " win" : "") + '">' + fmt(r.theirs) + "</span>" +
        "</div>";
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

  /** 画布文字自适应：超宽先缩字号（最低 22px），再省略号截断——修复长队名/赛事名与比分重叠 */
  function fitCanvasText(ctx, text, maxWidth, size, weight) {
    var s = size;
    var apply = function () { ctx.font = weight + " " + s + "px -apple-system, 'PingFang SC', sans-serif"; };
    apply();
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (s > 22) {
      s -= 2;
      apply();
      if (ctx.measureText(text).width <= maxWidth) return text;
    }
    while (text.length > 1 && ctx.measureText(text + "…").width > maxWidth) {
      text = text.slice(0, -1);
    }
    return text + "…";
  }

  function drawTeamAvatar(ctx, x, y, size, label) {
    ctx.fillStyle = "rgba(255,255,255,.06)";
    roundRect(ctx, x, y, size, size, 14);
    ctx.fill();
    ctx.fillStyle = "#9aa6ba";
    ctx.textAlign = "center";
    ctx.font = "800 " + Math.round(size * 0.36) + "px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(String(label || "?").slice(0, 3).toUpperCase(), x + size / 2, y + size / 2 + Math.round(size * 0.13));
  }

  // 人物头像（战报卡）：有图裁圆绘制，无图/未加载回退渐变首字
  function drawPersonAvatar(ctx, x, y, size, label, img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img && img.complete && img.naturalWidth > 0) {
      var s = Math.max(size / img.naturalWidth, size / img.naturalHeight);
      var w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
    } else {
      var g = ctx.createLinearGradient(x, y, x + size, y + size);
      g.addColorStop(0, "#ffd08a");
      g.addColorStop(1, "#ff8a3d");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = "#1a0e04";
      ctx.textAlign = "center";
      ctx.font = "800 " + Math.round(size * 0.4) + "px -apple-system, 'PingFang SC', sans-serif";
      ctx.fillText(String(label || "盒").slice(0, 1), x + size / 2, y + size / 2 + Math.round(size * 0.14));
    }
    ctx.restore();
  }

  // 战报卡头像预加载：画布要 toDataURL，跨域图必须 CORS，加载失败/超时回退首字
  function loadShareImage(url) {
    return new Promise(function (resolve) {
      if (!url) { resolve(null); return; }
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, 2500);
      img.onload = function () { if (!done) { done = true; clearTimeout(timer); resolve(img); } };
      img.onerror = function () { if (!done) { done = true; clearTimeout(timer); resolve(null); } };
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.src = url;
    });
  }

  function drawShareCard(pred, avatarImg) {
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

    // 背景
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#141a26");
    bg.addColorStop(1, "#0a0d13");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    var glow = ctx.createRadialGradient(W - 120, 80, 20, W - 120, 80, 420);
    glow.addColorStop(0, won ? "rgba(53,211,154,.22)" : "rgba(255,93,108,.2)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // 品牌行
    ctx.textAlign = "left";
    ctx.fillStyle = "#e9eef7";
    ctx.font = "800 32px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("赛事沙盘", 60, 92);
    ctx.textAlign = "right";
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 26px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(fmtTime(m.startAt), W - 60, 92);

    // 大结果 + 连对副行
    ctx.textAlign = "center";
    ctx.fillStyle = accent;
    ctx.font = "850 96px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(won ? "预测正确" : "预测失败", W / 2, 244);
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 27px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(won ? "当前连对 ×" + currentStreak() : "连对中断", W / 2, 296);

    // 对阵卡
    ctx.fillStyle = "rgba(255,255,255,.03)";
    roundRect(ctx, 50, 330, W - 100, 310, 28);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.07)";
    ctx.lineWidth = 2;
    roundRect(ctx, 50, 330, W - 100, 310, 28);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 26px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(fitCanvasText(ctx, m.tournament + " · " + m.stage, W - 180, 26, "500"), W / 2, 402);

    var scoreA = String(m.result.score).split(":")[0];
    var scoreB = String(m.result.score).split(":")[1];
    var rows = [
      { team: m.teamA, score: scoreA, win: m.result.winner === "A", y: 492 },
      { team: m.teamB, score: scoreB, win: m.result.winner === "B", y: 596 }
    ];
    rows.forEach(function (r, i) {
      if (i > 0) {
        ctx.strokeStyle = "rgba(255,255,255,.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(90, 544);
        ctx.lineTo(W - 90, 544);
        ctx.stroke();
      }
      drawTeamAvatar(ctx, 90, r.y - 42, 56, (r.team.short || r.team.name));
      ctx.textAlign = "left";
      ctx.fillStyle = r.win ? "#e9eef7" : "#9aa6ba";
      ctx.font = (r.win ? "800 " : "700 ") + "44px -apple-system, 'PingFang SC', sans-serif";
      ctx.fillText(fitCanvasText(ctx, r.team.name, W - 330, 44, r.win ? "800" : "700"), 168, r.y);
      ctx.textAlign = "right";
      ctx.font = "850 60px -apple-system, 'PingFang SC', sans-serif";
      ctx.fillStyle = r.win ? "#e9eef7" : "#6c788d";
      ctx.fillText(r.score, W - 90, r.y + 4);
    });

    // 我的预测行（左侧带我的头像，回退首字色块）
    drawPersonAvatar(ctx, 60, 652, 52, myNickCache || "我", avatarImg);
    ctx.textAlign = "left";
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 26px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("我的预测", 128, 690);
    ctx.fillStyle = accent;
    ctx.font = "800 36px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText(fitCanvasText(ctx, pickTeam.name + (won ? " ✓" : " ✗"), 380, 36, "800"), 128, 742);
    ctx.textAlign = "right";
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 26px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("投入 " + fmtNum(pred.stake) + " 沙粒", W - 60, 706);
    ctx.font = "850 36px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillStyle = won ? "#35d39a" : "#ff5d6c";
    ctx.fillText((pred.profit > 0 ? "+" : "") + fmtNum(pred.profit) + " 沙粒", W - 60, 760);

    // 总盈亏卡（底边 886 = 官方水印预留区上沿）
    ctx.fillStyle = "rgba(255,255,255,.03)";
    roundRect(ctx, 50, 790, W - 100, 96, 24);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 25px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("累计总盈亏", 90, 842);
    ctx.textAlign = "right";
    ctx.font = "850 42px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillStyle = profit >= 0 ? "#35d39a" : "#ff5d6c";
    ctx.fillText((profit > 0 ? "+" : "") + fmtNum(profit) + " 沙粒", W - 90, 848);

    // 战绩小字（底部 57 逻辑像素为官方水印预留区，勿放重要内容）
    ctx.textAlign = "center";
    ctx.fillStyle = "#6c788d";
    ctx.font = "500 24px -apple-system, 'PingFang SC', sans-serif";
    var metaLine = "累计猜对 " + stats.wins + " 场 · 猜错 " + stats.losses + " 场";
    if (state.gods > 0 || state.bankrupts > 0) {
      metaLine += " · 封神 " + (state.gods || 0) + " · 破产 " + (state.bankrupts || 0);
    }
    ctx.fillText(fitCanvasText(ctx, metaLine, W - 120, 24, "500"), W / 2, 878);
  }

  var sharePred = null;

  async function openShare(pred) {
    var img = await loadShareImage(myAvatarCache); // 失败/超时回退首字，不阻塞卡片打开太久
    drawShareCard(pred, img);
    sharePred = pred;
    $("#shareBackdrop").hidden = false;
  }

  function closeShare() {
    $("#shareBackdrop").hidden = true;
    sharePred = null;
  }

  /** 社区发帖预置话题：比赛所属项目名；未知项目退回通用话题。生产端会过滤无效项，写错也无害。 */
  function shareTopicFor(m) {
    var g = m && GAMES[m.game];
    return (g && g.label) || "电竞赛事";
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
    if (typeof state.gods !== "number" || !isFinite(state.gods) || state.gods < 0) state.gods = 0;
    if (typeof state.bankrupts !== "number" || !isFinite(state.bankrupts) || state.bankrupts < 0) state.bankrupts = 0;
    if (state.godOffered !== true) state.godOffered = false;
    if (state.bankruptOffered !== true) state.bankruptOffered = false;
    if (typeof state.lastCeremonyAt !== "number" || !isFinite(state.lastCeremonyAt) || state.lastCeremonyAt < 0) state.lastCeremonyAt = 0;

    var seen = {};
    state.predictions = state.predictions.filter(function (p) {
      if (!p || typeof p.matchId !== "string") return false;
      if (seen[p.matchId]) return false; // 同一场只保留一条
      seen[p.matchId] = 1;
      if (typeof p.stake !== "number" || !(p.stake > 0)) return false;
      if (p.pick !== "A" && p.pick !== "B") return false;
      if (typeof p.placedAt !== "number") p.placedAt = Date.now();
      if (typeof p.settled !== "boolean") p.settled = !!p.settled;
      // 不按「比赛是否在当前数据里」剔除：内置数据是窗口快照，
      // 运行时全量数据到之前老预测仍需保留（结算/渲染都会跳过找不到的比赛）
      return true;
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
    $("#onboardNext").textContent = onboardStep === 3 ? "同步黑盒资料" : "下一步";
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
        // 最后一步主按钮=同意规则并开始：同时发起黑盒资料同步（授权页由宿主弹出，
        // 同步不阻塞进入；失败/取消不影响使用，设置页可随时重试）
        closeOnboard(true);
        syncHbProfile();
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
    return storageGet(ONBOARD_KEY).then(function (seen) {
      if (String(seen) !== "1") {
        showOnboard();
        return true;
      }
      return false;
    });
  }

  /* ============================== 鸿蒙硬阻断（1.1.5 起停用） ============================== */
  /*
   * 1.1.3/1.1.4 曾用这套阻断让鸿蒙进入即退出。1.1.5 为了验证「握手晚到降级」（1.1.4 修复的
   * 第一层问题）是否就是鸿蒙表现为本地模式的全部原因，暂时改回进入门 + 重试的流程；
   * 若鸿蒙真机仍报 SERVER_API_REQUIRED（第二层：客户端 effective network 判 local），
   * 再把 showHarmonyBlock 的调用恢复回来即可。
   */
  var harmonyBlocked = false;
  var harmonyExiting = false;
  var harmonyCountdown = null;

  function setHarmonyHint(text) {
    var hint = $("#harmonyBlockHint");
    if (hint) hint.textContent = text;
  }

  async function exitHarmonyBlock() {
    if (harmonyExiting) return;
    harmonyExiting = true;
    if (harmonyCountdown) {
      clearInterval(harmonyCountdown);
      harmonyCountdown = null;
    }
    setHarmonyHint("正在退出小程序…");
    // 只做本地握手，拿到 navigation.close；握手本身不涉及服务端 API
    await initPlatform();
    var closed = await closeMiniProgram();
    if (!closed) {
      harmonyExiting = false;
      setHarmonyHint("自动退出失败，请点右上角「…」关闭小程序，或点下方按钮重试。");
    }
  }

  function startHarmonyCountdown() {
    if (harmonyExiting || harmonyCountdown) return;
    var left = 5;
    setHarmonyHint(left + " 秒后自动退出小程序。");
    harmonyCountdown = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        exitHarmonyBlock();
        return;
      }
      setHarmonyHint(left + " 秒后自动退出小程序。");
    }, 1000);
  }

  function showHarmonyBlock() {
    if (harmonyBlocked) return;
    harmonyBlocked = true;
    var backdrop = $("#harmonyBlockBackdrop");
    if (backdrop) backdrop.hidden = false;
    document.body.style.overflow = "hidden";
    var exitBtn = $("#harmonyBlockExit");
    if (exitBtn) exitBtn.addEventListener("click", exitHarmonyBlock);

    // 握手完成前页面可能还没被宿主显示，倒计时从握手结束才开始，保证提示能被看到
    setHarmonyHint("正在准备退出小程序…");
    initPlatform().then(function () {
      if (!harmonyBlocked || harmonyExiting) return;
      startHarmonyCountdown();
    });
  }

  /* 鸿蒙进入门：强制更新一次；失败则阻断整个小程序 */
  var gateRetrying = false;

  function showNetGate(mode) {
    var backdrop = $("#netGateBackdrop");
    if (!backdrop) return;
    $("#netGateTitle").textContent = mode === "error" ? "小程序无法使用" : "正在更新赛程";
    $("#netGateText").textContent = mode === "error"
      ? "赛程数据更新失败，请检查网络后重试。"
      : "进入前需要获取最新赛程与赛果，请稍候。";
    $("#netGateActions").hidden = mode !== "error";
    backdrop.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function hideNetGate() {
    var backdrop = $("#netGateBackdrop");
    if (backdrop) backdrop.hidden = true;
    document.body.style.overflow = "";
  }

  async function runHarmonyGate() {
    if (gateRetrying) return false;
    if (!isRuntimeEnabled() || getRuntimeMode() === "preview") {
      hideNetGate();
      maybeShowOnboard();
      return true;
    }
    gateRetrying = true;
    showNetGate("loading");
    // 宿主网络可能在握手完成后才就绪：失败后间隔重试，不要把第一次失败当成永久失败
    var ok = false;
    for (var attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt > 0) {
        await new Promise(function (resolve) { setTimeout(resolve, 2500); });
      }
      ok = await refreshData(true);
    }
    gateRetrying = false;
    if (ok) {
      hideNetGate();
      maybeShowOnboard();
    } else {
      showNetGate("error");
    }
    return ok;
  }

  function bindNetGate() {
    var retry = $("#netGateRetry");
    if (retry) retry.addEventListener("click", function () { runHarmonyGate(); });
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
      (state.gods > 0 || state.bankrupts > 0) ? "封神 " + (state.gods || 0) + " 次 · 破产 " + (state.bankrupts || 0) + " 次（魔神殿在册）" : "",
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
  var NICK_KEY = "esports_sandbox_nick"; // 用户自选展示昵称：本地保存 + 随榜单 extra 提交（跨设备经 getCurrentUserEntry 读回）
  var HB_PROFILE_KEY = "esports_sandbox_hbprofile"; // 黑盒授权资料缓存（换票结果）：{appUserId,nick,avatar,at}

  function loadNick() {
    return storageGet(NICK_KEY).then(function (v) {
      return String(v == null ? "" : v).trim();
    }).catch(function () { return ""; });
  }

  function loadHbProfile() {
    return storageGet(HB_PROFILE_KEY).then(function (v) {
      if (!v) return null;
      var p = typeof v === "string" ? JSON.parse(v) : v;
      return p && p.appUserId ? p : null;
    }).catch(function () { return null; });
  }

  function saveHbProfile(p) {
    return storageSet(HB_PROFILE_KEY, p);
  }

  /** 换票请求：直连 FC 优先（2026-10-26 官方口径：network 批准后第三方 HTTPS 免追加）；
   *  传输层失败（旧客户端域名拦截 / 网络异常）自动降级 OSS Mirror 回源兜底。 */
  var hbExchangeMode = ""; // 本次实际走通的链路："直连" | "回源"

  function exchangeProfile(code) {
    var path = "/" + encodeURIComponent(code);
    return networkGetJson(IDENTITY_EXCHANGE_URL + path, 10000).then(function (data) {
      hbExchangeMode = "直连";
      return data;
    }).catch(function (e) {
      console.warn("[exchange] 直连失败，降级回源：" + ((e && e.code) || "网络异常"));
      return networkGetJson(IDENTITY_EXCHANGE_FALLBACK + path, 10000).then(function (data) {
        hbExchangeMode = "回源";
        return data;
      });
    });
  }

  /** 已同步判定：本机换票缓存与当前榜单身份一致（身份暂未知时按已同步处理，宁可不换票也不重复计费） */
  function hbProfileMatchesIdentity(hb) {
    if (!hb) return false;
    // 1.1.26 前的旧缓存没有 via 字段（链路标记）：视为未同步，放行一次重新换票补标记
    // ——否则防重复门控会让这些用户永远无法记录实际链路（诊断行无法区分直连/回源）
    if (!hb.via) return false;
    var uid = Cloud.getMyUid();
    return !uid || hb.appUserId === uid;
  }

  /** 同步黑盒资料：授权（用户手势）→ 一次性 code → 换票端点 → 缓存昵称头像。
   *  已同步过的账号直接短路（每次换票=一次 FC 调用，防重复计费）；换账号后身份不匹配才允许重新同步。 */
  function syncHbProfile() {
    loadHbProfile().then(function (hb) {
      if (hbProfileMatchesIdentity(hb)) {
        toast("已同步过" + (hb.nick ? "：" + hb.nick : "") + "，无需重复同步");
        return;
      }
      authLogin().then(function (login) {
        if (!login || login.error || !login.code) {
          if (login && login.error === "AUTHORIZATION_CANCELLED") toast("已取消授权");
          else if (login && login.error === "USER_GESTURE_REQUIRED") toast("请直接点击按钮触发授权");
          else toast("授权未完成：" + ((login && login.error) || "UNKNOWN"));
          return;
        }
        // code 放路径（/api/exchange/<code>）：一次性码=唯一路径，回源兜底时也绝无缓存串号
        exchangeProfile(login.code).then(function (data) {
          if (data && data.appUserId) {
            saveHbProfile({
              appUserId: data.appUserId,
              nick: data.nickname || "",
              avatar: data.avatar || "",
              via: hbExchangeMode,
              at: Date.now()
            }).then(function () {
              toast(data.nickname ? "已同步黑盒资料：" + data.nickname : "已同步身份（该账号未设置昵称）");
              syncBoards(data.nickname || undefined); // 黑盒昵称优先随榜单 extra 提交
              renderSettings();
            });
          } else if (data && data.error === "invalid_grant") {
            toast("授权码已失效，请再点一次重新授权");
          } else if (data && (data.error === "HTTP_403" || data.error === "HTTP_404")) {
            toast("换票服务暂不可用（通道返回 " + data.error.replace("HTTP_", "") + "），稍后再试");
          } else {
            toast("换票失败：" + ((data && data.error) || "UNKNOWN"));
          }
        }).catch(function (e) {
          toast("换票失败：" + ((e && e.code) || "网络异常"));
        });
      });
    });
  }

  /** 确保榜单条目存在（0 分注册），隔离身份在静默读取被拒的客户端上也可读。 */
  function registerIdentity() {
    if (Cloud.isMock()) return;
    loadNick().then(function (nick) {
      return Cloud.registerIdentity(nick);
    }).then(function (ok) {
      if (ok && !$("#view-settings").hidden) renderSettings();
    }).catch(function () { /* 静默：未登录/宿主不支持时账号卡显示游客 */ });
  }

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
    $("#settingsCloudSync").textContent = Sync.statusText();

    var sourceNames = { pandascore: "PandaScore", liquipedia: "Liquipedia", manual: "官方/手工" };
    var sources = {};
    matches.forEach(function (m) { if (m.source) sources[m.source] = 1; });
    $("#settingsSource").textContent = Object.keys(sources).map(function (s) {
      return sourceNames[s] || s;
    }).join(" / ") || "—";

    Promise.all([
      loadNick(),
      loadHbProfile(),
      // 榜单通道返回隔离身份（app_user_id）与自选昵称，所有宿主行为一致（不使用 user.getInfo）
      Cloud.getMyEntry("win").catch(function () { return null; })
    ]).then(function (r) {
      var localNick = r[0], hb = r[1], entry = r[2];
      var entryNick = entry && entry.extra && entry.extra.nick ? entry.extra.nick : "";
      // 昵称显示链：黑盒昵称（换票缓存）→ 自选昵称 → 榜单 extra → 盒友
      var displayName = (hb && hb.nick) || localNick || entryNick || "盒友";
      $("#accountName").textContent = displayName;
      $("#accountId").textContent = "ID: " + ((hb && hb.appUserId) || (entry && entry.uid) || "--");
      // 头像：换票缓存里有 URL 就叠图（首字兜底，加载失败由全局 error 监听摘图），
      // 没有就维持首字母色块——OpenAPI 的 avatar 字段是否真有值，看诊断行的「+头像」
      var av = $("#accountAvatar");
      var letter = displayName.slice(0, 1) || "盒";
      if (hb && hb.avatar) {
        av.classList.remove("no-logo");
        var img = av.querySelector("img.avatar-img");
        if (!img || img.getAttribute("src") !== hb.avatar) {
          av.innerHTML = esc(letter) +
            '<img class="avatar-img" src="' + esc(hb.avatar) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
        }
      } else {
        av.textContent = letter;
      }
      $("#accountBadge").textContent = (hb && hb.nick) ? "已同步黑盒资料" : (entry ? "已绑定身份" : "游客");
      $("#accountHint").textContent = (hb && hb.nick)
        ? "昵称头像来自小黑盒授权资料（已同步，重复点击不会再次换票）"
        : (entry
          ? "已绑定小黑盒隔离身份 · 点「同步黑盒资料」可显示黑盒昵称头像，或设置展示昵称"
          : "打开小程序后自动绑定隔离身份；可先设置展示昵称用于榜单");
      $("#nickInput").value = localNick;
      // 已同步账号：按钮转为状态提示（点击只提示，不再发起换票=不再产生 FC 调用）
      $("#hbSyncBtn").textContent = hbProfileMatchesIdentity(hb) ? "已同步黑盒资料" : "同步黑盒资料";
      $("#hbSyncBtn").hidden = false;
      // 诊断行：宿主环境快照（版本/模式/系统），用于各端排障
      $("#settingsDiag").textContent = getDiagnostics() +
        (hb ? " · 换票:" + (hb.nick ? "ok" : hb.err || "无昵称") +
          (hb.via ? "(" + hb.via + ")" : "(旧缓存，点同步刷新)") +
          (hb.avatar ? "+头像" : "-无头像") : "");
    }).catch(function () {
      $("#accountBadge").textContent = "游客";
    });
  }

  /* ============================== 导航 ============================== */
  /* 视图历史：让宿主返回键回到上一级，而不是直接退出。
     深度用内存栈维护，不依赖 history.state（部分宿主会读到旧值）。 */
  var currentView = "matches";
  var viewStack = ["matches"];
  var historyReady = false;
  var resettingToHome = false;
  var resetTimer = 0;

  function isSubView(name) {
    return name === "rules" || name === "schedule" || name === "about" || name === "temple" || name === "duels" || name === "versus";
  }

  function initHistory() {
    if (typeof history === "undefined" || typeof history.pushState !== "function") return;
    try {
      history.replaceState({ sandbox: 1 }, "");
      historyReady = true;
    } catch (e) {
      historyReady = false;
    }
    window.addEventListener("popstate", function () {
      if (resettingToHome) {
        resettingToHome = false;
        clearTimeout(resetTimer);
        viewStack = ["matches"];
        switchView("matches", { fromHistory: true });
        return;
      }
      if (viewStack.length > 1) viewStack.pop();
      switchView(viewStack[viewStack.length - 1], { fromHistory: true });
    });
  }

  function syncHistory(prev, name) {
    if (!historyReady || name === prev) return;
    try {
      if (isSubView(name)) {
        // 二级页压一条，返回时回到来路（设置或首页）
        viewStack.push(name);
        history.pushState({ sandbox: 1 }, "");
        return;
      }
      if (name === "matches") {
        // 回首页时退掉临时记录，保证首页再按返回才退出
        var extra = viewStack.length - 1;
        viewStack = ["matches"];
        if (extra > 0) {
          resettingToHome = true;
          clearTimeout(resetTimer);
          // 宿主若吞掉 go() 不触发 popstate，兜底复位标记
          resetTimer = setTimeout(function () { resettingToHome = false; }, 800);
          history.go(-extra);
        } else {
          history.replaceState({ sandbox: 1 }, "");
        }
        return;
      }
      if (viewStack.length === 1) {
        // 首页 → 一级页：压一条，返回回首页
        viewStack.push(name);
        history.pushState({ sandbox: 1 }, "");
      } else {
        // 一级页之间切换：替换，返回仍回首页
        viewStack[viewStack.length - 1] = name;
        history.replaceState({ sandbox: 1 }, "");
      }
    } catch (e) {
      /* 历史记录不可用时退回宿主默认行为 */
    }
  }

  function goBack(fallback) {
    if (historyReady && viewStack.length > 1) {
      history.back();
      return;
    }
    switchView(fallback);
  }

  function switchView(name, options) {
    var opts = options || {};
    var prev = currentView;
    var isSubPage = isSubView(name);
    // 先归零滚动，再收缩页面：长页缩成短页时不会因滚动位置越界闪空白
    window.scrollTo(0, 0);
    if (name === "schedule" && prev !== "schedule") {
      // 清掉上次的 3000+ 行再显示，避免整树重排造成数秒卡顿；随后由 renderSchedule 分帧重建
      schedRender = null;
      var schedList = $("#scheduleList");
      if (schedList) schedList.innerHTML = "";
    }
    ["matches", "profile", "board", "settings", "rules", "schedule", "about", "temple", "duels", "versus"].forEach(function (v) {
      $("#view-" + v).hidden = v !== name;
    });
    // 魔神殿从排行榜进入返回回排行榜；对决记录/对比页从「我的」侧进入返回回「我的」
    var tabName = name === "temple" ? "board"
      : name === "duels" || name === "versus" ? "profile"
        : (isSubPage ? "settings" : name);
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("is-active", t.dataset.view === tabName);
    });
    if (name === "matches" && matchesDirty) renderMatches();
    if (name === "profile") renderProfile();
    if (name === "board") { syncBoards(); renderBoard(); }
    if (name === "temple") renderTemple();
    if (name === "duels") renderDuels();
    if (name === "versus") renderVersus();
    if (name === "settings" || isSubPage) renderSettings();
    if (name === "schedule") renderSchedule();
    currentView = name;
    if (!opts.fromHistory) syncHistory(prev, name);
  }

  /* ============================== 事件绑定 ============================== */
  function bindEvents() {
    var refreshBtn = $("#refreshDataBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", function () {
      // 宿主全局 Loading：无权限、无手势要求；旧宿主静默降级（按钮原有文案反馈仍在）
      uiShowLoading();
      Promise.resolve(refreshData(true)).then(
        function () { uiHideLoading(); },
        function () { uiHideLoading(); }
      );
    });

    $("#matchList").addEventListener("click", function (e) {
      var row = e.target.closest(".team-row[data-match]");
      if (!row) return;
      openSheet(row.dataset.match, row.dataset.pick);
    });

    // 对决：约战按钮（先确认）/ 邀请横幅 / 战报回传 / 已发约战再复制
    $("#duelBtn").addEventListener("click", openDuelConfirm);
    $("#duelEntry").addEventListener("click", function () { switchView("duels"); });
    $("#versusShareBtn").addEventListener("click", function () {
      var s = recordSummary();
      duelNick().then(function (nick) {
        return copyShareLink({
          v: 1, c: 1, n: nick,
          w: s.wins, l: s.losses, p: s.profit,
          g: state.gods || 0, b: state.bankrupts || 0
        });
      }).then(function (err) {
        if (!err) toast("对比链接已复制 · 发给好友即可开比");
        else toast("复制链接失败，当前端不支持");
      });
    });
    $("#duelDialogCopy").addEventListener("click", duelDialogCopyAction);
    $("#duelDialogDismiss").addEventListener("click", closeDuelDialog);
    $("#duelDialogClose").addEventListener("click", closeDuelDialog);
    $("#duelDialogBackdrop").addEventListener("click", function (e) {
      if (e.target === $("#duelDialogBackdrop")) closeDuelDialog();
    });
    // 约战流程说明：确认弹窗内 / 对决记录页各一个入口
    var openDuelHelp = function () { $("#duelHelpBackdrop").hidden = false; };
    var closeDuelHelp = function () { $("#duelHelpBackdrop").hidden = true; };
    $("#duelHelpFromDialog").addEventListener("click", openDuelHelp);
    $("#duelHelpFromPage").addEventListener("click", openDuelHelp);
    $("#duelHelpOk").addEventListener("click", closeDuelHelp);
    $("#duelHelpClose").addEventListener("click", closeDuelHelp);
    $("#duelHelpBackdrop").addEventListener("click", function (e) {
      if (e.target === $("#duelHelpBackdrop")) closeDuelHelp();
    });
    $("#duelSentBox").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-duel-recopy]");
      if (!btn) return;
      var sent = findSentInvite(btn.dataset.duelRecopy);
      if (!sent) { toast("该约战已失效（比赛已截止）"); renderDuelSent(); return; }
      copyDuelInvite(sent).then(function (err) {
        if (!err) toast("约战链接已复制 · 发给好友即可应战");
        else toast("复制链接失败，当前端不支持");
      });
    });
    $("#duelBanner").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-duel-act]");
      if (!btn) return;
      if (btn.dataset.duelAct === "accept") {
        var inv = duelInvite;
        var m = inv ? matchById(inv.m) : null;
        if (inv && m && statusOf(m) === "open") openSheet(inv.m, inv.p);
        else toast("这场比赛已不在可竞猜状态");
      } else {
        dismissDuelInvite();
      }
    });
    $("#duelList").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-duel-report]");
      if (btn) {
        var d = null;
        DUELS.forEach(function (x) { if (x.id === btn.dataset.duelReport) d = x; });
        if (d) sendDuelReport(d);
        return;
      }
      var rm = e.target.closest("button[data-duel-rematch]");
      if (rm) {
        switchView("matches");
        toast("选一场下注，再点「约战好友」向 " + rm.dataset.duelRematch + " 复仇");
      }
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
      // 保存兜底方案（2026-10-27）：宿主截图分享流程在实测中给不出相册入口，
      // 改为卡片全屏展示，用户直接系统截屏保存——不依赖任何宿主能力，全平台可靠。
      var canvas = $("#shareCanvas");
      try {
        $("#cardFullImg").src = canvas.toDataURL("image/png");
        $("#cardFullscreen").hidden = false;
      } catch (err) {
        toast("图片生成失败，可直接截屏分享卡");
      }
    });
    $("#cardFullClose").addEventListener("click", function () {
      $("#cardFullscreen").hidden = true;
    });
    $("#cardFullscreen").addEventListener("click", function (e) {
      if (e.target === $("#cardFullscreen")) $("#cardFullscreen").hidden = true;
    });

    $("#shareCopyText").addEventListener("click", function () {
      var text = buildPostText();
      function done() { toast("文案已复制，去发帖页粘贴即可"); }
      // 宿主内优先走原生剪贴板（不依赖浏览器 Clipboard 的手势/安全域规则），失败回退浏览器路径
      setClipboard(text).then(function (ok) {
        if (ok) return done();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
        } else {
          fallbackCopy(text);
          done();
        }
      });
    });

    $("#shareForward").addEventListener("click", function () {
      var pred = sharePred;
      var m = pred && matchById(pred.matchId);
      if (!pred || !m) return;
      var won = !!pred.won;
      showShareMenu({
        title: (won ? "我猜中了 " : "我猜错了 ") + m.teamA.short + " vs " + m.teamB.short,
        desc: "「赛事沙盘」电竞竞猜 · " + (won ? "盈利 " : "亏损 ") + fmtNum(Math.abs(pred.profit)) + " 沙粒",
        post: { topics: [shareTopicFor(m)] }
      }).then(function (err) {
        if (!err) return; // 面板已打开；是否发布由用户决定，返回值不透明不能判断
        if (err === "METHOD_FORBIDDEN" || err === "UNSUPPORTED" || err === "METHOD_NOT_FOUND") {
          toast("当前端不支持转发，可用复制文案或复制链接");
        } else {
          toast("转发未完成，可用复制文案或复制链接");
        }
      });
    });

    $("#shareCopyLink").addEventListener("click", function () {
      var pred = sharePred;
      if (!pred) return;
      // extra 随通用分享链接携带：{v:1, m: 比赛id}，接收方启动时 getLaunchExtra 还原后直达该场
      copyShareLink({ v: 1, m: String(pred.matchId || "") }).then(function (err) {
        if (!err) { toast("链接已复制，发给好友可直达这场比赛"); return; }
        if (err === "UNSUPPORTED" || err === "METHOD_FORBIDDEN" || err === "METHOD_NOT_FOUND") {
          toast("当前端不支持复制链接，可用复制文案");
        } else {
          toast("复制链接失败，可用复制文案");
        }
      });
    });

    $("#hbSyncBtn").addEventListener("click", function () { syncHbProfile(); });

    // 清除本地数据：两段式确认（第一次点变确认态，3s 未续点还原）
    var clearArmed = false, clearTimer = 0;
    $("#clearDataBtn").addEventListener("click", function () {
      if (!clearArmed) {
        clearArmed = true;
        $("#clearDataHint").textContent = "再点一次确认";
        toast("将清除本机全部数据（战绩/昵称/缓存/引导），云同步不受影响");
        clearTimeout(clearTimer);
        clearTimer = setTimeout(function () {
          clearArmed = false;
          var el = $("#clearDataHint");
          if (el) el.textContent = "重置全部";
        }, 3000);
        return;
      }
      clearTimeout(clearTimer);
      clearArmed = false;
      Promise.all(CLEAR_KEYS.map(function (k) { return storageSet(k, ""); }))
        .then(function () {
          // 浏览器/localStorage 分支同步清理；SDK storage 已被空串覆盖（读取端对空值一律回退默认）
          CLEAR_KEYS.forEach(function (k) {
            try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
          });
          toast("已清除，正在重新启动…");
          setTimeout(reloadPage, 600);
        });
    });

    $("#nickSave").addEventListener("click", function () {
      var nick = String($("#nickInput").value || "").trim();
      if (nick.length > 12) { toast("昵称最多 12 个字"); return; }
      storageSet(NICK_KEY, nick).then(function () {
        toast(nick ? "展示昵称已保存：" + nick : "展示昵称已清除");
        syncBoards(); // 立即随榜单 extra 提交，其他设备/榜单页可见
        renderSettings();
      });
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
    $("#rulesBackBtn").addEventListener("click", function () { goBack("settings"); });
    $("#aboutBackBtn").addEventListener("click", function () { goBack("settings"); });
    $("#openAboutBtn").addEventListener("click", function () { switchView("about"); });
    $("#homeScheduleBtn").addEventListener("click", function () { switchView("schedule"); });

    $("#openScheduleBtn").addEventListener("click", function () { switchView("schedule"); });
    $("#scheduleBackBtn").addEventListener("click", function () { goBack("settings"); });

    // 魔神殿与转生仪式
    $("#openTemple").addEventListener("click", function () { switchView("temple"); });
    $("#templeBackBtn").addEventListener("click", function () { goBack("board"); });
    $("#templeTabs").addEventListener("click", function (e) {
      var tab = e.target.closest(".temple-tab");
      if (!tab || tab.dataset.temple === templeTab) return;
      templeTab = tab.dataset.temple;
      renderTemple();
    });
    $("#templeCeremonyBtn").addEventListener("click", function () {
      var q = honorQualified();
      if (!q) { toast("尚未达到封神/破产条件"); return; }
      showCeremony(q);
    });
    $("#cerCta").addEventListener("click", performCeremony);
    $("#cerLater").addEventListener("click", closeCeremony);

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
      var input = this;
      var existing = predictionFor(sheetMatchId);
      var limits = stakeLimits(sheetMode, existing);
      if (limits.fixed) { updatePreview(); return; }
      var val = parseInt(input.value, 10);
      if (!isFinite(val)) { updatePreview(); return; }

      if (sheetMode === "withdraw") {
        var maxWithdraw = existing ? existing.stake : 0;
        if (val < 1) val = 1;
        if (val > maxWithdraw) {
          val = maxWithdraw;
          toast("最多可撤回 " + fmtNum(maxWithdraw) + " 沙粒");
        }
      } else {
        var minAllowed = Math.min(limits.min, limits.max);
        if (val > limits.max) {
          val = limits.max;
          toast("已按上限 " + fmtNum(limits.max) + " 沙粒" + (sheetMode === "add" ? "（总投入不超过当前沙粒 2 倍）" : "（当前沙粒 2 倍）"));
        }
        if (val < minAllowed) val = minAllowed;
      }
      input.value = val;
      updatePreview();
    });

    $("#stakeMode").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      sheetMode = btn.dataset.mode;
      renderStakeMode();
      renderStakeUI(predictionFor(sheetMatchId));
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
      var existing = predictionFor(sheetMatchId);
      var limits = stakeLimits(sheetMode, existing);
      var amount = btn.dataset.amount;
      var value;

      if (sheetMode === "withdraw") {
        if (!existing) return;
        value = amount === "withdrawAll" ? existing.stake : parseInt(amount, 10);
        value = Math.min(Math.max(1, value), existing.stake);
      } else if (sheetMode === "add") {
        value = amount === "max" ? limits.max : parseInt(amount, 10);
        if (limits.max !== Infinity) value = Math.min(value, limits.max);
        value = Math.max(Math.min(limits.min, limits.max), value);
      } else {
        if (amount === "all") value = Math.floor(Math.max(0, state.bankroll));
        else if (amount === "double") value = limits.max;
        else value = parseInt(amount, 10);
        if (limits.max !== Infinity) value = Math.min(value, limits.max);
        value = Math.max(Math.min(limits.min, limits.max), value);
      }
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
  function applySnapshot(matches, meta, teams) {
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
    // 队标映射只增不减：老队伍退场后保留，成本只有几十 KB 内存
    if (teams) {
      Object.keys(teams).forEach(function (name) { TEAM_LOGOS[name] = teams[name]; });
    }
    rebuildMatchIndex();
    if (meta && meta.updatedAt) DATA_UPDATED_AT = meta.updatedAt;
    runtimeRefreshed = true;

    var events = settlePending();
    var duelDone = settleDuels();
    renderDuelBanner(); // 数据刷新可能改变比赛状态（截止/开赛），横幅跟着收敛
    renderSelectors();
    renderAll();
    renderSettings();
    if (!$("#view-schedule").hidden) renderSchedule();
    if (!$("#view-board").hidden) renderBoard();
    resolveDeepLink();
    resolveVersusLink();

    if (events.length) {
      syncBoards();
      var total = events.reduce(function (s, e) { return s + e.pred.profit; }, 0);
      var wins = events.filter(function (e) { return e.pred.won; }).length;
      toast("已结算 " + events.length + " 场 · 命中 " + wins + " 场 · " +
        (total >= 0 ? "+" : "") + fmtNum(total) + " 沙粒" +
        (duelDone.length ? " · " + duelToastText(duelDone) : ""));
    } else if (duelDone.length) {
      setTimeout(function () { toast(duelToastText(duelDone)); }, 500);
    }
  }

  var NET_BLOCK_KEY = "esports_sandbox_net_block";
  var NET_BLOCK_TTL = 24 * 60 * 60 * 1000;
  var POLL_INTERVAL = 5 * 60 * 1000;      // 轮询节奏：与采集器 5 分钟更新对齐
  var POLL_MAX_AGE = 3 * 60 * 1000;       // 轮询/回前台节流：3 分钟内查过就只走本地缓存
  var POLL_BACKOFF = 15 * 60 * 1000;      // 限流退避：RATE_LIMITED 后暂停自动轮询
  var pollBackoffUntil = 0;
  var refreshing = false;

  async function refreshData(manual) {
    if (refreshing) {
      if (manual) toast("正在检查更新…");
      return false;
    }
    if (!isRuntimeEnabled()) {
      if (manual) toast("当前版本未启用在线更新");
      return false;
    }
    refreshing = true;
    if (manual) toast("正在检查赛程更新…");
    try {
      var cached = await loadCachedSnapshot();
      if (cached && cached.meta && cached.meta.updatedAt &&
          cached.meta.updatedAt !== DATA_UPDATED_AT) {
        applySnapshot(cached.matches, cached.meta, cached.teams);
      }

      // 宿主明确拒绝服务端 API 时，24 小时内不再自动重试，避免每次启动弹原生错误框
      var blocked = await storageGet(NET_BLOCK_KEY);
      if (typeof blocked === "string") {
        try { blocked = JSON.parse(blocked); } catch (e) { blocked = null; }
      }
      if (!manual && blocked && blocked.version === APP_VERSION && blocked.at &&
          Date.now() - blocked.at < NET_BLOCK_TTL) {
        return false;
      }

      var remote = await fetchRemoteSnapshot({
        force: manual === true,
        maxAgeMs: manual ? 0 : POLL_MAX_AGE
      });

      if (remote && remote.meta) {
        pollBackoffUntil = 0;
        await storageSet(NET_BLOCK_KEY, { at: 0, version: APP_VERSION });
        if (remote.meta.updatedAt && remote.meta.updatedAt !== DATA_UPDATED_AT) {
          applySnapshot(remote.matches, remote.meta, remote.teams);
          if (manual) toast("赛程已更新");
        } else if (manual) {
          toast("赛程已是最新");
        }
        syncBoards(); // 全平台统一：数据刷新后同步榜单（submit 只在新分数更优时落库）
        if (!$("#view-board").hidden) renderBoard();
        return true;
      }

      if (remote && (remote.error === "RATE_LIMITED" || remote.error === "RATE_LIMITED_BY_RUNTIME")) {
        // Runtime 本地熔断/上游限流：暂停自动轮询一个退避周期，不要立即重试
        pollBackoffUntil = Date.now() + POLL_BACKOFF;
        console.warn("[data] 限流，自动轮询退避至 " + new Date(pollBackoffUntil).toLocaleTimeString());
      }
      if (remote && remote.error === "SERVER_API_REQUIRED") {
        console.warn("[data] 宿主返回 SERVER_API_REQUIRED，冷却 24 小时");
        await storageSet(NET_BLOCK_KEY, { at: Date.now(), version: APP_VERSION });
      }
      if (!manual) return false;
      if (!remote) toast("预览版暂不支持在线更新");
      else if (remote.error === "SERVER_API_REQUIRED") toast("当前客户端暂不支持在线更新");
      else if (remote.error === "RATE_LIMITED" || remote.error === "RATE_LIMITED_BY_RUNTIME") toast("操作过于频繁，请稍后再试");
      else toast("检查更新失败，请稍后再试");
      return false;
    } catch (e) {
      if (manual) toast("检查更新失败，请稍后再试");
      return false;
    } finally {
      refreshing = false;
    }
  }

  /* 握手晚于 1.5s：SDK 能力在 ready 后会恢复，补一次布局、账号与数据刷新 */
  function scheduleLatePlatformRecovery(platformReady) {
    if (platformReady) return;
    whenPlatformReady(10000).then(function (ok) {
      if (!ok) return;
      setupViewport();
      if (!$("#view-settings").hidden) renderSettings();
      if (!$("#view-board").hidden) renderBoard();
      refreshData();
    });
  }

  /* ============================== 分享深链与宿主事件 ============================== */
  /* 复制链接/转发携带 {v:1, m: 比赛id}；接收方启动后 getLaunchExtra 还原，数据就绪即定位。 */
  var pendingDeepLink = "";
  var runtimeRefreshed = false;

  function clampStat(v) {
    return typeof v === "number" && isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1e9) : 0;
  }

  function readLaunchExtra() {
    var extra = getLaunchExtra();
    if (!extra || typeof extra !== "object" || Array.isArray(extra) || extra.v !== 1) return;
    // 战绩对比链接（c:1）：不依赖比赛数据，引导结束后直接进对比页
    if (extra.c === 1 && typeof extra.n === "string" && extra.n.trim()) {
      pendingVersusLaunch = {
        n: extra.n.trim().slice(0, 12),
        w: clampStat(extra.w),
        l: clampStat(extra.l),
        p: typeof extra.p === "number" && isFinite(extra.p) ? Math.max(-1e12, Math.min(1e12, Math.round(extra.p))) : 0,
        g: clampStat(extra.g),
        b: clampStat(extra.b)
      };
      return;
    }
    if (typeof extra.m !== "string" || !extra.m) return;
    pendingDeepLink = extra.m;
    // 对决链接：d:1 约战 / d:2 战报，参数合法性在接收端逐项校验
    if ((extra.d === 1 || extra.d === 2) &&
        (extra.p === "A" || extra.p === "B") &&
        typeof extra.n === "string" && extra.n.trim() &&
        typeof extra.s === "number" && isFinite(extra.s) && extra.s >= 0) {
      pendingDuelLaunch = {
        d: extra.d, m: extra.m, p: extra.p,
        s: Math.min(Math.round(extra.s), 1e12),
        n: extra.n.trim().slice(0, 24),
        r: typeof extra.r === "string" && /^[A-Za-z0-9]{2,8}$/.test(extra.r) ? extra.r : ""
      };
    }
  }

  function deepLinkSelector(scope, matchId) {
    // 属性选择器内引号/反斜杠会破坏匹配；id 来自自家链接，去掉即可
    var safe = matchId.replace(/["\\]/g, "");
    return scope + '[data-match="' + safe + '"]';
  }

  function flashMatchRow(el) {
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); }
    catch (e) { el.scrollIntoView(true); }
    el.classList.remove("deep-link-flash");
    void el.offsetWidth; // 重启动画
    el.classList.add("deep-link-flash");
    setTimeout(function () { el.classList.remove("deep-link-flash"); }, 2000);
  }

  function locateDeepLinkRow(matchId, selector) {
    // 赛程表分帧渲染，目标行可能还没插进来：轮询最多约 3 秒
    var left = 30;
    (function poll() {
      var el = document.querySelector(selector);
      if (el) {
        pendingDeepLink = "";
        flashMatchRow(el);
        return;
      }
      if (left-- <= 0) {
        pendingDeepLink = "";
        toast("该比赛不在当前数据范围内");
        return;
      }
      setTimeout(poll, 100);
    })();
  }

  function resolveDeepLink() {
    if (!pendingDeepLink) return;
    if (!$("#onboardBackdrop").hidden) { pendingDeepLink = ""; pendingDuelLaunch = null; return; } // 新用户先看引导，不打断
    var m = matchById(pendingDeepLink);
    if (!m) {
      // 内置窗口只是快照：等运行时数据到了再下结论
      if (runtimeRefreshed) {
        pendingDeepLink = "";
        if (pendingDuelLaunch) {
          toast(pendingDuelLaunch.d === 1 ? "约战的比赛不在当前数据范围内" : "战报的比赛不在当前数据范围内");
          pendingDuelLaunch = null;
        } else {
          toast("分享的比赛不在当前数据范围内");
        }
      }
      return;
    }
    // 对决链接：比赛就绪后先处理邀请/战报，再走常规定位高亮
    if (pendingDuelLaunch && pendingDuelLaunch.m === m.id) {
      var duel = pendingDuelLaunch;
      pendingDuelLaunch = null;
      if (duel.d === 1) handleDuelInvite(duel);
      else handleDuelReport(duel);
    }
    var start = new Date(m.startAt).getTime();
    var now = Date.now();
    if (start >= now - HOME_PAST_DAYS * 86400000 && start <= now + HOME_FUTURE_DAYS * 86400000) {
      if (currentView !== "matches") switchView("matches");
      locateDeepLinkRow(m.id, deepLinkSelector(".team-row", m.id));
    } else {
      // 赛程表 ±30 天窗口覆盖其余比赛；重置筛选避免被当前过滤条件挡住
      schedGame = "all";
      schedTournament = "__all__";
      schedQuery = "";
      $("#scheduleSearch").value = "";
      $("#scheduleSearchClear").hidden = true;
      if (currentView !== "schedule") switchView("schedule");
      locateDeepLinkRow(m.id, deepLinkSelector(".schedule-row", m.id));
    }
  }

  // 战绩对比链接：不依赖比赛数据，引导结束后直接进对比页
  function resolveVersusLink() {
    if (!pendingVersusLaunch) return;
    if (!$("#onboardBackdrop").hidden) return; // 新手引导进行中，等下一次调用
    versusData = pendingVersusLaunch;
    pendingVersusLaunch = null;
    switchView("versus");
  }

  /** 登录态变化/回前台：刷新账号展示与榜单高亮（数据仍只在启动时拉取，属既定设计）。 */
  function bindHostEvents() {
    onHostEvent("heybox_app_login_change", function () {
      Cloud.resetIdentity();
      if (!$("#view-settings").hidden) renderSettings();
      if (!$("#view-board").hidden) renderBoard();
    });
    onHostEvent("show", function () {
      // 回前台：可见页账号/榜单重渲染 + 赛程节流刷新（3 分钟内查过则只走本地缓存）
      refreshData(false);
      if (!$("#view-settings").hidden) renderSettings();
      if (!$("#view-board").hidden) renderBoard();
    });
  }

  /* ============================== 对决（约战好友） ==============================
   * 平台没有好友/私信/推送 API，也没有跨用户存储，对决靠分享链接 extra 往返闭环：
   *   d:1 约战（赛前，发起方带选择/投入/昵称）→ 对方应战下注 → d:2 战报（赛后，应战方回传）
   *   → 发起方据此补全记录。应战方在应战时就有完整记录。
   * 记录只存本机：cloud.storage 是每用户 16KB 配额且他人不可读，同步对决列表无意义。
   * extra 上限 128 字节（MessagePack 编码后），带随机码实测约 60~110B（超长 id+8 字昵称最坏 109B），
   * 昵称截断到 12 字符。
   */
  var DUELS_KEY = "esports_sandbox_duels_v1";
  var DUEL_INVITE_KEY = "esports_sandbox_duel_invite";
  var DUEL_LOCKS_KEY = "esports_sandbox_duel_locks";
  var DUEL_SENT_KEY = "esports_sandbox_duel_sent";
  var DUEL_MAX = 200;
  var DUEL_SENT_MAX = 50;
  var DUELS = [];
  var duelInvite = null; // 待应战的约战：{m,p,s,n,r,exp}
  var duelLocks = {}; // 对决锁定的比赛：{matchId: lockedAt}。战书不可改——发出/应战后该场投入冻结到截止
  var duelSent = []; // 已发出的约战：[{m,p,s,n,r,label,startAt,at}]，供再次复制链接
  var duelDialogMode = null; // "confirm" 发起确认 | "relock" 已约战再复制
  var duelDialogMatchId = "";
  var duelDialogPick = "";
  var myNickCache = ""; // 渲染用：我的展示昵称/头像（换票/榜单同步时刷新）
  var myAvatarCache = "";
  var duelAvatarMap = null; // 昵称 → 头像（来自榜单 extra，对决卡/对比页反查用）
  var duelAvatarMapAt = 0;
  var pendingVersusLaunch = null; // 战绩对比链接 extra，等引导结束后进对比页
  var versusData = null; // 当前对比页的对方数据
  var pendingDuelLaunch = null; // 启动链接里的对决 extra，等比赛数据就绪后处理

  function loadDuels() {
    return storageGet(DUELS_KEY).then(function (v) {
      var list = typeof v === "string" ? JSON.parse(v) : v;
      DUELS = Array.isArray(list) ? list.filter(function (d) {
        return d && typeof d.matchId === "string" && typeof d.oppNick === "string";
      }) : [];
    }).catch(function () { DUELS = []; });
  }

  function saveDuels() {
    storageSet(DUELS_KEY, DUELS.slice(0, DUEL_MAX)).catch(function () { /* 存储失败不阻塞对局 */ });
  }

  function duelId(matchId, role, oppKey) {
    return "duel-" + String(matchId + "|" + role + "|" + oppKey).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);
  }

  // 对手身份只有昵称（无账号体系），昵称撞车（尤其默认「盒友」）会让记录互相覆盖；
  // 链接里带 4 字符随机码掺进 id：同一个人重复发送=同码=去重，不同人=异码=各自成账
  function duelCode() {
    // 非加密用途（仅防昵称撞车的去重码）；强随机源优先，旧 WebView 回退时间戳
    try {
      var buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return (buf[0] % 1679616).toString(36).padStart(4, "0");
    } catch (e) {
      return (Date.now() % 1679616).toString(36).padStart(4, "0");
    }
  }

  function matchLockTime(m) { return new Date(m.startAt).getTime() - 3600000; }
  function pickName(m, pick) { return pick === "A" ? m.teamA.name : m.teamB.name; }
  function matchLabel(m) {
    return m.teamA.short + " vs " + m.teamB.short + " · " + String(m.tournament || "").split(" · ")[0];
  }
  function duelOutcomeText(status) {
    return status === "won" ? "胜" : status === "lost" ? "负" : status === "drawn" ? "平" : "待赛果";
  }

  // 我的展示昵称：黑盒资料 → 自选昵称 → 盒友；链接空间有限截到 12 字符
  function duelNick() {
    return loadHbProfile().catch(function () { return null; }).then(function (hb) {
      if (hb && hb.nick) {
        myNickCache = String(hb.nick).slice(0, 12);
        myAvatarCache = hb.avatar || "";
        return myNickCache;
      }
      return loadNick().then(function (nick) {
        myNickCache = (nick ? nick : "盒友").slice(0, 12);
        return myNickCache;
      });
    });
  }

  // 昵称 → 头像 反查表：对决卡/对比页里只有对方昵称，头像从榜单 extra 反查（榜单读取带 5 分钟缓存）
  function ensureDuelAvatars() {
    if (Cloud.isMock()) return Promise.resolve({});
    if (duelAvatarMap && Date.now() - duelAvatarMapAt < 300000) return Promise.resolve(duelAvatarMap);
    duelAvatarMapAt = Date.now();
    return Promise.all([
      Cloud.getBoard("win", 200).catch(function () { return { entries: [] }; }),
      Cloud.getBoard("lose", 200).catch(function () { return { entries: [] }; }),
      Cloud.getTemple(200).catch(function () { return { entries: [] }; })
    ]).then(function (rs) {
      var map = {};
      rs.forEach(function (r) {
        (r.entries || []).forEach(function (e) {
          if (e.nick && e.avatar && !map[e.nick]) map[e.nick] = e.avatar;
        });
      });
      duelAvatarMap = map;
      if (!$("#view-duels").hidden) renderDuels();
      return map;
    });
  }

  // 发起约战：先弹确认（预告锁仓），确认后才复制链接并锁定
  function openDuelConfirm() {
    var m = matchById(sheetMatchId);
    if (!m || statusOf(m) !== "open") { toast("比赛已截止，无法约战"); return; }
    var existing = predictionFor(m.id);
    if (!existing) { toast("先下注才能约战 · 对决按你的真实投入进行"); return; }
    duelDialogMode = "confirm";
    duelDialogMatchId = m.id;
    duelDialogPick = sheetPick;
    $("#duelDialogTitle").textContent = "约战好友";
    $("#duelDialogMeta").textContent = matchLabel(m) + " · " + fmtTime(m.startAt);
    $("#duelDialogText").innerHTML = "你押 <b>" + esc(pickName(m, sheetPick)) + "</b> · 投入 <b>" +
      fmtNum(existing.stake) + "</b> 沙粒。链接发给好友，对方点开下注即成立对决。" +
      "<b>发出后该场投入锁定到竞猜截止，不可加注/撤回。</b>";
    $("#duelDialogTip").textContent = "对方应战后会回传应战，你这边才会出现对决记录";
    $("#duelDialogCopy").textContent = "复制约战链接";
    $("#duelDialogBackdrop").hidden = false;
  }

  // 已约战的场次：竞猜面板进不去，从这里（或对决记录页）再复制链接发给更多好友
  function openDuelRelock(matchId) {
    var m = matchById(matchId);
    if (!m) return;
    duelDialogMode = "relock";
    duelDialogMatchId = matchId;
    duelDialogPick = "";
    $("#duelDialogTitle").textContent = "已约战";
    $("#duelDialogMeta").textContent = matchLabel(m) + " · " + fmtTime(m.startAt);
    $("#duelDialogText").innerHTML = "这场已发出约战，投入锁定到竞猜截止。对手点开链接下注即成立对决，可复制链接发给更多好友。";
    $("#duelDialogTip").textContent = "重复复制的是同一条链接，已应战的好友不会重复建账";
    $("#duelDialogCopy").textContent = "复制约战链接";
    $("#duelDialogBackdrop").hidden = false;
  }

  function closeDuelDialog() {
    $("#duelDialogBackdrop").hidden = true;
    duelDialogMode = null;
    duelDialogMatchId = "";
  }

  function copyDuelInvite(rec) {
    // rec 缺字段（老数据/兜底重建）时按当前预测重造；随机码必须复用，否则已应战者会重复建账
    return duelNick().then(function (nick) {
      var extra = {
        v: 1, d: 1, m: rec.m, p: rec.p, s: rec.s,
        n: rec.n || nick, r: rec.r || duelCode()
      };
      return copyShareLink(extra).then(function (err) {
        if (!err && !findSentInvite(rec.m)) saveSentInvite({
          m: rec.m, p: extra.p, s: extra.s, n: extra.n, r: extra.r,
          label: (matchById(rec.m) ? matchLabel(matchById(rec.m)) : rec.label) || "",
          startAt: (matchById(rec.m) || {}).startAt || rec.startAt || "",
          at: Date.now()
        });
        return err;
      });
    });
  }

  function duelDialogCopyAction() {
    var m = matchById(duelDialogMatchId);
    if (!m) { closeDuelDialog(); return; }
    if (duelDialogMode === "relock") {
      var sent = findSentInvite(duelDialogMatchId);
      var rec = sent || (function () {
        var my = predictionFor(m.id);
        return { m: m.id, p: my ? my.pick : "A", s: my ? my.stake : 0, r: duelCode() };
      })();
      copyDuelInvite(rec).then(function (err) {
        if (!err) { closeDuelDialog(); toast("约战链接已复制 · 发给好友即可应战"); }
        else toast("复制链接失败，当前端不支持");
      });
      return;
    }
    var existing = predictionFor(m.id);
    if (!existing) { toast("本场预测已不存在"); closeDuelDialog(); return; }
    duelNick().then(function (nick) {
      var r = duelCode();
      return copyShareLink({
        v: 1, d: 1, m: m.id, p: duelDialogPick,
        s: existing.stake, n: nick, r: r
      }).then(function (err) {
        if (!err) {
          saveSentInvite({
            m: m.id, p: duelDialogPick, s: existing.stake, n: nick, r: r,
            label: matchLabel(m), startAt: m.startAt, at: Date.now()
          });
          lockDuel(m.id);
          closeDuelDialog();
          closeSheet();
          toast("约战链接已复制 · 该场投入已锁定到截止");
        } else {
          toast("复制链接失败，当前端不支持");
        }
      });
    });
  }

  // 收到约战（d:1）：已有预测直接成立，否则挂横幅等下注
  function handleDuelInvite(ex) {
    var m = matchById(ex.m);
    if (!m) { toast("约战的比赛不在当前数据范围内"); return; }
    if (statusOf(m) !== "open") { toast("这场比赛已截止，无法应战"); return; }
    if (predictionFor(m.id)) { acceptDuel(ex); return; }
    duelInvite = { m: ex.m, p: ex.p, s: ex.s, n: ex.n, r: ex.r || "", exp: matchLockTime(m) };
    storageSet(DUEL_INVITE_KEY, duelInvite).catch(function () {});
    renderDuelBanner();
  }

  // 应战成立：记录含对手昵称/选择/投入，赛果出来后自动结算
  function acceptDuel(ex) {
    var m = matchById(ex.m);
    if (!m) return;
    var my = predictionFor(ex.m);
    if (!my) return; // 应战必须以真实下注为准
    var rec = {
      id: duelId(ex.m, "challenger", ex.n + (ex.r ? "+" + ex.r : "")),
      matchId: ex.m,
      role: "challenger",
      oppNick: ex.n, oppPick: ex.p, oppPickName: pickName(m, ex.p), oppStake: ex.s,
      myPick: my.pick, myPickName: pickName(m, my.pick), myStake: my.stake,
      label: matchLabel(m), startAt: m.startAt, createdAt: Date.now(),
      rc: duelCode(), // 应战方随机码：回执/战报携带，发起方据此建账防同昵称覆盖
      status: "pending", settledAt: 0, myProfit: 0
    };
    var idx = -1;
    DUELS.forEach(function (x, i) { if (x.id === rec.id) idx = i; });
    if (idx >= 0) {
      DUELS[idx] = Object.assign(DUELS[idx], {
        oppPick: rec.oppPick, oppPickName: rec.oppPickName, oppStake: rec.oppStake,
        myPick: rec.myPick, myPickName: rec.myPickName, myStake: rec.myStake, label: rec.label
      });
    } else {
      DUELS.unshift(rec);
    }
    saveDuels();
    lockDuel(ex.m); // 应战成立同样锁仓：防赛后悄悄改边求平，两边判定基准始终一致
    dismissDuelInvite();
    toast("对决成立 · 与 " + rec.oppNick + " 一决胜负，对决记录里发送应战回执");
    if (!$("#view-profile").hidden) renderProfile();
    if (!$("#view-duels").hidden) renderDuels();
  }

  // 下注成功后调用：若这场挂着待应战的约战，落记录
  function attachDuelInvite(matchId) {
    if (duelInvite && duelInvite.m === matchId) acceptDuel(duelInvite);
  }

  function dismissDuelInvite() {
    duelInvite = null;
    storageSet(DUEL_INVITE_KEY, "").catch(function () {});
    renderDuelBanner();
  }

  function loadDuelInvite() {
    return storageGet(DUEL_INVITE_KEY).then(function (v) {
      var inv = typeof v === "string" ? JSON.parse(v) : v;
      if (inv && typeof inv.m === "string" && (inv.p === "A" || inv.p === "B") &&
          typeof inv.n === "string" && inv.n && typeof inv.exp === "number" && Date.now() < inv.exp) {
        duelInvite = inv;
      }
    }).catch(function () {});
  }

  // ===== 对决锁：发出约战（发起方）/ 应战成立（应战方）后，该场投注冻结到竞猜截止。
  // 没有跨用户通道，唯一能让两边判定一致的基准就是战书快照——锁住它，改投注的口子就不存在。
  function loadDuelLocks() {
    return storageGet(DUEL_LOCKS_KEY).then(function (v) {
      var obj = typeof v === "string" ? JSON.parse(v) : v;
      duelLocks = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
      pruneDuelLocks();
    }).catch(function () { duelLocks = {}; });
  }

  function pruneDuelLocks() {
    // 比赛截止后本来就无法改投注，锁自然失效；数据被清理/过期出窗口的也一并丢弃
    var changed = false;
    Object.keys(duelLocks).forEach(function (id) {
      var m = matchById(id);
      if (!m || statusOf(m) !== "open") {
        delete duelLocks[id];
        changed = true;
      }
    });
    if (changed) saveDuelLocks();
  }

  function saveDuelLocks() {
    storageSet(DUEL_LOCKS_KEY, duelLocks).catch(function () { /* 锁丢失最坏情况=可改投注，不阻塞 */ });
  }

  function isDuelLocked(matchId) {
    if (!duelLocks[matchId]) return false;
    var m = matchById(matchId);
    if (!m || statusOf(m) !== "open") {
      delete duelLocks[matchId];
      saveDuelLocks();
      return false;
    }
    return true;
  }

  function lockDuel(matchId) {
    duelLocks[matchId] = Date.now();
    saveDuelLocks();
  }

  // ===== 已发出的约战：链接只在复制那一刻存在，存一份才能「再次复制」；同码重发=幂等
  function loadDuelSent() {
    return storageGet(DUEL_SENT_KEY).then(function (v) {
      var list = typeof v === "string" ? JSON.parse(v) : v;
      duelSent = Array.isArray(list) ? list.filter(function (x) {
        return x && typeof x.m === "string" && typeof x.r === "string";
      }) : [];
      pruneDuelSent();
    }).catch(function () { duelSent = []; });
  }

  function pruneDuelSent() {
    // 比赛截止/数据过期后链接已无法被应战，条目失去意义
    var kept = duelSent.filter(function (x) {
      var m = matchById(x.m);
      return m && statusOf(m) === "open";
    });
    if (kept.length !== duelSent.length) {
      duelSent = kept;
      saveDuelSent();
    }
  }

  function saveDuelSent() {
    storageSet(DUEL_SENT_KEY, duelSent.slice(0, DUEL_SENT_MAX)).catch(function () { /* 丢失最坏情况=无法再复制 */ });
  }

  function findSentInvite(matchId) {
    var hit = null;
    duelSent.forEach(function (x) { if (x.m === matchId) hit = x; });
    return hit;
  }

  function saveSentInvite(rec) {
    duelSent = duelSent.filter(function (x) { return x.m !== rec.m; });
    duelSent.unshift(rec);
    saveDuelSent();
    if (!$("#view-duels").hidden) renderDuelSent();
  }

  // 收到战报（d:2）：发起时不知道谁应战，靠对方回传补全这一侧的记录
  function handleDuelReport(ex) {
    var m = matchById(ex.m);
    if (!m) { toast("战报的比赛不在当前数据范围内"); return; }
    var my = predictionFor(ex.m);
    if (!my) { toast("这场你没有参与竞猜，战报已忽略"); return; }
    var id = duelId(ex.m, "initiator", ex.n + (ex.r ? "+" + ex.r : ""));
    var rec = null;
    DUELS.forEach(function (x) { if (x.id === id) rec = x; });
    if (!rec) {
      rec = {
        id: id, matchId: ex.m, role: "initiator",
        oppNick: ex.n, oppPick: ex.p, oppPickName: pickName(m, ex.p), oppStake: ex.s,
        myPick: my.pick, myPickName: pickName(m, my.pick), myStake: my.stake,
        label: matchLabel(m), startAt: m.startAt, createdAt: Date.now(),
        rc: duelCode(), // 我方随机码：回战报时携带，对面建账同样防覆盖
        status: "pending", settledAt: 0, myProfit: 0
      };
      DUELS.unshift(rec);
    } else {
      rec.oppPick = ex.p;
      rec.oppPickName = pickName(m, ex.p);
      rec.oppStake = ex.s;
    }
    saveDuels();
    if (statusOf(m) === "finished") {
      var done = settleDuels();
      toast("战报已收到 · " + (done.length ? duelToastText(done) : "与 " + ex.n + " 的对决已记录"));
    } else {
      toast("已记录与 " + ex.n + " 的对决 · 等赛果出来自动结算");
    }
    if (!$("#view-profile").hidden) renderProfile();
    if (!$("#view-duels").hidden) renderDuels();
  }

  // 结算：同边平、猜中胜、猜错负；我的投入/盈亏按结算时的真实预测回填
  function settleDuels() {
    var done = [];
    DUELS.forEach(function (d) {
      if (d.status !== "pending") return;
      var m = matchById(d.matchId);
      if (!m || statusOf(m) !== "finished") return;
      var my = predictionFor(d.matchId);
      d.myPick = my ? my.pick : d.myPick;
      d.myPickName = my ? pickName(m, my.pick) : d.myPickName;
      d.myStake = my ? my.stake : d.myStake;
      var w = m.result.winner;
      d.status = d.myPick === d.oppPick ? "drawn" : (d.myPick === w ? "won" : "lost");
      d.myProfit = my ? (my.profit || 0) : 0;
      d.settledAt = Date.now();
      done.push(d);
    });
    if (done.length) saveDuels();
    return done;
  }

  function duelToastText(done) {
    return "对决 " + done.map(function (d) {
      return duelOutcomeText(d.status) + " " + d.oppNick;
    }).join(" · ");
  }

  // 回传链接（d:2）：应战方在应战成立后发「应战回执」，让发起方当场看到对决；
  // 赛后再发就是「战报」（纯社交动作）。锁仓后两时点数据一致，发起方侧处理复用同一个入口。
  function sendDuelReport(d) {
    duelNick().then(function (nick) {
      return copyShareLink({ v: 1, d: 2, m: d.matchId, p: d.myPick, s: d.myStake, n: nick, r: d.rc || duelCode() });
    }).then(function (err) {
      if (!err) {
        toast(d.status === "pending"
          ? "应战已复制 · 发给 " + d.oppNick + "，他就能看到这场对决"
          : "战报链接已复制 · 发给 " + d.oppNick + " 即可让他记下这局");
      } else {
        toast("复制链接失败，当前端不支持");
      }
    });
  }

  function duelStats() {
    var won = 0, lost = 0, drawn = 0, pending = 0;
    var opp = {};
    DUELS.forEach(function (d) {
      if (d.status === "won") won++;
      else if (d.status === "lost") lost++;
      else if (d.status === "drawn") drawn++;
      else pending++;
      opp[d.oppNick] = (opp[d.oppNick] || 0) + 1;
    });
    var topOpp = "";
    Object.keys(opp).forEach(function (k) {
      if (!topOpp || opp[k] > opp[topOpp]) topOpp = k;
    });
    return { won: won, lost: lost, drawn: drawn, pending: pending, opponents: Object.keys(opp).length, topOpp: topOpp };
  }

  function renderDuelBanner() {
    var el = $("#duelBanner");
    if (!el) return;
    var m = duelInvite ? matchById(duelInvite.m) : null;
    if (!duelInvite || !m || statusOf(m) !== "open" || Date.now() >= duelInvite.exp) {
      if (duelInvite && (!m || Date.now() >= duelInvite.exp)) {
        duelInvite = null;
        storageSet(DUEL_INVITE_KEY, "").catch(function () {});
      }
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML =
      '<div class="duel-banner-main">' +
        "<div><b>" + esc(duelInvite.n) + "</b> 约你竞猜这场比赛</div>" +
        '<div class="duel-banner-sub">' + esc(m.teamA.short + " vs " + m.teamB.short) +
        " · 对方押 <b>" + esc(pickName(m, duelInvite.p)) + "</b>" +
        (duelInvite.s > 0 ? " · 投入 " + fmtNum(duelInvite.s) + " 沙粒" : "") + "</div></div>" +
      '<div class="duel-banner-acts">' +
        '<button type="button" class="duel-accept" data-duel-act="accept">去应战</button>' +
        '<button type="button" class="duel-ignore" data-duel-act="ignore">忽略</button></div>';
  }

  function renderDuelSent() {
    var box = $("#duelSentBox");
    if (!box) return;
    pruneDuelSent();
    if (!duelSent.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = '<div class="duel-sent-title">我发出的约战</div>' + duelSent.map(function (x) {
      var m = matchById(x.m);
      var label = m ? matchLabel(m) : (x.label || "比赛");
      var when = x.startAt ? fmtMonthDay(x.startAt) + " " + fmtClock(x.startAt) : "";
      return '<div class="duel-sent-row">' +
        '<span class="duel-sent-label">' + esc(label) + (when ? '<i>' + esc(when) + "</i>" : "") + "</span>" +
        '<button type="button" class="duel-report-btn" data-duel-recopy="' + esc(x.m) + '">复制链接</button></div>';
    }).join("");
  }

  function renderDuels() {
    renderDuelSent();
    ensureDuelAvatars(); // 异步反查对手头像，到了自动重渲染
    var amap = duelAvatarMap || {};
    var s = duelStats();
    $("#duelSummary").innerHTML =
      '<div class="duel-stat win"><b>' + s.won + "</b><span>胜</span></div>" +
      '<div class="duel-stat lose"><b>' + s.lost + "</b><span>负</span></div>" +
      '<div class="duel-stat"><b>' + s.drawn + "</b><span>平</span></div>" +
      '<div class="duel-stat"><b>' + s.pending + "</b><span>待赛果</span></div>";
    if (!DUELS.length) {
      $("#duelList").innerHTML =
        '<div class="empty-state"><strong>还没有对决</strong>竞猜面板点「约战好友」，把链接发给好友就能同场比拼</div>';
      return;
    }
    $("#duelList").innerHTML = DUELS.map(function (d) {
      var profit = d.status === "pending" ? "" :
        '<span class="duel-profit ' + (d.myProfit > 0 ? "pos" : d.myProfit < 0 ? "neg" : "") + '">' +
        (d.myProfit > 0 ? "+" : "") + fmtNum(d.myProfit) + " 沙粒</span>";
      // 回传按钮：已结算=战报（社交）；待赛果只有应战方需要发回执——发起方收到回执才建记录，
      // 记录存在即说明对手已知，无需再发
      var report = "";
      if (d.status !== "pending") {
        report = '<button type="button" class="duel-report-btn" data-duel-report="' + esc(d.id) + '">把战报发给他</button>';
      } else if (d.role === "challenger") {
        report = '<button type="button" class="duel-report-btn" data-duel-report="' + esc(d.id) + '">把应战发给他</button>';
      }
      var rematch = d.status === "lost"
        ? '<button type="button" class="duel-report-btn" data-duel-rematch="' + esc(d.oppNick) + '">再战一场</button>'
        : "";
      return '<div class="duel-card">' +
        '<div class="duel-card-head">' + personAvatar(d.oppNick, amap[d.oppNick]) +
          '<span class="duel-badge ' + d.status + '">' + duelOutcomeText(d.status) +
          '</span><span class="duel-opp">vs ' + esc(d.oppNick) + "</span>" + profit + "</div>" +
        '<div class="duel-match">' + esc(d.label) + "</div>" +
        '<div class="duel-picks">我押 <b>' + esc(d.myPickName || "?") + "</b> " + fmtNum(d.myStake) +
          " 沙粒 · 对方押 <b>" + esc(d.oppPickName || "?") + "</b> " + fmtNum(d.oppStake) + " 沙粒</div>" +
        '<div class="duel-foot"><span>' + fmtMonthDay(d.startAt) + " " + fmtClock(d.startAt) + "</span>" +
          (rematch || report ? '<span class="duel-foot-acts">' + rematch + report + "</span>" : "") + "</div>" +
        "</div>";
    }).join("");
  }

  /* ============================== 启动 ============================== */
  async function boot() {
    var platformReady = await initPlatform();
    await initTheme();
    readLaunchExtra(); // SDK 已加载即可同步读取启动链接里的分享 extra
    // 安全区测量最多等 800ms，避免旧宿主阻塞启动
    await Promise.race([
      setupViewport().catch(function () { return null; }),
      new Promise(function (resolve) { setTimeout(resolve, 800); })
    ]);
    state = await loadState();
    await loadDuels();
    await loadDuelInvite();
    await loadDuelLocks();
    await loadDuelSent();
    loadHbProfile().then(function (hb) {
      if (hb) {
        myNickCache = String(hb.nick || "").slice(0, 12);
        myAvatarCache = hb.avatar || "";
      }
    }).catch(function () { /* 头像/昵称缓存缺省即可 */ });
    var loadedSnapshot = stateSnapshot();
    validateLoadedState();
    persistedSnapshot = stateSnapshot();
    if (persistedSnapshot !== loadedSnapshot) {
      // validate 修正了脏数据：写回本地（不以此刷高 updatedAt，避免压过云端较新记录）
      storageSet(STORAGE_KEY, state);
    }
    maybeRestoreFromCloud(); // 云端较新则异步拉回覆盖，不阻塞首屏
    var events = settlePending();
    var duelDone = settleDuels();
    bindEvents();
    bindHostEvents();
    bindOnboard();
    bindNetGate();
    initHistory();
    initScrollRail();
    initPageLifecycle();
    registerIdentity(); // 确保榜单条目存在，隔离身份在任何宿主上都可读（不依赖 user.getInfo）

    // 数据文件加载失败：给出明确提示，避免白屏
    if (!MATCHES.length) {
      renderBalance();
      $("#openCount").textContent = "赛程数据加载失败，请稍后重试";
      $("#matchList").innerHTML =
        '<div class="empty-state"><strong>赛程数据加载失败</strong>请检查网络后刷新页面，或稍后再试</div>';
      if (isHarmonyOS()) {
        runHarmonyGate();
      } else {
        maybeShowOnboard();
        refreshData();
      }
      scheduleLatePlatformRecovery(platformReady);
      return;
    }

    renderSelectors();
    renderAll();
    renderDuelBanner();
    resolveDeepLink(); // 分享目标在内置窗口内时先定位；运行时数据到达后 applySnapshot 会再试
    resolveVersusLink();
    if (isHarmonyOS()) {
      runHarmonyGate();
    } else {
      maybeShowOnboard();
      refreshData();
    }
    scheduleLatePlatformRecovery(platformReady);

    if (events.length) {
      if (!isHarmonyOS()) syncBoards();
      var total = events.reduce(function (s, e) { return s + e.pred.profit; }, 0);
      var wins = events.filter(function (e) { return e.pred.won; }).length;
      setTimeout(function () {
        toast("已结算 " + events.length + " 场 · 命中 " + wins + " 场 · " +
          (total >= 0 ? "+" : "") + fmtNum(total) + " 沙粒" +
          (duelDone.length ? " · " + duelToastText(duelDone) : ""));
        vibrate("medium");
      }, 500);
    } else if (duelDone.length) {
      setTimeout(function () { toast(duelToastText(duelDone)); }, 500);
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
        vibrate("medium");
      }
    }, 60000);

    // 统一轮询：与采集器 5 分钟更新节奏对齐；maxAge 节流下每轮只花一次 meta 探测，
    // hash 变了才拉整包；限流退避期间跳过。榜单页可见时顺路刷新（宿主读缓存 5 分钟）。
    setInterval(function () {
      if (Date.now() < pollBackoffUntil) return;
      refreshData(false);
      if (!$("#view-board").hidden) renderBoard();
    }, POLL_INTERVAL);

    // 启动完成：云端恢复的达标余额此后可正常触发庆祝页
    bootDone = true;
    checkHonorPopup();
  }

  boot();
})();
