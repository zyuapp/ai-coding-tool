import type { ComputerCommand } from "../contracts/commands.js";
import type { ComputerLink, DiscoveredComputer } from "../domain/computers.js";
import { remoteNotices, type PairedComputer } from "./computers.js";
import { withAnnotations, withPastes } from "./composer-drafts.js";
import { announcedNotice } from "./notices.js";
import { threadOnScreen } from "./thread-attention.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./workspace-reducer.js";
import type { WorkspaceState } from "./workspace-state.js";

/** What the host process says about the paired computers: who is paired, and what each one's workspace now is. */
export type ComputerEvent =
  | { type: "computers.changed"; name: string; links: ComputerLink[] }
  | { type: "computers.found"; found: DiscoveredComputer[] }
  | { type: "computers.search-failed"; message: string }
  | { type: "computers.pair-failed"; message: string }
  /** A paired computer's whole state as it now stands. */
  | { type: "computer.state"; id: string; state: WorkspaceState }
  /** A paired computer took the draft a send carried, so this window lets go of it. */
  | { type: "computers.forwarded"; draftKey: string };

/** The host process holds the lines and the tokens, so every command here is described and never done. */
export type ComputerEffect =
  | { type: "computer.discover" }
  | { type: "computer.pair"; host: string; name: string; code: string }
  | { type: "computer.forget"; id: string }
  /** Inputs on their way to the computer that holds the thread they are about. `draftKey` names the draft a send carries. */
  | { type: "computer.forward"; id: string; inputs: WorkspaceInput[]; draftKey?: string };

export type ComputerInput = ComputerCommand | ComputerEvent;

export function isComputerInput(input: { type: string }): input is ComputerInput {
  return input.type.startsWith("computers.") || input.type === "computer.state";
}

/** The draft a paired computer has taken: its text and what rode with it are let go of here. */
function withoutDraft(state: WorkspaceState, key: string): WorkspaceState {
  const { [key]: _taken, ...prompts } = state.prompts;
  return withPastes(withAnnotations({ ...state, prompts }, key, []), key, []);
}

function withComputers(state: WorkspaceState, computers: Partial<WorkspaceState["computers"]>): WorkspaceState {
  return { ...state, computers: { ...state.computers, ...computers } };
}

function settled(state: WorkspaceState, effects: WorkspaceEffect[] = []): WorkspaceTransition {
  return { state, effects };
}

/** The links as the host reports them, each keeping the state this window already holds for it. */
function linked(state: WorkspaceState, links: ComputerLink[]): PairedComputer[] {
  const held = new Map(state.computers.paired.map((computer) => [computer.id, computer]));
  return links.map((link) => {
    const known = held.get(link.id);
    if (known && known.status === link.status && known.error === link.error && known.name === link.name && known.host === link.host) return known;
    return { ...link, state: known?.state ?? null };
  });
}

export function reduceComputers(state: WorkspaceState, input: ComputerInput): WorkspaceTransition {
  const { computers } = state;
  switch (input.type) {
    case "computers.discover":
      return settled(withComputers(state, { searching: true, searchError: null }), [{ type: "computer.discover" }]);
    case "computers.found":
      return settled(withComputers(state, { found: input.found, searching: false, searchError: null }));
    case "computers.search-failed":
      return settled(withComputers(state, { searching: false, searchError: input.message }));
    /** A pair with no code yet opens the card the code is typed into; one with a code sends it. */
    case "computers.pair": {
      const pairing = { host: input.host, name: input.name, busy: input.code !== "", error: null };
      const effects: WorkspaceEffect[] = input.code ? [{ type: "computer.pair", host: input.host, name: input.name, code: input.code }] : [];
      return settled(withComputers(state, { pairing }), effects);
    }
    case "computers.pair-failed":
      return settled(withComputers(state, { pairing: computers.pairing ? { ...computers.pairing, busy: false, error: input.message } : null }));
    case "computers.cancel-pairing":
      return settled(withComputers(state, { pairing: null }));
    case "computers.forget": {
      const active = computers.active === input.id ? null : computers.active;
      const filter = computers.filter === input.id ? "all" : computers.filter;
      return settled(withComputers(state, { active, filter }), [{ type: "computer.forget", id: input.id }]);
    }
    case "computers.filter":
      return settled(withComputers(state, { filter: input.filter }));
    case "computers.forwarded":
      return settled(withoutDraft(state, input.draftKey));
    case "computers.changed": {
      const paired = linked(state, input.links);
      /** A pairing that now shows up as a link is done; one that went away takes the screen with it. */
      const pairing = computers.pairing && paired.some((computer) => computer.host === computers.pairing?.host) ? null : computers.pairing;
      const active = computers.active !== null && paired.some((computer) => computer.id === computers.active) ? computers.active : null;
      const filter = computers.filter === "all" || computers.filter === "this" || paired.some((computer) => computer.id === computers.filter) ? computers.filter : "all";
      return settled(withComputers(state, { name: input.name, paired, pairing, active, filter }));
    }
    case "computer.state": {
      const computer = computers.paired.find((item) => item.id === input.id);
      if (!computer) return settled(state);
      const next = withComputers(state, { paired: computers.paired.map((item) => item === computer ? { ...item, state: input.state } : item) });
      const onScreen = (taskId: string) => computers.active === computer.id && state.focused && threadOnScreen({ ...input.state, computers: { active: null } }, taskId);
      const effects = remoteNotices(computer.state, input.state, onScreen).flatMap((notice) => announcedNotice(state, notice));
      return settled(next, effects);
    }
  }
}
