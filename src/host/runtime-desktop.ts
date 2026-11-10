import type { KeyValueStorage } from "../application/task-store.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceCommandResult } from "../contracts/workspace-result.js";
import type { WorkspaceState } from "../application/workspace-state.js";
import type { DesktopPorts, ThreadNotice } from "../contracts/ipc.js";
import type { JoinedPorts } from "../contracts/desktop-port.js";
import type { WorkspaceSurfaceEffect } from "../application/workspace-runtime.js";
import type { ComputerLink, DiscoveredComputer } from "../domain/computers.js";
import type { ComputerThreadQuery } from "../contracts/computers.js";

/** The other computers this one reaches, held by the host process along with the tokens that get it in. */
export type ComputerDesktop = {
  /** Looks across the tailnet for computers running this app. */
  discoverComputers(): Promise<DiscoveredComputer[]>;
  /** Trades the code the other computer shows for a token of this computer's own, and opens the line. */
  pairComputer(host: string, name: string, code: string): Promise<void>;
  forgetComputer(id: string): Promise<void>;
  /** Dials a paired computer now, or every one when none is named, without waiting out the pause between tries. */
  reconnectComputer(id?: string): Promise<void>;
  /** What this computer calls itself to the others from now on, told to every computer on the line. */
  renameComputer(name: string): Promise<void>;
  /** What this computer calls a paired one, kept here whatever that computer announces. */
  labelComputer(id: string, name: string): Promise<void>;
  /** Carries inputs to a paired computer's own reducer, answering with what it said. */
  sendToComputer(id: string, inputs: WorkspaceInput[]): Promise<WorkspaceCommandResult>;
  queryComputerThreads(id: string, query: ComputerThreadQuery): Promise<unknown>;
  /** The paired computers and where each line stands, pushed whenever any of it moves. */
  onComputersChanged(listener: (name: string, links: ComputerLink[]) => void): () => void;
  /** A paired computer's whole state, pushed as it changes there. */
  onComputerState(listener: (id: string, state: WorkspaceState) => void): () => void;
  /** A notice a paired computer raised, which this desktop carries as one of its own. */
  onComputerNotice(listener: (id: string, notice: ThreadNotice) => void): () => void;
};

/**
 * What the runtime asks of the machine it runs on: the desktop API less everything only a window on
 * screen uses, such as file drops, the terminal's own output, and the keystrokes a window hears.
 */
export type RuntimeDesktop = JoinedPorts<DesktopPorts, "runtime"> & ComputerDesktop;

/** Where the runtime runs: the desktop it acts on, where it keeps what a window remembers, and the window itself when there is one. */
export type WorkspaceRuntimeHost = {
  desktop: RuntimeDesktop;
  /** Drafts and view preferences, which outlive the runtime and are read back at the next start. */
  storage: KeyValueStorage;
  /** How wide the window is, which is what the panels default against on a first launch. Absent without a window. */
  viewportWidth?: number;
  /** Carries out an effect that lives in a window's own views. Absent without a window, which drops it. */
  surface?: (effect: WorkspaceSurfaceEffect) => void;
  /**
   * Holds a run's reports until the next paint, so a frame folds them in together. A host without a
   * window has no paint to wait for and gathers them for a moment instead.
   */
  frame?: (flush: () => void) => () => void;
};
