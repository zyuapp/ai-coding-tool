import assert from "node:assert/strict";
import { test } from "vitest";
import React, { useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { DiffFile, DiffFileSummary } from "../../src/domain/diff.ts";
import type { FindView } from "../../src/application/workspace-state.ts";
import type { FindResults } from "../../src/domain/find.ts";
import type { PanelRow } from "../../src/renderer/diff/panel-rows.ts";
import type { PatchState } from "../../src/renderer/diff/use-patch.ts";

import { mount } from "../support/renderer-dom.mts";

const { useReviewFind } = await import("../../src/renderer/diff/use-review-find.ts");

function summary(path: string): DiffFileSummary {
  return { path, status: "modified", additions: 1, deletions: 0, binary: false };
}

/** One file of one line, which is all a search needs to have somewhere to land. */
function patched(path: string, text: string): DiffFile {
  return {
    path,
    hunks: [{
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      rows: [{ kind: "add", key: `${path}:1`, text, oldLine: null, newLine: 1 }],
    }],
  };
}

const FILES = [summary("src/a.ts"), summary("src/b.ts")];
const PATCHES = new Map<string, PatchState>([
  ["src/a.ts", { status: "available", file: patched("src/a.ts", "az bz") }],
  ["src/b.ts", { status: "available", file: patched("src/b.ts", "zz here") }],
]);
const VERSIONS = new Map(FILES.map((file) => [file.path, `${file.path}|v1`]));

/** The rows the panel would draw, with each open file's name followed by its one line. */
function rowsFor(collapsed: Set<string>): PanelRow[] {
  const rows: PanelRow[] = [];
  for (const file of FILES) {
    rows.push({ kind: "file", key: `f:${file.path}`, path: file.path, file });
    if (collapsed.has(file.path)) continue;
    const patch = PATCHES.get(file.path);
    if (patch?.status !== "available") continue;
    rows.push({ kind: "line", key: `l:${file.path}`, path: file.path, row: patch.file.hunks[0]!.rows[0]!, index: 0 });
  }
  return rows;
}

function find(query: string, index = 0): FindView {
  return { target: { kind: "review", owner: "task-a" }, query, index, focus: 1, matches: 0, counting: false, hit: null };
}

const virtualizer = { scrollToIndex: () => {}, getVirtualItems: () => [] } as unknown as Virtualizer<HTMLDivElement, Element>;

function Review({ view, collapsed, onSetCollapsed, onResults }: {
  view: FindView | null;
  collapsed: string[];
  onSetCollapsed: (path: string, collapsed: boolean) => void;
  onResults: (results: FindResults) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const folded = new Set(collapsed);
  useReviewFind({
    find: view,
    files: FILES,
    versionOf: VERSIONS,
    patchOf: (path) => PATCHES.get(path),
    patches: PATCHES,
    /** Rebuilt on every render, the way the panel rebuilds them whenever anything about it moves. */
    rows: rowsFor(folded),
    collapsed: folded,
    windowed: false,
    virtualizer,
    scrollRef,
    onSetCollapsed,
    onResults,
  });
  return React.createElement("div", { ref: scrollRef });
}

test("folding the file a match is in leaves it folded", async () => {
  const folds: Array<[string, boolean]> = [];
  const props = { view: find("az"), collapsed: [] as string[], onSetCollapsed: (path: string, collapsed: boolean) => folds.push([path, collapsed]), onResults: () => {} };
  const panel = await mount(React.createElement(Review, props));

  assert.deepEqual(folds, [], "the file holding the match is open, so nothing is opened");

  await panel.render(React.createElement(Review, { ...props, collapsed: ["src/a.ts"] }));

  assert.deepEqual(folds, [], "the fold the user put on the file stays on it");
  await panel.unmount();
});

test("stepping onto a match in a folded file opens it", async () => {
  const folds: Array<[string, boolean]> = [];
  const panel = await mount(React.createElement(Review, {
    view: find("az"),
    collapsed: ["src/a.ts"],
    onSetCollapsed: (path: string, collapsed: boolean) => folds.push([path, collapsed]),
    onResults: () => {},
  }));

  assert.deepEqual(folds, [["src/a.ts", false]], "the row a match names only exists once its file is open");
  await panel.unmount();
});

test("a new query is read from its first match, not from where the last one had got to", async () => {
  const reports: FindResults[] = [];
  const props = {
    collapsed: [] as string[],
    onSetCollapsed: () => {},
    onResults: (results: FindResults) => reports.push(results),
  };
  const panel = await mount(React.createElement(Review, { ...props, view: find("zz") }));

  assert.deepEqual(reports, [{ matches: 1 }], "the only match is the one in the last file");

  await panel.render(React.createElement(Review, { ...props, view: find("z") }));

  assert.deepEqual(reports.at(-1), { matches: 4 }, "a shorter needle finds more, and the bar goes back to the first of them");
  await panel.unmount();
});
