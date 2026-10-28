import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import { composer } from "../support/composer.mts";
import { outbox } from "../support/composer-outbox.mts";

test("while a run goes, a written message shows how to queue it or steer it in", async () => {
  window.desktop = fakeDesktop();
  const idle = await mount(composer({ prompt: "check the logs" }));
  assert.equal(idle.container.querySelector(".composer-hint"), null, "with no run going Enter just sends");
  await idle.unmount();

  const empty = await mount(composer({ runActive: true }));
  assert.equal(empty.container.querySelector(".composer-hint"), null, "nothing written, nothing to steer");
  assert.equal(query(empty.container, "textarea").getAttribute("aria-describedby"), null);
  assert.equal(empty.container.querySelector('button[aria-label="Queue message"]'), null, "with nothing to queue the run has Stop alone");
  await empty.unmount();

  let cancelled = 0;
  const sent: boolean[] = [];
  const running = await mount(composer({ prompt: "check the logs", runActive: true, onCancel: () => { cancelled += 1; }, outbox: outbox({ send: (_attachments, steer) => { sent.push(steer); } }) }));
  const hint = query(running.container, ".composer-hint");
  assert.match(hint.textContent ?? "", /queue.*steer/);
  assert.equal(query(running.container, "textarea").getAttribute("aria-describedby"), hint.id, "the prompt names the keys to a screen reader too");
  assert.equal(hint.querySelectorAll("kbd").length, 2, "both keys stay named");
  const queue = query<HTMLButtonElement>(running.container, 'button[aria-label="Queue message"]');
  const stop = query<HTMLButtonElement>(running.container, 'button[aria-label="Stop task"]');
  assert.match(queue.dataset.tip ?? "", /^Queue \(.+\) · Steer \(.+\)$/);
  assert.match(stop.dataset.tip ?? "", /^Stop \((Esc|Escape)\)$/);
  await act(async () => { queue.click(); });
  assert.deepEqual(sent, [false], "a click on the arrow queues what is written");
  assert.equal(cancelled, 0, "and leaves the run going");
  await act(async () => { stop.click(); });
  assert.equal(cancelled, 1);
  await running.unmount();
});

test("an empty prompt carries no hint in the bar", async () => {
  window.desktop = fakeDesktop();
  const threads = [{ id: "t-2", title: "Fix login", handle: "fix-login", project: null, inScope: true, running: false, lastActivityAt: 1 }];
  const view = await mount(composer({ threads }));
  assert.equal(view.container.querySelector(".composer-hint"), null);
  await view.unmount();
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
