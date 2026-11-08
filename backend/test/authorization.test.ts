import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PrismaClient, Role, ProjectRole, TaskStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { app } from "../src/index";

const testDatabaseUrl = process.env.DATABASE_URL || "";
if (!/test/i.test(testDatabaseUrl))
  throw new Error(
    "Refusing to run authorization tests: DATABASE_URL must point to a test database or schema.",
  );

const prisma = new PrismaClient();
const PASSWORD = "TestPassword123!";
const USER = {
  admin: "u-admin",
  pmAssigned: "u-pm-assigned",
  pmCoManager: "u-pm-co-manager",
  pmMember: "u-pm-member",
  pmViewer: "u-pm-viewer",
  pmOutsider: "u-pm-outsider",
  tmManager: "u-tm-manager",
  tmMember: "u-tm-member",
  tmViewer: "u-tm-viewer",
  viewer: "u-viewer",
  viewerManager: "u-viewer-manager",
  outsider: "u-outsider",
  inactive: "u-inactive",
} as const;
const PROJECT = { alpha: "p-alpha", beta: "p-beta" } as const;
const TASK = {
  assignedTm2: "cmalphaassignedtm200000000",
  assignedTm3: "cmalphaassignedtm300000000",
  unassigned: "cmalphaunassigned00000000",
  beta: "cmbetaunassigned000000000",
} as const;
const COMMENT = {
  byViewer: "cbyviewer0000000000000000",
  byTm3: "cbytm30000000000000000000",
  byPm3: "cbypm30000000000000000000",
  byTm2: "cbytm20000000000000000000",
} as const;

let server: Server;
let baseUrl = "";
let passwordHash = "";

async function createUser(
  id: string,
  role: Role,
  active = true,
) {
  return prisma.user.create({
    data: {
      id,
      name: id.replace("u-", ""),
      email: `${id}@test.local`,
      passwordHash,
      role,
      active,
    },
  });
}

async function resetFixtures() {
  await prisma.taskActivity.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  await createUser(USER.admin, Role.ADMIN);
  await createUser(USER.pmAssigned, Role.PROJECT_MANAGER);
  await createUser(USER.pmCoManager, Role.PROJECT_MANAGER);
  await createUser(USER.pmMember, Role.PROJECT_MANAGER);
  await createUser(USER.pmViewer, Role.PROJECT_MANAGER);
  await createUser(USER.pmOutsider, Role.PROJECT_MANAGER);
  await createUser(USER.tmManager, Role.TEAM_MEMBER);
  await createUser(USER.tmMember, Role.TEAM_MEMBER);
  await createUser(USER.tmViewer, Role.TEAM_MEMBER);
  await createUser(USER.viewer, Role.VIEWER);
  await createUser(USER.viewerManager, Role.VIEWER);
  await createUser(USER.outsider, Role.TEAM_MEMBER);
  await createUser(USER.inactive, Role.TEAM_MEMBER, false);

  await prisma.project.createMany({
    data: [
      {
        id: PROJECT.alpha,
        name: "Alpha",
        description: "Alpha project",
        managerId: USER.pmAssigned,
      },
      {
        id: PROJECT.beta,
        name: "Beta",
        description: "Beta project",
        managerId: USER.pmCoManager,
      },
    ],
  });

  await prisma.projectMember.createMany({
    data: [
      // Contradictory VIEWER membership must not downgrade the assigned manager.
      { projectId: PROJECT.alpha, userId: USER.pmAssigned, role: ProjectRole.VIEWER },
      { projectId: PROJECT.alpha, userId: USER.pmCoManager, role: ProjectRole.MANAGER },
      { projectId: PROJECT.alpha, userId: USER.pmMember, role: ProjectRole.MEMBER },
      { projectId: PROJECT.alpha, userId: USER.pmViewer, role: ProjectRole.VIEWER },
      { projectId: PROJECT.alpha, userId: USER.tmManager, role: ProjectRole.MANAGER },
      { projectId: PROJECT.alpha, userId: USER.tmMember, role: ProjectRole.MEMBER },
      { projectId: PROJECT.alpha, userId: USER.tmViewer, role: ProjectRole.VIEWER },
      { projectId: PROJECT.alpha, userId: USER.viewer, role: ProjectRole.VIEWER },
      { projectId: PROJECT.alpha, userId: USER.viewerManager, role: ProjectRole.MANAGER },
      { projectId: PROJECT.beta, userId: USER.pmAssigned, role: ProjectRole.MEMBER },
    ],
  });

  await prisma.task.createMany({
    data: [
      {
        id: TASK.assignedTm2,
        projectId: PROJECT.alpha,
        title: "Alpha assigned to tm2",
        description: "Assigned task",
        assigneeId: USER.tmMember,
        status: TaskStatus.TODO,
      },
      {
        id: TASK.assignedTm3,
        projectId: PROJECT.alpha,
        title: "Alpha assigned to tm3",
        description: "Assigned to project viewer",
        assigneeId: USER.tmViewer,
        status: TaskStatus.TODO,
      },
      {
        id: TASK.unassigned,
        projectId: PROJECT.alpha,
        title: "Alpha unassigned",
        description: "Unassigned task",
        status: TaskStatus.TODO,
      },
      {
        id: TASK.beta,
        projectId: PROJECT.beta,
        title: "Beta unassigned",
        description: "Cross-project task",
        status: TaskStatus.TODO,
      },
    ],
  });

  await prisma.comment.createMany({
    data: [
      {
        id: COMMENT.byViewer,
        taskId: TASK.assignedTm2,
        authorId: USER.viewer,
        body: "Viewer comment",
      },
      {
        id: COMMENT.byTm3,
        taskId: TASK.assignedTm3,
        authorId: USER.tmViewer,
        body: "Project viewer comment",
      },
      {
        id: COMMENT.byPm3,
        taskId: TASK.assignedTm2,
        authorId: USER.pmMember,
        body: "Project member PM comment",
      },
      {
        id: COMMENT.byTm2,
        taskId: TASK.assignedTm2,
        authorId: USER.tmMember,
        body: "Team member comment",
      },
    ],
  });
}

async function login(userId: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${userId}@test.local`,
      password: PASSWORD,
    }),
  });
  assert.equal(response.status, 200, `login failed for ${userId}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, `missing session cookie for ${userId}`);
  return { cookie, user: await response.json() };
}

async function api(
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data, headers: response.headers };
}

function expectStatus(
  result: { status: number; data: unknown },
  status: number,
  label: string,
) {
  assert.equal(
    result.status,
    status,
    `${label}: expected ${status}, received ${result.status} ${JSON.stringify(result.data)}`,
  );
}

before(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(resetFixtures);

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await prisma.$disconnect();
});

test("unauthenticated and inactive users are rejected", async () => {
  expectStatus(await api(null, "GET", "/api/projects"), 401, "unauthenticated");

  const inactiveLogin = await api(null, "POST", "/api/auth/login", {
    email: `${USER.inactive}@test.local`,
    password: PASSWORD,
  });
  expectStatus(inactiveLogin, 401, "inactive login");

  const member = await login(USER.tmMember);
  const admin = await login(USER.admin);
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/users/${USER.tmMember}/deactivate`),
    200,
    "admin deactivates active member",
  );
  expectStatus(
    await api(member.cookie, "GET", "/api/projects"),
    401,
    "deactivated session rejected",
  );
});

test("ADMIN retains global override and admin-only operations", async () => {
  const admin = await login(USER.admin);

  expectStatus(await api(admin.cookie, "GET", "/api/projects"), 200, "admin project list");
  expectStatus(
    await api(admin.cookie, "GET", `/api/projects/${PROJECT.alpha}`),
    200,
    "admin reads project without membership",
  );
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      name: "Alpha renamed",
    }),
    200,
    "admin edits project without membership",
  );
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/projects/${PROJECT.alpha}/archive`, {
      archived: true,
    }),
    200,
    "admin archives project",
  );
  expectStatus(
    await api(admin.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Admin-created task",
      assigneeId: USER.tmMember,
    }),
    201,
    "admin creates assigned task",
  );
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      managerId: USER.pmCoManager,
    }),
    200,
    "admin reassigns manager",
  );
  expectStatus(
    await api(admin.cookie, "DELETE", `/api/projects/${PROJECT.beta}`),
    204,
    "admin deletes project",
  );
  expectStatus(
    await api(admin.cookie, "GET", `/api/projects/${PROJECT.beta}`),
    404,
    "deleted project is gone",
  );
  expectStatus(await api(admin.cookie, "GET", "/api/users"), 200, "admin lists users");
});

test("assigned manager authority overrides a contradictory VIEWER membership", async () => {
  const manager = await login(USER.pmAssigned);

  expectStatus(
    await api(manager.cookie, "GET", `/api/projects/${PROJECT.alpha}`),
    200,
    "assigned manager reads project",
  );
  expectStatus(
    await api(manager.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Managed despite viewer membership",
    }),
    200,
    "assigned manager edits project",
  );
  expectStatus(
    await api(manager.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Manager-created task",
    }),
    201,
    "assigned manager creates task",
  );
  expectStatus(
    await api(manager.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      title: "Manager edited",
      version: 1,
    }),
    200,
    "assigned manager edits any task",
  );
  expectStatus(
    await api(manager.cookie, "POST", `/api/projects/${PROJECT.alpha}/members`, {
      userId: USER.outsider,
      role: "MEMBER",
    }),
    201,
    "assigned manager adds member",
  );
  expectStatus(
    await api(manager.cookie, "PATCH", `/api/projects/${PROJECT.alpha}/archive`, {
      archived: true,
    }),
    200,
    "assigned manager archives project",
  );
  expectStatus(
    await api(manager.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      managerId: USER.pmCoManager,
    }),
    403,
    "assigned manager cannot reassign manager",
  );
});

test("assigned manager membership and assignment are protected from other project managers", async () => {
  const coManager = await login(USER.pmCoManager);
  const admin = await login(USER.admin);

  expectStatus(
    await api(
      coManager.cookie,
      "DELETE",
      `/api/projects/${PROJECT.alpha}/members/${USER.pmAssigned}`,
    ),
    403,
    "co-manager cannot remove assigned manager",
  );
  const protectedRole = await api(
    coManager.cookie,
    "PATCH",
    `/api/projects/${PROJECT.alpha}/members/${USER.pmAssigned}`,
    { role: "MEMBER" },
  );
  expectStatus(protectedRole, 403, "co-manager cannot change assigned manager project role");
  assert.equal(
    (protectedRole.data as { error?: string }).error,
    "ASSIGNED_MANAGER_PROTECTED",
  );

  expectStatus(
    await api(admin.cookie, "PATCH", `/api/projects/${PROJECT.alpha}/members/${USER.pmAssigned}`, {
      role: "MEMBER",
    }),
    200,
    "admin may change assigned manager membership role",
  );
  expectStatus(
    await api(admin.cookie, "DELETE", `/api/projects/${PROJECT.alpha}/members/${USER.pmAssigned}`),
    204,
    "admin may remove assigned manager membership",
  );

  const stillManager = await login(USER.pmAssigned);
  expectStatus(
    await api(stillManager.cookie, "GET", `/api/projects/${PROJECT.alpha}`),
    200,
    "managerId still grants access without membership",
  );

  expectStatus(
    await api(coManager.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      managerId: USER.pmCoManager,
    }),
    403,
    "non-admin cannot reassign manager",
  );
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      managerId: USER.pmCoManager,
    }),
    200,
    "admin reassigns manager",
  );
  expectStatus(
    await api(stillManager.cookie, "GET", `/api/projects/${PROJECT.alpha}`),
    404,
    "former manager loses access after admin reassignment",
  );
});

test("PROJECT_MANAGER with MEMBER can read and comment but cannot manage", async () => {
  const pm = await login(USER.pmMember);

  expectStatus(
    await api(pm.cookie, "GET", `/api/projects/${PROJECT.alpha}/tasks`),
    200,
    "PM member reads all tasks",
  );
  const tasks = (await api(pm.cookie, "GET", `/api/projects/${PROJECT.alpha}/tasks`))
    .data as Array<{ id: string }>;
  assert.equal(tasks.length, 3, "PM member sees all project tasks");

  expectStatus(
    await api(pm.cookie, "GET", `/api/tasks/${TASK.assignedTm2}/activity`),
    200,
    "PM member reads activity",
  );
  expectStatus(
    await api(pm.cookie, "GET", `/api/tasks/${TASK.assignedTm2}/comments`),
    200,
    "PM member reads comments",
  );
  expectStatus(
    await api(pm.cookie, "POST", `/api/tasks/${TASK.unassigned}/comments`, {
      body: "PM member comment",
    }),
    201,
    "PM member comments on visible task",
  );

  expectStatus(
    await api(pm.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Forbidden",
    }),
    403,
    "PM member cannot create tasks",
  );
  expectStatus(
    await api(pm.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      title: "Forbidden",
      version: 1,
    }),
    403,
    "PM member cannot edit tasks",
  );
  expectStatus(
    await api(pm.cookie, "DELETE", `/api/tasks/${TASK.unassigned}`),
    403,
    "PM member cannot delete tasks",
  );
  expectStatus(
    await api(pm.cookie, "POST", `/api/projects/${PROJECT.alpha}/members`, {
      userId: USER.outsider,
      role: "MEMBER",
    }),
    403,
    "PM member cannot add members",
  );
  expectStatus(
    await api(
      pm.cookie,
      "PATCH",
      `/api/projects/${PROJECT.alpha}/members/${USER.tmViewer}`,
      { role: "MEMBER" },
    ),
    403,
    "PM member cannot change member roles",
  );
  expectStatus(
    await api(pm.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Forbidden",
    }),
    403,
    "PM member cannot edit project",
  );
  expectStatus(
    await api(pm.cookie, "PATCH", `/api/projects/${PROJECT.alpha}/archive`, {
      archived: true,
    }),
    403,
    "PM member cannot archive project",
  );
  expectStatus(
    await api(pm.cookie, "DELETE", `/api/comments/${COMMENT.byPm3}`),
    204,
    "PM member deletes own comment",
  );
  expectStatus(
    await api(pm.cookie, "DELETE", `/api/comments/${COMMENT.byTm2}`),
    403,
    "PM member cannot delete another comment",
  );
  expectStatus(
    await api(pm.cookie, "GET", `/api/projects/${PROJECT.beta}`),
    404,
    "PM without Beta membership cannot read Beta",
  );
});

test("PROJECT_MANAGER with VIEWER is read-only", async () => {
  const pm = await login(USER.pmViewer);

  expectStatus(
    await api(pm.cookie, "GET", `/api/projects/${PROJECT.alpha}/tasks`),
    200,
    "PM viewer reads tasks",
  );
  expectStatus(
    await api(pm.cookie, "GET", `/api/tasks/${TASK.assignedTm2}/comments`),
    200,
    "PM viewer reads comments",
  );
  expectStatus(
    await api(pm.cookie, "POST", `/api/tasks/${TASK.unassigned}/comments`, {
      body: "Forbidden",
    }),
    403,
    "PM viewer cannot comment",
  );
  expectStatus(
    await api(pm.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      title: "Forbidden",
      version: 1,
    }),
    403,
    "PM viewer cannot edit tasks",
  );
  expectStatus(
    await api(pm.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Forbidden",
    }),
    403,
    "PM viewer cannot create tasks",
  );
  expectStatus(
    await api(pm.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Forbidden",
    }),
    403,
    "PM viewer cannot edit project",
  );
  expectStatus(
    await api(pm.cookie, "PATCH", `/api/projects/${PROJECT.alpha}/archive`, {
      archived: true,
    }),
    403,
    "PM viewer cannot archive project",
  );
});

test("project roles do not cross project boundaries", async () => {
  const alphaManager = await login(USER.pmAssigned);
  const pmOutsider = await login(USER.pmOutsider);

  expectStatus(
    await api(pmOutsider.cookie, "GET", `/api/projects/${PROJECT.alpha}`),
    404,
    "PM with no membership gets 404 on project",
  );
  expectStatus(
    await api(pmOutsider.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Forbidden",
    }),
    404,
    "PM with no membership gets 404 on project mutation",
  );
  expectStatus(
    await api(pmOutsider.cookie, "GET", `/api/projects/${PROJECT.alpha}/tasks`),
    404,
    "PM with no membership gets 404 on task list",
  );

  expectStatus(
    await api(alphaManager.cookie, "GET", `/api/projects/${PROJECT.beta}/tasks`),
    200,
    "Alpha manager with Beta MEMBER reads Beta tasks",
  );
  expectStatus(
    await api(alphaManager.cookie, "POST", `/api/tasks/${TASK.beta}/comments`, {
      body: "Cross-project member comment",
    }),
    201,
    "Alpha manager with Beta MEMBER comments as a member",
  );
  expectStatus(
    await api(alphaManager.cookie, "PATCH", `/api/projects/${PROJECT.beta}`, {
      description: "Forbidden",
    }),
    403,
    "Alpha manager cannot manage Beta",
  );
  expectStatus(
    await api(alphaManager.cookie, "POST", `/api/projects/${PROJECT.beta}/tasks`, {
      title: "Forbidden",
    }),
    403,
    "Alpha manager cannot create Beta tasks",
  );
});

test("TEAM_MEMBER with MANAGER is a real project co-manager", async () => {
  const manager = await login(USER.tmManager);

  expectStatus(
    await api(manager.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Team member manager",
    }),
    200,
    "TM manager edits project",
  );
  expectStatus(
    await api(manager.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "TM manager task",
      assigneeId: USER.tmMember,
    }),
    201,
    "TM manager creates assigned task",
  );
  expectStatus(
    await api(manager.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      title: "TM manager edit",
      version: 1,
      assigneeId: USER.tmMember,
    }),
    200,
    "TM manager updates and assigns any task",
  );
  expectStatus(
    await api(manager.cookie, "POST", `/api/tasks/${TASK.unassigned}/comments`, {
      body: "TM manager comment",
    }),
    201,
    "TM manager comments on any task",
  );
  expectStatus(
    await api(manager.cookie, "DELETE", `/api/comments/${COMMENT.byTm2}`),
    204,
    "TM manager deletes any comment",
  );
  expectStatus(
    await api(manager.cookie, "POST", `/api/projects/${PROJECT.alpha}/members`, {
      userId: USER.outsider,
      role: "MEMBER",
    }),
    201,
    "TM manager adds member",
  );
  expectStatus(
    await api(
      manager.cookie,
      "PATCH",
      `/api/projects/${PROJECT.alpha}/members/${USER.outsider}`,
      { role: "VIEWER" },
    ),
    200,
    "TM manager changes member role",
  );
  expectStatus(
    await api(
      manager.cookie,
      "DELETE",
      `/api/projects/${PROJECT.alpha}/members/${USER.outsider}`,
    ),
    204,
    "TM manager removes member",
  );
  expectStatus(
    await api(manager.cookie, "DELETE", `/api/tasks/${TASK.unassigned}`),
    204,
    "TM manager deletes task",
  );
  expectStatus(
    await api(manager.cookie, "DELETE", `/api/projects/${PROJECT.alpha}`),
    403,
    "TM manager cannot delete project",
  );
  expectStatus(
    await api(manager.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      managerId: USER.pmCoManager,
    }),
    403,
    "TM manager cannot reassign manager",
  );
  expectStatus(await api(manager.cookie, "GET", "/api/users"), 403, "TM manager cannot manage users");
});

test("TEAM_MEMBER with MEMBER reads all tasks but only mutates assigned work", async () => {
  const member = await login(USER.tmMember);
  const tasks = await api(member.cookie, "GET", `/api/projects/${PROJECT.alpha}/tasks`);
  expectStatus(tasks, 200, "TM member reads tasks");
  assert.equal((tasks.data as unknown[]).length, 3, "TM member sees all project tasks");

  expectStatus(
    await api(member.cookie, "PATCH", `/api/tasks/${TASK.assignedTm2}`, {
      title: "TM member edit",
      version: 1,
    }),
    200,
    "TM member edits own assigned task",
  );
  expectStatus(
    await api(member.cookie, "PATCH", `/api/tasks/${TASK.assignedTm2}`, {
      status: "IN_PROGRESS",
      version: 2,
    }),
    200,
    "TM member changes own task status",
  );
  expectStatus(
    await api(member.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      title: "Forbidden",
      version: 1,
    }),
    403,
    "TM member cannot edit unassigned task",
  );
  expectStatus(
    await api(member.cookie, "PATCH", `/api/tasks/${TASK.assignedTm3}`, {
      title: "Forbidden",
      version: 1,
    }),
    403,
    "TM member cannot edit another assignee task",
  );
  expectStatus(
    await api(member.cookie, "PATCH", `/api/tasks/${TASK.assignedTm2}`, {
      assigneeId: USER.tmViewer,
      version: 3,
    }),
    403,
    "TM member cannot reassign a task",
  );
  expectStatus(
    await api(member.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Forbidden",
    }),
    403,
    "TM member cannot create tasks",
  );
  expectStatus(
    await api(member.cookie, "DELETE", `/api/tasks/${TASK.assignedTm2}`),
    403,
    "TM member cannot delete tasks",
  );
  expectStatus(
    await api(member.cookie, "POST", `/api/tasks/${TASK.assignedTm2}/comments`, {
      body: "TM member comment",
    }),
    201,
    "TM member comments on assigned task",
  );
  expectStatus(
    await api(member.cookie, "POST", `/api/tasks/${TASK.unassigned}/comments`, {
      body: "Forbidden",
    }),
    403,
    "TM member cannot comment on unassigned task",
  );
  expectStatus(
    await api(member.cookie, "DELETE", `/api/comments/${COMMENT.byTm2}`),
    204,
    "TM member deletes own assigned-task comment",
  );
  expectStatus(
    await api(member.cookie, "DELETE", `/api/comments/${COMMENT.byTm3}`),
    403,
    "TM member cannot delete another comment",
  );
  expectStatus(
    await api(member.cookie, "GET", `/api/projects/${PROJECT.beta}`),
    404,
    "TM member without Beta membership cannot read Beta",
  );
});

test("TEAM_MEMBER with VIEWER cannot use an existing assignment to mutate", async () => {
  const viewer = await login(USER.tmViewer);

  expectStatus(
    await api(viewer.cookie, "GET", `/api/projects/${PROJECT.alpha}/tasks`),
    200,
    "TM viewer reads all tasks",
  );
  expectStatus(
    await api(viewer.cookie, "PATCH", `/api/tasks/${TASK.assignedTm3}`, {
      title: "Forbidden",
      version: 1,
    }),
    403,
    "TM viewer cannot edit even an assigned task",
  );
  expectStatus(
    await api(viewer.cookie, "PATCH", `/api/tasks/${TASK.assignedTm3}`, {
      status: "DONE",
      version: 1,
    }),
    403,
    "TM viewer cannot change status",
  );
  expectStatus(
    await api(viewer.cookie, "POST", `/api/tasks/${TASK.assignedTm3}/comments`, {
      body: "Forbidden",
    }),
    403,
    "TM viewer cannot comment",
  );
  expectStatus(
    await api(viewer.cookie, "DELETE", `/api/comments/${COMMENT.byTm3}`),
    403,
    "TM viewer cannot delete own comment",
  );

  const admin = await login(USER.admin);
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      assigneeId: USER.tmViewer,
      version: 1,
    }),
    400,
    "project viewer is not an eligible assignee",
  );
});

test("global VIEWER is read-only across all operations", async () => {
  const viewer = await login(USER.viewer);

  expectStatus(await api(viewer.cookie, "GET", "/api/projects"), 200, "viewer lists projects");
  expectStatus(
    await api(viewer.cookie, "GET", `/api/projects/${PROJECT.alpha}/tasks`),
    200,
    "viewer reads tasks",
  );
  expectStatus(
    await api(viewer.cookie, "GET", `/api/tasks/${TASK.assignedTm2}/comments`),
    200,
    "viewer reads comments",
  );
  expectStatus(
    await api(viewer.cookie, "GET", `/api/tasks/${TASK.assignedTm2}/activity`),
    200,
    "viewer reads activity",
  );

  expectStatus(
    await api(viewer.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Forbidden",
    }),
    403,
    "viewer cannot edit project",
  );
  expectStatus(
    await api(viewer.cookie, "PATCH", `/api/projects/${PROJECT.alpha}/archive`, {
      archived: true,
    }),
    403,
    "viewer cannot archive project",
  );
  expectStatus(
    await api(viewer.cookie, "DELETE", `/api/projects/${PROJECT.alpha}`),
    403,
    "viewer cannot delete project",
  );
  expectStatus(
    await api(viewer.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Forbidden",
    }),
    403,
    "viewer cannot create task",
  );
  expectStatus(
    await api(viewer.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      title: "Forbidden",
      version: 1,
    }),
    403,
    "viewer cannot edit task",
  );
  expectStatus(
    await api(viewer.cookie, "DELETE", `/api/tasks/${TASK.unassigned}`),
    403,
    "viewer cannot delete task",
  );
  expectStatus(
    await api(viewer.cookie, "POST", `/api/tasks/${TASK.unassigned}/comments`, {
      body: "Forbidden",
    }),
    403,
    "viewer cannot add comment",
  );
  expectStatus(
    await api(viewer.cookie, "DELETE", `/api/comments/${COMMENT.byViewer}`),
    403,
    "viewer cannot delete own comment",
  );
  expectStatus(
    await api(viewer.cookie, "POST", `/api/projects/${PROJECT.alpha}/members`, {
      userId: USER.outsider,
      role: "VIEWER",
    }),
    403,
    "viewer cannot add member",
  );
  expectStatus(
    await api(
      viewer.cookie,
      "PATCH",
      `/api/projects/${PROJECT.alpha}/members/${USER.tmViewer}`,
      { role: "MEMBER" },
    ),
    403,
    "viewer cannot change member role",
  );
  expectStatus(
    await api(
      viewer.cookie,
      "DELETE",
      `/api/projects/${PROJECT.alpha}/members/${USER.tmViewer}`,
    ),
    403,
    "viewer cannot remove member",
  );
});

test("global VIEWER cannot be elevated by a project MANAGER membership", async () => {
  const viewer = await login(USER.viewerManager);

  expectStatus(
    await api(viewer.cookie, "GET", `/api/projects/${PROJECT.alpha}/tasks`),
    200,
    "viewer manager reads tasks",
  );
  expectStatus(
    await api(viewer.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Forbidden",
    }),
    403,
    "viewer manager cannot edit project",
  );
  expectStatus(
    await api(viewer.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Forbidden",
    }),
    403,
    "viewer manager cannot create task",
  );
  expectStatus(
    await api(viewer.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      title: "Forbidden",
      version: 1,
    }),
    403,
    "viewer manager cannot edit task",
  );
  expectStatus(
    await api(viewer.cookie, "POST", `/api/projects/${PROJECT.alpha}/members`, {
      userId: USER.outsider,
      role: "VIEWER",
    }),
    403,
    "viewer manager cannot manage members",
  );
  expectStatus(
    await api(viewer.cookie, "POST", `/api/tasks/${TASK.unassigned}/comments`, {
      body: "Forbidden",
    }),
    403,
    "viewer manager cannot comment",
  );
});

test("task assignment eligibility is enforced for ADMIN and managers", async () => {
  const admin = await login(USER.admin);

  for (const [label, assigneeId] of [
    ["global PROJECT_MANAGER", USER.pmMember],
    ["global VIEWER", USER.viewer],
    ["project VIEWER", USER.tmViewer],
    ["non-member", USER.outsider],
    ["inactive", USER.inactive],
  ] as const) {
    expectStatus(
      await api(admin.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
        assigneeId,
        version: 1,
      }),
      400,
      `${label} is not assignable`,
    );
  }

  expectStatus(
    await api(admin.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      assigneeId: USER.tmMember,
      version: 1,
    }),
    200,
    "ADMIN assigns active project MEMBER",
  );
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/tasks/${TASK.unassigned}`, {
      assigneeId: USER.tmManager,
      version: 2,
    }),
    200,
    "ADMIN assigns active project MANAGER",
  );
  expectStatus(
    await api(admin.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Invalid assignee",
      assigneeId: USER.tmViewer,
    }),
    400,
    "task creation rejects project VIEWER assignee",
  );
  expectStatus(
    await api(admin.cookie, "POST", `/api/projects/${PROJECT.alpha}/tasks`, {
      title: "Valid assignee",
      assigneeId: USER.tmMember,
    }),
    201,
    "task creation accepts active project MEMBER",
  );
});

test("hidden resources return 404 instead of leaking existence", async () => {
  const outsider = await login(USER.outsider);
  const pmMember = await login(USER.pmMember);

  expectStatus(
    await api(outsider.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Forbidden",
    }),
    404,
    "non-member existing project mutation is 404",
  );
  expectStatus(
    await api(outsider.cookie, "PATCH", "/api/projects/does-not-exist", {
      description: "Forbidden",
    }),
    404,
    "missing project mutation is 404",
  );
  expectStatus(
    await api(outsider.cookie, "DELETE", `/api/tasks/${TASK.unassigned}`),
    404,
    "non-member existing task deletion is 404",
  );
  expectStatus(
    await api(outsider.cookie, "DELETE", "/api/tasks/does-not-exist"),
    404,
    "missing task deletion is 404",
  );
  expectStatus(
    await api(outsider.cookie, "DELETE", `/api/comments/${COMMENT.byTm2}`),
    404,
    "non-member existing comment deletion is 404",
  );
  expectStatus(
    await api(outsider.cookie, "DELETE", "/api/comments/does-not-exist"),
    404,
    "missing comment deletion is 404",
  );

  expectStatus(
    await api(pmMember.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      description: "Forbidden",
    }),
    403,
    "member without management gets 403 on existing project",
  );
  expectStatus(
    await api(pmMember.cookie, "PATCH", "/api/projects/does-not-exist", {
      description: "Forbidden",
    }),
    404,
    "member without management gets 404 on missing project",
  );
});

test("optimistic concurrency still returns 409 and preserves versions", async () => {
  const member = await login(USER.tmMember);

  expectStatus(
    await api(member.cookie, "PATCH", `/api/tasks/${TASK.assignedTm2}`, {
      title: "First edit",
      version: 1,
    }),
    200,
    "first task edit succeeds",
  );
  const stale = await api(member.cookie, "PATCH", `/api/tasks/${TASK.assignedTm2}`, {
    title: "Stale edit",
    version: 1,
  });
  expectStatus(stale, 409, "stale task edit conflicts");
  assert.equal(
    (stale.data as { error?: string }).error,
    "TASK_VERSION_CONFLICT",
  );
  assert.equal(
    (stale.data as { current?: { version?: number } }).current?.version,
    2,
    "conflict returns current version",
  );

  const [left, right] = await Promise.all([
    api(member.cookie, "PATCH", `/api/tasks/${TASK.assignedTm2}`, {
      title: "Concurrent A",
      version: 2,
    }),
    api(member.cookie, "PATCH", `/api/tasks/${TASK.assignedTm2}`, {
      title: "Concurrent B",
      version: 2,
    }),
  ]);
  assert.deepEqual(
    [left.status, right.status].sort((a, b) => a - b),
    [200, 409],
    "exactly one concurrent update succeeds",
  );
});

test("membership lifecycle validates users and protects the assigned manager", async () => {
  const manager = await login(USER.pmCoManager);
  const admin = await login(USER.admin);

  expectStatus(
    await api(manager.cookie, "POST", `/api/projects/${PROJECT.alpha}/members`, {
      userId: USER.inactive,
      role: "MEMBER",
    }),
    400,
    "inactive user cannot be added",
  );
  expectStatus(
    await api(manager.cookie, "POST", `/api/projects/${PROJECT.alpha}/members`, {
      userId: USER.outsider,
      role: "MEMBER",
    }),
    201,
    "active user can be added",
  );
  expectStatus(
    await api(manager.cookie, "POST", `/api/projects/${PROJECT.alpha}/members`, {
      userId: USER.outsider,
      role: "VIEWER",
    }),
    409,
    "duplicate membership conflicts",
  );
  expectStatus(
    await api(
      manager.cookie,
      "DELETE",
      `/api/projects/${PROJECT.alpha}/members/${USER.pmAssigned}`,
    ),
    403,
    "co-manager cannot remove assigned manager",
  );
  expectStatus(
    await api(
      manager.cookie,
      "PATCH",
      `/api/projects/${PROJECT.alpha}/members/${USER.pmAssigned}`,
      { role: "MEMBER" },
    ),
    403,
    "co-manager cannot change assigned manager role",
  );

  expectStatus(
    await api(admin.cookie, "PATCH", `/api/projects/${PROJECT.alpha}`, {
      managerId: USER.pmCoManager,
    }),
    200,
    "admin reassigns manager",
  );
  expectStatus(
    await api(admin.cookie, "DELETE", `/api/projects/${PROJECT.alpha}/members/${USER.pmAssigned}`),
    204,
    "admin removes former manager membership",
  );
});

test("global user administration remains ADMIN-only", async () => {
  const pm = await login(USER.pmCoManager);
  const admin = await login(USER.admin);

  expectStatus(await api(pm.cookie, "GET", "/api/users"), 403, "PM cannot list users");
  expectStatus(
    await api(pm.cookie, "POST", "/api/users", {
      name: "Forbidden",
      email: "forbidden@test.local",
      password: "Password123!",
      role: "TEAM_MEMBER",
    }),
    403,
    "PM cannot create users",
  );
  expectStatus(
    await api(pm.cookie, "PATCH", `/api/users/${USER.tmMember}`, {
      name: "Forbidden",
    }),
    403,
    "PM cannot update users",
  );
  expectStatus(
    await api(pm.cookie, "PATCH", `/api/users/${USER.tmMember}/deactivate`),
    403,
    "PM cannot deactivate users",
  );

  expectStatus(await api(admin.cookie, "GET", "/api/users"), 200, "admin lists users");
  const created = await api(admin.cookie, "POST", "/api/users", {
    name: "Created User",
    email: "created@test.local",
    password: "Password123!",
    role: "TEAM_MEMBER",
  });
  expectStatus(created, 201, "admin creates user");
  const createdId = (created.data as { id: string }).id;
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/users/${createdId}`, {
      name: "Renamed User",
    }),
    200,
    "admin updates user",
  );
  expectStatus(
    await api(admin.cookie, "PATCH", `/api/users/${createdId}/deactivate`),
    200,
    "admin deactivates user",
  );
  expectStatus(
    await api(null, "POST", "/api/auth/login", {
      email: "created@test.local",
      password: "Password123!",
    }),
    401,
    "deactivated user cannot log in",
  );
});
