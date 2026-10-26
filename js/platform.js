/*
 * 平台适配层：优先使用小黑盒 hb-sdk，浏览器开发环境自动回退到 localStorage。
 * SDK 采用动态导入，避免在普通浏览器里加载宿主专用代码。
 * 身份架构（1.1.15 起）：不使用 user.getInfo 静默读取（鸿蒙宿主缺陷）；auth.login
 *   仅用于「同步黑盒资料」手势换票。账号一律基于榜单通道的隔离身份
 *   （app_user_id，见 cloud.js#realMy/registerIdentity）+ 自选/黑盒昵称。
 */
let sdk = null;
let ready = false;
let handshakePromise = null;
let readyWaiters = [];

function settleReady() {
  if (ready) return;
  ready = true;
  var waiters = readyWaiters.slice();
  readyWaiters.length = 0;
  waiters.forEach(function (fn) {
    try { fn(); } catch (e) { /* ignore */ }
  });
}

/** 等待握手真正完成；超时返回 false。晚到的 ready 仍会把 ready 置为 true。 */
export function whenPlatformReady(timeoutMs) {
  if (ready) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      resolve(false);
    }, timeoutMs || 8000);
    readyWaiters.push(function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function inHeyboxHost() {
  try {
    return window.parent !== window;
  } catch (e) {
    return true;
  }
}

export function initPlatform() {
  if (handshakePromise) return handshakePromise;
  handshakePromise = new Promise(function (resolve) {
    if (!inHeyboxHost()) {
      resolve(false);
      return;
    }
    import("@heybox/hb-sdk")
      .then(function (mod) {
        sdk = mod.default || mod.hbSDK;
        var state = sdk.getHandshakeState();
        if (state.status === "ready") {
          settleReady();
          resolve(true);
          return;
        }
        if (state.status === "failed") {
          resolve(false);
          return;
        }
        var settled = false;
        sdk.onHandshakeStateChange(function (s) {
          if (s.status === "ready") {
            settleReady();
            if (!settled) {
              settled = true;
              resolve(true);
            }
          } else if (s.status === "failed") {
            if (!settled) {
              settled = true;
              resolve(false);
            }
          }
        });
        // 只让 boot 尽快继续渲染；不取消订阅，晚到的 ready 仍要恢复 SDK 能力
        setTimeout(function () {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }, 1500);
      })
      .catch(function () {
        resolve(false);
      });
  });
  return handshakePromise;
}

export function isMiniProgram() {
  // 只要 SDK 已加载就走真实能力：SDK 内部会等待握手，不能用 1.5s 超时永久降级
  return !!sdk;
}

/** 按主题切换宿主导航栏前景：浅色页面用深色前景，深色页面用浅色前景。 */
export async function setNavigationBarStyle(theme) {
  if (!ready || !sdk || !sdk.viewport) return;
  try {
    await sdk.viewport.setNavigationBarStyle({ foregroundStyle: theme === "light" ? "dark" : "light" });
  } catch (e) { /* 旧宿主可能不支持 */ }
}

/**
 * 适配宿主顶部胶囊与手机状态栏：
 * 1. 标记 in-host，让顶栏为宿主「更多 / 退出」按钮让出右侧空间；
 * 2. 把安全区写入 CSS 变量，顶栏不再压住状态栏；
 * 3. 深色页面使用浅色导航栏前景。
 */
export async function setupViewport() {
  if (!ready || !sdk) return null;
  document.documentElement.classList.add("in-host");

  var root = document.documentElement;
  function apply(info) {
    if (!info) return;
    var safe = info.safeArea;
    if (safe && typeof safe.top === "number") {
      root.style.setProperty("--safe-top", Math.round(Math.max(0, safe.top)) + "px");
      root.style.setProperty("--safe-left", Math.round(Math.max(0, safe.left || 0)) + "px");
      root.style.setProperty("--safe-right", Math.round(Math.max(0, (info.windowWidth || 0) - safe.right)) + "px");
      root.style.setProperty("--safe-bottom", Math.round(Math.max(0, (info.windowHeight || 0) - safe.bottom)) + "px");
    } else if (typeof info.statusBarHeight === "number") {
      root.style.setProperty("--safe-top", Math.round(Math.max(0, info.statusBarHeight)) + "px");
    }
  }

  if (sdk.viewport) {
    try {
      await setNavigationBarStyle(document.documentElement.getAttribute("data-theme") || "dark");
    } catch (e) { /* 旧宿主可能不支持 */ }

    try {
      apply(await sdk.viewport.getWindowInfo());
    } catch (e) { /* 忽略测量失败，退回 env() */ }

    try {
      if (typeof sdk.on === "function") {
        sdk.on("viewport_change", function (info) { apply(info); });
      }
    } catch (e) { /* 忽略事件订阅失败 */ }
  }

  return true;
}

export function getSDK() {
  return sdk;
}

/** 当前实例运行模式：production / preview / development / unknown（旧宿主）。 */
function getEnvironmentInfo() {
  if (!ready || !sdk || !sdk.environment || typeof sdk.environment.getInfoSync !== "function") {
    return null;
  }
  try {
    return sdk.environment.getInfoSync() || null;
  } catch (e) {
    return null;
  }
}

export function getRuntimeMode() {
  var info = getEnvironmentInfo();
  return (info && info.runtime && info.runtime.mode) || "unknown";
}

/** 设置页诊断行：运行模式 / 系统 / App 版本 / 小程序版本 / SDK 版本（均为握手快照，读不到给占位）。 */
export function getDiagnostics() {
  var info = getEnvironmentInfo() || {};
  function pick(path, fallback) {
    var v = info;
    for (var i = 0; i < path.length && v; i++) v = v[path[i]];
    return (v === null || v === undefined || v === "") ? fallback : v;
  }
  return [
    pick(["runtime", "mode"], "unknown"),
    pick(["operatingSystem", "name"], "unknown"),
    "App " + pick(["host", "appVersion"], "--"),
    "版本 " + pick(["miniProgram", "version"], "--"),
    "SDK " + pick(["sdk", "version"], "--")
  ].join(" · ");
}

/** 宿主明确上报的操作系统：android / ios / ohos / windows / macos / unknown。 */
export function getOperatingSystem() {
  var info = getEnvironmentInfo();
  return (info && info.operatingSystem && info.operatingSystem.name) || "unknown";
}

/** 纯判定：宿主上报 ohos，或 WebView UA 明确是鸿蒙。 */
export function isHarmonyOSName(os, ua) {
  if (os === "ohos") return true;
  return /HarmonyOS|OpenHarmony|ArkWeb/i.test(ua || "");
}

/** 鸿蒙客户端的服务端 API 可能仍处于 local 模式，自动调用会弹原生错误框。 */
export function isHarmonyOS() {
  var ua = "";
  try {
    ua = navigator.userAgent || "";
  } catch (e) { /* 非浏览器环境 */ }
  return isHarmonyOSName(getOperatingSystem(), ua);
}

/** 仅凭 UA 同步判定鸿蒙：不需要握手，供启动最早期（任何 SDK 调用之前）使用。 */
export function isHarmonyOSUserAgent() {
  var ua = "";
  try {
    ua = navigator.userAgent || "";
  } catch (e) { /* 非浏览器环境 */ }
  return isHarmonyOSName("unknown", ua);
}

/**
 * 请求宿主关闭当前小程序容器。
 * 返回 true 只代表宿主接受了关闭请求；此后当前 JS 上下文可能已被销毁。
 */
export async function closeMiniProgram() {
  if (!sdk || !sdk.navigation || typeof sdk.navigation.close !== "function") return false;
  try {
    await sdk.navigation.close();
    return true;
  } catch (e) {
    return false;
  }
}

export async function storageGet(key) {
  if (ready && sdk && sdk.storage) {
    try {
      var r = await sdk.storage.getStorage({ key: key });
      if (r && r.data !== undefined) return r.data;
    } catch (e) { /* 回退 localStorage */ }
  }
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

export async function storageSet(key, value) {
  if (ready && sdk && sdk.storage) {
    try {
      await sdk.storage.setStorage({ key: key, data: value });
      return true;
    } catch (e) { /* 回退 localStorage */ }
  }
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

function tagNetworkError(e, fallback) {
  if (e && e.code) return e;
  var code = (e && e.errorCode) || "";
  if (!code && e && typeof e.message === "string" && e.message.indexOf("SERVER_API_REQUIRED") >= 0) {
    code = "SERVER_API_REQUIRED";
  }
  var err = new Error("network request failed");
  err.code = code || fallback;
  err.cause = e;
  return err;
}

export async function networkGetJson(url, timeoutMs) {
  // 本地联调（http://127.0.0.1 或局域网 IP）走浏览器 fetch；
  // 生产必须是 HTTPS，走宿主 network.request。
  if (url.indexOf("http://") === 0) {
    try {
      var r = await fetch(url, { cache: "no-store" });
      if (!r.ok) {
        var httpErr = new Error("HTTP " + r.status);
        httpErr.code = "HTTP_" + r.status;
        throw httpErr;
      }
      return await r.json();
    } catch (e) {
      throw tagNetworkError(e, "REQUEST_FAILED");
    }
  }

  if (sdk && sdk.network) {
    try {
      var res = await sdk.network.request({
        url: url,
        method: "GET",
        timeout: timeoutMs || 10000
      });
      var data = res && res.data;
      if (typeof data === "string") {
        try {
          return JSON.parse(data);
        } catch (e) {
          var jsonErr = new Error("invalid json");
          jsonErr.code = "INVALID_JSON";
          throw jsonErr;
        }
      }
      return data || null;
    } catch (e) {
      throw tagNetworkError(e, "REQUEST_FAILED");
    }
  }

  try {
    var r2 = await fetch(url, { cache: "no-store" });
    if (!r2.ok) {
      var httpErr2 = new Error("HTTP " + r2.status);
      httpErr2.code = "HTTP_" + r2.status;
      throw httpErr2;
    }
    return await r2.json();
  } catch (e) {
    throw tagNetworkError(e, "REQUEST_FAILED");
  }
}

/* ============================== 宿主体验能力（均免权限声明，失败静默降级） ============================== */

/** 订阅宿主事件（show / hide / heybox_app_login_change / viewport_change…）；返回取消订阅函数。 */
export function onHostEvent(name, handler) {
  if (!sdk || typeof sdk.on !== "function") return function () {};
  try {
    return sdk.on(name, handler) || function () {};
  } catch (e) {
    return function () {};
  }
}

/** 触觉反馈：移动端生效；桌面 Host（METHOD_FORBIDDEN）与旧宿主静默忽略。 */
export async function vibrate(intensity) {
  if (!sdk || !sdk.device || typeof sdk.device.vibrate !== "function") return false;
  try {
    await sdk.device.vibrate({ intensity: intensity === "heavy" ? "heavy" : intensity === "medium" ? "medium" : "light" });
    return true;
  } catch (e) {
    return false;
  }
}

/** 宿主原生写系统剪贴板（需声明 clipboard 权限）；不适用浏览器 navigator 的手势/安全域限制。 */
export async function setClipboard(text) {
  if (!sdk || !sdk.device || typeof sdk.device.setClipboard !== "function") return false;
  try {
    await sdk.device.setClipboard({ text: text });
    return true;
  } catch (e) {
    return false;
  }
}

/** 宿主重载当前容器（白屏自救）；宿主未实现 reload 原语时回退 location.reload。 */
export async function reloadPage() {
  if (!sdk || !sdk.navigation || typeof sdk.navigation.reload !== "function") {
    location.reload();
    return;
  }
  try {
    await sdk.navigation.reload();
  } catch (e) {
    location.reload();
  }
}

export async function uiShowLoading() {
  if (!sdk || !sdk.ui || typeof sdk.ui.showLoading !== "function") return false;
  try {
    await sdk.ui.showLoading({});
    return true;
  } catch (e) {
    return false;
  }
}

export async function uiHideLoading() {
  if (!sdk || !sdk.ui || typeof sdk.ui.hideLoading !== "function") return false;
  try {
    await sdk.ui.hideLoading();
    return true;
  } catch (e) {
    return false;
  }
}

/* ============================== 官方分享（需声明 share，已启用） ============================== */

/**
 * 打开官方分享面板（post.topics 预置社区话题，用户仍可修改）。
 * 返回 null = 面板已打开（结果不透明，不能据返回值判断是否发布）；字符串 = 错误码。
 * 新 PC Host 未开放（METHOD_FORBIDDEN），由调用方降级提示。
 */
export async function showShareMenu(options) {
  if (!sdk || !sdk.share || typeof sdk.share.showShareMenu !== "function") return "UNSUPPORTED";
  try {
    await sdk.share.showShareMenu(options);
    return null;
  } catch (e) {
    return (e && e.code) || "FAILED";
  }
}

/**
 * 复制小程序通用分享链接到系统剪贴板（extra 随链接携带，接收方用 getLaunchExtra 读取）。
 * 返回 null = 已复制；字符串 = 错误码。
 */
export async function copyShareLink(extra) {
  if (!sdk || !sdk.share || typeof sdk.share.copyLink !== "function") return "UNSUPPORTED";
  try {
    await sdk.share.copyLink({ extra: extra });
    return null;
  } catch (e) {
    return (e && e.code) || "FAILED";
  }
}

/**
 * 宿主截图分享：截取指定区域并唤起系统分享/保存流程（saveToAlbum 提供相册入口）。
 * options: { rect?: {x,y,width,height}（窗口逻辑像素）, saveToAlbum?, watermarkTheme?, post?, delay? }。
 * SDK ≥0.9.1 默认叠加官方水印，截图区域底部需预留 ≥57 逻辑像素空白。
 * 返回 null = 流程已唤起（结果不透明，不能据返回值判断是否保存）；字符串 = 错误码。
 */
export async function shareScreenshot(options) {
  if (!sdk || !sdk.share || typeof sdk.share.screenshot !== "function") return "UNSUPPORTED";
  try {
    await sdk.share.screenshot(options || {});
    return null;
  } catch (e) {
    return (e && e.code) || "FAILED";
  }
}

/** 启动链接携带的 extra（同步、免权限、不依赖握手）；无有效数据返回 undefined。 */
export function getLaunchExtra() {
  if (!sdk || !sdk.share || typeof sdk.share.getExtra !== "function") return undefined;
  try {
    return sdk.share.getExtra();
  } catch (e) {
    return undefined;
  }
}

/**
 * 触发宿主授权登录（auth.login，必须来自可信用户手势）。
 * 1.1.17 起用于身份换票：申请 profile scope 拿一次性 code，
 * 由调用方 POST 到换票端点（js/config.js#IDENTITY_EXCHANGE_URL）换取昵称头像。
 * 返回 null = 已拿到 code（result.code）；字符串 = 错误码。
 */
export async function authLogin() {
  if (!sdk || !sdk.auth || typeof sdk.auth.login !== "function") return { error: "UNSUPPORTED" };
  try {
    var r = await sdk.auth.login({ scopes: ["profile"] });
    if (r && r.code) return { code: r.code };
    return { error: "NO_CODE" };
  } catch (e) {
    return { error: (e && e.code) || "FAILED" };
  }
}

