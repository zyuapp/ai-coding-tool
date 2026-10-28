import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import type { TerminalSession } from "../../src/domain/terminal.ts";

const { TerminalPanel } = await import("../../src/renderer/components/TerminalPanel.tsx");
const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");

const shell = (terminal: Partial<TerminalSession>): TerminalSession => ({ id: "t1", title: "project", cwd: "/project", taskId: null, status: "running", ...terminal });

test("an exited shell offers a new one in the same folder, and a running one does not", async () => {
  const dispatched: unknown[] = [];
  const panel = (terminal: TerminalSession) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command) => { dispatched.push(command); } } },
    React.createElement(TerminalPanel, { terminal, visible: false, onInput() {}, onResize() {} }));
  const view = await mount(panel(shell({})));
  assert.equal(view.container.querySelector(".terminal-new-shell"), null, "a running shell has nothing to restart");

  await view.render(panel(shell({ status: "exited", exitCode: 1 })));
  assert.match(query(view.container, ".terminal-status").textContent, /exited \(1\)/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".terminal-new-shell").click(); });
  assert.deepEqual(dispatched, [{ type: "terminal.open", cwd: "/project" }]);
  await view.unmount();
});
