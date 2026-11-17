// Connection screen: shows which server the app uses and opens it again on Retry (and every 15 s).
(function () {
  var cfg = window.CITY_CART_APP || {};
  var url = cfg.serverUrl || "";
  var server = document.getElementById("server");
  var status = document.getElementById("status");
  var hint = document.getElementById("hint");
  var retry = document.getElementById("retry");
  server.textContent = url ? url + (cfg.environment ? "  (" + cfg.environment + ")" : "") : "No server address configured";
  if (cfg.development) {
    hint.textContent =
      cfg.environment === "device"
        ? "Development: start the backend on your Mac, keep the phone on the same Wi-Fi, and allow incoming connections for Node if macOS asks."
        : "Development: start the backend on your Mac (npm run dev in the project folder).";
  }
  function open() {
    if (!url) return;
    retry.disabled = true;
    status.textContent = "Connecting…";
    // Navigating is allowed across schemes; if the server is still down, this screen comes back
    location.replace(url + "/dashboard");
  }
  retry.addEventListener("click", open);
  if (/index\.html$|\/$/.test(location.pathname) && !/offline/.test(location.pathname)) open();
  else setInterval(function () { if (navigator.onLine !== false) open(); }, 15000);
})();
