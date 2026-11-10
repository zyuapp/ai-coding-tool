import type { WorkspaceInput, WorkspaceEffect } from "./workspace-reducer.js";
import type { WorkspaceCommandResult } from "../contracts/workspace-result.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { WorkspacePatch } from "../contracts/workspace-patch.js";

export type WorkspaceUpdate = { revision: number; state: WorkspaceState } | { revision: number; patches: WorkspacePatch[] };
export type WorkspaceResponse = { id: string; result: WorkspaceCommandResult & { revision: number } };
export type WorkspaceSurfaceEffect = Extract<WorkspaceEffect, { type: "terminal.close" | "find-in-terminal" | "stop-find-in-terminal" }>;

/** The host owns state; a view subscribes to revisions and submits inputs to it. */
export type WorkspaceBridge = {
  /** Runs one input, or with none asks for a whole snapshot, and answers with the revision it left. */
  request(input?: WorkspaceInput): Promise<WorkspaceResponse["result"]>;
  /** Hands the window's own stored preferences and drafts to a host that has yet to keep any. */
  migrate(values: Record<string, string>): Promise<void>;
  onUpdate(listener: (update: WorkspaceUpdate) => void): () => void;
  onSurface(listener: (effect: WorkspaceSurfaceEffect) => void): () => void;
};
