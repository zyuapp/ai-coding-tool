import { MAX_ATTACHMENTS, MAX_ATTACHMENT_ENCODED_BYTES } from "../domain/conversation.js";
import { isMessageImageReference } from "../domain/message-artifacts.js";
import type { WorkspaceCommandResult, WorkspaceInput } from "../application/workspace-reducer.js";
import { isAppCommandType, isWorkspaceViewInput } from "./workspace-view-input.js";
import { isAgentEngine, type AgentEngine } from "../domain/agent-engine.js";
import { isDiffRange, type DiffRange } from "../domain/diff.js";
import type { ThreadNotice } from "./ipc.js";
import type { MobileErrorCode } from "./mobile.js";
import type { WorkspacePatch } from "./workspace-runtime.js";
import type { ThreadListQuery } from "./threads.js";

/** These reads stop at the receiving computer; they never follow its own paired links. */
export type ComputerThreadQuery =
  | { kind: "thread-read"; threadId: string; limit?: number }
  | ({ kind: "thread-list" } & Omit<ThreadListQuery, "computer">);

/**
 * How one computer running this app drives another. It is the phone's line with the phone's
 * projection taken out: a computer is handed the whole workspace state and speaks in the window's
 * own inputs, so anything the window can do there, it can do from here.
 */
export const COMPUTER_PROTOCOL_VERSION = 2;

/** A complete image strip, plus room for the prompt, annotations, and wire envelope. */
export const MAX_COMPUTER_MESSAGE_BYTES = MAX_ATTACHMENTS * MAX_ATTACHMENT_ENCODED_BYTES + 2 * 1024 * 1024;
/** Transfers share a socket with heartbeats, which wait behind large frames. */
export const COMPUTER_TRANSFER_TIMEOUT_MS = 5 * 60_000;
export const COMPUTER_SEND_TOO_LARGE = "This message is too large to send to another computer. Use smaller images or send fewer attachments.";

/** Reads that are content rather than state, which the window asks its own desktop for. */
export type ComputerQuery =
  | ComputerThreadQuery
  | { kind: "terminal-output"; terminalId: string; after?: number }
  | { kind: "directories"; prefix: string }
  | { kind: "attachment"; name: string }
  | { kind: "message-image"; path: string; root: string; message: string; thumbnail?: boolean }
  | { kind: "diff-patch"; workspaceId: string; range: DiffRange; path: string; previousPath?: string; ignoreWhitespace?: boolean }
  | { kind: "branches"; workspaceId: string }
  | { kind: "commands"; workspaceId: string; engine: AgentEngine };

export type ComputerPairRequest = { kind: "pair"; version: number; code: string; deviceName: string };
export type ComputerResumeRequest = { kind: "resume"; version: number; token: string; sessionId?: string; lastSequence: number };
/** Inputs run one after another by the other computer's reducer, answered once by the last one's result. */
export type ComputerInputRequest = { kind: "input"; requestId: string; inputs: WorkspaceInput[] };
export type ComputerQueryRequest = { kind: "query"; requestId: string; query: ComputerQuery };
/** A transfer announcement precedes the large frame so its upload also gets the longer deadline. */
export type ComputerClientMessage = ComputerPairRequest | ComputerResumeRequest | ComputerInputRequest | ComputerQueryRequest | { kind: "transfer"; requestId: string } | { kind: "pong"; at: number };

/** Requests that need the transfer deadline rather than the ordinary request deadline. */
export function isComputerTransfer(message: ComputerClientMessage): boolean {
  return message.kind === "input" ? message.inputs.some((input) => input.type === "attachments.send" && input.attachments.length > 0)
    : message.kind === "query" && (message.query.kind === "attachment" || message.query.kind === "message-image");
}

/** Data from an independently updated host is decoded before becoming this build's workspace state. */
export type ComputerWorkspaceUpdate = { revision: number; state: unknown } | { revision: number; patches: WorkspacePatch[] };

type Sequenced = { sequence: number };

export type ComputerServerMessage = Sequenced & (
  | { kind: "paired"; deviceId: string; deviceName: string; token: string }
  /** The whole state on arrival, named with the session a resume will ask for, then the difference each time it moves. */
  | { kind: "workspace"; sessionId?: string; update: ComputerWorkspaceUpdate }
  | { kind: "result"; requestId: string; result: WorkspaceCommandResult & { revision: number } }
  | ({ kind: "answer"; requestId: string } & ({ ok: true; result: unknown } | { ok: false; message: string }))
  | { kind: "error"; code: MobileErrorCode; message: string }
  /** What that computer would have put on its own desktop, for this one to put on its own. */
  | { kind: "notice"; notice: ThreadNotice }
  /** What that computer calls itself, sent as the line opens and again whenever it changes. */
  | { kind: "name"; name: string }
  | { kind: "capabilities"; capabilities: readonly string[] }
  | { kind: "ping"; at: number }
);

const MAX_ID_LENGTH = 256;
const MAX_TOKEN_LENGTH = 512;
const MAX_DEVICE_NAME_LENGTH = 128;
const MAX_PATH_LENGTH = 4_096;
/** How many inputs one request may carry. A send is a few; a stranger's list is refused. */
const MAX_INPUTS = 16;

function isString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Every query and field has one validator, also used to advertise what this host understands. */
const queryShapes = {
  "thread-read": { threadId: isString, limit: (v) => v === undefined || isCount(v) && v <= 200 },
  "thread-list": {
    project: (v) => v === undefined || isString(v, MAX_PATH_LENGTH),
    archived: (v) => v === undefined || typeof v === "boolean",
    idleForMs: (v) => v === undefined || isCount(v),
    search: (v) => v === undefined || isString(v, 1_000),
    attachments: (v) => v === undefined || typeof v === "boolean",
    limit: (v) => v === undefined || isCount(v) && v <= 200,
  },
  "terminal-output": { terminalId: isString, after: (v) => v === undefined || Number.isSafeInteger(v) && (v as number) >= 0 },
  directories: { prefix: (v) => typeof v === "string" && v.length <= MAX_PATH_LENGTH && !v.includes("\0") },
  attachment: { name: (v) => isString(v) && /^[A-Za-z0-9-]+\.png$/.test(v) },
  "message-image": { path: (v) => typeof v === "string", root: (v) => typeof v === "string", message: (v) => typeof v === "string", thumbnail: (v) => v === undefined || typeof v === "boolean" },
  "diff-patch": { workspaceId: isString, range: isDiffRange, path: (v) => isString(v, MAX_PATH_LENGTH), previousPath: (v) => v === undefined || isString(v, MAX_PATH_LENGTH), ignoreWhitespace: (v) => v === undefined || typeof v === "boolean" },
  branches: { workspaceId: isString },
  commands: { workspaceId: isString, engine: isAgentEngine },
} satisfies { [Kind in ComputerQuery["kind"]]: { [Field in keyof Omit<Extract<ComputerQuery, { kind: Kind }>, "kind">]-?: (value: unknown) => boolean } };

export function computerQueryDefinitions(): ReadonlyArray<{ kind: ComputerQuery["kind"]; fields: readonly string[] }> {
  return Object.entries(queryShapes).map(([kind, fields]) => ({ kind: kind as ComputerQuery["kind"], fields: Object.keys(fields) }));
}

export function isComputerQuery(value: unknown): value is ComputerQuery {
  if (!isRecord(value) || typeof value.kind !== "string" || !Object.hasOwn(queryShapes, value.kind)) return false;
  const fields = queryShapes[value.kind as ComputerQuery["kind"]];
  if (!Object.entries(fields).every(([key, check]) => check(value[key]))) return false;
  return value.kind !== "message-image" || isMessageImageReference(value.path, value.root, value.message);
}

/** What another computer sends is the security boundary, so every field of it is read defensively. */
export function isComputerClientMessage(value: unknown): value is ComputerClientMessage {
  if (!isRecord(value)) return false;
  if (value.kind === "pair") return isCount(value.version) && isString(value.code, MAX_TOKEN_LENGTH) && isString(value.deviceName, MAX_DEVICE_NAME_LENGTH);
  if (value.kind === "resume") {
    return isCount(value.version) && isString(value.token, MAX_TOKEN_LENGTH) && (value.sessionId === undefined || isString(value.sessionId)) && isCount(value.lastSequence);
  }
  if (value.kind === "transfer") return isString(value.requestId);
  if (value.kind === "input") {
    return isString(value.requestId) && Array.isArray(value.inputs) && value.inputs.length > 0 && value.inputs.length <= MAX_INPUTS && value.inputs.every((input) => isWorkspaceViewInput(input) && isAppCommandType(input.type));
  }
  if (value.kind === "query") return isString(value.requestId) && isComputerQuery(value.query);
  if (value.kind === "pong") return isCount(value.at);
  return false;
}

/** Only the envelope is checked: the state inside is the other computer's own derivation. */
export function isComputerServerMessage(value: unknown): value is ComputerServerMessage {
  if (!isRecord(value) || !isCount(value.sequence)) return false;
  if (value.kind === "paired") return isString(value.deviceId) && isString(value.deviceName, MAX_DEVICE_NAME_LENGTH) && isString(value.token, MAX_TOKEN_LENGTH);
  if (value.kind === "workspace") return (value.sessionId === undefined || isString(value.sessionId)) && isRecord(value.update) && isCount(value.update.revision) && (isRecord(value.update.state) || Array.isArray(value.update.patches));
  if (value.kind === "result") return isString(value.requestId) && isRecord(value.result) && typeof value.result.ok === "boolean" && isCount(value.result.revision);
  if (value.kind === "answer") {
    if (!isString(value.requestId)) return false;
    return (value.ok === true && "result" in value) || (value.ok === false && typeof value.message === "string");
  }
  if (value.kind === "error") return typeof value.code === "string" && typeof value.message === "string";
  if (value.kind === "notice") return isRecord(value.notice) && isString(value.notice.taskId) && typeof value.notice.title === "string" && typeof value.notice.headline === "string";
  if (value.kind === "capabilities") return Array.isArray(value.capabilities) && value.capabilities.length <= 4096 && value.capabilities.every((name) => typeof name === "string" && name.length > 0 && name.length <= 256);
  if (value.kind === "name") return isString(value.name, MAX_DEVICE_NAME_LENGTH);
  if (value.kind === "ping") return isCount(value.at);
  return false;
}
