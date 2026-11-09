import { deriveView, type QueuedMessage, type WorkspaceState } from "./workspace-state.js";
import { clipText, labelOf, threadSummaries, threadTranscript } from "./thread-projection.js";
import { projectName, type Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { hasUnreadAttention, newestUnreadFinding } from "../domain/attention.js";
import { DEFAULT_BRANCH_RANGE } from "../domain/diff.js";
import { themeFor, themeOrDefault } from "../domain/theme.js";
import { worktreeName } from "../domain/worktree.js";
import { orderThreads } from "./thread-order.js";
import { worktreeChoices } from "./worktree-choices.js";
import { coordinationMembers, coordinatorRoster, memberActivity, ownCoordinationSections, rowHeadline, waitingLine } from "./coordination.js";
import { computerOfThread, selectedComputer, type PairedComputer } from "./computers.js";
import { isUsersOwn } from "../domain/message-origin.js";
import { drainingQueued } from "./workspace-reducer/run-queue.js";
import { describeToolCall } from "../domain/tool-call.js";
import { deliveryLabel, isCoordinator } from "../domain/coordination.js";
import type { CoordinationDecisionView, ProposalView } from "./coordination-view.js";
import { ARCHIVE_RETENTION_MS } from "../domain/thread-retention.js";
import type { ConversationMessage } from "../domain/conversation.js";
import { mayLinkImages } from "../domain/message-artifacts.js";
import { threadActivity, type ThreadActivity } from "./thread-activity.js";
import { projectFor, threadWorkspaceId } from "./thread-location.js";
import { diffFor } from "./workspace-diff.js";
import { workspaceViewCollections } from "./workspace-view-collections.js";
import { barShare, NEAR_LIMIT_SHARE, planLabel, sessionAndWeek, tightestWindow, usageWarningKey, windowsFor, windowSpan, type UsageWindow } from "../domain/plan-usage.js";
import { AGENT_EFFORTS, AGENT_ENGINES, BUILT_IN_MODELS, byEngine, capabilitiesFor, efforts, engineCatalog, engineLabel, modelLabel, offeredPolicies, type AgentEngine, type EngineReadiness, type EngineStatus, type ModelCatalog } from "../domain/agent-engine.js";
import { orderSubagents, POLICIES, processLabel, subagentLine, type BackgroundProcess, type Subagent } from "../domain/run.js";
import { workflowLabel, type Workflow } from "../domain/workflow.js";
import { THREAD_ROLES } from "../domain/thread-role.js";
import { ownUpkeep } from "./computer-updates.js";
import { isPhoneCommand } from "../contracts/workspace-view-input.js";
import type {
  MobileActivity,
  MobileArchivedThread,
  MobileDecision,
  MobileSuggestion,
  MobileBackgroundItem,
  MobileChanges,
  MobileComposerUsage,
  MobileDraftView,
  MobileEngineUsage,
  MobileEngine,
  MobileEngines,
  MobileLocation,
  MobileMember,
  MobileMessage,
  MobileRunStatus,
  MobileThreadRead,
  MobileToolCall,
  MobilePatch,
  MobileProjectGroup,
  MobileTheme,
  MobileThreadDelta,
  MobileThreadEntry,
  MobileThreadView,
  MobileUpkeepItem,
  MobileUsage,
  MobileUsageWindow,
  MobileView,
  MobileVocabulary,
  MobileWorktreeChoice,
} from "../contracts/mobile.js";

/**
 * The phone's view, derived from workspace state alone, and the difference between two of them.
 * Nothing here reads state the desktop does not already derive, so a phone and the window in front
 * of the user can never disagree about what a thread is doing.
 */

/** How many threads the list carries. Far more than a phone scrolls, and still bounded. */
export const MOBILE_THREAD_LIMIT = 100;

/** How many messages of the open thread travel. Each one is cut to length by the transcript itself. */
export const MOBILE_TRANSCRIPT_MESSAGES = 40;

/** How much of one message travels: a long reply whole, a pasted log not without end. */
export const MOBILE_MESSAGE_TEXT_LIMIT = 40_000;

/** How many of the open thread's workflows, processes and subagents travel, live ones first. */
export const MOBILE_BACKGROUND_LIMIT = 100;

/** How much of a background item's line is carried; the phone shows two lines of it. */
export const MOBILE_BACKGROUND_DETAIL_LIMIT = 300;

/** How much of an approval's tool input is carried. Enough to judge it, never a whole file. */
export const MOBILE_APPROVAL_DETAIL_LIMIT = 4_000;

/** How many open decisions the open thread carries; the phone answers them one at a time. */
export const MOBILE_DECISION_LIMIT = 20;

/** How much of a suggestion's prompt is carried. The phone shows it only on request. */
export const MOBILE_SUGGESTION_PROMPT_LIMIT = 4_000;

export function emptyMobileView(): MobileView {
  return {
    groups: [],
    activity: { priority: [], running: [], threads: [], snoozed: [] },
    theme: { dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark" },
    engines: NO_ENGINES,
    upkeep: [],
    dictation: false,
    usage: NO_USAGE,
    archived: 0,
    thread: null,
    draft: null,
    error: null,
  };
}

const NO_ENGINES: MobileEngines = {};

const NO_USAGE: MobileUsage = { engines: [], composer: null };

const projectedEngines = new WeakMap<EngineStatus, MobileEngines>();

/** The engines as a phone reads them, kept per status so a view that did not read the engines again carries the same ones. */
export function projectMobileEngines(status: EngineStatus | null): MobileEngines {
  if (!status) return NO_ENGINES;
  let engines = projectedEngines.get(status);
  if (!engines) {
    engines = {};
    for (const engine of AGENT_ENGINES) {
      const readiness = status[engine];
      if (!readiness) continue;
      const projected: MobileEngine = { access: readiness.access };
      if (readiness.models) projected.models = [...readiness.models];
      if (readiness.catalog) projected.catalog = readiness.catalog.map((spec) => ({ id: spec.id, label: spec.label, description: spec.description, ...(spec.provider ? { provider: spec.provider } : {}), efforts: spec.efforts.map((effort) => effort.id) }));
      engines[engine] = projected;
    }
    projectedEngines.set(status, engines);
  }
  return engines;
}

/** What this build calls its engines, modes, models and efforts, as a phone app built apart from it reads them. */
export const MOBILE_VOCABULARY: MobileVocabulary = {
  engines: AGENT_ENGINES.map((engine) => ({
    id: engine,
    label: engineLabel(engine),
    fastMode: capabilitiesFor(engine).fastMode,
    policies: offeredPolicies(engine).map((policy) => ({ id: policy, ...POLICIES[policy] })),
    models: BUILT_IN_MODELS.models[engine].map((spec) => ({ id: spec.id, label: spec.label, description: spec.description, ...(spec.provider ? { provider: spec.provider } : {}), efforts: spec.efforts.map((effort) => effort.id) })),
  })),
  efforts: efforts(...AGENT_EFFORTS).map((spec) => ({ ...spec })),
  roles: THREAD_ROLES.map(({ role, label }) => ({ id: role, label })),
};

/** The computer's engines as a phone's pickers read them: the models they offer, and each engine's readiness. */
export type MobileEngineView = { catalog: ModelCatalog; access: Readonly<Record<AgentEngine, EngineReadiness>> };

const engineViews = new WeakMap<MobileEngines, MobileEngineView>();

/** The other half of {@link projectMobileEngines}, kept per engines so a picker reads one stable catalogue. */
export function mobileEngineView(engines: MobileEngines | undefined): MobileEngineView {
  const given = engines ?? NO_ENGINES;
  let read = engineViews.get(given);
  if (!read) {
    /** A phone never measures a model's context, so a model it is sent carries none. */
    const access = byEngine((engine): EngineReadiness => {
      const sent = given[engine];
      return {
        access: sent?.access ?? "ready",
        ...(sent?.models ? { models: sent.models } : {}),
        ...(sent?.catalog ? { catalog: sent.catalog.map((model) => ({ id: model.id, label: model.label, description: model.description, ...(model.provider ? { provider: model.provider } : {}), contextWindow: 0, efforts: efforts(...model.efforts) })) } : {}),
      };
    });
    read = { catalog: engineCatalog(access), access };
    engineViews.set(given, read);
  }
  return read;
}

/** Everything a phone reads, derived from workspace state alone. */
export function projectMobileView(state: WorkspaceState, at: number): MobileView {
  const view = deriveView(state);
  const here = { working: view.runningThreadIds, blocked: view.blockedThreadIds, ranked: workspaceViewCollections(state).everyRanked };
  const summaries = threadSummaries(state, { scope: { kind: "all" }, limit: MOBILE_THREAD_LIMIT }, at);
  const threadsById = new Map(state.threads.map((thread) => [thread.id, thread]));
  const projectsById = new Map(state.projects.map((project) => [project.id, project]));
  const entries = new Map<string | null, MobileThreadEntry[]>();
  const entriesById = new Map<string, MobileThreadEntry>();
  for (const summary of summaries) {
    const key = summary.projectId ?? null;
    const thread = threadsById.get(summary.id);
    const project = summary.projectId ? projectsById.get(summary.projectId) : undefined;
    const finding = thread ? newestUnreadFinding(thread) : undefined;
    /**
     * A coordinator's row speaks for the threads under it, which the phone reaches through it, as the
     * desktop's row does: their approvals, their work going on, and what else waits on the user.
     */
    /** Each thread under it stands as the computer holding it last said, whichever computers the desktop's sidebar shows. */
    const roster = thread ? coordinatorRoster(state, thread, here) : undefined;
    const waiting = roster ? waitingLine(roster.waiting) : null;
    const headline = thread ? rowHeadline(thread, waiting) : null;
    const blocked = view.blockedThreadIds.has(summary.id) || Boolean(roster?.blocked);
    const running = summary.status === "running" || Boolean(roster?.running);
    const entry: MobileThreadEntry = {
      id: summary.id,
      title: summary.title || "Untitled thread",
      projectId: project?.id ?? null,
      projectName: project ? projectName(project) : null,
      status: blocked ? "awaiting-approval" : running ? "running" : summary.status,
      lastActivityAt: summary.lastActivityAt,
      unread: Boolean(thread?.outcomeUnread) || finding !== undefined || Boolean(roster?.threads.some(hasUnreadAttention)),
      ...(thread?.outcome ? { outcome: thread.outcome } : {}),
      ...(headline !== null ? { headline } : {}),
      ...(waiting !== null ? { waiting: true as const } : {}),
      attention: Boolean(roster?.dismissable),
      ...(thread?.snoozedUntil !== undefined ? { snoozedUntil: thread.snoozedUntil } : {}),
    };
    entries.get(key)?.push(entry) ?? entries.set(key, [entry]);
    entriesById.set(entry.id, entry);
  }
  /** Every open project is a group even with nothing in it, because a group is how a phone starts one. */
  const groups: MobileProjectGroup[] = view.projects.map((project) =>
    ({ projectId: project.id, name: projectName(project), threads: rankGroup(entries.get(project.id) ?? [], threadsById) }));
  /** Always last, and always there, because it is the only way to start a thread in no project. */
  groups.push({ projectId: null, name: "Recents", threads: rankGroup(entries.get(null) ?? [], threadsById) });
  const thread = projectMobileThread(state, view, view.stoppableCoordinatorIds);
  return {
    groups,
    activity: projectMobileActivity(state, here, entriesById),
    theme: projectMobileTheme(state),
    engines: projectMobileEngines(state.engineStatus),
    upkeep: projectMobileUpkeep(state),
    dictation: state.dictation.model === "ready",
    usage: projectMobileUsage(state, view),
    archived: workspaceViewCollections(state).archivedThreads.length,
    thread,
    draft: thread ? null : projectMobileDraft(state, view),
    error: state.actionError,
  };
}

const share = (utilization: number | null) => utilization === null ? null : Math.round(barShare(utilization));

/**
 * Every engine's plan for the Usage sheet, and the windows the composer's model spends, as the
 * desktop composer's meter and warning read them.
 */
function projectMobileUsage(state: WorkspaceState, view: ReturnType<typeof deriveView>): MobileUsage {
  const { reports, dismissed } = state.planUsage;
  const drawn = (item: UsageWindow): MobileUsageWindow => ({ id: item.id, label: item.label, share: share(item.utilization), resetsAt: item.resetsAt });
  const engines = AGENT_ENGINES.flatMap((engine): MobileEngineUsage[] => {
    const usage = reports[engine];
    if (usage?.status === "available") return [{ engine, label: engineLabel(engine), plan: planLabel(usage.subscription), windows: usage.windows.map(drawn) }];
    if (usage?.status === "unavailable") return [{ engine, label: engineLabel(engine), plan: null, windows: [], message: usage.message }];
    return [];
  });
  if (!engines.length) return NO_USAGE;
  const spent = view.model === undefined ? [] : windowsFor(reports[view.engine], modelLabel(engineCatalog(state.engineStatus), view.engine, view.model));
  const tightest = tightestWindow(spent);
  let composer: MobileComposerUsage | null = null;
  if (tightest) {
    const { session, week } = sessionAndWeek(spent);
    const rows = session || week ? [session, week].filter((row) => row !== null) : [tightest];
    const key = usageWarningKey(view.engine, tightest);
    const warned = !view.limitPause && tightest.utilization >= NEAR_LIMIT_SHARE && !dismissed.includes(key);
    composer = {
      share: share(tightest.utilization)!,
      meter: rows.map((row) => ({ span: windowSpan(row) ?? row.label, share: share(row.utilization)! })),
      spends: spent.map((item) => item.id),
      warning: warned ? { key, share: share(tightest.utilization)!, window: `${engineLabel(view.engine)} · ${tightest.label}`, resetsAt: tightest.resetsAt } : null,
    };
  }
  return { engines, composer };
}

/** This computer's update rows as the Computers page draws a paired one's, each with a command a phone may send. */
function projectMobileUpkeep(state: WorkspaceState): MobileUpkeepItem[] {
  const installing = state.appUpdateRequest?.status === "installing";
  return ownUpkeep(state).map(({ key, label, version, state: part, action }) => ({
    key, label, version, state: part,
    action: action && isPhoneCommand(action.command) ? { label: action.label, command: action.command } : null,
    ...(installing && key === "app" ? { installing: true as const } : {}),
  }));
}

/**
 * The same lists the desktop's activity sidebar draws, ranked by the same rules, a coordinator
 * standing for the threads under it, over the threads the list carries. A thread past the list's
 * limit is not ranked either: it is too old to be waiting on anyone.
 */
function projectMobileActivity(state: WorkspaceState, here: Pick<ThreadActivity, "working" | "blocked" | "ranked">, entriesById: Map<string, MobileThreadEntry>): MobileActivity {
  const listed = workspaceViewCollections(state).visibleThreads.filter((thread) => entriesById.has(thread.id));
  const { sections } = ownCoordinationSections(state, listed, here, state.computers.paired);
  const rows = (threads: Thread[]) => threads.flatMap((thread) => entriesById.get(thread.id) ?? []);
  const snoozable = (entry: MobileThreadEntry): MobileThreadEntry => ({ ...entry, snoozable: true });
  return { priority: rows(sections.priority).map(snoozable), running: rows(sections.running), threads: rows(sections.threads), snoozed: rows(sections.snoozed) };
}

/** The desktop's family in both faces, so a phone on "auto" can pick its own without asking. */
export function projectMobileTheme(state: Pick<WorkspaceState, "theme" | "themeMode">): MobileTheme {
  const family = themeOrDefault(state.theme).family;
  return { dark: themeFor(family, "dark").id, light: themeFor(family, "light").id, mode: state.themeMode };
}

/**
 * One group's rows: threads waiting on the user first, then the rest in the sidebar's own order.
 * A thread holds its slot when it starts, speaks or finishes, so the list never reshuffles under
 * a thumb; only waiting on the user lifts a row. `entries` arrive newest first already.
 */
export function rankGroup(entries: MobileThreadEntry[], threadsById: Map<string, Thread>): MobileThreadEntry[] {
  const blocked: MobileThreadEntry[] = [];
  const rest: MobileThreadEntry[] = [];
  for (const entry of entries) (entry.status === "awaiting-approval" ? blocked : rest).push(entry);
  const byThread = new Map(rest.map((entry) => [entry.id, entry]));
  const threads = rest.flatMap((entry) => threadsById.get(entry.id) ?? []);
  return [...blocked, ...orderThreads(threads).flatMap((thread) => byThread.get(thread.id) ?? [])];
}

/** What the desktop's empty composer is pointed at, which is all a thread yet to exist amounts to. */
function projectMobileDraft(state: WorkspaceState, view: ReturnType<typeof deriveView>): MobileDraftView {
  const project = view.currentProject;
  return {
    projectId: project?.id ?? null,
    projectName: project ? projectName(project) : null,
    settings: { engine: view.engine, model: view.model, effort: view.effort, fastMode: view.fastMode, policy: view.policy, ...(view.coordinating ? { coordinating: true as const } : {}) },
    worktree: view.draftWorktree,
    worktreeName: view.draftWorktreeName,
    worktrees: view.draftWorktreeChoices,
    canWorktree: Boolean(project?.workspaceId),
  };
}

function locationOf(view: ReturnType<typeof deriveView>): MobileLocation {
  const location = view.location;
  if (location.kind !== "worktree") return { kind: location.kind };
  return { kind: "worktree", name: worktreeName(location.worktree), threads: location.threads };
}

function changesOf(view: ReturnType<typeof deriveView>): MobileChanges | null {
  const environment = view.environment;
  if (environment?.status !== "available") return null;
  return { branch: environment.branch, files: environment.files.length, additions: environment.additions, deletions: environment.deletions };
}

/**
 * The threads a phone may name: this computer's own, and those on a paired computer working under a
 * coordinator here, which the coordinator's screen lists. Nothing else of another computer is ever on the phone's.
 */
export function phoneReachesThread(state: WorkspaceState, taskId: string): boolean {
  return state.threads.some((thread) => thread.id === taskId) || remoteMemberHolder(state, taskId) !== null;
}

/** The paired computer holding a thread that works under a coordinator here, or null. */
export function remoteMemberHolder(state: WorkspaceState, taskId: string): PairedComputer | null {
  const holder = computerOfThread(state, taskId);
  if (!holder) return null;
  const lead = holder.state?.threads.find((thread) => thread.id === taskId)?.remoteLead?.threadId;
  return lead !== undefined && coordinationMembers(state, lead).some((member) => member.computer?.id === holder.id && member.thread.id === taskId) ? holder : null;
}

/**
 * Only the user's own words travel to the phone's composer and back: images and files are paths on
 * the computer, and pasted text and notes ride beside the words, which a phone's composer cannot hold.
 */
export function phoneEditsQueued(message: QueuedMessage): boolean {
  return isUsersOwn(message) && !message.steering && !message.attachments.length && !message.files?.length && !message.pastes?.length && !message.annotations?.length;
}

/**
 * The thread the desktop has open. One on a paired computer is read from that computer's mirror, and
 * only while it works under a coordinator here, so it is answered, approved and messaged through this
 * computer; its checkout is that computer's, so it offers no review and no move.
 */
function projectMobileThread(state: WorkspaceState, view: ReturnType<typeof deriveView>, stoppable: ReadonlySet<string>): MobileThreadView | null {
  const thread = view.currentThread;
  if (!thread) return null;
  const elsewhere = selectedComputer(state);
  const shown = elsewhere?.state ?? state;
  if (elsewhere && remoteMemberHolder(state, thread.id)?.id !== elsewhere.id) return null;
  const transcript = threadTranscript(shown, thread.id, MOBILE_TRANSCRIPT_MESSAGES, MOBILE_MESSAGE_TEXT_LIMIT);
  if (!transcript) return null;
  const blocked = elsewhere ? threadActivity(shown).blocked : view.blockedThreadIds;
  /** A coordinator answers for the threads under it, as its Needs-you card does, its own first. */
  const member = view.approval ? undefined : view.coordination.approvals[0];
  const approval = view.approval ?? member?.approval;
  const project = projectFor(shown, thread);
  const diff = diffFor(shown, thread.id);
  const location = locationOf(view);
  return {
    id: thread.id,
    loading: Boolean(thread.historySummary),
    title: thread.title || "Untitled thread",
    projectId: project?.id ?? null,
    projectName: view.currentProject ? projectName(view.currentProject) : null,
    worktreeId: thread.worktreeId ?? null,
    messages: withDetails(thread, transcript.messages),
    omitted: transcript.omitted,
    streamingTail: view.streamingTail?.text ?? null,
    status: blocked.has(thread.id) ? "awaiting-approval" : view.status,
    question: view.question ?? null,
    approval: approval
      ? {
        taskId: approval.taskId,
        ...(member && member.thread.id !== thread.id ? { from: member.thread.title || "Untitled thread" } : {}),
        approvalId: approval.approvalId,
        runId: approval.runId,
        title: approval.title,
        description: approval.description,
        toolName: approval.toolName,
        detail: approvalDetail(approval.input),
      }
      : null,
    queued: view.queuedMessages.map((message) => ({ id: message.id, text: message.text, ...labelOf(message), ...(message.steering ? { steering: true } : {}), ...(phoneEditsQueued(message) && !drainingQueued(shown, thread.id, message.id) ? { editable: true as const } : {}) })),
    settings: { engine: view.engine, model: view.model, effort: view.effort, fastMode: view.fastMode, policy: view.policy, ...(view.coordinating ? { coordinating: true as const } : {}) },
    location,
    worktrees: project && !elsewhere ? worktreeChoices(state, project.id, thread.worktreeId) : [],
    canMove: !elsewhere && Boolean(project?.workspaceId) && location.kind !== "creating" && location.kind !== "releasing" && !view.runningThreadIds.has(thread.id),
    changes: changesOf(view),
    reviewable: !elsewhere && threadWorkspaceId(state, thread) !== undefined,
    branchRange: diff.range.kind === "branches" ? diff.range : diff.branchRange ?? DEFAULT_BRANCH_RANGE,
    members: isCoordinator(thread) ? projectMembers(state, thread.id, view) : NO_MEMBERS,
    role: thread.role ?? null,
    background: projectBackground(view.workflows, view.backgroundProcesses, view.subagents),
    decisions: projectDecisions(thread, view.coordination.decisions),
    suggestions: projectSuggestions(view.coordination.proposals),
    limit: view.limitPause ? { resetsAt: view.limitPause.resetsAt, window: view.limitPause.window, position: view.limitPause.position } : null,
    ...(elsewhere ? { computer: elsewhere.name } : {}),
    stoppable: stoppable.has(thread.id),
  };
}

const NO_DECISIONS: MobileDecision[] = [];

/** The decisions the open thread's Needs-you card answers, naming the thread that asks when it is another. */
function projectDecisions(open: Thread, decisions: readonly CoordinationDecisionView[]): MobileDecision[] {
  if (!decisions.length) return NO_DECISIONS;
  return decisions.slice(0, MOBILE_DECISION_LIMIT).map(({ thread, decision }) => ({
    taskId: thread.id,
    ...(thread.id !== open.id ? { from: thread.title || "Untitled thread" } : {}),
    id: decision.id,
    question: decision.question,
    ...(decision.context ? { context: decision.context } : {}),
    options: decision.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}), ...(option.recommended ? { recommended: true as const } : {}) })),
  }));
}

const NO_SUGGESTIONS: MobileSuggestion[] = [];

const projectedSuggestions = new WeakMap<readonly ProposalView[], MobileSuggestion[]>();

/** The suggestions to start here, kept per list since the view holds the list while no suggestion moves. */
function projectSuggestions(proposals: readonly ProposalView[]): MobileSuggestion[] {
  if (!proposals.length) return NO_SUGGESTIONS;
  let suggestions = projectedSuggestions.get(proposals);
  if (!suggestions) {
    suggestions = proposals.flatMap(({ proposal, starting, elsewhere }): MobileSuggestion[] => elsewhere ? [] : [{
      id: proposal.id,
      title: proposal.title,
      ...(proposal.brief ? { brief: { intent: proposal.brief.intent, doneWhen: proposal.brief.doneWhen, delivers: deliveryLabel(proposal.brief.delivers) } } : {}),
      prompt: clipText(proposal.prompt, MOBILE_SUGGESTION_PROMPT_LIMIT),
      ...(starting ? { starting: true as const } : {}),
      ...(proposal.error && !starting ? { error: proposal.error } : {}),
    }]);
    projectedSuggestions.set(proposals, suggestions);
  }
  return suggestions;
}

/** Every archived thread as the phone's Archived list reads it, newest first. Retention bounds the list, and only a query reads it. */
export function mobileArchivedThreads(state: WorkspaceState): MobileArchivedThread[] {
  return workspaceViewCollections(state).archivedThreads.map((thread) => {
    const project = projectFor(state, thread);
    const archivedAt = thread.archivedAt!;
    return { id: thread.id, title: thread.title || "Untitled thread", projectName: project ? projectName(project) : null, archivedAt, deletesAt: archivedAt + ARCHIVE_RETENTION_MS };
  });
}

let heldBackground: { workflows: Workflow[]; processes: BackgroundProcess[]; subagents: Subagent[]; items: MobileBackgroundItem[] } | undefined;

/** The view hands a fresh empty list whenever a thread has none, so every empty list is the same list. */
function sameList(held: readonly unknown[], next: readonly unknown[]): boolean {
  return held === next || (held.length === 0 && next.length === 0);
}

/** The desktop's Processes and Subagents lists as one, kept while its sources are, since a streaming run projects many times a second. */
function projectBackground(workflows: Workflow[], processes: BackgroundProcess[], subagents: Subagent[]): MobileBackgroundItem[] {
  const held = heldBackground;
  if (held && sameList(held.workflows, workflows) && sameList(held.processes, processes) && sameList(held.subagents, subagents)) return held.items;
  const all: MobileBackgroundItem[] = [
    ...workflows.map((workflow): MobileBackgroundItem => {
      const running = workflow.status === "running";
      return { id: workflow.id, kind: "workflow", title: workflow.name, detail: workflowLabel(workflow), status: workflow.status === "running" ? "working" : workflow.status, live: running, stoppable: running, ...(workflow.stopping ? { stopping: true as const } : {}) };
    }),
    ...processes.map((process): MobileBackgroundItem =>
      ({ id: process.id, kind: process.kind, title: process.description, detail: processLabel(process), status: "working", live: true, stoppable: true, ...(process.stopping ? { stopping: true as const } : {}) })),
    ...orderSubagents(subagents).map((subagent): MobileBackgroundItem => ({
      id: subagent.id, kind: "agent", title: subagent.description, detail: clipText(subagentLine(subagent), MOBILE_BACKGROUND_DETAIL_LIMIT), status: subagent.status,
      live: subagent.status === "working" || subagent.status === "idle", stoppable: subagent.status === "working", ...(subagent.stopping ? { stopping: true as const } : {}),
    })),
  ];
  const items = [...all.filter((item) => item.live), ...all.filter((item) => !item.live)].slice(0, MOBILE_BACKGROUND_LIMIT);
  heldBackground = { workflows, processes, subagents, items };
  return items;
}

const NO_MEMBERS: MobileMember[] = [];

const toolCalls = new WeakMap<ConversationMessage, MobileToolCall>();

/** A tool call read once per stored message: its input is parsed here rather than on every change to the view. */
function toolCallOf(engine: Thread["engine"], message: ConversationMessage): MobileToolCall {
  let call = toolCalls.get(message);
  if (!call) {
    const described = describeToolCall(engine, message.text, message.detail);
    call = { family: described.family, label: described.label, argument: described.argument, ...(described.sigil ? { sigil: described.sigil } : {}), ...(described.verb ? { verb: true as const } : {}) };
    toolCalls.set(message, call);
  }
  return call;
}

const imageLinking = new WeakMap<ConversationMessage, boolean>();

function linksImages(message: ConversationMessage): boolean {
  let links = imageLinking.get(message);
  if (links === undefined) {
    links = mayLinkImages(message.text);
    imageLinking.set(message, links);
  }
  return links;
}

/**
 * The transcript with what a phone reads beside each message's words: what each tool call did, and
 * how many images a message carried, and the ID of a reply that may link images. The transcript is
 * the thread's newest messages, in order.
 */
function withDetails(thread: Thread, messages: MobileMessage[]): MobileMessage[] {
  const offset = thread.messages.length - messages.length;
  return messages.map((message, index) => {
    const stored = thread.messages[offset + index];
    if (message.kind === "tool" && stored?.kind === "tool") return { ...message, call: toolCallOf(thread.engine, stored) };
    if (stored?.kind === "assistant" && linksImages(stored)) return { ...message, id: stored.id };
    return stored?.attachments?.length ? { ...message, images: stored.attachments.length } : message;
  });
}

/** A thread on this computer as its own screen reads it, without opening it. Null for one this computer does not hold. */
export function mobileThreadRead(state: WorkspaceState, taskId: string): MobileThreadRead | null {
  const thread = state.threads.find((item) => item.id === taskId);
  const transcript = thread && threadTranscript(state, thread.id, MOBILE_TRANSCRIPT_MESSAGES, MOBILE_MESSAGE_TEXT_LIMIT);
  if (!thread || !transcript) return null;
  const { working, blocked } = threadActivity(state);
  const status: MobileRunStatus = blocked.has(thread.id) ? "awaiting-approval" : working.has(thread.id) ? "running" : "idle";
  /** A conversation not loaded yet counts as left out, as on a paired computer that has yet to open it. */
  const omitted = thread.historySummary ? Math.max(transcript.omitted, thread.historySummary.messageCount - transcript.messages.length) : transcript.omitted;
  return { title: thread.title || "Untitled thread", status, messages: withDetails(thread, transcript.messages), omitted, streamingTail: state.streamingTails[thread.id]?.text ?? null };
}

/** The threads working under a coordinator, here and on paired computers, as its desktop roster lists them. */
function projectMembers(state: WorkspaceState, leadId: string, view: ReturnType<typeof deriveView>): MobileMember[] {
  return coordinationMembers(state, leadId).map((member) => {
    const { working, blocked } = memberActivity(member, view.runningThreadIds, view.blockedThreadIds);
    const status: MobileMember["status"] = blocked.has(member.thread.id) ? "awaiting-approval" : working.has(member.thread.id) ? "running" : "idle";
    return { id: member.thread.id, title: member.thread.title || "Untitled thread", status, ...(member.computer ? { computer: member.computer.name, online: member.computer.status === "connected" } : {}) };
  });
}

function approvalDetail(input: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? "";
  } catch {
    text = "";
  }
  return clipText(text, MOBILE_APPROVAL_DETAIL_LIMIT);
}

/** Null when nothing moved, so a server with nothing to say sends nothing at all. */
export function diffMobileView(previous: MobileView, next: MobileView): MobilePatch | null {
  const patch: MobilePatch = {};
  if (!sameGroups(previous.groups, next.groups)) patch.groups = next.groups;
  if (!sameActivity(previous.activity, next.activity)) patch.activity = next.activity;
  if (!same(previous.theme, next.theme)) patch.theme = next.theme;
  if (previous.engines !== next.engines && !same(previous.engines, next.engines)) patch.engines = next.engines;
  if (!same(previous.upkeep, next.upkeep)) patch.upkeep = next.upkeep;
  if (previous.dictation !== next.dictation) patch.dictation = next.dictation;
  if (!same(previous.usage, next.usage)) patch.usage = next.usage;
  if (previous.archived !== next.archived) patch.archived = next.archived;
  const thread = diffMobileThread(previous.thread, next.thread);
  if (thread) patch.thread = thread;
  if (!same(previous.draft, next.draft)) patch.draft = next.draft;
  if (previous.error !== next.error) patch.error = next.error;
  return Object.keys(patch).length ? patch : null;
}

/**
 * How far a row's last activity may drift before the list is worth sending again. The list never
 * draws a time finer than a minute, and a streaming run moves its row with every block it commits,
 * which would otherwise resend the heaviest part of the view many times a minute. Whoever diffs
 * keeps the view the phone holds rather than the newest one, so the drift never passes this.
 */
const ACTIVITY_DRIFT_MS = 60_000;

function sameGroups(previous: MobileProjectGroup[], next: MobileProjectGroup[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((group, index) => {
    const other = next[index]!;
    return group.projectId === other.projectId && group.name === other.name && sameRows(group.threads, other.threads);
  });
}

function sameActivity(previous: MobileActivity, next: MobileActivity): boolean {
  return sameRows(previous.priority, next.priority) && sameRows(previous.running, next.running) && sameRows(previous.threads, next.threads)
    && sameRows(previous.snoozed, next.snoozed);
}

/** Rows in the same order that differ only in when they last moved, and by less than the drift, are the same rows. */
function sameRows(previous: MobileThreadEntry[], next: MobileThreadEntry[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (Math.abs(before.lastActivityAt - after.lastActivityAt) >= ACTIVITY_DRIFT_MS) return false;
    if (!same({ ...before, lastActivityAt: 0 }, { ...after, lastActivityAt: 0 })) return false;
  }
  return true;
}

function diffMobileThread(previous: MobileThreadView | null, next: MobileThreadView | null): MobilePatch["thread"] {
  if (!next) return previous ? { kind: "closed" } : undefined;
  if (!previous || previous.id !== next.id) return { kind: "opened", thread: next };
  const delta: MobileThreadDelta = {};
  for (const key of MOVING_KEYS) {
    if (previous[key] !== next[key] && !same(previous[key], next[key])) (delta as Record<string, unknown>)[key] = next[key];
  }
  const tail = previous.streamingTail;
  if (tail !== next.streamingTail) {
    if (tail !== null && next.streamingTail?.startsWith(tail)) delta.tail = { from: tail.length, text: next.streamingTail.slice(tail.length) };
    else delta.streamingTail = next.streamingTail;
  }
  Object.assign(delta, transcriptDelta(previous.messages, next.messages));
  return Object.keys(delta).length ? { kind: "changed", id: next.id, delta } : undefined;
}

/**
 * Every field of the open thread a delta carries as it stands, which is all of them but its id, its
 * transcript and its streaming tail: those two grow at their end, and travel as what they grew by.
 */
const MOVING_KEYS = [
  "loading", "title", "projectId", "projectName", "worktreeId", "omitted", "status", "question", "approval",
  "queued", "settings", "location", "worktrees", "canMove", "changes", "reviewable", "branchRange", "members", "role", "background", "decisions", "suggestions", "limit", "computer", "stoppable",
] as const satisfies ReadonlyArray<keyof Omit<MobileThreadView, "id" | "messages" | "streamingTail">>;

/**
 * How the transcript moved: not at all, at its end, or some other way. At its end means the window
 * may have slid past older messages, and the newest message the phone holds may have grown, while
 * everything between stayed as it was. Anything else sends the whole transcript.
 */
function transcriptDelta(previous: MobileMessage[], next: MobileMessage[]): Pick<MobileThreadDelta, "spliced" | "messages"> {
  const held = previous.map((message) => JSON.stringify(message));
  const wanted = next.map((message) => JSON.stringify(message));
  if (!held.length) return wanted.length ? { spliced: { dropped: 0, kept: 0, messages: next } } : {};
  const dropped = wanted.length ? held.indexOf(wanted[0]!) : -1;
  if (dropped < 0) return { messages: next };
  let kept = 0;
  while (dropped + kept < held.length && kept < wanted.length && held[dropped + kept] === wanted[kept]) kept += 1;
  const rest = held.length - dropped;
  if (kept < rest - 1) return { messages: next };
  if (dropped === 0 && kept === rest && kept === wanted.length) return {};
  return { spliced: { dropped, kept, messages: next.slice(kept) } };
}

/**
 * Puts a patch back on the view the phone holds, which is the other half of {@link diffMobileView}.
 * Null when it does not fit: a transcript or tail that grew from something other than what is held
 * would be drawn wrong in silence, so whoever holds the view fetches it whole instead.
 */
export function applyMobilePatch(view: MobileView, patch: MobilePatch): MobileView | null {
  const rest = {
    groups: patch.groups ?? view.groups,
    activity: patch.activity ?? view.activity,
    theme: patch.theme ?? view.theme,
    engines: patch.engines ?? view.engines,
    upkeep: patch.upkeep ?? view.upkeep,
    dictation: patch.dictation ?? view.dictation,
    usage: patch.usage ?? view.usage,
    archived: patch.archived ?? view.archived,
    draft: "draft" in patch ? patch.draft ?? null : view.draft,
    error: "error" in patch ? patch.error ?? null : view.error,
  };
  if (!patch.thread) return { ...rest, thread: view.thread };
  if (patch.thread.kind === "closed") return { ...rest, thread: null };
  if (patch.thread.kind === "opened") return { ...rest, thread: patch.thread.thread };
  const current = view.thread;
  if (!current || current.id !== patch.thread.id) return { ...rest, thread: current };
  const { spliced, messages, tail, ...moved } = patch.thread.delta;
  let transcript = messages ?? current.messages;
  if (spliced) {
    if (current.messages.length < spliced.dropped + spliced.kept) return null;
    transcript = [...current.messages.slice(spliced.dropped, spliced.dropped + spliced.kept), ...spliced.messages];
  }
  let streamingTail = "streamingTail" in moved ? moved.streamingTail ?? null : current.streamingTail;
  if (tail) {
    if (current.streamingTail?.length !== tail.from) return null;
    streamingTail = `${current.streamingTail}${tail.text}`;
  }
  return { ...rest, thread: { ...current, ...moved, messages: transcript, streamingTail } };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
