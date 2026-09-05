import type { LoadedTaskStore, TaskStoreDelta } from "../contracts/task-store.js";
import type { Automation } from "../domain/automation.js";
import type { ConversationMessage } from "../domain/conversation.js";
import type { SubagentActivity } from "../domain/run.js";

export type TaskDatabaseOperations = {
  ready: { input: undefined; result: void };
  load: { input: { summariesOnly?: boolean }; result: LoadedTaskStore | null };
  messages: { input: { taskId: string }; result: ConversationMessage[] };
  activity: { input: { taskId: string; subagentId: string }; result: SubagentActivity[] };
  persist: { input: TaskStoreDelta; result: void };
  automations: { input: undefined; result: Automation[] };
  saveAutomation: { input: Automation; result: void };
  deleteAutomation: { input: { id: string }; result: void };
  flush: { input: undefined; result: void };
  close: { input: undefined; result: void };
};

export type TaskDatabaseRequest = {
  [Operation in keyof TaskDatabaseOperations]: { id: number; operation: Operation; input: TaskDatabaseOperations[Operation]["input"] }
}[keyof TaskDatabaseOperations];

export type TaskDatabaseResponse = { id: number } & ({ ok: true; result: unknown } | { ok: false; error: string });
