import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Globe, RotateCw, ShieldAlert } from "lucide-react";
import { browserTabTitle, type BrowserApproval, type BrowserTab } from "../../domain/browser";
import { useDismissibleLayer } from "../focus";

export type BrowserPanelProps = {
  tab: BrowserTab;
  /** The navigation this page is waiting on the user to answer, when it has one. */
  approval: BrowserApproval | null;
  /** False whenever something else is over the panel: the page is a native view, not an element. */
  visible: boolean;
  /** The find bar, when it is this page being searched. It sits above the page rather than over it. */
  find?: ReactNode;
  onOpen: (url: string) => void;
  onGo: (delta: -1 | 1) => void;
  onReload: () => void;
  onDecide: (allow: boolean) => void;
};

export function BrowserPanel({ tab, approval, visible, find, onOpen, onGo, onReload, onDecide }: BrowserPanelProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  const stopEditing = () => {
    setAddress(tab.url);
    setEditing(false);
    addressInput.current?.blur();
  };
  useDismissibleLayer(editing, [addressInput], stopEditing, null);

  useEffect(() => {
    if (!editing) setAddress(tab.url);
  }, [tab.url, tab.id, editing]);

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
  }, [visible, tab.id, find]);

  /** A panel that is gone must not leave a page drawn over whatever replaces it. */
  useEffect(() => () => void window.desktop.setBrowserBounds(null), []);

  return (
    <section className="browser-panel" aria-label="Browser">
      <div className="browser-bar">
        <button type="button" aria-label="Back" disabled={!tab.canGoBack} onClick={() => onGo(-1)}><ArrowLeft size={15} /></button>
        <button type="button" aria-label="Forward" disabled={!tab.canGoForward} onClick={() => onGo(1)}><ArrowRight size={15} /></button>
        <button type="button" aria-label="Reload" disabled={!tab.url} onClick={onReload}><RotateCw size={14} /></button>
        <input
          ref={addressInput}
          value={address}
          aria-label="Address"
          spellCheck={false}
          placeholder="Enter a web address"
          onFocus={() => setEditing(true)}
          onInput={(event) => {
            setEditing(true);
            setAddress(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              stopEditing();
              return;
            }
            if (event.key !== "Enter") return;
            setEditing(false);
            if (address.trim()) onOpen(address);
          }}
          onBlur={() => setEditing(false)}
        />
      </div>

      {find}

      {approval && (
        <div className="browser-approval" role="alert">
          <ShieldAlert size={16} aria-hidden="true" />
          <p>Claude wants to open <strong>{browserTabTitle({ title: "", url: approval.url })}</strong>. It browses with every login you have here.</p>
          <button className="primary" type="button" onClick={() => onDecide(true)}>Allow this site</button>
          <button type="button" onClick={() => onDecide(false)}>Block</button>
        </div>
      )}

      <div className="browser-viewport" ref={viewport}>
        {!tab.url && (
          <div className="browser-empty">
            <span className="agent-orb"><Globe size={17} /></span>
            <h2>No page open</h2>
            <p>Open a page here and every thread can read it — signed in as you, in one session for the whole app.</p>
          </div>
        )}
        {tab.error && <p className="browser-error">{tab.error}</p>}
      </div>
    </section>
  );
}
