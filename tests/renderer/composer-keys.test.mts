import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";

import { composer } from "../support/composer.mts";
import { outbox } from "../support/composer-outbox.mts";
import { dom, mount, query } from "../support/renderer-dom.mts";

async function press(runActive: boolean, keys: KeyboardEventInit) {
  const sent: boolean[] = [];
  const view = await mount(composer({ prompt: "words", runActive, outbox: outbox({ send: (_attachments, steer) => { sent.push(steer); } }) }));
  const pressed = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...keys });
  const field = query<HTMLTextAreaElement>(view.container, "textarea");
  await act(async () => {
    field.focus();
    field.dispatchEvent(pressed);
  });
  await view.unmount();
  return { sent, handled: pressed.defaultPrevented };
}

test("during a run Enter steers and Cmd or Ctrl+Enter queues", async () => {
  window.desktop = fakeDesktop();
  assert.deepEqual((await press(true, {})).sent, [true]);
  assert.deepEqual((await press(true, { metaKey: true })).sent, [false]);
  assert.deepEqual((await press(true, { ctrlKey: true })).sent, [false]);
});

test("with no run Enter and Cmd+Enter both send", async () => {
  window.desktop = fakeDesktop();
  assert.deepEqual((await press(false, {})).sent, [false]);
  assert.deepEqual((await press(false, { metaKey: true })).sent, [false]);
});

test("Shift+Enter is left to the field, which breaks the line", async () => {
  window.desktop = fakeDesktop();
  const during = await press(true, { shiftKey: true });
  assert.deepEqual(during.sent, []);
  assert.equal(during.handled, false);
});

test("a focused Stop that ends with nothing left to send hands the keys to the composer", async () => {
  const view = await mount(composer({ runActive: true }));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Stop task"]').focus(); });
  await view.render(composer({ runActive: false }));
  assert.equal(dom.window.document.activeElement, query(view.container, "textarea"));
  await view.unmount();
});
