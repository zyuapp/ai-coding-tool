import type { ComputerCommand } from "../contracts/commands.js";
import type { ThreadNotice } from "../contracts/ipc.js";
import { MAX_COMPUTER_NAME, type ComputerLink, type DiscoveredComputer } from "../domain/computers.js";
import type { PairedComputer, SentDraft } from "./computers.js";
import { annotationsFor, imagesFor, pastesFor, withAnnotations, withImages, withPastes } from "./composer-drafts.js";
import { announcedNotice } from "./notices.js";
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
  /** What a paired computer would have put on its own desktop: it judged the run news, this one only carries it. */
  | { type: "computer.notice"; id: string; notice: ThreadNotice }
  /** A paired computer took the draft a send carried, so this window lets go of it. */
  | { type: "computers.forwarded"; draft: SentDraft };

/** The host process holds the lines and the tokens, so every command here is described and never done. */
export type ComputerEffect =
  | { type: "computer.discover" }
  | { type: "computer.pair"; host: string; name: string; code: string }
  | { type: "computer.forget"; id: string }
  /** What this computer will call itself, or a paired one, from now on. Empty goes back to the default. */
  | { type: "computer.rename"; name: string }
  | { type: "computer.label"; id: string; name: string }
  /** Inputs on their way to the computer that holds the thread they are about, with the draft a send carries. */
  | { type: "computer.forward"; id: string; inputs: WorkspaceInput[]; draft?: SentDraft };

export type ComputerInput = ComputerCommand | ComputerEvent;

export function isComputerInput(input: { type: string }): input is ComputerInput {
  return input.type.startsWith("computers.") || input.type === "computer.state" || input.type === "computer.notice";
}

/** What a paired computer has taken is let go of here; what was typed after it went stays. */
function withoutSent(state: WorkspaceState, draft: SentDraft): WorkspaceState {
  const { key } = draft;
  const typed = state.prompts[key] ?? "";
  const kept = typed === draft.prompt ? "" : typed.startsWith(draft.prompt) ? typed.slice(draft.prompt.length).trimStart() : typed;
  const { [key]: _sent, ...rest } = state.prompts;
  const prompts = kept ? { ...rest, [key]: kept } : rest;
  const annotations = annotationsFor(state, key).filter((annotation) => !draft.annotations.some((sent) => sent.id === annotation.id && sent.note === annotation.note));
  const pastes = pastesFor(state, key).filter((paste) => !draft.pastes.some((sent) => sent.id === paste.id));
  let next = withPastes(withAnnotations({ ...state, prompts }, key, annotations), key, pastes);
  if (draft.attachments) {
    const { key: composer, ids } = draft.attachments;
    next = withImages(next, key, imagesFor(next, key).filter((image) => !ids.includes(image.id)));
    next = { ...next, attachmentSends: { ...next.attachmentSends, [composer]: { busy: false, error: null, sent: ids } } };
  }
  return next;
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
    /** The name shows at once when there is one; an empty one is the host's to fill in and announce. */
    case "computers.rename": {
      const name = input.name.trim().slice(0, MAX_COMPUTER_NAME);
      return settled(name ? withComputers(state, { name }) : state, [{ type: "computer.rename", name }]);
    }
    case "computers.label": {
      if (!computers.paired.some((computer) => computer.id === input.id)) return settled(state);
      const name = input.name.trim().slice(0, MAX_COMPUTER_NAME);
      const paired = name ? computers.paired.map((computer) => computer.id === input.id ? { ...computer, name } : computer) : computers.paired;
      return settled(withComputers(state, { paired }), [{ type: "computer.label", id: input.id, name }]);
    }
    case "computers.filter":
      return settled(withComputers(state, { filter: input.filter }));
    case "computers.forwarded":
      return settled(withoutSent(state, input.draft));
    case "computers.changed": {
      const paired = linked(state, input.links);
      /** A pairing that now shows up as a link is done; one that went away, or whose line dropped, takes the screen with it. */
      const pairing = computers.pairing && paired.some((computer) => computer.host === computers.pairing?.host) ? null : computers.pairing;
      const active = computers.active !== null && paired.some((computer) => computer.id === computers.active && computer.status === "connected") ? computers.active : null;
      const filter = computers.filter === "all" || computers.filter === "this" || paired.some((computer) => computer.id === computers.filter) ? computers.filter : "all";
      return settled(withComputers(state, { name: input.name, paired, pairing, active, filter }));
    }
    case "computer.state": {
      const computer = computers.paired.find((item) => item.id === input.id);
      if (!computer) return settled(state);
      return settled(withComputers(state, { paired: computers.paired.map((item) => item === computer ? { ...item, state: input.state } : item) }));
    }
    case "computer.notice":
      return settled(state, computers.paired.some((computer) => computer.id === input.id) ? announcedNotice(state, input.notice) : []);
  }
}
