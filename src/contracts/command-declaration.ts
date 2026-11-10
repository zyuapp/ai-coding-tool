/**
 * How a feature declares its commands: the fields each carries, where it is carried out, and whether an
 * agent or a paired phone may send it. Each feature's table is checked against its own command union.
 */
import { isString } from "./ipc.js";
import type { PhoneRule } from "./phone-commands.js";

export type Validator<T> = (value: unknown) => value is T;
export type Shape<T> = { [K in keyof T]-?: Validator<T[K]> };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const text: Validator<string> = (value): value is string => typeof value === "string" && value.length <= 16_000_000;
export const pathText: Validator<string> = (value): value is string => typeof value === "string" && value.length <= 4096 && !value.includes("\0");
export const deviceId: Validator<string> = (value): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
export const boolean: Validator<boolean> = (value): value is boolean => typeof value === "boolean";
export const number: Validator<number> = (value): value is number => typeof value === "number" && Number.isFinite(value);

export function optional<T>(check: Validator<T>): Validator<T | undefined> {
  return (value): value is T | undefined => value === undefined || check(value);
}

export function nullable<T>(check: Validator<T>): Validator<T | null> {
  return (value): value is T | null => value === null || check(value);
}

export function array<T>(check: Validator<T>): Validator<T[]> {
  return (value): value is T[] => {
    if (!Array.isArray(value) || value.length > 10_000) return false;
    for (const item of value) if (!check(item)) return false;
    return true;
  };
}

export function literals<const T extends readonly (string | number | boolean)[]>(...choices: T): Validator<T[number]> {
  return (value): value is T[number] => choices.some((choice) => choice === value);
}

export function hasFields(value: Record<string, unknown>, fields: Readonly<Record<string, Validator<unknown>>>): boolean {
  for (const [key, check] of Object.entries<Validator<unknown>>(fields)) {
    if (!check(value[key])) return false;
  }
  return true;
}

export function object<T>(fields: Shape<T>): Validator<T> {
  return (value): value is T => record(value) && hasFields(value, fields);
}

export const optionalText = optional(text);
export const optionalBoolean = optional(boolean);
export const nullableText = nullable(text);
export const step = literals(-1, 1);

/** Agents name what they act on by a non-empty id. */
export function agentId(value: string | undefined): boolean {
  return value === undefined || isString(value);
}

export function agentThread(command: { taskId?: string }): boolean {
  return agentId(command.taskId);
}

/** An agent acts on the thread it names, never on whichever one is on screen. */
export function namesThread(command: { taskId?: string }): boolean {
  return isString(command.taskId);
}

/**
 * Where a command is carried out once another computer is paired. `local` stays with this window
 * and computer whatever is on screen. `thread` goes to the computer holding the thread it names,
 * else to the one showing the thread on screen; `panel` goes the same way, but only this computer's
 * own panels can carry it out. `project` and `terminal` go to the computer holding the project or
 * shell they name. `select` puts the computer holding the thread it names on screen. `own` follows
 * a rule of its own.
 */
export type CommandPlacement = "local" | "thread" | "panel" | "project" | "terminal" | "select" | "own";

/** Only a command that names a project, a shell or a thread can be placed by it. */
type PlacementOf<C> = "local" | "thread" | "panel" | "own"
  | (C extends { projectId: string } ? "project" : never)
  | (C extends { terminalId: string } ? "terminal" : never)
  | (C extends { taskId: string } ? "select" : never);

type Declaration<C extends { type: string }> = {
  fields: Shape<Omit<C, "type">>;
  at: PlacementOf<C>;
  /** Moves this window to one of its own threads, which takes a paired computer's thread off screen. */
  leaves?: true;
  /** What an agent's command must also satisfy. A command without one is the window's alone. */
  agent?: (command: C) => boolean;
  /** What a paired phone's command must satisfy. A command without one is never a phone's. */
  phone?: PhoneRule;
};

/** One declaration for every command of a union, and none for a command outside it. */
export type Declarations<U extends { type: string }> = { [Type in U["type"]]: Declaration<Extract<U, { type: Type }>> };
