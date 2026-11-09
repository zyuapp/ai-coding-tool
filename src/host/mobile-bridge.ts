import { applyMobilePatch, diffMobileView, mobileArchivedThreads, mobileThreadRead, phoneEditsQueued, phoneReachesThread, projectMobileView, remoteMemberHolder, saysQueuedGone } from "../application/mobile-projection.js";
import { NEW_THREAD_DRAFT, promptKey, type WorkspaceState } from "../application/workspace-state.js";
import type { WorkspaceExecution } from "../application/workspace-execution.js";
import type { WorkspaceCommandResult, WorkspaceEffect, WorkspaceInput } from "../application/workspace-reducer.js";
import type { AppCommand } from "../contracts/commands.js";
import { isMobileQuery, isMobileRequest, type MobileQuery, type MobileRequest, type MobileResponse, type MobileView, type MobileViewUpdate } from "../contracts/mobile.js";
import { isPhoneCommand, isWorkspaceViewInput } from "../contracts/workspace-view-input.js";
import type { RuntimeDesktop } from "./runtime-desktop.js";
import type { MobileServerState } from "../domain/mobile.js";
import { threadWorkspaceId, threadWorkspaceRoot } from "../application/thread-location.js";
import { messageImagePath } from "../domain/message-artifacts.js";
import { attachmentSendFor } from "../application/composer-attachments.js";
import { drainingQueued, editableQueued } from "../application/workspace-reducer/run-queue.js";
import { QUEUED_SENT } from "../application/computers.js";
import { REMOTE_UNSUPPORTED } from "../contracts/computer-capabilities.js";
import { errorMessage } from "./errors.js";

/** What a phone is refused with when it sends something outside the surface open to it. */
export const MOBILE_REFUSED = "That command is not one a phone may send.";

/** What a phone is refused with when it asks to edit a queued message carrying more than words. */
export const MOBILE_QUEUED_NOT_WORDS = "A message with images, files, pasted text or notes can only be edited on the computer.";

/** What a phone is refused with when it asks to review a thread that has no checkout. */
export const MOBILE_NO_CHECKOUT = "This thread has no checkout to review.";

/** The reads a phone's queries are answered from. Content only; state never travels this way. */
export type MobileBridgeReader = Pick<RuntimeDesktop, "diffSummary" | "diffPatch" | "directories" | "transcribeAudio" | "readMessageImage">;

/** The runtime state and the command execution that answers each phone request. */
export type MobileBridgeHost = {
  state: () => WorkspaceState;
  dispatch: (input: WorkspaceInput) => Promise<void> | void;
  execute: (command: AppCommand) => WorkspaceExecution;
  /** Absent in a host that answers no queries, which refuses them rather than read nothing. */
  read?: MobileBridgeReader;
  /** Loads a thread's stored transcript into the workspace, which a thread not on screen has yet to do. */
  hydrate?: (taskId: string) => Promise<void>;
};

/**
 * A review query names a thread, and the thread names the checkout: a phone never says which directory
 * to read. Whitespace-only changes are left out, as the desktop's review leaves them out by default. A
 * folder query lists folders by path prefix, as the desktop's own add-project field does. A thread
 * query reads a thread the phone may name without opening it, as a coordinator's tab does, one on a
 * paired computer from what that computer last published here. An
 * image query reads only an image the named reply links, as the desktop's previews of it do. An
 * archived query lists what the Archive settings page lists.
 */
async function answerQuery(host: MobileBridgeHost, query: MobileQuery): Promise<unknown> {
  if (query.kind === "archived") return mobileArchivedThreads(host.state());
  if (query.kind === "thread") {
    const remote = remoteMemberHolder(host.state(), query.taskId)?.state;
    if (remote) return mobileThreadRead(remote, query.taskId) ?? Promise.reject(new Error(`No thread has the ID ${query.taskId}.`));
    if (!host.state().threads.some((thread) => thread.id === query.taskId)) throw new Error(`No thread has the ID ${query.taskId}.`);
    await host.hydrate?.(query.taskId);
    return mobileThreadRead(host.state(), query.taskId) ?? Promise.reject(new Error(`No thread has the ID ${query.taskId}.`));
  }
  const reader = host.read;
  if (!reader) throw new Error("This computer cannot answer that.");
  if (query.kind === "directories") return reader.directories(query.prefix);
  if (query.kind === "transcribe") return { text: await reader.transcribeAudio(query.audio) };
  if (query.kind === "image") return linkedImage(host, reader, query);
  const state = host.state();
  const thread = state.threads.find((item) => item.id === query.taskId);
  if (!thread) throw new Error(`No thread has the ID ${query.taskId}.`);
  const workspaceId = threadWorkspaceId(state, thread);
  if (!workspaceId) throw new Error(MOBILE_NO_CHECKOUT);
  if (query.kind === "diff-summary") return reader.diffSummary(workspaceId, query.range, true);
  return reader.diffPatch(workspaceId, query.range, query.path, query.previousPath, true);
}

let images: Promise<typeof import("../application/message-images.js")> | undefined;

/** An image in a reply of a thread on a paired computer is read there, from that computer's checkout. */
async function linkedImage(host: MobileBridgeHost, reader: MobileBridgeReader, query: Extract<MobileQuery, { kind: "image" }>) {
  const remote = remoteMemberHolder(host.state(), query.taskId)?.state;
  if (!remote && !host.state().threads.some((thread) => thread.id === query.taskId)) throw new Error(`No thread has the ID ${query.taskId}.`);
  if (!remote) await host.hydrate?.(query.taskId);
  const state = remote ?? host.state();
  const thread = state.threads.find((item) => item.id === query.taskId);
  const message = thread?.messages.find((item) => item.id === query.messageId);
  const file = messageImagePath(query.href);
  const { messageImages } = await (images ??= import("../application/message-images.js"));
  if (!thread || message?.kind !== "assistant" || !file || !messageImages(message.text).some((image) => image.path === file)) throw new Error("That reply links no such image.");
  return reader.readMessageImage(file, threadWorkspaceRoot(state, thread) ?? "", message.id, query.preview === true, thread.id);
}

/**
 * A phone's edit takes a queued message's words back to its own composer, so the computer's composer
 * never holds them: the message leaves the queue of whichever computer holds the thread, as a paired
 * computer's edit takes it, or the phone is told why it cannot.
 */
function editedQueued(state: WorkspaceState, command: Extract<AppCommand, { type: "task.edit-queued" }>): { drop: AppCommand; taskId: string; text: string } | { refusal: string } {
  const taskId = command.taskId;
  if (taskId === undefined) return { refusal: QUEUED_SENT };
  const remote = remoteMemberHolder(state, taskId);
  if (remote && !saysQueuedGone(remote)) return { refusal: REMOTE_UNSUPPORTED };
  const holder = remote?.state ?? state;
  const edit = editableQueued(holder.queuedMessages[taskId] ?? [], command.messageId);
  if ("refusal" in edit) return edit;
  if (drainingQueued(holder, taskId, edit.message.id)) return { refusal: QUEUED_SENT };
  if (!phoneEditsQueued(edit.message)) return { refusal: MOBILE_QUEUED_NOT_WORDS };
  return { drop: { type: "task.drop-queued", taskId, messageId: command.messageId, ifWaiting: true }, taskId, text: edit.message.text };
}

/** How long a phone's edit waits for the computer holding the queue, well inside the relay's own deadline. */
export const MOBILE_EDIT_WAIT_MS = 5_000;

export const MOBILE_EDIT_LATE = "That computer has not answered yet. If it takes the message out, its words wait in this computer's composer.";

/**
 * The phone hears the edit went through only once the computer holding the queue says the message
 * left it. A line that drops can still carry the drop minutes later, so a holder that has not
 * answered in time leaves the phone told so, and the words of a drop it takes later wait in this
 * computer's composer for the thread rather than being lost.
 */
async function answerEdit(host: MobileBridgeHost, command: Extract<AppCommand, { type: "task.edit-queued" }>): Promise<WorkspaceCommandResult> {
  const edited = editedQueued(host.state(), command);
  if ("refusal" in edited) return { ok: false, message: edited.refusal };
  const execution = host.execute(edited.drop);
  /** Acceptance can itself wait, behind a read of the thread's history, so the wait covers it too. */
  const outcome = (async () => {
    const accepted = await execution.accepted;
    return accepted.ok ? execution.completed : accepted;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MOBILE_EDIT_WAIT_MS); });
  const answer = await Promise.race([outcome, late]).finally(() => clearTimeout(timer));
  if (answer) return answer;
  const { taskId } = edited;
  void outcome.then((result) => {
    if (!result.ok) return;
    const typed = host.state().prompts[taskId] ?? "";
    host.execute({ type: "view.set-prompt", taskId, prompt: [edited.text, typed].filter(Boolean).join("\n\n") });
  });
  return { ok: false, message: MOBILE_EDIT_LATE };
}

/** What a phone is refused with when it sends from the new thread's draft before the last send from there has started. */
export const MOBILE_DRAFT_BUSY = "The last message from this new thread is still on its way. Send again once its thread opens.";

/** Whether a phone's command writes or sends the new thread's draft, which the computer has open. */
function touchesDraft(state: WorkspaceState, command: AppCommand): boolean {
  if (promptKey(state) !== NEW_THREAD_DRAFT) return false;
  if (command.type === "view.set-prompt" || command.type === "attachments.send") return command.taskId === undefined;
  return command.type === "task.send" && command.taskId === undefined && command.text === undefined;
}

/** Whether a send from the new thread's draft has yet to start: its images are being written, or its run is starting. */
function draftSending(state: WorkspaceState): boolean {
  return attachmentSendFor(state.attachmentSends).busy || Object.values(state.pendingRuns).some((pending) => pending.draftKey === NEW_THREAD_DRAFT);
}

/**
 * A phone's images leave its composer at once, so a send to a thread carries its words, even none.
 * One from the new thread's draft goes as the composer's own draft send does: its words become the
 * draft's, so the thread starts where the draft points and opens once it runs.
 */
function phoneCommands(state: WorkspaceState, command: AppCommand): AppCommand[] {
  if (command.type !== "attachments.send") return [command];
  if (command.taskId === undefined && promptKey(state) === NEW_THREAD_DRAFT) {
    const { text, ...send } = command;
    return [{ type: "view.set-prompt", prompt: text ?? "" }, send];
  }
  return [command.text === undefined ? { ...command, text: "" } : command];
}

/**
 * Each phone reads a projection of runtime state and writes through the shared command path.
 * Commands are validated at this boundary before reaching the reducer.
 */
export async function answerMobileRequest(host: MobileBridgeHost, request: MobileRequest): Promise<MobileResponse> {
  const requestId = request.requestId;
  const ok = (result: unknown): MobileResponse => ({ type: "mobile.response", requestId, ok: true, result });
  const failed = (message: string): MobileResponse => ({ type: "mobile.response", requestId, ok: false, message });
  try {
    if (request.op === "snapshot") return ok(projectMobileView(host.state(), Date.now()));
    if (request.op === "query") {
      if (!isMobileQuery(request.query)) return failed(MOBILE_REFUSED);
      return ok(await answerQuery(host, request.query));
    }
    /** What a phone may send, and then every field as the window's own checks read it. */
    if (!isPhoneCommand(request.command) || !isWorkspaceViewInput(request.command)) return failed(MOBILE_REFUSED);
    const taskId = "taskId" in request.command ? request.command.taskId : undefined;
    if (taskId !== undefined && !phoneReachesThread(host.state(), taskId)) return failed(`No thread has the ID ${taskId}.`);
    /** The draft holds one send's words, so nothing may rewrite or send it until the last send from it has started. */
    if (touchesDraft(host.state(), request.command) && draftSending(host.state())) return failed(MOBILE_DRAFT_BUSY);
    if (request.command.type === "task.edit-queued") {
      const edited = await answerEdit(host, request.command);
      if (!edited.ok) return failed(edited.message);
      return ok(projectMobileView(host.state(), Date.now()));
    }
    for (const command of phoneCommands(host.state(), request.command)) {
      const execution = host.execute(command);
      const accepted = execution.accepted instanceof Promise ? await execution.accepted : execution.accepted;
      if (!accepted.ok) return failed(accepted.message);
    }
    return ok(projectMobileView(host.state(), Date.now()));
  } catch (error) {
    return failed(errorMessage(error));
  }
}

/**
 * The view every connected phone holds, so a change can be sent as the difference. It is what the
 * patches built rather than the newest projection: a patch may leave out what moved too little to
 * draw, and the next one is measured against what the phones actually have.
 */
export type MobileViewHolder = { current: MobileView | null };

export function noMobileView(): MobileViewHolder {
  return { current: null };
}

/**
 * What to push after a state change: nothing while no phone is connected, a whole view for the first
 * change after one arrives, and the difference from then on.
 */
export function nextMobileUpdate(held: MobileViewHolder, state: WorkspaceState, at: number): MobileViewUpdate | null {
  if (!state.remote.sessions.length) {
    held.current = null;
    return null;
  }
  const view = projectMobileView(state, at);
  const previous = held.current;
  if (!previous) {
    held.current = view;
    return { kind: "snapshot", view };
  }
  const patch = diffMobileView(previous, view);
  if (!patch) return null;
  held.current = applyMobilePatch(previous, patch) ?? view;
  return { kind: "patch", patch };
}

/** The settings the bridge keeps in main, which is where the socket, the tokens and Tailscale live. */
export type RemoteEffect = Extract<WorkspaceEffect, { type: `remote.${string}` }>;

/** Each one answers with the whole bridge state, so the reducer never infers what a change did to it. */
export async function runRemoteEffect(effect: RemoteEffect, desktop: RuntimeDesktop): Promise<MobileServerState> {
  switch (effect.type) {
    case "remote.set-enabled": return desktop.setMobileEnabled(effect.enabled);
    /** The offer the QR draws is read back from the bridge state, which is all settings draws. */
    case "remote.create-pairing-code": return desktop.createMobilePairingCode().then(() => desktop.mobileState());
    case "remote.revoke-device": return desktop.revokeMobileDevice(effect.deviceId);
    case "remote.refresh": return desktop.refreshTailscale();
  }
}

/** What main pushes about the bridge, and the phone messages it forwards for the window to answer. */
export function subscribeToMobile(host: MobileBridgeHost, desktop: RuntimeDesktop): () => void {
  void desktop.mobileState()
    .then((remote) => host.dispatch({ type: "remote.changed", remote }))
    .catch((error) => host.dispatch({ type: "action.failed", message: errorMessage(error) }));
  const stopWatching = desktop.onMobileState((remote) => void host.dispatch({ type: "remote.changed", remote }));
  /** A request is read as a stranger's even across the preload, so a malformed one is never answered. */
  const answering: MobileBridgeHost = { ...host, read: desktop };
  const stopAnswering = desktop.onMobileRequest((request) => {
    if (!isMobileRequest(request)) return;
    void answerMobileRequest(answering, request).then((response) => desktop.answerMobileRequest(response));
  });
  return () => {
    stopWatching();
    stopAnswering();
  };
}
