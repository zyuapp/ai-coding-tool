import { useState } from "react";
import type { ActiveGoal } from "../../domain/goal";

export function GoalBar({ goal, onClear }: { goal: ActiveGoal; onClear: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const detail = goal.status === "blocked"
    ? goal.lastReason ?? "Needs attention"
    : goal.iterations && goal.iterations > 1 ? `Pass ${goal.iterations}` : "Working toward goal";
  return (
    <div className={`goal-bar ${goal.status}`} role="status">
      <span className="goal-target" aria-hidden="true"><span /></span>
      <div className="goal-copy">
        <span className="goal-label">Goal</span>
        <span className="goal-objective">{goal.objective}</span>
      </div>
      <span className="goal-detail">{detail}</span>
      {confirming ? (
        <span className="goal-confirm" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setConfirming(false); } }}>
          <button type="button" className="goal-clear" onClick={() => setConfirming(false)}>Keep</button>
          <button type="button" className="goal-clear danger" autoFocus onClick={() => { setConfirming(false); onClear(); }}>Clear goal</button>
        </span>
      ) : (
        <button type="button" className="goal-clear" onClick={() => setConfirming(true)} aria-label="Clear goal">Clear</button>
      )}
    </div>
  );
}
