import { Check, ChevronDown, Minus, Moon, Plus, Search, Sun, SunMoon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { themeFamilies, themeFor, themeOrDefault, type ThemeMode } from "../../domain/theme";
import {
  MONO_FONTS,
  READING_SIZE,
  TERMINAL_SIZE,
  UI_FONTS,
  clampSize,
  customFontFamily,
  customFontId,
  monoFontOrDefault,
  stepSize,
  uiFontOrDefault,
  type SizeRange,
} from "../../domain/typography";
import { canReadInstalledFonts, readInstalledFonts } from "../system-fonts";

export type AppearanceSettingsProps = {
  /** The theme in effect, by id, whose ground is the one the theme tiles are drawn on. */
  theme: string;
  /** The ground the user asked for, which "auto" hands back to the system's own appearance. */
  themeMode: ThemeMode;
  uiFont: string;
  monoFont: string;
  /** The two sizes that follow the user, in px. */
  readingSize: number;
  terminalSize: number;
  onSetThemeFamily: (family: string) => void;
  onSetThemeMode: (mode: ThemeMode) => void;
  onSetUiFont: (font: string) => void;
  onSetMonoFont: (font: string) => void;
  onSetReadingSize: (size: number) => void;
  onSetTerminalSize: (size: number) => void;
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

type Axis = "uiFont" | "monoFont";

/**
 * The face a control paints its own text in. A bundled family is an attribute the stylesheet
 * answers; a named family and the system's own have no block, so their stack is set inline. Either
 * way the control shows the face it offers rather than the one the window is set to.
 */
function faceProps(axis: Axis, id: string) {
  const attribute = axis === "uiFont" ? "data-ui-font" : "data-mono-font";
  const token = axis === "uiFont" ? "--ui-font" : "--mono";
  const named = customFontFamily(id);
  const style = named
    ? ({ [token]: `"${named}", ${axis === "uiFont" ? "sans-serif" : "monospace"}` } as React.CSSProperties)
    : id === "system"
      ? ({ [token]: `var(--system-${axis === "uiFont" ? "ui" : "mono"}-font)` } as React.CSSProperties)
      : undefined;
  return { [attribute]: named ? "installed" : id, style };
}

/**
 * One font as one control: a button wearing the chosen face, and a popover that filters the
 * families the app bundles and, below them, the ones this machine has installed. Reading the
 * installed list needs the user's consent, so it is asked for on the click that opens the list.
 */
function FontSelect({ axis, label, chosen, onChoose }: {
  axis: Axis;
  label: string;
  chosen: string;
  onChoose: (id: string) => void;
}) {
  const current = axis === "uiFont" ? uiFontOrDefault(chosen) : monoFontOrDefault(chosen);
  const bundled = axis === "uiFont" ? UI_FONTS : MONO_FONTS;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [installed, setInstalled] = useState<string[] | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) search.current?.focus(); }, [open]);

  function toggle() {
    setQuery("");
    setOpen(!open);
    if (!open && installed === null && canReadInstalledFonts()) {
      setInstalled([]);
      void readInstalledFonts().then(setInstalled);
    }
  }

  function choose(id: string) {
    setOpen(false);
    onChoose(id);
  }

  const term = query.trim().toLowerCase();
  const families = bundled.filter((font) => !term || font.label.toLowerCase().includes(term));
  const extras = (installed ?? []).filter((family) =>
    (!term || family.toLowerCase().includes(term)) && !bundled.some((font) => font.label === family));
  const shown = extras.slice(0, 100);
  /** What Enter in the search lands on, so typing a name and pressing Enter is the whole gesture. */
  const first = families[0]?.id ?? (shown.length ? customFontId(shown[0]) : undefined);

  const option = (id: string, name: string) => (
    <li key={id} role="none">
      <button
        type="button"
        role="option"
        aria-selected={id === current.id}
        className={id === current.id ? "chosen" : ""}
        onClick={() => choose(id)}
        {...faceProps(axis, id)}
      >
        <span>{name}</span>
        {id === current.id && <Check size={13} aria-hidden="true" />}
      </button>
    </li>
  );

  return (
    <div
      ref={wrapper}
      className="font-select"
      onBlur={(event) => { if (!wrapper.current?.contains(event.relatedTarget as Node)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={toggle} {...faceProps(axis, current.id)}>
        <span>{current.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="font-select-popover">
          <label className="font-select-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="Search fonts"
              aria-label={`Search fonts for ${label.toLowerCase()}`}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && first) choose(first); }}
            />
          </label>
          <ul className="font-select-list" role="listbox" aria-label={label}>
            {families.map((font) => option(font.id, font.label))}
            {shown.length > 0 && <li className="font-select-heading" role="none">On this Mac</li>}
            {shown.map((family) => option(customFontId(family), family))}
          </ul>
          {extras.length > shown.length && <p className="font-select-note">Showing the first 100 of {extras.length}. Narrow the search to see the rest.</p>}
          {!families.length && !shown.length && <p className="font-select-note">No font here is called that.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * One size as `− 15 +`, in px. The steppers move a px at a time; the field takes a typed number and clamps
 * it to the range when it is committed, while Escape abandons the typing and keeps the settled size.
 */
function SizeField({ label, range, value, onChoose }: {
  label: string;
  range: SizeRange;
  value: number;
  onChoose: (size: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const abandoned = useRef(false);

  return (
    <div className="size-stepper">
      <button type="button" aria-label={`Smaller ${label.toLowerCase()}`} disabled={value <= range.min} onClick={() => onChoose(stepSize(range, value, -1))}>
        <Minus size={14} aria-hidden="true" />
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={draft ?? String(value)}
        aria-label={label}
        onFocus={(event) => {
          setDraft(String(value));
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          const typed = Number(event.target.value);
          const keep = !abandoned.current && event.target.value.trim() && Number.isFinite(typed);
          abandoned.current = false;
          setDraft(null);
          if (keep) onChoose(clampSize(range, typed));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.stopPropagation();
            abandoned.current = true;
            event.currentTarget.blur();
          }
        }}
      />
      <button type="button" aria-label={`Larger ${label.toLowerCase()}`} disabled={value >= range.max} onClick={() => onChoose(stepSize(range, value, 1))}>
        <Plus size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Everything the window looks like, on one page, and every choice applies the moment it is made. */
export function AppearanceSettings({
  theme,
  themeMode,
  uiFont,
  monoFont,
  readingSize,
  terminalSize,
  onSetThemeFamily,
  onSetThemeMode,
  onSetUiFont,
  onSetMonoFont,
  onSetReadingSize,
  onSetTerminalSize,
}: AppearanceSettingsProps) {
  const current = themeOrDefault(theme);

  return (
    <>
      <div className="settings-page-heading">
        <h2>Appearance</h2>
        <p>The window's colours, fonts, and text sizes. Every choice applies the moment you make it.</p>
      </div>

      <section className="settings-group" aria-labelledby="theme-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="theme-heading">Theme</h3>
            <p>Each theme comes in light and dark. Auto follows the system.</p>
          </div>
          <div className="settings-group-action">
            <div className="segmented" role="group" aria-label="Light or dark">
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={mode.id === themeMode ? "chosen" : ""}
                  aria-pressed={mode.id === themeMode}
                  onClick={() => onSetThemeMode(mode.id)}
                >
                  {mode.icon}
                  <span>{mode.label}</span>
                </button>
              ))}
            </div>
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
                onClick={() => onSetThemeFamily(family)}
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

      <section className="settings-group" aria-labelledby="fonts-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="fonts-heading">Fonts</h3>
            <p>The families Claudex ships, or any font installed on this Mac.</p>
          </div>
        </div>

        <div className="setting-row">
          <span className="setting-status blank" aria-hidden="true" />
          <div>
            <strong>Interface</strong>
            <p>The window itself: its threads, its menus, and what Claude writes back.</p>
          </div>
          <div className="setting-row-action">
            <FontSelect axis="uiFont" label="Interface font" chosen={uiFont} onChoose={onSetUiFont} />
          </div>
        </div>

        <div className="setting-row">
          <span className="setting-status blank" aria-hidden="true" />
          <div>
            <strong>Code and terminal</strong>
            <p>Code, diffs, and every shell.</p>
          </div>
          <div className="setting-row-action">
            <FontSelect axis="monoFont" label="Code and terminal font" chosen={monoFont} onChoose={onSetMonoFont} />
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="text-size-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="text-size-heading">Text size</h3>
            <p>The sidebar, the tabs, and the menus keep the size they were drawn at.</p>
          </div>
        </div>

        <div className="setting-row">
          <span className="setting-status blank" aria-hidden="true" />
          <div>
            <strong>Conversation text</strong>
            <p className="size-sample">Ran the tests — three failed in the parser.</p>
          </div>
          <div className="setting-row-action">
            <SizeField label="Conversation text size" range={READING_SIZE} value={readingSize} onChoose={onSetReadingSize} />
          </div>
        </div>

        <div className="setting-row">
          <span className="setting-status blank" aria-hidden="true" />
          <div>
            <strong>Terminal text</strong>
            <p className="size-sample terminal">$ git status</p>
          </div>
          <div className="setting-row-action">
            <SizeField label="Terminal text size" range={TERMINAL_SIZE} value={terminalSize} onChoose={onSetTerminalSize} />
          </div>
        </div>
      </section>
    </>
  );
}
