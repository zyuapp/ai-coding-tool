import { useId, type CSSProperties } from "react";
import type { ContextUsage } from "../../domain/thread-run";
import { UsageCard, UsageCardRow } from "./UsageCard";

/** A count of tokens in a few characters: 3.1M, 240K. */
export function compactTokens(tokens: number): string {
  return tokens.toLocaleString("en-US", { notation: "compact" });
}

/** Past this share the window is close to compacting, so the meter takes the accent. */
const HIGH_PERCENT = 80;

/** The ring, its share, and a card with the counts. Near compaction it compacts on a press, where compacting is on offer. */
export function ContextUsageMeter({ usage, onCompact }: { usage: ContextUsage; onCompact?: () => void }) {
  const tooltipId = useId();
  const percent = Math.min(Math.round(usage.tokens / usage.limit * 100), 100);
  const high = percent >= HIGH_PERCENT;
  const compacts = high && onCompact !== undefined;
  const Meter = compacts ? "button" : "span";

  return (
    <Meter
      className={`context-usage ${high ? "high" : ""}`}
      {...(compacts ? { type: "button" as const, onClick: onCompact } : { tabIndex: 0 })}
      aria-label={compacts ? `Compact context, ${percent}% used` : `${percent}% of context window used`}
      aria-describedby={tooltipId}
    >
      <span className="context-usage-ring" aria-hidden="true" style={{ "--context-progress": `${percent}%` } as CSSProperties} />
      <span className="context-usage-value" aria-hidden="true">{percent}%</span>
      <UsageCard id={tooltipId} title="Context window">
        <UsageCardRow label={`${percent}% used`} value={`${100 - percent}% left`} share={percent} high={high} detail={`${compactTokens(usage.tokens)} / ${compactTokens(usage.limit)} tokens used`} />
        {compacts && <span className="usage-card-hint">Click to compact</span>}
      </UsageCard>
    </Meter>
  );
}
