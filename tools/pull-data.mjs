#!/usr/bin/env node
/*
 * 赛事数据同步：从 GitHub Release 资产下载最新 data/matches.json。
 * ------------------------------------------------------------
 * 数据快照不进 Git 历史，由 .github/workflows 采集后覆盖上传到 Release 资产。
 * 用法：
 *   node tools/pull-data.mjs              文件不存在时下载（默认）
 *   node tools/pull-data.mjs --if-missing 同上，供 predev / prebuild 使用
 *   node tools/pull-data.mjs --force      强制下载
 *   node tools/pull-data.mjs --print-url  只打印解析出的地址
 *
 * 地址优先级：MATCH_DATA_URL > package.json#repository > git remote origin。
 * 下载失败时若本地已有快照，会保留旧文件并继续；没有快照则报错退出。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var TARGET = path.join(ROOT, "data", "matches.json");
var TMP = TARGET + ".tmp";

function parseRepo(value) {
  if (!value) return null;
  var s = String(value).trim();
  if (s.indexOf("github:") === 0) s = s.slice(7);
  var m = s.match(/github\.com[:\/]([^\/]+)\/([^\/]+?)(?:\.git)?$/i);
  if (m) return m[1] + "/" + m[2];
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s;
  return null;
}

async function repoFromPackage() {
  try {
    var pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    var repo = pkg.repository;
    if (repo && typeof repo === "object") repo = repo.url;
    return parseRepo(repo);
  } catch (e) {
    return null;
  }
}

function repoFromGit() {
  try {
    var remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return parseRepo(remote);
  } catch (e) {
    return null;
  }
}

async function resolveUrl() {
  if (process.env.MATCH_DATA_URL) return process.env.MATCH_DATA_URL;
  var repo = (await repoFromPackage()) || repoFromGit();
  if (!repo) return null;
  return "https://github.com/" + repo + "/releases/download/data/matches.json";
}

async function fetchToTmp(url) {
  var res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "esports-sandbox-data-pull" },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  await writeFile(TMP, await res.text(), "utf8");
}

function curlToTmp(url) {
  execFileSync("curl", [
    "-fsSL",
    "--retry", "2",
    "--connect-timeout", "15",
    "--max-time", "120",
    "-o", TMP,
    url
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

async function download(url) {
  await mkdir(path.dirname(TARGET), { recursive: true });
  try {
    await fetchToTmp(url);
  } catch (fetchError) {
    try {
      curlToTmp(url);
    } catch (curlError) {
      throw new Error(
        "fetch: " + (fetchError.message || fetchError) +
        "; curl: " + (curlError.message || curlError)
      );
    }
  }

  try {
    var text = await readFile(TMP, "utf8");
    var data = JSON.parse(text);
    if (!data || !Array.isArray(data.matches) || !data.matches.length) {
      throw new Error("响应不是有效的赛事数据");
    }
    await rename(TMP, TARGET);
    return data;
  } catch (e) {
    await rm(TMP, { force: true });
    throw e;
  }
}

async function main() {
  var args = process.argv.slice(2);
  var force = args.indexOf("--force") !== -1;
  var printUrl = args.indexOf("--print-url") !== -1;
  var url = await resolveUrl();

  if (printUrl) {
    console.log(url || "(未配置数据地址)");
    process.exitCode = url ? 0 : 1;
    return;
  }

  var hasFile = existsSync(TARGET);
  if (hasFile && !force) {
    console.log("[data] 已存在 data/matches.json，跳过下载（--force 可强制更新）");
    return;
  }

  if (!url) {
    console.error("[data] 未找到数据地址。请任选一种方式配置：");
    console.error("  1. 在 package.json 添加 \"repository\": \"github:OWNER/REPO\"");
    console.error("  2. 设置环境变量 MATCH_DATA_URL=https://github.com/OWNER/REPO/releases/download/data/matches.json");
    console.error("  3. 在项目里配置 git remote origin 后重试");
    process.exitCode = 1;
    return;
  }

  try {
    var data = await download(url);
    console.log("[data] 已更新 " + data.matches.length + " 场 · updatedAt " + (data.updatedAt || "未知"));
  } catch (e) {
    var message = e && e.message ? e.message : String(e);
    if (hasFile) {
      console.warn("[data] 下载失败（" + message + "），继续使用本地缓存");
      return;
    }
    console.error("[data] 下载失败：" + message);
    process.exitCode = 1;
  }
}

main();
