#!/usr/bin/env node
/*
 * 赛事数据采集器
 * ------------------------------------------------------------
 * 用法：
 *   node tools/fetch-matches.mjs                 采集并写入 data/matches.json（不提交 Git）
 *   node tools/fetch-matches.mjs --dry-run       只采集与合并，打印结果，不写文件
 *   node tools/fetch-matches.mjs --only=manual   只合并手工数据（离线可用）
 *   node tools/fetch-matches.mjs --days=14       采集未来 14 天赛程（默认 7 天）
 *   node tools/fetch-matches.mjs --retention=60  已结束比赛保留 60 天（默认 30 天）
 *
 * 数据源：
 *   手工   data/manual-matches.json（始终启用，优先级最高）
 *   Liquipedia  需要 LIQUIPEDIA_API_KEY
 *   PandaScore  需要 PANDASCORE_TOKEN
 * 凭据只从环境变量读取，不要写进任何文件。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectManual } from "./adapters/manual.mjs";
import { collectLiquipedia } from "./adapters/liquipedia.mjs";
import { collectPandascore } from "./adapters/pandascore.mjs";
import {
  mergeMatches,
  validateMatches,
  readExisting,
  writeOutputs,
  summarize
} from "./lib.mjs";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  var out = {
    days: 7,
    pastDays: 3,
    pastPages: 1,
    upcomingPages: 1,
    retentionDays: 30,
    dryRun: false,
    only: null
  };
  argv.forEach(function (arg) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg.indexOf("--days=") === 0) out.days = Number(arg.slice(7));
    else if (arg.indexOf("--past-days=") === 0) out.pastDays = Number(arg.slice(12));
    else if (arg.indexOf("--past-pages=") === 0) out.pastPages = Number(arg.slice(13));
    else if (arg.indexOf("--upcoming-pages=") === 0) out.upcomingPages = Number(arg.slice(17));
    else if (arg.indexOf("--retention=") === 0) out.retentionDays = Number(arg.slice(12));
    else if (arg.indexOf("--only=") === 0) {
      out.only = arg.slice(7).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    }
  });
  return out;
}

async function main() {
  var args = parseArgs(process.argv.slice(2));
  var enabled = args.only ? new Set(args.only) : null;
  var sources = [];
  var allIncoming = [];

  console.log(
    "赛事采集器启动 · 未来 " + args.days + " 天 · 过去 " + args.pastDays + " 天 · " +
    "分页 " + args.upcomingPages + "/" + args.pastPages + " · 保留 " + args.retentionDays + " 天"
  );

  if (!enabled || enabled.has("manual")) {
    var manual = await collectManual(ROOT);
    sources.push({ name: "manual", count: manual.count, skipped: manual.skipped });
    allIncoming = allIncoming.concat(manual.matches);
  }

  if (!enabled || enabled.has("liquipedia")) {
    var liq = await collectLiquipedia({ days: args.days });
    sources.push({ name: "liquipedia", count: liq.count, skipped: liq.skipped, errors: liq.errors });
    allIncoming = allIncoming.concat(liq.matches);
  }

  if (!enabled || enabled.has("pandascore")) {
    var panda = await collectPandascore({
      days: args.days,
      pastDays: args.pastDays,
      pastPages: args.pastPages,
      upcomingPages: args.upcomingPages
    });
    sources.push({ name: "pandascore", count: panda.count, skipped: panda.skipped, errors: panda.errors });
    allIncoming = allIncoming.concat(panda.matches);
  }

  var existing = await readExisting(ROOT);
  var merged = mergeMatches(existing, allIncoming, { retentionDays: args.retentionDays });
  var errors = validateMatches(merged.matches);
  var stats = summarize(merged.matches);

  console.log("\n数据源：");
  sources.forEach(function (s) {
    var line = "  - " + s.name + "：" + s.count + " 场";
    if (s.skipped) line += "（跳过：" + s.skipped + "）";
    console.log(line);
    if (s.errors && s.errors.length) {
      s.errors.forEach(function (e) { console.log("      ! " + e); });
    }
  });

  console.log("\n合并结果：");
  console.log("  总计 " + stats.total + " 场 · 新增 " + merged.added + " · 更新 " + merged.updated + " · 清理 " + merged.pruned);
  console.log("  状态：可竞猜 " + stats.byStatus.open + " / 待赛果 " + stats.byStatus.locked + " / 已结算 " + stats.byStatus.finished);
  console.log("  项目：" + Object.keys(stats.byGame).map(function (g) {
    return g + " " + stats.byGame[g];
  }).join(" · "));

  if (errors.length) {
    console.error("\n数据校验失败：");
    errors.forEach(function (e) { console.error("  - " + e); });
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    console.log("\n[dry-run] 未写入文件");
    return;
  }

  await writeOutputs(ROOT, merged.matches);
  console.log("\n已写入 data/matches.json");
}

main().catch(function (e) {
  console.error("采集失败：" + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
