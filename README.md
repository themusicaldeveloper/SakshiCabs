# CityRide Cabs

A small taxi catalog and booking-request app built with Express, EJS, and SQLite.

## Run locally

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open `http://localhost:3000`. The admin dashboard is at
`http://localhost:3000/admin`.

The sample admin password is `admin123`. Change `ADMIN_PASSWORD` and
`SESSION_SECRET` in `.env` before putting the app online.

## Current workflow

1. A visitor compares the Ertiga and Innova.
2. They submit a booking request.
3. The admin signs in, reviews the request, and calls the customer.
4. The admin changes the booking status and records a manual payment reference.

## Change car images

Replace the image files while keeping the same names:

- `public/images/ertiga.png`
- `public/images/innova.png`

To use different filenames, update `image_url` for each car in the SQLite
database. A car-management screen can be added later without changing the
booking data model.

## Change rates

The initial cars and rates are seeded in `server.js`. Existing records are not
overwritten when the app restarts. During this first version, update the values
directly in `data/taxi-booking.db`, or delete the database during development
and restart the app to recreate it from the seed data.

## Data

SQLite creates `data/taxi-booking.db` automatically. Back up this file to back
up the catalog and all bookings.
