import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { workspace, preferences, effectAt, run, running } from "./workspace-reducer-fixtures.mts";
import { OPEN_SUBAGENT_GROUPS, type SubagentGroup } from "../../src/domain/run.ts";
import { OPEN_SIDEBAR_SECTIONS, type SidebarSection } from "../../src/domain/sidebar.ts";

test("the panel and sidebar choices are persisted and survive the store loading", () => {
  const restored = run(workspace(), [{ type: "preferences.loaded", preferences: preferences({ sessionPanelOpen: true, sidebarOpen: false, sidebarMode: "projects" }) }]);
  assert.equal(restored.sessionPanelOpen, true);
  assert.equal(restored.sidebarOpen, false);

  const closed = reduce(restored, { type: "view.set-session-panel-open", open: false });
  assert.deepEqual(closed.effects, [{ type: "persist-preferences", preferences: { theme: "aicodingtool-dark", themeMode: "dark", uiFont: "system", monoFont: "system", readingSize: 15, terminalSize: 12, sessionPanelOpen: false, captureSound: true, captureFocus: true, plainEnglish: false, chromeBrowser: false, computerUse: true, browserTools: true, notifications: true, sidebarOpen: false, sidebarMode: "projects", sections: OPEN_SIDEBAR_SECTIONS, subagentGroups: OPEN_SUBAGENT_GROUPS, shortcuts: {}, browserTabs: {}, browserOrigins: [] } }]);
  assert.equal(closed.state.sessionPanelOpen, false);

  assert.deepEqual(reduce(closed.state, { type: "view.set-session-panel-open", open: false }).effects, [], "an unchanged choice writes nothing");
  assert.deepEqual(reduce(closed.state, { type: "view.set-sidebar-open", open: false }).effects, [], "and so does an unchanged sidebar");
  assert.equal(reduce(closed.state, { type: "view.set-sidebar-open", open: true }).state.sidebarOpen, true);

  const loaded = reduce(restored, { type: "store.loaded", data: { version: 2, tasks: [], projects: [], worktrees: [], lastFolder: null } });
  assert.equal(loaded.state.sessionPanelOpen, true);
  assert.equal(loaded.state.sidebarOpen, false);
});

test("the palette and the ground move on their own axes, and only the ground is remembered as a mode", () => {
  const state = workspace();
  assert.equal(state.theme, "aicodingtool-dark");
  assert.equal(state.themeMode, "dark");

  const palette = reduce(state, { type: "view.set-theme-family", family: "Gruvbox", systemDark: true });
  assert.equal(palette.state.theme, "gruvbox-dark", "a palette keeps the ground it was picked on");
  assert.equal(palette.state.themeMode, "dark");
  assert.deepEqual(reduce(palette.state, { type: "view.set-theme-family", family: "Gruvbox", systemDark: true }).effects, [], "an unchanged palette writes nothing");
  assert.deepEqual(reduce(palette.state, { type: "view.set-theme-family", family: "A Palette We Dropped", systemDark: true }).effects, [], "and a palette the app does not ship is ignored");

  const light = reduce(palette.state, { type: "view.set-theme-mode", mode: "light", systemDark: true });
  assert.equal(light.state.theme, "gruvbox-light", "a ground moves within the palette rather than replacing it");
  assert.equal(light.state.themeMode, "light");
  assert.equal(effectAt(light, "persist-preferences").preferences.themeMode, "light");
});

test("a window set to auto follows the system, and one set to a ground of its own ignores it", () => {
  const auto = reduce(workspace(), { type: "view.set-theme-mode", mode: "auto", systemDark: false });
  assert.equal(auto.state.themeMode, "auto");
  assert.equal(auto.state.theme, "aicodingtool-light");

  const darkened = reduce(auto.state, { type: "view.system-scheme", dark: true });
  assert.equal(darkened.state.theme, "aicodingtool-dark");
  assert.deepEqual(darkened.effects, [], "the system's own choice is not the user's, so it is not written down");
  assert.deepEqual(reduce(darkened.state, { type: "view.system-scheme", dark: true }).effects, []);

  const fixed = reduce(darkened.state, { type: "view.set-theme-mode", mode: "light", systemDark: true });
  assert.equal(fixed.state.theme, "aicodingtool-light");
  assert.equal(reduce(fixed.state, { type: "view.system-scheme", dark: true }).state.theme, "aicodingtool-light", "a ground of its own outranks the system's");
});

test("naming a theme outright names the ground it paints on, so the two axes never disagree", () => {
  const named = reduce(workspace(), { type: "view.set-theme", theme: "tokyo-night-day" });
  assert.equal(named.state.theme, "tokyo-night-day");
  assert.equal(named.state.themeMode, "light");
  assert.deepEqual(reduce(named.state, { type: "view.set-theme", theme: "a-theme-we-dropped" }).effects, []);
});

test("a size is px within the range it is for, and anything outside it is refused", () => {
  const bigger = reduce(workspace(), { type: "view.set-reading-size", size: 19 });
  assert.equal(bigger.state.readingSize, 19);
  assert.equal(effectAt(bigger, "persist-preferences").preferences.readingSize, 19);
  assert.deepEqual(reduce(bigger.state, { type: "view.set-reading-size", size: 19 }).effects, [], "an unchanged size writes nothing");
  assert.deepEqual(reduce(bigger.state, { type: "view.set-reading-size", size: 400 }).effects, []);
  assert.equal(reduce(bigger.state, { type: "view.set-reading-size", size: 400 }).state.readingSize, 19);
  assert.deepEqual(reduce(bigger.state, { type: "view.set-terminal-size", size: 2 }).effects, []);
});

test("the sidebar's shape and its folded lists outlive the window", () => {
  const state = workspace();
  assert.equal(state.sidebarMode, "projects");

  const ranked = reduce(state, { type: "view.set-sidebar-mode", mode: "activity" });
  assert.equal(ranked.state.sidebarMode, "activity");
  assert.equal(effectAt(ranked, "persist-preferences").preferences.sidebarMode, "activity");
  assert.deepEqual(reduce(ranked.state, { type: "view.set-sidebar-mode", mode: "activity" }).effects, [], "an unchanged shape writes nothing");

  const folded = reduce(ranked.state, { type: "view.set-section-open", section: "priority", open: false });
  assert.equal(folded.state.sections.priority, false);
  assert.equal(folded.state.sections.running, true, "folding one list leaves the others alone");
  assert.equal(effectAt(folded, "persist-preferences").preferences.sections.priority, false);

  assert.deepEqual(reduce(folded.state, { type: "view.set-section-open", section: "priority", open: false }).effects, [], "an unchanged list writes nothing");
  const unknown = reduce(folded.state, { type: "view.set-section-open", section: "nowhere" as SidebarSection, open: false });
  assert.deepEqual(unknown.state.sections, folded.state.sections);
  assert.deepEqual(unknown.effects, []);
});

test("a folded subagent group is written down, and an unknown group is refused", () => {
  const folded = reduce(workspace(), { type: "view.set-subagent-group", group: "completed", open: false });
  assert.equal(folded.state.subagentGroups.completed, false);
  assert.equal(folded.state.subagentGroups.working, true, "folding one group leaves the others alone");
  assert.equal(effectAt(folded, "persist-preferences").preferences.subagentGroups.completed, false);

  assert.deepEqual(reduce(folded.state, { type: "view.set-subagent-group", group: "completed", open: false }).effects, [], "an unchanged group writes nothing");
  const unknown = reduce(folded.state, { type: "view.set-subagent-group", group: "nowhere" as SubagentGroup, open: false });
  assert.deepEqual(unknown.state.subagentGroups, folded.state.subagentGroups);
  assert.deepEqual(unknown.effects, []);
});
