import { emptyMobileServerState, type MobileServerState } from "../../domain/mobile.js";

export type RemoteState = {
  /** The bridge a phone reaches this Mac through, as the main process last reported it. */
  remote: MobileServerState;
  /** True while main is reading Tailscale, which the Phone page says out loud. */
  remoteChecking: boolean;
};

export function initialRemoteState(): RemoteState {
  return { remote: emptyMobileServerState(), remoteChecking: false };
}
