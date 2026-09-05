import { parentPort, workerData } from "node:worker_threads";
import { TaskDatabase } from "./task-database.mjs";
import type { TaskDatabaseRequest, TaskDatabaseResponse } from "./task-database-protocol.mjs";

if (!parentPort) throw new Error("Task database must run inside its worker.");
const port = parentPort;
const { file, worktreesRoots } = workerData as { file: string; worktreesRoots?: string[] };
const database = new TaskDatabase(file, { worktreesRoots });

port.on("message", (request: TaskDatabaseRequest) => {
  let response: TaskDatabaseResponse;
  try {
    response = { id: request.id, ok: true, result: execute(request) };
  } catch (error) {
    response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(response);
  if (request.operation === "close" && response.ok) port.close();
});

/** The port delivers operations in order; a flush or close follows every write sent before it. */
function execute(request: TaskDatabaseRequest): unknown {
  switch (request.operation) {
    case "ready":
    case "flush": return;
    case "load": return database.load(request.input);
    case "messages": return database.loadThreadMessages(request.input.taskId);
    case "activity": return database.subagentActivity(request.input.taskId, request.input.subagentId);
    case "persist": return database.persist(request.input);
    case "automations": return database.listAutomations();
    case "saveAutomation": return database.saveAutomation(request.input);
    case "deleteAutomation": return database.deleteAutomation(request.input.id);
    case "close": return database.close();
  }
}
