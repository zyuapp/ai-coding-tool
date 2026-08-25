import { shortcutKeys, type ShortcutSetting } from "../../domain/shortcuts";
import { MAC } from "../platform";

export type ShortcutSettingsProps = {
  shortcuts: ShortcutSetting[];
  /** The action waiting for a keystroke, while the window hands every one of them over. */
  capturingShortcut: string | null;
  onCaptureShortcut: (action: string | null) => void;
  onSetShortcut: (action: string, binding: string | null) => void;
  onResetShortcuts: () => void;
};

export function ShortcutSettings({ shortcuts, capturingShortcut, onCaptureShortcut, onSetShortcut, onResetShortcuts }: ShortcutSettingsProps) {
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Shortcuts</h2>
        <p>The rest of the keyboard is fixed, so only the keystrokes worth choosing yourself are here.</p>
      </div>

      {[...new Set(shortcuts.map((shortcut) => shortcut.group))].map((group, index) => (
        <section className="settings-group" key={group} aria-label={group}>
          <div className="settings-group-heading">
            <div><h3>{group}</h3></div>
            {index === 0 && (
              <div className="settings-group-action">
                <button type="button" disabled={shortcuts.every((shortcut) => !shortcut.changed)} onClick={onResetShortcuts}>Restore defaults</button>
              </div>
            )}
          </div>

          {shortcuts.filter((shortcut) => shortcut.group === group).map((shortcut) => (
            <div className="setting-row shortcut-row" key={shortcut.id}>
              <span className="setting-status blank" aria-hidden="true" />
              <div>
                <strong>{shortcut.label}</strong>
                <p>{shortcut.description}</p>
              </div>
              <div className="setting-row-action">
                {capturingShortcut === shortcut.id
                  ? <>
                      <em className="shortcut-capture">Press a keystroke…</em>
                      <button type="button" onClick={() => onCaptureShortcut(null)}>Cancel</button>
                    </>
                  : <>
                      {shortcut.binding
                        ? <kbd className="shortcut-keys">{shortcutKeys(shortcut.binding, MAC).map((key, index) => <span className="shortcut-key" key={index}>{key}</span>)}</kbd>
                        : <em>Not set</em>}
                      <button type="button" onClick={() => onCaptureShortcut(shortcut.id)}>Change</button>
                      {shortcut.changed
                        ? <button type="button" onClick={() => onSetShortcut(shortcut.id, shortcut.defaultBinding)}>Reset</button>
                        : <button type="button" disabled={!shortcut.binding} onClick={() => onSetShortcut(shortcut.id, null)}>Clear</button>}
                    </>}
              </div>
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
