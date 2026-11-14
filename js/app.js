import matchesData from "../data/matches-embedded.json";
import { Cloud, Sync } from "./cloud.js";
import { normalizeCollection, onBet, onSettle, mergeCollection, collectionSummary, teamHistory, pickedTeamOf, mainTeamLevel, MAIN_LEVEL_THRESHOLDS } from "./collection.js";
import { ACHV_DEFS, normalizeAchv, mergeAchv, evalAchievements, achvById, achvTitle } from "./achv.js";
import { IDENTITY_EXCHANGE_URL, IDENTITY_EXCHANGE_FALLBACK } from "./config.js";
import { initPlatform, whenPlatformReady, setupViewport, setNavigationBarStyle, storageGet, storageSet, closeMiniProgram, getRuntimeMode, getDiagnostics, onHostEvent, vibrate, setClipboard, reloadPage, uiShowLoading, uiHideLoading, showShareMenu, copyShareLink, getLaunchExtra, authLogin, getAccountState, networkGetJson, saveFileBytes, openAppPage, getFollowStatus, requestFollowAuthor } from "./platform.js";
import { isRuntimeEnabled, loadCachedSnapshot, fetchRemoteSnapshot, fetchLiveSnapshot } from "./data-source.js";
import { fitDuelExtra } from "./duel-extra.mjs";
import { PICKEM_BUCKETS, PICKEM_AUTO_BUCKETS, PICKEM_SWISS_TEAMS, PICKEM_DEADLINE_MS, PICKEM_COINS, coinKeyForTier, PICKEM_PLACEMENT_TEAMS, normalizePickemData, normalizePickemState, normalizeStructures, stageAllDone, stageOpenForPicks, swissPickDeadline, pickableSeriesMatches, swissPicksComplete, recordsPicksComplete, recordBuckets, placementPicksComplete, scorePhase, settleRewards, mergePickem, mergePickemCoins, buildAutoEvents } from "./pickem.js";

(function () {
  "use strict";

  /* ============================== 配置 ============================== */
  var DATA = matchesData;
  var MATCHES = (DATA.matches || []).slice();
  // 队标：数据里只存相对路径（队名 → 路径），换自建 OSS 镜像时只改这一行
  var TEAM_LOGOS = DATA.teams || {};
  // 队伍主题色（1.2.11）：{队名: [c1, c2, darkText]}——构建期从队标提取，runtime/内嵌切片携带
  var TEAM_COLORS = DATA.teamColors || {};
  // 战队选手阵容（1.3.2）：{"game:name": [{n 职业ID, r 位置, l 国籍}, ...]}——fetch-team-rosters 管线切片（数组形状）
  var ROSTERS = DATA.rosters || {};
  // Pick'Em 赛事聚合（1.3 实验功能）：fetch-pickem 管线切片（内嵌 + 运行时合并，只增不减）
  var PICKEM = normalizePickemData(DATA.pickem).events;
  // 赛事结构（2026-11-10）：官方参赛名单/小组积分（fetch-tournament-structures 管线切片）——
  // auto 事件结构化竞猜与桶体积分条消费；键 game|tournament|stage
  var STRUCTURES = normalizeStructures(DATA.structures);
  var pickemEventId = ""; // 当前查看的赛事（多赛事时顶部 chip 切换）
  // 队标基址（1.3.12 起改为打包内嵌同源资源）：0.9.6 deploy 构建的 CSP img-src 实测未包含
  // network 批准的 OSS 域（服务端 network_policy entries 为空）——远程队标全被拦回退首字母。
  // 修复=tools/pack-team-logos.mjs（prebuild 钩子）把 OSS 原图压 96px WebP 打包进产物
  // public/logos/（~2.5MiB，724 张）——同源走 img-src 'self' 天然放行，加载更快且离线可渲染；
  // 文件名沿用 teams 映射路径（内容为 WebP 字节，浏览器按内容嗅探渲染）。
  // OSS 远程镜像（tools/mirror-team-logos.mjs）保留：作为打包源 + 未来恢复远程高清版的备胎。
  var LOGO_BASE = "logos/";
  // 选手位置徽章（PandaScore role 原文 → 中文；仅 LoL/Dota2/OW 有值）——阵容行与选手卡同源
  var ROLE_LABELS = { top: "上单", jungle: "打野", mid: "中单", adc: "ADC", support: "辅助", "midlaner": "中单", "adc/upport": "ADC", "upport": "辅助", "jungler": "打野", carry: "核心", "offlane": "三号位", solo: "中单" };
  var matchIndex = new Map();
  var matchMidIndex = new Map(); // PandaScore mid → match 对象引用（live.json 补丁定位，2026-11-11）
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
  var APP_VERSION = "1.3.18";
  /* 「去围观」映射：游戏 → 小黑盒游戏库 appid。跳转走 navigation.openAppPage（免权限声明）。
   * 关键认知（1.2.12 修正）：appid 不必 ⊆ bindAppIds——绑定只收 9000 段，围观只要库里有详情页。
   * 此前「刀塔2/绝地求生/守望/火箭联盟无法跳转」的结论错在把绑定池当成了详情页存在性；
   * cs2 特例：900196328 是国服「Counter-Strike: GO」条目（版号名），真实 CS2 页 = Steam 730。
   * 全部 appid 均经 remote games search 核对名称（test:cloud 场景 M 有逐对防回归）。 */
  var WATCH_GAME_APPIDS = {
    cs2: "730",           // CS2（Counter-Strike 2；非国服 CS:GO 条目）
    dota2: "570",         // 刀塔2
    lol: "900000045",     // 英雄联盟（腾讯国服）
    valorant: "900006125", // 无畏契约（腾讯国服）
    "starcraft-2": "900168298", // 星际争霸2
    r6: "900217539",      // 彩虹六号：攻势（国服围攻；如需国际围攻页换 359550）
    pubg: "578080",       // 绝地求生
    ow: "2357570",        // 守望先锋
    rl: "252950",         // 火箭联盟
    kpl: "99900051",      // 王者荣耀
    mlbb: "99928389"      // 无尽对决
  };
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
  var state = { bankroll: START_BALANCE, predictions: [], digs: 0, gods: 0, bankrupts: 0, godOffered: false, bankruptOffered: false, lastCeremonyAt: 0, collection: {}, achv: {}, minBankroll: START_BALANCE, title: undefined, mainTeam: undefined, mainLevels: {}, pickem: {}, pickemCoins: { c: 0, s: 0, g: 0, d: 0 } };
  var currentGame = "all";
  var currentTournament = "__all__";
  var currentStatus = "all";
  var homeQuery = ""; // 主页搜索词（1.3.2）：列表 + 状态 tab + 选择器计数三处同源
  var homeSearchTimer = null; // 独立防抖：不与赛程表的 searchTimer 串用
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

  // 榜单专用大数缩写（1.3.1）：≥1亿 → x.x亿、≥100万 → xxx.x万，其余全量——
  // 防止「赚 999,999,999 沙粒」这类长数字把昵称列挤没
  // 2026-11-12 夜间自查增补：线上真实榜单存在异常巨大的 extra.second（最高 ~3.9e21，
  // 显示成 15+ 字符的「39311868281807.2亿」再次挤压版面）——补 万亿/亿亿/万亿亿 档位，
  // 任何输入 ≤7 位数字 + 单位；不改 <1e12 的既有显示。
  function fmtCompact(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n >= 1e20) return (Math.round(n / 1e19) / 10) + "万亿亿";
    if (n >= 1e16) return (Math.round(n / 1e15) / 10) + "亿亿";
    if (n >= 1e12) return (Math.round(n / 1e11) / 10) + "万亿";
    if (n >= 1e8) return (Math.round(n / 1e7) / 10) + "亿";
    if (n >= 1e6) return (Math.round(n / 1e5) / 10) + "万";
    return fmtNum(n);
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
    "#gamePopover", "#tournamentPopover", "#schedGamePopover", "#schedTournamentPopover", "#pickemGamePopover", "#pickemEvPopover", "#duelDialogBackdrop", "#duelHelpBackdrop",
    "#pickemSheet", "#playerSheet"
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
    var base = { bankroll: START_BALANCE, predictions: [], digs: 0, updatedAt: 0, gods: 0, bankrupts: 0, godOffered: false, bankruptOffered: false, lastCeremonyAt: 0, collection: {}, achv: {}, minBankroll: START_BALANCE, title: undefined, mainTeam: undefined, mainLevels: {}, pickem: {}, pickemCoins: { c: 0, s: 0, g: 0, d: 0 } };
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
        collection: normalizeCollection(parsed.collection),
        achv: normalizeAchv(parsed.achv),
        minBankroll: typeof parsed.minBankroll === "number" && isFinite(parsed.minBankroll) ? parsed.minBankroll : START_BALANCE,
        title: typeof parsed.title === "string" ? parsed.title : undefined,
        mainTeam: typeof parsed.mainTeam === "string" ? parsed.mainTeam : undefined, // 三态：undefined=从未设置、""=已取消
        mainLevels: normalizeAchv(parsed.mainLevels), // {键: 累计押过场次}——复用同构校验（正数、取整、上限）
        pickem: normalizePickemState(parsed.pickem), // Pick'Em 竞猜记录（键 eventId:stageId）
        pickemCoins: mergePickemCoins({ c: 0, s: 0, g: 0, d: 0 }, parsed.pickemCoins), // Pick'Em 硬币（1.3.5，逐键 max）
        updatedAt: typeof parsed.updatedAt === "number" && isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
      };
    } catch (e) {
      return base;
    }
  }

  /* 战绩内容快照：只在内容真正变化时写存储/推云端，避免启动时把本地时间戳刷成最新 */
  var persistedSnapshot = "";
  var achvChecking = false; // 成就检测重入防护（checkAchievements 在 saveState 内执行）

  function stateSnapshot() {
    return JSON.stringify([state.bankroll, state.digs, state.predictions, state.gods, state.bankrupts, state.godOffered, state.bankruptOffered, state.lastCeremonyAt, state.collection, state.achv, state.minBankroll, state.title, state.mainTeam, state.mainLevels, state.pickem, state.pickemCoins]);
  }

  function saveState() {
    // 历史最低余额：saveState 是唯一写闸，余额一切变化必经此处，一处更新全覆盖
    if (state.bankroll < state.minBankroll) state.minBankroll = state.bankroll;
    // 成就检测挂在写闸内（幂等锁存，重入由 achvChecking 防护）——任何状态变化路径都不会漏检
    if (!achvChecking) {
      achvChecking = true;
      try { checkAchievements(); } finally { achvChecking = false; }
    }
    var snap = stateSnapshot();
    if (snap === persistedSnapshot) return;
    persistedSnapshot = snap;
    state.updatedAt = Date.now();
    storageSet(STORAGE_KEY, state);
    scheduleCloudSync();
  }

  /* ---------- 主队等级计数（1.2.12：与 collection 口径镜像——新押 +1、改选迁移 -1/+1；
     只记「设为主队过的队伍」（mainLevels 有键的），不随图鉴 150 队 LRU 淘汰丢失 ---------- */
  function trackMainLevelBet(match, pick, prevPick) {
    var picked = pickedTeamOf(match, pick);
    if (picked && state.mainLevels[picked.key] !== undefined) {
      state.mainLevels[picked.key] += 1;
    }
    if (prevPick && prevPick !== pick) {
      var old = pickedTeamOf(match, prevPick);
      if (old && state.mainLevels[old.key] !== undefined) {
        state.mainLevels[old.key] = Math.max(0, state.mainLevels[old.key] - 1);
      }
    }
  }

  /* ---------- 成就殿堂（1.2.10；检测挂在 saveState 写闸内，任何状态变化路径都会经过） ---------- */
  function buildAchvSnapshot() {
    var settled = settledInOrder();
    var wins = 0, curWin = 0, bestWin = 0, lossRun = 0, lossBest = 0;
    for (var i = 0; i < settled.length; i++) {
      if (settled[i].won) {
        wins += 1;
        curWin += 1;
        if (curWin > bestWin) bestWin = curWin;
        lossRun = 0;
      } else {
        lossRun += 1;
        if (lossRun > lossBest) lossBest = lossRun;
        curWin = 0;
      }
    }
    var maxStake = 0, nightBets = 0;
    for (var j = 0; j < state.predictions.length; j++) {
      var p = state.predictions[j];
      if (p.stake > maxStake) maxStake = p.stake;
      var h = new Date(p.placedAt || 0).getHours();
      if (h >= 2 && h < 5) nightBets += 1;
    }
    var codex = collectionSummary(state.collection);
    var ds = duelStats();
    return {
      bets: state.predictions.length,
      settled: settled.length,
      wins: wins,
      bestWinStreak: bestWin,
      bankroll: state.bankroll,
      minBankroll: state.minBankroll,
      maxStake: maxStake,
      nightBets: nightBets,
      lossStreakBest: lossBest,
      codexTeams: codex.teams,
      codexFollowBest: codex.bestStreak,
      duelsTotal: DUELS.length,
      duelsWon: ds.won,
      gods: state.gods || 0,
      bankrupts: state.bankrupts || 0,
      pickemSubmitted: pickemHasAnyPicks(),   // Pick'Em：提交过竞猜
      pickemCoins: state.pickemCoins || { c: 0, s: 0, g: 0, d: 0 } // Pick'Em 硬币（1.3.5：获得首枚银/金/钻石币成就）
    };
  }

  function checkAchievements() {
    var newly = evalAchievements(buildAchvSnapshot(), state.achv);
    if (!newly.length) return;
    newly.forEach(function (id) { state.achv[id] = Date.now(); });
    var def = achvById(newly[newly.length - 1]);
    toast("🏆 成就解锁：" + (def ? def.name : newly[newly.length - 1]));
    if (!$("#view-profile").hidden) renderProfile();
  }

  /* ---------- 主队与主题换肤（1.2.11：色值来自数据切片，纯 CSS 变量，零网络） ---------- */
  function mainTeamName() {
    var k = state.mainTeam || "";
    var sep = k.indexOf(":");
    return sep > 0 ? k.slice(sep + 1) : "";
  }

  /* ---------- 队色衍生小工具（1.2.15 主题色全面扩散） ---------- */
  function hexToRgb(hex) {
    var m = String(hex || "").match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbStr(hex) {
    var c = hexToRgb(hex);
    return c ? c.r + ", " + c.g + ", " + c.b : "";
  }
  function mixHex(hex, other, ratio) {
    var a = hexToRgb(hex), b = hexToRgb(other);
    if (!a || !b) return "";
    var ch = function (x, y) { return Math.round(x + (y - x) * ratio); };
    return "#" + [ch(a.r, b.r), ch(a.g, b.g), ch(a.b, b.b)]
      .map(function (v) { return ("0" + v.toString(16)).slice(-2); }).join("");
  }

  /* 设了主队时要内联覆盖的全部变量（取消主队时逐一移除，回落 CSS 默认值） */
  var TEAM_THEME_VARS = [
    "--accent", "--accent-strong", "--accent-text",
    "--accent-rgb", "--accent-hi", "--accent-hi-mid", "--accent-glow"
  ];

  function applyTeamTheme() {
    var root = document.documentElement;
    var colors = state.mainTeam ? TEAM_COLORS[mainTeamName()] : null;
    var rgb = colors ? rgbStr(colors[0]) : "";
    if (colors && colors[0] && colors[1] && rgb) {
      root.dataset.teamTheme = "1";
      root.style.setProperty("--accent", colors[0]);
      root.style.setProperty("--accent-strong", colors[1]);
      // 主色亮（白/黄系队标）→ 配深色文字，保证 accent 底上的可读性
      root.style.setProperty("--accent-text", colors[2] ? "#1a0e04" : "#ffffff");
      // 衍生色：CSS 端用 rgba(var(--accent-rgb), α) 引用（α 逐处保留），
      // 渐变起始/光晕由 c1 与白混色派生，默认（无主队）外观由 :root 变量保证与旧版一致
      root.style.setProperty("--accent-rgb", rgb);
      root.style.setProperty("--accent-hi", mixHex(colors[0], "#ffffff", .55) || colors[0]);
      root.style.setProperty("--accent-hi-mid", mixHex(colors[0], "#ffffff", .3) || colors[0]);
      root.style.setProperty("--accent-glow", "rgba(" + rgb + ", .28)");
    } else {
      delete root.dataset.teamTheme;
      TEAM_THEME_VARS.forEach(function (v) { root.style.removeProperty(v); });
    }
  }

  function toggleMainTeam() {
    if (!currentTeamKey) return;
    var wasMain = state.mainTeam === currentTeamKey;
    state.mainTeam = wasMain ? "" : currentTeamKey;
    var lvText = "";
    if (!wasMain) {
      // 播种：以图鉴累计押过场次起算——独立于图鉴 150 队 LRU，等级永不因换主队清零
      var seedBets = (state.collection[currentTeamKey] && state.collection[currentTeamKey].b) || 0;
      var prev = state.mainLevels[currentTeamKey] || 0;
      if (Math.max(prev, seedBets) >= 1) state.mainLevels[currentTeamKey] = Math.max(prev, seedBets);
      var seededLv = mainTeamLevel(state.mainLevels[currentTeamKey] || 0);
      lvText = seededLv >= 1 ? " · Lv." + seededLv : " · 跟它竞猜 1 场即达 Lv.1";
    }
    saveState();
    applyTeamTheme();
    renderTeamPage();
    if (!$("#view-profile").hidden) renderProfile();
    if (!$("#view-codex").hidden) renderCodex(); // 主队置顶/角标随设随变
    syncBoards(); // 主队/等级变化经榜单门控自动 second+1（低频动作），榜上小队标与 Lv 随之更新
    toast(wasMain ? "已取消主队" : "主队已设 · 主题色已换" + lvText);
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
    var localCodex = state.collection;
    var localAchv = state.achv, localMinBankroll = state.minBankroll;
    var localMainLevels = state.mainLevels;
    var localPickem = state.pickem;
    var localPickemCoins = state.pickemCoins;
    state = {
      bankroll: typeof s.bankroll === "number" && isFinite(s.bankroll) ? s.bankroll : START_BALANCE,
      predictions: Array.isArray(s.predictions) ? s.predictions : [],
      digs: typeof s.digs === "number" && isFinite(s.digs) ? s.digs : 0,
      gods: Math.max(localGods, typeof s.gods === "number" && s.gods > 0 ? s.gods : 0),
      bankrupts: Math.max(localBankrupts, typeof s.bankrupts === "number" && s.bankrupts > 0 ? s.bankrupts : 0),
      godOffered: state.godOffered === true || s.godOffered === true,
      bankruptOffered: state.bankruptOffered === true || s.bankruptOffered === true,
      lastCeremonyAt: Math.max(state.lastCeremonyAt || 0, typeof s.lastCeremonyAt === "number" ? s.lastCeremonyAt : 0),
      collection: mergeCollection(localCodex, s.collection),
      achv: mergeAchv(localAchv, s.achv),
      minBankroll: Math.min(localMinBankroll, typeof s.minBankroll === "number" && isFinite(s.minBankroll) ? s.minBankroll : localMinBankroll),
      title: typeof s.title === "string" ? s.title : state.title,
      mainTeam: typeof s.mainTeam === "string" ? s.mainTeam : state.mainTeam,
      mainLevels: mergeAchv(localMainLevels, s.mainLevels),
      pickem: mergePickem(localPickem, s.pickem), // Pick'Em：pickedAt 较新者胜、settled 取 OR（js/pickem.js#mergePickem）
      pickemCoins: mergePickemCoins(localPickemCoins, s.pickemCoins), // 硬币逐键 max（只增不减）
      updatedAt: rec.updatedAt
    };
    validateLoadedState();
    persistedSnapshot = stateSnapshot();
    storageSet(STORAGE_KEY, state);
    var events = settlePending();
    var pkDone = settlePickem();
    renderBalance();
    renderAll();
    if (!$("#view-profile").hidden) renderProfile();
    if (!$("#view-board").hidden) renderBoard();
    toast("已从云端同步战绩");
    if (events.length) syncBoards();
  }

  function maybeRestoreFromCloud() {
    Sync.read().then(function (rec) { // read 内含调试环境门禁（js/cloud.js isDebugRuntime）
      applyCloudRecord(rec);
    }).catch(function (e) { /* 读取失败保持本地 */ });
  }

  function rebuildMatchIndex() {
    matchIndex = new Map();
    matchMidIndex = new Map();
    MATCHES.forEach(function (m) {
      if (m && m.id) matchIndex.set(m.id, m);
      if (m && m.mid > 0) matchMidIndex.set(Math.floor(m.mid), m); // live.json 补丁按 mid 定位（2026-11-11）
    });
  }

  function matchByMid(mid) {
    return matchMidIndex.get(Math.floor(mid)) || null;
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

  /** 解析局进度串 "A1584,A1508" → [{w:"A",t:1584},...]（采集端编码见 pandascore.mjs toRaw） */
  function parseGameLog(str) {
    if (typeof str !== "string" || !str) return [];
    return str.split(",").map(function (seg) {
      var w = seg.charAt(0);
      var t = parseInt(seg.slice(1), 10);
      if (w !== "A" && w !== "B") return null;
      return { w: w, t: isFinite(t) && t > 0 ? t : 0 };
    }).filter(Boolean);
  }

  function statusOf(m) {
    if (m.result && (m.result.winner === "A" || m.result.winner === "B")) {
      return "finished";
    }
    // 官方 running 信号优先（2026-11-10 深度接入）：比「开赛时间+BO 估算时长」可靠——
    // 超时未结束是 awaiting 而非 live 的误判、以及「预计时长内其实已结束」的空窗都被它纠正
    if (m.lv === true) return "live";
    var now = Date.now();
    var start = new Date(m.startAt).getTime();
    if (now < start - 3600000) return "open";      // 开赛前 1 小时停止竞猜
    if (now < start) return "locked";               // 已截止，尚未开赛
    if (now < start + matchDurationMs(m)) return "live"; // 预计比赛进行中（无 lv 信号时的估算兜底）
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

  // 打包文件名（1.3.12）：队标资源名 = 战队路径的 djb2 8hex 散列 + .webp——与
  // tools/pack-team-logos.mjs 同算法（deploy 产物相对路径上限 39 字节，原 OSS 名超限）；
  // 内容为 96px WebP（浏览器按内容嗅探渲染，扩展名仅占位）
  function logoPackName(path2) {
    var h = 5381;
    for (var i = 0; i < path2.length; i++) { h = ((h << 5) + h + path2.charCodeAt(i)) >>> 0; }
    return h.toString(16).padStart(8, "0") + ".webp";
  }

  function logoUrl(team) {
    if (!team) return "";
    var path = TEAM_LOGOS[team.name] || team.logo || "";
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) {
      // 遗留存量：前缀剥离修复前的绝对 URL（team/player 图同域名同路径结构）——
      // 剥出后缀走打包资源；外域原样返回（被 CSP 拦时走首字兜底）
      var legacy = path.match(/^https?:\/\/(?:cdn-api|cdn)\.pandascore\.co\/images\/(?:team|player)\/image\/(.+)$/i);
      return legacy ? LOGO_BASE + logoPackName(legacy[1]) : path;
    }
    return LOGO_BASE + logoPackName(path);
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
      state.collection = onSettle(state.collection, m, p.pick, won); // 图鉴胜负（p.settled 门控保证只计一次）
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
    var q = homeQuery.trim().toLowerCase();
    return MATCHES.filter(function (m) {
      if (!inHomeWindow(m)) return false;
      if (currentGame !== "all" && m.game !== currentGame) return false;
      if (!matchQuery(m, q)) return false; // 主页搜索（1.3.2）
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
    var q = homeQuery.trim().toLowerCase();
    var counts = { all: 0, live: 0, open: 0, locked: 0, awaiting: 0, finished: 0 };
    MATCHES.forEach(function (m) {
      if (!inHomeWindow(m)) return;
      if (currentGame !== "all" && m.game !== currentGame) return;
      if (!matchQuery(m, q)) return; // 搜索词下状态 tab 计数与列表同源（1.3.2）
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

    // 计数与列表同口径（homeListMatches）：已结束且未预测的场次不在列表里，也不能算进 tile 计数
    var windowMatches = homeListMatches();
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

  // 主页列表口径（1.3.2）：窗口内 + 剔除「已结束且（未预测 或 超过 1 天）」。
  // 选择器计数必须走这里——否则会出现「全部赛事/游戏里显示 N 场、列表 0 张卡」（用户反馈）。
  // matchesFiltered 的逐条过滤与此保持一致（改口径时两处一起改）。
  function homeListMatches() {
    var dayAgo = Date.now() - 86400000;
    var q = homeQuery.trim().toLowerCase();
    return MATCHES.filter(function (m) {
      if (!inHomeWindow(m)) return false;
      if (!matchQuery(m, q)) return false; // 搜索词下选择器计数与列表同源（1.3.2）
      var st = statusOf(m);
      if (st === "finished" && (!predictionFor(m.id) || new Date(m.startAt).getTime() < dayAgo)) return false;
      return true;
    });
  }

  function tournamentBase() {
    var list = homeListMatches();
    return list.filter(function (m) {
      return currentGame === "all" || m.game === currentGame;
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

    // 主页「IEM 作业」公测直入口（1.3.10）：scoped 赛事已结束/不存在时隐藏按钮（1.3.14 随作业页
    // 已结束过滤），避免入口点进去是「暂无可竞猜的赛事」空页；scoped 赛事重新可看时自动回归
    var scopedWrap = $("#homePickemBtn");
    scopedWrap = scopedWrap ? scopedWrap.closest(".selector") : null;
    if (scopedWrap) {
      var scopedEv = pickemEventById(PICKEM_SCOPED_EVENT);
      scopedWrap.hidden = !(scopedEv && scopedEv.status !== "done");
    }

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
      html = homeQuery.trim()
        ? '<div class="empty-state"><strong>没有匹配的赛事</strong>换个关键词，或清空搜索试试</div>'
        : '<div class="empty-state"><strong>这里还没有赛事</strong>切换其他游戏分类看看，或等待赛程更新</div>';
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
      } else if (st === "live" && m.lsc) {
        // 实时比分（2026-11-10）：官方 running 场次的当前比分；无实时信号保持原留白
        var liveParts = String(m.lsc).split(":");
        right = '<span class="team-score is-live">' + esc((liveParts[side === "A" ? 0 : 1] || "").trim() || "-") + "</span>";
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
        // 非 open 状态的队伍行点击进战队资料页（open 行是选边按钮，不动）
        rows += '<div class="' + cls.join(" ") + '" data-team-key="' + esc(m.game + ":" + team.name) + '">' + inner + "</div>";
      }
    });

    var statusText = st === "open" ? "可竞猜"
      : st === "locked" ? "已截止"
        : st === "live" ? "正在比赛"
          : st === "awaiting" ? "待赛果"
            : "已结算";
    var bottom = '<span class="status-chip ' + st + '">' + statusText + "</span>";
    // 「去围观」只在进行中的卡片上（看比赛的欲望发生在比赛时，不在可竞猜时）；无映射的游戏不给入口
    if (st === "live" && WATCH_GAME_APPIDS[m.game]) {
      bottom += '<button type="button" class="watch-chip" data-watch="' + esc(m.game) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M10 9.5l5 3-5 3z"/></svg>' +
        "去围观</button>";
    }
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
      }, nick, avatar, state.title,
      // extra.mt 必须是纯队名（看榜端按名字查队标映射）——不能传图鉴键 "game:名字"，
      // 否则队标查找落空回退首字，还会渲染出 "CS2T" 这类键名截断（1.2.13 用户实测抓到）
      state.mainTeam === undefined ? undefined : state.mainTeam === "" ? "" : mainTeamName(),
      state.mainTeam === undefined ? undefined : mainTeamLevel(state.mainLevels[state.mainTeam] || 0));
      // mainTeam 传参：undefined（从未设置）沿用榜上旧值；""（取消过主队）权威清空
      // mtLevel 传参：主队等级 0-8（0=清空榜上 Lv；undefined=从未设置主队）
      // 魔神殿总榜已下线（1.3.5，榜位复用为硬币排行榜）：不再提交封神/破产荣誉
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
    $("#cerQuote").value = ""; // 1.3.5 起感言不再上传（魔神殿语录随页面下线），输入框已隐藏，读取防御性保留
    if (god) state.gods += 1; else state.bankrupts += 1;
    state.bankroll = START_BALANCE;
    state.lastCeremonyAt = Date.now();
    if (god) state.godOffered = false; else state.bankruptOffered = false;
    saveState();
    closeCeremony();
    renderAll();
    renderProfile();
    syncBoards();
    vibrate("medium");
    toast((god ? "封神！" : "已宣布破产：") + "沙粒重置 10,000");
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
      hitRate: settled.length ? Math.round((wins / settled.length) * 100) + "%" : "--",
      streak: collectionSummary(state.collection).bestStreak,
      teams: collectionSummary(state.collection).teams
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

    // 快捷行摘要（图鉴内容已升级为二级页，这里只刷数字）
    var codexQuick = collectionSummary(state.collection);
    $("#quickCodexSub").textContent = codexQuick.teams + " 队 · " + codexQuick.bestStreak + " 连";

    // 转生荣誉与本轮盈亏（上次封神/破产以来的已结算净变化，历史区保持累计）
    $("#profileGods").textContent = state.gods || 0;
    $("#profileBankrupts").textContent = state.bankrupts || 0;
    $("#profileTitle").textContent = state.title ? (achvTitle(state.title) || "未知称号") : "未装备";

    // 余额卡右侧主队块（1.2.13）：队标 + 主队/等级，点击进资料页
    var mtBtn = $("#profileMainTeam");
    if (state.mainTeam) {
      var mtName = mainTeamName();
      var mtLv = mainTeamLevel(state.mainLevels[state.mainTeam] || 0);
      mtBtn.hidden = false;
      mtBtn.innerHTML =
        avatarHTML({ name: mtName }) +
        '<span class="balance-team-main">' +
          '<span class="balance-team-lv">❤ 主队' + (mtLv >= 1 ? " · Lv." + mtLv : "") + "</span>" +
          '<span class="balance-team-name">' + esc(mtName) + "</span>" +
        "</span>";
    } else {
      mtBtn.hidden = true;
    }
    var achvCount = 0;
    Object.keys(state.achv || {}).forEach(function (k) { if (state.achv[k]) achvCount++; });
    $("#achvEntrySub").textContent = "已解锁 " + achvCount + " / " + ACHV_DEFS.length;
    var ds = duelStats();
    $("#duelEntrySub").textContent = DUELS.length
      ? ds.won + " 胜 " + ds.lost + " 负" + (ds.drawn ? " " + ds.drawn + " 平" : "")
      : "还没有对决";
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

    // 滑出数据窗口的比赛在「全部竞猜记录」页可见（1.2.15），这里只渲染窗口内条目
    var html = settled
      .slice()
      .sort(function (a, b) { return (b.settledAt || 0) - (a.settledAt || 0); })
      .filter(function (p) { return matchById(p.matchId); })
      .map(historyRowHTML)
      .join("");

    listEl.innerHTML = html || '<div class="empty-state"><strong>还没有已结算的预测</strong>去「赛事」页挑一场比赛试试手气</div>';
  }

  /* ============================== 全部竞猜记录（1.2.15） ============================== */
  // 我的页列表只渲染 matchById 命中的条目——比赛滑出数据窗口后记录被静默丢弃、
  // 未结算记录全项目无处可看。本页展示全部：找不到的比赛用下注时快照（n1/n2/tn）降级展示。
  function historyStatusText(m) {
    var st = statusOf(m);
    return st === "open" ? "可竞猜"
      : st === "locked" ? "已截止"
        : st === "live" ? "正在比赛"
          : "待赛果";
  }

  // 单条记录行：已结算（有比赛=完整展示，无比赛=归档降级）与待结算共用
  function historyRowHTML(p) {
    var m = matchById(p.matchId);
    var pending = !p.settled;
    var pickName = m ? (p.pick === "A" ? m.teamA.name : m.teamB.name)
      : (p.pick === "A" ? p.n1 : p.n2) || (p.pick === "A" ? "主队" : "客队");
    var title, sub, amountHTML;
    if (m) {
      title = esc(m.teamA.short) + " vs " + esc(m.teamB.short) + (pending ? "" : " · " + esc(m.result.score));
      sub = esc(m.tournament) + " · 预测 " + esc(pickName) + " · 投入 " + fmtNum(p.stake) + "沙粒";
      amountHTML = pending
        ? '<span class="history-amount pending">' + historyStatusText(m) + "</span>"
        : '<span class="history-amount ' + (p.won ? "won" : "lost") + '">' +
            (p.profit > 0 ? "+" : "") + fmtNum(p.profit) + "沙粒" +
          "</span>";
    } else {
      title = (p.n1 && p.n2 ? esc(p.n1) + " vs " + esc(p.n2) + " · " : "") + "比赛已归档";
      sub = (p.tn ? esc(p.tn) + " · " : "") + "预测 " + esc(pickName) + " · 投入 " + fmtNum(p.stake) + "沙粒";
      amountHTML = '<span class="history-amount ' + (pending ? "pending" : p.won ? "won" : "lost") + '">' +
        (pending ? "已归档" : (p.profit > 0 ? "+" : "") + fmtNum(p.profit) + "沙粒") + "</span>";
    }
    var badge = pending
      ? '<span class="history-badge pending">…</span>'
      : '<span class="history-badge ' + (p.won ? "won" : "lost") + '">' + (p.won ? "W" : "L") + "</span>";
    // 分享按钮只在比赛仍在窗口内时可用（分享卡需要比赛数据）
    var shareBtn = m && !pending
      ? '<button type="button" class="history-share" data-share="' + esc(p.matchId) + '" aria-label="分享这场竞猜">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/></svg>' +
        "</button>"
      : "";
    return (
      '<div class="history-item' + (pending ? " is-pending" : "") + '">' +
        badge +
        '<span class="history-main">' +
          '<span class="history-title">' + title + "</span>" +
          '<span class="history-sub">' + sub + "</span>" +
        "</span>" +
        amountHTML +
        shareBtn +
      "</div>"
    );
  }

  function renderHistoryFull() {
    var pending = state.predictions.filter(function (p) { return !p.settled; })
      .sort(function (a, b) { return (b.placedAt || 0) - (a.placedAt || 0); });
    var settled = state.predictions.filter(function (p) { return p.settled; })
      .sort(function (a, b) { return (b.settledAt || 0) - (a.settledAt || 0); });
    $("#historyTotalSub").textContent = "共 " + state.predictions.length + " 条 · 待赛果 " + pending.length;
    $("#historyPendingGroup").hidden = !pending.length;
    $("#historyPendingList").innerHTML = pending.map(historyRowHTML).join("");
    $("#historySettledList").innerHTML = settled.length
      ? settled.map(historyRowHTML).join("")
      : '<div class="empty-state"><strong>还没有已结算的预测</strong>去「赛事」页挑一场比赛试试手气</div>';
  }

  /* ============================== 比赛详情（1.2.16，赛程表行点击进入） ============================== */
  var matchDetailId = "";

  function detailStatusText(st) {
    return st === "open" ? "可竞猜"
      : st === "locked" ? "已截止"
        : st === "live" ? "正在比赛"
          : st === "awaiting" ? "待赛果"
            : "已结算";
  }

  // 队伍赛区：PandaScore location 是两位国家码（kr/us，小写），大写展示；manual 的中文赛区名原样
  function regionLabel(t) {
    var r = t && t.region ? String(t.region) : "";
    return /^[a-z]{2}$/.test(r) ? r.toUpperCase() : r;
  }

  function matchDetailSide(m, side, finished) {
    var t = side === "A" ? m.teamA : m.teamB;
    var won = finished && m.result.winner === side;
    var cls = finished ? (won ? " is-winner" : " is-loser") : "";
    var sub = t.short ? esc(t.short) : "";
    if (regionLabel(t)) sub += (sub ? " · " : "") + esc(regionLabel(t));
    return (
      '<div class="md-side' + cls + '">' +
        avatarHTML(t) +
        '<b class="md-side-name">' + esc(t.name) + "</b>" +
        (sub ? '<span class="md-side-sub">' + sub + "</span>" : "") +
      "</div>"
    );
  }

  function matchDetailInfoRow(label, valueHTML) {
    if (valueHTML === null || valueHTML === undefined || valueHTML === "") return "";
    return '<div class="md-info-row"><span class="md-info-label">' + label + '</span><span class="md-info-value">' + valueHTML + "</span></div>";
  }

  function renderMatchDetail() {
    var body = $("#matchDetailBody");
    var m = matchById(matchDetailId);
    if (!m) {
      body.innerHTML = '<div class="empty-state"><strong>比赛已归档</strong>该场比赛不在当前数据窗口内，去「赛程表」看近期赛事</div>';
      return;
    }
    var st = statusOf(m);
    var finished = st === "finished";
    var pred = predictionFor(m.id);
    var locked = isDuelLocked(m.id);
    var durMs = matchDurationMs(m);
    var startTs = new Date(m.startAt).getTime();

    // 对阵 hero：胜方高亮 / 未开赛显示状态与时间
    var center;
    if (finished) {
      var sa = String(m.result.score).split(":")[0];
      var sb = String(m.result.score).split(":")[1];
      var aWon = m.result.winner === "A";
      center =
        '<span class="md-score' + (aWon ? "" : " md-dim") + '">' + esc(sa || "0") + "</span>" +
        '<span class="md-score-sep">:</span>' +
        '<span class="md-score' + (aWon ? " md-dim" : "") + '">' + esc(sb || "0") + "</span>" +
        '<span class="md-center-sub">' + esc(m.result.winner === "A" ? m.teamA.name : m.teamB.name) + " 获胜</span>";
    } else {
      center =
        '<span class="status-chip ' + st + '">' + detailStatusText(st) + "</span>" +
        '<span class="md-center-sub">' + esc(fmtTime(m.startAt)) + " 开赛</span>";
    }
    var hero =
      '<div class="match-hero">' +
        matchDetailSide(m, "A", finished) +
        '<div class="md-center">' + center + "</div>" +
        matchDetailSide(m, "B", finished) +
      "</div>";

    // 信息组：这场比赛能拿到的全部数据
    var durText = (durMs / 3600000) + " 小时";
    var durLine;
    if (finished && m.endAt) {
      durLine = esc(fmtTime(m.endAt)) + "（实际）";
    } else if (finished) {
      durLine = "预计 " + esc(fmtTime(new Date(startTs + durMs).toISOString())) + " 前后";
    } else {
      durLine = "约 " + esc(durText.replace(".5", " 半")) + " · 预计 " + esc(fmtTime(new Date(startTs + durMs).toISOString())) + " 前后结束";
    }
    var info =
      '<div class="md-info">' +
        matchDetailInfoRow("状态", '<span class="status-chip ' + st + '">' + detailStatusText(st) + "</span>") +
        matchDetailInfoRow("开始时间", esc(fmtTime(m.startAt))) +
        matchDetailInfoRow(finished && m.endAt ? "结束时间" : "预计时长", durLine) +
        matchDetailInfoRow("赛制", esc(m.format)) +
        matchDetailInfoRow("等级", m.tier
          ? '<span class="tier-badge tier-' + esc(m.tier) + '">' + esc(m.tier.toUpperCase()) + "</span>"
          : "—") +
        matchDetailInfoRow("赛事", esc(m.tournament)) +
        matchDetailInfoRow("阶段", esc(m.stage)) +
        matchDetailInfoRow("游戏项目", esc(gameMeta(m.game).label)) +
        (m.note ? matchDetailInfoRow("备注", esc(m.note)) : "") +
      "</div>";

    // 局记分（2026-11-10 深度接入）：gs="A1584,A1508"（逐局胜方+秒）——官方 games 免费字段；
    // running 场次附实时比分提示；无 gs（BO1 未开/数据未及）自然不显示
    var gamesLog = parseGameLog(m.gs);
    var gamesBlock = "";
    if (gamesLog.length) {
      var gameRows = gamesLog.map(function (g, gi) {
        var winName = g.w === "A" ? m.teamA.name : m.teamB.name;
        var mm = Math.floor(g.t / 60), ss = ("0" + (g.t % 60)).slice(-2);
        return '<div class="md-game-row"><span class="md-game-no">第 ' + (gi + 1) + " 局</span>" +
          '<span class="md-game-win">' + esc(winName) + " 胜</span>" +
          (g.t ? '<span class="md-game-len">' + mm + ":" + ss + "</span>" : "") +
        "</div>";
      }).join("");
      var liveNote = m.lv === true && m.lsc
        ? '<div class="md-game-live">当前比分 <b>' + esc(m.lsc) + "</b> · 比赛进行中</div>" : "";
      gamesBlock = '<div class="md-games"><div class="md-games-head">局记分</div>' + gameRows + liveNote + "</div>";
    }

    // 我的预测卡（下过注才有）
    var predCard = "";
    if (pred) {
      var pickName = pred.pick === "A" ? m.teamA.name : m.teamB.name;
      var badge = pred.settled
        ? '<span class="history-badge ' + (pred.won ? "won" : "lost") + '">' + (pred.won ? "W" : "L") + "</span>"
        : '<span class="history-badge pending">…</span>';
      var sub2 = "预测 " + esc(pickName) + " · 投入 " + fmtNum(pred.stake) + "沙粒";
      if (pred.settled) sub2 += (pred.profit > 0 ? " · +" : " · ") + fmtNum(pred.profit) + "沙粒";
      else if (locked) sub2 += " · 已约战锁定";
      else sub2 += " · " + detailStatusText(st);
      predCard =
        '<div class="md-pred">' +
          badge +
          '<span class="md-pred-main"><b>' + (locked ? "已约战锁定 · 以战书快照判定" : "我的预测") + "</b>" +
            "<span>" + sub2 + "</span>" +
          "</span>" +
        "</div>";
    }

    // 操作区：按状态给入口（锁定/非 open 的拦截由 openSheet 自己处理）
    var actions = "";
    if (st === "open") {
      actions += '<button type="button" class="primary-btn md-bet" data-match-bet="' + esc(m.id) + '">' +
        (pred ? "加注 / 管理预测" : "去竞猜") + "</button>";
    }
    if (st === "live" && WATCH_GAME_APPIDS[m.game]) {
      actions += '<button type="button" class="watch-chip md-watch" data-match-watch="' + esc(m.game) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M10 9.5l5 3-5 3z"/></svg>去围观</button>';
    }
    if (finished && pred && pred.settled) {
      actions += '<button type="button" class="md-share" data-match-share="' + esc(m.id) + '">分享战报</button>';
    }
    var actionsHTML = actions ? '<div class="md-actions">' + actions + "</div>" : "";

    body.innerHTML =
      hero +
      info +
      gamesBlock +
      predCard +
      actionsHTML +
      '<p class="md-source">赛程与赛果数据来自公开赛事数据平台（PandaScore），以赛事官方公布为准</p>';
  }

  /* ============================== Pick'Em 赛事竞猜（1.3 实验功能） ==============================
     大型赛事按阶段竞猜：瑞士轮阶段猜 10 项（3:0 晋级×2 / 3:1·3:2 晋级×6 / 0:3 淘汰×2，
     1:3/2:3 淘汰 6 队为剩余队自动落位仅展示），淘汰赛逐场猜胜者。
     开赛前 1 小时截止（镜像单场竞猜），阶段完赛自动结算发沙粒。
     数据形状单一来源 = tools/fetch-pickem.mjs 头注释；桶定义/计分/云合并 = js/pickem.js。 */

  var pickemAutoCache = null;   // 自动收录赛事缓存（MATCHES 变化才重算）
  var pickemAutoCacheKey = "";
  var pickemGame = "all";       // 作业页游戏筛选（1.3.6，仿主页）
  var pickemQuery = "";         // 作业页搜索词（与 chips/主体同源，假设 75/76）
  // 公测直入口（1.3.10 建，1.3.14 起指向 BLAST Rivals 香港站——IEM 北京已结束）：
  // 主页「BLAST 作业」=只显示该手工赛事、隐藏 tabs/游戏筛选——其他赛事不展示；
  // 实验功能入口仍显示全部
  var PICKEM_SCOPED_EVENT = "blast-rivals-fall-2026";
  var pickemScoped = false;
  var pickemSearchTimer = null;

  /** 手工配置赛事占用的 tournament 匹配串（自动收录去重用——手工配置的精细模式优先）。
   *  注意按 tournament 串去重而非 id：自动赛事 id 是 "auto:"+tournament，与手工 id 天然不同。 */
  function pickemManualTournaments() {
    var set = {};
    PICKEM.forEach(function (ev) {
      if (ev && ev.stages && ev.stages.length && ev.tournament) set[ev.tournament] = 1;
    });
    return Object.keys(set);
  }

  /** 全部可浏览赛事 = 手工聚合（major/IEM 精细模式）+ 自动收录（tier=s/a，客户端现算） */
  function pickemEvents() {
    var key = DATA_UPDATED_AT + "|" + MATCHES.length + "|" + PICKEM.length;
    if (!pickemAutoCache || pickemAutoCacheKey !== key) {
      pickemAutoCache = buildAutoEvents(MATCHES, pickemManualTournaments(), STRUCTURES);
      pickemAutoCacheKey = key;
    }
    var merged = PICKEM.filter(function (ev) { return ev && ev.stages && ev.stages.length; })
      .concat(pickemAutoCache);
    // 排序：进行中 > 未开始 > 已结束；同级按结束时间近的在前
    var rank = { active: 0, upcoming: 1, done: 2 };
    return merged.sort(function (a, b) {
      var d = (rank[a.status] || 3) - (rank[b.status] || 3);
      if (d) return d;
      return String(b.endsAt || "").localeCompare(String(a.endsAt || ""));
    });
  }

  /** 作业页可见赛事（1.3.14）：已结束赛事不再展示（列表/游戏计数/空态同源）；
   *  结算与 recKey 查找仍走全量 pickemEvents——历史选择照常结算、已结束赛事条目仍可解析。 */
  function pickemVisibleEvents() {
    return pickemEvents().filter(function (ev) { return ev.status !== "done"; });
  }

  /** 作业页统一口径（1.3.6，假设 75/76）：游戏筛选 + 搜索词过滤后的赛事列表——chips 与主体同源。
   *  公测直入口（1.3.10）锁定 scoped 事件（1.3.14 起=BLAST 香港）：scoped 时其余赛事一律不出现。 */
  function pickemFilteredEvents() {
    var q = pickemQuery.trim().toLowerCase();
    var base = pickemVisibleEvents();
    if (pickemScoped) base = base.filter(function (ev) { return ev.id === PICKEM_SCOPED_EVENT; });
    return base.filter(function (ev) {
      if (pickemGame !== "all" && ev.game !== pickemGame) return false;
      if (!q) return true;
      var g = gameMeta(ev.game);
      var hay = [ev.name, ev.game, g.label, g.chip,
        ev.stages.map(function (s) { return s.label; }).join(" ")].join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function pickemEventById(id) {
    var all = pickemEvents();
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) return all[i]; }
    return null;
  }

  function pickemRecKey(evId, stageId) { return evId + "##" + stageId; } // 1.3.6 起用 ## 分隔（自动赛事 id 含冒号会撞 ":" 拆分）

  function pickemRec(evId, stageId) {
    return state.pickem[pickemRecKey(evId, stageId)] || null;
  }

  /** 阶段的桶清单：swiss=全局 Major 桶；records=stage.buckets（1.3.12 战绩桶）；其余 null */
  function pickemStageBuckets(stage) {
    if (stage.type === "swiss") return PICKEM_BUCKETS;
    if (stage.type === "records") return recordBuckets(stage);
    return null;
  }

  function pickemEnsureRec(stage, evId, stageId) {
    var key = pickemRecKey(evId, stageId);
    var rec = state.pickem[key];
    if (!rec || rec.type !== stage.type) {
      rec = stage.type === "swiss" || stage.type === "records"
        ? { type: stage.type, picks: {}, pickedAt: 0, settled: false, settledAt: 0, score: 0, total: 0, prize: 0 }
        : { type: stage.type, picks: { w: {} }, pickedAt: 0, settled: false, settledAt: 0, score: 0, total: 0, prize: 0 };
      var buckets = pickemStageBuckets(stage);
      if (buckets) buckets.forEach(function (b) { rec.picks[b.k] = []; });
      state.pickem[key] = rec;
    }
    return rec;
  }

  function pickemTeamOf(stage, name) {
    for (var i = 0; i < stage.teams.length; i++) { if (stage.teams[i].name === name) return stage.teams[i]; }
    return { name: name, short: "", region: "", logo: "", w: 0, l: 0 };
  }

  function pickemBucketByKey(stage, k) {
    var buckets = pickemStageBuckets(stage) || [];
    for (var i = 0; i < buckets.length; i++) { if (buckets[i].k === k) return buckets[i]; }
    return null;
  }

  function pickemSwissCount(stage, rec) {
    var n = 0;
    if (!rec) return 0;
    var buckets = pickemStageBuckets(stage) || [];
    buckets.forEach(function (b) { n += (rec.picks[b.k] || []).length; });
    return n;
  }

  function pickemStageStatus(stage) {
    // open=可竞猜 / locked=已截止待赛果 / wait=赛程未齐（队伍未定或结构降级）/ done=已完赛
    // placement：部分对阵（degraded）也算完赛只有赛果推导出来才行——QF 完赛但半决赛未排期时显示「等待赛果」
    if (stageAllDone(stage) && (stage.type !== "placement" && stage.type !== "records" || stage.results)) return "done";
    if (stage.type === "series") {
      // 逐场截止：阶段开打后只要有剩余可猜场次就是 open；全部过期且未完赛 = locked
      if (pickableSeriesMatches(stage).length) return "open";
      var anyFuture = stage.matches.some(function (m) {
        return !m.winner && m.a && m.b && !isNaN(new Date(m.startAt).getTime()) && Date.now() < new Date(m.startAt).getTime();
      });
      return anyFuture ? "locked" : "locked"; // 已开赛未完赛（含进行中）：等赛果
    }
    if (stage.type === "swiss") {
      if (stage.teams.length !== PICKEM_SWISS_TEAMS) return "wait";
      // 延迟截止（2026-11-12）：配置 pickOpenRounds 的 swiss 按两轮后规则判开放/锁定（与 stageOpenForPicks 同源）
      var sdl = swissPickDeadline(stage, Date.now());
      if (sdl !== null) return Date.now() < sdl ? "open" : "locked";
      if (typeof stage.pickOpenRounds === "number" && stage.pickOpenRounds >= 1) return "open"; // 阈值未到：保持可猜
      // 未配置：旧语义落共享尾部
    } else if (stage.type === "records") {
      var capTotal = (recordBuckets(stage) || []).reduce(function (s, b) { return s + b.cap; }, 0);
      if (!capTotal || stage.teams.length < capTotal) return "wait";
    } else if (stage.degraded &&
        !(stage.type === "placement" && stage.teams.length >= (stage.expectTeams || PICKEM_PLACEMENT_TEAMS))) {
      return "wait"; // 结构降级：placement 名单齐除外（名次竞猜与对阵无关，1.3.6；6 队轮空制按配置规模）
    }
    var start = new Date(stage.startsAt).getTime();
    if (isNaN(start)) return "wait";
    return Date.now() < start - PICKEM_DEADLINE_MS ? "open" : "locked";
  }

  function pickemToastText(list) {
    return "🏆 赛事竞猜结算：" + list.map(function (x) {
      var coins = (x.rewards && x.rewards.bySource || []).map(function (b) {
        return b.coin.icon + "×" + b.count;
      }).join(" ");
      return x.stage.label + " 猜对 " + x.r.correct + "/" + x.r.total + (coins ? " · " + coins : "");
    }).join(" · ");
  }

  /** 是否提交过任意 Pick'Em 竞猜（成就「大赛首票」判定） */
  function pickemHasAnyPicks() {
    var keys = Object.keys(state.pickem);
    for (var i = 0; i < keys.length; i++) {
      var rec = state.pickem[keys[i]];
      if (!rec) continue;
      if (rec.type === "swiss") {
        for (var j = 0; j < PICKEM_BUCKETS.length; j++) {
          if ((rec.picks[PICKEM_BUCKETS[j].k] || []).length) return true;
        }
      } else if (rec.type === "records") {
        for (var rk in rec.picks) {
          if (Object.prototype.hasOwnProperty.call(rec.picks, rk) && (rec.picks[rk] || []).length) return true;
        }
      } else if (rec.type === "placement") {
        if (rec.picks.champion || rec.picks.runnerUp || rec.picks.third) return true;
      } else if (rec.picks && rec.picks.w && Object.keys(rec.picks.w).length) {
        return true;
      }
    }
    return false;
  }

  /* ---- 结算：阶段完赛后计分并发硬币（1.3.5 硬币体系），幂等锁存（rec.settled） ---- */
  function settlePickem() {
    var done = [];
    Object.keys(state.pickem).forEach(function (key) {
      var rec = state.pickem[key];
      if (!rec || rec.settled) return;
      var sep = key.indexOf("##"); // 1.3.6 recKey 分隔符（自动赛事 id 含冒号）
      if (sep < 0) return;
      var ev = pickemEventById(key.slice(0, sep));
      if (!ev) return;
      var stage = null;
      ev.stages.forEach(function (s) { if (s.id === key.slice(sep + 2)) stage = s; });
      if (!stage) return;
      var r = scorePhase(stage, rec);
      if (!r) return; // 阶段未完赛（results 缺失 / 无已猜的完赛场次）
      // series/placement/records（逐段竞猜）必须整段结束才结算——中途部分结果提前置 settled 会漏计后续奖励
      if ((stage.type === "series" || stage.type === "placement" || stage.type === "records") && !stageAllDone(stage)) return;
      var rw = settleRewards(stage, rec, ev.tier);
      if (!rw) return;
      rec.settled = true;
      rec.settledAt = Date.now();
      rec.score = r.correct;
      rec.total = r.total;
      rec.prize = 0; // 1.3.5 起沙粒奖励移除，改发硬币（state.pickemCoins）
      var gained = 0;
      Object.keys(rw.coins).forEach(function (k) {
        if (rw.coins[k] > 0) { state.pickemCoins[k] += rw.coins[k]; gained += rw.coins[k]; }
      });
      done.push({ ev: ev, stage: stage, r: r, rewards: rw, gained: gained });
    });
    if (done.length) {
      saveState(); // 成就检测（新硬币成就）挂在 saveState 写闸内自动触发
      syncCoinBoard(); // 硬币变化推硬币榜（sha_board_god，实验功能内展示）
    }
    return done;
  }

  /* ---------- 渲染 ---------- */

  function pickemStageBadge(st, stage, rec) {
    if (st === "open") {
      if (stage.type === "series") {
        var n = pickableSeriesMatches(stage).length;
        return '<span class="pickem-badge is-open">可竞猜 ' + n + " 场 · 各场开赛前 1 小时截止</span>";
      }
      if (stage.type === "swiss" && typeof stage.pickOpenRounds === "number" && stage.pickOpenRounds >= 1) {
        // 延迟截止：阈值未到（聚合器还没下发 pickDeadline）显示规则文案；已下发显示确切时刻
        var sdl = swissPickDeadline(stage, Date.now());
        if (sdl !== null) return '<span class="pickem-badge is-open">可竞猜 · ' + esc(fmtTime(new Date(sdl).toISOString())) + " 截止</span>";
        return '<span class="pickem-badge is-open">可竞猜 · 第 ' + (stage.pickOpenRounds + 1) + " 轮开赛前 1 小时截止</span>";
      }
      var start = new Date(stage.startsAt).getTime();
      var dl = isNaN(start) ? "" : fmtTime(new Date(start - PICKEM_DEADLINE_MS).toISOString());
      return '<span class="pickem-badge is-open">可竞猜' + (dl ? " · " + esc(dl) + " 截止" : "") + "</span>";
    }
    if (st === "locked") return '<span class="pickem-badge is-locked">' + (stage.type === "series" ? "进行中 · 等赛果" : "已截止 · 等待赛果") + "</span>";
    if (st === "wait") return '<span class="pickem-badge is-wait">待赛程确定</span>';
    if (rec && rec.settled) {
      return '<span class="pickem-badge is-done">猜对 ' + rec.score + "/" + rec.total + (rec.prize ? " · +" + fmtNum(rec.prize) : "") + "</span>";
    }
    return '<span class="pickem-badge is-done">已结束' + (rec ? " · 待结算" : "") + "</span>";
  }

  function pickemTeamStrip(stage) {
    if (!stage.teams.length) return "";
    return '<div class="pickem-strip">' + stage.teams.map(function (t) {
      return '<span class="pickem-chip">' + avatarHTML(t) + "<span>" + esc(t.short || t.name) + "</span></span>";
    }).join("") + "</div>";
  }

  function pickemBucketHTML(stage, bucket, rec, editable, results) {
    var picks = rec && rec.picks ? (rec.picks[bucket.k] || []) : [];
    var resNames = results ? (results[bucket.k] || []) : null;
    var shown = Math.max(bucket.cap, picks.length, resNames ? resNames.length : 0);
    var slots = "";
    for (var i = 0; i < shown; i++) {
      var name = picks[i] || "";
      var resName = resNames ? (resNames[i] || "") : "";
      var team = pickemTeamOf(stage, name || resName);
      var hit = !!(name && resNames && resNames.indexOf(name) >= 0);
      var miss = !!(name && resNames && !hit);
      var cls = "pickem-slot" + (name ? " is-filled" : "") + (hit ? " is-hit" : "") + (miss ? " is-miss" : "") + (!name && resName ? " is-result" : "");
      // 已截止/已结束的桶槽位保持可点：点击由 body 委托给出提示（与场次同款处理）
      slots += '<button type="button" class="' + cls + '"' +
        (editable
          ? ' data-pkslot="' + esc(bucket.k) + '" data-pkcur="' + esc(name) + '"'
          : ' data-pkslot="' + esc(bucket.k) + '" data-pklocked="1"') + ">" +
        (name || resName
          ? avatarHTML(team) + '<span class="pickem-slot-name">' + esc(name || resName) +
              (hit ? '<i class="pickem-mark hit">✓</i>' : "") + (miss ? '<i class="pickem-mark miss">✗</i>' : "") + "</span>"
          : '<span class="pickem-slot-empty">＋</span>') +
        "</button>";
    }
    return '<div class="pickem-bucket' + (bucket.tone === "win" ? " is-win" : " is-lose") + '">' +
      '<div class="pickem-bucket-head"><span>' + esc(bucket.label) + "</span><b>" + picks.length + "/" + bucket.cap + "</b></div>" +
      '<div class="pickem-slot-grid">' + slots + "</div></div>";
  }

  /** 桶位阶段体（swiss=Major 瑞士轮；records=1.3.12 战绩桶）——桶清单按类型取，交互同构 */
  function pickemSwissBody(ev, stage, st, rec) {
    var editable = st === "open";
    var isRecords = stage.type === "records";
    var buckets = pickemStageBuckets(stage) || [];
    var capTotal = buckets.reduce(function (s, b) { return s + b.cap; }, 0);
    var html = "";
    if (st === "wait") {
      var need = isRecords ? capTotal : PICKEM_SWISS_TEAMS;
      html += '<div class="pickem-note">参赛队伍未同步完整（' + stage.teams.length + "/" + need + "），赛程确定后开放竞猜</div>" + pickemTeamStrip(stage);
      return html;
    }
    if (st === "done" && stage.results && rec && pickemSwissCount(stage, rec) > 0) {
      html += '<div class="pickem-note">' + (isRecords
        ? "按小组赛最终战绩逐桶比对：猜进「" + esc(buckets[0].label) + "」的队伍须真打出该战绩才算对"
        : "按终局比分逐桶比对：猜进「3:0 晋级」的队伍须真以 3-0 出线才算对") + "</div>";
    }
    // 奖励展示（与 settleRewards 同源：币级=stage.coinTier）——placement 体有币级文案、逐场行有，
    // 桶体此前缺失（BLAST Rivals 反馈「奖励还没显示出来」，2026-11-10）
    if (st === "open" || st === "locked") {
      var rc = PICKEM_COINS[coinKeyForTier(stage.coinTier || 1)];
      html += '<div class="pickem-note">奖励：每支落位正确得 ' + rc.icon + " " + esc(rc.name) +
        "（" + (isRecords ? "按最终战绩逐桶比对" : "按终局比分逐桶比对") + "，赛果出来后自动结算）</div>";
    }
    html += buckets.map(function (b) {
      return pickemBucketHTML(stage, b, rec, editable, st === "done" ? stage.results : null);
    }).join("");
    if (!isRecords && st === "done" && stage.results) {
      // 自动落位桶（1:3 / 2:3 淘汰）：剩余队伍的终局展示，不参与选择与计分（仅 Major 瑞士轮）
      html += PICKEM_AUTO_BUCKETS.map(function (b) {
        return pickemBucketHTML(stage, b, null, false, stage.results);
      }).join("");
    }
    if (editable) {
      var n = pickemSwissCount(stage, rec);
      html += '<div class="pickem-stage-acts">' +
        (n > 0 ? '<button type="button" class="ghost-btn" data-pkact="clear">清空重选</button>' : "") +
        '<span class="pickem-progress">已分配 ' + n + "/" + capTotal + (n === capTotal ? " · 提交完成，截止前可修改" : "") + "</span></div>";
      if (st === "open" && n === 0) {
        html += '<div class="pickem-note">' + (isRecords
          ? "点空位把队伍放进战绩桶：每桶容量见桶头（全部落位后才能提交，截止前可修改）"
          : "点空位选队伍：3:0 晋级 2 支 · 3:1/3:2 晋级 6 支 · 0:3 淘汰 2 支（1:3/2:3 淘汰由剩余队自动落位）") + "</div>";
      }
    } else if (st === "locked") {
      html += '<div class="pickem-note">已截止：开赛前 1 小时锁定选择，赛果出来后自动结算</div>';
    }
    // 官方小组积分（2026-11-10）：fetch-tournament-structures 管线切片，聚合器/auto 路径烘进阶段——
    // records/swiss 通用；无数据（未开赛/老缓存）自然不显示
    var stRows = stage.standings || [];
    if (stRows.length) {
      html += '<div class="pickem-round-label">小组积分</div><div class="pickem-standings">' +
        stRows.map(function (r) {
          return '<span class="pk-standing"><b>' + esc(r.t) + "</b><i>" + r.w + "-" + r.l + "</i></span>";
        }).join("") + "</div>";
    }
    // 轮次流（1.3.6）：对阵与赛果按轮展示（纯展示，选择交互在上方桶）
    if (stage.matches.length) {
      html += '<div class="pickem-round-label">对阵与赛果</div>' + pickemStaticRoundFlowHTML(stage, rec);
    }
    return html;
  }

  /** 瑞士轮「对阵与赛果」纯展示流（1.3.6 轮次优先改版后保留：桶位选择在上方，此处按轮只读）。
   *  已完赛/弃赛场次不展示（2026-11-07 同 series 口径）。
   *  网格只在每轮最后一场闭合一次——勿在换轮开头再闭合（双重闭合会关掉 data-pstage 包裹层，
   *  「蒙古对阵黑豹无法保存预测」根因，见 pickemMergedSeriesHTML 注释）。 */
  function pickemStaticRoundFlowHTML(stage, rec) {
    var html = "";
    var lastRound = -1;
    var visible = pickemStageVisibleMatches(stage);
    if (!visible.length) return '<div class="pickem-note">本轮次场次已全部结束</div>';
    visible.forEach(function (m, i) {
      var next = visible[i + 1];
      if (m.round !== lastRound) {
        lastRound = m.round;
        html += '<div class="pickem-round-label">第 ' + ((m.round || 0) + 1) + " 轮</div>" + '<div class="pk-round-grid">';
      }
      html += pickemMatchNodeHTML(stage, m, rec, false);
      if (!next || next.round !== m.round) html += "</div>";
    });
    return html;
  }

  function pickemSideHTML(stage, m, side, myPick, open) {
    var name = side === "A" ? m.a : m.b;
    if (!name) return '<span class="pickem-side is-tbd">待上一轮</span>';
    var team = pickemTeamOf(stage, name);
    var sel = myPick === side;
    var won = m.winner === side;
    // 已截止/已结束的场次保持可点：点击由 pickemBracketPick 给出明确提示（避免「点了没反应」的困惑）
    return '<button type="button" class="pickem-side' + (sel ? " is-picked" : "") + (won ? " is-winner" : "") + '"' +
      ' data-pkmatch="' + esc(m.id) + '" data-pkside="' + side + '"' + (open ? "" : ' data-pklocked="1"') + ">" +
      avatarHTML(team) + "<span>" + esc(name) + "</span>" +
      (won && m.winner ? '<i class="pickem-mark ' + (sel ? "hit" : "plain") + '">' + (sel ? "✓" : "胜") + "</i>" : "") +
      "</button>";
  }

  /* 系列赛（1.3.4）：任意赛制逐场猜（双败小组/联赛等）——已结束场次只展示，剩余场次逐场可猜；
     计分只算「用户猜过的」场次（中途接入公平），不发全对加成 */
  /* ---------- 树状展示（1.3.6，更接近官方 Major Pick'Em） ----------
     比赛节点卡：两队（队标+缩写）+ 比分/胜方高亮；series 可点选（点哪侧猜哪侧），
     已截止/已结束的侧也带 data-pkmatch（点击走 pickemBracketPick 的 toast，不做无反应按钮）；
     swiss/placement 纯展示（交互在桶/名次槽）。 */
  function pickemMatchNodeHTML(stage, m, rec, interactive) {
    var myW = rec && rec.picks && rec.picks.w ? rec.picks.w : {};
    var my = myW[m.id] || "";
    var start = new Date(m.startAt).getTime();
    var open = interactive && !m.winner && !!m.a && !!m.b && !isNaN(start) && Date.now() < start - PICKEM_DEADLINE_MS;
    // 已截止待赛果：视觉上与可竞猜卡区分（1.3.4 线上「蒙古对阵黑豹无法保存预测」的用户侧根因——
    // 已截止卡与可猜卡长得一样、点了又无反应，用户无从知道已过各场开赛前 1 小时截止线）
    var locked = interactive && !m.winner && !!m.a && !!m.b && !isNaN(start) && Date.now() >= start - PICKEM_DEADLINE_MS;
    var scoreParts = String(m.score || "").split(":");
    function sideRow(side) {
      var name = side === "A" ? m.a : m.b;
      if (!name) return '<span class="pk-node-side is-tbd">待定</span>';
      var won = m.winner === side;
      var team = pickemTeamOf(stage, name);
      var pts = m.score ? (side === "A" ? (scoreParts[0] || "") : (scoreParts[1] || "")) : "";
      var sel = my === side;
      var mark = "";
      if (m.winner && my) mark = sel && won ? '<em class="pickem-mark hit">✓</em>' : (sel ? '<em class="pickem-mark miss">✗</em>' : (won ? '<em class="pickem-mark plain">胜</em>' : ""));
      // open=可点选；locked=点击给截止/赛果提示（不做无反应按钮）
      return '<button type="button" class="pk-node-side' + (won ? " is-win" : "") + (sel ? " is-picked" : "") + '"' +
        (open ? ' data-pkmatch="' + esc(m.id) + '" data-pkside="' + side + '"'
          : (interactive && m.a && m.b ? ' data-pkmatch="' + esc(m.id) + '" data-pkside="' + side + '" data-pklocked="1"' : "")) + ">" +
        avatarHTML(team) + "<span>" + esc(team.short || name) + "</span>" +
        (pts !== "" ? "<i>" + esc(pts) + "</i>" : "") + mark +
        "</button>";
    }
    return '<div class="pk-node' + (m.winner ? " is-done" : "") + (locked ? " is-locked" : "") + '">' + sideRow("A") + sideRow("B") +
      (m.startAt ? '<span class="pk-node-time">' + esc(locked ? "已截止 · 开赛 " + fmtTime(m.startAt) : fmtTime(m.startAt)) + "</span>" : "") +
      "</div>";
  }

  /** 横向 bracket 树（placement/bracket）：列=轮，节点=比赛卡，flex 垂直居中自动对齐父子位置 */
  function pickemBracketTree(stage, rec) {
    var maxRound = -1;
    stage.matches.forEach(function (m) { if (m.round > maxRound) maxRound = m.round; });
    if (maxRound < 0) return "";
    var html = '<div class="pk-bracket">';
    for (var r = 0; r <= maxRound; r++) {
      var col = stage.matches.filter(function (m) { return m.round === r; });
      html += '<div class="pk-bracket-col' + (r === maxRound ? " is-final" : "") + '">' +
        '<div class="pk-bracket-colhead">' + esc((stage.rounds && stage.rounds[r]) || "第 " + (r + 1) + " 轮") + "</div>";
      col.forEach(function (m) {
        html += '<div class="pk-bracket-cell">' + pickemMatchNodeHTML(stage, m, rec, false) + "</div>";
      });
      html += "</div>";
    }
    html += "</div>";
    return html;
  }

  /* 轮次优先合并布局（1.3.6 任务 4）：event 的全部 series 阶段（Group A/B…）合并成
     「第 N 轮（北京日期）→ 组内子块（配置顺序=A 组在前）→ 场次（时间序）」——阅读顺序与时间顺序一致。
     历史（1.3.6 首提事故）：旧的 per-stage 轮次流在换轮处双重闭合 </div>，把 .pickem-stage[data-pstage]
     包裹层提前关掉，round 1+ 比赛卡溢出到包裹层外，点击 closest("[data-pstage]") 落空 → 预测静默无法保存
     （「蒙古对阵黑豹」根因）。现行：每个 (轮,阶段) 子块与阶段摘要行各自带 data-pstage 包裹层，
     closest 取最近祖先兜住卡片点击；摘要行承载 label/badge/进度。 */
  function pickemDayIso(startAt) {
    var d = new Date(new Date(startAt).getTime() + 8 * 3600000); // 北京日期（与聚合器 round 聚类同口径）
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  function pickemDayLabel(iso) {
    var p = (iso || "").split("-");
    return p.length === 3 ? parseInt(p[1], 10) + "月" + parseInt(p[2], 10) + "日" : "对阵";
  }
  function pickemSeriesProgressText(stage, rec) {
    var doneCount = stage.matches.filter(function (m) { return m.winner === "A" || m.winner === "B"; }).length;
    var myW = rec && rec.picks && rec.picks.w ? rec.picks.w : {};
    var picked = 0;
    Object.keys(myW).forEach(function (k) { if (myW[k]) picked++; });
    return "已结束 " + doneCount + "/" + stage.matches.length + " 场 · 你已猜 " + picked + " 场";
  }

  /* 折叠状态（1.3.8）：轮次/淘汰赛阶段可折叠；默认全部展开（1.3.9 平台拒审教训），
     手动点开/收起记录进 pickemCollapseOverrides（会话内有效），优先于默认值 */
  var pickemCollapseOverrides = {};

  /** series 阶段逐场币级展示（与 settleRewards 同口径）：auto 事件纯展示（displayOnly）返回 null；
   *  其余按赛事等级币（A 级铜、其余银） */
  function pickemSeriesCoin(ev, stage) {
    if (stage.displayOnly) return null; // displayOnly：auto 事件纯展示（2026-11-08）
    return PICKEM_COINS[ev.tier === "a" ? "c" : "s"];
  }

  // 已完赛/弃赛场次不再放进作业页（2026-11-07 用户口径）：结算与进度统计仍读数据，不受渲染过滤影响
  function pickemStageVisibleMatches(stage) {
    return (stage.matches || []).filter(function (m) {
      return !(m.winner === "A" || m.winner === "B") && m.canceled !== true;
    });
  }

  function pickemMergedSeriesHTML(ev, stages) {
    var allDisplay = stages.length && stages.every(function (st2) { return st2.displayOnly; });
    var html = '<div class="pickem-merged">' +
      '<div class="pickem-note">' + (allDisplay
        ? "自动收录赛事 · 仅展示赛程与赛果；结构化竞猜（战绩桶/名次）见配置赛事"
        : "逐场竞猜：已结束场次自动收起不展示，各场开赛前 1 小时截止；只统计你猜过的场次，结算不受影响") + '</div>';
    // 阶段摘要行（label + 状态徽章 + 进度）——行本身带 data-pstage
    html += '<div class="pk-stage-rows">';
    stages.forEach(function (stage) {
      var st = pickemStageStatus(stage);
      var rec = pickemRec(ev.id, stage.id);
      var coin = pickemSeriesCoin(ev, stage);
      html += '<div class="pk-stage-row" data-pstage="' + esc(pickemRecKey(ev.id, stage.id)) + '">' +
        "<b>" + esc(stage.label) + "</b>" + pickemStageBadge(st, stage, rec) +
        '<span class="pk-stage-progress">' + esc(pickemSeriesProgressText(stage, rec)) +
        (coin ? " · 猜对每场得 " + coin.icon + " " + esc(coin.name) : " · 赛程展示") + "</span></div>";
    });
    html += "</div>";
    // 按北京日期归并各阶段的轮次块（day key 用 ISO 串保证时间排序，展示标签单独格式化）
    var days = {}, dayOrder = [];
    stages.forEach(function (stage) {
      var visible = pickemStageVisibleMatches(stage);
      if (!visible.length) return; // 全部完赛/弃赛的阶段不产生日期块（摘要行仍在）
      var byRound = {}, roundOrder = [];
      visible.forEach(function (m) {
        var r = m.round || 0;
        if (!byRound[r]) { byRound[r] = []; roundOrder.push(r); }
        byRound[r].push(m);
      });
      roundOrder.forEach(function (r) {
        var ms = byRound[r];
        var day = ms.length && ms[0].startAt ? pickemDayIso(ms[0].startAt) : "";
        if (!days[day]) { days[day] = []; dayOrder.push(day); }
        days[day].push({ stage: stage, matches: ms });
      });
    });
    if (!dayOrder.length) {
      html += '<div class="pickem-note">本轮次场次已全部结束' + (ev.status === "done" ? "，感谢参与" : "，等待下一阶段排期") + "</div></div>";
      return html;
    }
    dayOrder.sort();
    dayOrder = dayOrder.filter(function (d) { return d; }).concat(dayOrder.filter(function (d) { return !d; })); // 无日期排最后
    dayOrder.forEach(function (day, i) {
      var dayBlocks = days[day];
      var dayKey = ev.id + "##day##" + (day || "na" + i);
      var collapsed = pickemCollapseOverrides[dayKey] === true; // 1.3.10：默认全部展开（1.3.9 因「完赛默认收起=首屏内容不可见」被平台拒），保留手动折叠
      html += '<div class="pk-day">' +
        '<div class="pickem-round-label is-toggle" data-pkday="' + esc(dayKey) + '" role="button">第 ' + (i + 1) + " 轮 · " + esc(day ? pickemDayLabel(day) : "对阵") +
        '<i class="pk-chev">' + (collapsed ? "▸" : "▾") + "</i></div>";
      html += '<div class="pk-day-body" data-daybody="' + esc(dayKey) + '"' + (collapsed ? " hidden" : "") + ">";
      dayBlocks.forEach(function (blk) {
        var key = pickemRecKey(ev.id, blk.stage.id);
        var rec = pickemRec(ev.id, blk.stage.id);
        var coin = pickemSeriesCoin(ev, blk.stage);
        html += '<div class="pk-day-group" data-pstage="' + esc(key) + '">' +
          '<div class="pk-group-head">' + esc(blk.stage.label) + (coin ? " · 猜对每场得 " + coin.icon + " " + esc(coin.name) : " · 淘汰赛 · 逐场不计币") + "</div>" +
          '<div class="pk-round-grid">' +
          blk.matches.map(function (m) { return pickemMatchNodeHTML(blk.stage, m, rec, !blk.stage.displayOnly); }).join("") +
          "</div></div>";
      });
      html += "</div></div>";
    });
    html += "</div>";
    return html;
  }

  /* placement（淘汰赛名次竞猜）：猜冠军（💎）/亚军（🥇）/季军（🥇，半决赛败者并列两队猜中任一即对） */
  var PLACEMENT_FIELDS = [
    { k: "champion", label: "冠军" },
    { k: "runnerUp", label: "亚军" },
    { k: "third", label: "季军" }
  ];

  function pickemPlacementBody(ev, stage, st, rec) {
    // 名单未齐（首轮未排完）才降级只展示；名单齐但部分对阵未排期可正常名次竞猜（1.3.6；规模按 expectTeams/默认 8）
    if (stage.degraded && stage.teams.length < (stage.expectTeams || PICKEM_PLACEMENT_TEAMS)) {
      return '<div class="pickem-note">该阶段赛制结构与预期不符，暂只展示赛程</div>' + pickemTeamStrip(stage);
    }
    var editable = st === "open";
    // A 级赛事币级整体降一级（1.3.6 改版）：冠军金币/亚季军银币；Major 与 S 级不变（冠军钻石/亚季军金币）
    var isA = ev.tier === "a";
    var champCoin = isA ? PICKEM_COINS.g : PICKEM_COINS.d;
    var placeCoin = isA ? PICKEM_COINS.s : PICKEM_COINS.g;
    var html = '<div class="pickem-note">预测最终名次：猜对冠军得 ' + champCoin.icon + " " + esc(champCoin.name) +
      "，猜对亚军/季军各得 " + placeCoin.icon + " " + esc(placeCoin.name) +
      "（季军=半决赛败者并列两队，猜中任一即对）；第一场开赛前 1 小时截止后锁定</div>";
    if (stage.degraded) {
      html += '<div class="pickem-note">淘汰赛名单已确定（部分对阵待公布）——名次竞猜与对阵无关；对阵树随官方公布补全</div>';
    }
    if (st === "done" && stage.results) {
      html += '<div class="pickem-note">终局：冠军 ' + esc(stage.results.champion) + " · 亚军 " + esc(stage.results.runnerUp) + " · 季军 " + esc((stage.results.third || []).join(" / ")) + "</div>";
    }
    PLACEMENT_FIELDS.forEach(function (f) {
      var picked = rec && rec.picks ? rec.picks[f.k] : "";
      var team = picked ? pickemTeamOf(stage, picked) : null;
      var resList = st === "done" && stage.results ? (f.k === "third" ? (stage.results.third || []) : [stage.results[f.k]]) : null;
      var hit = !!(picked && resList && resList.indexOf(picked) >= 0);
      var miss = !!(picked && resList && !hit);
      var coin = f.k === "champion" ? champCoin : placeCoin;
      html += '<div class="pickem-place">' +
        '<div class="pickem-place-head"><b>' + esc(f.label) + "</b><i>" + coin.icon + " " + esc(coin.name) + "</i>" +
          (hit ? '<span class="pickem-mark hit">✓</span>' : "") + (miss ? '<span class="pickem-mark miss">✗</span>' : "") + "</div>" +
        '<div class="pickem-place-slot">' + (team
          ? '<button type="button" class="pickem-side is-picked" data-pkplace="' + f.k + '" data-pkcur="' + esc(picked) + '"' + (editable ? "" : ' data-pklocked="1"') + ">" + avatarHTML(team) + "<span>" + esc(picked) + "</span></button>"
          : '<button type="button" class="pickem-side is-tbd" data-pkplace="' + f.k + '"' + (editable ? "" : ' data-pklocked="1"') + ">" + (editable ? "＋ 点选队伍" : "未选择") + "</button>") +
        "</div></div>";
    });
    if (st === "locked") html += '<div class="pickem-note">已截止：等全部赛果出来自动结算</div>';
    // bracket 树（1.3.6）：对阵与赛果的树状展示（纯展示，名次交互在上方三槽）
    html += '<div class="pickem-round-label">对阵树</div>' + pickemBracketTree(stage, rec);
    return html;
  }

  function pickemStageHTML(ev, stage) {
    var st = pickemStageStatus(stage);
    var rec = pickemRec(ev.id, stage.id);
    // series 阶段走 pickemEventHTML 的轮次优先合并布局（pickemMergedSeriesHTML），不进单阶段面板
    var key = pickemRecKey(ev.id, stage.id);
    var head = '<div class="pickem-stage-head"><b>' + esc(stage.label) + "</b>" + pickemStageBadge(st, stage, rec) + "</div>";
    if (stage.type !== "placement") {
      return '<div class="pickem-stage" data-pstage="' + esc(key) + '">' + head +
        (stage.type === "swiss" || stage.type === "records" ? pickemSwissBody(ev, stage, st, rec)
          : "") +
        "</div>";
    }
    // placement（淘汰赛）：头部可折叠，默认展开（1.3.10：完赛默认收起被平台拒——首屏内容不可见；保留手动折叠）
    var sk = key + "##stage";
    var collapsed = pickemCollapseOverrides[sk] === true;
    head = '<div class="pickem-stage-head is-toggle" data-pkstage="' + esc(sk) + '" role="button">' +
      '<b>' + esc(stage.label) + "</b>" + pickemStageBadge(st, stage, rec) +
      '<i class="pk-chev">' + (collapsed ? "▸" : "▾") + "</i></div>";
    return '<div class="pickem-stage" data-pstage="' + esc(key) + '">' + head +
      '<div class="pickem-stage-body" data-stagebody="' + esc(sk) + '"' + (collapsed ? " hidden" : "") + ">" +
      pickemPlacementBody(ev, stage, st, rec) +
      "</div></div>";
  }

  function pickemCoinsHTML() {
    var c = state.pickemCoins || { c: 0, s: 0, g: 0, d: 0 };
    var total = c.c + c.s + c.g + c.d;
    if (!total) return "";
    return PICKEM_COINS.c.icon + c.c + " " + PICKEM_COINS.s.icon + c.s + " " + PICKEM_COINS.g.icon + c.g + " " + PICKEM_COINS.d.icon + c.d;
  }

  /** 赛事硬币规则说明（1.3.6 改版，按赛事形态；2026-11-07 淘汰赛逐场不计币 + 1.3.12 战绩桶）：
   *  Major（有瑞士轮阶段）规则不变；records 小组=按战绩落位逐桶发币；其余 auto 赛事小组赛按等级
   *  发币、淘汰赛逐场不计币（高级币只走名次竞猜——手工配置赛事的 placement 阶段） */
  function pickemCoinRuleText(ev) {
    var hasSwiss = ev.stages.some(function (s) { return s.type === "swiss"; });
    var hasRecords = ev.stages.some(function (s) { return s.type === "records"; });
    if (hasSwiss) return "Major 规则：瑞士轮第 1/2/3 阶段猜对得 🥉/🥈/🥇 · 淘汰赛冠军 💎 亚/季军 🥇";
    if (hasRecords) {
      // 与 settleRewards 同源（原则 9）：records 币级取 stage.coinTier，不按 ev.tier 推导
      var recStage0 = null;
      ev.stages.forEach(function (s) { if (!recStage0 && s.type === "records") recStage0 = s; });
      var rc2 = PICKEM_COINS[coinKeyForTier((recStage0 && recStage0.coinTier) || 1)];
      var tier = rc2.icon + " " + rc2.name;
      // auto 赛事没有 placement（淘汰赛纯展示）——文案按形态分流，避免误导「猜冠军得钻石」
      var tail = ev.auto ? " · 淘汰赛等其他阶段仅赛程展示" : " · 淘汰赛冠军 💎/🥇 亚/季军 🥇（S/A）";
      return "战绩桶规则：把每支队伍放进小组赛最终战绩（猜对一桶得 " + tier + "）" + tail;
    }
    if (ev.tier === "a") return "A 级赛事：小组赛猜对每场得 🥉 铜币 · 淘汰赛逐场不计币（名次奖励见名次竞猜赛事）";
    return "S 级赛事：小组赛猜对每场得 🥈 银币 · 淘汰赛逐场不计币（名次奖励见名次竞猜赛事）";
  }

  function pickemEventHTML(ev) {
    var stLabel = ev.status === "done" ? "已结束" : ev.status === "active" ? "进行中" : "未开始";
    var coins = state.pickemCoins || { c: 0, s: 0, g: 0, d: 0 };
    var totalCoins = coins.c + coins.s + coins.g + coins.d;
    var html =
      '<div class="pickem-evhead"><span class="pickem-evname">' + esc(ev.name) + "</span>" +
        '<span class="pickem-evstatus is-' + ev.status + '">' + stLabel + "</span>" +
        '<span class="pickem-evmeta">' + esc(gameMeta(ev.game).label) + "</span></div>" +
      '<div class="pickem-coin' + (totalCoins ? " has" : "") + '">' +
        (totalCoins
          ? "我的硬币：" + pickemCoinsHTML() + " · 不可交易/不可压注，仅荣誉展示（硬币排行榜在实验功能内）"
          : esc(pickemCoinRuleText(ev))) +
      "</div>";
    // series 阶段合并为「轮次优先」布局（第 N 轮 → 组内子块），swiss/placement/bracket 保持独立面板。
    // 有 records 孪生（srcStage）的同源 series 阶段不渲染——桶体已含「对阵与赛果」，series 仅留作
    // 历史（1.3.12 时代）逐场选择的结算通道（settlePickem 仍按键找到它）
    var recTwin = {};
    ev.stages.forEach(function (s) { if (s.type === "records" && s.srcStage) recTwin[s.srcStage] = 1; });
    var seriesStages = ev.stages.filter(function (s) { return s.type === "series" && !recTwin[s.id]; });
    var restStages = ev.stages.filter(function (s) { return s.type !== "series"; });
    if (seriesStages.length) html += pickemMergedSeriesHTML(ev, seriesStages);
    restStages.forEach(function (stage) { html += pickemStageHTML(ev, stage); });
    html += '<p class="data-note">参赛名单与赛果以赛事官方公布为准 · 实验功能可能随时调整或下线</p>';
    return html;
  }

  function renderPickem() {
    var coin = $("#pickemCoin");
    if (coin) {
      var chtml = pickemCoinsHTML();
      coin.textContent = chtml ? "硬币 " + chtml : "";
    }
    var selRow = $("#pickemSelectors");
    var gameGrid = $("#pickemGameGrid");
    var evList = $("#pickemEvList");
    var body = $("#pickemBody");
    if (!body) return;
    var all = pickemVisibleEvents(); // 1.3.14：已结束赛事不进列表/计数/空态（与 pickemFilteredEvents 同源）
    if (pickemScoped) {
      // 公测直入口：只显示 scoped 赛事（1.3.14 起=BLAST 香港）——选择器整行隐藏（其他赛事不展示）
      all = all.filter(function (e) { return e.id === PICKEM_SCOPED_EVENT; });
      if (selRow) selRow.hidden = true;
      if (pickemEventId !== PICKEM_SCOPED_EVENT) pickemEventId = PICKEM_SCOPED_EVENT;
    } else if (selRow) {
      selRow.hidden = !all.length; // 无任何赛事时隐藏选择器行（保留搜索框位置提示空态）
    }
    if (pickemScoped || all.length) {
      // 游戏 tile（浮层 grid）：只列有赛事的游戏（按 GAME_ORDER 排序）；data-pkg 沿用旧委托
      var seen = {};
      var games = [];
      all.forEach(function (e) {
        if (!seen[e.game]) { seen[e.game] = 1; games.push(e.game); }
      });
      games.sort(function (a, b) {
        var xa = GAME_ORDER.indexOf(a), xb = GAME_ORDER.indexOf(b);
        return (xa < 0 ? 99 : xa) - (xb < 0 ? 99 : xb);
      });
      if (gameGrid) {
        gameGrid.innerHTML =
          '<button type="button" class="game-tile' + (pickemGame === "all" ? " is-selected" : "") + '" data-pkg="all">' +
            '<span class="game-tile-avatar" style="background:linear-gradient(135deg,#ffd08a,#ff8a3d)">ALL</span>' +
            '<span class="game-tile-main"><span class="game-tile-name">全部游戏</span><span class="game-tile-count">' + all.length + " 项</span></span>" +
            '<span class="game-tile-check" aria-hidden="true"></span></button>' +
          games.map(function (g) {
            var n = all.filter(function (e) { return e.game === g; }).length;
            var meta = gameMeta(g);
            return '<button type="button" class="game-tile' + (pickemGame === g ? " is-selected" : "") + '" data-pkg="' + esc(g) + '">' +
              '<span class="game-tile-avatar" style="background:linear-gradient(135deg,' + meta.c1 + "," + meta.c2 + ');color:' + (meta.dark ? "#1a0e04" : "#0b1220") + '">' + esc(meta.chip) + "</span>" +
              '<span class="game-tile-main"><span class="game-tile-name">' + esc(meta.label) + '</span><span class="game-tile-count">' + n + " 项</span></span>" +
              '<span class="game-tile-check" aria-hidden="true"></span></button>';
          }).join("");
        var curMeta = pickemGame === "all" ? { label: "全部游戏", c2: "#ff8a3d" } : gameMeta(pickemGame);
        $("#pickemGameCurrent").textContent = curMeta.label;
        var dot = $("#pickemGameDot");
        if (dot) dot.style.setProperty("--dot", curMeta.c2 || "#ff8a3d");
        $("#pickemGamePopoverMeta").textContent = all.length + " 项赛事";
      }
    }
    // 统一口径过滤（游戏 + 搜索）——浮层列表与主体同源（假设 75/76）
    var evs = pickemFilteredEvents();
    if (!all.length) {
      if (evList) evList.innerHTML = "";
      body.innerHTML = '<div class="empty-state"><strong>暂无可竞猜的赛事</strong>S/A 级赛事确认排期后，这里会自动收录作业</div>';
      return;
    }
    if (!evs.length) {
      if (evList) evList.innerHTML = "";
      body.innerHTML = '<div class="empty-state"><strong>没有匹配的赛事</strong>换个搜索词或游戏筛选试试</div>';
      return;
    }
    if (!pickemEventById(pickemEventId) || !evs.some(function (e) { return e.id === pickemEventId; })) {
      var first = evs.filter(function (e) { return e.status !== "done"; })[0] || evs[0];
      pickemEventId = first.id;
    }
    var ev = pickemEventById(pickemEventId);
    if (evList) {
      // 赛事浮层列表（主页 tournament-row 同款）：状态标 + 名称 + 场次数；data-pevt 沿用旧委托
      evList.innerHTML = evs.map(function (e) {
        var mc = (e.stages || []).reduce(function (s, st) { return s + (st.matches || []).length; }, 0);
        var done = e.status === "done";
        return '<button type="button" class="tournament-row' + (e.id === pickemEventId ? " is-selected" : "") + '" data-pevt="' + esc(e.id) + '">' +
          '<span class="pk-evtag' + (done ? " is-done" : "") + '">' + (e.status === "active" ? "进行中" : done ? "已结束" : "未开始") + "</span>" +
          '<span class="tournament-name">' + esc(e.name) + "</span>" +
          '<span class="tournament-count">' + mc + " 场</span></button>";
      }).join("");
      $("#pickemEvCurrent").textContent = ev.name;
      $("#pickemEvPopoverMeta").textContent = evs.length + " 项赛事";
    }
    body.innerHTML = pickemEventHTML(ev);
  }

  function renderLabs() {
    var box = $("#labsList");
    if (!box) return;
    var evs = pickemEvents();
    var active = evs.filter(function (e) { return e.status !== "done"; }).length;
    var coins = state.pickemCoins || { c: 0, s: 0, g: 0, d: 0 };
    var coinTotal = (coins.c || 0) + (coins.s || 0) + (coins.g || 0) + (coins.d || 0);
    box.innerHTML =
      '<button type="button" class="settings-row" data-labs="pickem">' +
        '<span class="settings-row-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/></svg></span>' +
        '<span class="settings-row-label">赛事竞猜 · Major Pick\'Em</span>' +
        '<span class="settings-row-value">' + (active ? active + " 个赛事进行中" : "暂无进行中") + "</span>" +
        '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>' +
      "</button>" +
      '<button type="button" class="settings-row" data-labs="coinboard">' +
        '<span class="settings-row-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10h5M9.5 14h5"/></svg></span>' +
        '<span class="settings-row-label">硬币排行榜</span>' +
        '<span class="settings-row-value">' + (coinTotal ? pickemCoinsHTML() : "荣誉货币 · 暂无硬币") + "</span>" +
        '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>' +
      "</button>";
  }

  /* ---------- 交互：桶位选择器（底部 sheet）与淘汰赛点选 ---------- */

  var pickemSheetCtx = null; // { kind:"bucket"|"placement", evId, stageId, bucket?, field?, current }
  var pickemClearArmed = "";
  var pickemClearTimer = 0;

  function pickemStageByKey(key) {
    var sep = key.indexOf("##"); // 1.3.6 recKey 分隔符（自动赛事 id 含冒号）
    if (sep < 0) return null;
    var ev = pickemEventById(key.slice(0, sep));
    if (!ev) return null;
    var stageId = key.slice(sep + 2);
    for (var i = 0; i < ev.stages.length; i++) {
      if (ev.stages[i].id === stageId) return { ev: ev, stage: ev.stages[i] };
    }
    return null;
  }

  function renderPickemSheet() {
    var ctx = pickemSheetCtx;
    if (!ctx) return;
    var hit = pickemStageByKey(pickemRecKey(ctx.evId, ctx.stageId));
    if (!hit) return;
    var stage = hit.stage;
    if (ctx.kind === "placement") {
      renderPickemPlaceSheet(stage);
      return;
    }
    var bucket = pickemBucketByKey(stage, ctx.bucket);
    if (!bucket) return;
    var rec = pickemRec(ctx.evId, ctx.stageId);
    var picks = rec && rec.picks ? (rec.picks[ctx.bucket] || []) : [];
    $("#pickemSheetTitle").textContent = bucket.label;
    $("#pickemSheetMeta").textContent = "空位 " + Math.max(0, bucket.cap - picks.length) + "/" + bucket.cap +
      (ctx.current ? " · 点当前队伍可移出" : " · 点选队伍放入");
    var assigned = {};
    (pickemStageBuckets(stage) || []).forEach(function (b) {
      ((rec && rec.picks ? rec.picks[b.k] : []) || []).forEach(function (n) { if (n) assigned[n] = b; });
    });
    var list = stage.teams.slice().sort(function (a, b2) {
      var xa = assigned[a.name] ? 1 : 0;
      var xb = assigned[b2.name] ? 1 : 0;
      return xa - xb || (b2.w - a.w) || (a.l - b2.l);
    });
    var html = "";
    if (ctx.current) {
      html += '<button type="button" class="pickem-picker-row is-remove" data-pksel="__remove__"><span class="pickem-picker-name">移出「' + esc(ctx.current) + "」</span></button>";
    }
    list.forEach(function (t) {
      var inBucket = assigned[t.name];
      html += '<button type="button" class="pickem-picker-row' + (inBucket ? " is-assigned" : "") +
        (t.name === ctx.current ? " is-current" : "") + '" data-pksel="' + esc(t.name) + '">' +
        avatarHTML(t) +
        '<span class="pickem-picker-name">' + esc(t.name) + "</span>" +
        '<span class="pickem-picker-where">' + (inBucket ? "已在 " + esc(inBucket.label) : t.w + " 胜 " + t.l + " 负") + "</span>" +
        "</button>";
    });
    $("#pickemSheetList").innerHTML = html;
  }

  /** 名次选择列表（placement）：标注三个名次的占用情况；选择时互异校验见 pickemSheetPick */
  function renderPickemPlaceSheet(stage) {
    var ctx = pickemSheetCtx;
    var rec = pickemRec(ctx.evId, ctx.stageId);
    var picks = rec && rec.picks ? rec.picks : {};
    var fieldLabel = { champion: "冠军", runnerUp: "亚军", third: "季军" };
    $("#pickemSheetTitle").textContent = "选择" + (fieldLabel[ctx.field] || "名次");
    $("#pickemSheetMeta").textContent = ctx.current ? "点当前队伍可清空该名次" : "点选队伍（各名次不能同队）";
    var used = {};
    PLACEMENT_FIELDS.forEach(function (f) {
      if (f.k !== ctx.field && picks[f.k]) used[picks[f.k]] = f.label;
    });
    var list = stage.teams.slice().sort(function (a, b) {
      var xa = used[a.name] ? 1 : 0, xb = used[b.name] ? 1 : 0;
      return xa - xb || (b.l - a.l);
    });
    var html = "";
    if (ctx.current) {
      html += '<button type="button" class="pickem-picker-row is-remove" data-pksel="__remove__"><span class="pickem-picker-name">清空该名次</span></button>';
    }
    list.forEach(function (t) {
      html += '<button type="button" class="pickem-picker-row' + (used[t.name] ? " is-assigned" : "") +
        (t.name === ctx.current ? " is-current" : "") + '" data-pksel="' + esc(t.name) + '">' +
        avatarHTML(t) +
        '<span class="pickem-picker-name">' + esc(t.name) + "</span>" +
        '<span class="pickem-picker-where">' + (used[t.name] ? "已选为 " + esc(used[t.name]) : "") + "</span>" +
        "</button>";
    });
    $("#pickemSheetList").innerHTML = html;
  }

  function openPickemPicker(evId, stageId, bucketKey, current) {
    pickemSheetCtx = { kind: "bucket", evId: evId, stageId: stageId, bucket: bucketKey, current: current || "" };
    renderPickemSheet();
    $("#pickemSheet").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function openPickemPlacePicker(evId, stageId, field, current) {
    pickemSheetCtx = { kind: "placement", evId: evId, stageId: stageId, field: field, current: current || "" };
    renderPickemSheet();
    $("#pickemSheet").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closePickemSheet() {
    var el = $("#pickemSheet");
    if (el) el.hidden = true;
    pickemSheetCtx = null;
    document.body.style.overflow = "";
  }

  function pickemSheetPick(name) {
    var ctx = pickemSheetCtx;
    if (!ctx) return;
    var hit = pickemStageByKey(pickemRecKey(ctx.evId, ctx.stageId));
    if (!hit) { closePickemSheet(); return; }
    var stage = hit.stage;
    var rec = pickemEnsureRec(stage, ctx.evId, ctx.stageId);
    if (ctx.kind === "placement") {
      // 名次选择：清空当前 / 互异校验（冠军≠亚军≠季军）
      if (name === "__remove__") {
        rec.picks[ctx.field] = "";
      } else {
        for (var i = 0; i < PLACEMENT_FIELDS.length; i++) {
          var f = PLACEMENT_FIELDS[i];
          if (f.k !== ctx.field && rec.picks[f.k] === name) {
            toast("该队已选为「" + f.label + "」——各名次不能同队");
            return;
          }
        }
        rec.picks[ctx.field] = name;
      }
      rec.pickedAt = Date.now();
      saveState();
      renderPickem();
      closePickemSheet();
      return;
    }
    var bucket = pickemBucketByKey(stage, ctx.bucket);
    if (!bucket) { closePickemSheet(); return; }
    var rec = pickemEnsureRec(stage, ctx.evId, ctx.stageId);
    if (name === "__remove__") {
      var arr = rec.picks[ctx.bucket] || [];
      var i = arr.indexOf(ctx.current);
      if (i >= 0) arr.splice(i, 1);
    } else {
      // 先从所有桶移除（同队只能在一个桶），再放进当前桶（替换 current 语义）
      (pickemStageBuckets(stage) || []).forEach(function (b) {
        var list = rec.picks[b.k];
        if (!list) return;
        var j = list.indexOf(name);
        if (j >= 0) list.splice(j, 1);
      });
      var arr2 = rec.picks[ctx.bucket] || (rec.picks[ctx.bucket] = []);
      var cur = arr2.indexOf(ctx.current);
      if (cur >= 0) arr2.splice(cur, 1);
      if (arr2.length >= bucket.cap) {
        toast("「" + bucket.label + "」已满（" + bucket.cap + " 支）");
        renderPickemSheet();
        return;
      }
      arr2.push(name);
    }
    rec.pickedAt = Date.now();
    saveState();
    renderPickem();
    closePickemSheet();
  }

  function pickemBracketPick(evId, stageId, matchId, side) {
    var hit = pickemStageByKey(pickemRecKey(evId, stageId));
    if (!hit) return;
    var stage = hit.stage;
    var m = null;
    stage.matches.forEach(function (x) { if (x.id === matchId) m = x; });
    if (!m) return;
    var start = new Date(m.startAt).getTime();
    // 已结束/已截止的点击给明确反馈（1.3.5：按钮不再 disabled，靠 toast 说明为什么不能改）
    if (m.winner) {
      toast("该场已结束，赛果 " + (m.score || "") + " · 胜 " + (m.winner === "A" ? m.a : m.b));
      return;
    }
    if (m.canceled) {
      toast("该场已取消（弃赛/轮空），不计入竞猜");
      return;
    }
    if (isNaN(start) || Date.now() >= start - PICKEM_DEADLINE_MS) {
      toast("该场竞猜已于开赛前 1 小时截止");
      renderPickem();
      return;
    }
    var rec = pickemEnsureRec(stage, evId, stageId);
    rec.picks.w[matchId] = side;
    rec.pickedAt = Date.now();
    saveState();
    renderPickem();
  }

  function pickemClearStage(evId, stageId) {
    var key = pickemRecKey(evId, stageId);
    if (pickemClearArmed !== key) {
      pickemClearArmed = key;
      clearTimeout(pickemClearTimer);
      pickemClearTimer = setTimeout(function () { pickemClearArmed = ""; renderPickem(); }, 3000);
      toast("再点一次「清空重选」确认");
      var btn = document.querySelector('[data-pstage="' + key + '"] [data-pkact="clear"]');
      if (btn) btn.textContent = "再点一次确认";
      return;
    }
    pickemClearArmed = "";
    clearTimeout(pickemClearTimer);
    delete state.pickem[key];
    saveState();
    renderPickem();
    toast("已清空该阶段选择");
  }

  function bindPickem() {
    $("#labsList").addEventListener("click", function (e) {
      var row = e.target.closest("[data-labs]");
      if (row && row.dataset.labs) {
        if (row.dataset.labs === "pickem") pickemScoped = false; // 实验功能入口=完整列表（主页「BLAST 作业」才是公测直入口）
        switchView(row.dataset.labs);
      }
    });
    $("#labsBackBtn").addEventListener("click", function () { goBack("about"); });
    $("#coinboardBackBtn").addEventListener("click", function () { goBack("labs"); });
    $("#pickemBackBtn").addEventListener("click", function () { goBack("labs"); });
    // 作业页筛选与搜索（1.3.6，仿主页）：搜索防抖 + 游戏 tiles + 清空
    $("#pickemSearch").addEventListener("input", function () {
      var el = this;
      $("#pickemSearchClear").hidden = !el.value;
      clearTimeout(pickemSearchTimer);
      pickemSearchTimer = setTimeout(function () { pickemQuery = el.value; renderPickem(); }, 250);
    });
    $("#pickemSearchClear").addEventListener("click", function () {
      $("#pickemSearch").value = "";
      pickemQuery = "";
      this.hidden = true;
      renderPickem();
    });
    // 作业页选择器（1.3.12 主页同款模式）：胶囊按钮开关浮层；浮层内行选择后关闭并重渲染
    $("#pickemGameSelectBtn").addEventListener("click", function () {
      var pop = $("#pickemGamePopover");
      var open = pop.hidden;
      $("#pickemEvPopover").hidden = true;
      $("#pickemEvSelectBtn").setAttribute("aria-expanded", "false");
      pop.hidden = !open;
      this.setAttribute("aria-expanded", String(open));
      if (open) renderPickem(); // 打开时刷新计数
    });
    $("#pickemEvSelectBtn").addEventListener("click", function () {
      var pop = $("#pickemEvPopover");
      var open = pop.hidden;
      $("#pickemGamePopover").hidden = true;
      $("#pickemGameSelectBtn").setAttribute("aria-expanded", "false");
      pop.hidden = !open;
      this.setAttribute("aria-expanded", String(open));
      if (open) renderPickem();
    });
    $("#pickemGameGrid").addEventListener("click", function (e) {
      var b = e.target.closest("[data-pkg]");
      if (!b) return;
      var changed = b.dataset.pkg !== pickemGame;
      pickemGame = b.dataset.pkg;
      $("#pickemGamePopover").hidden = true;
      $("#pickemGameSelectBtn").setAttribute("aria-expanded", "false");
      if (changed) renderPickem();
    });
    $("#pickemEvList").addEventListener("click", function (e) {
      var t = e.target.closest("[data-pevt]");
      if (!t) return;
      var changed = t.dataset.pevt !== pickemEventId;
      pickemEventId = t.dataset.pevt;
      $("#pickemEvPopover").hidden = true;
      $("#pickemEvSelectBtn").setAttribute("aria-expanded", "false");
      if (changed) renderPickem();
    });
    $("#pickemBody").addEventListener("click", function (e) {
      // 轮次/淘汰赛阶段折叠（1.3.8）：点头部翻转显隐并记录覆盖（直接 DOM 翻转，不整页重渲染）
      var dayT = e.target.closest("[data-pkday]");
      if (dayT) {
        var dk = dayT.dataset.pkday;
        var body = document.querySelector('[data-daybody="' + dk + '"]');
        if (body) {
          var wasHidden = body.hasAttribute("hidden");
          pickemCollapseOverrides[dk] = !wasHidden; // 展开态点击→收起；收起态点击→展开
          if (wasHidden) body.removeAttribute("hidden"); else body.setAttribute("hidden", "");
          var chev = dayT.querySelector(".pk-chev");
          if (chev) chev.textContent = wasHidden ? "▾" : "▸";
        }
        return;
      }
      var stageT = e.target.closest("[data-pkstage]");
      if (stageT) {
        var sk = stageT.dataset.pkstage;
        var sbody = document.querySelector('[data-stagebody="' + sk + '"]');
        if (sbody) {
          var sw = sbody.hasAttribute("hidden");
          pickemCollapseOverrides[sk] = !sw;
          if (sw) sbody.removeAttribute("hidden"); else sbody.setAttribute("hidden", "");
          var chev2 = stageT.querySelector(".pk-chev");
          if (chev2) chev2.textContent = sw ? "▾" : "▸";
        }
        return;
      }
      // recKey 分隔符 = "##"（1.3.6：自动赛事 id "auto:XXX" 含冒号，":" 拆分会错位）
      var place = e.target.closest("[data-pkplace]");
      if (place) {
        var pbox = place.closest("[data-pstage]");
        if (!pbox) return;
        var pkey = pbox.dataset.pstage;
        var psep = pkey.indexOf("##");
        if (place.dataset.pklocked) {
          toast("该阶段已于第一场开赛前 1 小时截止");
          return;
        }
        openPickemPlacePicker(pkey.slice(0, psep), pkey.slice(psep + 2), place.dataset.pkplace, place.dataset.pkcur || "");
        return;
      }
      var slot = e.target.closest("[data-pkslot]");
      if (slot) {
        var box = slot.closest("[data-pstage]");
        if (!box) return;
        var key = box.dataset.pstage;
        var sep = key.indexOf("##");
        if (slot.dataset.pklocked) {
          // 已截止/已结束阶段的槽位：给明确反馈而不是无反应（1.3.5）
          var lockedHit = pickemStageByKey(key);
          toast(lockedHit && stageAllDone(lockedHit.stage) ? "该阶段已结束" : "该阶段已于开赛前 1 小时截止");
          return;
        }
        openPickemPicker(key.slice(0, sep), key.slice(sep + 2), slot.dataset.pkslot, slot.dataset.pkcur || "");
        return;
      }
      var pick = e.target.closest("[data-pkmatch]");
      if (pick) {
        var mbox = pick.closest("[data-pstage]");
        if (!mbox) return;
        var mkey = mbox.dataset.pstage;
        var msep = mkey.indexOf("##");
        pickemBracketPick(mkey.slice(0, msep), mkey.slice(msep + 2), pick.dataset.pkmatch, pick.dataset.pkside);
        return;
      }
      var act = e.target.closest("[data-pkact]");
      if (act && act.dataset.pkact === "clear") {
        var cbox = act.closest("[data-pstage]");
        if (!cbox) return;
        var ckey = cbox.dataset.pstage;
        var csep = ckey.indexOf("##");
        pickemClearStage(ckey.slice(0, csep), ckey.slice(csep + 2));
      }
    });
    $("#pickemSheetClose").addEventListener("click", closePickemSheet);
    $("#pickemSheet").addEventListener("click", function (e) {
      if (e.target === $("#pickemSheet")) { closePickemSheet(); return; }
      var row = e.target.closest("[data-pksel]");
      if (row) pickemSheetPick(row.dataset.pksel);
    });
  }

  /* ---------- 硬币排行榜（1.3.5 实验功能：魔神殿榜位复用，旧条目编码过滤） ---------- */
  var coinBoardCache = null;
  var coinBoardLoading = false;

  function syncCoinBoard() {
    var coins = state.pickemCoins || { c: 0, s: 0, g: 0, d: 0 };
    if (!((coins.c || 0) + (coins.s || 0) + (coins.g || 0) + (coins.d || 0))) return;
    Promise.all([loadHbProfile().catch(function () { return null; }), loadNick()]).then(function (r) {
      var hb = r[0];
      var nick = (hb && hb.nick) || r[1] || "";
      var avatar = (hb && hb.avatar) || "";
      // extra 门控与胜败榜同构（mt 传纯队名；undefined=沿用榜上旧值）
      return Cloud.submitCoinBoard(coins, nick, avatar,
        state.title,
        state.mainTeam === undefined ? undefined : state.mainTeam === "" ? "" : mainTeamName(),
        state.mainTeam === undefined ? undefined : mainTeamLevel(state.mainLevels[state.mainTeam] || 0));
    }).catch(function () { /* 硬币榜实验功能：失败静默，下次结算/进入时再推 */ });
  }

  function coinBoardRowHTML(e, i) {
    var c = e.coins || { c: 0, s: 0, g: 0, d: 0 };
    return '<div class="board-row' + (e.isMe ? " is-me" : "") + '">' +
      '<span class="board-rank">' + (i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1) + "</span>" +
      personAvatar(e.nick, e.avatar) +
      '<span class="board-nick-wrap">' +
        '<span class="board-nick">' + esc(e.nick) + (e.isMe ? '<span class="me-tag">我</span>' : "") + "</span>" +
      "</span>" +
      '<span class="board-detail"><span class="board-coins">' +
        PICKEM_COINS.d.icon + " " + c.d + " · " + PICKEM_COINS.g.icon + " " + c.g + " · " +
        PICKEM_COINS.s.icon + " " + c.s + " · " + PICKEM_COINS.c.icon + " " + c.c +
      "</span></span>" +
    "</div>";
  }

  function paintCoinBoard(res) {
    var body = $("#coinboardBody");
    if (!body) return;
    var list = (res && res.entries) || [];
    if (!list.length) {
      body.innerHTML = '<div class="empty-state"><strong>还没有人上榜</strong>在赛事竞猜里猜对就能获得硬币（铜/银/金/钻石）</div>';
      return;
    }
    body.innerHTML =
      '<div class="settings-group"><div class="pickem-coin has" style="margin:0 0 10px">我的硬币：' +
        (pickemCoinsHTML() || "暂无 · 去赛事竞猜猜对拿币") + "</div></div>" +
      list.map(coinBoardRowHTML).join("") +
      '<p class="data-note">硬币为荣誉奖励：不可交易、不可作为压注 · 数据来自赛事竞猜结算</p>';
  }

  function renderCoinBoard() {
    var body = $("#coinboardBody");
    if (!body) return;
    if (coinBoardCache) paintCoinBoard(coinBoardCache);
    else body.innerHTML = '<div class="empty-state"><strong>加载中…</strong></div>';
    if (coinBoardLoading) return;
    coinBoardLoading = true;
    syncCoinBoard(); // 进入页面顺路推一次（昵称/头像变化也能刷上硬币榜）
    Cloud.getCoinBoard(100).then(function (res) {
      coinBoardCache = res;
      coinBoardLoading = false;
      paintCoinBoard(res);
    }).catch(function () {
      coinBoardLoading = false;
      body.innerHTML = '<div class="empty-state"><strong>暂时读不到硬币排行榜</strong>稍后再试（未登录/宿主不支持时不可用）</div>';
    });
  }

  /* ---------- 战队图鉴（押过的队伍 + 跟队连击；纯本地养成，随战绩云同步跨设备） ---------- */
  var codexExpanded = false;
  var CODEX_PREVIEW = 24; // 网格默认展示数，其余折叠进「展开全部」

  function codexEntryHTML(t) {
    var sub = (t.w + t.l) > 0 ? "胜率 " + t.rate + "%" : "押过 " + t.b + " 场";
    var isMain = t.key === state.mainTeam;
    return (
      '<button type="button" class="codex-cell' + (isMain ? " is-main" : "") + '" data-team-key="' + esc(t.key) + '">' +
        avatarHTML({ name: t.name }) +
        '<span class="codex-name">' + (isMain ? '<span class="codex-fav">❤</span>' : "") + esc(t.name) + "</span>" +
        '<span class="codex-meta">' + esc(gameMeta(t.game).label) + " · " + esc(sub) + "</span>" +
      "</button>"
    );
  }

  function renderCodex() {
    var codex = collectionSummary(state.collection);
    $("#codexSub").textContent = "押过 " + codex.teams + " 支队 · 最佳跟队 " + codex.bestStreak + " 连";
    var mainChip = $("#codexMainChip");
    if (state.mainTeam) {
      var mainEntry = codex.list.filter(function (t) { return t.key === state.mainTeam; })[0];
      mainChip.hidden = false;
      mainChip.textContent = "❤ 主队 · " + (mainEntry ? mainEntry.name : mainTeamName());
    } else {
      mainChip.hidden = true;
    }
    var gridEl = $("#codexGrid");
    var toggleEl = $("#codexToggle");
    var topEl = $("#codexTop");
    if (!codex.teams) {
      topEl.hidden = true;
      gridEl.innerHTML = '<div class="codex-empty">押过一支队伍就会在这里点亮 · 连续跟同一支队连胜场还会记「跟队连击」</div>';
      toggleEl.hidden = true;
      return;
    }
    topEl.hidden = codex.top.length === 0;
    topEl.innerHTML = codex.top.map(function (t) {
      var badge = t.s > 0 ? t.s + " 连" : "最佳 " + t.bs + " 连";
      var meta = gameMeta(t.game).label + (t.rate != null ? " · 胜率 " + t.rate + "%" : "");
      return (
        '<button type="button" class="codex-top-cell" data-team-key="' + esc(t.key) + '">' +
          "<b>" + badge + "</b>" +
          '<span class="codex-top-name">' + esc(t.name) + "</span>" +
          '<span class="codex-top-meta">' + esc(meta) + "</span>" +
        "</div>"
      );
    }).join("");
    // 主队置顶，其余按最近互动
    var listSorted = codex.list.slice().sort(function (x, y) {
      var xm = x.key === state.mainTeam ? 1 : 0;
      var ym = y.key === state.mainTeam ? 1 : 0;
      return (ym - xm) || ((y.ls || 0) - (x.ls || 0));
    });
    var shown = codexExpanded ? listSorted : listSorted.slice(0, CODEX_PREVIEW);
    gridEl.innerHTML = shown.map(codexEntryHTML).join("");
    toggleEl.hidden = codex.list.length <= CODEX_PREVIEW;
    toggleEl.textContent = codexExpanded ? "收起" : "展开全部 " + codex.list.length + " 支";
  }

  /* ---------- 战队资料页（1.2.9：图鉴单元格/比赛卡片队伍行入口，全部现算零新存储） ---------- */
  var currentTeamKey = "";
  var teamFromView = "profile";

  function openTeamPage(key, fromView) {
    if (!key || key.indexOf(":") < 1) return;
    currentTeamKey = key;
    teamFromView = fromView || "profile";
    switchView("team");
  }

  function teamStatCell(v, label) {
    return '<div class="stat-cell"><span class="stat-value">' + esc(String(v)) + '</span><span class="stat-label">' + esc(label) + "</span></div>";
  }

  function renderTeamPage() {
    var sep = currentTeamKey.indexOf(":");
    var game = sep > 0 ? currentTeamKey.slice(0, sep) : "";
    var name = sep > 0 ? currentTeamKey.slice(sep + 1) : currentTeamKey;
    $("#teamPageTitle").textContent = name;

    var isMain = state.mainTeam === currentTeamKey;
    var mlv = state.mainLevels[currentTeamKey] || 0;
    var lv = mainTeamLevel(mlv);
    var lvLine = "";
    if (mlv >= 1) {
      lvLine = (isMain ? "主队" : "曾主队") + " Lv." + lv +
        (lv >= MAIN_LEVEL_THRESHOLDS.length ? " · 满级 🏆" : " · 距 Lv." + (lv + 1) + " 还差 " + (MAIN_LEVEL_THRESHOLDS[lv] - mlv) + " 场");
    }
    $("#teamHero").innerHTML =
      '<div class="team-hero-card' + (isMain ? " is-main" : "") + '">' +
        avatarHTML({ name: name }) +
        '<span class="team-hero-main"><b>' + esc(name) + "</b>" +
          '<span class="team-hero-sub">' + esc(gameMeta(game).label) + " · 数据窗口 45 天</span>" +
          (lvLine ? '<span class="team-hero-lv">' + esc(lvLine) + "</span>" : "") +
        "</span>" +
        (lv >= 1 ? '<span class="team-lv-badge">Lv.' + lv + "</span>" : "") +
        '<button type="button" class="team-main-btn' + (isMain ? " is-main" : "") + '" id="teamMainBtn">' +
          (isMain ? "❤ 已是主队" : "❤ 设为主队") + "</button>" +
      "</div>";

    var hist = teamHistory(MATCHES, game, name, Date.now(), matchDurationMs);
    var codex = state.collection[currentTeamKey];

    var html = "";
    // 战队选手阵容（1.3.2）：PandaScore 花名册（键 game:name，规避同名不同游戏队）；数组形状，无数据整块隐藏。
    // 2026-11-14 二次修订：选手照片移除（用户拍板），但纯文本行被审核判「展示要求」——
    // 恢复首字圆形徽标（非照片，avatarStyle 中性色块）保证观感完整；点击仍开选手卡
    var rosterPlayers = ROSTERS[currentTeamKey];
    if (Array.isArray(rosterPlayers) && rosterPlayers.length) {
      html += '<div class="section-head"><h2>阵容</h2><span class="section-sub">点选手看详情 · 公开赛果平台数据</span></div>' +
        '<div class="roster-list">' + rosterPlayers.map(function (p, pi) {
          var role = p.r ? (ROLE_LABELS[p.r.toLowerCase()] || p.r) : "";
          var realName = [p.fn, p.ln].filter(Boolean).join(" ");
          return '<div class="roster-row" data-player="' + pi + '" role="button">' +
            playerAvatarHTML(p) +
            '<span class="roster-main">' +
              '<b class="roster-name">' + esc(p.n) + "</b>" +
              '<span class="roster-meta">' +
                (p.l ? '<span class="roster-nat">' + esc(p.l.toUpperCase()) + "</span>" : '<span class="roster-nat roster-nat-none">–</span>') +
                (role ? '<span class="roster-role">' + esc(role) + "</span>" : "") +
                (realName ? '<span class="player-real-inline">' + esc(realName) + "</span>" : "") +
              "</span>" +
            "</span>" +
            '<span class="chevron roster-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>' +
          "</div>";
        }).join("") + "</div>";
    }
    if (codex) {
      var settledN = codex.w + codex.l;
      html += '<div class="section-head"><h2>我的跟队档案</h2></div>' +
        '<div class="stat-grid">' +
          teamStatCell(codex.b, "押过") +
          teamStatCell(settledN ? Math.round((codex.w / settledN) * 100) + "%" : "--", "胜率") +
          teamStatCell(codex.s, "当前连击") +
          teamStatCell(codex.bs, "最佳连击") +
        "</div>";
    }

    html += '<div class="section-head"><h2>近 45 天战绩</h2><span class="section-sub">' + hist.wins + " 胜 " + hist.losses + " 负</span></div>";
    if (!hist.recent.length) {
      html += '<div class="codex-empty">数据窗口内没有该队的比赛 · 它可能休赛，或已滚出 45 天窗口</div>';
    } else {
      html += '<div class="history-list">' + hist.recent.map(function (r) {
        var badge = r.won === null
          ? '<span class="history-badge pending">待</span>'
          : '<span class="history-badge ' + (r.won ? "won" : "lost") + '">' + (r.won ? "W" : "L") + "</span>";
        return (
          '<div class="history-item">' + badge +
            '<span class="history-main">' +
              '<span class="history-title">vs ' + esc(r.opponentName) + (r.score ? " · " + esc(r.score) : "") + "</span>" +
              '<span class="history-sub">' + esc(fmtTime(r.startAt)) + "</span>" +
            "</span>" +
          "</div>"
        );
      }).join("") + "</div>";
    }

    html += '<div class="section-head"><h2>未来赛程</h2><span class="section-sub">' + hist.upcoming.length + " 场</span></div>";
    if (!hist.upcoming.length) {
      html += '<div class="codex-empty">窗口内暂无该队的未来赛程</div>';
    } else {
      html += '<div class="history-list">' + hist.upcoming.map(function (u) {
        var m = matchById(u.id);
        var st = m ? statusOf(m) : "open";
        var stText = st === "open" ? "可竞猜" : st === "locked" ? "已截止" : "正在比赛";
        return (
          '<div class="history-item team-upcoming-row"' + (st === "open" ? ' data-open-match="' + esc(u.id) + '"' : "") + ">" +
            '<span class="status-chip ' + st + '">' + stText + "</span>" +
            '<span class="history-main">' +
              '<span class="history-title">vs ' + esc(u.opponentName) + "</span>" +
              '<span class="history-sub">' + esc(u.stage || "") + " · " + esc(fmtTime(u.startAt)) + "</span>" +
            "</span>" +
            (st === "open" ? '<span class="history-amount won">去竞猜 ›</span>' : "") +
          "</div>"
        );
      }).join("") + "</div>";
    }

    $("#teamBody").innerHTML = html;
  }

  /* ---------- 选手卡（2026-11-10 深度接入；2026-11-14 照片移除、首字徽标恢复）：阵容行点击 → 底部抽屉 ---------- */

  function playerAvatarHTML(p) {
    // 首字徽标（2026-11-14 恢复，非照片）：纯文本行被审核判「展示要求」——中性色圆形色块保证观感完整；
    // 照片打包管线已移除（照片基址常量与工具均已删除），roster.img 字段保留不消费。
    var initial = esc((p && p.n || "?").slice(0, 1));
    return '<span class="avatar player-avatar" style="' + avatarStyle(p ? p.n : "?") + '">' + initial + "</span>";
  }

  var playerSheetCtx = null; // {teamKey, idx}

  function closePlayerSheet() {
    var el = $("#playerSheet");
    if (el) el.hidden = true;
    playerSheetCtx = null;
    document.body.style.overflow = "";
  }

  function openPlayerSheet(teamKey, idx) {
    var roster = ROSTERS[teamKey];
    if (!roster || !roster[idx]) return;
    playerSheetCtx = { teamKey: teamKey, idx: idx };
    var p = roster[idx];
    var sep = teamKey.indexOf(":");
    var game = teamKey.slice(0, sep), teamName = teamKey.slice(sep + 1);
    var role = p.r ? (ROLE_LABELS[p.r.toLowerCase()] || p.r) : "";
    var realName = [p.fn, p.ln].filter(Boolean).join(" ");
    $("#playerSheetTitle").textContent = p.n;
    $("#playerSheetMeta").textContent = gameMeta(game).label + " · " + teamName;

    // 该队近 5 场（MATCHES 直查，与战队资料页「近 45 天战绩」同数据源）
    var recentList = MATCHES.filter(function (m2) {
      return m2.game === game && ((m2.teamA && m2.teamA.name === teamName) || (m2.teamB && m2.teamB.name === teamName));
    }).sort(function (a, b) { return new Date(b.startAt) - new Date(a.startAt); }).slice(0, 5);
    var recent = recentList.map(function (m2) {
      var opp = m2.teamA.name === teamName ? m2.teamB.name : m2.teamA.name;
      var won = null, score = "";
      if (m2.result && (m2.result.winner === "A" || m2.result.winner === "B")) {
        score = m2.result.score || "";
        won = (m2.result.winner === "A" ? m2.teamA.name : m2.teamB.name) === teamName;
      }
      var badge = won === null
        ? '<span class="history-badge pending">…</span>'
        : '<span class="history-badge ' + (won ? "won" : "lost") + '">' + (won ? "W" : "L") + "</span>";
      return '<div class="history-item">' + badge +
        '<span class="history-main"><span class="history-title">vs ' + esc(opp) + (score ? " · " + esc(score) : "") + "</span>" +
        '<span class="history-sub">' + esc(fmtTime(m2.startAt)) + "</span></span></div>";
    }).join("");

    $("#playerSheetBody").innerHTML =
      '<div class="player-card">' +
        playerAvatarHTML(p) +
        '<div class="player-card-main"><b class="player-name">' + esc(p.n) + "</b>" +
          (realName ? '<span class="player-real">' + esc(realName) + "</span>" : "") +
          '<span class="player-tags">' +
            (p.l ? '<span class="roster-nat">' + esc(p.l.toUpperCase()) + "</span>" : "") +
            (role ? '<span class="roster-role">' + esc(role) + "</span>" : "") +
          "</span>" +
        "</div>" +
      "</div>" +
      '<div class="section-head"><h2>所属队伍</h2></div>' +
      '<div class="player-team-row">' + avatarHTML({ name: teamName }) +
        '<span class="team-main"><span class="team-name">' + esc(teamName) + '</span><span class="team-sub">' + esc(gameMeta(game).label) + " · 数据窗口 45 天</span></span></div>" +
      '<div class="section-head"><h2>该队近况</h2><span class="section-sub">近 ' + recentList.length + " 场</span></div>" +
      (recentList.length ? '<div class="history-list">' + recent + "</div>" : '<div class="codex-empty">窗口内没有该队的比赛</div>');

    $("#playerSheet").hidden = false;
    document.body.style.overflow = "hidden";
  }

  /* ---------- 成就殿堂页（1.2.10：解锁卡片网格 + 称号装备） ---------- */
  function renderAchv() {
    var unlocked = state.achv || {};
    var count = 0;
    ACHV_DEFS.forEach(function (d) { if (unlocked[d.id]) count++; });
    $("#achvProgress").textContent = "已解锁 " + count + " / " + ACHV_DEFS.length;

    var groups = [];
    ACHV_DEFS.forEach(function (d) {
      var g = null;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].name === d.g) { g = groups[i]; break; }
      }
      if (!g) { g = { name: d.g, defs: [] }; groups.push(g); }
      g.defs.push(d);
    });

    var html = "";
    groups.forEach(function (g) {
      var defs = g.defs.slice().sort(function (a, b) {
        return (unlocked[b.id] || 0) - (unlocked[a.id] || 0); // 已解锁排前
      });
      html += '<div class="section-head"><h2>' + esc(g.name) + "</h2></div>";
      html += '<div class="achv-grid">' + defs.map(function (d) {
        var got = !!unlocked[d.id];
        var hidden = d.hidden && !got; // 隐藏成就解锁前只显示 🔒
        var equipped = state.title === d.id;
        var cls = "achv-card" + (got ? " is-got" : " is-locked") + (equipped ? " is-equipped" : "");
        var icon = hidden ? "🔒" : d.icon;
        var name = hidden ? "神秘成就" : d.name;
        var desc = hidden ? "继续探索沙盘，解锁它" : d.desc;
        var meta = got
          ? "已解锁 · " + new Date(unlocked[d.id]).toLocaleDateString() + (d.title ? " · 称号「" + d.title + "」" : "")
          : (hidden ? "隐藏成就" : "未解锁");
        return (
          '<button type="button" class="' + cls + '"' + (got ? ' data-title-achv="' + esc(d.id) + '"' : "") + ">" +
            '<span class="achv-icon">' + icon + "</span>" +
            '<span class="achv-main">' +
              "<b>" + esc(name) + (equipped ? '<span class="achv-equipped">已装备</span>' : "") + "</b>" +
              '<span class="achv-desc">' + esc(desc) + "</span>" +
              '<span class="achv-meta">' + esc(meta) + "</span>" +
            "</span>" +
          "</button>"
        );
      }).join("") + "</div>";
    });
    $("#achvList").innerHTML = html;
  }

  function toggleTitle(id) {
    var def = achvById(id);
    if (!def) return;
    state.title = state.title === id ? "" : id; // 再点一次 = 卸下（""=权威清空，走门控清掉榜上字段）
    saveState();
    renderAchv();
    if (!$("#view-profile").hidden) renderProfile();
    syncBoards(); // 称号变化经 submitBoardWithNick 门控自动 second+1（低频动作，不随连击刷）
    toast(state.title === id ? "已装备称号「" + def.title + "」" : "已卸下称号");
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
    var prevPick = existing ? existing.pick : null; // 图鉴改选迁移用：下注面板内的改选发生在 add/撤回分支
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
      if (sheetPick !== prevPick) {
        state.collection = onBet(state.collection, m, sheetPick, prevPick, MATCHES, predictionFor); // 改选：旧队断签、迁移收录
        trackMainLevelBet(m, sheetPick, prevPick); // 主队等级镜像迁移
      }
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
      if (sheetPick !== prevPick) {
        state.collection = onBet(state.collection, m, sheetPick, prevPick, MATCHES, predictionFor); // 改选：旧队断签、迁移收录
        trackMainLevelBet(m, sheetPick, prevPick); // 主队等级镜像迁移
      }
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
    // n1/n2/tn：队名与赛事快照——比赛滑出数据窗口后记录仍可读（全部竞猜记录页 1.2.15）
    state.predictions.push({
      matchId: m.id,
      pick: sheetPick,
      stake: amount,
      placedAt: Date.now(),
      settled: false,
      n1: m.teamA.name,
      n2: m.teamB.name,
      tn: m.tournament
    });
    state.collection = onBet(state.collection, m, sheetPick, null, MATCHES, predictionFor); // 图鉴收录 + 跟队连击检测
    trackMainLevelBet(m, sheetPick, null); // 主队等级：新押 +1（仅曾为主队的队伍在册）
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
      $("#boardMyScore").textContent = "转生荣誉已留档";
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
          (e.mainTeam ? '<span class="board-mt">' + avatarHTML({ name: e.mainTeam }) +
            (e.mtLevel >= 1 ? '<span class="board-mt-lv">Lv' + e.mtLevel + "</span>" : "") + "</span>" : "") +
          '<span class="board-nick-wrap">' +
            '<span class="board-nick">' + esc(nick) + (e.isMe ? '<span class="me-tag">我</span>' : "") + "</span>" +
            // 称号放昵称下方小字：同行 chip 会被 nowrap+ellipsis 截断（1.2.15）
            (e.title ? '<span class="board-title">' + esc(achvTitle(e.title) || "🏆") + "</span>" : "") +
          "</span>" +
          '<span class="board-detail">' +
            '<span class="board-first ' + (isWin ? "won" : "lost") + '">' + e.first + " 场</span>" +
            '<span class="board-second">' + (isWin ? "赚 " : "亏 ") + fmtCompact(e.second) + " 沙粒</span>" +
          "</span>" +
        "</div>"
      );
    }).join("");
  }

  /* 魔神殿页面已下线（1.3.5）：入口/视图/榜单页移除；转生仪式（庆祝页/重置）与本地荣誉计数保留，
     荣誉榜位复用为硬币排行榜（renderCoinBoard / Cloud.submitCoinBoard）。 */

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
      { label: "破产", mine: state.bankrupts || 0, theirs: versusData.b, better: "less" },
      // s/t 为 1.2.5 新增；旧版链接缺失时显示 --，不参与胜负
      { label: "跟队连击", mine: my.streak, theirs: versusData.s, better: "more" },
      { label: "图鉴队伍", mine: my.teams, theirs: versusData.t, better: "more" }
    ];
    $("#versusGrid").innerHTML = rows.map(function (r) {
      var comparable = r.mine != null && r.theirs != null;
      var mineWin = false, theirsWin = false;
      if (comparable && r.better === "more") { mineWin = r.mine > r.theirs; theirsWin = r.theirs > r.mine; }
      else if (comparable && r.better === "less") { mineWin = r.mine < r.theirs; theirsWin = r.theirs < r.mine; }
      var fmt = function (v) {
        if (v == null) return "--";
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
  function drawPersonAvatar(ctx, x, y, size, label, img, theme) {
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
      g.addColorStop(0, theme ? theme.soft : "#ffd08a");
      g.addColorStop(1, theme ? theme.accent : "#ff8a3d");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = theme ? theme.text : "#1a0e04";
      ctx.textAlign = "center";
      ctx.font = "800 " + Math.round(size * 0.4) + "px -apple-system, 'PingFang SC', sans-serif";
      ctx.fillText(String(label || "盒").slice(0, 1), x + size / 2, y + size / 2 + Math.round(size * 0.14));
    }
    ctx.restore();
  }

  // 分享卡队色（1.2.15）：有主队时给出深底可读的提亮变体——
  // 队色可能是石墨类暗色（Team Spirit #1e1e1e），直接上深底卡会隐身，亮度不足就向白混
  function shareThemeColors() {
    var colors = state.mainTeam ? TEAM_COLORS[mainTeamName()] : null;
    if (!colors || !colors[0]) return null;
    var c = hexToRgb(colors[0]);
    if (!c) return null;
    var lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    var accent = lum >= 110 ? colors[0] : mixHex(colors[0], "#ffffff", .45);
    if (!accent) return null;
    var a2 = hexToRgb(accent);
    var aLum = a2 ? 0.299 * a2.r + 0.587 * a2.g + 0.114 * a2.b : 255;
    return {
      accent: accent,
      soft: mixHex(accent, "#ffffff", .35) || accent,
      text: aLum > 150 ? "#1a0e04" : "#ffffff",
      rgb: c.r + ", " + c.g + ", " + c.b
    };
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
    var theme = shareThemeColors(); // 主队队色（可空）：品牌字/头像兜底/对阵卡描边跟随
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
    ctx.fillStyle = theme ? theme.accent : "#e9eef7";
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
    ctx.strokeStyle = theme ? "rgba(" + theme.rgb + ", .3)" : "rgba(255,255,255,.07)";
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
    drawPersonAvatar(ctx, 60, 652, 52, myNickCache || "我", avatarImg, theme);
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
    var codex = collectionSummary(state.collection);
    if (codex.teams) {
      metaLine += " · 押过 " + codex.teams + " 队 · 最长跟队 " + codex.bestStreak + " 连";
    }
    if (state.gods > 0 || state.bankrupts > 0) {
      metaLine += " · 封神 " + (state.gods || 0) + " · 破产 " + (state.bankrupts || 0);
    }
    ctx.fillText(fitCanvasText(ctx, metaLine, W - 120, 24, "500"), W / 2, 878);
  }

  var sharePred = null;

  /* dataURL → ArrayBuffer 视图的 Uint8Array（files.saveFile 的 writeBytes 契约要求） */
  function dataUrlToBytes(dataUrl) {
    var bin = atob(String(dataUrl).slice(String(dataUrl).indexOf(",") + 1));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /* 保存兜底（1.1.33 定稿）：卡片全屏展示 + 系统截屏——不依赖任何宿主能力 */
  function openCardFullscreen(dataUrl) {
    $("#cardFullImg").src = dataUrl;
    $("#cardFullscreen").hidden = false;
  }

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
    if (state.pickem === undefined || state.pickem === null || typeof state.pickem !== "object") state.pickem = {};
    state.pickem = normalizePickemState(state.pickem); // Pick'Em 记录形状兜底（脏记录整条丢弃）
    if (state.pickemCoins === undefined || state.pickemCoins === null || typeof state.pickemCoins !== "object") state.pickemCoins = { c: 0, s: 0, g: 0, d: 0 };
    state.pickemCoins = mergePickemCoins({ c: 0, s: 0, g: 0, d: 0 }, state.pickemCoins); // 硬币形状兜底（负数/脏值清零）
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

  /* 鸿蒙硬阻断/进入门已删（2026-11-11 清理）：1.1.x 遗留的 showHarmonyBlock（从未启用）与
   * runHarmonyGate 进入门（仅鸿蒙走的强制拉取门）——云存储 1.3.396+ 修复、网络全平台一致后，
   * boot 已统一走 maybeShowOnboard + refreshData（失败路径=数据加载失败空态），无平台分支。 */

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
  var HB_PROFILE_KEY = "esports_sandbox_hbprofile"; // 黑盒授权资料缓存（换票结果）：{appUserId,nick,avatar,via,at,ak?}
  var HB_SYNC_THROTTLE_MS = 60 * 1000; // 静默刷新节流：刚换过票的点击直接提示（防连点打 FC；正常刷新不受影响）

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
   *  已同步账号（2026-11-07 升级）：auth.login 已授权时宿主静默返回新 code（不弹窗）——
   *  点击 = 静默刷新最新昵称/头像（60s 节流防连点；FC 成本模型下单次 ≈0.00003 元）；
   *  静默刷新失败时保留原资料不降级。换账号后身份不匹配走完整授权流程。 */
  function syncHbProfile() {
    loadHbProfile().then(function (hb) {
      var matched = hbProfileMatchesIdentity(hb);
      if (matched && hb.at && Date.now() - hb.at < HB_SYNC_THROTTLE_MS) {
        toast("刚同步过" + (hb.nick ? "：" + hb.nick : "") + "，资料已是最新");
        return;
      }
      authLogin().then(function (login) {
        if (!login || login.error || !login.code) {
          if (login && login.error === "AUTHORIZATION_CANCELLED") toast(matched ? "已取消——保留现有同步资料" : "已取消授权");
          else if (login && login.error === "USER_GESTURE_REQUIRED") toast("请直接点击按钮触发授权");
          else if (matched) toast("刷新未完成（" + ((login && login.error) || "UNKNOWN") + "），已保留原资料");
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
              at: Date.now(),
              ak: (login && login.accountKey) || (hb && hb.ak) || undefined
            }).then(function () {
              toast(matched
                ? "已刷新黑盒资料" + (data.nickname ? "：" + data.nickname : "")
                : (data.nickname ? "已同步黑盒资料：" + data.nickname : "已同步身份（该账号未设置昵称）"));
              syncBoards(data.nickname || undefined); // 黑盒昵称优先随榜单 extra 提交
              renderSettings();
            });
          } else if (data && data.error === "invalid_grant") {
            toast(matched ? "授权码已失效——已保留原资料，请稍后再点一次" : "授权码已失效，请再点一次重新授权");
          } else if (data && (data.error === "HTTP_403" || data.error === "HTTP_404")) {
            toast("换票服务暂不可用（通道返回 " + data.error.replace("HTTP_", "") + "），稍后再试");
          } else if (matched && data && data.error) {
            toast("刷新未完成（" + data.error + "），已保留原资料");
          } else {
            toast("换票失败：" + ((data && data.error) || "UNKNOWN"));
          }
        }).catch(function (e) {
          toast(matched ? "刷新未完成（" + ((e && e.code) || "网络异常") + "），已保留原资料" : "换票失败：" + ((e && e.code) || "网络异常"));
        });
      });
    });
  }

  /** 切号检测（2026-11-07）：auth.getAccountState 免手势免权限，boot/回前台时静默比对
   *  hbprofile 里存的 accountKey——不一致（切号）或登录态失效就清掉旧资料并提示重同步。
   *  读取失败/旧宿主不支持 = 待确认，不动本地资料；旧缓存无 ak 不主动失效（静默刷新时补）。 */
  function checkAccountState() {
    getAccountState().then(function (st) {
      if (!st || st.error || !st.ok) return;
      if (!st.loggedIn) {
        invalidateHbProfile("小黑盒登录态已失效");
        return;
      }
      if (!st.accountKey) return;
      loadHbProfile().then(function (hb) {
        if (!hb) return; // 游客态无需检测
        if (hb.ak && st.accountKey !== hb.ak) invalidateHbProfile("检测到已切换小黑盒账号");
        // hb.ak 缺失（0.9.2 前缓存）：不误杀，等下次同步补 ak
      });
    }).catch(function () { /* 静默：诊断行与设置页状态兜底 */ });
  }

  function invalidateHbProfile(reason) {
    storageSet(HB_PROFILE_KEY, "").then(function () {
      toast(reason + "，请重新同步黑盒资料");
      if (!$("#view-settings").hidden) renderSettings();
    }).catch(function () { /* 存储失败保留原值，下次检测再试 */ });
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

    if (!$("#view-about").hidden) refreshFollowAuthor(); // 关注状态可变，每次进关于页重探（免弹框查询，代价低）

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
    return name === "rules" || name === "schedule" || name === "about" || name === "duels" || name === "versus" || name === "team" || name === "achv" || name === "codex" || name === "history" || name === "match" || name === "labs" || name === "pickem" || name === "coinboard";
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
    if (name === "rules" && prev !== "rules") {
      // 重新进入玩法说明总是回到分类菜单（详情内容即时丢弃）
      closeRulesTopic();
    }
    ["matches", "profile", "board", "settings", "rules", "schedule", "about", "duels", "versus", "team", "achv", "codex", "history", "match", "labs", "pickem", "coinboard"].forEach(function (v) {
      $("#view-" + v).hidden = v !== name;
    });
    // 对决记录/对比页/成就殿堂/战队图鉴/全部竞猜记录从「我的」侧进入返回回「我的」；
    // 战队资料页按来源高亮（图鉴进=我的，比赛卡进=赛事）；实验功能/赛事竞猜/硬币榜挂在「关于小程序」链上归设置 tab
    var tabName = name === "duels" || name === "versus" || name === "achv" || name === "codex" || name === "history" ? "profile"
        : name === "team" ? (teamFromView === "profile" ? "profile" : "matches")
          : (isSubPage ? "settings" : name);
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("is-active", t.dataset.view === tabName);
    });
    if (name === "matches" && matchesDirty) renderMatches();
    if (name === "profile") renderProfile();
    if (name === "board") { syncBoards(); renderBoard(); }
    if (name === "duels") renderDuels();
    if (name === "versus") renderVersus();
    if (name === "team") renderTeamPage();
    if (name === "achv") renderAchv();
    if (name === "codex") renderCodex();
    if (name === "history") renderHistoryFull();
    if (name === "match") renderMatchDetail();
    if (name === "labs") renderLabs();
    if (name === "pickem") renderPickem();
    if (name === "coinboard") renderCoinBoard();
    if (name === "settings" || isSubPage) renderSettings();
    if (name === "schedule") renderSchedule();
    currentView = name;
    if (!opts.fromHistory) syncHistory(prev, name);
  }

  /* ---------- 关注作者（1.2.7，user.getFollowStatus/requestFollowAuthor 免权限声明） ---------- */
  function refreshFollowAuthor() {
    var btn = $("#followAuthorBtn");
    getFollowStatus().then(function (res) {
      // 只有「未关注」才显示；已关注/本人/查询失败/旧宿主不支持一律隐藏
      btn.hidden = !(res && res.status === "notFollowing");
    }).catch(function () { btn.hidden = true; });
  }

  /* ============================== 玩法说明（分类菜单 → 二级详情） ============================== */
  /* sections 里的 p/li 为撰写受信内容，可含 <strong>；dataNote=true 的分类在文末追加数据来源署名 */
  var RULES_TOPICS = [
    {
      id: "intro", icon: "🚀", title: "新手入门", summary: "三步开始你的第一次竞猜",
      sections: [
        { h: "这是什么", p: "「赛事沙盘」是一个面向 CS2、瓦罗兰特、英雄联盟、Dota 2、王者荣耀、无畏契约、彩虹六号等主流电竞赛事胜负预测的<strong>娱乐模拟盘</strong>。用虚拟的「沙粒」对真实比赛的胜负进行竞猜，验证自己的赛况判断力。" },
        { h: "三步上手", ul: [
          "在「赛事」页挑一场<strong>可竞猜</strong>的比赛，点开竞猜面板",
          "选边站队、确定投入（初始沙粒 <strong>10,000</strong>）",
          "等比赛结束自动结算——猜对净赚一倍，猜错投入不退"
        ] },
        { h: "沙粒是什么", p: "沙粒是虚拟道具，无任何现实价值，不可充值、不可兑换、不可转让。输光了可以「采沙」补足，随时从头再来。" }
      ]
    },
    {
      id: "bet", icon: "🎯", title: "竞猜与投注", summary: "沙粒、杠杆、加注撤回与连对加成",
      sections: [
        { h: "基本规则", ul: [
          "初始 <strong>10,000 沙粒</strong>；每场比赛同时只持有一个预测",
          "开赛前 <strong>1 小时</strong>停止竞猜与修改（22:00 开赛的场次 21:00 截止）",
          "投入时立即扣除；猜对返还 <strong>2 倍投入</strong>（净赚 1 倍），猜错投入不退"
        ] },
        { h: "杠杆与负债", ul: [
          "沙粒为正时，单场最多投入<strong>当前沙粒的 2 倍</strong>（投入后可能立即负债）",
          "沙粒可以<strong>为负数</strong>，负债不影响继续竞猜",
          "归零或负债时只能选 <strong>10 / 100 / 1000 / 负债额</strong> 四档定额投入"
        ] },
        { h: "投入 / 加注 / 撤回", p: "同一场比赛的预测可以随时<strong>加注</strong>追加投入，或<strong>撤回</strong>部分投入（全撤等于取消预测）。想换队伍：把投入全部撤回后重新选择，或在加注/撤回时改选。" },
        { h: "连对加成", p: "连续猜对第 2 场起获得加成：<strong>+10% / +20% / +30% / +50%</strong>（封顶）。加成只作用于盈利部分，中断后从零重计。" }
      ]
    },
    {
      id: "dig", icon: "⛏", title: "采沙", summary: "少于 10,000 免费补足",
      sections: [
        { h: "补足机制", ul: [
          "沙粒少于 10,000 时（含负债），采沙会<strong>补足到 10,000</strong>",
          "沙粒不少于 10,000 时无需采沙，不会额外增加",
          "采沙只补足、不会清空任何预测；已采沙次数会被记录"
        ] },
        { h: "", warn: "沙盘里的沙粒永远可以再采，现实中没有「采沙」按钮。请理性看待赛事预测。" }
      ]
    },
    {
      id: "settle", icon: "🏁", title: "赛果与结算", summary: "什么时候结算、为什么显示待赛果", dataNote: true,
      sections: [
        { h: "自动结算", p: "比赛结束、赛果录入后，打开小程序会自动结算，无需手动操作。连对加成也在结算时一并计入。" },
        { h: "预计时长", p: "赛果按比赛赛制估算时长：BO1 约 1 小时、BO3 约 2.5 小时、BO5 约 4 小时、BO7 约 5.5 小时。超过预计时长还没出结果的场次会显示「待赛果」，赛果录入后照常结算。" },
        { h: "以官方为准", p: "赛果来自公开赛事数据，最终以赛事官方公布为准。" },
        { h: "全部竞猜记录", p: "「我的 → 竞猜记录 · 全部」可以看完整历史：进行中/待赛果单独分区，比赛滑出数据窗口的老记录以<strong>「已归档」</strong>展示（投入与盈亏永久保留）。" }
      ]
    },
    {
      id: "data", icon: "📅", title: "赛程与数据", summary: "数据多久更新、断网会怎样", dataNote: true,
      sections: [
        { h: "自动更新", p: "小程序每 <strong>5 分钟</strong>自动检查一次赛程更新，有变化才下载新数据；也可以在设置页手动「刷新数据」。" },
        { h: "断网兜底", p: "拉取失败时自动回退到最近一次缓存，再退到内置赛程快照——<strong>离线也能看赛程</strong>，恢复后自动续上。" },
        { h: "赛程表", p: "「设置 → 赛程表」收录过去与未来各 30 天的场次，支持按游戏筛选、搜索、只看大型赛事（S/A 级）。<strong>点任意一行</strong>可以打开这场比赛的详情：状态、时间、赛制、等级、对阵双方、比分与你的预测一目了然。主页顶部也有<strong>搜索框</strong>，直接搜队伍、赛事或日期。" }
      ]
    },
    {
      id: "detail", icon: "🔍", title: "比赛详情", summary: "一场比赛能看到的全部信息",
      sections: [
        { h: "怎么打开", p: "「赛程表」里点任意一行（或「设置 → 赛程表」），进入这场比赛的详情页。" },
        { h: "能看到什么", ul: [
          "对阵双方：队标、全名、缩写与所属赛区",
          "状态与时间：可竞猜 / 已截止 / 正在比赛 / 待赛果 / 已结算，开始时间、预计时长与结束时间",
          "比赛信息：赛制（BO1/BO3…）、赛事等级（S/A/B/C/D）、所属赛事与阶段、游戏项目",
          "进行中的比赛显示<strong>实时比分</strong>；多局比赛（BO3/BO5）显示<strong>局记分</strong>（逐局胜方与用时）",
          "已结束的比赛显示<strong>最终比分与胜方</strong>"
        ] },
        { h: "能做什么", ul: [
          "可竞猜的比赛可以<strong>直接去竞猜</strong>（已下注则管理加注）",
          "正在比赛且支持跳转的游戏可<strong>去围观</strong>（打开小黑盒游戏详情页）",
          "下过注的已结算比赛可以<strong>分享战报</strong>，赛程表行本身也可以照旧转发"
        ] },
        { h: "数据说明", p: "详情数据来自公开赛事数据平台（PandaScore）；电竞比赛没有「比赛场地」数据，队伍标注的是<strong>所属赛区/国家</strong>。最终赛果以赛事官方公布为准。" }
      ]
    },
    {
      id: "board", icon: "🏆", title: "排行榜", summary: "胜败榜怎么排、谁能上榜",
      sections: [
        { h: "两块榜", p: "<strong>胜榜</strong>比猜对的次数，次数相同比净赚的沙粒；<strong>败榜</strong>正好相反，比谁猜错的次数多。" },
        { h: "展示口径", ul: [
          "只展示<strong>有战绩</strong>的玩家（0 战绩不出现在榜上）",
          "榜单数据约 5 分钟刷新一次",
          "单项净赚超过 10 亿时按 10 亿封顶展示，防止数字失真"
        ] },
        { h: "昵称与头像", p: "同步黑盒资料或自选昵称后，榜上昵称即时更新；头像同样会显示在榜单上。" },
        { h: "称号展示", p: "在成就殿堂装备的<strong>称号</strong>会以小字显示在榜单昵称下方，长昵称也不会互相挤压；点「我的 → 成就殿堂」即可装备或卸下。" }
      ]
    },
    {
      id: "temple", icon: "⛩", title: "转生", summary: "±10 亿的重来机制（1.3.5 起无荣誉殿）",
      sections: [
        { h: "转生仪式", ul: [
          "沙粒余额涨到 <strong>+10 亿</strong>或跌到 <strong>-10 亿</strong>时，可以举行转生仪式",
          "效果：对应次数 +1、沙粒余额重置 10,000——<strong>累计战绩和图鉴永不重置</strong>",
          "仪式前置：需要没有未结算的竞猜（先等赛果或撤回）"
        ] },
        { h: "庆祝页", p: "首次达标会自动弹出全屏庆祝页（每轮一次）。" },
        { h: "功成身退", p: "转生者会暂时离开胜败榜，新一轮分数超过历史峰值时自动回归。" },
        { h: "魔神殿下线", warn: true, p: "1.3.5 起魔神殿页面与封神/破产总榜已下线（本地荣誉计数与转生机制保留）；荣誉榜位由<strong>硬币排行榜</strong>接替（见「赛事竞猜」与实验功能）。" }
      ]
    },
    {
      id: "duel", icon: "⚔", title: "好友对决", summary: "约战、锁仓与战报回传",
      sections: [
        { h: "怎么约", ul: [
          "先对某场比赛下注，再点竞猜面板的「<strong>⚔ 约战好友</strong>」生成约战链接（没有预测不能约战）",
          "确认弹窗里可以放一句<strong>狠话</strong>（12 字以内、可不填），它会随战书出现在对方的约战卡片上",
          "把链接发给好友（微信/QQ 等任意渠道），对方点开、下注应战即成立",
          "对方应战后会自动回传战报，你这边同步建立这场对决"
        ] },
        { h: "锁仓", p: "约战发出或应战成立后，该场投入<strong>锁定到竞猜截止</strong>，期间不可加注、不可撤回——保证双方判定基准唯一（以战书快照为准：同边算平、猜中者胜）。已发约战无法撤回，发出前确认弹窗会再次提醒。" },
        { h: "判定与沙粒", p: "对决只比<strong>预测对错</strong>：同边平、猜中胜、猜错负。双方沙粒各自按自己的预测正常结算，<strong>玩家之间没有任何沙粒转移</strong>。" },
        { h: "多人与重名", ul: [
          "同一条约战链接被多人点开 = 1 v N，各自独立成局",
          "每条链接带 4 位随机码，重名玩家（比如都叫「盒友」）不会互相覆盖",
          "路人打开回执且押过同一场，会按公开挑战在他们自己的记录里建账"
        ] },
        { h: "记录管理", p: "「我的 → 对决记录」查看全部对决：已发出的约战可再复制链接；败局有「再战一场」一键开新约战。对决记录只保存在本机。" }
      ]
    },
    {
      id: "pickem", icon: "🏆", title: "赛事竞猜", summary: "大型赛事整程竞猜与硬币奖励（实验功能）",
      sections: [
        { h: "怎么玩", ul: [
          "「设置 → 关于小程序 → <strong>实验功能</strong>」进入赛事竞猜",
          "瑞士轮阶段（小组赛）：共 <strong>10 项选择</strong>——猜哪些队 <strong>3:0 晋级（2 支）</strong>、哪些队 <strong>3:1/3:2 晋级（6 支）</strong>、哪些队 <strong>0:3 淘汰（2 支）</strong>，不用猜对局路线；1:3/2:3 淘汰的 6 队由剩余队伍自动落位，仅供展示",
          "双败小组赛（如 IEM）：逐场猜胜者，第 1/2/3 轮对应铜/银/金币",
          "淘汰赛：对阵确定后<strong>预测最终名次</strong>——冠军、亚军、季军各猜 1 队（季军=半决赛败者并列两队，猜中任一即对）"
        ] },
        { h: "截止与结算", p: "每阶段在<strong>第一场开赛前 1 小时</strong>截止（逐场竞猜则各场各自截止），截止前可随时修改；阶段全部打完后自动结算——猜进「3:0 晋级」的队伍要真以 3-0 出线才算对。" },
        { h: "硬币奖励", ul: [
          "按阶段/轮次分级：<strong>第 1 阶段（轮）猜对 1 项 = 🥉 铜币、第 2 = 🥈 银币、第 3 及以后 = 🥇 金币</strong>",
          "淘汰赛：<strong>猜中冠军 = 💎 钻石币</strong>，猜中亚军/季军各 = 🥇 金币",
          "硬币为<strong>荣誉奖励</strong>：不可交易、不可作为压注，只在硬币排行榜（实验功能内）展示"
        ] },
        { h: "实验功能", warn: true, p: "参赛名单与赛果以赛事官方公布为准；本功能为实验功能，可能随时调整或下线，奖励口径如有调整以当期页面说明为准。" }
      ]
    },
    {
      id: "codex", icon: "📖", title: "战队图鉴", summary: "押过的队伍、跟队连击与胜率",
      sections: [
        { h: "收录规则", p: "押过哪支队伍就点亮哪支，按游戏区分（同名战队在不同游戏各算一支）。每支队伍记录<strong>押过场次</strong>与<strong>已结算胜率</strong>（押它的场次的胜率）。" },
        { h: "跟队连击", p: "连续押中同一支队伍（按它的比赛顺序）会累积<strong>跟队连击</strong>：漏看一场、押了对手或改投都算中断；队伍休赛不断签。最佳连击永久留档，图鉴页展示你的跟队 top3。" },
        { h: "上限与同步", p: "图鉴上限 <strong>150 支</strong>，超出后按最久未跟的队伍淘汰。图鉴随战绩云同步跨设备，也出现在分享卡与战绩对比里。" },
        { h: "主队主题色", p: "在战队资料页「设为主队」后，整个小程序换上主队颜色：按钮、徽章、选中态、榜单高亮、余额卡甚至<strong>分享卡</strong>都会跟随；取消主队立即恢复默认配色。主队等级只跟累计押过场次走，换主队不清零。" },
        { h: "选手阵容", p: "战队资料页可以看<strong>选手阵容</strong>（职业 ID、位置、国籍），来自公开赛果平台——阵容变更以赛事官方公布为准；部分项目（如 CS2）没有位置数据，徽章会留空。" }
      ]
    },
    {
      id: "sync", icon: "☁", title: "战绩云同步", summary: "多台设备保持一致",
      sections: [
        { h: "同步范围", p: "登录同一小黑盒账号的多台设备自动同步：沙粒、竞猜记录、战队图鉴、转生荣誉。本地变化约 2.5 秒后推送到云端。" },
        { h: "冲突处理", p: "两台设备同时变化时以<strong>较新的一方</strong>为准，冲突自动恢复，无需手动处理。云端空间不足时优先丢最旧的已结算记录，<strong>未结算的竞猜永不丢</strong>。" },
        { h: "不支持的客户端", p: "个别客户端不支持云同步时，设置页会显示「当前客户端暂不支持」——本地功能完全不受影响。<strong>对决记录只存本机，不同步</strong>。" }
      ]
    },
    {
      id: "account", icon: "👤", title: "账号与设置", summary: "昵称头像、主题与清除数据",
      sections: [
        { h: "身份", p: "无需任何授权即可开始游戏（自动获得隔离的榜单身份）。想展示小黑盒昵称和头像，用设置页的「<strong>同步黑盒资料</strong>」一次性授权完成；之后再次点击会在后台静默刷新最新昵称和头像（不再弹窗）。切换小黑盒账号后会自动检测并提示重新同步。" },
        { h: "昵称与头像", p: "「展示昵称」随时可改，修改后榜单即时更新；同步拿到的头像会显示在榜单、对决卡、图鉴与战报卡。" },
        { h: "外观主题", p: "设置页可切换<strong>深色 / 浅色 / 跟随系统</strong>，选择会记住。" },
        { h: "清除本地数据", p: "「关于小程序」里的「清除本地数据」会重置本机所有记录（含引导与图鉴）。云端数据不受影响——下次打开会自动拉回。" }
      ]
    },
    {
      id: "share", icon: "🔗", title: "分享与链接", summary: "战报卡、深链与晒战绩",
      sections: [
        { h: "战报卡", p: "每场已结算的竞猜都能生成战报卡。点「保存图片」会弹出系统保存界面，直接<strong>存成图片文件</strong>（在文件管理里查看）；宿主不支持时自动改为全屏预览，<strong>用系统截屏</strong>（电源键 + 音量键）保存。卡片底部预留了分享水印区。" },
        { h: "转发与深链", p: "竞猜面板支持转发和复制链接，好友点开直达那场比赛并高亮。" },
        { h: "晒战绩", p: "「我的 → 晒战绩」生成对比链接，好友点开直接开比：已结算、猜对、总盈亏、封神、破产、<strong>跟队连击、图鉴队伍</strong>七项，优方高亮。" }
      ]
    },
    {
      id: "safety", icon: "🛡", title: "安全与合规", summary: "虚拟道具声明与理性娱乐", dataNote: true,
      sections: [
        { h: "虚拟道具声明", safe: true, p: "沙粒为虚拟道具，无任何现实价值，<strong>不可充值、不可兑换、不可转让</strong>，不涉及真实货币。" },
        { h: "服务边界", p: "本应用仅提供赛事胜负预测的娱乐与练习功能，<strong>不提供任何形式的赌博或博彩服务</strong>；玩家之间没有任何资金或道具往来。" },
        { h: "数据来源", p: "赛程与赛果来自公开赛事数据平台（PandaScore 等），仅供娱乐参考，最终以赛事官方公布为准。" }
      ]
    }
  ];

  var rulesTopic = "";

  function renderRulesMenu() {
    $("#rulesMenuList").innerHTML = RULES_TOPICS.map(function (t) {
      return (
        '<button class="rules-menu-item" type="button" data-topic="' + t.id + '">' +
          '<span class="rules-menu-icon" aria-hidden="true">' + t.icon + "</span>" +
          '<span class="rules-menu-main"><b>' + esc(t.title) + "</b><span>" + esc(t.summary) + "</span></span>" +
          '<svg class="rules-menu-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>' +
        "</button>"
      );
    }).join("");
  }

  function openRulesTopic(id) {
    var t = null;
    for (var i = 0; i < RULES_TOPICS.length; i++) {
      if (RULES_TOPICS[i].id === id) { t = RULES_TOPICS[i]; break; }
    }
    if (!t) return;
    rulesTopic = id;
    $("#rulesTitle").textContent = t.title;
    $("#rulesMenu").hidden = true;
    var detail = $("#rulesDetail");
    detail.innerHTML = t.sections.map(function (sec) {
      var html = '<div class="rule-block' + (sec.safe ? " rule-safe" : "") + '">';
      if (sec.h) html += "<h2>" + esc(sec.h) + "</h2>";
      if (sec.p) html += "<p>" + sec.p + "</p>";
      if (sec.ul) html += "<ul>" + sec.ul.map(function (li) { return "<li>" + li + "</li>"; }).join("") + "</ul>";
      if (sec.warn) html += '<p class="rule-warn">' + sec.warn + "</p>";
      return html + "</div>";
    }).join("") +
      (t.dataNote ? '<p class="data-note">赛事数据来自公开赛果平台（PandaScore 等），仅供娱乐参考，以官方公布为准。</p>' : "");
    detail.hidden = false;
    window.scrollTo(0, 0);
  }

  function closeRulesTopic() {
    if (!rulesTopic) return;
    rulesTopic = "";
    $("#rulesTitle").textContent = "玩法说明";
    $("#rulesMenu").hidden = false;
    var detail = $("#rulesDetail");
    detail.hidden = true;
    detail.innerHTML = ""; // 详情内容即时丢弃，避免长文档滞留 DOM
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
      // 「去围观」小徽标：直接跳游戏详情页，不进竞猜面板
      var watch = e.target.closest(".watch-chip[data-watch]");
      if (watch) {
        var watchAppId = WATCH_GAME_APPIDS[watch.dataset.watch];
        if (watchAppId) {
          openAppPage({ target: "game_detail", appId: watchAppId, gameType: "pc", page: "game", hSrc: "miniprogram-esports-sandbox" })
            .then(function (res) {
              if (res && res.error) toast("当前客户端不支持跳转");
            });
        }
        return;
      }
      // 非 open 卡片的队伍行 → 战队资料页
      var teamCell = e.target.closest(".team-row[data-team-key]");
      if (teamCell) {
        openTeamPage(teamCell.dataset.teamKey, "matches");
        return;
      }
      var row = e.target.closest(".team-row[data-match]");
      if (!row) return;
      openSheet(row.dataset.match, row.dataset.pick);
    });

    // 对决：约战按钮（先确认）/ 邀请横幅 / 战报回传 / 已发约战再复制
    $("#duelBtn").addEventListener("click", openDuelConfirm);

    // 关注作者：点击内第一时间调 requestFollowAuthor（真手势契约，不可先 await）
    $("#followAuthorBtn").addEventListener("click", function () {
      requestFollowAuthor().then(function (res) {
        if (!res) return;
        if (res.status) {
          $("#followAuthorBtn").hidden = res.status !== "notFollowing";
          if (res.status === "following") toast("感谢关注！");
          else if (res.status === "self") toast("你就是作者本人 🙂");
        }
        // 用户取消 / 失败：静默结束（取消是正常结果）
      });
    });
    $("#duelEntry").addEventListener("click", function () { switchView("duels"); });
    $("#versusShareBtn").addEventListener("click", function () {
      var s = recordSummary();
      duelNick().then(function (nick) {
        return copyShareLink({
          v: 1, c: 1, n: nick,
          w: s.wins, l: s.losses, p: s.profit,
          g: state.gods || 0, b: state.bankrupts || 0,
          s: s.streak || 0, t: s.teams || 0 // 1.2.5 起：跟队连击/图鉴队伍（旧版收到的链接无此字段，对比页显示 --）
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

    $("#historySettledList").addEventListener("click", function (e) {
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
      // 双路径保存（1.2.6）：主路径 = files.saveFile 系统「另存为」（真手势内第一时间调用，
      // 需 manifest 声明 filesystem，android/ios ≥1.3.396 / ohos ≥1.3.390 / PC ≥1.0.0）；
      // 其余一切失败/不支持回退全屏预览+系统截屏（1.1.33 定稿链路，不依赖宿主能力，全平台恒可用）。
      var dataUrl;
      try {
        dataUrl = $("#shareCanvas").toDataURL("image/png");
      } catch (err) {
        toast("图片生成失败，可直接截屏分享卡");
        return;
      }
      var bytes = dataUrlToBytes(dataUrl);
      var d = new Date();
      var stamp = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") +
        "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
      saveFileBytes("esports-sandbox-card-" + stamp + ".png", bytes).then(function (res) {
        if (res.ok) { toast("已保存 · 可在文件管理里查看"); return; }
        if (res.error === "FILE_PICKER_CANCELLED") { toast("已取消保存"); return; } // 用户取消：结束流程不打扰
        openCardFullscreen(dataUrl); // 老客户端/未声明快照/宿主未开放/写失败 → 截屏兜底
      });
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

    // 赛程表行 → 比赛详情（行是分帧渲染的，委托必须绑容器）
    $("#scheduleList").addEventListener("click", function (e) {
      var row = e.target.closest(".schedule-row[data-match]");
      if (!row) return;
      matchDetailId = row.dataset.match;
      switchView("match");
    });

    // 比赛详情页内操作：去竞猜 / 去围观 / 分享战报
    $("#view-match").addEventListener("click", function (e) {
      var bet = e.target.closest("[data-match-bet]");
      if (bet) { openSheet(bet.dataset.matchBet); return; }
      var watch = e.target.closest("[data-match-watch]");
      if (watch) {
        var watchAppId = WATCH_GAME_APPIDS[watch.dataset.matchWatch];
        if (watchAppId) {
          openAppPage({ target: "game_detail", appId: watchAppId, gameType: "pc", page: "game", hSrc: "miniprogram-esports-sandbox" })
            .then(function (res) {
              if (res && res.error) toast("当前客户端不支持跳转");
            });
        }
        return;
      }
      var share = e.target.closest("[data-match-share]");
      if (share) {
        var sp = predictionFor(share.dataset.matchShare);
        if (sp && sp.settled) openShare(sp);
      }
    });

    // 主页搜索（1.3.2，仿赛程表）：列表 + 状态 tab + 选择器计数三处同源刷新
    $("#matchSearch").addEventListener("input", function () {
      var input = this;
      clearTimeout(homeSearchTimer);
      homeSearchTimer = setTimeout(function () {
        homeQuery = input.value;
        $("#matchSearchClear").hidden = !homeQuery;
        renderSelectors(); // 含 renderStatusTray：列表 + 状态 tab + 选择器计数三处同源
        renderMatches();
      }, 250);
    });

    $("#matchSearchClear").addEventListener("click", function () {
      $("#matchSearch").value = "";
      homeQuery = "";
      $("#matchSearchClear").hidden = true;
      renderSelectors();
      renderMatches();
      $("#matchSearch").focus();
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

    // 点击浮层外部关闭（主页/赛程表 + 作业页选择器）
    document.addEventListener("click", function (e) {
      var anyOpen = !$("#gamePopover").hidden || !$("#tournamentPopover").hidden ||
        !$("#schedGamePopover").hidden || !$("#schedTournamentPopover").hidden;
      if (anyOpen) {
        if (!e.target.closest(".selectors")) {
          closeGameSheet();
          closeTournamentSheet();
          closeSchedGame();
          closeSchedTournament();
        }
        return;
      }
      // 作业页浮层（选择器在二级页，独立 keep-open 区 .pk-selectors）
      var pkOpen = !$("#pickemGamePopover").hidden || !$("#pickemEvPopover").hidden;
      if (pkOpen && !e.target.closest(".pk-selectors")) {
        $("#pickemGamePopover").hidden = true;
        $("#pickemEvPopover").hidden = true;
        $("#pickemGameSelectBtn").setAttribute("aria-expanded", "false");
        $("#pickemEvSelectBtn").setAttribute("aria-expanded", "false");
      }
    });

    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () { switchView(btn.dataset.view); });
    });

    $("#goRulesFromMatches").addEventListener("click", function () { switchView("rules"); });

    $("#openRulesBtn").addEventListener("click", function () { switchView("rules"); });
    $("#rulesBackBtn").addEventListener("click", function () {
      if (rulesTopic) { closeRulesTopic(); window.scrollTo(0, 0); return; } // 详情态先回菜单，菜单态才退页
      goBack("settings");
    });
    $("#rulesMenuList").addEventListener("click", function (e) {
      var item = e.target.closest("[data-topic]");
      if (item) openRulesTopic(item.dataset.topic);
    });
    renderRulesMenu();
    $("#aboutBackBtn").addEventListener("click", function () { goBack("settings"); });
    $("#openAboutBtn").addEventListener("click", function () { switchView("about"); });
    // 实验功能（1.3）：关于页 → 实验功能列表 → 赛事竞猜
    $("#openLabsBtn").addEventListener("click", function () { switchView("labs"); });
    bindPickem();
    $("#homeScheduleBtn").addEventListener("click", function () { switchView("schedule"); });
    $("#homePickemBtn").addEventListener("click", function () {
      pickemScoped = true; // 公测直入口：锁定 scoped 赛事（1.3.14 起=BLAST 香港），其他赛事不展示
      switchView("pickem");
    });

    $("#openScheduleBtn").addEventListener("click", function () { switchView("schedule"); });
    $("#scheduleBackBtn").addEventListener("click", function () { goBack("settings"); });

    // 转生仪式（庆祝页）；魔神殿页面/入口已下线（1.3.5），荣誉榜位复用为硬币排行榜
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
    $("#codexToggle").addEventListener("click", function () {
      codexExpanded = !codexExpanded;
      renderCodex();
    });
    $("#codexMainChip").addEventListener("click", function () {
      if (state.mainTeam) openTeamPage(state.mainTeam, "profile");
    });
    $("#profileMainTeam").addEventListener("click", function () {
      if (state.mainTeam) openTeamPage(state.mainTeam, "profile");
    });

    // 成就殿堂：入口/返回/称号装备
    $("#achvEntry").addEventListener("click", function () { switchView("achv"); });
    $("#achvBackBtn").addEventListener("click", function () { goBack("profile"); });
    $("#achvList").addEventListener("click", function (e) {
      var card = e.target.closest("[data-title-achv]");
      if (card) toggleTitle(card.dataset.titleAchv);
    });

    // 战队图鉴：快捷入口 → 二级页
    $("#codexEntry").addEventListener("click", function () { switchView("codex"); });
    $("#codexBackBtn").addEventListener("click", function () { goBack("profile"); });
    $("#historyAllBtn").addEventListener("click", function () { switchView("history"); });
    $("#historyBackBtn").addEventListener("click", function () { goBack("profile"); });
    $("#matchBackBtn").addEventListener("click", function () { goBack("schedule"); });

    // 图鉴单元格 → 战队资料页（网格 + top3 共用委托）
    $("#codexGrid").addEventListener("click", function (e) {
      var cell = e.target.closest("[data-team-key]");
      if (cell) openTeamPage(cell.dataset.teamKey, "profile");
    });
    $("#codexTop").addEventListener("click", function (e) {
      var cell = e.target.closest("[data-team-key]");
      if (cell) openTeamPage(cell.dataset.teamKey, "profile");
    });

    // 战队资料页：返回 + 可竞猜场次直达竞猜面板
    $("#teamBackBtn").addEventListener("click", function () { goBack(teamFromView); });
    $("#view-team").addEventListener("click", function (e) {
      var mainBtn = e.target.closest("#teamMainBtn");
      if (mainBtn) { toggleMainTeam(); return; }
      var prow = e.target.closest("[data-player]");
      if (prow) { openPlayerSheet(currentTeamKey, Number(prow.dataset.player) || 0); return; }
      var row = e.target.closest("[data-open-match]");
      if (row) openSheet(row.dataset.openMatch);
    });

    // 选手卡抽屉（2026-11-10）：关闭按钮 + 点 backdrop 关闭
    $("#playerSheetClose").addEventListener("click", closePlayerSheet);
    $("#playerSheet").addEventListener("click", function (e) {
      if (e.target === $("#playerSheet")) closePlayerSheet();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!$("#gamePopover").hidden) closeGameSheet();
      else if (!$("#tournamentPopover").hidden) closeTournamentSheet();
      else if (!$("#schedGamePopover").hidden) closeSchedGame();
      else if (!$("#schedTournamentPopover").hidden) closeSchedTournament();
      else if (!$("#playerSheet").hidden) closePlayerSheet();
      else if (!$("#sheetBackdrop").hidden) closeSheet();
    });
  }

  /* ============================== 运行时数据 ============================== */
  function applySnapshot(matches, meta, teams, teamColors, rosters, pickem, structures) {
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
    // 主题色同理只增不减
    if (teamColors) {
      Object.keys(teamColors).forEach(function (name) { TEAM_COLORS[name] = teamColors[name]; });
    }
    // 阵容同理只增不减（键 game:name，同一队名不同游戏互不串）
    if (rosters) {
      Object.keys(rosters).forEach(function (key) { ROSTERS[key] = rosters[key]; });
    }
    // Pick'Em 赛事只增不减（事件 id 键；同 id 新数据整体替换——聚合器每次全量重建，新数据更完整）
    if (pickem && Array.isArray(pickem.events)) {
      pickem.events.forEach(function (ev) {
        if (!ev || !ev.id) return;
        var hit = -1;
        for (var i = 0; i < PICKEM.length; i++) { if (PICKEM[i].id === ev.id) { hit = i; break; } }
        if (hit >= 0) PICKEM[hit] = ev;
        else PICKEM.push(ev);
      });
    }
    // 赛事结构（2026-11-10）：同键新数据整体替换（官方积分随赛果演进，新值更完整）
    if (structures) {
      Object.keys(structures).forEach(function (key) { STRUCTURES[key] = structures[key]; });
    }
    applyTeamTheme(); // 主队的新色到了可能要换肤
    rebuildMatchIndex();
    if (meta && meta.updatedAt) DATA_UPDATED_AT = meta.updatedAt;
    runtimeRefreshed = true;

    var events = settlePending();
    var duelDone = settleDuels();
    var pkDone = settlePickem();
    renderDuelBanner(); // 数据刷新可能改变比赛状态（截止/开赛），横幅跟着收敛
    renderSelectors();
    renderAll();
    renderSettings();
    if (!$("#view-schedule").hidden) renderSchedule();
    if (!$("#view-board").hidden) renderBoard();
    // 作业页随赛程即时更新（1.3.6）：淘汰赛名单/赛果一到，正在浏览的作业页立刻重渲染并结算
    if (!$("#view-pickem").hidden) renderPickem();
    if (!$("#view-labs").hidden) renderLabs(); // 实验功能行「N 个赛事进行中」跟随
    if (!$("#view-coinboard").hidden) renderCoinBoard(); // 硬币榜（结算可能改变硬币数）
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
    if (pkDone.length) {
      setTimeout(function () { toast(pickemToastText(pkDone)); }, events.length || duelDone.length ? 1000 : 500);
    }
  }

  var NET_BLOCK_KEY = "esports_sandbox_net_block";
  var NET_BLOCK_TTL = 24 * 60 * 60 * 1000;
  var POLL_INTERVAL = 15 * 60 * 1000;     // 轮询节奏：探测 meta（很小），采集 30 分钟一轮（GitHub schedule 被节流，另有 FC 兜底）
  var POLL_MAX_AGE = 10 * 60 * 1000;      // 轮询/回前台节流：10 分钟内查过就只走本地缓存
  var POLL_BACKOFF = 15 * 60 * 1000;      // 限流退避：RATE_LIMITED 后暂停自动轮询
  var pollBackoffUntil = 0;
  // live 轻量轮询（2026-11-11 深度接入二期）：独立于主轮询的互斥/退避——live.json 只有几 KB，
  // 2.5 分钟一次；失败静默退避 10 分钟，绝不 toast（live 抖动属正常）
  var LIVE_POLL_INTERVAL = 150 * 1000;
  var LIVE_POLL_BACKOFF = 10 * 60 * 1000;
  var livePolling = false;
  var liveBackoffUntil = 0;
  var refreshing = false;

  /* ---------- live.json 轻量轮询（2026-11-11 深度接入二期） ----------
     独立小文件几 KB，2.5 分钟一次；补丁就地 Object.assign 到 matchMidIndex 引用对象——
     不重建 MATCHES/不重排（statusOf 是活计算，lv/result 就位后分组自动归类）。
     finished 迁移才跑结算与重渲染资金视图（比分更新绝不动钱）。失败静默退避 10 分钟。 */
  async function pollLive() {
    livePolling = true;
    try {
      var doc = await fetchLiveSnapshot();
      if (doc) applyLivePatch(doc);
    } catch (e) {
      liveBackoffUntil = Date.now() + LIVE_POLL_BACKOFF;
    } finally {
      livePolling = false;
    }
  }

  function applyLivePatch(doc) {
    var touched = false, finishedMigration = false;
    (doc.live || []).forEach(function (r) {
      var m = matchByMid(r.mid);
      if (!m) return; // 不在窗口（新开赛）：等主轮询整包带进来
      if (r.lsc !== undefined && m.lsc !== r.lsc) { m.lsc = r.lsc; touched = true; }
      if (r.gs !== undefined && m.gs !== r.gs) { m.gs = r.gs; touched = true; }
      if (m.lv !== true) { m.lv = true; touched = true; }
    });
    (doc.finished || []).forEach(function (r) {
      var m = matchByMid(r.mid);
      if (!m) return;
      if (m.result && (m.result.winner === "A" || m.result.winner === "B")) return; // 整包已结算，以整包为准
      if (!r.result || !(r.result.winner === "A" || r.result.winner === "B")) return;
      m.result = r.result;
      if (r.endAt) m.endAt = r.endAt;
      m.lv = undefined; // finished 语义优先，清掉 running 标记
      touched = true;
      finishedMigration = true;
    });
    if (!touched) return;
    rebuildMatchIndex(); // 就地改的是同一批引用，重建 Map 无成本且防漂移
    // 重渲染子集：受影响视图才刷（比 applySnapshot 全量尾部轻一个量级）
    renderDuelBanner();
    if (!$("#view-matches").hidden) renderMatches();
    else matchesDirty = true;
    if (!$("#view-schedule").hidden) renderSchedule();
    if (!$("#view-match").hidden) renderMatchDetail();
    if (finishedMigration) {
      settlePending();
      settleDuels();
      settlePickem();
      if (!$("#view-board").hidden) renderBoard();
      if (!$("#view-pickem").hidden) renderPickem();
      syncBoards();
    }
  }

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
        applySnapshot(cached.matches, cached.meta, cached.teams, cached.teamColors, cached.rosters, cached.pickem, cached.structures);
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
          applySnapshot(remote.matches, remote.meta, remote.teams, remote.teamColors, remote.rosters, remote.pickem, remote.structures);
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
        b: clampStat(extra.b),
        // s/t 为 1.2.5 新增字段，旧版链接缺失时保持 null（对比页显示 --，不计胜负）
        s: typeof extra.s === "number" && isFinite(extra.s) && extra.s >= 0 ? clampStat(extra.s) : null,
        t: typeof extra.t === "number" && isFinite(extra.t) && extra.t >= 0 ? clampStat(extra.t) : null
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
          r: typeof extra.r === "string" && /^[A-Za-z0-9]{2,8}$/.test(extra.r) ? extra.r : "",
          // 狠话（1.2.16，仅 d:1 挑战书携带）：可选，截 24 字防脏数据
          g: extra.d === 1 && typeof extra.g === "string" ? extra.g.trim().slice(0, 24) : ""
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
    // 对决链接：先处理邀请/战报。挑战卡就在首页顶部，处理成功就不再滚动定位
    // （否则自动滚到比赛行会把用户拽离卡片——1.2.16 用户反馈）；被拒（截止等）才落到常规定位给上下文
    if (pendingDuelLaunch && pendingDuelLaunch.m === m.id) {
      var duel = pendingDuelLaunch;
      pendingDuelLaunch = null;
      var duelHandled = duel.d === 1 ? handleDuelInvite(duel) : handleDuelReport(duel);
      if (duelHandled) { pendingDeepLink = ""; return; }
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
      // 回前台：切号检测（免手势静默比对 accountKey）+ 可见页账号/榜单重渲染 + 赛程节流刷新（3 分钟内查过则只走本地缓存）
      checkAccountState();
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

  /* ---------- 狠话（1.2.16，可选）：随 d:1 战书送达，extra 预算硬闸 ---------- */
  // 估算与截断的纯函数在 js/duel-extra.mjs（test:cloud 场景 T 与 @msgpack/msgpack 对拍）；
  // 这里只负责提示
  function fitDuelExtraWithToast(extra) {
    var res = fitDuelExtra(extra);
    if (res.dropped) toast("链接空间不足，狠话本次未带上");
    else if (res.trimmed) toast("狠话过长，已截断发送");
    return res.extra;
  }

  // 昵称 → 头像 反查表：对决卡/对比页里只有对方昵称，头像从榜单 extra 反查（榜单读取带 5 分钟缓存）
  function ensureDuelAvatars() {
    if (Cloud.isMock()) return Promise.resolve({});
    if (duelAvatarMap && Date.now() - duelAvatarMapAt < 300000) return Promise.resolve(duelAvatarMap);
    duelAvatarMapAt = Date.now();
    return Promise.all([
      Cloud.getBoard("win", 200).catch(function () { return { entries: [] }; }),
      Cloud.getBoard("lose", 200).catch(function () { return { entries: [] }; }),
      Cloud.getCoinBoard(200).catch(function () { return { entries: [] }; }) // 1.3.5：魔神殿榜位已换硬币榜（新荣誉条目在这里）
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
    if ($("#duelDialogMsg")) $("#duelDialogMsg").value = "";
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
    var sent = findSentInvite(matchId);
    if ($("#duelDialogMsg")) $("#duelDialogMsg").value = sent && sent.msg ? sent.msg : "";
    $("#duelDialogBackdrop").hidden = false;
  }

  function closeDuelDialog() {
    $("#duelDialogBackdrop").hidden = true;
    duelDialogMode = null;
    duelDialogMatchId = "";
  }

  function copyDuelInvite(rec) {
    // rec 缺字段（老数据/兜底重建）时按当前预测重造；随机码必须复用，否则已应战者会重复建账；
    // 狠话（msg）随同复用——同码重发 = 同一条战书（含狠话）幂等
    return duelNick().then(function (nick) {
      var extra = {
        v: 1, d: 1, m: rec.m, p: rec.p, s: rec.s,
        n: rec.n || nick, r: rec.r || duelCode()
      };
      if (rec.msg) extra.g = rec.msg;
      extra = fitDuelExtraWithToast(extra);
      return copyShareLink(extra).then(function (err) {
        if (!err) {
          var prev = findSentInvite(rec.m);
          if (!prev) {
            saveSentInvite({
              m: rec.m, p: extra.p, s: extra.s, n: extra.n, r: extra.r, msg: extra.g || "",
              label: (matchById(rec.m) ? matchLabel(matchById(rec.m)) : rec.label) || "",
              startAt: (matchById(rec.m) || {}).startAt || rec.startAt || "",
              at: Date.now()
            });
          } else if ((prev.msg || "") !== (extra.g || "")) {
            prev.msg = extra.g || ""; // relock 改狠话：同码建账幂等，但狠话以最新一次为准
            saveDuelSent();
            if (!$("#view-duels").hidden) renderDuelSent();
          }
        }
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
      // relock 可改狠话：同码幂等只约束建账，狠话以最新一次复制为准
      if ($("#duelDialogMsg")) rec = Object.assign({}, rec, { msg: $("#duelDialogMsg").value.trim().slice(0, 12) });
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
      var extra = { v: 1, d: 1, m: m.id, p: duelDialogPick, s: existing.stake, n: nick, r: r };
      var words = $("#duelDialogMsg") ? $("#duelDialogMsg").value.trim().slice(0, 12) : "";
      if (words) extra.g = words;
      extra = fitDuelExtraWithToast(extra);
      return copyShareLink(extra).then(function (err) {
        if (!err) {
          saveSentInvite({
            m: m.id, p: duelDialogPick, s: existing.stake, n: nick, r: r, msg: extra.g || "",
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

  // 收到约战（d:1）：已有预测直接成立，否则挂挑战卡等下注。返回 true=邀请已落地（卡/成局）
  function handleDuelInvite(ex) {
    var m = matchById(ex.m);
    if (!m) { toast("约战的比赛不在当前数据范围内"); return false; }
    if (statusOf(m) !== "open") { toast("这场比赛已截止，无法应战"); return false; }
    if (predictionFor(m.id)) { acceptDuel(ex); return true; }
    duelInvite = { m: ex.m, p: ex.p, s: ex.s, n: ex.n, r: ex.r || "", msg: ex.g || ex.msg || "", exp: matchLockTime(m) };
    storageSet(DUEL_INVITE_KEY, duelInvite).catch(function () {});
    renderDuelBanner();
    return true;
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
      msg: ex.msg || ex.g || "", // 对手的狠话：随战书送达，对决卡展示
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
  // 收到回执/战报（d:2）：发起方建账。返回 true=已记录（不再滚动定位），false=被忽略
  function handleDuelReport(ex) {
    var m = matchById(ex.m);
    if (!m) { toast("战报的比赛不在当前数据范围内"); return false; }
    var my = predictionFor(ex.m);
    if (!my) { toast("这场你没有参与竞猜，战报已忽略"); return false; }
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
    return true;
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
        storageSet(DUEL_INVITE_KEY, "").catch(function () {});   // exp 失效清理
      }
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    // 挑战卡（1.2.16）：对战双方队标 + 对方押边（高亮）/投入 + 狠话（可选）+ 赛程时间
    el.innerHTML =
      '<div class="duel-banner-head"><b>⚔ ' + esc(duelInvite.n) + "</b> 向你发起约战</div>" +
      '<div class="duel-banner-vs">' +
        '<span class="duel-vs-side' + (duelInvite.p === "A" ? " is-pick" : "") + '">' +
          avatarHTML(m.teamA) + "<b>" + esc(m.teamA.short || m.teamA.name) + "</b></span>" +
        '<span class="duel-vs-mark">VS</span>' +
        '<span class="duel-vs-side' + (duelInvite.p === "B" ? " is-pick" : "") + '">' +
          avatarHTML(m.teamB) + "<b>" + esc(m.teamB.short || m.teamB.name) + "</b></span>" +
      "</div>" +
      '<div class="duel-banner-sub">他押 <b>' + esc(pickName(m, duelInvite.p)) + "</b>" +
        (duelInvite.s > 0 ? " · 投入 <b>" + fmtNum(duelInvite.s) + "</b> 沙粒" : "") + "</div>" +
      (duelInvite.msg ? '<div class="duel-msg">「' + esc(duelInvite.msg) + "」</div>" : "") +
      '<div class="duel-banner-meta">' + esc(m.tournament) + " · " + esc(fmtTime(m.startAt)) + " 开赛</div>" +
      '<div class="duel-banner-acts">' +
        '<button type="button" class="duel-accept" data-duel-act="accept">接受应战</button>' +
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
        (d.msg ? '<div class="duel-quote">「' + esc(d.msg) + "」</div>" : "") +
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
    applyTeamTheme(); // 主队主题在首屏渲染前就位（色值来自内嵌数据，零网络）
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
    var pkDone = settlePickem();
    bindEvents();
    bindHostEvents();
    bindOnboard();
    initHistory();
    initScrollRail();
    initPageLifecycle();
    registerIdentity(); // 确保榜单条目存在，隔离身份在任何宿主上都可读（不依赖 user.getInfo）
    checkAccountState(); // boot 切号检测：旧 hbprofile 若属于前一个 APP 账号则失效并提示重同步（免手势）

    // 数据文件加载失败：给出明确提示，避免白屏
    if (!MATCHES.length) {
      renderBalance();
      $("#openCount").textContent = "赛程数据加载失败，请稍后重试";
      $("#matchList").innerHTML =
        '<div class="empty-state"><strong>赛程数据加载失败</strong>请检查网络后刷新页面，或稍后再试</div>';
      maybeShowOnboard();
      refreshData();
      scheduleLatePlatformRecovery(platformReady);
      return;
    }

    renderSelectors();
    renderAll();
    renderDuelBanner();
    resolveDeepLink(); // 分享目标在内置窗口内时先定位；运行时数据到达后 applySnapshot 会再试
    resolveVersusLink();
    maybeShowOnboard();
    refreshData();
    scheduleLatePlatformRecovery(platformReady);

    if (events.length) {
      syncBoards();
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
    if (pkDone.length) {
      setTimeout(function () { toast(pickemToastText(pkDone)); }, events.length || duelDone.length ? 1000 : 500);
    }

    // 每分钟刷新一次状态（到点自动截止、赛果更新后自动结算）
    setInterval(function () {
      var settledNow = settlePending();
      var pkDone = settlePickem();
      renderSelectors();
      renderAll();
      if (!$("#view-schedule").hidden) renderSchedule();
      if (!$("#view-pickem").hidden) renderPickem();
      if (settledNow.length) {
        syncBoards();
        var total = settledNow.reduce(function (s, e) { return s + e.pred.profit; }, 0);
        toast("已结算 " + settledNow.length + " 场预测 · " + (total >= 0 ? "+" : "") + fmtNum(total) + " 沙粒");
        vibrate("medium");
      }
      if (pkDone.length) {
        setTimeout(function () { toast(pickemToastText(pkDone)); }, settledNow.length ? 1000 : 0);
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

    // live 轻量轮询（2026-11-11 深度接入二期）：live.json 只有几 KB（独立小文件，不触发整包），
    // 2.5 分钟一次；存在 lv 场次才发请求。独立互斥/退避——失败半径与主轮询隔离，静默绝不 toast。
    setInterval(function () {
      if (Date.now() < liveBackoffUntil || livePolling) return;
      if (!MATCHES.some(function (m) { return m && m.lv === true; })) return;
      pollLive();
    }, LIVE_POLL_INTERVAL);
    pollLive(); // boot 立即拉一轮（不等 2.5 分钟——开屏即有实时比分）

    // 启动完成：云端恢复的达标余额此后可正常触发庆祝页
    bootDone = true;
    checkHonorPopup();
  }

  boot();
})();
