import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { LuRefreshCw as RefreshCw } from "react-icons/lu";
import { dom, mount, query } from "../../support/renderer-dom.mts";

const { SpinningIcon } = await import("../../../src/renderer/components/SpinningIcon.tsx");

test("work that ends in a blink still turns the icon until the turn completes", async (t) => {
  const icon = (spinning: boolean) => React.createElement(SpinningIcon, { icon: RefreshCw, spinning });
  const view = await mount(icon(false));
  t.onTestFinished(() => view.unmount());
  const svg = () => query(view.container, "svg");
  const finishTurn = () => act(async () => { svg().dispatchEvent(new dom.window.Event("animationiteration", { bubbles: true })); });
  assert.equal(svg().classList.contains("spinning"), false, "an idle icon stands still");

  await view.render(icon(true));
  await view.render(icon(false));
  assert.equal(svg().classList.contains("spinning"), true, "the icon keeps turning after quick work ends");
  await finishTurn();
  assert.equal(svg().classList.contains("spinning"), false, "the icon rests once its turn completes");

  await view.render(icon(true));
  await finishTurn();
  assert.equal(svg().classList.contains("spinning"), true, "the icon keeps turning while work runs");
});
