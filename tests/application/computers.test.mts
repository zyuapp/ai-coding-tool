import assert from "node:assert/strict";
import { test } from "vitest";
import { ATTACHMENTS_ELSEWHERE, FILES_ELSEWHERE, PANEL_ELSEWHERE, remoteNotices, routeInput, type PairedComputer } from "../../src/application/computers.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
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
  assert.deepEqual(effectOf(after, "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "task.select", taskId: "remote-thread" }] });
  assert.equal(after.state.currentId, null, "this computer's own thread is untouched");
});

test("a send to the thread on screen puts the draft typed here into that computer's composer, and lets go of it once taken", () => {
  let state = withComputers(workspace(), [paired("linux", remoteState)], { active: "linux" });
  state = reduce(state, { type: "view.set-prompt", prompt: "Fix the header" }).state;
  assert.equal(state.prompts["remote-thread"], "Fix the header", "the draft is keyed by the other computer's open thread");
  state = reduce(state, { type: "paste.add", text: "some log" }).state;
  const sent = reduce(state, { type: "task.send", attachments: [], steer: true });
  const forward = effectOf(sent, "computer.forward");
  assert.equal(forward.id, "linux");
  assert.equal(forward.draftKey, "remote-thread");
  assert.deepEqual(forward.inputs, [
    { type: "view.set-prompt", taskId: "remote-thread", prompt: "Fix the header" },
    { type: "paste.recall", taskId: "remote-thread", pastes: sent.state.pastes["remote-thread"] },
    { type: "task.send", taskId: "remote-thread", steer: true },
  ]);
  assert.equal(sent.state.prompts["remote-thread"], "Fix the header", "the draft stays until the other computer has it");
  const taken = reduce(sent.state, { type: "computers.forwarded", draftKey: "remote-thread" }).state;
  assert.equal(taken.prompts["remote-thread"], undefined);
  assert.deepEqual(taken.pastes["remote-thread"] ?? [], []);
});

test("a send starting a thread in a folder elsewhere names the folder and carries the draft under that folder's key", () => {
  const drafting = { ...remoteState, currentId: null, draftProjectId: "remote-project" };
  let state = withComputers(workspace(), [paired("linux", drafting)], { active: "linux" });
  state = reduce(state, { type: "view.set-prompt", prompt: "Start here" }).state;
  assert.equal(state.prompts["draft:remote-project"], "Start here");
  const forward = effectOf(reduce(state, { type: "task.send", attachments: [], project: "remote-project", model: "opus" }), "computer.forward");
  assert.deepEqual(forward.inputs, [
    { type: "view.set-prompt", taskId: "draft:remote-project", prompt: "Start here" },
    { type: "task.send", project: "remote-project", model: "opus" },
  ]);
});

test("moving to a thread here takes the paired computer off screen and tells it to open nothing", () => {
  const state = withComputers(workspace({ threads: [task("local")] }), [paired("linux", remoteState), paired("other", { ...remoteState, threads: [task("far", { projectId: "remote-project" })] })], { active: "linux" });
  const home = reduce(state, { type: "task.select", taskId: "local" });
  assert.equal(home.state.computers.active, null);
  assert.equal(home.state.currentId, "local");
  assert.deepEqual(home.effects.filter((effect) => effect.type === "computer.forward"), [{ type: "computer.forward", id: "linux", inputs: [{ type: "task.new" }] }]);
  const fresh = reduce(state, { type: "task.new" });
  assert.equal(fresh.state.computers.active, null);
  assert.deepEqual(effectOf(fresh, "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "task.new" }] });
  const across = reduce(state, { type: "task.select", taskId: "far" });
  assert.equal(across.state.computers.active, "other");
  assert.deepEqual(across.effects.filter((effect) => effect.type === "computer.forward").map((effect) => effect.type === "computer.forward" && effect.id), ["linux", "other"]);
});

test("whether the window is looking is kept here and told to the computer on screen", () => {
  const state = withComputers(workspace({ focused: true }), [paired("linux", remoteState)], { active: "linux" });
  const away = reduce(state, { type: "view.set-focused", focused: false });
  assert.equal(away.state.focused, false);
  assert.equal(away.state.computers.active, "linux");
  assert.deepEqual(effectOf(away, "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: false }] });
});

test("what only this computer's panels can do is refused for a thread elsewhere, and so are attachments", () => {
  const state = withComputers(workspace(), [paired("linux", remoteState)], { active: "linux" });
  assert.deepEqual(routeInput(state, { type: "terminal.open" }), { kind: "refuse", message: PANEL_ELSEWHERE });
  assert.deepEqual(routeInput(state, { type: "browser.new-tab" }), { kind: "refuse", message: PANEL_ELSEWHERE });
  assert.deepEqual(routeInput(state, { type: "file.open", path: "src/app.ts" }), { kind: "refuse", message: FILES_ELSEWHERE });
  assert.deepEqual(routeInput(state, { type: "app.open-folder", appId: "cursor" }), { kind: "refuse", message: FILES_ELSEWHERE });
  assert.deepEqual(routeInput(state, { type: "task.send", attachments: [{ path: "/tmp/shot.png", labels: [] }] }), { kind: "refuse", message: ATTACHMENTS_ELSEWHERE });
  assert.equal(reduce(state, { type: "terminal.open" }).result?.ok, false);
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

test("with a paired computer on screen the conversation is its own, under this window's chrome and drafts", () => {
  const state = withComputers(workspace({ theme: "catppuccin-mocha", prompts: { "remote-thread": "typed here" } }), [paired("linux", remoteState)], { active: "linux" });
  const view = deriveView(state);
  assert.equal(view.currentThread?.id, "remote-thread");
  assert.equal(view.theme, "catppuccin-mocha", "the theme is this window's");
  assert.equal(view.prompt, "typed here", "the draft is this window's");
  assert.equal(view.activeComputer?.id, "linux");
  assert.deepEqual(view.terminals, [], "no panel of the other computer is drawn here");
});

test("a run settling on a paired computer while this window shows something else is announced, once", () => {
  const before = remoteState;
  const finished = { ...remoteState, threads: [{ ...remoteThread, outcome: "finished" as const, outcomeUnread: true as const }] };
  const notices = remoteNotices(before, finished, () => false);
  assert.deepEqual(notices, [{ taskId: "remote-thread", title: "Remote work", headline: "The run finished." }]);
  assert.deepEqual(remoteNotices(finished, finished, () => false), [], "a state that did not move says nothing");
  assert.deepEqual(remoteNotices(before, finished, () => true), [], "a thread on screen has been seen");
  const watched = { ...remoteState, activeRuns: { "remote-thread": activeRun("remote-thread", "run-1") } };
  const settled = { ...remoteState, threads: [{ ...remoteThread, outcome: "finished" as const }] };
  assert.equal(remoteNotices(watched, settled, () => false).length, 1, "a run that settled is announced even when that computer thought it was being watched");
  const state = withComputers(workspace(), [paired("linux", before)]);
  const applied = reduce(state, { type: "computer.state", id: "linux", state: finished });
  assert.equal(effectOf(applied, "announce-thread").notice.title, "Remote work");
  assert.equal(applied.state.computers.paired[0]?.state, finished);
});

test("the paired computers as the host reports them keep the states already held, and a lost one leaves the screen", () => {
  const state = withComputers(workspace(), [paired("linux", remoteState)], { active: "linux", filter: "linux", pairing: { host: "linux.tail.ts.net", name: "linux", busy: true, error: null } });
  const still = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("linux", { status: "offline", error: "Timed out" })] }).state;
  assert.equal(still.computers.paired[0]?.state, remoteState, "the last state stays while the line is down");
  assert.equal(still.computers.paired[0]?.status, "offline");
  assert.equal(still.computers.pairing, null, "a pairing that shows up as a link is done");
  const gone = reduce(state, { type: "computers.changed", name: "This Mac", links: [] }).state;
  assert.equal(gone.computers.active, null);
  assert.equal(gone.computers.filter, "all");
  assert.equal(reduce(state, { type: "computers.pair-failed", message: "Wrong code" }).state.computers.pairing?.error, "Wrong code");
});
