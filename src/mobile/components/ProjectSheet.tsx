import { useRef, useState } from "react";
import { LuCheck as Check } from "react-icons/lu";
import type { MobileProjectGroup } from "../../contracts/mobile";
import { rankedMatches } from "../../domain/match-rank";
import { Sheet } from "./Sheet";

/** A project found by typing its name, or the one choice that is no project at all. */
export function ProjectSheet({ projects, selected, none = "All projects", label = "Show threads in", onClose, onSelect }: {
  projects: MobileProjectGroup[];
  selected: string | null;
  /** What choosing no project means here. */
  none?: string;
  label?: string;
  onClose: () => void;
  onSelect: (projectId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const searching = query.trim() !== "";
  const choices = [...(searching ? [] : [{ projectId: null, name: none }]), ...rankedMatches(projects, query, (project) => [project.name])];
  return (
    <Sheet title="Project" onClose={onClose}>
      <div className="sheet-search">
        <input ref={field} type="search" aria-label="Search projects" placeholder="Search projects" value={query} enterKeyHint="search" onInput={(event) => setQuery(event.currentTarget.value)} />
      </div>
      <section className="sheet-group" role="radiogroup" aria-label={label}>
        {choices.map(({ projectId, name }) => {
          const current = projectId === selected;
          return (
            <button key={projectId ?? "all"} type="button" role="radio" aria-checked={current} className="sheet-option" onClick={() => { onClose(); onSelect(projectId); }}>
              <strong>{name}</strong>
              <span className="sheet-check" aria-hidden="true">{current && <Check size={16} />}</span>
            </button>
          );
        })}
      </section>
      {!choices.length && (
        <div className="sheet-empty">
          <p>No project matches “{query.trim()}”</p>
          <button type="button" className="section-text-action" onClick={() => { setQuery(""); field.current?.focus(); }}>Clear search</button>
        </div>
      )}
    </Sheet>
  );
}
