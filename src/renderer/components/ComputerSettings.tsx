import { LuMonitor as Monitor, LuPlus as Plus, LuPencil as Pencil, LuRefreshCw as RefreshCw, LuTrash2 as Trash } from "react-icons/lu";
import { useEffect, useState } from "react";
import { computerAddress, MAX_COMPUTER_NAME, type ComputerLink, type ComputerPairing, type DiscoveredComputer } from "../../domain/computers";
import type { ComputerUpkeep, UpkeepItem, UpkeepPart } from "../../application/computer-updates";
import type { AppCommand } from "../../contracts/commands";
import { RenameInput, useRenaming } from "./SidebarRename";
import { SettingRowBase } from "./SettingRow";
import { SettingsSection } from "./SettingsLayout";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Field";
import { ConfirmAction } from "../ui/ConfirmAction";
import { SpinningIcon } from "./SpinningIcon";
import { PAIRING_CODE_LENGTH } from "../../domain/mobile";

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
  /** Dials a computer that is not connected now, rather than after the pause between tries. */
  onReconnect: (id: string) => void;
  /** What this computer will call itself. Empty goes back to the machine's own name. */
  onRename: (name: string) => void;
  /** What this computer will call a paired one. Empty goes back to what that computer calls itself. */
  onLabel: (id: string, name: string) => void;
  /** Each paired computer's status line and the step that moves it on. Absent where a test has none. */
  upkeep?: readonly ComputerUpkeep[];
  /** Runs the step a row offers, such as updating that computer. */
  onCommand?: (command: AppCommand) => void;
};

const NO_UPKEEP: readonly ComputerUpkeep[] = [];

const GLYPH = <span className="setting-glyph" aria-hidden="true"><Monitor size={16} /></span>;

/** Where the line stands, and while it is down, the last fault it reported, for a row nothing else describes. */
function linkParts(link: ComputerLink): UpkeepPart[] {
  if (link.status === "connected") return [{ text: "Connected", tone: "live" }];
  const away: UpkeepPart = { text: link.status === "connecting" ? "Reconnecting…" : "Offline" };
  return link.error ? [away, { text: link.error }] : [away];
}

function StatusLine({ parts }: { parts: readonly UpkeepPart[] }) {
  return (
    <p className="computer-status" aria-live="polite">
      {parts.map((part, index) => <span key={index} className={part.tone}>{part.text}</span>)}
    </p>
  );
}

/** The software that computer runs, one line each, with every step in one column. */
function Software({ items, onCommand }: { items: readonly UpkeepItem[]; onCommand?: (command: AppCommand) => void }) {
  if (!items.length) return null;
  return (
    <ul className="computer-software" aria-live="polite">
      {items.map((item) => (
        <li key={item.key} data-software={item.key}>
          <span className="computer-software-name">{item.label}</span>
          <span className="computer-software-version">{item.version ?? "—"}</span>
          <span className={`computer-software-state ${item.state.tone ?? ""}`}>{item.state.text}</span>
          <span className="computer-software-action">
            {item.action && onCommand && <Button {...(item.state.tone === "error" ? { variant: "primary", tone: "info" } as const : {})} onClick={() => onCommand(item.action!.command)}>{item.action.label}</Button>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The code the other computer printed, typed here, which is the whole of pairing. */
function CodeEntry({ pairing, onPair, onCancel }: { pairing: ComputerPairing; onPair: (code: string) => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const typed = code.trim().length;
  const ready = typed >= PAIRING_CODE_LENGTH && !pairing.busy;
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
        <TextField
          mono
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
        <Button type="submit" disabled={!ready} aria-busy={pairing.busy}>{pairing.busy ? "Pairing…" : "Pair"}</Button>
        <Button onClick={onCancel} disabled={pairing.busy}>Cancel</Button>
      </div>
      {pairing.error && <p className="settings-error" role="alert">{pairing.error}</p>}
    </form>
  );
}

/** A computer the tailnet does not list, named by address: the same pairing, with the code shown by that address. */
function AddressEntry({ pairing, onPair }: { pairing: ComputerPairing | null; onPair: (host: string) => void }) {
  const [host, setHost] = useState("");
  const [invalid, setInvalid] = useState(false);
  const typed = host.trim();
  return (
    <form
      className="computer-address"
      onSubmit={(event) => {
        event.preventDefault();
        const address = computerAddress(typed);
        if (address) onPair(address);
        else setInvalid(true);
      }}
    >
      <label>
        <span>Or pair by address</span>
        <TextField
          mono
          autoComplete="off"
          spellCheck={false}
          value={host}
          placeholder="host:port"
          aria-invalid={invalid}
          aria-describedby={invalid ? "computer-address-error" : undefined}
          disabled={pairing?.busy}
          onInput={(event) => { setHost(event.currentTarget.value); setInvalid(false); }}
        />
      </label>
      <Button type="submit" disabled={!typed || (pairing !== null && pairing.busy)}>Pair</Button>
      {invalid && <p id="computer-address-error" className="settings-error" role="alert">Not a valid address</p>}
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
        <strong>This computer's name</strong>
        <TextField
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_COMPUTER_NAME}
          value={draft}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || draft === name) return;
            event.preventDefault();
            event.stopPropagation();
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
export function ComputerSettings({ found, searching, searchError, name, links, pairing, onDiscover, onPair, onCancelPairing, onForget, onReconnect, onRename, onLabel, upkeep = NO_UPKEEP, onCommand }: ComputerSettingsProps) {
  useEffect(() => { onDiscover(); }, []);
  const labels = useRenaming(onLabel);
  const paired = new Set(links.map((link) => link.host));
  const offered = found.filter((computer) => !paired.has(computer.host));
  const upkeepOf = new Map(upkeep.map((item) => [item.id, item]));
  return (
    <SettingsSection setting="phone.computers" description={<>Another computer running AI Coding Tool, or <code>aic serve</code>, shows its threads here beside your own.</>}
      action={<Button disabled={searching} aria-busy={searching} onClick={onDiscover} icon={<SpinningIcon icon={RefreshCw} spinning={searching} size={14} aria-hidden="true" />}>{searching ? "Looking…" : "Look again"}</Button>}>
      <SettingRowBase data-this-computer leading={GLYPH} title={<NameEntry name={name} onRename={onRename} />} />

      {links.map((link) => {
        const upkept = upkeepOf.get(link.id);
        return (
          <SettingRowBase key={link.id} data-computer={link.id} leading={GLYPH} actionClassName="computer-actions"
            title={labels.editing === link.id
              ? <RenameInput
                  inputRef={labels.input}
                  className="computer-rename"
                  label={`Rename ${link.name}`}
                  value={link.name}
                  onCommit={(value) => labels.commit(link.id, value)}
                  onCancel={labels.cancel}
                />
              : <span className="computer-title">
                  <strong onDoubleClick={(event) => labels.start(link.id, event.currentTarget.closest(".setting-row"))}>{link.name}</strong>
                  {link.host !== link.name && <span className="computer-host">{link.host}</span>}
                </span>}
            description={<StatusLine parts={upkept?.status ?? linkParts(link)} />}
            footer={<Software items={upkept?.items ?? []} onCommand={onCommand} />}>
            {link.status !== "connected" && !upkept && <Button onClick={() => onReconnect(link.id)}>Reconnect</Button>}
            {upkept?.action && onCommand && <Button onClick={() => onCommand(upkept.action!.command)}>{upkept.action.label}</Button>}
            <Button className="computer-rename-trigger" icon={<Pencil size={16} aria-hidden="true" />} aria-label={`Rename ${link.name}`} data-tip="Rename" disabled={labels.editing === link.id} onClick={(event) => labels.start(link.id, event.currentTarget.closest(".setting-row"))} />
            <ConfirmAction variant="danger" icon={<Trash size={16} aria-hidden="true" />} aria-label={`Remove ${link.name}`} data-tip="Remove" confirm="Remove" onConfirm={() => onForget(link.id)} />
          </SettingRowBase>
        );
      })}

      {offered.map((computer) => (
        <SettingRowBase key={computer.host} data-found={computer.host} leading={GLYPH} title={computer.name} description={<>
          <p>{computer.host}{computer.os ? ` · ${computer.os}` : ""}</p>
          {pairing?.host === computer.host && <CodeEntry pairing={pairing} onPair={(code) => onPair(computer.host, computer.name, code)} onCancel={onCancelPairing} />}
        </>}>
          {pairing?.host !== computer.host && <Button disabled={pairing !== null && pairing.busy} onClick={() => onPair(computer.host, computer.name, "")}>Pair</Button>}
        </SettingRowBase>
      ))}

      <SettingRowBase data-address leading={<span className="setting-glyph" aria-hidden="true"><Plus size={16} /></span>} title={<>
        <AddressEntry pairing={pairing} onPair={(host) => onPair(host, host, "")} />
        {pairing && !offered.some((computer) => computer.host === pairing.host) && <CodeEntry pairing={pairing} onPair={(code) => onPair(pairing.host, pairing.name, code)} onCancel={onCancelPairing} />}
      </>} />

      {searchError && <p className="settings-error" role="alert">{searchError}</p>}
      {!searchError && !searching && offered.length === 0 && links.length === 0 && <p className="settings-empty">No other computer on your tailnet is serving AI Coding Tool.</p>}
    </SettingsSection>
  );
}
