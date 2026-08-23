import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MAX_BROWSER_WAIT_MS } from "../../contracts/ipc.js";
import type { BrowserReadResult } from "../../contracts/threads.js";
import { browserSearchUrl, describeTab, type BrowserSnapshot } from "../../domain/browser.js";
import type { BrowserBridge } from "./agent-provider.mjs";

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

/** Every read answers the same way, so a page nobody has allowed yet reads as the ask it is. */
function readText(result: BrowserReadResult) {
  if (result.kind === "snapshot") return snapshotText(result.snapshot);
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

export function browserServer(bridge: BrowserBridge): McpServerConfig {
  return createSdkMcpServer({
    name: BROWSER_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    tools: browserTools(bridge),
  });
}

export function browserTools(bridge: BrowserBridge) {
  /** Reading after a write is what the caller wants: the page as it stands once the action settled. */
  const settledPage = (tabId: string | undefined, seconds: number | undefined) =>
    bridge.read({ op: "snapshot", ...(tabId ? { tabId } : {}), timeoutMs: waitMs(seconds), textLimit: DEFAULT_TEXT_LIMIT }).then(readText);

  return [
    tool(
      "browser_open",
      "Open a page in the AICodingTool browser panel and read it back. The panel shares one browser session with the user, so any site they are signed into is already signed in here. A page the user has never visited is theirs to allow first, so say what you need and wait rather than retrying. To search, use browser_search.",
      {
        url: z.string().describe("The page to open. Include the scheme for anything that is not an ordinary domain."),
        newTab: z.boolean().optional().describe("Open another tab instead of reusing the one on screen."),
        tabId: tabField,
        waitSeconds: z.number().optional().describe("How long to wait for the page to finish loading. Defaults to 20."),
      },
      async (args) => report(async () => {
        await bridge.command({ type: "browser.open", url: args.url, ...(args.newTab ? { newTab: true } : {}), ...(args.tabId ? { tabId: args.tabId } : {}) });
        return await settledPage(args.newTab ? undefined : args.tabId, args.waitSeconds);
      }),
    ),
    tool(
      "browser_search",
      "Search the web in the AICodingTool browser panel and read the results. Use this rather than opening a search engine yourself: Google sometimes answers the panel with its bot page instead of results.",
      {
        query: z.string().describe("What to search for."),
        newTab: z.boolean().optional().describe("Search in another tab instead of the one on screen."),
        tabId: tabField,
        waitSeconds: z.number().optional().describe("How long to wait for the results to load. Defaults to 20."),
      },
      async (args) => report(async () => {
        await bridge.command({ type: "browser.open", url: browserSearchUrl(args.query), ...(args.newTab ? { newTab: true } : {}), ...(args.tabId ? { tabId: args.tabId } : {}) });
        return await settledPage(args.newTab ? undefined : args.tabId, args.waitSeconds);
      }),
    ),
    tool(
      "browser_read",
      "Read the page a tab is showing: its text, and the elements you can act on. Refs are only valid until the next read of that tab, so read again after anything changes the page.",
      {
        tabId: tabField,
        textLimit: z.number().optional().describe("How many characters of page text to return. Defaults to 4000."),
        waitSeconds: z.number().optional().describe("How long to wait for the page to settle first. Defaults to 20."),
      },
      async (args) => report(async () => readText(await bridge.read({
        op: "snapshot",
        ...(args.tabId ? { tabId: args.tabId } : {}),
        timeoutMs: waitMs(args.waitSeconds),
        textLimit: args.textLimit ?? DEFAULT_TEXT_LIMIT,
      }))),
    ),
    tool(
      "browser_click",
      "Click an element in the page and read back what it became.",
      { ref: refField, tabId: tabField, waitSeconds: z.number().optional().describe("How long to wait for the click's page load. Defaults to 20.") },
      async (args) => report(async () => {
        await bridge.command({ type: "browser.act", action: { kind: "click", ref: args.ref }, ...(args.tabId ? { tabId: args.tabId } : {}) });
        return await settledPage(args.tabId, args.waitSeconds);
      }),
    ),
    tool(
      "browser_type",
      "Type into a field in the page, optionally submitting it, then read back what it became.",
      {
        ref: refField,
        text: z.string().describe("What the field should contain. This replaces whatever it holds."),
        submit: z.boolean().optional().describe("Submit the field's form afterwards, the way pressing Enter would."),
        tabId: tabField,
        waitSeconds: z.number().optional().describe("How long to wait for a page load the submit causes. Defaults to 20."),
      },
      async (args) => report(async () => {
        await bridge.command({
          type: "browser.act",
          action: { kind: "type", ref: args.ref, text: args.text, ...(args.submit ? { submit: true } : {}) },
          ...(args.tabId ? { tabId: args.tabId } : {}),
        });
        return await settledPage(args.tabId, args.waitSeconds);
      }),
    ),
    tool(
      "browser_back",
      "Go back, or forward, in a tab's own history and read the page it lands on.",
      { forward: z.boolean().optional().describe("Go forward instead of back."), tabId: tabField },
      async (args) => report(async () => {
        await bridge.command({ type: "browser.go", delta: args.forward ? 1 : -1, ...(args.tabId ? { tabId: args.tabId } : {}) });
        return await settledPage(args.tabId, undefined);
      }),
    ),
    tool(
      "browser_tabs",
      "List the pages the browser panel has open. Use it to find the tab id of a page the user is looking at.",
      {},
      async () => report(async () => readText(await bridge.read({ op: "tabs" }))),
    ),
    tool(
      "browser_close_tab",
      "Close a tab in the browser panel. Only close tabs you opened; the user's own pages are theirs.",
      { tabId: z.string().describe("The tab to close, as browser_tabs reports it.") },
      async (args) => report(async () => {
        await bridge.command({ type: "browser.close-tab", tabId: args.tabId });
        return readText(await bridge.read({ op: "tabs" }));
      }),
    ),
  ];
}
