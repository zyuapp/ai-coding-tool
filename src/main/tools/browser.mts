import { z } from "zod";
import { MAX_BROWSER_WAIT_MS } from "../../contracts/ipc.js";
import type { BrowserReadResult } from "../../contracts/threads.js";
import { browserSearchUrl, describeTab, type BrowserShot, type BrowserSnapshot } from "../../domain/browser.js";
import type { BrowserBridge } from "../agent/agent-provider.mjs";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";

export const BROWSER_SERVER_NAME = "aicodingtool-browser";

const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_TEXT_LIMIT = 4_000;

const tabField = z.string().optional().describe("Which tab to act in. Defaults to the one the panel is showing.");
const refField = z.string().describe("The ref of the element, from the latest snapshot of that tab.");

function waitMs(seconds: number | undefined) {
  return Math.min(seconds === undefined ? DEFAULT_WAIT_MS : Math.max(0, seconds) * 1_000, MAX_BROWSER_WAIT_MS);
}

function snapshotText(snapshot: BrowserSnapshot) {
  const elements = snapshot.elements.map((element) => {
    const value = element.value === undefined ? "" : ` = ${JSON.stringify(element.value)}`;
    return `[${element.ref}] ${element.role} ${JSON.stringify(element.name)}${value}`;
  });
  return [
    `${snapshot.title || "Untitled"} — ${snapshot.url}${snapshot.loading ? " (still loading)" : ""}`,
    "",
    snapshot.text || "(the page has no text)",
    "",
    elements.length ? `Elements you can act on:\n${elements.join("\n")}` : "Nothing on this page can be clicked or typed into.",
  ].join("\n");
}

function shotText(shot: BrowserShot) {
  return [
    `${shot.title || "Untitled"} — ${shot.url}`,
    `Picture saved to ${shot.path} (${shot.width}x${shot.height}). Open that file to see the page.`,
  ].join("\n");
}

/** Every read answers the same way, so a page nobody has allowed yet reads as the ask it is. */
function readText(result: BrowserReadResult) {
  if (result.kind === "snapshot") return snapshotText(result.snapshot);
  if (result.kind === "shot") return shotText(result.shot);
  if (result.kind === "tabs") return result.tabs.length ? result.tabs.map(describeTab).join("\n") : "The browser panel has no tab open.";
  if (result.kind === "awaiting-approval") {
    return `AICodingTool is asking the user to allow ${result.url}. Nothing loads until they answer, so tell them what you need it for and wait, or ask them to open it themselves.`;
  }
  return "The browser panel has no tab open.";
}

async function report(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Browser error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

/** Reading after a write is what the caller wants: the page as it stands once the action settled. */
function settledPage(bridge: BrowserBridge, tabId: string | undefined, seconds: number | undefined) {
  return bridge.read({ op: "snapshot", ...(tabId ? { tabId } : {}), timeoutMs: waitMs(seconds), textLimit: DEFAULT_TEXT_LIMIT }).then(readText);
}

export const BROWSER_TOOLS: readonly ToolDefinition<BrowserBridge>[] = [
  defineTool({
    name: "browser_open",
    description: "Open a page in the AICodingTool browser panel and read it back. The panel shares one browser session with the user, so any site they are signed into is already signed in here, and they watch the same tabs you drive: leave the pages they opened alone. A page the user has never visited is theirs to allow first, so say what you need and wait rather than retrying. To search, use browser_search.",
    input: {
      url: z.string().describe("The page to open. Include the scheme for anything that is not an ordinary domain."),
      newTab: z.boolean().optional().describe("Open another tab instead of reusing the one on screen."),
      tabId: tabField,
      waitSeconds: z.number().optional().describe("How long to wait for the page to finish loading. Defaults to 20."),
    },
    readOnly: false,
    run: (bridge, args) => report(async () => {
      await bridge.command({ type: "browser.open", url: args.url, ...(args.newTab ? { newTab: true } : {}), ...(args.tabId ? { tabId: args.tabId } : {}) });
      return await settledPage(bridge, args.newTab ? undefined : args.tabId, args.waitSeconds);
    }),
  }),
  defineTool({
    name: "browser_search",
    description: "Search the web in the AICodingTool browser panel and read the results. Use this rather than opening a search engine yourself: Google sometimes answers the panel with its bot page instead of results.",
    input: {
      query: z.string().describe("What to search for."),
      newTab: z.boolean().optional().describe("Search in another tab instead of the one on screen."),
      tabId: tabField,
      waitSeconds: z.number().optional().describe("How long to wait for the results to load. Defaults to 20."),
    },
    readOnly: false,
    run: (bridge, args) => report(async () => {
      await bridge.command({ type: "browser.open", url: browserSearchUrl(args.query), ...(args.newTab ? { newTab: true } : {}), ...(args.tabId ? { tabId: args.tabId } : {}) });
      return await settledPage(bridge, args.newTab ? undefined : args.tabId, args.waitSeconds);
    }),
  }),
  defineTool({
    name: "browser_read",
    description: "Read the page a tab is showing: its text, and the elements you can act on. Act on the refs this hands back; they are only valid until the next read of that tab, so read again after anything changes the page.",
    input: {
      tabId: tabField,
      textLimit: z.number().optional().describe("How many characters of page text to return. Defaults to 4000."),
      waitSeconds: z.number().optional().describe("How long to wait for the page to settle first. Defaults to 20."),
    },
    readOnly: true,
    run: (bridge, args) => report(async () => readText(await bridge.read({
      op: "snapshot",
      ...(args.tabId ? { tabId: args.tabId } : {}),
      timeoutMs: waitMs(args.waitSeconds),
      textLimit: args.textLimit ?? DEFAULT_TEXT_LIMIT,
    }))),
  }),
  defineTool({
    name: "browser_screenshot",
    description: "Take a picture of a tab and read back where it was saved. Use it to check how a page looks, which the page text cannot tell you. The picture is a PNG file on this machine, so open that file to see it. The tab does not have to be the one on screen: a page the panel is not showing is captured just the same, and the user sees nothing move.",
    input: {
      tabId: tabField,
      fullPage: z.boolean().optional().describe("Capture the whole page instead of only the part that fits the window."),
      waitSeconds: z.number().optional().describe("How long to wait for the page to settle first. Defaults to 20."),
    },
    readOnly: true,
    run: (bridge, args) => report(async () => readText(await bridge.read({
      op: "screenshot",
      ...(args.tabId ? { tabId: args.tabId } : {}),
      ...(args.fullPage ? { fullPage: true } : {}),
      timeoutMs: waitMs(args.waitSeconds),
    }))),
  }),
  defineTool({
    name: "browser_click",
    description: "Click an element in the page and read back what it became.",
    input: { ref: refField, tabId: tabField, waitSeconds: z.number().optional().describe("How long to wait for the click's page load. Defaults to 20.") },
    readOnly: false,
    run: (bridge, args) => report(async () => {
      await bridge.command({ type: "browser.act", action: { kind: "click", ref: args.ref }, ...(args.tabId ? { tabId: args.tabId } : {}) });
      return await settledPage(bridge, args.tabId, args.waitSeconds);
    }),
  }),
  defineTool({
    name: "browser_type",
    description: "Type into a field in the page, optionally submitting it, then read back what it became.",
    input: {
      ref: refField,
      text: z.string().describe("What the field should contain. This replaces whatever it holds."),
      submit: z.boolean().optional().describe("Submit the field's form afterwards, the way pressing Enter would."),
      tabId: tabField,
      waitSeconds: z.number().optional().describe("How long to wait for a page load the submit causes. Defaults to 20."),
    },
    readOnly: false,
    run: (bridge, args) => report(async () => {
      await bridge.command({
        type: "browser.act",
        action: { kind: "type", ref: args.ref, text: args.text, ...(args.submit ? { submit: true } : {}) },
        ...(args.tabId ? { tabId: args.tabId } : {}),
      });
      return await settledPage(bridge, args.tabId, args.waitSeconds);
    }),
  }),
  defineTool({
    name: "browser_back",
    description: "Go back, or forward, in a tab's own history and read the page it lands on.",
    input: { forward: z.boolean().optional().describe("Go forward instead of back."), tabId: tabField },
    readOnly: false,
    run: (bridge, args) => report(async () => {
      await bridge.command({ type: "browser.go", delta: args.forward ? 1 : -1, ...(args.tabId ? { tabId: args.tabId } : {}) });
      return await settledPage(bridge, args.tabId, undefined);
    }),
  }),
  defineTool({
    name: "browser_tabs",
    description: "List the pages the browser panel has open. Use it to find the tab id of a page the user is looking at.",
    input: {},
    readOnly: true,
    run: (bridge) => report(async () => readText(await bridge.read({ op: "tabs" }))),
  }),
  defineTool({
    name: "browser_close_tab",
    description: "Close a tab in the browser panel. Only close tabs you opened; the user's own pages are theirs.",
    input: { tabId: z.string().describe("The tab to close, as browser_tabs reports it.") },
    readOnly: false,
    run: (bridge, args) => report(async () => {
      await bridge.command({ type: "browser.close-tab", tabId: args.tabId });
      return readText(await bridge.read({ op: "tabs" }));
    }),
  }),
];

export function browserTools(bridge: BrowserBridge) {
  return bindTools(bridge, BROWSER_TOOLS);
}
