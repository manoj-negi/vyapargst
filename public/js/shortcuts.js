document.addEventListener("keydown", (e) => {
  const isSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s";
  const isPrint = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p";

  if (isSave) {
    const saveBtn = document.querySelector("[data-shortcut-save]");
    if (saveBtn) {
      e.preventDefault();
      saveBtn.click();
    }
  }

  if (isPrint && document.querySelector("[data-shortcut-print]")) {
    e.preventDefault();
    window.print();
  }

  if (e.key === "Escape") {
    document.querySelectorAll(".modal.show").forEach((modal) => {
      const instance = window.bootstrap && window.bootstrap.Modal.getInstance(modal);
      if (instance) instance.hide();
    });
    document.querySelectorAll(".autocomplete-menu").forEach((el) => el.remove());
  }
});
