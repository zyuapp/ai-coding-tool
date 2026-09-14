import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../../src/renderer/components/BrowserPanel";
import { RemoteBrowserSurface } from "../../src/renderer/components/RemoteBrowserSurface";
import type { AppCommand } from "../../src/contracts/commands";
import type { BrowserFrame } from "../../src/contracts/browser-control";
import "../../src/renderer/styles.css";

declare global {
  interface Window {
    browserTest: { tabId: string; url: string; read: () => Promise<BrowserFrame>; send: (command: AppCommand) => Promise<void> };
  }
}

window.desktop = { readRemoteBrowserFrame: window.browserTest.read } as typeof window.desktop;
const { tabId, url, send } = window.browserTest;
createRoot(document.getElementById("root")!).render(<BrowserPanel
  tab={{ id: tabId, url, title: "Remote browser test", loading: false, canGoBack: false, canGoForward: false, offscreen: true }}
  approval={null}
  surface={<RemoteBrowserSurface computerId="test-host" tabId={tabId} visible focusToken={0} dispatch={send} />}
  onOpen={url => { void send({ type: "browser.open", tabId, url }); }}
  onGo={delta => { void send({ type: "browser.go", tabId, delta }); }}
  onReload={() => { void send({ type: "browser.reload", tabId }); }}
  onDecide={() => {}}
/>);
