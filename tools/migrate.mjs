/*
 * 历史一次性迁移脚本：把旧版 data/matches.js 转成 data/matches.json。
 * 迁移早已完成，data/matches.js 也已删除，正常流程不再需要本脚本；
 * 仅当手里还有旧版 matches.js 需要恢复时才运行。
 */
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { normalizeMatch, validateMatches, writeOutputs } from "./lib.mjs";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

var code = await readFile(path.join(ROOT, "data/matches.js"), "utf8");
var sandbox = { window: {} };
vm.runInNewContext(code, sandbox);

var data = sandbox.window.MATCH_DATA;
if (!data || !Array.isArray(data.matches)) {
  throw new Error("data/matches.js 中没有找到 window.MATCH_DATA.matches");
}

var matches = data.matches
  .map(function (m) {
    return normalizeMatch(Object.assign({}, m, { source: "manual" }), "manual");
  })
  .filter(Boolean);

var errors = validateMatches(matches);
if (errors.length) {
  console.error("校验失败：");
  errors.forEach(function (e) { console.error("  - " + e); });
  process.exit(1);
}

await writeOutputs(ROOT, matches);
console.log("迁移完成：" + matches.length + " 场赛事已写入 data/matches.json");
