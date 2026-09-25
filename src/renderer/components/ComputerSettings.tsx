import { LuCheck as Check, LuMonitor as Monitor, LuRefreshCw as RefreshCw } from "react-icons/lu";
import { useEffect, useState } from "react";
import { MAX_COMPUTER_NAME, type ComputerLink, type ComputerPairing, type DiscoveredComputer } from "../../domain/computers";
import { RenameInput, useRenaming } from "./SidebarRename";

export type ComputerSettingsProps = {
  found: DiscoveredComputer[];
  searching: boolean;
  searchError: string | null;
  /** What this computer calls itself to the others. */
  name: string;
  links: ComputerLink[];
  pairing: ComputerPairing | null;
  onDiscover: () => void;
  onPair: (host: string, name: string, code: string) => void;
  onCancelPairing: () => void;
  onForget: (id: string) => void;
  /** What this computer will call itself. Empty goes back to the machine's own name. */
  onRename: (name: string) => void;
  /** What this computer will call a paired one. Empty goes back to what that computer calls itself. */
  onLabel: (id: string, name: string) => void;
};

function statusLabel(link: ComputerLink): string {
  if (link.status === "connected") return "Connected";
  if (link.status === "connecting") return "Connecting…";
  return link.error ? `Offline: ${link.error}` : "Offline";
}

/** The code the other computer printed, typed here, which is the whole of pairing. */
function CodeEntry({ pairing, onPair, onCancel }: { pairing: ComputerPairing; onPair: (code: string) => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const ready = code.trim().length >= 8 && !pairing.busy;
  return (
    <form
      className="computer-code"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onPair(code.trim().toUpperCase());
      }}
    >
      <label>
        <span>Code shown by {pairing.name}</span>
        <input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={code}
          disabled={pairing.busy}
          placeholder="XXXXXXXX"
          onInput={(event) => setCode(event.currentTarget.value)}
        />
      </label>
      <div className="computer-code-actions">
        <button type="submit" disabled={!ready}>{pairing.busy ? "Pairing…" : "Pair"}</button>
        <button type="button" onClick={onCancel} disabled={pairing.busy}>Cancel</button>
      </div>
      {pairing.error && <p className="settings-error" role="alert">{pairing.error}</p>}
    </form>
  );
}

/** A computer the tailnet does not list, named by address: the same pairing, with the code shown by that address. */
function AddressEntry({ pairing, onPair }: { pairing: ComputerPairing | null; onPair: (host: string) => void }) {
  const [host, setHost] = useState("");
  const typed = host.trim();
  return (
    <form
      className="computer-address"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed) onPair(typed);
      }}
    >
      <label>
        <span>Or pair by address</span>
        <input
          autoComplete="off"
          spellCheck={false}
          value={host}
          placeholder="host:port"
          disabled={pairing?.busy}
          onInput={(event) => setHost(event.currentTarget.value)}
        />
      </label>
      <button type="submit" disabled={!typed || (pairing !== null && pairing.busy)}>Pair</button>
    </form>
  );
}

/** What this computer calls itself, kept as it is typed and given once the field is left or Enter is pressed. */
function NameEntry({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const typed = draft.trim();
    if (typed === name) return setDraft(name);
    if (!typed) setDraft(name);
    onRename(typed);
  };
  return (
    <form
      className="computer-name"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <label>
        <span>Name</span>
        <input
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_COMPUTER_NAME}
          value={draft}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setDraft(name);
          }}
        />
      </label>
    </form>
  );
}

/**
 * Other computers running this app on the tailnet, and the ones this computer already pairs with.
 * Pairing takes the code the other computer shows; from then on its threads sit in the sidebar.
 */
export function ComputerSettings({ found, searching, searchError, name, links, pairing, onDiscover, onPair, onCancelPairing, onForget, onRename, onLabel }: ComputerSettingsProps) {
  useEffect(() => { onDiscover(); }, []);
  const labels = useRenaming(onLabel);
  const paired = new Set(links.map((link) => link.host));
  const offered = found.filter((computer) => !paired.has(computer.host));
  return (
    <section className="settings-group" aria-labelledby="computers-heading">
      <div className="settings-group-heading">
        <div>
          <h3 id="computers-heading">Computers</h3>
          <p>Another computer running AI Coding Tool, or <code>aic serve</code>, shows its threads here beside your own.</p>
        </div>
        <div className="settings-group-action">
          <button type="button" disabled={searching} onClick={onDiscover}><RefreshCw size={13} aria-hidden="true" className={searching ? "spinning" : ""} />{searching ? "Looking…" : "Look again"}</button>
        </div>
      </div>

      <div className="setting-row" data-this-computer>
        <span className="setting-status granted"><Check size={13} /></span>
        <div>
          <NameEntry name={name} onRename={onRename} />
        </div>
      </div>

      {links.map((link) => (
        <div className="setting-row" key={link.id} data-computer={link.id}>
          <span className={`setting-status ${link.status === "connected" ? "granted" : "blank"}`}>{link.status === "connected" ? <Check size={13} /> : <Monitor size={13} />}</span>
          <div>
            {labels.editing === link.id
              ? <RenameInput
                  inputRef={labels.input}
                  className="computer-rename"
                  label={`Rename ${link.name}`}
                  value={link.name}
                  onCommit={(value) => labels.commit(link.id, value)}
                  onCancel={labels.cancel}
                />
              : <strong onDoubleClick={(event) => labels.start(link.id, event.currentTarget.closest(".setting-row"))}>{link.name}</strong>}
            <p className={`phone-device-state${link.status === "connected" ? " live" : ""}`}>{link.host} · {statusLabel(link)}</p>
          </div>
          <div className="setting-row-action">
            <button type="button" disabled={labels.editing === link.id} onClick={(event) => labels.start(link.id, event.currentTarget.closest(".setting-row"))}>Rename</button>
            <button className="danger" type="button" onClick={() => onForget(link.id)}>Remove</button>
          </div>
        </div>
      ))}

      {offered.map((computer) => (
        <div className="setting-row" key={computer.host} data-found={computer.host}>
          <span className="setting-status blank"><Monitor size={13} /></span>
          <div>
            <strong>{computer.name}</strong>
            <p>{computer.host}{computer.os ? ` · ${computer.os}` : ""}</p>
            {pairing?.host === computer.host && <CodeEntry pairing={pairing} onPair={(code) => onPair(computer.host, computer.name, code)} onCancel={onCancelPairing} />}
          </div>
          <div className="setting-row-action">
            {pairing?.host !== computer.host && <button type="button" disabled={pairing !== null && pairing.busy} onClick={() => onPair(computer.host, computer.name, "")}>Pair</button>}
          </div>
        </div>
      ))}

      <div className="setting-row" data-address>
        <span className="setting-status blank"><Monitor size={13} /></span>
        <div>
          <AddressEntry pairing={pairing} onPair={(host) => onPair(host, host, "")} />
          {pairing && !offered.some((computer) => computer.host === pairing.host) && <CodeEntry pairing={pairing} onPair={(code) => onPair(pairing.host, pairing.name, code)} onCancel={onCancelPairing} />}
        </div>
      </div>

      {searchError && <p className="settings-error" role="alert">{searchError}</p>}
      {!searchError && !searching && offered.length === 0 && links.length === 0 && <p className="settings-empty">No other computer on your tailnet is serving AI Coding Tool.</p>}
    </section>
  );
}
