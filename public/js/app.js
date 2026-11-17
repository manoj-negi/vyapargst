/* Shared page behaviour. Everything is opt-in through data attributes so pages without them are unaffected. */
(function () {
  "use strict";
  var root = document.documentElement;
  var shell = document.getElementById("appShell");

  function store(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      sessionStorage.setItem(key, value);
    } catch (e) { return null; }
  }

  /* ---------- Sidebar: desktop collapse (remembered) and mobile drawer ---------- */
  var toggle = document.getElementById("sidebarToggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var collapsed = root.classList.toggle("sb-collapsed");
      toggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
      try { localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0"); } catch (e) {}
    });
  }
  var mobileBtn = document.getElementById("mobileMenuToggle");
  if (mobileBtn && shell) {
    mobileBtn.addEventListener("click", function () { shell.classList.toggle("mobile-open"); });
    shell.addEventListener("click", function (e) {
      // Tapping the dimmed area (the shell's ::after overlay) closes the drawer
      if (shell.classList.contains("mobile-open") && e.target === shell) shell.classList.remove("mobile-open");
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") shell.classList.remove("mobile-open"); });
  }
  // Bottom navigation "More" (phones) opens the same drawer
  document.querySelectorAll("[data-open-drawer]").forEach(function (btn) {
    btn.addEventListener("click", function () { if (shell) shell.classList.add("mobile-open"); });
  });

  /* ---------- Phones: list tables become cards (CSS); each cell carries its column heading ---------- */
  function labelCells(table) {
    var heads = Array.prototype.map.call(table.querySelectorAll("thead th"), function (th) { return th.textContent.trim(); });
    // The column with the document number / name leads the card; the actions column goes last
    var titleCol = heads.findIndex(function (h) { return /^(number|item|name|customer|supplier|party|voucher|expense)$/i.test(h); });
    Array.prototype.forEach.call(table.tBodies[0] ? table.tBodies[0].rows : [], function (tr) {
      if (tr.hasAttribute("data-static")) return;
      Array.prototype.forEach.call(tr.cells, function (td, i) {
        td.setAttribute("data-label", heads[i] || "");
        td.classList.toggle("card-title", i === titleCol);
        td.classList.toggle("card-actions", !heads[i] || /^actions$/i.test(heads[i]) || !!td.querySelector(".row-actions"));
      });
    });
  }
  document.querySelectorAll("table.table-app[data-sortable]").forEach(function (table) {
    if (table.closest('[data-list-key^="/reports/"]')) return; // reports keep their columns (they scroll sideways)
    table.classList.add("table-cards");
    labelCells(table);
    table.addEventListener("rows:changed", function () { labelCells(table); });
  });

  /* ---------- Phones: list filters fold behind a "Filters (n)" button; search stays in view ---------- */
  document.querySelectorAll("form.filter-bar").forEach(function (bar) {
    var fields = Array.prototype.slice.call(bar.querySelectorAll(":scope > .f:not(.f-search)"));
    if (!fields.length) return;
    var active = fields.filter(function (f) {
      var el = f.querySelector("select, input");
      return el && el.value && !(el.tagName === "SELECT" && el.selectedIndex === 0);
    }).length;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm btn-outline-secondary filter-toggle";
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<i class="icon-sliders-horizontal" aria-hidden="true"></i> Filters' + (active ? ' <span class="badge text-bg-primary">' + active + "</span>" : "");
    var search = bar.querySelector(":scope > .f-search");
    if (search) search.after(btn); else bar.prepend(btn);
    bar.classList.add("has-filter-toggle");
    btn.addEventListener("click", function () {
      var open = bar.classList.toggle("filters-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });

  /* ---------- Connection lost: a banner with Retry instead of silent failures (website and app) ---------- */
  function connectionBanner(show) {
    var bar = document.getElementById("connectionBanner");
    if (!show) { if (bar) bar.remove(); return; }
    if (bar) return;
    bar = document.createElement("div");
    bar.id = "connectionBanner";
    bar.className = "connection-banner no-print";
    bar.setAttribute("role", "alert");
    bar.innerHTML = '<i class="icon-wifi-off" aria-hidden="true"></i><span>No connection to the server. Changes cannot be saved until it is back.</span><button type="button" class="btn btn-sm btn-light">Retry</button>';
    bar.querySelector("button").addEventListener("click", function () {
      fetch("/healthz", { cache: "no-store" }).then(function (r) { if (r.ok) location.reload(); }).catch(function () {});
    });
    document.body.appendChild(bar);
  }
  window.addEventListener("offline", function () { connectionBanner(true); });
  window.addEventListener("online", function () { connectionBanner(false); });
  if (navigator.onLine === false) connectionBanner(true);
  window.AppConnection = { lost: function () { connectionBanner(true); } };

  /* ---------- On-screen keyboard: bottom bars step aside so they never cover the field being typed in ---------- */
  if (window.visualViewport) {
    var setKeyboard = function () {
      var typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      root.classList.toggle("keyboard-open", !!typing && window.visualViewport.height < window.innerHeight * 0.78);
    };
    window.visualViewport.addEventListener("resize", setKeyboard);
    document.addEventListener("focusout", function () { setTimeout(setKeyboard, 50); });
  }

  /* ---------- Unsaved changes: <form data-dirty-guard> ----------
     A form is "dirty" only when its values differ from what the page loaded with (or when the
     server re-rendered it after a failed save, so the typed values are not stored yet).
     Internal links, other forms, shortcuts and Back/Forward ask through the in-app dialog;
     refresh, closing the tab and leaving the site keep the browser's own warning. */
  var guarded = Array.prototype.slice.call(document.querySelectorAll("form[data-dirty-guard]"));
  var serverRejected = !!document.querySelector("[data-form-errors]");

  function snapshot(form) {
    var parts = [];
    new FormData(form).forEach(function (value, key) {
      if (key === "clientToken") return;
      parts.push(key + "=" + (value instanceof File ? value.name + ":" + value.size : value));
    });
    return parts.join("&");
  }
  guarded.forEach(function (form) {
    form._initialState = snapshot(form);
  });
  // A failed save re-renders the form with the typed values, which are still not saved
  if (serverRejected) guarded.forEach(function (form) { form._unsavedFromServer = true; });

  var leaving = false; // set once a save or an approved navigation is under way
  function isDirty(form) {
    return !leaving && (form._unsavedFromServer || snapshot(form) !== form._initialState);
  }
  function anyDirty() { return guarded.some(isDirty); }
  function allowLeave() { leaving = true; }
  // Discarded or already-submitted edits must not come back as "unsaved" if the browser later
  // restores this page from its cache; such a page is reloaded fresh instead
  var DISCARD_KEY = "discarded:" + location.pathname + location.search;
  function discardAndLeave() {
    allowLeave();
    try { sessionStorage.setItem(DISCARD_KEY, "1"); } catch (e) {}
  }

  // Back/Forward: once a form becomes dirty, add one history entry for this same page, so the
  // browser's Back lands here first and the app can ask before really leaving.
  var armed = false;
  var pendingSubmit = null;
  function arm() {
    if (armed || leaving || !anyDirty()) return;
    armed = true;
    history.pushState({ appGuard: true }, "", location.href);
  }
  guarded.forEach(function (form) {
    form.addEventListener("input", arm);
    form.addEventListener("change", arm);
  });
  if (serverRejected && guarded.length) arm();

  window.addEventListener("popstate", function () {
    if (!armed) return;
    if (pendingSubmit) {
      // We stepped back over our own entry on purpose before saving; now submit for real
      var p = pendingSubmit;
      pendingSubmit = null;
      armed = false;
      if (p.form.requestSubmit) p.form.requestSubmit(p.submitter || undefined); else p.form.submit();
      return;
    }
    if (!anyDirty()) { armed = false; history.back(); return; }
    window.AppDialog.unsaved().then(function (discard) {
      if (discard) { armed = false; discardAndLeave(); history.back(); }
      else history.pushState({ appGuard: true }, "", location.href); // stay, and keep guarding
    });
  });

  /** Navigate inside the app, asking first if there are unsaved changes. */
  function guardedNavigate(url) {
    if (!anyDirty()) { location.href = url; return; }
    window.AppDialog.unsaved().then(function (discard) {
      if (!discard) return;
      discardAndLeave();
      // Replace our extra history entry so Back from the destination returns to the real previous page
      if (armed) location.replace(url); else location.href = url;
    });
  }
  window.AppNav = {
    go: guardedNavigate,
    isDirty: anyDirty,
    /** Leave without asking (the caller has already decided nothing would be lost). */
    leave: function (url) { discardAndLeave(); if (armed) location.replace(url); else location.href = url; },
  };

  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download") || a.hasAttribute("data-no-guard")) return;
    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#" || /^(javascript|mailto|tel):/i.test(href)) {
      if (/^javascript:history\.back\(\)/i.test(href || "") && anyDirty()) { e.preventDefault(); window.AppDialog.unsaved().then(function (d) { if (d) { discardAndLeave(); history.go(armed ? -2 : -1); } }); }
      return;
    }
    if (a.origin !== location.origin || !anyDirty()) return;
    e.preventDefault();
    guardedNavigate(a.href);
  }, true);

  window.addEventListener("beforeunload", function (e) {
    if (anyDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------- Dialog-driven actions ----------
     <form data-confirm="Message" data-confirm-title data-confirm-label data-confirm-tone="danger|primary"
           [data-confirm-reason="fieldName" data-confirm-reason-label]>
       asks first, then runs the form's real action in the background; a refusal is shown in the
       dialog (which stays open), success continues to the page the server sends back.
     <form data-dialog-form> inside a modal: submitted in the background, errors shown inside it. */
  function sendForm(form, submitter, extra) {
    var data;
    try { data = new FormData(form, submitter || undefined); } catch (err) {
      // Older browsers: no submitter argument, so add the clicked button's value by hand
      data = new FormData(form);
      if (submitter && submitter.name) data.append(submitter.name, submitter.value);
    }
    Object.keys(extra || {}).forEach(function (k) { data.set(k, extra[k]); });
    var body = form.enctype === "multipart/form-data" ? data : new URLSearchParams(data);
    return fetch(form.action, {
      method: "POST",
      body: body,
      credentials: "same-origin",
      headers: { "X-Dialog": "1", Accept: "application/json" },
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw new Error(json.error || (json.errors && json.errors.join(" ")) || "The action could not be completed (" + res.status + ").");
        allowLeave();
        location.href = json.redirect || location.href;
        return { navigating: true };
      });
    }, function () {
      throw new Error("Could not reach the server. Check the connection and try again; nothing was changed.");
    });
  }

  function confirmAction(form, submitter) {
    var d = form.dataset;
    window.AppDialog.confirm({
      title: d.confirmTitle || "Please confirm",
      message: d.confirm,
      tone: d.confirmTone || "danger",
      icon: d.confirmTone === "primary" ? "primary" : "danger",
      confirmLabel: d.confirmLabel || "Confirm",
      cancelLabel: d.confirmCancel || "Go back",
      busyLabel: d.confirmBusy,
      reason: d.confirmReason ? { label: d.confirmReasonLabel || "Reason", placeholder: d.confirmReasonPlaceholder || "", maxLength: 200 } : null,
      action: function (reason) {
        var extra = {};
        if (d.confirmReason) extra[d.confirmReason] = reason;
        return sendForm(form, submitter, extra);
      },
    });
  }

  function submitDialogForm(form, submitter) {
    var box = form.querySelector("[data-dialog-error]");
    var buttons = form.querySelectorAll('button[type="submit"], button:not([type])');
    var label = submitter ? submitter.innerHTML : "";
    if (box) box.classList.add("d-none");
    buttons.forEach(function (b) { b.disabled = true; });
    if (submitter) submitter.innerHTML = '<span class="spinner-border" aria-hidden="true"></span> Saving…';
    // Keep the dialog from closing while it saves
    var modalEl = form.closest(".modal");
    function block(ev) { ev.preventDefault(); }
    if (modalEl) modalEl.addEventListener("hide.bs.modal", block);
    sendForm(form, submitter).catch(function (err) {
      if (modalEl) modalEl.removeEventListener("hide.bs.modal", block);
      buttons.forEach(function (b) { b.disabled = false; });
      if (submitter) submitter.innerHTML = label;
      if (box) { box.textContent = err.message; box.classList.remove("d-none"); box.focus(); }
      else window.AppDialog.alert({ title: "Not saved", message: err.message });
    });
  }

  /* ---------- Submit handling ---------- */
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var method = (form.getAttribute("method") || "get").toLowerCase();

    if (form.dataset.bypass === "1") {
      delete form.dataset.bypass;
    } else if (form.hasAttribute("data-dialog-form")) {
      e.preventDefault();
      submitDialogForm(form, e.submitter);
      return;
    } else if (form.dataset.confirm) {
      e.preventDefault();
      confirmAction(form, e.submitter);
      return;
    } else if (guarded.indexOf(form) === -1 && form.hasAttribute("action") && anyDirty()) {
      // Another form on the page (logout, filters, stock adjustment…) would leave unsaved edits behind.
      // Forms without an action (quick-add dialogs) are handled by script and never leave the page.
      e.preventDefault();
      var other = e.submitter;
      window.AppDialog.unsaved().then(function (discard) {
        if (!discard) return;
        discardAndLeave();
        form.dataset.bypass = "1";
        if (form.requestSubmit) form.requestSubmit(other || undefined); else form.submit();
      });
      return;
    } else if (guarded.indexOf(form) !== -1 && armed) {
      // Remove our extra history entry first, so after saving Back goes to the real previous page
      e.preventDefault();
      pendingSubmit = { form: form, submitter: e.submitter };
      history.back();
      return;
    }

    if (method !== "post" || form.hasAttribute("data-no-loading")) return;
    if (form.dataset.submitting === "1") { e.preventDefault(); return; }
    form.dataset.submitting = "1";
    allowLeave();
    // If the browser later restores this page from its cache, reload it: the values were submitted
    if (guarded.indexOf(form) !== -1) { try { sessionStorage.setItem(DISCARD_KEY, "1"); } catch (err) {} }
    // Disable only after the browser has built the form data, so the clicked button's
    // name/value (e.g. after=print) is still sent exactly once
    setTimeout(function () {
      form.querySelectorAll('button[type="submit"], button:not([type])').forEach(function (b) {
        b.disabled = true;
        if (b === e.submitter || (!e.submitter && b.matches("[data-shortcut-save]"))) {
          b.dataset.label = b.innerHTML;
          b.innerHTML = '<span class="spinner-border" aria-hidden="true"></span> ' + (form.dataset.loadingLabel || "Saving…");
        }
      });
    }, 0);
  }, true);

  // Coming back with the browser's Back button restores the page from cache: make it usable again
  try { sessionStorage.removeItem(DISCARD_KEY); } catch (e) {}
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    var discarded = false;
    try { discarded = sessionStorage.getItem(DISCARD_KEY) === "1"; sessionStorage.removeItem(DISCARD_KEY); } catch (err) {}
    if (discarded) { location.reload(); return; } // show a fresh form, not discarded or submitted values
    leaving = false;
    armed = false;
    document.querySelectorAll("form[data-submitting]").forEach(function (form) {
      delete form.dataset.submitting;
      form.querySelectorAll("button[disabled]").forEach(function (b) { b.disabled = false; if (b.dataset.label) b.innerHTML = b.dataset.label; });
    });
  });

  /* ---------- Flash messages: success/info as toasts, errors that need attention as a dialog ---------- */
  var flashError = document.querySelector("[data-flash-error]");
  if (flashError && window.AppDialog) {
    window.AppDialog.alert({ title: flashError.dataset.title || "That could not be done", message: flashError.dataset.message });
  }

  /* ---------- Return to a list with its filters: lists mark themselves, back links ask for it ---------- */
  var listKey = document.body.querySelector("[data-list-key]");
  if (listKey) store("list:" + listKey.dataset.listKey, location.pathname + location.search);
  document.querySelectorAll("a[data-back-to]").forEach(function (a) {
    var saved = store("list:" + a.dataset.backTo);
    if (saved && saved.split("?")[0] === a.dataset.backTo) a.href = saved;
  });

  /* ---------- Sortable and paginated tables: <table data-sortable data-page-size="50"> + <th data-sort="text|num|date"> ---------- */
  function cellValue(row, index, type) {
    var cell = row.children[index];
    if (!cell) return "";
    var raw = cell.dataset.sortValue != null ? cell.dataset.sortValue : cell.textContent.trim();
    if (type === "num") { var n = parseFloat(String(raw).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? -Infinity : n; }
    if (type === "date") { var t = Date.parse(raw); return isNaN(t) ? 0 : t; }
    return String(raw).toLowerCase();
  }
  document.querySelectorAll("table[data-sortable]").forEach(function (table) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    var rows = function () { return Array.prototype.filter.call(tbody.rows, function (r) { return !r.hasAttribute("data-static"); }); };
    var pageSize = parseInt(table.dataset.pageSize || "0", 10);
    var page = 1;
    var pager = null;

    function paginate() {
      if (!pageSize) return;
      var all = rows();
      var pages = Math.max(1, Math.ceil(all.length / pageSize));
      page = Math.min(page, pages);
      all.forEach(function (r, i) { r.hidden = i < (page - 1) * pageSize || i >= page * pageSize; });
      if (all.length <= pageSize) { if (pager) pager.hidden = true; return; }
      if (!pager) {
        pager = document.createElement("div");
        pager.className = "table-pager";
        var wrap = table.closest(".table-scroll") || table;
        wrap.parentNode.insertBefore(pager, wrap.nextSibling);
        pager.addEventListener("click", function (e) {
          var btn = e.target.closest("button[data-page]");
          if (!btn) return;
          page = parseInt(btn.dataset.page, 10);
          paginate();
          (table.closest(".table-scroll") || table).scrollTop = 0;
        });
      }
      pager.hidden = false;
      var from = (page - 1) * pageSize + 1, to = Math.min(page * pageSize, all.length);
      pager.innerHTML = "<span>Showing " + from + "–" + to + " of " + all.length + "</span>" +
        '<span class="d-flex gap-1">' +
        '<button type="button" class="btn btn-sm btn-outline-secondary" data-page="' + (page - 1) + '"' + (page === 1 ? " disabled" : "") + ">Previous</button>" +
        '<span class="px-2 align-self-center">Page ' + page + " of " + pages + "</span>" +
        '<button type="button" class="btn btn-sm btn-outline-secondary" data-page="' + (page + 1) + '"' + (page === pages ? " disabled" : "") + ">Next</button></span>";
    }

    table.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      function sort() {
        var index = Array.prototype.indexOf.call(th.parentNode.children, th);
        var dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
        table.querySelectorAll("th[data-sort]").forEach(function (o) { o.removeAttribute("aria-sort"); });
        th.setAttribute("aria-sort", dir);
        var type = th.dataset.sort;
        var sorted = rows().sort(function (a, b) {
          var x = cellValue(a, index, type), y = cellValue(b, index, type);
          return (x > y ? 1 : x < y ? -1 : 0) * (dir === "ascending" ? 1 : -1);
        });
        sorted.forEach(function (r) { tbody.appendChild(r); });
        page = 1;
        paginate();
      }
      th.addEventListener("click", sort);
      th.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sort(); } });
    });
    paginate();
    table.addEventListener("rows:changed", function () { page = 1; paginate(); });
  });

  /* ---------- Image uploader with preview: <div class="uploader" data-uploader> ---------- */
  document.querySelectorAll("[data-uploader]").forEach(function (box) {
    var input = box.querySelector('input[type="file"]');
    var preview = box.querySelector(".uploader-preview");
    var name = box.querySelector(".uploader-name");
    var removeBtn = box.querySelector("[data-uploader-clear]");
    var original = preview.innerHTML;
    var originalName = name ? name.textContent : "";
    box.querySelector("[data-uploader-pick]").addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var url = URL.createObjectURL(file);
      preview.innerHTML = '<img alt="Selected image preview">';
      preview.querySelector("img").src = url;
      if (name) name.textContent = file.name + " · " + Math.max(1, Math.round(file.size / 1024)) + " KB";
      if (removeBtn) removeBtn.hidden = false;
    });
    if (removeBtn) {
      removeBtn.addEventListener("click", function () {
        input.value = "";
        preview.innerHTML = original;
        if (name) name.textContent = originalName;
        removeBtn.hidden = true;
      });
    }
  });

  /* ---------- Save & Print lands on the document with ?print=1 ---------- */
  if (/[?&]print=1\b/.test(location.search) && document.querySelector("[data-shortcut-print]")) {
    window.addEventListener("load", function () {
      setTimeout(function () { window.print(); }, 300);
      history.replaceState(null, "", location.pathname);
    });
  }

  /* ---------- Floating panels ----------
     Dropdowns use fixed positioning so scroll containers (tables, panels) cannot clip them, and
     Popper flips/shifts them to stay on screen. Icon-only buttons and the collapsed sidebar get tooltips. */
  if (window.bootstrap) {
    document.querySelectorAll('[data-bs-toggle="dropdown"]').forEach(function (el) {
      bootstrap.Dropdown.getOrCreateInstance(el, {
        popperConfig: function (config) {
          config.strategy = "fixed";
          return config;
        },
      });
    });
    document.querySelectorAll(".btn-icon[title], .btn-icon[aria-label]").forEach(function (el) {
      if (el.closest("[data-bs-toggle]") || el.hasAttribute("data-bs-toggle")) return;
      new bootstrap.Tooltip(el, { title: el.getAttribute("title") || el.getAttribute("aria-label"), trigger: "hover focus", placement: "top" });
    });
    document.querySelectorAll(".sidebar .nav-link[data-nav-tip]").forEach(function (el) {
      var tip = new bootstrap.Tooltip(el, { title: el.dataset.navTip, placement: "right", trigger: "hover focus", customClass: "nav-tooltip" });
      // Labels are visible when the sidebar is expanded (or as the mobile drawer), so only show tips when collapsed
      el.addEventListener("show.bs.tooltip", function (e) {
        if (!root.classList.contains("sb-collapsed") || window.innerWidth < 992) e.preventDefault();
      });
      el.addEventListener("click", function () { tip.hide(); });
    });
  }

  /* ---------- Global shortcuts (not while typing) ---------- */
  document.addEventListener("keydown", function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var key = e.key.toLowerCase();
    var target = { i: "/invoices/new", r: "/payments/new?direction=IN", p: "/purchases/new" }[key];
    if (target && document.querySelector(".sidebar")) { e.preventDefault(); guardedNavigate(target); }
  });
})();
