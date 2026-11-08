# Feature audit (2026-10-23)

Status is based on the checked-in implementation and available prior verification evidence. “Verified” means a runtime/build result was observed, not merely that a route exists.

| Requirement | Status | Notes |
|---|---|---|
| Local PostgreSQL / Prisma schema and migration | Implemented and verified | Local PostgreSQL 18, initial migration, and seeded data were exercised earlier. |
| Authentication, current user, logout, inactive account guard | Implemented but unverified | JWT cookie; active status is reloaded on each protected request. Logout clears browser cookie but has no server-side token revocation. |
| Admin user list/create/update/deactivate | Implemented but unverified | Admin-only API. UI currently creates and deactivates; user editing is API-only. |
| Project create/read/update/archive/delete | Implemented but unverified | Admin creates/deletes; assigned manager can update/archive. Project deletion cascades to tasks/members/comments. |
| Project membership add/remove/role change | Implemented and verified | Assigned manager/project `MANAGER`/Admin endpoints and UI controls. Project roles never elevate global permissions; assigned manager `managerId` is authoritative and protected from other project managers. |
| Task create/read/update/status/delete/assign | Implemented and verified | Version check is atomic. Assignment is limited to active global Team Members with project `MEMBER` or `MANAGER`; assignment never grants authority. |
| Comments list/create/delete | Implemented and verified | Managers can comment on any task; global PM with project `MEMBER` can comment; global Team Member with project `MEMBER` can comment on assigned tasks. Read-only roles cannot comment or delete their own comments. |
| Role and project-boundary authorization | Implemented and verified | 22 authorization tests cover global roles, project roles, manager precedence, cross-project boundaries, assignment, comments, inactive users, 404 hiding, and optimistic concurrency. |
| Team member editing only assigned tasks | Implemented and verified | All project members can read all project tasks; Team Members with project `MEMBER` can mutate only assigned tasks. Project `VIEWER` remains read-only even when assigned. |
| Frontend dashboard and forms | Implemented but unverified | Single page, not dedicated Dashboard/Projects/Tasks/Team/Admin sections. Search/filter/sort and richer loading/empty states are missing. |
| Priority, due dates, labels, subtasks, Kanban, activity, notifications, summaries | Missing | Schema has no corresponding models/fields. |
| Automated API/frontend tests | Implemented and verified | `npm test --prefix backend` runs API authorization tests against a real PostgreSQL test database plus frontend permission-helper parity tests. |
| Builds and pushed baseline | Implemented and verified | Commit `54086ee` was present locally and at `origin/master`; later production builds passed. |

## Ranked implementation sequence

1. Extend the authorization suite when new endpoints or roles are added.
2. Complete core UI actions already backed by APIs (user edit, task assignment, comment deletion) and improve task search/filter.
3. Harden session logout/revocation and normalize API error handling/validation.
4. Add high-value schema-backed task fields (priority and due date) with a non-destructive migration and UI.
5. Consider labels, subtasks, activity, notifications, and Kanban after the core remains green.
