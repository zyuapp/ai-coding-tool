import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type WorkspaceKind,
  type WorkspaceRecord,
  type WorkspaceResolution,
  UnknownWorkspaceError,
  WorkspaceRegistrationError,
} from "../../domain/workspace.js";

type RegistryFile = {
  version: 1;
  workspaces: WorkspaceRecord[];
};

export type WorkspaceServiceOptions = {
  registryPath: string;
  projectlessRoot: string;
};

export class WorkspaceService {
  private readonly registryPath: string;
  private readonly projectlessRoot: string;
  private readonly ready: Promise<void>;
  private registrationQueue = Promise.resolve();
  private records = new Map<string, WorkspaceRecord>();

  constructor(options: WorkspaceServiceOptions) {
    this.registryPath = options.registryPath;
    this.projectlessRoot = options.projectlessRoot;
    this.ready = this.load();
  }

  async registerProject(root: string) {
    return this.register("project", root);
  }

  async registerWorktree(root: string) {
    return this.register("worktree", root);
  }

  async getProjectless() {
    await this.ready;
    await mkdir(this.projectlessRoot, { recursive: true });
    return this.register("projectless", this.projectlessRoot);
  }

  /** Drops a worktree's registration once its directory is gone, so the registry never outgrows the disk. */
  async forgetWorktree(root: string) {
    await this.ready;
    const canonical = path.resolve(root);
    const doomed = [...this.records.values()].filter((record) => record.kind === "worktree" && record.root === canonical);
    if (!doomed.length) return;
    for (const record of doomed) this.records.delete(record.id);
    await this.writeRegistry();
  }

  async resolve(id: string): Promise<WorkspaceResolution> {
    await this.ready;
    const record = this.records.get(id);
    if (!record) throw new UnknownWorkspaceError(id);

    try {
      const actualRoot = await realpath(record.root);
      if (actualRoot !== record.root) return { status: "unavailable", workspace: record, reason: "changed" };
      if (!(await stat(actualRoot)).isDirectory()) {
        return { status: "unavailable", workspace: record, reason: "not-directory" };
      }
      return { status: "available", workspace: record };
    } catch (error) {
      return { status: "unavailable", workspace: record, reason: unavailableReason(error) };
    }
  }

  private async register(kind: WorkspaceKind, root: string) {
    await this.ready;
    const canonicalRoot = await canonicalDirectory(root);
    const registration = this.registrationQueue.then(async () => {
      const existing = [...this.records.values()].find((record) => record.kind === kind && record.root === canonicalRoot);
      if (existing) return { status: "available" as const, workspace: existing };

      const record: WorkspaceRecord = { id: randomUUID(), kind, root: canonicalRoot };
      this.records.set(record.id, record);
      try {
        await this.writeRegistry();
      } catch (error) {
        this.records.delete(record.id);
        throw error;
      }
      return { status: "available" as const, workspace: record };
    });
    this.registrationQueue = registration.then(() => {}, () => {});
    return registration;
  }

  private async load() {
    let content: string;
    try {
      content = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      await preserveCorruptRegistry(this.registryPath, content);
      return;
    }
    if (!isRegistryFile(parsed)) {
      await preserveCorruptRegistry(this.registryPath, content);
      return;
    }
    for (const workspace of parsed.workspaces) this.records.set(workspace.id, workspace);
  }

  private async writeRegistry() {
    await mkdir(path.dirname(this.registryPath), { recursive: true });
    const registry: RegistryFile = { version: 1, workspaces: [...this.records.values()] };
    const temporaryPath = `${this.registryPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.registryPath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch {
        // Best effort cleanup; preserve the original registry if replacement failed.
      }
      throw error;
    }
  }
}

function isRegistryFile(value: unknown): value is RegistryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const registry = value as Record<string, unknown>;
  return registry.version === 1 && Array.isArray(registry.workspaces) && registry.workspaces.every(isWorkspaceRecord);
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const workspace = value as Record<string, unknown>;
  return typeof workspace.id === "string" && workspace.id.length > 0 && typeof workspace.root === "string" && workspace.root.length > 0 && (workspace.kind === "project" || workspace.kind === "projectless" || workspace.kind === "worktree");
}

async function preserveCorruptRegistry(registryPath: string, content: string) {
  const preservedPath = `${registryPath}.corrupt.${randomUUID()}.json`;
  await writeFile(preservedPath, content, { encoding: "utf8", flag: "wx" });
}

async function canonicalDirectory(root: string) {
  try {
    const canonicalRoot = await realpath(root);
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new WorkspaceRegistrationError(root, `Cannot register workspace (not-directory): ${root}`);
    }
    return canonicalRoot;
  } catch (error) {
    if (error instanceof WorkspaceRegistrationError) throw error;
    const reason = unavailableReason(error);
    throw new WorkspaceRegistrationError(root, `Cannot register workspace (${reason}): ${root}`);
  }
}

function unavailableReason(error: unknown): "missing" | "not-directory" | "inaccessible" | "changed" {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  return "inaccessible";
}

export { UnknownWorkspaceError, WorkspaceRegistrationError } from "../../domain/workspace.js";
