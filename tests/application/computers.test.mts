import { executeWorkspaceInput } from "../../src/application/workspace-execution.ts";
import { computerEffects } from "../../src/host/computer-effects.ts";
import type { EffectHost } from "../../src/host/effect-host.ts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { ATTACHMENTS_ELSEWHERE, FILES_ELSEWHERE, PANEL_ELSEWHERE, routeInput, type PairedComputer } from "../../src/application/computers.ts";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
import { effectOf, task, workspace } from "./workspace-reducer-fixtures.mts";

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
  const away = [{ type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: false }] }];
  assert.deepEqual(home.effects.filter((effect) => effect.type === "computer.forward"), away);
  const fresh = reduce(state, { type: "task.new" });
  assert.equal(fresh.state.computers.active, null);
  assert.deepEqual(effectOf(fresh, "computer.forward"), away[0]);
  const theirs = reduce(remoteState, away[0]!.inputs[0]!).state;
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

test("a line to the computer on screen that comes back is told again whether anyone is looking", () => {
  const state = withComputers(workspace({ focused: false }), [paired("linux", remoteState, { status: "offline" })], { active: "linux" });
  const back = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("linux")] });
  assert.deepEqual(effectOf(back, "computer.forward"), { type: "computer.forward", id: "linux", inputs: [{ type: "view.set-focused", focused: false }] });
  const still = reduce(back.state, { type: "computers.changed", name: "This Mac", links: [link("linux")] });
  assert.equal(still.effects.length, 0, "a line that stayed up is told nothing");
});

test("what only this computer's panels can do is refused for a thread elsewhere, and so are attachments that only carry paths", () => {
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
