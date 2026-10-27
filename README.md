# AICTE FDR Management Portal

A prototype backend for an AICTE-style Security Deposit / Fixed Deposit Receipt (FDR) management portal. Phase 1 created the Express foundation and Phase 2 adds the MongoDB Atlas connection and schema layer. This project is not an official AICTE service.

## Prerequisites

- Node.js (v18 or later)
- npm
- Git
- MongoDB Atlas account with a cluster and database user

## MongoDB Atlas setup requirements

1. Create a MongoDB Atlas cluster and database user.
2. Allow network access from your local IP or use a trusted connection option.
3. Copy the Atlas connection string for the application database.
4. Store the connection string in the local environment only using `server/.env` or a shell export; do not commit real credentials.

## Required environment variables

Create `server/.env` from the example file:

```powershell
cd server
Copy-Item .env.example .env
```

Then update the values in `.env`:

```dotenv
PORT=3000
FRONTEND_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb+srv://<db_username>:<db_password>@cluster.example.mongodb.net/aicte_fdr_portal?retryWrites=true&w=majority
JWT_SECRET=<generate-a-random-secret-at-least-32-characters>
JWT_EXPIRES_IN=15m
ADMIN_NAME=
ADMIN_EMAIL=
ADMIN_PASSWORD=
```

Set `JWT_SECRET` to a new random value of at least 32 characters. `JWT_EXPIRES_IN` defaults to `15m` and may be configured up to `1h`. Set the three `ADMIN_*` values only when provisioning the initial AICTE administrator. Never commit `.env` or real credentials.

## Install dependencies

```powershell
cd server
npm install
```

## Start the backend

For development mode:

```powershell
cd server
npm run dev
```

For production mode:

```powershell
cd server
npm start
```

## Health check

With the server running, request:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

The endpoint returns HTTP 200 with JSON similar to:

```json
{
  "status": "ok",
  "message": "Backend is running",
  "database": {
    "status": "connected"
  }
}
```

## Database checks

Run the MongoDB connectivity and schema validation check:

```powershell
cd server
npm run db:check
```

This script performs:
- a MongoDB ping test
- schema validation smoke tests for Institution, User, FDR, and AuditLog
- no database writes or seeded records

## Phase 3: Authentication and authorization

Authentication endpoints:

- `POST /api/auth/register-institution` — accepts an `institution` object (`name`, `institutionCode`, `contactEmail`, `contactPhone`, `address`) and a `user` object (`fullName`, `email`, `password`). Registration always creates an `institution_user` and sets the institution status to `pending`; client-supplied roles or statuses are rejected.
- `POST /api/auth/login` — accepts `email` and `password`, and returns a short-lived JWT as a Bearer access token.
- `GET /api/auth/me` — requires `Authorization: Bearer <token>` and returns safe current-user and institution details.

Passwords must be at least 12 characters. Login and registration requests are rate limited. Access tokens are not persistent login credentials: the future frontend must not store them in `localStorage`. Refresh-token rotation and persistent login are outside this phase.

Create the initial AICTE administrator by setting `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in the local environment, then run:

```powershell
cd server
npm run bootstrap:admin
```

The script validates the environment, hashes the password, and does not change an existing administrator's password when rerun. Administrator provisioning is not available through public registration. Remove the bootstrap credentials from the environment after provisioning.

Run the auth tests with:

```powershell
cd server
npm test
```

## Troubleshooting connection failures

- Confirm `MONGODB_URI` is set correctly in `server/.env`.
- Verify the Atlas database user has permission to the target database.
- Ensure the current IP is allowed in Atlas Network Access.
- Check that the cluster is running and reachable.
- If the connection fails, review the terminal error and try again after confirming the URL and credentials.

## Current phase scope

Phase 3 adds institution registration, login, Bearer-token authentication, role authorization middleware, current-user lookup, and secure initial administrator provisioning. FDR CRUD APIs, document uploads, OCR, and frontend work remain out of scope.
