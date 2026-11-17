/*
 * Review screen of "Import bill with AI". State lives in `draft` (saved as a draft as you go; saving
 * changes nothing else). Every change asks the server to re-check the draft (/review): matching,
 * unit conversions, GST engine totals, price changes, duplicates and what still blocks saving.
 * Only "Confirm & Save Purchase" applies anything.
 */
(function () {
  "use strict";
  const S = window.__IMPORT;
  if (!S) return;
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const inr = (n) => (n == null || isNaN(n) ? "—" : `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const num = (v) => { const s = String(v ?? "").replace(/[,₹\s]/g, ""); if (s === "") return null; const n = Number(s); return isFinite(n) ? n : null; };
  const locked = S.status === "POSTED" || S.status === "POSTING";
  let draft = S.draft;
  let review = null;
  let saveTimer, reviewTimer, reviewSeq = 0;

  // ---------- Phone: Document / Details tabs ----------
  document.querySelectorAll("[data-pane-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-pane-tab]").forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-selected", x === b); });
      document.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("pane-active", p.dataset.pane === b.dataset.paneTab));
    })
  );
  $('[data-pane="doc"]').classList.add("pane-active");

  // ---------- Original document ----------
  let currentFile = 0;
  function renderDoc() {
    const box = $("[data-doc-files]");
    box.innerHTML = S.files.length > 1 ? S.files.map((f, i) => `<button type="button" class="chip ${i === currentFile ? "active" : ""}" data-file="${i}">${esc(f.name)}</button>`).join("") : `<span class="small text-muted">${esc(S.files[0]?.name || "")}</span>`;
    const f = S.files[currentFile];
    const view = $("[data-doc-view]");
    if (!f) { view.innerHTML = ""; return; }
    const url = `/purchases/import/${S.id}/files/${f.id}`;
    if (["jpeg", "png", "webp", "tiff", "heic"].includes(f.type)) {
      view.innerHTML = `<div class="doc-tools"><button type="button" class="btn btn-sm btn-outline-secondary" data-rotate="-90" ${locked ? "disabled" : ""}><i class="icon-rotate-ccw"></i> Rotate</button><button type="button" class="btn btn-sm btn-outline-secondary" data-rotate="90" ${locked ? "disabled" : ""}><i class="icon-rotate-cw"></i> Rotate</button><a class="btn btn-sm btn-tertiary" href="${url}" target="_blank" rel="noopener">Open original</a></div><img class="doc-image" alt="${esc(f.name)}" src="${url}?preview=1&r=${f.rotation}">`;
    } else if (f.type === "pdf") {
      view.innerHTML = `<div class="doc-tools"><span class="small text-muted">${f.pages ? f.pages + " page" + (f.pages === 1 ? "" : "s") : ""}</span><a class="btn btn-sm btn-tertiary" href="${url}" target="_blank" rel="noopener">Open in a new tab</a></div><object class="doc-pdf" data="${url}" type="application/pdf"><a href="${url}" target="_blank" rel="noopener">Open the PDF</a></object>`;
    } else {
      // Spreadsheets and documents: what was read from them
      const parts = (S.sourceData?.parts || []).filter((p) => p.fileId === f.id);
      view.innerHTML = `<div class="doc-tools"><a class="btn btn-sm btn-tertiary" href="${url}">Download original</a></div>` +
        (parts.length ? parts.map((p) => p.type === "table" ? `<div class="doc-table-title">${esc(p.source)}${p.hidden ? " (hidden sheet)" : ""}</div><div class="table-scroll"><table class="doc-table"><tbody>${p.rows.slice(0, 200).map((r, ri) => `<tr><th>${ri + 1}</th>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : p.type === "text" ? `<div class="doc-table-title">${esc(p.source)}</div><pre class="doc-text">${esc(p.text)}</pre>` : "").join("") : `<p class="small text-muted">Not read yet.</p>`);
    }
  }
  $("[data-doc-files]").addEventListener("click", (e) => { const b = e.target.closest("[data-file]"); if (b) { currentFile = Number(b.dataset.file); renderDoc(); } });
  $("[data-doc-view]").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-rotate]");
    if (!b) return;
    const f = S.files[currentFile];
    f.rotation = (((f.rotation + Number(b.dataset.rotate)) % 360) + 360) % 360;
    await fetch(`/api/purchase-imports/${S.id}/files/${f.id}/rotate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotation: f.rotation }) });
    renderDoc();
    if (S.aiReady && !locked) showScanPanel("Rotated. Read the bill again so the new orientation is used?", true);
  });

  // ---------- Reading (scan) ----------
  function showScanPanel(message, offerRetry, tone) {
    $("[data-scan]").innerHTML = `<div class="alert alert-${tone || "info"} d-flex justify-content-between align-items-center gap-2 flex-wrap" role="status"><span>${esc(message)}</span>${offerRetry ? `<button type="button" class="btn btn-sm btn-primary" data-rescan><i class="icon-refresh-cw"></i> ${S.status === "FAILED" ? "Retry" : "Read again (keeps your edits)"}</button>` : ""}</div>`;
  }
  $("[data-scan]").addEventListener("click", (e) => { if (e.target.closest("[data-rescan]")) runExtract(); });
  async function runExtract() {
    const steps = ["Opening the files", "Reading the text (scans and photos use OCR, up to a minute per page)", "Finding the supplier, items and totals (the optional local AI can take a few minutes)", "Matching items and checking totals"];
    let step = 0;
    const panel = $("[data-scan]");
    const paint = () => { panel.innerHTML = `<div class="panel import-scanning"><div class="panel-body"><div class="d-flex align-items-center gap-2"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span><strong>Reading…</strong></div><ol class="scan-steps">${steps.map((s, i) => `<li class="${i < step ? "done" : i === step ? "now" : ""}">${esc(s)}</li>`).join("")}</ol></div></div>`; };
    paint();
    const timer = setInterval(() => { if (step < steps.length - 1) { step++; paint(); } }, 2500);
    $("[data-editor]").innerHTML = "";
    try {
      const res = await fetch(`/api/purchase-imports/${S.id}/extract`, { method: "POST", headers: { Accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      clearInterval(timer);
      if (!res.ok) { S.status = "FAILED"; showScanPanel(body.error || "Reading failed. Retry in a moment.", true, "danger"); return; }
      Object.assign(S, { status: body.status, error: body.error, draft: body.draft, sourceData: body.sourceData, extractor: body.extractor });
      draft = S.draft;
      history.replaceState(null, "", location.pathname);
      start();
    } catch (err) {
      clearInterval(timer);
      showScanPanel("No connection to the server. Check the connection and retry.", true, "danger");
    }
  }

  // ---------- Editor ----------
  const KINDS = { invoice: "Purchase bill / tax invoice", catalog: "Catalogue (create items only)", price_list: "Price list (create items only)", quotation: "Quotation (create items only)", other: "Other document" };
  const field = (label, name, value, attrs = "") => `<div class="f"><label class="form-label">${label}</label><input class="form-control form-control-sm" data-h="${name}" value="${esc(value ?? "")}" ${attrs} ${locked ? "disabled" : ""}></div>`;
  function editorShell() {
    const sup = draft.supplier;
    const supplierOptions = `<option value="">— New supplier —</option>` + S.suppliers.map((s) => `<option value="${s.id}" ${s.id === draft.supplierId ? "selected" : ""}>${esc(s.name)}${s.gstin ? " · " + esc(s.gstin) : ""}</option>`).join("");
    const tables = (S.sourceData?.parts || []).map((p, i) => ({ p, i })).filter((x) => x.p.type === "table");
    return `
      ${readReport()}
      ${S.error ? `<div class="alert alert-${S.status === "NEEDS_SETUP" ? "warning" : "secondary"} small"><strong>${S.status === "NEEDS_SETUP" ? "Could not read this document automatically." : "Note:"}</strong> ${esc(S.error)} ${tables.length ? "You can also map its table below." : ""} Whatever was found is filled in below; nothing is saved to your accounts until you confirm.</div>` : ""}
      ${(S.sourceData?.warnings || []).length ? `<div class="alert alert-secondary small">${S.sourceData.warnings.map(esc).join("<br>")}</div>` : ""}
      ${(draft.notes || []).length ? `<div class="alert alert-info small"><strong>Notes from the reader:</strong> ${draft.notes.map(esc).join(" · ")}</div>` : ""}
      ${tables.length ? mappingPanel(tables) : ""}
      <section class="panel mb-3"><div class="panel-body">
        <div class="fgrid">
          <div class="s6"><label class="form-label">Document</label><select class="form-select form-select-sm" data-h="documentKind" ${locked ? "disabled" : ""}>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${draft.documentKind === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          <div class="s6"><label class="form-label">Supplier</label><select class="form-select form-select-sm" data-h="supplierId" ${locked ? "disabled" : ""}>${supplierOptions}</select><div class="small mt-1" data-supplier-hint></div></div>
        </div>
        <div class="fgrid mt-2 ${draft.supplierId ? "d-none" : ""}" data-new-supplier>
          <div class="s6">${field("New supplier name", "supplier.name", sup.name, `maxlength="150"`)}</div>
          <div class="s3">${field("GSTIN", "supplier.gstin", sup.gstin, `maxlength="15" class="text-uppercase"`)}</div>
          <div class="s3"><label class="form-label">State</label><select class="form-select form-select-sm" data-h="supplier.state" ${locked ? "disabled" : ""}><option value="">From GSTIN / your state</option>${S.states.map((s) => `<option ${sup.state === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
          <div class="s6">${field("Address", "supplier.address", sup.address)}</div>
          <div class="s3">${field("Phone", "supplier.phone", sup.phone)}</div>
          <div class="s3">${field("Email", "supplier.email", sup.email)}</div>
        </div>
        <div class="fgrid mt-2">
          <div class="s3">${field("Supplier invoice no.", "invoiceNo", draft.invoiceNo, `maxlength="40"`)}</div>
          <div class="s3">${field("Invoice date", "invoiceDate", draft.invoiceDate, `type="date"`)}</div>
          <div class="s3">${field("Due date", "dueDate", draft.dueDate, `type="date"`)}</div>
          <div class="s3">${field("Bill total (printed)", "extractedTotals.grand", draft.extractedTotals.grand, `inputmode="decimal"`)}</div>
          <div class="s3">${field("Bill discount ₹", "invoiceDiscountAmount", draft.invoiceDiscountAmount, `inputmode="decimal"`)}</div>
          <div class="s3">${field("Charges label", "chargesLabel", draft.chargesLabel, `placeholder="Delivery charges"`)}</div>
          <div class="s3">${field("Charges ₹ (before GST)", "chargesAmount", draft.chargesAmount, `inputmode="decimal"`)}</div>
          <div class="s3">${field("GST % on charges", "chargesGstRate", draft.chargesGstRate, `inputmode="decimal"`)}</div>
          <div class="s3">${field("Round-off ₹", "roundOff", draft.roundOff, `inputmode="decimal" placeholder="Auto"`)}</div>
        </div>
        ${draft.paymentTerms ? `<div class="small text-muted mt-2"><strong>Payment details on the bill:</strong> ${esc(draft.paymentTerms)} <em>(shown only; the bill is saved as unpaid — record payments separately)</em></div>` : ""}
        ${draft.uncertain?.length ? `<div class="small text-warning mt-1"><i class="icon-triangle-alert"></i> Check: ${draft.uncertain.map(esc).join(", ")}</div>` : ""}
      </div></section>
      <section class="panel mb-3"><div class="panel-header"><h2 class="panel-title">Items <span class="small text-muted fw-normal" data-row-count></span></h2>${locked ? "" : `<button type="button" class="btn btn-sm sale-add-row" data-add-row><i class="icon-plus"></i> Add row</button>`}</div>
        <div class="panel-body import-rows" data-rows></div>
      </section>
      <div data-checks></div>
      <section class="panel import-summary"><div class="panel-body" data-summary></div></section>`;
  }

  function readReport() {
    const rep = S.sourceData && S.sourceData.report;
    if (!rep || !rep.steps) return "";
    const icon = { ok: "✓", failed: "✗", unavailable: "–", skipped: "–" };
    return `<details class="import-report small mb-2" ${rep.ok ? "" : "open"}><summary>How this bill was read: ${rep.ok ? `${rep.rows} item row(s) found` : "no item rows found"}${S.extractor ? ` · ${esc(S.extractor === "table" ? "from the document's table" : S.extractor === "local" ? "local parser" : S.extractor.replace("local-ai:", "local AI "))}` : ""}</summary><ul>${rep.steps.map((st) => `<li class="st-${st.status}"><span>${icon[st.status] || "·"}</span> <strong>${esc(st.step)}</strong>: ${esc(st.detail)}</li>`).join("")}</ul></details>`;
  }

  function mappingPanel(tables) {
    const ts = draft.tableSource;
    const cur = tables.find((t) => t.i === ts?.partIndex) || tables[0];
    const header = cur.p.rows[ts?.headerRow ?? 0] || [];
    const colOptions = (sel) => `<option value="">—</option>` + header.map((h, c) => `<option value="${c}" ${sel === c ? "selected" : ""}>${String.fromCharCode(65 + (c % 26))}${c >= 26 ? Math.floor(c / 26) : ""}: ${esc(String(h).slice(0, 24))}</option>`).join("");
    return `<details class="panel mb-3 import-mapping" ${ts ? "" : "open"}><summary class="panel-body"><strong>Read rows from a table</strong> <span class="small text-muted">${ts ? "— choose another sheet, header row or columns if the rows look wrong" : "— pick the sheet and columns"}</span></summary><div class="panel-body pt-0">
      <div class="fgrid">
        <div class="s6"><label class="form-label">Sheet / table</label><select class="form-select form-select-sm" data-map="part">${tables.map((t) => `<option value="${t.i}" ${t.i === cur.i ? "selected" : ""}>${esc(t.p.source)}${t.p.hidden ? " (hidden)" : ""} · ${t.p.rows.length} rows</option>`).join("")}</select></div>
        <div class="s3"><label class="form-label">Header row</label><input type="number" min="1" class="form-control form-control-sm" data-map="header" value="${(ts?.headerRow ?? 0) + 1}"></div>
      </div>
      <div class="fgrid mt-2">${S.fields.map((f) => `<div class="s3"><label class="form-label">${esc(f.label)}</label><select class="form-select form-select-sm" data-map-col="${f.key}">${colOptions(ts?.columns?.[f.key] ?? null)}</select></div>`).join("")}</div>
      <button type="button" class="btn btn-sm btn-outline-primary mt-2" data-map-apply ${locked ? "disabled" : ""}>Read rows with these columns</button> <span class="small text-muted">Replaces the item rows below.</span>
    </div></details>`;
  }

  function rowHtml(r, i) {
    const d = locked ? "disabled" : "";
    const inp = (k, v, cls = "", a = "") => `<input class="form-control form-control-sm ${cls}" data-r="${k}" value="${esc(v ?? "")}" ${a} ${d} ${r.uncertain?.some((u) => u.toLowerCase().includes(k.toLowerCase())) ? 'data-uncertain="1"' : ""}>`;
    return `<div class="import-row ${r.action === "skip" ? "skipped" : ""}" data-row="${r.id}">
      <div class="ir-head"><span class="ir-num">${i + 1}</span>${inp("description", r.description, "ir-desc", 'aria-label="Description"')}${locked ? "" : `<button type="button" class="btn btn-sm btn-tertiary" data-del aria-label="Delete row"><i class="icon-trash-2"></i></button>`}</div>
      <div class="ir-grid">
        <label>Item code${inp("supplierCode", r.supplierCode)}</label>
        <label>HSN${inp("hsn", r.hsn, "", 'inputmode="numeric"')}</label>
        <label>Qty${inp("quantity", r.quantity, "num", 'inputmode="decimal"')}</label>
        <label>Free${inp("freeQuantity", r.freeQuantity, "num", 'inputmode="decimal"')}</label>
        <label>Unit${inp("unit", r.unit)}</label>
        <label>Rate${inp("rate", r.rate, "num", 'inputmode="decimal"')}</label>
        <label class="ir-check"><input type="checkbox" class="form-check-input" data-r="rateIncludesTax" ${r.rateIncludesTax ? "checked" : ""} ${d}> Rate incl. GST</label>
        <label>Disc %${inp("discountPercent", r.discountPercent, "num", 'inputmode="decimal"')}</label>
        <label>Disc ₹${inp("discountAmount", r.discountAmount, "num", 'inputmode="decimal"')}</label>
        <label>GST %${inp("gstRate", r.gstRate, "num", 'inputmode="decimal"')}</label>
        <label>Printed amount${inp("extractedLineTotal", r.extractedLineTotal, "num", 'inputmode="decimal"')}</label>
      </div>
      <div class="ir-match" data-match-area></div>
      <div class="ir-status" data-status></div>
    </div>`;
  }

  function matchHtml(r, rv) {
    const d = locked ? "disabled" : "";
    const opts = [];
    const seen = new Set();
    const add = (id, label) => { if (id && !seen.has(id)) { seen.add(id); opts.push(`<option value="p:${id}" ${r.action === "match" && r.productId === id ? "selected" : ""}>${esc(label)}</option>`); } };
    if (rv?.product) add(rv.product.id, rv.product.name);
    (rv?.suggestions || []).forEach((s) => add(s.id, `${s.name} — ${s.reason}`));
    const sel = `<select class="form-select form-select-sm" data-match ${d}>
      ${r.action === "match" && !r.productId ? `<option value="" selected>— Choose the item —</option>` : ""}
      ${opts.join("")}
      <option value="search">Search all items…</option>
      <option value="create" ${r.action === "create" ? "selected" : ""}>+ Create a new item</option>
      <option value="skip" ${r.action === "skip" ? "selected" : ""}>Skip this line</option></select>`;
    let extra = "";
    if (r.action === "create") {
      const np = r.newProduct || {};
      extra = `<div class="ir-grid mt-1"><label class="ir-wide">New item name<input class="form-control form-control-sm" data-np="name" value="${esc(np.name)}" ${d}></label><label>Unit<input class="form-control form-control-sm" data-np="unitName" value="${esc(np.unitName)}" ${d}></label><label>GST %<input class="form-control form-control-sm num" data-np="gstRate" value="${esc(np.gstRate)}" inputmode="decimal" ${d}></label><label>Selling price<input class="form-control form-control-sm num" data-np="salePrice" value="${esc(np.salePrice)}" inputmode="decimal" placeholder="Set later" ${d}></label></div>`;
    }
    if (rv && rv.status === "suggested" && r.action === "match" && r.productId) {
      extra += `<label class="form-check mt-1"><input type="checkbox" class="form-check-input" data-confirm-match ${r.matchConfirmed ? "checked" : ""} ${d}> <span class="form-check-label">Yes, this is the same item</span></label>`;
    }
    if (rv && (rv.needsConversion || (r.action === "match" && rv.unitFactor && rv.unitFactor !== 1) || r.unitFactor !== null) && rv.baseUnit && r.action === "match") {
      extra += `<div class="ir-conv"><span>1 ${esc(r.unit || "bill unit")} =</span><input class="form-control form-control-sm num" data-r="unitFactor" value="${esc(r.unitFactor ?? rv.unitFactor ?? "")}" inputmode="decimal" ${rv.needsConversion ? 'data-uncertain="1"' : ""} ${d}><span>${esc(rv.baseUnit)}</span>${r.packNote ? `<span class="small text-muted">(bill says: ${esc(r.packNote)})</span>` : ""}</div>`;
    }
    return `<div class="ir-match-row"><span class="ir-label">Item</span>${sel}</div><div class="ir-search" data-search hidden><input class="form-control form-control-sm" placeholder="Type to search your items" data-search-input><div class="ir-search-results" data-search-results></div></div>${extra}`;
  }

  function statusHtml(r, rv) {
    if (!rv) return "";
    const b = [];
    const badge = { remembered: ["Matched (remembered)", "status-paid"], code: ["Matched by code", "status-paid"], suggested: [r.matchConfirmed ? "Matched (confirmed)" : "Suggested match", r.matchConfirmed ? "status-paid" : "status-partial"], unmatched: ["Not matched", "status-unpaid"], create: ["New item", "status-open"], skip: ["Skipped", "status-cancelled"] }[rv.status];
    if (badge) b.push(`<span class="status-badge ${badge[1]}">${badge[0]}</span>`);
    if (rv.baseQuantity && S.draftKindIsPurchase) b.push(`<span class="small">Stock +${rv.baseQuantity} ${esc(rv.baseUnit || "")}${rv.product ? ` (now ${rv.product.currentStock})` : ""}</span>`);
    if (rv.total !== null) b.push(`<span class="small text-muted">Calculated ${inr(rv.total)}</span>`);
    let html = `<div class="ir-badges">${b.join("")}</div>`;
    if (rv.cost && rv.cost.direction && rv.cost.direction !== "same") {
      const c = rv.cost;
      html += `<div class="ir-cost ${c.direction}"><div><strong>Purchase cost ${c.direction === "up" ? "increased" : "decreased"}</strong>: ${inr(c.previous)} → ${inr(c.next)} per ${esc(rv.baseUnit || "unit")} (${c.change > 0 ? "+" : ""}${inr(c.change)}${c.percent !== null ? `, ${c.percent > 0 ? "+" : ""}${c.percent}%` : ""})${c.lastPurchase ? ` <span class="text-muted">· last bought on ${esc(c.lastPurchase.ref)}, ${esc(c.lastPurchase.date)} at ₹${c.lastPurchase.rate}</span>` : ""}</div>
        <label class="form-check mb-0"><input type="checkbox" class="form-check-input" data-update-price ${c.update ? "checked" : ""} ${locked ? "disabled" : ""}> <span class="form-check-label">Update the item's default purchase price to the new cost</span></label></div>`;
    } else if (rv.cost && rv.cost.previous === null && rv.cost.next !== null) {
      html += `<div class="ir-cost"><label class="form-check mb-0"><input type="checkbox" class="form-check-input" data-update-price ${rv.cost.update ? "checked" : ""} ${locked ? "disabled" : ""}> <span class="form-check-label">The item has no purchase price yet; save ${inr(rv.cost.next)} per ${esc(rv.baseUnit || "unit")} as its default</span></label></div>`;
    }
    if (rv.differentSize?.length) html += `<div class="small text-muted">Not matched to similar items of another size/variant: ${rv.differentSize.map((x) => esc(x.name)).join(", ")}</div>`;
    if (rv.flags.length) html += `<ul class="ir-flags">${rv.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`;
    if (rv.blockers.length) html += `<ul class="ir-blockers">${rv.blockers.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`;
    return html;
  }

  function renderRows() {
    $("[data-rows]").innerHTML = draft.rows.length ? draft.rows.map(rowHtml).join("") : `<p class="text-muted small mb-0">No item rows. ${locked ? "" : "Add the lines from the bill with “Add row”."}</p>`;
    $("[data-row-count]").textContent = `(${draft.rows.length})`;
    paintReview();
  }

  function paintReview() {
    S.draftKindIsPurchase = draft.documentKind === "invoice";
    draft.rows.forEach((r) => {
      const el = document.querySelector(`[data-row="${r.id}"]`);
      if (!el) return;
      const rv = review?.rows.find((x) => x.id === r.id);
      const area = $("[data-match-area]", el);
      if (!area.contains(document.activeElement)) area.innerHTML = matchHtml(r, rv);
      $("[data-status]", el).innerHTML = statusHtml(r, rv);
      el.classList.toggle("has-blockers", !!rv?.blockers.length);
    });
    const hint = $("[data-supplier-hint]");
    if (hint && review) {
      hint.innerHTML = !draft.supplierId && review.supplier.suggestions.length
        ? `Existing suppliers like this: ${review.supplier.suggestions.map((s) => `<button type="button" class="btn btn-link btn-sm p-0" data-pick-supplier="${s.id}">${esc(s.name)}</button>`).join(", ")}`
        : "";
    }
    if (!review) return;
    const t = review.totals;
    const isP = review.isPurchase;
    $("[data-checks]").innerHTML = `
      ${review.duplicates.bills.length ? `<div class="alert alert-danger"><strong>Possible duplicate.</strong> This supplier already has: ${review.duplicates.bills.map((b) => `<a href="/purchases/${b.id}" target="_blank">${esc(b.ref)} (${esc(b.date)}, ${inr(b.total)})</a>`).join(", ")}.<label class="form-check mt-1 mb-0"><input type="checkbox" class="form-check-input" data-ack="duplicateBill" ${draft.acknowledged.duplicateBill ? "checked" : ""} ${locked ? "disabled" : ""}> <span class="form-check-label">I checked: this is a different bill</span></label></div>` : ""}
      ${review.duplicates.files.length ? `<div class="alert ${review.duplicates.files.some((f) => f.status === "POSTED") ? "alert-danger" : "alert-warning"} small">The same file was uploaded before: ${review.duplicates.files.map((f) => `<a href="/purchases/import/${f.importId}">${esc(f.name)}</a> (${esc(f.status === "POSTED" ? "already confirmed as a purchase" : f.status.toLowerCase())})`).join(", ")}.${review.duplicates.files.some((f) => f.status === "POSTED") && !review.duplicates.bills.length ? `<label class="form-check mt-1 mb-0"><input type="checkbox" class="form-check-input" data-ack="duplicateBill" ${draft.acknowledged.duplicateBill ? "checked" : ""} ${locked ? "disabled" : ""}> <span class="form-check-label">I checked: this is a different bill</span></label>` : ""}</div>` : ""}
      ${isP ? `<section class="panel mb-3"><div class="panel-body import-totals">
        <div><span>Items</span><strong>${inr(t.subtotal)}</strong></div>
        <div><span>Bill discount</span><strong>${inr(-t.discount)}</strong></div>
        <div><span>Charges</span><strong>${inr(t.charges)}</strong></div>
        <div><span>Taxable</span><strong>${inr(t.taxable)}</strong></div>
        <div><span>GST (${review.intra ? "CGST + SGST" : "IGST"})</span><strong>${inr(t.tax)}</strong></div>
        <div><span>Round-off</span><strong>${inr(t.roundOff)}</strong></div>
        <div class="tot"><span>Calculated total</span><strong>${inr(t.total)}</strong></div>
        <div class="${t.mismatch ? "bad" : t.difference !== null ? "good" : ""}"><span>Bill's printed total</span><strong>${inr(t.printedTotal)}${t.difference !== null ? ` <small>(${t.mismatch ? "differs by " + inr(Math.abs(t.difference)) : "matches"})</small>` : ""}</strong></div>
        ${t.mismatch ? `<label class="form-check mb-0 span-all"><input type="checkbox" class="form-check-input" data-ack="totalsMismatch" ${draft.acknowledged.totalsMismatch ? "checked" : ""} ${locked ? "disabled" : ""}> <span class="form-check-label">I checked the difference; save with the calculated total</span></label>` : ""}
      </div></section>` : ""}`;
    const s = review.summary;
    const blockers = review.blockers;
    $("[data-summary]").innerHTML = locked
      ? `<p class="mb-0">${S.purchase ? `Saved as purchase <a href="/purchases/${S.purchase.id}">${esc(S.purchase.invoiceNo)}</a>.` : "Saved."}</p>`
      : `<h2 class="panel-title mb-2">Before you confirm</h2>
      ${isP ? `<div class="sum-grid">
        <div><div class="sum-label">Stock added</div>${s.stockItems.length ? `<ul>${s.stockItems.map((x) => `<li>${esc(x.name)}: +${x.quantity} ${esc(x.unit || "")}</li>`).join("")}</ul>` : "<p>—</p>"}</div>
        <div><div class="sum-label">New items</div>${s.newItems.length ? `<ul>${s.newItems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "<p>None</p>"}</div>
        <div><div class="sum-label">Default purchase price changes</div>${s.priceChanges.length ? `<ul>${s.priceChanges.map((x) => `<li>${esc(x.name)}: ${inr(x.from)} → ${inr(x.to)}${x.percent !== null ? ` (${x.percent > 0 ? "+" : ""}${x.percent}%)` : ""}</li>`).join("")}</ul>` : "<p>None</p>"}</div>
        <div><div class="sum-label">Bill total / outstanding</div><p class="mb-0"><strong>${inr(s.billTotal)}</strong> / ${inr(s.outstanding)} <span class="small text-muted">(saved unpaid)</span></p></div>
      </div>` : `<p>This document is a ${esc(KINDS[draft.documentKind] || draft.documentKind).toLowerCase()}: confirming creates the ${s.newItems.length} new item(s) only. No purchase is saved and stock does not change.</p>`}
      ${review.warnings.length ? `<ul class="ir-flags">${review.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${blockers.length ? `<div class="ir-blockers-box"><strong>${blockers.length} thing${blockers.length === 1 ? "" : "s"} to fix first:</strong><ul class="ir-blockers">${blockers.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      <div class="d-flex justify-content-end gap-2 flex-wrap mt-2"><span class="small text-muted align-self-center" data-saved></span>
        <button type="button" class="btn btn-outline-secondary" data-save-draft>Save draft</button>
        <button type="button" class="btn btn-primary" data-confirm-import ${blockers.length ? "disabled" : ""}><i class="icon-check"></i> ${isP ? "Confirm &amp; Save Purchase" : "Create items"}</button></div>`;
  }

  // ---------- Changes ----------
  function setPath(path, value) {
    const keys = path.split(".");
    let o = draft;
    while (keys.length > 1) o = o[keys.shift()];
    o[keys[0]] = value;
  }
  const NUMERIC = new Set(["quantity", "freeQuantity", "rate", "discountPercent", "discountAmount", "gstRate", "extractedLineTotal", "unitFactor"]);
  const NUMERIC_H = new Set(["invoiceDiscountAmount", "chargesAmount", "chargesGstRate", "roundOff", "extractedTotals.grand"]);
  function changed(structural) {
    if (structural) renderRows();
    scheduleReview();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraft(false), 1500);
  }
  function onInput(e) {
    const t = e.target;
    const rowEl = t.closest("[data-row]");
    const row = rowEl && draft.rows.find((r) => r.id === rowEl.dataset.row);
    if (t.dataset.h) {
      const v = t.type === "checkbox" ? t.checked : NUMERIC_H.has(t.dataset.h) ? num(t.value) : t.value.trim() === "" ? (t.dataset.h === "supplier.name" ? "" : null) : t.value;
      if (t.dataset.h === "supplier.gstin" && typeof v === "string") t.value = v.toUpperCase();
      setPath(t.dataset.h, t.dataset.h === "supplier.gstin" && v ? String(v).toUpperCase() : v);
      if (t.dataset.h === "supplierId") { $("[data-new-supplier]").classList.toggle("d-none", !!v); }
      return changed(t.dataset.h === "documentKind" || t.dataset.h === "supplierId");
    }
    if (row && t.dataset.r) {
      row[t.dataset.r] = t.type === "checkbox" ? t.checked : NUMERIC.has(t.dataset.r) ? num(t.value) : t.value.trim() || (t.dataset.r === "description" ? "" : null);
      if (["description", "supplierCode", "unit"].includes(t.dataset.r) && row.action === "match" && !row.matchConfirmed) row.productId = null;
      return changed(false);
    }
    if (row && t.dataset.np) {
      row.newProduct = row.newProduct || { name: row.description, unitName: row.unit || "Pieces", hsn: row.hsn, gstRate: row.gstRate, salePrice: null };
      row.newProduct[t.dataset.np] = ["gstRate", "salePrice"].includes(t.dataset.np) ? num(t.value) : t.value;
      row.autoNew = false;
      return changed(false);
    }
    if (row && t.matches("[data-confirm-match]")) { row.matchConfirmed = t.checked; return changed(false); }
    if (row && t.matches("[data-update-price]")) { row.updatePrice = t.checked; return changed(false); }
    if (t.matches("[data-ack]")) { draft.acknowledged[t.dataset.ack] = t.checked; return changed(false); }
  }
  function onMatchChange(e) {
    const t = e.target;
    if (!t.matches("[data-match]")) return false;
    const row = draft.rows.find((r) => r.id === t.closest("[data-row]").dataset.row);
    const v = t.value;
    if (v === "search") {
      const box = $("[data-search]", t.closest("[data-row]"));
      box.hidden = false;
      $("[data-search-input]", box).focus();
      return true;
    }
    row.autoNew = false; // the user's own choice is kept
    if (v === "create") { row.action = "create"; row.productId = null; row.newProduct = row.newProduct || { name: row.description, unitName: row.unit || "Pieces", hsn: row.hsn, gstRate: row.gstRate, salePrice: null }; }
    else if (v === "skip") row.action = "skip";
    else if (v.startsWith("p:")) { row.action = "match"; row.productId = v.slice(2); row.matchConfirmed = true; row.unitFactor = null; }
    changed(true);
    return true;
  }
  let searchTimer;
  document.addEventListener("input", (e) => {
    if (!$("[data-editor]").contains(e.target)) return;
    if (e.target.matches("[data-search-input]")) {
      clearTimeout(searchTimer);
      const box = e.target.closest("[data-search]");
      const q = e.target.value.trim();
      searchTimer = setTimeout(async () => {
        if (!q) { $("[data-search-results]", box).innerHTML = ""; return; }
        const res = await fetch(`/api/products/search?q=${encodeURIComponent(q)}`);
        const data = await res.json().catch(() => ({ results: [] }));
        $("[data-search-results]", box).innerHTML = (data.results || []).map((p) => `<button type="button" class="btn btn-sm btn-outline-secondary" data-choose="${p.id}">${esc(p.name)}${p.unitName ? " · " + esc(p.unitName) : ""}</button>`).join("") || `<span class="small text-muted">No items found.</span>`;
      }, 250);
      return;
    }
    onInput(e);
  });
  document.addEventListener("change", (e) => {
    if (!$("[data-editor]").contains(e.target)) return;
    if (onMatchChange(e)) return;
    if (e.target.type === "checkbox" || e.target.tagName === "SELECT") onInput(e);
  });
  document.addEventListener("click", (e) => {
    const editor = $("[data-editor]");
    if (!editor.contains(e.target)) return;
    const choose = e.target.closest("[data-choose]");
    if (choose) {
      const row = draft.rows.find((r) => r.id === choose.closest("[data-row]").dataset.row);
      Object.assign(row, { action: "match", productId: choose.dataset.choose, matchConfirmed: true, unitFactor: null });
      return changed(true);
    }
    if (e.target.closest("[data-del]")) {
      const id = e.target.closest("[data-row]").dataset.row;
      draft.rows = draft.rows.filter((r) => r.id !== id);
      return changed(true);
    }
    if (e.target.closest("[data-add-row]")) {
      draft.rows.push({ id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), description: "", supplierCode: null, barcode: null, hsn: null, quantity: null, freeQuantity: null, unit: null, packNote: null, unitFactor: null, rate: null, rateIncludesTax: false, discountPercent: null, discountAmount: null, gstRate: null, extractedLineTotal: null, uncertain: [], action: "match", productId: null, matchConfirmed: false, newProduct: null, updatePrice: null });
      changed(true);
      const rows = document.querySelectorAll("[data-row]");
      $("[data-r=description]", rows[rows.length - 1]).focus();
      return;
    }
    const pick = e.target.closest("[data-pick-supplier]");
    if (pick) { draft.supplierId = pick.dataset.pickSupplier; render(); return changed(false); }
    if (e.target.closest("[data-map-apply]")) return applyMapping();
    if (e.target.closest("[data-save-draft]")) return saveDraft(true);
    if (e.target.closest("[data-confirm-import]")) return confirm();
  });

  async function applyMapping() {
    const columns = {};
    document.querySelectorAll("[data-map-col]").forEach((s) => { columns[s.dataset.mapCol] = s.value === "" ? null : Number(s.value); });
    const res = await fetch(`/api/purchase-imports/${S.id}/remap`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partIndex: Number($("[data-map=part]").value), headerRow: Math.max(0, Number($("[data-map=header]").value) - 1), columns, draft }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return window.AppDialog && window.AppDialog.alert({ title: "Could not read the table", message: body.error || "Try other columns." });
    draft = body.draft;
    render();
    changed(false);
  }

  function scheduleReview() {
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(runReview, 350);
  }
  async function runReview() {
    const seq = ++reviewSeq;
    try {
      const res = await fetch(`/api/purchase-imports/${S.id}/review`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(draft) });
      const body = await res.json();
      if (seq !== reviewSeq) return;
      if (res.ok) {
        review = body;
        // Keep the draft in step with matches the server applied (remembered mappings, exact codes)
        review.rows.forEach((rv) => {
          const row = draft.rows.find((r) => r.id === rv.id);
          if (row && row.action === "match" && !row.productId && rv.product && (rv.status === "remembered" || rv.status === "code")) { row.productId = rv.product.id; row.matchConfirmed = true; }
          if (row && row.action === "create" && row.autoNew && rv.product && (rv.status === "remembered" || rv.status === "code")) Object.assign(row, { action: "match", productId: rv.product.id, matchConfirmed: true, autoNew: false });
        });
        paintReview();
      }
    } catch (err) {
      if (window.AppConnection) window.AppConnection.lost();
    }
  }
  async function saveDraft(manual) {
    if (locked) return;
    clearTimeout(saveTimer);
    const res = await fetch(`/api/purchase-imports/${S.id}/draft`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) }).catch(() => null);
    const el = $("[data-saved]");
    if (res && res.ok) { if (el) el.textContent = "Draft saved " + new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }); }
    else if (manual && window.AppDialog) window.AppDialog.alert({ title: "Draft not saved", message: "The draft could not be saved. Check the connection and try again." });
  }
  let confirming = false;
  async function confirm() {
    if (confirming || !review || review.blockers.length) return;
    confirming = true;
    const btn = $("[data-confirm-import]");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Saving…';
    try {
      const res = await fetch(`/api/purchase-imports/${S.id}/confirm`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(draft) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.redirect) { if (window.AppNav) window.AppNav.leave(body.redirect); else location.href = body.redirect; return; }
      if (window.AppDialog) await window.AppDialog.alert({ title: "Not saved", message: body.error || "The purchase could not be saved. Nothing was changed." });
    } catch (err) {
      if (window.AppDialog) await window.AppDialog.alert({ title: "Not saved", message: "No connection to the server. Nothing was changed; try again." });
    }
    confirming = false;
    runReview();
  }

  function render() {
    $("[data-editor]").innerHTML = editorShell();
    renderRows();
  }
  function start() {
    renderDoc();
    $("[data-scan]").innerHTML = "";
    if (S.status === "FAILED") showScanPanel(S.error || "The document could not be read.", true, "danger");
    if (!draft) { $("[data-editor]").innerHTML = ""; return; }
    if (!locked && (S.status === "DRAFT" || S.status === "NEEDS_SETUP")) showScanPanel(S.extractor ? "Read on this computer. Check every value against the document before confirming." : "Read the bill again after fixing the problem above — your edits are kept.", true, "light");
    render();
    runReview();
  }

  renderDoc();
  if (S.status === "UPLOADED" || S.status === "EXTRACTING" || (/[?&]scan=1/.test(location.search) && !draft)) runExtract();
  else start();
})();
