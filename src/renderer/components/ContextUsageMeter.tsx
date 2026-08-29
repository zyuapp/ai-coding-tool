import { useId, type CSSProperties } from "react";
import type { ContextUsage } from "../../domain/thread-run";

export function ContextUsageMeter({ usage }: { usage: ContextUsage }) {
  const tooltipId = useId();
  const percent = Math.min(Math.round(usage.tokens / usage.limit * 100), 100);

  return (
    <span className="context-usage" tabIndex={0} aria-label={`${percent}% of context window used`} aria-describedby={tooltipId}>
      <span className="context-usage-ring" aria-hidden="true" style={{ "--context-progress": `${percent}%` } as CSSProperties} />
      <span className="context-usage-tooltip" id={tooltipId} role="tooltip">
        <span>Context window:</span>
        <strong>{percent}% used ({100 - percent}% left)</strong>
        <span className="context-usage-tokens">{usage.tokens.toLocaleString("en-US", { notation: "compact" })} / {usage.limit.toLocaleString("en-US", { notation: "compact" })} tokens used</span>
      </span>
    </span>
  );
}
