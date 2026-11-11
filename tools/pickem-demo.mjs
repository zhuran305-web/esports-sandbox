#!/usr/bin/env node
/*
 * Pick'Em 演示数据注入（1.4.0，仅本地调试用）
 * ------------------------------------------------------------
 * 用法：node tools/pickem-demo.mjs [--remove]
 *
 * 往 data/pickem.json 注入一个合成的「可竞猜」演示赛事（16 队瑞士轮开赛前 2 小时 +
 * 八强淘汰赛 4 场可猜 + 半决赛/决赛待上一轮），供调试台走查选队/点胜者/截止状态 UI；
 * --remove 恢复为聚合器产物（重新跑 node tools/fetch-pickem.mjs 亦可）。
 * 注意：只改本地缓存文件，不碰 OSS/Release；demo 事件 id 带 demo- 前缀，绝不能进生产配置。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var FILE = path.join(ROOT, "data", "pickem.json");

function iso(ms) { return new Date(Date.now() + ms).toISOString(); }

function demoEvent() {
  var teams = [];
  for (var i = 0; i < 16; i++) {
    teams.push({ name: "演示队" + (i + 1), short: "D" + (i + 1), region: "cn", logo: "", w: 0, l: 0 });
  }
  var names = teams.map(function (t) { return t.name; });
  var t = function (i) { return teams[i]; };
  return {
    id: "demo-pickem-2026", game: "cs2", name: "演示赛 · Pick'Em 体验赛",
    status: "active", endsAt: iso(6 * 86400000),
    stages: [
      {
        id: "swiss", type: "swiss", label: "小组赛 · 瑞士轮",
        startsAt: iso(2 * 3600000), endsAt: iso(3 * 86400000),
        teams: teams,
        matches: [
          { id: "demo-m1", a: names[0], b: names[1], startAt: iso(2 * 3600000), winner: "", score: "" },
          { id: "demo-m2", a: names[2], b: names[3], startAt: iso(2.5 * 3600000), winner: "", score: "" }
        ],
        results: null
      },
      {
        // 2026-11-12 夜间自查：1.3.16 已删除 bracket 类型（normalizeStage 拒收 → 整块不渲染），
        // demo 改用现行 placement 类型（expectTeams=8 + 显式名单播种，与 pickem-events.json 同构）
        id: "po", type: "placement", label: "淘汰赛 · 八强",
        startsAt: iso(3 * 3600000), endsAt: iso(5 * 86400000),
        expectTeams: 8,
        qualifiedTeams: names.slice(0, 8),
        teams: teams.slice(0, 8),
        matches: [
          { id: "demo-qf1", a: names[0], b: names[1], startAt: iso(3 * 3600000), winner: "", score: "", round: 0 },
          { id: "demo-qf2", a: names[2], b: names[3], startAt: iso(3.5 * 3600000), winner: "", score: "", round: 0 },
          { id: "demo-qf3", a: names[4], b: names[5], startAt: iso(4 * 3600000), winner: "", score: "", round: 0 },
          { id: "demo-qf4", a: names[6], b: names[7], startAt: iso(4.5 * 3600000), winner: "", score: "", round: 0 },
          { id: "demo-sf1", a: "", b: "", startAt: iso(30 * 3600000), winner: "", score: "", round: 1 },
          { id: "demo-sf2", a: "", b: "", startAt: iso(31 * 3600000), winner: "", score: "", round: 1 },
          { id: "demo-f", a: "", b: "", startAt: iso(54 * 3600000), winner: "", score: "", round: 2 }
        ],
        rounds: ["四分之一决赛", "半决赛", "决赛"],
        degraded: false
      }
    ]
  };
}

var raw = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { v: 1, events: [] };
var events = (raw.events || []).filter(function (e) { return e && e.id !== "demo-pickem-2026"; });

if (process.argv.indexOf("--remove") >= 0) {
  writeFileSync(FILE, JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), events: events }, null, 2) + "\n", "utf8");
  console.log("[pickem-demo] 已移除演示事件，剩余 " + events.length + " 个赛事");
} else {
  events.push(demoEvent());
  writeFileSync(FILE, JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), events: events }, null, 2) + "\n", "utf8");
  console.log("[pickem-demo] 已注入演示事件（瑞士轮开赛前 2h + 八强 4 场可猜），当前 " + events.length + " 个赛事");
  console.log("[pickem-demo] 下一步：node tools/trim-embedded.mjs 后起 dev 调试台；验收完 node tools/pickem-demo.mjs --remove");
}
