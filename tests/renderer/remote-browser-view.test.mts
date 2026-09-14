import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { dom } from "../support/renderer-dom.mts";
import { mountRemoteBrowser } from "../../src/renderer/task-workspace/remote-browser-view.ts";
import type { BrowserFrame } from "../../src/contracts/browser-control.ts";
import type { AppCommand } from "../../src/contracts/commands.ts";

test("browser viewing bounds reads, maps scaled coordinates, and ignores frames arriving after unmount", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  const keyboard = document.createElement("textarea");
  container.append(canvas, keyboard); document.body.append(container);
  const box = { x: 10, y: 20, left: 10, top: 20, right: 410, bottom: 320, width: 400, height: 300, toJSON() {} };
  container.getBoundingClientRect = () => box;
  canvas.getBoundingClientRect = () => box;
  canvas.setPointerCapture = () => {};
  const drawn = vi.fn();
  canvas.getContext = (() => ({ drawImage: drawn })) as unknown as typeof canvas.getContext;
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const imageDecode = Object.getOwnPropertyDescriptor(dom.window.HTMLImageElement.prototype, "decode");
  dom.window.HTMLImageElement.prototype.decode = async function () {
    Object.defineProperties(this, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
  };
  let answer!: (frame: BrowserFrame) => void;
  const reads = vi.fn(() => new Promise<BrowserFrame>((resolve) => { answer = resolve; }));
  const commands: AppCommand[] = [];
  const stop = mountRemoteBrowser(canvas, keyboard, "remote-tab", { read: reads, send: async command => { commands.push(command); }, status() {} });
  try {
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(reads.mock.calls.length, 1);
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(reads.mock.calls.length, 1, "slow replies never accumulate more frame requests");
    answer({ data: "YWJj", width: 800, height: 600, epoch: 7 });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(drawn.mock.calls.length, 1);
    canvas.dispatchEvent(new dom.window.PointerEvent("pointerdown", { clientX: 210, clientY: 170, button: 0, buttons: 1, pointerId: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const control = commands.find(command => command.type === "browser.control");
    assert.ok(control?.type === "browser.control" && control.input.kind === "pointer");
    assert.equal(control.epoch, 7);
    assert.equal(control.input.x, 400); assert.equal(control.input.y, 300);
    keyboard.value = "你好";
    keyboard.dispatchEvent(new dom.window.InputEvent("input", { data: "你好" }));
    await vi.advanceTimersByTimeAsync(0);
    assert.ok(commands.some(command => command.type === "browser.control" && command.input.kind === "text" && command.input.text === "你好"));
    await vi.advanceTimersByTimeAsync(125);
    assert.equal(reads.mock.calls.length, 2);
    stop();
    answer({ data: "YWJj", width: 800, height: 600, epoch: 8 });
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(drawn.mock.calls.length, 1, "a detached panel never draws a late frame");
    assert.equal(reads.mock.calls.length, 2);
  } finally {
    stop(); container.remove(); vi.useRealTimers();
    if (imageDecode) Object.defineProperty(dom.window.HTMLImageElement.prototype, "decode", imageDecode);
    else Reflect.deleteProperty(dom.window.HTMLImageElement.prototype, "decode");
  }
});
