import { randomUUID } from "node:crypto";
import { query, type CanUseTool, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentRequest, ApprovalRequest } from "../shared.js";
import { isPathInside } from "./path-policy.mjs";

type ParentPort = {
  on(event: "message", listener: (event: { data: AgentRequest }) => void): void;
  postMessage(message: AgentEvent): void;
};

const parentPort = (process as typeof process & { parentPort: ParentPort }).parentPort;
const approvals = new Map<string, (allow: boolean) => void>();
let activeQuery: Query | null = null;
let activeAbort: AbortController | null = null;
let activeCwd = "";

function emit(event: AgentEvent) {
  parentPort.postMessage(event);
}

const canUseTool: CanUseTool = async (toolName, input, options) => {
  const editedPath = ["Write", "Edit", "NotebookEdit"].includes(toolName)
    ? String(input.file_path ?? input.notebook_path ?? "")
    : "";
  if (editedPath && !isPathInside(activeCwd, editedPath)) {
    return {
      behavior: "deny",
      message: `Threadline restricts file edits to the selected project folder (${activeCwd}). Use a path inside it.`,
      toolUseID: options.toolUseID,
    };
  }

  const approvalId = randomUUID();
  const request: ApprovalRequest = {
    approvalId,
    title: options.title ?? `${toolName} needs approval`,
    description: options.description ?? options.decisionReason ?? "Review this action before it runs.",
    toolName,
    input,
  };
  emit({ type: "approval", request });

  const allow = await new Promise<boolean>((resolve) => {
    approvals.set(approvalId, resolve);
    options.signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  approvals.delete(approvalId);
  return allow
    ? { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID }
    : { behavior: "deny", message: "The user denied this action.", toolUseID: options.toolUseID };
};

async function run(request: Extract<AgentRequest, { type: "start" }>) {
  activeQuery?.close();
  activeAbort?.abort();
  activeAbort = new AbortController();
  activeCwd = request.cwd;
  emit({ type: "status", status: "running" });

  try {
    activeQuery = query({
      prompt: request.prompt,
      options: {
        cwd: request.cwd,
        resume: request.sessionId,
        permissionMode: request.mode,
        settingSources: request.projectless ? ["user"] : ["user", "project", "local"],
        skills: "all",
        canUseTool,
        abortController: activeAbort,
      },
    });

    for await (const message of activeQuery) {
      if (message.type === "system" && message.subtype === "init") {
        emit({ type: "session", sessionId: message.session_id });
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            emit({ type: "assistant", id: message.uuid, text: block.text });
          } else if (block.type === "tool_use") {
            emit({
              type: "tool",
              id: block.id,
              toolName: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }
      } else if (message.type === "result") {
        emit({
          type: "result",
          text: message.subtype === "success" ? message.result : message.errors.join("\n"),
          isError: message.subtype !== "success" || message.is_error,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!activeAbort.signal.aborted) emit({ type: "error", message });
  } finally {
    activeQuery = null;
    activeAbort = null;
    emit({ type: "status", status: "idle" });
  }
}

parentPort.on("message", ({ data }) => {
  if (data.type === "start") void run(data);
  if (data.type === "cancel") {
    activeAbort?.abort();
    activeQuery?.close();
    emit({ type: "status", status: "stopped" });
  }
  if (data.type === "approval") approvals.get(data.approvalId)?.(data.allow);
});
