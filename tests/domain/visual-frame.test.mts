import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { test } from "vitest";
import { MAX_VISUAL_HEIGHT, renderMessage, themeMessage, VISUAL_FRAME_CSP, visualFrameDocument, visualFrameMessage } from "../../src/domain/visual-frame.ts";

test("a visual's frame runs inline script and reaches nothing outside itself", () => {
  const directives = new Map(VISUAL_FRAME_CSP.split("; ").map((directive) => [directive.split(" ")[0], directive]));
  assert.equal(directives.get("default-src"), "default-src 'none'");
  assert.match(directives.get("script-src")!, /'unsafe-inline'/);
  for (const directive of directives.values()) assert.doesNotMatch(directive, /https?:|\*|'self'/, directive);
  assert.equal(directives.get("form-action"), "form-action 'none'");
});

test("only well-formed size and error messages are taken from a frame, and a height is bounded", () => {
  assert.deepEqual(visualFrameMessage({ type: "aicodingtool-visual:size", height: 240.2 }), { type: "size", height: 241 });
  assert.deepEqual(visualFrameMessage({ type: "aicodingtool-visual:size", height: 1e9 }), { type: "size", height: MAX_VISUAL_HEIGHT });
  assert.deepEqual(visualFrameMessage({ type: "aicodingtool-visual:size", height: -4 }), { type: "size", height: 0 });
  assert.equal(visualFrameMessage({ type: "aicodingtool-visual:size", height: Number.NaN }), null);
  assert.equal(visualFrameMessage({ type: "aicodingtool-visual:size", height: "240" }), null);
  assert.equal(visualFrameMessage({ type: "something-else", height: 240 }), null);
  assert.equal(visualFrameMessage("aicodingtool-visual:size"), null);
  assert.equal(visualFrameMessage(null), null);
  assert.deepEqual(visualFrameMessage({ type: "aicodingtool-visual:error", message: "x".repeat(900) }), { type: "error", message: "x".repeat(500) });
});

test("the frame takes the markup once, runs its scripts in order, and applies the theme", async () => {
  const frame = new JSDOM(visualFrameDocument(), { runScripts: "dangerously", pretendToBeVisual: true });
  const window = frame.window;
  const observed: unknown[] = [];
  Object.defineProperty(window, "ResizeObserver", { value: class { observe() {} disconnect() {} } });
  const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window as unknown as MessageEventSource }));
  window.addEventListener("message", (event) => observed.push(event.data));
  const theme = { scheme: "light", vars: { "--color-text": "rgb(1, 2, 3)", "bad name": "red", "--font-size": "15px" } };

  post(renderMessage('<div id="viz-a"><p id="later">2</p><script>window.order = [document.getElementById("later").textContent]</script><script>window.order.push("second")</script></div>', theme));
  post(renderMessage('<script>window.order.push("again")</script>', theme));

  assert.deepEqual([...(window as unknown as { order: string[] }).order], ["2", "second"]);
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-text"), "rgb(1, 2, 3)");
  assert.equal(window.document.documentElement.style.getPropertyValue("bad name"), "");
  assert.equal(window.document.documentElement.style.colorScheme, "light");

  let restyled = 0;
  window.addEventListener("visualthemechange", () => { restyled += 1; });
  post(themeMessage({ scheme: "dark", vars: { "--color-text": "rgb(9, 9, 9)" } }));
  assert.equal(window.document.documentElement.style.getPropertyValue("--color-text"), "rgb(9, 9, 9)");
  assert.equal(window.document.documentElement.style.colorScheme, "dark");
  assert.equal(restyled, 1);

  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(observed.some((data) => visualFrameMessage(data)?.type === "size"), "the frame reports the height it needs");
  assert.equal(window.document.documentElement.style.overflowY, "hidden", "a visual within the cap shows no scrollbar to narrow it");
  // Closing empties the body, and a measure the bridge queued for that would run with no document.
  Object.defineProperty(window, "requestAnimationFrame", { value: () => 0 });
  window.close();
});

test("a ResizeObserver loop is not reported, so a later script error still is", async () => {
  const frame = new JSDOM(visualFrameDocument(), { runScripts: "dangerously" });
  const window = frame.window;
  const errors: string[] = [];
  window.addEventListener("message", (event) => {
    const message = visualFrameMessage(event.data);
    if (message?.type === "error") errors.push(message.message);
  });
  const fail = (message: string) => window.dispatchEvent(new window.ErrorEvent("error", { message }));

  fail("ResizeObserver loop completed with undelivered notifications.");
  fail("ResizeObserver loop limit exceeded");
  fail("ReferenceError: chart is not defined");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(errors, ["ReferenceError: chart is not defined"]);
  window.close();
});
