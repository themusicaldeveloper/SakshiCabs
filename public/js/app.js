document.addEventListener("DOMContentLoaded", () => {
  if (window.lucide) window.lucide.createIcons();
  document.querySelectorAll("[data-min-today]").forEach((input) => {
    input.min = new Date().toISOString().split("T")[0];
  });
});
