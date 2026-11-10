import { literals, optional, optionalText, text, type Declarations } from "./command-declaration.js";
import type { PhoneRule } from "./phone-commands.js";

/**
 * The thread's checkout, handed to another application on the machine. Only the user asks for this,
 * so it never appears in `ExternalCommand`: a run has the folder already.
 */
export type ExternalAppCommand =
  /** The applications this machine has, read again whenever a list of them is opened. */
  | { type: "app.list" }
  | { type: "app.open-folder"; appId: string }
  /** Asks the updater to look now. `quiet` is a phone's look, which shows nothing on this screen. */
  | { type: "app.check-for-updates"; quiet?: true }
  /** Downloads the newer build a check found. */
  | { type: "app.download-update" }
  /** Quits and installs the downloaded build. */
  | { type: "app.install-update" }
  /**
   * Moves the named computer, or this one, to the newest build: downloading it, then installing once
   * nothing runs there, then upgrading any engine the new build needs.
   */
  | { type: "app.update"; computerId?: string }
  /** Drops an update still waiting for the computer's threads to finish. */
  | { type: "app.cancel-update"; computerId?: string }
  /** Opens the notices shipped with this exact build in the system text viewer. */
  | { type: "app.open-source-licenses" };

/** The app on this computer, never one on a computer the desktop is linked to. */
const updatesHere: PhoneRule = (command) => command.computerId === undefined;

/** A phone looks for a newer build without a dialog, since nobody may be at the computer to close one. */
const checksQuietly: PhoneRule = (command) => command.quiet === true;

export const externalAppCommands = {
  "app.list": { fields: {}, at: "local" },
  "app.open-folder": { fields: { appId: text }, at: "own" },
  "app.check-for-updates": { fields: { quiet: optional(literals(true)) }, at: "local", phone: checksQuietly },
  "app.download-update": { fields: {}, at: "local" },
  "app.install-update": { fields: {}, at: "local" },
  "app.update": { fields: { computerId: optionalText }, at: "own", phone: updatesHere },
  "app.cancel-update": { fields: { computerId: optionalText }, at: "own", phone: updatesHere },
  "app.open-source-licenses": { fields: {}, at: "local" },
} satisfies Declarations<ExternalAppCommand>;
