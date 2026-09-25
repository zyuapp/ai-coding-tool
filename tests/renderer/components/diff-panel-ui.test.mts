import { dom, mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test, onTestFinished, vi } from "vitest";

import React, { act } from "react";

import type { DiffPanelProps } from "../../../src/renderer/components/DiffPanel.tsx";
import type { DiffState } from "../../../src/application/workspace-state.ts";
import type { Annotation } from "../../../src/domain/conversation.ts";
import type { DesktopAPI } from "../../../src/contracts/ipc.ts";
import type { ThemedToken } from "../../../src/renderer/diff/highlight.ts";

/** Reading a row's colours is what only a row does, so the count is how many rows have drawn. */
const colouring = vi.hoisted(() => ({ reads: 0 }));

vi.mock("../../../src/renderer/diff/highlight.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/renderer/diff/highlight.ts")>();
  return {
    ...actual,
    fileTokens: (file: Parameters<typeof actual.fileTokens>[0]) => {
      const drawn = actual.fileTokens(file);
      const counted = new Proxy(drawn.tokens, {
        get(target, property, receiver) {
          if (property === "get") return (key: string) => { colouring.reads += 1; return target.get(key); };
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Map<string, ThemedToken[]>;
      return { ...drawn, tokens: counted };
    },
  };
});

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

const { DiffPanel } = await import("../../../src/renderer/components/DiffPanel.tsx");

const PATHS = ["src/app.ts", "src/deep/nested/second.ts"];

function diffState(): DiffState {
  return {
    mode: "uncommitted",
    workspaceId: "workspace-1",
    range: { kind: "uncommitted" },
    result: {
      status: "available",
      range: { kind: "uncommitted" },
      ignoreWhitespace: false,
      files: PATHS.map((path) => ({ path, status: "modified" as const, additions: 2, deletions: 1, binary: false })),
      additions: 4,
      deletions: 2,
    },
    loading: false,
    collapsed: [],
    viewed: {},
    split: false,
    ignoreWhitespace: false,
  };
}

function panel(overrides: Partial<DiffPanelProps> = {}): React.ReactElement {
  const props: DiffPanelProps = {
    diff: diffState(),
    workspaceId: "workspace-1",
    onSetRange: () => {},
    onSetMode: () => {},
    onSetCollapsed: () => {},
    onSetViewed: () => {},
    onSetSplit: () => {},
    onSetIgnoreWhitespace: () => {},
    onRefresh: () => {},
    onOpenFile: () => {},
    annotations: [],
    onComment: () => {},
    onEditComment: () => {},
    onRemoveComment: () => {},
    openMenu: null,
    onSetOpenMenu: () => {},
  };
  return React.createElement(DiffPanel, { ...props, ...overrides });
}

/** Names are held back until a patch lands, and the first patch waits on its grammar being imported. */
async function settled(container: HTMLElement) {
  for (let turn = 0; turn < 100 && !container.querySelector(".diff-line"); turn += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

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

test("Viewed keeps a short review's next file visible and it can still be marked", async (t) => {
  const prototype = dom.window.HTMLElement.prototype;
  const offsets = new WeakMap<HTMLElement, number>();
  const geometry: PropertyDescriptorMap = {
    offsetTop: { get(this: HTMLElement) { return Math.max(0, [...(this.parentElement?.children ?? [])].indexOf(this)) * 20; } },
    offsetHeight: { get() { return 20; } },
    clientHeight: { get() { return 480; } },
    scrollHeight: { get(this: HTMLElement) {
      return this.children.length * 20 + 24;
    } },
    scrollTop: {
      get(this: HTMLElement) { return offsets.get(this) ?? 0; },
      set(this: HTMLElement, value: number) { offsets.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
    },
    scrollIntoView: { value(this: HTMLElement) { if (this.parentElement) this.parentElement.scrollTop = this.offsetTop; } },
  };
  for (const [name, descriptor] of Object.entries(geometry)) {
    const original = Object.getOwnPropertyDescriptor(prototype, name);
    Object.defineProperty(prototype, name, { configurable: true, ...descriptor });
    t.onTestFinished(() => {
      if (original) Object.defineProperty(prototype, name, original);
      else Reflect.deleteProperty(prototype, name);
    });
  }

  const marked: string[] = [];
  function Review() {
    const [diff, setDiff] = React.useState(diffState);
    return panel({ diff, onSetViewed(path, viewed) {
      assert.equal(viewed, true, "each click marks a new file");
      marked.push(path);
      setDiff((current) => ({ ...current, viewed: { ...current.viewed, [path]: "viewed" }, collapsed: [...current.collapsed, path] }));
    } });
  }

  const view = await mount(React.createElement(Review));
  onTestFinished(() => view.unmount());
  await settled(view.container);
  const scroller = query(view.container, ".diff-files");
  assert.equal(scroller.scrollTop, 0);
  const tickPinned = () => act(async () => { query<HTMLInputElement>(view.container, ".diff-file-pinned input").click(); });

  await tickPinned();
  const nextHeader = query(scroller, `[aria-label="Mark ${PATHS[1]} viewed"]`).closest(".diff-file-row")?.parentElement;
  assert.ok(nextHeader);
  assert.equal(scroller.scrollTop, 0, "a review that fits stays at the top");
  assert.ok(nextHeader.offsetTop + nextHeader.offsetHeight <= scroller.clientHeight, "the next header remains visible");

  await act(async () => { query<HTMLInputElement>(scroller, `[aria-label="Mark ${PATHS[1]} viewed"]`).click(); });
  assert.deepEqual(marked, PATHS);
  assert.match(query(view.container, ".diff-progress").textContent, /2 of 2 viewed/);
});

test.each([false, true])("a patch opens with line numbers and syntax colours (split=%s)", async (split) => {
  function Review() {
    const [diff, setDiff] = React.useState(() => ({ ...diffState(), split }));
    return panel({ diff, onSetCollapsed(path, collapsed) {
      setDiff((current) => ({ ...current, collapsed: collapsed ? [...current.collapsed, path] : current.collapsed.filter((item) => item !== path) }));
    } });
  }
  const view = await mount(React.createElement(Review));
  onTestFinished(() => view.unmount());
  await settled(view.container);

  if (!split) {
    const lines = [...view.container.querySelectorAll(".diff-line")].slice(0, 5);
    assert.equal(lines[0].className, "diff-line hunk", "the patch is already on screen");
    assert.deepEqual(lines.slice(1).map((line) => [...line.querySelectorAll(".diff-gutter span")].map((cell) => cell.textContent)),
      [["1", "1"], ["2", ""], ["", "2"], ["", "3"]]);
    assert.deepEqual(lines.slice(1).map((line) => line.className.replace("diff-line ", "")), ["context", "delete", "add", "add"]);
  }
  const coloured = [...view.container.querySelectorAll<HTMLElement>(split ? ".diff-split-cell code span" : ".diff-line code span")];
  assert.ok(coloured.length > 0, "the grammar produced tokens");
  assert.ok(coloured.every((token) => token.style.color.startsWith("var(--syntax") || token.style.color.startsWith("var(--code")), "every colour comes from a token");
  assert.ok(coloured.some((token) => token.textContent === "const" && token.style.color === "var(--syntax-keyword)"));
  for (const button of view.container.querySelectorAll<HTMLButtonElement>(".diff-files .diff-file-open")) {
    await act(async () => { button.click(); });
  }
  assert.equal(view.container.querySelectorAll(".diff-line, .diff-split-row").length, 0, "the headers fold the patches away");
});

test("a review already drawn is left alone when the panel is drawn again around it", async () => {
  const diff = diffState();
  /** What the workspace holds still between renders: a review only redraws on its own state moving. */
  const annotations: Annotation[] = [];
  const view = await mount(panel({ diff, annotations }));
  onTestFinished(() => view.unmount());
  await settled(view.container);
  /** Colouring runs a slice at a time, so the review is left to finish before anything is counted. */
  for (let turn = 0; turn < 10; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const drawnRows = colouring.reads;
  assert.ok(drawnRows > 0, "every drawn row reads the colours of its line");
  await view.render(panel({ diff, annotations, openMenu: "diff-range" }));
  assert.equal(colouring.reads, drawnRows, "a panel drawn again over the same review draws none of its rows");
});
