# CityRide Cabs

A mobile-first taxi catalog and dispatch app built with Express, EJS, and
PostgreSQL.

## Features

- Public vehicle catalog and booking requests
- PostgreSQL persistence with organization-scoped data
- Super-admin and driver accounts
- Dynamic driver and vehicle management
- Booking-to-driver assignment
- Driver-only view of assigned trips
- Compact, expandable mobile operations list
- Manual payment and booking status tracking
- Configurable vehicle scheduling gap and live availability checks
- In-app notifications for new bookings and driver assignments

## Local setup

1. Install PostgreSQL and create a database named `taxi_booking`.
2. Install packages and create the environment file:

```powershell
npm install
Copy-Item .env.example .env
```

3. Update `DATABASE_URL` in `.env`, then run:

```powershell
npm run dev
```

The schema and starter organization, admin, Ertiga, and Innova are created
automatically. Open `http://localhost:3000` and use
`http://localhost:3000/admin` for team login.

Default development login:

- Username: `admin`
- Password: `admin123`

Change `ADMIN_PASSWORD` and `SESSION_SECRET` before the first production
deployment. The seeded admin password is only read when that account is first
created.

## Roles

**Super admin** can see every booking for their organization, register drivers,
add vehicles, assign trips, update statuses, and record payment.

**Driver** can sign in with the account created by the super admin, see only
trips assigned to them, call the customer, and update the trip status.

## Availability rule

`AVAILABILITY_GAP_HOURS` controls the minimum time between two non-cancelled
bookings for the same vehicle. It defaults to `6`. Customers see a live check
after choosing the vehicle, date, and time. A conflicting slot is not submitted
online and the customer is asked to confirm directly with the manager.

## Notifications

New booking requests create an unread notification for every active super
admin in the organization. Assigning a booking creates an unread notification
for that driver. Notifications are currently in-app; email, SMS, and push
delivery can use the same records later.

## SaaS foundation

All users, vehicles, and bookings include an `organization_id`. The current
public site uses the organization configured by `TENANT_SLUG`. A later version
can resolve the organization from a custom domain or URL without changing the
core tables.

## Deployment

Set `DATABASE_URL` to a hosted PostgreSQL connection string. For providers that
require TLS, set `DATABASE_SSL=true`. The app can then run on DigitalOcean App
Platform, Render, Railway, Heroku, or a DigitalOcean Droplet without storing
business data on the app server filesystem.

## Vehicle images

The two starter images are in `public/images`. New vehicles accept a local image
path or hosted image URL. Direct image upload and object storage can be added in
a later version.
