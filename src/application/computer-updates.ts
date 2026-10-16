/**
 * How a paired computer's row on the Computers page reads: whether its line is up, then the software
 * it runs (the app and each engine), each with its version, where a newer one stands, and the one
 * command that moves it on when there is one.
 */
import { supportsComputerCommand } from "../contracts/computer-capabilities.js";
import type { AppCommand } from "../contracts/commands.js";
import { AGENT_ENGINES, engineLabel, engineUpdate, type AgentEngine } from "../domain/agent-engine.js";
import type { AppBuild } from "../domain/app-update.js";
import { compareVersions } from "../domain/engine-version.js";
import type { PairedComputer } from "./computers.js";
import { runningThreads } from "./app-updates.js";
import type { WorkspaceState } from "./workspace-state.js";

/** A short phrase and how it should read: fine, under way, offered, or wrong. */
export type UpkeepPart = { text: string; tone?: "live" | "quiet" | "progress" | "offer" | "error" };

export type UpkeepAction = { label: string; command: AppCommand };

/** One piece of software on that computer: the app, or an engine. */
export type UpkeepItem = {
  key: "app" | AgentEngine;
  label: string;
  /** What it runs now, or null when that computer cannot say. */
  version: string | null;
  state: UpkeepPart;
  action: UpkeepAction | null;
};

/** One paired computer's row: how its line stands, a step for the line itself, and its software. */
export type ComputerUpkeep = { id: string; status: UpkeepPart[]; action: UpkeepAction | null; items: UpkeepItem[] };

const UP_TO_DATE: UpkeepPart = { text: "Up to date", tone: "quiet" };

function threads(count: number) {
  return count === 1 ? "1 thread" : `${count} threads`;
}

/** Where a newer build of the app stands there: on its way, waiting, failed, or one only that computer can install. */
function appItem(computer: PairedComputer, remote: WorkspaceState, own: AppBuild | null): UpkeepItem {
  const id = computer.id;
  const item = { key: "app" as const, label: "AI Coding Tool", version: remote.appBuild?.version ?? null };
  const request = remote.appUpdateRequest;
  const update = remote.appUpdate;
  if (!supportsComputerCommand(computer.capabilities, { type: "app.update" })) {
    return { ...item, state: { text: "Update it there once to manage it from here" }, action: null };
  }
  if (request?.status === "installing") return { ...item, state: { text: `Installing ${request.version}…`, tone: "progress" }, action: null };
  if (update.status === "downloading") return { ...item, state: { text: `Downloading ${update.version} · ${update.percent}%`, tone: "progress" }, action: null };
  if (request?.status === "failed") {
    return { ...item, state: { text: request.message.replace(/\.$/, ""), tone: "error" }, action: { label: "Try again", command: { type: "app.update", computerId: id } } };
  }
  if (update.status === "available" || update.status === "ready") {
    const running = runningThreads(remote);
    if (request?.status === "waiting") {
      return { ...item, state: { text: `Waiting for ${threads(running)}`, tone: "progress" }, action: { label: "Cancel", command: { type: "app.cancel-update", computerId: id } } };
    }
    /** Updating never cuts a run off: the install waits for running threads, which the line says beforehand. */
    const waits = running > 0 ? ` · waits for ${threads(running)}` : "";
    return { ...item, state: { text: `${update.version} available${waits}`, tone: "offer" }, action: { label: "Update", command: { type: "app.update", computerId: id } } };
  }
  /** A copy that cannot update itself only learns of a newer build from one that runs it. */
  const build = remote.appBuild;
  if (build && !build.selfUpdating && own && compareVersions(own.version, build.version) > 0) {
    return { ...item, state: { text: `${own.version} available · update it there`, tone: "offer" }, action: null };
  }
  return { ...item, state: UP_TO_DATE, action: null };
}

/** Where an engine stands there: missing, too old to run, behind, or current, and whether the app can move it on. */
function engineItem(computer: PairedComputer, remote: WorkspaceState, engine: AgentEngine): UpkeepItem {
  const readiness = remote.engineStatus?.[engine];
  const item = { key: engine, label: engineLabel(engine), version: readiness?.version ?? null };
  if (remote.engineUpdating === engine) return { ...item, state: { text: "Updating…", tone: "progress" }, action: null };
  if (remote.engineUpdateQueue.includes(engine)) return { ...item, state: { text: "Waiting to update", tone: "progress" }, action: null };
  if (!readiness) return { ...item, state: { text: "Checking…", tone: "quiet" }, action: null };
  if (readiness.access === "missing") return { ...item, state: { text: "Not installed", tone: "quiet" }, action: null };
  if (readiness.access === "unavailable") return { ...item, state: { text: "Won't start", tone: "error" }, action: null };
  const update = engineUpdate(readiness);
  if (!update) return { ...item, state: UP_TO_DATE, action: null };
  const upgradable = Boolean(update.command) && supportsComputerCommand(computer.capabilities, { type: "engine.update", engine });
  const action = upgradable ? { label: "Update", command: { type: "engine.update", engine, computerId: computer.id } as const } : null;
  const where = upgradable ? "" : " · update it there";
  if (readiness.required) {
    /** Codex too old stops its runs; Claude behind only hides newer models. */
    const blocked = readiness.access === "outdated";
    return { ...item, state: { text: `Needs ${readiness.required} ${blocked ? "to run" : "for newer models"}${where}`, tone: blocked ? "error" : "offer" }, action };
  }
  return { ...item, state: { text: `${update.target} available${where}`, tone: "offer" }, action };
}

/** How the line to that computer stands, which a restart it was asked for explains. */
function connection(computer: PairedComputer, remote: WorkspaceState | null): UpkeepPart[] {
  if (computer.status === "connected") return [{ text: "Connected", tone: "live" }];
  const request = remote?.appUpdateRequest;
  if (request?.status === "installing") return [{ text: `Restarting into ${request.version}…`, tone: "progress" }];
  const away: UpkeepPart = { text: computer.status === "connecting" ? "Reconnecting…" : "Offline" };
  return computer.error ? [away, { text: computer.error.replace(/\.$/, "") }] : [away];
}

export function computerUpkeep(paired: readonly PairedComputer[], own: AppBuild | null): ComputerUpkeep[] {
  return paired.map((computer) => {
    const remote = computer.state;
    const status = connection(computer, remote);
    /** A computer restarting into an update comes back on its own; one that is away can be dialled now. */
    if (computer.status !== "connected") {
      const restarting = remote?.appUpdateRequest?.status === "installing";
      return { id: computer.id, status, action: restarting ? null : { label: "Reconnect", command: { type: "computers.reconnect", id: computer.id } }, items: [] };
    }
    if (!remote) return { id: computer.id, status, action: null, items: [] };
    return { id: computer.id, status, action: null, items: [appItem(computer, remote, own), ...AGENT_ENGINES.map((engine) => engineItem(computer, remote, engine))] };
  });
}

function samePart(before: UpkeepPart, next: UpkeepPart) {
  return before.text === next.text && before.tone === next.tone;
}

function sameAction(before: UpkeepAction | null, next: UpkeepAction | null) {
  return before?.label === next?.label && JSON.stringify(before?.command) === JSON.stringify(next?.command);
}

/** Streaming state rebuilds the rows on every change there, so an unchanged page keeps its old ones. */
export function sameComputerUpkeep(before: readonly ComputerUpkeep[], next: readonly ComputerUpkeep[]) {
  return before.length === next.length && before.every((row, index) => {
    const other = next[index]!;
    return row.id === other.id && sameAction(row.action, other.action)
      && row.status.length === other.status.length && row.status.every((part, at) => samePart(part, other.status[at]!))
      && row.items.length === other.items.length && row.items.every((item, at) => {
        const that = other.items[at]!;
        return item.key === that.key && item.version === that.version && samePart(item.state, that.state) && sameAction(item.action, that.action);
      });
  });
}
