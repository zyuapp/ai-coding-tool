import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import type { ComputerFilter } from "../../src/domain/computers.ts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar } from "../support/sidebar.mts";

const linux = { id: "linux", name: "linux-box", offline: false };
const gone = { id: "old", name: "old-laptop", offline: true };

test("rows on a paired computer carry its name, and rows on one that cannot be reached are greyed and take nothing", async () => {
  const selected: string[] = [];
  const here = task("here", { title: "Local work" });
  const there = task("there", { title: "Remote work", projectId: "remote-project" });
  const elsewhere = task("elsewhere", { title: "Unreachable work" });
  const view = await mount(renderProjectSidebar({
    mode: "activity",
    projects: [{ id: "remote-project", root: "/linux/app" }],
    activityThreads: { priority: [], running: [], threads: [here, there, elsewhere] },
    threadHosts: new Map([["there", linux], ["elsewhere", gone]]),
    projectHosts: new Map([["remote-project", linux]]),
    computerLinks: [{ id: "linux", name: "linux-box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1 }],
    onSelectThread: (id) => selected.push(id),
  }));
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".task-row")];
    assert.deepEqual(rows.map((row) => row.querySelector("small")?.textContent), [
      rows[0]!.querySelector("small")!.textContent,
      `linux-box · app · ${rows[1]!.querySelector("small")!.textContent!.split(" · ").at(-1)}`,
      `old-laptop · ${rows[2]!.querySelector("small")!.textContent!.split(" · ").at(-1)}`,
    ]);
    assert.equal(rows[2]!.classList.contains("offline"), true);
    assert.equal(rows[2]!.getAttribute("aria-disabled"), "true");
    await act(async () => { rows[2]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await act(async () => { rows[1]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(selected, ["there"], "only the reachable computer's row selects");
  } finally {
    await view.unmount();
  }
});

test("the switch names every computer and narrows the lists to the one chosen", async () => {
  const filters: ComputerFilter[] = [];
  const view = await mount(renderProjectSidebar({
    computerName: "My Mac",
    computerLinks: [
      { id: "linux", name: "linux-box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1 },
      { id: "old", name: "old-laptop", host: "old.tail.ts.net", status: "offline", error: "Timed out", pairedAt: 1 },
    ],
    computerFilter: "all",
    onSetComputerFilter: (filter) => filters.push(filter),
  }));
  try {
    const choices = [...view.container.querySelectorAll<HTMLButtonElement>(".computer-choice")];
    assert.deepEqual(choices.map((choice) => choice.textContent), ["All", "My Mac", "linux-box", "old-laptop"]);
    assert.equal(choices[0]!.getAttribute("aria-checked"), "true");
    assert.equal(choices[3]!.classList.contains("offline"), true);
    await act(async () => { choices[2]!.click(); });
    await act(async () => { choices[1]!.click(); });
    assert.deepEqual(filters, ["linux", "this"]);
  } finally {
    await view.unmount();
  }
});

test("a sidebar with no paired computer draws no switch", async () => {
  const view = await mount(renderProjectSidebar({}));
  try {
    assert.equal(view.container.querySelector(".computer-switch"), null);
    assert.ok(query(view.container, ".new-task-button"));
  } finally {
    await view.unmount();
  }
});
