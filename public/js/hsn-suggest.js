(function () {
  const nameInput = document.getElementById("itemName");
  const hsnInput = document.getElementById("hsnCode");
  const suggestBox = document.getElementById("hsnSuggestions");
  const gstRateSelect = document.getElementById("gstRateSelect");
  if (!nameInput || !hsnInput || !suggestBox) return;

  let debounceTimer;

  async function fetchSuggestions(query) {
    if (!query || query.trim().length < 2) {
      suggestBox.innerHTML = "";
      return;
    }
    try {
      const res = await fetch(`/api/hsn/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return;
      const data = await res.json();
      renderSuggestions(data.results || []);
    } catch (err) {
      console.error("HSN suggestion fetch failed", err);
    }
  }

  function renderSuggestions(results) {
    if (results.length === 0) {
      suggestBox.innerHTML = `<div class="text-muted small">No HSN suggestions found. You can enter one manually.</div>`;
      return;
    }
    suggestBox.innerHTML = results
      .map(
        (r) => `
      <div class="hsn-suggestion-item">
        <div>
          <strong>${r.hsnCode}</strong> — ${r.description}
          <div class="ac-sub">GST: ${r.gstRate}%</div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-primary" data-hsn="${r.hsnCode}" data-gst="${r.gstRate}">Select</button>
      </div>`
      )
      .join("");

    suggestBox.querySelectorAll("button[data-hsn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        hsnInput.value = btn.dataset.hsn;
        if (gstRateSelect && btn.dataset.gst) {
          const option = Array.from(gstRateSelect.options).find(
            (o) => Number(o.dataset.rate) === Number(btn.dataset.gst)
          );
          if (option) gstRateSelect.value = option.value;
        }
      });
    });
  }

  nameInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchSuggestions(nameInput.value), 350);
  });
})();
