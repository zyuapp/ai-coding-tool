/**
 * How a paired computer's row on the Computers page reads: whether its line is up, the build it
 * runs, and where a newer build of the app or of an engine it needs stands, with the one command
 * that moves it on when there is one.
 */
import { supportsComputerCommand } from "../contracts/computer-capabilities.js";
import type { AppCommand } from "../contracts/commands.js";
import { AGENT_ENGINES, engineLabel, engineUpdate } from "../domain/agent-engine.js";
import type { AppBuild } from "../domain/app-update.js";
import { compareVersions } from "../domain/engine-version.js";
import type { PairedComputer } from "./computers.js";
import { runningThreads } from "./app-updates.js";
import type { WorkspaceState } from "./workspace-state.js";

/** One part of a row's status line. */
export type UpkeepPart = { text: string; tone?: "live" | "progress" | "error" };

/**
 * One paired computer's row: a single status line, such as "Connected · v0.7.10 · 0.7.11 available",
 * and at most one step that moves it on.
 */
export type ComputerUpkeep = { id: string; parts: UpkeepPart[]; action: { label: string; command: AppCommand } | null };

type Upkeep = { note: UpkeepPart | null; action: ComputerUpkeep["action"] };

const NOTHING: Upkeep = { note: null, action: null };

function threads(count: number) {
  return count === 1 ? "1 thread finishes" : `${count} threads finish`;
}

/** Where a newer build stands there: on its way, waiting, failed, or one only that computer can install. */
function appUpkeep(computer: PairedComputer, remote: WorkspaceState, own: AppBuild | null): Upkeep {
  const id = computer.id;
  const request = remote.appUpdateRequest;
  const update = remote.appUpdate;
  if (!supportsComputerCommand(computer.capabilities, { type: "app.update" })) return { note: { text: "Update the app there to manage it from here" }, action: null };
  if (request?.status === "installing") return { note: { text: `Installing ${request.version}…`, tone: "progress" }, action: null };
  if (update.status === "downloading") return { note: { text: `Downloading ${update.version}… ${update.percent}%`, tone: "progress" }, action: null };
  if (request?.status === "failed") return { note: { text: request.message.replace(/\.$/, ""), tone: "error" }, action: { label: "Try again", command: { type: "app.update", computerId: id } } };
  if (update.status === "available" || update.status === "ready") {
    const running = runningThreads(remote);
    if (request?.status === "waiting") return { note: { text: `Updates after ${threads(running)}` }, action: { label: "Cancel", command: { type: "app.cancel-update", computerId: id } } };
    return { note: { text: `${update.version} available` }, action: { label: running > 0 ? "Update when idle" : "Update", command: { type: "app.update", computerId: id } } };
  }
  /** A copy that cannot update itself only learns of a newer build from one that runs it. */
  const build = remote.appBuild;
  if (build && !build.selfUpdating && own && compareVersions(own.version, build.version) > 0) return { note: { text: `Update to ${own.version} there` }, action: null };
  return NOTHING;
}

/**
 * An engine the app there needs moved on, which only matters when it stops or limits runs. A newer
 * release that is merely available is that computer's own to offer.
 */
function engineUpkeep(computer: PairedComputer, remote: WorkspaceState): Upkeep {
  for (const engine of AGENT_ENGINES) {
    const label = engineLabel(engine);
    if (remote.engineUpdating === engine || remote.engineUpdateQueue.includes(engine)) return { note: { text: `Updating ${label}…`, tone: "progress" }, action: null };
    const readiness = remote.engineStatus?.[engine];
    if (!readiness?.required) continue;
    const update = engineUpdate(readiness);
    const upgradable = update?.command && supportsComputerCommand(computer.capabilities, { type: "engine.update", engine });
    return {
      note: { text: `${label} ${readiness.version ?? ""} needs ${readiness.required}`.replace("  ", " "), tone: readiness.access === "outdated" ? "error" : undefined },
      action: upgradable ? { label: `Upgrade ${label}`, command: { type: "engine.update", engine, computerId: computer.id } } : null,
    };
  }
  return NOTHING;
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
    const parts = connection(computer, remote);
    const restarting = remote?.appUpdateRequest?.status === "installing" && computer.status !== "connected";
    if (remote?.appBuild && !restarting) parts.push({ text: `v${remote.appBuild.version}` });
    /** A computer restarting into an update comes back on its own; one that is away can be dialled now. */
    if (computer.status !== "connected") return { id: computer.id, parts, action: restarting ? null : { label: "Reconnect", command: { type: "computers.reconnect", id: computer.id } } };
    if (!remote) return { id: computer.id, parts, action: null };
    const app = appUpkeep(computer, remote, own);
    const engine = engineUpkeep(computer, remote);
    for (const note of [app.note, engine.note]) if (note) parts.push(note);
    return { id: computer.id, parts, action: app.action ?? engine.action };
  });
}

/** Streaming state rebuilds the rows on every change there, so an unchanged page keeps its old ones. */
export function sameComputerUpkeep(before: readonly ComputerUpkeep[], next: readonly ComputerUpkeep[]) {
  return before.length === next.length && before.every((item, index) => {
    const other = next[index]!;
    return item.id === other.id && item.parts.length === other.parts.length
      && item.parts.every((part, at) => part.text === other.parts[at]!.text && part.tone === other.parts[at]!.tone)
      && item.action?.label === other.action?.label && JSON.stringify(item.action?.command) === JSON.stringify(other.action?.command);
  });
}
