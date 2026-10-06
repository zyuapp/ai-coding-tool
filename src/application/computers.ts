import { REMOTE_UNSUPPORTED, supportsComputerCommand } from "../contracts/computer-capabilities.js";
/**
 * Threads that live on other computers. Each paired computer's whole workspace state is mirrored
 * here as it changes there, so its threads can be listed beside this computer's own and one of
 * them shown in the conversation. Nothing is decided about those threads on this side: a command
 * aimed at one is carried to the computer that holds it, and what comes back is its new state.
 */
import type { AppCommand } from "../contracts/commands.js";
import { commandLeaves, commandPlacement, isAppCommandType, type CommandPlacement, type PlacedCommand } from "../contracts/workspace-view-input.js";
import type { Annotation, PastedText } from "../domain/conversation.js";
import { offlineMessage, type ComputerFilter, type ComputerLink, type ComputerPairing, type DiscoveredComputer } from "../domain/computers.js";
import type { Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import type { Worktree } from "../domain/worktree.js";
import { MAIN_COMPOSER } from "./composer-attachments.js";
import { annotationsFor, filesFor, pastesFor } from "./composer-drafts.js";
import { promptKey, type WorkspaceState } from "./workspace-state.js";
import { threadActivity, threadLists } from "./thread-activity.js";
import type { WorkspaceInput } from "./workspace-reducer.js";
import { frontDock } from "./workspace-dock.js";

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
};

export const NO_COMPUTERS: ComputersState = { name: "", found: [], searching: false, searchError: null, paired: [], pairing: null, active: null, dropped: null, filter: "all" };

/** The paired computer whose thread is on screen, while its line is up. One whose line is down shows nothing and takes nothing. */
export function activeComputer(state: Pick<WorkspaceState, "computers">): PairedComputer | null {
  const { active, paired } = state.computers;
  const computer = active === null ? null : paired.find((computer) => computer.id === active) ?? null;
  return computer?.status === "connected" ? computer : null;
}

/** The selected host may stay on screen offline while its terminal waits to reconnect. */
export function selectedComputer(state: Pick<WorkspaceState, "computers">): PairedComputer | null {
  const computer = state.computers.paired.find((computer) => computer.id === state.computers.active);
  if (!computer) return null;
  if (computer.status === "connected") return computer;
  const dock = computer.state ? frontDock(computer.state).dock : null;
  return dock?.open && dock.terminals.some((terminal) => terminal.id === dock.tab) ? computer : null;
}

const terminalIds = new WeakMap<WorkspaceState["docks"], Set<string>>();

/** Keystrokes must not scan every thread's dock. Output leaves these records unchanged. */
function holdsTerminal(state: Pick<WorkspaceState, "docks">, id: string): boolean {
  let ids = terminalIds.get(state.docks);
  if (!ids) {
    ids = new Set(Object.values(state.docks).flatMap((dock) => dock.terminals.map((terminal) => terminal.id)));
    terminalIds.set(state.docks, ids);
  }
  return ids.has(id);
}

/** The paired computer holding what `holds` finds, or null when this computer holds it or nobody does. */
function holderOf<K extends keyof WorkspaceState>(state: Pick<WorkspaceState, "computers" | K>, holds: (held: Pick<WorkspaceState, K>) => boolean): PairedComputer | null {
  if (holds(state)) return null;
  return state.computers.paired.find((computer) => computer.state && holds(computer.state)) ?? null;
}

/** The paired computer holding a thread, or null for one of this computer's own or one nobody holds. */
export function computerOfThread(state: Pick<WorkspaceState, "computers" | "threads">, taskId: string | undefined): PairedComputer | null {
  return taskId === undefined ? null : holderOf(state, (held) => held.threads.some((thread) => thread.id === taskId));
}

export function computerOfProject(state: Pick<WorkspaceState, "computers" | "projects">, projectId: string | undefined): PairedComputer | null {
  return projectId === undefined ? null : holderOf(state, (held) => held.projects.some((project) => project.id === projectId));
}

/** The paired computer whose project or checkout a workspace id names, or null for one of this computer's own. */
export function computerOfWorkspace(state: Pick<WorkspaceState, "computers" | "projects" | "worktrees">, workspaceId: string): PairedComputer | null {
  return holderOf(state, (held) => held.projects.some((project) => project.workspaceId === workspaceId) || held.worktrees.some((worktree) => worktree.workspaceId === workspaceId));
}

function computerOfWorktree(state: Pick<WorkspaceState, "computers" | "worktrees">, worktreeId: string | undefined): PairedComputer | null {
  return worktreeId === undefined ? null : holderOf(state, (held) => held.worktrees.some((worktree) => worktree.id === worktreeId));
}

/** The paired computer whose checkout is at a root, or null for one of this computer's own or one nobody holds. */
function computerOfWorktreeRoot(state: Pick<WorkspaceState, "computers" | "worktrees" | "managedWorktrees">, root: string | undefined): PairedComputer | null {
  return root === undefined ? null : holderOf(state, (held) => held.worktrees.some((worktree) => worktree.root === root) || Boolean(held.managedWorktrees?.some((worktree) => worktree.root === root)));
}

/**
 * Where a command goes: this computer's reducer, a paired computer's, or nowhere with a reason.
 * `select` puts the computer on screen; `also` applies the command here as well; `draftKey` names
 * the draft a send carries, cleared here once the other computer has taken it.
 */
export type InputRoute =
  | { kind: "local" }
  | { kind: "computer"; computer: PairedComputer; inputs: WorkspaceInput[]; select?: true; also?: true; draft?: SentDraft }
  | { kind: "refuse"; message: string; reason?: "unsupported" };

/** The draft a send carried, whole, so what is typed or changed after it went can be told apart and stays. */
export type SentDraft = {
  key: string; prompt: string; pastes: PastedText[]; annotations: Annotation[];
  /** The sending strip: the main composer or a named side chat, independent of the thread's draft key. */
  attachments?: { key: string; ids: string[] };
};

const LOCAL = { kind: "local" } as const;

/**
 * Whether a command routed here means the window is leaving the paired computer it was showing. A
 * folder opened to start in leaves only when it answers the open dialog's own ask.
 */
export function leavesComputer(state: WorkspaceState, input: WorkspaceInput): boolean {
  if (input.type === "project.added") return input.start === true && (input.request === undefined || state.projectAdd?.request === input.request);
  return isAppCommandType(input.type) && commandLeaves(input.type);
}

export const PANEL_ELSEWHERE = "The browser panel opens only for threads on this computer.";
export const ATTACHMENTS_ELSEWHERE = "Files and folders attached by local path cannot be sent to another computer.";
export const QUEUED_ATTACHMENTS_ELSEWHERE = "A message with images or files cannot be edited from another computer.";
export const FILES_ELSEWHERE = "That folder is on another computer, so it cannot be opened here.";

function forwarded(computer: PairedComputer, inputs: WorkspaceInput[], options: { select?: true; also?: true; draft?: SentDraft } = {}): InputRoute {
  if (inputs.some((input) => !supportsComputerCommand(computer.capabilities, input as AppCommand))) return { kind: "refuse", reason: "unsupported", message: REMOTE_UNSUPPORTED };
  return { kind: "computer", computer, inputs, ...options };
}

/** A command bound for the computer holding what it names, which only a line that is up can carry. */
function toward(computer: PairedComputer | null, route: (computer: PairedComputer) => InputRoute): InputRoute {
  if (!computer) return LOCAL;
  if (computer.status !== "connected") return { kind: "refuse", message: offlineMessage(computer) };
  return route(computer);
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

type Route<C extends AppCommand> = (state: WorkspaceState, input: C, active: PairedComputer | null) => InputRoute;

/** The computer holding the thread a command names, else the one showing the thread on screen. */
function threadHolder(state: WorkspaceState, input: AppCommand, active: PairedComputer | null): PairedComputer | null {
  const taskId = "taskId" in input ? input.taskId : undefined;
  return taskId === undefined ? active : computerOfThread(state, taskId);
}

/** The paired computer holding a thread's queue, with the thread a command without a `taskId` means there. */
export function queueHolder(state: WorkspaceState, taskId: string | undefined): { computer: PairedComputer; taskId: string | undefined } | null {
  const computer = taskId === undefined ? selectedComputer(state) : computerOfThread(state, taskId);
  return computer ? { computer, taskId: taskId ?? computer.state?.currentId ?? undefined } : null;
}

const PLACED: { [At in Exclude<CommandPlacement, "own">]: Route<PlacedCommand<At>> } = {
  local: () => LOCAL,
  thread: (state, input, active) => toward(threadHolder(state, input, active), (holder) => forwarded(holder, [input])),
  panel: (state, input, active) => toward(threadHolder(state, input, active), () => ({ kind: "refuse", message: PANEL_ELSEWHERE })),
  project: (state, input) => toward(computerOfProject(state, input.projectId), (holder) => forwarded(holder, [input])),
  /** A delayed resize or keystroke follows its shell, even after another thread is selected. */
  terminal: (state, input) => {
    if (holdsTerminal(state, input.terminalId)) return LOCAL;
    const holder = state.computers.paired.find((computer) => computer.state && holdsTerminal(computer.state, input.terminalId));
    return holder ? toward(holder, (computer) => forwarded(computer, [input])) : { kind: "refuse", message: "That terminal is no longer available." };
  },
  select: (state, input) => toward(computerOfThread(state, input.taskId), (holder) => selecting(state, holder, [{ type: "task.select", taskId: input.taskId }])),
};

const OWN: { [Type in Exclude<PlacedCommand<"own">["type"], "project.add">]: Route<Extract<AppCommand, { type: Type }>> } = {
  "task.new": (state, input) => toward(computerOfProject(state, input.projectId) ?? computerOfWorktree(state, input.worktreeId), (holder) => selecting(state, holder, [input])),
  "task.send": (state, input, active) => toward(threadHolder(state, input, active), (holder) => forwardedSend(state, holder, input)),
  "attachments.send": (state, input, active) => toward(threadHolder(state, input, active), (holder) => forwardedSend(state, holder, input)),
  /** The queue is the holder's and the draft is this computer's, so the message leaves there and lands here. */
  "task.edit-queued": (state, input, active) => toward(threadHolder(state, input, active), (holder) => {
    const taskId = input.taskId ?? holder.state?.currentId;
    const message = taskId ? holder.state?.queuedMessages[taskId]?.find((item) => item.id === input.messageId) : undefined;
    if (!taskId || !message) return { kind: "refuse", message: "That message has already been sent." };
    /** Its images and files are paths on that computer, which a composer here cannot hold. */
    if (message.attachments.length || message.files?.length) return { kind: "refuse", message: QUEUED_ATTACHMENTS_ELSEWHERE };
    return forwarded(holder, [{ type: "task.drop-queued", taskId, messageId: input.messageId }], { also: true });
  }),
  /** Whether the user is looking is this window's to know and the other computer's to act on. */
  "view.set-focused": (_state, input, active) => active?.status === "connected" ? forwarded(active, [input], { also: true }) : LOCAL,
  /** A file or folder is opened on the machine that has it, which is not this one. */
  "file.open": (state, input, active) => threadHolder(state, input, active) ? { kind: "refuse", message: FILES_ELSEWHERE } : LOCAL,
  "app.open-folder": (_state, _input, active) => active ? { kind: "refuse", message: FILES_ELSEWHERE } : LOCAL,
  "worktree.reveal": (state, input) => computerOfWorktreeRoot(state, input.root) ? { kind: "refuse", message: FILES_ELSEWHERE } : LOCAL,
  /** The location menu opens and is searched here; the checkouts it offers, and what it moves or deletes, are the holder's. */
  "worktree.menu-open": (_state, input, active) => input.list === "destinations" && active ? forwarded(active, [input], { also: true }) : LOCAL,
  "worktree.delete": (state, input, active) => {
    const computer = input.worktreeId !== undefined ? computerOfWorktree(state, input.worktreeId)
      : input.root !== undefined ? computerOfWorktreeRoot(state, input.root)
      : input.taskId !== undefined ? computerOfThread(state, input.taskId) : active;
    return toward(computer, (holder) => forwarded(holder, [input]));
  },
  /** The confirmation is drawn from the holder's list, which it is asked for when it has none with this checkout. */
  "worktree.confirm-delete": (state, input) => {
    const root = input.root;
    if (root === null) return LOCAL;
    return toward(computerOfWorktreeRoot(state, root), (holder) => holder.state?.managedWorktrees?.some((worktree) => worktree.root === root)
      ? LOCAL
      : forwarded(holder, [{ type: "worktree.refresh" }], { also: true }));
  },
};

/** A folder is added on the computer the dialog names, whether or not any other is on screen. */
function addingProject(state: WorkspaceState, input: Extract<AppCommand, { type: "project.add" }>): InputRoute {
  if (!input.computerId || input.computerId === "this") return LOCAL;
  const computer = state.computers.paired.find((item) => item.id === input.computerId);
  if (!computer) return { kind: "refuse", message: "That computer is no longer paired." };
  return toward(computer, (holder) => input.start
    ? selecting(state, holder, [{ type: "project.add", root: input.root, start: true }])
    : forwarded(holder, [{ type: "project.add", root: input.root }]));
}

/** Where a command goes, by the placement it declares. Events, and everything once no computer is paired, stay here. */
export function routeInput(state: WorkspaceState, input: WorkspaceInput): InputRoute {
  if (input.type === "project.add") return addingProject(state, input);
  if (!state.computers.paired.length || !isAppCommandType(input.type)) return LOCAL;
  const command = input as AppCommand;
  const at = commandPlacement(command.type);
  const route = (at === "own" ? OWN[command.type as keyof typeof OWN] : PLACED[at]) as Route<AppCommand>;
  return route(state, command, selectedComputer(state));
}

/** Only missing capabilities hide controls. Ordinary refusals still reach dispatch and explain
 * themselves, including offline hosts and drafts carrying local file paths. */
export function computerCommandAvailable(state: WorkspaceState, command: AppCommand): boolean {
  const route = routeInput(state, command);
  return route.kind !== "refuse" || route.reason !== "unsupported";
}

/** Streaming state does not change which commands a host knows. Keep capability subscribers still
 * until host selection or an advertised list changes; controls read current state when invoked. */
export function createComputerCapabilitySnapshot() {
  let previous: { active: string | null; links: Pick<ComputerLink, "id" | "capabilities" | "status">[] } | undefined;
  return (computers: ComputersState) => {
    if (previous && previous.active === computers.active && previous.links.length === computers.paired.length
      && previous.links.every((link, index) => link.id === computers.paired[index]?.id && link.status === computers.paired[index]?.status && link.capabilities === computers.paired[index]?.capabilities)) return previous;
    previous = { active: computers.active, links: computers.paired.map(({ id, status, capabilities }) => ({ id, status, capabilities })) };
    return previous;
  };
}

/** The computer's state while its line is up; a computer that cannot be reached counts nothing unread. */
function reachable(computer: PairedComputer): WorkspaceState | null {
  return computer.status === "connected" ? computer.state : null;
}

/** Which computers the sidebar's filter lets through. */
export function shownComputers(computers: ComputersState): PairedComputer[] {
  if (computers.filter === "this") return [];
  if (computers.filter === "all") return computers.paired;
  return computers.paired.filter((computer) => computer.id === computers.filter);
}

/** One row's tag: which computer holds it, whether that computer can be reached, and whether it is being dialled again. */
export type ThreadHost = { id: string; name: string; offline: boolean; reconnecting?: boolean };

/** Everything the sidebar needs from the paired computers, gathered once per state. */
export type RemoteCollections = {
  threads: Thread[];
  projects: Project[];
  worktrees: Worktree[];
  worktreeThreadIds: Set<string>;
  busy: Set<string>;
  ranked: Set<string>;
  blocked: Set<string>;
  /** Which computer each remote thread and project belongs to, by id. */
  threadHosts: Map<string, ThreadHost>;
  projectHosts: Map<string, ThreadHost>;
  sideChatAttention: Set<string>;
  unreadCount: number;
};

export const NO_REMOTE_COLLECTIONS: RemoteCollections = { threads: [], projects: [], worktrees: [], worktreeThreadIds: new Set(), busy: new Set(), ranked: new Set(), blocked: new Set(), threadHosts: new Map(), projectHosts: new Map(), sideChatAttention: new Set(), unreadCount: 0 };

export function remoteCollections(computers: ComputersState): RemoteCollections {
  const shown = shownComputers(computers);
  if (!shown.length) return NO_REMOTE_COLLECTIONS;
  const gathered: RemoteCollections = { threads: [], projects: [], worktrees: [], worktreeThreadIds: new Set(), busy: new Set(), ranked: new Set(), blocked: new Set(), threadHosts: new Map(), projectHosts: new Map(), sideChatAttention: new Set(), unreadCount: 0 };
  for (const computer of shown) {
    const remote = computer.state;
    if (!remote) continue;
    /**
     * A computer whose line is down still lists what it last sent, dimmed and taking nothing, so its
     * threads stay where the user left them. It claims no work going on and nothing unread meanwhile.
     */
    const live = computer.status === "connected";
    const host: ThreadHost = { id: computer.id, name: computer.name, offline: !live, reconnecting: computer.status === "connecting" };
    const lists = threadLists(remote);
    for (const thread of lists.visibleThreads) {
      gathered.threads.push(thread);
      gathered.threadHosts.set(thread.id, host);
    }
    for (const project of remote.projects) {
      gathered.projects.push(project);
      gathered.projectHosts.set(project.id, host);
    }
    for (const worktree of remote.worktrees) gathered.worktrees.push(worktree);
    const activity = threadActivity(remote);
    for (const id of lists.worktreeThreadIds) gathered.worktreeThreadIds.add(id);
    if (live) for (const id of activity.working) gathered.busy.add(id);
    for (const id of activity.ranked) gathered.ranked.add(id);
    for (const id of activity.blocked) gathered.blocked.add(id);
    for (const id of lists.sideChatAttention) gathered.sideChatAttention.add(id);
    if (live) gathered.unreadCount += lists.unreadCount;
  }
  return gathered;
}

/** How many threads on every paired computer carry an unseen mark, which the app icon adds to its own. */
export function remoteUnreadCount(computers: ComputersState): number {
  let count = 0;
  for (const computer of computers.paired) {
    const remote = reachable(computer);
    if (remote) count += threadLists(remote).unreadCount;
  }
  return count;
}
