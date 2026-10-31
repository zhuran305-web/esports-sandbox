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
var updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString();
var hash = createHash("sha256").update(JSON.stringify({ teams: teams, teamColors: teamColors, matches: matches })).digest("hex");
var meta = {
  schemaVersion: 1,
  updatedAt: updatedAt,
  count: matches.length,
  teamCount: Object.keys(teams).length,
  teamColorCount: Object.keys(teamColors).length,
  hash: hash
};
var body = JSON.stringify({ updatedAt: updatedAt, teams: teams, teamColors: teamColors, matches: matches });

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
await writeFile(path.join(OUT, "matches.json"), body + "\n", "utf8");

console.log(
  "[runtime] " + matches.length + " 场 · " + Object.keys(teams).length + " 支队标 · " +
  Object.keys(teamColors).length + " 支主题色 · " +
  (body.length / 1048576).toFixed(2) + " MiB · hash " + hash.slice(0, 12)
);
