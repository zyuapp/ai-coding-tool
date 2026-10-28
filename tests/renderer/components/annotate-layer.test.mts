import { dom, mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { Selected } from "../../../src/renderer/timeline/use-annotations.ts";

const { AnnotatePopover, NoteEditor } = await import("../../../src/renderer/components/AnnotateLayer.tsx");

const selection: Selected = { quote: "the passage", anchor: { kind: "message", messageId: "m1", start: 0, end: 11 }, x: 10, y: 10 };

async function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event); });
  return event.defaultPrevented;
}

async function popover(withSide: boolean) {
  const calls = { noted: 0, sided: 0 };
  const view = await mount(React.createElement(AnnotatePopover, {
    selection,
    toolbarRef: { current: null },
    noteReturn: { current: null },
    onNote: () => { calls.noted += 1; },
    ...(withSide ? { onSide: () => { calls.sided += 1; } } : {}),
  }));
  return { view, calls };
}

test("Enter adds a selection to the chat and Mod+Enter to the side chat, with both keys in the tips", async () => {
  const { view, calls } = await popover(true);
  const [add, side] = [...document.body.querySelectorAll<HTMLButtonElement>(".annotate-popover button")];
  assert.match(add!.dataset.tip ?? "", /^Add to chat \(/);
  assert.match(side!.dataset.tip ?? "", /^Add to side chat \(/);

  assert.equal(await press(document.body, "Enter"), true);
  assert.deepEqual(calls, { noted: 1, sided: 0 });
  await press(document.body, "Enter", { metaKey: true, ctrlKey: true });
  assert.deepEqual(calls, { noted: 1, sided: 1 });
  await view.unmount();
});

test("Enter on a field or a button keeps its own meaning, and Mod+Enter does nothing with no side chat", async () => {
  const { view, calls } = await popover(false);
  const field = document.createElement("textarea");
  const button = document.createElement("button");
  document.body.append(field, button);

  assert.equal(await press(field, "Enter"), false);
  assert.equal(await press(button, "Enter"), false);
  assert.equal(await press(document.body, "Enter", { metaKey: true, ctrlKey: true }), false);
  assert.deepEqual(calls, { noted: 0, sided: 0 });
  field.remove();
  button.remove();
  await view.unmount();

  assert.equal(await press(document.body, "Enter"), false, "the popover stops listening once it is gone");
});

test("removing an annotation is set apart from saving it", async () => {
  const view = await mount(React.createElement(NoteEditor, {
    noting: { annotationId: "a", quote: "q", anchor: selection.anchor, note: "n", x: 0, y: 0 },
    editorRef: { current: null },
    onChange() {},
    onCommit() {},
    onClose() {},
    onRemove() {},
  }));
  assert.ok(query(document.body, ".annotate-editor-save"));
  assert.match(query<HTMLInputElement>(document.body, ".annotate-editor input").placeholder, /Enter saves, Esc cancels/, "the empty field names both of its keys");
  assert.equal(query(document.body, ".annotate-editor-remove").getAttribute("aria-label"), "Remove annotation");
  await view.unmount();
});
