/*
 * 平台适配层：优先使用小黑盒 hb-sdk，浏览器开发环境自动回退到 localStorage。
 * SDK 采用动态导入，避免在普通浏览器里加载宿主专用代码。
 */
let sdk = null;
let ready = false;
let handshakePromise = null;

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
          ready = true;
          resolve(true);
          return;
        }
        if (state.status === "failed") {
          resolve(false);
          return;
        }
        var stop = sdk.onHandshakeStateChange(function (s) {
          if (s.status === "ready") {
            ready = true;
            stop();
            resolve(true);
          } else if (s.status === "failed") {
            stop();
            resolve(false);
          }
        });
        setTimeout(function () {
          if (!ready) {
            try { stop(); } catch (e) { /* ignore */ }
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
  return ready;
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

export async function networkGetJson(url, timeoutMs) {
  // 本地联调（http://127.0.0.1 或局域网 IP）走浏览器 fetch；
  // 生产必须是 HTTPS，走宿主 network.request。
  if (url.indexOf("http://") === 0) {
    try {
      var r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  if (ready && sdk && sdk.network) {
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
          return null;
        }
      }
      return data || null;
    } catch (e) {
      return null;
    }
  }

  try {
    var r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

export async function getUserProfile() {
  if (!ready || !sdk || !sdk.user) return null;
  try {
    var r = await sdk.user.getInfo();
    if (!r || !r.isHeyboxAppLoggedIn || !r.userInfo) return null;
    var info = r.userInfo;
    var profile = info.profile || {};
    return {
      uid: info.app_user_id || "",
      nick: profile.nickname || "",
      avatar: profile.avatar || ""
    };
  } catch (e) {
    return null;
  }
}
