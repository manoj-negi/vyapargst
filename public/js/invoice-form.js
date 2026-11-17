(function () {
  const tbody = document.getElementById("itemsTbody");
  const addRowBtn = document.getElementById("addRowBtn");
  const rowTemplate = document.getElementById("itemRowTemplate");
  const customerSelect = document.getElementById("customerSelect");
  const placeOfSupplyBadge = document.getElementById("placeOfSupplyBadge");
  const invoiceDiscountValue = document.getElementById("invoiceDiscountValue");
  const invoiceDiscountType = document.getElementById("invoiceDiscountType");
  const receivedInput = document.getElementById("receivedInput");
  const manualRoundOffValue = document.getElementById("manualRoundOffValue");
  const balanceDisplay = document.getElementById("balanceDisplay");
  const paymentStatusBadge = document.getElementById("paymentStatusBadge");
  const form = document.getElementById("invoiceForm");
  const showCgstSgstCols = document.querySelectorAll(".col-cgst-sgst");
  const showIgstCols = document.querySelectorAll(".col-igst");
  const stickyTotalDisplay = document.getElementById("stickyTotalDisplay");
  const itemCountDisplay = document.getElementById("itemCountDisplay");

  if (!tbody || !form) return;

  const businessState = (form.dataset.businessState || "").trim().toLowerCase();
  const isPurchase = form.dataset.side === "PURCHASE";
  const chargesAmount = document.getElementById("chargesAmount");
  const chargesTaxRate = document.getElementById("chargesTaxRate");
  let rowCounter = 0;
  let debounceTimer;

  function money(n) {
    return `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function addRow(prefill) {
    const idx = rowCounter++;
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("tr");
    row.dataset.index = idx;
    row.querySelectorAll("[data-name]").forEach((el) => {
      el.name = `items[${idx}][${el.dataset.name}]`;
    });
    tbody.appendChild(row);
    renumberRows();
    wireRow(row);
    if (prefill) applyProductToRow(row, prefill);
    return row;
  }

  function renumberRows() {
    const rows = tbody.querySelectorAll("tr");
    rows.forEach((row, i) => {
      const numCell = row.querySelector(".row-number");
      if (numCell) numCell.textContent = i + 1;
    });
    if (itemCountDisplay) itemCountDisplay.textContent = `${rows.length} ${rows.length === 1 ? "item" : "items"}`;
  }

  function wireRow(row) {
    const nameInput = row.querySelector(".item-name-input");
    const qtyInput = row.querySelector(".qty-input");
    const priceInput = row.querySelector(".price-input");
    const discountInput = row.querySelector(".discount-input");
    const discountTypeSelect = row.querySelector(".discount-type-select");
    const removeBtn = row.querySelector(".remove-row-btn");
    const menu = row.querySelector(".autocomplete-menu");

    let acDebounce;
    nameInput.addEventListener("input", () => {
      row.querySelector(".product-id-input").value = "";
      clearTimeout(acDebounce);
      const q = nameInput.value.trim();
      if (q.length < 1) {
        menu.innerHTML = "";
        return;
      }
      acDebounce = setTimeout(async () => {
        try {
          const res = await fetch(`/api/products/search?q=${encodeURIComponent(q)}`);
          if (!res.ok) return;
          const data = await res.json();
          if (document.activeElement !== nameInput) return;
          renderAutocomplete(menu, row, data.results || []);
        } catch (err) {
          console.error("Product search failed", err);
        }
      }, 250);
    });

    nameInput.addEventListener("blur", () => {
      setTimeout(() => closeMenu(menu, nameInput), 150);
    });

    // Keyboard: ↑/↓ move through suggestions, Enter picks, Esc closes
    nameInput.addEventListener("keydown", (e) => {
      const items = Array.from(menu.querySelectorAll(".autocomplete-item[data-index]"));
      if (!items.length) return;
      let current = items.findIndex((el) => el.classList.contains("active"));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        current = e.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle("active", i === current));
        items[current].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && current >= 0) {
        e.preventDefault();
        e.stopPropagation();
        items[current].dispatchEvent(new MouseEvent("mousedown"));
      } else if (e.key === "Escape") {
        closeMenu(menu, nameInput);
      }
    });

    [qtyInput, priceInput, discountInput, discountTypeSelect].forEach((el) => {
      el.addEventListener("input", scheduleRecalc);
      el.addEventListener("change", scheduleRecalc);
    });
    // Only the user types here (the code sets values directly), so any event is a manual edit,
    // which a previous discount found later never replaces
    [discountInput, discountTypeSelect].forEach((el) => {
      el.addEventListener("input", () => markDiscountTouched(row));
      el.addEventListener("change", () => markDiscountTouched(row));
    });
    row.querySelector(".disc-hint").addEventListener("click", (e) => {
      const use = e.target.closest("[data-use-previous]");
      if (!use || !row._history) return;
      setRowDiscount(row, row._history.discountValue, row._history.discountType);
      row.dataset.discSource = "history";
      row.dataset.discTouched = "1";
      renderDiscountHint(row);
    });

    removeBtn.addEventListener("click", () => {
      row.remove();
      renumberRows();
      scheduleRecalc();
    });
  }

  // The menu is position: fixed so the table's scroll container can't clip it
  // Opens below the input, or above it when there is not enough room below; kept inside the window
  function positionMenu(menu, input) {
    const rect = input.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const openUp = below < 220 && above > below;
    menu.style.maxHeight = `${Math.max(140, Math.min(300, openUp ? above : below))}px`;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    if (openUp) {
      menu.style.top = "auto";
      menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
      menu.style.bottom = "auto";
      menu.style.top = `${rect.bottom + 4}px`;
    }
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function closeMenu(menu, input) {
    menu.innerHTML = "";
    if (input) input.setAttribute("aria-expanded", "false");
  }

  function renderAutocomplete(menu, row, results) {
    const input = row.querySelector(".item-name-input");
    positionMenu(menu, input);
    const typed = input.value.trim();
    const createOption = typed
      ? `<div class="autocomplete-item ac-create" data-index="${results.length}" data-create="1" role="option"><i class="icon-plus"></i> Create item “${escapeHtml(typed)}”</div>`
      : "";
    menu.innerHTML =
      (results.length === 0 ? `<div class="autocomplete-item text-muted">No matching items</div>` : "") +
      results
        .map((p, i) => {
          const price = isPurchase ? p.purchasePrice : p.salePrice;
          const stock = p.isService ? "Service" : `Stock ${Number(p.currentStock)}${p.unitName ? " " + escapeHtml(p.unitName) : ""}`;
          return `
      <div class="autocomplete-item${i === 0 ? " active" : ""}" data-id="${p.id}" data-index="${i}" role="option">
        <div class="d-flex justify-content-between gap-2"><span>${escapeHtml(p.name)}</span><span class="num">${money(price)}</span></div>
        <div class="ac-sub">${[p.itemCode, p.hsnCode ? "HSN " + p.hsnCode : "", stock].filter(Boolean).map(escapeHtml).join(" · ")}</div>
      </div>`;
        })
        .join("") +
      createOption;
    input.setAttribute("aria-expanded", "true");
    menu.querySelectorAll(".autocomplete-item[data-id]").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const product = results.find((p) => p.id === item.dataset.id);
        applyProductToRow(row, product);
        closeMenu(menu, input);
        row.querySelector(".qty-input").focus();
        row.querySelector(".qty-input").select();
      });
    });
    const create = menu.querySelector("[data-create]");
    if (create) {
      create.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeMenu(menu, input);
        openNewItemModal(row, typed);
      });
    }
  }

  function applyProductToRow(row, product) {
    row.querySelector(".item-name-input").value = product.name;
    row.querySelector(".product-id-input").value = product.id;
    row.querySelector(".hsn-input").value = product.hsnCode || "";
    row.querySelector(".unit-input").value = product.unitName || "";
    row.querySelector(".unit-display").textContent = product.unitName || "-";
    const price = isPurchase ? product.purchasePrice : product.salePrice;
    row.querySelector(".price-input").value = Number(price || 0).toFixed(2);
    row.querySelector(".price-type-input").value = (isPurchase ? product.purchasePriceType : product.priceType) || "EXCLUSIVE";
    row.querySelector(".gst-rate-input").value = product.gstRate || 0;
    row.querySelector(".gst-rate-cell-label").textContent = Number(product.gstRate || 0) === 0 ? 'Exempt' : `${product.gstRate || 0}%`;
    if (!isPurchase && product.defaultDiscount != null) {
      row.querySelector(".discount-input").value = Number(product.defaultDiscount).toFixed(2);
      row.querySelector(".discount-type-select").value = product.defaultDiscountType || "PERCENTAGE";
    }
    // A newly chosen item starts from its default discount; the customer's previous one replaces it when found
    row._defaultDiscount = { value: row.querySelector(".discount-input").value, type: row.querySelector(".discount-type-select").value };
    row.dataset.discSource = "default";
    row.dataset.discTouched = "";
    row._history = null;
    renderDiscountHint(row);
    refreshRowHistory(row, true);
    row.dataset.availableStock = product.currentStock;
    const hint = row.querySelector(".stock-hint");
    if (hint) {
      const stock = Number(product.currentStock);
      hint.textContent = product.isService ? "" : `In stock: ${stock}${product.unitName ? " " + product.unitName : ""}`;
      hint.classList.toggle("low", !product.isService && stock <= 0);
    }
    scheduleRecalc();
  }

  function updatePlaceOfSupply() {
    const opt = customerSelect.options[customerSelect.selectedIndex];
    const customerState = (opt?.dataset.state || "").trim().toLowerCase();
    const isIntra = customerState && customerState === businessState;
    if (!customerState) {
      placeOfSupplyBadge.textContent = isPurchase ? "Select a supplier" : "Select a customer";
      placeOfSupplyBadge.className = "badge text-bg-secondary";
      return;
    }
    if (isIntra) {
      placeOfSupplyBadge.textContent = "Intra-State (CGST + SGST)";
      placeOfSupplyBadge.className = "badge text-bg-primary";
      showCgstSgstCols.forEach((el) => el.classList.remove("d-none"));
      showIgstCols.forEach((el) => el.classList.add("d-none"));
    } else {
      placeOfSupplyBadge.textContent = "Inter-State (IGST)";
      placeOfSupplyBadge.className = "badge text-bg-warning text-dark";
      showCgstSgstCols.forEach((el) => el.classList.add("d-none"));
      showIgstCols.forEach((el) => el.classList.remove("d-none"));
    }
  }

  function collectPayload() {
    const opt = customerSelect.options[customerSelect.selectedIndex];
    const customerState = opt?.dataset.state || "";
    const items = Array.from(tbody.querySelectorAll("tr")).map((row) => ({
      productId: row.querySelector(".product-id-input").value || null,
      productName: row.querySelector(".item-name-input").value,
      hsn: row.querySelector(".hsn-input").value,
      unit: row.querySelector(".unit-input").value,
      quantity: Number(row.querySelector(".qty-input").value || 0),
      unitPrice: Number(row.querySelector(".price-input").value || 0),
      priceType: row.querySelector(".price-type-input").value,
      discountValue: Number(row.querySelector(".discount-input").value || 0),
      discountType: row.querySelector(".discount-type-select").value,
      gstRate: Number(row.querySelector(".gst-rate-input").value || 0),
    })).filter((i) => i.productName && i.quantity > 0);

    return {
      customerState,
      items,
      invoiceDiscount: {
        value: Number(invoiceDiscountValue.value || 0),
        type: invoiceDiscountType.value,
      },
      charges: {
        amount: Number((chargesAmount && chargesAmount.value) || 0),
        gstRate: Number((chargesTaxRate && chargesTaxRate.value) || 0),
      },
      manualRoundOff: document.getElementById('manualRoundOffValue') && document.getElementById('manualRoundOffValue').value !== "" ? Number(document.getElementById('manualRoundOffValue').value) : undefined,
    };
  }

  async function recalc() {
    updatePlaceOfSupply();
    const payload = collectPayload();
    if (payload.items.length === 0) {
      resetTotalsDisplay();
      return;
    }
    try {
      const res = await fetch("/api/invoices/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data && data.error && window.showToast) window.showToast(data.error, "danger");
        return;
      }
      applyCalculation(data);
      profitAfterRecalc();
    } catch (err) {
      console.error("Calculation failed", err);
    }
  }

  function scheduleRecalc() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recalc, 300);
  }

  function applyCalculation(data) {
    const rows = tbody.querySelectorAll("tr");
    data.lines.forEach((line, i) => {
      const row = rows[i];
      if (!row) return;
      row.querySelector(".taxable-cell").textContent = money(line.taxableValue);
      row.querySelector(".cgst-cell").textContent = money(line.cgst);
      row.querySelector(".sgst-cell").textContent = money(line.sgst);
      row.querySelector(".igst-cell").textContent = money(line.igst);
      row.querySelector(".total-cell").textContent = money(line.total);
    });

    document.getElementById("subtotalDisplay").textContent = money(data.totals.subtotal);
    document.getElementById("discountDisplay").textContent = money(data.totals.discount);
    const chargesDisplay = document.getElementById("chargesDisplay");
    if (chargesDisplay) chargesDisplay.textContent = money((data.totals.charges || 0) + (data.totals.chargesTax || 0));
    document.getElementById("taxableDisplay").textContent = money(data.totals.taxableAmount);
    document.getElementById("cgstDisplay").textContent = money(data.totals.cgst);
    document.getElementById("sgstDisplay").textContent = money(data.totals.sgst);
    document.getElementById("igstDisplay").textContent = money(data.totals.igst);
    document.getElementById("cessDisplay").textContent = money(data.totals.cess);
    document.getElementById("roundOffDisplay").textContent = money(data.totals.roundOff);
    document.getElementById("grandTotalDisplay").textContent = money(data.totals.total);
    if (stickyTotalDisplay) stickyTotalDisplay.textContent = money(data.totals.total);
    document.getElementById("grandTotalHidden").value = data.totals.total;

    updatePaymentStatus(data.totals.total);
  }

  function resetTotalsDisplay() {
    profitAfterRecalc();
    ["subtotalDisplay", "discountDisplay", "taxableDisplay", "cgstDisplay", "sgstDisplay", "igstDisplay", "cessDisplay", "roundOffDisplay", "grandTotalDisplay"].forEach(
      (id) => (document.getElementById(id).textContent = money(0))
    );
    if (stickyTotalDisplay) stickyTotalDisplay.textContent = money(0);
    updatePaymentStatus(0);
    tbody.querySelectorAll(".taxable-cell, .cgst-cell, .sgst-cell, .igst-cell, .total-cell").forEach((c) => (c.textContent = money(0)));
  }

  function updatePaymentStatus(total) {
    if (!receivedInput) return;
    const received = Number(receivedInput.value || 0);
    const balance = Math.max(total - received, 0);
    balanceDisplay.textContent = money(balance);
    const stickyBalance = document.getElementById("stickyBalanceDisplay");
    if (stickyBalance) stickyBalance.textContent = money(balance);

    if (received <= 0) {
      paymentStatusBadge.textContent = "Unpaid";
      paymentStatusBadge.className = "status-badge status-unpaid";
    } else if (received >= total && total > 0) {
      paymentStatusBadge.textContent = "Paid";
      paymentStatusBadge.className = "status-badge status-paid";
    } else {
      paymentStatusBadge.textContent = "Partly paid";
      paymentStatusBadge.className = "status-badge status-partial";
    }
  }

  addRowBtn.addEventListener("click", () => addRow().querySelector(".item-name-input").focus());

  // Enter moves to the next field in the row; on the last field of the last row it adds a new row.
  tbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.matches(".item-name-input[aria-expanded='true']")) return;
    const row = e.target.closest("tr");
    if (!row) return;
    e.preventDefault();
    const fields = Array.from(row.querySelectorAll("input:not([type=hidden]), select"));
    const next = fields[fields.indexOf(e.target) + 1];
    if (next) { next.focus(); if (next.select) next.select(); return; }
    const nextRow = row.nextElementSibling || addRow();
    nextRow.querySelector(".item-name-input").focus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      addRow().querySelector(".item-name-input").focus();
    }
  });

  // "New item" dialog: saves the item and fills it into the row it was opened from (or a new row)
  const newItemModalEl = document.getElementById("newItemModal");
  const newItemForm = document.getElementById("newItemForm");
  let newItemTargetRow = null;
  function openNewItemModal(row, name) {
    if (!newItemModalEl || !window.bootstrap) return;
    newItemTargetRow = row || null;
    newItemForm.reset();
    newItemForm.elements.name.value = name || "";
    window.bootstrap.Modal.getOrCreateInstance(newItemModalEl).show();
  }
  if (newItemModalEl) {
    newItemModalEl.addEventListener("show.bs.modal", (e) => {
      // Opened from the "New item" button rather than from search: fill an empty row if there is one
      if (e.relatedTarget) {
        newItemForm.reset();
        newItemTargetRow = Array.from(tbody.querySelectorAll("tr")).find((r) => !r.querySelector(".item-name-input").value.trim()) || null;
      }
      document.getElementById("newItemErrors").classList.add("d-none");
    });
    newItemModalEl.addEventListener("shown.bs.modal", () => newItemForm.elements.name.focus());
    newItemForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!newItemForm.checkValidity()) { newItemForm.reportValidity(); return; }
      const saveBtn = document.getElementById("newItemSave");
      const errorsBox = document.getElementById("newItemErrors");
      saveBtn.disabled = true;
      try {
        const res = await fetch("/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(Object.fromEntries(new FormData(newItemForm))),
        });
        const body = await res.json();
        if (!res.ok) {
          errorsBox.innerHTML = "<ul class='mb-0'>" + (body.errors || [body.error || "Could not save the item"]).map((m) => `<li>${escapeHtml(m)}</li>`).join("") + "</ul>";
          errorsBox.classList.remove("d-none");
          return;
        }
        const row = newItemTargetRow && document.body.contains(newItemTargetRow) ? newItemTargetRow : addRow();
        applyProductToRow(row, body.product);
        // Bootstrap ignores hide() while the open animation is still running, so retry after it
        const instance = window.bootstrap.Modal.getInstance(newItemModalEl);
        instance.hide();
        setTimeout(() => { if (newItemModalEl.classList.contains("show")) instance.hide(); }, 400);
        if (window.showToast) window.showToast(`Item “${escapeHtml(body.product.name)}” saved.`);
        row.querySelector(".qty-input").focus();
      } catch (err) {
        errorsBox.textContent = "Network error — please try again.";
        errorsBox.classList.remove("d-none");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // A fixed menu would drift away from its input on scroll, so close it instead
  window.addEventListener(
    "scroll",
    (e) => {
      if (e.target instanceof Element && e.target.closest(".autocomplete-menu")) return;
      tbody.querySelectorAll(".autocomplete-menu").forEach((m) => (m.innerHTML = ""));
    },
    true
  );
  window.addEventListener("resize", () => tbody.querySelectorAll(".autocomplete-menu").forEach((m) => (m.innerHTML = "")));
  customerSelect.addEventListener("change", scheduleRecalc);

  // Section and Department suggestions for the chosen customer (saved on its earlier invoices)
  const sectionInput = document.getElementById("sectionInput");
  const departmentInput = document.getElementById("departmentInput");
  const sectionList = document.getElementById("sectionList");
  const departmentList = document.getElementById("departmentList");
  function fillList(list, values) {
    if (!list) return;
    list.innerHTML = "";
    (values || []).forEach((v) => {
      const option = document.createElement("option");
      option.value = v;
      list.appendChild(option);
    });
  }
  async function loadDivisionSuggestions() {
    if (!sectionList && !departmentList) return;
    fillList(sectionList, []);
    fillList(departmentList, []);
    const partyId = customerSelect.value;
    if (!partyId) return;
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(partyId)}/departments`, { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = await res.json();
      if (customerSelect.value !== partyId) return; // answer for a party that is no longer selected
      fillList(sectionList, data.sections);
      fillList(departmentList, data.departments);
    } catch (err) {
      console.error("Could not load sections and departments", err);
    }
  }
  customerSelect.addEventListener("change", loadDivisionSuggestions);
  loadDivisionSuggestions();

  // Section and Department from the selected party's own saved fields (customer.section / .department,
  // carried on each option as data-section / data-department). They stay editable for this invoice and
  // are never written back to the party. Switching party replaces values that were filled from the
  // previous party (clearing them when the new party has none); values the user typed are only
  // replaced after asking. An opened invoice keeps its saved values: nothing is filled on load.
  const partyDivision = (opt) => ({ section: (opt && opt.dataset.section) || "", department: (opt && opt.dataset.department) || "" });
  const divisionFields = [["section", sectionInput, "Section"], ["department", departmentInput, "Department"]].filter((f) => f[1]);
  // What was last filled from a party; a field whose value differs was typed by the user
  let filledFromParty = partyDivision(customerSelect.options[customerSelect.selectedIndex]);
  let partySeq = 0;
  async function onPartyChange() {
    const seq = ++partySeq;
    const next = customerSelect.value ? partyDivision(customerSelect.options[customerSelect.selectedIndex]) : { section: "", department: "" };
    const usable = divisionFields.filter((f) => !f[1].disabled); // an unclassified older value is left for the user to classify
    const typed = usable.filter(([key, el]) => {
      const v = el.value.trim();
      return v && v !== filledFromParty[key] && v !== next[key];
    });
    let replaceTyped = true;
    if (typed.length && window.AppDialog) {
      const opt = customerSelect.options[customerSelect.selectedIndex];
      const party = opt && opt.value ? opt.textContent.split(" · ")[0].trim() : "no party";
      const result = await window.AppDialog.confirm({
        title: "Replace Section and Department?",
        message:
          `You entered ${typed.map(([, el, label]) => `${label} “${el.value.trim()}”`).join(" and ")}. ` +
          `${party} has ${usable.map(([key, , label]) => `${label} ${next[key] ? `“${next[key]}”` : "blank"}`).join(", ")}. Use the party's values?`,
        icon: "info",
        confirmLabel: "Use party's values",
        cancelLabel: "Keep my values",
      });
      if (seq !== partySeq) return; // another party was picked while the dialog was open
      replaceTyped = result.confirmed;
    }
    usable.forEach(([key, el]) => {
      if (!replaceTyped && typed.some((f) => f[1] === el)) return;
      el.value = next[key];
    });
    filledFromParty = next;
    onHistoryContextChange();
  }
  customerSelect.addEventListener("change", onPartyChange);

  // An older value saved under the combined "Section / Department" label: the user says which it is.
  // The text moves into that field unchanged; until then it is sent back as it was.
  const legacyBox = document.getElementById("legacyDivision");
  if (legacyBox) {
    const text = legacyBox.dataset.text;
    const body = legacyBox.querySelector("[data-legacy-body]");
    legacyBox.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-classify]");
      if (!btn) return;
      const target = btn.dataset.classify === "section" ? sectionInput : departmentInput;
      sectionInput.disabled = false;
      departmentInput.disabled = false;
      if (!target.value.trim()) target.value = text;
      legacyBox.querySelector("[data-legacy-flag]").value = "0";
      legacyBox.querySelector("[data-legacy-value]").disabled = true;
      legacyBox.classList.add("done");
      body.innerHTML = `<div>Saved as <strong>${btn.dataset.classify === "section" ? "Section" : "Department"}</strong> when you save this invoice. The original text “${escapeHtml(text)}” is kept in its history.</div>`;
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.focus();
    });
  }

  // ---------- Previous discounts (sale invoices) ----------
  // When an item is added for a customer, the discount last given to that customer for the same
  // item (same section / department first) is filled in, from saved invoices only. A discount the
  // user typed is never replaced without asking; changing the party or section / department offers
  // to apply the matching previous discounts.
  const discountHistoryOn = form.dataset.discountHistory === "1";
  const editingInvoiceId = form.dataset.invoiceId || "";
  const historyCache = new Map();

  function cleanText(el) {
    return el && !el.disabled ? el.value.trim().replace(/\s+/g, " ") : "";
  }
  function historyContext() {
    return { customerId: customerSelect.value, section: cleanText(sectionInput), department: cleanText(departmentInput) };
  }
  function contextKey(ctx) {
    return [ctx.customerId, ctx.section.toLowerCase(), ctx.department.toLowerCase()].join("|");
  }
  async function historyFor(ctx, productIds) {
    if (!ctx.customerId) return new Map();
    const key = contextKey(ctx);
    if (!historyCache.has(key)) historyCache.set(key, new Map());
    const cache = historyCache.get(key);
    const missing = Array.from(new Set(productIds)).filter((id) => !cache.has(id));
    if (missing.length) {
      const params = new URLSearchParams({ customerId: ctx.customerId, productIds: missing.join(",") });
      if (ctx.section) params.set("section", ctx.section);
      if (ctx.department) params.set("department", ctx.department);
      if (editingInvoiceId) params.set("excludeId", editingInvoiceId);
      const res = await fetch(`/api/invoices/previous-discounts?${params}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Previous discounts: HTTP ${res.status}`);
      const data = await res.json();
      missing.forEach((id) => cache.set(id, (data.discounts && data.discounts[id]) || null));
    }
    return cache;
  }

  function productIdOf(row) {
    return row.querySelector(".product-id-input").value;
  }
  function setRowDiscount(row, value, type) {
    row.querySelector(".discount-input").value = Number(value).toFixed(2);
    row.querySelector(".discount-type-select").value = type;
    scheduleRecalc();
  }
  function markDiscountTouched(row) {
    if (!discountHistoryOn) return;
    row.dataset.discTouched = "1";
    renderDiscountHint(row);
  }
  function discountLabel(value, type) {
    const n = Number(value);
    const shown = n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    // FIXED is an amount off the whole line, as saved; it is shown and reused that way
    return type === "PERCENTAGE" ? `${shown}%` : `₹${shown} off the line`;
  }
  function divisionLabel(h) {
    const parts = [];
    if (h.section) parts.push(`Section ${h.section}`);
    if (h.department) parts.push(`Department ${h.department}`);
    if (h.unclassified) parts.push(h.unclassified);
    return parts.join(", ");
  }
  function sameDiscount(row, h) {
    return Number(row.querySelector(".discount-input").value || 0) === Number(h.discountValue) && row.querySelector(".discount-type-select").value === h.discountType;
  }
  function renderDiscountHint(row) {
    const hint = row.querySelector(".disc-hint");
    if (!hint) return;
    const h = discountHistoryOn ? row._history : null;
    if (!h) {
      hint.innerHTML = "";
      hint.removeAttribute("title");
      return;
    }
    const ctx = historyContext();
    const scoped = ctx.section || ctx.department;
    const where = divisionLabel(h);
    const what = ctx.section && ctx.department ? "section & department" : ctx.section ? "section" : "department";
    // Where the discount came from: the same section / department, or the party's other invoices
    const source =
      h.match === "division"
        ? `Same ${what}`
        : scoped
          ? `No history for this ${what}; from this party (${where || "no section / department"})`
          : where ? `From ${where}` : "";
    const main = `Previous discount: ${discountLabel(h.discountValue, h.discountType)} · ${h.invoiceNo} · ${h.invoiceDateLabel}`;
    const differs = !sameDiscount(row, h);
    hint.classList.toggle("fallback", h.match === "party" && !!scoped);
    hint.title = [main, source].filter(Boolean).join("\n");
    hint.innerHTML =
      `<span class="disc-hint-main">${escapeHtml(main)}</span>` +
      (source ? `<span class="disc-hint-src">${escapeHtml(source)}</span>` : "") +
      (differs ? `<button type="button" class="disc-hint-use" data-use-previous>Use ${escapeHtml(discountLabel(h.discountValue, h.discountType))}</button>` : "");
  }

  /** Looks up this row's item; apply=true fills the previous discount unless the user already changed it. */
  async function refreshRowHistory(row, apply) {
    if (!discountHistoryOn) return;
    const pid = productIdOf(row);
    if (!pid) return;
    const ctx = historyContext();
    const key = contextKey(ctx);
    const token = (row._historyToken = (row._historyToken || 0) + 1);
    let cache;
    try {
      cache = await historyFor(ctx, [pid]);
    } catch (err) {
      console.error(err);
      return;
    }
    // Ignore answers that arrive after the item, the party or the section / department changed
    if (token !== row._historyToken || productIdOf(row) !== pid || contextKey(historyContext()) !== key || !row.isConnected) return;
    row._history = cache.get(pid) || null;
    if (apply && row._history && row.dataset.discTouched !== "1") {
      setRowDiscount(row, row._history.discountValue, row._history.discountType);
      row.dataset.discSource = "history";
    }
    renderDiscountHint(row);
  }

  let contextSeq = 0;
  let lastContextKey = contextKey(historyContext());
  async function onHistoryContextChange() {
    if (!discountHistoryOn) return;
    const ctx = historyContext();
    const key = contextKey(ctx);
    if (key === lastContextKey) return;
    lastContextKey = key;
    const seq = ++contextSeq;
    const rows = Array.from(tbody.querySelectorAll("tr")).filter((r) => productIdOf(r));
    rows.forEach((r) => (r._historyToken = (r._historyToken || 0) + 1)); // drop lookups for the old party
    if (!rows.length) return;
    let cache;
    try {
      cache = await historyFor(ctx, rows.map(productIdOf));
    } catch (err) {
      console.error(err);
      return;
    }
    if (seq !== contextSeq) return;

    const changes = [];
    rows.forEach((row) => {
      const h = cache.get(productIdOf(row)) || null;
      row._history = h;
      if (h) {
        if (!sameDiscount(row, h)) changes.push({ row, value: h.discountValue, type: h.discountType, source: "history" });
        else row.dataset.discSource = "history";
      } else if (ctx.customerId && row.dataset.discSource === "history" && row.dataset.discTouched !== "1" && row._defaultDiscount) {
        // Filled from the previous party's history, which no longer applies: offer the item's default
        const d = row._defaultDiscount;
        if (Number(row.querySelector(".discount-input").value || 0) !== Number(d.value) || row.querySelector(".discount-type-select").value !== d.type) {
          changes.push({ row, value: d.value, type: d.type, source: "default" });
        }
      }
    });
    rows.forEach(renderDiscountHint);
    if (!changes.length || !window.AppDialog) return;

    // The party's name without the section and phone shown in the list
    const name = (opt) => (opt ? opt.textContent.split(" (")[0].split(" · ")[0].trim() : "");
    const party = name(customerSelect.options[customerSelect.selectedIndex]);
    const fromHistory = changes.filter((c) => c.source === "history");
    const toDefault = changes.length - fromHistory.length;
    const itemName = (c) => c.row.querySelector(".item-name-input").value.trim();
    const list = fromHistory.slice(0, 4).map((c) => `${itemName(c)}: ${discountLabel(c.value, c.type)}`).join("; ");
    const message =
      (fromHistory.length
        ? `${party}${ctx.section ? ` · Section ${ctx.section}` : ""}${ctx.department ? ` · Department ${ctx.department}` : ""} has previous discounts for ${fromHistory.length} item${fromHistory.length === 1 ? "" : "s"} on this invoice: ${list}${fromHistory.length > 4 ? "; …" : ""}. `
        : "") +
      (toDefault ? `${toDefault} item${toDefault === 1 ? " has" : "s have"} no previous discount here and would go back to the item's default. ` : "") +
      "Apply these and replace the discounts now on those lines?";
    const result = await window.AppDialog.confirm({
      title: "Apply previous discounts?",
      message,
      icon: "info",
      confirmLabel: "Apply discounts",
      cancelLabel: "Keep current discounts",
    });
    if (seq !== contextSeq) return; // the party changed again while the dialog was open
    changes.forEach((c) => {
      if (result.confirmed) {
        setRowDiscount(c.row, c.value, c.type);
        c.row.dataset.discSource = c.source;
        c.row.dataset.discTouched = "";
      } else {
        c.row.dataset.discTouched = "1"; // the user chose to keep what is there
      }
      renderDiscountHint(c.row);
    });
  }
  [sectionInput, departmentInput].forEach((el) => el && el.addEventListener("change", onHistoryContextChange));
  invoiceDiscountValue.addEventListener("input", scheduleRecalc);
  invoiceDiscountType.addEventListener("change", scheduleRecalc);
  if (manualRoundOffValue) manualRoundOffValue.addEventListener("input", scheduleRecalc);
  if (chargesAmount) chargesAmount.addEventListener("input", scheduleRecalc);
  if (chargesTaxRate) chargesTaxRate.addEventListener("change", scheduleRecalc);
  if (receivedInput) {
    receivedInput.addEventListener("input", () => {
      const total = Number(document.getElementById("grandTotalHidden").value || 0);
      updatePaymentStatus(total);
    });
  }

  // ---------- Private profit panel (owner only; values only exist in the page while shown) ----------
  // Hidden on every page load and never remembered. Revealing fetches /api/invoices/profit (which
  // checks the owner again); hiding removes the figures from the page. Never part of print/PDF.
  const profitCard = document.querySelector("[data-profit-card]");
  let profitShown = false;
  let profitSeq = 0;
  let profitTimer;
  function inr(v) {
    const n = Number(v);
    return `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function renderProfit(d) {
    const body = profitCard.querySelector("[data-profit-body]");
    const loss = Number(d.grossProfit) < 0;
    const margin = d.marginPercent === null ? "—" : `${Number(d.marginPercent).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
    const notes = [];
    if (!d.complete) notes.push(`<div class="profit-warn"><i class="icon-triangle-alert" aria-hidden="true"></i> Incomplete: ${d.missingCount} item${d.missingCount === 1 ? " has" : "s have"} no cost, so ${d.missingCount === 1 ? "it is" : "they are"} left out of profit and margin.</div>`);
    if (d.editingOlderInvoice) notes.push(`<div class="profit-note">This invoice was saved before costs were recorded; its lines use today's purchase prices (estimate).</div>`);
    else if (d.usesCurrentCosts) notes.push(`<div class="profit-note">Cost estimated from each item's saved purchase price (excluding recoverable GST).</div>`);
    const extras = [];
    if (Number(d.charges)) extras.push(`charges ${inr(d.charges)}`);
    if (Number(d.roundOff)) extras.push(`round-off ${inr(d.roundOff)}`);
    notes.push(`<div class="profit-note">Item sales only: ${extras.length ? extras.join(" and ") + " are" : "delivery/other charges and round-off are"} not included. Other business expenses are not deducted.</div>`);
    const fig = (label, value, cls) => `<div><dt>${label}</dt><dd class="${cls || ""}">${value}</dd></div>`;
    const rows = d.lines
      .map((l) => `<li class="profit-line">
          <div class="profit-line-head"><span class="profit-item">${escapeHtml(l.productName)}</span>${l.costSource === "missing" ? `<span class="profit-missing">Cost missing</span>` : `<span class="profit-src">${l.costSource === "saved" ? "Saved cost" : "Current cost"}</span>`}</div>
          ${l.costSource === "missing" ? `<div class="profit-src">${escapeHtml(l.note)}</div>` : ""}
          <dl class="profit-figs">
            ${fig("Qty", escapeHtml(l.quantity) + (l.unit ? " " + escapeHtml(l.unit) : ""))}
            ${fig("Net sales", inr(l.netSales))}
            ${fig("Cost", l.cost === null ? "—" : inr(l.cost))}
            ${fig("Profit", l.profit === null ? "—" : inr(l.profit), l.profit !== null && Number(l.profit) < 0 ? "loss" : "")}
          </dl>
        </li>`)
      .join("");
    body.innerHTML = `
      <div class="profit-row"><span>Net sales <small>(excl. GST, after discounts)</small></span><strong>${inr(d.netSales)}</strong></div>
      <div class="profit-row"><span>Cost of items sold</span><strong>${inr(d.cost)}</strong></div>
      <div class="profit-row profit-total ${loss ? "loss" : "gain"}"><span>Estimated gross profit${loss ? " (loss)" : ""}</span><strong>${inr(d.grossProfit)}</strong></div>
      <div class="profit-row"><span>Gross margin</span><strong class="${loss ? "loss" : ""}">${margin}</strong></div>
      ${notes.join("")}
      ${d.lines.length ? `<details class="profit-details"><summary>Item breakdown (${d.lines.length})</summary>
        <ul class="profit-lines">${rows}</ul></details>` : ""}`;
  }
  async function loadProfit() {
    if (!profitShown) return;
    const seq = ++profitSeq;
    const body = profitCard.querySelector("[data-profit-body]");
    const payload = collectPayload();
    if (!payload.items.length) {
      body.innerHTML = `<div class="profit-note">Add items to see the estimated profit.</div>`;
      return;
    }
    if (form.dataset.invoiceId) payload.invoiceId = form.dataset.invoiceId;
    try {
      const res = await fetch("/api/invoices/profit", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (seq !== profitSeq || !profitShown) return; // hidden again, or a newer request is on its way
      if (!res.ok) { body.innerHTML = `<div class="profit-warn">${escapeHtml(data.error || "Profit could not be calculated.")}</div>`; return; }
      renderProfit(data);
    } catch (err) {
      if (seq === profitSeq && profitShown) body.innerHTML = `<div class="profit-warn">No connection to the server.</div>`;
    }
  }
  function setProfitShown(show) {
    if (!profitCard) return;
    profitShown = show;
    profitSeq++;
    const btn = profitCard.querySelector("[data-profit-toggle]");
    const body = profitCard.querySelector("[data-profit-body]");
    btn.setAttribute("aria-pressed", show ? "true" : "false");
    btn.setAttribute("aria-label", show ? "Hide profit" : "Show profit");
    btn.title = show ? "Hide profit" : "Show profit";
    btn.querySelector("i").className = show ? "icon-eye-off" : "icon-eye";
    profitCard.querySelector("[data-profit-masked]").hidden = show;
    body.hidden = !show;
    if (show) { body.innerHTML = `<div class="profit-note">Calculating…</div>`; loadProfit(); } else body.innerHTML = ""; // nothing left in the page
  }
  function profitAfterRecalc() {
    if (!profitShown) return;
    clearTimeout(profitTimer);
    profitTimer = setTimeout(loadProfit, 150);
  }
  if (profitCard) {
    profitCard.querySelector("[data-profit-toggle]").addEventListener("click", () => setProfitShown(!profitShown));
    // Wide screens: its own column right of the invoice (sticky); smaller desktops: beside the dates;
    // phones: below the invoice summary
    const headerSlot = profitCard.parentElement;
    const railSlot = document.querySelector("[data-profit-slot-rail]");
    const mobileSlot = document.querySelector("[data-profit-slot-mobile]");
    const mqPhone = window.matchMedia("(max-width: 991.98px)");
    const mqWide = window.matchMedia("(min-width: 1500px)");
    const place = () => {
      const target = mqPhone.matches ? mobileSlot : mqWide.matches && railSlot ? railSlot : headerSlot;
      if (target && profitCard.parentElement !== target) target.appendChild(profitCard);
      document.querySelector(".sale-page").classList.toggle("profit-in-rail", profitCard.parentElement === railSlot);
    };
    place();
    mqPhone.addEventListener("change", place);
    mqWide.addEventListener("change", place);
    // A page restored from the back/forward cache starts hidden again
    window.addEventListener("pageshow", (e) => { if (e.persisted) setProfitShown(false); });
    window.addEventListener("pagehide", () => setProfitShown(false));
  }

  // Double-submit protection and the saving spinner come from app.js (plus the server-side clientToken).

  // Bootstrap with existing rows (edit mode) or one empty row (create mode)
  const existingRows = window.__invoiceExistingItems || [];
  if (existingRows.length > 0) {
    existingRows.forEach((item) => {
      const row = addRow();
      row.querySelector(".item-name-input").value = item.productName;
      row.querySelector(".product-id-input").value = item.productId || "";
      row.querySelector(".hsn-input").value = item.hsn || "";
      row.querySelector(".unit-input").value = item.unit || "";
      row.querySelector(".unit-display").textContent = item.unit || "-";
      row.querySelector(".qty-input").value = item.quantity;
      row.querySelector(".price-input").value = item.rate;
      row.querySelector(".price-type-input").value = item.priceType || "EXCLUSIVE";
      row.querySelector(".discount-input").value = item.discount;
      row.querySelector(".discount-type-select").value = item.discountType;
      row.querySelector(".gst-rate-input").value = item.taxRate;
      row.querySelector(".gst-rate-cell-label").textContent = Number(item.taxRate) === 0 ? 'Exempt' : `${item.taxRate}%`;
      // Saved or copied discounts are the user's; on a new document previous discounts are only shown
      // beside them (on an invoice being edited, "previous" could be a later invoice, so nothing is shown)
      row.dataset.discTouched = "1";
      row.dataset.discSource = "saved";
      if (!editingInvoiceId) refreshRowHistory(row, false);
    });
  } else {
    addRow();
  }

  updatePlaceOfSupply();
  scheduleRecalc();
})();
