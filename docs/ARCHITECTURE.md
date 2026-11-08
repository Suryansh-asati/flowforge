# Architecture note

The backend owns authentication, authorization, validation, and persistence. The Next.js frontend calls the Express API using an HTTP-only session cookie. Prisma maps five core entities: users, projects, project memberships, tasks, and comments. The local PostgreSQL database is the only persistence service.

Global roles are Admin, Project Manager, Team Member, and Viewer. Project roles are Manager, Member, and Viewer. Authorization is the intersection of the two: the global role is a ceiling, and the project role only applies inside one project. `ADMIN` overrides project scoping. Global `VIEWER` remains read-only regardless of project role. `Project.managerId` is authoritative: the assigned manager manages the project even if their `ProjectMember` role is contradictory, and only an admin can reassign or remove that assignment. A project `MANAGER` is a real co-manager for global Project Managers and Team Members, but never grants global administration or access to another project.

All project members can read project details, tasks, comments, activity, and members. A global Team Member with project `MEMBER` can update, change status on, and comment on assigned tasks. A global Project Manager with project `MEMBER` can read and comment but cannot create, edit, delete, or assign tasks or manage members. Project `VIEWER` and global `VIEWER` are strictly read-only, including their own comments. Only active global Team Members with project `MEMBER` or `MANAGER` are eligible assignees; assignment alone never grants authority. Only admins create/delete projects, reassign managers, or manage global users. Non-members receive `404`; members lacking a capability receive `403`. Every API request reloads the session user and rejects inactive accounts.

### Permission matrix

Columns describe the caller’s effective project role. “Assigned manager” means `Project.managerId`; their authority overrides a contradictory membership role. Global `VIEWER` is clamped to the read-only column even when a project membership says `MANAGER`.

| # | Operation | Admin | Assigned manager / project `MANAGER` | Global `TEAM_MEMBER` + `MEMBER` | Global `PROJECT_MANAGER` + `MEMBER` | Project `VIEWER` / global `VIEWER` |
|---|---|---|---|---|---|---|
| 1 | View project details | Yes | Yes | Yes | Yes | Yes |
| 2 | Update project name/description | Yes | Yes | No | No | No |
| 3 | Archive / unarchive project | Yes | Yes | No | No | No |
| 4 | Delete project | Yes | No | No | No | No |
| 5 | Reassign `managerId` | Yes | No | No | No | No |
| 6 | Add project member | Yes | Yes | No | No | No |
| 7 | Remove project member | Yes | Yes¹ | No | No | No |
| 8 | Change member project role | Yes | Yes¹ | No | No | No |
| 9 | Create task | Yes | Yes | No | No | No |
| 10 | View all project tasks | Yes | Yes | Yes | Yes | Yes |
| 11 | Edit task title/description | Yes | Yes | Assigned only | No | No |
| 12 | Change task status | Yes | Yes | Assigned only | No | No |
| 13 | Assign task | Yes | Yes | No | No | No |
| 14 | Delete task | Yes | Yes | No | No | No |
| 15 | Add comment | Yes | Yes | Assigned tasks only | Any visible task | No |
| 16 | Delete comment | Yes | Any comment | Own comment on assigned task | Own comment | No |

¹ A non-admin project manager cannot remove or change the membership of the assigned `managerId`; that attempt returns `403 ASSIGNED_MANAGER_PROTECTED`. Only an admin may alter that membership. Co-managers can manage other memberships.

Global user administration (list/create/update/deactivate users) is outside the project matrix and remains `ADMIN`-only.

Task version starts at 1. A client PATCH includes its observed version, and a single conditional database update matches `(task ID, version)` and increments the version. A stale edit receives HTTP 409 and `TASK_VERSION_CONFLICT`, with safe current task fields to support reload. PostgreSQL foreign keys and unique membership constraints protect relational integrity.

The backend authorization suite runs against a real PostgreSQL test database and covers the global/project role matrix, assigned-manager precedence, assignment eligibility, comment permissions, project boundaries, inactive sessions, existence hiding, and optimistic concurrency. The same run checks frontend permission-helper parity. See `README.md` for the test command and the `DATABASE_URL` safety requirement.
