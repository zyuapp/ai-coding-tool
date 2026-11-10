/** What one computer asks of another: the window's own inputs, run there by its reducer. */
import { isComputerClientRequest, type ComputerPairRequest, type ComputerQueryRequest, type ComputerResumeRequest } from "../contracts/computers.js";
import type { WorkspaceInput } from "./workspace-reducer.js";

/** Inputs run one after another by the other computer's reducer, answered once by the last one's result. */
export type ComputerInputRequest = { kind: "input"; requestId: string; inputs: WorkspaceInput[] };
/** A transfer announcement precedes the large frame so its upload also gets the longer deadline. */
export type ComputerClientMessage = ComputerPairRequest | ComputerResumeRequest | ComputerInputRequest | ComputerQueryRequest | { kind: "transfer"; requestId: string } | { kind: "pong"; at: number };

/** Requests that need the transfer deadline rather than the ordinary request deadline. */
export function isComputerTransfer(message: ComputerClientMessage): boolean {
  return message.kind === "input" ? message.inputs.some((input) => input.type === "attachments.send" && input.attachments.length > 0)
    : message.kind === "query" && (message.query.kind === "attachment" || message.query.kind === "message-image");
}

export function isComputerClientMessage(value: unknown): value is ComputerClientMessage {
  return isComputerClientRequest(value);
}
