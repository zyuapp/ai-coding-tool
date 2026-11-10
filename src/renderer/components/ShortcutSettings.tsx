import { useEffect, useRef } from "react";
import { displayShortcut, shortcutKeys, type ShortcutSetting } from "../../domain/shortcuts";
import type { DesktopShortcutUnavailable } from "../../application/workspace-state";
import { MAC } from "../platform";
import { shortcutSettingId } from "../../domain/settings-catalog";
import { SettingRowBase } from "./SettingRow";
import { SettingsPage, SettingsSection } from "./SettingsLayout";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";
import { ConfirmAction } from "../ui/ConfirmAction";
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
  const changed = shortcuts.filter((shortcut) => shortcut.changed).length;
  return (
    <SettingsPage title="Shortcuts" action={<ConfirmAction disabled={changed === 0} confirm="Restore all" onConfirm={onResetShortcuts}>Restore defaults</ConfirmAction>}>
      {[...new Set(shortcuts.map((shortcut) => shortcut.group))].map((group) => (
        <SettingsSection key={group} title={group}>
          {shortcuts.filter((shortcut) => shortcut.group === group).map((shortcut) => (
            <ShortcutRow key={shortcut.id} shortcut={shortcut} capturing={capturingShortcut === shortcut.id}
              unavailable={shortcut.surface === "desktop" && shortcut.binding === desktopShortcutUnavailable?.binding ? desktopShortcutUnavailable : null}
              onCaptureShortcut={onCaptureShortcut} onSetShortcut={onSetShortcut} />
          ))}
        </SettingsSection>
      ))}
    </SettingsPage>
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
  const row = useRef<HTMLDivElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const wasCapturing = useRef(capturing);
  /** The pressed button is swapped out, so the focus follows to its counterpart unless it already went elsewhere. */
  useEffect(() => {
    const active = document.activeElement;
    const adrift = !active || active === document.body || Boolean(row.current?.contains(active));
    if (capturing) cancel.current?.focus();
    else if (wasCapturing.current && adrift) change.current?.focus();
    wasCapturing.current = capturing;
  }, [capturing]);
  return <SettingRowBase ref={row} mark={id} className={`shortcut-row${capturing ? " capturing" : ""}`} title={shortcut.label} description={<>
    <p>{shortcut.description}</p>
    {unavailable && <p className="shortcut-unavailable" role="status">{unavailable.message}</p>}
  </>}>
    {capturing
      ? <>
          <em className="shortcut-capture" role="status">Press a keystroke…</em>
          <Button ref={cancel} aria-label={`Cancel changing ${shortcut.label}`} data-tip={CANCEL_TIP} onClick={() => onCaptureShortcut(null)}>Cancel</Button>
        </>
      : <>
          {shortcut.binding
            ? <Kbd className="shortcut-keys" keys={shortcutKeys(shortcut.binding, MAC)} />
            : <em>Not set</em>}
          {shortcut.changed && <Button aria-label={`Reset ${shortcut.label}`} data-tip={shortcut.defaultBinding ? `Reset to ${displayShortcut(shortcut.defaultBinding, MAC)}` : undefined} onClick={() => onSetShortcut(shortcut.id, shortcut.defaultBinding)}>Reset</Button>}
          <Button ref={change} aria-label={`Change ${shortcut.label}`} onClick={() => onCaptureShortcut(shortcut.id)}>Change</Button>
          <Button aria-label={`Clear ${shortcut.label}`} disabled={!shortcut.binding} onClick={() => onSetShortcut(shortcut.id, null)}>Clear</Button>
        </>}
  </SettingRowBase>;
}
