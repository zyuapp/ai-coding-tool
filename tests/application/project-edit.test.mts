import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";

const PROJECT = { id: "project-1", root: "/work/ai-coding-tool", workspaceId: "workspace-1" };

function workspace(overrides = {}) {
  return { ...emptyWorkspaceState(), projects: [PROJECT], ...overrides };
}

test("naming a folder changes what it is called and nothing else", () => {
  const named = reduce(workspace(), { type: "project.edit", projectId: "project-1", name: "  App  " });

  assert.deepEqual(named.effects, [], "a name never reaches the disk");
  assert.equal(named.state.projects[0].name, "App");
  assert.equal(named.state.projects[0].root, "/work/ai-coding-tool", "the folder itself stays where it is");

  const cleared = reduce(named.state, { type: "project.edit", projectId: "project-1", name: "" });
  assert.equal(cleared.state.projects[0].name, undefined, "a blank name gives the folder its own back");
});

test("moving a folder waits for it to open, then takes the project and its threads with it", () => {
  const state = workspace({ tasks: [], lastFolder: "/work/ai-coding-tool" });
  const moving = reduce(state, { type: "project.edit", projectId: "project-1", name: "App", root: " /work/moved " });

  assert.deepEqual(moving.effects, [{ type: "register-project", projectId: "project-1", root: "/work/moved" }]);
  assert.equal(moving.state.projects[0].root, "/work/ai-coding-tool", "nothing moves until the folder opens");
  assert.equal(moving.state.projects[0].name, undefined, "the name waits with it");
  assert.deepEqual(moving.state.projectEdit, { projectId: "project-1", name: "App", saving: true, error: null });

  const moved = reduce(moving.state, {
    type: "project.registered",
    projectId: "project-1",
    workspace: { id: "workspace-2", kind: "project", root: "/work/moved" },
  });

  assert.equal(moved.state.projects[0].id, "project-1", "the project keeps its id, so its threads move with it");
  assert.equal(moved.state.projects[0].root, "/work/moved");
  assert.equal(moved.state.projects[0].workspaceId, "workspace-2");
  assert.equal(moved.state.projects[0].name, "App", "the name lands with the folder");
  assert.equal(moved.state.lastFolder, "/work/moved");
  assert.equal(moved.state.projectEdit, null);
});

test("a folder that cannot be opened leaves the editor open with what went wrong", () => {
  const moving = reduce(workspace(), { type: "project.edit", projectId: "project-1", name: "App", root: "/work/gone" });
  const failed = reduce(moving.state, { type: "project.register-failed", projectId: "project-1", message: "There is no folder at /work/gone." });

  assert.deepEqual(failed.state.projectEdit, { projectId: "project-1", name: "App", saving: false, error: "There is no folder at /work/gone." });
  assert.equal(failed.state.projects[0].root, "/work/ai-coding-tool");
  assert.equal(failed.state.projects[0].name, undefined, "a name typed beside a folder that stayed put is not kept either");
});

test("a folder the project already has asks for nothing", () => {
  const same = reduce(workspace(), { type: "project.edit", projectId: "project-1", name: "App", root: "/work/ai-coding-tool/" });

  assert.deepEqual(same.effects, []);
  assert.equal(same.state.projects[0].name, "App");
  assert.equal(same.state.projectEdit, null);
});

test("opening a folder a project was moved to finds it rather than listing it twice", () => {
  const moved = reduce(workspace(), {
    type: "project.registered",
    projectId: "project-1",
    workspace: { id: "workspace-2", kind: "project", root: "/work/moved" },
  });
  const reopened = reduce(moved.state, {
    type: "project.opened",
    workspace: { id: "workspace-3", kind: "project", root: "/work/moved" },
  });

  assert.equal(reopened.state.projects.length, 1);
  assert.equal(reopened.state.projects[0].id, "project-1");
  assert.equal(reopened.state.projects[0].workspaceId, "workspace-3");
});

test("the editor closes with the folder it was open on", () => {
  const editing = reduce(workspace(), { type: "view.edit-project", projectId: "project-1" });
  assert.deepEqual(editing.state.projectEdit, { projectId: "project-1", saving: false, error: null });

  const removed = reduce(editing.state, { type: "project.remove", projectId: "project-1" });
  assert.equal(removed.state.projectEdit, null);
});
