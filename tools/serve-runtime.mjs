#!/usr/bin/env node
/*
 * 本地运行时数据服务器（联调用）
 * 用法：node tools/serve-runtime.mjs [端口]
 * 默认 5180，绑定 0.0.0.0，允许局域网真机访问。
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");
var PORT = Number(process.argv[2] || process.env.PORT || 5180);

http.createServer(async function (req, res) {
  var url = new URL(req.url || "/", "http://localhost");
  var name = url.pathname.replace(/^\/+/, "");

  if (!name || name.indexOf("..") !== -1 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  try {
    var body = await readFile(path.join(ROOT, name));
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}).listen(PORT, "0.0.0.0", function () {
  console.log("[runtime] http://127.0.0.1:" + PORT + "/  （真机用本机局域网 IP）");
});
