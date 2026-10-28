import { LuArchive as Archive, LuArrowLeft as ArrowLeft, LuBot as Bot, LuFolderGit2 as FolderGit2, LuGauge as Gauge, LuGlobe as Globe, LuKeyboard as Keyboard, LuList as List, LuMonitorCog as MonitorCog, LuPalette as Palette, LuSearch as Search, LuSlidersHorizontal as SlidersHorizontal, LuSmartphone as Smartphone, LuX as X } from "react-icons/lu";
import type { IconType } from "react-icons";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SETTINGS_JUMP_OPTIONS, SETTINGS_PAGE_LABELS, type SettingsJumpOption } from "../../domain/settings-catalog";
import { rankSettingsJumps } from "../../domain/settings-jump";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../domain/settings-section";
import { moveListFocus } from "../focus";
import { shortcutTip } from "./TooltipLayer";

const CLEAR_TIP = shortcutTip("Clear", "Escape");

const PAGE_ICONS: Record<SettingsSection, IconType> = {
  general: SlidersHorizontal,
  appearance: Palette,
  usage: Gauge,
  engines: Bot,
  worktrees: FolderGit2,
  shortcuts: Keyboard,
  "computer-use": MonitorCog,
  browser: Globe,
  phone: Smartphone,
  archive: Archive,
};

const resultId = (option: SettingsJumpOption) => `settings-search-${option.id}`;

/** A result's title with the part the query typed in bold, where the title contains it. */
function Matched({ title, term }: { title: string; term: string }) {
  const at = term ? title.toLowerCase().indexOf(term) : -1;
  if (at === -1) return <span>{title}</span>;
  return <span>{title.slice(0, at)}<mark>{title.slice(at, at + term.length)}</mark>{title.slice(at + term.length)}</span>;
}

export type SettingsSidebarProps = {
  section: SettingsSection;
  /** The search field, which takes the focus when settings opens. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
  /** Opens a page, marking the control on it a search named. */
  onLand: (section: SettingsSection, settingId: string | null) => void;
  onRefreshEngines: () => void;
  onRefreshWorktrees: () => void;
  onRefreshRemote: () => void;
};

/** The way out of settings, a search across every page, and the list of pages the search stands in for while it has a query. */
export function SettingsSidebar({ section, searchRef, onClose, onLand, onRefreshEngines, onRefreshWorktrees, onRefreshRemote }: SettingsSidebarProps) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(0);
  const results = useMemo(() => rankSettingsJumps(query, SETTINGS_JUMP_OPTIONS.length), [query]);
  const pickedRow = useRef<HTMLButtonElement>(null);
  const searching = query.trim() !== "";

  useEffect(() => {
    pickedRow.current?.scrollIntoView({ block: "nearest" });
  }, [picked]);

  /** Three pages ask for a fresh read as they are opened. */
  function land(next: SettingsSection, settingId: string | null) {
    onLand(next, settingId);
    if (next === "engines") onRefreshEngines();
    else if (next === "worktrees") onRefreshWorktrees();
    else if (next === "phone") onRefreshRemote();
  }

  function clear() {
    setQuery("");
    searchRef.current?.focus();
  }

  function choose(option: SettingsJumpOption) {
    setQuery("");
    land(option.section, option.settingId);
  }

  /** Esc empties a query before it can close settings. */
  function keyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowDown" && results.length) setPicked((picked + 1) % results.length);
    else if (event.key === "ArrowUp" && results.length) setPicked((picked - 1 + results.length) % results.length);
    else if (event.key === "Enter" && results[picked]) choose(results[picked]);
    else if (event.key === "Escape" && query) setQuery("");
    else return;
    event.preventDefault();
  }

  const chosen = searching ? results[picked] : undefined;

  return (
    <aside className="settings-sidebar">
      <div className="settings-traffic-space" aria-hidden="true" />
      <button className="settings-back" type="button" aria-keyshortcuts="Escape" onClick={onClose}>
        <ArrowLeft size={18} aria-hidden="true" />
        <span>Back to AI Coding Tool</span>
        <kbd aria-hidden="true">Esc</kbd>
      </button>
      <h1>Settings</h1>
      <label className="settings-search">
        <Search size={16} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          role="combobox"
          aria-label="Search settings"
          aria-expanded={searching}
          aria-controls="settings-search-results"
          aria-activedescendant={chosen ? resultId(chosen) : undefined}
          placeholder="Search"
          spellCheck={false}
          onInput={(event) => { setQuery(event.currentTarget.value); setPicked(0); }}
          onKeyDown={keyDown}
        />
        {query && <button type="button" className="settings-search-clear" aria-label="Clear the search" data-tip={CLEAR_TIP} onMouseDown={(event) => event.preventDefault()} onClick={clear}><X size={14} aria-hidden="true" /></button>}
      </label>
      {searching ? (
        results.length ? (
          <div id="settings-search-results" className="settings-search-results" role="listbox" aria-label="Matching settings">
            {results.map((option, index) => {
              const Icon = PAGE_ICONS[option.section];
              return (
                <button
                  key={option.id}
                  id={resultId(option)}
                  ref={index === picked ? pickedRow : undefined}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === picked}
                  className={index === picked ? "active" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => { if (index !== picked) setPicked(index); }}
                  onClick={() => choose(option)}
                >
                  <Icon size={18} aria-hidden="true" />
                  <Matched title={option.title} term={query.trim().toLowerCase()} />
                  {option.page && <small>{option.page}</small>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="settings-search-empty">
            <p>No settings match</p>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={clear}><List size={18} aria-hidden="true" /><span>Show all pages</span></button>
          </div>
        )
      ) : (
        <nav aria-label="Settings sections" onKeyDown={moveListFocus}>
          {SETTINGS_SECTIONS.map((page) => {
            const Icon = PAGE_ICONS[page];
            return (
              <button key={page} className={section === page ? "active" : ""} type="button" tabIndex={section === page ? 0 : -1} aria-current={section === page ? "page" : undefined} onClick={() => land(page, null)}>
                <Icon size={18} aria-hidden="true" />
                <span>{SETTINGS_PAGE_LABELS[page]}</span>
              </button>
            );
          })}
        </nav>
      )}
    </aside>
  );
}
