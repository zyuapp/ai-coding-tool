import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
import { effectOf, task, workspace } from "./workspace-reducer-fixtures.mts";

function paired(id: string, remote: WorkspaceState, overrides: Partial<ComputerLink> = {}): PairedComputer {
  return { id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, ...overrides, state: remote };
}

function withComputers(state: WorkspaceState, computers: PairedComputer[]): WorkspaceState {
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: computers } };
}

test("a coordinator stays in a narrowed list while a thread under it works in the project", () => {
  const state = workspace({
    sidebarMode: "activity",
    projects: [{ id: "web", root: "/work/web" }, { id: "api", root: "/work/api" }],
    threads: [
      task("lead", { role: "coordinator", outcome: "finished" }),
      task("member", { parentId: "lead", projectId: "web" }),
      task("api-done", { projectId: "api", outcome: "finished" }),
    ],
  });
  const narrowed = reduce(state, { type: "view.set-activity-project", projectId: "web" });
  assert.equal(narrowed.effects.length, 1, "the choice is remembered");
  assert.deepEqual(deriveView(narrowed.state).activityThreads.priority.map((thread) => thread.id), ["lead"]);
  assert.equal(reduce(narrowed.state, { type: "view.set-activity-project", projectId: "web" }).state, narrowed.state);
});

test("the activity lists narrow to one project, a paired computer's included, and dismiss all keeps to it", () => {
  const remote = workspace({
    projects: [{ id: "remote-project", root: "/linux/app" }],
    threads: [task("remote-done", { projectId: "remote-project", outcome: "finished" }), task("remote-chat", { outcome: "finished" })],
  });
  const local = workspace({
    sidebarMode: "activity",
    projects: [{ id: "web", root: "/work/web" }, { id: "api", root: "/work/api" }],
    threads: [task("web-done", { projectId: "web", outcome: "finished" }), task("api-done", { projectId: "api", outcome: "finished" })],
  });
  const state = withComputers(local, [paired("linux", remote, { capabilities: COMPUTER_CAPABILITIES })]);
  const priority = (next: WorkspaceState) => deriveView(next).activityThreads.priority.map((thread) => thread.id).sort();
  assert.deepEqual(priority(state), ["api-done", "remote-chat", "remote-done", "web-done"]);

  const web = reduce(state, { type: "view.set-activity-project", projectId: "web" }).state;
  assert.equal(deriveView(web).activityProject, "web");
  assert.deepEqual(priority(web), ["web-done"]);
  const dismissedWeb = reduce(web, { type: "task.dismiss-all", projectId: "web" });
  assert.deepEqual(dismissedWeb.state.threads.map((thread) => thread.outcome), [undefined, "finished"], "another project's rows keep their dots");
  assert.equal(dismissedWeb.effects.some((effect) => effect.type === "computer.forward"), false, "no paired computer holds the project");

  const remoteOnly = reduce(state, { type: "view.set-activity-project", projectId: "remote-project" }).state;
  assert.deepEqual(priority(remoteOnly), ["remote-done"]);
  const dismissedRemote = reduce(remoteOnly, { type: "task.dismiss-all", projectId: "remote-project" });
  assert.equal(dismissedRemote.state.threads.every((thread) => thread.outcome === "finished"), true);
  const forward = effectOf(dismissedRemote, "computer.forward");
  assert.deepEqual(forward.inputs, [{ type: "task.dismiss-all", localOnly: true, projectId: "remote-project" }]);
  assert.deepEqual(reduce(remote, forward.inputs[0]).state.threads.map((thread) => thread.outcome), [undefined, "finished"]);

  const gone = reduce(state, { type: "view.set-activity-project", projectId: "removed" }).state;
  assert.equal(deriveView(gone).activityProject, null, "a project no longer listed narrows nothing");
  assert.deepEqual(priority(gone), priority(state));
});

test("a host that cannot keep dismiss all to one project is told nothing rather than everything", () => {
  const older = COMPUTER_CAPABILITIES.filter((name) => name !== "command:task.dismiss-all:projectId");
  const remote = workspace({ projects: [{ id: "remote-project", root: "/linux/app" }], threads: [task("remote", { projectId: "remote-project", outcome: "finished" })] });
  const dismissed = reduce(withComputers(workspace(), [paired("older", remote, { capabilities: older })]), { type: "task.dismiss-all", projectId: "remote-project" });
  assert.equal(dismissed.effects.some((effect) => effect.type === "computer.forward"), false);
  assert.match(dismissed.state.actionError!, /older:/);
});
