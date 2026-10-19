/*
 * Liquipedia 适配器（API v3）
 * 文档：https://api.liquipedia.net/api/v3/
 *
 * 需要环境变量 LIQUIPEDIA_API_KEY（免费注册获取）。
 * 可选 LIQUIPEDIA_CONTACT 填联系方式，Liquipedia 要求 User-Agent 带联系方式。
 *
 * 限制：免费额度约 60 请求/小时，且同一 IP 至少间隔 2 秒；本适配器按 2.1 秒节流。
 * 注意：Liquipedia 可能屏蔽数据中心 IP（如 GitHub Actions），失败时请改用本地运行或 PandaScore。
 */
import { normalizeMatch } from "../lib.mjs";

var API = "https://api.liquipedia.net/api/v3/match";
var RATE_LIMIT_MS = 2100;

// 游戏 id -> Liquipedia wiki 名称
var WIKIS = {
  cs2: "counterstrike",
  valorant: "valorant",
  lol: "leagueoflegends",
  dota2: "dota2",
  r6: "rainbowsix",
  apex: "apexlegends",
  fortnite: "fortnite",
  sf: "streetfighter",
  ff: "fatalfury"
};

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function toIso(value) {
  if (!value) return null;
  var s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    s = s.replace(" ", "T");
    if (/:\d{2}:\d{2}$/.test(s) === false) s += ":00";
    s += "Z";
  } else {
    s = s.replace(" ", "T");
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function pickScore(value) {
  var n = Number(value);
  return isFinite(n) ? n : null;
}

function itemToRaw(item, game) {
  var o1 = item.opponent1 || {};
  var o2 = item.opponent2 || {};
  var name1 = o1.name || o1.template || o1.opponent || "";
  var name2 = o2.name || o2.template || o2.opponent || "";
  if (!name1 || !name2) return null;

  var startAt = toIso(item.date || item.dateexact || item.datetime);
  if (!startAt) return null;

  var win1 = o1.win === 1 || o1.win === true || item.winner === 1 || item.winner === "1";
  var win2 = o2.win === 1 || o2.win === true || item.winner === 2 || item.winner === "2";
  var finished = item.finished === 1 || item.finished === true || win1 || win2;

  var s1 = pickScore(o1.score);
  var s2 = pickScore(o2.score);
  var result = null;
  if (finished && (win1 || win2)) {
    result = {
      winner: win1 ? "A" : "B",
      score: s1 !== null && s2 !== null ? s1 + ":" + s2 : "?:?"
    };
  }

  return {
    game: game,
    tournament: item.tournament || item.parent || "Liquipedia 赛事",
    stage: item.section || item.round || item.bracket || "赛程",
    startAt: startAt,
    bestof: item.bestof || item.bestOf || 0,
    teamA: { name: name1, short: o1.template || "", region: "" },
    teamB: { name: name2, short: o2.template || "", region: "" },
    status: result ? "finished" : undefined,
    result: result,
    note: ""
  };
}

async function fetchWiki(wiki, fromIso, toIsoStr, key, contact) {
  var conditions = JSON.stringify([
    ["date", ">=", fromIso],
    ["date", "<=", toIsoStr]
  ]);
  var url =
    API +
    "?wiki=" + encodeURIComponent(wiki) +
    "&conditions=" + encodeURIComponent(conditions) +
    "&limit=100" +
    "&order=" + encodeURIComponent("date ASC");

  var headers = {
    "Authorization": "Apikey " + key,
    "User-Agent": "esports-sandbox-collector/1.0 (" + contact + ")",
    "Accept": "application/json"
  };

  var res = await fetch(url, { headers: headers, signal: AbortSignal.timeout(25000) });
  if (res.status === 429) throw new Error("Liquipedia 限流（429），请降低频率");
  if (!res.ok) throw new Error("Liquipedia HTTP " + res.status);
  var body = await res.json();
  if (!body || !Array.isArray(body.result)) {
    throw new Error("Liquipedia 返回格式异常: " + JSON.stringify(body).slice(0, 200));
  }
  return body.result;
}

export async function collectLiquipedia(options) {
  var opts = options || {};
  var key = process.env.LIQUIPEDIA_API_KEY;
  if (!key) {
    return { matches: [], count: 0, skipped: "未设置 LIQUIPEDIA_API_KEY" };
  }

  var contact = process.env.LIQUIPEDIA_CONTACT || "https://github.com/";
  var days = Number(opts.days || 7);
  var now = new Date();
  var from = new Date(now.getTime() - 3 * 86400000); // 往回 3 天，补录刚结束的比赛
  var to = new Date(now.getTime() + days * 86400000);

  var games = opts.games && opts.games.length ? opts.games : Object.keys(WIKIS);
  var matches = [];
  var errors = [];

  for (var i = 0; i < games.length; i++) {
    var game = games[i];
    var wiki = WIKIS[game];
    if (!wiki) continue;
    try {
      var items = await fetchWiki(wiki, from.toISOString(), to.toISOString(), key, contact);
      items.forEach(function (item) {
        var raw = itemToRaw(item, game);
        if (!raw) return;
        var normalized = normalizeMatch(raw, "liquipedia");
        if (normalized) matches.push(normalized);
      });
    } catch (e) {
      errors.push(game + ": " + (e && e.message ? e.message : String(e)));
    }
    if (i < games.length - 1) await sleep(RATE_LIMIT_MS);
  }

  return { matches: matches, count: matches.length, errors: errors };
}

export { itemToRaw };
