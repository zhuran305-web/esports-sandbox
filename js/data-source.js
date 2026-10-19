/*
 * 运行时赛程数据源：先拉 meta.json，hash/updatedAt 变化时才拉 matches.json。
 * 所有网络/存储错误都返回 null，由调用方回退到缓存或内置数据。
 */
import { RUNTIME_DATA_BASE } from "./config.js";
import { networkGetJson, storageGet, storageSet } from "./platform.js";

var CACHE_KEY = "esports_sandbox_remote_v1";
var MAX_MATCHES = 10000;

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
    checkedAt: typeof cached.checkedAt === "number" ? cached.checkedAt : 0
  };
}

async function saveCache(meta, matches, checkedAt) {
  return storageSet(CACHE_KEY, {
    meta: meta,
    matches: matches,
    checkedAt: checkedAt
  });
}

export async function fetchRemoteSnapshot(options) {
  if (!isRuntimeEnabled()) return null;

  var maxAge = options && typeof options.maxAgeMs === "number" ? options.maxAgeMs : 0;
  var cached = await loadCachedSnapshot();
  if (cached && maxAge > 0 && Date.now() - cached.checkedAt < maxAge) {
    return {
      meta: cached.meta,
      matches: cached.matches,
      checkedAt: cached.checkedAt,
      fromCache: true,
      skipped: true
    };
  }

  var meta = await networkGetJson(baseUrl() + "meta.json?t=" + Date.now(), 10000);
  if (!validMeta(meta)) return null;

  if (cached && cached.meta.hash === meta.hash && cached.meta.updatedAt === meta.updatedAt) {
    return {
      meta: meta,
      matches: cached.matches,
      checkedAt: cached.checkedAt,
      fromCache: true
    };
  }

  var raw = await networkGetJson(
    baseUrl() + "matches.json?v=" + encodeURIComponent(meta.hash),
    10000
  );
  var matches = normalizeMatches(raw);
  if (!matches) return null;

  var checkedAt = Date.now();
  await saveCache(meta, matches, checkedAt);
  return {
    meta: meta,
    matches: matches,
    checkedAt: checkedAt,
    fromCache: false
  };
}
