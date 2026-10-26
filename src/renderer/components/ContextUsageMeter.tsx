import { useId, type CSSProperties } from "react";
import type { ContextUsage } from "../../domain/thread-run";
import { UsageCard, UsageCardRow } from "./UsageCard";

/** A count of tokens in a few characters: 3.1M, 240K. */
export function compactTokens(tokens: number): string {
  return tokens.toLocaleString("en-US", { notation: "compact" });
}

export function ContextUsageMeter({ usage }: { usage: ContextUsage }) {
  const tooltipId = useId();
  const percent = Math.min(Math.round(usage.tokens / usage.limit * 100), 100);

  return (
    <span className="context-usage" tabIndex={0} aria-label={`${percent}% of context window used`} aria-describedby={tooltipId}>
      <span className="context-usage-ring" aria-hidden="true" style={{ "--context-progress": `${percent}%` } as CSSProperties} />
      <UsageCard id={tooltipId} title="Context window">
        <UsageCardRow label={`${percent}% used`} value={`${100 - percent}% left`} share={percent} detail={`${compactTokens(usage.tokens)} / ${compactTokens(usage.limit)} tokens used`} />
      </UsageCard>
    </span>
  );
}
