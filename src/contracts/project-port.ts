import type { AgentEngine } from "../domain/agent-engine.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import type { CommandDiscoveryResult, InstalledApp, WorkspaceId } from "./ipc.js";

type ProjectRuntime = {
  openFolder(): Promise<WorkspaceRecord | null>;
  /** Opens a folder named by path rather than picked, refusing anything that is not one to work in. */
  registerProject(root: string): Promise<WorkspaceRecord>;
  directories(prefix: string, computerId?: string): Promise<string[]>;
  /** A folder the `aic` terminal command named, already registered as a workspace. */
  onOpenProject(listener: (workspace: WorkspaceRecord) => void): () => void;
  projectlessWorkspace(): Promise<WorkspaceRecord>;
  /** What the "/" menu offers a thread on the engine: its slash commands and enabled skills. */
  commands(workspaceId: WorkspaceId, engine: AgentEngine): Promise<CommandDiscoveryResult>;
  /** Hands a file to the desktop, which opens it with whatever it opens that kind of file with. */
  openFile(roots: string[], path: string, line: number | null): Promise<void>;
  /** The applications on this machine that can take a folder, read fresh enough to see a new install. */
  listApps(): Promise<InstalledApp[]>;
  /** Opens a checkout in one of them. `root` has to be a folder the app already works in. */
  openFolderInApp(appId: string, root: string): Promise<void>;
};

/** The folders the app works in, and the applications that open them. */
export type ProjectPort = {
  runtime: ProjectRuntime;
  windowCalls: Pick<ProjectRuntime, "openFolder" | "projectlessWorkspace" | "commands">;
};
