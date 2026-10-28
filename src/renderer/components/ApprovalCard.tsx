import { useId } from "react";
import { displayShortcut, shortcutAction } from "../../domain/shortcuts";
import { MAC } from "../platform";
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
  bindings?: DecideBindings;
};

/** The keystrokes Allow and Deny answer to; null where one is unbound. */
export type DecideBindings = { allow: string | null; deny: string | null };

const DEFAULT_BINDINGS: DecideBindings = { allow: shortcutAction("run.allow")?.defaultBinding ?? null, deny: shortcutAction("run.deny")?.defaultBinding ?? null };

/** Allow or Deny, with the keys that answer it beside its label. */
export function DecideButton({ label, binding, secondary = false, onDecide }: { label: string; binding: string | null; secondary?: boolean; onDecide: () => void }) {
  return (
    <button type="button" {...(secondary ? { className: "secondary" } : {})} {...(binding ? { "data-tip": shortcutTip(label, binding) } : {})} onClick={onDecide}>
      {label}{binding && <kbd aria-hidden="true">{displayShortcut(binding, MAC)}</kbd>}
    </button>
  );
}

/** The shell command a tool call would run, which is what the user is deciding on, when it has one. */
export function approvalCommand(input: Record<string, unknown>): string | null {
  return typeof input.command === "string" ? input.command : null;
}

export function ApprovalCard({ approval, onDecide, bindings = DEFAULT_BINDINGS }: ApprovalCardProps) {
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
          <DecideButton label="Deny" binding={bindings.deny} secondary onDecide={() => onDecide(approval, false)} />
          <DecideButton label="Allow once" binding={bindings.allow} onDecide={() => onDecide(approval, true)} />
        </div>
      </div>
    </section>
  );
}
