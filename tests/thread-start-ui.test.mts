import assert from "node:assert/strict";
import { test, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { BranchesResult } from "../src/contracts/ipc.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "KeyboardEvent", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
/** jsdom lays nothing out, so a frame is only ever the next turn of the loop. */
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });
/** React watches the focused field through the event methods only IE ever had, which jsdom has not. */
Object.defineProperties(dom.window.HTMLInputElement.prototype, { attachEvent: { value() {} }, detachEvent: { value() {} } });

const branches: BranchesResult = { status: "available", branches: ["main", "fix-loader", "feature-x"], remotes: ["origin/main"], current: "main" };
function fakeDesktop() {
  return { branches: async () => branches } as unknown as typeof window.desktop;
}

afterAll(async () => {
  dom.window.close();
});

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next: React.ReactNode) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function query<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element = root.querySelector<E>(selector);
  assert.ok(element, `Missing ${selector}`);
  return element;
}

function item<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

test("the start options say where a thread begins, and searching narrows the branches", async () => {
  const { ThreadStartOptions } = await import("../src/renderer/components/ThreadStartOptions.tsx");
  window.desktop = fakeDesktop();
  type StartOptionsProps = React.ComponentProps<typeof ThreadStartOptions>;
  const chosen: {
    project: Array<string | undefined>;
    branch: Array<string | null | { name: string | null; create: true }>;
    worktree: boolean[];
  } = { project: [], branch: [], worktree: [] };
  const projects = [{ id: "project-a", root: "/repo/ai-coding-tool" }, { id: "project-b", root: "/repo/just-speak" }];
  const options = (branch: StartOptionsProps["branch"], worktree: boolean) => React.createElement(ThreadStartOptions, {
    projects,
    projectId: "project-a",
    workspaceId: "workspace-a",
    branch,
    worktree,
    onSelectProject: (id) => { chosen.project.push(id); },
    onSelectBranch: (name, create) => { chosen.branch.push(create ? { name, create } : name); },
    onSetWorktree: (on) => { chosen.worktree.push(on); },
  });

  const view = await mount(options(null, false));
  const project = query<HTMLButtonElement>(view.container, 'button[aria-label="Project"]');
  assert.match(project.textContent, /ai-coding-tool/, "the project the thread starts in is filled in already");
  assert.match(query(view.container, 'button[aria-label="Starting branch"]').textContent, /main/, "and so is the branch the checkout is on");
  const worktreeToggle = query<HTMLButtonElement>(view.container, ".thread-start-toggle");
  assert.equal(worktreeToggle.textContent, "Worktree");
  assert.equal(worktreeToggle.getAttribute("aria-pressed"), "false", "a worktree is only ever asked for");
  assert.equal(view.container.querySelector(".thread-mode"), null, "the mode is asked for above these, not among them");

  await act(async () => { project.click(); });
  const projectSearch = query<HTMLInputElement>(view.container, 'input[aria-label="Search projects"]');
  assert.equal(document.activeElement, projectSearch, "the project search takes focus when it opens");
  assert.deepEqual([...view.container.querySelectorAll('[role="option"]')].map((option) => option.textContent), ["ai-coding-tool", "just-speak"]);
  await act(async () => {
    item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set!.call(projectSearch, "speak");
    projectSearch.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
  const projectOptions = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  assert.deepEqual(projectOptions.map((option) => option.textContent), ["just-speak"], "searching narrows the projects");
  await act(async () => { item(projectOptions[0]).click(); });
  assert.deepEqual([...chosen.project], ["project-b"]);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Starting branch"]').click(); });
  assert.ok(view.container.querySelector('input[aria-label="Search branches"]'), "the branch list is searchable");
  const branchOptions = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  assert.deepEqual(branchOptions.map((option) => option.textContent), ["main", "fix-loader", "feature-x"], "every local branch is offered, newest first");
  await act(async () => { item(branchOptions.find((option) => option.textContent === "fix-loader")).click(); });
  assert.deepEqual([...chosen.branch], ["fix-loader"]);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Starting branch"]').click(); });
  const reopened = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  await act(async () => { item(reopened.find((option) => option.textContent === "main")).click(); });
  assert.deepEqual([...chosen.branch], ["fix-loader", null], "the branch the checkout is already on asks for nothing");

  await view.render(options({ name: "fix-loader", create: false }, false));
  const branchTrigger = query<HTMLButtonElement>(view.container, 'button[aria-label="Starting branch"]');
  assert.match(branchTrigger.textContent, /fix-loader/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".thread-start-toggle").click(); });
  assert.deepEqual(chosen.worktree, [true]);

  await act(async () => { branchTrigger.click(); });
  const branchSearch = query<HTMLInputElement>(view.container, 'input[aria-label="Search branches"]');
  assert.equal(document.activeElement, branchSearch, "the branch search takes focus when it opens");
  await act(async () => { branchSearch.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.container.querySelector(".branch-menu"), null, "Escape closes the branch list");
  assert.equal(document.activeElement, branchTrigger, "closing the list returns focus to its trigger");

  await act(async () => { branchTrigger.click(); });
  await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.container.querySelector(".branch-menu"), null, "one outside pointer press closes the branch list");
  assert.equal(document.activeElement, branchTrigger);
  await view.unmount();
});

test("the mode is chat or work, and a chat is left with nothing else to answer", async () => {
  const { ThreadModeSwitch, ThreadStartOptions } = await import("../src/renderer/components/ThreadStartOptions.tsx");
  window.desktop = fakeDesktop();
  const chosen: Array<string | undefined> = [];
  const projects = [{ id: "project-a", root: "/repo/ai-coding-tool" }, { id: "project-b", root: "/repo/just-speak" }];
  const view = await mount(React.createElement(ThreadModeSwitch, { projects, projectId: "project-a", onSelectProject: (id) => { chosen.push(id); } }));

  const modes = () => [...view.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  assert.deepEqual(modes().map((mode) => [mode.textContent, mode.getAttribute("aria-checked")]), [["Chat", "false"], ["Work", "true"]], "a thread in a project is work");
  await act(async () => { item(modes()[1]).click(); });
  assert.deepEqual([...chosen], [], "the mode it is already in asks for nothing");
  await act(async () => { item(modes()[0]).click(); });
  assert.deepEqual([...chosen], [undefined], "turning to chat leaves the project behind");
  chosen.length = 0;

  await view.render(React.createElement(ThreadModeSwitch, { projects, projectId: null, onSelectProject: (id) => { chosen.push(id); } }));
  assert.deepEqual(modes().map((mode) => mode.getAttribute("aria-checked")), ["true", "false"], "a thread with no project is a chat");
  await act(async () => { item(modes()[1]).click(); });
  assert.deepEqual([...chosen], ["project-a"], "turning to work starts the thread in the first project");

  await view.render(React.createElement(ThreadModeSwitch, { projects: [], projectId: null, onSelectProject() {} }));
  assert.equal(view.container.querySelector(".thread-mode"), null, "with nowhere to work there is no mode to choose");

  await view.render(React.createElement(ThreadStartOptions, {
    projects,
    projectId: null,
    branch: null,
    worktree: false,
    onSelectProject() {},
    onSelectBranch() {},
    onSetWorktree() {},
  }));
  assert.equal(view.container.querySelector(".thread-start"), null, "a chat has no project, branch, or checkout to answer for");
  await view.unmount();
});

test("a branch the repository does not have is offered as one to create", async () => {
  const { ThreadStartOptions } = await import("../src/renderer/components/ThreadStartOptions.tsx");
  window.desktop = fakeDesktop();
  type StartOptionsProps = React.ComponentProps<typeof ThreadStartOptions>;
  const chosen: Array<{ name: string | null; create: boolean | undefined }> = [];
  const options = (branch: StartOptionsProps["branch"]) => React.createElement(ThreadStartOptions, {
    projects: [{ id: "project-a", root: "/repo/ai-coding-tool" }],
    projectId: "project-a",
    workspaceId: "workspace-a",
    branch,
    worktree: false,
    onSelectProject() {},
    onSelectBranch: (name, create) => { chosen.push({ name, create }); },
    onSetWorktree() {},
  });

  const view = await mount(options(null));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Starting branch"]').click(); });
  const search = query<HTMLInputElement>(view.container, 'input[aria-label="Search branches"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  const type = async (text: string) => {
    await act(async () => {
      item(setValue).call(search, text);
      search.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    });
  };

  await type("main");
  assert.equal(
    [...view.container.querySelectorAll('[role="option"]')].some((option) => /Create branch/.test(option.textContent)),
    false,
    "a name the repository already has is a branch to pick, not one to make",
  );

  await type("loader-fix");
  const creating = item([...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => /Create branch/.test(option.textContent)));
  assert.match(creating.textContent, /loader-fix/);
  await act(async () => { creating.click(); });
  assert.deepEqual(chosen, [{ name: "loader-fix", create: true }]);

  await view.render(options({ name: "loader-fix", create: true }));
  const trigger = query<HTMLButtonElement>(view.container, 'button[aria-label="Starting branch"]');
  assert.match(trigger.textContent, /loader-fix/);
  assert.match(trigger.textContent, /new/, "a branch yet to exist says so");
  await view.unmount();
});

test("a project search keeps what the query names, by name and by path", async () => {
  const { matchProjects } = await import("../src/renderer/components/ThreadStartOptions.tsx");
  const projects = [
    { id: "a", root: "/repo/ai-coding-tool" },
    { id: "b", root: "/repo/just-speak", name: "Speaker" },
  ];

  assert.deepEqual(matchProjects(projects, ""), projects);
  assert.deepEqual(matchProjects(projects, "   "), projects, "an empty search is not a filter");
  assert.deepEqual(matchProjects(projects, "SPEAK").map((project) => project.id), ["b"], "case never decides a match");
  assert.deepEqual(matchProjects(projects, "just").map((project) => project.id), ["b"], "the path is matched as well as the name");
  assert.deepEqual(matchProjects(projects, "nope"), []);
});

test("a branch search keeps what the query names, and everything when it is empty", async () => {
  const { matchBranches, newBranchName } = await import("../src/renderer/components/BranchMenu.tsx");
  const branches = ["main", "fix-loader", "feature-x", "Fix-Encoding"];

  assert.deepEqual(matchBranches(branches, ""), branches);
  assert.deepEqual(matchBranches(branches, "   "), branches, "an empty search is not a filter");
  assert.deepEqual(matchBranches(branches, "fix"), ["fix-loader", "Fix-Encoding"], "case never decides a match");
  assert.deepEqual(matchBranches(branches, "load"), ["fix-loader"], "a fragment anywhere in the name is enough");
  assert.deepEqual(matchBranches(branches, "nope"), []);

  assert.equal(newBranchName(branches, "nope"), "nope");
  assert.equal(newBranchName(branches, "  spaced  "), "spaced", "a name is what the query says, trimmed");
  assert.equal(newBranchName(branches, "main"), null, "a branch that exists is picked rather than made");
  assert.equal(newBranchName(branches, "   "), null);
});
