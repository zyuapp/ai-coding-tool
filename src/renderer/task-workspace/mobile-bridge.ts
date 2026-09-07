import { diffMobileView, projectMobileView } from "../../application/mobile-projection";
import type { WorkspaceState } from "../../application/workspace-state";
import type { WorkspaceExecution } from "../../application/workspace-execution";
import type { WorkspaceEffect, WorkspaceInput } from "../../application/workspace-reducer";
import type { AppCommand } from "../../contracts/commands";
import { isMobileCommand, isMobileRequest, type MobileRequest, type MobileResponse, type MobileView, type MobileViewUpdate } from "../../contracts/mobile";
import type { DesktopAPI } from "../../contracts/ipc";
import type { MobileServerState } from "../../domain/mobile";
import { errorMessage } from "./errors";

/** What a phone is refused with when it sends something outside the surface open to it. */
export const MOBILE_REFUSED = "That command is not one a phone may send.";

/** The runtime state and the command execution that answers each phone request. */
export type MobileBridgeHost = {
  state: () => WorkspaceState;
  dispatch: (input: WorkspaceInput) => Promise<void> | void;
  execute: (command: AppCommand) => WorkspaceExecution;
};

/**
 * Each phone reads a projection of runtime state and writes through the shared command path.
 * Commands are validated at this boundary before reaching the reducer.
 */
export async function answerMobileRequest(host: MobileBridgeHost, request: MobileRequest): Promise<MobileResponse> {
  const requestId = request.requestId;
  const ok = (result: unknown): MobileResponse => ({ type: "mobile.response", requestId, ok: true, result });
  const failed = (message: string): MobileResponse => ({ type: "mobile.response", requestId, ok: false, message });
  try {
    if (request.op === "snapshot") return ok(projectMobileView(host.state(), Date.now()));
    if (!isMobileCommand(request.command)) return failed(MOBILE_REFUSED);
    const taskId = "taskId" in request.command ? request.command.taskId : undefined;
    if (taskId !== undefined && !host.state().threads.some((thread) => thread.id === taskId)) {
      return failed(`No thread has the ID ${taskId}.`);
    }
    const execution = host.execute(request.command);
    const accepted = execution.accepted instanceof Promise ? await execution.accepted : execution.accepted;
    if (!accepted.ok) return failed(accepted.message);
    return ok(projectMobileView(host.state(), Date.now()));
  } catch (error) {
    return failed(errorMessage(error));
  }
}

/** The view every connected phone was last shown, so a change can be sent as the difference. */
export type MobileViewHolder = { current: MobileView | null };

export function noMobileView(): MobileViewHolder {
  return { current: null };
}

/**
 * What to push after a state change: nothing while no phone is connected, a whole view for the first
 * change after one arrives, and the difference from then on.
 */
export function nextMobileUpdate(held: MobileViewHolder, state: WorkspaceState, at: number): MobileViewUpdate | null {
  if (!state.remote.sessions.length) {
    held.current = null;
    return null;
  }
  const view = projectMobileView(state, at);
  const previous = held.current;
  held.current = view;
  if (!previous) return { kind: "snapshot", view };
  const patch = diffMobileView(previous, view);
  return patch ? { kind: "patch", patch } : null;
}

/** The settings the bridge keeps in main, which is where the socket, the tokens and Tailscale live. */
export type RemoteEffect = Extract<WorkspaceEffect, { type: `remote.${string}` }>;

/** Each one answers with the whole bridge state, so the reducer never infers what a change did to it. */
export async function runRemoteEffect(effect: RemoteEffect, desktop: DesktopAPI): Promise<MobileServerState> {
  switch (effect.type) {
    case "remote.set-enabled": return desktop.setMobileEnabled(effect.enabled);
    /** The offer the QR draws is read back from the bridge state, which is all settings draws. */
    case "remote.create-pairing-code": return desktop.createMobilePairingCode().then(() => desktop.mobileState());
    case "remote.revoke-device": return desktop.revokeMobileDevice(effect.deviceId);
    case "remote.refresh": return desktop.refreshTailscale();
  }
}

/** What main pushes about the bridge, and the phone messages it forwards for the window to answer. */
export function subscribeToMobile(host: MobileBridgeHost, desktop: DesktopAPI): () => void {
  void desktop.mobileState()
    .then((remote) => host.dispatch({ type: "remote.changed", remote }))
    .catch((error) => host.dispatch({ type: "action.failed", message: errorMessage(error) }));
  const stopWatching = desktop.onMobileState((remote) => void host.dispatch({ type: "remote.changed", remote }));
  /** A request is read as a stranger's even across the preload, so a malformed one is never answered. */
  const stopAnswering = desktop.onMobileRequest((request) => {
    if (!isMobileRequest(request)) return;
    void answerMobileRequest(host, request).then((response) => desktop.answerMobileRequest(response));
  });
  return () => {
    stopWatching();
    stopAnswering();
  };
}
