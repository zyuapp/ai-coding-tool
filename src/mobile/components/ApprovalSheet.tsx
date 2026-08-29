import { LuShieldAlert as ShieldAlert } from "react-icons/lu";
import { useState } from "react";
import type { MobileApproval } from "../../contracts/mobile";

/**
 * The one thing a phone is most often picked up for. Both answers are full-width and thumb-high,
 * and neither sits where the other was a moment ago, so an approval cannot be given by reflex.
 * One tap decides: the card dims and both buttons are disabled until the Mac takes the card away,
 * so a second tap cannot answer twice while the first is still on its way.
 */
export function ApprovalSheet({ approval, onDecide }: { approval: MobileApproval; onDecide: (allow: boolean) => void }) {
  const [decidedFor, setDecidedFor] = useState<string | null>(null);
  const decided = decidedFor === approval.approvalId;
  function decide(allow: boolean) {
    setDecidedFor(approval.approvalId);
    onDecide(allow);
  }
  return (
    <section className="approval" aria-live="assertive" data-decided={decided || undefined}>
      <header>
        <span className="approval-glyph" aria-hidden="true"><ShieldAlert size={16} strokeWidth={1.9} /></span>
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
        <button type="button" className="deny" disabled={decided} onClick={() => decide(false)}>Deny</button>
        <button type="button" className="allow" disabled={decided} onClick={() => decide(true)}>Allow</button>
      </div>
    </section>
  );
}
