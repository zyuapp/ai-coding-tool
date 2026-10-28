import { useId, type CSSProperties } from "react";
import type { ContextUsage } from "../../domain/thread-run";
import { UsageCard, UsageCardRow } from "./UsageCard";

/** A count of tokens in a few characters: 3.1M, 240K. */
export function compactTokens(tokens: number): string {
  return tokens.toLocaleString("en-US", { notation: "compact" });
}

/** Past this share the window is close to compacting, so the ring takes the accent and says how full it is. */
const HIGH_PERCENT = 80;

export function ContextUsageMeter({ usage }: { usage: ContextUsage }) {
  const tooltipId = useId();
  const percent = Math.min(Math.round(usage.tokens / usage.limit * 100), 100);
  const high = percent >= HIGH_PERCENT;

  return (
    <span className={`context-usage ${high ? "high" : ""}`} tabIndex={0} aria-label={`${percent}% of context window used`} aria-describedby={tooltipId}>
      <span className="context-usage-ring" aria-hidden="true" style={{ "--context-progress": `${percent}%` } as CSSProperties} />
      {high && <span className="context-usage-value" aria-hidden="true">{percent}%</span>}
      <UsageCard id={tooltipId} title="Context window">
        <UsageCardRow label={`${percent}% used`} value={`${100 - percent}% left`} share={percent} high={high} detail={`${compactTokens(usage.tokens)} / ${compactTokens(usage.limit)} tokens used`} />
      </UsageCard>
    </span>
  );
}
