import { workspaceCommandDefinitions } from "../../src/contracts/workspace-view-input.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import { executeWorkspaceInput } from "../../src/application/workspace-execution.ts";
import { computerEffects } from "../../src/host/computer-effects.ts";
import type { EffectHost } from "../../src/host/effect-host.ts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { ATTACHMENTS_ELSEWHERE, FILES_ELSEWHERE, PANEL_ELSEWHERE, routeInput, computerCommandAvailable, createComputerCapabilitySnapshot, type PairedComputer } from "../../src/application/computers.ts";
import { reduce, type WorkspaceEffect, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
import { activeRun, effectOf, task, workspace } from "./workspace-reducer-fixtures.mts";

const link = (id: string, overrides: Partial<ComputerLink> = {}): ComputerLink => ({ id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, ...overrides });

/** A paired computer with a workspace of its own: one project, and one thread in it. */
function paired(id: string, remote: WorkspaceState, overrides: Partial<ComputerLink> = {}): PairedComputer {
  return { ...link(id, overrides), state: remote };
}

const remoteThread = task("remote-thread", { projectId: "remote-project", title: "Remote work" });
const remoteState = workspace({
  projects: [{ id: "remote-project", root: "/linux/app", workspaceId: "ws-remote" }],
  threads: [remoteThread],
  currentId: "remote-thread",
  theme: "catppuccin-latte",
});

function withComputers(state: WorkspaceState, computers: PairedComputer[], extra: Partial<WorkspaceState["computers"]> = {}): WorkspaceState {
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: computers, ...extra } };
}

test("remote side chats display local drafts through typing, host updates, and send acknowledgement", () => {
  const chatId = "remote-chat";
  let remote = reduce(remoteState, { type: "side-chat.open", chatId }).state;
  remote = reduce(remote, { type: "view.set-prompt", taskId: chatId, prompt: "Host draft" }).state;
  let state = withComputers(workspace({ prompts: { "remote-thread": "Main draft" } }), [paired("linux", remote)], { active: "linux" });
  assert.equal(deriveView(state).sideChats[0].prompt, "", "the host's draft belongs to its own window");
  for (const prompt of ["H", "Hello", "", "Send this"]) {
    const typed = reduce(state, { type: "view.set-prompt", taskId: chatId, prompt });
    assert.deepEqual(typed.effects, [], "keystrokes stay local");
    state = typed.state;
    assert.equal(deriveView(state).sideChats[0].prompt, prompt);
    assert.equal(deriveView(state).prompt, "Main draft");
  }
  state = reduce(state, { type: "paste.add", taskId: chatId, text: "Local log" }).state;
  state = reduce(state, { type: "annotation.recall", taskId: chatId, annotations: [{ id: "note", quote: "Selected text", note: "Local comment" }] }).state;
  remote = { ...remote, activeRuns: { [chatId]: activeRun(chatId, "remote-run") } };
  state = reduce(state, { type: "computer.state", id: "linux", state: remote }).state;
  const chat = deriveView(state).sideChats[0];
  assert.equal(chat.prompt, "Send this");
  assert.equal(chat.running, true, "run status still comes from the host");
  assert.equal(chat.thread, remote.threads.find((thread) => thread.id === chatId));
  assert.equal(chat.pastes, state.pastes[chatId]);
  assert.equal(chat.annotations, state.annotations[chatId]);
  const sent = reduce(state, { type: "attachments.send", taskId: chatId, attachments: [] });
  const forward = effectOf(sent, "computer.forward");
  assert.equal(forward.id, "linux");
  assert.deepEqual(forward.inputs[0], { type: "view.set-prompt", taskId: chatId, prompt: "Send this" });
  assert.equal(deriveView(sent.state).sideChats[0].prompt, "Send this", "the draft stays until acknowledged");
  const taken = deriveView(reduce(sent.state, { type: "computers.forwarded", draft: forward.draft! }).state);
  assert.equal(taken.sideChats[0].prompt, "");
  assert.deepEqual(taken.sideChats[0].pastes, []);
  assert.deepEqual(taken.sideChats[0].annotations, []);
  assert.equal(taken.prompt, "Main draft");
});

test("remote side chat attachment drafts are isolated and unrelated edits preserve their views", () => {
  let remote = reduce(remoteState, { type: "side-chat.open", chatId: "chat-one" }).state;
  remote = reduce(remote, { type: "side-chat.open", chatId: "chat-two" }).state;
  remote = reduce(remote, { type: "image.recall", taskId: "chat-two", paths: ["/linux/host.png"] }).state;
  let state = withComputers(workspace(), [paired("linux", remote)], { active: "linux" });
  state = reduce(state, { type: "image.recall", taskId: "chat-one", paths: ["/mac/local.png"] }).state;
  state = reduce(state, { type: "file.recall", taskId: "chat-one", files: [{ id: "file", name: "local.ts", path: "/mac/local.ts" }] }).state;
  const before = deriveView(state).sideChats;
  assert.equal(before[0].images, state.images["chat-one"]);
  assert.equal(before[0].files, state.files["chat-one"]);
  assert.deepEqual(before[1].images, []);
  assert.deepEqual(before[1].files, []);
  state = reduce(state, { type: "view.set-prompt", prompt: "Main edit" }).state;
  assert.equal(deriveView(state).sideChats, before);
  state = reduce(state, { type: "view.set-prompt", taskId: "chat-one", prompt: "Side edit" }).state;
  const after = deriveView(state).sideChats;
  assert.equal(after[0].prompt, "Side edit");
  assert.equal(after[1], before[1]);
  state = reduce(state, { type: "image.remove", taskId: "chat-one", imageId: after[0].images[0].id }).state;
  state = reduce(state, { type: "file.detach", taskId: "chat-one", fileId: "file" }).state;
  assert.deepEqual(deriveView(state).sideChats[0].images, []);
  assert.deepEqual(deriveView(state).sideChats[0].files, []);
});

test("dismiss all clears local and remote Priority with one scoped request per computer", () => {
  const computers = ["claude", "codex"].map((engine) => {
    const threads = Array.from({ length: 40 }, (_, index) => task(`${engine}-${index}`, {
      engine: engine as "claude" | "codex", outcome: "finished", outcomeUnread: true,
      findings: [{ id: `finding-${index}`, headline: "Review", key: `issue-${index}`, at: 1 }],
    }));
    return paired(engine, workspace({ threads, currentId: threads[0].id, sidebarMode: "activity" }), { capabilities: COMPUTER_CAPABILITIES });
  });
  const state = withComputers(workspace({ threads: [task("local", { outcome: "finished" })], currentId: "local" }), computers, { active: "codex" });
  const dismissed = reduce(state, { type: "task.dismiss-all" });
  assert.equal(dismissed.state.threads[0].outcome, undefined);
  assert.equal(dismissed.state.currentId, "local");
  assert.equal(dismissed.state.computers, state.computers, "remote state waits for its host's update");
  const forwards = dismissed.effects.filter((effect) => effect.type === "computer.forward");
  assert.equal(forwards.length, 2);
  for (const effect of forwards) {
    assert.deepEqual(effect.inputs, [{ type: "task.dismiss-all", localOnly: true }]);
    const computer = computers.find((item) => item.id === effect.id)!;
    const remote = reduce(computer.state!, effect.inputs[0]);
    assert.equal(remote.state.currentId, computer.state!.currentId);
    assert.ok(remote.state.threads.every((thread) => !thread.outcome && !thread.findings && thread.handledIssues?.length === 1));
    const refreshed = { ...dismissed.state, computers: { ...dismissed.state.computers, paired: [{ ...computer, state: remote.state }] } };
    assert.deepEqual(deriveView(refreshed).activityThreads.priority, []);
  }
});

test("dismiss all follows the sidebar's computer filter", () => {
  const computers = ["one", "two"].map((id) => paired(id, workspace({ threads: [task(id, { outcome: "failed" })] })));
  for (const filter of ["this", "one", "all"] as const) {
    const state = withComputers(workspace({ threads: [task("local", { outcome: "finished" })] }), computers, { filter, active: "two" });
    const dismissed = reduce(state, { type: "task.dismiss-all" });
    assert.equal(dismissed.state.threads[0].outcome, filter === "one" ? "finished" : undefined);
    assert.deepEqual(dismissed.effects.filter((effect) => effect.type === "computer.forward").map((effect) => effect.id), filter === "this" ? [] : filter === "one" ? ["one"] : ["one", "two"]);
  }
});

test("a forwarded dismissal stays on its host regardless of its filter or paired computers", () => {
  const threads = [task("done", { outcome: "finished" }), task("busy", { outcome: "finished" }), task("blocked"),
    task("archived", { outcome: "finished", archivedAt: 1 }), task("snoozed", { outcome: "finished", snoozedUntil: Date.now() + 3_600_000 }),
    task("chat", { outcome: "finished" })];
  const state = withComputers(workspace({
    threads, currentId: "done", sidebarMode: "activity",
    activeRuns: { busy: activeRun("busy", "r1"), blocked: activeRun("blocked", "r2", { status: "awaiting-approval" }) },
    sideChats: [{ id: "chat", sourceThreadId: "done", error: null }],
  }), [paired("other", workspace({ threads: [task("elsewhere", { outcome: "finished" })] }))], { filter: "other", active: "other" });
  const dismissed = reduce(state, { type: "task.dismiss-all", localOnly: true });
  assert.equal(dismissed.state.threads[0].outcome, undefined);
  assert.deepEqual(dismissed.state.threads.slice(1), threads.slice(1));
  assert.equal(dismissed.state.activeRuns, state.activeRuns);
  assert.equal(dismissed.state.computers, state.computers);
  assert.equal(dismissed.state.currentId, "done");
  assert.equal(dismissed.effects.some((effect) => effect.type === "computer.forward"), false);
});

test("dismiss all reports unavailable computers while still reaching available ones", () => {
  const remote = workspace({ threads: [task("remote", { outcome: "finished" })] });
  const computers = [paired("offline", remote, { status: "offline" }), paired("unsupported", remote, { capabilities: [] }),
    paired("online", remote), paired("quiet", workspace(), { status: "offline" })];
  const state = withComputers(workspace({ threads: [task("local", { outcome: "finished" })] }), computers);
  const dismissed = reduce(state, { type: "task.dismiss-all" });
  assert.equal(dismissed.state.threads[0].outcome, undefined);
  assert.equal(dismissed.state.computers, state.computers);
  assert.equal(dismissed.result?.ok, false);
  assert.match(dismissed.state.actionError!, /offline is offline/);
  assert.match(dismissed.state.actionError!, /unsupported:/);
  assert.doesNotMatch(dismissed.state.actionError!, /quiet/);
  assert.deepEqual(dismissed.effects.filter((effect) => effect.type === "computer.forward").map((effect) => effect.id), ["online"]);
});

test("dismiss all uses the original local-only command on hosts predating its scope field", () => {
  const older = COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.dismiss-all:localOnly");
  const state = withComputers(workspace(), [paired("older", workspace({ threads: [task("remote", { outcome: "finished" })] }), { capabilities: older })]);
  assert.deepEqual(effectOf(reduce(state, { type: "task.dismiss-all" }), "computer.forward").inputs, [{ type: "task.dismiss-all" }]);
});

test("with no computer paired every command stays where it is", () => {
  const state = workspace({ threads: [task("local")] });
  assert.deepEqual(routeInput(state, { type: "task.select", taskId: "local" }), { kind: "local" });
  assert.deepEqual(routeInput(state, { type: "task.select", taskId: "remote-thread" }), { kind: "local" });
});

test("selecting a paired computer's thread carries the selection there and puts that computer on screen", () => {
  const state = withComputers(workspace({ threads: [task("local")] }), [paired("linux", remoteState)]);
  const route = routeInput(state, { type: "task.select", taskId: "remote-thread" });
  assert.equal(route.kind, "computer");
  if (route.kind !== "computer") return;
  assert.equal(route.computer.id, "linux");
  assert.equal(route.select, true);
  const after = reduce(state, { type: "task.select", taskId: "remote-thread" });
  assert.equal(after.state.computers.active, "linux");
  assert.deepEqual(effectOf(after, "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: true }, { type: "task.select", taskId: "remote-thread" }] });
  assert.equal(after.state.currentId, null, "this computer's own thread is untouched");
});

test("a send to the thread on screen puts the draft typed here into that computer's composer, and lets go of it once taken", () => {
  let state = withComputers(workspace(), [paired("linux", remoteState)], { active: "linux" });
  state = reduce(state, { type: "view.set-prompt", prompt: "Fix the header" }).state;
  assert.equal(state.prompts["remote-thread"], "Fix the header", "the draft is keyed by the other computer's open thread");
  state = reduce(state, { type: "paste.add", text: "some log" }).state;
  const annotations = [{ id: "a1", quote: "header", note: "first thought" }, { id: "a2", quote: "footer", note: "second" }];
  state = reduce(state, { type: "annotation.recall", annotations }).state;
  const sent = reduce(state, { type: "task.send", attachments: [], steer: true });
  const forward = effectOf(sent, "computer.forward");
  assert.equal(forward.id, "linux");
  const pastes = sent.state.pastes["remote-thread"]!;
  assert.deepEqual(forward.draft, { key: "remote-thread", prompt: "Fix the header", pastes, annotations });
  assert.deepEqual(forward.inputs, [
    { type: "view.set-prompt", taskId: "remote-thread", prompt: "Fix the header" },
    { type: "annotation.recall", taskId: "remote-thread", annotations },
    { type: "paste.recall", taskId: "remote-thread", pastes },
    { type: "task.send", taskId: "remote-thread", steer: true },
  ]);
  assert.equal(sent.state.prompts["remote-thread"], "Fix the header", "the draft stays until the other computer has it");
  const taken = reduce(sent.state, { type: "computers.forwarded", draft: forward.draft! }).state;
  assert.equal(taken.prompts["remote-thread"], undefined);
  assert.deepEqual(taken.pastes["remote-thread"] ?? [], []);
  /** What is typed while the send is on its way is not the send's to take. */
  let meanwhile = reduce(sent.state, { type: "view.set-prompt", prompt: "Fix the header and the footer" }).state;
  meanwhile = reduce(meanwhile, { type: "paste.add", text: "later log" }).state;
  meanwhile = reduce(meanwhile, { type: "annotation.note", annotationId: "a1", note: "second thought" }).state;
  const later = reduce(meanwhile, { type: "computers.forwarded", draft: forward.draft! }).state;
  assert.equal(later.prompts["remote-thread"], "and the footer");
  assert.deepEqual(later.pastes["remote-thread"]?.map((paste) => paste.text), ["later log"]);
  assert.deepEqual(later.annotations["remote-thread"], [{ id: "a1", quote: "header", note: "second thought" }], "a note changed since is not the one that went");
});

test("a send with text of its own goes as it is, and a refused send leaves the draft here", () => {
  const state = withComputers(workspace({ prompts: { "remote-thread": "kept" } }), [paired("linux", remoteState)], { active: "linux" });
  const forward = effectOf(reduce(state, { type: "task.send", text: "From an agent", taskId: "remote-thread" }), "computer.forward");
  assert.deepEqual(forward, { type: "computer.forward", id: "linux", inputs: [{ type: "task.send", text: "From an agent", taskId: "remote-thread" }] });
  assert.equal(reduce(state, { type: "action.failed", message: "Refused there" }).state.prompts["remote-thread"], "kept");
});

test("a send starting a thread in a folder elsewhere names the folder and carries the draft under that folder's key", () => {
  const drafting = { ...remoteState, currentId: null, draftProjectId: "remote-project" };
  let state = withComputers(workspace(), [paired("linux", drafting)], { active: "linux" });
  state = reduce(state, { type: "view.set-prompt", prompt: "Start here" }).state;
  assert.equal(state.prompts["draft:remote-project"], "Start here");
  const forward = effectOf(reduce(state, { type: "task.send", attachments: [], project: "remote-project", model: "opus" }), "computer.forward");
  assert.deepEqual(forward.inputs, [
    { type: "view.set-prompt", taskId: "draft:remote-project", prompt: "Start here" },
    { type: "annotation.recall", taskId: "draft:remote-project", annotations: [] },
    { type: "paste.recall", taskId: "draft:remote-project", pastes: [] },
    { type: "task.send", project: "remote-project", model: "opus" },
  ]);
});

test("moving to a thread here takes the paired computer off screen and tells it nobody is looking, leaving its own composer alone", () => {
  const state = withComputers(workspace({ threads: [task("local")] }), [paired("linux", remoteState), paired("other", { ...remoteState, threads: [task("far", { projectId: "remote-project" })] })], { active: "linux" });
  const home = reduce(state, { type: "task.select", taskId: "local" });
  assert.equal(home.state.computers.active, null);
  assert.equal(home.state.currentId, "local");
  const away: WorkspaceEffect[] = [{ type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: false }] }];
  assert.deepEqual(home.effects.filter((effect) => effect.type === "computer.forward"), away);
  const fresh = reduce(state, { type: "task.new" });
  assert.equal(fresh.state.computers.active, null);
  assert.deepEqual(effectOf(fresh, "computer.forward"), away[0]);
  const theirs = reduce(remoteState, { type: "view.set-focused", focused: false }).state;
  assert.equal(theirs.currentId, "remote-thread", "the other computer's window stays on the thread its user had open");
  assert.equal(theirs.focused, false);
  const across = reduce(state, { type: "task.select", taskId: "far" });
  assert.equal(across.state.computers.active, "other");
  assert.deepEqual(across.effects.filter((effect) => effect.type === "computer.forward").map((effect) => effect.type === "computer.forward" && effect.id), ["linux", "other"]);
});

test("a new thread starts where the user is looking: on the paired computer's screen, in its project", () => {
  const local = workspace({ projects: [{ id: "p-local", root: "/mac/app", workspaceId: "ws-local" }], threads: [task("local", { projectId: "p-local" })], currentId: "local" });
  const state = withComputers(local, [paired("linux", remoteState)], { active: "linux" });
  const fresh = reduce(state, { type: "view.shortcut", action: "thread.new", surface: "any" });
  assert.equal(fresh.state.computers.active, "linux", "the new thread is that computer's, so it stays on screen");
  assert.equal(fresh.state.currentId, "local", "this computer's own thread is untouched");
  assert.deepEqual(effectOf(fresh, "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: true }, { type: "task.new", projectId: "remote-project" }] });
  const chatting = withComputers(local, [paired("linux", { ...remoteState, currentId: null, draftProjectId: null })], { active: "linux" });
  const chat = reduce(chatting, { type: "view.shortcut", action: "thread.new", surface: "any" });
  assert.equal(chat.state.computers.active, null, "a chat has no project to start on the other computer, so it starts here");
  assert.equal(chat.state.currentId, null);
  assert.equal(chat.state.draftProjectId, null, "as a chat, not in the project this computer's last thread was in");
});

test("whether the window is looking is kept here and told to the computer on screen, and only what is on screen is read", () => {
  const unseen = task("local", { outcome: "finished", outcomeUnread: true });
  const state = withComputers(workspace({ focused: true, threads: [unseen], currentId: "local" }), [paired("linux", remoteState)], { active: "linux" });
  const away = reduce(state, { type: "view.set-focused", focused: false });
  assert.equal(away.state.focused, false);
  assert.equal(away.state.computers.active, "linux");
  assert.deepEqual(effectOf(away, "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: false }] });
  const back = reduce(away.state, { type: "view.set-focused", focused: true }).state;
  assert.equal(back.threads[0]?.outcomeUnread, true, "the thread behind the other computer's has not been looked at");
  const home = reduce({ ...back, computers: { ...back.computers, active: null } }, { type: "view.set-focused", focused: true }).state;
  assert.equal(home.threads[0]?.outcomeUnread, undefined);
});

test("a line that comes back is told nothing until one of its threads is selected again", () => {
  const state = withComputers(workspace({ focused: false }), [paired("linux", remoteState, { status: "offline" })]);
  const back = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("linux")] });
  assert.equal(back.effects.length, 0);
  assert.equal(back.state.computers.active, null);
  const chosen = reduce(back.state, { type: "task.select", taskId: "remote-thread" });
  assert.equal(chosen.state.computers.active, "linux");
  assert.deepEqual(effectOf(chosen, "computer.forward").inputs[0], { type: "view.set-focused", focused: false });
});

test("what only this computer's panels can do is refused for a thread elsewhere, and so are attachments that only carry paths", () => {
  const state = withComputers(workspace(), [paired("linux", remoteState)], { active: "linux" });
  assert.deepEqual(effectOf(reduce(state, { type: "terminal.open" }), "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "terminal.open" }] });
  assert.deepEqual(routeInput(state, { type: "browser.new-tab" }), { kind: "refuse", reason: "unsupported", message: PANEL_ELSEWHERE });
  assert.deepEqual(routeInput(state, { type: "file.open", path: "src/app.ts" }), { kind: "refuse", message: FILES_ELSEWHERE });
  assert.deepEqual(routeInput(state, { type: "app.open-folder", appId: "cursor" }), { kind: "refuse", message: FILES_ELSEWHERE });
  assert.deepEqual(routeInput(state, { type: "task.send", attachments: [{ path: "/tmp/shot.png", labels: [] }] }), { kind: "refuse", message: ATTACHMENTS_ELSEWHERE });
  assert.equal(reduce(state, { type: "terminal.open" }).result?.ok, true);
});

test("the window's own affairs stay here whichever computer is on screen, and events are never carried", () => {
  const state = withComputers(workspace(), [paired("linux", remoteState)], { active: "linux" });
  for (const input of [
    { type: "view.set-theme", theme: "x" },
    { type: "view.set-sidebar-open", open: false },
    { type: "engine.read" },
    { type: "computers.filter", filter: "this" },
    { type: "action.failed", message: "nothing to carry" },
    { type: "computer.state", id: "linux", state: remoteState },
  ] as const) assert.deepEqual(routeInput(state, input), { kind: "local" }, input.type);
  assert.deepEqual(routeInput(state, { type: "run.cancel" }).kind, "computer", "a run control about the thread on screen goes to its computer");
  assert.deepEqual(routeInput(state, { type: "task.new" }), { kind: "local" }, "a new thread with no folder named starts here");
  const inProject = routeInput(state, { type: "task.new", projectId: "remote-project" });
  assert.equal(inProject.kind === "computer" && inProject.select, true, "a new thread in a folder on the other computer starts there");
});

test("the sidebar lists every computer's threads, tagged, and the filter narrows them", () => {
  const local = task("local", { title: "Local work" });
  const state = withComputers(workspace({ threads: [local] }), [paired("linux", remoteState, { status: "offline" })]);
  const view = deriveView(state);
  assert.deepEqual(view.activityThreads.threads.map((thread) => thread.id).sort(), ["local", "remote-thread"]);
  assert.deepEqual(view.threadHosts.get("remote-thread"), { id: "linux", name: "linux", offline: true });
  assert.equal(view.threadHosts.get("local"), undefined);
  assert.deepEqual(view.projects.map((project) => project.id), ["remote-project"]);
  assert.equal(view.projectHosts.get("remote-project")?.name, "linux");
  const narrowed = deriveView({ ...state, computers: { ...state.computers, filter: "this" } });
  assert.deepEqual(narrowed.activityThreads.threads.map((thread) => thread.id), ["local"]);
  assert.deepEqual(deriveView({ ...state, computers: { ...state.computers, filter: "linux" } }).activityThreads.threads.map((thread) => thread.id), ["remote-thread"]);
});

test("a draft may start in any computer's project whatever the sidebar filter shows, this computer's first", () => {
  const state = withComputers(
    workspace({ projects: [{ id: "local-b", root: "/mac/b", sortIndex: 1 }, { id: "local-a", root: "/mac/a", sortIndex: 0 }], draftProjectId: "local-a" }),
    [paired("linux", remoteState)],
  );
  for (const filter of ["all", "this", "linux"] as const) {
    const view = deriveView({ ...state, computers: { ...state.computers, filter } });
    assert.deepEqual(view.startProjects.map((project) => project.id), ["local-a", "local-b", "remote-project"], `filter ${filter}`);
    assert.equal(view.startProjects.find((project) => project.id === view.currentProject?.id)?.id, "local-a", "the drafted project is always offered");
  }
  const remoteOnly = deriveView({ ...state, projects: [], draftProjectId: null, computers: { ...state.computers, filter: "this" } });
  assert.deepEqual(remoteOnly.startProjects.map((project) => project.id), ["remote-project"], "with nothing here, work can still start elsewhere");
  const drafting = { ...remoteState, currentId: null, draftProjectId: "remote-project" };
  const overlaid = deriveView(withComputers(state, [paired("linux", drafting)], { active: "linux", filter: "this" }));
  assert.equal(overlaid.currentProject?.id, "remote-project");
  assert.ok(overlaid.startProjects.some((project) => project.id === "remote-project"), "a draft on the other computer is offered its own project too");
});

test("filter changes update local lists even when neither selection has remote collections", () => {
  const state = workspace({ projects: [{ id: "local", root: "/local" }], threads: [task("local-chat")] });
  for (const filter of ["this", "missing", "all", "missing", "this"] as const) {
    const view = deriveView({ ...state, computers: { ...state.computers, filter } });
    const own = filter !== "missing";
    assert.deepEqual(view.projects.map((project) => project.id), own ? ["local"] : []);
    assert.deepEqual(view.recentThreads.map((thread) => thread.id), own ? ["local-chat"] : []);
  }
});

test("with a paired computer on screen the conversation is its own, under this window's chrome and drafts", () => {
  const state = withComputers(workspace({ theme: "catppuccin-mocha", prompts: { "remote-thread": "typed here" } }), [paired("linux", remoteState)], { active: "linux" });
  const view = deriveView(state);
  assert.equal(view.currentThread?.id, "remote-thread");
  assert.equal(view.theme, "catppuccin-mocha", "the theme is this window's");
  assert.equal(view.prompt, "typed here", "the draft is this window's");
  assert.equal(view.activeComputer?.id, "linux");
  assert.deepEqual(view.terminals, [], "no panel of the other computer is drawn here");
});

test("a notice a paired computer raised is carried to this desktop as one of its own, under the same switch", () => {
  const notice = { taskId: "remote-thread", title: "Remote work", headline: "The run finished." };
  const state = withComputers(workspace(), [paired("linux", remoteState)]);
  const carried = reduce(state, { type: "computer.notice", id: "linux", notice });
  assert.deepEqual(carried.effects, [{ type: "announce-thread", notice }]);
  assert.deepEqual(reduce(state, { type: "computer.notice", id: "stranger", notice }).effects, [], "a computer not paired has no say here");
  assert.deepEqual(reduce({ ...state, notifications: false }, { type: "computer.notice", id: "linux", notice }).effects, [], "notifications off here are off for every computer");
  const finished = { ...remoteState, threads: [{ ...remoteThread, outcome: "finished" as const, outcomeUnread: true as const }] };
  const applied = reduce(state, { type: "computer.state", id: "linux", state: finished });
  assert.deepEqual(applied.effects, [], "a state moving says nothing of itself; the notice is that computer's to raise");
  assert.equal(applied.state.computers.paired[0]?.state, finished);
});

test("the paired computers as the host reports them keep the states already held, and a lost one leaves the screen", () => {
  const state = withComputers(workspace(), [paired("linux", remoteState)], { active: "linux", filter: "linux", pairing: { host: "linux.tail.ts.net", name: "linux", busy: true, error: null } });
  const still = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("linux", { status: "offline", error: "Timed out" })] }).state;
  assert.equal(still.computers.paired[0]?.state, remoteState, "the last state stays while the line is down");
  assert.equal(still.computers.paired[0]?.status, "offline");
  assert.equal(still.computers.active, null, "a line that dropped takes the screen with it");
  assert.equal(still.computers.filter, "linux", "the sidebar's filter is the user's and stays");
  assert.equal(still.computers.pairing, null, "a pairing that shows up as a link is done");
  const gone = reduce(state, { type: "computers.changed", name: "This Mac", links: [] }).state;
  assert.equal(gone.computers.active, null);
  assert.equal(gone.computers.filter, "all");
  assert.equal(reduce(state, { type: "computers.pair-failed", message: "Wrong code" }).state.computers.pairing?.error, "Wrong code");
});

test("images cross to their holder as bytes and only the acknowledged strip is cleared", () => {
  for (const taskId of [undefined, "remote-thread"]) {
    const sentImage = { id: "shot", path: "/mac/shot.png", source: "data:image/png;base64,AQID", annotations: [] };
    const laterImage = { id: "later", path: "/mac/later.png", label: "Later" };
    const state = withComputers(workspace({ prompts: { "remote-thread": "Look here" }, images: { "remote-thread": [{ id: "shot", path: sentImage.path, label: "Shot" }, laterImage] } }), [paired("linux", remoteState)], { active: "linux" });
    const sending = reduce(state, { type: "attachments.send", ...(taskId ? { taskId } : {}), steer: true, attachments: [sentImage] });
    const forward = effectOf(sending, "computer.forward");
    assert.deepEqual(forward.inputs, [
      { type: "view.set-prompt", taskId: "remote-thread", prompt: "Look here" },
      { type: "annotation.recall", taskId: "remote-thread", annotations: [] },
      { type: "paste.recall", taskId: "remote-thread", pastes: [] },
      { type: "attachments.send", taskId: "remote-thread", steer: true, attachments: [{ id: "shot", source: sentImage.source, annotations: [] }] },
    ]);
    assert.deepEqual(forward.draft?.attachments, { key: taskId ?? "", ids: ["shot"] });
    assert.deepEqual(sending.state.attachmentSends[taskId ?? ""], { busy: true, error: null, sent: [] });
    assert.deepEqual(reduce(sending.state, { type: "attachments.send", ...(taskId ? { taskId } : {}), attachments: [sentImage] }).effects, [], "a second click cannot duplicate the transfer");
    assert.deepEqual(sending.state.images, state.images);
    const failed = reduce(sending.state, { type: "attachments.failed", ...(taskId ? { taskId } : {}), message: "The holder refused" }).state;
    assert.deepEqual(failed.attachmentSends[taskId ?? ""], { busy: false, error: "The holder refused", sent: [] });
    assert.deepEqual(failed.images, state.images);
    const acknowledged = reduce(failed, { type: "computers.forwarded", draft: forward.draft! }).state;
    assert.deepEqual(acknowledged.attachmentSends[taskId ?? ""], { busy: false, error: null, sent: ["shot"] });
    assert.deepEqual(acknowledged.images["remote-thread"], [laterImage]);
    let holder = remoteState;
    for (const input of forward.inputs.slice(0, -1)) holder = reduce(holder, input).state;
    const save = effectOf(reduce(holder, forward.inputs.at(-1)!), "send-attachments");
    assert.deepEqual(save.attachments, [{ id: "shot", source: sentImage.source, annotations: [] }]);
  }
});

test("file and folder chips stay here when an image or text send targets another computer", () => {
  for (const folder of [undefined, true] as const) {
    const state = withComputers(workspace({ files: { "remote-thread": [{ id: "file", path: "/mac/local", name: "local", ...(folder ? { folder } : {}) }] } }), [paired("linux", remoteState)], { active: "linux" });
    for (const input of [{ type: "task.send" }, { type: "attachments.send", attachments: [] }] satisfies WorkspaceInput[]) {
      assert.deepEqual(routeInput(state, input), { kind: "refuse", message: ATTACHMENTS_ELSEWHERE });
      assert.deepEqual(reduce(state, input).state.files, state.files);
    }
    assert.equal(routeInput(state, { type: "task.send", text: "independent agent send" }).kind, "computer");
  }
});


test("a refused transfer or dropped link releases the composer and preserves its draft for retry", async () => {
  for (const disconnected of [false, true]) {
    let state = withComputers(workspace({ prompts: { "remote-thread": "Keep me" } }), [paired("linux", remoteState)], { active: "linux" });
    const execution = executeWorkspaceInput({ type: "attachments.send", attachments: [{ id: "shot", source: "data:image/png;base64,AQID", annotations: [] }] }, {
      state: () => state,
      commit: (next) => { state = next; },
      perform: async (effect, dispatch) => {
        if (effect.type !== "computer.forward") return;
        await computerEffects["computer.forward"](effect, { dispatch, desktop: { sendToComputer: async () => {
          if (disconnected) throw new Error("Transfer failed");
          return { ok: false, message: "Transfer failed" };
        } } } as unknown as EffectHost);
      },
    });
    assert.deepEqual(await execution.completed, { ok: false, message: "Transfer failed" });
    assert.equal(state.prompts["remote-thread"], "Keep me");
    assert.deepEqual(state.attachmentSends[""], { busy: false, error: "Transfer failed", sent: [] });
  }
});

test("a paired computer whose line drops leaves the screen, and the window's own work goes nowhere near it", () => {
  const local = task("local", { projectId: "p-local" });
  const shown = withComputers(workspace({ projects: [{ id: "p-local", root: "/mac/app", workspaceId: "ws-local" }], threads: [local], currentId: "local" }), [paired("linux", remoteState)], { active: "linux" });
  const dropped = reduce(shown, { type: "computers.changed", name: "This Mac", links: [link("linux", { status: "offline", error: "The other computer runs a different version of AI Coding Tool. Update both." })] });
  assert.equal(dropped.state.computers.active, null, "a line that dropped takes the screen with it");
  assert.equal(dropped.state.computers.paired[0]?.state, remoteState, "what it published stays for the sidebar");
  assert.deepEqual(dropped.effects, [], "nothing is told to a line that is down");
  const view = deriveView(dropped.state);
  assert.equal(view.currentThread?.id, "local", "the window shows its own thread again");
  assert.equal(view.activeComputer, null);
  assert.deepEqual(view.startProjects.map((project) => project.id), ["p-local"], "a draft cannot start on a computer that is away");
  const own: WorkspaceInput[] = [
    { type: "view.set-focused", focused: true },
    { type: "task.new" },
    { type: "task.set-branch", branch: "main" },
    { type: "task.send", attachments: [], text: "hello" },
    { type: "run.cancel" },
    { type: "file.open", path: "src/app.ts" },
  ];
  for (const input of own) assert.deepEqual(routeInput(dropped.state, input), { kind: "local" }, input.type);
  const sent = reduce(dropped.state, { type: "task.send", attachments: [], text: "hello" });
  assert.equal(sent.effects.some((effect) => effect.type === "computer.forward"), false);
  assert.equal(sent.state.actionError, null);
});

test("a command that names a thread or project on a computer that is away is refused with why, once", () => {
  const away = paired("linux", remoteState, { status: "offline", error: "The other computer runs a different version of AI Coding Tool. Update both." });
  const state = withComputers(workspace({ threads: [task("local")] }), [away]);
  const why = { kind: "refuse", message: away.error };
  assert.deepEqual(routeInput(state, { type: "task.select", taskId: "remote-thread" }), why);
  assert.deepEqual(routeInput(state, { type: "task.new", projectId: "remote-project" }), why);
  assert.deepEqual(routeInput(state, { type: "run.cancel", taskId: "remote-thread" }), why);
  assert.deepEqual(routeInput(state, { type: "task.send", attachments: [], taskId: "remote-thread" }), why);
  assert.deepEqual(routeInput(state, { type: "project.remove", projectId: "remote-project" }), why);
  const refused = reduce(state, { type: "task.select", taskId: "remote-thread" });
  assert.equal(refused.state.computers.active, null, "a computer that cannot take the selection is not put on screen");
  assert.equal(refused.state.actionError, away.error);
  assert.deepEqual(refused.effects, []);
  const nameless = withComputers(state, [paired("linux", remoteState, { status: "connecting" })]);
  assert.deepEqual(routeInput(nameless, { type: "task.select", taskId: "remote-thread" }), { kind: "refuse", message: "linux is offline." });
});

test("a computer on screen that is not connected counts as none: the window paints and routes its own", () => {
  const local = task("local");
  const state = withComputers(workspace({ threads: [local], currentId: "local", prompts: { local: "mine" } }), [paired("linux", remoteState, { status: "offline" })], { active: "linux" });
  assert.equal(deriveView(state).currentThread?.id, "local");
  assert.equal(deriveView(state).prompt, "mine", "the draft is the window's own, not the other computer's");
  assert.deepEqual(routeInput(state, { type: "task.send", attachments: [], text: "hello" }), { kind: "local" });
  assert.deepEqual(routeInput(state, { type: "view.set-focused", focused: false }), { kind: "local" });
  const home = reduce(state, { type: "task.new" });
  assert.equal(home.state.computers.active, null);
  assert.equal(home.effects.some((effect) => effect.type === "computer.forward"), false, "a line that is down is not told the window left");
});

test("a forward the line refused is the window's error once, and housekeeping the line refused is no error at all", async () => {
  const raised: WorkspaceInput[] = [];
  const host = { dispatch: async (input: WorkspaceInput) => { raised.push(input); }, desktop: { sendToComputer: async () => { throw new Error("That computer cannot be reached right now."); } } } as unknown as EffectHost;
  await computerEffects["computer.forward"]({ type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: true }] }, host);
  assert.deepEqual(raised, []);
  await computerEffects["computer.forward"]({ type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: true }, { type: "task.select", taskId: "remote-thread" }] }, host);
  assert.deepEqual(raised, [{ type: "action.failed", message: "That computer cannot be reached right now." }]);
});


test("remote terminals stay with their host across selection changes and reconnects", () => {
  const opened = reduce(remoteState, { type: "terminal.open" }).state;
  const terminal = deriveView(opened).terminals[0];
  const focused = reduce(opened, { type: "view.dock-keys", tab: terminal.id }).state;
  const state = withComputers(workspace(), [paired("linux", focused)], { active: "linux" });
  assert.equal(deriveView(state).terminals[0].id, terminal.id);
  const command = { type: "terminal.input", terminalId: terminal.id, data: "pwd\r" } as const;
  const home = { ...state, computers: { ...state.computers, active: null } };
  assert.deepEqual(effectOf(reduce(home, command), "computer.forward"), { type: "computer.forward", id: "linux", inputs: [command] });
  const dropped = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("linux", { status: "offline" })] }).state;
  assert.equal(dropped.computers.active, "linux");
  assert.equal(deriveView(dropped).terminals[0].id, terminal.id);
  assert.equal(deriveView(dropped).activeComputer?.status, "offline");
  assert.equal(reduce(dropped, command).result?.ok, false);
  assert.equal(reduce(dropped, { type: "terminal.open" }).result?.ok, false);
  const back = reduce(dropped, { type: "computers.changed", name: "This Mac", links: [link("linux")] });
  assert.deepEqual(back.effects, [], "reconnection never replays keyboard input");
  assert.equal(deriveView(back.state).terminals[0].id, terminal.id);
  const search = reduce(back.state, { type: "view.find-open" });
  assert.deepEqual(search.state.find?.target, { kind: "terminal", terminalId: terminal.id });
  const query = reduce(search.state, { type: "view.find-query", query: "hello" });
  assert.equal(effectOf(query, "find-in-terminal").terminalId, terminal.id);
  assert.equal(deriveView(query.state).find?.query, "hello");
  const gone = reduce(dropped, { type: "computers.changed", name: "This Mac", links: [] });
  assert.equal(gone.state.computers.active, null);
});

test("an offline terminal keeps shortcuts and attention on the computer still on screen", () => {
  const remote = reduce(remoteState, { type: "terminal.open" }).state;
  const local = task("local", { projectId: "p-local", outcomeUnread: true });
  const state = withComputers(workspace({
    projects: [{ id: "p-local", root: "/mac/app", workspaceId: "ws-local" }],
    threads: [local], currentId: "local", focused: false,
  }), [paired("linux", remote, { status: "offline" })], { active: "linux" });
  const fresh = reduce(state, { type: "view.shortcut", action: "thread.new", surface: "any" });
  assert.equal(fresh.result?.ok, false, "the offline remote project refuses a new thread");
  assert.equal(fresh.state.currentId, "local");
  assert.equal(fresh.state.computers.active, "linux");
  const focused = reduce(state, { type: "view.set-focused", focused: true });
  assert.equal(focused.state.focused, true);
  assert.equal(focused.state.threads[0].outcomeUnread, true, "the hidden local thread has not been read");
  assert.equal(focused.effects.some((effect) => effect.type === "computer.forward"), false);
});


test("advertised support blocks a whole remote batch before it changes selection or sends drafts", () => {
  const limited = COMPUTER_CAPABILITIES.filter((name) => !name.startsWith("command:annotation.recall") && name !== "command:task.send:role");
  const state = withComputers(workspace({ prompts: { "remote-thread": "keep me" } }), [paired("linux", remoteState, { capabilities: limited })], { active: "linux" });
  assert.equal(routeInput(state, { type: "task.send" }).kind, "refuse");
  assert.equal(routeInput(state, { type: "task.send", text: "direct", role: "reviewer" }).kind, "refuse");
  assert.equal(routeInput(state, { type: "task.send", text: "direct" }).kind, "computer");
  const rejected = reduce(state, { type: "task.send" });
  assert.equal(rejected.state.prompts["remote-thread"], "keep me");
  assert.equal(rejected.effects.some((effect) => effect.type === "computer.forward"), false);
  assert.equal(routeInput(state, { type: "view.set-theme", theme: "catppuccin-latte" }).kind, "local");
});

test("a capability refresh replaces the paired link even when its status and name are unchanged", () => {
  const first = paired("linux", remoteState, { capabilities: [] });
  const state = withComputers(workspace(), [first]);
  const changed = reduce(state, { type: "computers.changed", name: "Mac", links: [{ ...link("linux"), capabilities: COMPUTER_CAPABILITIES }] }).state;
  assert.equal(changed.computers.paired[0]?.state, remoteState);
  assert.equal(changed.computers.paired[0]?.capabilities, COMPUTER_CAPABILITIES);
  assert.equal(routeInput(changed, { type: "task.select", taskId: "remote-thread" }).kind, "computer");
});


test("ordinary remote refusals keep their explanations instead of masquerading as missing capabilities", () => {
  const connected = paired("linux", remoteState, { capabilities: COMPUTER_CAPABILITIES });
  const state = withComputers(workspace(), [connected], { active: "linux" });
  const files = { ...state, files: { "remote-thread": [{ id: "file", name: "local", path: "/local/file" }] } };
  const send = { type: "attachments.send", attachments: [] } as const;
  assert.equal(computerCommandAvailable(files, { ...send, attachments: [] }), true);
  assert.deepEqual(routeInput(files, { ...send, attachments: [] }), { kind: "refuse", message: ATTACHMENTS_ELSEWHERE });
  const offline = withComputers(state, [{ ...connected, status: "offline" }]);
  const archive = { type: "task.archive", taskId: "remote-thread" } as const;
  assert.equal(computerCommandAvailable(offline, archive), true);
  assert.deepEqual(routeInput(offline, archive), { kind: "refuse", message: "linux is offline." });
  const limited = withComputers(state, [{ ...connected, capabilities: [] }]);
  assert.equal(computerCommandAvailable(limited, archive), false);
});

test("streaming updates preserve the capability context while discovery and connection changes invalidate it", () => {
  const snapshot = createComputerCapabilitySnapshot();
  const computer = paired("linux", remoteState, { capabilities: COMPUTER_CAPABILITIES });
  const computers = { ...workspace().computers, paired: [computer], active: "linux" };
  const first = snapshot(computers);
  const streamed = { ...computers, paired: [{ ...computer, state: { ...remoteState, composerFocus: 1 } }] };
  assert.equal(snapshot(streamed), first);
  const offline = snapshot({ ...streamed, paired: [{ ...computer, status: "offline" }] });
  assert.notEqual(offline, first);
  const refreshed = snapshot({ ...computers, paired: [{ ...computer, capabilities: [] }] });
  assert.notEqual(refreshed, first);
});


test("remote browsers expose their tabs and approvals and route input by the tab's owner", () => {
  const remote = reduce(remoteState, { type: "browser.open", url: "http://localhost:3000" }).state;
  const tab = remote.docks["remote-thread"].browserTabs[0];
  const capabilities = ["query:browser-frame", ...workspaceCommandDefinitions().flatMap(({ type, fields }) => [`command:${type}`, ...fields.map((field) => `command:${type}:${field}`)])];
  const approval = { approvalId: "allow", tabId: tab.id, taskId: "remote-thread", url: "https://example.com" };
  const computer = paired("linux", { ...remote, browserApproval: approval }, { capabilities });
  const state = withComputers(workspace(), [computer], { active: "linux" });
  assert.deepEqual(deriveView(state).browserTabs, [tab]);
  assert.deepEqual(deriveView(state).browserApproval, approval);
  for (const command of [{ type: "browser.new-tab" }, { type: "browser.open", url: tab.url, newTab: true }] as const) {
    const opening = routeInput(state, command);
    assert.ok(opening.kind === "computer");
    assert.deepEqual(opening.inputs, [{ ...command, offscreen: true }], "new remote pages use an offscreen renderer");
  }
  const input = { type: "browser.control" as const, tabId: tab.id, epoch: 1, input: { kind: "text" as const, text: "hello" } };
  assert.equal(routeInput(state, input).kind, "computer");
  const local = { ...state, computers: { ...state.computers, active: null } };
  const routed = routeInput(local, input);
  assert.equal(routed.kind, "computer", "late input follows its tab after selecting a local thread");
  const closing = { type: "browser.viewport" as const, tabId: tab.id, viewport: null };
  assert.equal(routeInput(local, closing).kind, "computer");
  assert.equal(routeInput(state, { ...input, tabId: "gone" }).kind, "refuse", "a stale tab never falls back to the active host");
  assert.equal(deriveView(withComputers(workspace(), [paired("linux", remote)], { active: "linux" })).browserTabs.length, 0, "older hosts do not expose an unusable surface");
});
