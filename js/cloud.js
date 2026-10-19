/*
 * 云服务层：排行榜与账号信息。
 * 在小黑盒宿主内（hb-sdk 就绪）使用平台云端排行榜与用户资料；
 * 普通浏览器开发环境自动回退到本地模拟数据。
 */
import { isMiniProgram, getSDK, getUserProfile } from "./platform.js";

var BOARD_KEYS = {
  win: "sha_board_win",
  lose: "sha_board_lose"
};

function encode(wins, amount) {
  return wins * 1e9 + Math.max(0, Math.round(amount));
}

function decode(score) {
  var wins = Math.floor(score / 1e9);
  return { first: wins, second: score - wins * 1e9 };
}

/* ============================== 本地模拟 ============================== */

var MOCK_KEY = "esports_sandbox_mock_cloud_v2";
var MOCK_BOTS = [
  { uid: "b1", nick: "赛事老登", wins: 31, winProfit: 4820, losses: 11, loseAmount: 1340 },
  { uid: "b2", nick: "沙盘巴菲特", wins: 24, winProfit: 3950, losses: 15, loseAmount: 2050 },
  { uid: "b3", nick: "含泪吃面", wins: 17, winProfit: 940, losses: 30, loseAmount: 5260 },
  { uid: "b4", nick: "竞猜小王子", wins: 12, winProfit: 1210, losses: 9, loseAmount: 780 },
  { uid: "b5", nick: "反着买大师", wins: 11, winProfit: 660, losses: 19, loseAmount: 3110 },
  { uid: "b6", nick: "场场梭哈", wins: 9, winProfit: 2450, losses: 14, loseAmount: 2900 },
  { uid: "b7", nick: "冠军预测家", wins: 20, winProfit: 2100, losses: 12, loseAmount: 1560 },
  { uid: "b8", nick: "反向先知", wins: 6, winProfit: 310, losses: 25, loseAmount: 4480 }
];

function mockRead() {
  try {
    var raw = localStorage.getItem(MOCK_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return null;
}

function mockWrite(data) {
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify(data));
  } catch (e) { /* ignore */ }
}

function mockEnsure() {
  var data = mockRead();
  if (!data) {
    data = { win: {}, lose: {} };
    MOCK_BOTS.forEach(function (b) {
      data.win[b.uid] = { uid: b.uid, nick: b.nick, score: encode(b.wins, b.winProfit), extra: { first: b.wins, second: b.winProfit } };
      data.lose[b.uid] = { uid: b.uid, nick: b.nick, score: encode(b.losses, b.loseAmount), extra: { first: b.losses, second: b.loseAmount } };
    });
    mockWrite(data);
  }
  return data;
}

function mockUpsert(board, entry) {
  var data = mockEnsure();
  var prev = data[board][entry.uid];
  if (!prev || entry.score > prev.score) {
    data[board][entry.uid] = entry;
    mockWrite(data);
  }
}

function mockList(board, limit) {
  var data = mockEnsure();
  var list = Object.keys(data[board]).map(function (uid) {
    var e = data[board][uid];
    var d = decode(e.score);
    return { uid: e.uid, nick: e.nick, first: d.first, second: d.second, isMe: e.uid === "me" };
  });
  list.sort(function (a, b) { return b.first - a.first || b.second - a.second; });
  list.forEach(function (e, i) { e.rank = i + 1; });
  return { entries: list.slice(0, limit || 20) };
}

function mockMy(board) {
  var list = mockList(board, 9999);
  return list.entries.filter(function (e) { return e.isMe; })[0] || null;
}

/* ============================== 云端实现 ============================== */

var myUid = null;

async function realSubmit(board, first, second) {
  var sdk = getSDK();
  if (!sdk || !sdk.cloud) return;
  var extra = { first: first, second: second };
  var profile = await getUserProfile();
  if (profile && profile.nick) extra.nick = profile.nick;
  if (profile && profile.uid) myUid = profile.uid;
  await sdk.cloud.leaderboard.submit({
    key: BOARD_KEYS[board],
    score: encode(first, second),
    extra: extra
  });
}

async function realList(board, limit) {
  var sdk = getSDK();
  if (!sdk || !sdk.cloud) return { entries: [] };
  var page = await sdk.cloud.leaderboard.getList({ key: BOARD_KEYS[board], limit: limit });
  var entries = (page && page.entries) || [];
  return {
    entries: entries.map(function (e) {
      var d = decode(e.score);
      var extra = e.extra || {};
      return {
        uid: e.appUserId,
        nick: extra.nick || "盒友",
        first: d.first,
        second: d.second,
        rank: e.rank,
        isMe: myUid ? e.appUserId === myUid : false
      };
    })
  };
}

async function realMy(board) {
  var sdk = getSDK();
  if (!sdk || !sdk.cloud) return null;
  var e = await sdk.cloud.leaderboard.getCurrentUserEntry({ key: BOARD_KEYS[board] });
  if (!e) return null;
  var d = decode(e.score);
  var extra = e.extra || {};
  return {
    uid: e.appUserId,
    nick: extra.nick || "我",
    first: d.first,
    second: d.second,
    rank: e.rank,
    isMe: true
  };
}

/* ============================== 对外接口 ============================== */

export var Cloud = {
  KEYS: BOARD_KEYS,

  isMock: function () {
    return !isMiniProgram();
  },

  submitStats: async function (stats) {
    if (stats.wins > 0) {
      if (isMiniProgram()) await realSubmit("win", stats.wins, Math.max(0, stats.winProfit));
      else mockUpsert("win", { uid: "me", nick: "我", score: encode(stats.wins, Math.max(0, stats.winProfit)), extra: { first: stats.wins, second: Math.max(0, stats.winProfit) } });
    }
    if (stats.losses > 0) {
      if (isMiniProgram()) await realSubmit("lose", stats.losses, Math.max(0, stats.loseAmount));
      else mockUpsert("lose", { uid: "me", nick: "我", score: encode(stats.losses, Math.max(0, stats.loseAmount)), extra: { first: stats.losses, second: Math.max(0, stats.loseAmount) } });
    }
  },

  getBoard: async function (board, limit) {
    if (isMiniProgram()) return realList(board, limit || 20);
    return mockList(board, limit || 20);
  },

  getMyEntry: async function (board) {
    if (isMiniProgram()) return realMy(board);
    return mockMy(board);
  },

  decodeScore: decode
};

export var Account = {
  getProfile: async function () {
    var profile = await getUserProfile();
    if (profile) {
      return {
        nick: profile.nick || "盒友",
        uid: profile.uid || "--",
        avatarText: (profile.nick || "盒").slice(0, 1),
        mode: "heybox"
      };
    }
    return {
      nick: "本地体验",
      uid: "local-0000",
      avatarText: "盒",
      mode: "local"
    };
  }
};
