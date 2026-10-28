import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import { composer } from "../support/composer.mts";
import { outbox } from "../support/composer-outbox.mts";

test("while a run goes, a written message shows how to queue it or steer it in", async () => {
  window.desktop = fakeDesktop();
  const idle = await mount(composer({ prompt: "check the logs" }));
  assert.equal(idle.container.querySelector(".composer-hint"), null, "with no run going Enter just sends");
  await idle.unmount();

  const empty = await mount(composer({ runActive: true }));
  assert.doesNotMatch(query(empty.container, ".composer-hint").textContent ?? "", /queue|steer/, "nothing written, nothing to steer");
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

test("an empty prompt offers its / and @ menus from the bar", async () => {
  window.desktop = fakeDesktop();
  const threads = [{ id: "t-2", title: "Fix login", handle: "fix-login", project: null, inScope: true, running: false, lastActivityAt: 1 }];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return composer({ prompt, onPromptChange: setPrompt, threads });
  }
  const view = await mount(React.createElement(Harness));
  const [commands, mention] = [...view.container.querySelectorAll<HTMLButtonElement>(".composer-hint button")];
  assert.equal(commands.textContent, "/ commands");
  assert.equal(mention.textContent, "@ threads");
  await act(async () => { commands.click(); });
  assert.equal(query<HTMLTextAreaElement>(view.container, "textarea").value, "/");
  assert.ok(query(view.container, "#slash-command-menu"), "the command menu opens");
  assert.equal(view.container.querySelector(".composer-hint button"), null, "the hint steps aside once something is written");
  await view.unmount();

  const mentioning = await mount(React.createElement(Harness));
  await act(async () => { query<HTMLButtonElement>(mentioning.container, ".composer-hint button:last-child").click(); });
  assert.equal(query<HTMLTextAreaElement>(mentioning.container, "textarea").value, "@");
  assert.ok(query(mentioning.container, "#thread-mention-menu"), "the thread menu opens");
  await mentioning.unmount();

  const lone = await mount(composer({}));
  assert.equal(lone.container.querySelectorAll(".composer-hint button").length, 1, "with no threads to name only / is offered");
  await lone.unmount();
});

test("removing a queued message asks first, with the focus on Cancel", async () => {
  window.desktop = fakeDesktop();
  const dropped: string[] = [];
  const queuedMessages = [{ id: "q-1", text: "next", prompt: "next", attachments: [] }];
  const view = await mount(composer({ runActive: true, queuedMessages, onDropQueued: (id) => { dropped.push(id); } }));
  await act(async () => { query<HTMLButtonElement>(view.container, ".queued-drop").click(); });
  assert.deepEqual(dropped, [], "the first press only asks");
  const [remove, cancel] = [...view.container.querySelectorAll<HTMLButtonElement>(".queued-actions button")].filter((button) => !button.matches(".queued-edit, .queued-steer"));
  assert.equal(remove.textContent, "Remove");
  assert.equal(document.activeElement, cancel, "the safe answer takes the focus");
  await act(async () => { cancel.click(); });
  assert.deepEqual(dropped, []);
  await act(async () => { query<HTMLButtonElement>(view.container, ".queued-drop").click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, ".queued-actions .armed").click(); });
  assert.deepEqual(dropped, ["q-1"]);
  await view.unmount();
});
