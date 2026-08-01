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
    let requestNumber = 0;

    async function checkAvailability() {
      const vehicle = bookingForm.querySelector('[name="car_id"]:checked');
      if (!vehicle || !dateInput.value || !timeInput.value) {
        message.hidden = true;
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
        message.innerHTML = result.available
          ? `<strong>Available</strong><span>${result.message}</span>`
          : `<strong>Manager confirmation needed</strong><span>${result.message} <a href="tel:${managerTel}">Call ${managerPhone}</a></span>`;
        submit.disabled = !result.available;
      } catch (error) {
        if (currentRequest !== requestNumber) return;
        message.className = "availability-message checking";
        message.textContent = "Availability could not be checked. Please try again.";
        submit.disabled = true;
      }
    }

    bookingForm.querySelectorAll('[name="car_id"], [name="pickup_date"], [name="pickup_time"]').forEach((input) => input.addEventListener("change", checkAvailability));
    checkAvailability();
  }
});
