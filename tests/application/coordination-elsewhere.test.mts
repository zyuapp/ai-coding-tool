import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { coordinationContext, coordinationMembers, coordinationRole } from "../../src/application/coordination.ts";
import { coordinationView } from "../../src/application/coordination-view.ts";
import { sidebarLists } from "../../src/application/sidebar-lists.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
import type { Subagent } from "../../src/domain/run.ts";
import type { Thread } from "../../src/domain/thread.ts";
import type { Workflow } from "../../src/domain/workflow.ts";
import { THREAD_STORE_VERSION } from "../../src/domain/thread-storage.ts";
import { ARCHIVE_RETENTION_MS } from "../../src/domain/thread-retention.ts";
import { createFailureMessage } from "../../src/domain/conversation.ts";
import { activeRun, effectAt, effectOf, required, task, workspace } from "./workspace-reducer-fixtures.mts";
import { viewPreferences } from "../../src/application/view-preferences.ts";

/**
 * A coordinator here and the threads it started on paired computers, as each side sees them: here,
 * through the state each computer publishes; there, as threads of that computer's own.
 */

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };

const link = (id: string, overrides: Partial<ComputerLink> = {}): ComputerLink => ({ id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, ...overrides });

function paired(id: string, remote: WorkspaceState | null, overrides: Partial<ComputerLink> = {}): PairedComputer {
  return { ...link(id, overrides), state: remote };
}

function withComputers(state: WorkspaceState, computers: PairedComputer[]): WorkspaceState {
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: computers } };
}

function lead(id = "lead", overrides = {}) {
  return task(id, { role: "coordinator", ...overrides });
}

/** A coordinator here, and a paired computer "studio" holding a thread the coordinator started there. */
const FAR = { threadId: "lead", title: "Lead", computer: "This Mac" };
const far = (overrides: Partial<Thread> = {}) => task("far", { title: "Far work", remoteLead: FAR, createdAt: 10, ...overrides });
const coordinating = (holder: WorkspaceState, link: Partial<ComputerLink> = {}) => withComputers(workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })] }), [paired("studio", holder, { capabilities: COMPUTER_CAPABILITIES, ...link })]);
const mirrored = (state: WorkspaceState, holder: WorkspaceState) => reduce(state, { type: "computer.state", id: "studio", state: holder });
const notesOf = (state: WorkspaceState) => (state.threads.find((thread) => thread.id === "lead")?.coordinationNotes ?? []).map((note) => note.text);
const wakesOf = (state: WorkspaceState) => Object.values(state.pendingRuns).filter((pending) => pending.taskId === "lead");

test("a paired computer's member folds under its coordinator", () => {
  const holder = workspace({ threads: [far(), task("other", { title: "Unrelated" })] });
  const state = coordinating(holder);
  const lead = state.threads[0]!;
  const lists = sidebarLists(state, [], [lead, ...holder.threads], new Set(), new Set());
  assert.deepEqual(lists.threadsByCoordinator.get("lead")?.map((thread) => thread.id), ["far"]);
  assert.deepEqual(coordinationMembers(state, "lead").map(({ thread, computer }) => [thread.id, computer?.id]), [["far", "studio"]]);
  const view = coordinationView(state, lead, new Set(), new Set());
  assert.deepEqual(view.members.map(({ thread, host }) => [thread.id, host?.name]), [["far", "studio"]]);
  assert.deepEqual(coordinationMembers({ ...state, threads: [{ ...lead, role: undefined }] }, "lead"), [], "only a live coordinator here has threads there");
});

test("a paired computer's member whose coordinator is away stays in a list of its own until it hears the coordinator is back", () => {
  const holder = workspace({ threads: [far({ remoteLead: { ...FAR, away: true } })] });
  const state = coordinating(holder);
  const lists = sidebarLists(state, [], [state.threads[0]!, ...holder.threads], new Set(), new Set());
  assert.equal(lists.threadsByCoordinator.get("lead"), undefined);
  assert.ok(lists.recentThreads.some((thread) => thread.id === "far"));
  assert.deepEqual(coordinationMembers(state, "lead"), [], "as its Overview and roster leave it out");
});

test("its turn end, report and decision reach the coordinator, once each, even across a dropped link", () => {
  let state = coordinating(workspace());
  state = mirrored(state, workspace({ threads: [far()], activeRuns: { far: activeRun("far", "run-far") } })).state;
  assert.deepEqual(notesOf(state), ["\"Far work\" started on studio."]);
  assert.deepEqual(wakesOf(state), [], "showing up is heard quietly");
  assert.equal(state.threads[0]!.remoteHeard?.far, 10);

  state = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("studio", { status: "offline", capabilities: COMPUTER_CAPABILITIES })] }).state;
  state = reduce(state, { type: "computers.changed", name: "This Mac", links: [link("studio", { capabilities: COMPUTER_CAPABILITIES })] }).state;
  const decision = { id: "d1", question: "Keep the old API?", options: [], raisedAt: 20 };
  const finished = workspace({ threads: [far({ report: { state: "done", summary: "Tests pass", at: 30 }, decisions: [decision], runEndedAt: 40, outcome: "finished" })] });
  const caught = mirrored(state, finished);
  assert.deepEqual(notesOf(caught.state).slice(1), [
    "\"Far work\" asked the user to decide: Keep the old API?",
    "\"Far work\" reported done: Tests pass",
    "\"Far work\" ended its turn.",
  ], "what happened while the line was down is caught up once it is back");
  assert.equal(caught.state.threads[0]!.remoteHeard?.far, 40);
  assert.ok(caught.effects.some((effect) => effect.type === "announce-thread" && effect.notice.headline === "Needs you: Keep the old API?"));
  assert.equal(wakesOf(caught.state).length, 1, "with nothing working there, the news wakes the coordinator");

  const again = mirrored(caught.state, { ...finished, activeRuns: {} });
  assert.deepEqual(notesOf(again.state), notesOf(caught.state), "each is heard once");
});

/** A coordinator here holding news from "one" while "far" works on studio, as studio said with its line up. */
const ONE_ENDED = { id: "n1", threadId: "one", text: "\"One\" ended its turn.", at: 1 };
const FAR_RUNNING = workspace({ threads: [far()], activeRuns: { far: activeRun("far", "run-far") } });
const FAR_ENDED = workspace({ threads: [far({ runEndedAt: 40, outcome: "finished" })] });
const holdingNews = () => mirrored(withComputers(workspace({ threads: [lead("lead", { title: "Lead", coordinationNotes: [ONE_ENDED] }), task("one", { title: "One", parentId: "lead" })] }), [paired("studio", workspace(), { capabilities: COMPUTER_CAPABILITIES })]), FAR_RUNNING).state;
const studioLine = (status: ComputerLink["status"]): WorkspaceInput => ({ type: "computers.changed", name: "This Mac", links: [link("studio", { status, capabilities: COMPUTER_CAPABILITIES })] });
const memberOf = (state: WorkspaceState) => coordinationView(state, state.threads[0], new Set(), new Set()).members.flatMap(({ thread, status, lastHeard }) => thread.id === "far" ? [status, lastHeard] : []);
const rosterOf = (state: WorkspaceState) => coordinationContext(state, required(state.threads.find((thread) => thread.id === "lead"))).split("\n").filter((line) => line.includes("[far]"));

test("a line that drops is not taken for its thread's work ending", () => {
  const holding = holdingNews();
  assert.deepEqual(wakesOf(holding), [], "a thread working there holds the news");
  for (const status of ["offline", "connecting"] as const) {
    const dropped = reduce(holding, studioLine(status)).state;
    assert.deepEqual(wakesOf(dropped), [], `going ${status} says nothing of its work`);
    assert.deepEqual(rosterOf(dropped), ["- \"Far work\" [far] on studio, which cannot be reached now · working when last heard"]);
    assert.deepEqual(memberOf(dropped), ["working", true], "its card says why the coordinator still waits");
  }
  assert.deepEqual(memberOf(holding), ["working", false]);
  const dropped = reduce(holding, studioLine("offline")).state;
  const back = reduce(dropped, studioLine("connected")).state;
  assert.deepEqual(wakesOf(back), []);
  const woke = wakesOf(mirrored(back, FAR_ENDED).state);
  assert.equal(woke.length, 1, "its turn ending there wakes the coordinator, once");
  assert.match(woke[0]!.prompt, /"One" ended its turn\.[\s\S]*"Far work" ended its turn\.[\s\S]*None of your threads is working now/);
});

test("a computer that has yet to answer after a restart here holds the news its thread was holding", () => {
  const holding = holdingNews();
  assert.deepEqual(holding.threads[0]!.remoteWorking, { far: { computer: "studio", title: "Far work" } }, "kept with the coordinator, which outlives a restart");
  const restarted = reduce(workspace(), { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: holding.threads, projects: [], worktrees: [], lastFolder: null } }).state;
  assert.deepEqual(wakesOf(restarted), [], "before the paired computers come in");
  assert.deepEqual(rosterOf(restarted), ["- \"Far work\" [far] on a paired computer, which cannot be reached now · working when last heard"]);
  const away = reduce(restarted, studioLine("offline")).state;
  assert.deepEqual(wakesOf(away), [], "while its line is down");
  assert.deepEqual(rosterOf(away), ["- \"Far work\" [far] on studio, which cannot be reached now · working when last heard"]);

  const answered = mirrored(reduce(away, studioLine("connected")).state, FAR_RUNNING).state;
  assert.deepEqual(wakesOf(answered), [], "still working once it answers");
  const woke = wakesOf(mirrored(answered, FAR_ENDED).state);
  assert.equal(woke.length, 1);
  assert.match(woke[0]!.prompt, /None of your threads is working now/);
  assert.equal(mirrored(answered, FAR_ENDED).state.threads[0]!.remoteWorking, undefined);

  const unpaired = reduce(restarted, { type: "computers.changed", name: "This Mac", links: [] });
  assert.equal(wakesOf(unpaired.state).length, 1, "a computer no longer paired holds nothing");
  assert.equal(unpaired.state.threads[0]!.remoteWorking, undefined);
  const gone = mirrored(reduce(away, studioLine("connected")).state, workspace());
  assert.equal(wakesOf(gone.state).length, 1, "nor does one whose thread is no longer there");
});

test("a coordinator with more threads there than it keeps watermarks for hears each of them once", () => {
  const many = Array.from({ length: 101 }, (_, index) => far({ id: `m${index}`, title: `M${index}`, createdAt: index + 1, runEndedAt: 1_000 + index, outcome: "finished" }));
  let state = mirrored(coordinating(workspace()), workspace({ threads: many })).state;
  const heard = notesOf(state).length;
  assert.equal(Object.keys(state.threads[0]!.remoteHeard ?? {}).length, 101, "none still working under it is forgotten");
  state = mirrored(state, workspace({ threads: [...many] })).state;
  state = mirrored(state, workspace({ threads: [...many] })).state;
  assert.equal(notesOf(state).length, heard, "a patch from there is not heard all over again");

  const left = mirrored(state, workspace({ threads: [...many.slice(1), far({ id: "new", title: "New", createdAt: 5_000 })] })).state;
  assert.equal(left.threads[0]!.remoteHeard?.m0, undefined, "one no longer there is what makes room");
  assert.equal(left.threads[0]!.remoteHeard?.new, 5_000);
});

test("what a member's scheduled runs find is said here, and a scheduled run that finished is not", () => {
  const ticking = workspace({ threads: [far()], activeRuns: { far: activeRun("far", "tick", { origin: "automation" }) } });
  const state = mirrored(coordinating(workspace()), ticking).state;
  const found = mirrored(state, workspace({ threads: [far({ runEndedAt: 30, outcome: "finished", findings: [{ id: "f1", headline: "Disk almost full", at: 25 }] })] }));
  assert.deepEqual(found.effects.filter((effect) => effect.type === "announce-thread").map((effect) => effect.notice.headline), ["Disk almost full"]);
  assert.equal(notesOf(found.state).at(-1), "\"Far work\" ended its turn.", "its coordinator still hears the turn end");
});

test("a member's turn ending is said as a run here would say it, and one never seen to start says only that it failed", () => {
  const announcedOf = (effects: ReturnType<typeof reduce>["effects"]) => effects.flatMap((effect) => effect.type === "announce-thread" ? [effect.notice.headline] : []);
  const running = mirrored(coordinating(workspace()), workspace({ threads: [far()], activeRuns: { far: activeRun("far", "run-far") } })).state;
  const failure = createFailureMessage("The engine ran out of credit.");
  const failed = mirrored(running, workspace({ threads: [far({ runEndedAt: 30, outcome: "failed", messages: [failure] })] }));
  assert.deepEqual(announcedOf(failed.effects), ["The engine ran out of credit."], "in the words that computer left on the thread");

  const unseen = mirrored(coordinating(workspace()), workspace({ threads: [far({ runEndedAt: 30, outcome: "finished" })] }));
  assert.deepEqual(announcedOf(unseen.effects), [], "a run this computer never saw go could have been a scheduled one");
  assert.equal(notesOf(unseen.state).at(-1), "\"Far work\" ended its turn.", "its coordinator still hears it");
  const unseenFailure = mirrored(coordinating(workspace()), workspace({ threads: [far({ runEndedAt: 30, outcome: "failed" })] }));
  assert.deepEqual(announcedOf(unseenFailure.effects), ["The run failed."]);
});

test("a member stopped by Stop all is heard quietly", () => {
  const holder = workspace({ threads: [far()], activeRuns: { far: activeRun("far", "run-far") } });
  let state = mirrored(coordinating(workspace()), holder).state;
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  assert.deepEqual(effectOf(stopped, "computer.forward"), { type: "computer.forward", id: "studio", inputs: [{ type: "run.cancel", taskId: "far" }] });
  assert.deepEqual(stopped.state.quietStops, ["run-far"]);
  state = mirrored(stopped.state, workspace({ threads: [far({ runEndedAt: 50, outcome: "stopped" })] })).state;
  assert.equal(notesOf(state).at(-1), "\"Far work\" was stopped.");
  assert.equal(state.threads[0]!.coordinationNotes!.at(-1)!.quiet, true);
  assert.deepEqual(wakesOf(state), [], "nothing it stopped wakes the coordinator");
  assert.deepEqual(state.quietStops, []);
});

test("Stop all stops a remote member's workflows and subagents there, which alone offer it", () => {
  const work: Workflow = { id: "wf", name: "audit", description: "Audit", status: "running", phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 };
  const child: Subagent = { id: "child", description: "Inspect", status: "working", sessionScoped: true, startedAt: 1, activity: [] };
  const holder = workspace({ threads: [far()], workflows: { far: [work] }, subagents: { far: [child] } });
  const state = mirrored(coordinating(workspace()), holder).state;
  assert.equal(deriveView(state).stoppableCoordinatorIds.has("lead"), true, "though no run is going there");
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  assert.deepEqual(effectOf(stopped, "computer.forward"), { type: "computer.forward", id: "studio", inputs: [
    { type: "run.stop-process", taskId: "far", processId: "wf" },
    { type: "run.stop-process", taskId: "far", processId: "child" },
  ] });
  const stopping = mirrored(stopped.state, { ...holder, workflows: { far: [{ ...work, stopping: true }] }, subagents: { far: [{ ...child, stopping: true }] } }).state;
  assert.equal(deriveView(stopping).stoppableCoordinatorIds.has("lead"), false, "once it is stopping there");

  const older = COMPUTER_CAPABILITIES.filter((capability) => !capability.startsWith("command:run.stop-process"));
  const unreachable = mirrored(coordinating(workspace(), { capabilities: older }), holder).state;
  assert.equal(deriveView(unreachable).stoppableCoordinatorIds.has("lead"), false, "by a computer whose build cannot stop them");
});

test("a relayed notice for a remote member of a local coordinator is dropped", () => {
  const state = coordinating(workspace({ threads: [far(), task("other", { title: "Unrelated" })] }));
  assert.deepEqual(reduce(state, { type: "computer.notice", id: "studio", notice: { taskId: "far", title: "Far work", headline: "The run finished." } }).effects, [], "it is announced here, under its coordinator");
  const other = { taskId: "other", title: "Unrelated", headline: "The run finished." };
  assert.deepEqual(reduce(state, { type: "computer.notice", id: "studio", notice: other }).effects, [{ type: "announce-thread", notice: other }]);
});

test("archiving the coordinator lets its remote members stand on their own, and a computer that was offline is told when it reconnects", () => {
  const released = { type: "task.set-lead-away", taskId: "far", away: true };
  const state = withComputers(workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" })] }), [
    paired("studio", workspace({ threads: [far()] }), { capabilities: COMPUTER_CAPABILITIES }),
    paired("linux", workspace({ threads: [far({ id: "away" })] }), { status: "offline", capabilities: COMPUTER_CAPABILITIES }),
  ]);
  const archived = reduce(state, { type: "task.archive", taskId: "lead" });
  const forwards = archived.effects.filter((effect) => effect.type === "computer.forward");
  assert.deepEqual(forwards, [{ type: "computer.forward", id: "studio", inputs: [released], silent: true }], "only a line that is up carries it");
  const back = reduce(archived.state, { type: "computers.changed", name: "This Mac", links: [link("studio", { capabilities: COMPUTER_CAPABILITIES }), link("linux", { capabilities: COMPUTER_CAPABILITIES })] });
  assert.deepEqual(back.effects.filter((effect) => effect.type === "computer.forward" && effect.silent), [{ type: "computer.forward", id: "linux", inputs: [{ ...released, taskId: "away" }], silent: true }]);
});

test("a computer that restarted is told once its state comes in after its line", () => {
  const restarted = withComputers(workspace({ threads: [task("lead", { role: "coordinator", title: "Lead", archivedAt: 5 })] }), [paired("studio", null, { status: "offline", capabilities: COMPUTER_CAPABILITIES })]);
  const connected = reduce(restarted, { type: "computers.changed", name: "This Mac", links: [link("studio", { capabilities: COMPUTER_CAPABILITIES })] });
  assert.deepEqual(connected.effects.filter((effect) => effect.type === "computer.forward"), [], "nothing is known there yet");
  const said = mirrored(connected.state, workspace({ threads: [far(), task("other")] }));
  assert.deepEqual(said.effects.filter((effect) => effect.type === "computer.forward"), [{ type: "computer.forward", id: "studio", inputs: [{ type: "task.set-lead-away", taskId: "far", away: true }], silent: true }]);
  const letGo = mirrored(said.state, workspace({ threads: [far({ remoteLead: { ...FAR, away: true } }), task("other")] }));
  assert.deepEqual(letGo.effects.filter((effect) => effect.type === "computer.forward"), [], "once it is let go there is nothing more to say");
});

test("restoring the coordinator, or giving its role back, brings its remote members back under it", () => {
  const away = far({ remoteLead: { ...FAR, away: true } });
  const back = { type: "computer.forward", id: "studio", inputs: [{ type: "task.set-lead-away", taskId: "far", away: false }], silent: true };
  const forwards = (transition: ReturnType<typeof reduce>) => transition.effects.filter((effect) => effect.type === "computer.forward");
  const archived = coordinating(workspace({ threads: [away] }));
  const filed = { ...archived, threads: [{ ...archived.threads[0]!, archivedAt: 5 }] };
  assert.deepEqual(coordinationMembers(filed, "lead"), []);
  assert.deepEqual(forwards(reduce(filed, { type: "task.restore", taskId: "lead" })), [back]);
  const plain = { ...archived, threads: [{ ...archived.threads[0]!, role: undefined }] };
  assert.deepEqual(forwards(reduce(plain, { type: "task.set-role", taskId: "lead", role: "coordinator" })), [back]);
  assert.deepEqual(forwards(mirrored(archived, workspace({ threads: [away, task("other")] }))), [back], "a computer that was offline is told once it says so");
  const returned = mirrored(archived, workspace({ threads: [far({ remoteLead: { ...FAR, backAt: 20 } })] })).state;
  assert.deepEqual(coordinationMembers(returned, "lead").map(({ thread }) => thread.id), ["far"]);
  const cleared = { ...filed, threads: [], computers: { ...filed.computers, discardedLeads: ["lead"] } };
  assert.deepEqual(forwards(mirrored(cleared, workspace({ threads: [away] }))), [{ ...back, inputs: [{ type: "task.set-coordinator", taskId: "far", coordinatorId: null }] }], "one gone from here lets it go for good");
});

test("a remote member back under its coordinator brings only what it did since", () => {
  const heard = mirrored(coordinating(workspace()), workspace({ threads: [far()] })).state;
  const notes = notesOf(heard).length;
  const returned = mirrored(heard, workspace({ threads: [far({ remoteLead: { ...FAR, backAt: 40 }, runEndedAt: 30, outcome: "failed", findings: [{ id: "f1", headline: "Disk almost full", at: 25 }] })] }));
  assert.equal(notesOf(returned.state).length, notes, "its turn ended while its coordinator was away");
  assert.deepEqual(returned.effects.filter((effect) => effect.type === "announce-thread"), [], "that computer said so itself");
  assert.deepEqual(wakesOf(returned.state), []);
  const later = mirrored(returned.state, workspace({ threads: [far({ remoteLead: { ...FAR, backAt: 40 }, runEndedAt: 50, outcome: "finished" })] })).state;
  assert.equal(notesOf(later).at(-1), "\"Far work\" ended its turn.");
});

test("a computer from before a coordinator could be away lets its thread go for good", () => {
  const older = COMPUTER_CAPABILITIES.filter((capability) => !capability.startsWith("command:task.set-lead-away"));
  const state = coordinating(workspace({ threads: [far()] }), { capabilities: older });
  const archived = reduce(state, { type: "task.archive", taskId: "lead" });
  assert.deepEqual(archived.effects.filter((effect) => effect.type === "computer.forward"), [{ type: "computer.forward", id: "studio", inputs: [{ type: "task.set-coordinator", taskId: "far", coordinatorId: null }], silent: true }]);
});

test("a coordinator cleared from the archive while a computer holding its thread was away still lets that thread go once it is back, after a restart too", () => {
  const state = withComputers(workspace({ threads: [task("lead", { role: "coordinator", title: "Lead", archivedAt: 5 })] }), [paired("studio", workspace({ threads: [far()] }), { status: "offline", capabilities: COMPUTER_CAPABILITIES })]);
  const cleared = reduce(state, { type: "task.clear-archive" });
  assert.deepEqual(cleared.state.computers.discardedLeads, ["lead"]);
  const remembered = required(cleared.effects.find((effect) => effect.type === "persist-preferences"));
  assert.deepEqual(remembered.type === "persist-preferences" && remembered.preferences.discardedLeads, ["lead"], "it is kept between launches");

  const restarted = reduce(withComputers(workspace(), [paired("studio", null, { status: "offline", capabilities: COMPUTER_CAPABILITIES })]), { type: "preferences.loaded", preferences: { ...viewPreferences(workspace()), discardedLeads: ["lead"] } }).state;
  for (const before of [cleared.state, restarted]) {
    const back = reduce(before, { type: "computers.changed", name: "This Mac", links: [link("studio", { capabilities: COMPUTER_CAPABILITIES })] });
    const said = mirrored(back.state, workspace({ threads: [far()] }));
    const forwards = [...back.effects, ...said.effects].filter((effect) => effect.type === "computer.forward");
    assert.ok(forwards.length > 0);
    assert.deepEqual(new Set(forwards.map((effect) => JSON.stringify(effect))), new Set([JSON.stringify({ type: "computer.forward", id: "studio", inputs: [{ type: "task.set-coordinator", taskId: "far", coordinatorId: null }], silent: true })]));
  }
});

test("a coordinator that outlived its time in the archive while a computer holding its thread was away still lets that thread go once it is back", () => {
  const expired = task("lead", { role: "coordinator", title: "Lead", archivedAt: Date.now() - ARCHIVE_RETENTION_MS - 1 });
  const recent = task("recent", { role: "coordinator", archivedAt: Date.now() });
  const away = withComputers(workspace(), [paired("studio", null, { status: "offline", capabilities: COMPUTER_CAPABILITIES })]);
  const loaded = reduce(away, { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: [expired, recent, task("plain", { archivedAt: 1 })], projects: [], worktrees: [], lastFolder: null } });
  assert.deepEqual(loaded.state.threads.map((thread) => thread.id), ["recent"]);
  assert.deepEqual(loaded.state.computers.discardedLeads, ["lead"], "only a coordinator gone from here is remembered");
  const remembered = required(loaded.effects.find((effect) => effect.type === "persist-preferences"));
  assert.deepEqual(remembered.type === "persist-preferences" && remembered.preferences.discardedLeads, ["lead"], "it is kept between launches");
  const again = reduce(loaded.state, { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: [expired], projects: [], worktrees: [], lastFolder: null } });
  assert.deepEqual([again.state.computers.discardedLeads, again.effects.some((effect) => effect.type === "persist-preferences")], [["lead"], false], "one remembered already is not said twice");

  const back = reduce(loaded.state, { type: "computers.changed", name: "This Mac", links: [link("studio", { capabilities: COMPUTER_CAPABILITIES })] });
  const said = mirrored(back.state, workspace({ threads: [far()] }));
  assert.deepEqual(said.effects.filter((effect) => effect.type === "computer.forward"), [{ type: "computer.forward", id: "studio", inputs: [{ type: "task.set-coordinator", taskId: "far", coordinatorId: null }], silent: true }]);
});

test("a coordinator whose role was taken off while a computer holding its thread was away still lets that thread go once it is cleared from the archive", () => {
  const state = withComputers(workspace({ threads: [task("lead", { role: "coordinator", title: "Lead", remoteHeard: { far: 10 } }), task("plain")] }), [paired("studio", workspace({ threads: [far()] }), { status: "offline", capabilities: COMPUTER_CAPABILITIES })]);
  const plain = reduce(state, { type: "task.set-role", taskId: "lead", role: null }).state;
  assert.equal(plain.threads[0]!.role, undefined);
  const archived = ["lead", "plain"].reduce((held, taskId) => reduce(held, { type: "task.archive", taskId }).state, plain);
  const cleared = reduce(archived, { type: "task.clear-archive" });
  assert.deepEqual(cleared.state.computers.discardedLeads, ["lead"], "a thread that never led one there is not remembered");

  const back = reduce(cleared.state, { type: "computers.changed", name: "This Mac", links: [link("studio", { capabilities: COMPUTER_CAPABILITIES })] });
  const said = mirrored(back.state, workspace({ threads: [far()] }));
  const forwards = [...back.effects, ...said.effects].filter((effect) => effect.type === "computer.forward");
  assert.ok(forwards.length > 0);
  assert.deepEqual(new Set(forwards.map((effect) => JSON.stringify(effect))), new Set([JSON.stringify({ type: "computer.forward", id: "studio", inputs: [{ type: "task.set-coordinator", taskId: "far", coordinatorId: null }], silent: true })]));
});

/** A coordinator on a paired computer, as the thread it started here names it. */
const LEAD_THERE = { threadId: "lead-there", title: "Lead", computer: "Laptop" };

test("a thread whose coordinator is on another computer runs as a member there and records its own reports and decisions", () => {
  const state = workspace({ threads: [task("member", { title: "Member", remoteLead: LEAD_THERE })] });
  const sending = reduce(state, { type: "task.send", taskId: "member", text: "Carry on" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  assert.equal(effectAt(started, "start-run").command.coordinationRole, "member");

  const reported = reduce(state, { type: "coordination.reported", taskId: "member", state: "blocked", summary: "No GPU here" });
  assert.deepEqual([reported.state.threads[0]!.report?.state, reported.state.threads[0]!.report?.summary], ["blocked", "No GPU here"]);
  assert.deepEqual(reported.effects, [], "the coordinator's computer hears it, and says it, there");
  const raised = reduce(state, { type: "coordination.decision-raised", taskId: "member", request: { question: "Drop the old API?", options: [] } });
  assert.equal(raised.state.threads[0]!.decisions?.[0]?.question, "Drop the old API?");
  assert.deepEqual(raised.effects, []);

  const view = coordinationView(raised.state, raised.state.threads[0], new Set(), new Set());
  assert.deepEqual(view.remoteLead, { title: "Lead", computer: "Laptop", threadId: null }, "a coordinator no paired computer here holds cannot be gone to");
  assert.deepEqual(view.decisions, [], "its decision is answered on its coordinator's card");
  assert.equal(view.asking, true);

  const other = { ...state, threads: [...state.threads, task("other", { title: "Other" })] };
  const signed = reduce(other, { type: "task.send", taskId: "member", text: "Rebase", from: "other" });
  assert.match(Object.values(signed.state.pendingRuns)[0]!.prompt, /works under the coordinator "Lead" \[lead-there\], which did not send this message/);
});

test("a remote member's decision and approval are answered on its own computer", () => {
  const decision = { id: "d1", question: "Keep the old API?", options: [], raisedAt: 5 };
  const approval = { approvalId: "a1", taskId: "far", runId: "run-far", title: "Run tests", description: "", toolName: "Bash", input: {} };
  const holder = workspace({
    threads: [task("far", { title: "Far work", remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" }, decisions: [decision] })],
    activeRuns: { far: activeRun("far", "run-far", { status: "awaiting-approval" }) },
    approvals: { "run-far": approval },
  });
  const state = workspace({
    threads: [lead("lead", { title: "Lead" })],
    currentId: "lead",
    computers: { ...workspace().computers, name: "Mac", paired: [{ id: "studio", name: "Studio", host: "studio.test", pairedAt: 1, status: "connected", error: null, state: holder }] },
  });
  const view = deriveView(state).coordination;
  assert.deepEqual(view.approvals.map(({ thread, approval: waiting }) => [thread.id, waiting.approvalId]), [["far", "a1"]]);
  assert.deepEqual(view.decisions.map(({ thread, decision: open }) => [thread.id, open.id]), [["far", "d1"]]);
  assert.equal(view.members[0]!.status, "approval");

  for (const input of [
    { type: "decision.answer", taskId: "far", decisionId: "d1", answer: "Keep it" },
    { type: "run.decide", taskId: "far", runId: "run-far", approvalId: "a1", allow: true },
  ] satisfies WorkspaceInput[]) {
    const carried = reduce(state, input);
    assert.deepEqual(effectOf(carried, "computer.forward"), { type: "computer.forward", id: "studio", inputs: [input] }, `${input.type} is decided where the thread is`);
  }
});

test("a remote member whose coordinator is away stands on its own, and works under it again once it is back", () => {
  const state = workspace({ threads: [task("member", { remoteLead: LEAD_THERE, resolvedAt: 3 })] });
  const away = reduce(state, { type: "task.set-lead-away", taskId: "member", away: true }).state;
  assert.deepEqual(away.threads[0]!.remoteLead, { ...LEAD_THERE, away: true }, "it keeps whom it worked under");
  assert.equal(coordinationRole(away.threads, away.threads[0]!), undefined);
  assert.equal(coordinationView(away, away.threads[0], new Set(), new Set()).remoteLead, null);
  assert.equal(reduce(away, { type: "task.set-lead-away", taskId: "member", away: true }).state, away, "saying it twice changes nothing");

  const back = reduce(away, { type: "task.set-lead-away", taskId: "member", away: false }).state;
  const lead = required(back.threads[0]!.remoteLead);
  assert.deepEqual([lead.away, typeof lead.backAt, back.threads[0]!.resolvedAt], [undefined, "number", 3], "it is back as it was");
  assert.equal(coordinationRole(back.threads, back.threads[0]!), "member");
  const moved = reduce(away, { type: "task.set-coordinator", taskId: "member", coordinatorId: null }).state;
  assert.equal(moved.threads[0]!.remoteLead, undefined, "moving it out lets it go for good");
});

test("moving a remote member out clears its remote lead", () => {
  const state = workspace({ threads: [task("member", { remoteLead: LEAD_THERE, resolvedAt: 3 }), lead("here")] });
  const left = reduce(state, { type: "task.set-coordinator", taskId: "member", coordinatorId: null }).state;
  assert.equal(left.threads[0]!.remoteLead, undefined);
  assert.equal(left.threads[0]!.resolvedAt, undefined);
  assert.equal(coordinationRole(left.threads, left.threads[0]!), undefined);
  const moved = reduce(state, { type: "task.set-coordinator", taskId: "member", coordinatorId: "here" }).state;
  assert.deepEqual([moved.threads[0]!.parentId, moved.threads[0]!.remoteLead], ["here", undefined], "a coordinator here takes it from the one elsewhere");
});

test("a start allowed on another computer that is still on its way when everything stops is stopped there as it lands, and heard quietly", () => {
  const brief = { intent: "port the parser", doneWhen: "tests pass", delivers: "report" as const };
  const proposal = { id: "p1", title: "Far work", prompt: "Port it", brief, place: { computer: { id: "studio", name: "studio" }, project: "far-project", worktree: false }, proposedAt: 1 };
  const holder = workspace({ projects: [{ id: "far-project", root: "/far" }] });
  const state = withComputers(workspace({ threads: [lead("lead", { title: "Lead", proposals: [proposal] })] }), [paired("studio", holder, { capabilities: COMPUTER_CAPABILITIES })]);
  const allowed = reduce(state, { type: "proposal.start", taskId: "lead", proposalId: "p1", place: { project: "far-project", worktree: false } });
  assert.deepEqual(allowed.state.startingProposals, ["p1"]);
  assert.equal(deriveView(allowed.state).stoppableCoordinatorIds.has("lead"), true, "a start on its way is something to stop");

  const stopped = reduce(allowed.state, { type: "coordination.stop-all", taskId: "lead" });
  assert.deepEqual(stopped.state.stoppedStarts, [{ proposalId: "p1" }]);
  assert.deepEqual(stopped.state.startingProposals, ["p1"], "it cannot be called back, so it is not offered again until it lands");
  assert.equal(deriveView(stopped.state).stoppableCoordinatorIds.has("lead"), false, "once caught, nothing is left to stop");

  const landed = reduce(stopped.state, { type: "proposal.settled", taskId: "lead", proposalId: "p1", threadId: "far" });
  assert.deepEqual(landed.effects.flatMap((effect) => effect.type === "computer.forward" ? [[effect.id, effect.inputs]] : []), [["studio", [{ type: "run.cancel", taskId: "far" }]]], "the thread is stopped where it landed");
  assert.deepEqual(landed.state.startingProposals, []);
  assert.equal(landed.state.threads[0]!.proposals, undefined);

  const ended = mirrored(landed.state, { ...holder, threads: [far({ runEndedAt: 50, outcome: "stopped" })] });
  assert.deepEqual(notesOf(ended.state), ["\"Far work\" started on studio.", "\"Far work\" was stopped."]);
  assert.equal(ended.state.threads[0]!.coordinationNotes?.every((note) => note.quiet), true);
  assert.deepEqual(wakesOf(ended.state), [], "its stop never wakes the coordinator");
  assert.deepEqual(ended.state.stoppedStarts, []);

  const failed = reduce(stopped.state, { type: "proposal.settled", taskId: "lead", proposalId: "p1", message: "No such folder." });
  assert.deepEqual(failed.state.startingProposals, []);
  assert.deepEqual(failed.state.threads[0]!.proposals?.map((item) => [item.id, item.error]), [["p1", undefined]], "one that never landed waits to be allowed again, with nothing to say");
  assert.deepEqual(failed.state.stoppedStarts, []);
});

test("a start allowed on another computer whose answer is lost settles its card once its thread shows up there", () => {
  const brief = { intent: "port the parser", doneWhen: "tests pass", delivers: "report" as const };
  const proposal = { id: "p1", title: "Far work", prompt: "Port it", brief, place: { computer: { id: "studio", name: "studio" }, project: "far-project", worktree: false }, proposedAt: 1 };
  const holder = workspace({ projects: [{ id: "far-project", root: "/far" }] });
  const state = withComputers(workspace({ threads: [lead("lead", { title: "Lead", proposals: [proposal] })] }), [paired("studio", holder, { capabilities: COMPUTER_CAPABILITIES })]);
  const allowed = reduce(state, { type: "proposal.start", taskId: "lead", proposalId: "p1" });
  const send = effectOf(allowed, "computer.forward").inputs.find((input) => input.type === "task.send");
  assert.ok(send?.type === "task.send");
  assert.deepEqual(send.lead, { ...FAR, proposalId: "p1" }, "the start names the suggestion it is");
  const there = { ...holder, threads: [far({ remoteLead: { ...FAR, proposalId: "p1" } })] };

  const lost = reduce(allowed.state, { type: "proposal.settled", taskId: "lead", proposalId: "p1", message: "That computer cannot be reached right now." });
  assert.deepEqual(lost.state.threads[0]!.proposals?.map((item) => item.error), ["That computer cannot be reached right now."]);
  const landed = mirrored(lost.state, there);
  assert.equal(landed.state.threads[0]!.proposals, undefined, "its card is gone, so it cannot be allowed twice");
  assert.deepEqual(notesOf(landed.state), ["\"Far work\" started on studio."]);
  assert.equal(reduce(landed.state, { type: "proposal.settled", taskId: "lead", proposalId: "p1", threadId: "far" }).state, landed.state, "an answer that comes late changes nothing");
  assert.equal(reduce(landed.state, { type: "proposal.settled", taskId: "lead", proposalId: "p1", message: "Lost." }).state.threads[0]!.proposals, undefined);

  const reloaded = mirrored({ ...allowed.state, startingProposals: [] }, there);
  assert.equal(reloaded.state.threads[0]!.proposals, undefined, "nor after a restart here, which forgets what was starting");
  const early = mirrored(allowed.state, there);
  assert.deepEqual([early.state.threads[0]!.proposals, early.state.startingProposals], [undefined, []], "nor when the thread shows up before the answer");

  const stopped = reduce(allowed.state, { type: "coordination.stop-all", taskId: "lead" });
  const caught = mirrored(stopped.state, { ...there, activeRuns: { far: activeRun("far", "run-far") } });
  assert.deepEqual(caught.effects.flatMap((effect) => effect.type === "computer.forward" ? [[effect.id, effect.inputs]] : []), [["studio", [{ type: "run.cancel", taskId: "far" }]]], "a start Stop all caught is stopped as it shows up");
  assert.deepEqual(caught.state.stoppedStarts, [{ proposalId: "p1", threadId: "far" }]);
  assert.deepEqual(reduce(caught.state, { type: "proposal.settled", taskId: "lead", proposalId: "p1", threadId: "far" }).effects, [], "and only once");
});

test("a computer asked again for a suggestion it started names that thread rather than starting another", () => {
  const holder = workspace({ projects: [{ id: "far-project", root: "/far" }] });
  const send = { type: "task.send", text: "Port it", project: "far-project", lead: { ...FAR, proposalId: "p1" } } satisfies WorkspaceInput;
  const sending = reduce(holder, send);
  assert.deepEqual(reduce(sending.state, send).result, { ok: false, message: "That thread is still starting." });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "far-project", kind: "project" as const, root: "/far" } });
  const thread = required(started.state.threads[0]);
  assert.deepEqual(thread.remoteLead, { ...FAR, proposalId: "p1" });

  const again = reduce(started.state, send);
  assert.deepEqual([again.result, again.effects], [{ ok: true, taskId: thread.id }, []]);
  assert.equal(again.state, started.state);
  const other = reduce(started.state, { ...send, lead: { ...FAR, proposalId: "p2" } });
  assert.equal(Object.keys(other.state.pendingRuns).length, 1, "another suggestion starts as its own thread");
  assert.equal(Object.keys(reduce(started.state, { ...send, lead: FAR }).state.pendingRuns).length, 1, "and so does a start that names none");
});

test("a start allowed on another computer keeps its card's name there, and a build that cannot take one names it itself", () => {
  const brief = { intent: "port the parser", doneWhen: "tests pass", delivers: "report" as const };
  const proposal = { id: "p1", title: "Port the parser", named: true as const, prompt: "Port it", brief, place: { computer: { id: "studio", name: "studio" }, project: "far-project", worktree: false }, proposedAt: 1 };
  const holder = workspace({ projects: [{ id: "far-project", root: "/far" }] });
  const forwardedSend = (capabilities: readonly string[]) => {
    const state = withComputers(workspace({ threads: [lead("lead", { title: "Lead", proposals: [proposal] })] }), [paired("studio", holder, { capabilities })]);
    const allowed = reduce(state, { type: "proposal.start", taskId: "lead", proposalId: "p1" });
    assert.deepEqual(allowed.state.startingProposals, ["p1"]);
    const send = effectOf(allowed, "computer.forward").inputs.find((input) => input.type === "task.send");
    assert.ok(send?.type === "task.send");
    return send;
  };
  assert.equal(forwardedSend(COMPUTER_CAPABILITIES).title, "Port the parser");
  const older = forwardedSend(COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.send:title"));
  assert.equal("title" in older, false, "the start still goes, named there from its prompt");
});
