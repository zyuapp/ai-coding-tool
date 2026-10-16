import { LuCheck as Check } from "react-icons/lu";
import type { MobileProjectGroup } from "../../contracts/mobile";
import { Sheet } from "./Sheet";

/** Which project's threads the activity list ranks: every one, or one. */
export function ProjectSheet({ projects, selected, onClose, onSelect }: {
  projects: MobileProjectGroup[];
  selected: string | null;
  onClose: () => void;
  onSelect: (projectId: string | null) => void;
}) {
  const choices = [{ projectId: null, name: "All projects" }, ...projects];
  return (
    <Sheet title="Project" onClose={onClose}>
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
    </Sheet>
  );
}
