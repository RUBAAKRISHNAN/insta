# Lumen Social

Lumen is an original, Instagram-inspired social application with an Express API, a responsive React application, PostgreSQL persistence, authentication, and authenticated post creation.

## Prerequisites

- Node.js 22+
- npm 10+
- PostgreSQL 15+ (required for migrations, authentication, and posts)

## Setup

```bash
npm install
Copy-Item .env.example apps/api/.env
Copy-Item .env.example apps/web/.env
npm run dev
```

The web application runs on `http://localhost:5173`; the API runs on `http://localhost:4000`.

Local API defaults remain available for development. In production, set `NODE_ENV=production`, `DATABASE_URL` to a non-local PostgreSQL URL, and `WEB_ORIGIN` to the exact HTTPS frontend origin (without a path). Production frontend builds require `VITE_API_URL`; use `/api` when routing API requests through the frontend origin, or an HTTPS API URL ending in `/api`. `VITE_` values are compiled into public browser assets and must never contain secrets.

## Deployment (Vercel + Render)

Keep the Vercel project root set to the repository root. The root `vercel.mjs` config builds the shared workspace and Vite frontend, sets the public frontend API base to `/api`, proxies `/api/*` to the configured Render API origin, then falls back to `index.html` for client-side routes. Configure `RENDER_API_ORIGIN` as the Render service's HTTPS origin in Vercel for each deployment environment. Do not include a path, credentials, or a trailing slash. The config rejects local and Vercel origins and compares the target against Vercel's deployment domains to help prevent accidental rewrite loops.

Create the Render API service with the repository root as its working directory and these commands:

```text
Build: npm ci --include=dev && npm run build -w @lumen/shared && npm run build -w @lumen/api
Start: npm run start -w @lumen/api
```

Set `NODE_ENV=production`, `DATABASE_URL` to the separately provisioned production PostgreSQL database, and `WEB_ORIGIN` to the exact canonical deployed Vercel origin (for example, `https://your-project.vercel.app`, with no path or trailing slash). Because API CORS and CSRF checks allow one exact origin, redirect any alternate frontend domains to that canonical origin. Render supplies `PORT`; do not hard-code it. Preview deployments need a matching exact API origin configuration or should not be used for authenticated flows; do not use a wildcard origin.

Before deploying, provision a separate hosted database and verify its identity. Apply the existing migrations with `npm run db:migrate` only after explicitly setting `DATABASE_URL` to that target and confirming it is not a development database. Do not put database credentials in Vercel configuration or source control.

The current image adapter writes to local disk. Render's free service filesystem is not durable across service restarts or redeploys, so uploaded images may be lost; this deployment setup does not add persistent storage. Recheck current Vercel, Render, and PostgreSQL provider limits before launch.

## Database

Set `DATABASE_URL` in `apps/api/.env` to the dedicated local development database, then apply the checked-in migration lineage:

```bash
npm run db:migrate
```

`db:migrate` applies pending migrations only. It never resets or drops a database. Generate a migration only after changing the Drizzle schema and reviewing the generated SQL.

The legacy hand-authored SQL at `apps/api/drizzle/0001_auth.sql` is retained only as a reference. The active lineage, including generated journal and snapshot metadata, lives at `apps/api/drizzle-v2/`.

Post images are stored as generated, non-public files in `apps/api/var/uploads` by default (or in the configured `IMAGE_UPLOAD_DIR`). PostgreSQL stores only each image's storage key and detected content type. The API currently supports local storage, JPEG/PNG/WebP uploads up to 8 MB, and captions up to 2200 characters. Private-account images and post interactions are available only to the owner and approved followers. The `ImageStorage` interface provides the seam for a future object-storage adapter; no cloud storage is configured.

The authenticated home feed includes per-user like state and total like counts. Likes are idempotent through `PUT`/`DELETE /api/posts/:postId/like`. Comments are listed newest-first with stable `(created_at, id)` cursor pagination at `GET /api/posts/:postId/comments`; authenticated users can create comments with `POST` and delete only their own with `DELETE /api/posts/:postId/comments/:commentId`.

Follow relationships are unique per follower/profile pair. Following a public profile is immediate; following a private profile creates a pending request. Profile owners can inspect pending requests at `GET /api/users/me/follow-requests`, approve with `PUT /api/users/follow-requests/:followerId/approve`, or reject with `DELETE /api/users/follow-requests/:followerId`. Accepted follower/following counts exclude pending requests. A private profile's full details and posts are visible only to its owner and accepted followers; other viewers receive only a minimal profile preview and follow state. Profile post listings are available at `GET /api/users/:username/posts` with the same stable cursor pagination as the home feed.

Notifications are generated transactionally for another user's likes and comments, public follows, private follow requests, and approved follow requests. Authenticated users can list them newest-first with cursor pagination at `GET /api/notifications` and mark their own as read with `PUT /api/notifications/:notificationId/read`. Notification responses omit post captions and comment text, and post-image links are returned only when the recipient currently has access. Comment creation accepts an optional UUID `Idempotency-Key`; clients should reuse the same key when retrying a request so the comment and notification are not duplicated.

Direct messages use explicit message requests; following someone does not grant messaging permission. An authenticated user can start or open a conversation with `POST /api/conversations/:username` by sending the first message. The recipient must accept the pending request before either participant can continue; declined requests are closed. Inbox listing (`GET /api/conversations`), message history (`GET /api/conversations/:conversationId/messages`), request acceptance/decline, and read-state updates are restricted to conversation participants. Messages are trimmed, limited to 2,000 characters, and returned newest-first with stable `(created_at, id)` cursor pagination. Each message submission requires a UUID idempotency key. Conversation requests are limited to 10 per 15 minutes and message sends to 60 per 15 minutes per rate-limit identity.

Authenticated user discovery is available at `GET /api/users/discover?q=...`; it performs case-insensitive username-prefix search, excludes the current user, and uses cursor pagination with a maximum page size of 30. Discovery is rate-limited, and private profiles expose no profile details or counts until the viewer is an accepted follower. The web app provides paginated search results and profile pages with authorized posts, follow controls, and private-profile previews. Changing an account to private preserves accepted followers but does not grant access to pending requests; changing it to public accepts outstanding requests.

## Verification

```bash
npm run typecheck
npm run lint
npm run test
npm run build
curl http://localhost:4000/api/health
```

`/api/health` returns only API and database availability; it never returns configuration values.

`npm run test -w @lumen/api` runs the ordinary API unit-test suite and excludes `*.integration.test.ts`; the root `npm run test` therefore does not invoke the database integration suites. Run the separate `npm run test:integration -w @lumen/api` command for database-backed integration tests. Its guard requires `DATABASE_URL` to identify exactly `lumen_social_test` before Vitest starts and imports test files. Each integration test also imports the same guard before application modules, and the integration Vitest config runs it as setup, so directly selecting integration files through Vitest is guarded too. Set the URL explicitly in the process environment to a dedicated test database with the migrations already applied. The guard checks the database name, not the PostgreSQL role's privileges or server identity, so isolate the test role/database from development and production at the PostgreSQL access-control level. Guard-only validation tests can be run without a database using `npm run test:guard -w @lumen/api`.

## Project layout

- `apps/web`: Vite, React, TypeScript, Tailwind frontend
- `apps/api`: Express, Zod, Drizzle API
- `packages/shared`: shared API types and validation schemas

## Troubleshooting

- If the API reports `database: unavailable`, confirm PostgreSQL is running and `DATABASE_URL` points to a database that exists.
- If port 4000 or 5173 is occupied, set `PORT` for the API or use Vite's displayed alternative port.
- Existing accounts remain public by default; changing account privacy does not revoke already-approved followers.
