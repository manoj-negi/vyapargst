/*
 * Shared in-app dialogs (replaces window.alert / confirm / prompt).
 *
 *   AppDialog.confirm({ title, message, tone, icon, confirmLabel, cancelLabel, reason, action })
 *     -> Promise<{ confirmed: boolean, reason?: string }>
 *     tone "danger" styles the confirm button red and focuses the safe (cancel) button.
 *     reason: { label, placeholder, maxLength } asks for a required reason.
 *     action(reason): optional async work run while the dialog shows a spinner. If it throws,
 *     the dialog stays open with the error and nothing else happens; if it resolves, the dialog
 *     closes (or stays busy if the action navigates away).
 *   AppDialog.alert({ title, message, tone }) -> Promise<void>
 *   AppDialog.unsaved() -> Promise<boolean>   true = discard changes
 *
 * Built on the Bootstrap modal: static backdrop (no accidental dismissal), Esc = cancel,
 * focus trapped inside and restored to where it was when the dialog closes.
 */
(function () {
  "use strict";

  var ICONS = { danger: "icon-triangle-alert", warning: "icon-circle-alert", info: "icon-info", success: "icon-circle-check", primary: "icon-circle-help" };
  var el, modal, state;

  function build() {
    el = document.createElement("div");
    el.className = "modal fade app-dialog";
    el.tabIndex = -1;
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("aria-labelledby", "appDialogTitle");
    el.setAttribute("aria-describedby", "appDialogMessage");
    el.innerHTML =
      '<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">' +
      '<div class="modal-content">' +
      '<div class="modal-body">' +
      '<div class="app-dialog-layout">' +
      '<span class="app-dialog-icon" aria-hidden="true"><i></i></span>' +
      '<div class="app-dialog-text">' +
      '<h2 class="app-dialog-title" id="appDialogTitle"></h2>' +
      '<p class="app-dialog-message" id="appDialogMessage"></p>' +
      '<div class="app-dialog-reason d-none">' +
      '<label class="form-label" for="appDialogReason"></label>' +
      '<input type="text" class="form-control" id="appDialogReason" autocomplete="off">' +
      '<div class="invalid-feedback">Please enter a reason.</div>' +
      "</div>" +
      '<div class="alert alert-danger app-dialog-error d-none" role="alert"></div>' +
      "</div></div></div>" +
      '<div class="modal-footer">' +
      '<button type="button" class="btn btn-outline-secondary" data-dialog-cancel></button>' +
      '<button type="button" class="btn" data-dialog-ok></button>' +
      "</div></div></div>";
    document.body.appendChild(el);
    modal = new bootstrap.Modal(el, { backdrop: "static", keyboard: true, focus: true });

    var ok = el.querySelector("[data-dialog-ok]");
    var cancel = el.querySelector("[data-dialog-cancel]");
    var reason = el.querySelector("#appDialogReason");

    cancel.addEventListener("click", function () { if (state && !state.busy) close(false); });
    ok.addEventListener("click", confirmNow);
    reason.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); confirmNow(); } });
    reason.addEventListener("input", function () { reason.classList.remove("is-invalid"); });

    // Esc, or any other hide request, counts as Cancel, and is ignored while an action is running
    el.addEventListener("hide.bs.modal", function (e) {
      if (!state) return;
      if (state.busy) { e.preventDefault(); return; }
      if (!state.settled) settle(false);
    });
    el.addEventListener("shown.bs.modal", function () {
      if (!state) return;
      // Bootstrap marks the modal role=dialog; confirmations interrupt, so announce them as alerts
      el.setAttribute("role", "alertdialog");
      var target = state.opts.reason ? reason : state.opts.tone === "danger" || state.opts.tone === "warning" ? cancel : ok;
      if (state.opts.hideCancel) target = state.opts.reason ? reason : ok;
      target.focus();
    });
    el.addEventListener("hidden.bs.modal", function () {
      var s = state;
      state = null;
      if (s && s.returnFocus && document.contains(s.returnFocus)) s.returnFocus.focus();
      if (queue.length) queue.shift()();
    });
  }

  function settle(confirmed, reasonValue) {
    state.settled = true;
    state.resolve(confirmed ? { confirmed: true, reason: reasonValue } : { confirmed: false });
  }

  function close(confirmed, reasonValue) {
    if (!state.settled) settle(confirmed, reasonValue);
    modal.hide();
  }

  function setBusy(busy, label) {
    var ok = el.querySelector("[data-dialog-ok]");
    var cancel = el.querySelector("[data-dialog-cancel]");
    state.busy = busy;
    ok.disabled = busy;
    cancel.disabled = busy;
    el.querySelector("#appDialogReason").disabled = busy;
    ok.innerHTML = busy ? '<span class="spinner-border" aria-hidden="true"></span> ' + escapeHtml(label || "Working…") : escapeHtml(state.opts.confirmLabel);
    el.querySelector(".modal-content").setAttribute("aria-busy", busy ? "true" : "false");
  }

  function confirmNow() {
    if (!state || state.busy) return;
    var input = el.querySelector("#appDialogReason");
    var value;
    if (state.opts.reason) {
      value = input.value.trim();
      if (!value) { input.classList.add("is-invalid"); input.focus(); return; }
    }
    if (!state.opts.action) { close(true, value); return; }

    var errorBox = el.querySelector(".app-dialog-error");
    errorBox.classList.add("d-none");
    setBusy(true, state.opts.busyLabel);
    Promise.resolve()
      .then(function () { return state.opts.action(value); })
      .then(function (result) {
        // An action that navigates away keeps the dialog busy until the page changes
        if (result && result.navigating) return;
        setBusy(false);
        close(true, value);
      })
      .catch(function (err) {
        setBusy(false);
        errorBox.textContent = (err && err.message) || "Something went wrong. Please try again.";
        errorBox.classList.remove("d-none");
        el.querySelector("[data-dialog-ok]").focus();
      });
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var queue = [];
  function open(opts) {
    return new Promise(function (resolve) {
      function show() {
        if (!el) build();
        var tone = opts.tone || "primary";
        state = { opts: opts, resolve: resolve, busy: false, settled: false, returnFocus: document.activeElement };
        el.querySelector(".app-dialog-icon").className = "app-dialog-icon tone-" + (opts.icon || tone);
        el.querySelector(".app-dialog-icon i").className = ICONS[opts.icon || tone] || ICONS.primary;
        el.querySelector(".app-dialog-title").textContent = opts.title || "Please confirm";
        el.querySelector(".app-dialog-message").textContent = opts.message || "";
        var reasonWrap = el.querySelector(".app-dialog-reason");
        var reasonInput = el.querySelector("#appDialogReason");
        reasonWrap.classList.toggle("d-none", !opts.reason);
        reasonInput.value = "";
        reasonInput.disabled = false;
        reasonInput.classList.remove("is-invalid");
        if (opts.reason) {
          reasonWrap.querySelector("label").innerHTML = escapeHtml(opts.reason.label || "Reason") + ' <span class="req">*</span>';
          reasonInput.placeholder = opts.reason.placeholder || "";
          reasonInput.maxLength = opts.reason.maxLength || 200;
        }
        el.querySelector(".app-dialog-error").classList.add("d-none");
        var ok = el.querySelector("[data-dialog-ok]");
        ok.className = "btn " + (tone === "danger" ? "btn-danger" : "btn-primary");
        ok.disabled = false;
        ok.textContent = opts.confirmLabel || "Confirm";
        var cancel = el.querySelector("[data-dialog-cancel]");
        cancel.disabled = false;
        cancel.textContent = opts.cancelLabel || "Cancel";
        cancel.hidden = !!opts.hideCancel;
        modal.show();
      }
      // One dialog at a time; a second request waits for the first to close
      if (state) queue.push(show); else show();
    });
  }

  window.AppDialog = {
    confirm: open,
    alert: function (opts) {
      return open({ title: opts.title || "Something went wrong", message: opts.message, icon: opts.tone || "danger", tone: "primary", confirmLabel: opts.okLabel || "OK", hideCancel: true }).then(function () {});
    },
    unsaved: function () {
      return open({
        title: "Unsaved changes",
        message: "You have unsaved changes. Would you like to keep editing or discard them?",
        icon: "warning",
        tone: "danger",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
      }).then(function (r) { return r.confirmed; });
    },
    escapeHtml: escapeHtml,
  };
})();
