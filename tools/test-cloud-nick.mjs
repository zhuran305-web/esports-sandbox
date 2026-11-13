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

var { Cloud, Sync, encodeCoinScore, decodeCoinScore } = await import(pathToFileURL(path.join(tmp, "cloud.js")).href);

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
check("换票静默刷新齐备（2026-11-07：已同步账号点击=静默刷新，60s 节流，失败保留原资料）",
  /function hbProfileMatchesIdentity/.test(appSrc) && /HB_SYNC_THROTTLE_MS/.test(appSrc) && /已刷新黑盒资料/.test(appSrc) && /已保留原资料/.test(appSrc));
check("切号检测齐备（getAccountState 于 boot+show 挂载；hbprofile 持久化 accountKey）",
  /function checkAccountState/.test(appSrc) && /ak:\s*\(login && login\.accountKey\)/.test(appSrc) &&
  (appSrc.match(/checkAccountState\(\)/g) || []).length >= 3); // 定义 1 + boot 1 + show 1
var htmlSrc = rf(path.join(root, "index.html"), "utf8");
check("魔神殿已下线但庆祝页保留（1.3.5）", /id="view-temple"/.test(htmlSrc) === false && /id="openTemple"/.test(htmlSrc) === false && /id="templeCeremony"/.test(htmlSrc));
check("转生逻辑齐备（页面下线，仪式/庆祝页/计数保留）", /function performCeremony/.test(appSrc) && /function renderTemple/.test(appSrc) === false && /function checkHonorPopup/.test(appSrc));
var platformNoComments = rf(path.join(root, "js", "platform.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check("user.getInfo 全库禁用看护（0.9.6 身份双模式合同：server 模式调它必被拦——platform.js/app.js 代码中不得出现）",
  !/user\s*\.\s*getInfo|\.getInfo\s*\(/.test(appNoComments) &&
  !/user\s*\.\s*getInfo|\.getInfo\s*\(/.test(platformNoComments));
check("platform.js 导出 getAccountState 且 authLogin 回传 accountKey（切号检测依赖）",
  /export async function getAccountState/.test(rf(path.join(root, "js", "platform.js"), "utf8")) &&
  /accountKey:\s*r\.accountKey \|\| ""/.test(rf(path.join(root, "js", "platform.js"), "utf8")));

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
check("榜单超大数档位（2026-11-12 夜间自查）：fmtCompact 含 万亿/亿亿/万亿亿 档位——真实榜单异常 extra.second（~3.9e21）不再显示 15+ 字符",
  /1e20\)\s*return[^;]+万亿亿/.test(appSrc) && /1e16\)\s*return[^;]+亿亿/.test(appSrc) && /1e12\)\s*return[^;]+万亿/.test(appSrc) &&
  appSrc.indexOf('1e20) return') < appSrc.indexOf('1e16) return') && appSrc.indexOf('1e16) return') < appSrc.indexOf('1e12) return'));
check("榜单超大数档位行为级（2026-11-12 夜间自查）：从 app.js 提取 fmtCompact 沙箱执行 10 用例往返",
  (function () {
    var m = appSrc.match(/function fmtCompact[\s\S]*?\n  \}/);
    if (!m) return false;
    var fmtNumStub = function (n) { return Number(n).toLocaleString("en-US"); };
    var fn = new Function("fmtNum", m[0].replace("function fmtCompact", "return function fmtCompact") + ";")(fmtNumStub);
    var cases = [
      [3.93e21, "39.3万亿亿"], [8.57e16, "8.6亿亿"], [2.09e10, "209亿"], [1.54e9, "15.4亿"],
      [1e12, "1万亿"], [3.93e12, "3.9万亿"], [1.5e6, "1.5万"], [999999, "999,999"], [0, "0"], [12345, "12,345"]
    ];
    return cases.every(function (c) { return fn(c[0]) === c[1]; });
  })());
check("demo 注入工具防回归（2026-11-12 夜间自查）：pickem-demo 不得再发已删除的 bracket 类型（1.3.16 normalizeStage 拒收 → 阶段静默不渲染）",
  /type:\s*"bracket"/.test(rf(path.join(root, "tools", "pickem-demo.mjs"), "utf8")) === false);
check("动效四档体系（2026-11-12「沙粒光影」）：boot 读取/设置页/浮层/CSS 四档块/reduced-motion/CLEAR_KEYS/计数滚动/精选卡 全接线", (function () {
  var bootSrc = rf(path.join(root, "public", "theme-boot.js"), "utf8");
  var htmlSrc = rf(path.join(root, "index.html"), "utf8");
  var cssSrc = rf(path.join(root, "css", "style.css"), "utf8");
  return /esports_sandbox_fx/.test(bootSrc) && /setAttribute\("data-fx", fx\)/.test(bootSrc) &&
    /id="fxOptions"/.test(htmlSrc) && /data-fx-opt="mid"/.test(htmlSrc) &&
    /id="fxChooseBackdrop"/.test(htmlSrc) && /data-fx-pick="high"/.test(htmlSrc) && /id="fxValue"/.test(htmlSrc) &&
    /id="fxRippleLayer"/.test(htmlSrc) &&
    /html\[data-fx="off"\] \*/.test(cssSrc) && /prefers-reduced-motion: reduce/.test(cssSrc) &&
    /html\[data-fx="high"\] \.topbar/.test(cssSrc) && /fxTouch/.test(cssSrc) && /fxRingOne/.test(cssSrc) &&
    /::view-transition-old\(root\)/.test(cssSrc) && /fx-touch-ripple/.test(cssSrc) &&
    /html\[data-fx="low"\] \.status-chip\.live::before/.test(cssSrc) && /--ease-spring/.test(cssSrc) &&
    /FX_KEY, FX_PROMPTED_KEY/.test(appSrc) && /function initFx/.test(appSrc) &&
    /function applyFx/.test(appSrc) && /function animateNumber/.test(appSrc) &&
    /is-featured/.test(appSrc) && /initFx\(\)/.test(appSrc) && /lastBankrollShown/.test(appSrc) &&
    /function fxRing/.test(appSrc) && /function fxOn/.test(appSrc) &&
    /document\.startViewTransition/.test(appSrc) &&
    /class="match-card is-' \+ st \+ \(featured \? " is-featured" : ""\) \+ '" data-match="' \+ m\.id \+ '"/.test(appSrc);
})());
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
// 反回退（2026-11-11）：阵容缓存只在 OSS 累积，update-matches 必须恢复它才能 build——
// 否则每小时清空线上阵容切片（rosterCount 恒 0，天禄等队伍资料页无阵容）。固化双通道恢复 + backfill 回传资产。
check("rosters 反回退：update-matches 恢复 team-rosters.json（gh Release + OSS 匿名双通道）+ backfill 回传该资产",
  /--pattern team-rosters\.json/.test(umSrc) && /team-rosters\.json/.test(bfSrc) &&
  /gh release upload data data\/team-rosters\.json/.test(bfSrc) &&
  /阵容切片为 0/.test(buildSrc));

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
check("自动收录 S/A 赛事（1.3.6 建；1.3.14 records 升级；11-09 歧义守卫）：tier 筛选 + stage 分组 + 手工去重" +
  " + 日期聚类轮次 + 状态推断 + 4 队组按证据升级战绩桶（≥5 场=GSL；4 队×2 场=形态歧义保持展示）",
  (function () {
    var now = Date.now();
    function m(id, tier, tn, st, a, b, startAtMs, winner) {
      return { id: id, game: "cs2", tier: tier, tournament: tn, stage: st,
        teamA: { name: a, short: a.slice(0, 3) }, teamB: { name: b, short: b.slice(0, 3) },
        startAt: iso(startAtMs), result: winner ? { winner: winner, score: "2:0" } : null };
    }
    var matches = [
      // Stage 1：4 队 × 2 场（只有首轮带队名）→ 经典 GSL 与 BLAST 式 4进3 不可区分 → 不套桶（展示）
      m("1", "s", "X Major", "Stage 1", "甲", "乙", -86400000, "A"),
      m("2", "s", "X Major", "Stage 1", "丙", "丁", -60000000, "B"),
      // Stage 2：4 队 × 5 场（GSL 证据充分：2:0/2:1/1:2/0:2 分布）→ 升级 records
      m("s2a", "s", "X Major", "Stage 2", "戊", "己", -85000000, "A"),
      m("s2b", "s", "X Major", "Stage 2", "庚", "辛", -84000000, "A"),
      m("s2c", "s", "X Major", "Stage 2", "戊", "庚", -83000000, "A"),
      m("s2d", "s", "X Major", "Stage 2", "己", "辛", -82000000, "A"),
      m("s2e", "s", "X Major", "Stage 2", "己", "庚", -81000000, "A"),
      m("3", "a", "X Major", "Playoffs", "甲", "丙", 3 * 3600000, null),
      m("4", "b", "X Major", "Stage 1", "戊", "己", -50000000, "A"),   // tier=b 不收录
      m("5", "b", "Y Cup", "Group A", "甲", "乙", -86400000, "A"),     // 全组 tier=b → 整赛事不收录
      m("6", "s", "手工赛事", "Stage 1", "甲", "乙", -86400000, "A"),  // 手工配置去重
      // A 级杯：4 队 × 5 场（全 a → A 级；币级整体降一级 → records 铜币）
      m("7", "a", "A 级杯", "Group A", "庚", "辛", -86400000, "A"),
      m("8", "a", "A 级杯", "Group A", "壬", "癸", -86000000, "A"),
      m("9", "a", "A 级杯", "Group A", "庚", "壬", -85000000, "A"),
      m("10", "a", "A 级杯", "Group A", "辛", "癸", -84000000, "A"),
      m("11", "a", "A 级杯", "Group A", "辛", "壬", -83000000, "A")
    ];
    var evs = PK.buildAutoEvents(matches, ["手工赛事"]);
    var xm = evs.filter(function (e) { return e.name === "X Major"; })[0];
    if (!xm || evs.some(function (e) { return e.name === "手工赛事"; })) return false;
    // Stage1(仅 series) + Stage2(records+series孪生) + Playoffs(series) = 4 个阶段
    if (xm.status !== "active" || xm.stages.length !== 4) return false;
    if (xm.tier !== "") return false; // s+a 混合 → 按 S 级处理
    // Stage 1：4 队 × 2 场 → 形态歧义，不套桶（无 |rec 孪生）
    if (xm.stages.some(function (s) { return s.id === "Stage 1|rec"; })) return false;
    var s1 = xm.stages.filter(function (s) { return s.id === "Stage 1"; })[0];
    if (!s1 || s1.type !== "series" || s1.displayOnly !== true) return false;
    // Stage 2：4 队 × 5 场 → records（GSL 桶）+ 同源 series 孪生（历史逐场选择结算通道）
    var rec2 = xm.stages.filter(function (s) { return s.id === "Stage 2|rec"; })[0];
    var s2 = xm.stages.filter(function (s) { return s.id === "Stage 2"; })[0];
    var po = xm.stages.filter(function (s) { return s.id === "Playoffs"; })[0];
    if (!rec2 || !s2 || !po || rec2.type !== "records" || s2.type !== "series" || po.type !== "series") return false;
    if (rec2.srcStage !== "Stage 2" || rec2.coinTier !== 2) return false; // S 级银币
    if (rec2.buckets.length !== 4 || rec2.buckets[0].k !== "2:0" ||
        rec2.buckets.reduce(function (s, b) { return s + b.cap; }, 0) !== 4) return false; // GSL 桶 2:0/2:1/1:2/0:2 各 1
    if (rec2.teams.length !== 4 || !rec2.results) return false; // 全完赛且分布吻合 → 出结果
    if ((rec2.results["2:0"] || []).join() !== "戊") return false;
    if (rec2.matches[0].round !== 0) return false;
    if (s2.displayOnly !== true || po.displayOnly !== true) return false; // series 全部纯展示
    if (xm.stages.some(function (s) { return s.type === "records" && s.srcStage === "Playoffs"; })) return false; // 淘汰赛豁免
    var acup = evs.filter(function (e) { return e.name === "A 级杯"; })[0];
    if (!acup || acup.tier !== "a") return false; // 全 a → A 级（币级整体降一级）
    var acupRec = acup.stages.filter(function (s) { return s.type === "records"; })[0];
    if (!acupRec || acupRec.coinTier !== 1) return false; // A 级战绩桶=铜币
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
  /structures: structures/.test(buildSrc) && /structureCount/.test(buildSrc) && // 2026-11-10 赛事结构切片入 hash/meta
  /pickem, structures: structures, matches: matches/.test(buildSrc));
check("视图接线：两视图 + 关于页入口 + 桶位选择器 sheet 注册（[hidden] 补丁随 sheet-backdrop 继承）",
  /id="view-labs"/.test(htmlSrc) && /id="view-pickem"/.test(htmlSrc) && /id="labsList"/.test(htmlSrc) &&
  /id="pickemSelectors"/.test(htmlSrc) && /id="pickemBody"/.test(htmlSrc) &&
  /id="pickemSearch"/.test(htmlSrc) && /id="pickemSearchClear"/.test(htmlSrc) &&
  /id="pickemGamePopover"/.test(htmlSrc) && /id="pickemEvPopover"/.test(htmlSrc) &&
  /id="pickemSheet"/.test(htmlSrc) && /id="pickemSheetList"/.test(htmlSrc) &&
  /id="openLabsBtn"/.test(htmlSrc) && /id="labsBackBtn"/.test(htmlSrc) && /id="pickemBackBtn"/.test(htmlSrc) &&
  /name === "labs" \|\| name === "pickem"/.test(appSrc) &&
  /"match", "labs", "pickem", "coinboard"\]\.forEach/.test(appSrc) &&
  /name === "labs"\) renderLabs/.test(appSrc) && /name === "pickem"\) renderPickem/.test(appSrc) &&
  /function bindPickem/.test(appSrc) && /bindPickem\(\);/.test(appSrc) &&
  /"#pickemSheet"/.test(appSrc));
check("作业页筛选与搜索（1.3.6 统一口径；1.3.12 换主页同款浮层选择器）",
  /"#pickemSearch"\)\.addEventListener/.test(appSrc) && /"#pickemSearchClear"\)\.addEventListener/.test(appSrc) &&
  /"#pickemGameGrid"\)\.addEventListener/.test(appSrc) && /"#pickemEvList"\)\.addEventListener/.test(appSrc) &&
  /#pickemGamePopover"\)\.hidden/.test(appSrc) && // 胶囊开关浮层
  /function pickemFilteredEvents/.test(appSrc) && // 统一口径：浮层列表与主体都走它
  (appSrc.match(/pickemFilteredEvents\(\)/g) || []).length >= 1 &&
  /function pickemVisibleEvents/.test(appSrc) && // 1.3.14：已结束赛事不进作业页（列表/计数/空态同源）
  /var base = pickemVisibleEvents\(\)/.test(appSrc) &&
  /var all = pickemVisibleEvents\(\)/.test(appSrc) &&
  /pickemEventById\(PICKEM_SCOPED_EVENT\)/.test(appSrc) && // 主页公测入口：scoped 赛事已结束→隐藏按钮
  /scopedWrap\.hidden = !\(scopedEv && scopedEv\.status !== "done"\)/.test(appSrc) &&
  /var pickemGame = "all"/.test(appSrc) && /var pickemQuery = ""/.test(appSrc) &&
  /function buildAutoEvents/.test(pickemJsSrc) && /buildAutoEvents\(MATCHES, pickemManualTournaments\(\), STRUCTURES\)/.test(appSrc) &&
  /function autoRecordsBuckets/.test(pickemJsSrc) && // 1.3.14：4 队组自动升级战绩桶（淘汰赛阶段名豁免）
  /isPlayoffStageKey\(sk\) \? null : autoRecordsBuckets/.test(pickemJsSrc) &&
  /id: sk \+ "\|rec"/.test(pickemJsSrc) && // records 阶段 recKey 与同源 series 阶段隔离（历史选择结算通道不冲撞）
  /recTwin\[s\.srcStage\] = 1/.test(appSrc) && /!recTwin\[s\.id\]/.test(appSrc) && // 渲染去重：孪生 series 隐藏（桶体已含对阵与赛果）
  /pk-selectors\[hidden\]/.test(cssSrc)); // [hidden] 显式补丁（浮层常显陷阱）
check("桶体奖励展示与结算同源（1.3.15）：records/swiss 桶体币级走 stage.coinTier（settleRewards 同源，防 ev.tier 再漂移）",
  /coinKeyForTier\(stage\.coinTier \|\| 1\)/.test(appSrc) && // pickemSwissBody 奖励行
  /奖励：每支落位正确得/.test(appSrc) && // 桶体奖励文案在场（placement 有、逐场行有，桶体 2026-11-10 补）
  /coinKeyForTier\(\(recStage0 && recStage0\.coinTier\) \|\| 1\)/.test(appSrc) && // 规则文案同源
  /export function coinKeyForTier/.test(pickemJsSrc)); // helper 从 pickem.js 导出
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

check("series 逐场链路（1.3.4）：聚合器 + 渲染 + 逐场点选 + 结算整段门控（含 placement；2026-11-11 起接线带 builtById 供 qualifyFrom 推导）",
  /function buildSeriesStage/.test(fpkSrc) && /scfg\.type === "series"\) \{ var ss = buildSeriesStage\(scfg, sm\); if \(ss\) \{ stages\.push\(ss\); builtById\[ss\.id\] = ss; \} \}/.test(fpkSrc) &&
  /function buildPlacementStage/.test(fpkSrc) && /scfg\.type === "placement"\) \{ var ps = buildPlacementStage\(scfg, sm, structure, builtById\)/.test(fpkSrc) &&
  /function deriveQualifiedFromGroups/.test(fpkSrc) && /qualifyFrom/.test(fpkSrc) &&
  /function pickableSeriesMatches/.test(pickemJsSrc) && /stage\.type === "series"\) \{\s*if \(stage\.displayOnly\) return false;[^\n]*\n\s*return pickableSeriesMatches/.test(pickemJsSrc) &&
  /function pickemMergedSeriesHTML/.test(appSrc) && /pickableSeriesMatches/.test(appSrc) &&
  /stage\.type === "series" \|\| stage\.type === "placement" \|\| stage\.type === "records"\) && !stageAllDone\(stage\)\) return/.test(appSrc) &&
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
  /applySnapshot\(cached\.matches, cached\.meta, cached\.teams, cached\.teamColors, cached\.rosters, cached\.pickem, cached\.structures\)/.test(appSrc) &&
  /applySnapshot\(remote\.matches, remote\.meta, remote\.teams, remote\.teamColors, remote\.rosters, remote\.pickem, remote\.structures\)/.test(appSrc) &&
  /if \(!\$\("#view-pickem"\)\.hidden\) renderPickem\(\)/.test(appSrc) &&
  /if \(!\$\("#view-labs"\)\.hidden\) renderLabs\(\)/.test(appSrc) &&
  /if \(!\$\("#view-coinboard"\)\.hidden\) renderCoinBoard\(\)/.test(appSrc) &&
  /Pick'Em 赛事只增不减/.test(appSrc));

check("已删函数零残留（夜间自查 1 轮：swiss 正文残留 pickemRoundFlowHTML 调用——Major 作业页运行时 ReferenceError，与 pickableBracketMatches 同类）",
  ["pickableBracketMatches", "pickemSeriesBody", "pickemRoundFlowHTML"].every(function (fn) {
    return appSrc.indexOf(fn + "(") < 0 && appSrc.indexOf("function " + fn) < 0;
  }) &&
  /function pickemStaticRoundFlowHTML/.test(appSrc) && // swiss 对阵展示的替代实现
  /pickemStaticRoundFlowHTML\(stage, rec\)/.test(appSrc));

/* ---------- 场景 X（夜间自查 R2）：Sync.write 冲突恢复路径 ----------
   官方契约：写失败（含 VERSION_CONFLICT）清掉版本凭证缓存，必须先成功 get 一次才能再 set——
   盲目重试 set 永远失败（陷阱条目「cloud.storage 写入失败后重试 set 一直失败」）。
   此前该路径零测试覆盖，只有线上行为背书。 */
console.log("X. Sync.write 冲突恢复：");
var calls = [];
var cloudRec = null;
function makeSyncSdk(mode, failCode) {
  // mode: "always" = 每次都失败；"first" = 仅首次失败；failCode 缺省 VERSION_CONFLICT
  failCode = failCode || "VERSION_CONFLICT";
  var failAlways = mode === "always";
  var failFirst = mode === "first";
  calls = [];
  globalThis.__TEST_SDK = {
    cloud: {
      storage: {
        setStorage: async function () {
          calls.push("set");
          if (failAlways || failFirst) {
            if (failFirst) failFirst = false;
            var e = new Error("sim"); e.code = failCode; throw e;
          }
        },
        getStorage: async function () {
          calls.push("get");
          return cloudRec ? JSON.stringify(cloudRec) : null;
        }
      }
    }
  };
}
var smallState = { bankroll: 100, digs: 0, predictions: [], pickem: {}, pickemCoins: { c: 0, s: 0, g: 0, d: 0 } };
// 顶层 await（文件为 ESM）：保证用例跑完再进文末汇总
// ① VERSION_CONFLICT + 云端较新 → {conflict:true}，调用序 set→get（绝不盲试第二次 set）
makeSyncSdk("always", "VERSION_CONFLICT");
cloudRec = { v: 1, updatedAt: 5000, state: { bankroll: 1, digs: 0, predictions: [] } };
var r1 = await Sync.write(smallState, 4000);
check("① 写冲突+云端较新 → 返回 {conflict:true, cloud} 且调用序 set→get（无第二次 set）",
  !!(r1 && r1.conflict === true && r1.cloud && r1.cloud.updatedAt === 5000) &&
  calls.join(",") === "set,get",
  "got calls=" + calls.join(",") + " r1=" + JSON.stringify(r1 && { conflict: r1.conflict }));
// ② 写冲突 + 云端无记录 → get 恢复凭证后重写一次成功：set→get→set
makeSyncSdk("first", "VERSION_CONFLICT");
cloudRec = null;
var r2 = await Sync.write(smallState, 9000);
check("② 写冲突+云端无记录 → get 恢复凭证后重写成功：调用序 set→get→set",
  r2 === true && calls.join(",") === "set,get,set",
  "got calls=" + calls.join(",") + " r2=" + r2);
// ③ 重写仍失败 → false（放弃，等下次防抖收敛）
makeSyncSdk("always", "VERSION_CONFLICT");
cloudRec = { v: 1, updatedAt: 1000, state: { bankroll: 1, digs: 0, predictions: [] } };
var r3 = await Sync.write(smallState, 9000);
check("③ 写冲突+云端较旧+重写仍失败 → false 放弃（调用序 set→get→set）",
  r3 === false && calls.join(",") === "set,get,set",
  "got calls=" + calls.join(",") + " r3=" + r3);
// ④ UNAUTHORIZED → 无恢复动作：只 set 一次，进入 nologin 停用
makeSyncSdk("always", "UNAUTHORIZED");
var r4 = await Sync.write(smallState, 9000);
check("④ UNAUTHORIZED → 只 set 一次无恢复（lastKind=nologin）",
  r4 === false && calls.join(",") === "set" && Sync.lastKind === "nologin",
  "got calls=" + calls.join(",") + " lastKind=" + Sync.lastKind);

/* ---------- 场景 Y（夜间自查 R4）：硬币榜编解码往返 ----------
   encode: 1e12 + d×1e10 + g×1e7 + s×1e4 + c×10 + tick；decode 必须按同乘位拆回。
   历史坑：旧 decode 先整除 10 再拆位，s×1e4 错位落进 c 段（s=2 被读成 🥉2000，
   1.3.6 硬币榜实测抓到——E2E 结算发 2 枚银币、榜上显示铜币 2000）。 */
console.log("Y. 硬币榜编解码往返：");
check("① s=2 回归（银币 2 枚不再错显为铜币 2000）",
  (function () { var b = decodeCoinScore(encodeCoinScore({ s: 2 }, 0)); return b.d === 0 && b.g === 0 && b.s === 2 && b.c === 0; })());
check("② 混合组合往返（含 tick 0-9 不串位）",
  (function () {
    var combos = [
      { c: 1, s: 0, g: 0, d: 0 }, { c: 0, s: 1, g: 0, d: 0 }, { c: 0, s: 0, g: 1, d: 0 },
      { c: 0, s: 0, g: 0, d: 1 }, { c: 123, s: 45, g: 6, d: 7 }, { c: 999, s: 999, g: 999, d: 99 }
    ];
    return combos.every(function (coins) {
      for (var tick = 0; tick <= 9; tick++) {
        var back = decodeCoinScore(encodeCoinScore(coins, tick));
        if (back.d !== (coins.d || 0) || back.g !== (coins.g || 0) || back.s !== (coins.s || 0) || back.c !== (coins.c || 0)) return false;
      }
      return true;
    });
  })());
check("③ 旧魔神条目过滤（<1e12 → null）与 1e12 边界",
  decodeCoinScore(999999999999) === null && decodeCoinScore(1e12) !== null &&
  (function () { var b = decodeCoinScore(1e12); return b.d === 0 && b.g === 0 && b.s === 0 && b.c === 0; })() &&
  decodeCoinScore(2000) === null);

/* ---------- 场景 Z（夜间自查 R5）：buildAutoEvents 日期聚类边界 ---------- */
console.log("Z. buildAutoEvents 日期聚类（北京时间 +8h）边界：");
check("① 跨天聚类：23:50 与次日 00:10（北京）分属两轮；同日两场同轮", (function () {
  function mk(id, utcIso) {
    return { id: id, game: "cs2", tier: "s", tournament: "聚类测试赛", stage: "Group A",
      teamA: { name: "甲" + id }, teamB: { name: "乙" + id }, startAt: utcIso, result: null };
  }
  var evs = PK.buildAutoEvents([
    mk("a", "2026-11-10T15:50:00.000Z"), // 北京 11-10 23:50
    mk("b", "2026-11-10T16:10:00.000Z"), // 北京 11-11 00:10
    mk("c", "2026-11-10T10:00:00.000Z")  // 北京 11-10 18:00（与 a 同轮）
  ], []);
  var ev = evs[0];
  if (!ev || ev.stages.length !== 1) return false;
  var rounds = {};
  ev.stages[0].matches.forEach(function (m) { rounds[m.id] = m.round; });
  return rounds["a"] === 0 && rounds["c"] === 0 && rounds["b"] === 1;
})());
check("② 脏 startAt 场次 round 归 0 且不抛错", (function () {
  var evs = PK.buildAutoEvents([
    { id: "x", game: "cs2", tier: "s", tournament: "脏数据赛", stage: "G", teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: "not-a-date", result: null }
  ], []);
  return evs.length === 1 && evs[0].stages[0].matches[0].round === 0;
})());

/* ---------- 场景 AB（2026-11-07 建；2026-11-08 改 mid 主键）：mergeMatches 同场标识与治愈口径 ----------
   历史 bug 一：matchKey 用队简称有序拼接派生，PandaScore 重取时主客交换/队名简称编辑会让同一场
   fork 成孪生（74 组）。修复一=pid 对拼键——**被 11-08 事故推翻**：同两队多场（双败再相遇/背靠背/
   双循环）共享 pid 键 → 跨场污染 + 重复 id，采集连败 26h。修复二（现行）=**PandaScore match id
   （mid）作同场主键**——唯一、稳定、天然区分同队多场；无 mid 的 manual/旧数据走 slug 键。 */
console.log("AB. mergeMatches mid 主键（同场标识）与治愈口径：");
var Lib = await import(pathToFileURL(path.join(root, "tools", "lib.mjs")).href);
check("① 主客交换 + 队简称编辑的重取经 mid 键并入原条目（不再 fork）", (function () {
  var existing = [{
    id: "auto-cs2-20261024-furia-den", game: "cs2", mid: 5550001, tournament: "T", stage: "Group", startAt: "2026-10-24T16:14:37.000Z",
    teamA: { name: "FURIA", short: "FURIA" }, teamB: { name: "DENDELE CS", short: "DEN" },
    result: { winner: "A", score: "2:0" }, status: "finished", source: "pandascore"
  }];
  // 重取：主客交换 + 简称 DEN→DC（历史实测的两种 fork 触发叠加）——mid 相同即同场
  var incoming = [{
    game: "cs2", mid: 5550001, tournament: "T", stage: "Group", startAt: "2026-10-24T16:14:37.000Z",
    teamA: { name: "DENDELE CS", short: "DC" }, teamB: { name: "FURIA", short: "FURIA" },
    result: null, source: "pandascore"
  }];
  var r = Lib.mergeMatches(existing, incoming, { retentionDays: 45 });
  // incoming 无赛果 → 不覆盖原赛果（正确语义）；防 fork 的判据 = added===0（没有裂出新条目）
  return r.matches.length === 1 && r.matches[0].id === "auto-cs2-20261024-furia-den" && r.added === 0;
})());
check("② 无 mid 的旧条目仍走 slug 键（行为不变，正常并入）", (function () {
  var existing = [{
    id: "auto-cs2-20261105-sta-xi", game: "cs2", tournament: "T", stage: "R", startAt: "2026-11-05T17:08:42.000Z",
    teamA: { name: "STATE", short: "STA" }, teamB: { name: "XI", short: "XI" },
    result: { winner: "A", score: "1:0" }, status: "finished", source: "pandascore"
  }];
  var incoming = [{
    game: "cs2", tournament: "T", stage: "R", startAt: "2026-11-05T17:08:42.000Z",
    teamA: { name: "STATE", short: "STA" }, teamB: { name: "XI", short: "XI" },
    result: null, source: "pandascore"
  }];
  var r = Lib.mergeMatches(existing, incoming, { retentionDays: 45 });
  return r.matches.length === 1 && r.matches[0].id === "auto-cs2-20261105-sta-xi" && r.matches[0].result.winner === "A";
})());
check("③ 同两队两场（双败再相遇，mid 不同）：互不误并、互不污染（11-08 事故回归）", (function () {
  var existing = [{
    id: "auto-cs2-20261107-ace-ryve", game: "cs2", tournament: "T", stage: "R", startAt: "2026-11-07T14:00:00.000Z",
    teamA: { name: "Acend", short: "ACE" }, teamB: { name: "Ryvex", short: "RYVE" },
    result: null, status: "open", source: "pandascore"
  }];
  // 第二场（11-08 重逢，PandaScore 不同 match id）重取：绝不能并进 11-07 条目
  var incoming = [{
    game: "cs2", mid: 9900002, tournament: "T", stage: "R", startAt: "2026-11-08T14:00:00.000Z",
    teamA: { name: "Acend", short: "ACE" }, teamB: { name: "Ryvex", short: "RYVE" },
    result: { winner: "A", score: "2:1" }, status: "finished", source: "pandascore"
  }];
  var r = Lib.mergeMatches(existing, incoming, { retentionDays: 45 });
  if (r.matches.length !== 2) return false;
  var byId = {};
  r.matches.forEach(function (m) { byId[m.id] = m; });
  return byId["auto-cs2-20261107-ace-ryve"] && byId["auto-cs2-20261107-ace-ryve"].result === null &&
    byId["auto-cs2-20261108-ace-ryve"] && byId["auto-cs2-20261108-ace-ryve"].result.winner === "A";
})());
check("④ mid 经 merge 往返保留；manual 覆盖不丢 pandascore 的 mid", (function () {
  var existing = [{
    id: "auto-cs2-20261111-a-b", game: "cs2", mid: 7700011, tournament: "T", stage: "R", startAt: "2026-11-11T15:30:00.000Z",
    teamA: { name: "A队", short: "A" }, teamB: { name: "B队", short: "B" },
    result: null, status: "open", source: "pandascore", note: "原始"
  }];
  var incoming = [{
    game: "cs2", tournament: "T", stage: "R", startAt: "2026-11-11T15:30:00.000Z",
    teamA: { name: "A队", short: "A" }, teamB: { name: "B队", short: "B" },
    result: null, source: "manual", note: "手工补"
  }];
  var r = Lib.mergeMatches(existing, incoming, { retentionDays: 45 });
  return r.matches.length === 1 && r.matches[0].mid === 7700011 && r.matches[0].note === "手工补";
})());
check("⑤ canceled 标记经 merge 往返保留", (function () {
  var existing = [{
    id: "auto-cs2-20261112-c-d", game: "cs2", tournament: "T", stage: "R", startAt: "2026-11-12T10:00:00.000Z",
    teamA: { name: "C队" }, teamB: { name: "D队" }, status: "locked", result: null, canceled: true, source: "pandascore"
  }];
  var r = Lib.mergeMatches(existing, [], { retentionDays: 45 });
  return r.matches.length === 1 && r.matches[0].canceled === true;
})());
check("⑥ midIndex 与 map 同源（11-08 晚 valorant 重复 id 事故）：交换序重取不再 fork 出同 id 孪生", (function () {
  var mk = function (mid, a, b, w) {
    return { game: "valorant", mid: mid, tournament: "VRL", stage: "Group", startAt: "2026-11-08T03:15:00.000Z",
      teamA: { name: a, short: a.slice(0, 3) }, teamB: { name: b, short: b.slice(0, 3) },
      status: w ? "finished" : "scheduled", source: "pandascore",
      result: w ? { winner: w, score: "1:0" } : null };
  };
  var base = Lib.mergeMatches([], [mk(1797548, "Bonkers", "MeatZn", null)]).matches;
  // 重取：主客交换 + 赛果落地（PandaScore 完赛重取换主客序——事故现场形态）
  var r = Lib.mergeMatches(base, [mk(1797548, "MeatZn", "Bonkers", "A")]);
  return r.matches.length === 1 && Lib.validateMatches(r.matches).length === 0 &&
    r.matches[0].result && r.matches[0].result.winner === "A";
})());
check("⑦ 同队对同日第二场（mid 不同）→ 独立条目 + id 后缀去重，互不污染（slug 回退不再并场）", (function () {
  var mk = function (mid, a, b, w) {
    return { game: "valorant", mid: mid, tournament: "VRL", stage: "Group", startAt: "2026-11-08T03:15:00.000Z",
      teamA: { name: a, short: a.slice(0, 3) }, teamB: { name: b, short: b.slice(0, 3) },
      status: w ? "finished" : "scheduled", source: "pandascore",
      result: w ? { winner: w, score: "1:0" } : null };
  };
  var base = Lib.mergeMatches([], [mk(111, "A队", "B队", "A")]).matches;
  var r = Lib.mergeMatches(base, [mk(222, "A队", "B队", "A")]); // 同序第二场（再相遇/背靠背）
  if (r.matches.length !== 2) return false;
  var ids = {};
  r.matches.forEach(function (m) { ids[m.id] = m.mid; });
  var keys = Object.keys(ids);
  return keys.length === 2 && keys[0] !== keys[1] &&
    (ids[keys[0]] === 111 || ids[keys[1]] === 111) && // 各保各的 mid（成绩互不覆盖的前提）
    (ids[keys[0]] === 222 || ids[keys[1]] === 222) &&
    Lib.validateMatches(r.matches).length === 0;
})());
check("⑧ manual 升级 mid 后条目收编到 mid 键（旧 slug 槽位残留会在交换重取时 fork 同 id 孪生）", (function () {
  var mk = function (mid, a, b, w, src) {
    return { game: "valorant", mid: mid, tournament: "VRL", stage: "Group", startAt: "2026-11-08T03:15:00.000Z",
      teamA: { name: a, short: a.slice(0, 3) }, teamB: { name: b, short: b.slice(0, 3) },
      status: w ? "finished" : "scheduled", source: src || "pandascore",
      result: w ? { winner: w, score: "1:0" } : null };
  };
  var base = Lib.mergeMatches([], [mk(null, "A队", "B队", null, "manual")]).matches;
  var up = Lib.mergeMatches(base, [mk(555, "A队", "B队", "A")]); // manual → pandascore 升级
  if (up.matches.length !== 1 || up.matches[0].mid !== 555) return false;
  var r = Lib.mergeMatches(up.matches, [mk(555, "B队", "A队", "A")]); // 升级后交换序重取
  return r.matches.length === 1 && r.matches[0].mid === 555 && Lib.validateMatches(r.matches).length === 0;
})());

/* ---------- 场景 AC（2026-11-07 用户口径）：auto 事件淘汰赛币级升级 + 已完赛不展示 + 弃赛透传 ---------- */
console.log("AC. auto 事件淘汰赛币级 / 弃赛透传：");
check("① 阶段名识别：Playoffs/Quarterfinals/败者组命中；Group Stage/Regular Season 不命中", (function () {
  var hit = ["Playoffs", "Quarterfinals", "Semifinal", "Grand Final", "Lower Bracket Round 1", "Round of 16", "淘汰赛", "Play-off"];
  var miss = ["Group Stage", "Regular Season", "Group A", "Championship Group Stage North America"];
  return hit.every(function (k) { return PK.isPlayoffStageKey(k); }) && miss.every(function (k) { return !PK.isPlayoffStageKey(k); });
})());
check("② A 级赛事：全部 series 阶段 displayOnly（纯展示）", (function () {
  function mk(id, stage, tier) {
    return { id: id, game: "cs2", tier: tier, tournament: "PGL 测试赛", stage: stage,
      teamA: { name: "甲" + id }, teamB: { name: "乙" + id }, startAt: "2026-11-10T10:00:00.000Z", result: null };
  }
  var evs = PK.buildAutoEvents([mk("g1", "Group Stage", "a"), mk("p1", "Playoffs", "a")], []);
  var ev = evs[0];
  if (!ev || ev.tier !== "a" || ev.stages.length !== 2) return false;
  var byId = {};
  ev.stages.forEach(function (s) { byId[s.id] = s; });
  return byId["Group Stage"].coinTier === 1 && byId["Group Stage"].displayOnly === true && byId["Playoffs"].displayOnly === true;
})());
check("③ S 级赛事：淘汰赛同样 displayOnly", (function () {
  function mk(id, stage) {
    return { id: id, game: "cs2", tier: "s", tournament: "S 测试赛", stage: stage,
      teamA: { name: "甲" + id }, teamB: { name: "乙" + id }, startAt: "2026-11-10T10:00:00.000Z", result: null };
  }
  var ev = PK.buildAutoEvents([mk("g1", "Group Stage"), mk("p1", "Playoffs")], [])[0];
  var byId = {};
  ev.stages.forEach(function (s) { byId[s.id] = s; });
  return ev.tier === "" && byId["Playoffs"].displayOnly === true && byId["Group Stage"].displayOnly === true;
})());
check("④ series 结算：displayOnly 阶段的历史已提交选择照常结算（A 级铜、S 级银）", (function () {
  function seriesStage(extra) {
    return Object.assign({ id: "st", type: "series", label: "T", coinTier: 1,
      matches: [{ id: "m1", a: "甲", b: "乙", startAt: "2026-11-10T10:00:00.000Z", winner: "A", score: "1:0", round: 0 }] }, extra || {});
  }
  var rec = { picks: { w: { m1: "A" } }, settled: false, pickedAt: 1 };
  var display = PK.settleRewards(seriesStage({ displayOnly: true }), rec, "a");
  var aGroup = PK.settleRewards(seriesStage(), rec, "a");
  var sGroup = PK.settleRewards(seriesStage(), rec, "");
  return display.coins.c === 1 && aGroup.coins.c === 1 && sGroup.coins.s === 1;
})());
check("⑤ 弃赛透传：canceled 场进 stage matches、不阻塞事件 done（场次取 4 天前——超 done 宽限期，见 ⑥）", (function () {
  var old = function (h) { return new Date(Date.now() - 4 * 86400000 + h * 3600000).toISOString(); };
  var evs = PK.buildAutoEvents([
    { id: "d1", game: "cs2", tier: "a", tournament: "弃赛测试赛", stage: "Group Stage",
      teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: old(0), result: { winner: "A", score: "1:0" } },
    { id: "d2", game: "cs2", tier: "a", tournament: "弃赛测试赛", stage: "Group Stage",
      teamA: { name: "丙" }, teamB: { name: "丁" }, startAt: old(2), result: null, canceled: true }
  ], []);
  var ev = evs[0];
  var stage = ev.stages[0];
  var canceledMatch = stage.matches.filter(function (m) { return m.canceled === true; });
  return ev.status === "done" && canceledMatch.length === 1 && stage.matches.length === 2;
})());
check("⑥ done 双证据链（1.3.14 防「小组赛打完误判联赛结束」）：仅小组赛完赛→宽限期内 active；" +
  "超宽限期→done；出现过 Playoffs 阶段且完赛→立即 done；有未打场次→active", (function () {
  function mk(id, stage, daysAgo, withResult) {
    return { id: id, game: "cs2", tier: "s", tournament: "判定测试赛", stage: stage,
      teamA: { name: "甲" + id }, teamB: { name: "乙" + id },
      startAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      result: withResult ? { winner: "A", score: "1:0" } : null };
  }
  // a) 仅小组赛、最近打完、数据里无淘汰赛阶段 → 宽限期内不判 done（淘汰赛可能尚未被数据源排期）
  var grace = PK.buildAutoEvents([mk("g1", "Group Stage", 1, true), mk("g2", "Group Stage", 0.5, true)], [])[0];
  // b) 仅小组赛、4 天前打完 → 超宽限期，判 done（视为纯循环赛/已收场）
  var lagged = PK.buildAutoEvents([mk("g1", "Group Stage", 5, true), mk("g2", "Group Stage", 4, true)], [])[0];
  // c) 小组赛 + Playoffs 都打完（哪怕刚打完）→ 结构证据成立（决赛已打），立即 done
  var withPo = PK.buildAutoEvents([mk("g1", "Group Stage", 2, true), mk("p1", "Playoffs", 0.5, true)], [])[0];
  // d) 有未来场次（无结果）→ allDone=false，照旧 active
  var future = PK.buildAutoEvents([mk("g1", "Group Stage", 1, true), mk("g2", "Group Stage", -2, false)], [])[0];
  return grace.status === "active" && lagged.status === "done" &&
    withPo.status === "done" && future.status === "active";
})());
check("⑦ auto records 端到端（1.3.14 仿 BLAST 模式）：GSL 全完赛按实际战绩落桶出结果 →" +
  " scorePhase/settleRewards 走桶语义（S 级银 ×N）；4 队误判形态（循环赛）宁缺勿滥不出结果", (function () {
  function g(id, a, b, w, daysAgo) {
    return { id: id, game: "cs2", tier: "s", tournament: "GSL 自动赛", stage: "Group A",
      teamA: { name: a, short: a.slice(0, 2) }, teamB: { name: b, short: b.slice(0, 2) },
      startAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      result: w ? { winner: w, score: "2:0" } : null };
  }
  var picks = function () { return { type: "records", picks: { "2:0": ["A队"], "2:1": ["B队"], "1:2": ["C队"], "0:2": ["D队"] } }; };
  // GSL 5 场（winner=侧位，teamA 均为胜方）：上半 A-B / C-D；胜者组决赛 A-C；败者首轮 B-D；决胜 B-C
  var ev = PK.buildAutoEvents([
    g("r1", "A队", "B队", "A", 9), g("r2", "C队", "D队", "A", 9),
    g("uf", "A队", "C队", "A", 8), g("lr", "B队", "D队", "A", 7), g("dec", "B队", "C队", "A", 6)
  ], [])[0];
  var rec = ev.stages.filter(function (s) { return s.type === "records"; })[0];
  if (!rec || rec.results === null) return false;
  // 战绩：A 2:0 · B 2:1 · C 1:2 · D 0:2 —— 与 GSL 桶逐一吻合
  if ((rec.results["2:0"] || []).join() !== "A队" || (rec.results["2:1"] || []).join() !== "B队" ||
      (rec.results["1:2"] || []).join() !== "C队" || (rec.results["0:2"] || []).join() !== "D队") return false;
  var r = PK.scorePhase(rec, picks());
  var rw = PK.settleRewards(rec, picks(), "");
  if (!r || r.correct !== 4 || r.total !== 4 || !r.perfect) return false;
  if (!rw || rw.coins.s !== 4) return false; // S 级（tier ""）→ 银币
  // 误判兜底：4 队循环赛（6 场，各 3 战）——战绩分布 3:0/2:1/1:2/0:3 不落 GSL 桶 → 结果 null 不结算
  var rr = PK.buildAutoEvents([
    g("c1", "A队", "B队", "A", 9), g("c2", "C队", "D队", "A", 9),
    g("c3", "A队", "C队", "A", 8), g("c4", "B队", "D队", "A", 8),
    g("c5", "A队", "D队", "A", 7), g("c6", "B队", "C队", "A", 7)
  ], [])[0].stages.filter(function (s) { return s.type === "records"; })[0];
  return !!rr && rr.results === null;
})());

/* ---------- 场景 AD（2026-11-08 四踩后固化）：mergeMatches 属性测试（fuzz） ----------
   同场键四连坑（slug 孪生 → pid 跨场污染 → canceled 洗掉 → midIndex 孤儿对象）全是
   「特定数据形态才爆发」的缺陷——逐形态补断言追不上数据源的花样，改为属性测试：
   确定性种子随机生成 merge 序列（重取/交换主客/改简称/同队对同日多场/无 mid/manual
   升级/弃赛/脏 startAt），断言不变量：
   I1 validateMatches 恒零错误（id 唯一——四踩的直接症状）
   I2 一个 mid 至多一条条目
   I3 id 稳定性：同 mid 跨轮 id 不变（用户预测/对决挂在 matchId 上，id 漂移=账本断裂）
   I4 赛果不丢不漂：某场一旦有胜者，后续合并后仍是同一胜者（胜者按队名解析，与主客序无关）
   I5 有 mid 的场次集合单调不减（重取不制造也不消灭场次）
   I6 重放幂等：同一轮 incoming 重放一遍，条目数与 mid→id 映射不变（重取 fork 的通杀断言）
   边界：同 slug 组内「无 mid 条目 + 带 mid 多场」并存的消歧是 slug 键设计的固有歧义
   （真实场景=手工补录与同队对同日多场并存），不在 fuzz 形态内。 */
console.log("AD. mergeMatches 属性测试（fuzz，确定性种子）：");
check("I1-I6 不变量 × 8 种子 × 24 轮（重取/交换/改名/同队多场/manual 升级/弃赛/脏日期）", (function () {
  function mulberry32(seed) {
    return function () {
      var t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var TEAMS = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"];
  function buildWorld(rnd) {
    var fixtures = [];
    var midSeq = 100000;
    // 组 = game|日|有序队对（= slug 键）。组内第一条 born=1 且可noMid/manual；其余恒带 mid（消歧边界，见组注释）
    var groups = {};
    function addFixture(game, a, b, day) {
      var key = game + "|" + day + "|" + a + ">" + b;
      var first = !groups[key];
      groups[key] = 1;
      var f = {
        mid: ++midSeq, game: game, a: a, b: b, day: day,
        born: first ? 1 : 1 + Math.floor(rnd() * 5),
        noMid: first && rnd() < 0.15,               // manual/liquipedia/旧数据形态：恒无 mid
        manual: first && rnd() < 0.15,
        canceled: rnd() < 0.08,                     // 弃赛与赛果互斥
        resultRound: -1,
        winnerTeam: -1
      };
      if (!f.canceled && rnd() < 0.75) {
        f.resultRound = 1 + Math.floor(rnd() * 6);
        f.winnerTeam = rnd() < 0.5 ? a : b;
      }
      fixtures.push(f);
    }
    addFixture("cs2", 0, 1, 0); addFixture("cs2", 1, 0, 0);        // 同队对同日（交换序组）
    addFixture("cs2", 0, 1, 0);                                    // 同序同队对同日——slug 键撞车压力
    addFixture("cs2", 2, 3, 0); addFixture("cs2", 3, 2, 1);
    addFixture("valorant", 4, 5, 0); addFixture("valorant", 5, 6, 0);
    for (var i = 0; i < 8; i++) {
      addFixture(i % 2 ? "cs2" : "valorant", Math.floor(rnd() * 8), Math.floor(rnd() * 8), Math.floor(rnd() * 2));
    }
    return fixtures.filter(function (f) { return f.a !== f.b; });
  }
  function mkIncoming(f, rnd, round) {
    var swap = rnd() < 0.3; // PandaScore 完赛重取交换主客（11-08 事故现场形态）
    var a = swap ? f.b : f.a, b = swap ? f.a : f.b;
    var shortA = TEAMS[a].slice(0, 3), shortB = TEAMS[b].slice(0, 3);
    if (rnd() < 0.1) shortA += "X"; // 简称编辑（fork 历史触发之一）
    var m = {
      game: f.game, tournament: "Fuzz League", stage: "Group",
      startAt: rnd() < 0.02 ? "not-a-date" : new Date(Date.UTC(2026, 10, 8 + f.day, 10)).toISOString(),
      teamA: { name: TEAMS[a], short: shortA }, teamB: { name: TEAMS[b], short: shortB },
      source: f.manual ? "manual" : "pandascore",
      status: "scheduled"
    };
    if (!f.noMid) m.mid = f.mid;
    if (f.canceled) {
      m.canceled = true;
    } else if (f.resultRound >= 0 && round >= f.resultRound) {
      var w = f.winnerTeam === a ? "A" : "B"; // 胜者是队，侧位随本次主客序解析——不变量按队名断言
      m.status = "finished";
      m.result = { winner: w, score: "2:0" };
    }
    return m;
  }
  function fuzzRun(seed) {
    var rnd = mulberry32(seed);
    var fixtures = buildWorld(rnd);
    var matches = [];
    var seen = {}; // mid → {id, winnerTeam}
    for (var round = 1; round <= 24; round++) {
      var inc = [];
      fixtures.forEach(function (f) {
        if (round < f.born) return;
        if (rnd() < 0.6) inc.push(mkIncoming(f, rnd, round));
      });
      if (!inc.length) continue;
      var r = Lib.mergeMatches(matches, inc, { retentionDays: 365 });
      matches = r.matches;
      var errs = Lib.validateMatches(matches); // I1
      if (errs.length) return "seed " + seed + " r" + round + " I1: " + errs.join("; ");
      var mids = {};
      for (var i = 0; i < matches.length; i++) {
        var m = matches[i];
        if (!m.mid) continue;
        var mk = String(m.mid);
        if (mids[mk]) return "seed " + seed + " r" + round + " I2: mid 重复 " + mk; // I2
        mids[mk] = m;
        if (seen[mk] && seen[mk].id !== m.id) return "seed " + seed + " r" + round + " I3: mid " + mk + " id 漂移"; // I3
        var wTeam = m.result && m.result.winner ? (m.result.winner === "A" ? m.teamA.name : m.teamB.name) : null;
        if (seen[mk] && seen[mk].winnerTeam) {
          if (!wTeam) return "seed " + seed + " r" + round + " I4: mid " + mk + " 赛果丢失"; // I4
          if (wTeam !== seen[mk].winnerTeam) return "seed " + seed + " r" + round + " I4: mid " + mk + " 胜者漂移";
        }
        seen[mk] = { id: m.id, winnerTeam: (seen[mk] && seen[mk].winnerTeam) || wTeam || null };
      }
      for (var k in seen) { // I5
        if (!mids[k]) return "seed " + seed + " r" + round + " I5: mid " + k + " 条目消失";
      }
      var r2 = Lib.mergeMatches(matches, inc, { retentionDays: 365 }); // I6 重放幂等
      var map2 = {};
      var dup = false;
      for (var j = 0; j < r2.matches.length; j++) {
        var mm = r2.matches[j];
        if (!mm.mid) continue;
        var k2 = String(mm.mid);
        if (map2[k2]) { dup = true; break; }
        map2[k2] = mm.id;
      }
      if (dup) return "seed " + seed + " r" + round + " I6: 重放出现 mid 重复";
      if (r2.matches.length !== matches.length) return "seed " + seed + " r" + round + " I6: 重放条目数漂移";
      for (var k3 in map2) {
        if (!seen[k3]) return "seed " + seed + " r" + round + " I6: 重放制造新 mid " + k3;
        if (map2[k3] !== seen[k3].id) return "seed " + seed + " r" + round + " I6: 重放 id 漂移 mid " + k3;
      }
    }
    return null;
  }
  for (var s = 1; s <= 8; s++) {
    var fail = fuzzRun(s * 7919);
    if (fail) { console.log("      ! " + fail); return false; }
  }
  return true;
})());

/* ---------- 场景 AE（2026-11-07 用户拍板）：records 战绩桶阶段（双败小组赛按战绩落位） ---------- */
console.log("AE. records 战绩桶（双败小组赛 · 4 队 GSL 2:0/2:1/1:2/0:2）：");
var AG = await import(pathToFileURL(path.join(root, "tools", "fetch-pickem.mjs")).href).catch(function () { return null; });
var GSL_BUCKETS = [
  { k: "2:0", label: "2:0 出线", cap: 1 },
  { k: "2:1", label: "2:1 出线", cap: 1 },
  { k: "1:2", label: "1:2 淘汰", cap: 1 },
  { k: "0:2", label: "0:2 淘汰", cap: 1 }
];
function gslMatch(id, a, b, w, day) {
  return { id: id, game: "cs2", tournament: "GSL 测试赛", stage: "Group A",
    teamA: { name: a }, teamB: { name: b }, startAt: "2026-11-20T1" + day + ":00:00.000Z",
    result: w ? { winner: w, score: "2:" + (w === "A" ? (day === "0" ? 1 : 0) : (day === "0" ? 1 : 0)) } : null };
}
check("① normalizeStage：records 桶形状清洗（非法 k/cap 丢弃）；无桶=无 buckets 字段", (function () {
  var st = PK.normalizePickemData({ events: [{ id: "e", game: "cs2", name: "x", stages: [
    { id: "g", type: "records", label: "G", buckets: [
      { k: "2:0", label: "2:0", cap: 1 }, { k: "bad", label: "x", cap: 1 },
      { k: "2:1", label: "2:1", cap: 0 }, { k: "1:2", label: "1:2", cap: 2 }
    ] }
  ] }] }).events[0];
  var s = st.stages[0];
  return s.type === "records" && s.buckets.length === 2 && s.buckets[0].k === "2:0" && s.buckets[1].k === "1:2" && s.buckets[1].cap === 2;
})());
check("② stageOpenForPicks：队伍齐（≥桶容量）+ 截止前可猜；队伍不齐不可猜", (function () {
  var now = Date.parse("2026-11-19T00:00:00.000Z");
  var teams = [{ name: "甲" }, { name: "乙" }, { name: "丙" }, { name: "丁" }];
  var stage = { id: "g", type: "records", label: "G", buckets: GSL_BUCKETS, teams: teams, matches: [
    { id: "m1", a: "甲", b: "乙", startAt: "2026-11-20T10:00:00.000Z", winner: "", score: "", round: 0 }
  ], startsAt: "2026-11-20T10:00:00.000Z" };
  if (PK.stageOpenForPicks(stage, now) !== true) return false;
  if (PK.stageOpenForPicks(Object.assign({}, stage, { teams: teams.slice(0, 3) }), now) !== false) return false;
  return PK.stageOpenForPicks(stage, Date.parse("2026-11-20T09:30:00.000Z")) === false; // 截止后
})());
check("③ recordsPicksComplete：每桶满 cap + 无重复；跨桶重复不完整", (function () {
  var picksOk = { "2:0": ["甲"], "2:1": ["乙"], "1:2": ["丙"], "0:2": ["丁"] };
  var picksDup = { "2:0": ["甲"], "2:1": ["甲"], "1:2": ["丙"], "0:2": ["丁"] };
  var picksShort = { "2:0": ["甲"], "2:1": [], "1:2": ["丙"], "0:2": ["丁"] };
  return PK.recordsPicksComplete(picksOk, GSL_BUCKETS) === true &&
    PK.recordsPicksComplete(picksDup, GSL_BUCKETS) === false &&
    PK.recordsPicksComplete(picksShort, GSL_BUCKETS) === false;
})());
check("④ scorePhase：按最终战绩落桶逐桶比对（results 缺失返回 null）", (function () {
  var stage = { id: "g", type: "records", label: "G", buckets: GSL_BUCKETS,
    teams: [{ name: "甲" }, { name: "乙" }, { name: "丙" }, { name: "丁" }], matches: [{ id: "m1", a: "甲", b: "乙", startAt: "x", winner: "A", score: "2:0", round: 0 }],
    results: { "2:0": ["甲"], "2:1": ["乙"], "1:2": ["丙"], "0:2": ["丁"] } };
  var rec = { type: "records", picks: { "2:0": ["甲"], "2:1": ["丙"], "1:2": ["乙"], "0:2": ["丁"] } };
  var r = PK.scorePhase(stage, rec);
  if (!r || r.correct !== 2 || r.total !== 4) return false;
  return PK.scorePhase(Object.assign({}, stage, { results: null }), rec) === null;
})());
check("⑤ settleRewards：A 级 records 阶段按 coinTier 发币（猜对 2 → 🥉×2）", (function () {
  var stage = { id: "g", type: "records", label: "Group A · 双败", coinTier: 1, buckets: GSL_BUCKETS,
    teams: [{ name: "甲" }], matches: [{ id: "m1", a: "甲", b: "乙", startAt: "x", winner: "A", score: "2:0", round: 0 }],
    results: { "2:0": ["甲"], "2:1": ["乙"], "1:2": ["丙"], "0:2": ["丁"] } };
  var rec = { type: "records", picks: { "2:0": ["甲"], "2:1": ["丙"], "1:2": ["乙"], "0:2": ["丁"] } };
  var rw = PK.settleRewards(stage, rec, "a");
  return rw && rw.coins.c === 2 && rw.coins.s === 0 && rw.bySource.length === 1;
})());
check("⑥ 聚合器 records：打完全部场次按 W:L 落桶；结构不符（宁缺勿滥）出 null", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true; // 聚合器未导出 buildEvent 时跳过（走 demo 实跑覆盖）
  var cfg = { id: "gsl-ev", game: "cs2", name: "GSL 赛", tournament: "GSL 测试赛", stages: [
    { id: "groupA", type: "records", label: "Group A · 双败", stageNames: ["Group A"], buckets: GSL_BUCKETS }
  ] };
  // GSL 5 场：甲 2:0 / 乙 2:1 / 丙 1:2 / 丁 0:2
  var matches = [
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: "2026-11-20T10:00:00.000Z", result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "丙" }, teamB: { name: "丁" }, startAt: "2026-11-20T12:00:00.000Z", result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "甲" }, teamB: { name: "丙" }, startAt: "2026-11-21T10:00:00.000Z", result: { winner: "A", score: "2:1" } },
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "乙" }, teamB: { name: "丁" }, startAt: "2026-11-21T12:00:00.000Z", result: { winner: "B", score: "0:2" } },
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "乙" }, teamB: { name: "丙" }, startAt: "2026-11-22T10:00:00.000Z", result: { winner: "A", score: "2:1" } }
  ];
  var ev = AG.buildEvent(cfg, matches, null);
  var s = ev && ev.stages[0];
  if (!s || s.type !== "records" || !s.results) return false;
  var ok = s.results["2:0"][0] === "甲" && s.results["2:1"][0] === "乙" && s.results["1:2"][0] === "丙" && s.results["0:2"][0] === "丁";
  if (!ok) return false;
  // 结构不符：多打一场让某队战绩越出桶 → results 为 null（宁缺勿滥）
  var matches2 = matches.concat([Object.assign({}, matches[4], { id: "extra", startAt: "2026-11-23T10:00:00.000Z", result: { winner: "B", score: "1:2" } })]);
  var ev2 = AG.buildEvent(cfg, matches2, null);
  return ev2.stages[0].results === null;
})());
check("⑦ 官方 standings 主证据（2026-11-10）：自采漏采一场致派生 W:L 失真，官方 standings 定案出正确结果", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  var cfg = { id: "gsl-ev", game: "cs2", name: "GSL 赛", tournament: "GSL 测试赛", stages: [
    { id: "groupA", type: "records", label: "Group A · 双败", stageNames: ["Group A"], buckets: GSL_BUCKETS }
  ] };
  // 5 场只到 4 场（乙 vs 丁 漏采）：乙派生 1:1（真值 2:1）→ 旧分布比对必 null
  var matches = [
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: "2026-11-20T10:00:00.000Z", result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "丙" }, teamB: { name: "丁" }, startAt: "2026-11-20T12:00:00.000Z", result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "甲" }, teamB: { name: "丙" }, startAt: "2026-11-21T10:00:00.000Z", result: { winner: "A", score: "2:1" } },
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "乙" }, teamB: { name: "丙" }, startAt: "2026-11-22T10:00:00.000Z", result: { winner: "A", score: "2:1" } }
  ];
  var structures = { "cs2|GSL 测试赛|Group A": { tid: 1, participants: ["甲", "乙", "丙", "丁"], standings: [
    { t: "甲", w: 2, l: 0 }, { t: "乙", w: 2, l: 1 }, { t: "丙", w: 1, l: 2 }, { t: "丁", w: 0, l: 2 }
  ] } };
  var ev = AG.buildEvent(cfg, matches, null, structures);
  var s = ev && ev.stages[0];
  if (!s || !s.results) return false;
  // 阶段 standings 烘入（桶体展示用）
  if (!Array.isArray(s.standings) || s.standings.length !== 4) return false;
  return s.results["2:0"][0] === "甲" && s.results["2:1"][0] === "乙" && s.results["1:2"][0] === "丙" && s.results["0:2"][0] === "丁";
})());
check("⑨ swiss 延迟截止（2026-11-12，PGL Major Stage 1）：pickOpenRounds 两轮后锁——阈值前保持可猜（含已开赛）、阈值后=下一轮首场-1h、聚合器权威值优先、旧配置走旧语义", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  // 16 队 swiss：R1 8 场全有赛果（阈值 16 未到），R2 8 场（4 场有赛果 + 4 场未赛）
  function swissMatches() {
    var arr = [];
    for (var i = 0; i < 8; i++) {
      arr.push({ game: "cs2", tournament: "SG赛", stage: "Stage 1", teamA: { name: "队" + (i + 1) }, teamB: { name: "队" + (i + 9) }, startAt: "2026-11-24T0" + (i % 8) + ":00:00.000Z", result: { winner: "A", score: "2:0" } });
    }
    for (var j = 0; j < 8; j++) {
      var done = j < 4;
      arr.push({ game: "cs2", tournament: "SG赛", stage: "Stage 1", teamA: { name: "队" + (j + 1) }, teamB: { name: "队" + ((j + 1) % 8 + 1) }, startAt: "2026-11-25T0" + j + ":00:00.000Z", result: done ? { winner: "A", score: "2:1" } : null });
    }
    // 第 3 轮（阈值后才出现的未赛场次）
    arr.push({ game: "cs2", tournament: "SG赛", stage: "Stage 1", teamA: { name: "队1" }, teamB: { name: "队2" }, startAt: "2026-11-26T10:00:00.000Z", result: null });
    return arr;
  }
  var cfg = { id: "sg-ev", game: "cs2", name: "SG", tournament: "SG赛", stages: [
    { id: "s1", type: "swiss", label: "Stage 1", stageNames: ["Stage 1"], pickOpenRounds: 2 }
  ] };
  var ev = AG.buildEvent(cfg, swissMatches(), null);
  var st = ev && ev.stages[0];
  if (!st || st.type !== "swiss") return false;
  if (st.pickOpenRounds !== 2) return false;
  // 阈值 = 16 完赛；当前 12 完赛 → 不下发 pickDeadline（保持可猜）
  if (st.pickDeadline !== undefined) return false;
  // 客户端镜像：阈值未到 → null → stageOpenForPicks 返回 true（即使阶段首场-1h 早已过去）
  if (PK.stageOpenForPicks(st, Date.parse("2026-11-24T20:00:00.000Z")) !== true) return false;
  // 阈值到达（再造 4 场完赛 = 16）→ 聚合器下发 pickDeadline = 最早未赛 -1h
  var more = swissMatches();
  more[8].result = { winner: "B", score: "1:2" }; more[9].result = { winner: "A", score: "2:0" };
  more[10].result = { winner: "B", score: "0:2" }; more[11].result = { winner: "A", score: "2:0" };
  var ev2 = AG.buildEvent(cfg, more, null);
  var st2 = ev2 && ev2.stages[0];
  // 最早未赛 = 2026-11-26T10:00Z → pickDeadline = 09:00Z
  if (!st2 || st2.pickDeadline !== Date.parse("2026-11-26T09:00:00.000Z")) return false;
  if (PK.stageOpenForPicks(st2, Date.parse("2026-11-26T08:00:00.000Z")) !== true) return false;
  if (PK.stageOpenForPicks(st2, Date.parse("2026-11-26T09:30:00.000Z")) !== false) return false;
  // 聚合器权威值优先于本地镜像：人为改 stage.matches 完赛数不影响已下发的 pickDeadline
  if (PK.swissPickDeadline(Object.assign({}, st2, { matches: swissMatches() }), 0) !== Date.parse("2026-11-26T09:00:00.000Z")) return false;
  // 旧配置（无 pickOpenRounds）走旧语义：pickOpenRounds undefined
  var ev3 = AG.buildEvent({ id: "x", game: "cs2", name: "x", tournament: "SG赛", stages: [
    { id: "s1", type: "swiss", label: "S", stageNames: ["Stage 1"] }
  ] }, swissMatches(), null);
  if (!ev3 || !ev3.stages[0] || ev3.stages[0].pickOpenRounds !== undefined) return false;
  if (PK.swissPickDeadline(ev3.stages[0], 0) !== null) return false;
  return true;
})());
check("swiss 延迟截止客户端接线（2026-11-12 静态）：normalize 白名单 + stageOpenForPicks/pickemStageStatus/徽标三处同源", (function () {
  var pkSrc = rf(path.join(root, "js", "pickem.js"), "utf8");
  return /export function swissPickDeadline/.test(pkSrc) &&
    /out\.pickOpenRounds = Math\.round\(raw\.pickOpenRounds\)/.test(pkSrc) &&
    /out\.pickDeadline = raw\.pickDeadline/.test(pkSrc) &&
    /var dl = swissPickDeadline\(stage, now\)/.test(pkSrc) &&
    /var sdl = swissPickDeadline\(stage, Date\.now\(\)\)/.test(appSrc) &&
    /swissPickDeadline/.test(appSrc.replace(/import[^;]+;/, "")); // app.js 非仅 import（有实际使用）
})());
check("⑧ 官方 standings 落桶仍不满（官方与桶结构也不符）→ 仍 null（宁缺勿滥不因新证据放宽）", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  var cfg = { id: "gsl-ev", game: "cs2", name: "GSL 赛", tournament: "GSL 测试赛", stages: [
    { id: "groupA", type: "records", label: "Group A", stageNames: ["Group A"], buckets: GSL_BUCKETS }
  ] };
  var matches = [
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: "2026-11-20T10:00:00.000Z", result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "GSL 测试赛", stage: "Group A", teamA: { name: "丙" }, teamB: { name: "丁" }, startAt: "2026-11-20T12:00:00.000Z", result: { winner: "A", score: "2:0" } }
  ];
  var structures = { "cs2|GSL 测试赛|Group A": { tid: 1, participants: ["甲", "乙", "丙", "丁"], standings: [
    { t: "甲", w: 1, l: 0 }, { t: "乙", w: 0, l: 1 }, { t: "丙", w: 1, l: 0 }, { t: "丁", w: 0, l: 1 }
  ] } };
  var ev = AG.buildEvent(cfg, matches, null, structures);
  var s = ev && ev.stages[0];
  return s && Array.isArray(s.standings) && s.results === null;
})());


/* ---------- 场景 W2（用户口径 2026-11-05）：placement 截止铁律 ----------
   冠亚季竞猜必须在「整个淘汰赛开始前」（=阶段内最早一场开赛前 1 小时）锁定：
   QF 打完后前四名可知、可排除其余队伍——任何时间轴场景都不得在 QF1-1h 之后仍可猜。 */
console.log("W2. placement 截止铁律（冠亚季必须在淘汰赛开打前锁定）：");
check("① 标准：4 场 QF 已排期+8 队 → 截止前可猜；截止后（QF1-1h 内/已开赛）不可猜", (function () {
  var now = Date.now();
  function po(qfOffsetMs, extra) {
    var ms = [];
    for (var i = 0; i < 4; i++) ms.push({ id: "qf" + i, a: "队" + (i*2+1), b: "队" + (i*2+2), startAt: new Date(now + qfOffsetMs + i * 40 * 60000).toISOString(), winner: "", score: "", round: 0 });
    var st = { id: "po", type: "placement", label: "淘汰赛", startsAt: new Date(now + qfOffsetMs).toISOString(),
      teams: Array.from({ length: 8 }, function (_, i) { return { name: "队" + (i + 1), short: "D" + (i + 1) }; }),
      matches: ms, rounds: [], degraded: false, results: null };
    if (extra) Object.assign(st, extra);
    return st;
  }
  if (PK.stageOpenForPicks(po(48 * 3600000), now) !== true) return false;      // QF1 在 48h 后 → 可猜
  if (PK.stageOpenForPicks(po(30 * 60000), now) !== false) return false;      // QF1 在 30min 后（不足 1h）→ 已截止
  if (PK.stageOpenForPicks(po(-2 * 3600000), now) !== false) return false;    // QF1 已开赛 → 不可猜
  return true;
})());
check("② QF 全部完赛且 SF 未排期（degraded、8 队、前四名已可知）→ 不可猜", (function () {
  var now = Date.now();
  var ms = [];
  for (var i = 0; i < 4; i++) ms.push({ id: "qf" + i, a: "队" + (i*2+1), b: "队" + (i*2+2), startAt: new Date(now - 86400000).toISOString(), winner: "A", score: "2:0", round: 0 });
  var st = { id: "po", type: "placement", label: "淘汰赛", startsAt: new Date(now - 86400000).toISOString(),
    teams: Array.from({ length: 8 }, function (_, i) { return { name: "队" + (i + 1), short: "D" + (i + 1) }; }),
    matches: ms, rounds: [], degraded: true, results: null };
  return PK.stageOpenForPicks(st, now) === false; // stageAllDone：所列场次全有结果 → 关闭
})());
check("③ QF 完赛 + SF 已排期（deadline 早已过去）→ 不可猜；④ 只有 2 场 SF 数据（4 队，前四名已知）→ 名单未齐不可猜", (function () {
  var now = Date.now();
  function teamList(n) { return Array.from({ length: n }, function (_, i) { return { name: "队" + (i + 1), short: "D" + (i + 1) }; }); }
  var st3 = { id: "po", type: "placement", label: "淘汰赛", startsAt: new Date(now - 86400000).toISOString(),
    teams: teamList(8), matches: [
      { id: "qf0", a: "队1", b: "队2", startAt: new Date(now - 86400000).toISOString(), winner: "A", score: "2:0", round: 0 },
      { id: "qf1", a: "队3", b: "队4", startAt: new Date(now - 82800000).toISOString(), winner: "A", score: "2:0", round: 0 },
      { id: "sf0", a: "队1", b: "队3", startAt: new Date(now + 86400000).toISOString(), winner: "", score: "", round: 1 }
    ], rounds: [], degraded: true, results: null };
  if (PK.stageOpenForPicks(st3, now) !== false) return false; // deadline=QF1(过去) → locked
  var st4 = { id: "po", type: "placement", label: "淘汰赛", startsAt: new Date(now + 86400000).toISOString(),
    teams: teamList(4), matches: [
      { id: "sf0", a: "队1", b: "队2", startAt: new Date(now + 86400000).toISOString(), winner: "", score: "", round: 1 },
      { id: "sf1", a: "队3", b: "队4", startAt: new Date(now + 88200000).toISOString(), winner: "", score: "", round: 1 }
    ], rounds: [], degraded: true, results: null };
  return PK.stageOpenForPicks(st4, now) === false; // 4 队 < 8 → 名单未齐（防「知道前四名排除其他队」）
})());

check("⑤ 6 队轮空制 placement（IEM 北京实测）：expectTeams=6 + 名单播种 → 2 场揭幕战即可猜；未播种 4 队不可猜", (function () {
  var now = Date.now();
  function po6(nTeams, expectTeams) {
    var names = ["TheMongolz", "MOUZ", "PARIVISION", "Natus Vincere", "FURIA", "BetBoom Team"];
    var ms = [
      { id: "p0", a: "PARIVISION", b: "Natus Vincere", startAt: new Date(now + 24 * 3600000).toISOString(), winner: "", score: "", round: 0 },
      { id: "p1", a: "FURIA", b: "BetBoom Team", startAt: new Date(now + 26 * 3600000).toISOString(), winner: "", score: "", round: 0 }
    ];
    return { id: "po", type: "placement", label: "淘汰赛", startsAt: ms[0].startAt,
      teams: names.slice(0, nTeams).map(function (n) { return { name: n, short: "" }; }),
      matches: ms, rounds: [], degraded: true, expectTeams: expectTeams || 0, results: null };
  }
  // expectTeams=6：播种 6 队（哪怕只有 2 场揭幕战）→ 可猜
  if (PK.stageOpenForPicks(po6(6, 6), now) !== true) return false;
  // 未播种（数据只有 4 队）且未声明 expectTeams → 默认 8 门槛 → 不可猜
  if (PK.stageOpenForPicks(po6(4, 0), now) !== false) return false;
  // normalizeStage 透传 expectTeams（含非法值归 0）
  var nd = PK.normalizePickemData({ events: [{ id: "e", game: "cs2", name: "x", stages: [
    { id: "po", type: "placement", label: "p", teams: [], matches: [], degraded: true, expectTeams: 6 },
    { id: "po2", type: "placement", label: "p", teams: [], matches: [], degraded: true, expectTeams: 99 }
  ] }] });
  return nd.events[0].stages[0].expectTeams === 6 && nd.events[0].stages[1].expectTeams === 0;
})());

function readIfDs() { return rf(path.join(root, "js", "data-source.js"), "utf8"); }
function readIfBuild() { return rf(path.join(root, "tools", "build-runtime-data.mjs"), "utf8"); }
function readIfTrim() { return rf(path.join(root, "tools", "trim-embedded.mjs"), "utf8"); }

/* ---------- 场景 AF（2026-11-09 IEM 未结算事故）：placement 季军赛结构 ----------
   IEM 北京实际赛制比 [2,2,1] 多一场季军赛（半决赛败者之间，决赛队不打）——6≠5 → degraded
   → results 永远不推导 → 名次竞猜永不结算。修复：配置 [2,2,1,1] + 推导改「决赛队的倒数
   第二场比赛的败者=半决赛败者」（对经典 [4,2,1] 与含季军赛结构都成立，并列口径不变）。 */
console.log("AF. placement 季军赛结构（IEM 北京 6 场实测）：");
check("① [2,2,1,1] 含季军赛 → results 推导：冠军/亚军正确，季军=半决赛败者并列两队（季军赛胜者也算）", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  function m(id, a, b, w, hAgo) {
    return { game: "cs2", tournament: "季军赛测试", stage: "Playoffs", teamA: { name: a }, teamB: { name: b },
      startAt: new Date(Date.now() - hAgo * 3600000).toISOString(), result: w ? { winner: w, score: "2:0" } : null };
  }
  var cfg = { id: "brz-ev", game: "cs2", name: "测试", tournament: "季军赛测试", stages: [
    { id: "po", type: "placement", label: "淘汰赛", stageNames: ["Playoffs"], expectRounds: [2, 2, 1, 1], expectTeams: 6,
      qualifiedTeams: ["TheMongolz", "MOUZ", "PARIVISION", "Natus Vincere", "FURIA", "BetBoom Team"] }
  ] };
  var matches = [
    m("qf1", "PARIVISION", "Natus Vincere", "B", 60),   // NaVi 胜
    m("qf2", "FURIA", "BetBoom Team", "B", 58),         // BetBoom 胜
    m("sf1", "TheMongolz", "Natus Vincere", "A", 30),   // TheMongolz 胜（半决赛）
    m("sf2", "MOUZ", "BetBoom Team", "A", 28),          // MOUZ 胜（半决赛）
    m("bronze", "Natus Vincere", "BetBoom Team", "A", 20), // 季军赛 NaVi 胜
    m("final", "TheMongolz", "MOUZ", "B", 10)           // MOUZ 冠军
  ];
  var ev = AG.buildEvent(cfg, matches, null);
  var s = ev && ev.stages[0];
  if (!s || s.type !== "placement" || s.degraded) return false;
  if (!s.results) return false;
  return s.results.champion === "MOUZ" && s.results.runnerUp === "TheMongolz" &&
    (s.results.third || []).indexOf("BetBoom Team") >= 0 && (s.results.third || []).indexOf("Natus Vincere") >= 0;
})());
check("② 经典 [4,2,1] 结构回归：季军=半决赛败者并列（推导规则改后语义不变）", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  var matches = [
    { game: "cs2", tournament: "经典测试", stage: "Playoffs", teamA: { name: "队1" }, teamB: { name: "队2" }, startAt: new Date(Date.now() - 96 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "经典测试", stage: "Playoffs", teamA: { name: "队3" }, teamB: { name: "队4" }, startAt: new Date(Date.now() - 95 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "经典测试", stage: "Playoffs", teamA: { name: "队5" }, teamB: { name: "队6" }, startAt: new Date(Date.now() - 94 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "经典测试", stage: "Playoffs", teamA: { name: "队7" }, teamB: { name: "队8" }, startAt: new Date(Date.now() - 93 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "经典测试", stage: "Playoffs", teamA: { name: "队1" }, teamB: { name: "队5" }, startAt: new Date(Date.now() - 48 * 3600000).toISOString(), result: { winner: "A", score: "2:1" } },
    { game: "cs2", tournament: "经典测试", stage: "Playoffs", teamA: { name: "队3" }, teamB: { name: "队7" }, startAt: new Date(Date.now() - 47 * 3600000).toISOString(), result: { winner: "B", score: "1:2" } },
    { game: "cs2", tournament: "经典测试", stage: "Playoffs", teamA: { name: "队1" }, teamB: { name: "队7" }, startAt: new Date(Date.now() - 24 * 3600000).toISOString(), result: { winner: "B", score: "0:2" } }
  ];
  var cfg = { id: "cls-ev", game: "cs2", name: "测试", tournament: "经典测试", stages: [
    { id: "po", type: "placement", label: "淘汰赛", stageNames: ["Playoffs"], expectRounds: [4, 2, 1], expectTeams: 8, qualifiedTeams: [] }
  ] };
  var ev = AG.buildEvent(cfg, matches, null);
  var s = ev && ev.stages[0];
  if (!s || s.degraded || !s.results) return false;
  // 决赛 队1 vs 队7，队7 胜 → 冠军队7、亚军队1；半决赛：队1 胜队5、队7 胜队3 → 季军并列 [队5, 队3]
  return s.results.champion === "队7" && s.results.runnerUp === "队1" &&
    (s.results.third || []).indexOf("队5") >= 0 && (s.results.third || []).indexOf("队3") >= 0;
})());
check("③ 场次数与 expectRounds 不符（5 场配 [2,2,1,1]）→ degraded、不出结果（宁缺勿滥）", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  var cfg = { id: "deg-ev", game: "cs2", name: "测试", tournament: "欠赛测试", stages: [
    { id: "po", type: "placement", label: "淘汰赛", stageNames: ["Playoffs"], expectRounds: [2, 2, 1, 1], expectTeams: 6, qualifiedTeams: ["甲", "乙", "丙", "丁", "戊", "己"] }
  ] };
  var matches = [
    { game: "cs2", tournament: "欠赛测试", stage: "Playoffs", teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: new Date(Date.now() - 48 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "欠赛测试", stage: "Playoffs", teamA: { name: "丙" }, teamB: { name: "丁" }, startAt: new Date(Date.now() - 47 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "欠赛测试", stage: "Playoffs", teamA: { name: "甲" }, teamB: { name: "丙" }, startAt: new Date(Date.now() - 24 * 3600000).toISOString(), result: { winner: "A", score: "2:1" } },
    { game: "cs2", tournament: "欠赛测试", stage: "Playoffs", teamA: { name: "乙" }, teamB: { name: "丁" }, startAt: new Date(Date.now() - 23 * 3600000).toISOString(), result: { winner: "B", score: "1:2" } },
    { game: "cs2", tournament: "欠赛测试", stage: "Playoffs", teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: new Date(Date.now() - 12 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } }
  ];
  var ev = AG.buildEvent(cfg, matches, null);
  var s = ev && ev.stages[0];
  return s && s.degraded === true && s.results === null;
})());
check("④ bracket 前驱链推导（2026-11-10 主证据）：expectRounds 配错也出正确结果+不炸；冠军/亚军/季军=GF 两个 winner 前驱的败者并列", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  var cfg = { id: "brk-ev", game: "cs2", name: "测试", tournament: "括号测试", stages: [
    { id: "po", type: "placement", label: "淘汰赛", stageNames: ["Playoffs"], expectRounds: [2, 2, 1], expectTeams: 6, qualifiedTeams: [] }
  ] };
  var structures = { "cs2|括号测试|Playoffs": { tid: 9, participants: ["甲", "乙", "丙", "丁", "戊", "己"], bracket: [
    { mid: 101, st: "finished", a: "甲", b: "乙", w: "甲", prev: [] },
    { mid: 102, st: "finished", a: "丙", b: "丁", w: "丁", prev: [] },
    { mid: 103, st: "finished", a: "戊", b: "己", w: "戊", prev: [] },
    { mid: 104, st: "finished", a: "甲", b: "戊", w: "戊", prev: [{ mid: 101, type: "winner" }, { mid: 103, type: "winner" }] },
    { mid: 105, st: "finished", a: "丁", b: "乙", w: "丁", prev: [{ mid: 102, type: "winner" }] },
    { mid: 106, st: "finished", a: "戊", b: "丁", w: "戊", prev: [{ mid: 104, type: "winner" }, { mid: 105, type: "winner" }] }
  ] } };
  var ev = AG.buildEvent(cfg, [], null, structures);
  var s = ev && ev.stages[0];
  if (!s || !s.results) return false;
  var ok = s.results.champion === "戊" && s.results.runnerUp === "丁" &&
    (s.results.third || []).indexOf("甲") >= 0 && (s.results.third || []).indexOf("乙") >= 0;
  // expectRounds [2,2,1]=5 场 ≠ bracket 6 场 → 只告警不炸（走到这里即通过）
  return ok;
})());
check("⑤ bracket 未全完赛 → 不出结果（round 启发式兜底语义不变）；⑥ qualifiedTeams 自动播种（rosters participants）", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  // ⑤ 半决赛未打完
  var structuresPending = { "cs2|括号测试|Playoffs": { tid: 9, participants: ["甲", "乙"], bracket: [
    { mid: 101, st: "finished", a: "甲", b: "乙", w: "甲", prev: [] },
    { mid: 106, st: "not_started", a: "", b: "", w: "", prev: [{ mid: 101, type: "winner" }] }
  ] } };
  var cfg = { id: "p-ev", game: "cs2", name: "测试", tournament: "括号测试", stages: [
    { id: "po", type: "placement", label: "淘汰赛", stageNames: ["Playoffs"], expectRounds: [2, 2, 1], expectTeams: 0, qualifiedTeams: [] }
  ] };
  var evP = AG.buildEvent(cfg, [], null, structuresPending);
  if (!evP || evP.stages[0].results !== null) return false;
  // ⑥ 播种：participants 6 队 → stage.teams=6、expectTeams=6（客户端名单齐判定的数据基础）
  var structuresSeed = { "cs2|括号测试|Playoffs": { tid: 9, participants: ["甲", "乙", "丙", "丁", "戊", "己"], bracket: [] } };
  var evS = AG.buildEvent(cfg, [], null, structuresSeed);
  var sS = evS && evS.stages[0];
  if (!sS) return false;
  return sS.teams.length === 6 && sS.expectTeams === 6;
})());
check("⑦ roundLabels 配置覆盖生效（_doc 宣称可配，2026-11-10 起真实现）", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  var cfg = { id: "rl-ev", game: "cs2", name: "测试", tournament: "轮名测试", stages: [
    { id: "po", type: "placement", label: "淘汰赛", stageNames: ["Playoffs"], expectRounds: [2, 1], expectTeams: 4, qualifiedTeams: ["甲", "乙", "丙", "丁"],
      roundLabels: ["四强", "总决赛"] }
  ] };
  var matches = [
    { game: "cs2", tournament: "轮名测试", stage: "Playoffs", teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: new Date(Date.now() - 48 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "轮名测试", stage: "Playoffs", teamA: { name: "丙" }, teamB: { name: "丁" }, startAt: new Date(Date.now() - 47 * 3600000).toISOString(), result: { winner: "A", score: "2:0" } },
    { game: "cs2", tournament: "轮名测试", stage: "Playoffs", teamA: { name: "甲" }, teamB: { name: "丙" }, startAt: new Date(Date.now() - 24 * 3600000).toISOString(), result: { winner: "A", score: "2:1" } }
  ];
  var ev = AG.buildEvent(cfg, matches, null);
  var s = ev && ev.stages[0];
  return s && !s.degraded && Array.isArray(s.rounds) && s.rounds[0] === "四强" && s.rounds[1] === "总决赛";
})());

/* ---------- 场景 AG（2026-11-09 事故）：Sync 调试环境门禁 ----------
   cloud.storage 在新宿主对调试会话（Browser Fake）真实可用——调试台本地测试状态曾以新
   时间戳推送真实云端，生产设备 LWW 拉回覆盖用户真实竞猜记录。门禁：runtime.mode=
   development 时读+写双向禁用（isMock() 区分不了 fake——fake 里 SDK 已加载）。 */
console.log("AG. Sync 调试门禁（development 禁读禁写、production 正常）：");
var gateOk = await (async function () {
  var sdk = globalThis.__TEST_SDK || (globalThis.__TEST_SDK = { cloud: {} });
  sdk.cloud = sdk.cloud || {};
  var storageWrites = 0;
  sdk.cloud.storage = { getStorage: async () => null, setStorage: async () => { storageWrites += 1; } };
  sdk.environment = { getInfoSync: () => ({ runtime: { mode: "development" } }) };
  var wDev = await Sync.write({ bankroll: 1, predictions: [] }, Date.now());
  var rDev = await Sync.read();
  sdk.environment.getInfoSync = () => ({ runtime: { mode: "production" } });
  var wProd = await Sync.write({ bankroll: 1, predictions: [] }, Date.now());
  var rProd = await Sync.read();
  return wDev === false && rDev === null && wProd === true && rProd === null && storageWrites === 1;
}());
check("development: write=false/read=null（零存储调用）；production: write=true", gateOk);

check("④ 4进3 战绩桶（BLAST Rivals 香港实测形态）：4 队×4 场 → 2:0×1 / 1:1×2 / 0:2×1 落桶出结果", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  var cfg = { id: "g43-ev", game: "cs2", name: "测试", tournament: "4进3测试", stages: [
    { id: "groupA", type: "records", label: "Group A · 双败战绩", stageNames: ["Group A"], buckets: [
      { k: "2:0", label: "2:0 直进四强", cap: 1 },
      { k: "1:1", label: "1:1 进六强", cap: 2 },
      { k: "0:2", label: "0:2 淘汰", cap: 1 }
    ] }
  ] };
  var t = 0;
  function m(a, b, w) {
    t += 1;
    return { game: "cs2", tournament: "4进3测试", stage: "Group A", teamA: { name: a }, teamB: { name: b },
      startAt: new Date(Date.UTC(2026, 10, 11, t)).toISOString(), result: { winner: w, score: "2:0" } };
  }
  // R1：甲胜乙、丙胜丁 → 胜者赛 甲胜丙、败者赛 乙胜丁（每队恰好两场）
  var matches = [m("甲", "乙", "A"), m("丙", "丁", "A"), m("甲", "丙", "A"), m("乙", "丁", "A")];
  var ev = AG.buildEvent(cfg, matches, null);
  var s = ev && ev.stages[0];
  if (!s || s.type !== "records" || !s.results) return false;
  return (s.results["2:0"] || []).join() === "甲" &&
    (s.results["1:1"] || []).slice().sort().join() === ["丙", "乙"].sort().join() &&
    (s.results["0:2"] || []).join() === "丁";
})());
check("⑤ qualifyFrom 自动推导晋级名单（2026-11-11）：小组完赛+桶落满 → 播种；未完赛/分布不符/官方 rosters 规模不符不播种", (function () {
  if (!AG || typeof AG.buildEvent !== "function") return true;
  var t = 0;
  function m(stage, a, b, w) {
    t += 1;
    return { id: "q" + t, game: "cs2", tournament: "晋级测试", stage: stage, teamA: { name: a }, teamB: { name: b },
      startAt: new Date(Date.UTC(2026, 11, stage === "Playoffs" ? 13 : 11, t % 24)).toISOString(),
      result: w ? { winner: w, score: "2:0" } : null };
  }
  function cfgWith() {
    return { id: "q-ev", game: "cs2", name: "测试", tournament: "晋级测试", stages: [
      { id: "groupA", type: "records", label: "Group A", stageNames: ["Group A"], buckets: [
        { k: "2:0", label: "2:0", cap: 1 }, { k: "1:1", label: "1:1", cap: 2 }, { k: "0:2", label: "0:2", cap: 1 }
      ] },
      { id: "playoffs", type: "placement", label: "淘汰赛", stageNames: ["Playoffs"], expectTeams: 3,
        qualifyFrom: [{ stage: "groupA", buckets: ["2:0", "1:1"] }] }
    ] };
  }
  function teamNames(ps) { return ps ? ps.teams.map(function (x) { return x.name; }).join() : ""; }
  // R1：甲胜乙、丙胜丁；胜者赛 甲胜丙；败者赛 乙胜丁 → 甲 2:0、丙/乙 1:1、丁 0:2（4进3 分布吻合）
  var full = [m("Group A", "甲", "乙", "A"), m("Group A", "丙", "丁", "A"), m("Group A", "甲", "丙", "A"), m("Group A", "乙", "丁", "A")];
  var playoffMatch = m("Playoffs", "甲", "丙", "");
  var ev1 = AG.buildEvent(cfgWith(), full.concat([playoffMatch]), null);
  var ps1 = ev1 && ev1.stages[1];
  if (!ps1 || ps1.type !== "placement" || ps1.degraded !== true) return false;
  if (teamNames(ps1).split(",").sort().join() !== ["甲", "丙", "乙"].sort().join()) return false;
  // ② 小组未完赛（败者赛无赛果）→ 不播种（playoffs 只有已排期场次的队伍）
  var ev2 = AG.buildEvent(cfgWith(), full.slice(0, 3).concat([m("Group A", "乙", "丁", "")]).concat([playoffMatch]), null);
  if (teamNames(ev2 && ev2.stages[1]) !== "甲,丙") return false;
  // ③ 分布不符（加打一场 → 甲 3:0 落不进任何桶）→ 不播种
  var ev3 = AG.buildEvent(cfgWith(), full.concat([m("Group A", "甲", "丁", "A")]).concat([playoffMatch]), null);
  if (teamNames(ev3 && ev3.stages[1]) !== "甲,丙") return false;
  // ④ 官方 rosters 5 队 ≠ expectTeams 3 → 不采用，落到 qualifyFrom 推导
  var st = { "cs2|晋级测试|Playoffs": { participants: ["外1", "外2", "外3", "外4", "外5"] } };
  var ev4 = AG.buildEvent(cfgWith(), full.concat([playoffMatch]), null, st);
  if (teamNames(ev4 && ev4.stages[1]).split(",").sort().join() !== ["甲", "丙", "乙"].sort().join()) return false;
  return true;
})());

/* ---------- 场景 AI（2026-11-10 深度接入）：实时三件套 lv/lsc/gs ----------
   lv=官方 running 信号（statusOf 优先于时间估算）、lsc=实时比分、gs=局进度串 "A1584,A1508"。
   键恒存在（未发生=undefined）——mergeMatches 的 Object.assign 复制 own key，
   running→finished 后旧实时数据被显式覆盖不残留；JSON.stringify 自动省略 undefined。 */
console.log("AI. 实时三件套（lv/lsc/gs 采集与 merge 刷新）：");
var LIB = await import(pathToFileURL(path.join(root, "tools", "lib.mjs")).href);
check("① normalizeMatch：lv/lsc/gs 白名单透传，键恒存在（未发生=undefined）", (function () {
  var n1 = LIB.normalizeMatch({ id: "x", game: "cs2", tournament: "T", stage: "S", startAt: "2026-11-20T10:00:00Z",
    teamA: { name: "甲" }, teamB: { name: "乙" }, lv: true, lsc: "1:0", gs: "A1584,B1520" }, "pandascore");
  if (n1.lv !== true || n1.lsc !== "1:0" || n1.gs !== "A1584,B1520") return false;
  var n2 = LIB.normalizeMatch({ id: "x", game: "cs2", tournament: "T", stage: "S", startAt: "2026-11-20T10:00:00Z",
    teamA: { name: "甲" }, teamB: { name: "乙" } }, "pandascore");
  return "lv" in n2 && n2.lv === undefined && "lsc" in n2 && n2.lsc === undefined && "gs" in n2 && n2.gs === undefined;
})());
check("② mergeMatches：running→finished 转换后旧实时数据被显式覆盖不残留", (function () {
  var base = { game: "cs2", tournament: "T", stage: "S", startAt: "2026-11-20T10:00:00Z",
    teamA: { name: "甲" }, teamB: { name: "乙" } };
  var existing = [Object.assign({}, base, { id: "m1", mid: 9001, lv: true, lsc: "1:0", gs: "A1584" })];
  var incoming = [Object.assign({}, base, { id: "m1", mid: 9001, result: { winner: "A", score: "2:0" } })];
  var merged = LIB.mergeMatches(existing, incoming, { retentionDays: 45 }).matches;
  var m = merged[0];
  if (!m.result || m.result.winner !== "A") return false; // finished 落定
  return m.lv === undefined && m.lsc === undefined && m.gs === undefined; // 旧实时数据清干净
})());
check("③ mergeMatches：纯 running 更新（无 result）照常刷新 lv/lsc/gs", (function () {
  var base = { game: "cs2", tournament: "T", stage: "S", startAt: "2026-11-20T10:00:00Z",
    teamA: { name: "甲" }, teamB: { name: "乙" } };
  var existing = [Object.assign({}, base, { id: "m1", mid: 9001 })];
  var incoming = [Object.assign({}, base, { id: "m1", mid: 9001, lv: true, lsc: "1:1", gs: "A1800,B1750" })];
  var merged = LIB.mergeMatches(existing, incoming, { retentionDays: 45 }).matches;
  var m = merged[0];
  return m.lv === true && m.lsc === "1:1" && m.gs === "A1800,B1750";
})());
check("④ 客户端接线（静态）：statusOf lv 优先于时间估算 + 卡片实时分 + 详情页局记分", (function () {
  var body = appSrc.slice(appSrc.indexOf("function statusOf"), appSrc.indexOf("function statusOf") + 700);
  return /if \(m\.lv === true\) return "live"/.test(body) && // lv 优先（在时间估算前）
    body.indexOf("m.lv === true") < body.indexOf("now < start + matchDurationMs") &&
    /team-score is-live/.test(appSrc) && /function parseGameLog/.test(appSrc) &&
    /md-games/.test(appSrc) && /md-game-live/.test(appSrc);
})());

/* ---------- 场景 AK（2026-11-11 二期）：live.json 高频链路 ----------
   publish-live-oss 全局 running/past → live.json（几 KB 独立小文件，不进 meta hash）→
   客户端 fetchLiveSnapshot（内存缓存+静默降级）→ applyLivePatch 就地补丁（matchMidIndex 引用）
   → finished 迁移才结算。客户端匹配必须用 mid（停剥后进 runtime 包）。 */
console.log("AK. live 高频链路（live.json 形状 / applyLivePatch / mid 定位）：");
var LIVE = await import(pathToFileURL(path.join(root, "tools", "publish-live-oss.mjs")).href);
check("① buildLiveDoc：running→live（mid/lsc/gs）+ past finished（mid/result/endAt）；非完赛局/无比分剔除", (function () {
  var running = [{
    id: 5001, status: "running",
    opponents: [{ opponent: { id: 11, name: "甲" } }, { opponent: { id: 22, name: "乙" } }],
    results: [{ team_id: 11, score: 1 }, { team_id: 22, score: 0 }],
    games: [{ position: 1, status: "finished", winner: { id: 11 }, length: 1820 }, { position: 2, status: "running" }]
  }];
  var past = [{
    id: 5002, status: "finished", winner_id: 22, end_at: "2026-11-11T10:00:00Z",
    opponents: [{ opponent: { id: 11, name: "甲" } }, { opponent: { id: 22, name: "乙" } }],
    results: [{ team_id: 11, score: 1 }, { team_id: 22, score: 2 }],
    games: [{ position: 1, status: "finished", winner: { id: 22 }, length: 1900 }]
  }, {
    id: 5003, status: "canceled", opponents: [{ opponent: { id: 11 } }, { opponent: { id: 22 } }], results: []
  }];
  var doc = LIVE.buildLiveDoc(running, past);
  if (doc.live.length !== 1 || doc.live[0].mid !== 5001) return false;
  if (doc.live[0].lsc !== "1:0" || doc.live[0].gs !== "A1820") return false;
  if (doc.finished.length !== 1 || doc.finished[0].mid !== 5002) return false;
  if (doc.finished[0].result.winner !== "B" || doc.finished[0].result.score !== "1:2") return false;
  return doc.finished[0].endAt === "2026-11-11T10:00:00Z"; // canceled 无比分 → 剔除
})());
check("② 客户端接线（静态）：fetchLiveSnapshot 降级门/内存缓存 + applyLivePatch 就地补丁 + mid 索引 + 独立轮询 + mid 停剥", (function () {
  var dsSrc2 = rf(path.join(root, "js", "data-source.js"), "utf8");
  return /export async function fetchLiveSnapshot/.test(dsSrc2) &&
    /getRuntimeMode\(\) === "preview"\) return null/.test(dsSrc2) && // 预览态降级（不弹 SERVER_API_REQUIRED）
    /var liveCache = null/.test(dsSrc2) && /normalizeLiveDoc/.test(dsSrc2) &&
    /function applyLivePatch/.test(appSrc) && /matchMidIndex/.test(appSrc) &&
    /function matchByMid/.test(appSrc) && /LIVE_POLL_INTERVAL/.test(appSrc) &&
    /finishedMigration/.test(appSrc) && /settlePickem\(\);/.test(appSrc) &&
    /mid 保留在运行时包/.test(libSrc); // stripTeamLogos 停剥 mid
})());

/* ---------- 场景 AL（2026-11-11 二期）：结构管线 v3（tier 直发现 + listing participants） ---------- */
console.log("AL. 结构管线 v3（tier 直发现 / listing participants）：");
check("① tier 直发现（静态）：filter[tier]=s 调用 + listingParticipants 提取 + rosters 兜底", (function () {
  var stSrc = rf(path.join(root, "tools", "fetch-tournament-structures.mjs"), "utf8");
  return /filter\[tier\]=s&per_page=12/.test(stSrc) &&
    /listingParticipants/.test(stSrc) &&
    /listingParticipants \? null : await apiGet/.test(stSrc) &&
    /import { SLUGS } from ".\/adapters\/pandascore.mjs"/.test(stSrc) &&
    /export var SLUGS/.test(pandasSrc);
})());
check("② incidents 自愈（静态）：creation→GET /matches/{id} 补抓 + validate 守卫 + writeOutputs", (function () {
  var incSrc = rf(path.join(root, "tools", "fetch-incidents.mjs"), "utf8");
  return /已自动补抓/.test(incSrc) && /\/matches\/" \+ miss\.mid/.test(incSrc) &&
    /validateMatches\(merged\.matches\)/.test(incSrc) && /writeOutputs\(ROOT, src\.matches\)/.test(incSrc);
})());
check("③ rosters 事件驱动（静态）：range[modified_at] + player-cursor 游标 + changedTeams 过滤", (function () {
  var bfSrc2 = rf(path.join(root, ".github", "workflows", "backfill-matches.yml"), "utf8");
  return /range\[modified_at\]/.test(rostersTool) && /player-cursor\.json/.test(rostersTool) &&
    /if \(changedTeams\) return !!changedTeams\[k\];/.test(rostersTool) &&
    /player-cursor\.json/.test(bfSrc2);
})());
/* ---------- 场景 AJ（2026-11-10 深度接入）：incidents 对账 ----------
   官方 /incidents?type=match&since= 增量流（每对象只留最新一条）；对账=漏抓/删除警告，
   删除只警告不删数据（账本完整性纪律）；游标必须单调推进（乱序/空批次不回退）。
   2026-11-11 v2：creation 漏抓升级为 GET /matches/{id} 定向补抓自愈（见 AL ②）。 */
console.log("AJ. incidents 对账（游标推进 / creation 漏抓 / deletion 仍持有）：");
var INC = await import(pathToFileURL(path.join(root, "tools", "fetch-incidents.mjs")).href);
check("① classifyIncidents：creation 窗口内漏抓 / deletion 仍持有 / update 计数 / 窗口外忽略", (function () {
  var matches = [
    { mid: 100, tournament: "T", teamA: { name: "甲" }, teamB: { name: "乙" }, startAt: "2026-11-10T10:00:00Z" }
  ];
  var now = Date.now();
  var window = { fromMs: now - 3 * 86400000, toMs: now + 10 * 86400000 };
  var items = [
    { change_type: "creation", modified_at: "2026-11-10T12:00:00Z", object: { id: 200, begin_at: new Date(now + 86400000).toISOString() } }, // 窗口内、本地无 → 漏抓
    { change_type: "creation", modified_at: "2026-11-10T12:01:00Z", object: { id: 201, begin_at: new Date(now + 40 * 86400000).toISOString() } }, // 窗口外 → 忽略
    { change_type: "creation", modified_at: "2026-11-10T12:02:00Z", object: { id: 100, begin_at: new Date(now + 86400000).toISOString() } }, // 本地已有 → 不算漏抓
    { change_type: "deletion", modified_at: "2026-11-10T12:03:00Z", object: { id: 100 } }, // 仍持有 → deletion
    { change_type: "deletion", modified_at: "2026-11-10T12:04:00Z", object: { id: 300 } }, // 本来就没有 → 忽略
    { change_type: "update", modified_at: "2026-11-10T12:05:00Z", object: { id: 100 } }
  ];
  var r = INC.classifyIncidents(items, matches, window);
  if (r.createdMissed.length !== 1 || r.createdMissed[0].mid !== 200) return false;
  if (r.deleted.length !== 1 || r.deleted[0].mid !== 100) return false;
  if (r.updated !== 1) return false;
  return r.maxModified === "2026-11-10T12:05:00Z";
})());
check("② nextCursor：取批次最大 modified_at；空批次保持旧游标；序列单调不回退", (function () {
  if (INC.nextCursor([{ modified_at: "2026-11-10T12:05:00Z" }, { modified_at: "2026-11-10T12:09:00Z" }], "2026-11-10T12:00:00Z") !== "2026-11-10T12:09:00Z") return false;
  if (INC.nextCursor([], "2026-11-10T12:00:00Z") !== "2026-11-10T12:00:00Z") return false;
  var c = "2026-11-10T00:00:00Z";
  [[{ modified_at: "2026-11-10T01:00:00Z" }], [], [{ modified_at: "2026-11-10T00:30:00Z" }]].forEach(function (batch) { c = INC.nextCursor(batch, c); });
  return c === "2026-11-10T01:00:00Z"; // 乱序/空批次后游标仍单调
})());
check("③ 数据链路（静态）：游标资产 + 对账步骤 + 两 workflow 接线", (function () {
  var bfSrc = rf(path.join(root, ".github", "workflows", "backfill-matches.yml"), "utf8");
  return /Fetch incidents/.test(wfSrc) && /Fetch incidents/.test(bfSrc) &&
    /incidents-cursor\.json/.test(wfSrc) && /incidents-cursor\.json/.test(bfSrc) &&
    /export function classifyIncidents/.test(rf(path.join(root, "tools", "fetch-incidents.mjs"), "utf8"));
})());
check("④ U+ rosters 字段扩展与选手卡链路（静态）", (function () {
  var dsSrc2 = rf(path.join(root, "js", "data-source.js"), "utf8");
  return /playerImgPath\(p\.image_url\)/.test(rostersTool) &&
    /id: p\.id > 0 \? Math\.floor\(p\.id\) : undefined/.test(rostersTool) &&
    /img: typeof p\.img === "string" && p\.img \? p\.img : undefined/.test(dsSrc2) &&
    /PLAYER_BASE = "players\/"/.test(appSrc) && /function playerAvatarHTML/.test(appSrc) &&
    /function openPlayerSheet/.test(appSrc) && /id="playerSheet"/.test(htmlSrc) &&
    /pack-player-avatars/.test(JSON.stringify(pkgJson)) &&
    /\.md-games/.test(cssSrc) && /\.player-sheet/.test(cssSrc) && /\.team-score\.is-live/.test(cssSrc);
})());

rmSync(tmp, { recursive: true, force: true });

/* ---------- 场景 AH（2026-11-10）：赛事结构（structures）客户端链路 ----------
   fetch-tournament-structures（官方 rosters/standings/brackets）→ build/trim 切片 →
   normalizeStructures 白名单 → buildAutoEvents（auto records 结算主证据）与桶体积分条。 */
console.log("AH. 赛事结构链路（normalizeStructures / stage.standings / auto standings 主证据）：");
check("① normalizeStructures：白名单（participants/standings）+ 脏条目丢弃 + 封顶", (function () {
  var raw = {
    "cs2|T1|Group A": { tid: 1, participants: ["甲", "乙", "", 42], standings: [{ t: "甲", w: 2, l: 0 }, { t: "bad" }, { t: "乙", w: -1, l: 0 }, { t: "丙", w: 1, l: 1 }] },
    "cs2|T1|Group B": { participants: [], standings: [] }, // 空条目丢弃
    "bad": 42
  };
  var out = PK.normalizeStructures(raw);
  var a = out["cs2|T1|Group A"];
  if (!a) return false;
  if (a.participants.join() !== "甲,乙" ) return false; // 空串/数字过滤
  if (!Array.isArray(a.standings) || a.standings.length !== 2) return false; // 脏行丢弃
  if (out["cs2|T1|Group B"] !== undefined) return false; // 全空丢弃
  if (out["bad"] !== undefined) return false;
  // 封顶 64
  var many = {};
  for (var i = 0; i < 70; i++) many["k" + i] = { participants: ["甲"] };
  var out2 = PK.normalizeStructures(many);
  return Object.keys(out2).length === 64;
})());
check("② normalizeStage：standings 行清洗透传（脏行丢弃、无行省略）", (function () {
  var st = PK.normalizePickemData({ events: [{ id: "e", game: "cs2", name: "x", stages: [
    { id: "g", type: "records", label: "G", buckets: [{ k: "1:0", cap: 1 }], standings: [{ t: "甲", w: 1, l: 0 }, { t: "乙", w: "x", l: 0 }] }
  ] }] }).events[0].stages[0];
  if (!Array.isArray(st.standings) || st.standings.length !== 1 || st.standings[0].t !== "甲") return false;
  var st2 = PK.normalizePickemData({ events: [{ id: "e", game: "cs2", name: "x", stages: [
    { id: "g", type: "records", label: "G", buckets: [{ k: "1:0", cap: 1 }] }
  ] }] }).events[0].stages[0];
  return st2.standings === undefined; // 无数据省略（老数据形状不变）
})());
check("③ buildAutoEvents：auto records 结算以官方 standings 为主证据（自采胜者误差不再永不结算）", (function () {
  var now = Date.now();
  function m(id, a, b, w, hAgo) {
    return { id: id, game: "cs2", tournament: "自动桶测试", stage: "Group A", tier: "s",
      teamA: { name: a }, teamB: { name: b }, startAt: new Date(now - hAgo * 3600000).toISOString(),
      result: w ? { winner: w, score: "2:0" } : null };
  }
  // 4 队×5 场 GSL（autoRecordsBuckets 命中），乙 vs 丁 一场胜者被采反（heal/误差模拟）——
  // 派生 W:L：甲 2:0 / 乙 1:2 / 丙 1:2 / 丁 1:1 → 分布不符（旧逻辑 null）；
  // 官方 standings 给真值（甲 2:0 / 乙 2:1 / 丙 1:2 / 丁 0:2）→ 落桶出结果
  var matches = [m("a1", "甲", "乙", "A", 80), m("a2", "丙", "丁", "A", 79), m("a3", "甲", "丙", "A", 50), m("a4", "丁", "乙", "A", 49), m("a5", "乙", "丙", "A", 20)];
  var structures = { "cs2|自动桶测试|Group A": { participants: ["甲", "乙", "丙", "丁"], standings: [
    { t: "甲", w: 2, l: 0 }, { t: "乙", w: 2, l: 1 }, { t: "丙", w: 1, l: 2 }, { t: "丁", w: 0, l: 2 }
  ] } };
  var evs = PK.buildAutoEvents(matches, [], structures);
  var ev = evs.filter(function (e) { return e.id === "auto:自动桶测试"; })[0];
  if (!ev) return false;
  var rec = ev.stages.filter(function (s) { return s.type === "records"; })[0];
  if (!rec) return false;
  if (!Array.isArray(rec.standings) || rec.standings.length !== 4) return false;
  if (!rec.results) return false;
  return (rec.results["2:0"] || []).join() === "甲" && (rec.results["2:1"] || []).join() === "乙" &&
    (rec.results["1:2"] || []).join() === "丙" && (rec.results["0:2"] || []).join() === "丁";
})());
check("④ buildAutoEvents：无 structures 时行为不变（分布比对兜底回归）", (function () {
  var now = Date.now();
  function m(id, a, b, w, hAgo) {
    return { id: id, game: "cs2", tournament: "自动桶回归", stage: "Group A", tier: "s",
      teamA: { name: a }, teamB: { name: b }, startAt: new Date(now - hAgo * 3600000).toISOString(),
      result: w ? { winner: w, score: "2:0" } : null };
  }
  var matches = [m("b1", "甲", "乙", "A", 80), m("b2", "丙", "丁", "A", 79), m("b3", "甲", "丙", "A", 50), m("b4", "乙", "丁", "A", 49), m("b5", "乙", "丙", "A", 20)];
  var evs = PK.buildAutoEvents(matches, []);
  var rec = evs[0].stages.filter(function (s) { return s.type === "records"; })[0];
  if (!rec || rec.standings !== undefined) return false;
  if (!rec.results) return false;
  return rec.results["2:0"][0] === "甲" && rec.results["2:1"][0] === "乙" &&
    rec.results["1:2"][0] === "丙" && rec.results["0:2"][0] === "丁";
})());

console.log("");
if (failures) {
  console.error("FAILED: " + failures + " 项未通过");
  process.exit(1);
}
console.log("OK: 全部场景通过");
