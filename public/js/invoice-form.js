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
      setTimeout(() => (menu.innerHTML = ""), 150);
    });

    [qtyInput, priceInput, discountInput, discountTypeSelect].forEach((el) => {
      el.addEventListener("input", scheduleRecalc);
      el.addEventListener("change", scheduleRecalc);
    });

    removeBtn.addEventListener("click", () => {
      row.remove();
      renumberRows();
      scheduleRecalc();
    });
  }

  // The menu is position: fixed so the table's scroll container can't clip it
  function positionMenu(menu, input) {
    const rect = input.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;
    menu.style.width = `${Math.max(rect.width, 280)}px`;
  }

  function renderAutocomplete(menu, row, results) {
    positionMenu(menu, row.querySelector(".item-name-input"));
    if (results.length === 0) {
      menu.innerHTML = `<div class="autocomplete-item text-muted">No matching items</div>`;
      return;
    }
    menu.innerHTML = results
      .map(
        (p) => `
      <div class="autocomplete-item" data-id="${p.id}">
        ${p.name}
        <div class="ac-sub">${p.itemCode || ""} ${p.hsnCode ? "· HSN " + p.hsnCode : ""} · Stock: ${p.currentStock}</div>
      </div>`
      )
      .join("");
    menu.querySelectorAll(".autocomplete-item[data-id]").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const product = results.find((p) => p.id === item.dataset.id);
        applyProductToRow(row, product);
        menu.innerHTML = "";
      });
    });
  }

  function applyProductToRow(row, product) {
    row.querySelector(".item-name-input").value = product.name;
    row.querySelector(".product-id-input").value = product.id;
    row.querySelector(".hsn-input").value = product.hsnCode || "";
    row.querySelector(".unit-input").value = product.unitName || "";
    row.querySelector(".unit-display").textContent = product.unitName || "-";
    row.querySelector(".price-input").value = Number(product.salePrice).toFixed(2);
    row.querySelector(".price-type-input").value = product.priceType || "EXCLUSIVE";
    row.querySelector(".gst-rate-input").value = product.gstRate || 0;
    row.querySelector(".gst-rate-cell-label").textContent = `${product.gstRate || 0}%`;
    if (product.defaultDiscount != null) {
      row.querySelector(".discount-input").value = Number(product.defaultDiscount).toFixed(2);
      row.querySelector(".discount-type-select").value = product.defaultDiscountType || "PERCENTAGE";
    }
    row.dataset.availableStock = product.currentStock;
    scheduleRecalc();
  }

  function updatePlaceOfSupply() {
    const opt = customerSelect.options[customerSelect.selectedIndex];
    const customerState = (opt?.dataset.state || "").trim().toLowerCase();
    const isIntra = customerState && customerState === businessState;
    if (!customerState) {
      placeOfSupplyBadge.textContent = "Select a customer";
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
      if (!res.ok) return;
      const data = await res.json();
      applyCalculation(data);
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
    ["subtotalDisplay", "discountDisplay", "taxableDisplay", "cgstDisplay", "sgstDisplay", "igstDisplay", "cessDisplay", "roundOffDisplay", "grandTotalDisplay"].forEach(
      (id) => (document.getElementById(id).textContent = money(0))
    );
    if (stickyTotalDisplay) stickyTotalDisplay.textContent = money(0);
    updatePaymentStatus(0);
  }

  function updatePaymentStatus(total) {
    const received = Number(receivedInput.value || 0);
    const balance = Math.max(total - received, 0);
    balanceDisplay.textContent = money(balance);

    if (received <= 0) {
      paymentStatusBadge.textContent = "UNPAID";
      paymentStatusBadge.className = "status-badge status-unpaid";
    } else if (received >= total && total > 0) {
      paymentStatusBadge.textContent = "PAID";
      paymentStatusBadge.className = "status-badge status-paid";
    } else {
      paymentStatusBadge.textContent = "PARTIALLY PAID";
      paymentStatusBadge.className = "status-badge status-partial";
    }
  }

  addRowBtn.addEventListener("click", () => addRow());

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
  invoiceDiscountValue.addEventListener("input", scheduleRecalc);
  invoiceDiscountType.addEventListener("change", scheduleRecalc);
  if (manualRoundOffValue) manualRoundOffValue.addEventListener("input", scheduleRecalc);
  receivedInput.addEventListener("input", () => {
    const total = Number(document.getElementById("grandTotalHidden").value || 0);
    updatePaymentStatus(total);
  });

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
      row.querySelector(".discount-input").value = item.discount;
      row.querySelector(".discount-type-select").value = item.discountType;
      row.querySelector(".gst-rate-input").value = item.taxRate;
      row.querySelector(".gst-rate-cell-label").textContent = `${item.taxRate}%`;
    });
  } else {
    addRow();
  }

  updatePlaceOfSupply();
  scheduleRecalc();
})();
