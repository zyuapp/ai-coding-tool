import { isThreadRole } from "../domain/thread-role.js";
import type { ThreadSummary, ThreadTranscript } from "./threads.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** A paired host is independently updated, so its tool results are checked before formatting. */
export function isThreadSummary(value: unknown): value is ThreadSummary {
  if (!record(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 && typeof value.title === "string"
    && ["idle", "running", "stopped"].includes(value.status as string)
    && typeof value.archived === "boolean"
    && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    && typeof value.lastActivityAt === "number" && Number.isFinite(value.lastActivityAt)
    && count(value.messageCount) && count(value.attachmentCount)
    && (value.role === undefined || isThreadRole(value.role))
    && ["projectId", "projectRoot", "worktreeId", "worktreeRoot"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

export function isThreadTranscript(value: unknown): value is ThreadTranscript {
  return record(value) && isThreadSummary(value.thread) && count(value.omitted)
    && Array.isArray(value.messages) && value.messages.length <= 200
    && value.messages.every((message: unknown) => record(message)
      && ["user", "assistant", "tool", "system"].includes(message.kind as string)
      && typeof message.text === "string" && message.text.length <= 2_001
      && typeof message.at === "number" && Number.isFinite(message.at));
}
