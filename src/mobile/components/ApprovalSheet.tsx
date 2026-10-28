import { LuShieldAlert as ShieldAlert } from "react-icons/lu";
import { useState } from "react";
import type { MobileApproval } from "../../contracts/mobile";
import { glanceable } from "../format";

/**
 * The one thing a phone is most often picked up for. One a thread under the open coordinator asks
 * names that thread above it. Both answers are full-width and thumb-high,
 * and neither sits where the other was a moment ago, so an approval cannot be given by reflex.
 * A detail short enough to take in at a glance is open, so what is being allowed is read first.
 * One tap decides: the card dims and both buttons are disabled until the Mac takes the card away,
 * so a second tap cannot answer twice while the first is still on its way. `refused` names the last
 * answer the Mac turned down, which hands the card back to be answered again.
 */
export function ApprovalSheet({ approval, refused = null, onDecide }: {
  approval: MobileApproval;
  refused?: string | null;
  onDecide: (approval: MobileApproval, allow: boolean) => void;
}) {
  const [decision, setDecision] = useState<{ approvalId: string; allow: boolean } | null>(null);
  const [released, setReleased] = useState<string | null>(null);
  if (refused !== null && refused !== released) {
    setReleased(refused);
    if (decision) setDecision(null);
  }
  const decided = decision?.approvalId === approval.approvalId ? decision : null;
  function decide(allow: boolean) {
    setDecision({ approvalId: approval.approvalId, allow });
    onDecide(approval, allow);
  }
  return (
    <section className="approval" aria-live="assertive" data-decided={decided ? true : undefined}>
      <header>
        <span className="approval-glyph" aria-hidden="true"><ShieldAlert size={16} strokeWidth={1.9} /></span>
        <div>
          {approval.from && <small className="approval-from">{approval.from}</small>}
          <strong>{approval.title}</strong>
          <p>{approval.description}</p>
        </div>
      </header>
      {approval.detail && (
        <details open={glanceable(approval.detail)}>
          <summary>{approval.toolName}</summary>
          <pre>{approval.detail}</pre>
        </details>
      )}
      <div className="approval-actions">
        <button type="button" className="deny" disabled={decided !== null} onClick={() => decide(false)}>{decided?.allow === false ? "Denying…" : "Deny"}</button>
        <button type="button" className="allow" disabled={decided !== null} onClick={() => decide(true)}>{decided?.allow ? "Allowing…" : "Allow once"}</button>
      </div>
    </section>
  );
}
