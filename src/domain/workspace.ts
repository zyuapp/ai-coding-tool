export type WorkspaceKind = "project" | "projectless";

export type WorkspaceRecord = {
  id: string;
  kind: WorkspaceKind;
  root: string;
};

export type WorkspaceResolution =
  | { status: "available"; workspace: WorkspaceRecord }
  | {
      status: "unavailable";
      workspace: WorkspaceRecord;
      reason: "missing" | "not-directory" | "inaccessible" | "changed";
    };

export class UnknownWorkspaceError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`Unknown workspace: ${workspaceId}`);
    this.name = "UnknownWorkspaceError";
    this.workspaceId = workspaceId;
  }
}

export class WorkspaceRegistrationError extends Error {
  readonly root: string;

  constructor(root: string, message: string) {
    super(message);
    this.name = "WorkspaceRegistrationError";
    this.root = root;
  }
}
