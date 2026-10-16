/**
 * How a paired computer stands against newer builds of the app and of its engines, in the lines its
 * row on the Computers page shows, each with the command that moves it on when there is one.
 */
import { supportsComputerCommand } from "../contracts/computer-capabilities.js";
import type { AppCommand } from "../contracts/commands.js";
import { AGENT_ENGINES, engineLabel, engineNotice, engineUpdate } from "../domain/agent-engine.js";
import type { AppBuild } from "../domain/app-update.js";
import { compareVersions } from "../domain/engine-version.js";
import type { PairedComputer } from "./computers.js";
import { runningThreads } from "./app-updates.js";
import type { WorkspaceState } from "./workspace-state.js";

export type UpkeepLine = {
  /** Stable within the row, for the list it is drawn in. */
  key: string;
  text: string;
  tone?: "progress" | "error";
  action?: { label: string; command: AppCommand };
};

/** One paired computer's version and what its row says about moving it on. */
export type ComputerUpkeep = { id: string; version: string | null; lines: UpkeepLine[] };

function threads(count: number) {
  return count === 1 ? "1 running thread finishes" : `${count} running threads finish`;
}

/** What the app itself says: a newer build on its way, waiting, failed, or one only that computer can install. */
function appLines(computer: PairedComputer, remote: WorkspaceState, own: AppBuild | null): UpkeepLine[] {
  const id = computer.id;
  const request = remote.appUpdateRequest;
  const update = remote.appUpdate;
  if (computer.status !== "connected") {
    return request?.status === "installing" ? [{ key: "app", text: `Restarting into ${request.version}…`, tone: "progress" }] : [];
  }
  if (!supportsComputerCommand(computer.capabilities, { type: "app.update" })) {
    return [{ key: "app", text: "Update AI Coding Tool on that computer to manage it from here." }];
  }
  if (request?.status === "installing") return [{ key: "app", text: `Installing ${request.version}…`, tone: "progress" }];
  if (update.status === "downloading") return [{ key: "app", text: `Downloading ${update.version}… ${update.percent}%`, tone: "progress" }];
  const running = runningThreads(remote);
  if (request?.status === "failed") {
    return [{ key: "app", text: request.message, tone: "error", action: { label: "Try again", command: { type: "app.update", computerId: id } } }];
  }
  if (update.status === "available" || update.status === "ready") {
    if (request?.status === "waiting") {
      return [{ key: "app", text: `Updates to ${update.version} after ${threads(running)}.`, action: { label: "Cancel", command: { type: "app.cancel-update", computerId: id } } }];
    }
    const text = update.status === "ready" ? `${update.version} is ready to install.` : `${update.version} is available.`;
    return [{ key: "app", text, action: { label: running > 0 ? "Update when idle" : "Update", command: { type: "app.update", computerId: id } } }];
  }
  /** A copy that cannot update itself only learns of a newer build from one that runs it. */
  const build = remote.appBuild;
  if (build && !build.selfUpdating && own && compareVersions(own.version, build.version) > 0) {
    return [{ key: "app", text: `${own.version} is out. Update it on that computer.` }];
  }
  return [];
}

/** What each engine there says: one the build needs, or a newer release the app can install. */
function engineLines(computer: PairedComputer, remote: WorkspaceState): UpkeepLine[] {
  if (computer.status !== "connected") return [];
  const upgradable = supportsComputerCommand(computer.capabilities, { type: "engine.update", engine: "claude" });
  return AGENT_ENGINES.flatMap((engine): UpkeepLine[] => {
    const label = engineLabel(engine);
    const key = `engine:${engine}`;
    if (remote.engineUpdating === engine || remote.engineUpdateQueue.includes(engine)) return [{ key, text: `Updating ${label}…`, tone: "progress" }];
    const readiness = remote.engineStatus?.[engine];
    const update = readiness ? engineUpdate(readiness) : null;
    if (!readiness || !update) return [];
    const action = update.command && upgradable ? { label: "Upgrade", command: { type: "engine.update", engine, computerId: computer.id } as const } : undefined;
    if (readiness.required) {
      const notice = engineNotice(engine, readiness, "on that computer");
      return [{ key, text: notice?.message ?? `${label} needs ${readiness.required}.`, tone: notice?.blocking ? "error" : undefined, ...(action ? { action } : {}) }];
    }
    return action ? [{ key, text: `${label} ${update.target} is available.`, action }] : [];
  });
}

export function computerUpkeep(paired: readonly PairedComputer[], own: AppBuild | null): ComputerUpkeep[] {
  return paired.map((computer) => {
    const remote = computer.state;
    if (!remote) return { id: computer.id, version: null, lines: [] };
    return { id: computer.id, version: remote.appBuild?.version ?? null, lines: [...appLines(computer, remote, own), ...engineLines(computer, remote)] };
  });
}

function sameLine(before: UpkeepLine, next: UpkeepLine) {
  return before.key === next.key && before.text === next.text && before.tone === next.tone
    && before.action?.label === next.action?.label && JSON.stringify(before.action?.command) === JSON.stringify(next.action?.command);
}

/** Streaming state rebuilds the rows on every change there, so an unchanged page keeps its old ones. */
export function sameComputerUpkeep(before: readonly ComputerUpkeep[], next: readonly ComputerUpkeep[]) {
  return before.length === next.length && before.every((item, index) => {
    const other = next[index]!;
    return item.id === other.id && item.version === other.version && item.lines.length === other.lines.length
      && item.lines.every((line, at) => sameLine(line, other.lines[at]!));
  });
}
