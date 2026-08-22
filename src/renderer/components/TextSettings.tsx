import { Check, Minus, Plus, Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  MONO_FONTS,
  READING_SIZE,
  TERMINAL_SIZE,
  UI_FONTS,
  customFontFamily,
  customFontId,
  monoFontOrDefault,
  stepSize,
  uiFontOrDefault,
  type Font,
  type SizeRange,
} from "../../domain/typography";
import { canReadInstalledFonts, readInstalledFonts } from "../system-fonts";
import { previewTypography } from "../typography";

export type TextSettingsProps = {
  uiFont: string;
  monoFont: string;
  /** The two sizes that follow the user, in px. */
  readingSize: number;
  terminalSize: number;
  onSetUiFont: (font: string) => void;
  onSetMonoFont: (font: string) => void;
  onSetReadingSize: (size: number) => void;
  onSetTerminalSize: (size: number) => void;
};

type Axis = "uiFont" | "monoFont";

/**
 * The stack a tile paints its own sample in. A bundled family has a block keyed by the attribute the
 * tile carries, so CSS answers for it; a named family and the system's own have none, and a tile
 * left to inherit would show whatever the root is previewing rather than what it is offering.
 */
function sampleStyle(axis: Axis, id: string) {
  const token = axis === "uiFont" ? "--ui-font" : "--mono";
  const named = customFontFamily(id);
  if (named) return { [token]: `"${named}", sans-serif` } as React.CSSProperties;
  if (id === "system") return { [token]: `var(--system-${axis === "uiFont" ? "ui" : "mono"}-font)` } as React.CSSProperties;
  return undefined;
}

/** The card paints itself in the family it names, so the sample is the face the window will use. */
function FontChoices({ fonts, chosen, sample, axis, onChoose }: {
  fonts: Font[];
  chosen: string;
  sample: ReactNode;
  axis: Axis;
  onChoose: (id: string) => void;
}) {
  const attribute = axis === "uiFont" ? "data-ui-font" : "data-mono-font";
  return (
    <div className="theme-choices compact">
      {fonts.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`theme-choice${option.id === chosen ? " chosen" : ""}`}
          aria-pressed={option.id === chosen}
          style={sampleStyle(axis, option.id)}
          {...{ [attribute]: customFontFamily(option.id) ? "installed" : option.id }}
          onPointerEnter={() => previewTypography({ [axis]: option.id })}
          onPointerLeave={() => previewTypography(null)}
          onFocus={() => previewTypography({ [axis]: option.id })}
          onBlur={() => previewTypography(null)}
          onClick={() => onChoose(option.id)}
        >
          <span className="font-preview" aria-hidden="true">{sample}</span>
          <span className="theme-choice-name">
            {option.label}
            {option.id === chosen && <Check size={13} aria-hidden="true" />}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The families this machine has, which the app has no face for and so can only name. Reading them
 * needs the user's consent, so the list stays behind a button rather than being asked for on open.
 */
function InstalledFonts({ axis, chosen, onChoose }: { axis: Axis; chosen: string; onChoose: (id: string) => void }) {
  const [families, setFamilies] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  if (!canReadInstalledFonts()) return null;

  if (!families) {
    return (
      <div className="installed-fonts">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setFamilies(await readInstalledFonts());
            setBusy(false);
          }}
        >
          {busy ? "Reading…" : "Use a font installed on this Mac"}
        </button>
      </div>
    );
  }

  if (!families.length) {
    return <p className="installed-fonts-empty">Claudex could not read this machine's fonts, so it is offering the ones it ships.</p>;
  }

  const term = query.trim().toLowerCase();
  const matches = term ? families.filter((family) => family.toLowerCase().includes(term)) : families;
  return (
    <div className="installed-fonts open">
      <label className="installed-fonts-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={`Search ${families.length} families`}
          aria-label="Search installed fonts"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <ul className="installed-fonts-list">
        {matches.slice(0, 200).map((family) => {
          const id = customFontId(family);
          return (
            <li key={family}>
              <button
                type="button"
                className={id === chosen ? "chosen" : ""}
                aria-pressed={id === chosen}
                style={{ fontFamily: `"${family}", sans-serif` }}
                onPointerEnter={() => previewTypography({ [axis]: id })}
                onPointerLeave={() => previewTypography(null)}
                onFocus={() => previewTypography({ [axis]: id })}
                onBlur={() => previewTypography(null)}
                onClick={() => onChoose(id)}
              >
                <span>{family}</span>
                {id === chosen && <Check size={13} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
      {matches.length > 200 && <p className="installed-fonts-empty">Showing the first 200 of {matches.length}. Narrow the search to see the rest.</p>}
      {!matches.length && <p className="installed-fonts-empty">No family here is called that.</p>}
    </div>
  );
}

/**
 * One size, in px rather than on a rung with a name: the slider covers the range at a glance and
 * the two steppers land on a single px, which dragging a 13-step slider cannot be trusted to do.
 */
function SizeSlider({ label, range, value, onChoose }: {
  label: string;
  range: SizeRange;
  value: number;
  onChoose: (size: number) => void;
}) {
  return (
    <div className="size-slider">
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(event) => onChoose(Number(event.target.value))}
      />
      <div className="size-stepper">
        <button type="button" aria-label={`Smaller ${label.toLowerCase()}`} disabled={value <= range.min} onClick={() => onChoose(stepSize(range, value, -1))}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <output>{value}px</output>
        <button type="button" aria-label={`Larger ${label.toLowerCase()}`} disabled={value >= range.max} onClick={() => onChoose(stepSize(range, value, 1))}>
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="size-reset" disabled={value === range.default} onClick={() => onChoose(range.default)}>
        Reset
      </button>
    </div>
  );
}

/** The families and the two sizes, on one page, with everything painting the window as you rest on it. */
export function TextSettings({
  uiFont,
  monoFont,
  readingSize,
  terminalSize,
  onSetUiFont,
  onSetMonoFont,
  onSetReadingSize,
  onSetTerminalSize,
}: TextSettingsProps) {
  useEffect(() => () => previewTypography(null), []);

  /** A named family is not in the list it was chosen from, so it is appended as its own tile. */
  const uiChoices = uiFontOrDefault(uiFont);
  const monoChoices = monoFontOrDefault(monoFont);
  const uiList = customFontFamily(uiChoices.id) ? [...UI_FONTS, uiChoices] : UI_FONTS;
  const monoList = customFontFamily(monoChoices.id) ? [...MONO_FONTS, monoChoices] : MONO_FONTS;

  return (
    <>
      <div className="settings-page-heading">
        <h2>Text</h2>
        <p>What the window is set in, and how big the two things that follow you are drawn.</p>
        <p className="settings-summary">
          {uiChoices.label}
          <span aria-hidden="true"> · </span>
          {monoChoices.label}
          <span aria-hidden="true"> · </span>
          {readingSize}px
          <span aria-hidden="true"> · </span>
          {terminalSize}px
        </p>
      </div>

      <section className="settings-group" aria-labelledby="ui-font-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="ui-font-heading">Interface font</h3>
            <p>What the window itself is set in: its threads, its menus, and what Claude writes back.</p>
          </div>
        </div>
        <FontChoices
          fonts={uiList}
          chosen={uiChoices.id}
          axis="uiFont"
          sample={<><strong>Threads</strong><em>Aa Bb Gg 0123</em></>}
          onChoose={onSetUiFont}
        />
        <InstalledFonts axis="uiFont" chosen={uiChoices.id} onChoose={onSetUiFont} />
      </section>

      <section className="settings-group" aria-labelledby="mono-font-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="mono-font-heading">Code and terminal font</h3>
            <p>What code, diffs, and every shell are set in.</p>
          </div>
        </div>
        <FontChoices
          fonts={monoList}
          chosen={monoChoices.id}
          axis="monoFont"
          sample={<><strong>0O1lI {"{}"}</strong><em className="added">+ added</em></>}
          onChoose={onSetMonoFont}
        />
        <InstalledFonts axis="monoFont" chosen={monoChoices.id} onChoose={onSetMonoFont} />
      </section>

      <section className="settings-group" aria-labelledby="text-size-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="text-size-heading">Size</h3>
            <p>The sidebar, the tabs, and the menus keep the size they were drawn at.</p>
          </div>
        </div>

        <div className="setting-row">
          <span className="setting-status" />
          <div>
            <strong>Conversation text</strong>
            <p className="size-sample">Ran the tests — three failed in the parser.</p>
          </div>
          <div className="setting-row-action">
            <SizeSlider label="Conversation text size" range={READING_SIZE} value={readingSize} onChoose={onSetReadingSize} />
          </div>
        </div>

        <div className="setting-row">
          <span className="setting-status" />
          <div>
            <strong>Terminal text</strong>
            <p className="size-sample terminal">$ git status</p>
          </div>
          <div className="setting-row-action">
            <SizeSlider label="Terminal text size" range={TERMINAL_SIZE} value={terminalSize} onChoose={onSetTerminalSize} />
          </div>
        </div>
      </section>
    </>
  );
}
