import React from "react";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import { item, mount } from "./renderer-dom.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");

export type TaskWorkspace = ReturnType<typeof useTaskWorkspace>;

export async function mountWorkspace(desktop: DesktopAPI) {
  localStorage.clear();
  window.desktop = desktop;
  let latest: TaskWorkspace | undefined;
  function Harness() {
    latest = useTaskWorkspace();
    return null;
  }
  const view = await mount(React.createElement(Harness));
  return { view, get: () => item(latest) };
}
