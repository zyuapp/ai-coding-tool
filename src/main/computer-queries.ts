import { isComputerQuery } from "../contracts/computers.js";
import { readSavedAttachment } from "./attachment-store.js";
import { readMessageImage } from "./message-image-store.js";
import type { ComputerQuery } from "../contracts/computers.js";
import type { AgentEngine } from "../domain/agent-engine.js";
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };

/** What a read from another computer is answered from: the checkouts here, and the engines here. */
export type ComputerQueryHost = {
  workspaces: () => WorkspaceService;
  commands: (workspaceId: string, engine: AgentEngine) => Promise<unknown>;
};

/** Answers one of another computer's reads the way the window's own desktop would. */
export async function answerComputerQuery(query: ComputerQuery, host: ComputerQueryHost): Promise<unknown> {
  if (query.kind === "attachment") return readSavedAttachment(query.name);
  if (query.kind === "message-image") {
    if (!isComputerQuery(query)) throw new Error("Invalid image reference.");
    const { bytes, contentType } = await readMessageImage(query.path, query.root, query.message, query.thumbnail);
    return { data: bytes.toString("base64"), contentType };
  }
  if (query.kind === "diff-patch") {
    const { diffPatch } = await import("./workspace/git-diff.mjs");
    return diffPatch(query.workspaceId, query.range, query.path, host.workspaces(), query.previousPath, query.ignoreWhitespace === true);
  }
  if (query.kind === "commands") return host.commands(query.workspaceId, query.engine);
  try {
    const resolution = await host.workspaces().resolve(query.workspaceId);
    if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
    const { listBranches } = await import("./workspace/git.mjs");
    return { status: "available", ...(await listBranches(resolution.workspace.root)) };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
