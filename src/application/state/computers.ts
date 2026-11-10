import type { ComputerFilter, ComputerLink, ComputerPairing, DiscoveredComputer } from "../../domain/computers.js";
import type { WorkspaceState } from "../workspace-state.js";
import { frontDock } from "../workspace-dock.js";

/** A paired computer as this one holds it: the link, and the last state it published. */
export type PairedComputer = ComputerLink & { state: WorkspaceState | null };

export type ComputersState = {
  /** What this computer calls itself, which is how a paired computer tags this one's rows. */
  name: string;
  /** Computers on the tailnet that answered, as of the last look. */
  found: DiscoveredComputer[];
  searching: boolean;
  searchError: string | null;
  paired: PairedComputer[];
  pairing: ComputerPairing | null;
  /** The paired computer whose thread the conversation is showing. Null for this computer's own. */
  active: string | null;
  /** The paired computer that was on screen when its line dropped, put back once it is up again unless the window has moved on. */
  dropped: string | null;
  filter: ComputerFilter;
  /**
   * Coordinators gone from here, cleared from the archive or outliving their time in it, whose threads
   * on paired computers are let go once each computer says it still holds one. Kept between launches,
   * newest last.
   */
  discardedLeads: string[];
};

/** How many coordinators gone from here are remembered for threads elsewhere that may still work under them. */
export const MAX_DISCARDED_LEADS = 50;

export const NO_COMPUTERS: ComputersState = { name: "", found: [], searching: false, searchError: null, paired: [], pairing: null, active: null, dropped: null, filter: "all", discardedLeads: [] };

export type ComputersSliceState = {
  /** The computers this one is paired with, each mirrored here as it changes there. Session-only. */
  computers: ComputersState;
};

export function initialComputersState(): ComputersSliceState {
  return { computers: NO_COMPUTERS };
}

/** The paired computer whose thread is on screen, while its line is up. One whose line is down shows nothing and takes nothing. */
export function activeComputer(state: ComputersSliceState): PairedComputer | null {
  const { active, paired } = state.computers;
  const computer = active === null ? null : paired.find((computer) => computer.id === active) ?? null;
  return computer?.status === "connected" ? computer : null;
}

/** `id` while it names a paired computer, else null. */
export function pairedId(computers: Pick<ComputersState, "paired">, id: string | null): string | null {
  return id !== null && computers.paired.some((computer) => computer.id === id) ? id : null;
}

/** The selected host may stay on screen offline while its terminal waits to reconnect. */
export function selectedComputer(state: ComputersSliceState): PairedComputer | null {
  const computer = state.computers.paired.find((computer) => computer.id === state.computers.active);
  if (!computer) return null;
  if (computer.status === "connected") return computer;
  const dock = computer.state ? frontDock(computer.state).dock : null;
  return dock?.open && dock.terminals.some((terminal) => terminal.id === dock.tab) ? computer : null;
}
