import { MAX_ATTACHMENTS, MAX_ATTACHMENT_ENCODED_BYTES } from "../domain/conversation.js";
import { isMessageImageReference } from "../domain/message-artifacts.js";
import type { WorkspaceCommandResult, WorkspaceInput } from "../application/workspace-reducer.js";
import { isWorkspaceViewInput } from "./workspace-view-input.js";
import { isAgentEngine, type AgentEngine } from "../domain/agent-engine.js";
import { isDiffRange, type DiffRange } from "../domain/diff.js";
import type { ThreadNotice } from "./ipc.js";
import type { MobileErrorCode } from "./mobile.js";
import type { WorkspaceUpdate } from "./workspace-runtime.js";

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

type Sequenced = { sequence: number };

export type ComputerServerMessage = Sequenced & (
  | { kind: "paired"; deviceId: string; deviceName: string; token: string }
  /** The whole state on arrival, named with the session a resume will ask for, then the difference each time it moves. */
  | { kind: "workspace"; sessionId?: string; update: WorkspaceUpdate }
  | { kind: "result"; requestId: string; result: WorkspaceCommandResult & { revision: number } }
  | ({ kind: "answer"; requestId: string } & ({ ok: true; result: unknown } | { ok: false; message: string }))
  | { kind: "error"; code: MobileErrorCode; message: string }
  /** What that computer would have put on its own desktop, for this one to put on its own. */
  | { kind: "notice"; notice: ThreadNotice }
  /** What that computer calls itself, sent as the line opens and again whenever it changes. */
  | { kind: "name"; name: string }
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

export function isComputerQuery(value: unknown): value is ComputerQuery {
  if (!isRecord(value)) return false;
  if (value.kind === "attachment") return isString(value.name) && /^[A-Za-z0-9-]+\.png$/.test(value.name);
  if (value.kind === "message-image") return isMessageImageReference(value.path, value.root, value.message)
    && (value.thumbnail === undefined || typeof value.thumbnail === "boolean");
  if (value.kind === "directories") return typeof value.prefix === "string" && value.prefix.length <= MAX_PATH_LENGTH && !value.prefix.includes("\0");
  if (!isString(value.workspaceId)) return false;
  if (value.kind === "branches") return true;
  if (value.kind === "commands") return isAgentEngine(value.engine);
  return value.kind === "diff-patch" && isDiffRange(value.range) && isString(value.path, MAX_PATH_LENGTH)
    && (value.previousPath === undefined || isString(value.previousPath, MAX_PATH_LENGTH))
    && (value.ignoreWhitespace === undefined || typeof value.ignoreWhitespace === "boolean");
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
    return isString(value.requestId) && Array.isArray(value.inputs) && value.inputs.length > 0 && value.inputs.length <= MAX_INPUTS && value.inputs.every(isWorkspaceViewInput);
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
  if (value.kind === "name") return isString(value.name, MAX_DEVICE_NAME_LENGTH);
  if (value.kind === "ping") return isCount(value.at);
  return false;
}
