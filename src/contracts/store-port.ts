import type { ConversationMessage } from "../domain/conversation.js";
import type { SubagentActivity } from "../domain/run.js";
import type { LoadedTaskStore, TaskStoreDelta } from "./task-store.js";

/** Where threads are kept between launches. */
export type StorePort = {
  runtime: {
    loadTaskStore(): Promise<LoadedTaskStore | null>;
    loadThreadMessages(taskId: string): Promise<ConversationMessage[]>;
    /** Which of these threads have a stored message containing `search`, read without loading their histories. */
    searchThreadMessages(search: string, taskIds: string[]): Promise<string[]>;
    persistTaskStore(delta: TaskStoreDelta): Promise<void>;
    /** A stored subagent's activity, which the store leaves behind until someone opens that subagent. */
    loadSubagentActivity(taskId: string, subagentId: string): Promise<SubagentActivity[]>;
  };
};
