/** How the window and the store talk: what a thread looks like on disk, and the writes that change it. */
import type { Project, Task, TaskMessage, TaskStoreData } from "../domain/task.js";
import type { Subagent, SubagentActivity } from "../domain/run.js";
import type { Worktree } from "../domain/worktree.js";

export type PersistedTask = Omit<Task, "messages">;
export type PersistedSubagent = Omit<Subagent, "activity">;

/** The stored workspace, plus the count of threads this build could not read and left on disk. */
export type LoadedTaskStore = TaskStoreData & { hiddenTasks: number };

export type TaskStoreDelta = {
  tasks: Array<{
    task: PersistedTask;
    messages: Array<{ index: number; message: TaskMessage }>;
    subagents?: Array<{ index: number; subagent: PersistedSubagent }>;
    activity?: Array<{ subagentId: string; index: number; item: SubagentActivity }>;
  }>;
  removedTasks?: string[];
  projects?: Project[];
  /** The whole list, as `projects` is: a checkout is only ever added or dropped, never edited alone. */
  worktrees?: Worktree[];
  lastFolder?: string | null;
};
