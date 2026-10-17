import { useState } from "react";
import { LuCheck as Check } from "react-icons/lu";
import type { MobileProjectGroup } from "../../contracts/mobile";
import { rankedMatches } from "../../domain/match-rank";
import { Sheet } from "./Sheet";

/** Which project's threads the activity list ranks: every one, or one, found by typing its name. */
export function ProjectSheet({ projects, selected, onClose, onSelect }: {
  projects: MobileProjectGroup[];
  selected: string | null;
  onClose: () => void;
  onSelect: (projectId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const choices = [...(searching ? [] : [{ projectId: null, name: "All projects" }]), ...rankedMatches(projects, query, (project) => [project.name])];
  return (
    <Sheet title="Project" onClose={onClose}>
      <div className="sheet-search">
        <input type="search" aria-label="Search projects" placeholder="Search projects" value={query} enterKeyHint="search" onInput={(event) => setQuery(event.currentTarget.value)} />
      </div>
      <section className="sheet-group" role="radiogroup" aria-label="Show threads in">
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
      {!choices.length && <p className="sheet-note">No matches</p>}
    </Sheet>
  );
}
