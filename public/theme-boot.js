/*
 * 主题启动脚本：在样式加载前设置 data-theme，避免深色/浅色闪烁。
 * 主题偏好以 localStorage 镜像为准（宿主存储是异步的），首次无值时跟随系统。
 * 动效档位（2026-11-12）：同理在样式加载前设置 data-fx（off/low/mid/high），
 * 首次无值时用「中」——首启选档弹窗（app.js）确认后写入镜像。
 */
(function () {
  var pref = "system";
  try {
    pref = localStorage.getItem("esports_sandbox_theme") || "system";
  } catch (e) { /* ignore */ }
  var systemLight = false;
  try {
    systemLight = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  } catch (e) { /* ignore */ }
  var theme = pref === "light" || (pref === "system" && systemLight) ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  var fx = "mid";
  try {
    var stored = localStorage.getItem("esports_sandbox_fx");
    fx = stored === "off" || stored === "low" || stored === "high" ? stored : "mid";
  } catch (e) { /* ignore */ }
  document.documentElement.setAttribute("data-fx", fx);
})();
