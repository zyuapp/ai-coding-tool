import { computerAddress, type ComputerFilter } from "../domain/computers.js";
import { optionalText, text, type Declarations, type Validator } from "./command-declaration.js";

/**
 * Other computers running this app, reached over the tailnet the way a phone reaches this one.
 * Pairing takes the code the other computer shows; from then on its threads are listed here.
 */
export type ComputerCommand =
  /** Looks across the tailnet for computers running this app. */
  | { type: "computers.discover" }
  | { type: "computers.pair"; host: string; name: string; code: string }
  | { type: "computers.cancel-pairing" }
  | { type: "computers.forget"; id: string }
  /** Dials a paired computer now, or every one that is not connected, even one that refused the last try. */
  | { type: "computers.reconnect"; id?: string }
  /** What this computer calls itself to the others. Empty goes back to the machine's own name. */
  | { type: "computers.rename"; name: string }
  /** What this computer calls a paired one. Empty goes back to what that computer calls itself. */
  | { type: "computers.label"; id: string; name: string }
  /** Which computers' threads the sidebar draws. */
  | { type: "computers.filter"; filter: ComputerFilter };

/** A host, with an optional port, already in the form it is dialled in. */
const hostAddress: Validator<string> = (value): value is string => typeof value === "string" && computerAddress(value) === value;

export const computerCommands = {
  "computers.discover": { fields: {}, at: "local" },
  "computers.pair": { fields: { host: hostAddress, name: text, code: text }, at: "local" },
  "computers.cancel-pairing": { fields: {}, at: "local" },
  "computers.forget": { fields: { id: text }, at: "local" },
  "computers.reconnect": { fields: { id: optionalText }, at: "local" },
  "computers.rename": { fields: { name: text }, at: "local" },
  "computers.label": { fields: { id: text, name: text }, at: "local" },
  "computers.filter": { fields: { filter: text }, at: "local" },
} satisfies Declarations<ComputerCommand>;
