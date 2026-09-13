import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
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
  if (query.kind === "directories") return listDirectories(query.prefix);
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

/** A bounded directory scan, shared by the desktop IPC and paired hosts. */
export async function listDirectories(prefix: string): Promise<string[]> {
  if (!isComputerQuery({ kind: "directories", prefix })) throw new Error("Invalid directory prefix.");
  const expanded = prefix === "~" || prefix.startsWith("~/") ? path.join(homedir(), prefix.slice(1)) + (prefix.endsWith("/") ? path.sep : "") : prefix;
  if (!expanded || !path.isAbsolute(expanded)) return [];
  const directory = prefix === "~" || expanded.endsWith(path.sep) ? expanded : path.dirname(expanded);
  const partial = prefix === "~" || expanded.endsWith(path.sep) ? "" : path.basename(expanded);
  const matches: string[] = [];
  let scanned = 0;
  let links = 0;
  let entries;
  try { entries = await opendir(directory); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
  for await (const entry of entries) {
    if (++scanned > 4096) break;
    if (!entry.name.startsWith(partial) || (entry.name.startsWith(".") && !partial.startsWith("."))) continue;
    const root = path.join(directory, entry.name);
    const folder = entry.isDirectory() || (entry.isSymbolicLink() && ++links <= 40 && (await stat(root).catch(() => null))?.isDirectory());
    if (folder && root.length < 4096) matches.push(root + path.sep);
    if (matches.length === 20) break;
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

/** A path query names a computer explicitly; a missing link never falls back to local disk. */
export async function queryDirectories(prefix: string, computerId?: string, query?: (id: string, query: ComputerQuery) => Promise<unknown>): Promise<string[]> {
  const request = { kind: "directories", prefix } as const;
  if (!isComputerQuery(request) || (computerId !== undefined && (typeof computerId !== "string" || !computerId || computerId.length > 256))) throw new Error("Invalid directory query.");
  if (!computerId || computerId === "this") return listDirectories(prefix);
  if (!query) throw new Error("That computer is unavailable.");
  const result = await query(computerId, request);
  if (!Array.isArray(result) || result.length > 20 || !result.every((item) => typeof item === "string" && item.length <= 4096 && !item.includes("\0"))) throw new Error("Invalid directory response.");
  return result;
}
