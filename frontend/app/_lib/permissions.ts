export type GlobalRole = "ADMIN" | "PROJECT_MANAGER" | "TEAM_MEMBER" | "VIEWER";
export type ProjectRole = "MANAGER" | "MEMBER" | "VIEWER";

export type PermissionUser = {
  id: string;
  role: GlobalRole;
  active?: boolean;
};

export type PermissionMembership = {
  userId: string;
  role: ProjectRole;
  user: PermissionUser & { name: string; email: string };
};

export type PermissionProject = {
  manager: { id: string };
  memberships?: PermissionMembership[];
};

export type PermissionTask = {
  assigneeId?: string | null;
  assignee?: { id: string } | null;
};

export type PermissionComment = {
  author: { id: string };
};

export function getEffectiveProjectRole(
  user: PermissionUser,
  project: PermissionProject,
): ProjectRole | null {
  if (user.role === "ADMIN") return "MANAGER";

  const assignedManager = project.manager.id === user.id;
  const membership = project.memberships?.find(
    (candidate) => candidate.userId === user.id,
  );
  if (!assignedManager && !membership) return null;

  if (user.role === "VIEWER") return "VIEWER";
  if (assignedManager || membership?.role === "MANAGER") return "MANAGER";
  return membership?.role ?? null;
}

export function canManageProject(
  user: PermissionUser,
  project: PermissionProject,
) {
  return getEffectiveProjectRole(user, project) === "MANAGER";
}

export function canUpdateTask(
  user: PermissionUser,
  project: PermissionProject,
  task: PermissionTask,
) {
  const role = getEffectiveProjectRole(user, project);
  if (role === "MANAGER") return true;
  return (
    user.role === "TEAM_MEMBER" &&
    role === "MEMBER" &&
    (task.assigneeId ?? task.assignee?.id) === user.id
  );
}

export function canChangeTaskStatus(
  user: PermissionUser,
  project: PermissionProject,
  task: PermissionTask,
) {
  return canUpdateTask(user, project, task);
}

export function canManageTaskAssignment(
  user: PermissionUser,
  project: PermissionProject,
) {
  return canManageProject(user, project);
}

export function canCommentOnTask(
  user: PermissionUser,
  project: PermissionProject,
  task: PermissionTask,
) {
  const role = getEffectiveProjectRole(user, project);
  if (role === "MANAGER") return true;
  if (role !== "MEMBER") return false;
  if (user.role === "PROJECT_MANAGER") return true;
  return (
    user.role === "TEAM_MEMBER" &&
    (task.assigneeId ?? task.assignee?.id) === user.id
  );
}

export function canDeleteComment(
  user: PermissionUser,
  project: PermissionProject,
  task: PermissionTask,
  comment: PermissionComment,
) {
  const role = getEffectiveProjectRole(user, project);
  if (role === "MANAGER") return true;
  if (role !== "MEMBER" || comment.author.id !== user.id) return false;
  if (user.role === "PROJECT_MANAGER") return true;
  return (
    user.role === "TEAM_MEMBER" &&
    (task.assigneeId ?? task.assignee?.id) === user.id
  );
}

export function eligibleAssignees(project: PermissionProject) {
  return (project.memberships ?? []).filter(
    (membership) =>
      membership.user.role === "TEAM_MEMBER" &&
      membership.user.active !== false &&
      (membership.role === "MEMBER" || membership.role === "MANAGER"),
  );
}
