"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  canChangeTaskStatus,
  canCommentOnTask,
  canDeleteComment,
  canManageProject as canManageProjectFor,
  canManageTaskAssignment,
  canUpdateTask,
  eligibleAssignees,
} from "../_lib/permissions";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type Role = "ADMIN" | "PROJECT_MANAGER" | "TEAM_MEMBER" | "VIEWER";
type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active?: boolean;
};
type Comment = {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string };
};
type TaskActivity = {
  id: string;
  eventType: string;
  details: Record<string, unknown>;
  createdAt: string;
  actor: { id: string; name: string } | null;
};
type Task = {
  id: string;
  title: string;
  description: string;
  status: "TODO" | "IN_PROGRESS" | "DONE";
  version: number;
  updatedAt?: string;
  assigneeId?: string | null;
  assignee?: { id: string; name: string } | null;
  comments?: Comment[];
};
type Membership = {
  userId: string;
  role: "MANAGER" | "MEMBER" | "VIEWER";
  user: { id: string; name: string; email: string; role: Role };
};
type Project = {
  id: string;
  name: string;
  description: string;
  archived?: boolean;
  createdAt?: string;
  manager: { id: string; name: string };
  memberships?: Membership[];
  tasks: Task[];
};
type View = "Overview" | "Projects" | "Board" | "Tasks" | "TaskDetail" | "Team" | "Admin";
type RecentWork = {
  id: string;
  kind: "task" | "project";
  title: string;
  projectName: string;
  timestamp: string;
  projectId?: string;
};

class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function messageFor(error: unknown) {
  if (!(error instanceof ApiError)) return "Could not reach FlowForge. Check that the API is running and try again.";
  if (error.code === "REQUEST_TIMEOUT") return "The API did not respond within 12 seconds. Check that the backend is running, then try again.";
  if (error.code === "NETWORK_ERROR") return "Could not reach the API. Check that the backend is running and try again.";
  const messages: Record<string, string> = {
    INVALID_CREDENTIALS: "Email or password is incorrect.",
    UNAUTHENTICATED: "Your session has expired. Please sign in again.",
    FORBIDDEN: "You do not have permission to do that.",
    NOT_FOUND: "That item is no longer available.",
    VALIDATION_ERROR: "Check the form fields and try again.",
    INVALID_MANAGER: "Choose an active Project Manager account.",
    ASSIGNEE_NOT_IN_PROJECT: "Choose an active team member who belongs to this project.",
    MEMBERSHIP_EXISTS: "This person is already on the project.",
    EMAIL_EXISTS: "An account with that email already exists.",
    TASK_VERSION_CONFLICT: "This task changed elsewhere. The latest version has been loaded.",
    CANNOT_DEACTIVATE_SELF: "You cannot deactivate your own account.",
  };
  return messages[error.code] || `Request failed (${error.status}): ${error.code}`;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(response.status, data.error || `HTTP_${response.status}`);
    }
    return (response.status === 204 ? null : await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(0, "REQUEST_TIMEOUT");
    throw new ApiError(0, "NETWORK_ERROR");
  } finally {
    window.clearTimeout(timeout);
  }
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function decodeRouteSegment(value: string) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function StatusPill({ status }: { status: Task["status"] }) {
  const label = status === "TODO" ? "To do" : status === "IN_PROGRESS" ? "In progress" : "Done";
  return <span className={`status-pill status-${status.toLowerCase()}`}><i />{label}</span>;
}

const TASK_STATUSES: Task["status"][] = ["TODO", "IN_PROGRESS", "DONE"];
const STATUS_LABELS: Record<Task["status"], string> = { TODO: "To Do", IN_PROGRESS: "In Progress", DONE: "Done" };

function activitySummary(activity: TaskActivity) {
  const details = activity.details?.changes as Record<string, { from?: unknown; to?: unknown }> | undefined;
  if (activity.eventType === "TASK_CREATED") return "created the task";
  if (activity.eventType === "COMMENT_ADDED") return "added a comment";
  if (activity.eventType === "TASK_STATUS_CHANGED" && details?.status) {
    const statusName = (value: unknown) => value === "TODO" ? "To Do" : value === "IN_PROGRESS" ? "In Progress" : value === "DONE" ? "Done" : String(value);
    return `changed status from ${statusName(details.status.from)} to ${statusName(details.status.to)}`;
  }
  if (activity.eventType === "TASK_ASSIGNEE_CHANGED" && details?.assignee) return `changed assignee from ${String(details.assignee.from)} to ${String(details.assignee.to)}`;
  if (activity.eventType === "TASK_DETAILS_CHANGED") {
    const fields = Object.keys(details || {}).map((key) => key === "title" ? "title" : key === "description" ? "description" : key);
    return `updated ${fields.join(" and ") || "task details"}`;
  }
  return "updated the task";
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span className="empty-icon">◇</span><h3>{title}</h3><p>{text}</p></div>;
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="section-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function DashboardSkeleton() {
  return <div className="dashboard-skeleton" role="status" aria-label="Loading dashboard analytics">
    <span className="sr-only">Loading dashboard analytics…</span>
    <div className="summary-grid">{[0, 1, 2, 3].map((item) => <div className="summary-card skeleton-block" key={item} />)}</div>
    <div className="analytics-grid"><div className="surface-card skeleton-panel" /><div className="surface-card skeleton-panel" /><div className="surface-card skeleton-panel skeleton-wide" /></div>
  </div>;
}

function TaskCard({
  task,
  project,
  user,
  canManageProject,
  busy,
  onUpdate,
  onStatus,
  onDelete,
  onComment,
  onDeleteComment,
}: {
  task: Task;
  project: Project;
  user: User;
  canManageProject: boolean;
  busy: boolean;
  onUpdate: (task: Task, data: { title: string; description: string; assigneeId: string | null }) => void;
  onStatus: (task: Task, status: Task["status"]) => void;
  onDelete: (task: Task) => void;
  onComment: (task: Task, body: string) => Promise<boolean>;
  onDeleteComment: (comment: Comment) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [commentText, setCommentText] = useState("");
  const canManage = canManageProject;
  const canUpdate = canUpdateTask(user, project, task);
  const canComment = canCommentOnTask(user, project, task);
  const members = eligibleAssignees(project);

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onComment(task, commentText);
    if (saved) { setCommentText(""); setCommenting(false); }
  }

  return (
    <article className="task-card">
      <div className="task-topline"><div className="task-title-wrap"><span className="task-mark">✓</span><div><h3><Link className="task-detail-link" href={`/tasks/${encodeURIComponent(task.id)}`}>{task.title}</Link></h3><p className="task-project-name"><Link href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</Link></p></div></div><StatusPill status={task.status} /></div>
      {task.description && <p className="task-description">{task.description}</p>}
      <div className="task-meta"><span className="avatar avatar-small">{initials(task.assignee?.name || "Unassigned")}</span><span>{task.assignee?.name || "Unassigned"}</span><span className="meta-divider" /> <span>Version {task.version}</span></div>

      <div className="task-actions">
        {canUpdate && <label className="compact-field">Status<select aria-label={`Status for ${task.title}`} disabled={busy} value={task.status} onChange={(event) => onStatus(task, event.target.value as Task["status"])}><option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option></select></label>}
        {canManage && <button className="button button-quiet button-small" type="button" onClick={() => setEditing((value) => !value)}>{editing ? "Close editor" : "Edit task"}</button>}
        {canManage && <button className="button button-danger-quiet button-small" type="button" disabled={busy} onClick={() => onDelete(task)}>Delete</button>}
      </div>

      {editing && canManage && <form className="inline-editor" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onUpdate(task, { title: String(form.get("title")), description: String(form.get("description")), assigneeId: String(form.get("assigneeId") || "") || null }); setEditing(false); }}>
        <label>Task name<input name="title" defaultValue={task.title} maxLength={200} required /></label>
        <label>Description<input name="description" defaultValue={task.description} maxLength={2000} /></label>
        <label>Assignee<select name="assigneeId" defaultValue={task.assignee?.id || ""}><option value="">Unassigned</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.user.name}</option>)}</select></label>
        <button className="button button-primary button-small" disabled={busy}>Save task</button>
      </form>}

      <div className="comments-block">
        <div className="comments-heading"><span>Comments <b>{task.comments?.length || 0}</b></span>{canComment && <button className="text-button" type="button" onClick={() => setCommenting((value) => !value)}>{commenting ? "Cancel" : "+ Add comment"}</button>}</div>
        {(task.comments || []).length > 0 ? <div className="comment-list">{task.comments?.map((comment) => <div className="comment-item" key={comment.id}><span className="avatar avatar-tiny">{initials(comment.author.name)}</span><div className="comment-copy"><div><strong>{comment.author.name}</strong><span className="comment-time">Project update</span></div><p>{comment.body}</p></div>{canDeleteComment(user, project, task, comment) && <button className="icon-button" type="button" aria-label={`Delete comment by ${comment.author.name}`} title="Delete comment" onClick={() => onDeleteComment(comment)}>×</button>}</div>)}</div> : <p className="no-comments">No comments yet.</p>}
        {commenting && canComment && <form className="comment-form" onSubmit={submitComment}><label className="sr-only" htmlFor={`comment-${task.id}`}>Add a comment</label><input id={`comment-${task.id}`} value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="Share an update…" maxLength={2000} required /><button className="button button-primary button-small" disabled={busy}>Post</button></form>}
        {!canComment && <p className="read-only-note">View only</p>}
      </div>
    </article>
  );
}

export default function Home() {
  const pathname = usePathname();
  const router = useRouter();
  const taskRoute = pathname.match(/^\/tasks\/([^/]+)$/);
  const taskId = taskRoute ? decodeRouteSegment(taskRoute[1]) : null;
  const view: View = pathname === "/dashboard" ? "Overview"
    : pathname === "/projects" || pathname.startsWith("/projects/") ? "Projects"
    : pathname === "/board" ? "Board"
    : pathname === "/tasks" ? "Tasks"
    : taskRoute ? "TaskDetail"
    : pathname === "/team" ? "Team"
    : pathname === "/admin/users" ? "Admin"
    : "Overview";
  const projectRoute = pathname.match(/^\/projects\/([^/]+)$/);
  const projectId = projectRoute ? decodeRouteSegment(projectRoute[1]) : null;
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDetail, setProjectDetail] = useState<Project | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [booting, setBooting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [boardSearch, setBoardSearch] = useState("");
  const [boardProjectFilter, setBoardProjectFilter] = useState("ALL");
  const [boardAssigneeFilter, setBoardAssigneeFilter] = useState("ALL");
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<Task["status"] | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [editingTask, setEditingTask] = useState(false);
  const [taskTitleDraft, setTaskTitleDraft] = useState("");
  const [taskDescriptionDraft, setTaskDescriptionDraft] = useState("");
  const [taskAssigneeDraft, setTaskAssigneeDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const statusUpdateInFlight = useRef(false);

  const isAdmin = user?.role === "ADMIN";
  const canManageProject = (project: Project) => !!user && canManageProjectFor(user, project);
  const visibleProjects = useMemo(() => projects.filter((project) => {
    const text = `${project.name} ${project.description} ${project.tasks.map((task) => task.title).join(" ")}`.toLowerCase();
    return text.includes(query.toLowerCase());
  }), [projects, query]);
  const tasks = useMemo(() => visibleProjects.flatMap((project) => project.tasks.map((task) => ({ ...task, project })))
    .filter(({ status }) => statusFilter === "ALL" || status === statusFilter), [visibleProjects, statusFilter]);
  const accessibleTasks = useMemo(() => projects.flatMap((project) => project.tasks.map((task) => ({ task, project }))), [projects]);
  const taskDetail = taskId ? accessibleTasks.find(({ task }) => task.id === taskId) || null : null;
  const boardAssignees = useMemo(() => {
    const unique = new Map<string, string>();
    for (const { task } of accessibleTasks) {
      const id = task.assignee?.id || task.assigneeId || "UNASSIGNED";
      unique.set(id, task.assignee?.name || "Unassigned");
    }
    return [...unique.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [accessibleTasks]);
  const filteredBoardTasks = useMemo(() => {
    const search = boardSearch.trim().toLowerCase();
    return accessibleTasks.filter(({ task, project }) => {
      const assigneeId = task.assignee?.id || task.assigneeId || "UNASSIGNED";
      return (boardProjectFilter === "ALL" || project.id === boardProjectFilter) &&
        (boardAssigneeFilter === "ALL" || assigneeId === boardAssigneeFilter) &&
        (!search || task.title.toLowerCase().includes(search));
    });
  }, [accessibleTasks, boardAssigneeFilter, boardProjectFilter, boardSearch]);
  const totalTasks = projects.reduce((total, project) => total + project.tasks.length, 0);
  const dashboardAnalytics = useMemo(() => {
    const visibleTasks = projects.flatMap((project) => project.tasks.map((task) => ({ task, project })));
    const statusCounts: Record<Task["status"], number> = { TODO: 0, IN_PROGRESS: 0, DONE: 0 };
    const workloadByAssignee = new Map<string, { id: string; name: string; count: number }>();
    for (const { task } of visibleTasks) {
      statusCounts[task.status] += 1;
      const id = task.assignee?.id || "unassigned";
      const name = task.assignee?.name || "Unassigned";
      const current = workloadByAssignee.get(id);
      if (current) current.count += 1;
      else workloadByAssignee.set(id, { id, name, count: 1 });
    }
    const workload = [...workloadByAssignee.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const recentWork: RecentWork[] = [
      ...visibleTasks.flatMap(({ task, project }) => task.updatedAt ? [{ id: `task-${task.id}`, kind: "task" as const, title: task.title, projectName: project.name, timestamp: task.updatedAt }] : []),
      ...projects.flatMap((project) => project.createdAt ? [{ id: `project-${project.id}`, kind: "project" as const, title: project.name, projectName: project.name, timestamp: project.createdAt, projectId: project.id }] : []),
    ].filter((item) => !Number.isNaN(Date.parse(item.timestamp)))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 6);
    const activeProjects = projects.filter((project) => !project.archived).length;
    return {
      totalProjects: projects.length,
      activeProjects,
      archivedProjects: projects.length - activeProjects,
      totalTasks: visibleTasks.length,
      statusCounts,
      completion: visibleTasks.length ? Math.round(statusCounts.DONE / visibleTasks.length * 100) : 0,
      workload,
      recentWork,
    };
  }, [projects]);
  const maxWorkload = Math.max(0, ...dashboardAnalytics.workload.map((person) => person.count));

  async function loadData(activeUser: User, activePath = pathname, isCurrent: () => boolean = () => true) {
    const data = await request<Project[]>("/api/projects");
    if (!isCurrent()) return;
    setProjects(data);
    setProjectsLoaded(true);
    const taskRoute = activePath.match(/^\/tasks\/([^/]+)$/);
    const taskId = taskRoute ? decodeRouteSegment(taskRoute[1]) : null;
    const taskIsVisible = taskId ? data.some((project) => project.tasks.some((task) => task.id === taskId)) : false;
    setActivity([]);
    setActivityError("");
    if (taskIsVisible) {
      setActivityLoading(true);
      try {
        const events = await request<TaskActivity[]>(`/api/tasks/${encodeURIComponent(taskId!)}/activity`);
        if (isCurrent()) setActivity(events);
      } catch (reason) {
        if (isCurrent()) setActivityError(messageFor(reason));
      } finally {
        if (isCurrent()) setActivityLoading(false);
      }
    } else {
      setActivityLoading(false);
    }
    if (activeUser.role === "ADMIN") {
      const accounts = await request<User[]>("/api/users");
      if (!isCurrent()) return;
      setUsers(accounts);
    }
    else setUsers([]);
    const detailRoute = activePath.match(/^\/projects\/([^/]+)$/);
    const detailId = detailRoute ? decodeRouteSegment(detailRoute[1]) : null;
    const detail = detailId ? await request<Project>(`/api/projects/${encodeURIComponent(detailId)}`) : null;
    if (isCurrent()) setProjectDetail(detail);
  }

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const current = await request<User>("/api/auth/me");
        if (!mounted) return;
        setUser(current);
        if (pathname === "/") router.replace("/dashboard");
      } catch (reason) {
        if (reason instanceof ApiError && reason.status !== 401 && mounted) setError(messageFor(reason));
      } finally {
        if (mounted) setBooting(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (user && pathname === "/") router.replace("/dashboard");
  }, [pathname, router, user]);

  useEffect(() => {
    if (!user) return;
    let mounted = true;
    setLoading(true);
    setError("");
    if (/^\/projects\/[^/]+$/.test(pathname)) setProjectDetail(null);
    loadData(user, pathname, () => mounted).catch((reason) => {
      if (mounted) setError(messageFor(reason));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [pathname, user]);

  useEffect(() => {
    const pageName = projectDetail?.name || (view === "TaskDetail" ? taskDetail?.task.title || "Task" : view === "Overview" ? "Dashboard" : view === "Admin" ? "Admin users" : view);
    document.title = `${user ? pageName : "Sign in"} | FlowForge`;
  }, [projectDetail?.name, taskDetail?.task.title, user, view]);

  useEffect(() => {
    if (!taskDetail) return;
    setTaskTitleDraft(taskDetail.task.title);
    setTaskDescriptionDraft(taskDetail.task.description);
    setTaskAssigneeDraft(taskDetail.task.assigneeId || taskDetail.task.assignee?.id || "");
  }, [taskDetail?.task.id, taskDetail?.task.version]);

  async function refresh() {
    if (user) await loadData(user, pathname);
  }

  async function retryWorkspaceLoad() {
    if (!user) return;
    setLoading(true);
    setError("");
    try { await loadData(user, pathname); }
    catch (reason) { setError(messageFor(reason)); }
    finally { setLoading(false); }
  }

  async function changeTaskStatus(project: Project, task: Task, status: Task["status"]) {
    if (!user || status === task.status || busy || statusUpdateInFlight.current || !canChangeTaskStatus(user, project, task)) return false;
    statusUpdateInFlight.current = true;
    setSavingTaskId(task.id);
    setDraggedTaskId(null);
    setDropTargetStatus(null);
    try {
      return await mutate("Task status updated.", () => request(`/api/tasks/${encodeURIComponent(task.id)}`, "PATCH", { status, version: task.version }));
    } finally {
      statusUpdateInFlight.current = false;
      setSavingTaskId(null);
    }
  }

  async function saveTaskDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!taskDetail || !user) return;
    const payload: Record<string, unknown> = {
      title: taskTitleDraft.trim(),
      description: taskDescriptionDraft,
      version: taskDetail.task.version,
    };
    if (canManageTaskAssignment(user, taskDetail.project)) payload.assigneeId = taskAssigneeDraft || null;
    const saved = await mutate("Task details updated.", () => request(`/api/tasks/${encodeURIComponent(taskDetail.task.id)}`, "PATCH", payload));
    if (saved) setEditingTask(false);
  }

  async function addTaskComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!taskDetail || !commentDraft.trim()) return;
    const saved = await mutate("Comment added.", () => request(`/api/tasks/${encodeURIComponent(taskDetail.task.id)}/comments`, "POST", { body: commentDraft.trim() }));
    if (saved) setCommentDraft("");
  }

  async function retryActivity() {
    if (!taskDetail) return;
    setActivityLoading(true);
    setActivityError("");
    try { setActivity(await request<TaskActivity[]>(`/api/tasks/${encodeURIComponent(taskDetail.task.id)}/activity`)); }
    catch (reason) { setActivityError(messageFor(reason)); }
    finally { setActivityLoading(false); }
  }

  async function mutate(label: string, action: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try {
      await action();
      if (user) await loadData(user, pathname);
      setNotice(label);
      return true;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && reason.code === "TASK_VERSION_CONFLICT") await refresh().catch(() => undefined);
      setError(messageFor(reason));
      return false;
    } finally { setBusy(false); }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const signedIn = await request<User>("/api/auth/login", "POST", { email, password });
      setUser(signedIn); setPassword(""); setNotice(`Welcome back, ${signedIn.name}.`); router.replace("/dashboard");
    } catch (reason) { setError(messageFor(reason)); }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true); setError("");
    try { await request<null>("/api/auth/logout", "POST"); setUser(null); setProjects([]); setProjectsLoaded(false); setProjectDetail(null); setUsers([]); setNotice(""); router.replace("/"); }
    catch (reason) { setError(messageFor(reason)); }
    finally { setBusy(false); }
  }

  function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    void mutate("Project created.", () => request("/api/projects", "POST", { name: form.get("name"), description: form.get("description"), managerId: form.get("managerId") || undefined })).then((saved) => { if (saved) formElement.reset(); });
  }

  function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    void mutate("User account created.", () => request("/api/users", "POST", { name: form.get("name"), email: form.get("email"), password: form.get("password"), role: form.get("role") })).then((saved) => { if (saved) formElement.reset(); });
  }

  function createTask(project: Project, event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    void mutate("Task added to project.", () => request(`/api/projects/${project.id}/tasks`, "POST", { title: form.get("title"), description: form.get("description"), assigneeId: form.get("assigneeId") || undefined })).then((saved) => { if (saved) formElement.reset(); });
  }

  if (booting) return <main className="boot-screen"><div className="brand-mark">F</div><p>Loading your workspace…</p></main>;

  if (!user) return <main className="login-screen"><section className="login-brand-panel"><div className="brand-lockup"><span className="brand-mark">F</span><span>FlowForge</span></div><div className="login-pitch"><span className="eyebrow light-eyebrow">WORK, IN SYNC</span><h1>Make meaningful progress together.</h1><p>One clear place to organize projects, align your team, and keep every task moving.</p><div className="login-decoration"><div className="decoration-line" /><div className="decoration-line short" /><div className="decoration-card"><span className="decoration-check">✓</span><span><b>Launch checklist</b><small>Progress is looking good</small></span><span className="decoration-status">On track</span></div></div></div><span className="panel-footnote">A calmer way to move work forward.</span></section>
    <section className="login-form-panel"><div className="login-form-wrap"><div className="eyebrow">WELCOME BACK</div><h2>Sign in to your workspace</h2><p className="form-intro">Use your FlowForge account to continue.</p>{error && <div className="alert alert-error" role="alert"><span>!</span>{error}</div>}
      <form onSubmit={login} className="stack-form"><label>Email address<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" required /></label><label>Password<span className="password-input"><input type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required /><button type="button" className="password-toggle" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? "Hide" : "Show"}</button></span></label><button className="button button-primary button-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<span>→</span></button></form><div className="login-help">Demo accounts are documented in the project README.</div></div></section></main>;

  return <main className="app-shell">
    <aside className="sidebar"><div className="brand-lockup"><span className="brand-mark">F</span><span>FlowForge</span></div><div className="workspace-switch"><span className="workspace-icon">F</span><span><small>WORKSPACE</small><b>FlowForge</b></span><span className="chevron">⌄</span></div><nav className="side-nav" aria-label="Main navigation"><span className="nav-label">WORKSPACE</span>{([['Overview', '/dashboard', '\u25a6'], ['Projects', '/projects', '\u25a4'], ['Tasks', '/tasks', '\u2713'], ['Team', '/team', '\u2667']] as const).map(([item, href, icon]) => <Link key={item} href={href} className={`nav-item ${view === item ? "active" : ""}`}><span className="nav-icon">{icon}</span>{item}{item === "Tasks" && <span className="nav-count">{totalTasks}</span>}</Link>)}{isAdmin && <><span className="nav-label nav-label-spaced">MANAGE</span><Link href="/admin/users" className={`nav-item ${view === "Admin" ? "active" : ""}`}><span className="nav-icon">{String.fromCharCode(0x2699)}</span>Administration</Link></>}<Link href="/board" className={`nav-item ${view === "Board" ? "active" : ""}`}><span className="nav-icon">▦</span>Board</Link></nav><div className="sidebar-bottom"><div className="help-card"><span className="help-icon">?</span><b>Need a hand?</b><p>Check the project README for setup and demo account details.</p></div><div className="sidebar-user"><span className="avatar">{initials(user.name)}</span><span className="sidebar-user-copy"><b>{user.name}</b><small>{user.role.replaceAll("_", " ")}</small></span></div></div></aside>

    <section className="main-panel"><header className="topbar"><div className="breadcrumb"><Link href="/dashboard">FlowForge</Link><b>/</b><strong>{projectDetail?.name || (view === "Overview" ? "Dashboard" : view === "Admin" ? "Admin users" : view)}</strong></div><div className="topbar-actions"><label className="search-box"><span>⌕</span><input aria-label="Search projects and tasks" placeholder="Search projects and tasks…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><span className="topbar-divider" /><div className="profile-chip"><span className="avatar avatar-small">{initials(user.name)}</span><span>{user.name}</span><button className="text-button" type="button" onClick={logout} disabled={busy}>Sign out</button></div></div></header>

    <div className={`page-content ${view === "Overview" ? "dashboard-content" : ""}`}>{error && <div className="alert alert-error global-alert" role="alert"><span>!</span>{error}{(view === "Overview" || view === "Board" || view === "TaskDetail") && <button className="button button-secondary button-small" type="button" onClick={retryWorkspaceLoad} disabled={loading}>Retry</button>}<button className="alert-close" onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}{notice && <div className="alert alert-success global-alert" role="status"><span>✓</span>{notice}<button className="alert-close" onClick={() => setNotice("")} aria-label="Dismiss message">×</button></div>}
      {loading && <div className="loading-strip"><span className="spinner" /> Syncing workspace…</div>}

      {view === "Overview" && <>
        <SectionHeading eyebrow="YOUR WORKSPACE" title={"Good to see you, " + user.name.split(" ")[0]} description="Here’s the latest across your projects." action={isAdmin ? <button className="button button-primary" onClick={() => router.push("/projects")}>＋ New project</button> : undefined} />
        {!projectsLoaded ? loading ? <DashboardSkeleton /> : <section className="surface-card dashboard-unavailable"><h2>Dashboard data is unavailable</h2><p>Metrics will appear after FlowForge can load your authorized projects and tasks.</p><button className="button button-secondary button-small" type="button" onClick={retryWorkspaceLoad}>Try again</button></section> : <>
          <div className="summary-grid analytics-summary">
            <article className="summary-card"><span className="summary-icon icon-violet">▤</span><span className="summary-label">Visible projects</span><b>{dashboardAnalytics.totalProjects}</b><small>{dashboardAnalytics.activeProjects} active · {dashboardAnalytics.archivedProjects} archived</small></article>
            <article className="summary-card"><span className="summary-icon icon-blue">◷</span><span className="summary-label">Active projects</span><b>{dashboardAnalytics.activeProjects}</b><small>Of {dashboardAnalytics.totalProjects} visible projects</small></article>
            <article className="summary-card"><span className="summary-icon icon-green">✓</span><span className="summary-label">Visible tasks</span><b>{dashboardAnalytics.totalTasks}</b><small>{dashboardAnalytics.statusCounts.TODO} to do · {dashboardAnalytics.statusCounts.IN_PROGRESS} in progress</small></article>
            <article className="summary-card"><span className="summary-icon icon-amber">%</span><span className="summary-label">Task completion</span><b>{dashboardAnalytics.totalTasks ? dashboardAnalytics.completion + "%" : "—"}</b><small>{dashboardAnalytics.totalTasks ? dashboardAnalytics.statusCounts.DONE + " of " + dashboardAnalytics.totalTasks + " tasks done" : "No tasks yet"}</small></article>
          </div>
          <div className="analytics-grid">
            <section className="surface-card analytics-card" aria-labelledby="status-breakdown-title"><div className="card-heading"><div><h2 id="status-breakdown-title">Task status</h2><p>Visible tasks by current status</p></div><span className="analytics-total">{dashboardAnalytics.totalTasks} total</span></div>
              <div className="status-breakdown">{([["TODO", "To do"], ["IN_PROGRESS", "In progress"], ["DONE", "Done"]] as const).map(([status, label]) => {
                const count = dashboardAnalytics.statusCounts[status];
                const percent = dashboardAnalytics.totalTasks ? Math.round(count / dashboardAnalytics.totalTasks * 100) : 0;
                return <div className="status-breakdown-row" key={status}><div className="status-breakdown-label"><span className={"task-dot dot-" + status.toLowerCase()} /><b>{label}</b><span>{count}</span><small>{percent}%</small></div><div className="analytics-bar" role="img" aria-label={label + ": " + count + " tasks, " + percent + "%"}><i className={"analytics-fill fill-" + status.toLowerCase()} style={{ width: percent + "%" }} /></div></div>;
              })}</div>
            </section>
            <section className="surface-card analytics-card" aria-labelledby="workload-title"><div className="card-heading"><div><h2 id="workload-title">Team workload</h2><p>Visible tasks grouped by assignee</p></div><span className="analytics-total">{dashboardAnalytics.workload.length} assignees</span></div>
              {dashboardAnalytics.workload.length ? <div className="workload-list">{dashboardAnalytics.workload.map((person) => <div className="workload-row" key={person.id}><span className={"avatar avatar-small " + (person.id === "unassigned" ? "avatar-unassigned" : "")}>{person.id === "unassigned" ? "—" : initials(person.name)}</span><span className="workload-person"><b>{person.name}</b><span className="analytics-bar"><i style={{ width: (maxWorkload ? person.count / maxWorkload * 100 : 0) + "%" }} /></span></span><strong>{person.count}</strong></div>)}</div> : <EmptyState title="No task workload yet" text="Tasks will be grouped here when they are available." />}
            </section>
            <section className="surface-card analytics-card analytics-recent" aria-labelledby="recent-work-title"><div className="card-heading"><div><h2 id="recent-work-title">Recent work</h2><p>Projects created and tasks updated, ordered by available timestamps</p></div><button className="text-button" onClick={() => router.push("/tasks")}>View tasks →</button></div>
              {dashboardAnalytics.recentWork.length ? <div className="recent-work-list">{dashboardAnalytics.recentWork.map((item) => <Link className="recent-work-row" key={item.id} href={item.kind === "task" ? "/tasks" : "/projects/" + encodeURIComponent(item.projectId || "")}><span className={"recent-work-icon " + (item.kind === "task" ? "recent-task-icon" : "recent-project-icon")}>{item.kind === "task" ? "✓" : "▤"}</span><span className="recent-work-copy"><b>{item.title}</b><small>{item.kind === "task" ? item.projectName + " · Task updated" : "Project created"}</small></span><time dateTime={item.timestamp}>{formatDate(item.timestamp)}</time></Link>)}</div> : <EmptyState title="No recent work yet" text="Projects and tasks with available timestamps will appear here." />}
            </section>
          </div>
        </>}
      </>}
      {view === "Projects" && projectId && <>
        {loading && !projectDetail ? <div className="surface-card route-loading" role="status"><span className="spinner" /> Loading project details…</div> : projectDetail ? <>
          <SectionHeading eyebrow="PROJECT WORKSPACE" title={projectDetail.name} description={projectDetail.description || "Project details, team, tasks, and discussion."} action={<Link className="button button-secondary" href="/projects">All projects</Link>} />
          <div className="project-detail-grid">
            <section className="surface-card project-detail-summary"><div className="card-heading"><div><h2>Project details</h2><p>Managed by {projectDetail.manager.name}</p></div><span className={projectDetail.archived ? "archived-pill" : "status-pill status-done"}>{projectDetail.archived ? "Archived" : "Active"}</span></div><p className="project-detail-description">{projectDetail.description || "No description has been added yet."}</p><div className="project-detail-stats"><span><b>{projectDetail.tasks.length}</b> tasks</span><span><b>{projectDetail.memberships?.length || 0}</b> members</span></div><Link className="text-button" href="/team">View team and membership settings →</Link></section>
            <section className="surface-card project-detail-team"><div className="card-heading"><div><h2>Project team</h2><p>People with project access</p></div></div>{projectDetail.memberships?.length ? <ul className="detail-member-list">{projectDetail.memberships.map((membership) => <li key={membership.userId}><span className="avatar avatar-small">{initials(membership.user.name)}</span><span><b>{membership.user.name}</b><small>{membership.user.role.replaceAll("_", " ")}</small></span><span className="project-role-pill">{membership.role}</span></li>)}</ul> : <EmptyState title="No project members" text="This project currently has no additional members." />}</section>
          </div>
          <section className="project-detail-tasks"><div className="card-heading"><div><h2>Project tasks</h2><p>Task updates and comments for this project</p></div><span className="member-count">{projectDetail.tasks.length} total</span></div>{projectDetail.tasks.length ? <div className="task-list">{projectDetail.tasks.map((task) => <TaskCard key={`${task.id}-${task.version}`} task={task} project={projectDetail} user={user} busy={busy} canManageProject={canManageProject(projectDetail)} onUpdate={(current, data) => void mutate("Task updated.", () => request(`/api/tasks/${current.id}`, "PATCH", { ...data, version: current.version }))} onStatus={(current, status) => void mutate("Task status updated.", () => request(`/api/tasks/${current.id}`, "PATCH", { status, version: current.version }))} onDelete={(current) => { if (window.confirm(`Delete “${current.title}”? This cannot be undone.`)) void mutate("Task deleted.", () => request(`/api/tasks/${current.id}`, "DELETE")); }} onComment={(current, body) => mutate("Comment added.", () => request(`/api/tasks/${current.id}/comments`, "POST", { body }))} onDeleteComment={(comment) => { if (window.confirm("Delete this comment?")) void mutate("Comment deleted.", () => request(`/api/comments/${comment.id}`, "DELETE")); }} />)}</div> : <EmptyState title="No tasks yet" text="Tasks added to this project will appear here." />}</section>
        </> : <EmptyState title="Project unavailable" text="This project may not exist, or your account may not have access to it." />}
      </>}

      {view === "Projects" && !projectId && <><SectionHeading eyebrow="ORGANIZE YOUR WORK" title="Projects" description="Plan work, share context, and see progress across your team." action={isAdmin ? <button className="button button-primary" onClick={() => document.getElementById("create-project")?.scrollIntoView({ behavior: "smooth", block: "center" })}>＋ New project</button> : undefined} />
        {isAdmin && <form id="create-project" className="surface-card create-project-form" onSubmit={createProject}><div className="form-card-title"><div><h2>Create a project</h2><p>Start a new shared workspace.</p></div><span className="create-project-icon">＋</span></div><div className="form-grid"><label>Project name<input name="name" maxLength={100} placeholder="e.g. Website relaunch" required /></label><label>Project Manager<select name="managerId" required defaultValue=""><option value="" disabled>Select a manager</option>{users.filter((account) => account.active && account.role === "PROJECT_MANAGER").map((account) => <option key={account.id} value={account.id}>{account.name} · {account.email}</option>)}</select></label><label className="field-wide">Description<input name="description" maxLength={1000} placeholder="What is this project about?" /></label></div><button className="button button-primary" disabled={busy}>{busy ? "Creating…" : "Create project"}</button></form>}
        <div className="list-toolbar"><div><b>{visibleProjects.length}</b> projects <span>·</span> Search filters projects and tasks</div><select aria-label="Project visibility filter" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}><option value="ALL">All work</option><option value="TODO">To do</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option></select></div>
        {visibleProjects.length === 0 ? <EmptyState title="No matching projects" text={projects.length ? "Try a different search." : "Projects you can access will appear here."} /> : <div className="project-grid">{visibleProjects.map((project, index) => {
          const completed = project.tasks.filter((task) => task.status === "DONE").length;
          const progress = project.tasks.length ? Math.round(completed / project.tasks.length * 100) : 0;
          const taskMatches = project.tasks.filter((task) => statusFilter === "ALL" || task.status === statusFilter);
          return <article className="project-card" key={project.id}><div className={`project-card-accent accent-${index % 4}`} /><div className="project-card-main"><div className="project-card-heading"><div className={`project-avatar project-avatar-large avatar-tone-${index % 4}`}>{initials(project.name)}</div><div className="project-card-title"><div className="project-title-line"><h2><Link href={`/projects/${project.id}`}>{project.name}</Link></h2>{project.archived && <span className="archived-pill">Archived</span>}</div><p>{project.description || "No project description yet."}</p></div><button className="icon-button more-button" aria-label={`Project actions for ${project.name}`} title="Project actions" onClick={(event) => { const menu = event.currentTarget.nextElementSibling as HTMLDetailsElement | null; menu?.toggleAttribute("open"); }}>···</button><details className="project-menu"><summary className="sr-only">Project actions</summary><div><p>Managed by <b>{project.manager.name}</b></p>{canManageProject(project) && <button type="button" onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; const editor = document.getElementById(`edit-${project.id}`) as HTMLDetailsElement | null; if (editor) { editor.open = true; editor.scrollIntoView({ behavior: "smooth", block: "center" }); editor.querySelector<HTMLInputElement>('input[name="name"]')?.focus({ preventScroll: true }); } }}>Edit project</button>}{canManageProject(project) && <button type="button" onClick={() => void mutate(project.archived ? "Project restored." : "Project archived.", () => request(`/api/projects/${project.id}/archive`, "PATCH", { archived: !project.archived }))}>{project.archived ? "Restore project" : "Archive project"}</button>}{isAdmin && <button className="menu-danger" type="button" onClick={() => { if (window.confirm(`Delete “${project.name}” and all its tasks and comments? This cannot be undone.`)) void mutate("Project deleted.", () => request(`/api/projects/${project.id}`, "DELETE")); }}>Delete project</button>}</div></details></div>
            <div className="project-stats"><div><span>Tasks</span><b>{project.tasks.length}</b></div><div><span>Team</span><b>{project.memberships?.length || 0}</b></div><div className="project-progress"><div><span>Progress</span><b>{progress}%</b></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></div></div>
            {canManageProject(project) && <details className="disclosure" id={`edit-${project.id}`}><summary>Edit project details</summary><form className="inline-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const data: Record<string, string> = { name: String(form.get("name")), description: String(form.get("description")) }; if (isAdmin) data.managerId = String(form.get("managerId")); void mutate("Project details saved.", () => request(`/api/projects/${project.id}`, "PATCH", data)); }}><label>Project name<input name="name" defaultValue={project.name} maxLength={100} required /></label><label>Description<input name="description" defaultValue={project.description} maxLength={1000} /></label>{isAdmin && <label>Project Manager<select name="managerId" defaultValue={project.manager.id}>{users.filter((account) => account.active && account.role === "PROJECT_MANAGER").map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}<button className="button button-secondary button-small" disabled={busy}>Save changes</button></form></details>}
            {canManageProject(project) && <details className="disclosure"><summary>Add a task</summary><form className="inline-form" onSubmit={(event) => createTask(project, event)}><label>Task name<input name="title" placeholder="Describe the next step" maxLength={200} required /></label><label>Description<input name="description" placeholder="Optional details" maxLength={2000} /></label><label>Assign to<select name="assigneeId" defaultValue=""><option value="">Unassigned</option>{eligibleAssignees(project).map((member) => <option key={member.userId} value={member.userId}>{member.user.name}</option>)}</select></label><button className="button button-secondary button-small" disabled={busy}>Create task</button></form></details>}
            <div className="project-task-preview"><div className="preview-heading"><b>Task list</b><span>{taskMatches.length} {taskMatches.length === 1 ? "task" : "tasks"}</span></div>{taskMatches.slice(0, 3).map((task) => <div className="preview-task" key={task.id}><span className={`task-dot dot-${task.status.toLowerCase()}`} /><span>{task.title}</span><StatusPill status={task.status} /></div>)}{taskMatches.length > 3 && <button className="text-button" onClick={() => router.push("/tasks")}>View all {taskMatches.length} tasks →</button>}{taskMatches.length === 0 && <p className="small-muted">No tasks match this filter.</p>}</div>
            <div className="project-card-footer"><span className="manager-avatar avatar">{initials(project.manager.name)}</span><span>Project Manager <b>{project.manager.name}</b></span><button className="text-button" onClick={() => router.push("/team")}>Manage team →</button></div>
          </div></article>;
        })}</div>}
      </>}

      {view === "Board" && <>
        <SectionHeading eyebrow="TASK FLOW" title="Kanban board" description="Move work through To Do, In Progress, and Done. Drag a card or use its status control." />
        {!projectsLoaded ? loading ? <DashboardSkeleton /> : <section className="surface-card board-empty-state"><h2>Board data is unavailable</h2><p>Tasks will appear when FlowForge can load your authorized projects.</p><button className="button button-secondary button-small" type="button" onClick={retryWorkspaceLoad}>Try again</button></section> : <>
          <section className="surface-card board-filters" aria-label="Filter board tasks">
            <label>Search title<input type="search" value={boardSearch} onChange={(event) => setBoardSearch(event.target.value)} placeholder="Find a task…" /></label>
            <label>Project<select value={boardProjectFilter} onChange={(event) => setBoardProjectFilter(event.target.value)}><option value="ALL">All projects</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label>Assignee<select value={boardAssigneeFilter} onChange={(event) => setBoardAssigneeFilter(event.target.value)}><option value="ALL">All assignees</option>{boardAssignees.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
            <button className="button button-secondary button-small" type="button" disabled={!boardSearch && boardProjectFilter === "ALL" && boardAssigneeFilter === "ALL"} onClick={() => { setBoardSearch(""); setBoardProjectFilter("ALL"); setBoardAssigneeFilter("ALL"); }}>Reset filters</button>
            <span className="board-result-count" aria-live="polite">{filteredBoardTasks.length} {filteredBoardTasks.length === 1 ? "task" : "tasks"}</span>
          </section>
          {accessibleTasks.length === 0 ? <div className="surface-card board-empty-state"><EmptyState title="No tasks on the board" text="Tasks from projects you can access will appear here." /></div> : filteredBoardTasks.length === 0 ? <div className="surface-card board-empty-state" role="status"><h2>No matching tasks</h2><p>Adjust or reset the project, assignee, or title filters.</p><button className="button button-secondary button-small" type="button" onClick={() => { setBoardSearch(""); setBoardProjectFilter("ALL"); setBoardAssigneeFilter("ALL"); }}>Reset filters</button></div> : null}
          <div className="kanban-board" aria-label="Tasks by status">
            {TASK_STATUSES.map((status) => {
              const columnTasks = filteredBoardTasks.filter(({ task }) => task.status === status);
              return <section className={"kanban-column" + (dropTargetStatus === status ? " drop-target" : "")} key={status} aria-labelledby={"kanban-" + status}>
                <header className="kanban-column-heading"><div><span className={"task-dot dot-" + status.toLowerCase()} /><h2 id={"kanban-" + status}>{STATUS_LABELS[status]}</h2></div><span className="kanban-count">{columnTasks.length}</span></header>
                <div className="kanban-card-list" onDragOver={(event) => { if (!draggedTaskId || busy) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTargetStatus(status); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetStatus(null); }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || draggedTaskId; setDraggedTaskId(null); setDropTargetStatus(null); const entry = filteredBoardTasks.find(({ task }) => task.id === id); if (entry) void changeTaskStatus(entry.project, entry.task, status); }}>
                  {columnTasks.map(({ task, project }) => {
                    const canMove = canChangeTaskStatus(user, project, task);
                    const saving = savingTaskId === task.id;
                    return <article className={"kanban-card" + (saving ? " is-saving" : "")} key={task.id} draggable={canMove && !busy} onDragStart={(event) => { if (!canMove || busy) { event.preventDefault(); return; } event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; setDraggedTaskId(task.id); }} onDragEnd={() => { setDraggedTaskId(null); setDropTargetStatus(null); }}>
                      <div className="kanban-card-title-row"><Link className="kanban-task-title" href={"/tasks/" + encodeURIComponent(task.id)}>{task.title}</Link><StatusPill status={task.status} /></div>
                      <Link className="kanban-project-link" href={"/projects/" + encodeURIComponent(project.id)}>{project.name}</Link>
                      <div className="kanban-card-meta"><span className="avatar avatar-small">{initials(task.assignee?.name || "Unassigned")}</span><span>{task.assignee?.name || "Unassigned"}</span>{task.updatedAt && <time dateTime={task.updatedAt}>Updated {formatDate(task.updatedAt)}</time>}</div>
                      {canMove && <label className="board-status-control">Move to<select aria-label={"Move " + task.title + " to status"} value={task.status} disabled={busy || saving} onChange={(event) => void changeTaskStatus(project, task, event.target.value as Task["status"])}>{TASK_STATUSES.map((option) => <option value={option} key={option}>{STATUS_LABELS[option]}</option>)}</select></label>}
                      {saving && <span className="saving-task-indicator" role="status"><span className="spinner" /> Saving status…</span>}
                    </article>;
                  })}
                  {columnTasks.length === 0 && <p className="kanban-column-empty">{accessibleTasks.length ? "No matching tasks." : "No tasks in this status."}</p>}
                </div>
              </section>;
            })}
          </div>
        </>}
      </>}

      {view === "TaskDetail" && <>
        <SectionHeading eyebrow="TASK DETAILS" title={taskDetail?.task.title || "Task"} description="Task information from the projects you can access." action={taskDetail ? <Link className="button button-secondary" href={"/projects/" + encodeURIComponent(taskDetail.project.id)}>Open project</Link> : undefined} />
        {loading && !taskDetail ? <div className="surface-card route-loading" role="status"><span className="spinner" /> Loading task…</div> : error && !taskDetail ? <section className="surface-card board-empty-state"><h2>Could not load this task</h2><p>Retry to check whether the task is available to your account.</p><button className="button button-secondary button-small" type="button" onClick={retryWorkspaceLoad}>Try again</button></section> : taskDetail ? <>
          <article className="surface-card task-detail-card">
            <div className="task-detail-top"><StatusPill status={taskDetail.task.status} /><span>Version {taskDetail.task.version}</span>{canChangeTaskStatus(user, taskDetail.project, taskDetail.task) && !editingTask && <button className="button button-secondary button-small" type="button" onClick={() => setEditingTask(true)}>Edit task</button>}</div>
            {!editingTask ? <>
              <h2>{taskDetail.task.title}</h2>
              <Link className="task-detail-project-link" href={"/projects/" + encodeURIComponent(taskDetail.project.id)}>{taskDetail.project.name}</Link>
              <p className="task-detail-description">{taskDetail.task.description || "No description has been added."}</p>
              <div className="task-detail-meta"><div><small>Assignee</small><span className="task-detail-assignee"><span className="avatar avatar-small">{initials(taskDetail.task.assignee?.name || "Unassigned")}</span>{taskDetail.task.assignee?.name || "Unassigned"}</span></div>{taskDetail.task.updatedAt && <div><small>Last updated</small><time dateTime={taskDetail.task.updatedAt}>{formatDateTime(taskDetail.task.updatedAt)}</time></div>}</div>
            </> : <form className="task-edit-form" onSubmit={(event) => void saveTaskDetails(event)}>
              <label>Title<input value={taskTitleDraft} onChange={(event) => setTaskTitleDraft(event.target.value)} maxLength={200} required /></label>
              <label>Description<textarea value={taskDescriptionDraft} onChange={(event) => setTaskDescriptionDraft(event.target.value)} maxLength={2000} rows={5} /></label>
              {canManageTaskAssignment(user, taskDetail.project) && <label>Assignee<select value={taskAssigneeDraft} onChange={(event) => setTaskAssigneeDraft(event.target.value)}><option value="">Unassigned</option>{eligibleAssignees(taskDetail.project).map((membership) => <option value={membership.userId} key={membership.userId}>{membership.user.name}</option>)}{taskDetail.task.assignee && !(taskDetail.project.memberships || []).some((membership) => membership.userId === taskDetail.task.assignee?.id) && <option value={taskDetail.task.assignee.id}>{taskDetail.task.assignee.name}</option>}</select></label>}
              <div className="task-edit-actions"><button className="button button-primary button-small" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button><button className="button button-secondary button-small" type="button" disabled={busy} onClick={() => { setEditingTask(false); setTaskTitleDraft(taskDetail.task.title); setTaskDescriptionDraft(taskDetail.task.description); setTaskAssigneeDraft(taskDetail.task.assigneeId || ""); }}>Cancel</button></div>
            </form>}
            {canChangeTaskStatus(user, taskDetail.project, taskDetail.task) && <label className="board-status-control task-detail-status">Update status<select aria-label="Update task status" value={taskDetail.task.status} disabled={busy} onChange={(event) => void changeTaskStatus(taskDetail.project, taskDetail.task, event.target.value as Task["status"])}>{TASK_STATUSES.map((option) => <option value={option} key={option}>{STATUS_LABELS[option]}</option>)}</select></label>}
          </article>

          <section className="surface-card task-detail-section">
            <div className="card-heading"><div><h2>Comments</h2><p>Discussion on this task</p></div><span className="member-count">{taskDetail.task.comments?.length || 0}</span></div>
            {(taskDetail.task.comments || []).length ? <ol className="task-comments">{[...(taskDetail.task.comments || [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((comment) => <li className="task-comment" key={comment.id}><div className="task-comment-heading"><span className="avatar avatar-small">{initials(comment.author.name)}</span><b>{comment.author.name}</b><time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time></div><p>{comment.body}</p></li>)}</ol> : <p className="task-section-empty">No comments yet.</p>}
            {canCommentOnTask(user, taskDetail.project, taskDetail.task) && <form className="task-comment-form" onSubmit={(event) => void addTaskComment(event)}><label htmlFor="task-comment-input">Add a comment</label><textarea id="task-comment-input" value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} maxLength={2000} rows={3} placeholder="Write a comment…" required /><button className="button button-primary button-small" disabled={busy || !commentDraft.trim()}>{busy ? "Posting…" : "Post comment"}</button></form>}
          </section>

          <section className="surface-card task-detail-section task-activity-section">
            <div className="card-heading"><div><h2>Activity</h2><p>Recorded changes to this task</p></div></div>
            {activityLoading ? <div className="task-section-empty" role="status"><span className="spinner" /> Loading activity…</div> : activityError ? <div className="task-activity-error" role="alert"><p>{activityError}</p><button className="button button-secondary button-small" type="button" onClick={retryActivity}>Retry</button></div> : activity.length ? <ol className="task-activity-list">{activity.map((event) => <li className="task-activity-row" key={event.id}><span className="activity-marker" aria-hidden="true">•</span><div><p><b>{event.actor?.name || "Former user"}</b> {activitySummary(event)}</p><time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time></div></li>)}</ol> : <p className="task-section-empty">No activity has been recorded for this task yet. History begins with actions made after activity tracking was added.</p>}
          </section>
        </> : <div className="surface-card board-empty-state"><EmptyState title="Task not found" text="This task may not exist, or your account may not have access to it." /></div>}
      </>}
      {view === "Tasks" && <><SectionHeading eyebrow="KEEP WORK MOVING" title="Tasks" description="A clear view of the next steps across your projects." /><div className="task-toolbar"><div className="filter-tabs" role="group" aria-label="Filter tasks by status">{[["ALL", "All tasks"], ["TODO", "To do"], ["IN_PROGRESS", "In progress"], ["DONE", "Done"]].map(([value, label]) => <button key={value} className={statusFilter === value ? "selected" : ""} onClick={() => setStatusFilter(value)}>{label}{value === "ALL" && <span>{totalTasks}</span>}</button>)}</div><span className="task-result-count">{tasks.length} shown</span></div>{tasks.length === 0 ? <EmptyState title="Nothing on your task list" text={query || statusFilter !== "ALL" ? "Try clearing a filter or changing your search." : "When a task is assigned to you or added to your project, it will show up here."} /> : <div className="task-list">{tasks.map(({ project, ...task }) => <TaskCard key={`${task.id}-${task.version}`} task={task} project={project} user={user} busy={busy} canManageProject={canManageProject(project)} onUpdate={(current, data) => void mutate("Task updated.", () => request(`/api/tasks/${current.id}`, "PATCH", { ...data, version: current.version }))} onStatus={(current, status) => void mutate("Task status updated.", () => request(`/api/tasks/${current.id}`, "PATCH", { status, version: current.version }))} onDelete={(current) => { if (window.confirm(`Delete “${current.title}”? This cannot be undone.`)) void mutate("Task deleted.", () => request(`/api/tasks/${current.id}`, "DELETE")); }} onComment={(current, body) => mutate("Comment added.", () => request(`/api/tasks/${current.id}/comments`, "POST", { body }))} onDeleteComment={(comment) => { if (window.confirm("Delete this comment?")) void mutate("Comment deleted.", () => request(`/api/comments/${comment.id}`, "DELETE")); }} />)}</div>}</>}

      {view === "Team" && <><SectionHeading eyebrow="PEOPLE & ACCESS" title="Team" description="See who is part of each project and manage project-scoped roles." />{projects.length === 0 ? <EmptyState title="No project teams yet" text="Teams appear here when you have access to a project." /> : <div className="team-project-list">{projects.map((project) => <section className="surface-card team-project" key={project.id}><div className="team-project-heading"><span className="project-avatar">{initials(project.name)}</span><div><h2>{project.name}</h2><p>Project Manager: {project.manager.name}</p></div><span className="member-count">{project.memberships?.length || 0} members</span></div>{(project.memberships || []).length ? <div className="member-table"><div className="member-table-head"><span>MEMBER</span><span>ACCOUNT ROLE</span><span>PROJECT ROLE</span>{canManageProject(project) && <span>MANAGE</span>}</div>{project.memberships?.map((membership) => <div className="member-row" key={membership.userId}><span className="member-identity"><span className="avatar avatar-small">{initials(membership.user.name)}</span><span><b>{membership.user.name}</b><small>{membership.user.email}</small></span></span><span><span className={`role-label role-${membership.user.role.toLowerCase()}`}>{membership.user.role.replaceAll("_", " ")}</span></span>{canManageProject(project) ? <span><select aria-label={`Project role for ${membership.user.name}`} value={membership.role} disabled={busy} onChange={(event) => void mutate("Project role updated.", () => request(`/api/projects/${project.id}/members/${membership.userId}`, "PATCH", { role: event.target.value }))}><option value="MANAGER">Manager · project only</option><option value="MEMBER">Member</option><option value="VIEWER">Viewer</option></select></span> : <span><span className="project-role-pill">{membership.role}</span></span>}{canManageProject(project) && <span><button className="button button-danger-quiet button-small" disabled={busy} onClick={() => { if (window.confirm(`Remove ${membership.user.name} from ${project.name}?`)) void mutate("Member removed.", () => request(`/api/projects/${project.id}/members/${membership.userId}`, "DELETE")); }}>Remove</button></span>}</div>)}</div> : <p className="empty-members">No members have been added to this project yet.</p>}{canManageProject(project) && <form className="add-member-form" onSubmit={(event) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); void mutate("Member added to project.", () => request(`/api/projects/${project.id}/members`, "POST", { userId: form.get("userId"), role: form.get("role") })).then((saved) => { if (saved) formElement.reset(); }); }}><label>Member user ID<input name="userId" placeholder="Paste the user's account ID" required /></label><label>Project role<select name="role"><option value="MEMBER">Member</option><option value="VIEWER">Viewer</option><option value="MANAGER">Manager · project only</option></select></label><button className="button button-secondary button-small" disabled={busy}>＋ Add member</button><p>Project roles only affect this project; they do not change account permissions.</p></form>}</section>)}</div>}</>}

      {view === "Admin" && isAdmin && <><SectionHeading eyebrow="WORKSPACE SETTINGS" title="Administration" description="Manage FlowForge accounts and their organization-wide access." /><section className="surface-card admin-create-card"><div className="form-card-title"><div><h2>Create a user</h2><p>Choose the account’s global role. Project roles are managed separately.</p></div><span className="create-project-icon">＋</span></div><form className="form-grid" onSubmit={createUser}><label>Full name<input name="name" maxLength={100} placeholder="Name" required /></label><label>Email address<input name="email" type="email" placeholder="name@company.com" required /></label><label>Temporary password<input name="password" type="password" minLength={10} autoComplete="new-password" placeholder="At least 10 characters" required /></label><label>Account role<select name="role" defaultValue="TEAM_MEMBER"><option value="ADMIN">Admin</option><option value="PROJECT_MANAGER">Project Manager</option><option value="TEAM_MEMBER">Team Member</option><option value="VIEWER">Viewer</option></select></label><div className="form-submit"><button className="button button-primary" disabled={busy}>{busy ? "Creating…" : "Create account"}</button></div></form></section><section className="surface-card user-management-card"><div className="card-heading"><div><h2>User accounts</h2><p>{users.length} accounts · inactive users cannot sign in</p></div></div>{users.length === 0 ? <EmptyState title="No accounts found" text="User accounts will appear here." /> : <div className="user-list">{users.map((account) => <details className="user-row" key={account.id}><summary><span className="member-identity"><span className="avatar avatar-small">{initials(account.name)}</span><span><b>{account.name}</b><small>{account.email}</small><small className="account-id-inline">Account ID: <code>{account.id}</code></small></span></span><span className={`role-label role-${account.role.toLowerCase()}`}>{account.role.replaceAll("_", " ")}</span><span className={`account-state ${account.active ? "active-state" : "inactive-state"}`}><i />{account.active ? "Active" : "Inactive"}</span><span className="user-row-action">Edit details <b>⌄</b></span></summary><div className="user-edit-panel"><form className="user-edit-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void mutate("User account updated.", () => request(`/api/users/${account.id}`, "PATCH", { name: form.get("name"), email: form.get("email"), role: form.get("role"), password: form.get("password") || undefined })); }}><label>Name<input name="name" defaultValue={account.name} maxLength={100} required /></label><label>Email<input name="email" type="email" defaultValue={account.email} required /></label><label>Global role<select name="role" defaultValue={account.role}><option value="ADMIN">Admin</option><option value="PROJECT_MANAGER">Project Manager</option><option value="TEAM_MEMBER">Team Member</option><option value="VIEWER">Viewer</option></select></label><label>Reset password <span className="field-hint">optional, 10+ characters</span><input name="password" type="password" minLength={10} autoComplete="new-password" placeholder="Leave blank to keep current" /></label><div className="user-form-actions"><button className="button button-secondary button-small" disabled={busy}>Save changes</button>{account.active && account.id !== user.id && <button className="button button-danger-quiet button-small" type="button" disabled={busy} onClick={() => { if (window.confirm(`Deactivate ${account.name}? They will no longer be able to sign in.`)) void mutate("User deactivated.", () => request(`/api/users/${account.id}/deactivate`, "PATCH", {})); }}>Deactivate account</button>}</div></form><p className="account-id">Account ID <code>{account.id}</code></p></div></details>)}</div>}</section></>}
      {view === "Admin" && !isAdmin && <EmptyState title="Admin access required" text="Only administrators can manage user accounts." />}
      <footer className="page-footer"><span>FlowForge workspace</span><span>Changes save automatically when you submit a form.</span></footer>
    </div></section>
  </main>;
}
