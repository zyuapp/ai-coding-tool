import type { RemoteCommand } from "../contracts/commands.js";
import type { MobileServerState } from "../domain/mobile.js";
import type { WorkspaceState } from "./workspace-state.js";

/**
 * The bridge a phone reaches this Mac through. The socket, the paired tokens and Tailscale all live
 * in the main process, so every command here is described and never done, and what main answers with
 * is the only thing that writes the bridge into state.
 */
export type RemoteEvent = { type: "remote.changed"; remote: MobileServerState };

/** Each of these answers with the whole bridge state, so nothing downstream infers what it did. */
export type RemoteEffect = RemoteCommand;

export type RemoteInput = RemoteCommand | RemoteEvent;

export type RemoteTransition = { state: WorkspaceState; effects: RemoteEffect[] };

/** Everything about the bridge is named `remote.`, so one test sorts the whole family out of the way. */
export function isRemoteInput(input: { type: string }): input is RemoteInput {
  return input.type.startsWith("remote.");
}

export function reduceRemote(state: WorkspaceState, input: RemoteInput): RemoteTransition {
  if (input.type === "remote.changed") return { state: { ...state, remote: input.remote }, effects: [] };
  /** A read changes nothing, so it leaves whatever the window last said on screen. */
  if (input.type === "remote.refresh") return { state, effects: [input] };
  return { state: { ...state, actionError: null }, effects: [input] };
}
