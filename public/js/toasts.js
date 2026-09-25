document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-autohide-toast]").forEach((el) => {
    if (window.bootstrap) {
      const toast = new window.bootstrap.Toast(el, { delay: 4000 });
      toast.show();
    }
  });

  const sidebarToggle = document.getElementById("sidebarToggle");
  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
      document.querySelector(".app-shell").classList.toggle("sidebar-collapsed");
    });
  }

  const mobileMenuToggle = document.getElementById("mobileMenuToggle");
  if (mobileMenuToggle) {
    mobileMenuToggle.addEventListener("click", () => {
      document.querySelector(".app-shell").classList.toggle("mobile-open");
    });
  }
});

function showToast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast align-items-center text-bg-${type} border-0 show`;
  el.setAttribute("role", "alert");
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${message}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  container.appendChild(el);
  if (window.bootstrap) {
    new window.bootstrap.Toast(el, { delay: 4000 }).show();
  }
  setTimeout(() => el.remove(), 4500);
}
