import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import type { TerminalSession } from "../../src/domain/terminal.ts";

const { TerminalPanel } = await import("../../src/renderer/components/TerminalPanel.tsx");
const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");

const shell = (terminal: Partial<TerminalSession>): TerminalSession => ({ id: "t1", title: "project", cwd: "/project", taskId: null, status: "running", ...terminal });

test("a shell offers a new one in the same folder whether it is running or has exited", async () => {
  const dispatched: unknown[] = [];
  const panel = (terminal: TerminalSession) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command) => { dispatched.push(command); } } },
    React.createElement(TerminalPanel, { terminal, visible: false, onInput() {}, onResize() {} }));
  const view = await mount(panel(shell({})));
  const running = query<HTMLButtonElement>(view.container, ".terminal-new-shell");
  assert.equal(running.classList.contains("primary"), false, "a running shell offers another quietly");
  await act(async () => { running.click(); });
  assert.deepEqual(dispatched, [{ type: "terminal.open", cwd: "/project" }]);

  await view.render(panel(shell({ status: "exited", exitCode: 1 })));
  const status = query(view.container, ".terminal-status em");
  assert.match(status.textContent, /Exited \(1\)/);
  assert.ok(status.querySelector("svg"), "a failed exit is marked by more than its colour");
  const exited = query<HTMLButtonElement>(view.container, ".terminal-new-shell");
  assert.equal(exited.classList.contains("primary"), true, "an exited shell makes a new one the next step");
  await act(async () => { exited.click(); });
  assert.equal(dispatched.length, 2);

  await view.render(panel(shell({ status: "exited", exitCode: 0 })));
  assert.equal(query(view.container, ".terminal-status em").className, "clean");
  await view.unmount();
});
