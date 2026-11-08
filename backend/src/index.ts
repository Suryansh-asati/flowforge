import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
const prisma = new PrismaClient();
const app = express();
const secret = process.env.JWT_SECRET;
const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGIN || "http://localhost:3000,http://localhost:3001")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
if (!secret || secret.length < 32)
  throw new Error("JWT_SECRET must be set to at least 32 characters.");
const Role = {
  ADMIN: "ADMIN",
  PROJECT_MANAGER: "PROJECT_MANAGER",
  TEAM_MEMBER: "TEAM_MEMBER",
  VIEWER: "VIEWER",
} as const;
type Role = (typeof Role)[keyof typeof Role];
const TaskStatus = {
  TODO: "TODO",
  IN_PROGRESS: "IN_PROGRESS",
  DONE: "DONE",
} as const;
app.use(
  cors({
    origin: (requestOrigin, callback) =>
      callback(null, !requestOrigin || allowedOrigins.has(requestOrigin)),
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());
type AuthReq = Request & { user?: { id: string; role: Role } };
type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;
const asyncHandler =
  (handler: AsyncRouteHandler) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
const authenticate = async (req: AuthReq, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies.session;
    if (!token) return res.status(401).json({ error: "UNAUTHENTICATED" });
    const claims = jwt.verify(token, secret) as { id: string };
    const u = await prisma.user.findUnique({ where: { id: claims.id } });
    if (!u?.active) return res.status(401).json({ error: "UNAUTHENTICATED" });
    req.user = { id: u.id, role: u.role };
    next();
  } catch {
    return res.status(401).json({ error: "UNAUTHENTICATED" });
  }
};
const auth = asyncHandler(authenticate);
// ProjectRole is scoped to one project. It never changes the authenticated
// user's global role or grants access to global administration endpoints.
const ProjectRole = {
  MANAGER: "MANAGER",
  MEMBER: "MEMBER",
  VIEWER: "VIEWER",
} as const;
type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];
type ProjectAccess = {
  exists: boolean;
  managerId: string | null;
  assignedManager: boolean;
  membershipRole: ProjectRole | null;
  effectiveRole: ProjectRole | null;
};
const getProjectAccess = async (
  userId: string,
  role: Role,
  projectId: string,
): Promise<ProjectAccess> => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      managerId: true,
      memberships: { where: { userId }, select: { role: true } },
    },
  });
  if (!project)
    return {
      exists: false,
      managerId: null,
      assignedManager: false,
      membershipRole: null,
      effectiveRole: null,
    };
  const assignedManager = project.managerId === userId;
  const membershipRole = project.memberships[0]?.role ?? null;
  const hasMembership = assignedManager || membershipRole !== null;
  let effectiveRole: ProjectRole | null = null;
  if (role === Role.ADMIN) effectiveRole = ProjectRole.MANAGER;
  else if (role === Role.VIEWER)
    effectiveRole = hasMembership ? ProjectRole.VIEWER : null;
  else if (assignedManager || membershipRole === ProjectRole.MANAGER)
    effectiveRole = ProjectRole.MANAGER;
  else if (membershipRole) effectiveRole = membershipRole;
  return {
    exists: true,
    managerId: project.managerId,
    assignedManager,
    membershipRole,
    effectiveRole,
  };
};
const canReadProject = (access: ProjectAccess) =>
  access.exists && access.effectiveRole !== null;
const canManageProject = (access: ProjectAccess) =>
  access.exists && access.effectiveRole === ProjectRole.MANAGER;
const canUpdateTask = (
  access: ProjectAccess,
  role: Role,
  userId: string,
  assigneeId: string | null,
) => {
  if (role === Role.ADMIN) return access.exists;
  if (access.effectiveRole === ProjectRole.MANAGER) return true;
  return (
    role === Role.TEAM_MEMBER &&
    access.effectiveRole === ProjectRole.MEMBER &&
    assigneeId === userId
  );
};
const canCommentOnTask = (
  access: ProjectAccess,
  role: Role,
  userId: string,
  assigneeId: string | null,
) => {
  if (role === Role.ADMIN) return access.exists;
  if (access.effectiveRole === ProjectRole.MANAGER) return true;
  if (access.effectiveRole !== ProjectRole.MEMBER) return false;
  if (role === Role.PROJECT_MANAGER) return true;
  return role === Role.TEAM_MEMBER && assigneeId === userId;
};
const canDeleteComment = (
  access: ProjectAccess,
  role: Role,
  userId: string,
  assigneeId: string | null,
  authorId: string,
) => {
  if (role === Role.ADMIN) return access.exists;
  if (access.effectiveRole === ProjectRole.MANAGER) return true;
  if (access.effectiveRole !== ProjectRole.MEMBER || authorId !== userId)
    return false;
  if (role === Role.PROJECT_MANAGER) return true;
  return role === Role.TEAM_MEMBER && assigneeId === userId;
};
const isEligibleAssignee = async (userId: string, projectId: string) => {
  const assignee = await prisma.user.findUnique({
    where: { id: userId },
    select: { active: true, role: true },
  });
  if (!assignee?.active || assignee.role !== Role.TEAM_MEMBER) return false;
  const access = await getProjectAccess(userId, Role.TEAM_MEMBER, projectId);
  return (
    access.effectiveRole === ProjectRole.MEMBER ||
    access.effectiveRole === ProjectRole.MANAGER
  );
};
const requireProjectRead = async (
  req: AuthReq,
  res: Response,
  projectId: string,
) => {
  const access = await getProjectAccess(
    req.user!.id,
    req.user!.role,
    projectId,
  );
  if (!canReadProject(access)) {
    res.status(404).json({ error: "NOT_FOUND" });
    return null;
  }
  return access;
};
const requireProjectManage = async (
  req: AuthReq,
  res: Response,
  projectId: string,
) => {
  const access = await getProjectAccess(
    req.user!.id,
    req.user!.role,
    projectId,
  );
  if (!canReadProject(access)) {
    res.status(404).json({ error: "NOT_FOUND" });
    return null;
  }
  if (!canManageProject(access)) {
    res.status(403).json({ error: "FORBIDDEN" });
    return null;
  }
  return access;
};
app.get("/api/health", (_q, res) => res.json({ ok: true }));
app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const parsed = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "VALIDATION_ERROR" });
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });
  if (
    !user?.active ||
    !(await bcrypt.compare(parsed.data.password, user.passwordHash))
  )
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  res.cookie(
    "session",
    jwt.sign({ id: user.id }, secret, { expiresIn: "8h" }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 3600_000,
    },
  );
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  });
}));
app.post("/api/auth/logout", (_q, res) => {
  res.clearCookie("session");
  res.status(204).end();
});
app.get("/api/auth/me", auth, asyncHandler(async (req: AuthReq, res) => {
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, name: true, email: true, role: true },
  });
  res.json(u);
}));
app.get("/api/projects", auth, asyncHandler(async (req: AuthReq, res) => {
  const where =
    req.user!.role === Role.ADMIN
      ? {}
      : {
          OR: [
            { managerId: req.user!.id },
            { memberships: { some: { userId: req.user!.id } } },
          ],
        };
  const projects = await prisma.project.findMany({
    where,
    include: {
      tasks: { include: { assignee: { select: { id: true, name: true } }, comments: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } } } },
      manager: { select: { id: true, name: true } },
      memberships: { include: { user: { select: { id: true, name: true, email: true, role: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(projects);
}));
app.post("/api/projects", auth, asyncHandler(async (req: AuthReq, res) => {
  if (req.user!.role !== Role.ADMIN)
    return res.status(403).json({ error: "FORBIDDEN" });
  const b = z
    .object({
      name: z.string().min(1).max(100),
      description: z.string().max(1000).optional(),
      managerId: z.string().optional(),
    })
    .safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const managerId = b.data.managerId || req.user!.id;
  const manager = await prisma.user.findUnique({ where: { id: managerId } });
  if (!manager || !manager.active || manager.role !== Role.PROJECT_MANAGER)
    return res.status(400).json({ error: "INVALID_MANAGER" });
  res
    .status(201)
    .json(
      await prisma.project.create({
        data: {
          name: b.data.name,
          description: b.data.description || "",
          managerId,
        },
        include: { tasks: true },
      }),
    );
}));
app.get("/api/projects/:id/tasks", auth, asyncHandler(async (req: AuthReq, res) => {
  const projectId = String(req.params.id);
  if (!(await requireProjectRead(req, res, projectId))) return;
  res.json(
    await prisma.task.findMany({
      where: { projectId },
      include: {
        assignee: { select: { id: true, name: true } },
        comments: {
          include: { author: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
  );
}));
app.post("/api/projects/:id/tasks", auth, asyncHandler(async (req: AuthReq, res) => {
  const projectId = String(req.params.id);
  if (!(await requireProjectManage(req, res, projectId))) return;
  const b = z
    .object({
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      assigneeId: z.string().optional(),
    })
    .safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  if (b.data.assigneeId && !(await isEligibleAssignee(b.data.assigneeId, projectId)))
    return res.status(400).json({ error: "ASSIGNEE_NOT_IN_PROJECT" });
  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        projectId,
        title: b.data.title,
        description: b.data.description || "",
        assigneeId: b.data.assigneeId,
      },
      include: { assignee: { select: { id: true, name: true } } },
    });
    await tx.taskActivity.create({
      data: { taskId: created.id, actorId: req.user!.id, eventType: "TASK_CREATED", details: { title: created.title } },
    });
    return created;
  });
  res.status(201).json(task);
}));
app.get("/api/users", auth, asyncHandler(async (req: AuthReq, res) => {
  if (req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "FORBIDDEN" });
  res.json(await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true, active: true, createdAt: true }, orderBy: { name: "asc" } }));
}));
app.post("/api/users", auth, asyncHandler(async (req: AuthReq, res) => {
  if (req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "FORBIDDEN" });
  const b = z.object({ name: z.string().min(1).max(100), email: z.string().email(), password: z.string().min(10), role: z.enum([Role.ADMIN, Role.PROJECT_MANAGER, Role.TEAM_MEMBER, Role.VIEWER]) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  if (await prisma.user.findUnique({ where: { email: b.data.email } })) return res.status(409).json({ error: "EMAIL_EXISTS" });
  const { password, ...fields } = b.data;
  const user = await prisma.user.create({ data: { ...fields, passwordHash: await bcrypt.hash(password, 10) }, select: { id: true, name: true, email: true, role: true, active: true } });
  res.status(201).json(user);
}));
app.patch("/api/users/:id", auth, asyncHandler(async (req: AuthReq, res) => {
  if (req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "FORBIDDEN" });
  const b = z.object({ name: z.string().min(1).max(100).optional(), email: z.string().email().optional(), password: z.string().min(10).optional(), role: z.enum([Role.ADMIN, Role.PROJECT_MANAGER, Role.TEAM_MEMBER, Role.VIEWER]).optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const { password, ...fields } = b.data;
  const user = await prisma.user.update({ where: { id: String(req.params.id) }, data: { ...fields, ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) }, select: { id: true, name: true, email: true, role: true, active: true } }).catch(() => null);
  return user ? res.json(user) : res.status(404).json({ error: "NOT_FOUND" });
}));
app.patch("/api/users/:id/deactivate", auth, asyncHandler(async (req: AuthReq, res) => {
  if (req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "FORBIDDEN" });
  if (String(req.params.id) === req.user!.id) return res.status(400).json({ error: "CANNOT_DEACTIVATE_SELF" });
  const result = await prisma.user.updateMany({ where: { id: String(req.params.id), active: true }, data: { active: false } });
  return result.count ? res.json({ id: req.params.id, active: false }) : res.status(404).json({ error: "NOT_FOUND" });
}));
app.get("/api/projects/:id", auth, asyncHandler(async (req: AuthReq, res) => {
  const id = String(req.params.id);
  if (!(await requireProjectRead(req, res, id))) return;
  res.json(await prisma.project.findUnique({ where: { id }, include: { manager: { select: { id: true, name: true } }, memberships: { include: { user: { select: { id: true, name: true, email: true, role: true } } } }, tasks: { include: { assignee: { select: { id: true, name: true } }, comments: { include: { author: { select: { id: true, name: true } } } } } } } }));
}));
app.patch("/api/projects/:id", auth, asyncHandler(async (req: AuthReq, res) => {
  const id = String(req.params.id);
  if (!(await requireProjectManage(req, res, id))) return;
  const b = z.object({ name: z.string().min(1).max(100).optional(), description: z.string().max(1000).optional(), managerId: z.string().optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  if (b.data.managerId !== undefined && req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "ONLY_ADMIN_CAN_REASSIGN_MANAGER" });
  if (b.data.managerId !== undefined) { const m = await prisma.user.findUnique({ where: { id: b.data.managerId } }); if (!m?.active || m.role !== Role.PROJECT_MANAGER) return res.status(400).json({ error: "INVALID_MANAGER" }); }
  const project = await prisma.project.update({ where: { id }, data: b.data }).catch(() => null);
  return project ? res.json(project) : res.status(404).json({ error: "NOT_FOUND" });
}));
app.patch("/api/projects/:id/archive", auth, asyncHandler(async (req: AuthReq, res) => {
  const id = String(req.params.id);
  if (!(await requireProjectManage(req, res, id))) return;
  const b = z.object({ archived: z.boolean() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const p = await prisma.project.update({ where: { id }, data: { archived: b.data.archived } }).catch(() => null);
  return p ? res.json(p) : res.status(404).json({ error: "NOT_FOUND" });
}));
app.delete("/api/projects/:id", auth, asyncHandler(async (req: AuthReq, res) => {
  if (req.user!.role !== Role.ADMIN) return res.status(403).json({ error: "FORBIDDEN" });
  const deleted = await prisma.project.deleteMany({ where: { id: String(req.params.id) } });
  if (!deleted.count) return res.status(404).json({ error: "NOT_FOUND" });
  res.status(204).end();
}));
app.get("/api/projects/:id/members", auth, asyncHandler(async (req: AuthReq, res) => {
  const id = String(req.params.id);
  if (!(await requireProjectRead(req, res, id))) return;
  res.json(await prisma.projectMember.findMany({ where: { projectId: id }, include: { user: { select: { id: true, name: true, email: true, role: true } } } }));
}));
app.post("/api/projects/:id/members", auth, asyncHandler(async (req: AuthReq, res) => {
  const id = String(req.params.id);
  if (!(await requireProjectManage(req, res, id))) return;
  const b = z.object({ userId: z.string(), role: z.enum(["MANAGER", "MEMBER", "VIEWER"]) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const u = await prisma.user.findUnique({ where: { id: b.data.userId } });
  if (!u?.active) return res.status(400).json({ error: "INVALID_MEMBER" });
  const member = await prisma.projectMember.create({ data: { projectId: id, ...b.data } }).catch(() => null);
  return member ? res.status(201).json(member) : res.status(409).json({ error: "MEMBERSHIP_EXISTS" });
}));
app.patch("/api/projects/:id/members/:userId", auth, asyncHandler(async (req: AuthReq, res) => {
  const id = String(req.params.id);
  const access = await requireProjectManage(req, res, id);
  if (!access) return;
  const targetUserId = String(req.params.userId);
  if (access.managerId === targetUserId && req.user!.role !== Role.ADMIN)
    return res.status(403).json({ error: "ASSIGNED_MANAGER_PROTECTED" });
  const b = z.object({ role: z.enum(["MANAGER", "MEMBER", "VIEWER"]) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const member = await prisma.projectMember.update({ where: { projectId_userId: { projectId: id, userId: targetUserId } }, data: b.data }).catch(() => null);
  return member ? res.json(member) : res.status(404).json({ error: "NOT_FOUND" });
}));
app.delete("/api/tasks/:id", auth, asyncHandler(async (req: AuthReq, res) => {
  const task = await prisma.task.findUnique({ where: { id: String(req.params.id) } });
  if (!task) return res.status(404).json({ error: "NOT_FOUND" });
  if (!(await requireProjectManage(req, res, task.projectId))) return;
  await prisma.task.delete({ where: { id: task.id } });
  res.status(204).end();
}));
app.get("/api/tasks/:id/activity", auth, asyncHandler(async (req: AuthReq, res) => {
  const parsedId = z.string().cuid().safeParse(String(req.params.id));
  if (!parsedId.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const task = await prisma.task.findUnique({ where: { id: parsedId.data } });
  if (!task) return res.status(404).json({ error: "NOT_FOUND" });
  if (!(await requireProjectRead(req, res, task.projectId))) return;
  const activity = await prisma.taskActivity.findMany({
    where: { taskId: task.id },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  res.json(activity);
}));
app.get("/api/tasks/:id/comments", auth, asyncHandler(async (req: AuthReq, res) => {
  const task = await prisma.task.findUnique({ where: { id: String(req.params.id) } });
  if (!task) return res.status(404).json({ error: "NOT_FOUND" });
  if (!(await requireProjectRead(req, res, task.projectId))) return;
  res.json(await prisma.comment.findMany({ where: { taskId: task.id }, include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } }));
}));
app.delete("/api/comments/:id", auth, asyncHandler(async (req: AuthReq, res) => {
  const comment = await prisma.comment.findUnique({ where: { id: String(req.params.id) }, include: { task: true } });
  if (!comment) return res.status(404).json({ error: "NOT_FOUND" });
  const access = await getProjectAccess(req.user!.id, req.user!.role, comment.task.projectId);
  if (!canReadProject(access)) return res.status(404).json({ error: "NOT_FOUND" });
  if (!canDeleteComment(access, req.user!.role, req.user!.id, comment.task.assigneeId, comment.authorId))
    return res.status(403).json({ error: "FORBIDDEN" });
  await prisma.comment.delete({ where: { id: comment.id } });
  res.status(204).end();
}));
app.delete("/api/projects/:id/members/:userId", auth, asyncHandler(async (req: AuthReq, res) => {
  const id = String(req.params.id);
  const access = await requireProjectManage(req, res, id);
  if (!access) return;
  const targetUserId = String(req.params.userId);
  if (access.managerId === targetUserId && req.user!.role !== Role.ADMIN)
    return res.status(403).json({ error: "ASSIGNED_MANAGER_PROTECTED" });
  const result = await prisma.projectMember.deleteMany({ where: { projectId: id, userId: targetUserId } });
  return result.count ? res.status(204).end() : res.status(404).json({ error: "NOT_FOUND" });
}));
app.patch("/api/tasks/:id", auth, asyncHandler(async (req: AuthReq, res) => {
  const b = z
    .object({
      version: z.number().int().positive(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      status: z.nativeEnum(TaskStatus).optional(),
      assigneeId: z.string().nullable().optional(),
    })
    .safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const t = await prisma.task.findUnique({
    where: { id: String(req.params.id) },
  });
  if (!t) return res.status(404).json({ error: "NOT_FOUND" });
  const access = await getProjectAccess(req.user!.id, req.user!.role, t.projectId);
  if (!canReadProject(access)) return res.status(404).json({ error: "NOT_FOUND" });
  const manager = canManageProject(access);
  if (!canUpdateTask(access, req.user!.role, req.user!.id, t.assigneeId))
    return res.status(403).json({ error: "FORBIDDEN" });
  if (!manager && b.data.assigneeId !== undefined)
    return res.status(403).json({ error: "FORBIDDEN" });
  if (manager && b.data.assigneeId) {
    if (!(await isEligibleAssignee(b.data.assigneeId, t.projectId)))
      return res.status(400).json({ error: "ASSIGNEE_NOT_IN_PROJECT" });
  }
  const { version, ...data } = b.data;
  const changes: Record<string, { from: string; to: string }> = {};
  if (data.title !== undefined && data.title !== t.title) changes.title = { from: t.title, to: data.title };
  if (data.description !== undefined && data.description !== t.description) changes.description = { from: t.description, to: data.description };
  if (data.status !== undefined && data.status !== t.status) changes.status = { from: t.status, to: data.status };
  if (data.assigneeId !== undefined && data.assigneeId !== t.assigneeId) {
    const ids = [t.assigneeId, data.assigneeId].filter((id): id is string => !!id);
    const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(people.map((person) => [person.id, person.name]));
    changes.assignee = { from: t.assigneeId ? names.get(t.assigneeId) || "Assignee" : "Unassigned", to: data.assigneeId ? names.get(data.assigneeId) || "Assignee" : "Unassigned" };
  }
  const changedFields = Object.keys(changes);
  const eventType = changedFields.length === 1 && changes.status ? "TASK_STATUS_CHANGED"
    : changedFields.length === 1 && changes.assignee ? "TASK_ASSIGNEE_CHANGED"
    : changedFields.length > 0 && changedFields.every((field) => field === "title" || field === "description") ? "TASK_DETAILS_CHANGED"
    : "TASK_UPDATED";
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const result = await tx.task.updateMany({
        where: { id: t.id, version },
        data: { ...data, version: { increment: 1 } },
      });
      if (!result.count) throw new Error("TASK_VERSION_CONFLICT");
      if (changedFields.length) {
        await tx.taskActivity.create({
          data: { taskId: t.id, actorId: req.user!.id, eventType, details: { changes } },
        });
      }
      return tx.task.findUnique({ where: { id: t.id }, include: { assignee: { select: { id: true, name: true } } } });
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "TASK_VERSION_CONFLICT") throw error;
    const current = await prisma.task.findUnique({
      where: { id: t.id },
      select: {
        id: true,
        version: true,
        status: true,
        title: true,
        description: true,
      },
    });
    return res.status(409).json({ error: "TASK_VERSION_CONFLICT", current });
  }
  res.json(updated);
}));
app.post("/api/tasks/:id/comments", auth, asyncHandler(async (req: AuthReq, res) => {
  const b = z.object({ body: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "VALIDATION_ERROR" });
  const t = await prisma.task.findUnique({
    where: { id: String(req.params.id) },
  });
  if (!t) return res.status(404).json({ error: "NOT_FOUND" });
  const access = await getProjectAccess(req.user!.id, req.user!.role, t.projectId);
  if (!canReadProject(access)) return res.status(404).json({ error: "NOT_FOUND" });
  if (!canCommentOnTask(access, req.user!.role, req.user!.id, t.assigneeId))
    return res.status(403).json({ error: "FORBIDDEN" });
  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: { taskId: t.id, authorId: req.user!.id, body: b.data.body },
      include: { author: { select: { id: true, name: true } } },
    });
    await tx.taskActivity.create({
      data: { taskId: t.id, actorId: req.user!.id, eventType: "COMMENT_ADDED", details: { commentId: created.id } },
    });
    return created;
  });
  res.status(201).json(comment);
}));
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const details =
    typeof err === "object" && err !== null
      ? (err as { type?: unknown; status?: unknown; statusCode?: unknown; name?: unknown })
      : {};
  const status =
    typeof details.status === "number"
      ? details.status
      : typeof details.statusCode === "number"
        ? details.statusCode
        : 500;
  if (status >= 500) {
    console.error(`Unhandled request error: ${typeof details.name === "string" ? details.name : "Error"}`);
  }
  if (details.type === "entity.parse.failed") {
    return res.status(400).json({ error: "INVALID_JSON" });
  }
  if (status >= 400 && status < 500) {
    const clientErrorCodes: Record<number, string> = {
      400: "BAD_REQUEST",
      401: "UNAUTHENTICATED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      405: "METHOD_NOT_ALLOWED",
      409: "CONFLICT",
      413: "PAYLOAD_TOO_LARGE",
      415: "UNSUPPORTED_MEDIA_TYPE",
      429: "TOO_MANY_REQUESTS",
    };
    return res.status(status).json({ error: clientErrorCodes[status] || "REQUEST_ERROR" });
  }
  return res.status(500).json({ error: "INTERNAL_ERROR" });
});
export { app };
if (require.main === module) {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`API listening on ${port}`));
}
