export type Project = {
  id: string;
  root: string;
  /** What the user chose to call the folder. Without one it goes by the folder's own name. */
  name?: string;
  workspaceId?: string;
  /** Sidebar position. Only the user moves it. */
  sortIndex?: number;
};

/**
 * Where a dragged thread lands: a slot in a project's list, or in the project-less "recents" list.
 * `index` counts rows in that one list, so each list is its own.
 */
export type ThreadDropTarget = {
  projectId: string | null;
  index: number;
};

/** How a folder names itself: its last path segment. */
export function folderName(root: string) {
  let end = root.length;
  while (end > 0 && root[end - 1] === "/") end -= 1;
  return end === 0 ? root : root.slice(root.lastIndexOf("/", end - 1) + 1, end);
}

/** What a project is called everywhere in the UI: the name the user gave it, else its folder's. */
export function projectName(project: Pick<Project, "name" | "root">) {
  return project.name ?? folderName(project.root);
}

export function legacyProjectId(root: string) {
  return `legacy-project-${encodeURIComponent(normalizeProjectRoot(root))}`;
}

/**
 * A project as something outside the app may name it: its folder name, its path, or its id.
 * An id is never asked for, so a reference that matches nothing answers with what is open.
 */
export function findProject(projects: Project[], reference: string): { project: Project } | { error: string } {
  const wanted = reference.trim();
  const exact = projects.find((project) => project.id === wanted || sameRoot(project.root, wanted));
  if (exact) return { project: exact };
  /** Either name finds it: the one the user gave it, and the folder's own, which outside callers still know. */
  const named = projects.filter((project) => [projectName(project), folderName(project.root)].some((label) => label.toLowerCase() === wanted.toLowerCase()));
  if (named.length === 1) return { project: named[0] };
  const open = projects.map((project) => `${projectName(project)} (${project.root})`).join(", ") || "none";
  if (named.length > 1) return { error: `More than one open project is named "${reference}": ${named.map((project) => project.root).join(", ")}. Name the folder path instead.` };
  return { error: `No project matches "${reference}". Open projects: ${open}.` };
}

export function isProject(value: unknown): value is Project {
  return isRecord(value) && nonEmptyString(value.id) && nonEmptyString(value.root) && (value.name === undefined || nonEmptyString(value.name)) && (value.workspaceId === undefined || nonEmptyString(value.workspaceId)) && (value.sortIndex === undefined || finiteNumber(value.sortIndex));
}

/** Whether two paths name the same folder, whatever trailing separators they were written with. */
export function sameRoot(left: string, right: string) {
  return normalizeProjectRoot(left) === normalizeProjectRoot(right);
}

export function normalizeProjectRoot(root: string) {
  const normalized = root.replace(/[\\/]+$/, "");
  return normalized || root;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
