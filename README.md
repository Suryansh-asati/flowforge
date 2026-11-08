# FlowForge

FlowForge is a collaborative project workspace for planning projects, managing team tasks, and sharing progress. PostgreSQL runs locally; the Express API and Next.js UI run as separate processes.

## Prerequisites

- Node.js 22+ and npm
- PostgreSQL 14+ running locally, with a `neostats` database

### Install-script policy (npm 12)

`backend/package.json` and `frontend/package.json` pin the reviewed lifecycle scripts in npm 12's `allowScripts` field. The backend approvals are required for Prisma Client/engines and the esbuild binary used by `tsx`. The `sharp` install script is explicitly denied because Sharp uses its prebuilt `@img/*` packages; a global libvips installation can otherwise trigger an unnecessary source build. Approvals are pinned to exact versions, so review and update them when upgrading those packages.

Create the local database as a PostgreSQL administrator (`createdb neostats`, or use pgAdmin). Copy `.env.example` to `backend/.env` and set `DATABASE_URL` to your local account/password. Set a private random `JWT_SECRET`. The default `FRONTEND_ORIGIN` permits the local frontend on ports 3000 and 3001; separate multiple allowed origins with commas. Copy `frontend/.env.example` to `frontend/.env.local`.

## Install and run

In separate terminals:

```powershell
npm install --prefix backend
npm install --prefix frontend
npm run prisma:generate --prefix backend
npm run prisma:migrate --prefix backend -- --name init
npm run prisma:seed --prefix backend
npm run dev --prefix backend
npm run dev --prefix frontend
```

Open http://localhost:3000. API health: http://localhost:4000/api/health.

## Demo accounts

All seeded accounts use `NeoStats123!`:

- Admin: `admin@neostats.local`
- Project Manager: `manager@neostats.local`
- Team Member: `member@neostats.local`
- Viewer: `viewer@neostats.local`

## Application routes

- `/` — sign in; authenticated users are redirected to the dashboard.
- `/dashboard` — project and task summary.
- `/projects` — accessible project list and project creation for Admins.
- `/projects/[projectId]` — authorized project details, team, tasks, and comments.
- `/tasks` — task list and task workflows.
- `/team` — project membership and scoped role management.
- `/admin/users` — Admin-only user management in the UI; API authorization remains authoritative.

## Architecture and authorization

`backend/` is an Express TypeScript REST API and Prisma data layer; `frontend/` is a separate Next.js App Router UI. PostgreSQL stores users, projects, project memberships, tasks, and comments. Passwords use bcrypt hashes. Login issues an HTTP-only, same-site session cookie; every protected request reloads the user and checks that the account is active. Global roles are stored in the database and never accepted from request bodies.

Authorization combines a global role with an optional project role:

- The global role is a ceiling. `ADMIN` overrides project scoping. Global `VIEWER` is always read-only, even if the account has a project `MANAGER` membership.
- `Project.managerId` is authoritative. The assigned manager manages the project even if their `ProjectMember` role is contradictory (for example, `VIEWER`). Only an admin can reassign the manager.
- Project `MANAGER` is a real project-scoped co-manager for global `PROJECT_MANAGER` and `TEAM_MEMBER`. It grants project editing, archiving, task create/update/delete/assign/status, comment moderation, and membership management only inside that project. It never grants global administration or access to another project.
- Project `MEMBER` can read all project tasks, comments, and activity. A global `TEAM_MEMBER` with `MEMBER` can update, change status on, and comment on tasks assigned to them. A global `PROJECT_MANAGER` with `MEMBER` can read and comment but cannot create, edit, delete, or assign tasks or manage the project.
- Project `VIEWER` and global `VIEWER` are strictly read-only. They can read the project, tasks, comments, activity, and members but cannot mutate anything, including their own comments.
- Only active global `TEAM_MEMBER` accounts with project `MEMBER` or `MANAGER` may be assigned tasks. Global `PROJECT_MANAGER` and global `VIEWER` accounts are never assignable. Assignment alone never grants authority.
- Only `ADMIN` can create or delete projects, reassign `Project.managerId`, or manage global users and roles.
- Non-members receive `404` for hidden project resources; members who lack a capability receive `403`.

Task reads include a numeric `version`. A PATCH must send the version it read. The API uses one conditional `updateMany` matching both task ID and version while incrementing the version. If no row matches, it returns `409 TASK_VERSION_CONFLICT` and the current safe task fields. Comments can be listed by project members. Managers can comment on any project task; a global `PROJECT_MANAGER` with project `MEMBER` can comment on visible tasks; a global `TEAM_MEMBER` with project `MEMBER` can comment on assigned tasks. Read-only roles cannot comment. Managers can delete any comment; an author may delete their own only when their effective project role is not read-only. Admin and project management endpoints are described below.

`.env` files are ignored. Never commit local credentials.

## Implemented workflows

- Admins can list/create/update/deactivate users, create projects, assign active Project Managers, view all projects, reassign managers, and delete projects.
- The assigned manager and project `MANAGER` co-managers can update/archive projects, manage project memberships and scoped membership roles, and create/update/delete/assign tasks. Manager reassignment remains Admin-only.
- Team Members can read all tasks in their projects, update/change status on/comment on tasks assigned to them, and add comments where permitted. Viewers can read project/task/comment/activity data but cannot mutate it, including deleting their own comments.
- A global Project Manager with project `MEMBER` can read all project tasks, comments, and activity and add comments, but cannot create, edit, delete, or assign tasks, manage members, or reassign the manager.
- A global Team Member with project `VIEWER` remains read-only even if a task is already assigned to them. Project `VIEWER` users are never eligible assignees.
- Inactive accounts are rejected at login and on every protected request. Non-members receive `404` for hidden resources; members without a required capability receive `403`.
- The routed workspace includes project and task creation, project rename/archive/delete controls, member role controls, task status/deletion controls, comments, and Admin user create/deactivate controls. API authorization remains authoritative.

## Local setup

Use only the local PostgreSQL service. Create the `neostats` database, copy `.env.example` to `backend/.env`, then set `DATABASE_URL` to the local account/database and set a random `JWT_SECRET` with at least 32 characters. Keep `backend/.env` private; it is ignored by Git. Copy `frontend/.env.example` to `frontend/.env.local`.

From the repository root, install and prepare the database:

```powershell
npm install --prefix backend
npm install --prefix frontend
npm run prisma:generate --prefix backend
npm run prisma:migrate --prefix backend -- --name init
npm run prisma:seed --prefix backend
```

For later schema changes, run `npm run prisma:migrate --prefix backend` against the local PostgreSQL database to apply the checked-in migrations without resetting existing data. Step 4 adds the `TaskActivity` table in migration `202610240001_task_activity`; it does not backfill events for actions that occurred before activity tracking was added. Regenerate Prisma Client with `npm run prisma:generate --prefix backend` after schema changes; stop the backend first on Windows so its loaded query engine does not lock the generated binary.

Run these in separate terminals:

```powershell
npm run dev --prefix backend
npm run dev --prefix frontend
```

The frontend is at http://localhost:3000. The API health endpoint is http://localhost:4000/api/health.

Seeded demo credentials (all use `NeoStats123!`): Admin `admin@neostats.local`; Project Manager `manager@neostats.local`; Team Member `member@neostats.local`; Viewer `viewer@neostats.local`.

Membership roles (`MANAGER`, `MEMBER`, `VIEWER`) are project-scoped and never grant global privileges. All project members can read all tasks in the project; write access is restricted by the effective project role. Current limitations: priority, due dates, labels, subtasks, activity history, notifications, and Kanban are not implemented. Task changes require a version and stale writes return 409 `TASK_VERSION_CONFLICT`.

## Authorization tests

The backend test suite exercises the API permission matrix against a real PostgreSQL database:

```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/neostats_test?schema=public"
$env:JWT_SECRET="replace-with-at-least-32-random-characters"
npm test --prefix backend
```

The suite refuses to run unless `DATABASE_URL` contains `test`, because it resets the tables between cases. Apply migrations to that test database first:

```powershell
$env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/neostats_test?schema=public"
npm run prisma:migrate --prefix backend -- --skip-generate
```

The suite covers global roles, project roles, assigned-manager precedence, project boundaries, assignment eligibility, comment deletion, inactive sessions, `404` existence hiding, and optimistic concurrency. Frontend permission-helper parity is checked in the same run.
