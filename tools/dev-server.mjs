/*
 * 本地开发服务器（禁用缓存，避免改动样式/脚本后浏览器读到旧文件）
 * 用法：node tools/dev-server.mjs [端口]
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";

      const file = path.normalize(path.join(ROOT, pathname));
      const rel = path.relative(ROOT, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store, max-age=0"
      });
      res.end(data);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log("dev server (no-store): http://127.0.0.1:" + PORT);
  });
