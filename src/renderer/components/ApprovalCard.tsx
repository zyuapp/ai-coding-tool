import { useId } from "react";
import { shortcutTip } from "./TooltipLayer";

export type ApprovalCardProps = {
  approval: {
    approvalId: string;
    taskId: string;
    runId: string;
    title: string;
    description: string;
    toolName: string;
    input: Record<string, unknown>;
  };
  onDecide: (approval: Pick<ApprovalCardProps["approval"], "taskId" | "runId" | "approvalId">, allow: boolean) => void;
};

/** The shell command a tool call would run, which is what the user is deciding on, when it has one. */
export function approvalCommand(input: Record<string, unknown>): string | null {
  return typeof input.command === "string" ? input.command : null;
}

export function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  const id = useId();
  const command = approvalCommand(approval.input);
  return (
    <section className="approval-card" aria-labelledby={`${id}-title`} {...(approval.description ? { "aria-describedby": `${id}-description` } : {})}>
      <div className="approval-icon" aria-hidden="true">!</div>
      <div>
        <div role="alert">
          <strong id={`${id}-title`}>{approval.title}</strong>
          {approval.description && <p id={`${id}-description`}>{approval.description}</p>}
        </div>
        {command
          ? <pre className="approval-command">{command}</pre>
          : <details>
              <summary>{approval.toolName}</summary>
              <pre>{JSON.stringify(approval.input, null, 2)}</pre>
            </details>}
        <div className="approval-actions">
          <button type="button" className="secondary" data-tip={shortcutTip("Deny", "Mod+Shift+D")} onClick={() => onDecide(approval, false)}>Deny</button>
          <button type="button" data-tip={shortcutTip("Allow once", "Mod+Shift+A")} onClick={() => onDecide(approval, true)}>Allow once</button>
        </div>
      </div>
    </section>
  );
}
