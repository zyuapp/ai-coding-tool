import assert from "node:assert/strict";
import { test } from "vitest";
import { BRIEF_REQUIRED, newThreadSend, proposalSend, threadProposal, type NewThreadSend, type NewThreadStart } from "../../src/application/thread-starts.ts";
import { WORKTREE_ELSEWHERE_ERROR, WORKTREE_MISSING_ERROR } from "../../src/application/workspace-reducer/errors.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ThreadBrief } from "../../src/domain/coordination.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import { heldWorktree, PROJECT, task, workspace } from "./workspace-reducer-fixtures.mts";

const BRIEF: ThreadBrief = { intent: "fix the login test", doneWhen: "it passes", delivers: "commit" };

const send = (overrides: Partial<NewThreadSend> = {}): NewThreadSend => ({ type: "task.send", text: "Fix it", ...overrides });

function started(start: NewThreadStart): NewThreadSend {
  assert.ok(!("error" in start), "error" in start ? start.error : "");
  assert.equal(start.elsewhere, undefined, "the thread starts here");
  return start.command;
}

function refused(start: NewThreadStart): string {
  assert.ok("error" in start, "the start is refused");
  return start.error;
}

/** A coordinator on sonnet/low whose threads run on opus/high, one thread under it, and one thread under nobody. */
function coordinated(): WorkspaceState {
  return workspace({
    projects: [PROJECT],
    threads: [
      task("lead", { role: "coordinator", model: "sonnet", effort: "low", threadModel: { model: "opus", effort: "high" }, projectId: PROJECT.id, worktreeId: "wt-lead" }),
      task("worker", { parentId: "lead", model: "gpt-6-luna", engine: "codex", effort: "medium", projectId: PROJECT.id }),
      task("solo", { model: "sonnet", effort: "max", projectId: PROJECT.id, worktreeId: "wt-solo" }),
    ],
  });
}

const thread = (state: WorkspaceState, id: string) => state.threads.find((item) => item.id === id)!;

test("a thread under a coordinator works under it, from the brief it was handed, on what its threads run on", () => {
  const state = coordinated();
  assert.equal(refused(newThreadSend(state, thread(state, "lead"), send())), BRIEF_REQUIRED, "a coordinator's thread starts from a brief");
  assert.deepEqual(started(newThreadSend(state, thread(state, "lead"), send({ brief: BRIEF }))), {
    type: "task.send", text: "Fix it", brief: BRIEF, model: "opus", effort: "high", project: PROJECT.id, worktreeId: "wt-lead", coordinatorId: "lead", from: "lead",
  });

  /** One of its threads needs no brief, but what it starts joins the coordinator and runs on its threads' model, not the caller's. */
  assert.deepEqual(started(newThreadSend(state, thread(state, "worker"), send({ role: "reviewer" }))), {
    type: "task.send", text: "Fix it", role: "reviewer", model: "opus", effort: "high", project: PROJECT.id, coordinatorId: "lead", from: "worker",
  });
  /** A brief is the coordinator's to hand out, so a thread one of its threads starts never reads as one the coordinator started. */
  assert.equal(started(newThreadSend(state, thread(state, "worker"), send({ brief: BRIEF }))).brief, undefined);
  assert.equal(started(newThreadSend(state, thread(state, "solo"), send({ brief: BRIEF }))).brief, undefined);
});

test("a thread under no coordinator starts on the caller's own model, in the caller's own place", () => {
  const state = coordinated();
  assert.deepEqual(started(newThreadSend(state, thread(state, "solo"), send())), {
    type: "task.send", text: "Fix it", model: "sonnet", effort: "max", project: PROJECT.id, worktreeId: "wt-solo", from: "solo",
  });
  const placed = started(newThreadSend(state, thread(state, "solo"), send({ project: "elsewhere", worktree: true, model: "haiku" })));
  assert.equal(placed.project, "elsewhere", "a place the send names outranks the caller's");
  assert.equal(placed.worktree, true);
  assert.equal(placed.worktreeId, undefined, "asking for a worktree of its own leaves the caller's");
  assert.equal(placed.model, "haiku", "only a thread under a coordinator is kept off Haiku");
  assert.equal(placed.effort, undefined, "a model that takes no effort runs without one");
});

test("a thread named onto a paired computer starts there, unless the request named another", () => {
  const remote = { id: "remote-project", root: "/remote", workspaceId: "remote-workspace" };
  const linux: PairedComputer = {
    id: "linux", name: "Linux", host: "linux.test", pairedAt: 1, status: "connected", error: null, capabilities: COMPUTER_CAPABILITIES,
    state: workspace({ projects: [remote] }),
  };
  const base = coordinated();
  const state = { ...base, computers: { ...base.computers, paired: [linux] } };

  const there = newThreadSend(state, thread(state, "solo"), send({ project: remote.id }));
  assert.equal(there.elsewhere, linux);
  assert.ok(!("error" in there));
  assert.deepEqual(there.command, { type: "task.send", text: "Fix it", project: remote.id, model: "sonnet", effort: "max" }, "it carries none of this computer's places or threads");
  assert.equal(newThreadSend(state, thread(state, "solo"), send(), linux).elsewhere, linux, "a computer the request names is where it starts");

  assert.equal(refused(newThreadSend(state, thread(state, "solo"), send({ project: remote.id }), null)), 'That project or worktree is on Linux. Pass computer "Linux" to start the thread there.');
  const led = newThreadSend(state, thread(state, "lead"), send({ brief: BRIEF }), linux);
  assert.ok(led.elsewhere, "a coordinator's start elsewhere is that computer's too");
  assert.equal(led.lead?.id, "lead", "and says which coordinator it would work under");
});

test("a suggestion is checked as its start would be, and kept in the place that start resolves to", () => {
  const other = { id: "project-b", root: "/other", workspaceId: "workspace-b" };
  const base = coordinated();
  const state = { ...base, projects: [PROJECT, other], worktrees: [heldWorktree("wt-lead"), { ...heldWorktree("wt-other"), projectId: other.id }] };
  const lead = thread(state, "lead");
  const suggest = (asked: object) => threadProposal(state, lead, { title: " Fix login ", prompt: "Fix it", brief: BRIEF, ...asked }, 5);
  const kept = (asked: object = {}) => {
    const made = suggest(asked);
    assert.ok(!("error" in made), "error" in made ? made.error : "");
    return made.proposal;
  };

  const plain = kept();
  assert.deepEqual({ ...plain, id: "" }, { id: "", title: "Fix login", prompt: "Fix it", brief: BRIEF, place: { project: PROJECT.id, worktreeId: "wt-lead" }, proposedAt: 5 }, "it inherits the coordinator's project and worktree, and names no model of its own");
  const named = kept({ model: "gpt-6-luna", role: "reviewer" });
  assert.equal(named.model, "gpt-6-luna");
  assert.equal(named.role, "reviewer");
  assert.equal(named.effort, undefined, "an effort the coordinator did not name is left to what its threads run on then");
  assert.deepEqual(kept({ project: "/other", worktree: true }).place, { project: other.id, worktree: true }, "a project named by its path is kept by its id");
  assert.deepEqual(kept({ worktree: false }).place, { project: PROJECT.id, worktree: false }, "sharing the project checkout is said, so a start never moves into a checkout the coordinator entered since");

  assert.deepEqual(suggest({ brief: undefined }), { error: BRIEF_REQUIRED });
  assert.deepEqual(suggest({ model: "haiku" }), { error: "Threads under a coordinator cannot run on the haiku model. Pick another model." });
  const unknown = suggest({ project: "nowhere" });
  assert.ok("error" in unknown && /No project matches "nowhere"/.test(unknown.error), "an unknown project comes straight back");
  assert.deepEqual(suggest({ worktreeId: "wt-gone" }), { error: WORKTREE_MISSING_ERROR });
  assert.deepEqual(suggest({ project: PROJECT.id, worktreeId: "wt-other" }), { error: WORKTREE_ELSEWHERE_ERROR });

  /** Starting it later asks for exactly what it was suggested with, in the place it was suggested for. */
  assert.deepEqual(proposalSend(kept({ model: "gpt-6-luna", effort: "low", role: "reviewer" })), {
    type: "task.send", text: "Fix it", brief: BRIEF, project: PROJECT.id, worktreeId: "wt-lead", model: "gpt-6-luna", effort: "low", role: "reviewer",
  });
  assert.deepEqual(started(newThreadSend(state, lead, proposalSend(plain), null)), started(newThreadSend(state, lead, send({ brief: BRIEF }))), "a suggestion starts as the coordinator would have started it");
});
