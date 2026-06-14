# PesaSmart — Backend

The backend API for **PesaSmart**, a USSD-based group governance and transparency platform for informal **Ikimina** (rotating savings) circles in urban Rwanda. It powers two interfaces: the **USSD member menu** (via Africa's Talking) and the **organiser web admin panel**.


## Live Links

- **API:** https://pesasmart-backend.onrender.com
- **Web app:** https://pesasmart.vercel.app

## Tech Stack

- Node.js + Express
- PostgreSQL (Neon)
- bcryptjs (PINs are hashed, never stored in plain text)
- Africa's Talking (USSD + SMS)
- Hosted on Render; CI via GitHub Actions

## Endpoints

- `GET /` — health check
- `GET /db-check` — database connectivity check
- `POST /api/signup` — register an organiser
- `POST /api/login` — organiser login
- `POST /ussd` — USSD member menu (called by Africa's Talking)

## Running Locally

```
git clone https://github.com/Usanas7/pesasmart-backend.git
cd pesasmart-backend
npm install
```

Create a `.env` file (see `.env.example`):

```
PORT=3000
DATABASE_URL=your-postgres-connection-string
```

Then:

```
npm start
```

API runs at http://localhost:3000 (test http://localhost:3000/db-check).

## Database Schema

Seven tables, derived from the project ERD: `users`, `ikimina_groups`, `ikimina_members`, `rotation_cycles`, `contribution_disputes`, `membership_changes`, `sms_notifications`.


## Architecture Note

PesaSmart's member-facing interface runs over **USSD** so any member can use it from any phone without internet. This backend serves both that USSD menu and the organiser **admin panel** (the frontend repo above).
