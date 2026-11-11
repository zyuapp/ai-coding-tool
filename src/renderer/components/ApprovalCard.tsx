import { useId } from "react";
import { LuShieldAlert as ShieldAlert } from "react-icons/lu";
import { shortcutAction } from "../../domain/shortcuts";
import { approvalPreview } from "../../domain/approval-preview";
import { toolLabel } from "../../domain/tool-call";
import { shortcutTip } from "./TooltipLayer";
import { Button } from "../ui/Button";
import "../ui/glass.css";

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

/** Allow or Deny, whose tip names the keys that answer it. */
export function DecideButton({ label, binding, secondary = false, onDecide }: { label: string; binding: string | null; secondary?: boolean; onDecide: () => void }) {
  return (
    <Button variant={secondary ? "secondary" : "primary"} {...(binding ? { "data-tip": shortcutTip(label, binding) } : {})} onClick={onDecide}>
      {label}
    </Button>
  );
}

/**
 * The action an approval is asked for, drawn as what it is. `id` names the part that reads in full,
 * for the card to be described by; a call left to its raw input has none.
 */
export function ApprovalAction({ input, toolName, id }: { input: Record<string, unknown>; toolName: string; id?: string }) {
  const preview = approvalPreview(input);
  switch (preview.kind) {
    case "command": return <pre className="approval-command" id={id}>{preview.command}</pre>;
    case "subject": return <pre className="approval-command" id={id}>{preview.text}</pre>;
    case "file": return (
      <div className="approval-change" id={id}>
        <p>{preview.path}</p>
        <pre>{preview.content}</pre>
      </div>
    );
    case "edit": return (
      <div className="approval-change" id={id}>
        <p>{preview.path}</p>
        <pre>
          {preview.removed.map((line, index) => <span key={`-${index}`} className="removed">{line}{"\n"}</span>)}
          {preview.added.map((line, index) => <span key={`+${index}`} className="added">{line}{"\n"}</span>)}
        </pre>
      </div>
    );
    case "raw": return (
      <details className="approval-raw">
        <summary>{toolLabel(toolName)}</summary>
        <pre>{JSON.stringify(input, null, 2)}</pre>
      </details>
    );
  }
}

export function ApprovalCard({ approval, onDecide, bindings = DEFAULT_BINDINGS }: ApprovalCardProps) {
  const id = useId();
  return (
    <section className="glass-float approval-card" aria-labelledby={`${id}-title`} {...(approval.description ? { "aria-describedby": `${id}-description` } : {})}>
      <div className="approval-icon" aria-hidden="true"><ShieldAlert size={16} /></div>
      <div>
        <div role="alert">
          <strong id={`${id}-title`}>{approval.title}</strong>
          {approval.description && <p id={`${id}-description`}>{approval.description}</p>}
        </div>
        <ApprovalAction input={approval.input} toolName={approval.toolName} />
        <div className="approval-actions">
          <DecideButton label="Deny" binding={bindings.deny} secondary onDecide={() => onDecide(approval, false)} />
          <DecideButton label="Allow once" binding={bindings.allow} onDecide={() => onDecide(approval, true)} />
        </div>
      </div>
    </section>
  );
}
