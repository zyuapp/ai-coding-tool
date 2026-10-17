/**
 * The rules a new thread starts by, whoever asks for it: what it runs on, whom it works under, and
 * where it starts. One function holds them, so a thread a run starts and one started any other way
 * for a coordinator cannot drift apart.
 */
import type { WorkspaceState } from "./workspace-state.js";
import { computerOfPlace, type PairedComputer } from "./computers.js";
import { worktreeById } from "./thread-location.js";
import { WORKTREE_ELSEWHERE_ERROR, WORKTREE_MISSING_ERROR } from "./workspace-reducer/errors.js";
import type { AppCommand } from "../contracts/commands.js";
import { coordinatorOf, isCoordinator, threadModelOf, undelegable, type ProposalPlace, type ProposalRequest, type ThreadProposal } from "../domain/coordination.js";
import { findProject } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { defaultEffortFor, defaultModelFor, effortForModel, engineForModel, modelDelegable, modelHasEffort, modelTakesEffort } from "../domain/agent-engine.js";

export type NewThreadSend = Extract<AppCommand, { type: "task.send" }>;

/**
 * A send ready to start here, a refusal, or a send for the paired computer the thread belongs on.
 * One for elsewhere names the coordinator it would work under, and carries none of this computer's
 * places or threads.
 */
export type NewThreadStart =
  | { command: NewThreadSend; elsewhere?: undefined }
  | { error: string; elsewhere?: undefined }
  | { elsewhere: PairedComputer; command: NewThreadSend; lead?: Thread };

export const COORDINATED_HERE = "A coordinator and the threads under it start threads only on their own computer.";

export const BRIEF_REQUIRED = "A coordinator hands every thread it starts a brief: pass intent (the user's own words), doneWhen, and delivers.";

/**
 * What a thread `caller` asks for starts on. A thread that will work under a coordinator, because the
 * coordinator asked or one of its threads did, runs on what the coordinator's threads run on and never
 * on a model they may not; any other inherits the caller's own model and effort. `asked` is the
 * computer the request named: null for this one, absent when it named none.
 */
export function newThreadSend(state: WorkspaceState, caller: Thread, command: NewThreadSend, asked?: PairedComputer | null): NewThreadStart {
  const lead = isCoordinator(caller) ? caller : coordinatorOf(state.threads, caller);
  const inherited = lead ? threadModelOf(lead) : { model: caller.model ?? defaultModelFor(caller.engine), effort: caller.effort };
  const model = command.model ?? inherited.model;
  if (lead && !modelDelegable(model)) return { error: undelegable(model) };
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
  if (elsewhere) return { elsewhere, command: chosen, ...(lead ? { lead } : {}) };

  /** With no place named it starts where the caller lives: its project, and its worktree when it has one. */
  const project = chosen.project === undefined && caller.projectId ? { project: caller.projectId } : {};
  const worktree = chosen.worktree === undefined && chosen.worktreeId === undefined && caller.worktreeId ? { worktreeId: caller.worktreeId } : {};
  /** It works under the lead, and its first message names the thread that sent it. */
  return { command: { ...chosen, ...project, ...worktree, ...(lead ? { coordinatorId: lead.id } : {}), from: caller.id } };
}

/**
 * A thread `lead` suggests, checked now by the rules its start will be, and placed in the project and
 * checkout that start resolves to, or why it cannot be suggested. Only a model and effort the lead
 * named are kept, so starting it later runs on what the lead's threads run on by then.
 */
export function threadProposal(state: WorkspaceState, lead: Thread, request: ProposalRequest, at: number): { proposal: ThreadProposal } | { error: string } {
  const { title, prompt, ...asked } = request;
  const start = newThreadSend(state, lead, { type: "task.send", text: prompt, ...asked });
  if ("error" in start) return start;
  if (start.elsewhere) return { error: COORDINATED_HERE };
  const { command } = start;
  if (!command.brief) return { error: BRIEF_REQUIRED };
  const named = command.project === undefined ? undefined : findProject(state.projects, command.project);
  if (named && "error" in named) return named;
  const worktree = worktreeById(state, command.worktreeId);
  if (command.worktreeId && !worktree) return { error: WORKTREE_MISSING_ERROR };
  if (worktree && named && named.project.id !== worktree.projectId) return { error: WORKTREE_ELSEWHERE_ERROR };
  const project = named?.project.id ?? worktree?.projectId;
  /** Whether it gets a checkout of its own is said either way, so starting it never falls back to the user's draft. */
  const place: ProposalPlace = { ...(project ? { project } : {}), ...(worktree ? { worktreeId: worktree.id } : { worktree: command.worktree === true }) };
  return {
    proposal: {
      id: crypto.randomUUID(),
      title: title.trim(),
      prompt,
      brief: command.brief,
      place,
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.role ? { role: request.role } : {}),
      proposedAt: at,
    },
  };
}

/** The send a suggestion asks for, as the lead would have started it, in the place it was suggested for. */
export function proposalSend(proposal: ThreadProposal): NewThreadSend {
  const { place } = proposal;
  return {
    type: "task.send",
    text: proposal.prompt,
    brief: proposal.brief,
    ...(place.project === undefined ? {} : { project: place.project }),
    ...(place.worktreeId ? { worktreeId: place.worktreeId } : place.worktree === undefined ? {} : { worktree: place.worktree }),
    ...(proposal.model ? { model: proposal.model } : {}),
    ...(proposal.effort ? { effort: proposal.effort } : {}),
    ...(proposal.role ? { role: proposal.role } : {}),
  };
}
