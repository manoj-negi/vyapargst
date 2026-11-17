/* Upload step of "Import bill with AI": choose / drop / photograph files, then upload with progress. */
(function () {
  "use strict";
  var root = document.querySelector("[data-import-upload]");
  if (!root) return;
  var input = root.querySelector("[data-files]");
  var camera = root.querySelector("[data-camera-input]");
  var list = root.querySelector("[data-file-list]");
  var grouping = root.querySelector("[data-grouping]");
  var btn = root.querySelector("[data-upload]");
  var errorBox = root.querySelector("[data-upload-error]");
  var progress = root.querySelector("[data-progress]");
  var zone = root.querySelector("[data-dropzone]");
  var files = [];

  function esc(s) { return window.AppDialog ? window.AppDialog.escapeHtml(s) : String(s); }
  function size(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function render() {
    list.innerHTML = files.map(function (f, i) {
      return '<li><i class="icon-file" aria-hidden="true"></i><span class="name">' + esc(f.name) + '</span><span class="text-muted small">' + size(f.size) + '</span><button type="button" class="btn btn-sm btn-tertiary" data-remove="' + i + '" aria-label="Remove ' + esc(f.name) + '"><i class="icon-x"></i></button></li>';
    }).join("");
    grouping.hidden = files.length < 2;
    btn.disabled = !files.length;
  }
  function add(newFiles) {
    Array.prototype.forEach.call(newFiles, function (f) { files.push(f); });
    errorBox.classList.add("d-none");
    render();
  }
  root.querySelector("[data-pick]").addEventListener("click", function (e) { e.stopPropagation(); input.click(); });
  root.querySelector("[data-camera]").addEventListener("click", function (e) { e.stopPropagation(); camera.click(); });
  zone.addEventListener("click", function () { input.click(); });
  zone.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", function () { add(input.files); input.value = ""; });
  camera.addEventListener("change", function () { add(camera.files); camera.value = ""; });
  list.addEventListener("click", function (e) {
    var b = e.target.closest("[data-remove]");
    if (b) { files.splice(Number(b.dataset.remove), 1); render(); }
  });
  ["dragenter", "dragover"].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add("drag"); }); });
  ["dragleave", "drop"].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.remove("drag"); }); });
  zone.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files); });

  btn.addEventListener("click", function () {
    if (!files.length || btn.disabled) return;
    var fd = new FormData();
    files.forEach(function (f) { fd.append("files", f, f.name); });
    fd.append("grouping", (root.querySelector('input[name="grouping"]:checked') || {}).value || "one");
    var xhr = new XMLHttpRequest();
    btn.disabled = true;
    progress.hidden = false;
    errorBox.classList.add("d-none");
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) progress.querySelector(".progress-bar").style.width = Math.round((e.loaded / e.total) * 100) + "%";
    };
    xhr.onload = function () {
      var body = {};
      try { body = JSON.parse(xhr.responseText); } catch (x) {}
      if (xhr.status >= 200 && xhr.status < 300 && body.redirect) {
        progress.querySelector("[data-progress-text]").textContent = "Uploaded. Opening…";
        if (window.AppNav) window.AppNav.leave(body.redirect); else location.href = body.redirect;
        return;
      }
      fail(body.error || "The upload failed (" + xhr.status + "). Please try again.");
    };
    xhr.onerror = function () { fail("No connection to the server. Check the connection and retry."); };
    xhr.open("POST", "/purchases/import");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.send(fd);
  });
  function fail(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove("d-none");
    progress.hidden = true;
    btn.disabled = !files.length;
  }
})();
