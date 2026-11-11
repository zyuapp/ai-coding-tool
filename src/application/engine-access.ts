import type { AgentSettingsReloadEvent } from "../contracts/ipc.js";
import type { EngineCommand } from "../contracts/commands.js";
import { AGENT_ENGINES, engineIsBlocked, engineLabel, engineNeedsAttention, engineUpdate, type AgentEngine, type EngineAccess, type EngineStatus } from "../domain/agent-engine.js";
import type { Toast } from "../domain/toast.js";
import { toastIn, toastsOf, type ToastEffect, type ToastsEdit } from "./toasts.js";
import type { SliceTransition } from "./workspace-reducer/slice.js";
import type { EnginesState } from "./state/engines.js";
import { engineReadinessOf } from "./state/engines.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { WorkspaceCommandResult } from "../contracts/workspace-result.js";

/** What main found out about an engine's access, on asking, after a sign-in or after an update, or why it could not. */
export type EngineEvent =
  | AgentSettingsReloadEvent
  | { type: "engine.status"; status: EngineStatus }
  | { type: "engine.failed"; message: string }
  /** An update is over, with every engine read again after it. */
  | { type: "engine.updated"; engine: AgentEngine; status: EngineStatus }
  | { type: "engine.update-failed"; engine: AgentEngine; message: string };

export type EngineEffect = EngineCommand;

export type EngineInput = EngineCommand | EngineEvent;

/** Engine work, and the toasts that offer an update and say how it went. */
export type EngineTransition = { state: WorkspaceState; effects: Array<EngineEffect | ToastEffect>; result?: WorkspaceCommandResult };

/** Everything about engine access is named `engine.`, so one test sorts the whole family out of the way. */
export function isEngineInput(input: { type: string }): input is EngineInput {
  return input.type.startsWith("engine.");
}

export function engineAccessOf(state: Pick<WorkspaceState, "engineStatus">, engine: AgentEngine): EngineAccess {
  return engineReadinessOf(state, engine).access;
}

/**
 * Asks main about the engines again, for a user who has just gone and installed or upgraded one.
 * Nothing is asked while every engine is fine, or while an earlier ask is still out, so coming back
 * to the window costs nothing on a machine with both engines in place.
 */
export function refreshEngines(state: WorkspaceState): EngineTransition {
  if (state.engineChecking || !engineNeedsAttention(state.engineStatus)) return { state, effects: [] };
  return { state: { ...state, engineChecking: true }, effects: [{ type: "engine.read", refresh: true }] };
}

/** True while no engine stands between the user and a run, which is when an engine error is stale. */
function nothingBlocked(status: EngineStatus) {
  return !Object.entries(status).some(([engine, readiness]) => engineIsBlocked(engine as AgentEngine, readiness));
}

/** The key a closed offer is remembered by, so the same release is not offered again but the next one is. */
export function engineUpdateKey(engine: AgentEngine, target: string) {
  return `engine-update:${engine}@${target}`;
}

type Own = EnginesState;

/** What an input has made of the engines, their toasts and the error banner so far, and the work it asks for. */
type Work = { engines: Own; toasts: ToastsEdit; effects: Array<EngineEffect | ToastEffect>; error?: SliceTransition<Own>["error"] };

function workOf(state: WorkspaceState): Work {
  const { engineStatus, engineChecking, engineUpdating, engineUpdateQueue, engineUpdatesOffered, agentSettingsReload } = state;
  return { engines: { engineStatus, engineChecking, engineUpdating, engineUpdateQueue, engineUpdatesOffered, agentSettingsReload }, toasts: toastsOf(state), effects: [] };
}

/** The answer a piece of work comes to, naming only what it changed. */
function done(state: WorkspaceState, { engines, toasts, effects, error }: Work, result?: WorkspaceCommandResult): SliceTransition<Own> {
  const changed = Object.entries(engines).some(([field, value]) => state[field as keyof Own] !== value);
  return { ...(changed ? { patch: engines } : {}), edits: [toasts], effects, ...(error ? { error } : {}), ...(result ? { result } : {}) };
}

const NO_ERROR = { message: null, page: null };

/** Puts a toast up alongside the engine work already decided. */
function toasted(work: Work, toast: Omit<Toast, "id">): Work {
  const shown = toastIn(work.toasts, toast);
  return { ...work, toasts: shown.toasts, effects: [...work.effects, ...shown.effects] };
}

/**
 * The card that offers an engine's update when the launch first hears about the engines. It stays
 * until the user upgrades or closes it, and a closed one is not offered again for the same release.
 */
function updateOffer(work: Work, engine: AgentEngine): Omit<Toast, "id"> | null {
  const readiness = engineReadinessOf(work.engines, engine);
  const update = engineUpdate(readiness);
  if (!update || work.toasts.view.dismissedToasts.includes(engineUpdateKey(engine, update.target))) return null;
  const label = engineLabel(engine);
  const have = update.version ? `You have ${update.version}.` : "";
  const needed = readiness.required ? `This app needs ${readiness.required} or newer. ${have}` : have;
  return {
    tone: "update",
    title: `${label} ${update.target} is available`,
    message: update.command ? needed.trim() : `${needed} Update it the way you installed it.`.trim(),
    subject: engine,
    persistent: true,
    remember: engineUpdateKey(engine, update.target),
    ...(update.command ? { action: { label: "Upgrade", command: { type: "engine.update", engine } } } : {}),
  };
}

/** Starts an engine's update, saying so in place of the card that offered it. */
function startUpdate(work: Work, engine: AgentEngine): Work {
  const label = engineLabel(engine);
  const update = engineUpdate(engineReadinessOf(work.engines, engine));
  const message = update?.version ? `Moving from ${update.version} to ${update.target}.` : `Moving to ${update?.target}.`;
  return toasted(
    { ...work, engines: { ...work.engines, engineUpdating: engine }, error: NO_ERROR, effects: [...work.effects, { type: "engine.update", engine }] },
    { tone: "progress", title: `Updating ${label}`, message, subject: engine, persistent: true },
  );
}

/** Starts the next engine waiting its turn, since package managers lock. One brought up to date meanwhile is passed over. */
function nextUpdate(work: Work): Work {
  const { engines } = work;
  const queue = engines.engineUpdateQueue.filter((engine) => engineUpdate(engineReadinessOf(engines, engine))?.command);
  const [engine, ...rest] = queue;
  const next = { ...work, engines: { ...engines, engineUpdateQueue: rest } };
  return engine ? startUpdate(next, engine) : queue.length === engines.engineUpdateQueue.length ? work : next;
}

/** How an update went: the version it reached, or that the engine is still behind. A success leaves on its own. */
function updateResult(engines: Own, engine: AgentEngine): Omit<Toast, "id"> {
  const label = engineLabel(engine);
  const readiness = engineReadinessOf(engines, engine);
  const update = engineUpdate(readiness);
  if (update) {
    const run = update.command ? ` Run \`${update.command}\` in your terminal.` : "";
    return { tone: "error", title: `Couldn't update ${label}`, message: `${label} is still on ${update.version ?? "an older version"}.${run}`, subject: engine, persistent: true };
  }
  return { tone: "success", title: `${label} updated`, ...(readiness.version ? { message: `Now on ${readiness.version}.` } : {}), subject: engine };
}

export function reduceEngine(state: WorkspaceState, input: EngineInput): SliceTransition<Own> {
  const work = workOf(state);
  const { engines } = work;
  if (input.type === "engine.reload-settings") {
    if (engines.agentSettingsReload === "reloading" || engines.agentSettingsReload === "pending") return {};
    const clearError = engines.agentSettingsReload === "failed" && state.actionErrorPage === "engines";
    return { patch: { agentSettingsReload: "reloading" }, ...(clearError ? { error: NO_ERROR } : {}), effects: [input] };
  }
  if (input.type === "engine.settings-reload-status") {
    return { patch: { agentSettingsReload: input.status }, ...(input.status === "failed" ? { error: { message: input.message ?? "Could not reload agent settings.", page: "engines" as const } } : {}) };
  }
  if (input.type === "engine.status" || input.type === "engine.updated") {
    const engineStatus = { ...engines.engineStatus, ...input.status };
    /** The error under the composer named an engine, so an answer that clears the engine clears it too. */
    const cleared = state.actionErrorPage === "engines" && nothingBlocked(engineStatus);
    const next: Work = { ...work, engines: { ...engines, engineStatus }, ...(cleared ? { error: NO_ERROR } : {}) };
    if (input.type === "engine.status") {
      const read = { ...next, engines: { ...next.engines, engineChecking: false } };
      /** Only the launch's first answer offers updates; later ones are the user's own checks, answered in Settings. */
      if (engines.engineUpdatesOffered) return done(state, read);
      return done(state, AGENT_ENGINES.reduce<Work>((offered, engine) => {
        const offer = updateOffer(offered, engine);
        return offer ? toasted(offered, offer) : offered;
      }, { ...read, engines: { ...read.engines, engineUpdatesOffered: true } }));
    }
    const updated = { ...next, engines: { ...next.engines, engineUpdating: null } };
    return done(state, nextUpdate(toasted(updated, updateResult(updated.engines, input.engine))));
  }

  if (input.type === "engine.failed") return { patch: { engineChecking: false }, refusal: input.message };

  if (input.type === "engine.update-failed") {
    const shown = toasted({ ...work, engines: { ...engines, engineUpdating: null } }, { tone: "error", title: `Couldn't update ${engineLabel(input.engine)}`, message: input.message, subject: input.engine, persistent: true });
    return done(state, nextUpdate(shown), { ok: false, message: input.message });
  }

  if (input.type === "engine.read") {
    if (engines.engineChecking) return {};
    /** Asked on the way up, asked again whenever something is wrong, since only the user can fix that. */
    if (engines.engineStatus === null) return { patch: { engineStatus: {}, engineChecking: true }, effects: [{ type: "engine.read" }] };
    if (!input.refresh && !engineNeedsAttention(engines.engineStatus)) return {};
    return { patch: { engineChecking: true }, effects: [{ type: "engine.read", refresh: true }] };
  }

  if (input.type === "engine.update") {
    /** Only an install the app can upgrade is, and only once; one asked for while another runs waits its turn. */
    const { engine } = input;
    if (!engineUpdate(engineReadinessOf(engines, engine))?.command || engines.engineUpdating === engine || engines.engineUpdateQueue.includes(engine)) return {};
    if (!engines.engineUpdating) return done(state, startUpdate(work, engine));
    return done(state, toasted(
      { ...work, engines: { ...engines, engineUpdateQueue: [...engines.engineUpdateQueue, engine] } },
      { tone: "progress", title: `Updating ${engineLabel(engine)}`, message: `Waiting for ${engineLabel(engines.engineUpdating)} to finish.`, subject: engine, persistent: true },
    ));
  }

  /** Only an engine that asked to be signed in to is; a ready one has nothing to open. */
  if (engineAccessOf(state, input.engine) !== "signed-out") return {};
  return { clearsError: true, effects: [input] };
}
