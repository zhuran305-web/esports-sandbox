/*
 * Pick'Em 配置助手（2026-11-08）：降低战绩桶（records）的接入摩擦
 *
 * 回答「新联赛必须逐场手动配置吗」：不需要——records 按赛事一段配置（tournament 串 +
 * stageNames + 桶结构），该赛事全部场次自动流入；本工具把「写这段配置」压缩成一条命令：
 *
 *   ① 扫描：node tools/pickem-config-helper.mjs
 *      列出全部 tier=s/a 赛事的阶段形态，识别「4 队 × 5 场 = GSL 双败」「8 队 × 12 场
 *      = 8 队双败」等可配置战绩桶的形状（循环赛如 4 队×6 场 / 8 队×21 场不适用，明确排除）。
 *   ② 生成：node tools/pickem-config-helper.mjs --emit "<赛事串原文>"
 *      按实测阶段名生成 records 配置块（GSL 模板桶）并合入 data/pickem-events.json
 *      （已存在的事件跳过；playoffs 形态的舞台自动生成 placement 骨架，qualifiedTeams
 *      留空待小组出结果后补）。
 *
 * 桶结构模板（可改）：
 *   4 队 GSL（5 场）：2:0/2:1/1:2/0:2 各 1        （IEM、VCT、BLAST Slam 小组）
 *   4 队 4进3（4 场）：2:0×1 / 1:1×2 / 0:2×1      （BLAST Rivals 香港站实测：每队只打两场，
 *                                                  两连胜进四强、一胜一负进六强、两连败出局）
 *   8 队双败（12 场）：3:0/3:1/2:1/2:2/1:2×2/0:2×2 （IEM 北京 8 队组实测）
 * 风险边界：形态按「队数×场次」推断——特殊赛制（循环、瑞士轮混编、三局种子赛）会被
 * 明确标记「形态未知」而不是硬套模板；生成后仍需人工确认桶结构是否符合官方赛制。
 * **时点限制**：4 队 4进3 与 4 队 GSL 在「小组开赛前」数据侧只有首轮 2 场带真实队名
 * （TBD 场次被采集器过滤），两者不可区分——4进3 的自动识别要在首轮打完后（场次齐）才命中，
 * 因此预测期接入 4进3 赛事需**手工写 buckets**（照上面模板），或赛后核对时用本工具识别。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

function log(message) { console.log("[cfg] " + message); }

var emitTarget = null;
var ei = process.argv.indexOf("--emit");
if (ei >= 0) emitTarget = process.argv[ei + 1];

var m = JSON.parse(readFileSync(new URL("../data/matches.json", import.meta.url), "utf8"));
var now = Date.now();

/* ---------- 扫描 S/A 赛事的阶段形态 ---------- */
var byT = new Map();
(m.matches || []).forEach(function (x) {
  if (x.tier !== "s" && x.tier !== "a") return;
  var t = Date.parse(x.startAt || "");
  if (isNaN(t)) return;
  if (!byT.has(x.tournament)) {
    byT.set(x.tournament, { game: x.game, tier: x.tier, stages: new Map(), first: t, last: t });
  }
  var g = byT.get(x.tournament);
  var sn = x.stage || "?";
  if (!g.stages.has(sn)) g.stages.set(sn, { teams: new Set(), n: 0, done: 0, future: 0 });
  var st = g.stages.get(sn);
  st.n += 1;
  if (x.teamA && x.teamA.name) st.teams.add(x.teamA.name);
  if (x.teamB && x.teamB.name) st.teams.add(x.teamB.name);
  if (x.result && x.result.winner) st.done += 1;
  if (t > now) st.future += 1;
  if (t < g.first) g.first = t;
  if (t > g.last) g.last = t;
});

/* ---------- 形态识别 ---------- */
function stageShape(st) {
  var n = st.teams.size, matches = st.n;
  if (n === 4 && matches === 5) return { kind: "gsl4", buckets: [
    { k: "2:0", label: "2:0 出线", cap: 1 }, { k: "2:1", label: "2:1 出线", cap: 1 },
    { k: "1:2", label: "1:2 淘汰", cap: 1 }, { k: "0:2", label: "0:2 淘汰", cap: 1 }
  ] };
  // 「4 进 3」（BLAST Rivals 式，2026-11-09 香港站实测）：4 队各打 2 场，两连胜进四强、
  // 一胜一负进六强、两连败出局 → 战绩分布 2:0×1 / 1:1×2 / 0:2×1（4 场，无第 5 场决定赛）
  if (n === 4 && matches === 4) return { kind: "gsl43", buckets: [
    { k: "2:0", label: "2:0 直进四强", cap: 1 },
    { k: "1:1", label: "1:1 进六强", cap: 2 },
    { k: "0:2", label: "0:2 淘汰", cap: 1 }
  ] };
  if (n === 8 && matches === 12) return { kind: "de8", buckets: [
    { k: "3:0", label: "3:0", cap: 1 }, { k: "3:1", label: "3:1", cap: 1 },
    { k: "2:1", label: "2:1", cap: 1 }, { k: "2:2", label: "2:2", cap: 1 },
    { k: "1:2", label: "1:2 淘汰", cap: 2 }, { k: "0:2", label: "0:2 淘汰", cap: 2 }
  ] };
  return { kind: "unknown", buckets: null };
}
function isPlayoffStageName(sn) {
  return /play ?-?off|knock ?out|quarter|semi|final|淘汰|bracket/i.test(sn);
}

var candidates = [];
byT.forEach(function (g, tn) {
  var gslStages = [];
  var playoffStage = null;
  var unknownStages = [];
  g.stages.forEach(function (st, sn) {
    if (isPlayoffStageName(sn)) { if (!playoffStage) playoffStage = sn; return; }
    var shape = stageShape(st);
    if (shape.kind === "gsl4" || shape.kind === "gsl43" || shape.kind === "de8") gslStages.push({ sn: sn, shape: shape });
    else unknownStages.push(sn + "（" + st.teams.size + " 队 × " + st.n + " 场）");
  });
  if (!gslStages.length && !playoffStage) return; // 无可配置形态
  candidates.push({
    tournament: tn, game: g.game, tier: g.tier,
    first: new Date(g.first).toISOString().slice(0, 10),
    last: new Date(g.last).toISOString().slice(0, 10),
    finished: g.last < now,
    gslStages: gslStages, playoffStage: playoffStage, unknownStages: unknownStages
  });
});

/* ---------- 输出 ---------- */
if (!emitTarget) {
  log("tier=s/a 赛事中可配置战绩桶的候选（" + candidates.length + " 个）：");
  candidates.forEach(function (c) {
    var state = c.finished ? "已完赛（配置无预测价值）" : "可配置";
    log("• " + c.tournament + " [" + c.tier + "/" + c.game + "] " + c.first + " → " + c.last + " · " + state);
    c.gslStages.forEach(function (s) { log("    records 候选: " + s.sn + "（" + (s.shape.kind === "gsl4" ? "4 队 GSL（5 场）" : s.shape.kind === "gsl43" ? "4 队 4进3（每队两场）" : "8 队双败") + "）"); });
    if (c.playoffStage) log("    placement 候选: " + c.playoffStage);
    if (c.unknownStages.length) log("    形态未知（不自动配桶）: " + c.unknownStages.join(", "));
  });
  log("生成配置：node tools/pickem-config-helper.mjs --emit \"<赛事串原文>\"");
  process.exit(0);
}

/* ---------- --emit：生成并合入配置 ---------- */
var c = candidates.find(function (x) { return x.tournament === emitTarget; });
if (!c) { log("✗ 未找到该赛事（或无可配置形态）：先用扫描模式核对赛事串原文"); process.exit(1); }
if (c.finished) log("⚠ 该赛事已完赛——配置不会产生可预测阶段，确认是否有意");

var cfgPath = new URL("../data/pickem-events.json", import.meta.url);
var cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
cfg.events = cfg.events || [];
if (cfg.events.some(function (e) { return e.tournament === emitTarget; })) {
  log("该赛事已配置，跳过（如需重配请手工改）");
  process.exit(0);
}
var slug = emitTarget.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
var stages = c.gslStages.map(function (s, i) {
  return { id: (i ? "groupB" + (i > 1 ? i : "") : "groupA"), type: "records", label: s.sn + " · 双败战绩",
    stageNames: [s.sn], coinTier: c.tier === "a" ? 1 : 2, buckets: s.shape.buckets };
});
if (c.playoffStage) {
  stages.push({ id: "playoffs", type: "placement", label: "淘汰赛", stageNames: [c.playoffStage],
    // expectTeams/qualifiedTeams 待实际对阵/名单确定后补（双败头名直进半决赛不播种名单不齐，IEM 教训）
    qualifiedTeams: [] });
}
var slugId = "pk-" + (slug || c.game + "-" + c.last.replace(/-/g, ""));
if (cfg.events.some(function (e) { return e.id === slugId; })) slugId = slugId + "-" + c.first.replace(/-/g, "");
cfg.events.push({ id: slugId, game: c.game, name: emitTarget + " · 作业", tournament: emitTarget, stages: stages });
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
log("✓ 已合入 data/pickem-events.json（事件 id=" + slugId + "，" + stages.length + " 阶段）");
log("下一步：本地跑 node tools/fetch-pickem.mjs 验证聚合，然后随版本/数据发布链发布（先 commit）");
