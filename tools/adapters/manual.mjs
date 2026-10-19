/*
 * 手工赛程适配器
 * 读取 data/manual-matches.json，用于补充数据源未覆盖的赛事，
 * 或人工修正自动采集的错误信息。手工数据优先级最高，且不会被历史清理。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function collectManual(root) {
  var file = path.join(root, "data/manual-matches.json");
  try {
    var raw = JSON.parse(await readFile(file, "utf8"));
    var list = Array.isArray(raw) ? raw : raw.matches || [];
    return {
      matches: list.map(function (m) {
        return Object.assign({}, m, { source: "manual" });
      }),
      count: list.length
    };
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { matches: [], count: 0, skipped: "data/manual-matches.json 不存在" };
    }
    throw e;
  }
}
