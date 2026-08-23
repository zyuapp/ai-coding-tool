import { DatabaseSync, type StatementSync } from "node:sqlite";
import path from "node:path";
import type { TaskStoreDelta } from "../contracts/ipc.js";
import { isAutomation, type Automation } from "../domain/automation.js";
import type { Subagent, SubagentActivity } from "../domain/run.js";
import { isProject, validateTaskStoreData, type Project, type Task, type TaskMessage, type TaskStoreData } from "../domain/task.js";
import { isWorktree, type Worktree } from "../domain/worktree.js";

/** Automations are read while the app boots, so one unreadable row must not take the window with it. */
function parseAutomationRow(data: string): Automation | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isAutomation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A project folder can never be a checkout the app made for a thread, under any root it has used. */
export function projectRootsAreOwn(projects: Array<{ root: string }>, worktreesRoots: string[]) {
  const owned = worktreesRoots.map((root) => `${path.resolve(root)}${path.sep}`);
  return !projects.some((project) => owned.some((root) => path.resolve(project.root).startsWith(root)));
}

export class TaskDatabase {
  private readonly database: DatabaseSync;
  private readonly worktreesRoots: string[];
  private readonly saveTask: StatementSync;
  private readonly saveMessage: StatementSync;
  private readonly saveSubagent: StatementSync;
  private readonly saveActivity: StatementSync;
  private closed = false;

  constructor(file: string, options: { worktreesRoots?: string[] } = {}) {
    this.worktreesRoots = options.worktreesRoots ?? [];
    this.database = new DatabaseSync(file);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worktrees (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (task_id, id)
      );
      CREATE INDEX IF NOT EXISTS messages_task_position ON messages(task_id, position);
      CREATE TABLE IF NOT EXISTS subagents (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (task_id, id)
      );
      CREATE INDEX IF NOT EXISTS subagents_task_position ON subagents(task_id, position);
      CREATE TABLE IF NOT EXISTS subagent_activity (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        subagent_id TEXT NOT NULL,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (task_id, subagent_id, id)
      );
      CREATE INDEX IF NOT EXISTS subagent_activity_position ON subagent_activity(task_id, subagent_id, position);
      CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    `);
    this.saveTask = this.database.prepare("INSERT INTO tasks (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data");
    this.saveMessage = this.database.prepare("INSERT INTO messages (task_id, id, position, data) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, id) DO UPDATE SET position = excluded.position, data = excluded.data");
    this.saveSubagent = this.database.prepare("INSERT INTO subagents (task_id, id, position, data) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, id) DO UPDATE SET position = excluded.position, data = excluded.data");
    this.saveActivity = this.database.prepare("INSERT INTO subagent_activity (task_id, subagent_id, id, position, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, subagent_id, id) DO UPDATE SET position = excluded.position, data = excluded.data");
    this.liftEmbeddedSubagents();
    this.liftEmbeddedWorktrees();
  }

  /**
   * Tasks written while a checkout belonged to exactly one thread carry it inside themselves. Giving
   * each checkout a row of its own is what lets a second thread claim it; the fork the thread had
   * already made stays with the thread. A checkout on a thread with no project has nowhere to be
   * listed, so its claim goes and the next reconcile reaps the directory.
   */
  private liftEmbeddedWorktrees() {
    const stale: Array<{ id: string; task: Record<string, unknown> }> = [];
    for (const row of this.database.prepare("SELECT id, data FROM tasks").iterate() as Iterable<{ id: string; data: string }>) {
      const task = JSON.parse(row.data) as Record<string, unknown>;
      if (task.worktree) stale.push({ id: row.id, task });
    }
    if (!stale.length) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const save = this.database.prepare("UPDATE tasks SET data = ? WHERE id = ?");
      const saveWorktree = this.database.prepare("INSERT INTO worktrees (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data");
      for (const { id, task } of stale) {
        const { worktree, ...rest } = task as { worktree: Record<string, unknown> } & Record<string, unknown>;
        const { enteredAt, ...record } = worktree;
        const lifted = { ...record, projectId: rest.projectId };
        if (!isWorktree(lifted)) {
          save.run(JSON.stringify(rest), id);
          continue;
        }
        saveWorktree.run(lifted.id, JSON.stringify(lifted));
        save.run(JSON.stringify({ ...rest, worktreeId: lifted.id, ...(typeof enteredAt === "number" ? { worktreeEnteredAt: enteredAt } : {}) }), id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Tasks written before subagents had rows of their own still carry them inside the task record. */
  private liftEmbeddedSubagents() {
    const stale: Array<{ id: string; task: { subagents?: Subagent[] } }> = [];
    for (const row of this.database.prepare("SELECT id, data FROM tasks").iterate() as Iterable<{ id: string; data: string }>) {
      const task = JSON.parse(row.data) as { subagents?: Subagent[] };
      if (task.subagents) stale.push({ id: row.id, task });
    }
    if (!stale.length) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const save = this.database.prepare("UPDATE tasks SET data = ? WHERE id = ?");
      for (const { id, task } of stale) {
        const { subagents = [], ...rest } = task;
        subagents.forEach((subagent, index) => this.writeSubagent(id, index, subagent));
        save.run(JSON.stringify(rest), id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeSubagent(taskId: string, index: number, subagent: Subagent) {
    const { activity = [], ...record } = subagent;
    this.saveSubagent.run(taskId, subagent.id, index, JSON.stringify(record));
    activity.forEach((item, position) => this.saveActivity.run(taskId, subagent.id, item.id, position, JSON.stringify(item)));
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

  /** Project roots for worktree reconciliation, without reading and parsing every transcript first. */
  projectRoots(): string[] {
    const rows = this.database.prepare("SELECT data FROM projects ORDER BY position").all() as Array<{ data: string }>;
    return rows.map(({ data }) => {
      const project = JSON.parse(data) as unknown;
      if (!isProject(project)) throw new Error("v2 projects contains an invalid value");
      return project.root;
    });
  }

  load(): TaskStoreData | null {
    const taskRecords = Array.from(
      this.database.prepare("SELECT data FROM tasks").iterate() as Iterable<{ data: string }>,
      ({ data }) => JSON.parse(data) as Omit<Task, "messages" | "subagents">,
    );
    const projects = Array.from(
      this.database.prepare("SELECT data FROM projects ORDER BY position").iterate() as Iterable<{ data: string }>,
      ({ data }) => JSON.parse(data) as Project,
    );
    const lastFolderRow = this.database.prepare("SELECT value FROM settings WHERE key = 'lastFolder'").get() as { value: string } | undefined;
    if (!taskRecords.length && !projects.length && !lastFolderRow) return null;

    const messages = new Map<string, TaskMessage[]>();
    for (const row of this.database.prepare("SELECT task_id, data FROM messages ORDER BY task_id, position").iterate() as Iterable<{ task_id: string; data: string }>) {
      const values = messages.get(row.task_id) ?? [];
      values.push(JSON.parse(row.data) as TaskMessage);
      messages.set(row.task_id, values);
    }
    const subagents = new Map<string, Subagent[]>();
    for (const row of this.database.prepare("SELECT task_id, id, data FROM subagents ORDER BY task_id, position").iterate() as Iterable<{ task_id: string; data: string }>) {
      const values = subagents.get(row.task_id) ?? [];
      values.push({ ...JSON.parse(row.data) as Omit<Subagent, "activity">, activity: [] });
      subagents.set(row.task_id, values);
    }
    const tasks = taskRecords
      .map((task) => ({
        ...task,
        messages: messages.get(task.id) ?? [],
        ...(subagents.has(task.id) ? { subagents: subagents.get(task.id) } : {}),
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const worktrees = Array.from(
      this.database.prepare("SELECT data FROM worktrees").iterate() as Iterable<{ data: string }>,
      ({ data }) => JSON.parse(data) as Worktree,
    );
    const data: TaskStoreData = {
      version: 2,
      tasks,
      projects,
      worktrees,
      lastFolder: lastFolderRow ? JSON.parse(lastFolderRow.value) as string | null : null,
    };
    const validated = validateTaskStoreData(data);
    if (!validated.ok) throw new Error(validated.errors.join(" "));
    return validated.data;
  }

  /** A subagent's activity, read only when someone opens it: a session's logs never all fit in the window. */
  subagentActivity(taskId: string, subagentId: string): SubagentActivity[] {
    return Array.from(
      this.database.prepare("SELECT data FROM subagent_activity WHERE task_id = ? AND subagent_id = ? ORDER BY position").iterate(taskId, subagentId) as Iterable<{ data: string }>,
      ({ data }) => JSON.parse(data) as SubagentActivity,
    );
  }

  /**
   * The checkouts live threads still claim, so a reconcile can tell one in use from an abandoned one.
   * Any one thread keeps a checkout, which is what lets several share it; an archived thread keeps
   * nothing, so a checkout only archived threads claim is reaped like any other nobody is in.
   */
  claimedWorktrees(): string[] {
    const claimed = new Set(
      (this.database.prepare("SELECT data FROM tasks").all() as Array<{ data: string }>)
        .flatMap(({ data }) => {
          const task = JSON.parse(data) as { worktreeId?: string; archivedAt?: number };
          return typeof task.worktreeId === "string" && task.worktreeId && task.archivedAt === undefined ? [task.worktreeId] : [];
        }),
    );
    return this.worktreeRecords().flatMap(({ id, root }) => claimed.has(id) && root ? [root] : []);
  }

  /** Every checkout the app has a record of, claimed or not, so a reconcile can see what is gone. */
  worktreeRoots(): string[] {
    return this.worktreeRecords().flatMap(({ root }) => root ? [root] : []);
  }

  private worktreeRecords(): Array<{ id: string; root: string | undefined }> {
    return (this.database.prepare("SELECT id, data FROM worktrees").all() as Array<{ id: string; data: string }>)
      .map(({ id, data }) => {
        const root = (JSON.parse(data) as { root?: string }).root;
        return { id, root: typeof root === "string" && root ? root : undefined };
      });
  }

  /**
   * Drops the checkouts at `roots`, which no longer exist, and every claim on them, so neither a
   * thread nor a record is left pointing at a directory that is gone. Counts the threads freed.
   */
  forgetWorktrees(roots: string[]): number {
    if (!roots.length) return 0;
    const gone = new Set(roots.map((root) => path.resolve(root)));
    const doomed = new Set(
      (this.database.prepare("SELECT id, data FROM worktrees").all() as Array<{ id: string; data: string }>)
        .flatMap(({ id, data }) => {
          const root = (JSON.parse(data) as { root?: string }).root;
          return typeof root === "string" && root && gone.has(path.resolve(root)) ? [id] : [];
        }),
    );
    if (!doomed.size) return 0;
    const rows = this.database.prepare("SELECT id, data FROM tasks").all() as Array<{ id: string; data: string }>;
    const save = this.database.prepare("UPDATE tasks SET data = ? WHERE id = ?");
    const dropWorktree = this.database.prepare("DELETE FROM worktrees WHERE id = ?");
    let changed = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const task = JSON.parse(row.data) as { worktreeId?: string };
        if (!task.worktreeId || !doomed.has(task.worktreeId)) continue;
        const { worktreeId: _released, worktreeEnteredAt: _forked, ...rest } = task as Record<string, unknown>;
        save.run(JSON.stringify(rest), row.id);
        changed += 1;
      }
      for (const id of doomed) dropWorktree.run(id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return changed;
  }

  persist(delta: TaskStoreDelta) {
    /**
     * A project row and the last folder are where the user's own directories are recorded, so a
     * delta that would move either into the app's worktrees is dropped instead of written. The rest
     * of the delta still lands: losing transcripts is a worse answer than keeping the folder on disk.
     */
    const writesProjects = !delta.projects || projectRootsAreOwn(delta.projects, this.worktreesRoots);
    const writesLastFolder = delta.lastFolder === undefined
      || projectRootsAreOwn(delta.lastFolder ? [{ root: delta.lastFolder }] : [], this.worktreesRoots);
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
      if (delta.worktrees) {
        this.database.exec("DELETE FROM worktrees");
        const insertWorktree = this.database.prepare("INSERT INTO worktrees (id, data) VALUES (?, ?)");
        for (const worktree of delta.worktrees) insertWorktree.run(worktree.id, JSON.stringify(worktree));
      }
      if (delta.lastFolder !== undefined && writesLastFolder) {
        this.database.prepare("INSERT INTO settings (key, value) VALUES ('lastFolder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(delta.lastFolder));
      }
      if (delta.removedTasks?.length) {
        const dropTask = this.database.prepare("DELETE FROM tasks WHERE id = ?");
        const dropMessages = this.database.prepare("DELETE FROM messages WHERE task_id = ?");
        const dropSubagents = this.database.prepare("DELETE FROM subagents WHERE task_id = ?");
        const dropActivity = this.database.prepare("DELETE FROM subagent_activity WHERE task_id = ?");
        for (const id of delta.removedTasks) {
          dropMessages.run(id);
          dropActivity.run(id);
          dropSubagents.run(id);
          dropTask.run(id);
        }
      }
      for (const change of delta.tasks) {
        this.saveTask.run(change.task.id, JSON.stringify(change.task));
        for (const { index, message } of change.messages) this.saveMessage.run(change.task.id, message.id, index, JSON.stringify(message));
        for (const { index, subagent } of change.subagents ?? []) this.saveSubagent.run(change.task.id, subagent.id, index, JSON.stringify(subagent));
        for (const { subagentId, index, item } of change.activity ?? []) this.saveActivity.run(change.task.id, subagentId, item.id, index, JSON.stringify(item));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
