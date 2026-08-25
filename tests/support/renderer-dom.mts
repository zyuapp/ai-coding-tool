import assert from "node:assert/strict";
import { afterAll } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

export const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "localStorage", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "Image", "navigator", "File", "Blob", "FileReader", "DOMParser", "innerWidth", "innerHeight"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
/** jsdom has no animation frames. Everything queued for one runs together, on a single timestamp. */
let animationTime = 0;
let frameId = 0;
let drain: ReturnType<typeof setTimeout> | null = null;
const queuedFrames = new Map<number, FrameRequestCallback>();
function runFrame() {
  if (drain !== null) clearTimeout(drain);
  drain = null;
  animationTime += 33;
  /** Only the frames asked for before this one, and only while a frame ahead has not cancelled them. */
  for (const id of [...queuedFrames.keys()]) {
    const callback = queuedFrames.get(id);
    if (!callback) continue;
    queuedFrames.delete(id);
    callback(animationTime);
  }
}
function scheduleFrame() {
  if (drain || queuedFrames.size === 0) return;
  drain = setTimeout(runFrame, 0);
}
const animationFunctions = {
  requestAnimationFrame: (fn: FrameRequestCallback) => { const id = (frameId += 1); queuedFrames.set(id, fn); scheduleFrame(); return id; },
  cancelAnimationFrame: (id: number) => queuedFrames.delete(id),
};
for (const name of Object.keys(animationFunctions) as Array<keyof typeof animationFunctions>) {
  const value = animationFunctions[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(dom.window, name, { configurable: true, value });
}
/** jsdom has no ResizeObserver, and the transcript's scrolling is driven by one. */
class ResizeObserverStub implements ResizeObserver {
  static live: ResizeObserverStub[] = [];
  constructor(readonly callback: ResizeObserverCallback) { ResizeObserverStub.live.push(this); }
  observe(_target: Element, _options?: ResizeObserverOptions) {}
  unobserve(_target: Element) {}
  disconnect() { ResizeObserverStub.live = ResizeObserverStub.live.filter((observer) => observer !== this); }
}
for (const target of [globalThis, dom.window]) {
  Object.defineProperty(target, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
/** React watches the focused field through the event methods only IE ever had, which jsdom has not. */
for (const prototype of [dom.window.HTMLInputElement.prototype, dom.window.HTMLTextAreaElement.prototype]) {
  Object.defineProperty(prototype, "attachEvent", { configurable: true, value: () => {} });
  Object.defineProperty(prototype, "detachEvent", { configurable: true, value: () => {} });
}
/**
 * jsdom lays nothing out and hit tests nothing, so a test places the rectangles it cares about and
 * the document answers from them. The last one placed is the one on top.
 */
export type TestBox = { x: number; y: number; width: number; height: number };
export const placed: Array<{ selector: string; box: TestBox }> = [];
export function place(selector: string, box: TestBox) {
  placed.push({ selector, box });
  const element = document.querySelector(selector);
  if (element) element.getBoundingClientRect = () => ({
    ...box,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    left: box.x,
    toJSON: () => box,
  });
  return box;
}
dom.window.document.elementFromPoint = (x, y) => {
  const hit = [...placed].reverse().find(({ selector, box }) => document.querySelector(selector)
    && x >= box.x && y >= box.y && x <= box.x + box.width && y <= box.y + box.height);
  return hit ? document.querySelector(hit.selector) : null;
};
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: () => {} });
Object.defineProperty(dom.window.Element.prototype, "getAnimations", { configurable: true, value: () => [] });

afterAll(async () => {
  dom.window.close();
});

export async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next: React.ReactNode) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

export function item<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

/**
 * Row heights for a virtualised list. Deleting the override would take jsdom's own accessor with it
 * and leave every height `undefined`, so the original descriptor goes back exactly as it was.
 */
export function rowHeights(height: (node: HTMLElement) => number) {
  const original = item(Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "offsetHeight"));
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) { return height(this); },
  });
  return { restore() { Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", original); } };
}

/** A virtualiser reads the scroll box off the element, which jsdom reports at nothing. */
export function sizeOf(node: Element, width: number, height: number) {
  Object.defineProperty(node, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(node, "offsetHeight", { configurable: true, value: height });
}

/** Every live observer, told its element changed size. jsdom raises none of these on its own. */
export function fireResizeObservers() {
  for (const observer of [...ResizeObserverStub.live]) observer.callback([], observer);
}

export async function pumpResizeObservers() {
  await act(async () => { fireResizeObservers(); });
}

export function query<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element = root.querySelector<E>(selector);
  assert.ok(element, `Expected ${selector}`);
  return element;
}
