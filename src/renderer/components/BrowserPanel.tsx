import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Globe, RotateCw, ShieldAlert } from "lucide-react";
import { browserTabTitle, type BrowserApproval, type BrowserTab } from "../../domain/browser";
import { useDismissibleLayer } from "../focus";
import { NativeSurface } from "./NativeSurface";

export type BrowserPanelProps = {
  tab: BrowserTab;
  /** The navigation this page is waiting on the user to answer, when it has one. */
  approval: BrowserApproval | null;
  /** Bumped whenever something asks this tab to take the keyboard. */
  focusToken?: number;
  /** The find bar, when it is this page being searched. It sits above the page rather than over it. */
  find?: ReactNode;
  onOpen: (url: string) => void;
  onGo: (delta: -1 | 1) => void;
  onReload: () => void;
  onDecide: (allow: boolean) => void;
};

export function BrowserPanel({ tab, approval, focusToken = 0, find, onOpen, onGo, onReload, onDecide }: BrowserPanelProps) {
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

  /** A tab asked for is one to read; a tab with no page yet is one to type an address into. */
  useEffect(() => {
    if (!focusToken) return;
    if (tab.url) void window.desktop.focusBrowserTab(tab.id);
    else addressInput.current?.focus({ preventScroll: true });
    /** Only a fresh request moves the keys, so the page this tab lands on later leaves them where they are. */
  }, [focusToken]);

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
          <p>The agent wants to open <strong>{browserTabTitle({ title: "", url: approval.url })}</strong>. It browses with every login you have here.</p>
          <button className="primary" type="button" onClick={() => onDecide(true)}>Allow this site</button>
          <button type="button" onClick={() => onDecide(false)}>Block</button>
        </div>
      )}

      <NativeSurface className="browser-viewport" report={(box) => void window.desktop.setBrowserBounds(box)}>
        {!tab.url && (
          <div className="browser-empty">
            <span className="agent-orb"><Globe size={17} /></span>
            <h2>No page open</h2>
            <p>Open a page here and every thread can read it — signed in as you, in one session for the whole app.</p>
          </div>
        )}
        {tab.error && <p className="browser-error">{tab.error}</p>}
      </NativeSurface>
    </section>
  );
}
