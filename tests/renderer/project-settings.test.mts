import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import { renderSettingsPanel } from "../support/settings-panel.mts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";
import type { ProjectSettingsProps } from "../../src/renderer/components/ProjectSettings.tsx";

const linux = { id: "linux", name: "linux-box", offline: false };

function projectSettings(overrides: Partial<ProjectSettingsProps> = {}): ProjectSettingsProps {
  return { projects: [], projectHosts: new Map(), threads: [], onAdd() {}, onEdit() {}, onRemove() {}, ...overrides };
}

const button = (root: ParentNode, name: string) => item([...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name));

test("Settings lists a Projects page, and choosing it shows the projects", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ projects: projectSettings({ projects: [{ id: "web", root: "/work/web" }] }) }));
  await act(async () => {});
  const nav = query(view.container, 'nav[aria-label="Settings sections"]');
  const page = button(nav, "Projects");
  await act(async () => { page.click(); });
  assert.equal(page.getAttribute("aria-current"), "page");
  assert.equal(query(view.container, "#projects-heading").textContent, "1 project");
  assert.equal(query(view.container, ".settings-page-heading h2").textContent, "Projects");
  assert.deepEqual([...view.container.querySelectorAll(".settings-group .setting-row strong")].map((title) => title.textContent), ["web"]);
  await view.unmount();
});

test("projects are listed this computer's first, then by name, with a paired computer's named before its path", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({
    initialSection: "projects",
    projects: projectSettings({
      projects: [
        { id: "ml", root: "/linux/ml" },
        { id: "zeta", root: "/work/zeta" },
        { id: "alpha", root: "/work/alpha", name: "Alpha app" },
      ],
      projectHosts: new Map([["ml", linux]]),
    }),
  }));
  await act(async () => {});
  const rows = [...view.container.querySelectorAll(".settings-group .setting-row")];
  assert.deepEqual(rows.map((row) => row.querySelector("strong")?.textContent), ["Alpha app", "zeta", "ml"]);
  assert.deepEqual(rows.map((row) => row.querySelector("p")?.textContent), ["/work/alpha", "/work/zeta", "linux-box · /linux/ml"]);
  assert.equal(query(view.container, "#projects-heading").textContent, "3 projects");
  await view.unmount();
});

test("a project's row edits it, and removing asks first, naming the threads it archives", async () => {
  window.desktop = fakeDesktop({});
  const added: number[] = [];
  const edited: string[] = [];
  const removed: string[] = [];
  const view = await mount(renderSettingsPanel({
    initialSection: "projects",
    projects: projectSettings({
      projects: [{ id: "busy", root: "/work/busy" }, { id: "empty", root: "/work/empty" }],
      threads: [task("one", { projectId: "busy" }), task("two", { projectId: "busy" }), task("loose")],
      onAdd: () => { added.push(1); },
      onEdit: (id) => { edited.push(id); },
      onRemove: (id) => { removed.push(id); },
    }),
  }));
  await act(async () => {});
  const row = (name: string) => item([...view.container.querySelectorAll<HTMLElement>(".setting-row")].find((candidate) => candidate.querySelector("strong")?.textContent === name));

  await act(async () => { button(view.container, "Add project").click(); });
  assert.deepEqual(added, [1]);

  await act(async () => { query<HTMLButtonElement>(row("busy"), '[aria-label="Edit busy"]').click(); });
  assert.deepEqual(edited, ["busy"]);

  await act(async () => { query<HTMLButtonElement>(row("busy"), '[aria-label="Remove busy"]').click(); });
  assert.deepEqual(removed, [], "the first press only asks");
  assert.equal(dom.window.document.activeElement, button(row("busy"), "Cancel"));
  await act(async () => { button(row("busy"), "Cancel").click(); });
  assert.deepEqual(removed, []);

  await act(async () => { query<HTMLButtonElement>(row("busy"), '[aria-label="Remove busy"]').click(); });
  await act(async () => { button(row("busy"), "Remove and archive 2 threads").click(); });
  assert.deepEqual(removed, ["busy"]);

  await act(async () => { query<HTMLButtonElement>(row("empty"), '[aria-label="Remove empty"]').click(); });
  await act(async () => { button(row("empty"), "Remove").click(); });
  assert.deepEqual(removed, ["busy", "empty"], "a project with no threads is removed with a plain confirm");
  await view.unmount();
});

test("with no projects, the page says so and still offers adding one", async () => {
  window.desktop = fakeDesktop({});
  let added = 0;
  const view = await mount(renderSettingsPanel({ initialSection: "projects", projects: projectSettings({ onAdd: () => { added++; } }) }));
  await act(async () => {});
  assert.equal(query(view.container, ".settings-empty").textContent, "No projects yet.");
  await act(async () => { button(view.container, "Add project").click(); });
  assert.equal(added, 1);
  await view.unmount();
});
