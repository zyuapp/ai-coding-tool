import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import { composer } from "../support/composer.mts";

test("a running composer with words written shows Stop alone", async () => {
  window.desktop = fakeDesktop();
  let cancelled = 0;
  const running = await mount(composer({ prompt: "check the logs", runActive: true, onCancel: () => { cancelled += 1; } }));
  assert.equal(running.container.querySelector(".composer-hint"), null);
  assert.equal(query(running.container, "textarea").getAttribute("aria-describedby"), null);
  assert.equal(running.container.querySelector('button[aria-label="Queue message"]'), null, "Enter queues, so the run has Stop alone");
  const stop = query<HTMLButtonElement>(running.container, 'button[aria-label="Stop task"]');
  assert.match(stop.dataset.tip ?? "", /^Stop \((Esc|Escape)\)$/);
  await act(async () => { stop.click(); });
  assert.equal(cancelled, 1);
  await running.unmount();
});

test("removing a queued message just removes it", async () => {
  window.desktop = fakeDesktop();
  const dropped: string[] = [];
  const queuedMessages = [{ id: "q-1", text: "next", prompt: "next", attachments: [] }];
  const view = await mount(composer({ runActive: true, queuedMessages, onDropQueued: (id) => { dropped.push(id); } }));
  await act(async () => { query<HTMLButtonElement>(view.container, ".queued-drop").click(); });
  assert.deepEqual(dropped, ["q-1"]);
  assert.equal(view.container.querySelector(".queued-actions .armed"), null);
  await view.unmount();
});
