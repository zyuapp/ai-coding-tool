import assert from "node:assert/strict";
import { test } from "vitest";
import { projectSettingsRows } from "../../src/application/project-settings.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
import { task, workspace } from "./workspace-reducer-fixtures.mts";

function paired(id: string, name: string, remote: WorkspaceState, status: ComputerLink["status"] = "connected"): PairedComputer {
  return { id, name, host: `${id}.tail.ts.net`, status, error: null, pairedAt: 1, state: remote };
}

function withComputers(state: WorkspaceState, computers: PairedComputer[], filter: WorkspaceState["computers"]["filter"] = "all"): WorkspaceState {
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: computers, filter } };
}

const summary = (state: WorkspaceState) => projectSettingsRows(state).map((row) => [row.project.id, row.host?.name ?? null, row.threads]);

test("this computer's projects come first by name, then each paired computer's by its name, each by project name", () => {
  const state = withComputers(workspace({
    projects: [{ id: "zeta", root: "/work/zeta" }, { id: "alpha", root: "/work/alpha", name: "Alpha app" }],
  }), [
    paired("studio", "Studio", workspace({ projects: [{ id: "s-b", root: "/studio/b" }, { id: "s-a", root: "/studio/a" }] })),
    paired("linux", "linux-box", workspace({ projects: [{ id: "ml", root: "/linux/ml" }] })),
  ]);
  assert.deepEqual(summary(state), [
    ["alpha", null, 0],
    ["zeta", null, 0],
    ["ml", "linux-box", 0],
    ["s-a", "Studio", 0],
    ["s-b", "Studio", 0],
  ]);
});

test("a project counts every thread removing it would archive: side chats too, but not ones already archived", () => {
  const state = workspace({
    projects: [{ id: "web", root: "/work/web" }],
    threads: [
      task("listed", { projectId: "web" }),
      task("side-chat", { projectId: "web" }),
      task("archived", { projectId: "web", archivedAt: 5 }),
      task("loose"),
    ],
    sideChats: [{ id: "side-chat", sourceThreadId: "listed", error: null }],
  });
  assert.deepEqual(summary(state), [["web", null, 2]]);
});

test("a project opened only to start a thread is not listed, here or on a paired computer", () => {
  const state = withComputers(workspace({
    projects: [{ id: "kept", root: "/work/kept" }, { id: "draft", root: "/work/draft", unlisted: true }],
  }), [paired("linux", "linux-box", workspace({ projects: [{ id: "remote-draft", root: "/linux/draft", unlisted: true }] }))]);
  assert.deepEqual(summary(state), [["kept", null, 0]]);
});

test("the sidebar's computer filter narrows nothing on the Projects page", () => {
  const computers = [paired("linux", "linux-box", workspace({ projects: [{ id: "ml", root: "/linux/ml" }] }))];
  const base = workspace({ projects: [{ id: "web", root: "/work/web" }] });
  for (const filter of ["all", "this", "linux"] as const) {
    assert.deepEqual(summary(withComputers(base, computers, filter)), [["web", null, 0], ["ml", "linux-box", 0]], filter);
  }
  const view = deriveView(withComputers(base, computers, "linux"));
  assert.deepEqual(view.projectSettings.map((row) => row.project.id), ["web", "ml"], "the view carries the unfiltered rows");
});

test("a paired computer that is away still lists what it last sent, marked away", () => {
  const away = paired("studio", "Studio", workspace({ projects: [{ id: "away", root: "/studio/away" }], threads: [task("t", { projectId: "away" })] }), "offline");
  const rows = projectSettingsRows(withComputers(workspace(), [away, { ...paired("blank", "Blank", workspace()), state: null }]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.project.id, "away");
  assert.equal(rows[0]!.threads, 1);
  assert.equal(rows[0]!.host?.offline, true);
});
