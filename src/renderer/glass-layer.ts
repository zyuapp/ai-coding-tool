/**
 * The glass layer is a see-through window of this page's own, floating over it. Whatever is drawn in
 * it sits on real glass, which the platform puts under each region the layer names. It is a second
 * document of the same page, so the page's own tree draws into it and hears from it directly.
 */

/** The name main knows the layer by. */
const FRAME = "glass-layer";
/** What marks an element in the layer as a pane the platform puts glass under. */
const REGION = "data-glass-region";

export type GlassLayerView = {
  /** Where panes are mounted. */
  root: HTMLElement;
  /** The layer's own window, for observers that watch what is mounted in it. */
  window: Window & typeof globalThis;
  /** Tells the platform where the layer's panes are now. Coalesced to one telling a frame. */
  reportRegions(): void;
};

/**
 * What the page listens for on its own window and document, which it must also hear from the
 * layer: the layer is part of the page, but a press or a key in it never reaches the page's document.
 */
const SHARED_EVENTS = new Set(["keydown", "keyup", "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "focusin", "focusout"]);

type Listening = { on: "window" | "document"; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions };
const listening: Listening[] = [];
let layerTargets: { window: Window; document: Document } | null = null;

/**
 * Starts keeping the page's own listeners, so they can be given to the layer as well. Runs before
 * anything listens, and only where the window can open a layer.
 */
export function shareListenersWithGlassLayer() {
  if (!window.desktop.glassLayer) return;
  for (const on of ["window", "document"] as const) {
    const target: Window | Document = on === "window" ? window : document;
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      add(type, listener, options);
      if (!SHARED_EVENTS.has(type)) return;
      listening.push({ on, type, listener, ...(options === undefined ? {} : { options }) });
      layerTargets?.[on].addEventListener(type, listener, options);
    };
    target.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      remove(type, listener, options);
      if (!SHARED_EVENTS.has(type)) return;
      const index = listening.findIndex((kept) => kept.on === on && kept.type === type && kept.listener === listener);
      if (index >= 0) listening.splice(index, 1);
      layerTargets?.[on].removeEventListener(type, listener, options);
    };
  }
}

/**
 * An element the layer made is an HTMLElement of the layer's own, which the page's `instanceof`
 * does not know. The page's kinds of node and event are taught to answer for the layer's too.
 */
function shareInstances(layer: Window & typeof globalThis) {
  const kinds = Object.getOwnPropertyNames(window).filter((name) => /^(Node|Element|Text|Range|DocumentFragment|Event|(HTML|SVG)\w*Element|\w+Event)$/.test(name));
  const instance = Function.prototype[Symbol.hasInstance];
  for (const name of kinds) {
    const mine = (window as unknown as Record<string, unknown>)[name];
    const theirs = (layer as unknown as Record<string, unknown>)[name];
    if (typeof mine !== "function" || typeof theirs !== "function") continue;
    Object.defineProperty(mine, Symbol.hasInstance, { configurable: true, value: (value: unknown) => instance.call(mine, value) || instance.call(theirs, value) });
  }
}

let opening: Promise<GlassLayerView | null> | null = null;

/** Opens the layer the first time it is wanted. Null where the window has no glass to put under one. */
export function openGlassLayer(): Promise<GlassLayerView | null> {
  opening ??= open();
  return opening;
}

/** The layer's first document is replaced once its window exists, so nothing is built in it until that has happened. */
async function settledDocument(layer: Window): Promise<Document> {
  for (let tries = 0; tries < 40; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (layer.document.readyState === "complete" && tries >= 2) break;
  }
  return layer.document;
}

function mirrorStyles(into: Document) {
  const base = into.createElement("base");
  base.href = document.baseURI;
  into.head.append(base);
  const copy = (node: Node) => into.head.append(into.importNode(node, true));
  const sheets = 'link[rel="stylesheet"], style';
  document.head.querySelectorAll(sheets).forEach(copy);
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof Element && node.matches(sheets)) copy(node);
      });
    }
  }).observe(document.head, { childList: true });
}

/** The theme, the fonts, the sizes and the glass tint all live on the root, so the layer's root follows it. */
function mirrorRoot(into: Document) {
  const from = document.documentElement;
  const sync = () => {
    for (const { name, value } of from.attributes) into.documentElement.setAttribute(name, value);
    for (const { name } of [...into.documentElement.attributes]) {
      if (name !== "data-glass-layer" && !from.hasAttribute(name)) into.documentElement.removeAttribute(name);
    }
    into.documentElement.setAttribute("data-glass-layer", "");
  };
  sync();
  new MutationObserver(sync).observe(from, { attributes: true });
}

/** The layer lets the pointer through to the page except over what it draws, or while a press that began there is held. */
function followPointer(layer: Window) {
  const doc = layer.document;
  let interactive = false;
  let pressed = false;
  const set = (next: boolean) => {
    if (next === interactive) return;
    interactive = next;
    void window.desktop.setGlassLayerInteractive(next);
  };
  const drawn = (target: EventTarget | null) => target !== null && target !== doc && target !== doc.documentElement && target !== doc.body;
  doc.addEventListener("mousemove", (event) => set(pressed || drawn(event.target)), true);
  doc.addEventListener("mousedown", () => { pressed = true; }, true);
  doc.addEventListener("mouseup", (event) => {
    pressed = false;
    set(drawn(event.target));
  }, true);
  doc.documentElement.addEventListener("mouseleave", () => {
    if (!pressed) set(false);
  });
}

/**
 * The keyboard goes to whichever window is the key one, so it follows focus between the two
 * documents: to the layer when something in it takes focus, and back when something in the page does.
 */
function followFocus(layer: Window & typeof globalThis) {
  let layerHasKeyboard = false;
  layer.addEventListener("focus", () => { layerHasKeyboard = true; });
  layer.addEventListener("blur", () => { layerHasKeyboard = false; });
  const toLayer = () => {
    if (!layerHasKeyboard) void window.desktop.focusGlassLayer(true);
  };
  layer.document.addEventListener("focusin", toLayer);
  /** A window without the keyboard moves its focus silently, so a focus asked for in code is heard here instead. */
  const focus = layer.HTMLElement.prototype.focus;
  layer.HTMLElement.prototype.focus = function focusOnGlass(this: HTMLElement, options?: FocusOptions) {
    focus.call(this, options);
    toLayer();
  };
  document.addEventListener("focusin", () => {
    if (layerHasKeyboard) void window.desktop.focusGlassLayer(false);
  });
}

function regionReporter(doc: Document) {
  let frame = 0;
  let told = "";
  return () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const regions = [...doc.querySelectorAll<HTMLElement>(`[${REGION}]`)].flatMap((pane) => {
        const { x, y, width, height } = pane.getBoundingClientRect();
        if (width === 0 || height === 0 || pane.closest("[data-covered]")) return [];
        return [{ x, y, width, height, radius: Number.parseFloat(getComputedStyle(pane).borderTopLeftRadius) || 0 }];
      });
      const telling = JSON.stringify(regions);
      if (telling === told) return;
      told = telling;
      void window.desktop.setGlassRegions(regions);
    });
  };
}

async function open(): Promise<GlassLayerView | null> {
  if (!window.desktop.glassLayer) return null;
  const layer = window.open("about:blank", FRAME) as (Window & typeof globalThis) | null;
  if (!layer) return null;
  const doc = await settledDocument(layer);
  mirrorStyles(doc);
  mirrorRoot(doc);
  shareInstances(layer);
  layerTargets = { window: layer, document: doc };
  for (const { on, type, listener, options } of listening) layerTargets[on].addEventListener(type, listener, options);
  followPointer(layer);
  followFocus(layer);
  const root = doc.createElement("div");
  root.className = "glass-layer";
  doc.body.append(root);
  return { root, window: layer, reportRegions: regionReporter(doc) };
}
