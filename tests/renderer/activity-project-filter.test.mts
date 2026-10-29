import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import { task } from "../application/workspace-reducer-fixtures.mts";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar } from "../support/sidebar.mts";

const linux = { id: "linux", name: "linux-box", offline: false };
const projects = [
  { id: "web", root: "/work/web-app" }, { id: "billing", root: "/work/billing-api" },
  { id: "gateway", root: "/work/api-gateway" }, { id: "ml", root: "/linux/ml-pipeline" },
];
const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;

test("the sidebar heading's menu is searched by project or computer name, and Enter picks the top match", async () => {
  const picked: (string | null)[] = [];
  const view = await mount(renderProjectSidebar({
    mode: "activity",
    projects,
    projectHosts: new Map([["ml", linux]]),
    activityThreads: { priority: [task("done", { projectId: "web", outcome: "finished" })], running: [], threads: [], snoozed: [] },
    activityProject: null,
    openMenu: "sidebar:scope",
    onSetActivityProject: (projectId) => picked.push(projectId),
  }));
  try {
    const field = query<HTMLInputElement>(document, ".sidebar-scope-menu .menu-search input");
    const labels = () => [...document.querySelectorAll<HTMLButtonElement>('.sidebar-scope-menu [role="menuitemcheckbox"]')].map((choice) => choice.textContent);
    const type = async (text: string) => act(async () => {
      setValue.call(field, text);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const press = async (target: Element, key: string) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
    assert.equal(field.closest(".sidebar-scroll"), null, "the menu is drawn outside the scrolling list that would crop it");
    assert.equal(document.activeElement, field, "the caret is in the field as the menu opens");
    assert.equal(field.placeholder, "Search projects");
    assert.deepEqual(labels(), ["Activity", "Projects", "All projects", "web-app", "billing-api", "api-gateway", "ml-pipelinelinux-box"]);

    await type("api");
    assert.deepEqual(labels(), ["api-gateway", "billing-api"], "a name that starts with the query comes first");
    assert.equal(document.activeElement, field, "typing keeps the caret");
    await type("linux");
    assert.deepEqual(labels(), ["ml-pipelinelinux-box"], "the computer's name finds its projects");
    await type("nothing here");
    assert.deepEqual(labels(), []);
    assert.equal(query(document, ".sidebar-scope-menu .menu-empty").textContent, "No matches");

    await type("bill");
    await press(field, "ArrowDown");
    assert.equal(document.activeElement?.textContent, "billing-api");
    await press(document.activeElement!, "ArrowUp");
    assert.equal(document.activeElement, field, "up from the first match returns to the field");
    await press(field, "Enter");
    assert.deepEqual(picked, ["billing"]);
  } finally {
    await view.unmount();
  }
});
