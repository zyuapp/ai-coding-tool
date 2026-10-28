import { dom, mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

const { GoalBar } = await import("../../../src/renderer/components/GoalBar.tsx");

async function press(target: Element, key: string) {
  await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
}

test("Clear asks first, with focus on Cancel, and only the confirm clears the goal", async () => {
  let cleared = 0;
  const view = await mount(React.createElement(GoalBar, { goal: { objective: "Ship the release", status: "active" }, onClear: () => { cleared += 1; } }));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Clear goal"]').click(); });
  assert.equal(cleared, 0);
  const cancel = [...view.container.querySelectorAll<HTMLButtonElement>(".goal-actions button")].find((button) => button.textContent === "Cancel")!;
  assert.equal(document.activeElement, cancel, "the safe choice takes focus");

  await press(cancel, "Escape");
  assert.equal(cleared, 0);
  const trigger = query<HTMLButtonElement>(view.container, 'button[aria-label="Clear goal"]');
  assert.equal(document.activeElement, trigger, "backing out returns to Clear");

  await act(async () => { trigger.click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, ".goal-actions button.danger").click(); });
  assert.equal(cleared, 1);
  await view.unmount();
});

test("a blocked goal shows why in place of its progress", async () => {
  const view = await mount(React.createElement(GoalBar, { goal: { objective: "Ship", status: "blocked", lastReason: "Tests fail" }, onClear() {} }));
  assert.ok(query(view.container, ".goal-bar").classList.contains("blocked"));
  assert.equal(query(view.container, ".goal-detail").textContent, "Tests fail");
  await view.unmount();
});

test("a goal too long for its line opens out in place, by click or key, and a short one stays plain", async () => {
  const proto = dom.window.HTMLElement.prototype;
  const scrollWidth = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) { return this.parentElement?.classList.contains("goal-objective") ? 900 : 0; } });
  try {
    const view = await mount(React.createElement(GoalBar, { goal: { objective: "Ship the release with every check green", status: "active" }, onClear() {} }));
    const objective = query<HTMLElement>(view.container, ".goal-objective");
    assert.equal(objective.getAttribute("role"), "button");
    assert.equal(objective.getAttribute("aria-expanded"), "false");
    await act(async () => { objective.click(); });
    assert.equal(objective.getAttribute("aria-expanded"), "true");
    assert.ok(objective.classList.contains("open"));
    await press(objective, "Enter");
    assert.equal(objective.getAttribute("aria-expanded"), "false");
    await view.unmount();
  } finally {
    if (scrollWidth) Object.defineProperty(proto, "scrollWidth", scrollWidth);
    else Reflect.deleteProperty(proto, "scrollWidth");
  }

  const short = await mount(React.createElement(GoalBar, { goal: { objective: "Ship", status: "active" }, onClear() {} }));
  assert.equal(query(short.container, ".goal-objective").getAttribute("role"), null);
  await short.unmount();
});
