import { useId, type CSSProperties } from "react";
import type { ContextUsage } from "../../domain/thread-run";
import { UsageCard, UsageCardRow } from "./UsageCard";

/** A count of tokens in a few characters: 3.1M, 240K. */
export function compactTokens(tokens: number): string {
  return tokens.toLocaleString("en-US", { notation: "compact" });
}

/** Past this share the window is close to compacting, so the meter takes the accent. */
const HIGH_PERCENT = 80;

/** The ring and its share, with a card giving the counts and, where compacting is on offer, a Compact button. */
export function ContextUsageMeter({ usage, onCompact }: { usage: ContextUsage; onCompact?: () => void }) {
  const cardId = useId();
  const percent = Math.min(Math.round(usage.tokens / usage.limit * 100), 100);
  const high = percent >= HIGH_PERCENT;

  return (
    <span className={`context-usage${high ? " high" : ""}`}>
      <span
        className="context-usage-meter"
        role="meter"
        tabIndex={0}
        aria-label="Context window"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% used`}
        aria-describedby={cardId}
      >
        <span className="context-usage-ring" style={{ "--context-progress": `${percent}%` } as CSSProperties} />
        <span className="context-usage-value">{percent}%</span>
      </span>
      <UsageCard id={cardId} title="Context window">
        <UsageCardRow label={`${percent}% used`} value={`${100 - percent}% left`} share={percent} high={high} detail={`${compactTokens(usage.tokens)} / ${compactTokens(usage.limit)} tokens used`} />
        {onCompact && <button type="button" className="usage-card-action" onClick={onCompact}>Compact</button>}
      </UsageCard>
    </span>
  );
}
