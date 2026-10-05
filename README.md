# Sakshi Cabs

A mobile-first taxi catalog and dispatch app built with Express, EJS, and
JSON-file persistence.

## Features

- Public vehicle catalog and booking requests
- JSON-file persistence with organization-scoped data
- Super-admin and driver accounts
- Dynamic driver and vehicle management
- Booking-to-driver assignment
- Driver-only view of assigned trips
- Compact, expandable mobile operations list
- Manual payment and booking status tracking
- Configurable vehicle scheduling gap and live availability checks
- In-app notifications for new bookings and driver assignments
- Customer booking tracking and manager-approved cancellation requests

## Local setup

1. Install packages and create the environment file:

```powershell
npm install
Copy-Item .env.example .env
```

2. Set `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env`, then run:

```powershell
npm run dev
```

The schema and starter organization, admin, Ertiga, and Innova are created
automatically and saved to `data/taxi-booking.json`. Open
`http://localhost:3000` and use
`http://localhost:3000/admin` for team login.

Default development login:

- Username: `admin`
- Password: `admin123`

Change `ADMIN_PASSWORD` and `SESSION_SECRET` before the first production
deployment. The seeded admin password is only read when that account is first
created. Admin sessions are held in memory and users will need to sign in again
after an app restart.

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
Confirmed conflicts are shown as already booked. A cancellation request does
not release the vehicle until the manager approves it.
Customers can still send an unavailable selection for manager review. The
request is flagged in dispatch, creates a dedicated admin notification, and can
be moved to an available vehicle from the consolidated booking update form.

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

## JSON storage and deployment

The app reads and writes the dataset at `DATA_FILE` (default
`data/taxi-booking.json`). Set `DATA_FILE` to a path on a persistent writable
volume when deploying. The JSON file is written atomically and contains account
password hashes and business records, so keep it private and include it in
regular backups.

This low-cost starter storage is intended for one app instance with modest
traffic. Do not run multiple app instances against the same JSON file: this
setup does not provide cross-instance locking or database-level transaction
guarantees. Hosting platforms with ephemeral filesystems can lose the dataset
when the app is redeployed or restarted; use a persistent disk or move to a
managed database before scaling.

## GitHub Pages static site

The `site` folder contains a separate static public website. It shows the
starter fleet and lets customers contact the business by phone or WhatsApp.
It does not run the Express app: online booking submissions, booking
management, admin login, and JSON dataset writes are not available on GitHub
Pages. The Node app can continue to be hosted separately.

To publish it, push this repository to GitHub on the `main` branch, then in
repository **Settings → Pages**, select **GitHub Actions** as the build and
deployment source. The workflow deploys the `site` folder when it changes, or
can be started manually from the Actions tab.

The static site displays the business contact number configured in
`site/index.html`. The static site is public, so only put public business
contact details there.

## Vehicle images

The two starter images are in `public/images`. New vehicles accept a local image
path or hosted image URL. Direct image upload and object storage can be added in
a later version.
