import type { ActiveGoal } from "../../domain/goal";

export function GoalBar({ goal, onClear }: { goal: ActiveGoal; onClear: () => void }) {
  const detail = goal.status === "blocked"
    ? goal.lastReason ?? "Needs attention"
    : goal.iterations && goal.iterations > 1 ? `Pass ${goal.iterations}` : "Working toward goal";
  return (
    <div className={`goal-bar ${goal.status}`} role="status">
      <span className="goal-target" aria-hidden="true"><span /></span>
      <div className="goal-copy">
        <span className="goal-label">Goal</span>
        <span className="goal-objective" data-tip={goal.objective} data-tip-overflow>{goal.objective}</span>
      </div>
      <span className="goal-detail">{detail}</span>
      <button type="button" className="goal-clear" aria-label="Clear goal" onClick={onClear}>Clear</button>
    </div>
  );
}
