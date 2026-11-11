import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import { createConversationMessage, createFailureMessage } from "../../src/domain/conversation.ts";

import { mount, query } from "../support/renderer-dom.mts";

const { ApprovalCard } = await import("../../src/renderer/components/ApprovalCard.tsx");
const { SystemNotice } = await import("../../src/renderer/components/SystemNotice.tsx");

const approval = (input: Record<string, unknown>) => ({ approvalId: "a1", taskId: "t", runId: "r", title: "Run a command?", description: "Wants to clean the build", toolName: "Bash", input });

test("the approval card shows the command it would run and decides it either way", async () => {
  const decided: boolean[] = [];
  const view = await mount(React.createElement(ApprovalCard, { approval: approval({ command: "rm -rf dist" }), onDecide: (_approval: unknown, allow: boolean) => { decided.push(allow); } }));
  const card = query(view.container, ".approval-card");
  assert.equal(query(card, ".approval-command").textContent, "rm -rf dist");
  assert.equal(card.querySelector("details"), null, "a command is read in full, not behind a disclosure");
  assert.equal(document.getElementById(card.getAttribute("aria-labelledby")!)?.textContent, "Run a command?");
  assert.equal(document.getElementById(card.getAttribute("aria-describedby")!)?.textContent, "Wants to clean the build");
  const button = (label: string) => [...card.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.firstChild?.textContent === label)!;
  assert.match(button("Allow once").dataset.tip ?? "", /^Allow once \(/);
  assert.match(button("Deny").dataset.tip ?? "", /^Deny \(/);
  assert.equal(card.querySelector("kbd"), null);
  await act(async () => { button("Allow once").click(); });
  await act(async () => { button("Deny").click(); });
  assert.deepEqual(decided, [true, false]);
  await view.unmount();

  const rebound = await mount(React.createElement(ApprovalCard, { approval: approval({ command: "ls" }), bindings: { allow: "Mod+Shift+Y", deny: null }, onDecide() {} }));
  const reboundButton = (label: string) => [...rebound.container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.firstChild?.textContent === label)!;
  assert.match(reboundButton("Allow once").dataset.tip ?? "", /Y\)$/, "a rebound shortcut is the one offered");
  assert.equal(reboundButton("Deny").hasAttribute("data-tip"), false, "an unbound one offers no keys");
  await rebound.unmount();

  const other = await mount(React.createElement(ApprovalCard, { approval: { ...approval({ query: "a" }), description: "" }, onDecide() {} }));
  assert.equal(other.container.querySelector(".approval-command"), null);
  assert.equal(query(other.container, "details summary").textContent, "Bash", "a call with nothing to read in full keeps its input behind the tool's name");
  assert.equal(query(other.container, ".approval-card").hasAttribute("aria-describedby"), false);
  await other.unmount();

  const edit = await mount(React.createElement(ApprovalCard, { approval: approval({ file_path: "src/a.ts", old_string: "a", new_string: "b\nc" }), onDecide() {} }));
  assert.equal(query(edit.container, ".approval-change > p").textContent, "src/a.ts");
  assert.deepEqual([...edit.container.querySelectorAll(".approval-change span")].map((line) => [line.className, line.textContent]), [["removed", "a\n"], ["added", "b\n"], ["added", "c\n"]], "an edit reads as the lines it swaps");
  assert.equal(edit.container.querySelector("details"), null);
  await edit.unmount();
});

test("a failure notice carries an alert mark, a copy button only with detail, and a neutral notice only its own mark", async () => {
  const failed = await mount(React.createElement(SystemNotice, { message: { ...createFailureMessage("The run failed."), detail: "exit 1" } }));
  assert.ok(query(failed.container, ".message.system.error .notice-icon"));
  assert.equal(query(failed.container, ".copy-affordance").getAttribute("aria-label"), "Copy the error");
  await failed.unmount();

  const short = await mount(React.createElement(SystemNotice, { message: createFailureMessage("Workspace is unavailable (missing).") }));
  assert.equal(short.container.querySelector(".copy-affordance"), null);
  await short.unmount();

  const info = await mount(React.createElement(SystemNotice, { message: createConversationMessage("system", "Moved to a worktree.") }));
  assert.equal(info.container.querySelector(".error"), null);
  assert.ok(query(info.container, ".message.system .notice-icon"));
  assert.equal(info.container.querySelector(".copy-affordance"), null);
  await info.unmount();
});

