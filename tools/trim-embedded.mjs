/*
 * 生成内置数据快照 data/matches-embedded.json（构建打包用）：
 * 只保留冷启动兜底需要的窗口（默认过去 4 天 + 未来 16 天），
 * 完整的 30+30 天数据仍由运行时 OSS 拉取提供（js/data-source.js）。
 * 3375 场全量里约 77% 是 7 天前的历史赛果，打进包里只是压舱物。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTeamLogos, stripTeamLogos } from "./lib.mjs";

var ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function numFlag(name, dft) {
  var i = process.argv.indexOf("--" + name);
  if (i >= 0 && process.argv[i + 1] && /^\d+$/.test(process.argv[i + 1])) {
    return Number(process.argv[i + 1]);
  }
  return dft;
}

var PAST_DAYS = numFlag("past-days", 4);
var FUTURE_DAYS = numFlag("future-days", 16);
var DAY = 24 * 60 * 60 * 1000;

var srcPath = path.join(ROOT, "data", "matches.json");
var src;
try {
  src = JSON.parse(readFileSync(srcPath, "utf8"));
} catch (e) {
  console.error("[trim] 缺少 data/matches.json，先运行 npm run data:pull");
  process.exit(1);
}

var now = Date.now();
var from = now - PAST_DAYS * DAY;
var to = now + FUTURE_DAYS * DAY;
var matches = (src.matches || []).filter(function (m) {
  var t = m && m.startAt ? new Date(m.startAt).getTime() : NaN;
  return !isNaN(t) && t >= from && t < to;
});
matches.sort(function (a, b) {
  return new Date(a.startAt) - new Date(b.startAt);
});

var out = {
  updatedAt: src.updatedAt || "",
  // 标记内置窗口，便于排查「为什么离线看不到 30 天」
  embeddedWindow: {
    pastDays: PAST_DAYS,
    futureDays: FUTURE_DAYS,
    generatedAt: new Date(now).toISOString()
  },
  // 只带窗口内队伍的队标（全量 902 支，窗口内约 400 支）
  teams: collectTeamLogos(matches),
  matches: stripTeamLogos(matches)
};

var body = JSON.stringify(out);
writeFileSync(path.join(ROOT, "data", "matches-embedded.json"), body, "utf8");
console.log("[trim] 内置快照 " + (src.matches || []).length + " 场 -> " + matches.length +
  " 场（过去 " + PAST_DAYS + " 天 + 未来 " + FUTURE_DAYS + " 天），" +
  (body.length / 1048576).toFixed(2) + " MiB");
