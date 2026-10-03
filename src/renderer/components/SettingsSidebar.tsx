import { LuArchive as Archive, LuArrowLeft as ArrowLeft, LuBot as Bot, LuFolderGit2 as FolderGit2, LuGauge as Gauge, LuGlobe as Globe, LuKeyboard as Keyboard, LuMonitorCog as MonitorCog, LuPalette as Palette, LuSearch as Search, LuSlidersHorizontal as SlidersHorizontal, LuSmartphone as Smartphone } from "react-icons/lu";
import type { IconType } from "react-icons";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SETTINGS_JUMP_OPTIONS, SETTINGS_PAGE_LABELS, type SettingsJumpOption } from "../../domain/settings-catalog";
import { rankSettingsJumps } from "../../domain/settings-jump";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../domain/settings-section";

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

export type SettingsSidebarProps = {
  section: SettingsSection;
  backRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  /** Opens a page, marking the control on it a search named. */
  onLand: (section: SettingsSection, settingId: string | null) => void;
  onRefreshEngines: () => void;
  onRefreshWorktrees: () => void;
  onRefreshRemote: () => void;
};

/** The way out of settings, a search across every page, and the list of pages the search stands in for while it has a query. */
export function SettingsSidebar({ section, backRef, onClose, onLand, onRefreshEngines, onRefreshWorktrees, onRefreshRemote }: SettingsSidebarProps) {
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
      <button ref={backRef} className="settings-back" type="button" onClick={onClose}>
        <ArrowLeft size={17} aria-hidden="true" />
        <span>Back to AI Coding Tool</span>
      </button>
      <h1>Settings</h1>
      <label className="settings-search">
        <Search size={15} aria-hidden="true" />
        <input
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
                  onClick={() => choose(option)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{option.title}</span>
                  {option.page && <small>{option.page}</small>}
                </button>
              );
            })}
          </div>
        ) : <p className="settings-search-empty">No settings match</p>
      ) : (
        <nav aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((page) => {
            const Icon = PAGE_ICONS[page];
            return (
              <button key={page} className={section === page ? "active" : ""} type="button" aria-current={section === page ? "page" : undefined} onClick={() => land(page, null)}>
                <Icon size={17} aria-hidden="true" />
                <span>{SETTINGS_PAGE_LABELS[page]}</span>
              </button>
            );
          })}
        </nav>
      )}
    </aside>
  );
}
