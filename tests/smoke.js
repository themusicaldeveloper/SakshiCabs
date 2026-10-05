const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_FILE = path.join(os.tmpdir(), `taxi-booking-smoke-${process.pid}.json`);
process.env.PORT = process.env.PORT || "3199";
process.env.SESSION_SECRET = "smoke-test-secret";
fs.rmSync(process.env.DATA_FILE, { force: true });

const { start } = require("../server");

async function request(path, options = {}, cookie = "") {
  const response = await fetch(`http://localhost:${process.env.PORT}${path}`, {
    redirect: "manual",
    ...options,
    headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) },
  });
  return { response, text: await response.text(), cookie: response.headers.get("set-cookie")?.split(";")[0] || cookie };
}

async function run() {
  await start();
  const health = await request("/health");
  if (health.response.status !== 200 || !health.text.includes('"database":"json"')) throw new Error("JSON storage health check failed");

  const home = await request("/");
  if (home.response.status !== 200 || !home.text.includes("Toyota Innova")) throw new Error("Public catalog failed");

  const booking = await request("/book", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ car_id: "1", customer_name: "Smoke Customer", phone: "9999999999", pickup_location: "Station", drop_location: "Airport", pickup_date: "2026-08-10", pickup_time: "09:30", trip_type: "airport" }),
  });
  if (booking.response.status !== 302) throw new Error("Booking creation failed");

  const conflict = await request("/book", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ car_id: "1", customer_name: "Conflict Customer", phone: "9777777777", pickup_location: "Hotel", drop_location: "Office", pickup_date: "2026-08-10", pickup_time: "13:00", trip_type: "one-way" }),
  });
  if (conflict.response.status !== 409 || !conflict.text.includes("call the manager")) throw new Error("Availability conflict rule failed");

  const login = await request("/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password: "admin123" }),
  });
  const dashboard = await request("/admin", {}, login.cookie);
  if (!dashboard.text.includes("Smoke Customer")) throw new Error("Admin booking view failed");
  const bookingId = dashboard.text.match(/\/admin\/bookings\/(\d+)\/update/)?.[1];
  const adminNotifications = await request("/admin/notifications", {}, login.cookie);
  if (!adminNotifications.text.includes("New booking request")) throw new Error("Admin notification failed");

  const driverCreate = await request("/admin/drivers", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Test Driver", phone: "9888888888", username: "driver", password: "driver123" }),
  }, login.cookie);
  if (driverCreate.response.status !== 302) throw new Error("Driver creation failed");

  const drivers = await request("/admin/drivers", {}, login.cookie);
  if (!drivers.text.includes("Test Driver")) throw new Error("Driver list failed");
  const driverId = drivers.text.match(/\/admin\/drivers\/(\d+)\/toggle/)?.[1];

  const vehicleCreate = await request("/admin/vehicles", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Test Sedan", registration_number: "TEST 123", category: "Sedan", seats: "4", bags: "2", rate_per_km: "14", day_rate: "2800", image_url: "/images/ertiga.png", description: "Test vehicle" }),
  }, login.cookie);
  if (vehicleCreate.response.status !== 302) throw new Error("Vehicle creation failed");
  const vehicles = await request("/admin/vehicles", {}, login.cookie);
  if (!vehicles.text.includes("Test Sedan")) throw new Error("Vehicle list failed");

  await request(`/admin/bookings/${bookingId}/update`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ driver_id: driverId, status: "pending", payment_status: "paid", payment_reference: "UPI-SMOKE", return_status: "all" }),
  }, login.cookie);
  const combinedUpdate = await request("/admin", {}, login.cookie);
  if (!combinedUpdate.text.includes("paid-dot") || !combinedUpdate.text.includes("UPI-SMOKE")) throw new Error("Combined booking update failed");

  const driverLogin = await request("/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "driver", password: "driver123" }),
  });
  const driverDashboard = await request("/admin", {}, driverLogin.cookie);
  if (!driverDashboard.text.includes("Smoke Customer")) throw new Error("Assigned driver trip view failed");
  const driverNotifications = await request("/admin/notifications", {}, driverLogin.cookie);
  if (!driverNotifications.text.includes("New trip assigned")) throw new Error("Driver notification failed");
  const forbidden = await request("/admin/vehicles", {}, driverLogin.cookie);
  if (forbidden.response.status !== 403) throw new Error("Driver role restriction failed");

  await request(`/admin/bookings/${bookingId}/update`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ driver_id: driverId, status: "confirmed", payment_status: "paid", payment_reference: "UPI-SMOKE", return_status: "all" }),
  }, login.cookie);
  const bookedAvailability = await request("/api/availability?vehicle_id=1&pickup_date=2026-08-10&pickup_time=13%3A00");
  if (!bookedAvailability.text.includes('"state":"booked"') || !bookedAvailability.text.includes("Already booked")) throw new Error("Confirmed availability message failed");
  if (!bookedAvailability.text.includes("Toyota Innova")) throw new Error("Available alternative was not suggested");

  const managerReviewBooking = await request("/book", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ car_id: "1", manager_review: "1", customer_name: "Arrangement Customer", phone: "9666666666", pickup_location: "Hotel", drop_location: "Office", pickup_date: "2026-08-10", pickup_time: "13:00", trip_type: "one-way" }),
  });
  if (managerReviewBooking.response.status !== 302) throw new Error("Manager review booking was not accepted");
  const conflictDashboard = await request("/admin", {}, login.cookie);
  if (!conflictDashboard.text.includes("Scheduling conflict")) throw new Error("Admin conflict flag failed");
  const conflictNotifications = await request("/admin/notifications", {}, login.cookie);
  if (!conflictNotifications.text.includes("Vehicle conflict needs arrangement")) throw new Error("Admin conflict notification failed");
  const bookingIds = [...conflictDashboard.text.matchAll(/\/admin\/bookings\/(\d+)\/update/g)].map((match) => match[1]);
  const conflictBookingId = bookingIds.find((id) => id !== bookingId);
  await request(`/admin/bookings/${conflictBookingId}/update`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ vehicle_id: "2", status: "pending", payment_status: "unpaid", return_status: "all" }),
  }, login.cookie);
  const resolvedDashboard = await request("/admin", {}, login.cookie);
  if (resolvedDashboard.text.includes("Scheduling conflict")) throw new Error("Alternative vehicle did not resolve conflict");

  const tracking = await request("/booking/manage?reference=CR", {}, "");
  if (tracking.response.status !== 200) throw new Error("Booking tracking page failed");
  const reference = dashboard.text.match(/CR-\d{4}-[A-F0-9]+/)?.[0];
  const cancellation = await request(`/booking/${reference}/cancel-request`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone: "9999999999", reason: "Plans changed" }),
  });
  if (cancellation.response.status !== 302) throw new Error("Cancellation request failed");
  const cancellationDashboard = await request("/admin", {}, login.cookie);
  if (!cancellationDashboard.text.includes("Cancellation requested")) throw new Error("Admin cancellation view failed");
  const cancellationNotifications = await request("/admin/notifications", {}, login.cookie);
  if (!cancellationNotifications.text.includes("Cancellation requested")) throw new Error("Cancellation notification failed");
  await request(`/admin/bookings/${bookingId}/cancellation`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ resolution: "approved" }),
  }, login.cookie);
  const reopenedAvailability = await request("/api/availability?vehicle_id=1&pickup_date=2026-08-10&pickup_time=13%3A00");
  if (!reopenedAvailability.text.includes('"available":true')) throw new Error("Cancellation did not reopen availability");

  const restoreCheck = `
    const fs = require("fs");
    const db = require("./db");
    (async () => {
      await db.initialize(fs.readFileSync("schema.sql", "utf8"));
      const { rows } = await db.query("SELECT b.customer_name, u.username FROM bookings b JOIN users u ON u.id = b.driver_id");
      if (!rows.some((row) => row.customer_name === "Smoke Customer" && row.username === "driver")) {
        throw new Error("JSON dataset did not restore booking relationships");
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ["-e", restoreCheck], { env: process.env, stdio: "inherit" });

  console.log("Smoke test passed: booking flows and JSON dataset restore.");
}

run().then(() => {
  fs.rmSync(process.env.DATA_FILE, { force: true });
  process.exit(0);
}).catch((error) => {
  console.error(error);
  fs.rmSync(process.env.DATA_FILE, { force: true });
  process.exit(1);
});
