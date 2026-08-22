import { Check, Moon, Sun, SunMoon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { themeFamilies, themeFor, themeOrDefault, type ThemeMode } from "../../domain/theme";
import { previewTheme } from "../theme";

export type ThemeSettingsProps = {
  /** The theme in effect, by id, whose ground is the one the family tiles are drawn on. */
  theme: string;
  /** The ground the user asked for, which "auto" hands back to the system's own appearance. */
  themeMode: ThemeMode;
  onSetFamily: (family: string) => void;
  onSetMode: (mode: ThemeMode) => void;
};

/** The window in miniature: a sidebar, a message, a shell line, and a diff row, all in the theme's own tokens. */
function ThemePreview() {
  return (
    <span className="theme-preview" aria-hidden="true">
      <span className="theme-preview-sidebar">
        <i /><i /><i />
      </span>
      <span className="theme-preview-body">
        <span className="theme-preview-bubble"><i /><i /></span>
        <span className="theme-preview-shell">
          <i className="ansi-green" /><i className="ansi-blue" /><i className="ansi-yellow" /><i className="ansi-magenta" />
        </span>
        <span className="theme-preview-diff">
          <i className="added" /><i className="removed" />
        </span>
      </span>
    </span>
  );
}

const MODES: { id: ThemeMode; label: string; icon: ReactNode }[] = [
  { id: "light", label: "Light", icon: <Sun size={15} aria-hidden="true" /> },
  { id: "dark", label: "Dark", icon: <Moon size={15} aria-hidden="true" /> },
  { id: "auto", label: "Auto", icon: <SunMoon size={15} aria-hidden="true" /> },
];

/**
 * The eight themes are four families on two grounds, so the picker offers those two axes rather than
 * the eight combinations. Resting on a choice paints the window in it; leaving puts the old one back.
 */
export function ThemeSettings({ theme, themeMode, onSetFamily, onSetMode }: ThemeSettingsProps) {
  const current = themeOrDefault(theme);
  useEffect(() => () => previewTheme(null), []);

  return (
    <>
      <div className="settings-page-heading">
        <h2>Theme</h2>
        <p>Every colour in the window comes from the theme, including the terminal and the code viewer.</p>
        <p className="settings-summary">
          {current.label}
          <span aria-hidden="true"> · </span>
          {MODES.find((mode) => mode.id === themeMode)?.label}
        </p>
      </div>

      <section className="settings-group" aria-labelledby="theme-mode-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="theme-mode-heading">Ground</h3>
            <p>Which of a family's two themes the window paints, or whether the system decides.</p>
          </div>
          <div className="settings-group-action">
            <div className="segmented" role="group" aria-label="Ground">
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={mode.id === themeMode ? "chosen" : ""}
                  aria-pressed={mode.id === themeMode}
                  onPointerEnter={() => previewTheme(mode.id === "auto" ? null : themeFor(current.family, mode.id).id)}
                  onPointerLeave={() => previewTheme(null)}
                  onFocus={() => previewTheme(mode.id === "auto" ? null : themeFor(current.family, mode.id).id)}
                  onBlur={() => previewTheme(null)}
                  onClick={() => onSetMode(mode.id)}
                >
                  {mode.icon}
                  <span>{mode.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="theme-family-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="theme-family-heading">Palette</h3>
            <p>Each one ships a light and a dark theme; the ground above picks which you get.</p>
          </div>
        </div>
        <div className="theme-choices compact">
          {themeFamilies().map((family) => {
            const option = themeFor(family, current.variant);
            const chosen = option.id === current.id;
            return (
              <button
                key={family}
                type="button"
                className={`theme-choice${chosen ? " chosen" : ""}`}
                aria-pressed={chosen}
                data-theme={option.id}
                onPointerEnter={() => previewTheme(option.id)}
                onPointerLeave={() => previewTheme(null)}
                onFocus={() => previewTheme(option.id)}
                onBlur={() => previewTheme(null)}
                onClick={() => onSetFamily(family)}
              >
                <ThemePreview />
                <span className="theme-choice-name">
                  {family}
                  {chosen && <Check size={13} aria-hidden="true" />}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
