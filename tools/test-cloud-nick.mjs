#!/usr/bin/env node
/*
 * 昵称上榜冒烟测试（不依赖宿主/SDK/浏览器）：
 * 把 js/cloud.js 原样复制到临时目录，旁边放一个 stub 版 platform.js
 * （isMiniProgram/getSDK 由 globalThis.__TEST_SDK 控制），再导入运行。
 * 覆盖 submitStats / submitBoardWithNick 的分支，重点验证：
 *   本地 0 胜 0 负（新用户/清除本地数据后）昵称也能刷上榜单旧条目。
 * 运行：node tools/test-cloud-nick.mjs（或 npm run test:cloud）
 */
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

var root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var tmp = path.join(root, ".tmp-cloud-test");

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
copyFileSync(path.join(root, "js", "cloud.js"), path.join(tmp, "cloud.js"));
writeFileSync(path.join(tmp, "platform.js"), [
  "export function isMiniProgram() { return !!globalThis.__TEST_SDK; }",
  "export function getSDK() { return globalThis.__TEST_SDK || null; }"
].join("\n"));

// mock 榜单走 localStorage，Node 下补一个内存实现
globalThis.localStorage = {
  _s: {},
  getItem(k) { return k in this._s ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; }
};

var { Cloud } = await import(pathToFileURL(path.join(tmp, "cloud.js")).href);

var WIN = "sha_board_win";
var LOSE = "sha_board_lose";
var failures = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log("  PASS " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (detail ? " —— " + detail : ""));
  }
}

/** 造一个可控 SDK：entries 按榜单 key 存服务端条目；submits 记录所有 submit 调用 */
function makeSdk(entries) {
  var submits = [];
  globalThis.__TEST_SDK = {
    cloud: {
      leaderboard: {
        getCurrentUserEntry: async function (p) {
          var e = entries[p.key];
          if (!e) return null;
          return { appUserId: e.uid, score: e.score, extra: e.extra, rank: e.rank || 1 };
        },
        submit: async function (p) {
          submits.push(p);
          entries[p.key] = { uid: "u1", score: p.score, extra: p.extra };
        }
      }
    }
  };
  return submits;
}

/* ---------- 场景 A（核心修复）：本地 0/0，榜上有旧条目（无昵称）→ 刷昵称 ---------- */
console.log("A. 清除本地数据后（榜上 5胜/300 无昵称），同步黑盒资料：");
var submitsA = makeSdk({ [WIN]: { uid: "u1", score: 5e9 + 300, extra: { first: 5, second: 300 } } });
await Cloud.submitStats({ wins: 0, winProfit: 0, losses: 0, loseAmount: 0 }, "赤色之晨");
check("win 榜提交恰好一次", submitsA.length === 1 && submitsA[0].key === WIN,
  JSON.stringify(submitsA.map(function (s) { return s.key; })));
check("分数 = 榜上 second+1（5胜/301）", submitsA[0] && submitsA[0].score === 5e9 + 301,
  String(submitsA[0] && submitsA[0].score));
check("extra.nick 已带上", submitsA[0] && submitsA[0].extra && submitsA[0].extra.nick === "赤色之晨");

/* ---------- 场景 B：0/0 且无昵称 → 什么都不提交 ---------- */
console.log("B. 0/0 且无昵称（未同步/未自选）：");
var submitsB = makeSdk({ [WIN]: { uid: "u1", score: 5e9 + 300, extra: { first: 5, second: 300 } } });
await Cloud.submitStats({ wins: 0, winProfit: 0, losses: 0, loseAmount: 0 }, "");
check("无任何提交", submitsB.length === 0, JSON.stringify(submitsB));

/* ---------- 场景 C：分数更优 → 正常提交真实分数与昵称 ---------- */
console.log("C. 有新战绩（2胜/100旧 → 3胜/200新）：");
var submitsC = makeSdk({ [WIN]: { uid: "u1", score: 2e9 + 100, extra: { first: 2, second: 100, nick: "旧名" } } });
await Cloud.submitStats({ wins: 3, winProfit: 200, losses: 0, loseAmount: 0 }, "新名");
check("提交一次 win", submitsC.length === 1 && submitsC[0].key === WIN);
check("分数用真实战绩（3e9+200）", submitsC[0].score === 3e9 + 200, String(submitsC[0].score));
check("extra.nick 更新", submitsC[0].extra.nick === "新名");

/* ---------- 场景 D：昵称未变 → 不重复提交（防 second+1 漂移） ---------- */
console.log("D. 0/0 但榜上昵称已是当前昵称：");
var submitsD = makeSdk({ [WIN]: { uid: "u1", score: 5e9 + 300, extra: { first: 5, second: 300, nick: "赤色之晨" } } });
await Cloud.submitStats({ wins: 0, winProfit: 0, losses: 0, loseAmount: 0 }, "赤色之晨");
check("无任何提交", submitsD.length === 0, JSON.stringify(submitsD));

/* ---------- 场景 E：全新用户（榜上无条目）0/0 → 不新建条目 ---------- */
console.log("E. 全新用户（无榜上条目）设自选昵称：");
var submitsE = makeSdk({});
await Cloud.submitStats({ wins: 0, winProfit: 0, losses: 0, loseAmount: 0 }, "小明");
check("win 榜不新建（registerIdentity 负责注册）",
  !submitsE.some(function (s) { return s.key === WIN; }),
  JSON.stringify(submitsE.map(function (s) { return s.key; })));
check("lose 榜不新建（输过才出现）",
  !submitsE.some(function (s) { return s.key === LOSE; }));

/* ---------- 场景 F：败榜旧条目（清除数据后）也能刷昵称 ---------- */
console.log("F. 清除本地数据后，败榜旧条目（3败/800 无昵称）刷昵称：");
var submitsF = makeSdk({
  [WIN]: { uid: "u1", score: 5e9 + 300, extra: { first: 5, second: 300 } },
  [LOSE]: { uid: "u1", score: 3e9 + 800, extra: { first: 3, second: 800 } }
});
await Cloud.submitStats({ wins: 0, winProfit: 0, losses: 0, loseAmount: 0 }, "赤色之晨");
var loseSubmits = submitsF.filter(function (s) { return s.key === LOSE; });
check("lose 榜 second+1（3败/801）", loseSubmits.length === 1 && loseSubmits[0].score === 3e9 + 801,
  JSON.stringify(loseSubmits.map(function (s) { return s.score; })));
check("lose 榜 extra.nick 已带上", loseSubmits[0] && loseSubmits[0].extra.nick === "赤色之晨");

/* ---------- 场景 G：浏览器 mock 路径一致性 ---------- */
console.log("G. 浏览器 mock（isMiniProgram=false）0/0 设昵称：");
globalThis.__TEST_SDK = null;
globalThis.localStorage._s = {};
await Cloud.submitStats({ wins: 0, winProfit: 0, losses: 0, loseAmount: 0 }, "小明");
var mockWin = await Cloud.getBoard("win", 50);
var me = mockWin.entries.filter(function (e) { return e.isMe; })[0];
check("mock win 榜出现 0 分「我」且带昵称", !!me && me.nick === "小明" && me.first === 0,
  me ? JSON.stringify(me) : "无 me 条目");
await Cloud.submitStats({ wins: 0, winProfit: 0, losses: 0, loseAmount: 0 }, "小红");
var mockWin2 = await Cloud.getBoard("win", 50);
var me2 = mockWin2.entries.filter(function (e) { return e.isMe; })[0];
check("mock 昵称变化即时更新", !!me2 && me2.nick === "小红", me2 ? JSON.stringify(me2) : "无 me 条目");
var mockLose = await Cloud.getBoard("lose", 50);
var meLose = mockLose.entries.filter(function (e) { return e.isMe; })[0];
check("mock lose 榜不新建", !meLose, meLose ? JSON.stringify(meLose) : "");

/* ---------- 场景 H：净赚超 10 亿封顶——score 次数位不被污染，真实值在 extra ---------- */
console.log("H. 净赚 18 亿（指数杠杆极端值）：");
var submitsH = makeSdk({});
await Cloud.submitStats({ wins: 8, winProfit: 1.8e9, losses: 0, loseAmount: 0 }, "鲸鱼");
check("score = 8×1e9 + 封顶值（次数位完整）",
  submitsH.length === 1 && submitsH[0].score === 8 * 1e9 + 999999999,
  String(submitsH[0] && submitsH[0].score));
check("extra.second 保留真实净赚", submitsH[0] && submitsH[0].extra && submitsH[0].extra.second === 1.8e9,
  String(submitsH[0] && submitsH[0].extra && submitsH[0].extra.second));
check("decode 往返次数位正确", Cloud.decodeScore(8 * 1e9 + 999999999).first === 8);
console.log("   正常值不封顶：");
var submitsH2 = makeSdk({});
await Cloud.submitStats({ wins: 3, winProfit: 21023, losses: 0, loseAmount: 0 }, "常人");
check("5 万级净赚原样编码", submitsH2[0].score === 3 * 1e9 + 21023 && submitsH2[0].extra.second === 21023);

/* ---------- 场景 J：魔神殿总榜（score = 封神×1e9 + 破产，字典序兼容 only-if-better） ---------- */
console.log("J. 魔神殿总榜：");
check("decodeTemple 往返", Cloud.decodeTemple(2e9 + 7).gods === 2 && Cloud.decodeTemple(2e9 + 7).bankrupts === 7);
check("CAP 与转生阈值同源", Cloud.CAP === 999999999);
var submitsJ = makeSdk({});
await Cloud.submitHonor(1, 3, "赌神");
check("首次提交 score = 1e9+3", submitsJ.length === 1 && submitsJ[0].score === 1e9 + 3,
  JSON.stringify(submitsJ.map(function (s) { return s.score; })));
check("extra 带 gods/bankrupts/nick", submitsJ[0].extra.gods === 1 && submitsJ[0].extra.bankrupts === 3 && submitsJ[0].extra.nick === "赌神");
var lenJ = submitsJ.length;
await Cloud.submitHonor(1, 3, "改名");
check("同次数不重复提交（second+1 会污染破产位）", submitsJ.length === lenJ);
await Cloud.submitHonor(2, 3, "赌神");
check("封神次数增加被接受", submitsJ.length === lenJ + 1 && submitsJ[lenJ].score === 2e9 + 3);
await Cloud.submitHonor(2, 5, "赌神");
check("破产次数增加被接受", submitsJ.length === lenJ + 2 && submitsJ[lenJ + 1].score === 2e9 + 5);
await Cloud.submitHonor(0, 0, "x");
check("0/0 不提交", submitsJ.length === lenJ + 2);
var submitsJ2 = makeSdk({});
await Cloud.submitHonor(1, 2e9, "极限");
check("破产次数封顶不污染封神位", submitsJ2.length === 1 && submitsJ2[0].score === 1e9 + 999999999,
  String(submitsJ2[0] && submitsJ2[0].score));

/* ---------- 场景 K：app.js 不得裸引用 cloud.js 私有变量 myUid（曾致 renderBoard 全崩、榜单页空白） ---------- */
console.log("K. 静态检查（myUid / 转生视图齐备）：");
var { readFileSync: rf } = await import("node:fs");
var appSrc = rf(path.join(root, "js", "app.js"), "utf8");
var appNoComments = appSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check("app.js 无裸引用 myUid", !/\bmyUid\b/.test(appNoComments));
var cloudSrc = rf(path.join(root, "js", "cloud.js"), "utf8");
check("Cloud.getMyUid 已定义并被使用", /getMyUid\s*:\s*function/.test(cloudSrc) && /Cloud\.getMyUid\(\)/.test(appSrc));
check("换票已同步短路存在（防重复计费）", /function hbProfileMatchesIdentity/.test(appSrc) && /已同步过/.test(appSrc));
var htmlSrc = rf(path.join(root, "index.html"), "utf8");
check("魔神殿已下线但庆祝页保留（1.3.5）", /id="view-temple"/.test(htmlSrc) === false && /id="openTemple"/.test(htmlSrc) === false && /id="templeCeremony"/.test(htmlSrc));
check("转生逻辑齐备（页面下线，仪式/庆祝页/计数保留）", /function performCeremony/.test(appSrc) && /function renderTemple/.test(appSrc) === false && /function checkHonorPopup/.test(appSrc));

/* ---------- 场景 L：战队图鉴与跟队连击（js/collection.js 纯函数直跑） ---------- */
console.log("L. 战队图鉴/跟队连击：");
var Col = await import(pathToFileURL(path.join(root, "js", "collection.js")).href);

function mkMatch(id, game, nameA, nameB, startAt) {
  return { id: id, game: game, startAt: startAt, teamA: { name: nameA }, teamB: { name: nameB } };
}
var T0 = 1700000000000;
var DAY = 86400000;
var preds = {};
var pFor = function (id) { return preds[id] || null; };

console.log("   下注收录与连击检测：");
var c1 = Col.onBet({}, mkMatch("m1", "lol", "T1", "GEN", T0), "A", null, [], pFor);
check("收录：键=game:队名，b=1", !!c1["lol:T1"] && c1["lol:T1"].b === 1, JSON.stringify(c1));
check("首押即 1 连（s/bs/ls 正确）", c1["lol:T1"].s === 1 && c1["lol:T1"].bs === 1 && c1["lol:T1"].ls === T0);
preds["m1"] = { pick: "A" };
var c2 = Col.onBet(c1, mkMatch("m2", "lol", "T1", "HLE", T0 + 20 * DAY), "A", null, [mkMatch("m1", "lol", "T1", "GEN", T0)], pFor);
check("休赛续连：s=2", c2["lol:T1"].s === 2 && c2["lol:T1"].bs === 2, JSON.stringify(c2["lol:T1"]));
preds["m2"] = { pick: "A" };
var c3 = Col.onBet(c2, mkMatch("m3", "lol", "T1", "DKT", T0 + 40 * DAY), "A", null,
  [mkMatch("mX", "lol", "T1", "KT", T0 + 30 * DAY)], pFor); // mX 落在检测窗口 (ls=T0+20d, ms=T0+40d) 内
check("间隔漏看一场断签：s=1，bs 留档 2", c3["lol:T1"].s === 1 && c3["lol:T1"].bs === 2, JSON.stringify(c3["lol:T1"]));
preds["m3"] = { pick: "A" };
var c4 = Col.onBet(c3, mkMatch("m4", "lol", "T1", "FOX", T0 + 50 * DAY), "A", null,
  [mkMatch("mY", "lol", "T1", "NS", T0 + 45 * DAY)], function () { return { pick: "B" }; });
check("间隔押了对手断签：s=1", c4["lol:T1"].s === 1, JSON.stringify(c4["lol:T1"]));
check("押对手不收 T1（b 只数押它的场次）", c4["lol:T1"].b === 4, String(c4["lol:T1"].b));
var c11 = Col.onBet(c4, mkMatch("m5", "lol", "T1", "GAM", T0 + 120 * DAY), "A", null, [], pFor);
check("间隔超出可验证窗口（>40 天）保守断签", c11["lol:T1"].s === 1, JSON.stringify(c11["lol:T1"]));
var c5 = Col.onBet({}, mkMatch("v1", "valorant", "T1", "GEN", T0), "A", null, [], pFor);
check("跨游戏同名分键（valorant:T1 ≠ lol:T1）", !!c5["valorant:T1"] && !c5["lol:T1"], JSON.stringify(Object.keys(c5)));

console.log("   改选迁移：");
var c6 = Col.onBet({}, mkMatch("m1", "lol", "T1", "GEN", T0), "A", null, [], pFor);
c6 = Col.onBet(c6, mkMatch("m1", "lol", "T1", "GEN", T0), "B", "A", [], pFor);
check("旧队 b-1 且连击清零", c6["lol:T1"].b === 0 && c6["lol:T1"].s === 0, JSON.stringify(c6["lol:T1"]));
check("新队正常收录 1 连", !!c6["lol:GEN"] && c6["lol:GEN"].b === 1 && c6["lol:GEN"].s === 1, JSON.stringify(c6["lol:GEN"]));

console.log("   结算与云合并：");
var c7 = Col.onSettle({}, mkMatch("m1", "lol", "T1", "GEN", T0), "A", true);
check("结算 w=1，旧注 b 回补", c7["lol:T1"].w === 1 && c7["lol:T1"].b === 1, JSON.stringify(c7));
c7 = Col.onSettle(c7, mkMatch("m2", "lol", "T1", "HLE", T0 + DAY), "A", false);
check("结算 l=1（胜率分母 w+l=2）", c7["lol:T1"].l === 1 && c7["lol:T1"].w + c7["lol:T1"].l === 2, JSON.stringify(c7));
var c8 = Col.mergeCollection(
  { "lol:T1": { b: 5, w: 3, l: 1, s: 2, bs: 4, ls: T0 } },
  { "lol:T1": { b: 3, w: 2, l: 2, s: 1, bs: 3, ls: T0 + DAY } }
);
check("合并：计数取 max", c8["lol:T1"].b === 5 && c8["lol:T1"].w === 3 && c8["lol:T1"].l === 2 && c8["lol:T1"].bs === 4, JSON.stringify(c8));
check("合并：s/ls 归 ls 较新一方", c8["lol:T1"].s === 1 && c8["lol:T1"].ls === T0 + DAY, JSON.stringify(c8));
var c8b = Col.mergeCollection({ "lol:T1": { b: 2, w: 1, l: 0, s: 1, bs: 1, ls: T0 } }, {});
check("合并：云端缺字段不覆盖本地", c8b["lol:T1"].b === 2, JSON.stringify(c8b));

console.log("   上限与汇总：");
var big = {};
for (var bi = 0; bi < 151; bi++) big["g:t" + bi] = { b: 1, w: 0, l: 0, s: 0, bs: 0, ls: bi };
var c9 = Col.capCollection(big);
check("151 → 150 且淘汰 ls 最旧", Object.keys(c9).length === 150 && !c9["g:t0"] && !!c9["g:t150"], String(Object.keys(c9).length));
var c10 = Col.collectionSummary({ "lol:T1": { b: 10, w: 3, l: 7, s: 2, bs: 5, ls: 99 }, "val:T1": { b: 2, w: 2, l: 0, s: 0, bs: 2, ls: 50 } });
check("汇总：队伍数/最佳连击", c10.teams === 2 && c10.bestStreak === 5, JSON.stringify({ t: c10.teams, b: c10.bestStreak }));
check("汇总：game/name 解析与胜率", c10.list[0].game === "lol" && c10.list[0].name === "T1" && c10.list[0].rate === 30, JSON.stringify(c10.list[0]));

console.log("   接线静态检查：");
check("Sync.pack 已带 collection", /collection:\s*state\.collection/.test(cloudSrc));
check("app.js 已接线（onBet/onSettle/merge/collectionSummary）",
  /onBet\(state\.collection/.test(appSrc) && /onSettle\(state\.collection/.test(appSrc) &&
  /mergeCollection\(localCodex/.test(appSrc) && /collectionSummary\(state\.collection\)/.test(appSrc));
check("对比链接带 s/t 字段", /s: s\.streak/.test(appSrc) && /t: s\.teams/.test(appSrc));
check("对比页接收端解析 s/t", /clampStat\(extra\.s\)/.test(appSrc) && /clampStat\(extra\.t\)/.test(appSrc));
check("图鉴 DOM 齐备", /id="codexGrid"/.test(htmlSrc) && /id="codexToggle"/.test(htmlSrc) && /id="codexSub"/.test(htmlSrc));
check("renderCodex 已挂进 renderProfile", /renderCodex\(\);/.test(appSrc) && /function renderCodex/.test(appSrc));
check("玩法说明分类菜单齐备", /var RULES_TOPICS/.test(appSrc) && /id="rulesMenuList"/.test(htmlSrc) && /id="rulesDetail"/.test(htmlSrc) && /function openRulesTopic/.test(appSrc) && /function closeRulesTopic/.test(appSrc));
check("保存图片双路径接线（saveFile 主路径 + 截屏兜底）",
  /saveFileBytes\(/.test(appSrc) && /FILE_PICKER_CANCELLED/.test(appSrc) && /openCardFullscreen\(/.test(appSrc));
var platformSrc = rf(path.join(root, "js", "platform.js"), "utf8");
check("platform.js 有 saveFileBytes 包装", /files\.saveFile/.test(platformSrc) && /writeBytes/.test(platformSrc));
var pkgJson = JSON.parse(rf(path.join(root, "package.json"), "utf8"));
check("filesystem 权限已声明", !!(pkgJson.heybox && pkgJson.heybox.permissions && pkgJson.heybox.permissions.filesystem && pkgJson.heybox.permissions.filesystem.enabled === true));
check("版本两处一致", pkgJson.version === (appSrc.match(/APP_VERSION = "([^"]+)"/) || [])[1],
  pkgJson.version + " vs " + (appSrc.match(/APP_VERSION = "([^"]+)"/) || [])[1]);

/* ---------- 场景 M：去围观/关注作者（1.2.7，免权限声明能力） ---------- */
console.log("M. 去围观/关注作者：");
var watchBlock = (appSrc.match(/var WATCH_GAME_APPIDS = \{[\s\S]*?\};/) || [""])[0];
var WATCH_PAIRS = [
  ["cs2", "730"], ["dota2", "570"], ["lol", "900000045"], ["valorant", "900006125"],
  ["\"starcraft-2\"", "900168298"], ["r6", "900217539"], ["pubg", "578080"],
  ["ow", "2357570"], ["rl", "252950"], ["kpl", "99900051"], ["mlbb", "99928389"]
];
check("围观映射 11 款逐对齐备（appid 经 games search 核对，不限于 bindAppIds 池）",
  WATCH_PAIRS.every(function (p) { return watchBlock.indexOf(p[0] + ": \"" + p[1] + "\"") >= 0; }),
  watchBlock.slice(0, 200));
check("platform 三包装齐备（openAppPage/关注状态/请求关注）",
  /navigation\.openAppPage/.test(platformSrc) && /user\.getFollowStatus/.test(platformSrc) && /user\.requestFollowAuthor/.test(platformSrc));
check("app.js 已接线（live 卡片围观徽标/真手势关注/状态探测显隐）",
  /st === "live" && WATCH_GAME_APPIDS\[m\.game\]/.test(appSrc) && /watch-chip" data-watch=/.test(appSrc) &&
  /requestFollowAuthor\(\)/.test(appSrc) && /res\.status === "notFollowing"/.test(appSrc));
check("围观徽标不在竞猜面板（1.2.8 修正）", !/id="watchGameBtn"/.test(htmlSrc) && /id="followAuthorBtn"/.test(htmlSrc));

/* ---------- 场景 N：战队资料页 teamHistory（1.2.9） ---------- */
console.log("N. 战队资料页 teamHistory：");
var NOW = 1700000000000;
var dur = function () { return 2 * 3600000; }; // 统一估时 2h
var histMatches = [
  mkMatch("h1", "lol", "T1", "GEN", NOW - 10 * DAY), // T1 在 A 侧，胜者 A
  mkMatch("h2", "lol", "GEN", "T1", NOW - 8 * DAY),  // T1 在 B 侧，胜者 A → T1 负
  mkMatch("h3", "lol", "T1", "HLE", NOW - 6 * DAY),
  mkMatch("h4", "lol", "T1", "DKT", NOW - 4 * DAY),
  mkMatch("h5", "lol", "T1", "FOX", NOW - 3600000),
  mkMatch("v1", "valorant", "T1", "GEN", NOW - 2 * DAY)
];
histMatches[0].result = { winner: "A", score: "2:0" };
histMatches[1].result = { winner: "A", score: "1:2" };
histMatches[2].result = { winner: "B", score: "0:2" };
histMatches[3].result = { winner: "A", score: "2:1" };
histMatches[4].stage = "决赛"; // 无胜者，开赛 1h < 估时 2h → 进行中 → upcoming
var hn = Col.teamHistory(histMatches, "lol", "T1", NOW, dur);
check("胜负统计（跨侧位正确）：2 胜 2 负", hn.total === 4 && hn.wins === 2 && hn.losses === 2, JSON.stringify({ t: hn.total, w: hn.wins, l: hn.losses }));
check("跨游戏同名不分（valorant:T1 不混入）", hn.recent.every(function (r) { return r.id !== "v1"; }));
check("recent 倒序且含对手/比分", hn.recent[0].id === "h4" && hn.recent[0].opponentName === "DKT" && hn.recent[0].score === "2:1",
  JSON.stringify(hn.recent[0]));
check("进行中归 upcoming 而非 recent", hn.recent.every(function (r) { return r.id !== "h5"; }) && hn.upcoming.length === 1 && hn.upcoming[0].id === "h5",
  JSON.stringify(hn.upcoming));
var ha = Col.teamHistory(histMatches, "lol", "T1", NOW + 5 * 3600000, dur); // 5h 后：h5 超估时无胜者 → recent 待赛果
check("超估时无胜者 → recent 待赛果（won=null）", ha.recent[0].id === "h5" && ha.recent[0].won === null && ha.wins === 2 && ha.total === 5,
  JSON.stringify(ha.recent[0]));
check("upcoming 正序", hn.upcoming[0].startAt <= (hn.upcoming[1] ? hn.upcoming[1].startAt : Infinity));
check("资料页接线静态检查", /id="view-team"/.test(htmlSrc) && /"team"/.test(appSrc.match(/function isSubView[\s\S]*?;/)[0]) &&
  /function renderTeamPage/.test(appSrc) && /openTeamPage\(cell\.dataset\.teamKey, "profile"\)/.test(appSrc) &&
  /openTeamPage\(teamCell\.dataset\.teamKey, "matches"\)/.test(appSrc));

/* ---------- 场景 O：成就殿堂（1.2.10） ---------- */
console.log("O. 成就殿堂：");
var A = await import(pathToFileURL(path.join(root, "js", "achv.js")).href);
var achvIds = A.ACHV_DEFS.map(function (d) { return d.id; });
check("成就 defs：id 唯一、test/称号齐备、规模 ≥30",
  new Set(achvIds).size === achvIds.length && achvIds.length >= 30 &&
  A.ACHV_DEFS.every(function (d) { return typeof d.test === "function" && typeof d.title === "string" && d.title; }));
function snapBase() {
  return { bets: 1, settled: 1, wins: 1, bestWinStreak: 1, bankroll: 5000, minBankroll: 10000,
    maxStake: 100, nightBets: 0, lossStreakBest: 0, codexTeams: 1, codexFollowBest: 0,
    duelsTotal: 0, duelsWon: 0, gods: 0, bankrupts: 0 };
}
var gotO = A.evalAchievements(snapBase(), {});
check("首胜快照解锁（first_bet/first_win/codex_1）",
  gotO.indexOf("first_bet") >= 0 && gotO.indexOf("first_win") >= 0 && gotO.indexOf("codex_1") >= 0, JSON.stringify(gotO));
check("锁存：已解锁不重复返回", A.evalAchievements(snapBase(), { first_bet: 1, first_win: 1, codex_1: 1 }).indexOf("first_win") < 0);
var sO4 = snapBase(); sO4.settled = 5; sO4.wins = 5; sO4.bets = 5; sO4.bestWinStreak = 4;
var sO5 = Object.assign({}, sO4, { bestWinStreak: 5 });
check("边界：streak_5 需 ≥5", A.evalAchievements(sO4, {}).indexOf("streak_5") < 0 && A.evalAchievements(sO5, {}).indexOf("streak_5") >= 0);
var deepO = snapBase(); deepO.bankroll = 2000; deepO.minBankroll = -60000; deepO.settled = 2; deepO.wins = 0; deepO.lossStreakBest = 2; deepO.bets = 2;
check("深渊回望（minBankroll ≤ -5 万）", A.evalAchievements(deepO, {}).indexOf("debt_50k") >= 0);
deepO.bankroll = -30000;
check("绝地重生需回正（负余额不解锁）", A.evalAchievements(deepO, {}).indexOf("debt_recover") < 0);
deepO.bankroll = 2000;
check("绝地重生（回正后解锁）", A.evalAchievements(deepO, {}).indexOf("debt_recover") >= 0);
check("隐藏成就存在且 hidden", A.achvById("loss_10") && A.achvById("loss_10").hidden === true && A.achvById("night_owl").hidden === true);
check("称号取值：已知返回称号、未知返回空串",
  typeof A.achvTitle("first_win") === "string" && A.achvTitle("first_win") !== "" && A.achvTitle("nonexistent") === "");
var mgO = A.mergeAchv({ a: 5 }, { a: 9, b: 3 });
check("mergeAchv 逐键取 max", mgO.a === 9 && mgO.b === 3);
var nO = A.normalizeAchv({ x: "bad", y: 2.7 });
check("normalizeAchv 容错", Object.keys(A.normalizeAchv(null)).length === 0 && nO.y === 3 && !nO.x);
check("云链路静态：title 门控 + extra.title + pack 三字段",
  /titleChanged/.test(cloudSrc) && /extra\.title/.test(cloudSrc) && /achv: state\.achv/.test(cloudSrc) && /minBankroll/.test(cloudSrc));
check("app 接线：saveState 内检测 + minBankroll 更新 + syncBoards 传 title",
  /if \(!achvChecking\)/.test(appSrc) && /state\.bankroll < state\.minBankroll/.test(appSrc) && /nick, avatar, state\.title/.test(appSrc));
var cssSrc = rf(path.join(root, "css", "style.css"), "utf8");
check("主队上榜链路：mt 门控 + extra.mt + getList 透出 + 榜单小队标（mt=纯队名非键）",
  /mtChanged/.test(cloudSrc) && /extra\.mt/.test(cloudSrc) && /mainTeam: typeof extra\.mt/.test(cloudSrc) &&
  /state\.mainTeam === "" \? "" : mainTeamName\(\)/.test(appSrc) && !/state\.mainTeam === "" \? "" : state\.mainTeam\b/.test(appSrc) &&
  /board-mt/.test(appSrc) && /board-mt \.avatar/.test(cssSrc));
check("成就页/入口/徽章 DOM 与渲染齐备",
  /id="view-achv"/.test(htmlSrc) && /id="achvEntry"/.test(htmlSrc) && /id="profileTitle"/.test(htmlSrc) &&
  /function renderAchv/.test(appSrc) && /function toggleTitle/.test(appSrc) &&
  /board-title/.test(appSrc) && !/title-chip/.test(appSrc) && /board-title/.test(cssSrc)); // 1.2.15 称号=昵称下方小字（chip 已废）
check("我的页快捷三联 + 图鉴二级页（1.2.12 瘦身）",
  /id="quick-row"|class="quick-row"/.test(htmlSrc) && /id="codexEntry"/.test(htmlSrc) && /id="view-codex"/.test(htmlSrc) &&
  /id="codexBackBtn"/.test(htmlSrc) && /quickCodexSub/.test(appSrc) && /name === "codex"\) renderCodex/.test(appSrc));

/* ---------- 场景 P：主队主题/提色（1.2.11） ---------- */
console.log("P. 主队主题/提色：");
var C = await import(pathToFileURL(path.join(root, "tools", "extract-team-colors.mjs")).href);
var PW = 32, pixels = Buffer.alloc(PW * PW * 3, 255); // 白底
for (var py = 10; py < 22; py++) {
  for (var pxx = 10; pxx < 22; pxx++) {
    var po = (py * PW + pxx) * 3;
    pixels[po] = 200; pixels[po + 1] = 30; pixels[po + 2] = 40; // 中心红块
  }
}
var pal = C.pickPalette(pixels);
check("红标白底 → 提出红色主色 + 白字（lum≤150）", !!pal && pal[0] === "#c81e28" && pal[2] === 0, JSON.stringify(pal));
var grayPx = Buffer.alloc(PW * PW * 3, 128);
check("纯灰 logo → 无可提色返回 null", C.pickPalette(grayPx) === null);
// 黑白 logo + JPEG 色度噪边复现（1.2.12 修复）：饱和噪边 <4% 判消色差，不许提出假红
var bwPx = Buffer.alloc(PW * PW * 3, 255); // 白底
for (var by = 8; by < 24; by++) {
  for (var bx = 8; bx < 24; bx++) {
    var bo = (by * PW + bx) * 3;
    bwPx[bo] = 20; bwPx[bo + 1] = 20; bwPx[bo + 2] = 20; // 黑色字形
  }
}
for (var ni = 0; ni < 20; ni++) { // 字形边缘撒 20 个红噪点（≈2%，典型 JPEG 色度残留）
  var no = (8 * PW + 8 + ni) * 3;
  bwPx[no] = 220; bwPx[no + 1] = 40; bwPx[no + 2] = 50;
}
var bwPal = C.pickPalette(bwPx);
check("黑白 logo + 2% 红噪边 → 不出假红，出石墨（暗部主导，白字）",
  !!bwPal && bwPal[2] === 0 && lumOf(bwPal[0]) <= 72 && bwPal[0] !== "#dc2832" && bwPal[0][1] !== "d",
  JSON.stringify(bwPal));
// 石墨主题增强（1.2.12）：黑字形白底 → 暗部主导，提出石墨对（深底白字），不再是 null
var bwPx2 = Buffer.alloc(PW * PW * 3, 255);
for (var by2 = 6; by2 < 26; by2++) {
  for (var bx2 = 6; bx2 < 26; bx2++) {
    var bo2 = (by2 * PW + bx2) * 3;
    bwPx2[bo2] = 15; bwPx2[bo2 + 1] = 18; bwPx2[bo2 + 2] = 24; // 大块黑字形（400px ≈ 39%）
  }
}
var graphite = C.pickPalette(bwPx2);
function lumOf(hex6) {
  var n = parseInt(hex6.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}
check("黑白 logo（暗部 39%）→ 石墨主题：主色亮度钳 28-72 + 白字",
  !!graphite && lumOf(graphite[0]) >= 28 && lumOf(graphite[0]) <= 72 && graphite[2] === 0 && lumOf(graphite[1]) > lumOf(graphite[0]),
  JSON.stringify(graphite));
var whitePx = Buffer.alloc(PW * PW * 3, 255);
check("白亮 logo（flatten 后全白）→ 仍回退默认（null）", C.pickPalette(whitePx) === null);
var yPx = Buffer.alloc(PW * PW * 3);
for (var yi = 0; yi < yPx.length; yi += 3) { yPx[yi] = 255; yPx[yi + 1] = 230; yPx[yi + 2] = 60; }
var palY = C.pickPalette(yPx);
check("亮黄主色 → darkText=1（配深字保对比度）", !!palY && palY[2] === 1, JSON.stringify(palY));
var bigCache = {};
for (var ci = 0; ci < 3050; ci++) bigCache["t" + ci] = { c: ["#000000", "#111111", 0], t: ci };
var capped = C.capColors(bigCache, 3000);
check("缓存 LRU 封顶 3000 且淘汰最旧", Object.keys(capped).length === 3000 && !capped.t0 && !!capped.t3049);
check("主队接线静态：state/主题/数据管线齐备",
  /mainTeam/.test(appSrc) && /function applyTeamTheme/.test(appSrc) && /var TEAM_COLORS = DATA\.teamColors/.test(appSrc) &&
  /normalizeTeamColors/.test(readIfDs()) && /teamColors/.test(readIfBuild()) && /teamColors/.test(readIfTrim()));
var wfSrc = rf(path.join(root, ".github", "workflows", "update-matches.yml"), "utf8");
check("workflow 已加提色步骤", /Extract team colors/.test(wfSrc) && /extract-team-colors\.mjs --oss/.test(wfSrc));

/* ---------- 场景 Q：主队等级（1.2.12） ---------- */
console.log("Q. 主队等级：");
check("阈值表等比 ×2、Lv8=128",
  Col.MAIN_LEVEL_THRESHOLDS.length === 8 &&
  Col.MAIN_LEVEL_THRESHOLDS.every(function (v, i) { return v === Math.pow(2, i); }));
var lvCases = [[0, 0], [1, 1], [2, 2], [3, 2], [4, 3], [7, 3], [8, 4], [127, 7], [128, 8], [9999, 8], [-5, 0], [1.9, 1]];
check("mainTeamLevel 查表全对", lvCases.every(function (c) { return Col.mainTeamLevel(c[0]) === c[1]; }),
  JSON.stringify(lvCases.map(function (c) { return Col.mainTeamLevel(c[0]); })));
check("等级链路静态：mainLevels 接线 + ml 门控 + extra.ml + 榜单/资料页展示",
  /function trackMainLevelBet/.test(appSrc) && /trackMainLevelBet\(m, sheetPick, null\)/.test(appSrc) &&
  /mlChanged/.test(cloudSrc) && /extra\.ml/.test(cloudSrc) && /mtLevel: typeof extra\.ml/.test(cloudSrc) &&
  /mainLevels: mergeAchv/.test(appSrc) && /team-lv-badge/.test(appSrc) && /board-mt-lv/.test(appSrc));
check("余额卡主队块（1.2.13）", /id="profileMainTeam"/.test(htmlSrc) && /balance-team-lv/.test(appSrc) &&
  /profileMainTeam"\)\.addEventListener/.test(appSrc));

/* ---------- 场景 R：1.2.15 称号下移 + 主题色全面扩散 + 全部竞猜记录 ---------- */
console.log("R. 称号小字/主题扩散/全部记录：");
check("称号渲染为昵称下方小字（1.3.5 起榜单+硬币榜，无 chip；魔神殿页面已下线）",
  /board-nick-wrap/.test(appSrc) && /board-title/.test(cssSrc) &&
  (appSrc.match(/board-title/g) || []).length >= 1);
check("主题色扩散：衍生变量默认值齐备 + applyTeamTheme 内联覆盖 + CSS 走 var 引用",
  /--accent-rgb: 255, 138, 61/.test(cssSrc) && /--accent-rgb: 232, 98, 15/.test(cssSrc) &&
  /--accent-hi: #ffd08a/.test(cssSrc) && /--accent-hi-mid: #ffb066/.test(cssSrc) && /--accent-glow/.test(cssSrc) &&
  /TEAM_THEME_VARS/.test(appSrc) && /--accent-rgb", rgb/.test(appSrc) &&
  (cssSrc.match(/var\(--accent-rgb\)/g) || []).length >= 40 && (cssSrc.match(/var\(--accent-hi/g) || []).length >= 8);
check("主题色扩散：取消主队时全部衍生变量移除（防残留换肤）",
  /TEAM_THEME_VARS\.forEach\(function \(v\) \{ root\.style\.removeProperty\(v\); \}\)/.test(appSrc));
check("分享卡跟队色：shareThemeColors 提亮防线 + 三处应用",
  /function shareThemeColors/.test(appSrc) && /lum >= 110/.test(appSrc) &&
  /drawPersonAvatar\(ctx, 60, 652, 52, myNickCache \|\| "我", avatarImg, theme\)/.test(appSrc) &&
  /theme \? "rgba\(" \+ theme\.rgb \+ ", \.3\)" : "rgba\(255,255,255,\.07\)"/.test(appSrc));
check("全部竞猜记录页：DOM + 视图接线 + 渲染与分享委托",
  /id="view-history"/.test(htmlSrc) && /id="historyAllBtn"/.test(htmlSrc) && /id="historyBackBtn"/.test(htmlSrc) &&
  /name === "history" \|\| name === "match" \|\| name === "labs"/.test(appSrc) && /"match", "labs", "pickem", "coinboard"\]\.forEach/.test(appSrc) &&
  /function renderHistoryFull/.test(appSrc) && /name === "history"\) renderHistoryFull/.test(appSrc) &&
  /historySettledList"\)\.addEventListener/.test(appSrc));
check("竞猜快照：下注落账冗余存队名/赛事 + 归档降级渲染",
  /n1: m\.teamA\.name,/.test(appSrc) && /n2: m\.teamB\.name,/.test(appSrc) && /tn: m\.tournament/.test(appSrc) &&
  /比赛已归档/.test(appSrc) && /filter\(function \(p\) \{ return matchById\(p\.matchId\); \}\)/.test(appSrc));

/* ---------- 场景 S：1.2.16 比赛详情页 + 采集器 region/endAt + 玩法说明 ---------- */
console.log("S. 比赛详情/采集字段/玩法说明：");
var libSrc = rf(path.join(root, "tools", "lib.mjs"), "utf8");
var pandasSrc = rf(path.join(root, "tools", "adapters", "pandascore.mjs"), "utf8");
check("采集器：location→region + end_at 采集 + normalize 白名单放行 + 合并保底",
  /op1\.location \|\| ""/.test(pandasSrc) && /item\.end_at \|\| ""/.test(pandasSrc) &&
  /endAt: endAt/.test(libSrc) && /merged\.endAt = m\.endAt \|\| cur\.endAt/.test(libSrc) &&
  /region: cur\[side\]\.region/.test(libSrc));
check("比赛详情页：DOM + 视图接线 + 渲染与操作委托",
  /id="view-match"/.test(htmlSrc) && /id="matchBackBtn"/.test(htmlSrc) && /id="matchDetailBody"/.test(htmlSrc) &&
  /name === "history" \|\| name === "match" \|\| name === "labs"/.test(appSrc) &&
  /"match", "labs", "pickem", "coinboard"\]\.forEach/.test(appSrc) &&
  /function renderMatchDetail/.test(appSrc) && /name === "match"\) renderMatchDetail/.test(appSrc) &&
  /scheduleList"\)\.addEventListener/.test(appSrc) && /view-match"\)\.addEventListener/.test(appSrc) &&
  /matchBackBtn"\)\.addEventListener/.test(appSrc) && /goBack\("schedule"\)/.test(appSrc));
check("详情页数据面：region 展示 + endAt + 状态/赛制/等级/预测/围观/分享齐备",
  /function regionLabel/.test(appSrc) && /m\.endAt/.test(appSrc) && /matchDetailInfoRow\("等级"/.test(appSrc) &&
  /data-match-bet/.test(appSrc) && /data-match-watch/.test(appSrc) && /data-match-share/.test(appSrc) &&
  /schedule-row \{/.test(cssSrc) && /cursor: pointer; \/\* 1\.2\.16 行点击进比赛详情 \*\//.test(cssSrc) && /match-hero/.test(cssSrc));
check("玩法说明：比赛详情 topic + 1.2.15 三处新 section",
  /id: "detail", icon: "🔍"/.test(appSrc) && /称号展示/.test(appSrc) &&
  /主队主题色/.test(appSrc) && /全部竞猜记录", p:/.test(appSrc));

/* ---------- 场景 T：1.2.16 约战卡片化 + 狠话（extra 硬闸对拍） ---------- */
console.log("T. 约战卡片/狠话：");
var { createRequire } = await import("node:module");
var { encode } = createRequire(path.join(root, "package.json"))("@msgpack/msgpack");
var DEX = await import(pathToFileURL(path.join(root, "js", "duel-extra.mjs")).href);

var extraCases = [
  { v: 1, d: 1, m: "auto-cs2-20261101-fly-ae", p: "A", s: 10000, n: "赤色之晨", r: "ab3x" },
  { v: 1, d: 1, m: "auto-lol-wild-rift-20261101-abcdefgh-ijkl-2", p: "B", s: 1000000, n: "一二三四五六七八九十十一十", r: "ab3x" },
  { v: 1, d: 1, m: "auto-cs2-20261101-fly-ae", p: "A", s: 100, n: "盒友", r: "z9z9", g: "晚上八点决战到天亮" },
  { v: 1, d: 1, m: "auto-kpl-20261107-ag-sgp-3", p: "B", s: 0, n: "ABCDEFGH", r: "q1w2", g: "GG-ez-ar" },
  { v: 1, d: 1, m: "auto-cs2-20261101-fly-ae", p: "A", s: 1000000, n: "盒友", r: "ab3x", g: "狠🔥话" } // emoji 代理对 4B
];
check("狠话硬闸对拍：duelExtraBytes 与 @msgpack/msgpack 逐字节一致",
  extraCases.every(function (x) { return DEX.duelExtraBytes(x) === encode(x).length; }),
  JSON.stringify(extraCases.map(function (x) { return [DEX.duelExtraBytes(x), encode(x).length]; })));
console.log("  体积参考（估算=编码）：" +
  extraCases.map(function (x) { return DEX.duelExtraBytes(x); }).join("/") + " B");

var worst = { v: 1, d: 1, m: "auto-lol-wild-rift-20261101-abcdefgh-ijkl-2", p: "A", s: 1000000, n: "一二三四五六七八九十十一十", r: "ab3x", g: "一二三四五六七八九十十一十" };
check("硬闸截断：最坏组合（超长 id + 12 字昵称 + 12 字狠话）自动截到 ≤128B",
  encode(DEX.fitDuelExtra(worst).extra).length <= 128 && DEX.fitDuelExtra(worst).trimmed &&
  encode(DEX.fitDuelExtra(extraCases[2]).extra).length <= 128 && !DEX.fitDuelExtra(extraCases[2]).trimmed,
  "worst: " + encode(worst).length + "B → " + encode(DEX.fitDuelExtra(worst).extra).length + "B（g=" +
  (DEX.fitDuelExtra(worst).extra.g || "(无)") + "）");
check("硬闸丢弃：上限压到放不下整句时整体去掉 g",
  !DEX.fitDuelExtra({ v: 1, d: 1, m: "auto-lol-wild-rift-20261101-abcdefgh-ijkl-2", p: "A", s: 1000000, n: "一二三四五六七八九十十一十", r: "ab3x", g: "狠话" }, 50).extra.g);
check("约战狠话接线：输入框 + g 三处透传 + 挑战卡 + 对决卡狠话行",
  /id="duelDialogMsg"/.test(htmlSrc) && /maxlength="12"/.test(htmlSrc) &&
  /function fitDuelExtraWithToast/.test(appSrc) && /extra\.g = words/.test(appSrc) && /extra\.g = rec\.msg/.test(appSrc) &&
  /g: extra\.d === 1 && typeof extra\.g === "string"/.test(appSrc) &&
  /msg: ex\.msg \|\| ex\.g \|\| ""/.test(appSrc) &&
  /duel-banner-vs/.test(appSrc) && /avatarHTML\(m\.teamA\)/.test(appSrc) && /avatarHTML\(m\.teamB\)/.test(appSrc) &&
  /duel-msg/.test(appSrc) && /duel-quote/.test(appSrc) &&
  /duel-vs-side/.test(cssSrc) && /duel-dialog-msg/.test(cssSrc) && /duel-msg/.test(cssSrc));
check("榜单布局防挤压（1.3.1）：fmtCompact 大数缩写 + 数字列封顶 46% + 昵称列弹性占位",
  /function fmtCompact/.test(appSrc) && /fmtCompact\(e\.second\)/.test(appSrc) &&
  /max-width: 46%/.test(cssSrc) && /flex: 1 1 auto; \/\* 弹性占位/.test(cssSrc) &&
  /board-second \{ max-width: 100%; overflow: hidden/.test(cssSrc));
check("选择器计数与列表同口径（1.3.2）：homeListMatches 收敛 + 两处计数复用",
  /function homeListMatches/.test(appSrc) &&
  /var windowMatches = homeListMatches\(\);/.test(appSrc) &&
  /var list = homeListMatches\(\);/.test(appSrc) &&
  /st === "finished" && \(!predictionFor\(m\.id\) \|\| new Date\(m\.startAt\)\.getTime\(\) < dayAgo\)\) return false;/.test(appSrc));
check("主页搜索接线（1.3.2）：输入框 + 三处 matchQuery 同源 + 空态区分",
  /id="matchSearch"/.test(htmlSrc) && /id="matchSearchClear"/.test(htmlSrc) &&
  /var homeQuery = ""/.test(appSrc) && /var homeSearchTimer = null/.test(appSrc) &&
  /"#matchSearch"\)\.addEventListener/.test(appSrc) && /"#matchSearchClear"\)\.addEventListener/.test(appSrc) &&
  /if \(!matchQuery\(m, q\)\) return false; \/\/ 主页搜索（1\.3\.2）/.test(appSrc) &&
  (appSrc.match(/homeQuery\.trim\(\)\.toLowerCase\(\)/g) || []).length >= 3 &&
  /没有匹配的赛事/.test(appSrc));

/* ---------- 场景 U：1.3.2 选手阵容（PandaScore rosters 管线） ---------- */
console.log("U. 选手阵容：");
var rostersTool = rf(path.join(root, "tools", "fetch-team-rosters.mjs"), "utf8");
var buildSrc = rf(path.join(root, "tools", "build-runtime-data.mjs"), "utf8");
var trimSrc = rf(path.join(root, "tools", "trim-embedded.mjs"), "utf8");
var dsSrc = readIfDs();
var umSrc = rf(path.join(root, ".github", "workflows", "update-matches.yml"), "utf8");
var bfSrc = rf(path.join(root, ".github", "workflows", "backfill-matches.yml"), "utf8");
var pandaSrc2 = rf(path.join(root, "tools", "adapters", "pandascore.mjs"), "utf8");
var fetchSrc = rf(path.join(root, "tools", "fetch-matches.mjs"), "utf8");
check("rosters 采集链：pandascore 累积 team-ids + fetch-matches 落盘",
  /teamIds\[game \+ ":" \+ op\.name\]/.test(pandaSrc2) && /var teamIds = \{\}/.test(pandaSrc2) &&
  /data\/team-ids\.json/.test(fetchSrc) && /pandaTeamIds/.test(fetchSrc));
check("rosters 链路静态：工具 + workflow + build/trim 切片 + 客户端渲染",
  /function extractPlayers/.test(rostersTool) && /ROSTER_CAP = 5/.test(rostersTool) && /CACHE_CAP = 1500/.test(rostersTool) &&
  /team-ids\.json/.test(umSrc) && /team-ids\.json/.test(bfSrc) && /Fetch team rosters/.test(bfSrc) &&
  /rosters: rosters/.test(buildSrc) && /out\[key\] = e\.players/.test(trimSrc) &&
  /var ROSTERS = DATA\.rosters \|\| \{\}/.test(appSrc) &&
  /ROSTERS\[key\] = rosters\[key\]/.test(appSrc) &&
  /function normalizeRosters/.test(dsSrc) && /rosters: normalizeRosters\(cached\)/.test(dsSrc) &&
  /roster-list/.test(appSrc) && /roster-row/.test(cssSrc) &&
  /公开赛果平台数据/.test(appSrc));

/* ---------- 场景 V：1.4.0 Pick'Em 赛事竞猜（js/pickem.js 纯函数直跑） ---------- */
console.log("V. Pick'Em 赛事竞猜：");
var PK = await import(pathToFileURL(path.join(root, "js", "pickem.js")).href);

function mkTeams(prefix) {
  var arr = [];
  for (var i = 0; i < 16; i++) arr.push({ name: prefix + (i + 1), short: "T" + (i + 1), region: "xx", logo: "", w: 0, l: 0 });
  return arr;
}
function iso(msFromNow) { return new Date(Date.now() + msFromNow).toISOString(); }
var T16 = mkTeams("队");
var SWISS_RESULTS = {
  adv30: ["队1", "队2"], adv: ["队3", "队4", "队5", "队6", "队7", "队8"],
  out23: ["队9", "队10", "队11"], out13: ["队12", "队13", "队14"], out03: ["队15", "队16"]
};
function mkSwissStage(startsAtMs, teams) {
  return { id: "s1", type: "swiss", label: "第一阶段", startsAt: iso(startsAtMs), endsAt: "", teams: teams || T16,
    matches: [{ id: "m1", a: "队1", b: "队2", startAt: iso(startsAtMs), winner: "", score: "" }], results: null };
}
function fullPicks() { return JSON.parse(JSON.stringify(SWISS_RESULTS)); }

check("数据规范：normalizePickemData 脏事件整条丢弃 + 事件数封顶 8",
  PK.normalizePickemData({ events: [null, { id: "e1", game: "cs2", name: "E", status: "active", stages: [{ id: "s1", type: "swiss", label: "L", teams: T16, matches: [] }] }, { id: "bad" }, { id: "e2", stages: [] }] }).events.length === 1 &&
  (function () { var many = []; for (var i = 0; i < 12; i++) many.push({ id: "e" + i, stages: [{ id: "s", type: "swiss", label: "L", teams: [], matches: [] }] }); return PK.normalizePickemData({ events: many }).events.length === 8; })());
check("截止边界：开赛前 1 小时（镜像 statusOf 的 3600000 语义）+ 队伍未齐不可猜",
  PK.stageOpenForPicks(mkSwissStage(61 * 60 * 1000), Date.now()) === true &&
  PK.stageOpenForPicks(mkSwissStage(59 * 60 * 1000), Date.now()) === false &&
  PK.stageOpenForPicks(mkSwissStage(2 * 3600000, T16.slice(0, 15)), Date.now()) === false);
check("选择完整性：五桶恰好满 / 桶内重复 / 缺员 均按语义判定",
  PK.swissPicksComplete(fullPicks()) === true &&
  (function () { var p = fullPicks(); p.adv30 = ["队1", "队1"]; return PK.swissPicksComplete(p) === false; })() &&
  (function () { var p = fullPicks(); p.adv.pop(); return PK.swissPicksComplete(p) === false; })());
check("计分（瑞士轮）：逐桶位置语义——猜进 3:0 桶的队必须真 3-0 出线（1.3.5 无沙粒奖励字段）",
  (function () {
    var r = PK.scorePhase({ id: "s1", type: "swiss", label: "L", teams: T16, matches: [], results: SWISS_RESULTS }, { type: "swiss", picks: fullPicks() });
    return r && r.correct === 10 && r.total === 10 && r.perfect && r.prize === undefined;
  })() &&
  (function () {
    var p = fullPicks();
    p.adv30 = ["队1", "队3"];  // 队3 实际 3-1/3-2 晋级：放 3:0 桶不算对
    p.adv = ["队2", "队4", "队5", "队6", "队7", "队8"]; // 队2 实际 3-0：放 adv 桶也不算对
    var r = PK.scorePhase({ id: "s1", type: "swiss", label: "L", teams: T16, matches: [], results: SWISS_RESULTS }, { type: "swiss", picks: p });
    return r && r.correct === 8 && !r.perfect;
  })());
check("硬币奖励（1.3.6 改版）：swiss 按阶段币级（Major 不变）/ series 按赛事等级（S银 A铜）/ placement 冠军钻亚季军金（A 级降一级）",
  (function () {
    // swiss coinTier=1（第一阶段）猜对 10 → 10 铜币
    var w1 = PK.settleRewards({ id: "s1", type: "swiss", label: "第一阶段", coinTier: 1, teams: T16, matches: [], results: SWISS_RESULTS }, { type: "swiss", picks: fullPicks() });
    if (!(w1 && w1.coins.c === 10 && w1.coins.s === 0 && w1.coins.g === 0 && w1.coins.d === 0)) return false;
    // coinTier=3（第三阶段）猜对 2 → 2 金币
    var p2 = fullPicks();
    p2.adv = []; p2.out03 = [];
    p2.adv30 = ["队1", "队2"];
    var w2 = PK.settleRewards({ id: "s3", type: "swiss", label: "第三阶段", coinTier: 3, teams: T16, matches: [], results: SWISS_RESULTS }, { type: "swiss", picks: p2 });
    return w2 && w2.coins.g === 2;
  })() &&
  (function () {
    // series 按赛事等级币级（1.3.6 改版，不再按轮数）：猜对 4 场 → S 级/未知 4 银；A 级 4 铜
    var stage = { id: "gA", type: "series", label: "Group A", teams: T16, matches: [
      { id: "r1a", a: "队1", b: "队2", startAt: iso(-7200000), winner: "A", score: "", round: 0 },
      { id: "r1b", a: "队3", b: "队4", startAt: iso(-7000000), winner: "B", score: "", round: 0 },
      { id: "r2a", a: "队5", b: "队6", startAt: iso(-3600000), winner: "B", score: "", round: 1 },
      { id: "r3a", a: "队7", b: "队8", startAt: iso(-1800000), winner: "A", score: "", round: 2 }
    ] };
    var picks = { type: "series", picks: { w: { r1a: "A", r1b: "B", r2a: "B", r3a: "A" } } };
    var wS = PK.settleRewards(stage, picks, ""); // S 级/未知 → 每场银币
    var wA = PK.settleRewards(stage, picks, "a"); // A 级 → 每场铜币
    return wS && wS.coins.c === 0 && wS.coins.s === 4 && wS.coins.g === 0 && wS.coins.d === 0 &&
      wA && wA.coins.c === 4 && wA.coins.s === 0 && wA.coins.g === 0 && wA.coins.d === 0;
  })() &&
  (function () {
    // placement：冠军→钻、亚军→金、季军（并列两队猜中任一）→金；未猜名次不计分母；
    // A 级赛事整体降一级（1.3.6 改版）：冠军→金、亚军/季军→银
    var stage = { id: "po", type: "placement", label: "淘汰赛", startsAt: iso(-86400000), teams: T16.slice(0, 8), matches: [
      { id: "f", a: "队1", b: "队2", startAt: iso(-3600000), winner: "A", score: "", round: 2 }
    ], rounds: ["决赛"], degraded: false, results: { champion: "队1", runnerUp: "队2", third: ["队3", "队4"] } };
    var w = PK.settleRewards(stage, { type: "placement", picks: { champion: "队1", runnerUp: "队2", third: "队4" } }, "");
    var w2 = PK.settleRewards(stage, { type: "placement", picks: { champion: "队2", runnerUp: "", third: "" } }, "");
    var wA = PK.settleRewards(stage, { type: "placement", picks: { champion: "队1", runnerUp: "队2", third: "队4" } }, "a");
    var sc = PK.scorePhase(stage, { type: "placement", picks: { champion: "队1", runnerUp: "队2", third: "队4" } });
    var sc2 = PK.scorePhase(stage, { type: "placement", picks: { champion: "队2", runnerUp: "", third: "" } });
    return w && w.coins.d === 1 && w.coins.g === 2 && w2 && w2.coins.d === 0 && w2.coins.g === 0 &&
      wA && wA.coins.d === 0 && wA.coins.g === 1 && wA.coins.s === 2 &&
      sc && sc.correct === 3 && sc.total === 3 && sc2 && sc2.correct === 0 && sc2.total === 1;
  })());
check("placement 选择完整性：三名次齐且互异才完整；归一化形状校验",
  PK.placementPicksComplete({ champion: "队1", runnerUp: "队2", third: "队3" }) === true &&
  PK.placementPicksComplete({ champion: "队1", runnerUp: "队1", third: "队3" }) === false &&
  PK.placementPicksComplete({ champion: "队1", runnerUp: "", third: "队3" }) === false);
check("placement 部分对阵可猜（1.3.6 修）：名单齐 8 队（哪怕仅 4 场 QF、半决赛/决赛未排期）即可名次竞猜；名单未齐仍不可猜；事件 tier 透传",
  (function () {
    var T8 = [];
    for (var i = 0; i < 8; i++) T8.push({ name: "队" + (i + 1), short: "D" + (i + 1) });
    function poStage(nTeams, nMatches) {
      var ms = [];
      for (var i = 0; i < nMatches; i++) {
        ms.push({ id: "qf" + i, a: "队" + (i * 2 + 1), b: "队" + (i * 2 + 2), startAt: iso(24 * 3600000), winner: "", score: "", round: 0 });
      }
      return { id: "po", type: "placement", label: "淘汰赛", startsAt: iso(24 * 3600000),
        teams: T8.slice(0, nTeams), matches: ms, rounds: [], degraded: nMatches < 7, results: null };
    }
    // 仅 4 场 QF（degraded）+ 名单 8 队 → 可猜
    if (PK.stageOpenForPicks(poStage(8, 4)) !== true) return false;
    // 名单只 4 队（首轮没排完）→ 不可猜
    if (PK.stageOpenForPicks(poStage(4, 2)) !== false) return false;
    // 名单齐但已过截止（第一场 1h 内开赛）→ 不可猜
    var soon = poStage(8, 4);
    soon.matches[0].startAt = iso(30 * 60000);
    soon.startsAt = soon.matches[0].startAt;
    if (PK.stageOpenForPicks(soon) !== false) return false;
    // normalizePickemData 透传事件 tier（a 保留、其余归 ""）
    var nd = PK.normalizePickemData({ events: [
      { id: "ea", game: "cs2", name: "A 级", tier: "a", stages: [{ id: "s", type: "series", label: "G", teams: [], matches: [] }] },
      { id: "es", game: "cs2", name: "S 级", tier: "s", stages: [{ id: "s", type: "series", label: "G", teams: [], matches: [] }] }
    ] });
    return nd.events[0].tier === "a" && nd.events[1].tier === "";
  })());
check("硬币云合并：逐键 max（只增不减，脏值清零）",
  (function () {
    var m = PK.mergePickemCoins({ c: 3, s: 1, g: 0, d: 0 }, { c: 1, s: 2, g: 1, d: 0 });
    return m.c === 3 && m.s === 2 && m.g === 1 && m.d === 0;
  })() &&
  (function () {
    var m = PK.mergePickemCoins({ c: 0, s: 0, g: 0, d: 0 }, { c: -5, s: "x", g: 1.7, d: 1e9 });
    return m.c === 0 && m.s === 0 && m.g === 2 && m.d === 1e6; // 脏值/取整/封顶
  })());
check("云合并：pickedAt 较新者胜选择内容 + settled 取 OR 且奖励随已结算侧 + 旧键迁移（: → ##）",
  (function () {
    var local = { "e:s": { type: "swiss", picks: { adv30: ["队1"], adv: [], out23: [], out13: [], out03: [] }, pickedAt: 100, settled: false, settledAt: 0, score: 0, total: 0 } };
    var cloud = { "e:s": { type: "swiss", picks: { adv30: ["队2"], adv: [], out23: [], out13: [], out03: [] }, pickedAt: 200, settled: false, settledAt: 0, score: 0, total: 0 } };
    var m = PK.mergePickem(local, cloud);
    // 旧键（无 ##）经 normalizePickemState 迁移为 ## 键；手工 id 无冒号故拆分安全
    return m["e##s"] && m["e##s"].picks.adv30[0] === "队2";
  })() &&
  (function () {
    var local = { "e:s": { type: "swiss", picks: { adv30: ["队1"], adv: [], out23: [], out13: [], out03: [] }, pickedAt: 300, settled: false, settledAt: 0, score: 0, total: 0 } };
    var cloud = { "e:s": { type: "swiss", picks: { adv30: ["队2"], adv: [], out23: [], out13: [], out03: [] }, pickedAt: 100, settled: true, settledAt: 50, score: 7, total: 10 } };
    var m = PK.mergePickem(local, cloud)["e##s"];
    return m.settled === true && m.score === 7 && m.prize === 0; // 1.3.5 起沙粒奖励移除，prize 恒 0
  })() &&
  (function () {
    // 脏记录（未知 type / picks 形状错）整条丢弃，不污染本地
    var m = PK.mergePickem({}, { bad: { type: "???", picks: {} }, "e:s": { type: "swiss", picks: "垃圾", pickedAt: 1, settled: false } });
    return !m.bad && m["e##s"] && Array.isArray(m["e##s"].picks.adv30);
  })() &&
  (function () {
    // 新格式键（##）原样保留——自动赛事 id 含冒号（auto:XXX）不再撞拆分
    var m = PK.normalizePickemState({ "auto:X Major##Group A": { type: "series", picks: { w: { m1: "A" } }, pickedAt: 5, settled: false } });
    return m["auto:X Major##Group A"] && m["auto:X Major##Group A"].picks.w.m1 === "A";
  })());

check("series 逐场计分（1.3.4）：只算猜过的场次（中途接入公平）+ 不发全对加成 + 逐场截止",
  (function () {
    var stage = { id: "gA", type: "series", label: "Group A", teams: T16.slice(0, 8), matches: [
      { id: "s-m1", a: "队1", b: "队2", startAt: iso(-7200000), winner: "A", score: "" }, // 已结束（用户没机会猜）
      { id: "s-m2", a: "队3", b: "队4", startAt: iso(-3600000), winner: "B", score: "" },
      { id: "s-m3", a: "队5", b: "队6", startAt: iso(3600000), winner: "", score: "" }
    ] };
    var r = PK.scorePhase(stage, { type: "series", picks: { w: { "s-m2": "B", "s-m3": "A" } } });
    return r && r.correct === 1 && r.total === 1 && r.prize === undefined && r.perfect === false;
  })() &&
  (function () {
    var stage = { id: "gA", type: "series", label: "Group A", teams: [], matches: [
      { id: "s-m1", a: "队1", b: "队2", startAt: iso(-7200000), winner: "A", score: "" } ] };
    return PK.scorePhase(stage, { type: "series", picks: { w: {} } }) === null;
  })() &&
  (function () {
    // 阶段已开打（首场已结束）但剩余场次仍可猜：逐场截止与阶段截止解耦
    var stage = { id: "gA", type: "series", label: "Group A", startsAt: iso(-3600000), teams: [], matches: [
      { id: "s-m1", a: "队1", b: "队2", startAt: iso(-7200000), winner: "A", score: "" },
      { id: "s-m2", a: "队3", b: "队4", startAt: iso(3 * 3600000), winner: "", score: "" } ] };
    return PK.stageOpenForPicks(stage) === true && PK.pickableSeriesMatches(stage).length === 1;
  })());
check("自动收录 S/A 赛事（1.3.6）：tier 筛选 + stage 分组 series + 手工去重 + 日期聚类轮次 + 状态推断",
  (function () {
    var now = Date.now();
    function m(id, tier, tn, st, a, b, startAtMs, winner) {
      return { id: id, game: "cs2", tier: tier, tournament: tn, stage: st,
        teamA: { name: a, short: a.slice(0, 3) }, teamB: { name: b, short: b.slice(0, 3) },
        startAt: iso(startAtMs), result: winner ? { winner: winner, score: "2:0" } : null };
    }
    var matches = [
      m("1", "s", "X Major", "Stage 1", "甲", "乙", -86400000, "A"),
      m("2", "s", "X Major", "Stage 1", "丙", "丁", -60000000, "B"),
      m("3", "a", "X Major", "Playoffs", "甲", "丙", 3 * 3600000, null),
      m("4", "b", "X Major", "Stage 1", "戊", "己", -50000000, "A"),   // tier=b 不收录
      m("5", "b", "Y Cup", "Group A", "甲", "乙", -86400000, "A"),     // 全组 tier=b → 整赛事不收录
      m("6", "s", "手工赛事", "Stage 1", "甲", "乙", -86400000, "A"),  // 手工配置去重
      m("7", "a", "A 级杯", "Group A", "庚", "辛", -86400000, "A"),     // 全 a → 事件 tier="a"
      m("8", "a", "A 级杯", "Group A", "壬", "癸", -60000000, "B")
    ];
    var evs = PK.buildAutoEvents(matches, ["手工赛事"]);
    var xm = evs.filter(function (e) { return e.name === "X Major"; })[0];
    if (!xm || evs.some(function (e) { return e.name === "手工赛事"; })) return false;
    if (xm.status !== "active" || xm.stages.length !== 2) return false; // Stage 1 + Playoffs 两个 series 阶段
    if (xm.tier !== "") return false; // s+a 混合 → 按 S 级处理
    var s1 = xm.stages.filter(function (s) { return s.id === "Stage 1"; })[0];
    var po = xm.stages.filter(function (s) { return s.id === "Playoffs"; })[0];
    if (!s1 || !po || s1.type !== "series" || po.type !== "series") return false;
    if (s1.matches.length !== 2 || po.matches.length !== 1) return false;
    if (s1.matches[0].round !== 0 || po.matches[0].round !== 0) return false;
    if (s1.coinTier !== 1 || po.coinTier !== 1) return false;
    var acup = evs.filter(function (e) { return e.name === "A 级杯"; })[0];
    if (!acup || acup.tier !== "a") return false; // 全 a → A 级（币级整体降一级）
    // Y Cup 组内只有 tier=b → 不收录
    return !evs.some(function (e) { return e.name === "Y Cup"; });
  })());

/* ---------- 场景 W：1.4.0 Pick'Em 接线静态断言 ---------- */
console.log("W. Pick'Em 接线：");
var achvSrc = rf(path.join(root, "js", "achv.js"), "utf8");
var cloudSrc = rf(path.join(root, "js", "cloud.js"), "utf8");
var fpkSrc = rf(path.join(root, "tools", "fetch-pickem.mjs"), "utf8");
var pickemJsSrc = rf(path.join(root, "js", "pickem.js"), "utf8");
check("数据链路：fetch-pickem 聚合 → build/trim 切片（hash 计入）→ data-source normalize → app PICKEM",
  /adv30: \[队名\]/.test(fpkSrc) && /DEFAULT_SWISS_BUCKETS/.test(fpkSrc) && /KEEP_DONE_DAYS = 30/.test(fpkSrc) &&
  /pickem: pickem/.test(buildSrc) && /pickemCount: pickem\.events\.length/.test(buildSrc) &&
  /pickem: \(function \(\)/.test(trimSrc) &&
  /function normalizePickemData/.test(pickemJsSrc) && /normalizePickemData/.test(dsSrc) &&
  /var PICKEM = normalizePickemData\(DATA\.pickem\)\.events/.test(appSrc) &&
  /pickem\.events\.forEach\(function \(ev\)/.test(appSrc) &&
  /pickem, matches: matches/.test(buildSrc));
check("视图接线：两视图 + 关于页入口 + 桶位选择器 sheet 注册（[hidden] 补丁随 sheet-backdrop 继承）",
  /id="view-labs"/.test(htmlSrc) && /id="view-pickem"/.test(htmlSrc) && /id="labsList"/.test(htmlSrc) &&
  /id="pickemEvtabs"/.test(htmlSrc) && /id="pickemBody"/.test(htmlSrc) &&
  /id="pickemSearch"/.test(htmlSrc) && /id="pickemSearchClear"/.test(htmlSrc) && /id="pickemGames"/.test(htmlSrc) &&
  /id="pickemSheet"/.test(htmlSrc) && /id="pickemSheetList"/.test(htmlSrc) &&
  /id="openLabsBtn"/.test(htmlSrc) && /id="labsBackBtn"/.test(htmlSrc) && /id="pickemBackBtn"/.test(htmlSrc) &&
  /name === "labs" \|\| name === "pickem"/.test(appSrc) &&
  /"match", "labs", "pickem", "coinboard"\]\.forEach/.test(appSrc) &&
  /name === "labs"\) renderLabs/.test(appSrc) && /name === "pickem"\) renderPickem/.test(appSrc) &&
  /function bindPickem/.test(appSrc) && /bindPickem\(\);/.test(appSrc) &&
  /"#pickemSheet"/.test(appSrc));
check("作业页筛选与搜索（1.3.6，假设 75/76 同源）：搜索防抖 + 游戏 tiles + 统一口径函数",
  /"#pickemSearch"\)\.addEventListener/.test(appSrc) && /"#pickemSearchClear"\)\.addEventListener/.test(appSrc) &&
  /"#pickemGames"\)\.addEventListener/.test(appSrc) &&
  /function pickemFilteredEvents/.test(appSrc) && // 统一口径：chips 与主体都走它
  (appSrc.match(/pickemFilteredEvents\(\)/g) || []).length >= 1 &&
  /var pickemGame = "all"/.test(appSrc) && /var pickemQuery = ""/.test(appSrc) &&
  /function buildAutoEvents/.test(pickemJsSrc) && /buildAutoEvents\(MATCHES, pickemManualTournaments\(\)\)/.test(appSrc) &&
  /pk-games/.test(cssSrc));
check("状态与结算：state.pickem 全链（init/load/快照/校验/云合并）+ settlePickem 四挂点 + Sync.pack 白名单",
  /mainLevels: \{\}, pickem: \{\}, pickemCoins: \{ c: 0, s: 0, g: 0, d: 0 \}/.test(appSrc) &&
  /pickem: normalizePickemState\(parsed\.pickem\)/.test(appSrc) &&
  /mergePickemCoins\(\{ c: 0, s: 0, g: 0, d: 0 \}, parsed\.pickemCoins\)/.test(appSrc) &&
  /state\.mainLevels, state\.pickem, state\.pickemCoins\]/.test(appSrc) &&
  /state\.pickem = normalizePickemState\(state\.pickem\)/.test(appSrc) &&
  /pickem: mergePickem\(localPickem, s\.pickem\)/.test(appSrc) &&
  /pickemCoins: mergePickemCoins\(localPickemCoins, s\.pickemCoins\)/.test(appSrc) &&
  /function settlePickem/.test(appSrc) &&
  (appSrc.match(/settlePickem\(\)/g) || []).length >= 4 &&
  /pickem: state\.pickem \|\| \{\}/.test(cloudSrc) &&
  /pickemCoins: state\.pickemCoins \|\| \{\}/.test(cloudSrc));
check("workflow：fetch-pickem 步骤 + 显式 continue-on-error（假设 77）+ Release 资产恢复/上传",
  /Fetch pickem events/.test(umSrc) && /node tools\/fetch-pickem\.mjs/.test(umSrc) &&
  /Fetch pickem events/.test(bfSrc) && /node tools\/fetch-pickem\.mjs/.test(bfSrc) &&
  /pattern pickem\.json/.test(umSrc) && /pattern pickem\.json/.test(bfSrc) &&
  /Upload pickem data/.test(umSrc) && /data\/pickem\.json --clobber/.test(bfSrc));
check("玩法/成就/样式：pickem topic + 硬币成就组 + css 关键类 + 魔神殿下线（入口/视图移除，仪式保留）",
  /id: "pickem", icon: "🏆"/.test(appSrc) && /实验功能/.test(appSrc) && /钻石币/.test(appSrc) &&
  /g: "赛事"/.test(achvSrc) && /pickem_first/.test(achvSrc) && /pickem_diamond/.test(achvSrc) &&
  /pickemSubmitted/.test(appSrc) && /pickemCoins: state\.pickemCoins \|\| \{ c: 0, s: 0, g: 0, d: 0 \}/.test(appSrc) &&
  /pickem-slot-grid/.test(cssSrc) && /pickem-bucket/.test(cssSrc) && /pickem-side\.is-picked/.test(cssSrc) &&
  /pickem-picker-row/.test(cssSrc) && /pickem-place/.test(cssSrc) && /board-coins/.test(cssSrc) &&
  /PICKEM_BUCKETS/.test(appSrc));
check("硬币排行榜（1.3.5）：编码/解码/提交/读取 + 视图接线 + labs 入口 + 旧魔神条目过滤",
  /COIN_SCORE_BASE = 1e12/.test(cloudSrc) && /function encodeCoinScore/.test(cloudSrc) && /function decodeCoinScore/.test(cloudSrc) &&
  /function submitCoinBoardWithNick/.test(cloudSrc) && /getCoinBoard: async function/.test(cloudSrc) &&
  /syncCoinBoard\(\)/.test(appSrc) && /function renderCoinBoard/.test(appSrc) &&
  /id="view-coinboard"/.test(htmlSrc) && /id="coinboardBackBtn"/.test(htmlSrc) &&
  /data-labs="coinboard"/.test(appSrc) &&
  /e\.scoreRaw < 1e12/.test(cloudSrc) &&
  /id="openTemple"/.test(htmlSrc) === false &&
  /id="view-temple"/.test(htmlSrc) === false &&
  /id="templeCeremony"/.test(htmlSrc) === true &&
  /"#templeCeremony"/.test(appSrc) === true);

check("series 逐场链路（1.3.4）：聚合器 + 渲染 + 逐场点选 + 结算整段门控（含 placement）",
  /function buildSeriesStage/.test(fpkSrc) && /scfg\.type === "series"\) stages\.push\(buildSeriesStage/.test(fpkSrc) &&
  /function buildPlacementStage/.test(fpkSrc) && /scfg\.type === "placement"\) stages\.push\(buildPlacementStage/.test(fpkSrc) &&
  /function pickableSeriesMatches/.test(pickemJsSrc) && /stage\.type === "series"\) \{\s*return pickableSeriesMatches/.test(pickemJsSrc) &&
  /function pickemMergedSeriesHTML/.test(appSrc) && /pickableSeriesMatches/.test(appSrc) &&
  /stage\.type === "series" \|\| stage\.type === "placement"\) && !stageAllDone\(stage\)\) return/.test(appSrc) &&
  /pickemMergedSeriesHTML\(ev, seriesStages\)/.test(appSrc) && /pickemPlacementBody\(ev, stage, st, rec\)/.test(appSrc));

check("轮次优先合并布局（1.3.6 任务 4）：series 阶段合并单面板 + 每轮子块各带 data-pstage 包裹层 + 轮头日期" +
  " + 已截止卡视觉（is-locked + 已截止·开赛）",
  /function pickemMergedSeriesHTML/.test(appSrc) &&
  /pk-day-group" data-pstage=/.test(appSrc) && // (轮,阶段) 子块必须自带委托包裹层（双重闭合事故的现行防御结构）
  /pk-stage-row" data-pstage=/.test(appSrc) && // 阶段摘要行同键包裹
  appSrc.indexOf('if (lastRound >= 0) html += "</div>"') < 0 && // 旧双重闭合写法不得回潮
  /pickemDayIso/.test(appSrc) && /pickemDayLabel/.test(appSrc) &&
  /locked \? " is-locked" : ""/.test(appSrc) &&
  /已截止 · 开赛 /.test(appSrc) &&
  /pk-node\.is-locked/.test(cssSrc) &&
  /pickem-merged/.test(cssSrc) && /pk-group-head/.test(cssSrc) &&
  /data-pklocked/.test(appSrc));

check("作业页赛程自动更新（1.3.6）：refreshData 两个 applySnapshot 挂点透传 pickem + 可见视图即时重渲染",
  /applySnapshot\(cached\.matches, cached\.meta, cached\.teams, cached\.teamColors, cached\.rosters, cached\.pickem\)/.test(appSrc) &&
  /applySnapshot\(remote\.matches, remote\.meta, remote\.teams, remote\.teamColors, remote\.rosters, remote\.pickem\)/.test(appSrc) &&
  /if \(!\$\("#view-pickem"\)\.hidden\) renderPickem\(\)/.test(appSrc) &&
  /if \(!\$\("#view-labs"\)\.hidden\) renderLabs\(\)/.test(appSrc) &&
  /if \(!\$\("#view-coinboard"\)\.hidden\) renderCoinBoard\(\)/.test(appSrc) &&
  /Pick'Em 赛事只增不减/.test(appSrc));

function readIfDs() { return rf(path.join(root, "js", "data-source.js"), "utf8"); }
function readIfBuild() { return rf(path.join(root, "tools", "build-runtime-data.mjs"), "utf8"); }
function readIfTrim() { return rf(path.join(root, "tools", "trim-embedded.mjs"), "utf8"); }

rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failures) {
  console.error("FAILED: " + failures + " 项未通过");
  process.exit(1);
}
console.log("OK: 全部场景通过");
