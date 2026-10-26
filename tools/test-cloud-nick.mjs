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

rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failures) {
  console.error("FAILED: " + failures + " 项未通过");
  process.exit(1);
}
console.log("OK: 全部场景通过");
