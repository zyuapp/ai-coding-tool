import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../src/application/workspace-reducer.ts";
import { emptyWorkspaceState } from "../src/application/workspace-state.ts";
import { viewPreferences } from "../src/application/view-preferences.ts";
import { DOCK_MIN, panelLayout, sidebarFloats, type PanelRoom } from "../src/domain/panel-widths.ts";

/** A 1512px window with both panels at the widths the app picks, which each case then varies. */
function room(overrides: Partial<PanelRoom> = {}): PanelRoom {
  return { windowWidth: 1512, sidebarOpen: true, dockExpanded: false, sidebarWidth: null, dockWidth: null, ...overrides };
}

test("the panel holds still when the sidebar opens, and the conversation gives up the room", () => {
  const open = panelLayout(room());
  const shut = panelLayout(room({ sidebarOpen: false }));
  assert.equal(open.dock, shut.dock, "a panel at the width the app picks is the same width either way");
  assert.equal(open.sidebar, 280);
});

test("the panel never grows past the room beside the sidebar, so it cannot be pushed off the right edge", () => {
  const wide = room({ sidebarWidth: 420, dockWidth: 1192 });
  const open = panelLayout(wide);
  assert.equal(panelLayout({ ...wide, sidebarOpen: false }).dock, 1192, "with the sidebar away the panel is as wide as it was dragged");
  assert.equal(open.dock, 1512 - 420, "beside the sidebar it gives up exactly what does not fit, and no more");
});

test("a panel that already fits beside the sidebar is left at the width it was dragged to", () => {
  const wide = room({ dockWidth: 1192 });
  assert.equal(panelLayout(wide).dock, 1192, "a 280px sidebar still leaves room for it");
  assert.equal(panelLayout({ ...wide, sidebarOpen: false }).dock, 1192);
});

test("a width dragged while the sidebar was away comes back when the sidebar goes again", () => {
  const dragged = room({ sidebarWidth: 420, dockWidth: 1192 });
  assert.equal(panelLayout({ ...dragged, sidebarOpen: false }).dock, 1192);
  assert.equal(panelLayout(dragged).dock, 1092, "the sidebar takes the room while it is there");
  assert.equal(panelLayout({ ...dragged, sidebarOpen: false }).dock, 1192, "and gives it back when it goes");
});

test("dragging leaves the conversation its room, which is tighter than what may be drawn", () => {
  const tight = panelLayout(room({ windowWidth: 950, sidebarWidth: 475, dockWidth: 900 }));
  assert.equal(tight.dock, 475, "drawn, the panel takes the room beside the sidebar and no more");
  assert.equal(tight.dockLimit, DOCK_MIN, "dragged, it stops at its own minimum rather than swallowing the conversation");
  assert.equal(panelLayout(room()).dockLimit, 1512 - 280 - 320);
});

test("an expanded panel is the same width whether the sidebar is open or not, since the sidebar lies over it", () => {
  const expanded = room({ dockExpanded: true, dockWidth: 1192 });
  const open = panelLayout(expanded);
  assert.equal(open.floating, true);
  assert.equal(open.dock, panelLayout({ ...expanded, sidebarOpen: false }).dock, "nothing under the sidebar moves");
});

test("the sidebar floats in a window too narrow to hold it beside the workspace", () => {
  assert.equal(sidebarFloats(880, false), true);
  assert.equal(sidebarFloats(1512, false), false);
  assert.equal(sidebarFloats(1512, true), true, "an expanded panel floats it at any width");
});

test("the sidebar never takes more than half the window, whatever it was dragged to", () => {
  assert.equal(panelLayout(room({ windowWidth: 1000, sidebarWidth: 900 })).sidebar, 500);
  assert.equal(panelLayout(room({ windowWidth: 1000, sidebarWidth: 100 })).sidebar, 220, "nor less than it can read at");
});

test("both widths are remembered, and a width that is not a number is refused", () => {
  const dragged = reduce(emptyWorkspaceState(), { type: "view.set-sidebar-width", width: 420 });
  assert.equal(dragged.state.sidebarWidth, 420);
  const persisted = dragged.effects.find((effect) => effect.type === "persist-preferences");
  assert.ok(persisted);
  assert.equal(persisted.preferences.sidebarWidth, 420);
  assert.deepEqual(reduce(dragged.state, { type: "view.set-sidebar-width", width: 420 }).effects, [], "an unchanged width writes nothing");

  const panel = reduce(dragged.state, { type: "view.set-dock-width", width: 1192 });
  assert.equal(panel.state.dockWidth, 1192);
  assert.equal(reduce(panel.state, { type: "view.set-dock-width", width: 10 }).state.dockWidth, DOCK_MIN, "a width under the minimum is floored, not refused");
  const refused = reduce(panel.state, { type: "view.set-dock-width", width: Number.NaN });
  assert.equal(refused.state, panel.state);
  assert.deepEqual(refused.effects, []);
});

test("a stored file with no widths in it leaves the app to pick them", () => {
  const preferences = { ...viewPreferences(emptyWorkspaceState()) };
  const restored = reduce(emptyWorkspaceState(), { type: "preferences.loaded", preferences }).state;
  assert.equal(restored.sidebarWidth, null);
  assert.equal(restored.dockWidth, null);
});
