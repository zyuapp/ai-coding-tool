import { boolean, text, type Declarations } from "./command-declaration.js";

/**
 * The desktop settings screen driving the bridge a phone reaches this Mac through. Every one of
 * these is the user's own: a phone changes threads, never the door it came in by. Not to be confused
 * with `MobileCommand` in contracts/mobile.ts, which is what a phone is allowed to send.
 */
export type RemoteCommand =
  | { type: "remote.set-enabled"; enabled: boolean }
  /** Mints the code the QR carries. Minting a second one discards the first. */
  | { type: "remote.create-pairing-code" }
  | { type: "remote.revoke-device"; deviceId: string }
  /** Asks Tailscale again whether it is installed, signed in, and what this machine is called. */
  | { type: "remote.refresh" };

export const remoteCommands = {
  "remote.set-enabled": { fields: { enabled: boolean }, at: "local" },
  "remote.create-pairing-code": { fields: {}, at: "local" },
  "remote.revoke-device": { fields: { deviceId: text }, at: "local" },
  "remote.refresh": { fields: {}, at: "local" },
} satisfies Declarations<RemoteCommand>;
