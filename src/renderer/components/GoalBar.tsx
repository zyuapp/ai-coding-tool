import { LuChevronDown as ChevronDown } from "react-icons/lu";
import { useState, type KeyboardEvent } from "react";
import type { ActiveGoal } from "../../domain/goal";
import { ConfirmAction } from "./SettingRow";
import { useClamped } from "./AnnotationRow";

/** The objective on one line, opened out in place when it runs past it. */
function GoalObjective({ objective }: { objective: string }) {
  const [open, setOpen] = useState(false);
  const [ref, cut] = useClamped(objective);
  const toggles = cut || open;
  return (
    <span
      className={`goal-objective${open ? " open" : ""}${toggles ? " toggles" : ""}`}
      {...(toggles ? {
        role: "button",
        tabIndex: 0,
        "aria-expanded": open,
        onClick: () => setOpen(!open),
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen(!open);
        },
      } : {})}
    >
      <span ref={ref}>{objective}</span>
      {toggles && <ChevronDown size={14} aria-hidden="true" />}
    </span>
  );
}

export function GoalBar({ goal, onClear }: { goal: ActiveGoal; onClear: () => void }) {
  const detail = goal.status === "blocked"
    ? goal.lastReason ?? "Needs attention"
    : goal.iterations && goal.iterations > 1 ? `Pass ${goal.iterations}` : "Working toward goal";
  return (
    <div className={`goal-bar ${goal.status}`} role="status">
      <span className="goal-target" aria-hidden="true"><span /></span>
      <div className="goal-copy">
        <span className="goal-label">Goal</span>
        <GoalObjective objective={goal.objective} />
      </div>
      <span className="goal-detail">{detail}</span>
      <div className="goal-actions">
        <ConfirmAction className="goal-clear" aria-label="Clear goal" confirm="Clear goal" onConfirm={onClear}>Clear</ConfirmAction>
      </div>
    </div>
  );
}
