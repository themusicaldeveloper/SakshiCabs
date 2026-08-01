process.env.DB_ADAPTER = "memory";
process.env.PORT = process.env.PORT || "3199";
process.env.SESSION_SECRET = "smoke-test-secret";

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
  const bookingId = dashboard.text.match(/\/admin\/bookings\/(\d+)\/status/)?.[1];
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

  await request(`/admin/bookings/${bookingId}/assign`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ driver_id: driverId }),
  }, login.cookie);

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

  console.log("Smoke test passed: availability, booking, notifications, assignment, and role access.");
  process.exit(0);
}

run().catch((error) => { console.error(error); process.exit(1); });
