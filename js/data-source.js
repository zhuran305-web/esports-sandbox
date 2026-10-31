/*
 * 运行时赛程数据源：先拉 meta.json，hash/updatedAt 变化时才拉 matches.json。
 * 网络失败返回 { error: 错误码 }，由调用方回退到缓存或内置数据。
 * 预览版本的 effective network 未启用，直接跳过，避免宿主弹 SERVER_API_REQUIRED。
 * 1.1.16 起全平台统一轮询（无 ohos 特殊分支）；maxAgeMs 供轮询/回前台做节流。
 */
import { RUNTIME_DATA_BASE } from "./config.js";
import { networkGetJson, storageGet, storageSet, getRuntimeMode, whenPlatformReady } from "./platform.js";

var CACHE_KEY = "esports_sandbox_remote_v1";
var MAX_MATCHES = 10000;
var MAX_TEAMS = 3000;

export function isRuntimeEnabled() {
  return !!RUNTIME_DATA_BASE;
}

function validMatch(m) {
  return !!m &&
    typeof m.id === "string" && m.id.length > 0 &&
    typeof m.game === "string" && m.game.length > 0 &&
    typeof m.startAt === "string" && !isNaN(new Date(m.startAt).getTime()) &&
    m.teamA && typeof m.teamA.name === "string" && m.teamA.name.length > 0 &&
    m.teamB && typeof m.teamB.name === "string" && m.teamB.name.length > 0 &&
    (!m.result || m.result.winner === "A" || m.result.winner === "B");
}

function validMeta(meta) {
  return !!meta &&
    typeof meta.updatedAt === "string" && meta.updatedAt.length > 0 &&
    typeof meta.hash === "string" && meta.hash.length > 0 &&
    typeof meta.count === "number";
}

function normalizeMatches(raw) {
  if (!raw || !Array.isArray(raw.matches)) return null;
  var list = raw.matches.filter(validMatch).slice(0, MAX_MATCHES);
  return list.length ? list : null;
}

// 队标映射：{队名: 相对路径}。缺字段/老数据一律当空，渲染端回退文字徽标
function normalizeTeams(raw) {
  var src = raw && raw.teams;
  if (!src || typeof src !== "object") return {};
  var out = {};
  var n = 0;
  Object.keys(src).forEach(function (name) {
    if (n >= MAX_TEAMS) return;
    var v = src[name];
    if (typeof v === "string" && v) {
      out[name] = v;
      n++;
    }
  });
  return out;
}

// 队伍主题色（1.2.11）：{队名: [c1, c2, darkText]}。缺字段/老数据/非法色值一律当空
var MAX_TEAM_COLORS = 1200;
function normalizeTeamColors(raw) {
  var src = raw && raw.teamColors;
  if (!src || typeof src !== "object") return {};
  var out = {};
  var n = 0;
  Object.keys(src).forEach(function (name) {
    if (n >= MAX_TEAM_COLORS) return;
    var v = src[name];
    if (Array.isArray(v) && v.length >= 3 &&
        typeof v[0] === "string" && /^#[0-9a-fA-F]{6}$/.test(v[0]) &&
        typeof v[1] === "string" && /^#[0-9a-fA-F]{6}$/.test(v[1])) {
      out[name] = [v[0], v[1], v[2] ? 1 : 0];
      n++;
    }
  });
  return out;
}

function baseUrl() {
  return RUNTIME_DATA_BASE.replace(/\/+$/, "") + "/";
}

export async function loadCachedSnapshot() {
  var cached = await storageGet(CACHE_KEY);
  if (!cached) return null;
  if (typeof cached === "string") {
    try {
      cached = JSON.parse(cached);
    } catch (e) {
      return null;
    }
  }
  if (!cached || !validMeta(cached.meta)) return null;
  var matches = normalizeMatches({ matches: cached.matches });
  if (!matches) return null;
  return {
    meta: cached.meta,
    matches: matches,
    teams: normalizeTeams(cached),
    teamColors: normalizeTeamColors(cached),
    checkedAt: typeof cached.checkedAt === "number" ? cached.checkedAt : 0
  };
}

async function saveCache(meta, matches, teams, teamColors, checkedAt) {
  return storageSet(CACHE_KEY, {
    meta: meta,
    matches: matches,
    teams: teams,
    teamColors: teamColors,
    checkedAt: checkedAt
  });
}

export async function fetchRemoteSnapshot(options) {
  if (!isRuntimeEnabled()) return null;
  // 握手未完成时 environment 还读不到，先等一会，避免把预览态误判成生产态
  if (getRuntimeMode() === "unknown") {
    await whenPlatformReady(5000);
  }
  if (getRuntimeMode() === "preview") {
    console.info("[data] 预览态没有 effective network，跳过运行时拉取");
    return null;
  }

  var force = options && options.force === true;
  var maxAgeMs = options && typeof options.maxAgeMs === "number" ? options.maxAgeMs : 0;
  var cached = await loadCachedSnapshot();
  if (cached && maxAgeMs > 0 && Date.now() - cached.checkedAt < maxAgeMs) {
    return {
      meta: cached.meta,
      matches: cached.matches,
      teams: cached.teams,
      teamColors: cached.teamColors,
      checkedAt: cached.checkedAt,
      fromCache: true,
      skipped: true
    };
  }

  var meta;
  try {
    meta = await networkGetJson(baseUrl() + "meta.json?t=" + Date.now(), 10000);
  } catch (e) {
    return { error: (e && e.code) || "REQUEST_FAILED" };
  }
  if (!validMeta(meta)) return { error: "INVALID_META" };

  if (cached && cached.meta.hash === meta.hash && cached.meta.updatedAt === meta.updatedAt) {
    // 数据未变化：也刷新 checkedAt，让 maxAge 节流在下一轮生效（每轮轮询只花一次 meta 探测）
    cached.checkedAt = Date.now();
    await saveCache(meta, cached.matches, cached.teams, cached.teamColors, cached.checkedAt);
    return {
      meta: meta,
      matches: cached.matches,
      teams: cached.teams,
      teamColors: cached.teamColors,
      checkedAt: cached.checkedAt,
      fromCache: true
    };
  }

  // 整包约 1.2 MiB，弱网下 10s 容易超时；meta 很小，仍用 10s
  var raw;
  try {
    raw = await networkGetJson(
      baseUrl() + "matches.json?v=" + encodeURIComponent(meta.hash),
      30000
    );
  } catch (e) {
    return { error: (e && e.code) || "REQUEST_FAILED" };
  }
  var matches = normalizeMatches(raw);
  if (!matches) return { error: "INVALID_MATCHES" };
  var teams = normalizeTeams(raw);
  var teamColors = normalizeTeamColors(raw);

  var checkedAt = Date.now();
  var cachedOk = await saveCache(meta, matches, teams, teamColors, checkedAt);
  if (!cachedOk) {
    // 整包约 1.2 MiB，宿主可能对单值设 UTF-8 字节配额；失败只影响下次启动需重下
    console.warn("[data] 快照缓存写入失败，下次启动会重新下载整包");
  }
  return {
    meta: meta,
    matches: matches,
    teams: teams,
    teamColors: teamColors,
    checkedAt: checkedAt,
    fromCache: false
  };
}
