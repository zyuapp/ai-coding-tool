import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { act } from "react";
import { renderSettingsPanel } from "../support/settings-panel.mts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";
import type { ProjectSettingsProps } from "../../src/renderer/components/ProjectSettings.tsx";
import type { ProjectSettingsRow } from "../../src/application/project-settings.ts";
import type { ThreadHost } from "../../src/application/computers.ts";

const linux: ThreadHost = { id: "linux", name: "linux-box", offline: false };

function row(id: string, root: string, overrides: { name?: string; host?: ThreadHost; threads?: number } = {}): ProjectSettingsRow {
  return { project: { id, root, ...(overrides.name ? { name: overrides.name } : {}) }, ...(overrides.host ? { host: overrides.host } : {}), threads: overrides.threads ?? 0 };
}

function projectSettings(overrides: Partial<ProjectSettingsProps> = {}): ProjectSettingsProps {
  return { rows: [], error: null, onDismissError() {}, onAdd() {}, onEdit() {}, onRemove() {}, ...overrides };
}

const button = (root: ParentNode, name: string) => item([...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name));

test("Settings lists a Projects page, and choosing it shows the projects", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ projects: projectSettings({ rows: [row("web", "/work/web")] }) }));
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

test("rows are drawn in the order given, with a paired computer's named before its path", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({
    initialSection: "projects",
    projects: projectSettings({
      rows: [row("alpha", "/work/alpha", { name: "Alpha app" }), row("zeta", "/work/zeta"), row("ml", "/linux/ml", { host: linux })],
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
      rows: [row("busy", "/work/busy", { threads: 2 }), row("empty", "/work/empty")],
      onAdd: () => { added.push(1); },
      onEdit: (id) => { edited.push(id); },
      onRemove: (id) => { removed.push(id); },
    }),
  }));
  await act(async () => {});
  const rowNamed = (name: string) => item([...view.container.querySelectorAll<HTMLElement>(".setting-row")].find((candidate) => candidate.querySelector("strong")?.textContent === name));

  await act(async () => { button(view.container, "Add project").click(); });
  assert.deepEqual(added, [1]);

  await act(async () => { query<HTMLButtonElement>(rowNamed("busy"), '[aria-label="Edit busy"]').click(); });
  assert.deepEqual(edited, ["busy"]);

  await act(async () => { query<HTMLButtonElement>(rowNamed("busy"), '[aria-label="Remove busy"]').click(); });
  assert.deepEqual(removed, [], "the first press only asks");
  assert.equal(dom.window.document.activeElement, button(rowNamed("busy"), "Cancel"));
  await act(async () => { button(rowNamed("busy"), "Cancel").click(); });
  assert.deepEqual(removed, []);

  await act(async () => { query<HTMLButtonElement>(rowNamed("busy"), '[aria-label="Remove busy"]').click(); });
  await act(async () => { button(rowNamed("busy"), "Remove and archive 2 threads").click(); });
  assert.deepEqual(removed, ["busy"]);

  await act(async () => { query<HTMLButtonElement>(rowNamed("empty"), '[aria-label="Remove empty"]').click(); });
  await act(async () => { button(rowNamed("empty"), "Remove").click(); });
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

test("a refused removal is said on the page, and Dismiss puts it away", async () => {
  window.desktop = fakeDesktop({});
  let dismissed = 0;
  const view = await mount(renderSettingsPanel({
    initialSection: "projects",
    projects: projectSettings({ rows: [row("web", "/work/web")], error: "Stop the running tasks before removing this project.", onDismissError: () => { dismissed++; } }),
  }));
  await act(async () => {});
  const alert = query(view.container, '.settings-error[role="alert"]');
  assert.match(alert.textContent, /^Stop the running tasks before removing this project\./);
  await act(async () => { button(alert, "Dismiss").click(); });
  assert.equal(dismissed, 1);
  await view.unmount();

  const quiet = await mount(renderSettingsPanel({ initialSection: "projects", projects: projectSettings({ rows: [row("web", "/work/web")] }) }));
  await act(async () => {});
  assert.equal(quiet.container.querySelector(".settings-error"), null, "no error, no alert");
  await quiet.unmount();
});

test("a paired computer's project offers no Edit, and one whose computer is away cannot be removed", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({
    initialSection: "projects",
    projects: projectSettings({
      rows: [row("here", "/work/here"), row("ml", "/linux/ml", { host: linux }), row("away", "/studio/away", { host: { id: "studio", name: "Studio", offline: true } })],
    }),
  }));
  await act(async () => {});
  assert.ok(view.container.querySelector('[aria-label="Edit here"]'), "this computer's project is edited here");
  assert.equal(view.container.querySelector('[aria-label="Edit ml"]'), null, "a paired computer's project is edited on that computer");
  assert.equal(query<HTMLButtonElement>(view.container, '[aria-label="Remove ml"]').disabled, false, "a connected computer's project can be removed");
  assert.equal(query<HTMLButtonElement>(view.container, '[aria-label="Remove away"]').disabled, true, "an away computer's cannot");
  const paths = [...view.container.querySelectorAll(".project-settings-path")].map((path) => path.textContent);
  assert.ok(paths.includes("Studio (offline) · /studio/away"), "the row says why its Remove is out of reach");
  assert.ok(paths.includes("linux-box · /linux/ml"));
  await view.unmount();
});

test("arming Remove takes the row's Edit out of the way, leaving the question and Cancel", async () => {
  const css = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.project-actions:has\(> \.armed\) > :not\(\.armed, \.armed \+ button\)/);
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "projects", projects: projectSettings({ rows: [row("web", "/work/web")] }) }));
  await act(async () => {});
  const actions = query(view.container, ".setting-row-action.project-actions");
  await act(async () => { query<HTMLButtonElement>(actions, '[aria-label="Remove web"]').click(); });
  assert.deepEqual([...actions.children].map((child) => [child.textContent, child.classList.contains("armed")]), [["Edit…", false], ["Remove", true], ["Cancel", false]]);
  await view.unmount();
});
