import { Check, ShieldAlert, X } from "lucide-react";
import type { MobileApproval } from "../../contracts/mobile";

/**
 * The one thing a phone is most often picked up for. Both answers are full-width and thumb-high,
 * and neither sits where the other was a moment ago, so an approval cannot be given by reflex.
 */
export function ApprovalSheet({ approval, onDecide }: { approval: MobileApproval; onDecide: (allow: boolean) => void }) {
  return (
    <section className="approval" aria-live="assertive">
      <header>
        <span className="approval-glyph" aria-hidden="true"><ShieldAlert size={18} strokeWidth={1.9} /></span>
        <div>
          <strong>{approval.title}</strong>
          <p>{approval.description}</p>
        </div>
      </header>
      {approval.detail && (
        <details>
          <summary>{approval.toolName}</summary>
          <pre>{approval.detail}</pre>
        </details>
      )}
      <div className="approval-actions">
        <button type="button" className="deny" onClick={() => onDecide(false)}><X size={18} strokeWidth={2.2} />Deny</button>
        <button type="button" className="allow" onClick={() => onDecide(true)}><Check size={18} strokeWidth={2.2} />Allow</button>
      </div>
    </section>
  );
}
