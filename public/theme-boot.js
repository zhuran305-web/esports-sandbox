/*
 * 主题启动脚本：在样式加载前设置 data-theme，避免深色/浅色闪烁。
 * 主题偏好以 localStorage 镜像为准（宿主存储是异步的），首次无值时跟随系统。
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
})();
