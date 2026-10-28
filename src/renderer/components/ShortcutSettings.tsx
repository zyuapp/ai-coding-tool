import { useEffect, useRef } from "react";
import { displayShortcut, shortcutKeys, type ShortcutSetting } from "../../domain/shortcuts";
import type { DesktopShortcutUnavailable } from "../../application/workspace-state";
import { MAC } from "../platform";
import { shortcutSettingId } from "../../domain/settings-catalog";
import { ConfirmAction, useSettingMark } from "./SettingRow";
import { shortcutTip } from "./TooltipLayer";

const CANCEL_TIP = shortcutTip("Cancel", "Escape");

export type ShortcutSettingsProps = {
  shortcuts: ShortcutSetting[];
  /** The action waiting for a keystroke, while the window hands every one of them over. */
  capturingShortcut: string | null;
  desktopShortcutUnavailable: DesktopShortcutUnavailable | null;
  onCaptureShortcut: (action: string | null) => void;
  onSetShortcut: (action: string, binding: string | null) => void;
  onResetShortcuts: () => void;
};

export function ShortcutSettings({ shortcuts, capturingShortcut, desktopShortcutUnavailable, onCaptureShortcut, onSetShortcut, onResetShortcuts }: ShortcutSettingsProps) {
  return (
    <main className="settings-main">
      <div className="settings-page-heading with-action">
        <div>
          <h2>Shortcuts</h2>
          <p>The rest of the keyboard is fixed, so only the keystrokes worth choosing yourself are here.</p>
        </div>
        <div className="settings-group-action">
          <ConfirmAction disabled={shortcuts.every((shortcut) => !shortcut.changed)} confirm="Restore all" onConfirm={onResetShortcuts}>Restore defaults</ConfirmAction>
        </div>
      </div>

      {[...new Set(shortcuts.map((shortcut) => shortcut.group))].map((group) => (
        <section className="settings-group" key={group} aria-label={group}>
          <div className="settings-group-heading">
            <div><h3>{group}</h3></div>
          </div>

          {shortcuts.filter((shortcut) => shortcut.group === group).map((shortcut) => (
            <ShortcutRow key={shortcut.id} shortcut={shortcut} capturing={capturingShortcut === shortcut.id}
              unavailable={shortcut.surface === "desktop" && shortcut.binding === desktopShortcutUnavailable?.binding ? desktopShortcutUnavailable : null}
              onCaptureShortcut={onCaptureShortcut} onSetShortcut={onSetShortcut} />
          ))}
        </section>
      ))}
    </main>
  );
}

type ShortcutRowProps = Pick<ShortcutSettingsProps, "onCaptureShortcut" | "onSetShortcut"> & {
  shortcut: ShortcutSetting;
  /** Whether this row is the one waiting for a keystroke. */
  capturing: boolean;
  unavailable: DesktopShortcutUnavailable | null;
};

function ShortcutRow({ shortcut, capturing, unavailable, onCaptureShortcut, onSetShortcut }: ShortcutRowProps) {
  const id = shortcutSettingId(shortcut.id);
  const { ref, found } = useSettingMark<HTMLDivElement>(id);
  const change = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const wasCapturing = useRef(capturing);
  /** The pressed button is swapped out, so the focus follows to its counterpart unless it already went elsewhere. */
  useEffect(() => {
    const active = document.activeElement;
    const adrift = !active || active === document.body || Boolean(ref.current?.contains(active));
    if (capturing) cancel.current?.focus();
    else if (wasCapturing.current && adrift) change.current?.focus();
    wasCapturing.current = capturing;
  }, [capturing]);
  return <div ref={ref} className={`setting-row plain shortcut-row${capturing ? " capturing" : ""}${found ? " found" : ""}`} data-setting={id}>
    <div>
      <strong>{shortcut.label}</strong>
      <p>{shortcut.description}</p>
      {unavailable && <p className="shortcut-unavailable" role="status">{unavailable.message}</p>}
    </div>
    <div className="setting-row-action">
      {capturing
        ? <>
            <em className="shortcut-capture" role="status">Press a keystroke…</em>
            <button ref={cancel} type="button" aria-label={`Cancel changing ${shortcut.label}`} data-tip={CANCEL_TIP} onClick={() => onCaptureShortcut(null)}>Cancel</button>
          </>
        : <>
            {shortcut.binding
              ? <kbd className="shortcut-keys">{shortcutKeys(shortcut.binding, MAC).map((key, index) => <span className="shortcut-key" key={index}>{key}</span>)}</kbd>
              : <em>Not set</em>}
            {shortcut.changed && <button type="button" aria-label={`Reset ${shortcut.label}`} data-tip={shortcut.defaultBinding ? `Reset to ${displayShortcut(shortcut.defaultBinding, MAC)}` : undefined} onClick={() => onSetShortcut(shortcut.id, shortcut.defaultBinding)}>Reset</button>}
            <button ref={change} type="button" aria-label={`Change ${shortcut.label}`} onClick={() => onCaptureShortcut(shortcut.id)}>Change</button>
            <button type="button" aria-label={`Clear ${shortcut.label}`} disabled={!shortcut.binding} onClick={() => onSetShortcut(shortcut.id, null)}>Clear</button>
          </>}
    </div>
  </div>;
}
