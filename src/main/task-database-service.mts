import { Worker } from "node:worker_threads";
import type { TaskStoreDelta } from "../contracts/task-store.js";
import type { Automation } from "../domain/automation.js";
import type { TaskDatabaseOperations, TaskDatabaseResponse } from "./task-database-protocol.mjs";

/** SQLite and JSON decoding live on one ordered worker, outside Electron's event loop. */
export class TaskDatabaseService {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;

  private constructor(file: string, options: { worktreesRoots?: string[]; workerURL?: URL }) {
    this.worker = new Worker(options.workerURL ?? new URL("./task-database-worker.mjs", import.meta.url), { workerData: { file, worktreesRoots: options.worktreesRoots } });
    this.worker.on("message", (response: TaskDatabaseResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    });
    this.worker.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    this.worker.on("exit", (code) => {
      if (!this.closing || code !== 0 || this.pending.size) this.fail(new Error(`Task database worker exited (${code}).`));
    });
  }

  static async open(file: string, options: { worktreesRoots?: string[]; workerURL?: URL } = {}) {
    const service = new TaskDatabaseService(file, options);
    try {
      await service.request("ready", undefined);
      return service;
    } catch (error) {
      await service.worker.terminate();
      throw error;
    }
  }

  load() { return this.request("load", {}); }
  loadSummaries() { return this.request("load", { summariesOnly: true }); }
  loadThreadMessages(taskId: string) { return this.request("messages", { taskId }); }
  subagentActivity(taskId: string, subagentId: string) { return this.request("activity", { taskId, subagentId }); }
  persist(delta: TaskStoreDelta) { return this.request("persist", delta); }
  listAutomations() { return this.request("automations", undefined); }
  saveAutomation(automation: Automation) { return this.request("saveAutomation", automation); }
  deleteAutomation(id: string) { return this.request("deleteAutomation", { id }); }
  flush() { return this.request("flush", undefined); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.request("close", undefined).then(
      async () => { await this.worker.terminate(); },
      (error: unknown) => {
        this.closing = null;
        throw error;
      },
    );
    return this.closing;
  }

  private request<Operation extends keyof TaskDatabaseOperations>(operation: Operation, input: TaskDatabaseOperations[Operation]["input"]): Promise<TaskDatabaseOperations[Operation]["result"]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new Error("Task database is closing."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as TaskDatabaseOperations[Operation]["result"]), reject });
      try {
        this.worker.postMessage({ id, operation, input });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private fail(error: Error) {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
