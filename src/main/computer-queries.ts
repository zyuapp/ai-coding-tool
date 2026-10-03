import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { computerOfThread, computerOfWorkspace } from "../application/computers.js";
import type { WorkspaceState } from "../application/workspace-state.js";
import { isComputerQuery, type ComputerQuery, type ComputerThreadQuery } from "../contracts/computers.js";
import type { BranchesResult } from "../contracts/git.js";
import type { CommandDiscoveryResult, DiffPatchResult } from "../contracts/ipc.js";
import { isTerminalOutputRead, type TerminalOutputRead } from "../contracts/terminal.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_ENCODED_BYTES } from "../domain/conversation.js";
import { errorMessage } from "../host/errors.js";
import { readSavedAttachment } from "./attachment-store.js";
import { messageImageBytes, preserveMessageImage, readMessageImage } from "./message-image-store.js";
import { readTerminalOutput } from "./terminal-host.js";
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };

/** What a read is answered from on this computer: the threads here, and the checkouts here. */
export type ComputerQueryHost = {
  threads: (query: ComputerThreadQuery) => Promise<unknown>;
  workspaces: () => WorkspaceService;
};

/** Where a read is answered: this computer, or the paired one holding what it names. */
export type ComputerReadHost = ComputerQueryHost & {
  state: () => Pick<WorkspaceState, "computers" | "threads" | "projects" | "worktrees">;
  /** The lines to the paired computers, or null while there are none. */
  links: () => { query: (id: string, query: ComputerQuery) => Promise<unknown> } | null;
};

/** What a read names: a thread or checkout, wherever it is held, or a computer by id ("this" or none for this one). */
export type ComputerReadOwner = { thread: string | undefined } | { workspace: string } | { computer: string | undefined };

type Answers = {
  "thread-read": unknown;
  "thread-list": unknown;
  "terminal-output": TerminalOutputRead | null;
  directories: string[];
  attachment: Buffer<ArrayBuffer>;
  "message-image": { bytes: Buffer<ArrayBuffer>; contentType: string };
  "diff-patch": DiffPatchResult;
  branches: BranchesResult;
  commands: CommandDiscoveryResult;
};

type Kind = ComputerQuery["kind"];
type QueryOf<K extends Kind> = Extract<ComputerQuery, { kind: K }>;

type Read<K extends Kind> = {
  here: (query: QueryOf<K>, host: ComputerQueryHost) => Promise<Answers[K]>;
  /** What the line carries, when that is not the answer itself. */
  sent?: (answer: Answers[K]) => unknown;
  /** The holder's reply as this computer uses it; anything malformed is refused. */
  received: (value: unknown, query: QueryOf<K>) => Answers[K];
  /** Asks the holder some other way than passing the query on. */
  forward?: (query: QueryOf<K>, ask: (query: ComputerQuery) => Promise<unknown>) => Promise<Answers[K]>;
  /** What a failed read answers with, for reads whose result carries its own failure. */
  failed?: (message: string) => Answers[K];
};

const MAX_DIRECTORIES = 20;
const MAX_PATH_LENGTH = 4_096;

function refuse(what: string): never {
  throw new Error(`Invalid ${what} response.`);
}

function isStrings(value: unknown, maxLength = MAX_PATH_LENGTH): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= maxLength);
}

function isFailure(value: unknown): value is { status: "error"; message: string } {
  const result = value as { status?: unknown; message?: unknown } | null;
  return result?.status === "error" && typeof result.message === "string";
}

function isCommand(value: unknown) {
  const command = value as Record<string, unknown> | null;
  return typeof command?.name === "string" && typeof command.description === "string" && typeof command.argumentHint === "string"
    && (command.aliases === undefined || isStrings(command.aliases));
}

async function resolved(host: ComputerQueryHost, workspaceId: string) {
  const resolution = await host.workspaces().resolve(workspaceId);
  if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
  return resolution.workspace;
}

const failed = (message: string) => ({ status: "error", message }) as const;

function threadRead<K extends "thread-read" | "thread-list">(): Read<K> {
  return { here: (query, host) => host.threads(query), received: (value) => value };
}

/** Every read a computer answers: how it is answered here, how it crosses the line, and how a failure reads. */
const reads: { [K in Kind]: Read<K> } = {
  "thread-read": threadRead(),
  "thread-list": threadRead(),
  "terminal-output": {
    here: (query) => readTerminalOutput(query.terminalId, query.after),
    received: (value) => isTerminalOutputRead(value) ? value : refuse("terminal output"),
  },
  directories: {
    here: (query) => listDirectories(query.prefix),
    received: (value) => isStrings(value) && value.length <= MAX_DIRECTORIES && value.every((item) => !item.includes("\0")) ? value : refuse("directory"),
  },
  attachment: {
    here: async (query) => Buffer.from(await readSavedAttachment(query.name), "base64"),
    sent: (bytes) => bytes.toString("base64"),
    received: (value) => {
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_ATTACHMENT_ENCODED_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) refuse("attachment");
      const bytes = Buffer.from(value, "base64");
      return bytes.length > 0 && bytes.length <= MAX_ATTACHMENT_BYTES ? bytes : refuse("attachment");
    },
  },
  "message-image": {
    here: (query) => readMessageImage(query.path, query.root, query.message, query.thumbnail),
    sent: ({ bytes, contentType }) => ({ data: bytes.toString("base64"), contentType }),
    received: (value, query) => ({ bytes: messageImageBytes(value, query.path), contentType: (value as { contentType: string }).contentType }),
    /** The holder's original is kept here, so its previews are cut here and it still opens once the holder is gone. */
    forward: async (query, ask) => {
      const original = { kind: "message-image", path: query.path, root: query.root, message: query.message } as const;
      await preserveMessageImage(query.path, query.root, query.message, async () => messageImageBytes(await ask(original), query.path));
      return readMessageImage(query.path, query.root, query.message, query.thumbnail);
    },
  },
  "diff-patch": {
    here: async (query, host) => {
      const { diffPatch } = await import("./workspace/git-diff.mjs");
      return diffPatch(query.workspaceId, query.range, query.path, host.workspaces(), query.previousPath, query.ignoreWhitespace === true);
    },
    received: (value) => {
      const result = value as DiffPatchResult | null;
      if (result?.status === "available" && typeof result.patch === "string") return result;
      if (result?.status === "too-large" && typeof result.limit === "number") return result;
      return isFailure(result) ? result : refuse("patch");
    },
    failed,
  },
  branches: {
    here: async (query, host) => {
      const { listBranches } = await import("./workspace/git.mjs");
      return { status: "available", ...(await listBranches((await resolved(host, query.workspaceId)).root)) };
    },
    received: (value) => {
      const result = value as BranchesResult | null;
      if (result?.status === "available" && isStrings(result.branches) && isStrings(result.remotes) && (result.current === null || typeof result.current === "string")) return result;
      return isFailure(result) ? result : refuse("branch");
    },
    failed,
  },
  commands: {
    here: async (query, host) => {
      const workspace = await resolved(host, query.workspaceId);
      const { engineServices } = await import("./agent/engine-services.mjs");
      return { status: "available", commands: await engineServices[query.engine].commands({ workspaceRoot: workspace.root, projectless: workspace.kind === "projectless" }) };
    },
    received: (value) => {
      const result = value as CommandDiscoveryResult | null;
      if (result?.status === "available" && Array.isArray(result.commands) && result.commands.every(isCommand)) return result;
      return isFailure(result) ? result : refuse("command");
    },
    failed,
  },
};

function readOf<K extends Kind>(kind: K): Read<K> {
  return reads[kind];
}

async function settled<K extends Kind>(kind: K, work: () => Promise<Answers[K]>): Promise<Answers[K]> {
  try {
    return await work();
  } catch (error) {
    const fail = readOf(kind).failed;
    if (fail) return fail(errorMessage(error));
    throw error;
  }
}

function checked<Query extends ComputerQuery>(query: Query): Query {
  if (!isComputerQuery(query)) throw new Error(`Invalid ${String((query as { kind?: unknown }).kind)} query.`);
  return query;
}

/** This computer's own answer to a read, in the form it is used here. */
export function answerComputerQuery<K extends Kind>(query: QueryOf<K>, host: ComputerQueryHost): Promise<Answers[K]> {
  const kind = query.kind as K;
  return settled(kind, () => readOf(kind).here(checked(query), host));
}

/** Reads answered by whichever computer holds what they name, in one shape whichever answers and however it fails. */
export function createComputerReads(host: ComputerReadHost) {
  function holder(owner: ComputerReadOwner): string | null {
    if ("thread" in owner) return computerOfThread(host.state(), owner.thread)?.id ?? null;
    if ("workspace" in owner) return computerOfWorkspace(host.state(), owner.workspace)?.id ?? null;
    if (owner.computer === undefined || owner.computer === "this") return null;
    if (typeof owner.computer !== "string" || !owner.computer || owner.computer.length > 256) throw new Error("Invalid computer.");
    return owner.computer;
  }

  return {
    read<K extends Kind>(query: QueryOf<K>, owner: ComputerReadOwner): Promise<Answers[K]> {
      const kind = query.kind as K;
      const read = readOf(kind);
      return settled(kind, async () => {
        const valid = checked(query);
        const id = holder(owner);
        if (id === null) return read.here(valid, host);
        const links = host.links();
        if (!links) throw new Error("That computer is unavailable.");
        const ask = (asked: ComputerQuery) => links.query(id, asked);
        return read.forward ? read.forward(valid, ask) : read.received(await ask(valid), valid);
      });
    },
    /** Answers a paired computer's read from this computer, in the form the line carries. */
    async answer(query: ComputerQuery): Promise<unknown> {
      const answer = await answerComputerQuery(query, host);
      const { sent } = readOf(query.kind) as Read<Kind>;
      return sent ? sent(answer) : answer;
    },
  };
}

export type ComputerReads = ReturnType<typeof createComputerReads>;

/** A bounded directory scan. */
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
    if (folder && root.length < MAX_PATH_LENGTH) matches.push(root + path.sep);
    if (matches.length === MAX_DIRECTORIES) break;
  }
  return matches.sort((a, b) => a.localeCompare(b));
}
