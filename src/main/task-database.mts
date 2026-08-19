import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { TaskStoreDelta } from "../contracts/ipc.js";
import { isAutomation, type Automation } from "../domain/automation.js";
import { parseTaskStore, serializeTaskStore, type Project, type Task, type TaskMessage, type TaskStoreData } from "../domain/task.js";

/** Automations are read while the app boots, so one unreadable row must not take the window with it. */
function parseAutomationRow(data: string): Automation | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isAutomation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A project folder can never be a checkout the app made for a thread. */
export function projectRootsAreOwn(projects: Array<{ root: string }>, worktreesRoot: string | undefined) {
  if (!worktreesRoot) return true;
  const owned = `${path.resolve(worktreesRoot)}${path.sep}`;
  return !projects.some((project) => path.resolve(project.root).startsWith(owned));
}

export class TaskDatabase {
  private readonly database: DatabaseSync;
  private readonly worktreesRoot: string | undefined;
  private closed = false;

  constructor(file: string, options: { worktreesRoot?: string } = {}) {
    this.worktreesRoot = options.worktreesRoot;
    this.database = new DatabaseSync(file);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (task_id, id)
      );
      CREATE INDEX IF NOT EXISTS messages_task_position ON messages(task_id, position);
      CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    `);
  }

  listAutomations(): Automation[] {
    const rows = this.database.prepare("SELECT data FROM automations ORDER BY task_id").all() as Array<{ data: string }>;
    return rows.flatMap(({ data }) => {
      const automation = parseAutomationRow(data);
      return automation ? [automation] : [];
    });
  }

  saveAutomation(automation: Automation) {
    this.database
      .prepare("INSERT INTO automations (id, task_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, data = excluded.data")
      .run(automation.id, automation.taskId, JSON.stringify(automation));
  }

  deleteAutomation(id: string) {
    this.database.prepare("DELETE FROM automations WHERE id = ?").run(id);
  }

  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  load(): TaskStoreData | null {
    const taskRows = this.database.prepare("SELECT data FROM tasks").all() as Array<{ data: string }>;
    const projectRows = this.database.prepare("SELECT data FROM projects ORDER BY position").all() as Array<{ data: string }>;
    const lastFolderRow = this.database.prepare("SELECT value FROM settings WHERE key = 'lastFolder'").get() as { value: string } | undefined;
    if (!taskRows.length && !projectRows.length && !lastFolderRow) return null;

    const messages = new Map<string, TaskMessage[]>();
    for (const row of this.database.prepare("SELECT task_id, data FROM messages ORDER BY task_id, position").all() as Array<{ task_id: string; data: string }>) {
      const values = messages.get(row.task_id) ?? [];
      values.push(JSON.parse(row.data) as TaskMessage);
      messages.set(row.task_id, values);
    }
    const tasks = taskRows
      .map(({ data }) => JSON.parse(data) as Omit<Task, "messages">)
      .map((task) => ({ ...task, messages: messages.get(task.id) ?? [] }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const data: TaskStoreData = {
      version: 2,
      tasks,
      projects: projectRows.map(({ data }) => JSON.parse(data) as Project),
      lastFolder: lastFolderRow ? JSON.parse(lastFolderRow.value) as string | null : null,
    };
    const validated = parseTaskStore(serializeTaskStore(data));
    if (!validated.ok) throw new Error(validated.errors.join(" "));
    return validated.data;
  }

  /** Every task's checkout of its own, so a reconcile can tell a live worktree from an abandoned one. */
  claimedWorktrees(): string[] {
    const rows = this.database.prepare("SELECT data FROM tasks").all() as Array<{ data: string }>;
    return rows.flatMap(({ data }) => {
      const root = (JSON.parse(data) as { worktree?: { root?: string } }).worktree?.root;
      return typeof root === "string" && root ? [root] : [];
    });
  }

  /** Takes a checkout away from every task that claimed one of `roots`, which no longer exist. */
  forgetWorktrees(roots: string[]): number {
    if (!roots.length) return 0;
    const gone = new Set(roots.map((root) => path.resolve(root)));
    const rows = this.database.prepare("SELECT id, data FROM tasks").all() as Array<{ id: string; data: string }>;
    const save = this.database.prepare("UPDATE tasks SET data = ? WHERE id = ?");
    let changed = 0;
    for (const row of rows) {
      const task = JSON.parse(row.data) as { worktree?: { root?: string } };
      if (!task.worktree?.root || !gone.has(path.resolve(task.worktree.root))) continue;
      const { worktree: _released, ...rest } = task;
      save.run(JSON.stringify(rest), row.id);
      changed += 1;
    }
    return changed;
  }

  persist(delta: TaskStoreDelta) {
    /**
     * A project row and the last folder are where the user's own directories are recorded, so a
     * delta that would move either into the app's worktrees is dropped instead of written. The rest
     * of the delta still lands: losing transcripts is a worse answer than keeping the folder on disk.
     */
    const writesProjects = !delta.projects || projectRootsAreOwn(delta.projects, this.worktreesRoot);
    const writesLastFolder = delta.lastFolder === undefined
      || projectRootsAreOwn(delta.lastFolder ? [{ root: delta.lastFolder }] : [], this.worktreesRoot);
    if (!writesProjects || !writesLastFolder) {
      console.error("Refused to record a folder inside the app's worktrees directory.", { projects: delta.projects, lastFolder: delta.lastFolder });
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (delta.projects && writesProjects) {
        this.database.exec("DELETE FROM projects");
        const insertProject = this.database.prepare("INSERT INTO projects (id, position, data) VALUES (?, ?, ?)");
        delta.projects.forEach((project, index) => insertProject.run(project.id, index, JSON.stringify(project)));
      }
      if (delta.lastFolder !== undefined && writesLastFolder) {
        this.database.prepare("INSERT INTO settings (key, value) VALUES ('lastFolder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(delta.lastFolder));
      }
      if (delta.removedTasks?.length) {
        const dropTask = this.database.prepare("DELETE FROM tasks WHERE id = ?");
        const dropMessages = this.database.prepare("DELETE FROM messages WHERE task_id = ?");
        for (const id of delta.removedTasks) {
          dropMessages.run(id);
          dropTask.run(id);
        }
      }
      const saveTask = this.database.prepare("INSERT INTO tasks (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data");
      const saveMessage = this.database.prepare("INSERT INTO messages (task_id, id, position, data) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, id) DO UPDATE SET position = excluded.position, data = excluded.data");
      for (const change of delta.tasks) {
        saveTask.run(change.task.id, JSON.stringify(change.task));
        for (const { index, message } of change.messages) saveMessage.run(change.task.id, message.id, index, JSON.stringify(message));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
