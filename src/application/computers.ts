/**
 * Threads that live on other computers. Each paired computer's whole workspace state is mirrored
 * here as it changes there, so its threads can be listed beside this computer's own and one of
 * them shown in the conversation. Nothing is decided about those threads on this side: a command
 * aimed at one is carried to the computer that holds it, and what comes back is its new state.
 */
import type { AppCommand } from "../contracts/commands.js";
import { isAppCommandType } from "../contracts/workspace-view-input.js";
import type { Annotation, PastedText } from "../domain/conversation.js";
import { hasUnreadAttention } from "../domain/attention.js";
import type { ComputerFilter, ComputerLink, ComputerPairing, DiscoveredComputer } from "../domain/computers.js";
import type { Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { MAIN_COMPOSER } from "./composer-attachments.js";
import { annotationsFor, filesFor, pastesFor } from "./composer-drafts.js";
import { blockedThreadIds, busyThreadIds, promptKey, sideChatIds, type WorkspaceState } from "./workspace-state.js";
import type { WorkspaceInput } from "./workspace-reducer.js";

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
  filter: ComputerFilter;
};

export const NO_COMPUTERS: ComputersState = { name: "", found: [], searching: false, searchError: null, paired: [], pairing: null, active: null, filter: "all" };

export function activeComputer(state: Pick<WorkspaceState, "computers">): PairedComputer | null {
  const { active, paired } = state.computers;
  return active === null ? null : paired.find((computer) => computer.id === active) ?? null;
}

/** The paired computer holding a thread, or null for one of this computer's own or one nobody holds. */
export function computerOfThread(state: Pick<WorkspaceState, "computers" | "threads">, taskId: string | undefined): PairedComputer | null {
  if (taskId === undefined || state.threads.some((thread) => thread.id === taskId)) return null;
  return state.computers.paired.find((computer) => computer.state?.threads.some((thread) => thread.id === taskId)) ?? null;
}

export function computerOfProject(state: Pick<WorkspaceState, "computers" | "projects">, projectId: string | undefined): PairedComputer | null {
  if (projectId === undefined || state.projects.some((project) => project.id === projectId)) return null;
  return state.computers.paired.find((computer) => computer.state?.projects.some((project) => project.id === projectId)) ?? null;
}

/** The paired computer whose project or checkout a workspace id names, or null for one of this computer's own. */
export function computerOfWorkspace(state: Pick<WorkspaceState, "computers" | "projects" | "worktrees">, workspaceId: string): PairedComputer | null {
  const holds = (held: Pick<WorkspaceState, "projects" | "worktrees">) => held.projects.some((project) => project.workspaceId === workspaceId) || held.worktrees.some((worktree) => worktree.workspaceId === workspaceId);
  if (holds(state)) return null;
  return state.computers.paired.find((computer) => computer.state && holds(computer.state)) ?? null;
}

function computerOfWorktree(state: Pick<WorkspaceState, "computers" | "worktrees">, worktreeId: string | undefined): PairedComputer | null {
  if (worktreeId === undefined || state.worktrees.some((worktree) => worktree.id === worktreeId)) return null;
  return state.computers.paired.find((computer) => computer.state?.worktrees.some((worktree) => worktree.id === worktreeId)) ?? null;
}

/** The paired computer whose checkout is at a root, or null for one of this computer's own or one nobody holds. */
function computerOfWorktreeRoot(state: Pick<WorkspaceState, "computers" | "worktrees" | "managedWorktrees">, root: string | undefined): PairedComputer | null {
  const holds = (held: Pick<WorkspaceState, "worktrees" | "managedWorktrees">) => held.worktrees.some((worktree) => worktree.root === root) || Boolean(held.managedWorktrees?.some((worktree) => worktree.root === root));
  if (root === undefined || holds(state)) return null;
  return state.computers.paired.find((computer) => computer.state && holds(computer.state)) ?? null;
}

/**
 * Where a command goes: this computer's reducer, a paired computer's, or nowhere with a reason.
 * `select` puts the computer on screen; `also` applies the command here as well; `draftKey` names
 * the draft a send carries, cleared here once the other computer has taken it.
 */
export type InputRoute =
  | { kind: "local" }
  | { kind: "computer"; computer: PairedComputer; inputs: WorkspaceInput[]; select?: true; also?: true; draft?: SentDraft }
  | { kind: "refuse"; message: string };

/** The draft a send carried, whole, so what is typed or changed after it went can be told apart and stays. */
export type SentDraft = {
  key: string; prompt: string; pastes: PastedText[]; annotations: Annotation[];
  /** The sending strip: the main composer or a named side chat, independent of the thread's draft key. */
  attachments?: { key: string; ids: string[] };
};

const LOCAL = { kind: "local" } as const;

/** Commands that move this window to one of its own threads, which takes a paired computer's thread off screen. */
const LEAVING_TYPES = new Set(["task.select", "worktree.open-thread", "view.jump-choose", "task.new", "view.go-back", "view.go-forward"]);

/** Whether a command routed here means the window is leaving the paired computer it was showing. */
export function leavesComputer(input: WorkspaceInput): boolean {
  return LEAVING_TYPES.has(input.type);
}

/** Commands that stay on this computer whatever thread is on screen: the window, its settings, and its drafts. */
const LOCAL_PREFIXES = ["computer-use.", "cli.", "engine.", "remote.", "computers.", "app.list", "app.check-for-updates", "app.open-source-licenses", "worktree.", "annotation.", "paste.", "image.", "file.", "view.set-theme", "view.set-ui", "view.set-mono", "view.set-reading", "view.set-terminal", "view.set-sidebar", "view.set-session", "view.set-capture", "view.set-chrome", "view.set-concise", "view.set-computer", "view.set-browser", "view.set-notifications", "view.set-settings", "view.set-shortcut", "view.reset-shortcuts", "view.capture-shortcut", "view.dismiss-", "view.set-section", "view.set-subagent", "view.set-model-favorite", "view.set-menu", "view.go-", "view.mounted", "view.closed", "view.toggle-project", "view.edit-project", "view.move-worktree", "view.jump-", "view.find-", "view.focus-composer", "view.system-scheme", "view.set-prompt", "view.reading-point", "view.refresh-environment", "usage.", "project.open", "attachments.notice"] as const;

/** Commands that only this computer's own panels can carry out. */
const PANEL_PREFIXES = ["terminal.", "browser."] as const;

export const PANEL_ELSEWHERE = "The terminal and browser panels open only for threads on this computer.";
export const ATTACHMENTS_ELSEWHERE = "Files and folders attached by local path cannot be sent to another computer.";
export const FILES_ELSEWHERE = "That folder is on another computer, so it cannot be opened here.";

function forwarded(computer: PairedComputer, inputs: WorkspaceInput[], options: { select?: true; also?: true; draft?: SentDraft } = {}): InputRoute {
  return { kind: "computer", computer, inputs, ...options };
}

/** Puts a computer on screen: it is told first whether anyone here is looking, which is what its unread marks go by. */
function selecting(state: WorkspaceState, computer: PairedComputer, inputs: WorkspaceInput[]): InputRoute {
  return forwarded(computer, [{ type: "view.set-focused", focused: state.focused }, ...inputs], { select: true });
}

/**
 * A composer send carries the draft this computer holds for the thread: the text and what rides
 * with it are put into the other computer's own composer for that thread, whole, so a send it
 * refused leaves nothing behind for the next, and its send reads them from there. The draft stays
 * here until that computer has taken it. A send with text of its own goes as it is.
 */
function forwardedSend(state: WorkspaceState, computer: PairedComputer, command: Extract<AppCommand, { type: "task.send" | "attachments.send" }>): InputRoute {
  if (command.type === "task.send" && command.attachments?.length) return { kind: "refuse", message: ATTACHMENTS_ELSEWHERE };
  const remote = computer.state;
  if (!remote) return { kind: "refuse", message: "That computer has not answered yet." };
  const { attachments: _attachments, ...rest } = command;
  if (rest.type === "task.send" && rest.text !== undefined) return forwarded(computer, [rest]);
  /** The thread the send is for: the one named, else the one that computer has open, else its draft. */
  const key = command.taskId ?? promptKey(remote);
  if (filesFor(state, key).length) return { kind: "refuse", message: ATTACHMENTS_ELSEWHERE };
  const prompt = state.prompts[key] ?? "";
  const annotations = annotationsFor(state, key);
  const pastes = pastesFor(state, key);
  const { taskId: _named, ...send } = rest;
  const outgoing = command.type === "attachments.send"
    ? { ...send, type: "attachments.send" as const, attachments: command.attachments.map(({ path: _local, ...attachment }) => attachment) }
    : { ...send, type: "task.send" as const };
  const inputs: WorkspaceInput[] = [
    { type: "view.set-prompt", taskId: key, prompt },
    { type: "annotation.recall", taskId: key, annotations },
    { type: "paste.recall", taskId: key, pastes },
    { ...outgoing, ...(key.startsWith("draft:") ? {} : { taskId: key }) },
  ];
  const draft: SentDraft = {
    key, prompt, pastes, annotations,
    ...(command.type === "attachments.send" ? { attachments: { key: command.taskId ?? MAIN_COMPOSER, ids: command.attachments.map((attachment) => attachment.id) } } : {}),
  };
  return forwarded(computer, inputs, { draft });
}

/**
 * Where a command goes. A thread named outright goes to the computer holding it; one about the
 * thread on screen goes to the computer showing it; the window's own affairs stay here.
 */
export function routeInput(state: WorkspaceState, input: WorkspaceInput): InputRoute {
  if (!state.computers.paired.length || !isAppCommandType(input.type)) return LOCAL;
  const active = activeComputer(state);
  const type = input.type;
  if (type === "task.new") {
    const computer = computerOfProject(state, input.projectId) ?? computerOfWorktree(state, input.worktreeId);
    return computer ? selecting(state, computer, [input]) : LOCAL;
  }
  if (type === "task.select" || type === "worktree.open-thread" || type === "view.jump-choose") {
    const computer = computerOfThread(state, input.taskId);
    return computer ? selecting(state, computer, [{ type: "task.select", taskId: input.taskId }]) : LOCAL;
  }
  if (type === "task.dismiss-all") return LOCAL;
  /** Whether the user is looking is this window's to know and the other computer's to act on. */
  if (type === "view.set-focused") return active ? forwarded(active, [input], { also: true }) : LOCAL;
  if (type === "project.move" || type === "project.edit" || type === "project.remove") {
    const computer = computerOfProject(state, input.projectId);
    return computer ? forwarded(computer, [input]) : LOCAL;
  }
  /** A file or folder is opened on the machine that has it, which is not this one. */
  if (type === "file.open" || type === "app.open-folder") {
    const named = type === "file.open" ? computerOfThread(state, input.taskId) : null;
    const elsewhere = named ?? (type === "file.open" && input.taskId !== undefined ? null : active);
    return elsewhere ? { kind: "refuse", message: FILES_ELSEWHERE } : LOCAL;
  }
  /** The location menu opens and is searched here; the checkouts it offers, and what it moves or deletes, are the holder's. */
  if (type === "worktree.menu-open") return input.list === "destinations" && active ? forwarded(active, [input], { also: true }) : LOCAL;
  if (type === "worktree.delete") {
    const computer = input.root !== undefined ? computerOfWorktreeRoot(state, input.root) : input.taskId !== undefined ? computerOfThread(state, input.taskId) : active;
    return computer ? forwarded(computer, [input]) : LOCAL;
  }
  if (LOCAL_PREFIXES.some((prefix) => type.startsWith(prefix))) return LOCAL;
  const named = "taskId" in input ? computerOfThread(state, input.taskId) : null;
  const computer = named ?? ("taskId" in input && input.taskId !== undefined ? null : active);
  if (!computer) return LOCAL;
  if (PANEL_PREFIXES.some((prefix) => type.startsWith(prefix))) return { kind: "refuse", message: PANEL_ELSEWHERE };
  if (type === "task.send" || type === "attachments.send") return forwardedSend(state, computer, input);
  return forwarded(computer, [input]);
}

/** The threads a paired computer would list, as it would list them: its own, less the ones it has filed away. */
export type RemoteThreads = { computer: PairedComputer; visible: Thread[]; busy: Set<string>; blocked: Set<string> };

const remoteThreadCache = new WeakMap<WorkspaceState, Omit<RemoteThreads, "computer">>();

function remoteThreads(computer: PairedComputer): RemoteThreads | null {
  const remote = computer.state;
  if (!remote) return null;
  let held = remoteThreadCache.get(remote);
  if (!held) {
    const forked = sideChatIds(remote);
    held = {
      visible: remote.threads.filter((thread) => thread.archivedAt === undefined && !forked.has(thread.id)),
      busy: busyThreadIds(remote),
      blocked: blockedThreadIds(remote),
    };
    remoteThreadCache.set(remote, held);
  }
  return { computer, ...held };
}

/** Which computers the sidebar's filter lets through. */
export function shownComputers(computers: ComputersState): PairedComputer[] {
  if (computers.filter === "this") return [];
  if (computers.filter === "all") return computers.paired;
  return computers.paired.filter((computer) => computer.id === computers.filter);
}

/** One row's tag: which computer holds it, and whether that computer can be reached. */
export type ThreadHost = { id: string; name: string; offline: boolean };

/** Everything the sidebar needs from the paired computers, gathered once per state. */
export type RemoteCollections = {
  threads: Thread[];
  projects: Project[];
  busy: Set<string>;
  blocked: Set<string>;
  /** Which computer each remote thread and project belongs to, by id. */
  threadHosts: Map<string, ThreadHost>;
  projectHosts: Map<string, ThreadHost>;
  unreadCount: number;
};

export const NO_REMOTE_COLLECTIONS: RemoteCollections = { threads: [], projects: [], busy: new Set(), blocked: new Set(), threadHosts: new Map(), projectHosts: new Map(), unreadCount: 0 };

export function remoteCollections(computers: ComputersState): RemoteCollections {
  const shown = shownComputers(computers);
  if (!shown.length) return NO_REMOTE_COLLECTIONS;
  const gathered: RemoteCollections = { threads: [], projects: [], busy: new Set(), blocked: new Set(), threadHosts: new Map(), projectHosts: new Map(), unreadCount: 0 };
  for (const computer of shown) {
    const held = remoteThreads(computer);
    if (!held) continue;
    const host: ThreadHost = { id: computer.id, name: computer.name, offline: computer.status !== "connected" };
    for (const thread of held.visible) {
      gathered.threads.push(thread);
      gathered.threadHosts.set(thread.id, host);
      if (hasUnreadAttention(thread)) gathered.unreadCount += 1;
    }
    for (const project of computer.state!.projects) {
      gathered.projects.push(project);
      gathered.projectHosts.set(project.id, host);
    }
    for (const id of held.busy) gathered.busy.add(id);
    for (const id of held.blocked) gathered.blocked.add(id);
  }
  return gathered;
}

/** How many threads on every paired computer carry an unseen mark, which the app icon adds to its own. */
export function remoteUnreadCount(computers: ComputersState): number {
  let count = 0;
  for (const computer of computers.paired) {
    const held = remoteThreads(computer);
    if (!held) continue;
    for (const thread of held.visible) if (hasUnreadAttention(thread)) count += 1;
  }
  return count;
}

