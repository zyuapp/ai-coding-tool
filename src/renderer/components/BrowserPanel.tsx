import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuArrowLeft as ArrowLeft, LuArrowRight as ArrowRight, LuGlobe as Globe, LuRotateCw as RotateCw, LuShieldAlert as ShieldAlert, LuX as X } from "react-icons/lu";
import { browserTabTitle, type BrowserApproval, type BrowserTab } from "../../domain/browser";
import { focusBrowserPage, placeBrowserPage } from "../browser-view";
import { useDismissibleLayer } from "../focus";
import { NativeSurface } from "./NativeSurface";
import { SpinningIcon } from "./SpinningIcon";
import { shortcutTip } from "./TooltipLayer";
import { Button, IconButton } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { TextField } from "../ui/Field";
import { Notice } from "../ui/Notice";
import { Toolbar } from "../ui/PanelHeader";

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
  /** Stops a page that is still loading; Reload stands in its place while absent. */
  onStop?: () => void;
  onDecide: (approvalId: string, allow: boolean) => void;
};

export function BrowserPanel({ tab, approval, focusToken = 0, find, onOpen, onGo, onReload, onStop, onDecide }: BrowserPanelProps) {
  const addressInput = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  /** A click that focuses the address keeps the whole of it selected, as a browser's own bar does. */
  const selectOnFocus = useRef(false);
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
    if (tab.url) focusBrowserPage(tab.id);
    else addressInput.current?.focus({ preventScroll: true });
    /** Only a fresh request moves the keys, so the page this tab lands on later leaves them where they are. */
  }, [focusToken]);

  return (
    <section className="browser-panel" aria-label="Browser">
      <Toolbar className="browser-bar">
        <IconButton label="Back" tip={shortcutTip("Back", "Mod+[")} disabled={!tab.canGoBack} onClick={() => onGo(-1)}><ArrowLeft size={16} /></IconButton>
        <IconButton label="Forward" tip={shortcutTip("Forward", "Mod+]")} disabled={!tab.canGoForward} onClick={() => onGo(1)}><ArrowRight size={16} /></IconButton>
        {tab.loading && onStop
          ? <IconButton label="Stop" onClick={onStop}><X size={16} /></IconButton>
          : <IconButton label="Reload" tip={shortcutTip("Reload", "Mod+R")} disabled={!tab.url} onClick={onReload}><SpinningIcon icon={RotateCw} spinning={tab.loading} size={16} /></IconButton>}
        <TextField
          ref={addressInput}
          value={address}
          aria-label="Address"
          spellCheck={false}
          placeholder="Enter a web address"
          onFocus={(event) => {
            setEditing(true);
            event.currentTarget.select();
          }}
          onMouseDown={(event) => { selectOnFocus.current = document.activeElement !== event.currentTarget; }}
          onMouseUp={(event) => {
            if (selectOnFocus.current) event.preventDefault();
            selectOnFocus.current = false;
          }}
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
      </Toolbar>

      {find}

      {approval && (
        <Notice
          className="browser-approval"
          tone="accent"
          role="alert"
          icon={<ShieldAlert size={16} />}
          actions={<>
            <Button onClick={() => onDecide(approval.approvalId, false)}>Block</Button>
            <Button variant="danger" onClick={() => onDecide(approval.approvalId, true)}>Always allow this site</Button>
          </>}
        >
          The agent wants to open <strong>{browserTabTitle({ title: "", url: approval.url })}</strong>. It browses with every login you have here.
        </Notice>
      )}

      <NativeSurface className="browser-viewport" report={placeBrowserPage}>
        {!tab.url && (
          <EmptyState
            className="browser-empty"
            icon={<Globe size={18} />}
            title="No page open"
            detail="Open a page here and every thread can read it, signed in as you, in one session for the whole app."
            action={<Button variant="soft" size="lg" onClick={() => addressInput.current?.focus()}>Type an address</Button>}
          />
        )}
        {tab.error && (
          <Notice className="browser-error" tone="danger" actions={tab.url && <Button size="sm" variant="soft" onClick={onReload}>Try again</Button>}>
            {tab.error}
          </Notice>
        )}
      </NativeSurface>
    </section>
  );
}
