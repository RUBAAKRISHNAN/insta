# Lumen Social

Lumen is an original, Instagram-inspired social application. This repository currently contains the Phase 2 foundation: an Express API, a responsive React application shell, and a PostgreSQL/Drizzle setup ready for the authentication milestone.

## Prerequisites

- Node.js 22+
- npm 10+
- PostgreSQL 15+ (required only for migrations and database health checks)

## Setup

```bash
npm install
Copy-Item .env.example apps/api/.env
Copy-Item .env.example apps/web/.env
npm run dev
```

The web application runs on `http://localhost:5173`; the API runs on `http://localhost:4000`.

## Database

Create an empty PostgreSQL database, set `DATABASE_URL` in `apps/api/.env`, then run:

```bash
npm run db:generate
npm run db:migrate
```

`db:migrate` applies generated migrations only. It never resets or drops a database.

Before applying authentication migrations, configure a dedicated local database (never production):

```bash
createdb lumen_social
Copy-Item .env.example apps/api/.env
# Set DATABASE_URL in apps/api/.env to the new database.
npm run db:migrate
```

The legacy hand-authored SQL at `apps/api/drizzle/0001_auth.sql` is retained only as a reference. A fresh development-only Drizzle lineage, including generated journal and snapshot metadata, lives at `apps/api/drizzle-v2/`. It is configured as the active migration output. No migration has been applied by this project.

## Verification

```bash
npm run typecheck
npm run lint
npm run test
npm run build
curl http://localhost:4000/api/health
```

`/api/health` returns only API and database availability; it never returns configuration values.

## Project layout

- `apps/web`: Vite, React, TypeScript, Tailwind frontend
- `apps/api`: Express, Zod, Drizzle API
- `packages/shared`: shared API types and validation schemas

## Troubleshooting

- If the API reports `database: unavailable`, confirm PostgreSQL is running and `DATABASE_URL` points to a database that exists.
- If port 4000 or 5173 is occupied, set `PORT` for the API or use Vite's displayed alternative port.
- The current feed uses explicitly labelled development-only sample data; it is not persisted or connected to the API yet.
