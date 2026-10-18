import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { coordinationContext } from "../../src/application/coordination.ts";
import { sidebarLists } from "../../src/application/sidebar-lists.ts";
import { deriveView, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ThreadBrief, ThreadProposal } from "../../src/domain/coordination.ts";
import { activeRun, correlatedRunEvent, effectAt, PROJECT, required, task, workspace } from "./workspace-reducer-fixtures.mts";

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };
const BRIEF: ThreadBrief = { intent: "fix the flaky login test", doneWhen: "the suite passes 50 runs", delivers: "pull-request" };

function lead(overrides = {}) {
  return task("lead", { role: "coordinator", threadModel: { model: "opus", effort: "high" }, ...overrides });
}

function proposal(id: string, overrides: Partial<ThreadProposal> = {}): ThreadProposal {
  return { id, title: `Suggestion ${id}`, prompt: `Do ${id}`, brief: BRIEF, place: { worktree: false }, proposedAt: 1, ...overrides };
}

/** The coordinator as the state holds it now. */
const coordinator = (state: WorkspaceState) => required(state.threads.find((thread) => thread.id === "lead"));

const resolving = (transition: WorkspaceTransition) => transition.effects.filter((effect): effect is Extract<WorkspaceEffect, { type: "resolve-run-workspace" }> => effect.type === "resolve-run-workspace");

/** The user starts one suggestion and its run resolves, answering with the run's start and the state it leaves. */
function startOne(state: WorkspaceState, proposalId: string) {
  const asked = reduce(state, { type: "proposal.start", taskId: "lead", proposalId });
  const [request] = resolving(asked);
  const started = reduce(asked.state, { type: "run.resolved", pendingId: required(request).pendingId, workspace: PROJECTLESS });
  return { asked, started, command: effectAt(started, "start-run").command };
}

test("a coordinator's suggestions wait for the user, and one started works under it with its brief and memory", () => {
  const memory = { purpose: "Ship the v2 reader", notes: [{ id: "n1", text: "Use Sonnet for docs", at: 1 }], revision: 1, heard: 1 };
  const state = workspace({ threads: [lead({ memory })], currentId: "lead" });
  const proposed = reduce(state, { type: "coordination.proposed", taskId: "lead", proposals: [proposal("p1", { title: "Fix login", named: true }), proposal("p2")] });
  assert.deepEqual(coordinator(proposed.state).proposals?.map((item) => item.id), ["p1", "p2"]);
  assert.deepEqual(proposed.effects, [], "nothing starts until the user starts it");
  assert.deepEqual(deriveView(proposed.state).coordination.proposals.map(({ proposal: item, starting }) => [item.id, starting]), [["p1", false], ["p2", false]]);

  const { asked, started, command } = startOne(proposed.state, "p1");
  assert.deepEqual(asked.state.startingProposals, ["p1"]);
  assert.equal(deriveView(asked.state).coordination.proposals[0]?.starting, true, "its row says it is starting");
  assert.equal(resolving(reduce(asked.state, { type: "proposal.start", taskId: "lead", proposalId: "p1" })).length, 0, "starting it twice starts one thread");

  const worker = required(started.state.threads.find((thread) => thread.parentId === "lead"));
  assert.deepEqual(worker.brief, BRIEF);
  assert.equal(worker.title, "Fix login", "it is named what the suggestion the user started was called");
  assert.equal(started.effects.some((effect) => effect.type === "suggest-title"), false);
  assert.equal(command.coordinationRole, "member");
  assert.equal(command.model, "opus");
  assert.equal(command.effort, "high");
  assert.match(command.prompt, /Message from the thread "lead" \[lead\]/, "it reads as a thread its coordinator started");
  assert.match(command.prompt, /The user's words: fix the flaky login test[\s\S]*The coordinator's purpose: Ship the v2 reader\nWhat the coordinator keeps in memory:\n- \[n1\] Use Sonnet for docs/);
  assert.deepEqual(started.state.startingProposals, []);
  assert.deepEqual(coordinator(started.state).proposals?.map((item) => item.id), ["p2"], "its row goes once the thread exists");

  const note = required(coordinator(started.state).coordinationNotes?.at(-1));
  assert.equal(note.text, `The user started your suggested thread "Fix login" [${worker.id}].`);
  assert.equal(note.quiet, true);
  assert.equal(resolving(started).length, 0, "the coordinator is not woken by it");
  assert.deepEqual(deriveView(started.state).coordination.starts.map((start) => start.id), [worker.id], "it has a card where it began, like any thread the coordinator starts");
  assert.equal(started.state.currentId, "lead", "the user stays with the coordinator");
});

test("a suggestion started later runs on what the coordinator's threads run on then", () => {
  const state = workspace({ threads: [lead({ proposals: [proposal("p1"), proposal("p2", { model: "sonnet" }), proposal("p3", { model: "gpt-6-luna", effort: "low" })] })] });
  const moved = reduce(state, { type: "coordination.set-thread-model", taskId: "lead", model: "gpt-6.1-sol", effort: "ultra" }).state;
  const runsOn = (proposalId: string) => {
    const { command } = startOne(moved, proposalId);
    return { model: command.model, effort: command.effort };
  };
  assert.deepEqual(runsOn("p1"), { model: "gpt-6.1-sol", effort: "ultra" });
  assert.deepEqual(runsOn("p2"), { model: "sonnet", effort: "max" }, "a model it named keeps the threads' effort, as near as that model takes");
  assert.deepEqual(runsOn("p3"), { model: "gpt-6-luna", effort: "low" });
});

test("Start all starts every suggestion here, and one that cannot start stays with its error", () => {
  const gone = proposal("p3", { place: { project: "project-gone", worktree: false } });
  const state = workspace({ projects: [PROJECT], threads: [lead({ proposals: [proposal("p1"), proposal("p2"), gone] })], currentId: "lead" });
  const all = reduce(state, { type: "proposal.start", taskId: "lead" });
  assert.equal(resolving(all).length, 2);
  assert.deepEqual(all.state.startingProposals, ["p1", "p2"]);
  const failed = required(coordinator(all.state).proposals?.find((item) => item.id === "p3"));
  assert.match(required(failed.error), /No project matches "project-gone"/);
  assert.equal(all.state.actionError, null, "the refusal is said on its row, not in the banner");
  assert.equal(all.result?.ok, false);

  const again = reduce(all.state, { type: "proposal.start", taskId: "lead" });
  assert.equal(resolving(again).length, 0, "suggestions already starting are not started again");

  const fixed = { ...again.state, projects: [PROJECT, { id: "project-gone", root: "/gone", workspaceId: "workspace-gone" }] };
  const retried = reduce(fixed, { type: "proposal.start", taskId: "lead", proposalId: "p3" });
  assert.equal(coordinator(retried.state).proposals?.find((item) => item.id === "p3")?.error, undefined, "a new attempt clears the error");
  assert.deepEqual(retried.state.startingProposals, ["p1", "p2", "p3"]);

  const [request] = resolving(retried);
  const unresolved = reduce(retried.state, { type: "run.unresolved", pendingId: required(request).pendingId, message: "The folder is gone." });
  assert.equal(coordinator(unresolved.state).proposals?.find((item) => item.id === "p3")?.error, "The folder is gone.", "a start that fails on its way keeps its row with why");
  assert.deepEqual(unresolved.state.startingProposals, ["p1", "p2"]);
  assert.equal(unresolved.state.actionError, null);
});

test("starting a suggestion leaves where the user's own draft is pointed alone", () => {
  const drafted = workspace({
    projects: [PROJECT],
    threads: [lead({ proposals: [proposal("p1", { place: { project: PROJECT.id } })] })],
    currentId: "lead",
    draftBranch: { name: "feature", create: true },
    draftWorktree: true,
  });
  const asked = reduce(drafted, { type: "proposal.start", taskId: "lead", proposalId: "p1" });
  const [request] = resolving(asked);
  assert.equal(required(request).createWorktree, undefined, "it gets no checkout the user's draft asked for");
  assert.equal(required(request).createBranch, undefined);
  assert.equal(required(request).checkout, undefined, "nor moves the project onto the draft's branch");
  const started = reduce(asked.state, { type: "run.resolved", pendingId: required(request).pendingId, workspace: { id: PROJECT.workspaceId!, kind: "project", root: PROJECT.root } });
  assert.ok(started.state.threads.some((thread) => thread.parentId === "lead"));
  assert.deepEqual(started.state.draftBranch, { name: "feature", create: true });
  assert.equal(started.state.draftWorktree, true);
});

test("a declined suggestion is heard quietly", () => {
  const worker = task("worker", { parentId: "lead", title: "Fix login" });
  const state = workspace({
    threads: [lead({ proposals: [proposal("p1", { title: "Docs" }), proposal("p2", { title: "Tests" }), proposal("p3", { title: "Bench" })] }), worker],
    activeRuns: { worker: activeRun("worker", "run-w") },
    runStatuses: { worker: "running" },
  });
  const one = reduce(state, { type: "proposal.dismiss", taskId: "lead", proposalId: "p1" });
  assert.deepEqual(coordinator(one.state).proposals?.map((item) => item.id), ["p2", "p3"]);
  assert.equal(coordinator(one.state).coordinationNotes?.at(-1)?.text, 'The user declined the suggested thread "Docs".');
  assert.equal(coordinator(one.state).coordinationNotes?.at(-1)?.quiet, true);
  assert.equal(resolving(one).length, 0, "declining wakes nothing");

  const rest = reduce(one.state, { type: "proposal.dismiss", taskId: "lead" });
  assert.equal(coordinator(rest.state).proposals, undefined);
  assert.equal(coordinator(rest.state).coordinationNotes?.at(-1)?.text, 'The user declined the suggested threads "Tests" and "Bench".', "dismissing all says so once");
  assert.equal(resolving(rest).length, 0);

  const ended = reduce(rest.state, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  const [wake] = resolving(ended);
  assert.match(required(ended.state.pendingRuns[required(wake).pendingId]).text, /declined the suggested thread "Docs"[\s\S]*"Fix login" ended its turn/, "the next wake carries what the user declined");
});

test("pending suggestions are listed in the coordinator's context", () => {
  const state = workspace({ threads: [lead({ proposals: [proposal("p1", { title: "Fix login" })] })] });
  assert.match(coordinationContext(state, coordinator(state)), /Suggested threads waiting on the user:\n- "Fix login" \[p1\]/);
  const none = workspace({ threads: [lead()] });
  assert.doesNotMatch(coordinationContext(none, coordinator(none)), /Suggested threads/);
});

test("at most twelve suggestions wait at once, the ones already waiting first", () => {
  const twelve = Array.from({ length: 12 }, (_, index) => proposal(`p${index}`));
  const state = workspace({ threads: [lead()] });
  const filled = reduce(state, { type: "coordination.proposed", taskId: "lead", proposals: [...twelve, proposal("p12")] }).state;
  assert.deepEqual(coordinator(filled).proposals?.map((item) => item.id), twelve.map((item) => item.id));
  assert.equal(reduce(filled, { type: "coordination.proposed", taskId: "lead", proposals: [proposal("late")] }).state, filled, "a full list takes no more");
});

test("only a coordinator keeps suggestions, and none is ever left starting after a restart", () => {
  const solo = workspace({ threads: [task("solo", { proposals: [proposal("p1")] })] });
  for (const input of [
    { type: "coordination.proposed" as const, taskId: "solo", proposals: [proposal("p2")] },
    { type: "proposal.start" as const, taskId: "solo" },
    { type: "proposal.dismiss" as const, taskId: "solo" },
  ]) assert.equal(reduce(solo, input).state, solo, input.type);
  const demoted = reduce(workspace({ threads: [lead({ proposals: [proposal("p1")] })] }), { type: "task.set-role", taskId: "lead", role: null }).state;
  assert.equal(coordinator(demoted).proposals, undefined, "a thread that stops coordinating forgets what it suggested");

  const starting = reduce(workspace({ threads: [lead({ proposals: [proposal("p1")] })], currentId: "lead" }), { type: "proposal.start", taskId: "lead" }).state;
  assert.equal(Object.hasOwn(required(coordinator(starting).proposals?.[0]), "starting"), false, "starting is never written on the thread");
  const restarted = { ...emptyWorkspaceState(), threads: starting.threads, currentId: "lead" };
  assert.deepEqual(deriveView(restarted).coordination.proposals.map(({ starting: going }) => going), [false], "so a restart finds it ready to start again");
  assert.equal(reduce(starting, { type: "proposal.dismiss", taskId: "lead" }).state, starting, "one already starting is past turning down");
});

test("a thread under a coordinator asking to run one on another computer is put to the user at once", () => {
  const studio = { id: "studio", name: "Studio" };
  const asked = proposal("p1", { title: "GPU tests", place: { computer: studio, project: "app", worktree: false }, from: "worker" });
  const state = workspace({ threads: [lead({ title: "Plan" }), task("worker", { parentId: "lead" })], notifications: true });
  const announcedOf = (transition: WorkspaceTransition) => transition.effects.flatMap((effect) => effect.type === "announce-thread" ? [[effect.notice.taskId, effect.notice.title, effect.notice.headline]] : []);
  const filed = reduce(state, { type: "coordination.proposed", taskId: "lead", proposals: [asked] });
  assert.deepEqual(announcedOf(filed), [["lead", "Plan", "Needs you: Run \"GPU tests\" on Studio?"]], "on the coordinator, whose card holds it, as a decision of its threads is");
  assert.deepEqual(announcedOf(reduce(filed.state, { type: "coordination.proposed", taskId: "lead", proposals: [proposal("p2")] })), [], "one already waiting is not said again");

  const own = reduce(state, { type: "coordination.proposed", taskId: "lead", proposals: [proposal("p1", { place: { computer: studio, project: "app", worktree: false } }), proposal("p2")] });
  assert.deepEqual(announcedOf(own), [], "what the coordinator asks for itself, its reply says");
  const muted = workspace({ ...state, threads: [lead({ muted: true }), task("worker", { parentId: "lead" })] });
  assert.deepEqual(announcedOf(reduce(muted, { type: "coordination.proposed", taskId: "lead", proposals: [asked] })), [], "a muted coordinator keeps it back");
});

test("a coordinator's row says what its Needs-you card holds, a request by the computer it names, and nothing already starting", () => {
  const studio = { id: "studio", name: "Studio" };
  const request = (id: string, computer = studio) => proposal(id, { place: { computer, project: "app", worktree: false } });
  const decision = { id: "d1", question: "Which?", options: [], raisedAt: 1 };
  const said = (proposals: ThreadProposal[], starting: string[] = [], decisions = [decision]) => {
    const state = workspace({ threads: [lead({ proposals }), task("worker", { parentId: "lead", decisions })], startingProposals: starting });
    const lists = sidebarLists(state, [], state.threads, new Set(), new Set());
    return [lists.waitingLines.get("lead") ?? null, lists.activityThreads.priority.map((thread) => thread.id)];
  };
  assert.deepEqual(said([proposal("p1"), request("p2"), request("p3")]), ["A decision, 2 requests to run threads on Studio and a suggested thread are waiting on you", ["lead"]]);
  assert.deepEqual(said([request("p2"), request("p3", { id: "lab", name: "Lab" })], [], []), ["2 requests to run threads on other computers are waiting on you", ["lead"]]);
  assert.deepEqual(said([proposal("p1"), request("p2")], ["p1"], []), ["A request to run a thread on Studio is waiting on you", ["lead"]], "one already starting waits on no one");
  assert.deepEqual(said([proposal("p1"), request("p2")], ["p1", "p2"], []), [null, []], "so a coordinator with only those has nothing waiting");
});
