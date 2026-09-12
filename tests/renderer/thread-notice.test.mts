import assert from "node:assert/strict";
import React from "react";
import { test } from "vitest";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { mount } from "../support/renderer-dom.mts";

const { useWorkspaceSubscriptions } = await import("../../src/renderer/task-workspace/workspace-subscriptions.ts");

test("the window answers a clicked notification by selecting that thread", async () => {
  const listeners = new Map<string, unknown>();
  let openThread: Parameters<DesktopAPI["onOpenThread"]>[0] | undefined;
  function listen<T>(name: string, listener: T) {
    listeners.set(name, listener);
    return () => { listeners.delete(name); };
  }
  const desktop = {
    onShortcut: (listener) => listen("onShortcut", listener),
    onShortcutCaptured: (listener) => listen("onShortcutCaptured", listener),
    onDesktopShortcutRefused: (listener) => listen("onDesktopShortcutRefused", listener),
    onWindowScreenshot: (listener) => listen("onWindowScreenshot", listener),
    onOpenThread(listener: Parameters<DesktopAPI["onOpenThread"]>[0]) {
      listeners.set("onOpenThread", listener);
      openThread = listener;
      return () => { listeners.delete("onOpenThread"); openThread = undefined; };
    },
  } satisfies Pick<DesktopAPI, "onShortcut" | "onShortcutCaptured" | "onDesktopShortcutRefused" | "onWindowScreenshot" | "onOpenThread">;
  const previous = Object.getOwnPropertyDescriptor(window, "desktop");
  Object.defineProperty(window, "desktop", { configurable: true, value: desktop });
  let view: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    const dispatched: WorkspaceInput[] = [];
    function Harness() {
      useWorkspaceSubscriptions({ restored: false, displayedState: emptyWorkspaceState, dispatch: async (input) => { dispatched.push(input); } });
      return null;
    }
    view = await mount(React.createElement(Harness));
    dispatched.length = 0;

    assert.ok(openThread);
    openThread("task-datadog");
    assert.deepEqual(dispatched, [{ type: "task.select", taskId: "task-datadog" }]);
  } finally {
    await view?.unmount();
    if (previous) Object.defineProperty(window, "desktop", previous);
    else Reflect.deleteProperty(window, "desktop");
  }
  assert.equal(listeners.size, 0, "the window drops every subscription at once");
});

