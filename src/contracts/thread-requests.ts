/** The guards a thread tool request has to pass on its way from the agent process to the window. */
import { isBlankable, isBrowserRead, isCount, isExternalCommand, isString, isTerminalRead, MAX_THREAD_WAIT_MS } from "./ipc.js";
import type { FindingReport, ThreadRequest } from "./threads.js";
import { isCoordinationState, isDecisionRequest, MAX_SUMMARY } from "../domain/coordination.js";
import { MAX_DETAIL, MAX_FINDING_KEY, MAX_HEADLINE } from "../domain/finding.js";

export function isThreadRequest(value: unknown): value is ThreadRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (request.type !== "thread.request" || !isString(request.requestId) || !isString(request.taskId)) return false;
  if (request.computer !== undefined && !isString(request.computer)) return false;
  if (request.op === "list") {
    return (request.project === undefined || isString(request.project, 4_096))
      && (request.archived === undefined || typeof request.archived === "boolean")
      && (request.idleForMs === undefined || isCount(request.idleForMs))
      && (request.search === undefined || isString(request.search, 1_000))
      && (request.attachments === undefined || typeof request.attachments === "boolean")
      && (request.limit === undefined || isCount(request.limit));
  }
  if (request.op === "read") return isString(request.threadId) && (request.limit === undefined || isCount(request.limit));
  if (request.op === "wait") return isString(request.threadId) && isCount(request.timeoutMs) && request.timeoutMs <= MAX_THREAD_WAIT_MS;
  if (request.op === "command") return isExternalCommand(request.command);
  if (request.op === "browser") return isBrowserRead(request.read);
  if (request.op === "terminal") return isTerminalRead(request.read);
  if (request.op === "notify") return isFindingReport(request.report);
  if (request.op === "nothing-to-report") return isString(request.checked, MAX_HEADLINE);
  if (request.op === "report") return isCoordinationState(request.state) && isString(request.summary, MAX_SUMMARY);
  if (request.op === "decision") return isDecisionRequest(request.request);
  return false;
}

export function isFindingReport(value: unknown): value is FindingReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return isString(report.headline, MAX_HEADLINE)
    /** An optional the caller sent empty says the same as one it left out, and is no reason to drop the call. */
    && (report.detail === undefined || isBlankable(report.detail, MAX_DETAIL))
    && (report.key === undefined || isBlankable(report.key, MAX_FINDING_KEY));
}
