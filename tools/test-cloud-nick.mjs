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

rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failures) {
  console.error("FAILED: " + failures + " 项未通过");
  process.exit(1);
}
console.log("OK: 全部场景通过");
