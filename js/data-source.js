/*
 * 运行时赛程数据源：先拉 meta.json，hash/updatedAt 变化时才拉 matches.json。
 * 网络失败返回 { error: 错误码 }，由调用方回退到缓存或内置数据。
 * 预览版本的 effective network 未启用，直接跳过，避免宿主弹 SERVER_API_REQUIRED。
 * 1.1.16 起全平台统一轮询（无 ohos 特殊分支）；maxAgeMs 供轮询/回前台做节流。
 */
import { RUNTIME_DATA_BASE } from "./config.js";
import { networkGetJson, networkGetJsonCompressed, setTransferReporter, storageGet, storageSet, getRuntimeMode, whenPlatformReady } from "./platform.js";
import { normalizePickemData, normalizeStructures } from "./pickem.js";

var CACHE_KEY = "esports_sandbox_remote_v1";
var MAX_MATCHES = 10000;
var MAX_TEAMS = 3000;

/** 本地快照缓存健康状态（2026-11-25）：ok=可落盘 / fail=宿主拒写（每次冷启动都要重下整包）。
 *  设置页诊断行展示，用于确认「流量包为何烧得快」是否由此引起。 */
var cacheDiag = "unknown";
export function getCacheDiag() {
  return cacheDiag;
}

/** 传输方式统计（2026-11-25）：cmp=压缩版命中 / raw=回退原版——诊断行可看出压缩是否真的生效。 */
var transferDiag = { cmp: 0, raw: 0 };
export function getTransferDiag() {
  return transferDiag;
}
setTransferReporter(function (kind) {
  if (kind === "cmp") transferDiag.cmp += 1;
  else if (kind === "raw") transferDiag.raw += 1;
});

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

// 战队选手阵容（1.3.2）：{ "game:name": [{n 职业ID, r 位置, l 国籍}, ...] }——数组形状，与
// build-runtime-data/trim-embedded 的切片一致。脏数据整队丢弃
var MAX_ROSTERS = 1500;
function normalizeRosters(raw) {
  var src = raw && raw.rosters;
  if (!src || typeof src !== "object") return {};
  var out = {};
  var n = 0;
  Object.keys(src).forEach(function (key) {
    if (n >= MAX_ROSTERS) return;
    var v = src[key];
    // 兼容两种来源：数组（build/trim/embedded）与 {pid, players}（老缓存）
    var players = Array.isArray(v) ? v : (v && Array.isArray(v.players) ? v.players : null);
    if (!players) return;
    players = players.filter(function (p) {
      return p && typeof p.n === "string" && p.n;
    }).slice(0, 5).map(function (p) {
      // 2026-11-10 深度接入：id/img/fn/ln；缺省 undefined（老缓存无这些字段）。img 字段保留兼容——2026-11-14 客户端选手头像整体移除后不再渲染
      return { n: p.n, r: typeof p.r === "string" ? p.r : "", l: typeof p.l === "string" ? p.l : "",
        id: typeof p.id === "number" && p.id > 0 ? p.id : undefined,
        img: typeof p.img === "string" && p.img ? p.img : undefined,
        fn: typeof p.fn === "string" && p.fn ? p.fn : undefined,
        ln: typeof p.ln === "string" && p.ln ? p.ln : undefined };
    });
    if (!players.length) return;
    out[key] = players;
    n++;
  });
  return out;
}

function baseUrl() {
  return RUNTIME_DATA_BASE.replace(/\/+$/, "") + "/";
}

/* ---------- 全量阵容低频拉取（1.3.22：窗口外队伍资料页阵容恢复） ----------
 * 窗口切片（过去4天+未来16天）只保活跃队伍——主队/图鉴押过的队伍休赛期掉窗后
 * 资料页阵容消失+队标回退首字（天禄 11-15 用户实测：最近一场 11-07 掉窗）。
 * team-rosters.json 是采集器每小时同步的全量资产（970+ 队 ~300KB）——启动后台拉一次
 * 合并进 ROSTERS。1.3.23 阀门 1：12h 本地缓存（storage 落盘）——每次启动拉 305KB 降为
 * 每半天一次；单键 305KB 可能超部分宿主 storage 限额 → 自适应降级（写入失败标记
 * rostersStorageOk=false，回退每次启动拉），失败静默（窗口切片兜底），绝不 toast。 */
var ROSTERS_CACHE_KEY = "esports_sandbox_rosters_all_v1";
var ROSTERS_CACHE_TTL = 12 * 3600000;
var allRostersCache = null;
var allRostersAt = 0;
var rostersStorageOk = null; // null=未知 true=可落盘 false=超限（读写都跳过）
export async function fetchAllRosters() {
  if (allRostersCache && Date.now() - allRostersAt < ROSTERS_CACHE_TTL) return allRostersCache;
  if (!isRuntimeEnabled()) return null;
  // 预览态门禁（1.3.25）：与 fetchLiveSnapshot/fetchRemoteSnapshot 同款——预览态无 effective
  // network，network.request 会弹宿主原生 SERVER_API_REQUIRED（审核包首启体验，1.3.22 漏加）
  if (getRuntimeMode() === "unknown") {
    await whenPlatformReady(5000);
  }
  if (getRuntimeMode() === "preview") return null;
  if (rostersStorageOk !== false) {
    try {
      var cachedRaw = await storageGet(ROSTERS_CACHE_KEY);
      if (cachedRaw) {
        var rec = typeof cachedRaw === "string" ? JSON.parse(cachedRaw) : cachedRaw;
        if (rec && typeof rec.at === "number" && rec.at > 0 &&
            Date.now() - rec.at < ROSTERS_CACHE_TTL && rec.data && typeof rec.data === "object") {
          var norm = normalizeRosters({ rosters: rec.data });
          if (Object.keys(norm).length) {
            allRostersCache = norm;
            allRostersAt = rec.at;
            return norm;
          }
        }
      }
    } catch (e) { /* 脏缓存/超限 → 走网络 */ }
  }
  try {
    // 640KB → 压缩版约 151KB（4.2x）；同样带回退
    var raw = await networkGetJsonCompressed(baseUrl() + "team-rosters.json?t=" + Date.now(), 20000);
    var fresh = normalizeRosters({ rosters: raw });
    if (!Object.keys(fresh).length) return null;
    allRostersCache = fresh;
    allRostersAt = Date.now();
    if (rostersStorageOk !== false) {
      try {
        await storageSet(ROSTERS_CACHE_KEY, JSON.stringify({ at: allRostersAt, data: raw }));
        rostersStorageOk = true;
      } catch (e2) {
        rostersStorageOk = false; // 单键超限宿主：本次会话起不再读写缓存（每次启动拉）
      }
    }
    return fresh;
  } catch (e) {
    return null; // 静默：窗口切片兜底
  }
}

/* ---------- live.json 轻量轮询（2026-11-11 深度接入二期） ----------
   独立小文件（几 KB，refresh-live 每 10 分钟写）——高频刷新不触发 1.99MiB 整包下载。
   纯内存缓存不写 storage：几 KB 且 2-3 分钟即过期，storage 序列化开销不值得；
   失败静默（陈旧值兜底），绝不 toast/不设全局退避——live 轮询抖动属正常。 */
var MAX_LIVE_ENTRIES = 60;
var liveCache = null;     // {updatedAt, live:[{mid,lsc,gs}], finished:[{mid,result,endAt}]}
var liveCacheAt = 0;

function validLiveDoc(doc) {
  return !!doc && Array.isArray(doc.live) && Array.isArray(doc.finished);
}

function normalizeLiveDoc(raw) {
  if (!raw || !validLiveDoc(raw)) return null;
  function rows(list) {
    return (Array.isArray(list) ? list : []).filter(function (r) {
      return !!r && typeof r.mid === "number" && r.mid > 0;
    }).slice(0, MAX_LIVE_ENTRIES);
  }
  var out = {
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    live: rows(raw.live),
    finished: rows(raw.finished)
  };
  return out; // 空集也返回（真实静默态，客户端据此停轮询）
}

export async function fetchLiveSnapshot(options) {
  if (!isRuntimeEnabled()) return null;
  if (getRuntimeMode() === "unknown") {
    await whenPlatformReady(5000);
  }
  if (getRuntimeMode() === "preview") return null; // 预览态无 effective network（不弹 SERVER_API_REQUIRED）
  var force = options && options.force === true;
  if (!force && liveCache && Date.now() - liveCacheAt < 60000) return liveCache; // 1 分钟内存节流

  try {
    var raw = await networkGetJson(baseUrl() + "live.json?t=" + Date.now(), 10000);
    var doc = normalizeLiveDoc(raw);
    if (doc) {
      liveCache = doc;
      liveCacheAt = Date.now();
    }
    return doc || liveCache; // 失败静默：返回陈旧内存值
  } catch (e) {
    return liveCache; // 静默（陈旧值兜底或 null）
  }
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
    rosters: normalizeRosters(cached),
    pickem: normalizePickemData(cached.pickem),
    structures: normalizeStructures(cached.structures),
    checkedAt: typeof cached.checkedAt === "number" ? cached.checkedAt : 0
  };
}

async function saveCache(meta, matches, teams, teamColors, rosters, pickem, structures, checkedAt) {
  return storageSet(CACHE_KEY, {
    meta: meta,
    matches: matches,
    teams: teams,
    teamColors: teamColors,
    rosters: rosters,
    pickem: pickem,
    structures: structures,
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
      rosters: cached.rosters,
      pickem: cached.pickem,
      structures: cached.structures,
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
    await saveCache(meta, cached.matches, cached.teams, cached.teamColors, cached.rosters, cached.pickem, cached.structures, cached.checkedAt);
    return {
      meta: meta,
      matches: cached.matches,
      teams: cached.teams,
      teamColors: cached.teamColors,
      rosters: cached.rosters,
      pickem: cached.pickem,
      structures: cached.structures,
      checkedAt: cached.checkedAt,
      fromCache: true
    };
  }

  // 整包 2.2 MiB（弱网 30s 超时）；2026-11-25 起优先拉 matches.json.gz.b64（约 486KB，4.6x），
  // 压缩版缺失/解压失败自动回退原版——OSS 下行流量包（2GB/月）几乎全部消耗在此文件
  var raw;
  try {
    raw = await networkGetJsonCompressed(
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
  var rosters = normalizeRosters(raw);
  var pickem = normalizePickemData(raw.pickem);
  var structures = normalizeStructures(raw.structures);

  var checkedAt = Date.now();
  var cachedOk = await saveCache(meta, matches, teams, teamColors, rosters, pickem, structures, checkedAt);
  cacheDiag = cachedOk ? "ok" : "fail";
  if (!cachedOk) {
    // 整包约 2.4 MiB，宿主可能对单值设 UTF-8 字节配额；失败意味着每次冷启动都要重下整包
    // （OSS 下行流量包 2GB/月的主要消耗源之一）——2026-11-25 起在设置页诊断行可见
    console.warn("[data] 快照缓存写入失败，下次启动会重新下载整包");
  }
  return {
    meta: meta,
    matches: matches,
    teams: teams,
    teamColors: teamColors,
    rosters: rosters,
    pickem: pickem,
    structures: structures,
    checkedAt: checkedAt,
    fromCache: false
  };
}
