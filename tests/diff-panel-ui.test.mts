import assert from "node:assert/strict";
import { test, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { DiffPanelProps } from "../src/renderer/components/DiffPanel.tsx";
import type { DiffState } from "../src/application/workspace-state.ts";
import type { DesktopAPI } from "../src/contracts/ipc.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "KeyboardEvent", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
/** jsdom has no ResizeObserver, and the panel measures its own width through one. */
class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

/** Named as the file it is, because a patch's own path is what picks the grammar that colours it. */
const PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const first = 1;",
  "-const second = 2;",
  "+const second = 22;",
  "+const third = 3;",
  "",
].join("\n");

Object.defineProperty(window, "desktop", { value: {
  diffPatch: async () => ({ status: "available", patch: PATCH } as const),
  branches: async () => ({ status: "error", message: "unavailable" } as const),
} satisfies Pick<DesktopAPI, "diffPatch" | "branches"> });

const { DiffPanel } = await import("../src/renderer/components/DiffPanel.tsx");

afterAll(() => { dom.window.close(); });

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function query<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element = root.querySelector<E>(selector);
  assert.ok(element, `Missing ${selector}`);
  return element;
}

const PATHS = ["src/app.ts", "src/deep/nested/second.ts"];

function diffState(): DiffState {
  return {
    workspaceId: "workspace-1",
    range: { kind: "uncommitted" },
    result: {
      status: "available",
      range: { kind: "uncommitted" },
      files: PATHS.map((path) => ({ path, status: "modified" as const, additions: 2, deletions: 1, binary: false })),
      additions: 4,
      deletions: 2,
    },
    loading: false,
    collapsed: [],
    viewed: {},
    split: false,
  };
}

function panel(): React.ReactElement {
  const props: DiffPanelProps = {
    diff: diffState(),
    workspaceId: "workspace-1",
    onSetRange: () => {},
    onSetCollapsed: () => {},
    onSetViewed: () => {},
    onSetSplit: () => {},
    onRefresh: () => {},
    onOpenFile: () => {},
    annotations: [],
    onComment: () => {},
    onEditComment: () => {},
    onRemoveComment: () => {},
    openMenu: null,
    onSetOpenMenu: () => {},
  };
  return React.createElement(DiffPanel, props);
}

/** Names are held back until a patch lands, and the first patch waits on its grammar being imported. */
async function settled(container: HTMLElement) {
  for (let turn = 0; turn < 100 && !container.querySelector(".diff-line"); turn += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

test("lines are coloured once they are drawn, not when their patch arrives", async () => {
  const view = await mount(panel());
  await settled(view.container);

  const coloured = () => [...view.container.querySelectorAll(".diff-line code")].filter((code) => code.querySelector("span")).length;
  assert.ok(coloured() > 0, "the rows on screen carry colour");
  await view.unmount();
});

test("the row of the file being read is held at the top of the review", async () => {
  const view = await mount(panel());
  await settled(view.container);

  const scroller = query(view.container, ".diff-files");
  const rows = [...scroller.children];
  rows.forEach((row, index) => Object.defineProperty(row, "offsetTop", { configurable: true, value: index * 20 }));
  const pinnedName = () => view.container.querySelector(".diff-file-pinned .diff-file-name")?.textContent;

  const scrollTo = async (offset: number) => {
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: offset });
    await act(async () => { scroller.dispatchEvent(new window.Event("scroll")); });
  };

  await scrollTo(0);
  assert.equal(pinnedName(), "src/app.ts", "the first file names itself before anything has scrolled");
  await scrollTo(20 * (rows.length - 1));
  assert.equal(pinnedName(), "src/deep/nested/second.ts", "reading into the second file swaps the row over");
  await view.unmount();
});

test("the row held at the top echoes the one in the list rather than doubling it", async () => {
  const view = await mount(panel());
  await settled(view.container);

  const names = [...view.container.querySelectorAll(".diff-file-name")].map((name) => name.textContent);
  assert.deepEqual(names.slice(0, PATHS.length), PATHS, "the list leads, so a lookup by name reaches it");

  const pinned = query(view.container, ".diff-file-pinned");
  assert.equal(pinned.getAttribute("aria-hidden"), "true");
  assert.deepEqual(
    [...pinned.querySelectorAll("button, input")].map((control) => control.getAttribute("tabindex")),
    ["-1", "-1", "-1"],
    "so nothing in the echo is reachable twice",
  );
  await view.unmount();
});
