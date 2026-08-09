document.addEventListener("DOMContentLoaded", () => {
  if (window.lucide) window.lucide.createIcons();
  document.querySelectorAll("[data-min-today]").forEach((input) => {
    input.min = new Date().toISOString().split("T")[0];
  });

  const bookingForm = document.querySelector("[data-availability-form]");
  if (bookingForm) {
    const dateInput = bookingForm.querySelector('[name="pickup_date"]');
    const timeInput = bookingForm.querySelector('[name="pickup_time"]');
    const message = bookingForm.querySelector("[data-availability-message]");
    const submit = bookingForm.querySelector("[data-booking-submit]");
    const managerReview = bookingForm.querySelector("[data-manager-review]");
    let requestNumber = 0;

    async function checkAvailability() {
      const vehicle = bookingForm.querySelector('[name="car_id"]:checked');
      if (!vehicle || !dateInput.value || !timeInput.value) {
        message.hidden = true;
        managerReview.value = "0";
        submit.innerHTML = 'Send booking request <i data-lucide="arrow-right"></i>';
        if (window.lucide) window.lucide.createIcons();
        submit.disabled = false;
        return;
      }

      const currentRequest = ++requestNumber;
      message.hidden = false;
      message.className = "availability-message checking";
      message.textContent = "Checking vehicle availability...";
      submit.disabled = true;

      try {
        const params = new URLSearchParams({ vehicle_id: vehicle.value, pickup_date: dateInput.value, pickup_time: timeInput.value });
        const response = await fetch(`/api/availability?${params}`);
        const result = await response.json();
        if (currentRequest !== requestNumber) return;
        message.className = `availability-message ${result.available ? "available" : "unavailable"}`;
        const managerPhone = bookingForm.dataset.managerPhone;
        const managerTel = bookingForm.dataset.managerTel;
        const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
        const alternatives = result.alternatives?.length
          ? ` Available alternatives: <strong>${result.alternatives.map((vehicle) => escapeHtml(vehicle.name)).join(", ")}</strong>.`
          : "";
        message.innerHTML = result.available
          ? `<strong>Available</strong><span>${result.message}</span>`
          : `<strong>${result.state === "booked" ? "Already booked" : "Manager confirmation needed"}</strong><span>${result.message}${alternatives} Choose another car above or <a href="tel:${managerTel}">call ${managerPhone}</a>.</span>`;
        managerReview.value = result.available ? "0" : "1";
        submit.innerHTML = result.available ? 'Send booking request <i data-lucide="arrow-right"></i>' : 'Send for manager review <i data-lucide="arrow-right"></i>';
        if (window.lucide) window.lucide.createIcons();
        submit.disabled = false;
      } catch (error) {
        if (currentRequest !== requestNumber) return;
        message.className = "availability-message checking";
        message.textContent = "Availability could not be checked. Please try again.";
        managerReview.value = "0";
        submit.disabled = true;
      }
    }

    bookingForm.querySelectorAll('[name="car_id"], [name="pickup_date"], [name="pickup_time"]').forEach((input) => input.addEventListener("change", checkAvailability));
    checkAvailability();
  }
});
