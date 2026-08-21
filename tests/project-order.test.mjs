import assert from "node:assert/strict";
import test from "node:test";
import { backfillProjectSortIndex, moveProject, nextProjectSortIndex, orderProjects } from "../dist/main/application/project-order.js";

function project(id, overrides = {}) {
  return { id, root: `/${id}`, ...overrides };
}

function ids(projects) {
  return orderProjects(projects).map((item) => item.id);
}

test("sort index outranks the stored order, and folders without one keep it", () => {
  const projects = [project("a", { sortIndex: 1 }), project("b", { sortIndex: 0 }), project("first"), project("second")];
  assert.deepEqual(ids(projects), ["b", "a", "first", "second"]);
});

test("backfill freezes the loaded order and leaves settled folders untouched", () => {
  const settled = [project("a", { sortIndex: 0 }), project("b", { sortIndex: 1 })];
  assert.equal(backfillProjectSortIndex(settled), settled);

  const mixed = backfillProjectSortIndex([project("a", { sortIndex: 0 }), project("b"), project("c")]);
  assert.deepEqual(mixed.map((item) => [item.id, item.sortIndex]), [["a", 0], ["b", 1], ["c", 2]]);
  assert.equal(nextProjectSortIndex(mixed), -1);
});

test("new folders land above everything, including a list that was never reordered", () => {
  assert.equal(nextProjectSortIndex([]), -1);
  assert.equal(nextProjectSortIndex([project("a", { sortIndex: -3 }), project("b", { sortIndex: 4 })]), -4);
});

test("a drop lands at its slot and past the end", () => {
  const projects = [project("a", { sortIndex: 0 }), project("b", { sortIndex: 1 }), project("c", { sortIndex: 2 })];
  assert.deepEqual(ids(moveProject(projects, "c", 0)), ["c", "a", "b"]);
  assert.deepEqual(ids(moveProject(projects, "a", 1)), ["b", "a", "c"]);
  assert.deepEqual(ids(moveProject(projects, "a", 9)), ["b", "c", "a"]);
});

test("a drop keeps everything else about a folder", () => {
  const projects = [project("a", { sortIndex: 0, workspaceId: "workspace-a" }), project("b", { sortIndex: 1 })];
  const moved = moveProject(projects, "b", 0);
  assert.equal(moved.find((item) => item.id === "a").workspaceId, "workspace-a");
  assert.equal(moved.find((item) => item.id === "a").root, "/a");
});

test("a move that changes nothing keeps the list itself, so nothing is written", () => {
  const projects = [project("a", { sortIndex: 0 }), project("b", { sortIndex: 1 })];
  assert.equal(moveProject(projects, "a", 0), projects);
  assert.equal(moveProject(projects, "missing", 0), projects);
});

test("a drop renumbers a list that was never reordered", () => {
  const projects = [project("a"), project("b"), project("c")];
  const moved = moveProject(projects, "c", 0);
  assert.deepEqual(moved.map((item) => [item.id, item.sortIndex]), [["a", 1], ["b", 2], ["c", 0]]);
  assert.deepEqual(ids(moved), ["c", "a", "b"]);
});
