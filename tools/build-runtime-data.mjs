#!/usr/bin/env node
/*
 * 生成运行时数据快照：runtime/matches.json + runtime/meta.json
 * 客户端先拉 meta.json，hash/updatedAt 变化时才拉 matches.json。
 * 用法：node tools/build-runtime-data.mjs
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTeamLogos, stripTeamLogos } from "./lib.mjs";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var SRC = path.join(ROOT, "data", "matches.json");
var OUT = path.join(ROOT, "runtime");

var raw = JSON.parse(await readFile(SRC, "utf8"));
if (!raw || !Array.isArray(raw.matches) || !raw.matches.length) {
  throw new Error("data/matches.json 不是有效的赛事数据");
}

var matches = stripTeamLogos(raw.matches);
var teams = collectTeamLogos(raw.matches);
// 队伍主题色（1.2.11）：extract-team-colors 的缓存切片——只输出当前窗口有的队伍
var colorsAll = {};
var colorsPath = path.join(ROOT, "data", "team-colors.json");
if (existsSync(colorsPath)) {
  try { colorsAll = JSON.parse(await readFile(colorsPath, "utf8")) || {}; } catch (e) { colorsAll = {}; }
}
var teamColors = {};
Object.keys(teams).forEach(function (name) {
  var e = colorsAll[name];
  if (e && Array.isArray(e.c) && e.c.length >= 3) teamColors[name] = e.c;
});
// 战队选手阵容（1.3.2）：fetch-team-rosters 的缓存切片——只输出窗口队伍（键 game:name）
var rostersAll = {};
var rostersPath = path.join(ROOT, "data", "team-rosters.json");
if (existsSync(rostersPath)) {
  try { rostersAll = JSON.parse(await readFile(rostersPath, "utf8")) || {}; } catch (e) { rostersAll = {}; }
}
var rosters = {};
raw.matches.forEach(function (m) {
  ["teamA", "teamB"].forEach(function (side) {
    var t = m[side];
    if (!t || !t.name) return;
    var key = m.game + ":" + t.name;
    var e = rostersAll[key];
    if (e && Array.isArray(e.players) && e.players.length && !rosters[key]) rosters[key] = e.players;
  });
});
// Pick'Em 赛事聚合（1.4.0 实验功能）：fetch-pickem 的累积缓存整体进 runtime；
// 事件内部自带全部队伍/赛程/赛果，与 matches 的时间窗无关（major 跨 2-3 周）
var pickem = { v: 1, events: [] };
var pickemPath = path.join(ROOT, "data", "pickem.json");
if (existsSync(pickemPath)) {
  try {
    var pickemRaw = JSON.parse(await readFile(pickemPath, "utf8"));
    if (pickemRaw && Array.isArray(pickemRaw.events)) pickem = { v: 1, events: pickemRaw.events };
  } catch (e) { pickem = { v: 1, events: [] }; }
}
// 赛事结构切片（2026-11-10）：fetch-tournament-structures 的官方名单/积分——只带客户端要用的
// participants/standings（bracket 仅数据侧推导用，不下发）；键 game|tournament|stage 与 matches 对齐，
// 只输出窗口内出现过的赛事，封顶 64。计入 meta hash（内容变化才翻，确定性序列化）
var structuresAll = {};
var structsPath = path.join(ROOT, "data", "tournament-structures.json");
if (existsSync(structsPath)) {
  try {
    var structsRaw = JSON.parse(await readFile(structsPath, "utf8"));
    if (structsRaw && structsRaw.structures) structuresAll = structsRaw.structures;
  } catch (e) { structuresAll = {}; }
}
var structures = {};
raw.matches.forEach(function (m) {
  var nKeys = Object.keys(structures).length;
  if (!m || !m.game || !m.tournament || !m.stage || nKeys >= 64) return;
  var key = m.game + "|" + m.tournament + "|" + m.stage;
  if (structures[key] || !structuresAll[key]) return;
  var e = structuresAll[key];
  structures[key] = {
    participants: Array.isArray(e.participants) ? e.participants.slice(0, 32) : [],
    standings: Array.isArray(e.standings) ? e.standings.slice(0, 16) : []
  };
});
var updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString();
var hash = createHash("sha256").update(JSON.stringify({ teams: teams, teamColors: teamColors, rosters: rosters, pickem: pickem, structures: structures, matches: matches })).digest("hex");
var meta = {
  schemaVersion: 1,
  updatedAt: updatedAt,
  count: matches.length,
  teamCount: Object.keys(teams).length,
  teamColorCount: Object.keys(teamColors).length,
  rosterCount: Object.keys(rosters).length,
  pickemCount: pickem.events.length,
  structureCount: Object.keys(structures).length,
  hash: hash
};
var body = JSON.stringify({ updatedAt: updatedAt, teams: teams, teamColors: teamColors, rosters: rosters, pickem: pickem, structures: structures, matches: matches });

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
await writeFile(path.join(OUT, "matches.json"), body + "\n", "utf8");

console.log(
  "[runtime] " + matches.length + " 场 · " + Object.keys(teams).length + " 支队标 · " +
  Object.keys(teamColors).length + " 支主题色 · " + Object.keys(rosters).length + " 套阵容 · " +
  pickem.events.length + " 个 Pick'Em 赛事 · " + Object.keys(structures).length + " 组赛事结构 · " +
  (body.length / 1048576).toFixed(2) + " MiB · hash " + hash.slice(0, 12)
);

// 阵容切片为 0 是「数据缺失」而非「正常为空」——发布会把线上阵容清空（2026-11-11 事故：
// update-matches 未恢复 data/team-rosters.json，每小时清空线上阵容切片）。显式告警，别静默。
if (Object.keys(rosters).length === 0) {
  console.warn("[runtime] 警告：阵容切片为 0（data/team-rosters.json " +
    (Object.keys(rostersAll).length ? "有 " + Object.keys(rostersAll).length + " 队但无窗口匹配" : "缺失") +
    "）——发布将清空线上阵容切片，请检查 Restore/采集步骤是否恢复了该文件");
}
