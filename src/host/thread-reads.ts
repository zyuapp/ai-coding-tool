import type { PairedComputer } from "../application/computers.js";
import { findThread, resolveScope, threadSummaries, threadSummary, threadTranscript } from "../application/thread-projection.js";
import type { WorkspaceState } from "../application/workspace-state.js";
import { isThreadSummary, isThreadTranscript } from "../contracts/thread-results.js";
import type { ThreadListQuery, ThreadRequest, ThreadSummary, ThreadTranscript } from "../contracts/threads.js";
import { isComputerQuery, type ComputerThreadQuery } from "../contracts/computers.js";
import type { ComputerDesktop } from "./runtime-desktop.js";
import { matchingProjects } from "../domain/project.js";
import { awayStatus } from "../domain/computers.js";

type ReadHost = { state(): WorkspaceState; desktop: Pick<ComputerDesktop, "queryComputerThreads"> };

/** What preparing a request found on disk: the unloaded threads whose stored messages match a list search. */
export type PreparedThreadRequest = { stored?: ReadonlySet<string> };

type PrepareThreadRequest = (request: ThreadRequest) => Promise<PreparedThreadRequest | void>;

export function localThreadReader(state: () => WorkspaceState, prepare: PrepareThreadRequest, flush: () => void, disposed: () => boolean) {
  return async (query: ComputerThreadQuery) => {
    if (disposed()) throw new Error("The workspace runtime has closed.");
    flush();
    return queryLocalThreads(state, prepare, query);
  };
}

/** The receiving host answers from its own state and disk, without following any paired links. */
export async function queryLocalThreads(state: () => WorkspaceState, prepare: PrepareThreadRequest, query: ComputerThreadQuery) {
  if (!isComputerQuery(query) || (query.kind !== "thread-read" && query.kind !== "thread-list")) throw new Error("Invalid thread query.");
  if (query.kind === "thread-read") {
    const limit = query.limit ?? 30;
    await prepare({ type: "thread.request", requestId: "paired-read", taskId: "paired", op: "read", threadId: query.threadId, limit, computer: "this" });
    const transcript = threadTranscript(state(), query.threadId, limit);
    if (!transcript) throw new Error(`No thread has the ID ${query.threadId}.`);
    return transcript;
  }
  const { kind: _kind, ...filter } = query;
  const local = { ...filter, project: filter.project ?? "all", limit: filter.limit ?? 20 };
  const prepared = await prepare({ ...local, type: "thread.request", requestId: "paired-list", taskId: "paired", op: "list", computer: "this" });
  return localThreadList(state(), "paired", local, prepared?.stored);
}

export function localThreadList(state: WorkspaceState, caller: string, query: ThreadListQuery, stored?: ReadonlySet<string>): ThreadSummary[] {
  const scope = resolveScope(state, caller, query.project);
  if ("error" in scope) throw new Error(scope.error);
  return threadSummaries(state, { ...query, scope, ...(stored ? { stored } : {}) }, Date.now());
}

function computers(state: WorkspaceState, selected: string): { local: boolean; paired: PairedComputer[] } {
  if (selected === "this") return { local: true, paired: [] };
  if (selected === "all") return { local: true, paired: state.computers.paired };
  const byId = state.computers.paired.find((computer) => computer.id === selected);
  const found = byId ? [byId] : state.computers.paired.filter((computer) => computer.name.toLowerCase() === selected.trim().toLowerCase());
  if (found.length !== 1) throw new Error(found.length ? `More than one computer is named ${selected}. Use its computer ID.` : `No paired computer is named ${selected}.`);
  return { local: false, paired: found };
}

/** The paired computer a caller names, or null for this one. */
export function namedComputer(state: WorkspaceState, selected: string): PairedComputer | null {
  return computers(state, selected).paired[0] ?? null;
}

export function tag(computer: PairedComputer) {
  return { id: computer.id, name: computer.name, offline: computer.status !== "connected" };
}

export function online(computer: PairedComputer, doing = "read") {
  if (computer.status !== "connected") throw new Error(`${computer.name} is ${awayStatus(computer.status)}, so its threads cannot be ${doing} right now.`);
}

/** A paired computer's thread as a listing shows it, tagged with the computer, or null while that computer's state does not hold it. */
export function remoteSummary(state: WorkspaceState, computerId: string, threadId: string): ThreadSummary | null {
  const computer = state.computers.paired.find((item) => item.id === computerId);
  const thread = computer?.state?.threads.find((item) => item.id === threadId);
  return computer?.state && thread ? { ...threadSummary(computer.state, thread), computer: tag(computer) } : null;
}

/**
 * Ordinary listings use the already mirrored index, including cached rows when a host is offline. A
 * listing across every computer leaves out one it cannot answer for: one that has sent no list yet,
 * or, for a search, one whose line is down or that fails to answer. Naming that computer says why.
 */
export async function listAcrossComputers(host: ReadHost, caller: string, query: ThreadListQuery, stored?: ReadonlySet<string>): Promise<ThreadSummary[]> {
  const state = host.state();
  const selected = computers(state, query.computer ?? "this");
  const { computer: _computer, ...filter } = query;
  if (query.computer && query.computer !== "this" && filter.project === undefined) filter.project = "all";
  if (selected.paired.length && filter.project === "current") throw new Error('Project "current" belongs to this computer. Use computer "this", or name a remote project.');
  const covers = (state: WorkspaceState) => query.computer !== "all" || !filter.project || filter.project === "all" || filter.project === "current" || matchingProjects(state.projects, filter.project).length > 0;
  const rows = selected.local && covers(state) ? localThreadList(state, caller, filter, stored) : [];
  const every = query.computer === "all";
  const remote = await Promise.all(selected.paired.map(async (computer) => {
    if (!computer.state) {
      if (every) return [];
      throw new Error(`${computer.name} has not sent its thread list yet. Try again once it is connected.`);
    }
    if (!covers(computer.state)) return [];
    let summaries: ThreadSummary[];
    if (filter.search?.trim()) {
      if (every && computer.status !== "connected") return [];
      online(computer);
      try {
        const result = await host.desktop.queryComputerThreads(computer.id, { ...filter, kind: "thread-list", limit: Math.min(filter.limit ?? 20, 200) });
        if (!Array.isArray(result) || result.length > 200 || !result.every(isThreadSummary)) throw new Error(`Invalid thread list from ${computer.name}.`);
        summaries = result;
      } catch (error) {
        if (every) return [];
        throw error;
      }
    } else {
      summaries = localThreadList(computer.state, "", filter);
    }
    return summaries.map((thread) => ({ ...thread, computer: tag(computer) }));
  }));
  const combined = rows.concat(...remote).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return query.limit === undefined ? combined : combined.slice(0, Math.max(0, query.limit));
}

/** The same resolution runs before loading history, so a remote read never loads local messages. */
export function resolveThreadRead(state: WorkspaceState, reference: string, selected = "all") {
  const scope = computers(state, selected);
  const sources = [
    ...(scope.local ? [{ state, computer: null }] : []),
    ...scope.paired.flatMap((computer) => computer.state ? [{ state: computer.state, computer }] : []),
  ];
  const matches = sources.flatMap((source) => {
    const thread = findThread(source.state, reference);
    return thread ? [{ ...source, thread }] : [];
  });
  const exact = matches.filter(({ thread }) => thread.id.toLowerCase() === reference.trim().toLowerCase());
  const candidates = exact.length ? exact : matches;
  if (candidates.length > 1) throw new Error(`More than one computer has a thread matching ${reference}: ${candidates.map(({ computer, thread }) => `${thread.id} on ${computer ? `${computer.name} [${computer.id}]` : "this computer"}`).join(", ")}. Use the full thread ID.`);
  const match = candidates[0];
  if (!match) {
    const missing = scope.paired.filter((computer) => !computer.state || computer.status !== "connected");
    throw new Error(`No thread has the ID ${reference}.${missing.length ? ` ${missing.map((computer) => computer.name).join(", ")} ${missing.length === 1 ? "is" : "are"} not connected, so newer threads there may be missing.` : ""}`);
  }
  return match;
}

/** Resolve across the paired indexes, then ask only the owning computer for the transcript. */
export async function readAcrossComputers(host: ReadHost, reference: string, limit?: number, selected = "all"): Promise<ThreadTranscript> {
  const state = host.state();
  const match = resolveThreadRead(state, reference, selected);
  if (!match.computer) return threadTranscript(state, match.thread.id, limit)!;
  const computer = match.computer;
  online(computer);
  const result = await host.desktop.queryComputerThreads(computer.id, { kind: "thread-read", threadId: match.thread.id, limit: Math.min(limit ?? 30, 200) });
  if (!isThreadTranscript(result) || result.thread.id !== match.thread.id) throw new Error(`Invalid thread transcript from ${computer.name}.`);
  return { ...result, thread: { ...result.thread, computer: tag(computer) } };
}
