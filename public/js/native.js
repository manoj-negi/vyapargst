/*
 * Native behaviour for the Android/iOS app (mobile-app/). The layout loads this file only inside the
 * app, after /js/vendor/capacitor-bridge.js; on the website it is never loaded, so nothing here
 * changes the browser experience.
 *
 * - PDF and CSV downloads (invoice PDF, report / statement exports): a WebView cannot save
 *   "attachment" responses, so the file is fetched with the signed-in session, written to the app's
 *   cache folder and handed to the system share sheet (save to Files, WhatsApp, email, print...).
 * - Print: there is no print dialog in a WebView; Print and "Save & print" share the PDF instead.
 * - Android Back: closes the open dialog, menu or drawer first, then goes back a page (the
 *   unsaved-changes guard in app.js asks before leaving a changed form), and on the dashboard
 *   sends the app to the background.
 * - Links to other sites open in the in-app browser instead of replacing the app.
 * - On-screen keyboard: bottom bars step aside and the field being typed in stays visible.
 */
(function () {
  "use strict";
  var N = window.CityCartNative;
  var Cap = N && N.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  var P = N.plugins;
  var root = document.documentElement;
  function noop() {}

  root.classList.add("native-app", "native-" + Cap.getPlatform());
  P.SplashScreen.hide().catch(noop);
  P.SystemBars.setStyle({ style: "LIGHT" }).catch(noop); // dark icons on the light top bar

  function alertError(title, message) {
    if (window.AppDialog) window.AppDialog.alert({ title: title, message: message });
  }
  function toast(message, type) {
    if (typeof window.showToast === "function") window.showToast(message, type || "info");
  }

  /* ---------- Downloads → share sheet ---------- */
  function isDownload(a) {
    if (!a || !a.href || a.origin !== location.origin) return false;
    return /\/pdf$/.test(a.pathname) || /[?&]format=(pdf|csv)(&|$)/.test(a.search);
  }
  function fileNameFrom(res, url) {
    var cd = res.headers.get("Content-Disposition") || "";
    var m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    var name = m ? decodeURIComponent(m[1]) : (/format=csv/.test(url) ? "export.csv" : "document.pdf");
    return name.replace(/[^\w.\-]+/g, "_");
  }
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(",")[1] || ""); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }
  var sharing = false;
  async function shareDownload(url) {
    if (sharing) return; // one at a time; a second tap while preparing is ignored
    sharing = true;
    toast("Preparing the file…");
    try {
      var res;
      try {
        res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      } catch (netErr) {
        if (window.AppConnection) window.AppConnection.lost();
        throw new Error("No connection to the server. Check the connection and try again.");
      }
      if (res.redirected && /\/login(\?|$)/.test(new URL(res.url).pathname + new URL(res.url).search)) {
        throw new Error("Your session has ended. Please sign in again.");
      }
      if (!res.ok) throw new Error(res.status === 404 ? "This document was not found." : "The file could not be created (error " + res.status + "). Please try again.");
      var name = fileNameFrom(res, url);
      var data = await toBase64(await res.blob());
      var written = await P.Filesystem.writeFile({ path: "exports/" + name, data: data, directory: "CACHE", recursive: true });
      try {
        await P.Share.share({ title: name, url: written.uri, dialogTitle: "Share " + name });
      } catch (shareErr) {
        if (/cancel/i.test((shareErr && shareErr.message) || "")) return; // the user closed the share sheet
        throw shareErr;
      }
    } catch (err) {
      alertError("Could not share the file", (err && err.message) || "Something went wrong. Please try again.");
    } finally {
      sharing = false;
    }
  }

  document.addEventListener(
    "click",
    function (e) {
      var a = e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      if (isDownload(a)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        shareDownload(a.href);
        return;
      }
      // Other websites open in the in-app browser, never inside the app's own view
      if (a.origin !== location.origin && /^https?:$/.test(a.protocol)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        P.Browser.open({ url: a.href }).catch(noop);
      }
    },
    true
  );
  var nativeOpen = window.open;
  window.open = function (url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin !== location.origin) { P.Browser.open({ url: u.href }).catch(noop); return null; }
    } catch (e) {}
    return nativeOpen.apply(window, arguments);
  };

  /* ---------- Print → share the PDF of what is on screen ---------- */
  window.print = function () {
    var own = document.querySelector('a[href="' + location.pathname + '/pdf"]');
    var pdf = own || document.querySelector('a[href*="format=pdf"]');
    if (pdf) { shareDownload(pdf.href); return; }
    alertError("Printing", "Printing is not available inside the app. Open the PDF and print it from the share sheet.");
  };

  /* ---------- Android Back ---------- */
  P.App.addListener("backButton", function (ev) {
    var modal = document.querySelector(".modal.show");
    if (modal && window.bootstrap) {
      var m = window.bootstrap.Modal.getInstance(modal);
      if (m) m.hide(); // the shared dialog treats this as Cancel (and ignores it while saving)
      return;
    }
    var shell = document.getElementById("appShell");
    if (shell && shell.classList.contains("mobile-open")) { shell.classList.remove("mobile-open"); return; }
    var dd = document.querySelector('[data-bs-toggle="dropdown"].show');
    if (dd && window.bootstrap) { window.bootstrap.Dropdown.getOrCreateInstance(dd).hide(); return; }
    var menu = document.querySelector(".autocomplete-menu:not(:empty)");
    if (menu) { menu.innerHTML = ""; return; }
    if (ev && ev.canGoBack) { history.back(); return; } // a changed form asks first (app.js)
    if (!/^\/(dashboard)?$/.test(location.pathname)) {
      if (window.AppNav) window.AppNav.go("/dashboard"); else location.href = "/dashboard";
      return;
    }
    P.App.minimizeApp().catch(noop);
  }).catch(noop);

  /* ---------- On-screen keyboard ---------- */
  P.Keyboard.addListener("keyboardWillShow", function () { root.classList.add("keyboard-open"); }).catch(noop);
  P.Keyboard.addListener("keyboardDidShow", function () {
    var el = document.activeElement;
    if (el && el.scrollIntoView && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }).catch(noop);
  P.Keyboard.addListener("keyboardWillHide", function () { root.classList.remove("keyboard-open"); }).catch(noop);

  /* ---------- Back in the foreground: notice a dropped connection ---------- */
  P.App.addListener("appStateChange", function (state) {
    if (!state || !state.isActive) return;
    fetch("/healthz", { cache: "no-store" }).catch(function () { if (window.AppConnection) window.AppConnection.lost(); });
  }).catch(noop);
})();
