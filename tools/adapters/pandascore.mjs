/*
 * PandaScore 适配器
 * 文档：https://developers.pandascore.co/
 *
 * 需要环境变量 PANDASCORE_TOKEN（Bearer Token）。
 * 覆盖 15 个路由：CS2 / 瓦罗兰特 / 英雄联盟 / Dota 2 / 彩虹六号 / PUBG / 王者荣耀（kog）/
 * 无尽对决 / 守望先锋 / 火箭联盟 / EA Sports FC / 使命召唤 / 星际争霸2 / 星际母巢之战 / 英雄联盟手游。
 * 不覆盖 Apex、堡垒之夜、街霸、饿狼传说（这些用 Liquipedia 或手工数据）。
 * 速率：免费额度 1000 请求/小时；本适配器每轮 15 个游戏 × 2 个端点 = 30 次起（含翻页通常约 33 次）。
 */
import { normalizeMatch } from "../lib.mjs";

var API = "https://api.pandascore.co";
var RATE_LIMIT_MS = 1200;
// 队标 CDN：只存相对路径，客户端拼 LOGO_BASE（换成自建 OSS 镜像时客户端无需改动）
// API 现在返回 cdn-api 域名，老数据/文档里是 cdn，两种前缀都剥掉
var LOGO_PREFIXES = [
  "https://cdn-api.pandascore.co/images/team/image/",
  "https://cdn.pandascore.co/images/team/image/"
];

function logoPath(url) {
  var u = String(url || "").trim();
  if (!u) return "";
  for (var i = 0; i < LOGO_PREFIXES.length; i++) {
    if (u.indexOf(LOGO_PREFIXES[i]) === 0) return u.slice(LOGO_PREFIXES[i].length);
  }
  return u;
}

// 游戏 id -> PandaScore 路由 slug（注意：路由别名与 /videogames 的 slug 不同）
var SLUGS = {
  cs2: "csgo",
  valorant: "valorant",
  lol: "lol",
  dota2: "dota2",
  r6: "r6siege",
  pubg: "pubg",
  kpl: "kog",
  mlbb: "mlbb",
  ow: "ow",
  rl: "rl",
  fifa: "fifa",
  codmw: "codmw",
  "starcraft-2": "starcraft-2",
  "starcraft-brood-war": "starcraft-brood-war",
  "lol-wild-rift": "lol-wild-rift"
};

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function toRaw(item, game) {
  var opponents = item.opponents || [];
  if (opponents.length < 2) return null;
  var op1 = opponents[0] && opponents[0].opponent ? opponents[0].opponent : {};
  var op2 = opponents[1] && opponents[1].opponent ? opponents[1].opponent : {};
  if (!op1.name || !op2.name) return null;

  var startAt = item.begin_at || item.scheduled_at;
  if (!startAt) return null;

  var results = item.results || [];
  function scoreOf(id) {
    var r = results.filter(function (x) { return x.team_id === id; })[0];
    return r && typeof r.score === "number" ? r.score : null;
  }
  var s1 = scoreOf(op1.id);
  var s2 = scoreOf(op2.id);

  var winner = null;
  if (item.winner_id) {
    if (item.winner_id === op1.id) winner = "A";
    else if (item.winner_id === op2.id) winner = "B";
  }
  var finished = item.status === "finished" && winner;

  var result = finished
    ? { winner: winner, score: s1 !== null && s2 !== null ? s1 + ":" + s2 : "?:?" }
    : null;

  var league = item.league ? item.league.name : "";
  var serie = item.serie ? item.serie.full_name : "";
  var tournament = league && serie ? league + " · " + serie : league || "PandaScore 赛事";

  return {
    game: game,
    tournament: tournament,
    stage: item.tournament ? item.tournament.name : "赛程",
    startAt: startAt,
    bestof: item.number_of_games || 0,
    tier: item.tournament && item.tournament.tier ? String(item.tournament.tier).toLowerCase() : "",
    teamA: { name: op1.name, short: op1.acronym || "", region: "", logo: logoPath(op1.image_url) },
    teamB: { name: op2.name, short: op2.acronym || "", region: "", logo: logoPath(op2.image_url) },
    status: result ? "finished" : undefined,
    result: result,
    note: ""
  };
}

async function fetchList(path, token) {
  var res = await fetch(API + path, {
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(25000)
  });
  if (res.status === 401 || res.status === 403) throw new Error("PandaScore 鉴权失败，请检查 PANDASCORE_TOKEN");
  if (res.status === 429) throw new Error("PandaScore 限流（429），请稍后再试");
  if (!res.ok) throw new Error("PandaScore HTTP " + res.status);
  var body = await res.json();
  return Array.isArray(body) ? body : [];
}

export async function collectPandascore(options) {
  var opts = options || {};
  var token = process.env.PANDASCORE_TOKEN;
  if (!token) {
    return { matches: [], count: 0, skipped: "未设置 PANDASCORE_TOKEN" };
  }

  var days = Number(opts.days || 7);
  var pastDays = Number(opts.pastDays || 3);
  var upcomingPages = Math.max(1, Number(opts.upcomingPages || 1));
  var pastPages = Math.max(1, Number(opts.pastPages || 1));
  var games = opts.games && opts.games.length ? opts.games : Object.keys(SLUGS);
  var matches = [];
  var errors = [];

  var now = Date.now();
  var from = now - pastDays * 86400000;
  var to = now + days * 86400000;
  var rangeParam = "range%5Bbegin_at%5D=" +
    encodeURIComponent(new Date(from).toISOString() + "," + new Date(to).toISOString());

  function inWindow(raw) {
    var t = new Date(raw.startAt).getTime();
    return t >= from && t <= to;
  }

  for (var i = 0; i < games.length; i++) {
    var game = games[i];
    var slug = SLUGS[game];
    if (!slug) continue;

    // 未来赛程：服务端按时间范围过滤，再按时间正序翻页
    for (var p = 1; p <= upcomingPages; p++) {
      try {
        var upcoming = await fetchList(
          "/" + slug + "/matches/upcoming?" + rangeParam +
            "&page[size]=50&page[number]=" + p + "&sort=begin_at",
          token
        );
        upcoming.forEach(function (item) {
          var raw = toRaw(item, game);
          if (!raw || !inWindow(raw)) return;
          var normalized = normalizeMatch(raw, "pandascore");
          if (normalized) matches.push(normalized);
        });
        if (upcoming.length < 50) break;
      } catch (e) {
        errors.push(game + " upcoming p" + p + ": " + (e && e.message ? e.message : String(e)));
      }
      await sleep(RATE_LIMIT_MS);
    }

    // 过去赛果：同样按范围过滤，按时间倒序翻页
    for (var q = 1; q <= pastPages; q++) {
      try {
        var past = await fetchList(
          "/" + slug + "/matches/past?" + rangeParam +
            "&page[size]=50&page[number]=" + q + "&sort=-begin_at",
          token
        );
        past.forEach(function (item) {
          var raw = toRaw(item, game);
          if (!raw || !inWindow(raw)) return;
          var normalized = normalizeMatch(raw, "pandascore");
          if (normalized) matches.push(normalized);
        });
        if (past.length < 50) break;
      } catch (e) {
        errors.push(game + " past p" + q + ": " + (e && e.message ? e.message : String(e)));
      }
      await sleep(RATE_LIMIT_MS);
    }
  }

  return { matches: matches, count: matches.length, errors: errors };
}

export { toRaw };
