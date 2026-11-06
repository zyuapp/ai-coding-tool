import assert from "node:assert/strict";
import { test } from "vitest";
import { backfillProjectSortIndex, nextProjectSortIndex, orderProjects } from "../../src/application/project-order.ts";
import type { Project } from "../../src/domain/project.ts";

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { id, root: `/${id}`, ...overrides };
}

function ids(projects: Project[]) {
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
