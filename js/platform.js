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
      return;
    } catch (e) { /* 回退 localStorage */ }
  }
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch (e) { /* 忽略 */ }
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
