import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import React, { useRef } from "react";
import { createPortal } from "react-dom";
import { dom, mount } from "../support/renderer-dom.mts";
import { installFocusAppearance, keyboardFocusVisible } from "../../src/renderer/focus-appearance.ts";
import { useModalFocus } from "../../src/renderer/focus.ts";

let stop: () => void;
beforeEach(() => {
  stop = installFocusAppearance();
  window.dispatchEvent(new Event("focus"));
});
afterEach(() => { stop(); document.body.replaceChildren(); });

function press(key: string, extra: KeyboardEventInit = {}, target: EventTarget = window) {
  target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, ...extra }));
}

test("modifiers, app switching chords, typing and IME do not highlight the previous control", () => {
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  for (const key of ["Shift", "Alt", "Control", "Meta", "CapsLock", "a"]) press(key);
  press("Tab", { altKey: true });
  press("Tab", { metaKey: true });
  press("ArrowLeft", { ctrlKey: true });
  press("Enter", { isComposing: true });
  assert.equal(keyboardFocusVisible(), false);
  assert.equal(document.activeElement, button);
});

test("navigation enables appearance before a menu moves focus, even when it stops propagation", () => {
  const menu = document.createElement("div");
  const button = document.createElement("button");
  menu.append(button);
  document.body.append(menu);
  let visibleOnFocus = false;
  button.addEventListener("focus", () => { visibleOnFocus = keyboardFocusVisible(); });
  menu.addEventListener("keydown", event => { event.stopPropagation(); button.focus(); });
  press("ArrowDown", {}, menu);
  assert.equal(visibleOnFocus, true);
  assert.equal(document.activeElement, button);
  window.dispatchEvent(new dom.window.PointerEvent("pointerdown"));
  assert.equal(keyboardFocusVisible(), false);
  assert.equal(document.activeElement, button, "a pointer press changes appearance without blurring the control");
  press("Tab", { shiftKey: true });
  assert.equal(keyboardFocusVisible(), true);
});

test("window return and restored focus stay quiet until the next navigation key", () => {
  const input = document.createElement("textarea");
  const button = document.createElement("button");
  document.body.append(input, button);
  input.value = "keep my caret";
  input.focus();
  input.setSelectionRange(5, 7);
  press("Tab");
  window.dispatchEvent(new Event("blur"));
  press("Tab");
  assert.equal(keyboardFocusVisible(), false, "late keyboard events in the background do not enable focus appearance");
  window.dispatchEvent(new Event("focus"));
  assert.equal(keyboardFocusVisible(), false);
  assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [5, 7]);
  button.focus();
  assert.equal(keyboardFocusVisible(), false, "script-restored focus cannot enable the highlight");
  press("Enter");
  assert.equal(keyboardFocusVisible(), true);
});

test("teardown removes listeners and restores the document marker", () => {
  stop();
  assert.equal(document.documentElement.dataset.focusAppearance, undefined);
  press("Tab");
  assert.equal(document.documentElement.dataset.focusAppearance, undefined);
});

test("a modal leaves app-switching chords alone while trapping ordinary Tab", async () => {
  function Dialog() {
    const root = useRef<HTMLDivElement>(null);
    useModalFocus(root);
    return createPortal(React.createElement("div", { ref: root, tabIndex: -1, role: "dialog" }), document.body);
  }
  const view = await mount(React.createElement(Dialog));
  try {
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const modifiers of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...modifiers });
      dialog.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
    }
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(document.activeElement, dialog);
  } finally { await view.unmount(); }
});
