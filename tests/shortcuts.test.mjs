import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopAccelerator,
  displayShortcut,
  formatShortcut,
  keystrokeOf,
  parseShortcut,
  FIXED_SHORTCUTS,
  resolveShortcuts,
  SHORTCUT_ACTIONS,
  shortcutFor,
  shortcutProblem,
  shortcutSettings,
  withShortcut,
} from "../dist/main/domain/shortcuts.js";
import { reduce, shortcutCommands } from "../dist/main/application/workspace-reducer.js";
import { deriveView, dockFor, dockOwner, emptyWorkspaceState } from "../dist/main/application/workspace-state.js";

function input(code, { key = "", meta = false, control = false, alt = false, shift = false } = {}) {
  return { key, code, meta, control, alt, shift };
}

function workspace(overrides = {}) {
  return { ...emptyWorkspaceState(), ...overrides };
}

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

function run(state, inputs) {
  return inputs.reduce((current, next) => reduce(current, next).state, state);
}

test("a keystroke is read from the physical key, so a layout cannot change what it means", () => {
  assert.deepEqual(
    keystrokeOf(input("KeyN", { key: "˜", meta: true, alt: true }), true),
    { key: "N", mod: true, ctrl: false, alt: true, shift: false },
    "⌥ turns N into a dead key on macOS, and the binding is still N",
  );
  assert.equal(formatShortcut(keystrokeOf(input("Comma", { key: ",", meta: true }), true)), "Mod+,");
  assert.equal(formatShortcut(keystrokeOf(input("Digit1", { key: "1", meta: true }), true)), "Mod+1");
  assert.equal(formatShortcut(keystrokeOf(input("ArrowLeft", { key: "ArrowLeft", meta: true, alt: true }), true)), "Mod+Alt+ArrowLeft");

  assert.equal(keystrokeOf(input("KeyB", { control: true }), true).mod, false, "on macOS the command key is ⌘");
  assert.equal(keystrokeOf(input("KeyB", { control: true }), false).mod, true, "and Ctrl everywhere else");

  assert.equal(keystrokeOf(input("MetaLeft", { key: "Meta", meta: true }), true), null, "a modifier on its own is no keystroke");
});

test("a binding survives being written down and read back", () => {
  for (const action of SHORTCUT_ACTIONS) {
    const stroke = parseShortcut(action.defaultBinding);
    assert.ok(stroke, `${action.id} has a readable default`);
    assert.equal(formatShortcut(stroke), action.defaultBinding, `${action.id} is written the way it parses`);
    assert.equal(shortcutProblem(action.defaultBinding), null, `${action.id} is bindable`);
  }
  assert.equal(parseShortcut("Mod+Mod+N"), null);
  assert.equal(parseShortcut("Meta+N"), null);
  assert.equal(parseShortcut(""), null);
  assert.equal(parseShortcut(42), null);
});

test("a shortcut has to carry a modifier, and cannot take what the desktop keeps", () => {
  assert.ok(shortcutProblem("N"), "a bare key would swallow typing");
  assert.ok(shortcutProblem("Shift+N"), "and so would a shifted one");
  assert.equal(shortcutProblem("Alt+N"), null);
  assert.ok(shortcutProblem("Mod+Q"), "quitting stays the desktop's");
  assert.equal(shortcutProblem("Mod+Shift+Q"), null, "only ⌘Q itself is spoken for");
  assert.ok(shortcutProblem("Mod+Tab"), "and so does switching windows");
});

test("a keystroke belongs to one action, so binding it takes it from whoever held it", () => {
  const stolen = withShortcut({}, "run.allow", "Mod+Shift+D");
  assert.deepEqual(stolen, { "run.allow": "Mod+Shift+D", "run.deny": null }, "⇧⌘D left the answer it used to give");

  const settings = shortcutSettings(stolen);
  assert.equal(settings.find((setting) => setting.id === "run.deny").binding, null);
  assert.equal(settings.find((setting) => setting.id === "run.deny").changed, true);

  const restored = withShortcut(stolen, "run.allow", "Mod+Shift+A");
  assert.deepEqual(restored, { "run.deny": null }, "a binding back at its default is no longer worth storing");
  assert.deepEqual(withShortcut(restored, "run.deny", "Mod+Shift+D"), {}, "and neither is the one that took it back");
});

test("the keystrokes the app answers on its own are not on offer", () => {
  assert.equal(SHORTCUT_ACTIONS.some((action) => FIXED_SHORTCUTS.some((fixed) => fixed.action === action.id)), false);
  assert.ok(shortcutProblem("Mod+F"), "finding is the app's own");
  assert.ok(shortcutProblem("Mod+1"), "and so is the first panel tab");
});

test("only bound, unclaimed keystrokes reach the matcher", () => {
  const bindings = resolveShortcuts({ "run.allow": null });
  assert.equal(bindings.some((binding) => binding.action === "run.allow"), false);

  assert.equal(shortcutFor(bindings, parseShortcut("Mod+W"), "any").action, "tab.close");
  assert.equal(shortcutFor(bindings, parseShortcut("Mod+R"), "any"), undefined, "reloading is a page's keystroke");
  assert.equal(shortcutFor(bindings, parseShortcut("Mod+R"), "browser").action, "page.reload");
  assert.equal(shortcutFor(bindings, parseShortcut("Mod+W"), "browser").action, "tab.close", "the rest work inside a page too");

  const shared = resolveShortcuts({ "run.deny": "Mod+W" });
  assert.deepEqual(shared.filter((binding) => binding.binding === "Mod+W").map((binding) => binding.action), ["tab.close"], "a fixed keystroke is not one an override can take");
});

test("a keystroke means whatever the user could have clicked", () => {
  const state = workspace({ tasks: [task("a"), task("b")], currentId: "a", draftProjectId: null });
  assert.deepEqual(shortcutCommands(state, "dock.tab-3", "any"), [{ type: "view.select-dock-index", index: 2 }]);
  assert.deepEqual(shortcutCommands(state, "dock.tab-last", "any"), [{ type: "view.select-dock-index", index: -1 }]);
  assert.deepEqual(shortcutCommands(state, "nav.back", "any"), [{ type: "view.go-back" }]);
  assert.deepEqual(shortcutCommands(state, "nav.back", "browser"), [{ type: "browser.go", delta: -1 }], "inside a page, back is the page's own");
  assert.deepEqual(shortcutCommands(state, "sidebar.toggle", "any"), [{ type: "view.set-sidebar-open", open: false }]);
  assert.deepEqual(shortcutCommands(state, "settings.toggle", "any"), [{ type: "view.set-settings-open", open: true }]);
  assert.deepEqual(shortcutCommands(state, "thread.new-worktree", "any"), [{ type: "task.new" }, { type: "task.set-worktree", worktree: true }]);
  assert.deepEqual(shortcutCommands(state, "nothing.at.all", "any"), [], "an action the app does not have asks for nothing");

  const inProject = workspace({ tasks: [task("a", { projectId: "p1" })], currentId: "a" });
  assert.deepEqual(shortcutCommands(inProject, "thread.new", "any"), [{ type: "task.new", projectId: "p1" }], "a new thread starts where the last one was");
});

test("going back with a keystroke moves the cursor rather than recording a visit", () => {
  const state = run(workspace({ tasks: [task("a"), task("b")] }), [
    { type: "task.select", taskId: "a" },
    { type: "task.select", taskId: "b" },
    { type: "view.shortcut", action: "nav.back", surface: "any" },
  ]);
  assert.equal(state.currentId, "a");
  assert.deepEqual(state.history, ["a", "b"], "the trail ahead survives");
  assert.equal(reduce(state, { type: "view.shortcut", action: "nav.forward", surface: "any" }).state.currentId, "b");
});

test("a keystroke that moves the user somewhere leaves the settings sheet behind", () => {
  const state = workspace({ tasks: [task("a"), task("b")], currentId: "a", settingsOpen: true, history: ["a"], historyIndex: 0 });

  const started = reduce(state, { type: "view.shortcut", action: "thread.new", surface: "any" });
  assert.equal(started.state.settingsOpen, false, "a new thread is not started behind the sheet");
  assert.equal(started.state.currentId, null);

  const back = reduce(state, { type: "view.shortcut", action: "nav.back", surface: "any" });
  assert.equal(back.state.settingsOpen, false, "the thread behind the sheet is not read through it");

  const cancelled = reduce(state, { type: "view.shortcut", action: "run.cancel", surface: "any" });
  assert.equal(cancelled.state.settingsOpen, true, "stopping a run is not moving anywhere");
});

test("a new tab answers with whatever the panel is showing", () => {
  const state = workspace({ tasks: [task("a", { projectId: "p1" })], currentId: "a", projects: [{ id: "p1", root: "/repo" }] });
  const shell = reduce(state, { type: "view.shortcut", action: "tab.new", surface: "any" });
  assert.deepEqual(shell.effects.map((effect) => effect.type), ["terminal.start", "focus-window"], "with no page in front, a shell, and the keyboard with it");

  const page = run(state, [{ type: "browser.new-tab" }]);
  const second = reduce(page, { type: "view.shortcut", action: "tab.new", surface: "any" });
  assert.equal(dockFor(second.state, dockOwner(second.state)).browserTabs.length, 2, "over a page, another page");

  const closed = reduce(workspace({ settingsOpen: true }), { type: "view.shortcut", action: "tab.new", surface: "any" });
  assert.deepEqual(closed.effects, [], "settings have no tabs to add to");
});

test("a numbered keystroke shows the tab in that position", () => {
  const state = run(workspace({ tasks: [task("a")], currentId: "a" }), [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "view.open-dock-panel", panel: "automation" },
  ]);
  assert.equal(dockFor(state, "a").tab, "automation");
  assert.equal(dockFor(reduce(state, { type: "view.shortcut", action: "dock.tab-1", surface: "any" }).state, "a").tab, "agents");
  assert.equal(dockFor(reduce(state, { type: "view.shortcut", action: "dock.tab-last", surface: "any" }).state, "a").tab, "automation");
  assert.equal(dockFor(reduce(state, { type: "view.shortcut", action: "dock.tab-8", surface: "any" }).state, "a").tab, "automation", "a position with no tab in it does nothing");
});

test("changing a binding persists it, hands it to the window, and stops the capture", () => {
  const capturing = reduce(workspace({ settingsOpen: true }), { type: "view.capture-shortcut", action: "run.allow" });
  assert.equal(capturing.state.capturingShortcut, "run.allow");
  assert.deepEqual(capturing.effects, [{ type: "capture-shortcut", capturing: true }]);

  const bound = reduce(capturing.state, { type: "shortcut.captured", binding: "Mod+Shift+K" });
  assert.equal(bound.state.capturingShortcut, null);
  assert.deepEqual(bound.state.shortcuts, { "run.allow": "Mod+Shift+K" });
  assert.deepEqual(bound.effects.map((effect) => effect.type), ["persist-preferences", "apply-shortcuts", "capture-shortcut"]);
  assert.deepEqual(bound.effects.at(-1), { type: "capture-shortcut", capturing: false });
  assert.equal(deriveView(bound.state).shortcuts.find((setting) => setting.id === "run.allow").binding, "Mod+Shift+K");

  const refused = reduce(capturing.state, { type: "shortcut.captured", binding: "Mod+Q" });
  assert.deepEqual(refused.state.shortcuts, {}, "a keystroke the desktop keeps is not taken");
  assert.ok(refused.state.actionError);
  assert.equal(refused.state.capturingShortcut, null);

  const cancelled = reduce(capturing.state, { type: "shortcut.captured", binding: null });
  assert.equal(cancelled.state.capturingShortcut, null);
  assert.deepEqual(cancelled.effects, [{ type: "capture-shortcut", capturing: false }]);

  const reset = reduce(bound.state, { type: "view.reset-shortcuts" });
  assert.deepEqual(reset.state.shortcuts, {});
  assert.deepEqual(reset.effects.map((effect) => effect.type), ["persist-preferences", "apply-shortcuts"]);

  assert.deepEqual(reduce(bound.state, { type: "shortcut.captured", binding: "Mod+J" }).effects, [], "a keystroke nobody asked for is ignored");
});

test("settings that go stop waiting for a keystroke", () => {
  const capturing = reduce(workspace({ settingsOpen: true }), { type: "view.capture-shortcut", action: "run.allow" }).state;

  const closed = reduce(capturing, { type: "view.set-settings-open", open: false });
  assert.equal(closed.state.capturingShortcut, null);
  assert.deepEqual(closed.effects, [{ type: "capture-shortcut", capturing: false }]);

  const blurred = reduce(capturing, { type: "view.set-focused", focused: false });
  assert.equal(blurred.state.capturingShortcut, null);
  assert.deepEqual(blurred.effects, [{ type: "capture-shortcut", capturing: false }]);
});

test("a binding reads the way the platform writes it", () => {
  assert.equal(displayShortcut("Mod+Shift+N", true), "⇧⌘N");
  assert.equal(displayShortcut("Mod+Shift+N", false), "Ctrl+Shift+N");
  assert.equal(displayShortcut("Mod+Alt+ArrowLeft", true), "⌥⌘←");
  assert.equal(displayShortcut("Mod+,", true), "⌘,");
  assert.equal(displayShortcut("nonsense", true), "");
});

test("a desktop binding is written the way the desktop registers it, and is never claimed in the window", () => {
  assert.equal(desktopAccelerator("Alt+Shift+S"), "Alt+Shift+S");
  assert.equal(desktopAccelerator("Mod+Ctrl+ArrowLeft"), "CommandOrControl+Control+Left");
  assert.equal(desktopAccelerator("Mod+Escape"), "CommandOrControl+Esc");
  assert.equal(desktopAccelerator("S"), null, "a keystroke with no modifier would swallow what you type");
  assert.equal(desktopAccelerator("nonsense"), null);

  const bindings = resolveShortcuts({});
  const capture = bindings.find((binding) => binding.action === "window.capture");
  assert.equal(capture.surface, "desktop");
  const stroke = parseShortcut(capture.binding);
  assert.equal(shortcutFor(bindings, stroke, "any"), undefined, "the window never takes the desktop's keystroke");
  assert.equal(shortcutFor(bindings, stroke, "browser"), undefined);
  assert.equal(shortcutFor(bindings, stroke, "desktop").action, "window.capture");
});
