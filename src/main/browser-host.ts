import { BrowserWindow, session, WebContentsView, type Rectangle } from "electron";
import type { BrowserPageEvent } from "../contracts/ipc.js";
import type { BrowserAction, BrowserBounds, BrowserSnapshot } from "../domain/browser.js";
import type { FindResults } from "../domain/find.js";
import { chromeHeaders, chromeIdentity } from "./browser-headers.js";

/**
 * The browser panel's pages. One partition serves the whole app, so a login the user makes in the
 * panel is there for every thread and every project, and is still there after a restart.
 */
const PARTITION = "persist:browser";
/** Sites refuse sign-in from a user agent that names an embedded runtime, so Electron's is replaced. */
const IDENTITY = chromeIdentity(process.versions.chrome);
const REF_ATTRIBUTE = "data-claudex-ref";
const DEFAULT_TEXT_LIMIT = 4_000;

type Tab = {
  id: string;
  view: WebContentsView;
};

const tabs = new Map<string, Tab>();
let host: BrowserWindow | null = null;
let publish: (event: BrowserPageEvent) => void = () => undefined;
let publishFind: (tabId: string, results: FindResults) => void = () => undefined;
let keyPressed: (input: Electron.Input) => boolean = () => false;
let activeId: string | null = null;
let bounds: BrowserBounds | null = null;

/** Reads what a caller can act on, keeping the refs it hands out on the elements themselves. */
const SNAPSHOT_SCRIPT = `(() => {
  const limit = __LIMIT__;
  const selector = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=textbox],[contenteditable=""],[contenteditable=true]';
  const elements = [];
  let ref = 0;
  for (const node of document.querySelectorAll(selector)) {
    if (node.disabled) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    node.setAttribute('${REF_ATTRIBUTE}', String(++ref));
    const tag = node.tagName.toLowerCase();
    const type = tag === 'input' ? (node.getAttribute('type') || 'text').toLowerCase() : '';
    const label = node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('title')
      || node.getAttribute('alt') || (node.innerText || node.value || '').trim() || node.getAttribute('name') || '';
    const element = { ref: String(ref), role: node.getAttribute('role') || (type ? tag + ':' + type : tag), name: label.replace(/\\s+/g, ' ').slice(0, 140) };
    if (type !== 'password' && typeof node.value === 'string' && node.value) element.value = node.value.slice(0, 140);
    elements.push(element);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, text: text.slice(0, limit), truncated: text.length > limit, elements };
})()`;

function actionScript(action: BrowserAction) {
  const ref = JSON.stringify(action.ref);
  const found = `const node = document.querySelector('[${REF_ATTRIBUTE}=' + JSON.stringify(${ref}) + ']');
    if (!node) return 'No element has the ref ' + ${ref} + '. Take a fresh snapshot first.';
    node.scrollIntoView({ block: 'center', inline: 'center' });`;
  if (action.kind === "click") {
    return `(() => { ${found}
      node.click();
      return 'Clicked ' + (node.innerText || node.getAttribute('aria-label') || node.tagName).trim().slice(0, 80);
    })()`;
  }
  const text = JSON.stringify(action.text);
  return `(() => { ${found}
    node.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')?.set;
    if (setter) setter.call(node, ${text}); else node.textContent = ${text};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    ${action.submit ? `if (node.form) node.form.requestSubmit ? node.form.requestSubmit() : node.form.submit();
    else node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));` : ""}
    return 'Typed into ' + (node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.tagName);
  })()`;
}

export function startBrowserHost(window: BrowserWindow, handlers: { onPage: (event: BrowserPageEvent) => void; onFind: (tabId: string, results: FindResults) => void; onKey: (input: Electron.Input) => boolean }) {
  host = window;
  publish = handlers.onPage;
  publishFind = handlers.onFind;
  keyPressed = handlers.onKey;
  const partition = session.fromPartition(PARTITION);
  partition.setUserAgent(IDENTITY.userAgent);
  /** The user agent is one of several things a request says about the browser; these are the rest. */
  partition.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: chromeHeaders(details.url, details.requestHeaders, IDENTITY) });
  });
}

/** Every view is dropped when the window goes, so a closed window leaves no page running. */
export function stopBrowserHost() {
  for (const id of [...tabs.keys()]) closeTab(id);
  host = null;
  activeId = null;
  bounds = null;
}

function report(tabId: string, event: Omit<BrowserPageEvent, "tabId">) {
  publish({ tabId, ...event });
}

function layout(tab: Tab) {
  const visible = tab.id === activeId && bounds !== null;
  tab.view.setVisible(visible);
  if (visible && bounds) tab.view.setBounds(inWindow(bounds));
}

/**
 * The panel reports CSS pixels and a view is placed in window points, which differ by however much
 * the window is zoomed. Reading the zoom here keeps the page over the panel at any zoom level.
 */
function inWindow(box: BrowserBounds): Rectangle {
  const zoom = host && !host.isDestroyed() ? host.webContents.getZoomFactor() : 1;
  return {
    x: Math.round(box.x * zoom),
    y: Math.round(box.y * zoom),
    width: Math.max(1, Math.round(box.width * zoom)),
    height: Math.max(1, Math.round(box.height * zoom)),
  };
}

/** Idempotent: a tab that already has a view keeps it, so showing a tab never reloads its page. */
export function openTab(tabId: string, url?: string) {
  if (tabs.get(tabId)) return;
  if (!host || host.isDestroyed()) return;
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  const tab: Tab = { id: tabId, view };
  tabs.set(tabId, tab);
  host.contentView.addChildView(view);
  view.setVisible(false);
  watch(tab);
  if (url) void load(tab, url);
  layout(tab);
}

function watch({ id, view }: Tab) {
  const contents = view.webContents;
  const state = () => ({ url: contents.getURL(), title: contents.getTitle(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() });
  contents.on("did-start-loading", () => report(id, { loading: true }));
  contents.on("did-stop-loading", () => report(id, { loading: false, ...state() }));
  contents.on("page-title-updated", (_event, title) => report(id, { title }));
  contents.on("did-navigate", () => report(id, state()));
  contents.on("did-navigate-in-page", () => report(id, state()));
  contents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame && code !== -3) report(id, { loading: false, error: `${description} (${validatedURL})` });
  });
  contents.on("render-process-gone", () => report(id, { loading: false, error: "The page stopped responding." }));
  /** Chromium counts a page's matches itself, and numbers the one it is on from one. */
  contents.on("found-in-page", (_event, result) => publishFind(id, { matches: result.matches, index: Math.max(0, (result.activeMatchOrdinal ?? 1) - 1) }));
  /** A shortcut belongs to the app while a page has the keys, so the page never sees that keystroke. */
  contents.on("before-input-event", (event, input) => {
    if (keyPressed(input)) event.preventDefault();
  });
  /** The panel only ever holds web pages; anything else the page asks for is left to the OS. */
  contents.on("will-navigate", (event, url) => {
    if (!/^https?:$/.test(new URL(url).protocol)) event.preventDefault();
  });
  /** A sign-in popup keeps the app's session, so the login it completes is the panel's login too. */
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/.test(url)) return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: { width: 560, height: 720, autoHideMenuBar: true } };
  });
}

async function load(tab: Tab, url: string) {
  try {
    await tab.view.webContents.loadURL(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) report(tab.id, { loading: false, error: message });
  }
}

export function navigate(tabId: string, url: string) {
  const tab = tabs.get(tabId);
  if (!tab) {
    openTab(tabId, url);
    return;
  }
  void load(tab, url);
}

export function goHistory(tabId: string, delta: -1 | 1) {
  const history = tabs.get(tabId)?.view.webContents.navigationHistory;
  if (!history) return;
  if (delta === -1 && history.canGoBack()) history.goBack();
  if (delta === 1 && history.canGoForward()) history.goForward();
}

export function reload(tabId: string) {
  tabs.get(tabId)?.view.webContents.reload();
}

/** Searches a page, stepping to the next match when the query is one the page is already showing. */
export function findInPage(tabId: string, query: string, options: { forward: boolean; findNext: boolean }) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.view.webContents.findInPage(query, { forward: options.forward, findNext: options.findNext });
}

export function stopFindInPage(tabId: string) {
  tabs.get(tabId)?.view.webContents.stopFindInPage("clearSelection");
}

export function closeTab(tabId: string) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tabs.delete(tabId);
  if (host && !host.isDestroyed()) host.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
}

/** Which tab the panel shows. The view is only drawn once the panel has also reported where it is. */
export function showTab(tabId: string | null) {
  activeId = tabId;
  for (const tab of tabs.values()) layout(tab);
}

/** Where the panel is, in window coordinates. Null means the panel is not on screen at all. */
export function setBounds(box: BrowserBounds | null) {
  bounds = box;
  for (const tab of tabs.values()) layout(tab);
}

async function settled(tabId: string, timeoutMs: number) {
  const tab = tabs.get(tabId);
  if (!tab) return null;
  const contents = tab.view.webContents;
  if (!contents.isLoading()) return tab;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      contents.off("did-stop-loading", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    contents.once("did-stop-loading", done);
  });
  return tabs.get(tabId) ?? null;
}

/** Waits for the page to settle, then reads it. Null when that tab is gone by the time it settles. */
export async function readPage(tabId: string, textLimit: number, timeoutMs: number): Promise<BrowserSnapshot | null> {
  const tab = await settled(tabId, timeoutMs);
  if (!tab) return null;
  const limit = Math.max(200, Math.min(textLimit || DEFAULT_TEXT_LIMIT, 120_000));
  const page = await tab.view.webContents.executeJavaScript(SNAPSHOT_SCRIPT.replace("__LIMIT__", String(limit)), true) as {
    url: string;
    title: string;
    text: string;
    truncated: boolean;
    elements: BrowserSnapshot["elements"];
  };
  return {
    tabId,
    url: page.url,
    title: page.title,
    loading: tab.view.webContents.isLoading(),
    text: page.truncated ? `${page.text}\n… (page text truncated)` : page.text,
    elements: page.elements,
  };
}

export async function act(tabId: string, action: BrowserAction): Promise<string> {
  const tab = tabs.get(tabId);
  if (!tab) return "That tab is no longer open.";
  return await tab.view.webContents.executeJavaScript(actionScript(action), true) as string;
}

/** Signs the whole app out of everything the panel has ever logged into. */
export async function clearData() {
  const partition = session.fromPartition(PARTITION);
  await partition.clearStorageData();
  await partition.clearCache();
  for (const tab of tabs.values()) tab.view.webContents.reload();
}
