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
check("魔神殿视图/庆祝页/入口齐备", /id="view-temple"/.test(htmlSrc) && /id="templeCeremony"/.test(htmlSrc) && /id="openTemple"/.test(htmlSrc));
check("转生逻辑齐备", /function performCeremony/.test(appSrc) && /function renderTemple/.test(appSrc) && /function checkHonorPopup/.test(appSrc));

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
  /function renderAchv/.test(appSrc) && /function toggleTitle/.test(appSrc) && /title-chip/.test(appSrc));
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
