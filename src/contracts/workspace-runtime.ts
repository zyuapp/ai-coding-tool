import type { WorkspaceInput, WorkspaceEffect, WorkspaceCommandResult } from "../application/workspace-reducer.js";
import type { WorkspaceState } from "../application/workspace-state.js";

export type WorkspaceSplice = { index: number; deleteCount: number; items: unknown[] };
export type WorkspacePatch =
  | { path: Array<string | number>; value?: unknown; remove?: true }
  | { path: Array<string | number>; splice: WorkspaceSplice };
export type WorkspaceUpdate = { revision: number; state: WorkspaceState } | { revision: number; patches: WorkspacePatch[] };
export type WorkspaceRequest = { id: string; input?: WorkspaceInput; flush?: true };
export type WorkspaceResponse = { id: string; result: WorkspaceCommandResult & { revision: number } };
export type WorkspaceSurfaceEffect = Extract<WorkspaceEffect, { type: "terminal.close" | "find-in-terminal" | "stop-find-in-terminal" }>;

/** The runtime owns state; a view subscribes to revisions and submits inputs through main. */
export type WorkspaceBridge = {
  owner: boolean;
  request(input?: WorkspaceInput): Promise<WorkspaceResponse["result"]>;
  onUpdate(listener: (update: WorkspaceUpdate) => void): () => void;
  onRequest(listener: (request: WorkspaceRequest) => void): () => void;
  respond(response: WorkspaceResponse): void;
  publish(update: WorkspaceUpdate): void;
  ready(): void;
  surface(effect: WorkspaceSurfaceEffect): void;
  onSurface(listener: (effect: WorkspaceSurfaceEffect) => void): () => void;
};
