import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, ShieldAlert, X } from "lucide-react";
import type { BrowserApproval, BrowserTab } from "../../domain/browser";

export type BrowserPanelProps = {
  tabs: BrowserTab[];
  tab: BrowserTab | undefined;
  approval: BrowserApproval | null;
  /** False whenever something else is over the panel: the page is a native view, not an element. */
  visible: boolean;
  onOpen: (url: string, newTab?: boolean) => void;
  onNewTab: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onGo: (delta: -1 | 1) => void;
  onReload: () => void;
  onDecide: (allow: boolean) => void;
};

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function BrowserPanel({ tabs, tab, approval, visible, onOpen, onNewTab, onSelectTab, onCloseTab, onGo, onReload, onDecide }: BrowserPanelProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(tab?.url ?? "");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setAddress(tab?.url ?? "");
  }, [tab?.url, tab?.id, editing]);

  /** Main draws the page over this rectangle, so every layout change has to be reported. */
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const report = () => {
      const box = element.getBoundingClientRect();
      const hidden = !visible || box.width < 1 || box.height < 1;
      void window.desktop.setBrowserBounds(hidden ? null : { x: box.x, y: box.y, width: box.width, height: box.height });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    window.addEventListener("scroll", report, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
    };
  }, [visible, tab?.id]);

  /** A panel that is gone must not leave a page drawn over whatever replaces it. */
  useEffect(() => () => void window.desktop.setBrowserBounds(null), []);

  return (
    <section className="browser-panel" aria-label="Browser">
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((item) => (
          <div className={`browser-tab ${item.id === tab?.id ? "active" : ""}`} key={item.id}>
            <button type="button" role="tab" aria-selected={item.id === tab?.id} onClick={() => onSelectTab(item.id)}>
              <Globe size={13} aria-hidden="true" />
              <span>{item.title || hostOf(item.url) || "New tab"}</span>
            </button>
            <button type="button" aria-label={`Close ${item.title || item.url}`} onClick={() => onCloseTab(item.id)}><X size={12} /></button>
          </div>
        ))}
        <button className="browser-new-tab" type="button" aria-label="New browser tab" onClick={onNewTab}><Plus size={15} /></button>
      </div>

      <div className="browser-bar">
        <button type="button" aria-label="Back" disabled={!tab?.canGoBack} onClick={() => onGo(-1)}><ArrowLeft size={15} /></button>
        <button type="button" aria-label="Forward" disabled={!tab?.canGoForward} onClick={() => onGo(1)}><ArrowRight size={15} /></button>
        <button type="button" aria-label="Reload" disabled={!tab} onClick={onReload}><RotateCw size={14} /></button>
        <input
          value={address}
          aria-label="Address"
          spellCheck={false}
          placeholder="Enter a web address"
          onInput={(event) => {
            setEditing(true);
            setAddress(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            setEditing(false);
            if (address.trim()) onOpen(address, !tab);
          }}
          onBlur={() => setEditing(false)}
        />
      </div>

      {approval && (
        <div className="browser-approval" role="alert">
          <ShieldAlert size={16} aria-hidden="true" />
          <p>Claude wants to open <strong>{hostOf(approval.url)}</strong>. It browses with every login you have here.</p>
          <button className="primary" type="button" onClick={() => onDecide(true)}>Allow this site</button>
          <button type="button" onClick={() => onDecide(false)}>Block</button>
        </div>
      )}

      <div className="browser-viewport" ref={viewport}>
        {!tab && (
          <div className="browser-empty">
            <span className="agent-orb"><Globe size={17} /></span>
            <h2>No page open</h2>
            <p>Open a page here and every thread can read it — signed in as you, in one session for the whole app.</p>
          </div>
        )}
        {tab?.error && <p className="browser-error">{tab.error}</p>}
      </div>
    </section>
  );
}
