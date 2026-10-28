import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { typeInto } from "../support/mobile-phone.mts";
import { Composer } from "../../src/mobile/components/Composer.tsx";
import type { MobileThreadSettings } from "../../src/contracts/mobile.ts";

const settings: MobileThreadSettings = { engine: "claude", model: "opus", effort: "high", policy: "confirm" };

function mount(): { root: Root; render: (props: Partial<React.ComponentProps<typeof Composer>>) => void } {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  return {
    root,
    render: (props) => act(() => root.render(React.createElement(Composer, { running: false, waiting: 0, settings, onSend: () => {}, onOpenSettings: () => {}, ...props }))),
  };
}

const field = () => document.querySelector<HTMLTextAreaElement>(".composer-card textarea")!;

test("each thread keeps its own unsent words, and they outlive the composer", () => {
  const sent = vi.fn();
  const { root, render } = mount();
  render({ draftKey: "t1", onSend: sent });
  typeInto(".composer-card textarea", "for one");
  render({ draftKey: "t2", onSend: sent });
  assert.equal(field().value, "", "another thread's words do not follow it");
  render({ draftKey: "t1", onSend: sent });
  assert.equal(field().value, "for one");
  act(() => root.unmount());

  const again = mount();
  again.render({ draftKey: "t1", onSend: sent });
  assert.equal(field().value, "for one", "back and in again finds them");
  act(() => void document.querySelector(".send-button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  assert.deepEqual(sent.mock.calls, [["for one"]]);
  act(() => again.root.unmount());
  mount().render({ draftKey: "t1" });
  assert.equal(field().value, "", "a sent message is not kept");
});

test("messages held for the line can be taken back into the field", () => {
  const edit = vi.fn();
  const { render } = mount();
  render({ waiting: 2 });
  assert.equal(document.querySelector(".composer-waiting span")?.textContent, "2 waiting · offline");
  assert.equal(document.querySelector(".composer-waiting button"), null, "nothing to offer without a way to take them back");
  render({ waiting: 2, onEditWaiting: edit });
  act(() => void document.querySelector(".composer-waiting-edit")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  assert.equal(edit.mock.calls.length, 1);
});

test("a hardware keyboard's send shortcut is announced on the field and on Send", () => {
  mount().render({});
  assert.equal(field().getAttribute("aria-keyshortcuts"), "Meta+Enter Control+Enter");
  assert.equal(document.querySelector(".send-button")?.getAttribute("aria-keyshortcuts"), "Meta+Enter Control+Enter");
});

test("Steer and Queue say how they differ until one is first used", () => {
  localStorage.clear();
  const steer = vi.fn();
  const { render } = mount();
  render({ running: true, onSteer: steer, onStop: () => {} });
  assert.equal(document.querySelector(".composer-steer-hint"), null, "nothing typed, nothing to choose");
  typeInto(".composer-card textarea", "look at the tests");
  assert.equal(document.querySelector(".composer-steer-hint")?.textContent, "Steer joins this run · Queue waits for it");
  render({ running: true, waiting: 1, onSteer: steer, onStop: () => {} });
  assert.equal(document.querySelector(".composer-steer-hint"), null, "the offline chip keeps that spot");
  render({ running: true, onSteer: steer, onStop: () => {} });
  const pill = [...document.querySelectorAll<HTMLButtonElement>(".composer-pill")].find((button) => button.textContent === "Steer now")!;
  act(() => void pill.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  assert.deepEqual(steer.mock.calls, [["look at the tests"]]);
  typeInto(".composer-card textarea", "and the docs");
  assert.equal(document.querySelector(".composer-steer-hint"), null);

  const again = mount();
  again.render({ running: true, onSteer: steer, onStop: () => {} });
  typeInto(".composer-card textarea", "later");
  assert.equal(document.querySelector(".composer-steer-hint"), null, "learned once, learned for good");
  localStorage.clear();
});
