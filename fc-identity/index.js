/*
 * 赛事沙盘 · 身份换票函数（阿里云 FC 3.0，HTTP 触发器，匿名）
 *
 * 输入：POST/GET { code } —— 小程序 auth.login() 返回的一次性授权码
 * 输出：{ appUserId, nickname, avatar }，或 { error } + 4xx/5xx
 *
 * 凭据 USER_MINIPROGRAM_ID / USER_MINIPROGRAM_SECRET 只存在于本函数的环境变量，
 * 不进仓库、不打日志、不返回给客户端。
 * 无状态：不存数据库；同一 code 只能兑换一次（平台侧保证）。
 */
const https = require("https");

const MINIPROGRAM_ID = process.env.USER_MINIPROGRAM_ID || "";
const MINIPROGRAM_SECRET = process.env.USER_MINIPROGRAM_SECRET || "";
const OPENAPI_HOST = "api.xiaoheihe.cn";
const TOKEN_PATH = "/user_miniprogram/openapi/v1/oauth/token";
const USER_PATH = "/user_miniprogram/openapi/v1/user";

function postJson(path, headers, bodyObj) {
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify(bodyObj);
    var req = https.request({
      hostname: OPENAPI_HOST,
      path: path,
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, headers)
    }, function (res) {
      var d = "";
      res.on("data", function (c) { d += c; });
      res.on("end", function () {
        var json = null;
        try { json = JSON.parse(d); } catch (e) { /* 保留下游原文 */ }
        resolve({ status: res.statusCode, json: json, raw: d });
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, function () { req.destroy(new Error("upstream timeout")); });
    req.write(body);
    req.end();
  });
}

function getJson(path, headers) {
  return new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: OPENAPI_HOST,
      path: path,
      method: "GET",
      headers: headers
    }, function (res) {
      var d = "";
      res.on("data", function (c) { d += c; });
      res.on("end", function () {
        var json = null;
        try { json = JSON.parse(d); } catch (e) { /* 保留下游原文 */ }
        resolve({ status: res.statusCode, json: json, raw: d });
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, function () { req.destroy(new Error("upstream timeout")); });
    req.end();
  });
}

function send(res, status, obj) {
  res.setStatusCode(status);
  res.send(JSON.stringify(obj));
}

exports.handler = async function (request, response, context) {
  // CORS：宿主 network.request 无需；调试台浏览器 fetch 需要
  // Cache-Control: no-store —— 该响应走 OSS Mirror 回源时绝不落桶缓存（换票结果人各不同）
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method === "OPTIONS") {
    response.setStatusCode(204);
    response.send("");
    return;
  }

  if (!MINIPROGRAM_ID || !MINIPROGRAM_SECRET) {
    send(response, 200, { error: "server_configuration_error" }); // 回源要求 200：错误语义放 body
    return;
  }

  // 取 code：路径末段（/api/exchange/<code>，OSS 回源缓存键按路径，code 进路径保证每码各得其所）
  // 兼容 query 与 JSON body 的 code（直连调试用）
  var code = "";
  try {
    var url = String(request.url || "");
    var m = url.match(/\/([A-Za-z0-9_-]{4,256})$/);
    if (m && url.indexOf("/api/exchange") === 0) code = m[1];
    if (!code) {
      var queries = request.queries || {};
      code = queries.code || "";
    }
    if (!code) {
      var body = "";
      await new Promise(function (r) {
        request.on("data", function (c) { body += c; });
        request.on("end", r);
      });
      if (body) {
        try { code = (JSON.parse(body) || {}).code || ""; } catch (e) { /* 非 JSON 忽略 */ }
      }
    }
  } catch (e) { /* 读取失败走参数校验 */ }
  if (!code || typeof code !== "string" || code.length > 256) {
    send(response, 200, { error: "invalid_request", message: "missing code" });
    return;
  }
  // 扫描器防护：auth.login 的授权码是 URL-safe 短串。公开 OSS 桶的镜像回源（api/ 前缀）
  // 与直连地址都会被互联网扫描器持续探测——格式不符直接拒绝，不发起上游 OpenAPI 请求，
  // 把单次垃圾请求的成本从「调用+上游往返（最长 10s）」降到「调用+微秒返回」。
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) {
    send(response, 200, { error: "invalid_request", message: "invalid code format" });
    return;
  }

  try {
    // 1) code -> access token（Basic = miniprogram_id:secret）
    var basic = Buffer.from(MINIPROGRAM_ID + ":" + MINIPROGRAM_SECRET).toString("base64");
    var tokenRes = await postJson(TOKEN_PATH, { Authorization: "Basic " + basic },
      { grant_type: "authorization_code", code: code });
    if (tokenRes.status === 401 && tokenRes.json && tokenRes.json.error === "invalid_client") {
      send(response, 200, { error: "server_configuration_error" }); // 回源要求 200：错误语义放 body // 服务端凭据问题，不能让用户重试解决
      return;
    }
    if (!tokenRes.json || !tokenRes.json.access_token) {
      send(response, 200, { error: "invalid_grant", message: "code 无效、过期或已使用，请重新授权" });
      return;
    }

    // 2) token -> 用户资料
    var userRes = await getJson(USER_PATH, { Authorization: "Bearer " + tokenRes.json.access_token });
    if (!userRes.json || !userRes.json.app_user_id) {
      send(response, 200, { error: "openapi_failed" });
      return;
    }

    send(response, 200, {
      appUserId: userRes.json.app_user_id,
      nickname: userRes.json.nickname || "",
      avatar: userRes.json.avatar || "",
      scopes: tokenRes.json.scopes || []
    });
  } catch (e) {
    send(response, 200, { error: "exchange_failed", message: String((e && e.message) || "upstream error") });
  }
};
