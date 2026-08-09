const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

require("dotenv").config();

const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const db = require("./db");

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const tenantSlug = process.env.TENANT_SLUG || "cityride";
const availabilityGapHours = Math.max(0, Number(process.env.AVAILABILITY_GAP_HOURS || 6));

async function initializeDatabase() {
  await db.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

  const organizationResult = await db.query(
    `INSERT INTO organizations (slug, name, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone
     RETURNING *`,
    [tenantSlug, process.env.BUSINESS_NAME || "CityRide Cabs", process.env.BUSINESS_PHONE || "+91 98765 43210"],
  );
  const organization = organizationResult.rows[0];

  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const existingAdmin = await db.query(
    "SELECT id FROM users WHERE organization_id = $1 AND username = $2",
    [organization.id, adminUsername],
  );
  if (!existingAdmin.rowCount) {
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin123", 12);
    await db.query(
      `INSERT INTO users (organization_id, role, name, phone, username, password_hash)
       VALUES ($1, 'super_admin', $2, $3, $4, $5)`,
      [organization.id, "Business Admin", organization.phone, adminUsername, passwordHash],
    );
  }

  const vehicles = [
    ["ertiga", "Maruti Suzuki Ertiga", "Comfort MPV", 6, 3, 16, 3200, "/images/ertiga.png", "A comfortable and efficient choice for family trips, airport transfers, and city travel."],
    ["innova", "Toyota Innova Crysta", "Premium MPV", 7, 4, 22, 4500, "/images/innova.png", "Extra space and premium comfort for long journeys, business travel, and larger groups."],
  ];
  for (const vehicle of vehicles) {
    await db.query(
      `INSERT INTO vehicles (organization_id, slug, name, category, seats, bags, rate_per_km, day_rate, image_url, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (organization_id, slug) DO NOTHING`,
      [organization.id, ...vehicle],
    );
  }

  const existingBookings = await db.query(
    `SELECT id, organization_id, vehicle_id, pickup_date, pickup_time, status
     FROM bookings WHERE organization_id = $1 AND status IN ('pending', 'confirmed')`,
    [organization.id],
  );
  const pendingBookings = existingBookings.rows.filter((booking) => booking.status === "pending");
  const confirmedBookings = existingBookings.rows.filter((booking) => booking.status === "confirmed");
  const gapMilliseconds = availabilityGapHours * 60 * 60 * 1000;
  for (const pending of pendingBookings) {
    const conflict = confirmedBookings.find((confirmed) =>
      Number(confirmed.vehicle_id) === Number(pending.vehicle_id)
      && Math.abs(pickupTimestamp(confirmed.pickup_date, confirmed.pickup_time) - pickupTimestamp(pending.pickup_date, pending.pickup_time)) < gapMilliseconds
    );
    if (conflict) {
      await db.query(
        `INSERT INTO booking_schedule_conflicts (organization_id, booking_id, conflicting_booking_id)
         VALUES ($1,$2,$3) ON CONFLICT (booking_id) DO NOTHING`,
        [organization.id, pending.id, conflict.id],
      );
    }
  }

  return organization;
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
if (isProduction) app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessionOptions = {
  secret: process.env.SESSION_SECRET || "local-development-secret-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 12 * 60 * 60 * 1000 },
};
if (process.env.DB_ADAPTER !== "memory") {
  sessionOptions.store = new PgSession({ pool: db.pool, createTableIfMissing: true });
}
app.use(session(sessionOptions));

let defaultOrganization;
app.use(asyncRoute(async (req, res, next) => {
  res.locals.business = defaultOrganization;
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.notice = req.session.notice || null;
  res.locals.unreadNotificationCount = 0;
  delete req.session.notice;
  if (req.session.user) {
    const result = await db.query(
      "SELECT COUNT(*)::integer AS count FROM notifications WHERE recipient_user_id = $1 AND is_read = FALSE",
      [req.session.user.id],
    );
    res.locals.unreadNotificationCount = result.rows[0].count;
  }
  next();
}));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireUser(req, res, next) {
  if (req.session.user) return next();
  return res.redirect("/admin/login");
}

function requireSuperAdmin(req, res, next) {
  if (req.session.user?.role === "super_admin") return next();
  return res.status(403).render("message", { title: "Access denied", message: "Only a super admin can manage this section." });
}

function canManageBooking(user, booking) {
  return user.role === "super_admin" || Number(booking.driver_id) === Number(user.id);
}

function createReference() {
  return `CR-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function datePart(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function pickupTimestamp(date, time) {
  return new Date(`${datePart(date)}T${String(time).slice(0, 8)}`).getTime();
}

async function checkVehicleAvailability(organizationId, vehicleId, pickupDate, pickupTime) {
  const requestedAt = pickupTimestamp(pickupDate, pickupTime);
  if (!Number.isFinite(requestedAt)) return { available: false, invalid: true };

  const { rows } = await db.query(
    `SELECT id, pickup_date, pickup_time, status FROM bookings
     WHERE organization_id = $1 AND vehicle_id = $2 AND status <> 'cancelled'`,
    [organizationId, vehicleId],
  );
  const gapMilliseconds = availabilityGapHours * 60 * 60 * 1000;
  const conflicts = rows.filter((booking) => Math.abs(pickupTimestamp(booking.pickup_date, booking.pickup_time) - requestedAt) < gapMilliseconds);
  const conflict = conflicts.find((booking) => booking.status === "confirmed") || conflicts[0];
  return {
    available: !conflict,
    conflict: conflict || null,
    state: conflict?.status === "confirmed" ? "booked" : conflict ? "under_review" : "available",
    gapHours: availabilityGapHours,
  };
}

async function notifyUsers(client, organizationId, userIds, bookingId, type, title, message) {
  for (const userId of userIds) {
    await client.query(
      `INSERT INTO notifications (organization_id, recipient_user_id, booking_id, type, title, message)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [organizationId, userId, bookingId, type, title, message],
    );
  }
}

app.get("/", asyncRoute(async (req, res) => {
  const { rows: cars } = await db.query("SELECT * FROM vehicles WHERE organization_id = $1 AND is_active = TRUE ORDER BY id", [defaultOrganization.id]);
  res.render("home", { cars, title: "Reliable taxis for every journey" });
}));

app.get("/cars/:slug", asyncRoute(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM vehicles WHERE organization_id = $1 AND slug = $2 AND is_active = TRUE", [defaultOrganization.id, req.params.slug]);
  if (!rows[0]) return res.status(404).render("message", { title: "Car not found", message: "This car is not currently available." });
  return res.render("car", { car: rows[0], title: rows[0].name });
}));

app.get("/book", asyncRoute(async (req, res) => {
  const { rows: cars } = await db.query("SELECT * FROM vehicles WHERE organization_id = $1 AND is_active = TRUE ORDER BY id", [defaultOrganization.id]);
  res.render("book", { cars, selectedCarId: Number(req.query.car || cars[0]?.id), error: null, values: {}, managerReviewRequired: false, title: "Request a booking" });
}));

app.get("/api/availability", asyncRoute(async (req, res) => {
  const vehicleId = Number(req.query.vehicle_id);
  const { rows } = await db.query(
    "SELECT id FROM vehicles WHERE id = $1 AND organization_id = $2 AND is_active = TRUE",
    [vehicleId, defaultOrganization.id],
  );
  if (!rows[0] || !req.query.pickup_date || !req.query.pickup_time) {
    return res.status(400).json({ available: false, message: "Choose a valid vehicle, date, and time." });
  }
  const availability = await checkVehicleAvailability(defaultOrganization.id, vehicleId, req.query.pickup_date, req.query.pickup_time);
  const { rows: otherVehicles } = await db.query(
    "SELECT id, name FROM vehicles WHERE organization_id = $1 AND is_active = TRUE AND id <> $2 ORDER BY id",
    [defaultOrganization.id, vehicleId],
  );
  const alternatives = [];
  for (const vehicle of otherVehicles) {
    const option = await checkVehicleAvailability(defaultOrganization.id, vehicle.id, req.query.pickup_date, req.query.pickup_time);
    if (option.available) alternatives.push(vehicle);
  }
  res.json({
    available: availability.available,
    state: availability.state,
    gapHours: availabilityGapHours,
    alternatives,
    message: availability.available
      ? "This vehicle is available for the selected time."
      : availability.state === "booked"
        ? "Already booked for this time. Please confirm with the manager before proceeding; the slot may reopen if the confirmed trip is cancelled."
        : "Another booking request is being reviewed for this time. Please confirm availability with the manager before proceeding.",
  });
}));

app.post("/book", asyncRoute(async (req, res) => {
  const values = req.body;
  const { rows: cars } = await db.query("SELECT * FROM vehicles WHERE organization_id = $1 AND is_active = TRUE ORDER BY id", [defaultOrganization.id]);
  const car = cars.find((item) => Number(item.id) === Number(values.car_id));
  const required = ["customer_name", "phone", "pickup_location", "drop_location", "pickup_date", "pickup_time", "trip_type"];
  if (!car || required.some((key) => !String(values[key] || "").trim())) {
    return res.status(400).render("book", { cars, selectedCarId: Number(values.car_id), values, error: "Please complete all required fields.", managerReviewRequired: false, title: "Request a booking" });
  }
  const availability = await checkVehicleAvailability(defaultOrganization.id, car.id, values.pickup_date, values.pickup_time);
  const managerReviewRequired = !availability.available;
  if (managerReviewRequired && values.manager_review !== "1") {
    const conflictMessage = availability.state === "booked"
      ? "This vehicle is already booked for this time. Please call the manager before proceeding; availability may change if the confirmed trip is cancelled."
      : "Another request for this vehicle is being reviewed within the configured time gap. Please call the manager before booking.";
    return res.status(409).render("book", {
      cars,
      selectedCarId: Number(values.car_id),
      values,
      error: conflictMessage,
      managerReviewRequired: true,
      title: "Request a booking",
    });
  }
  const reference = createReference();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const bookingResult = await client.query(
      `INSERT INTO bookings (organization_id, reference, vehicle_id, customer_name, phone, email, pickup_location, drop_location, pickup_date, pickup_time, trip_type, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [defaultOrganization.id, reference, car.id, values.customer_name.trim(), values.phone.trim(), String(values.email || "").trim(), values.pickup_location.trim(), values.drop_location.trim(), values.pickup_date, values.pickup_time, values.trip_type, String(values.notes || "").trim()],
    );
    const adminResult = await client.query(
      "SELECT id FROM users WHERE organization_id = $1 AND role = 'super_admin' AND is_active = TRUE",
      [defaultOrganization.id],
    );
    if (managerReviewRequired) {
      await client.query(
        `INSERT INTO booking_schedule_conflicts (organization_id, booking_id, conflicting_booking_id)
         VALUES ($1,$2,$3)`,
        [defaultOrganization.id, bookingResult.rows[0].id, availability.conflict.id],
      );
    }
    await notifyUsers(
      client,
      defaultOrganization.id,
      adminResult.rows.map((admin) => admin.id),
      bookingResult.rows[0].id,
      managerReviewRequired ? "schedule_conflict" : "new_booking",
      managerReviewRequired ? "Vehicle conflict needs arrangement" : "New booking request",
      managerReviewRequired
        ? `${values.customer_name.trim()} requested already-booked ${car.name} for ${values.pickup_date} at ${values.pickup_time}. Call the customer or arrange another vehicle.`
        : `${values.customer_name.trim()} requested ${car.name} for ${values.pickup_date} at ${values.pickup_time}.`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.redirect(`/booking/success?reference=${encodeURIComponent(reference)}`);
}));

app.get("/booking/success", asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.*, v.name AS car_name, sc.id AS schedule_conflict_id
     FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
     LEFT JOIN booking_schedule_conflicts sc ON sc.booking_id = b.id AND sc.resolved_at IS NULL
     WHERE b.organization_id = $1 AND b.reference = $2`,
    [defaultOrganization.id, req.query.reference],
  );
  if (!rows[0]) return res.redirect("/");
  res.render("success", { booking: rows[0], title: "Booking request received" });
}));

app.get("/booking/manage", asyncRoute(async (req, res) => {
  let booking = null;
  let error = null;
  const reference = String(req.query.reference || "").trim().toUpperCase();
  const phone = String(req.query.phone || "").trim();
  if (reference || phone) {
    if (!reference || !phone) {
      error = "Enter both the booking reference and phone number.";
    } else {
      const { rows } = await db.query(
        `SELECT b.*, v.name AS car_name, u.name AS driver_name,
                cr.status AS cancellation_status, cr.reason AS cancellation_reason
         FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
         LEFT JOIN users u ON u.id = b.driver_id
         LEFT JOIN booking_cancellation_requests cr ON cr.booking_id = b.id
         WHERE b.organization_id = $1 AND UPPER(b.reference) = $2 AND b.phone = $3`,
        [defaultOrganization.id, reference, phone],
      );
      booking = rows[0] || null;
      if (!booking) error = "No booking matched that reference and phone number.";
    }
  }
  res.render("booking-manage", { booking, error, values: { reference, phone }, title: "Manage booking" });
}));

app.post("/booking/:reference/cancel-request", asyncRoute(async (req, res) => {
  const reference = String(req.params.reference || "").trim().toUpperCase();
  const phone = String(req.body.phone || "").trim();
  const { rows } = await db.query(
    "SELECT * FROM bookings WHERE organization_id = $1 AND UPPER(reference) = $2 AND phone = $3",
    [defaultOrganization.id, reference, phone],
  );
  const booking = rows[0];
  if (!booking) return res.status(404).render("message", { title: "Booking not found", message: "We could not verify this booking." });
  if (["cancelled", "completed"].includes(booking.status)) {
    return res.redirect(`/booking/manage?reference=${encodeURIComponent(reference)}&phone=${encodeURIComponent(phone)}`);
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO booking_cancellation_requests (organization_id, booking_id, reason)
       VALUES ($1,$2,$3)
       ON CONFLICT (booking_id) DO UPDATE SET reason = EXCLUDED.reason, status = 'pending', requested_at = CURRENT_TIMESTAMP, resolved_at = NULL`,
      [defaultOrganization.id, booking.id, String(req.body.reason || "").trim()],
    );
    const admins = await client.query("SELECT id FROM users WHERE organization_id = $1 AND role = 'super_admin' AND is_active = TRUE", [defaultOrganization.id]);
    await notifyUsers(client, defaultOrganization.id, admins.rows.map((admin) => admin.id), booking.id, "cancellation_requested", "Cancellation requested", `${booking.reference}: ${booking.customer_name} requested cancellation.`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.redirect(`/booking/manage?reference=${encodeURIComponent(reference)}&phone=${encodeURIComponent(phone)}`);
}));

app.get("/admin/login", (req, res) => {
  if (req.session.user) return res.redirect("/admin");
  res.render("login", { error: null, title: "Team sign in" });
});

app.post("/admin/login", asyncRoute(async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.*, o.name AS organization_name FROM users u JOIN organizations o ON o.id = u.organization_id
     WHERE o.slug = $1 AND LOWER(u.username) = LOWER($2) AND u.is_active = TRUE`,
    [tenantSlug, String(req.body.username || "").trim()],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) {
    return res.status(401).render("login", { error: "Incorrect username or password.", title: "Team sign in" });
  }
  req.session.user = { id: user.id, organizationId: user.organization_id, name: user.name, role: user.role, organizationName: user.organization_name };
  res.redirect("/admin");
}));

app.post("/admin/logout", requireUser, (req, res) => req.session.destroy(() => res.redirect("/admin/login")));

app.get("/admin", requireUser, asyncRoute(async (req, res) => {
  const user = req.session.user;
  const allowed = ["all", "pending", "confirmed", "completed", "cancelled"];
  const filter = allowed.includes(req.query.status) ? req.query.status : "all";
  const params = [user.organizationId];
  const conditions = ["b.organization_id = $1"];
  if (user.role === "driver") { params.push(user.id); conditions.push(`b.driver_id = $${params.length}`); }
  if (filter !== "all") { params.push(filter); conditions.push(`b.status = $${params.length}`); }
  const { rows: bookings } = await db.query(
    `SELECT b.*, v.name AS car_name, v.registration_number, u.name AS driver_name,
            cr.status AS cancellation_status, cr.reason AS cancellation_reason,
            cb.id AS conflicting_booking_id, cb.reference AS conflicting_reference, cb.status AS conflicting_status
     FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN users u ON u.id = b.driver_id
     LEFT JOIN booking_cancellation_requests cr ON cr.booking_id = b.id
     LEFT JOIN booking_schedule_conflicts sc ON sc.booking_id = b.id AND sc.resolved_at IS NULL
     LEFT JOIN bookings cb ON cb.id = sc.conflicting_booking_id AND cb.status <> 'cancelled'
     WHERE ${conditions.join(" AND ")} ORDER BY b.pickup_date ASC, b.pickup_time ASC`, params,
  );
  const countParams = [user.organizationId];
  let countWhere = "organization_id = $1";
  if (user.role === "driver") { countParams.push(user.id); countWhere += " AND driver_id = $2"; }
  const { rows: counts } = await db.query(`SELECT status, COUNT(*)::integer AS count FROM bookings WHERE ${countWhere} GROUP BY status`, countParams);
  const { rows: drivers } = user.role === "super_admin" ? await db.query("SELECT id, name FROM users WHERE organization_id = $1 AND role = 'driver' AND is_active = TRUE ORDER BY name", [user.organizationId]) : { rows: [] };
  const { rows: vehicles } = user.role === "super_admin" ? await db.query("SELECT id, name, registration_number FROM vehicles WHERE organization_id = $1 AND is_active = TRUE ORDER BY name", [user.organizationId]) : { rows: [] };
  res.render("admin", { bookings, counts, drivers, vehicles, filter, title: user.role === "driver" ? "My trips" : "Booking dashboard" });
}));

app.post("/admin/bookings/:id/status", requireUser, asyncRoute(async (req, res) => {
  const allowed = ["pending", "confirmed", "completed", "cancelled"];
  const { rows } = await db.query("SELECT * FROM bookings WHERE id = $1 AND organization_id = $2", [req.params.id, req.session.user.organizationId]);
  if (rows[0] && canManageBooking(req.session.user, rows[0]) && allowed.includes(req.body.status)) {
    await db.query("UPDATE bookings SET status = $1 WHERE id = $2", [req.body.status, rows[0].id]);
    if (req.body.status === "cancelled") {
      await db.query(
        `UPDATE booking_cancellation_requests SET status = 'approved', resolved_at = CURRENT_TIMESTAMP
         WHERE booking_id = $1 AND status = 'pending'`,
        [rows[0].id],
      );
    }
  }
  res.redirect(`/admin?status=${encodeURIComponent(req.body.return_status || "all")}`);
}));

app.post("/admin/bookings/:id/update", requireUser, asyncRoute(async (req, res) => {
  const user = req.session.user;
  const allowedStatuses = ["pending", "confirmed", "completed", "cancelled"];
  const bookingResult = await db.query("SELECT * FROM bookings WHERE id = $1 AND organization_id = $2", [req.params.id, user.organizationId]);
  const booking = bookingResult.rows[0];
  if (!booking || !canManageBooking(user, booking)) {
    return res.status(404).render("message", { title: "Booking not found", message: "This booking is not available to your account." });
  }

  const status = allowedStatuses.includes(req.body.status) ? req.body.status : booking.status;
  if (user.role === "driver") {
    await db.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, booking.id]);
    return res.redirect(`/admin?status=${encodeURIComponent(req.body.return_status || "all")}`);
  }

  const driverId = req.body.driver_id ? Number(req.body.driver_id) : null;
  if (driverId) {
    const driver = await db.query("SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = 'driver' AND is_active = TRUE", [driverId, user.organizationId]);
    if (!driver.rowCount) return res.status(400).render("message", { title: "Invalid driver", message: "Choose an active driver from your organization." });
  }
  const vehicleId = Number(req.body.vehicle_id || booking.vehicle_id);
  const vehicle = await db.query("SELECT id FROM vehicles WHERE id = $1 AND organization_id = $2 AND is_active = TRUE", [vehicleId, user.organizationId]);
  if (!vehicle.rowCount) return res.status(400).render("message", { title: "Invalid vehicle", message: "Choose an active vehicle from your organization." });

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE bookings SET vehicle_id = $1, driver_id = $2, status = $3, payment_status = $4, payment_reference = $5
       WHERE id = $6 AND organization_id = $7`,
      [vehicleId, driverId, status, req.body.payment_status === "paid" ? "paid" : "unpaid", String(req.body.payment_reference || "").trim(), booking.id, user.organizationId],
    );
    if (vehicleId !== Number(booking.vehicle_id)) {
      await client.query("UPDATE booking_schedule_conflicts SET resolved_at = CURRENT_TIMESTAMP WHERE booking_id = $1 AND resolved_at IS NULL", [booking.id]);
    }
    if (status === "cancelled") {
      await client.query("UPDATE booking_cancellation_requests SET status = 'approved', resolved_at = CURRENT_TIMESTAMP WHERE booking_id = $1 AND status = 'pending'", [booking.id]);
    }
    if (driverId && Number(booking.driver_id) !== driverId) {
      await notifyUsers(client, user.organizationId, [driverId], booking.id, "trip_assigned", "New trip assigned", `${booking.reference}: ${booking.pickup_location} to ${booking.drop_location} on ${datePart(booking.pickup_date)} at ${String(booking.pickup_time).slice(0, 5)}.`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  req.session.notice = "Booking updated.";
  res.redirect(`/admin?status=${encodeURIComponent(req.body.return_status || "all")}`);
}));

app.post("/admin/bookings/:id/cancellation", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  const resolution = req.body.resolution === "approved" ? "approved" : "rejected";
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE booking_cancellation_requests SET status = $1, resolved_at = CURRENT_TIMESTAMP
       WHERE booking_id = $2 AND organization_id = $3 AND status = 'pending' RETURNING booking_id`,
      [resolution, req.params.id, req.session.user.organizationId],
    );
    if (result.rowCount && resolution === "approved") {
      await client.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND organization_id = $2", [req.params.id, req.session.user.organizationId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.redirect("/admin");
}));

app.post("/admin/bookings/:id/assign", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  const driverId = req.body.driver_id ? Number(req.body.driver_id) : null;
  if (driverId) {
    const driver = await db.query("SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND role = 'driver' AND is_active = TRUE", [driverId, req.session.user.organizationId]);
    if (!driver.rowCount) return res.status(400).send("Invalid driver");
  }
  const previousResult = await db.query(
    "SELECT driver_id FROM bookings WHERE id = $1 AND organization_id = $2",
    [req.params.id, req.session.user.organizationId],
  );
  const bookingResult = await db.query(
    `UPDATE bookings SET driver_id = $1 WHERE id = $2 AND organization_id = $3
     RETURNING id, reference, pickup_date, pickup_time, pickup_location, drop_location, driver_id`,
    [driverId, req.params.id, req.session.user.organizationId],
  );
  const booking = bookingResult.rows[0];
  if (booking && driverId && Number(previousResult.rows[0]?.driver_id) !== driverId) {
    await notifyUsers(db, req.session.user.organizationId, [driverId], booking.id, "trip_assigned", "New trip assigned", `${booking.reference}: ${booking.pickup_location} to ${booking.drop_location} on ${datePart(booking.pickup_date)} at ${String(booking.pickup_time).slice(0, 5)}.`);
  }
  res.redirect("/admin");
}));

app.get("/admin/notifications", requireUser, asyncRoute(async (req, res) => {
  const { rows: notifications } = await db.query(
    `SELECT * FROM notifications WHERE recipient_user_id = $1
     ORDER BY is_read ASC, created_at DESC LIMIT 100`,
    [req.session.user.id],
  );
  res.render("notifications", { notifications, title: "Notifications" });
}));

app.post("/admin/notifications/read-all", requireUser, asyncRoute(async (req, res) => {
  await db.query("UPDATE notifications SET is_read = TRUE WHERE recipient_user_id = $1", [req.session.user.id]);
  res.redirect("/admin/notifications");
}));

app.post("/admin/notifications/:id/read", requireUser, asyncRoute(async (req, res) => {
  await db.query("UPDATE notifications SET is_read = TRUE WHERE id = $1 AND recipient_user_id = $2", [req.params.id, req.session.user.id]);
  res.redirect("/admin");
}));

app.post("/admin/bookings/:id/payment", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  await db.query(
    "UPDATE bookings SET payment_status = $1, payment_reference = $2 WHERE id = $3 AND organization_id = $4",
    [req.body.payment_status === "paid" ? "paid" : "unpaid", String(req.body.payment_reference || "").trim(), req.params.id, req.session.user.organizationId],
  );
  res.redirect("/admin");
}));

app.get("/admin/drivers", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  const { rows: drivers } = await db.query(
    `SELECT u.id, u.name, u.phone, u.username, u.is_active, COUNT(b.id)::integer AS booking_count
     FROM users u LEFT JOIN bookings b ON b.driver_id = u.id
     WHERE u.organization_id = $1 AND u.role = 'driver'
     GROUP BY u.id, u.name, u.phone, u.username, u.is_active
     ORDER BY u.name`, [req.session.user.organizationId],
  );
  res.render("drivers", { drivers, error: null, title: "Drivers" });
}));

app.post("/admin/drivers", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  const values = req.body;
  if (!["name", "phone", "username", "password"].every((key) => String(values[key] || "").trim())) {
    req.session.notice = "Complete all driver fields."; return res.redirect("/admin/drivers");
  }
  try {
    await db.query(
      `INSERT INTO users (organization_id, role, name, phone, username, password_hash)
       VALUES ($1, 'driver', $2, $3, $4, $5)`,
      [req.session.user.organizationId, values.name.trim(), values.phone.trim(), values.username.trim().toLowerCase(), await bcrypt.hash(values.password, 12)],
    );
    req.session.notice = "Driver account created.";
  } catch (error) {
    req.session.notice = error.code === "23505" ? "That username is already in use." : "Could not create driver.";
  }
  res.redirect("/admin/drivers");
}));

app.post("/admin/drivers/:id/toggle", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  await db.query("UPDATE users SET is_active = NOT is_active WHERE id = $1 AND organization_id = $2 AND role = 'driver'", [req.params.id, req.session.user.organizationId]);
  res.redirect("/admin/drivers");
}));

app.get("/admin/vehicles", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  const { rows: vehicles } = await db.query("SELECT * FROM vehicles WHERE organization_id = $1 ORDER BY id", [req.session.user.organizationId]);
  res.render("vehicles", { vehicles, title: "Vehicles" });
}));

app.post("/admin/vehicles", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  const v = req.body;
  const slug = String(v.name || "vehicle").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + `-${Date.now().toString().slice(-5)}`;
  await db.query(
    `INSERT INTO vehicles (organization_id, slug, name, registration_number, category, seats, bags, rate_per_km, day_rate, image_url, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [req.session.user.organizationId, slug, v.name.trim(), String(v.registration_number || "").trim(), v.category.trim(), Number(v.seats), Number(v.bags || 0), Number(v.rate_per_km), Number(v.day_rate), String(v.image_url || "/images/ertiga.png").trim(), String(v.description || "Comfortable taxi available for hire.").trim()],
  );
  res.redirect("/admin/vehicles");
}));

app.post("/admin/vehicles/:id/toggle", requireUser, requireSuperAdmin, asyncRoute(async (req, res) => {
  await db.query("UPDATE vehicles SET is_active = NOT is_active WHERE id = $1 AND organization_id = $2", [req.params.id, req.session.user.organizationId]);
  res.redirect("/admin/vehicles");
}));

app.get("/health", asyncRoute(async (req, res) => { await db.query("SELECT 1"); res.json({ status: "ok", database: "postgresql" }); }));
app.use((req, res) => res.status(404).render("message", { title: "Page not found", message: "The page you requested does not exist." }));
app.use((error, req, res, next) => { console.error(error); res.status(500).render("message", { title: "Something went wrong", message: "Please try again shortly." }); });

async function start() {
  defaultOrganization = await initializeDatabase();
  app.listen(port, () => console.log(`${defaultOrganization.name} running at http://localhost:${port}`));
}

if (require.main === module) start().catch((error) => { console.error("Application failed to start:", error); process.exit(1); });

module.exports = { app, initializeDatabase, start };
