import test from "node:test";
import assert from "node:assert/strict";
import {
  canChangeTaskStatus,
  canCommentOnTask,
  canDeleteComment,
  canManageProject,
  canManageTaskAssignment,
  canUpdateTask,
  eligibleAssignees,
  getEffectiveProjectRole,
  type PermissionProject,
  type PermissionUser,
} from "../../frontend/app/_lib/permissions";

const project: PermissionProject = {
  manager: { id: "pm-assigned" },
  memberships: [
    { userId: "pm-assigned", role: "VIEWER", user: { id: "pm-assigned", role: "PROJECT_MANAGER", name: "Assigned", email: "a@test" } },
    { userId: "pm-co", role: "MANAGER", user: { id: "pm-co", role: "PROJECT_MANAGER", name: "Co", email: "c@test" } },
    { userId: "pm-member", role: "MEMBER", user: { id: "pm-member", role: "PROJECT_MANAGER", name: "PM Member", email: "pm@test" } },
    { userId: "pm-viewer", role: "VIEWER", user: { id: "pm-viewer", role: "PROJECT_MANAGER", name: "PM Viewer", email: "pv@test" } },
    { userId: "tm-manager", role: "MANAGER", user: { id: "tm-manager", role: "TEAM_MEMBER", name: "TM Manager", email: "tm@test" } },
    { userId: "tm-member", role: "MEMBER", user: { id: "tm-member", role: "TEAM_MEMBER", name: "TM Member", email: "tmm@test" } },
    { userId: "tm-viewer", role: "VIEWER", user: { id: "tm-viewer", role: "TEAM_MEMBER", name: "TM Viewer", email: "tmv@test" } },
    { userId: "viewer", role: "VIEWER", user: { id: "viewer", role: "VIEWER", name: "Viewer", email: "v@test" } },
    { userId: "viewer-manager", role: "MANAGER", user: { id: "viewer-manager", role: "VIEWER", name: "Viewer Manager", email: "vm@test" } },
    { userId: "inactive-tm", role: "MEMBER", user: { id: "inactive-tm", role: "TEAM_MEMBER", active: false, name: "Inactive", email: "i@test" } },
  ],
};

function user(id: string, role: PermissionUser["role"]): PermissionUser {
  return { id, role };
}

test("effective project role respects managerId and global ceiling", () => {
  assert.equal(getEffectiveProjectRole(user("admin", "ADMIN"), { manager: { id: "x" } }), "MANAGER");
  assert.equal(getEffectiveProjectRole(user("pm-assigned", "PROJECT_MANAGER"), project), "MANAGER");
  assert.equal(getEffectiveProjectRole(user("pm-co", "PROJECT_MANAGER"), project), "MANAGER");
  assert.equal(getEffectiveProjectRole(user("pm-member", "PROJECT_MANAGER"), project), "MEMBER");
  assert.equal(getEffectiveProjectRole(user("pm-viewer", "PROJECT_MANAGER"), project), "VIEWER");
  assert.equal(getEffectiveProjectRole(user("tm-manager", "TEAM_MEMBER"), project), "MANAGER");
  assert.equal(getEffectiveProjectRole(user("tm-member", "TEAM_MEMBER"), project), "MEMBER");
  assert.equal(getEffectiveProjectRole(user("tm-viewer", "TEAM_MEMBER"), project), "VIEWER");
  assert.equal(getEffectiveProjectRole(user("viewer", "VIEWER"), project), "VIEWER");
  assert.equal(getEffectiveProjectRole(user("viewer-manager", "VIEWER"), project), "VIEWER");
  assert.equal(getEffectiveProjectRole(user("outsider", "TEAM_MEMBER"), project), null);
});

test("management and assignment helpers match the approved matrix", () => {
  assert.equal(canManageProject(user("admin", "ADMIN"), project), true);
  assert.equal(canManageProject(user("pm-assigned", "PROJECT_MANAGER"), project), true);
  assert.equal(canManageProject(user("pm-co", "PROJECT_MANAGER"), project), true);
  assert.equal(canManageProject(user("tm-manager", "TEAM_MEMBER"), project), true);
  assert.equal(canManageProject(user("pm-member", "PROJECT_MANAGER"), project), false);
  assert.equal(canManageProject(user("pm-viewer", "PROJECT_MANAGER"), project), false);
  assert.equal(canManageProject(user("viewer-manager", "VIEWER"), project), false);
  assert.equal(canManageTaskAssignment(user("pm-co", "PROJECT_MANAGER"), project), true);
  assert.equal(canManageTaskAssignment(user("tm-member", "TEAM_MEMBER"), project), false);
});

test("task update and status helpers only allow managers or assigned MEMBER team members", () => {
  const assigned = { assigneeId: "tm-member" };
  const other = { assigneeId: "tm-viewer" };

  assert.equal(canUpdateTask(user("pm-co", "PROJECT_MANAGER"), project, other), true);
  assert.equal(canUpdateTask(user("tv", "VIEWER"), project, other), false);
  assert.equal(canUpdateTask(user("pm-member", "PROJECT_MANAGER"), project, assigned), false);
  assert.equal(canUpdateTask(user("pm-viewer", "PROJECT_MANAGER"), project, assigned), false);
  assert.equal(canUpdateTask(user("tm-member", "TEAM_MEMBER"), project, assigned), true);
  assert.equal(canUpdateTask(user("tm-member", "TEAM_MEMBER"), project, other), false);
  assert.equal(canUpdateTask(user("tm-viewer", "TEAM_MEMBER"), project, { assigneeId: "tm-viewer" }), false);
  assert.equal(canChangeTaskStatus(user("tm-member", "TEAM_MEMBER"), project, assigned), true);
  assert.equal(canChangeTaskStatus(user("tm-viewer", "TEAM_MEMBER"), project, { assigneeId: "tm-viewer" }), false);
});

test("comment helpers separate read, write, and delete permissions", () => {
  const assigned = { assigneeId: "tm-member" };
  const unassigned = {};

  assert.equal(canCommentOnTask(user("pm-co", "PROJECT_MANAGER"), project, unassigned), true);
  assert.equal(canCommentOnTask(user("pm-member", "PROJECT_MANAGER"), project, unassigned), true);
  assert.equal(canCommentOnTask(user("pm-viewer", "PROJECT_MANAGER"), project, unassigned), false);
  assert.equal(canCommentOnTask(user("tm-member", "TEAM_MEMBER"), project, assigned), true);
  assert.equal(canCommentOnTask(user("tm-member", "TEAM_MEMBER"), project, unassigned), false);
  assert.equal(canCommentOnTask(user("tm-viewer", "TEAM_MEMBER"), project, { assigneeId: "tm-viewer" }), false);
  assert.equal(canCommentOnTask(user("viewer", "VIEWER"), project, unassigned), false);

  assert.equal(
    canDeleteComment(user("pm-member", "PROJECT_MANAGER"), project, unassigned, { author: { id: "pm-member" } }),
    true,
  );
  assert.equal(
    canDeleteComment(user("pm-member", "PROJECT_MANAGER"), project, unassigned, { author: { id: "tm-member" } }),
    false,
  );
  assert.equal(
    canDeleteComment(user("tm-member", "TEAM_MEMBER"), project, assigned, { author: { id: "tm-member" } }),
    true,
  );
  assert.equal(
    canDeleteComment(user("tm-member", "TEAM_MEMBER"), project, unassigned, { author: { id: "tm-member" } }),
    false,
  );
  assert.equal(
    canDeleteComment(user("tm-viewer", "TEAM_MEMBER"), project, { assigneeId: "tm-viewer" }, { author: { id: "tm-viewer" } }),
    false,
  );
  assert.equal(
    canDeleteComment(user("viewer", "VIEWER"), project, {}, { author: { id: "viewer" } }),
    false,
  );
});

test("eligible assignees are active TEAM_MEMBER users with MEMBER or MANAGER", () => {
  const eligible = eligibleAssignees(project).map((membership) => membership.userId);
  assert.deepEqual(eligible, ["tm-manager", "tm-member"]);
});
