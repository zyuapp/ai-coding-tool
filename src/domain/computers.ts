/**
 * The vocabulary for computers that run this app for each other: what one on the tailnet looks
 * like before pairing, and what a paired one is while this computer holds its threads beside its own.
 */

/** Where a paired computer's line stands. Offline keeps its threads on screen, greyed and untouchable. */
export type ComputerStatus = "connecting" | "connected" | "offline";

/** A computer on the tailnet that answered the app's own health check. */
export type DiscoveredComputer = {
  /** The MagicDNS name, which is what the app dials. */
  host: string;
  /** What the machine calls itself. */
  name: string;
  os: string;
};

/** A computer this one has paired with. The token that gets it in stays in the host process's own file. */
export type ComputerLink = {
  id: string;
  name: string;
  host: string;
  status: ComputerStatus;
  /** Why the line is down, when the last attempt could say. */
  error: string | null;
  pairedAt: number;
};

/** The pairing Settings has open: which computer, whether the code is on its way, and what the last one earned. */
export type ComputerPairing = {
  host: string;
  name: string;
  busy: boolean;
  error: string | null;
};

/** Which computers' threads the sidebar draws: every one, this one, or one paired computer by id. */
export type ComputerFilter = "all" | "this" | string;

/** What a computer calls itself to the others: the machine's own name, which is how its rows are tagged. */
export const MAX_COMPUTER_NAME = 128;

export function isComputerStatus(value: unknown): value is ComputerStatus {
  return value === "connecting" || value === "connected" || value === "offline";
}
