import { isResourceStop, type ResourceStop } from "../domain/session-resources.js";

/** Only the agent worker and its supervisor exchange OS process identities. */
export type SessionProcessEvent = { type: "session.process"; taskId: string; sessionId: string; pid: number };
export type SessionReleaseEvent = { type: "session.released"; taskId: string; sessionId: string };
export type SessionResourceMessage = SessionProcessEvent | SessionReleaseEvent | { type: "session.state"; taskId: string; sessionId: string; busy: boolean };
export type TerminateSessionCommand = { type: "terminate-session"; taskId: string; sessionId: string; idleOnly?: true };
export type ResourceStoppedEvent = { type: "resource.stopped"; taskId: string; stop: ResourceStop };

function named(value: unknown): value is Record<string, unknown> & { taskId: string } {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).taskId === "string"
    && ((value as Record<string, unknown>).taskId as string).length > 0 && ((value as Record<string, unknown>).taskId as string).length <= 256;
}
export function isSessionResourceMessage(value: unknown): value is SessionResourceMessage {
  if (!named(value) || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 256) return false;
  return value.type === "session.state" && typeof value.busy === "boolean" || value.type === "session.released" || value.type === "session.process" && Number.isSafeInteger(value.pid) && (value.pid as number) > 1;
}
export function isTerminateSessionCommand(value: unknown): value is TerminateSessionCommand {
  return named(value) && (value.idleOnly === undefined || value.idleOnly === true) && value.type === "terminate-session" && typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 256;
}
export function isResourceStoppedEvent(value: unknown): value is ResourceStoppedEvent {
  return named(value) && value.type === "resource.stopped" && isResourceStop(value.stop);
}
