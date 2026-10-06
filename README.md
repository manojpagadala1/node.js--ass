- Client profiles and project management with budgets, deadlines, status, deliverable URLs, and uploaded files (PDF, images, text, Word, or Excel; 10 MB maximum).
![Studioflow freelancer dashboard](docs/screenshots/dashboard.png)

![Studioflow mobile dashboard](docs/screenshots/dashboard-mobile.png)
# Studioflow

Studioflow is a freelancer workspace for clients, projects, tasks, invoices, payments, and project history. The React client uses an Express API backed by Neon Postgres. Local development stores uploaded files on disk; production uploads go directly to Vercel Blob.

## Requirements

- Node.js 20.19+ (Node 24 recommended)
- npm 10+

## Local setup

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Set `DATABASE_URL` in `.env` to a Neon connection string before starting the app. Open `http://localhost:5173`. The development command starts Vite on port 5173 and the API on port 3001; Vite proxies `/api` requests to Express. On first start, the API creates the schema and seeds local demo data. Local uploads are stored in `server/uploads/`.

For a production build and local API process:

```powershell
npm run build
$env:NODE_ENV = 'production'
npm start
```

The API listens on port 3001. Set `PORT` if needed. Vercel serves the built client separately from its API function.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Express listen port |
| `JWT_SECRET` | Development-only fallback | Signing key; set a long random value outside local development |
| `DATABASE_URL` | — | Neon Postgres connection string |
| `BLOB_READ_WRITE_TOKEN` | — | Vercel Blob token; required for deployed uploads and migrating existing attachments |
| `INITIAL_ADMIN_EMAIL` | — | Required for an empty production database |
| `INITIAL_ADMIN_PASSWORD` | — | Initial production admin password; must contain at least 12 characters |
| `INITIAL_ADMIN_NAME` | `Studio Admin` | Optional name for the initial production admin |
| `MIGRATION_FREELANCER_PASSWORD`, `MIGRATION_CLIENT_PASSWORD`, `MIGRATION_ADMIN_PASSWORD` | — | Unique replacement passwords for unchanged seeded demo accounts during SQLite migration |
| `CLIENT_ORIGIN` | Any origin | Optional CORS origin when hosting client and API separately |
| `NODE_ENV` | — | Set to `production` to require `JWT_SECRET` and initialize the first production admin |

Do not commit `.env` or production credentials. Local demo accounts use password `studio123`; production never seeds those shared demo credentials.

## Demo accounts

All seeded users use password `studio123`.

| Role | Email |
| --- | --- |
| Freelancer | `alex@studioflow.app` |
| Client | `maya@northstar.studio` |
| Admin | `admin@studioflow.app` |

The freelancer account can manage clients, projects, tasks, invoices, and payment entries. The client account is limited to that client's own project data and cannot mutate records. The admin account has management access.

## Features

- Freelancer dashboard with collected earnings, outstanding balances, active projects, and task completion.
- Client profiles and project management with budgets, deadlines, status, deliverable URLs, and uploaded files (PDF, images, text, Word, or Excel; 10 MB maximum).
- Kanban task board with `To Do`, `In Progress`, and `Completed` states, priorities, and due dates.
- Invoice creation for projects with completed work, partial-payment tracking, and overpayment prevention.
- Project history for project creation, task changes, invoice creation, and payments.
- JWT sign-in, backend role checks, Zod input validation, empty/loading/error states, and responsive layouts.
- Project titles are unique per client (case-insensitive); Postgres enforces the constraint.

## API overview

All routes except `GET /api/health` and `POST /api/auth/login` require `Authorization: Bearer <token>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `POST` | `/api/auth/login` | Sign in and receive a 12-hour JWT |
| `GET` | `/api/auth/me` | Current user and role |
| `GET`, `POST` | `/api/clients` | List or create clients |
| `PUT` | `/api/clients/:id` | Update a client |
| `GET`, `POST` | `/api/projects` | List or create projects |
| `PUT` | `/api/projects/:id` | Update a project |
| `POST` | `/api/projects/:id/attachment` | Upload a project deliverable |
| `POST` | `/api/projects/:id/attachment/confirm` | Save a completed Vercel Blob upload |
| `POST` | `/api/uploads` | Authorize direct Vercel Blob uploads |
| `GET` | `/uploads/:filename` | Retrieve an uploaded deliverable |
| `GET`, `POST` | `/api/tasks` | List or create tasks |
| `PUT` | `/api/tasks/:id/status` | Change task status |
| `GET`, `POST` | `/api/invoices` | List or create invoices |
| `POST` | `/api/invoices/:id/payments` | Record a partial or final payment |
| `GET` | `/api/payments` | Payment history |
| `GET` | `/api/history` | Project lifecycle activity |
| `GET` | `/api/dashboard/summary` | Earnings, project, and task summary |

The API returns JSON errors with appropriate `4xx` status codes for invalid data, duplicate project titles, permission violations, and overpayments. Invoice creation requires at least one completed task on its project.

## Database

The schema is initialized in `server/database.js`. Tables: `users`, `clients`, `projects`, `tasks`, `invoices`, `payments`, and `project_history`. Database initialization is safe to run more than once. Local demo data is inserted only when the users table is empty.

## Deployment

### Migrate existing SQLite data

Create an empty Neon database and configure `DATABASE_URL` in `.env`. If the SQLite database has uploaded deliverables, also set `BLOB_READ_WRITE_TOKEN` and keep the files in `server/uploads/`. By default, the migration reads `server/data.sqlite`; override the path with `SQLITE_DATABASE_PATH`.

```powershell
npm run migrate:sqlite
```

The migration preserves record IDs and relationships, copies uploaded deliverables to Vercel Blob, updates their URLs, resets Postgres ID sequences, and verifies imported row counts. It refuses to import into non-empty Neon tables. If the database still contains any of the published `studio123` demo passwords, provide a different 12-character-or-longer migration password for each affected account in `.env`; the migration replaces those password hashes before import. Keep a backup of the SQLite database and uploads until you have verified the Neon application.

### Deploy to Vercel

Import this GitHub repository into Vercel. The included `vercel.json` builds the Vite client and routes `/api/*` to the Express function. Create a Vercel Blob store for the project and configure these Production environment variables:

- `DATABASE_URL`: Neon Postgres connection string.
- `JWT_SECRET`: a unique, randomly generated secret.
- `BLOB_READ_WRITE_TOKEN`: the token for the connected Vercel Blob store.
- `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`: credentials for the first admin when the database is empty; the password must be at least 12 characters.
- `INITIAL_ADMIN_NAME` (optional): the initial admin's display name.

If you are importing an existing SQLite database, finish the Neon/Blob migration before the first production API request. Otherwise, the first request creates an administrator using the initial-admin credentials. Vercel deployments use Postgres and Blob rather than the function's temporary filesystem.

## Screenshots

![Studioflow freelancer dashboard](docs/screenshots/dashboard.png)

![Studioflow mobile dashboard](docs/screenshots/dashboard-mobile.png)
