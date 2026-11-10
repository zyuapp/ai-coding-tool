/**
 * What a paired phone's command must satisfy: each feature declares one rule per command a phone may
 * send, from the checks here. A rule reads the command as sent, so it checks every field it lets through.
 */
export type PhoneRule = (command: Readonly<Record<string, unknown>>) => boolean;

const MAX_ID_LENGTH = 256;
export const MAX_PROMPT_LENGTH = 1_000_000;
export const MAX_PATH_LENGTH = 4_096;

export function isString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isBlankable(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A thread named by id, or none for the thread on screen. */
export const named: PhoneRule = (command) => command.taskId === undefined || isString(command.taskId);

export const namesThread: PhoneRule = (command) => isString(command.taskId);
