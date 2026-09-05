import assert from "node:assert/strict";
import React, { act } from "react";
import { test, vi } from "vitest";
import { mount } from "../support/renderer-dom.mts";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { workspace } from "../application/workspace-reducer-fixtures.mts";

const { useWorkspaceSubscriptions } = await import("../../src/renderer/task-workspace/workspace-subscriptions.ts");
const { loadViewPreferences, saveViewPreferences } = await import("../../src/renderer/task-workspace/local-view-preferences.ts");

test("desktop initialization waits for restoration and applies current runtime preferences after listeners attach", async () => {
  let state = workspace({ restored: true, shortcuts: { "window.capture": "Alt+Shift+J" }, captureSound: false, captureFocus: false });
  const shortcuts: Parameters<DesktopAPI["setShortcuts"]>[0][] = [];
  const capture: Parameters<DesktopAPI["setCaptureOptions"]>[0][] = [];
  const pending = Promise.withResolvers<void>();
  let refusal: Parameters<DesktopAPI["onDesktopShortcutRefused"]>[0] | undefined;
  window.desktop = {
    onShortcut: () => () => {},
    onShortcutCaptured: () => () => {},
    onDesktopShortcutRefused: (listener: Parameters<DesktopAPI["onDesktopShortcutRefused"]>[0]) => { refusal = listener; return () => { refusal = undefined; }; },
    onWindowScreenshot: () => () => {},
    onOpenThread: () => () => {},
    setShortcuts: (value: Parameters<DesktopAPI["setShortcuts"]>[0]) => {
      assert.ok(refusal, "the refusal listener must precede claiming shortcuts");
      shortcuts.push(value);
      refusal({ reason: "unsupported", binding: "Alt+Shift+K", message: "Shortcut unavailable" });
    },
    setCaptureOptions: (value: Parameters<DesktopAPI["setCaptureOptions"]>[0]) => { capture.push(value); },
  } as unknown as DesktopAPI;
  async function dispatch(input: WorkspaceInput) {
    if (input.type === "view.mounted") await pending.promise;
    const transition = reduce(state, input);
    state = transition.state;
    for (const effect of transition.effects) {
      if (effect.type === "apply-shortcuts") window.desktop.setShortcuts(effect.overrides);
      if (effect.type === "apply-capture-options") window.desktop.setCaptureOptions(effect.options);
    }
  }
  function Harness({ restored }: { restored: boolean }) {
    useWorkspaceSubscriptions({ restored, dispatch });
    return null;
  }
  const view = await mount(React.createElement(Harness, { restored: false }));
  try {
    assert.deepEqual(shortcuts, []);
    assert.deepEqual(capture, []);
    await view.render(React.createElement(Harness, { restored: true }));
    assert.deepEqual(shortcuts, []);
    await dispatch({ type: "view.set-shortcut", action: "window.capture", binding: "Alt+Shift+K" });
    await dispatch({ type: "view.set-capture-options", options: { sound: true, focus: false } });
    await act(async () => { pending.resolve(); await Promise.resolve(); });
    assert.deepEqual(shortcuts, [{ "window.capture": "Alt+Shift+K" }, { "window.capture": "Alt+Shift+K" }]);
    assert.deepEqual(capture, [{ sound: true, focus: false }, { sound: true, focus: false }]);
    assert.equal(state.desktopShortcutUnavailable?.message, "Shortcut unavailable");
    await view.render(React.createElement(Harness, { restored: true }));
    assert.equal(shortcuts.length, 2);
  } finally {
    pending.resolve();
    await view.unmount();
  }
});

test("layout defaults use the supplied window width while stored choices remain authoritative", () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
  localStorage.clear();
  try {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1240 });
    assert.equal(loadViewPreferences().sidebarOpen, true);
    assert.equal(loadViewPreferences().sessionPanelOpen, false);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    const wide = loadViewPreferences();
    assert.equal(wide.sidebarOpen, true);
    assert.equal(wide.sessionPanelOpen, true);
    saveViewPreferences({ ...wide, sidebarOpen: false, sessionPanelOpen: false });
    assert.equal(loadViewPreferences().sidebarOpen, false);
    assert.equal(loadViewPreferences().sessionPanelOpen, false);
  } finally {
    localStorage.clear();
    if (descriptor) Object.defineProperty(window, "innerWidth", descriptor);
  }
});

test("reopened views report both focused and unfocused initial DOM state", async () => {
  window.desktop = {
    onShortcut: () => () => {}, onShortcutCaptured: () => () => {}, onDesktopShortcutRefused: () => () => {},
    onWindowScreenshot: () => () => {}, onOpenThread: () => () => {},
  } as unknown as DesktopAPI;
  for (const focused of [true, false]) {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
    let state = workspace({ focused: !focused });
    function Harness() {
      useWorkspaceSubscriptions({ restored: false, dispatch: async (input) => { state = reduce(state, input).state; } });
      return null;
    }
    const view = await mount(React.createElement(Harness));
    try { assert.equal(state.focused, focused); }
    finally { await view.unmount(); focus.mockRestore(); }
  }
});
