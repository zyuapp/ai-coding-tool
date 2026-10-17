/**
 * The rules a new thread starts by, whoever asks for it: what it runs on, whom it works under, and
 * where it starts. One function holds them, so a thread a run starts and one started any other way
 * for a coordinator cannot drift apart.
 */
import type { WorkspaceState } from "./workspace-state.js";
import { computerOfPlace, projectOnComputer, type PairedComputer } from "./computers.js";
import { projectFor, worktreeById } from "./thread-location.js";
import { WORKTREE_ELSEWHERE_ERROR, WORKTREE_MISSING_ERROR } from "./workspace-reducer/errors.js";
import type { AppCommand } from "../contracts/commands.js";
import { coordinatorOf, isCoordinator, remoteLeadOf, threadModelOf, undelegable, type ProposalPlace, type ProposalRequest, type ThreadProposal } from "../domain/coordination.js";
import { findProject } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { defaultEffortFor, defaultModelFor, effortForModel, engineForModel, modelDelegable, modelHasEffort, modelTakesEffort } from "../domain/agent-engine.js";

export type NewThreadSend = Extract<AppCommand, { type: "task.send" }>;

/**
 * A send ready to start here, a refusal, or a send for the paired computer the thread belongs on.
 * One for elsewhere names the coordinator it would work under, which the user allows there first,
 * and carries none of this computer's places or threads.
 */
export type NewThreadStart =
  | { command: NewThreadSend; elsewhere?: undefined }
  | { error: string; elsewhere?: undefined }
  | { elsewhere: PairedComputer; command: NewThreadSend; lead?: Thread };

/** A thread under a coordinator on another computer cannot ask that coordinator's user to allow a start, so it starts threads only here. */
export const REMOTE_LED_HERE = "This thread works under a coordinator on another computer, so the threads it starts run on this computer.";

export const BRIEF_REQUIRED = "A coordinator hands every thread it starts a brief: pass intent (the user's own words), doneWhen, and delivers.";

/**
 * What a thread `caller` asks for starts on. A thread that will work under a coordinator, because the
 * coordinator asked or one of its threads did, runs on what the coordinator's threads run on and never
 * on a model they may not; any other inherits the caller's own model and effort. A thread under a
 * coordinator on another computer starts its threads under that coordinator too, on its own model,
 * since what the coordinator's threads run on is that computer's to know. `asked` is the computer the
 * request named: null for this one, absent when it named none.
 */
export function newThreadSend(state: WorkspaceState, caller: Thread, command: NewThreadSend, asked?: PairedComputer | null): NewThreadStart {
  const lead = isCoordinator(caller) ? caller : coordinatorOf(state.threads, caller);
  const remote = lead ? undefined : remoteLeadOf(caller);
  const inherited = lead ? threadModelOf(lead) : { model: caller.model ?? defaultModelFor(caller.engine), effort: caller.effort };
  const model = command.model ?? inherited.model;
  if ((lead || remote) && !modelDelegable(model)) return { error: undelegable(model) };
  if (command.effort && !modelHasEffort(model, command.effort)) return { error: `The ${model} model does not support ${command.effort} effort.` };
  /** An inherited effort the new model does not take drops to the nearest one it does. */
  const effort = command.effort ?? effortForModel(model, inherited.effort ?? defaultEffortFor(engineForModel(model)));
  /** A brief is what a coordinator hands the threads it starts, so one any other thread passes is dropped. */
  const { effort: _asked, brief, ...rest } = command;
  const briefed = lead === caller && brief ? { brief } : {};
  const chosen: NewThreadSend = modelTakesEffort(model) ? { ...rest, ...briefed, model, effort } : { ...rest, ...briefed, model };
  /** A coordinator's new thread starts from the brief it was handed. */
  if (lead === caller && !chosen.brief) return { error: BRIEF_REQUIRED };

  /** A new thread asked for on a paired computer, or named into a checkout or project there, is that computer's to start. */
  const placedOn = computerOfPlace(state, chosen) ?? null;
  if (placedOn && asked !== undefined && asked?.id !== placedOn.id) {
    return { error: `That project or worktree is on ${placedOn.name}. Pass computer "${placedOn.name}" to start the thread there.` };
  }
  const elsewhere = asked ?? placedOn;
  if (elsewhere && remote) return { error: REMOTE_LED_HERE };
  if (elsewhere) return { elsewhere, command: chosen, ...(lead ? { lead } : {}) };

  /** With no place named it starts where the caller lives: its project, and its worktree when it has one. */
  const project = chosen.project === undefined && caller.projectId ? { project: caller.projectId } : {};
  const worktree = chosen.worktree === undefined && chosen.worktreeId === undefined && caller.worktreeId ? { worktreeId: caller.worktreeId } : {};
  /** It works under the lead, and its first message names the thread that sent it. */
  const under = lead ? { coordinatorId: lead.id } : remote ? { lead: remote } : {};
  return { command: { ...chosen, ...project, ...worktree, ...under, from: caller.id } };
}

/**
 * A thread `caller` asks its coordinator's user for, checked now by the rules its start will be, and
 * placed in the project and checkout that start resolves to, or why it cannot be. A coordinator
 * suggests threads here or on `asked`, a paired computer; a thread under it asks only for one on a
 * paired computer, which the user allows there. Only a model and effort that were named are kept, so
 * starting it later runs on what the coordinator's threads run on by then.
 */
export function threadProposal(state: WorkspaceState, caller: Thread, request: ProposalRequest, at: number, asked?: PairedComputer | null): { proposal: ThreadProposal } | { error: string } {
  const { title, prompt, computer: _named, ...rest } = request;
  const start = newThreadSend(state, caller, { type: "task.send", text: prompt, ...rest }, asked);
  if ("error" in start) return start;
  const agent = {
    ...(request.model ? { model: request.model } : {}),
    ...(request.effort ? { effort: request.effort } : {}),
    ...(request.role ? { role: request.role } : {}),
  };
  if (start.elsewhere) {
    if (!start.lead) return { error: "Only a coordinator and the threads under it ask for threads on another computer." };
    const placed = elsewherePlace(state, caller, start.elsewhere, start.command);
    if ("error" in placed) return placed;
    const { command } = start;
    return {
      proposal: {
        id: crypto.randomUUID(),
        title: title.trim(),
        prompt,
        ...(command.brief ? { brief: command.brief } : {}),
        place: placed.place,
        ...agent,
        ...(caller.id === start.lead.id ? {} : { from: caller.id }),
        proposedAt: at,
      },
    };
  }
  const { command } = start;
  if (!command.brief) return { error: BRIEF_REQUIRED };
  const named = command.project === undefined ? undefined : findProject(state.projects, command.project);
  if (named && "error" in named) return named;
  const worktree = worktreeById(state, command.worktreeId);
  if (command.worktreeId && !worktree) return { error: WORKTREE_MISSING_ERROR };
  if (worktree && named && named.project.id !== worktree.projectId) return { error: WORKTREE_ELSEWHERE_ERROR };
  const project = named?.project.id ?? worktree?.projectId;
  /** Whether it gets a checkout of its own is said either way, so starting it never moves into one the coordinator entered since. */
  const place: ProposalPlace = { ...(project ? { project } : {}), ...(worktree ? { worktreeId: worktree.id } : { worktree: command.worktree === true }) };
  return {
    proposal: {
      id: crypto.randomUUID(),
      title: title.trim(),
      prompt,
      brief: command.brief,
      place,
      ...agent,
      proposedAt: at,
    },
  };
}

/**
 * Where on a paired computer a thread asked for there starts: the project there its start names, or
 * the one matching the asking thread's own, and whether it gets a worktree of its own there. A
 * checkout that computer already has is its own to name, so asking for one is refused.
 */
function elsewherePlace(state: WorkspaceState, caller: Thread, computer: PairedComputer, command: NewThreadSend): { place: ProposalPlace } | { error: string } {
  if (command.worktreeId !== undefined) return { error: `A worktree already on ${computer.name} cannot be named. Pass worktree: true for a new one there.` };
  const found = projectOnComputer(computer, command.project, projectFor(state, caller));
  if ("error" in found) return found;
  return { place: { computer: { id: computer.id, name: computer.name }, project: found.project.id, worktree: command.worktree === true } };
}

/** The send a suggestion asks for, as the lead would have started it, in the place it was suggested for. */
export function proposalSend(proposal: ThreadProposal): NewThreadSend {
  const { place } = proposal;
  return {
    type: "task.send",
    text: proposal.prompt,
    ...(proposal.brief ? { brief: proposal.brief } : {}),
    ...(place.project === undefined ? {} : { project: place.project }),
    ...(place.worktreeId ? { worktreeId: place.worktreeId } : place.worktree === undefined ? {} : { worktree: place.worktree }),
    ...(proposal.model ? { model: proposal.model } : {}),
    ...(proposal.effort ? { effort: proposal.effort } : {}),
    ...(proposal.role ? { role: proposal.role } : {}),
  };
}
