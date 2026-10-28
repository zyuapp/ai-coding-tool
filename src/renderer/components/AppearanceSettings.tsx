import { LuCheck as Check, LuChevronDown as ChevronDown, LuCornerDownLeft as Enter, LuMinus as Minus, LuMoon as Moon, LuPlus as Plus, LuSearch as Search, LuSun as Sun, LuSunMoon as SunMoon } from "react-icons/lu";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { THEMES, themeFamilies, themeFor, themeOrDefault, type Theme, type ThemeMode } from "../../domain/theme";
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
import { SettingRow } from "./SettingRow";
import { moveListFocus } from "../focus";

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

/** The theme in the row's own button: its accent and three ansi slots on its own canvas. */
function ThemeSwatch({ id }: { id: string }) {
  return (
    <span className="theme-swatch" data-theme={id} aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

/** Left and Right, or Up and Down, choose the next segment along, wrapping at the ends, and take the keyboard to it. */
function moveSegment(event: KeyboardEvent<HTMLElement>) {
  const step = ({ ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 } as Record<string, number>)[event.key];
  if (step === undefined) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at === -1) return;
  event.preventDefault();
  const next = buttons[(at + step + buttons.length) % buttons.length]!;
  next.focus();
  next.click();
}

/** The mark on the option Enter in the search picks. */
const EnterMark = () => <Enter size={14} className="enter-mark" aria-hidden="true" />;

/**
 * Arrow keys across a grid of tiles: Left and Right step through them in order, Up and Down move a
 * row, keeping the column. Down from the search lands on the first tile; Up from the top row goes back.
 */
function moveGridFocus(event: KeyboardEvent<HTMLElement>, field: HTMLInputElement | null, first: HTMLButtonElement | null) {
  const tiles = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".theme-choice")];
  if (!tiles.length) return;
  const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
  if (at === -1) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    (first ?? tiles[0]!).focus();
    return;
  }
  const top = tiles[0]!.offsetTop;
  const columns = Math.max(1, tiles.findIndex((tile) => tile.offsetTop !== top) === -1 ? tiles.length : tiles.findIndex((tile) => tile.offsetTop !== top));
  const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns } as Record<string, number>)[event.key];
  if (step === undefined) return;
  event.preventDefault();
  const next = at + step;
  if (next < 0) field?.focus();
  else tiles[Math.min(next, tiles.length - 1)]!.focus();
}

/** ArrowDown or ArrowUp on a closed list button opens its list, as on a native select. */
function opensList(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  event.preventDefault();
  return true;
}

/**
 * Every family as one control: a button wearing the theme the window is in, and a popover of tiles
 * the search narrows. A tile carries its own theme, so it is drawn in the colours it offers.
 */
function ThemeSelect({ current, onChoose }: { current: Theme; onChoose: (family: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const chosen = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    chosen.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function choose(family: string) {
    close();
    onChoose(family);
  }

  const term = query.trim().toLowerCase();
  const families = themeFamilies().filter((family) => !term || family.toLowerCase().includes(term));
  /** What Enter in the search picks: the first match while a search narrows the tiles. */
  const target = term ? families[0] : undefined;

  return (
    <div
      ref={wrapper}
      className="theme-select"
      onBlur={(event) => { if (!wrapper.current?.contains(event.relatedTarget as Node)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button ref={trigger} type="button" aria-label={`Theme: ${current.family}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setQuery(""); setOpen(!open); }} onKeyDown={(event) => { if (!open && opensList(event)) { setQuery(""); setOpen(true); } }}>
        <ThemeSwatch id={current.id} />
        <span>{current.family}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="theme-select-popover" onKeyDown={(event) => moveGridFocus(event, search.current, target ? null : chosen.current)}>
          <label className="font-select-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="Search themes"
              aria-label="Search themes"
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && target) choose(target); }}
            />
          </label>
          <div className="theme-choices compact" role="listbox" aria-label="Theme">
            {families.map((family) => {
              const option = themeFor(family, current.variant);
              const picked = option.id === current.id;
              return (
                <button
                  key={family}
                  ref={picked ? chosen : undefined}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  className={`theme-choice${picked ? " chosen" : ""}${family === target ? " next" : ""}`}
                  data-theme={option.id}
                  onClick={() => choose(family)}
                >
                  <ThemePreview />
                  <span className="theme-choice-name">
                    {family}
                    {family === target ? <EnterMark /> : picked && <Check size={14} aria-hidden="true" />}
                  </span>
                </button>
              );
            })}
          </div>
          {!families.length && <p className="font-select-note">No theme here is called that.</p>}
        </div>
      )}
    </div>
  );
}

const MODES: { id: ThemeMode; label: string; icon: ReactNode }[] = [
  { id: "light", label: "Light", icon: <Sun size={16} aria-hidden="true" /> },
  { id: "dark", label: "Dark", icon: <Moon size={16} aria-hidden="true" /> },
  { id: "auto", label: "Auto", icon: <SunMoon size={16} aria-hidden="true" /> },
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
  /** The families this machine has, `"reading"` while they are asked for, and null before the first open. */
  const [installed, setInstalled] = useState<string[] | "reading" | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (open) search.current?.focus(); }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function toggle() {
    setQuery("");
    setOpen(!open);
    if (!open && installed === null && canReadInstalledFonts()) {
      setInstalled("reading");
      void readInstalledFonts().then(setInstalled);
    }
  }

  function choose(id: string) {
    close();
    onChoose(id);
  }

  const term = query.trim().toLowerCase();
  const families = bundled.filter((font) => !term || font.label.toLowerCase().includes(term));
  const extras = (Array.isArray(installed) ? installed : []).filter((family) =>
    (!term || family.toLowerCase().includes(term)) && !bundled.some((font) => font.label === family));
  const shown = extras.slice(0, 100);
  /** What Enter in the search lands on, so typing a name and pressing Enter is the whole gesture. */
  const first = !term ? undefined : families[0]?.id ?? (shown.length ? customFontId(shown[0]!) : undefined);

  const option = (id: string, name: string) => (
    <li key={id} role="none">
      <button
        type="button"
        role="option"
        aria-selected={id === current.id}
        className={[id === current.id && "chosen", id === first && "next"].filter(Boolean).join(" ") || undefined}
        onClick={() => choose(id)}
        {...faceProps(axis, id)}
      >
        <span>{name}</span>
        {id === first ? <EnterMark /> : id === current.id && <Check size={14} aria-hidden="true" />}
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
          close();
        }
      }}
    >
      <button ref={trigger} type="button" aria-label={`${label}: ${current.label}`} aria-haspopup="listbox" aria-expanded={open} onClick={toggle} onKeyDown={(event) => { if (!open && opensList(event)) toggle(); }} {...faceProps(axis, current.id)}>
        <span>{current.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="font-select-popover" onKeyDown={moveListFocus}>
          <label className="font-select-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="Search fonts"
              aria-label={`Search fonts for ${label.toLowerCase()}`}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && first) choose(first); }}
            />
          </label>
          <ul className="font-select-list" role="listbox" aria-label={label}>
            {families.map((font) => option(font.id, font.label))}
            {shown.length > 0 && <li className="font-select-heading" role="none">On this computer</li>}
            {shown.map((family) => option(customFontId(family), family))}
          </ul>
          {installed === "reading" && <p className="font-select-note">Reading installed fonts…</p>}
          {extras.length > shown.length && <p className="font-select-note">Showing the first 100 of {extras.length}. Narrow the search to see the rest.</p>}
          {!families.length && !shown.length && installed !== "reading" && <p className="font-select-note">No font here is called that.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * One size as `− 15 +`, in px, after the range it may take. The steppers move a px at a time; the field
 * takes a typed number and clamps it to the range when it is committed, which the range then says, while
 * Escape abandons the typing and keeps the settled size.
 */
function SizeField({ label, range, value, onChoose }: {
  label: string;
  range: SizeRange;
  value: number;
  onChoose: (size: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /** Which end of the range a typed size was held to, until the size next changes. */
  const [clamped, setClamped] = useState<"min" | "max" | null>(null);
  const abandoned = useRef(false);
  const step = (delta: 1 | -1) => {
    setClamped(null);
    onChoose(stepSize(range, value, delta));
  };

  let limit = `${range.min}–${range.max} px`;
  if (clamped === "max") limit = `Max ${range.max} px`;
  if (clamped === "min") limit = `Min ${range.min} px`;

  return (
    <>
      <span className={`size-range${clamped ? " clamped" : ""}`} role="status">{limit}</span>
      <div className="size-stepper">
        <button type="button" aria-label={`Smaller ${label.toLowerCase()}`} disabled={value <= range.min} onClick={() => step(-1)}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <label className="size-value">
          <input
            type="text"
            inputMode="numeric"
            value={draft ?? String(value)}
            aria-label={label}
            onFocus={(event) => {
              setClamped(null);
              setDraft(String(value));
              event.currentTarget.select();
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => {
              const typed = Number(event.target.value);
              const keep = !abandoned.current && event.target.value.trim() && Number.isFinite(typed);
              abandoned.current = false;
              setDraft(null);
              if (!keep) return;
              const kept = clampSize(range, typed);
              setClamped(kept === typed ? null : typed > kept ? "max" : "min");
              onChoose(kept);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                const typed = Number(draft);
                const next = stepSize(range, draft?.trim() && Number.isFinite(typed) ? clampSize(range, typed) : value, event.key === "ArrowUp" ? 1 : -1);
                setDraft(String(next));
                onChoose(next);
              }
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.stopPropagation();
                abandoned.current = true;
                event.currentTarget.blur();
              }
            }}
          />
          <span aria-hidden="true">px</span>
        </label>
        <button type="button" aria-label={`Larger ${label.toLowerCase()}`} disabled={value >= range.max} onClick={() => step(1)}>
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
    </>
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
            <div className="segmented" role="radiogroup" aria-label="Light or dark" onKeyDown={moveSegment}>
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  className={mode.id === themeMode ? "chosen" : ""}
                  aria-checked={mode.id === themeMode}
                  tabIndex={mode.id === themeMode ? 0 : -1}
                  onClick={() => onSetThemeMode(mode.id)}
                >
                  {mode.icon}
                  <span>{mode.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <SettingRow id="appearance.theme" description={`${THEMES.length} themes, each drawn in its own colours.`}>
          <ThemeSelect current={current} onChoose={onSetThemeFamily} />
        </SettingRow>
      </section>

      <section className="settings-group" aria-labelledby="fonts-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="fonts-heading">Fonts</h3>
            <p>The families AI Coding Tool ships, or any font installed on this computer.</p>
          </div>
        </div>

        <SettingRow id="appearance.ui-font" description="The window itself: its threads, its menus, and what the agent writes back.">
          <FontSelect axis="uiFont" label="Interface font" chosen={uiFont} onChoose={onSetUiFont} />
        </SettingRow>

        <SettingRow id="appearance.mono-font" description="Code, diffs, and every shell.">
          <FontSelect axis="monoFont" label="Code and terminal font" chosen={monoFont} onChoose={onSetMonoFont} />
        </SettingRow>
      </section>

      <section className="settings-group" aria-labelledby="text-size-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="text-size-heading">Text size</h3>
            <p>The sidebar, the tabs, and the menus keep the size they were drawn at.</p>
          </div>
        </div>

        <SettingRow id="appearance.reading-size" description={<p className="size-sample">Ran the tests. Three failed in the parser.</p>}>
          <SizeField label="Conversation text size" range={READING_SIZE} value={readingSize} onChoose={onSetReadingSize} />
        </SettingRow>

        <SettingRow id="appearance.terminal-size" description={<p className="size-sample terminal">$ git status</p>}>
          <SizeField label="Terminal text size" range={TERMINAL_SIZE} value={terminalSize} onChoose={onSetTerminalSize} />
        </SettingRow>
      </section>
    </>
  );
}
