/*
 * 云服务层：排行榜与账号信息。
 * 在小黑盒宿主内（hb-sdk 就绪）使用平台云端排行榜；
 * 普通浏览器开发环境自动回退到本地模拟数据。
 * 身份架构（1.1.15 起）：不使用 user.getInfo 静默读取（鸿蒙宿主缺陷，工单 2323841）；
 * auth.login 保留、仅用于设置页/引导页「同步黑盒资料」按钮的手势换票（见 app.js#syncHbProfile）。
 * 账号 = 榜单通道的隔离身份（getCurrentUserEntry 的 appUserId，
 * boot 时 registerIdentity 保证条目存在）+ 自选/黑盒昵称（随榜单 extra 提交）。
 */
import { isMiniProgram, getSDK } from "./platform.js";

var BOARD_KEYS = {
  win: "sha_board_win",
  lose: "sha_board_lose",
  temple: "sha_board_god"
};

/* score = 次数×1e9 + 沙粒数（10 亿进制）。沙粒数封顶在 1e9-1：
 * 净赚超过 10 亿会溢出污染次数位（指数杠杆下十来场连赢即可触发）。
 * 封顶只影响排序键；真实沙粒数随 extra.second 提交，展示优先读 extra。 */
var AMOUNT_CAP = 999999999;

function encode(wins, amount) {
  var amt = Math.max(0, Math.round(amount));
  if (amt > AMOUNT_CAP) amt = AMOUNT_CAP;
  return wins * 1e9 + amt;
}

function decode(score) {
  var wins = Math.floor(score / 1e9);
  return { first: wins, second: score - wins * 1e9 };
}

/* 魔神殿总榜（平台配额 3 榜已满，封神/破产共用一榜）：
 * score = 封神次数×1e9 + min(破产次数, AMOUNT_CAP)。
 * 两个计数都单调递增 → score 单调递增，天然兼容 only-if-better；
 * 字典序 = 封神优先、破产次之；封顶防破产次数进位污染封神位。
 * 昵称刷新不走 second+1（+1 会落在破产位上），仅随次数变化刷新。 */
function encodeTemple(gods, bankrupts) {
  var b = Math.max(0, Math.round(bankrupts));
  if (b > AMOUNT_CAP) b = AMOUNT_CAP;
  return Math.max(0, Math.round(gods)) * 1e9 + b;
}

function decodeTemple(score) {
  var gods = Math.floor(score / 1e9);
  return { gods: gods, bankrupts: score - gods * 1e9 };
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
    data = { win: {}, lose: {}, temple: {} };
    MOCK_BOTS.forEach(function (b) {
      data.win[b.uid] = { uid: b.uid, nick: b.nick, score: encode(b.wins, b.winProfit), extra: { first: b.wins, second: b.winProfit } };
      data.lose[b.uid] = { uid: b.uid, nick: b.nick, score: encode(b.losses, b.loseAmount), extra: { first: b.losses, second: b.loseAmount } };
    });
    // 示例：一位赌神 + 一位赌狗，便于浏览器联调时看到魔神殿形态
    data.temple["t1"] = { uid: "t1", nick: "沙盘巴菲特", score: encodeTemple(3, 0), extra: { gods: 3, bankrupts: 0, nick: "沙盘巴菲特" } };
    data.temple["t2"] = { uid: "t2", nick: "含泪吃面", score: encodeTemple(0, 5), extra: { gods: 0, bankrupts: 5, nick: "含泪吃面" } };
    mockWrite(data);
  }
  if (!data.temple || !Object.keys(data.temple).length) {
    // 存量 mock 数据升级：补示例（一位赌神 + 一位赌狗），便于浏览器联调时看到魔神殿形态
    data.temple = {
      t1: { uid: "t1", nick: "沙盘巴菲特", score: encodeTemple(3, 0), extra: { gods: 3, bankrupts: 0, nick: "沙盘巴菲特" } },
      t2: { uid: "t2", nick: "含泪吃面", score: encodeTemple(0, 5), extra: { gods: 0, bankrupts: 5, nick: "含泪吃面" } }
    };
    mockWrite(data);
  }
  return data;
}

function mockUpsert(board, entry) {
  var data = mockEnsure();
  var prev = data[board][entry.uid];
  // 昵称变化也覆盖（对齐真实榜单的 second+1 刷新语义）
  if (!prev || entry.score > prev.score || (entry.nick && entry.nick !== prev.nick)) {
    data[board][entry.uid] = entry;
    mockWrite(data);
  }
}

function mockList(board, limit) {
  var data = mockEnsure();
  var list = Object.keys(data[board]).map(function (uid) {
    var e = data[board][uid];
    var d = decode(e.score);
    var extra = e.extra || {};
    return {
      uid: e.uid,
      nick: e.nick,
      first: typeof extra.first === "number" ? extra.first : d.first,
      second: typeof extra.second === "number" ? extra.second : d.second,
      isMe: e.uid === "me"
    };
  });
  list.sort(function (a, b) { return b.first - a.first || b.second - a.second; });
  list.forEach(function (e, i) { e.rank = i + 1; });
  return { entries: list.slice(0, limit || 20) };
}

function mockMy(board) {
  var list = mockList(board, 9999);
  return list.entries.filter(function (e) { return e.isMe; })[0] || null;
}

function mockTempleList(limit) {
  var data = mockEnsure();
  var list = Object.keys(data.temple).map(function (uid) {
    var e = data.temple[uid];
    var d = decodeTemple(e.score);
    return { uid: e.uid, nick: e.nick, gods: d.gods, bankrupts: d.bankrupts, score: e.score, rank: 0, isMe: e.uid === "me" };
  });
  list.sort(function (a, b) { return b.score - a.score; });
  list.forEach(function (e, i) { e.rank = i + 1; });
  return { entries: list.slice(0, limit || 50) };
}

function mockTempleMe() {
  var list = mockTempleList(9999);
  return list.entries.filter(function (e) { return e.isMe; })[0] || null;
}

/* ============================== 云端实现 ============================== */

var myUid = null;

/* ============================== 账号 ============================== */
/*
 * 演变：1.1.6 曾走「榜单条目回退读昵称」的双通道，因新用户无条目拿不到昵称被否撤销；
 * 1.1.15 起移除 user.getInfo 静默读取（鸿蒙生产态被拦），账号一律走榜单通道隔离身份；
 * 1.1.17+ 真实昵称头像由授权换票获得（app.js#syncHbProfile，须用户手势）。
 */

async function realSubmit(board, first, second, displayNick) {
  var sdk = getSDK();
  if (!sdk || !sdk.cloud) return;
  var extra = { first: first, second: second };
  if (displayNick) extra.nick = displayNick; // 自选/黑盒昵称（跨设备经 extra.nick 读回）
  await sdk.cloud.leaderboard.submit({
    key: BOARD_KEYS[board],
    score: encode(first, second),
    extra: extra
  });
}

/**
 * 提交一个榜：分数更优才落库（榜单语义）。
 * 昵称变化但分数未变优时，用「当前榜上 second+1」触发一次 extra 更新——
 * 否则昵称（如同步黑盒资料后）要等下一次赢球才刷得上榜。
 * 本地 0 胜 0 负（新用户/清除本地数据后榜上还有旧条目）同样要能刷昵称；
 * 榜上无条目且无分数时不新建（win 榜条目由 registerIdentity 保证，败榜输过才出现）。
 */
async function submitBoardWithNick(board, first, second, displayNick) {
  var cur = await realMy(board).catch(function () { return null; });
  var curFirst = cur ? cur.first : 0;
  var curSecond = cur ? cur.second : 0;
  var curNick = (cur && cur.extra && cur.extra.nick) || "";
  if (first > curFirst || (first === curFirst && second > curSecond)) {
    await realSubmit(board, first, second, displayNick);
    return;
  }
  if (cur && displayNick && displayNick !== curNick) {
    await realSubmit(board, curFirst, curSecond + 1, displayNick); // 仅刷昵称，1 沙粒触发 only-if-better
  }
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
        // 展示值优先读 extra（score 里的沙粒数已封顶，extra 存真实值；老条目两者一致）
        first: typeof extra.first === "number" ? extra.first : d.first,
        second: typeof extra.second === "number" ? extra.second : d.second,
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
  // 榜单通道返回的隔离身份与 user.getInfo 的 app_user_id 同源：
  // 静默读取被拒的客户端（鸿蒙）上这是唯一的 myUid 来源，供榜单 isMe 高亮
  myUid = e.appUserId;
  var d = decode(e.score);
  var extra = e.extra || {};
  return {
    uid: e.appUserId,
    nick: extra.nick || "我",
    extra: extra,
    first: typeof extra.first === "number" ? extra.first : d.first,
    second: typeof extra.second === "number" ? extra.second : d.second,
    rank: e.rank,
    isMe: true
  };
}

async function realTempleMy() {
  var sdk = getSDK();
  if (!sdk || !sdk.cloud) return null;
  var e = await sdk.cloud.leaderboard.getCurrentUserEntry({ key: BOARD_KEYS.temple });
  if (!e) return null;
  myUid = e.appUserId;
  var d = decodeTemple(e.score);
  return { uid: e.appUserId, scoreRaw: e.score, gods: d.gods, bankrupts: d.bankrupts, rank: e.rank, extra: e.extra || {}, isMe: true };
}

/** 魔神殿总榜提交：仅当（封神, 破产）字典序高于榜上时落库；昵称仅随次数变化刷新。 */
async function realSubmitTemple(gods, bankrupts, displayNick) {
  var sdk = getSDK();
  if (!sdk || !sdk.cloud) return;
  var extra = { gods: gods, bankrupts: bankrupts };
  if (displayNick) extra.nick = displayNick;
  await sdk.cloud.leaderboard.submit({
    key: BOARD_KEYS.temple,
    score: encodeTemple(gods, bankrupts),
    extra: extra
  });
}

/* ============================== 对外接口 ============================== */

export var Cloud = {
  KEYS: BOARD_KEYS,

  isMock: function () {
    return !isMiniProgram();
  },

  submitStats: async function (stats, displayNick) {
    if (!isMiniProgram()) {
      var mockNick = displayNick || "我";
      if (stats.wins > 0 || displayNick) mockUpsert("win", { uid: "me", nick: mockNick, score: encode(stats.wins, Math.max(0, stats.winProfit)), extra: { first: stats.wins, second: Math.max(0, stats.winProfit) } });
      if (stats.losses > 0) mockUpsert("lose", { uid: "me", nick: mockNick, score: encode(stats.losses, Math.max(0, stats.loseAmount)), extra: { first: stats.losses, second: Math.max(0, stats.loseAmount) } });
      return;
    }
    // 0 胜/0 负也带昵称提交：新用户与「清除本地数据」后的用户，榜上旧条目才刷得出昵称
    if (stats.wins > 0 || displayNick) await submitBoardWithNick("win", stats.wins, Math.max(0, stats.winProfit), displayNick);
    if (stats.losses > 0 || displayNick) await submitBoardWithNick("lose", stats.losses, Math.max(0, stats.loseAmount), displayNick);
  },

  getBoard: async function (board, limit) {
    if (isMiniProgram()) return realList(board, limit || 20);
    return mockList(board, limit || 20);
  },

  getMyEntry: async function (board) {
    if (isMiniProgram()) return realMy(board);
    return mockMy(board);
  },

  /**
   * 确保当前用户在胜榜有条目（身份注册）：无条目时提交一条 0 分记录，
   * 让隔离身份（appUserId）在不依赖 user.getInfo 的客户端上也可读。
   * 返回 true = 身份可读（已有条目或注册成功）；false = 未登录/宿主不支持。
   */
  registerIdentity: async function (displayNick) {
    if (!isMiniProgram()) return true; // 本地模拟无需注册
    try {
      var e = await realMy("win");
      if (e) return true;
      await realSubmit("win", 0, 0, displayNick);
      return true;
    } catch (e2) {
      return false;
    }
  },

  decodeScore: decode,

  decodeTemple: decodeTemple,

  /** 与沙粒数封顶同源的转生阈值（10 亿）：余额≥CAP 可封神、≤-CAP 可破产 */
  CAP: AMOUNT_CAP,

  /** 魔神殿总榜提交：封神/破产次数（字典序编码，见 encodeTemple）。0/0 不提交。 */
  submitHonor: async function (gods, bankrupts, displayNick) {
    var g = Math.max(0, Math.round(gods || 0));
    var b = Math.max(0, Math.round(bankrupts || 0));
    if (g <= 0 && b <= 0) return;
    if (!isMiniProgram()) {
      mockUpsert("temple", { uid: "me", nick: displayNick || "我", score: encodeTemple(g, b), extra: { gods: g, bankrupts: b, nick: displayNick || "我" } });
      return;
    }
    try {
      var cur = await realTempleMy();
      var next = encodeTemple(g, b);
      if (!cur || next > cur.scoreRaw) await realSubmitTemple(g, b, displayNick);
    } catch (e) { /* 未登录或异常静默，下次 syncBoards 重试 */ }
  },

  /** 魔神殿总榜（score 序 = 封神优先、破产次之）；拉取失败返回空，不阻塞调用方 */
  getTemple: async function (limit) {
    if (!isMiniProgram()) return mockTempleList(limit || 50);
    try {
      var sdk = getSDK();
      if (!sdk || !sdk.cloud) return { entries: [] };
      var page = await sdk.cloud.leaderboard.getList({ key: BOARD_KEYS.temple, limit: limit });
      var entries = (page && page.entries) || [];
      return {
        entries: entries.map(function (e) {
          var d = decodeTemple(e.score);
          var extra = e.extra || {};
          return { uid: e.appUserId, nick: extra.nick || "赌徒", gods: d.gods, bankrupts: d.bankrupts, rank: e.rank, isMe: myUid ? e.appUserId === myUid : false };
        })
      };
    } catch (e) {
      return { entries: [] };
    }
  },

  getMyTemple: async function () {
    if (!isMiniProgram()) return mockTempleMe();
    try {
      return await realTempleMy();
    } catch (e) {
      return null;
    }
  },

  /** 账号切换/登录态变化时清掉缓存的当前用户标识，榜单 isMe 下次渲染重新判定 */
  resetIdentity: function () {
    myUid = null;
  },

  /** 当前隔离身份（realMy 取到后缓存）；app.js 渲染榜单时回填 isMe 用。
   *  myUid 是模块私有变量，app.js 不能裸引用（曾致 renderBoard 全崩、榜单页空白）。 */
  getMyUid: function () {
    return myUid;
  }
};

/* ============================== 战绩云同步 ============================== */
/*
 * 用 cloud.storage（每个登录用户私有、单值上限 16KB）跨设备同步沙粒与预测记录。
 * 策略：最后写入者胜（LWW）——saveState 防抖推送，启动时云端较新则拉回覆盖本地。
 * 体积保护：超过 15KB 时先丢最旧的已结算预测，未结算记录永不丢；仍装不下则放弃本次推送。
 * 调试宿主（Browser Fake）与鸿蒙 local 模式会报 METHOD_FORBIDDEN / SERVER_API_REQUIRED，
 * 捕获后本会话停用并回退纯本地，不影响任何功能。
 */
var STATE_KEY = "state_v1";
var STATE_MAX_BYTES = 15 * 1024;
var syncDisabled = false;

function cloudStorageModule() {
  var sdk = getSDK();
  return sdk && sdk.cloud && sdk.cloud.storage ? sdk.cloud.storage : null;
}

function syncErrorKind(e) {
  var code = (e && (e.code || e.errorCode)) || "";
  if (code === "UNAUTHORIZED") return "nologin";
  if (code === "METHOD_FORBIDDEN" || code === "SERVER_API_REQUIRED" ||
      code === "PERMISSION_NOT_IN_SNAPSHOT" || code === "PERMISSION_DENIED") return "unsupported";
  return "error";
}

export var Sync = {
  lastKind: "idle", // idle | ok | nologin | unsupported | error

  statusText: function () {
    if (this.lastKind === "ok") return "已开启";
    if (this.lastKind === "nologin") return "未登录";
    if (this.lastKind === "unsupported") return "当前客户端暂不支持";
    if (this.lastKind === "error") return "暂不可用";
    return "—";
  },

  canWrite: function () {
    return !syncDisabled && !!cloudStorageModule();
  },

  /** 打包同步记录；超限时按结算时间丢最旧的已结算预测，装不下返回 null（不丢未结算） */
  pack: function (state, updatedAt) {
    var predictions = Array.isArray(state.predictions) ? state.predictions.slice() : [];
    function tryPack(list) {
      return JSON.stringify({
        v: 1,
        updatedAt: updatedAt || 0,
        state: {
          bankroll: state.bankroll, digs: state.digs, predictions: list,
          gods: state.gods || 0, bankrupts: state.bankrupts || 0,
          godOffered: state.godOffered === true, bankruptOffered: state.bankruptOffered === true,
          lastCeremonyAt: state.lastCeremonyAt || 0
        }
      });
    }
    var body = tryPack(predictions);
    if (body.length <= STATE_MAX_BYTES) return body;
    var settled = predictions
      .filter(function (p) { return p && p.settled; })
      .sort(function (a, b) { return (a.settledAt || a.placedAt || 0) - (b.settledAt || b.placedAt || 0); });
    for (var i = 0; i < settled.length; i++) {
      var idx = predictions.indexOf(settled[i]);
      if (idx >= 0) predictions.splice(idx, 1);
      body = tryPack(predictions);
      if (body.length <= STATE_MAX_BYTES) return body;
    }
    return null;
  },

  /**
   * 推送战绩。返回 true（已推送）/ false（未推送）/
   * { conflict: true, cloud: 记录 }（云端已被其他设备更新且比本地新，调用方应拉回）。
   * 官方契约：写入失败（含 VERSION_CONFLICT）会清掉该 key 的版本凭证缓存，
   * 之后必须先成功 get 一次才能再 set——所以冲突后先读云端再决定重写或拉回。
   */
  write: async function (state, updatedAt) {
    var cs = cloudStorageModule();
    if (!cs) return false;
    var body = this.pack(state, updatedAt);
    if (body === null) {
      console.warn("[sync] 战绩超过云端 16KB 上限，跳过推送");
      return false;
    }
    try {
      await cs.setStorage(STATE_KEY, body);
      this.lastKind = "ok";
      return true;
    } catch (e) {
      this.lastKind = syncErrorKind(e);
      if (this.lastKind !== "error") syncDisabled = true;
      console.warn("[sync] 推送战绩失败：" + this.lastKind + "（" + ((e && (e.code || e.message)) || "") + "）");
      if (this.lastKind !== "error") return false; // 未登录/不支持：无恢复动作
      var cloud = await this.read();               // 读一次恢复凭证缓存；云端较新则让位
      if (cloud && cloud.updatedAt > (updatedAt || 0)) {
        return { conflict: true, cloud: cloud };
      }
      try {
        await cs.setStorage(STATE_KEY, body);      // 本地仍是最新：重写一次
        this.lastKind = "ok";
        return true;
      } catch (e2) {
        console.warn("[sync] 冲突后重写仍失败：" + ((e2 && (e2.code || e2.message)) || ""));
        return false;
      }
    }
  },

  read: async function () {
    var cs = cloudStorageModule();
    if (!cs) return null;
    try {
      var raw = await cs.getStorage(STATE_KEY);
      this.lastKind = "ok";
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || rec.v !== 1 || !rec.state || typeof rec.updatedAt !== "number") return null;
      return rec;
    } catch (e) {
      this.lastKind = syncErrorKind(e);
      if (this.lastKind !== "error") syncDisabled = true;
      console.warn("[sync] 读取战绩失败：" + this.lastKind + "（" + ((e && (e.code || e.message)) || "") + "）");
      return null;
    }
  }
};
