const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

/*
|--------------------------------------------------------------------------
| Database setup
|--------------------------------------------------------------------------
*/

const dataDirectory = path.join(__dirname, "data");
fs.mkdirSync(dataDirectory, { recursive: true });

const databasePath = path.join(dataDirectory, "taxi-booking.db");

const db = new Database(databasePath);

// Simpler journal mode for a temporary Heroku SQLite deployment.
db.pragma("journal_mode = DELETE");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS cars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    seats INTEGER NOT NULL,
    bags INTEGER NOT NULL,
    rate_per_km INTEGER NOT NULL,
    day_rate INTEGER NOT NULL,
    image_url TEXT NOT NULL,
    description TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE NOT NULL,
    car_id INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    pickup_location TEXT NOT NULL,
    drop_location TEXT NOT NULL,
    pickup_date TEXT NOT NULL,
    pickup_time TEXT NOT NULL,
    trip_type TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    payment_reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (car_id) REFERENCES cars(id)
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_reference
  ON bookings(reference);

  CREATE INDEX IF NOT EXISTS idx_bookings_status
  ON bookings(status);

  CREATE INDEX IF NOT EXISTS idx_bookings_pickup_date
  ON bookings(pickup_date);
`);

/*
|--------------------------------------------------------------------------
| Business configuration
|--------------------------------------------------------------------------
*/

const business = {
  name: process.env.BUSINESS_NAME || "CityRide Cabs",
  phone: process.env.BUSINESS_PHONE || "+91 98765 43210",
};

/*
|--------------------------------------------------------------------------
| Seed cars
|--------------------------------------------------------------------------
*/

const seedCar = db.prepare(`
  INSERT OR IGNORE INTO cars
  (
    slug,
    name,
    category,
    seats,
    bags,
    rate_per_km,
    day_rate,
    image_url,
    description
  )
  VALUES
  (
    @slug,
    @name,
    @category,
    @seats,
    @bags,
    @rate_per_km,
    @day_rate,
    @image_url,
    @description
  )
`);

const carsToSeed = [
  {
    slug: "ertiga",
    name: "Maruti Suzuki Ertiga",
    category: "Comfort MPV",
    seats: 6,
    bags: 3,
    rate_per_km: 16,
    day_rate: 3200,
    image_url: "/images/ertiga.png",
    description:
      "A comfortable and efficient choice for family trips, airport transfers, and city travel.",
  },
  {
    slug: "innova",
    name: "Toyota Innova Crysta",
    category: "Premium MPV",
    seats: 7,
    bags: 4,
    rate_per_km: 22,
    day_rate: 4500,
    image_url: "/images/innova.png",
    description:
      "Extra space and premium comfort for long journeys, business travel, and larger groups.",
  },
];

const seedCarsTransaction = db.transaction((cars) => {
  for (const car of cars) {
    seedCar.run(car);
  }
});

seedCarsTransaction(carsToSeed);

/*
|--------------------------------------------------------------------------
| Express configuration
|--------------------------------------------------------------------------
*/

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

if (isProduction) {
  // Heroku runs behind a reverse proxy.
  app.set("trust proxy", 1);
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/*
|--------------------------------------------------------------------------
| Session configuration
|--------------------------------------------------------------------------
*/

const sessionSecret =
  process.env.SESSION_SECRET || "local-development-secret-change-this";

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 8 * 60 * 60 * 1000,
    },
  }),
);

/*
|--------------------------------------------------------------------------
| Shared view values
|--------------------------------------------------------------------------
*/

app.use((req, res, next) => {
  res.locals.business = business;
  res.locals.currentPath = req.path;
  next();
});

/*
|--------------------------------------------------------------------------
| Helper functions
|--------------------------------------------------------------------------
*/

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) {
    return next();
  }

  return res.redirect("/admin/login");
}

function createReference() {
  const year = new Date().getFullYear();
  const randomCode = crypto.randomBytes(4).toString("hex").toUpperCase();

  return `CR-${year}-${randomCode}`;
}

function createUniqueReference() {
  let reference;
  let exists;

  do {
    reference = createReference();

    exists = db
      .prepare("SELECT id FROM bookings WHERE reference = ?")
      .get(reference);
  } while (exists);

  return reference;
}

/*
|--------------------------------------------------------------------------
| Public routes
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  const cars = db
    .prepare(
      `
        SELECT *
        FROM cars
        WHERE is_active = 1
        ORDER BY id
      `,
    )
    .all();

  return res.render("home", {
    cars,
    title: "Reliable taxis for every journey",
  });
});

app.get("/cars/:slug", (req, res) => {
  const car = db
    .prepare(
      `
        SELECT *
        FROM cars
        WHERE slug = ?
          AND is_active = 1
      `,
    )
    .get(req.params.slug);

  if (!car) {
    return res.status(404).render("message", {
      title: "Car not found",
      message: "This car is not currently available.",
    });
  }

  return res.render("car", {
    car,
    title: car.name,
  });
});

app.get("/book", (req, res) => {
  const cars = db
    .prepare(
      `
        SELECT *
        FROM cars
        WHERE is_active = 1
        ORDER BY id
      `,
    )
    .all();

  const requestedCarId = Number(req.query.car);
  const selectedCarExists = cars.some((car) => car.id === requestedCarId);

  const selectedCarId = selectedCarExists
    ? requestedCarId
    : cars[0]?.id || null;

  return res.render("book", {
    cars,
    selectedCarId,
    error: null,
    values: {},
    title: "Request a booking",
  });
});

app.post("/book", (req, res) => {
  const values = req.body;

  const cars = db
    .prepare(
      `
        SELECT *
        FROM cars
        WHERE is_active = 1
        ORDER BY id
      `,
    )
    .all();

  const selectedCarId = Number(values.car_id);

  const car = cars.find((item) => item.id === selectedCarId);

  const requiredFields = [
    "customer_name",
    "phone",
    "pickup_location",
    "drop_location",
    "pickup_date",
    "pickup_time",
    "trip_type",
  ];

  const hasMissingFields = requiredFields.some(
    (key) => !String(values[key] || "").trim(),
  );

  if (!car || hasMissingFields) {
    return res.status(400).render("book", {
      cars,
      selectedCarId,
      values,
      error: "Please complete all required fields.",
      title: "Request a booking",
    });
  }

  const reference = createUniqueReference();

  const insertBooking = db.prepare(`
    INSERT INTO bookings
    (
      reference,
      car_id,
      customer_name,
      phone,
      email,
      pickup_location,
      drop_location,
      pickup_date,
      pickup_time,
      trip_type,
      notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertBooking.run(
    reference,
    car.id,
    String(values.customer_name).trim(),
    String(values.phone).trim(),
    String(values.email || "").trim(),
    String(values.pickup_location).trim(),
    String(values.drop_location).trim(),
    String(values.pickup_date).trim(),
    String(values.pickup_time).trim(),
    String(values.trip_type).trim(),
    String(values.notes || "").trim(),
  );

  return res.redirect(
    `/booking/success?reference=${encodeURIComponent(reference)}`,
  );
});

app.get("/booking/success", (req, res) => {
  const reference = String(req.query.reference || "").trim();

  const booking = db
    .prepare(
      `
        SELECT
          bookings.*,
          cars.name AS car_name
        FROM bookings
        INNER JOIN cars
          ON cars.id = bookings.car_id
        WHERE bookings.reference = ?
      `,
    )
    .get(reference);

  if (!booking) {
    return res.redirect("/");
  }

  return res.render("success", {
    booking,
    title: "Booking request received",
  });
});

/*
|--------------------------------------------------------------------------
| Admin authentication
|--------------------------------------------------------------------------
*/

app.get("/admin/login", (req, res) => {
  if (req.session.isAdmin) {
    return res.redirect("/admin");
  }

  return res.render("login", {
    error: null,
    title: "Admin sign in",
  });
});

app.post("/admin/login", (req, res) => {
  const expectedPassword = process.env.ADMIN_PASSWORD || "admin123";
  const enteredPassword = String(req.body.password || "");

  if (enteredPassword !== expectedPassword) {
    return res.status(401).render("login", {
      error: "Incorrect password.",
      title: "Admin sign in",
    });
  }

  req.session.isAdmin = true;

  return req.session.save(() => {
    res.redirect("/admin");
  });
});

app.post("/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Unable to destroy session:", error);
    }

    res.clearCookie("connect.sid");
    res.redirect("/admin/login");
  });
});

/*
|--------------------------------------------------------------------------
| Admin dashboard
|--------------------------------------------------------------------------
*/

app.get("/admin", requireAdmin, (req, res) => {
  const allowedFilters = [
    "all",
    "pending",
    "confirmed",
    "completed",
    "cancelled",
  ];

  const requestedFilter = String(req.query.status || "all");

  const filter = allowedFilters.includes(requestedFilter)
    ? requestedFilter
    : "all";

  const bookings =
    filter === "all"
      ? db
          .prepare(
            `
              SELECT
                bookings.*,
                cars.name AS car_name
              FROM bookings
              INNER JOIN cars
                ON cars.id = bookings.car_id
              ORDER BY
                pickup_date ASC,
                pickup_time ASC,
                bookings.id ASC
            `,
          )
          .all()
      : db
          .prepare(
            `
              SELECT
                bookings.*,
                cars.name AS car_name
              FROM bookings
              INNER JOIN cars
                ON cars.id = bookings.car_id
              WHERE bookings.status = ?
              ORDER BY
                pickup_date ASC,
                pickup_time ASC,
                bookings.id ASC
            `,
          )
          .all(filter);

  const counts = db
    .prepare(
      `
        SELECT
          status,
          COUNT(*) AS count
        FROM bookings
        GROUP BY status
      `,
    )
    .all();

  return res.render("admin", {
    bookings,
    counts,
    filter,
    title: "Booking dashboard",
  });
});

app.post("/admin/bookings/:id/status", requireAdmin, (req, res) => {
  const allowedStatuses = [
    "pending",
    "confirmed",
    "completed",
    "cancelled",
  ];

  const bookingId = Number(req.params.id);
  const newStatus = String(req.body.status || "");

  if (Number.isInteger(bookingId) && allowedStatuses.includes(newStatus)) {
    db.prepare(
      `
        UPDATE bookings
        SET status = ?
        WHERE id = ?
      `,
    ).run(newStatus, bookingId);
  }

  const returnStatus = String(req.body.return_status || "");

  if (allowedStatuses.includes(returnStatus)) {
    return res.redirect(
      `/admin?status=${encodeURIComponent(returnStatus)}`,
    );
  }

  return res.redirect("/admin");
});

app.post("/admin/bookings/:id/payment", requireAdmin, (req, res) => {
  const bookingId = Number(req.params.id);

  if (!Number.isInteger(bookingId)) {
    return res.redirect("/admin");
  }

  const paymentStatus =
    req.body.payment_status === "paid" ? "paid" : "unpaid";

  const paymentReference = String(
    req.body.payment_reference || "",
  ).trim();

  db.prepare(
    `
      UPDATE bookings
      SET
        payment_status = ?,
        payment_reference = ?
      WHERE id = ?
    `,
  ).run(paymentStatus, paymentReference, bookingId);

  return res.redirect("/admin");
});

/*
|--------------------------------------------------------------------------
| Health-check route
|--------------------------------------------------------------------------
*/

app.get("/health", (req, res) => {
  try {
    db.prepare("SELECT 1").get();

    return res.status(200).json({
      status: "ok",
      application: business.name,
      database: "connected",
    });
  } catch (error) {
    console.error("Health check failed:", error);

    return res.status(500).json({
      status: "error",
      database: "unavailable",
    });
  }
});

/*
|--------------------------------------------------------------------------
| 404 handler
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  return res.status(404).render("message", {
    title: "Page not found",
    message: "The page you requested does not exist.",
  });
});

/*
|--------------------------------------------------------------------------
| Error handler
|--------------------------------------------------------------------------
*/

app.use((error, req, res, next) => {
  console.error("Unhandled application error:", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).render("message", {
    title: "Something went wrong",
    message: "The application encountered an unexpected error.",
  });
});

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`${business.name} running on port ${port}`);
  console.log(`Database path: ${databasePath}`);
});

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

function shutdown(signal) {
  console.log(`${signal} received. Closing application.`);

  server.close(() => {
    try {
      db.close();
      console.log("Database connection closed.");
    } catch (error) {
      console.error("Error closing database:", error);
    }

    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));